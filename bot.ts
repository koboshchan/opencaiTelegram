import { Db } from "mongodb";
import { Bot } from "grammy";
import { BotContext, UserLink, AuthToken, WizardState, TgChatMapping } from "./src/types.js";
import { markdownToHtml } from "./src/utils/markdown.js";
import { handleStart, sendAuthLink } from "./src/handlers/auth.js";
import { startCreateWizard, handleWizardInput } from "./src/handlers/wizard.js";
import { handleImport, listCharacters, showCharacterDetails, initiateTopicChat } from "./src/handlers/character.js";
import { showProfile } from "./src/handlers/profile.js";
import { handleChatReply, handleEditReply, handleRegen, checkDeletedMessages } from "./src/handlers/chat.js";

// Re-export types and functions to maintain compatibility with other modules
export { BotContext, UserLink, AuthToken, WizardState, TgChatMapping };
export { markdownToHtml };

export class TelegramBot {
  public db: Db;
  public botToken: string;
  public apiBaseUrl: string;
  public botSecret: string;
  public botUsername: string | null = null;
  public grammyBot: Bot<BotContext>;

  constructor(db: Db, botToken: string, apiBaseUrl: string, botSecret: string) {
    this.db = db;
    this.botToken = botToken;
    this.apiBaseUrl = apiBaseUrl.replace(/\/+$/, "");
    this.botSecret = botSecret;

    this.grammyBot = new Bot<BotContext>(this.botToken);

    // Transform all outgoing "Markdown" parse_mode calls to "HTML" using our markdownToHtml helper
    this.grammyBot.api.config.use((prev, method, payload, signal) => {
      if (payload && "parse_mode" in payload && payload.parse_mode === "Markdown") {
        payload.parse_mode = "HTML";
        if ("text" in payload && typeof payload.text === "string") {
          payload.text = markdownToHtml(payload.text);
        }
        if ("caption" in payload && typeof payload.caption === "string") {
          payload.caption = markdownToHtml(payload.caption);
        }
      }
      return prev(method, payload, signal);
    });

    this.setupGrammyHandlers();
  }

  private setupGrammyHandlers() {
    this.grammyBot.command("regen", async (ctx) => {
      await this.handleRegen(ctx);
    });

    this.grammyBot.on("edited_message", async (ctx) => {
      const message = ctx.editedMessage;
      const text = message?.text?.trim();
      const chat = message?.chat;
      const threadId = message?.message_thread_id;

      if (text && !text.startsWith("/") && threadId && chat) {
        const mapping = await this.db.collection<TgChatMapping>("tgChats").findOne({
          tgChatId: chat.id,
          tgThreadId: threadId,
        });

        if (mapping && mapping.lastUserTgMessageId === message.message_id) {
          console.log(`[Edit] Last user message was edited in thread ${threadId}: ${text}`);
          await this.handleEditReply(ctx, mapping);
        }
      }
    });

    this.grammyBot.on("message:text", async (ctx) => {
      const text = ctx.message.text?.trim();
      const chat = ctx.chat;
      const threadId = ctx.message.message_thread_id;

      if (text && !text.startsWith("/") && threadId) {
        const mapping = await this.db.collection<TgChatMapping>("tgChats").findOne({
          tgChatId: chat.id,
          tgThreadId: threadId,
        });
        if (mapping) {
          await this.handleChatReply(ctx, mapping);
          return;
        }
      }

      await this.handleMessage(ctx.message);
    });

    this.grammyBot.on("callback_query", async (ctx) => {
      await this.handleCallbackQuery(ctx.callbackQuery);
    });

    this.grammyBot.on("message", async (ctx) => {
      await this.handleMessage(ctx.message);
    });
  }

  async init() {
    await this.grammyBot.init();
    const me = await this.callTelegram("getMe", {});
    if (me?.ok) {
      this.botUsername = me.result.username;
      console.log(`Telegram Bot @${this.botUsername} initialized successfully.`);

      // Register bot commands for tab-completion
      const commands = [
        { command: "start", description: "Start the bot and link your account" },
        { command: "characters", description: "List your AI characters" },
        { command: "create", description: "Create a new AI character" },
        { command: "import", description: "Import a character from Character.AI" },
        { command: "profile", description: "View and edit your user profile" },
        { command: "regen", description: "Regenerate the last character response" },
        { command: "cancel", description: "Cancel the active wizard or action" }
      ];
      const registerRes = await this.callTelegram("setMyCommands", { commands });
      if (registerRes?.ok) {
        console.log("Bot commands registered successfully for tab-completion.");
      } else {
        console.warn("Failed to register bot commands:", registerRes);
      }
    } else {
      console.error("Failed to initialize bot with getMe. Check TELEGRAM_BOT_TOKEN.");
    }
  }

