const ignore = require('ignore');
const { getTokenCount } = require('../utils');

const {
  PLAN_PROMPT_TEMPLATE,
  TASK_EXECUTION_PROMPT_TEMPLATE,
  FINISH_TASK_PROMPT_TEMPLATE,
} = require('../static/prompts');
const { withErrorHandling, getSystemInfo, isTextFile } = require('../utils');
const { normalizedFilePath } = require('../utils');
const ignorePatterns = require('../static/embeddings_ignore_patterns');

const MAX_SUMMARY_TOKENS = 2000;
const MAX_RELEVANT_FILES_TOKENS = 10000;
const MAX_RELEVANT_FILES_COUNT = 7;
const MAX_FILE_SIZE = 30000;
const SUMMARIZE_MESSAGES_THRESHOLD = 6; // Last n message will be left as is

class ChatContextBuilder {
  constructor(chat) {
    this.chat = chat;
    this.lastSummarizedMessageID = 0;
    this.lastMessageIdForRelevantFiles = 0;
    this.reduceRelevantFilesContextMessageId = 0;
    this.lastEditedFilesTimestamp = chat.startTimestamp;
    this.taskRelevantFiles = [];
    this.pastSummarizedMessages = '';
    this.searchRelevantFiles = false;
    this.taskNeedsPlan = false;
    this.isComplexTask = false;
  }

  async buildMessages(userMessage, reflectMessage = null) {
    this.backendMessages = this.chat.backendMessages.map((message) => _.omit(message, ['id']));

    return [await this.addSystemMessage(), await this.addUserMessage(userMessage, reflectMessage)];
  }

  async addUserMessage(userMessage, reflectMessage) {
    const conversationSummary = await this.addSummaryOfMessages();
    const lastUserMessage = this.addLastUserMessage(userMessage);
    const reflectMessageResult = this.addReflectMessage(reflectMessage);
    const relevantSourceCodeInformation = await this.relevantSourceCodeInformation();

    const textContent = [
      this.addTaskMessage(),
      conversationSummary,
      lastUserMessage,
      relevantSourceCodeInformation,
      reflectMessageResult,
    ]
      .filter(Boolean)
      .join('\n');

    let content;

    const imageMessages = this.getImageMessages();
    if (imageMessages.length > 0) {
      content = [...imageMessages, { type: 'text', text: textContent }];
    } else {
      content = textContent;
    }

    return {
      role: 'user',
      content,
    };
  }

  getImageMessages() {
    const imageMessages = this.backendMessages.filter(
      (message) => Array.isArray(message.content) && message.content.some((content) => content.type === 'image_url'),
    );

    return imageMessages.map((message) => {
      return message.content.find((content) => content.type === 'image_url');
    });
  }

  async addSystemMessage() {
    let systemMessage;

    if (
      (this.taskNeedsPlan && this.chat.countOfUserMessages() === 0) ||
      (this.chat.isEmpty() && (await this.isTaskNeedsPlan()))
    ) {
      this.taskNeedsPlan = true;
      this.isComplexTask = true;
      systemMessage = PLAN_PROMPT_TEMPLATE;
    } else {
      this.taskNeedsPlan = false;
      systemMessage = TASK_EXECUTION_PROMPT_TEMPLATE;
    }

    if (this.chat.backendMessages.length > 7 || !this.isComplexTask) {
      systemMessage += `\n\n${FINISH_TASK_PROMPT_TEMPLATE}`;
    }

    systemMessage += this.addProjectCustomInstructionsMessage();
    systemMessage = this.fromTemplate(systemMessage, '{osName}', getSystemInfo());
    systemMessage = this.fromTemplate(systemMessage, '{shellType}', chatController.terminalSession.shellType);

    return {
      role: 'system',
      content: systemMessage,
    };
  }

