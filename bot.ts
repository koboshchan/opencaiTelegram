import { Db, ObjectId } from "mongodb";
import crypto from "crypto";

interface UserLink {
  _id?: ObjectId;
  tgUserId: number;
  clerkUserId: string;
  tgUsername?: string | null;
  createdAt: Date;
}

interface AuthToken {
  _id?: ObjectId;
  token: string;
  tgUserId: number;
  tgChatId: number;
  tgUsername?: string | null;
  createdAt: Date;
}

interface WizardState {
  _id?: ObjectId;
  tgUserId: number;
  tgChatId: number;
  step: "name" | "description" | "systemPrompt" | "visibility" | "import" | "profile_name" | "profile_description";
  data: {
    name?: string;
    description?: string;
    systemPrompt?: string;
    visibility?: "public" | "private";
  };
  updatedAt: Date;
}

interface TgChatMapping {
  _id?: ObjectId;
  tgChatId: number;
  tgThreadId: number;
  chatId: string;
  clerkUserId: string;
  createdAt: Date;
}

export class TelegramBot {
  private db: Db;
  private botToken: string;
  private apiBaseUrl: string;
  private botSecret: string;
  private botUsername: string | null = null;

  constructor(db: Db, botToken: string, apiBaseUrl: string, botSecret: string) {
    this.db = db;
    this.botToken = botToken;
    this.apiBaseUrl = apiBaseUrl.replace(/\/+$/, "");
    this.botSecret = botSecret;
  }