  async handleUpdate(update: any) {
    try {
      await this.grammyBot.handleUpdate(update);
    } catch (err) {
      console.error("Error handling update:", err);
    }
  }

  private async handleMessage(message: any) {
    const text = message.text?.trim();
    const chat = message.chat;
    const from = message.from;
    const threadId = message.message_thread_id;

    if (!from || !text) return;

    // Check if this is a group chat with topics (supergroup with is_forum)
    const isForum = chat.type === "supergroup" && chat.is_forum;

    // Command Check
    const isCommand = text.startsWith("/");

    if (isCommand) {
      let command = text.split(" ")[0].toLowerCase();
      if (this.botUsername && command.includes(`@${this.botUsername.toLowerCase()}`)) {
        command = command.split("@")[0];
      }
      if (command === "/start") {
        await this.handleStart(message);
        return;
      }

      if (command === "/cancel") {
        await this.db.collection<WizardState>("tgWizardState").deleteOne({ tgUserId: from.id, tgChatId: chat.id });
        await this.sendTelegram("sendMessage", {
          chat_id: chat.id,
          message_thread_id: threadId,
          text: "❌ Wizard or active action has been cancelled.",
        });
        return;
      }

      // Verification: must be run in a forum supergroup
      if (!isForum) {
        await this.sendTelegram("sendMessage", {
          chat_id: chat.id,
          text: "⚠️ This bot is designed to run in a Group Chat with Topics (Forum) enabled. Please add it to a topic-enabled group chat to use it.",
          reply_to_message_id: message.message_id,
        });
        return;
      }

      // Check authentication for all other commands
      const link = await this.getUserLink(from.id);
      if (!link) {
        await this.sendAuthLink(chat.id, from.id, from.username, threadId);
        return;
      }

      if (command === "/create") {
        await this.startCreateWizard(chat.id, from.id, threadId);
      } else if (command === "/import") {
        const parts = text.split(" ");
        if (parts.length < 2 || !parts[1].trim()) {
          await this.db.collection<WizardState>("tgWizardState").updateOne(
            { tgUserId: from.id, tgChatId: chat.id },
            {
              $set: {
                step: "import",
                data: {},
                updatedAt: new Date(),
              },
            },
            { upsert: true }
          );
          await this.sendTelegram("sendMessage", {
            chat_id: chat.id,
            message_thread_id: threadId,
            text: "Please send the Character.AI URL link you want to import.",
          });
          return;
        }
        const url = parts[1];
        await this.handleImport(chat.id, from.id, link.clerkUserId, url, threadId);
      } else if (command === "/characters") {
        await this.listCharacters(chat.id, from.id, link.clerkUserId, threadId);
      } else if (command === "/profile") {
        await this.showProfile(chat.id, from.id, link.clerkUserId, threadId);
      }
    } else {
      // It's not a command. Check if user is in character creation wizard
      const wizard = await this.getWizardState(from.id, chat.id);
      if (wizard) {
        await this.handleWizardInput(message, wizard);
        return;
      }

      // Check if this message was sent inside a registered character chat thread
      if (threadId) {
        const mapping = await this.db.collection<TgChatMapping>("tgChats").findOne({
          tgChatId: chat.id,
          tgThreadId: threadId,
        });
        if (mapping) {
          await this.handleChatReply(message, mapping);
        }
      }
    }
  }