  async isTaskNeedsPlan() {
    const prompt = `
    Task:
    "${this.chat.task}"\n
    Will this user task need to be brainstormed and planned before execution? Respond false if this is a simple task that involves only a few commands or one file manipulation.`;

    const format = {
      type: 'boolean',
      result: 'true or false',
    };

    const result = await chatController.backgroundTask.run({
      prompt,
      format,
      model: chatController.settings.selectedModel,
    });

    return result;
  }

  addTaskMessage() {
    return `<task>\n${this.chat.task}\n</task>\n`;
  }

  addProjectCustomInstructionsMessage() {
    const projectCustomInstructions = chatController.agent.projectController.getCustomInstructions();
    if (!projectCustomInstructions) {
      return '';
    } else {
      return `\n\n${projectCustomInstructions}`;
    }
  }

  async addSummaryOfMessages() {
    let allMessagesText = '';
    const backendMessages = this.chat.backendMessages;

    // remove image data from content
    const preprocessedMessages = backendMessages.map((message) => {
      if (Array.isArray(message.content)) {
        const filteredContent = message.content.filter((content) => content.type !== 'image_url');
        return { ...message, content: filteredContent };
      }
      return message;
    });
    const messagesToSummarize = preprocessedMessages.slice(0, -SUMMARIZE_MESSAGES_THRESHOLD);
    let lastSummarizedId = this.lastSummarizedMessageID;
    const notSummarizedMessages = messagesToSummarize
      .filter((message) => message.id > this.lastSummarizedMessageID)
      .reduce((acc, message) => {
        acc += `${this.formatMessageForSummary(message)},\n`;
        lastSummarizedId = message.id;
        return acc;
      }, '');

    allMessagesText = this.pastSummarizedMessages + '\n\n' + notSummarizedMessages; // up to -SUMMARIZE_MESSAGES_THRESHOLD

    if (getTokenCount(notSummarizedMessages) > MAX_SUMMARY_TOKENS) {
      this.summarizeMessages(allMessagesText).then((summarizedMessages) => {
        this.pastSummarizedMessages = summarizedMessages;
        this.lastSummarizedMessageID = lastSummarizedId;
      });
    }

    const lastNMessages = preprocessedMessages.slice(-SUMMARIZE_MESSAGES_THRESHOLD);
    let messagesToAdd = lastNMessages.filter((message) => message.id > this.lastSummarizedMessageID);
    if (messagesToAdd.length > 0 && messagesToAdd[messagesToAdd.length - 1].role === 'user') {
      messagesToAdd.pop(); // Remove the last message if it's from a user
    }
    messagesToAdd.forEach((message) => {
      allMessagesText += `${this.formatMessageForSummary(message, false)},\n`;
    });

    const summary =
      allMessagesText.trim().length > 0
        ? `\n<conversation_history>\n[${allMessagesText}]\n</conversation_history>`
        : '';

    return summary;
  }

  formatMessageForSummary(message, removeCodeDiff = true) {
    let messageContent = message.content;
    let content = [];

    if (messageContent) {
      if (removeCodeDiff && messageContent && messageContent.includes('<code diff>')) {
        messageContent = messageContent.replace(/<code diff>[\s\S]*<\/code diff>/g, '');
      }
      content.push({
        type: message.role === 'tool' ? 'tool_result' : 'text',
        content: messageContent,
      });
    }
    if (message.tool_calls) {
      message.tool_calls.forEach((toolCall) => {
        content.push({
          type: 'tool_use',
          name: toolCall.function.name,
        });
      });
    }
    const role = message.role === 'tool' ? 'user' : message.role;
    const result = { role, content };
    return JSON.stringify(result, null, 2);
  }