  async init() {
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
      if (update.message) {
        await this.handleMessage(update.message);
      } else if (update.callback_query) {
        await this.handleCallbackQuery(update.callback_query);
      }
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

  private async handleStart(message: any) {
    const text = message.text?.trim() || "";
    const from = message.from;
    const chat = message.chat;
    const threadId = message.message_thread_id;

    // Handle Clerk redirect token linking
    // /start link_<clerkUserId>_<token>
    if (text.includes("link_")) {
      const param = text.split(" ")[1];
      if (param && param.startsWith("link_")) {
        const payload = param.substring(5); // remove "link_"
        const lastUnderscore = payload.lastIndexOf("_");
        if (lastUnderscore !== -1) {
          const clerkUserId = payload.substring(0, lastUnderscore);
          const token = payload.substring(lastUnderscore + 1);

          const tokenDoc = await this.db.collection<AuthToken>("authTokens").findOne({ token, tgUserId: from.id });
          if (tokenDoc) {
            // Linked!
            await this.db.collection<UserLink>("userLinks").updateOne(
              { tgUserId: from.id },
              {
                $set: {
                  clerkUserId,
                  tgUsername: from.username || null,
                  createdAt: new Date(),
                },
              },
              { upsert: true }
            );

            await this.db.collection<AuthToken>("authTokens").deleteOne({ _id: tokenDoc._id });

            await this.sendTelegram("sendMessage", {
              chat_id: chat.id,
              message_thread_id: threadId,
              text: `🎉 Account successfully linked! You are logged in as Clerk User: ${clerkUserId}. You can now run bot commands.`,
            });
            return;
          } else {
            await this.sendTelegram("sendMessage", {
              chat_id: chat.id,
              message_thread_id: threadId,
              text: "❌ Invalid or expired linking token. Please try again.",
            });
            return;
          }
        }
      }
    }

    const isPrivate = chat.type === "private";
    let welcomeText = "👋 Welcome to OpenCai Bot! Link your account to start managing and chatting with AI characters.\n\nUse /characters to see your list, /create to make one, or /import to import from Character.AI.";
    if (isPrivate) {
      welcomeText += "\n\nℹ️ *Note*: This bot is designed to run in a Group Chat with Topics (Forum) enabled. Please add it to a topic-enabled group chat to use commands and chat with characters.";
    }

    await this.sendTelegram("sendMessage", {
      chat_id: chat.id,
      message_thread_id: threadId,
      text: welcomeText,
      parse_mode: "Markdown",
    });

    const link = await this.getUserLink(from.id);
    if (!link) {
      await this.sendAuthLink(chat.id, from.id, from.username, threadId);
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

  private async sendAuthLink(chatId: number, tgUserId: number, tgUsername: string | null, threadId?: number) {
    const token = crypto.randomBytes(8).toString("hex");
    await this.db.collection<AuthToken>("authTokens").updateOne(
      { tgUserId },
      {
        $set: {
          token,
          tgChatId: chatId,
          tgUsername: tgUsername || null,
          createdAt: new Date(),
        },
      },
      { upsert: true }
    );

    const botName = this.botUsername || "opencai_bot";
    const authUrl = `${this.apiBaseUrl}/tg-auth?token=${token}&bot=${botName}`;

    await this.sendTelegram("sendMessage", {
      chat_id: chatId,
      message_thread_id: threadId,
      text: `🔐 *Authentication Required*\n\nPlease login with Clerk to link your Telegram account:\n\n[Login and Link Account](${authUrl})`,
      parse_mode: "Markdown",
    });
  }

  private async startCreateWizard(chatId: number, tgUserId: number, threadId?: number) {
    await this.db.collection<WizardState>("tgWizardState").updateOne(
      { tgUserId, tgChatId: chatId },
      {
        $set: {
          step: "name",
          data: {},
          updatedAt: new Date(),
        },
      },
      { upsert: true }
    );

    await this.sendTelegram("sendMessage", {
      chat_id: chatId,
      message_thread_id: threadId,
      text: "🎨 *Character Creation Wizard*\n\nStep 1/4: What is the character's name?",
      parse_mode: "Markdown",
    });
  }

  private async handleWizardInput(message: any, wizard: WizardState) {
    const text = message.text?.trim();
    const chat = message.chat;
    const from = message.from;
    const threadId = message.message_thread_id;

    if (!text) return;

    const link = await this.getUserLink(from.id);
    if (!link) return;

    if (wizard.step === "import") {
      await this.db.collection<WizardState>("tgWizardState").deleteOne({ _id: wizard._id });
      await this.handleImport(chat.id, from.id, link.clerkUserId, text, threadId);
      return;
    }

    if (wizard.step === "profile_name") {
      await this.db.collection<WizardState>("tgWizardState").deleteOne({ _id: wizard._id });
      try {
        const response = await fetch(`${this.apiBaseUrl}/api/me`, {
          method: "PATCH",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${this.botSecret}`,
            "x-clerk-user-id": link.clerkUserId,
          },
          body: JSON.stringify({ displayName: text }),
        });
        const resData = await response.json();
        if (response.ok) {
          await this.sendTelegram("sendMessage", {
            chat_id: chat.id,
            message_thread_id: threadId,
            text: `✅ Display name successfully updated to: *${resData.user.displayName}*`,
            parse_mode: "Markdown",
          });
        } else {
          throw new Error(resData.error?.message || "Failed to update profile.");
        }
      } catch (err: any) {
        await this.sendTelegram("sendMessage", {
          chat_id: chat.id,
          message_thread_id: threadId,
          text: `❌ Failed to update name: ${err.message}`,
        });
      }
      return;
    }

    if (wizard.step === "profile_description") {
      await this.db.collection<WizardState>("tgWizardState").deleteOne({ _id: wizard._id });
      try {
        const response = await fetch(`${this.apiBaseUrl}/api/me`, {
          method: "PATCH",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${this.botSecret}`,
            "x-clerk-user-id": link.clerkUserId,
          },
          body: JSON.stringify({ description: text }),
        });
        const resData = await response.json();
        if (response.ok) {
          await this.sendTelegram("sendMessage", {
            chat_id: chat.id,
            message_thread_id: threadId,
            text: `✅ Bio/description successfully updated!`,
          });
        } else {
          throw new Error(resData.error?.message || "Failed to update profile.");
        }
      } catch (err: any) {
        await this.sendTelegram("sendMessage", {
          chat_id: chat.id,
          message_thread_id: threadId,
          text: `❌ Failed to update bio: ${err.message}`,
        });
      }
      return;
    }

    if (wizard.step === "name") {
      await this.db.collection<WizardState>("tgWizardState").updateOne(
        { _id: wizard._id },
        {
          $set: {
            step: "description",
            "data.name": text,
            updatedAt: new Date(),
          },
        }
      );
      await this.sendTelegram("sendMessage", {
        chat_id: chat.id,
        message_thread_id: threadId,
        text: `Step 2/4: Enter a short description for ${text} (e.g. what is this character for?).`,
      });
    } else if (wizard.step === "description") {
      await this.db.collection<WizardState>("tgWizardState").updateOne(
        { _id: wizard._id },
        {
          $set: {
            step: "systemPrompt",
            "data.description": text,
            updatedAt: new Date(),
          },
        }
      );
      await this.sendTelegram("sendMessage", {
        chat_id: chat.id,
        message_thread_id: threadId,
        text: `Step 3/4: Enter the system prompt / behavior details for ${wizard.data.name}.`,
      });
    } else if (wizard.step === "systemPrompt") {
      await this.db.collection<WizardState>("tgWizardState").updateOne(
        { _id: wizard._id },
        {
          $set: {
            step: "visibility",
            "data.systemPrompt": text,
            updatedAt: new Date(),
          },
        }
      );
      await this.sendTelegram("sendMessage", {
        chat_id: chat.id,
        message_thread_id: threadId,
        text: `Step 4/4: Visibility. Enter 'public' or 'private'.`,
      });
    } else if (wizard.step === "visibility") {
      const visibility = text.toLowerCase() === "public" ? "public" : "private";
      const name = wizard.data.name!;
      const description = wizard.data.description!;
      const systemPrompt = wizard.data.systemPrompt!;

      // Complete Creation
      await this.sendTelegram("sendMessage", {
        chat_id: chat.id,
        message_thread_id: threadId,
        text: `Saving character ${name}...`,
      });

      try {
        const response = await fetch(`${this.apiBaseUrl}/api/characters`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${this.botSecret}`,
            "x-clerk-user-id": link.clerkUserId,
          },
          body: JSON.stringify({
            name,
            description,
            systemPrompt,
            visibility,
            tags: [],
          }),
        });

        const resData = await response.json();
        if (response.ok) {
          const charId = resData.character.id;
          await this.db.collection<WizardState>("tgWizardState").deleteOne({ _id: wizard._id });

          await this.sendTelegram("sendMessage", {
            chat_id: chat.id,
            message_thread_id: threadId,
            text: `🎉 *Character Created!*\n\n*Name*: ${name}\n*ID*: \`${charId}\``,
            parse_mode: "Markdown",
            reply_markup: {
              inline_keyboard: [
                [
                  { text: "💬 Start Chatting", callback_data: `start_chat:${charId}` },
                ],
              ],
            },
          });
        } else {
          throw new Error(resData.error?.message || "Creation failed.");
        }
      } catch (err: any) {
        await this.sendTelegram("sendMessage", {
          chat_id: chat.id,
          message_thread_id: threadId,
          text: `❌ Failed to create character: ${err.message}. Starting over.`,
        });
        await this.db.collection<WizardState>("tgWizardState").deleteOne({ _id: wizard._id });
      }
    }
  }