  private async handleCallbackQuery(query: any) {
    const data = query.data;
    const from = query.from;
    const message = query.message;
    const threadId = message.message_thread_id;

    await this.callTelegram("answerCallbackQuery", { callback_query_id: query.id });

    const link = await this.getUserLink(from.id);
    if (!link) {
      await this.sendTelegram("sendMessage", {
        chat_id: message.chat.id,
        message_thread_id: threadId,
        text: "⚠️ Please authenticate first using the links above.",
      });
      return;
    }

    if (data.startsWith("start_chat:")) {
      const charId = data.substring(11);
      await this.initiateTopicChat(message.chat.id, from.id, link.clerkUserId, charId, threadId);
    } else if (data.startsWith("details:")) {
      const charId = data.substring(8);
      await this.showCharacterDetails(message.chat.id, link.clerkUserId, charId, threadId, message.message_id);
    } else if (data.startsWith("list_chars:")) {
      await this.listCharacters(message.chat.id, from.id, link.clerkUserId, threadId, message.message_id);
    } else if (data === "profile_edit:name") {
      await this.db.collection<WizardState>("tgWizardState").updateOne(
        { tgUserId: from.id, tgChatId: message.chat.id },
        {
          $set: {
            step: "profile_name",
            data: {},
            updatedAt: new Date(),
          },
        },
        { upsert: true }
      );
      await this.sendTelegram("sendMessage", {
        chat_id: message.chat.id,
        message_thread_id: threadId,
        text: "Please send your new display name (or type /cancel to abort):",
      });
    } else if (data === "profile_edit:bio") {
      await this.db.collection<WizardState>("tgWizardState").updateOne(
        { tgUserId: from.id, tgChatId: message.chat.id },
        {
          $set: {
            step: "profile_description",
            data: {},
            updatedAt: new Date(),
          },
        },
        { upsert: true }
      );
      await this.sendTelegram("sendMessage", {
        chat_id: message.chat.id,
        message_thread_id: threadId,
        text: "Please send your new profile bio/description (or type /cancel to abort):",
      });
    } else if (data === "profile_refresh") {
      await this.showProfile(message.chat.id, from.id, link.clerkUserId, threadId, message.message_id);
    }
  }

  // Delegate Methods to Extracted Modules
  public async handleStart(message: any) {
    return handleStart(this, message);
  }

  public async sendAuthLink(chatId: number, tgUserId: number, tgUsername: string | null, threadId?: number) {
    return sendAuthLink(this, chatId, tgUserId, tgUsername, threadId);
  }

  public async startCreateWizard(chatId: number, tgUserId: number, threadId?: number) {
    return startCreateWizard(this, chatId, tgUserId, threadId);
  }

  public async handleWizardInput(message: any, wizard: WizardState) {
    return handleWizardInput(this, message, wizard);
  }

  public async handleImport(chatId: number, tgUserId: number, clerkUserId: string, url: string, threadId?: number) {
    return handleImport(this, chatId, tgUserId, clerkUserId, url, threadId);
  }

  public async listCharacters(chatId: number, tgUserId: number, clerkUserId: string, threadId?: number, editMessageId?: number) {
    return listCharacters(this, chatId, tgUserId, clerkUserId, threadId, editMessageId);
  }

  public async showCharacterDetails(chatId: number, clerkUserId: string, charId: string, threadId?: number, editMessageId?: number) {
    return showCharacterDetails(this, chatId, clerkUserId, charId, threadId, editMessageId);
  }

  public async initiateTopicChat(chatId: number, tgUserId: number, clerkUserId: string, charId: string, threadId?: number) {
    return initiateTopicChat(this, chatId, tgUserId, clerkUserId, charId, threadId);
  }

  public async handleEditReply(ctx: BotContext, mapping: TgChatMapping) {
    return handleEditReply(this, ctx, mapping);
  }

  public async handleChatReply(ctxOrMsg: BotContext | any, mapping: TgChatMapping) {
    return handleChatReply(this, ctxOrMsg, mapping);
  }

  public async handleRegen(ctx: BotContext) {
    return handleRegen(this, ctx);
  }

  public async showProfile(chatId: number, tgUserId: number, clerkUserId: string, threadId?: number, editMessageId?: number) {
    return showProfile(this, chatId, tgUserId, clerkUserId, threadId, editMessageId);
  }

  public async checkDeletedMessages() {
    return checkDeletedMessages(this);
  }

  // Database and Telegram API Helpers
  public async getUserLink(tgUserId: number) {
    return this.db.collection<UserLink>("userLinks").findOne({ tgUserId });
  }

  public async getWizardState(tgUserId: number, tgChatId: number) {
    return this.db.collection<WizardState>("tgWizardState").findOne({ tgUserId, tgChatId });
  }

  public async sendTelegram(method: string, body: Record<string, any>) {
    return this.callTelegram(method, body);
  }

  public async callTelegram(method: string, body: Record<string, any>) {
    try {
      if (body && body.parse_mode === "Markdown") {
        body.parse_mode = "HTML";
        if (typeof body.text === "string") {
          body.text = markdownToHtml(body.text);
        }
        if (typeof body.caption === "string") {
          body.caption = markdownToHtml(body.caption);
        }
      }
      const response = await fetch(`https://api.telegram.org/bot${this.botToken}/${method}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      return response.json();
    } catch (err) {
      console.error(`Telegram API error for method ${method}:`, err);
      return null;
    }
  }
}