  async summarizeMessages(messages) {
    const prompt = `
    Compress conversation_history below without losing important information.
    Compress with at least .75 or more compression ratio.
    
    Summarization rules:
     - Preserve roles, tool names, file names
     - Preserve all important information and code snippets
     - Leave messages with "user" role word for word without alteration
     - Make sure to remove any duplicate or similar actions or information that repeats
     - Compress terminal output and only leave most important information
     - Compress "content", only keep the most important information, shorten it as much as possible
     - Compress top (older) messages more, then lower (newer) messages. Compress long assistant messages into maximum 3 sentences
     - Keep plan for the task as is (can be more than 3 sentences), make sure to preserve all messages that have requirements fully

    Respond with compressed conversation_history without wrapping XML tag, in exactly the same JSON schema format as provided in the original.

    <conversation_history>
    [
      ${messages}
    ]
    </conversation_history>`;
    const format = {
      type: 'string',
      result: 'Summary of the conversation',
    };
    let summary = await chatController.backgroundTask.run({
      prompt,
      format,
      model: chatController.settings.selectedModel,
    });

    if (summary) {
      // Remove first "[" if present
      summary = summary.replace(/^\s*\[/, '');
      // Replace last "]" with "," if present
      summary = summary.replace(/\]\s*$/, ',');
      console.log('Summarized message history:', summary);
      return summary;
    } else {
      return messages;
    }
  }

  async relevantSourceCodeInformation() {
    const projetState = await this.projectStateToText();
    const relevantFilesAndFoldersToUserMessages = await this.getRelevantFilesAndFoldersToUserMessages();
    const relevantFilesContents = await this.getRelevantFilesContents();

    return `${projetState}${relevantFilesAndFoldersToUserMessages}${relevantFilesContents}`;
  }

  async getRelevantFilesAndFoldersToUserMessages() {
    if (
      !this.searchRelevantFiles ||
      !chatController.settings.selectedEmbeddingsModel ||
      !chatController.agent.projectController.currentProject
    ) {
      return '';
    }

    let lastBackendMessage = this.chat.backendMessages[this.chat.backendMessages.length - 1];
    let lastUserMessage;
    if (!lastBackendMessage) {
      lastUserMessage = this.chat.task;
    } else {
      if (lastBackendMessage.role === 'user') {
        lastUserMessage = lastBackendMessage;
      }
    }

    if (!lastUserMessage) {
      return '';
    }

    const params = {
      query: this.chat.task + (lastUserMessage ? ' ' + lastUserMessage.content : ''),
      limit: 10,
      filenamesOnly: true,
    };
    const projectController = chatController.agent.projectController;

    const relevantFilesAndFolders = await projectController.searchEmbeddings(params);
    if (!relevantFilesAndFolders || relevantFilesAndFolders.length === 0) {
      return '';
    } else {
      const relevantFilesAndFoldersMessage = relevantFilesAndFolders
        .map((result) => {
          return `- "${result}"`;
        })
        .join('\n');
      return `These files might or might not be relevant:\n<relevant_files_and_folders>\n${relevantFilesAndFoldersMessage}\n</relevant_files_and_folders>\n`;
    }
  }

  async getRelevantFilesContents() {
    const relevantFileNames = await this.getListOfRelevantFiles();
    if (relevantFileNames.length === 0) {
      return '';
    }

    let fileContents = await this.getFileContents(relevantFileNames);
    fileContents = await this.reduceRelevantFilesContext(fileContents, relevantFileNames);

    return fileContents
      ? `\n\nCurrent content of the files (do not read these files again. Do not thank me for providing these files):\n<relevant_files_contents>${fileContents}\n</relevant_files_contents>`
      : '';
  }

  async getListOfRelevantFiles() {
    const chatInteractionFiles = await this.getChatInteractionFiles();
    const editedFiles = chatController.agent.projectController.getRecentModifiedFiles(this.lastEditedFilesTimestamp);
    this.lastEditedFilesTimestamp = Date.now();
    const combinedFiles = [...new Set([...chatInteractionFiles, ...this.taskRelevantFiles, ...editedFiles])].slice(
      0,
      20,
    );
    this.taskRelevantFiles = combinedFiles;

    return combinedFiles;
  }