  private async handleImport(chatId: number, tgUserId: number, clerkUserId: string, url: string, threadId?: number) {
    await this.sendTelegram("sendMessage", {
      chat_id: chatId,
      message_thread_id: threadId,
      text: "📥 Importing character from Character.AI...",
    });

    try {
      const response = await fetch(`${this.apiBaseUrl}/api/import-character`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.botSecret}`,
          "x-clerk-user-id": clerkUserId,
        },
        body: JSON.stringify({
          url,
          visibility: "private",
        }),
      });

      const resData = await response.json();
      if (response.ok) {
        // Find the imported character to get its ID
        const charsResponse = await fetch(`${this.apiBaseUrl}/api/characters`, {
          headers: {
            Authorization: `Bearer ${this.botSecret}`,
            "x-clerk-user-id": clerkUserId,
          },
        });
        const charsData = await charsResponse.json();
        const latestChar = charsData.characters?.[0];

        if (latestChar) {
          await this.sendTelegram("sendMessage", {
            chat_id: chatId,
            message_thread_id: threadId,
            text: `🎉 *Character Imported!*\n\n*Name*: ${latestChar.name}\n*ID*: \`${latestChar.id}\``,
            parse_mode: "Markdown",
            reply_markup: {
              inline_keyboard: [
                [
                  { text: "💬 Start Chatting", callback_data: `start_chat:${latestChar.id}` },
                ],
              ],
            },
          });
        } else {
          await this.sendTelegram("sendMessage", {
            chat_id: chatId,
            message_thread_id: threadId,
            text: "🎉 Character imported! Refresh your dashboard or run /characters to view.",
          });
        }
      } else {
        throw new Error(resData.error?.message || "Import failed.");
      }
    } catch (err: any) {
      await this.sendTelegram("sendMessage", {
        chat_id: chatId,
        message_thread_id: threadId,
        text: `❌ Import failed: ${err.message}`,
      });
    }
  }

  private async showProfile(chatId: number, tgUserId: number, clerkUserId: string, threadId?: number, editMessageId?: number) {
    try {
      const response = await fetch(`${this.apiBaseUrl}/api/me`, {
        headers: {
          Authorization: `Bearer ${this.botSecret}`,
          "x-clerk-user-id": clerkUserId,
        },
      });
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error?.message || "Failed to fetch profile.");
      }
      const user = data.user;
      const profileText = `👤 *Your Profile*\n\n` +
        `*Name*: ${user.displayName || "Not set"}\n` +
        `*Bio/Description*: ${user.description || "Not set"}\n` +
        `*Clerk User ID*: \`${user.clerkUserId}\`\n` +
        `*Email*: ${user.email || "Not set"}`;

      const replyMarkup = {
        inline_keyboard: [
          [
            { text: "✏️ Edit Name", callback_data: `profile_edit:name` },
            { text: "✏️ Edit Bio", callback_data: `profile_edit:bio` },
          ],
          [
            { text: "🔄 Refresh", callback_data: `profile_refresh` },
          ]
        ],
      };

      if (editMessageId) {
        await this.sendTelegram("editMessageText", {
          chat_id: chatId,
          message_id: editMessageId,
          message_thread_id: threadId,
          text: profileText,
          parse_mode: "Markdown",
          reply_markup: replyMarkup,
        });
      } else {
        await this.sendTelegram("sendMessage", {
          chat_id: chatId,
          message_thread_id: threadId,
          text: profileText,
          parse_mode: "Markdown",
          reply_markup: replyMarkup,
        });
      }
    } catch (err: any) {
      await this.sendTelegram("sendMessage", {
        chat_id: chatId,
        message_thread_id: threadId,
        text: `❌ Failed to load profile: ${err.message}`,
      });
    }
  }

  private async listCharacters(chatId: number, tgUserId: number, clerkUserId: string, threadId?: number, editMessageId?: number) {
    try {
      const response = await fetch(`${this.apiBaseUrl}/api/characters`, {
        headers: {
          Authorization: `Bearer ${this.botSecret}`,
          "x-clerk-user-id": clerkUserId,
        },
      });
      const data = await response.json();
      const characters = data.characters || [];

      if (!characters.length) {
        const text = "📭 You don't own any characters yet. Use /create to create one.";
        if (editMessageId) {
          await this.sendTelegram("editMessageText", { chat_id: chatId, message_id: editMessageId, text });
        } else {
          await this.sendTelegram("sendMessage", { chat_id: chatId, message_id: editMessageId, message_thread_id: threadId, text });
        }
        return;
      }

      let text = "👥 *Your Characters*:\n\n";
      const inlineKeyboard: any[] = [];

      characters.forEach((char: any) => {
        text += `• *${char.name}* (ID: \`${char.id}\`)\n  _${char.description}_\n\n`;
        inlineKeyboard.push([
          { text: `ℹ️ ${char.name} details`, callback_data: `details:${char.id}` },
          { text: `💬 Chat`, callback_data: `start_chat:${char.id}` },
        ]);
      });

      if (editMessageId) {
        await this.sendTelegram("editMessageText", {
          chat_id: chatId,
          message_id: editMessageId,
          text,
          parse_mode: "Markdown",
          reply_markup: { inline_keyboard: inlineKeyboard },
        });
      } else {
        await this.sendTelegram("sendMessage", {
          chat_id: chatId,
          message_thread_id: threadId,
          text,
          parse_mode: "Markdown",
          reply_markup: { inline_keyboard: inlineKeyboard },
        });
      }
    } catch (err: any) {
      await this.sendTelegram("sendMessage", {
        chat_id: chatId,
        message_thread_id: threadId,
        text: `❌ Failed to fetch characters: ${err.message}`,
      });
    }
  }

  private async showCharacterDetails(chatId: number, clerkUserId: string, charId: string, threadId?: number, editMessageId?: number) {
    try {
      const response = await fetch(`${this.apiBaseUrl}/api/characters`, {
        headers: {
          Authorization: `Bearer ${this.botSecret}`,
          "x-clerk-user-id": clerkUserId,
        },
      });
      const data = await response.json();
      const character = (data.characters || []).find((c: any) => c.id === charId);

      if (!character) {
        await this.sendTelegram("sendMessage", {
          chat_id: chatId,
          message_thread_id: threadId,
          text: "❌ Character not found.",
        });
        return;
      }

      const text = `ℹ️ *Character Details*\n\n*Name*: ${character.name}\n*Description*: ${character.description}\n*Visibility*: ${character.visibility}\n\n*System Prompt*:\n\`\`\`\n${character.systemPrompt}\n\`\`\``;
      const inlineKeyboard = [
        [
          { text: "💬 Start Chat", callback_data: `start_chat:${character.id}` },
          { text: "⬅️ Back to List", callback_data: "list_chars:" },
        ]
      ];

      await this.sendTelegram("editMessageText", {
        chat_id: chatId,
        message_id: editMessageId,
        text,
        parse_mode: "Markdown",
        reply_markup: { inline_keyboard: inlineKeyboard },
      });
    } catch (err: any) {
      await this.sendTelegram("sendMessage", {
        chat_id: chatId,
        message_thread_id: threadId,
        text: `❌ Failed to fetch details: ${err.message}`,
      });
    }
  }

  private async initiateTopicChat(chatId: number, tgUserId: number, clerkUserId: string, charId: string, threadId?: number) {
    try {
      const response = await fetch(`${this.apiBaseUrl}/api/characters`, {
        headers: {
          Authorization: `Bearer ${this.botSecret}`,
          "x-clerk-user-id": clerkUserId,
        },
      });
      const data = await response.json();
      const character = (data.characters || []).find((c: any) => c.id === charId);

      if (!character) {
        throw new Error("Character not found.");
      }

      // 1. Create a forum topic on Telegram
      const topicResult = await this.callTelegram("createForumTopic", {
        chat_id: chatId,
        name: character.name,
      });

      if (!topicResult?.ok) {
        const desc = topicResult?.description || "Failed to create forum topic.";
        if (desc.toLowerCase().includes("rights")) {
          throw new Error("Bad Request: not enough rights to create a topic. Please ensure the bot is promoted to an Administrator in this group chat with the 'Manage Topics' (or 'Manage Forums') permission enabled.");
        }
        throw new Error(desc);
      }

      const newThreadId = topicResult.result.message_thread_id;

      // 2. Create the chat record on OpenCai API
      const chatResponse = await fetch(`${this.apiBaseUrl}/api/characters/${charId}/chats`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.botSecret}`,
          "x-clerk-user-id": clerkUserId,
        },
        body: JSON.stringify({
          title: `Telegram chat: ${character.name}`,
        }),
      });

      const chatData = await chatResponse.json();
      if (!chatResponse.ok) {
        throw new Error(chatData.error?.message || "Failed to start chat.");
      }

      const openCaiChatId = chatData.chat.id;

      // 3. Save mapping in database
      const mapping: TgChatMapping = {
        tgChatId: chatId,
        tgThreadId: newThreadId,
        chatId: openCaiChatId,
        clerkUserId,
        createdAt: new Date(),
      };
      await this.db.collection<TgChatMapping>("tgChats").insertOne(mapping);

      // 4. Trigger the first message generation (character greeting)
      await this.sendTelegram("sendChatAction", {
        chat_id: chatId,
        message_thread_id: newThreadId,
        action: "typing",
      });

      const msgResponse = await fetch(`${this.apiBaseUrl}/api/chats/${openCaiChatId}/messages`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.botSecret}`,
          "x-clerk-user-id": clerkUserId,
        },
        body: JSON.stringify({}),
      });

      let greetingText = "";
      if (msgResponse.ok && msgResponse.body) {
        const reader = (msgResponse.body as any).getReader();
        const decoder = new TextDecoder();
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          greetingText += decoder.decode(value);
        }
      }

      if (!greetingText.trim()) {
        greetingText = `👋 Hello! I am ${character.name}. Let's chat!`;
      }

      // Send the character's greeting directly to the topic thread
      try {
        await this.sendTelegram("sendMessage", {
          chat_id: chatId,
          message_thread_id: newThreadId,
          text: greetingText,
          parse_mode: "Markdown",
        });
      } catch (err) {
        // Fallback to plain text if markdown parsing fails
        await this.sendTelegram("sendMessage", {
          chat_id: chatId,
          message_thread_id: newThreadId,
          text: greetingText,
        });
      }

      // 5. Notify in Controls topic
      await this.sendTelegram("sendMessage", {
        chat_id: chatId,
        message_thread_id: threadId,
        text: `💬 Topic *${character.name}* created successfully! Click on the topic thread to start chatting.`,
        parse_mode: "Markdown",
      });
    } catch (err: any) {
      await this.sendTelegram("sendMessage", {
        chat_id: chatId,
        message_thread_id: threadId,
        text: `❌ Failed to initiate chat: ${err.message}`,
      });
    }
  }

  private async handleChatReply(message: any, mapping: TgChatMapping) {
    const text = message.text?.trim();
    if (!text) return;

    // Send typing state
    await this.sendTelegram("sendChatAction", {
      chat_id: mapping.tgChatId,
      message_thread_id: mapping.tgThreadId,
      action: "typing",
    });

    try {
      const response = await fetch(`${this.apiBaseUrl}/api/chats/${mapping.chatId}/messages`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.botSecret}`,
          "x-clerk-user-id": mapping.clerkUserId,
        },
        body: JSON.stringify({
          content: text,
        }),
      });

      if (!response.ok || !response.body) {
        const errData = await response.json();
        throw new Error(errData.error?.message || "API completion failed.");
      }

      // Read text stream fully
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let assistantText = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        assistantText += decoder.decode(value);
      }

      if (assistantText.trim()) {
        try {
          await this.sendTelegram("sendMessage", {
            chat_id: mapping.tgChatId,
            message_thread_id: mapping.tgThreadId,
            text: assistantText,
            parse_mode: "Markdown",
          });
        } catch (err) {
          // Fallback to plain text if Markdown parsing fails
          await this.sendTelegram("sendMessage", {
            chat_id: mapping.tgChatId,
            message_thread_id: mapping.tgThreadId,
            text: assistantText,
          });
        }
      }
    } catch (err: any) {
      await this.sendTelegram("sendMessage", {
        chat_id: mapping.tgChatId,
        message_thread_id: mapping.tgThreadId,
        text: `❌ API Error: ${err.message}`,
      });
    }
  }

  private async getUserLink(tgUserId: number) {
    return this.db.collection<UserLink>("userLinks").findOne({ tgUserId });
  }

  private async getWizardState(tgUserId: number, tgChatId: number) {
    return this.db.collection<WizardState>("tgWizardState").findOne({ tgUserId, tgChatId });
  }

  private async sendTelegram(method: string, body: Record<string, any>) {
    return this.callTelegram(method, body);
  }

  private async callTelegram(method: string, body: Record<string, any>) {
    try {
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