  async getChatInteractionFiles() {
    const chatFiles = this.chat.backendMessages
      .filter((message) => message.id > this.lastMessageIdForRelevantFiles)
      .filter((message) => message.role === 'assistant' && message.tool_calls)
      .flatMap((message) =>
        message.tool_calls
          .map((toolCall) => {
            const parsedArguments = chatController.agent.parseArguments(toolCall.function.arguments);
            return parsedArguments.hasOwnProperty('targetFile') ? parsedArguments.targetFile : undefined;
          })
          .filter((file) => file !== undefined),
      );
    const normalizedFilePaths = await Promise.all(chatFiles.map((file) => normalizedFilePath(file)));
    const chatInteractionFiles = normalizedFilePaths
      .filter((file) => fs.existsSync(file) && !fs.statSync(file).isDirectory())
      .reverse();
    this.lastMessageIdForRelevantFiles = this.backendMessages.length - 1;

    return chatInteractionFiles;
  }

  async getFileContents(fileList) {
    if (fileList.length === 0) {
      return '';
    }

    const fileReadPromises = fileList.map((file) => this.readFile(file));
    const fileContents = await Promise.all(fileReadPromises);

    return fileList
      .map((file, index) => `\n<file_content file="${file}">\n${fileContents[index]}\n</file_content>`)
      .join('\n\n');
  }

  async reduceRelevantFilesContext(fileContents, fileList) {
    const fileContentTokenCount = getTokenCount(fileContents);
    const lastMessageId = this.chat.backendMessages.length - 1;
    if (
      fileContentTokenCount > MAX_RELEVANT_FILES_TOKENS &&
      fileList.length > MAX_RELEVANT_FILES_COUNT &&
      (lastMessageId - this.reduceRelevantFilesContextMessageId >= 10 || this.reduceRelevantFilesContextMessageId === 0)
    ) {
      this.reduceRelevantFilesContextMessageId = lastMessageId;
      const relevantFiles = await this.updateListOfRelevantFiles(fileContents);
      if (Array.isArray(relevantFiles)) {
        console.log('Reducing relevant files context', relevantFiles);
        this.taskRelevantFiles = relevantFiles.slice(0, MAX_RELEVANT_FILES_COUNT);
        return await this.getFileContents(relevantFiles);
      }
    }

    return fileContents;
  }

  async updateListOfRelevantFiles(fileContents) {
    const messageHistory = [this.addTaskMessage(), await this.addSummaryOfMessages()];

    const prompt = `AI coding assistant is helping user with a task.
    Here is a summary of the conversation and what was done: ${messageHistory}
    
    The content of the files is too long to process. Out of the list of files below, select the most relevant files that the assistant still needs to know the contents of in order to complete the user's task.
    The files are:\n\n${fileContents}
    
    Include only required files, exclude files that are already processed or most likely not needed.
    Respond with an array of file paths exactly as they appeared (do not shorten or change file paths) in the list above, separated by commas.
    If all files are relevant, respond with a list of all files.
    Order the files by how much assistant still needs to know about them to complete the user's task, most important first.
    `;

    const format = {
      type: 'array',
      description: 'Array of relevant file paths',
      items: {
        type: 'string',
      },
    };

    const result = await chatController.backgroundTask.run({
      prompt,
      format,
      model: chatController.settings.selectedModel,
    });

    return result;
  }

  async readFile(filePath) {
    try {
      const stats = await fs.promises.stat(filePath);
      if (!isTextFile(filePath) || stats.size > MAX_FILE_SIZE) {
        console.error(`Skipped file (non-text or too large): ${filePath}`);
        return null;
      }
      const content = await fs.promises.readFile(filePath, 'utf8');
      return this.addLineNumbers(content);
    } catch (error) {
      console.error(`Error reading file ${filePath}:`, error);
      return null;
    }
  }

  addLineNumbers(content) {
    const lines = content.split('\n');
    const paddedLines = lines.map((line, index) => {
      const lineNumber = (index + 1).toString().padStart(4, ' ');
      return `${lineNumber}|${line}`;
    });
    content = paddedLines.join('\n');
    return content;
  }

  addLastUserMessage(userMessage) {
    if (!userMessage) {
      userMessage = '';
    }

    return userMessage ? `<user>${userMessage}</user>\n` : '';
  }

  addReflectMessage(reflectMessage) {
    if (!reflectMessage) {
      return null;
    }

    return `
      "assistant" proposed this change:
      
      ${JSON.stringify(reflectMessage, null, 2)}
      
      This can be improved.
      First step by step explain how code/commamnd can be improved or fixed, what bugs it has, what was not implemented correctly or fully, and what may not work.
      Then run the same tool but with improved code/command based on your explanation. Only provide code/command in the tool not in message content`;
  }

  fromTemplate(content, placeholder, value) {
    const regex = new RegExp(placeholder, 'g');
    return content.replace(regex, value);
  }

  async projectStateToText() {
    const dirName = path.basename(await chatController.terminalSession.getCurrentDirectory());

    let projectStateText = '';
    projectStateText += `Current directory is '${dirName}'. The full path to this directory is '${chatController.agent.currentWorkingDir}'`;
    if (chatController.agent.projectController.currentProject) {
      const filesInFolder = await withErrorHandling(this.getFolderStructure.bind(this));
      if (filesInFolder) {
        projectStateText += `\nThe contents of this directory (excluding files from .gitignore): \n${filesInFolder}`;
      }
    }

    return projectStateText ? `\n<current_project_state>\n${projectStateText}\n</current_project_state>\n` : '';
  }

  async getFolderStructure() {
    const ig = ignore().add(ignorePatterns);
    const rootDir = chatController.agent.currentWorkingDir;

    // Recursive function to list files
    const listFiles = async (dir, allFiles = [], currentPath = '') => {
      const entries = await fs.promises.readdir(dir, { withFileTypes: true });
      for (let entry of entries) {
        const entryPath = path.join(dir, entry.name);
        const relativePath = path.join(currentPath, entry.name);

        if (entry.isDirectory()) {
          await listFiles(entryPath, allFiles, relativePath);
        } else {
          allFiles.push(relativePath);
        }
      }
      return allFiles;
    };

    try {
      const allFiles = await listFiles(rootDir);
      const filesExcludingIgnored = allFiles.filter((file) => !ig.ignores(file));

      if (allFiles.length === 0) {
        // If directory is empty
        this.searchRelevantFiles = false;
        return 'The directory is empty.';
      } else if (filesExcludingIgnored.length <= 30) {
        this.searchRelevantFiles = false;
        return filesExcludingIgnored.map((file) => `- ${file}`).join('\n');
      } else {
        // If more than 30 files, only show top-level directories and files
        this.searchRelevantFiles = true;
        const topLevelEntries = await fs.promises.readdir(rootDir, { withFileTypes: true });
        const filteredTopLevelEntries = topLevelEntries.filter((entry) => !ig.ignores(entry.name));

        const folderStructure = [];
        for (const entry of filteredTopLevelEntries) {
          if (entry.isDirectory()) {
            folderStructure.push(`- ${entry.name}/`);
            const subEntries = await fs.promises.readdir(path.join(rootDir, entry.name), { withFileTypes: true });
            const filteredSubEntries = subEntries.filter(
              (subEntry) => !ig.ignores(path.join(entry.name, subEntry.name)),
            );
            for (const subEntry of filteredSubEntries) {
              folderStructure.push(`  - ${subEntry.name}${subEntry.isDirectory() ? '/' : ''}`);
            }
          } else {
            folderStructure.push(`- ${entry.name}`);
          }
        }

        return folderStructure.join('\n');
      }
    } catch (error) {
      chatController.chat.addFrontendMessage(
        'error',
        `Error occurred while checking directory structure in ${rootDir}.
       <br>Please change directory where app can read/write files or update permissions for current directory.`,
      );
      return;
    }
  }
}

module.exports = ChatContextBuilder;
