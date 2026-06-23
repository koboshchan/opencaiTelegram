import type { TelegramBot } from "../../bot.js";
import { WizardState } from "../types.js";
import { handleImport } from "./character.js";

export async function startCreateWizard(bot: TelegramBot, chatId: number, tgUserId: number, threadId?: number) {
  await bot.db.collection<WizardState>("tgWizardState").updateOne(
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

  await bot.sendTelegram("sendMessage", {
    chat_id: chatId,
    message_thread_id: threadId,
    text: "🎨 *Character Creation Wizard*\n\nStep 1/5: What is the character's name?",
    parse_mode: "Markdown",
  });
}

export async function handleWizardInput(bot: TelegramBot, message: any, wizard: WizardState) {
  const text = message.text?.trim();
  const chat = message.chat;
  const from = message.from;
  const threadId = message.message_thread_id;

  if (!text) return;

  const link = await bot.getUserLink(from.id);
  if (!link) return;

  if (wizard.step === "import") {
    await bot.db.collection<WizardState>("tgWizardState").deleteOne({ _id: wizard._id });
    if (!text.startsWith("https://")) {
      await bot.sendTelegram("sendMessage", {
        chat_id: chat.id,
        message_thread_id: threadId,
        text: "❌ Invalid URL. Import URL must start with https://. Import aborted.",
      });
      return;
    }
    await handleImport(bot, chat.id, from.id, link.clerkUserId, text, threadId);
    return;
  }

  if (wizard.step === "search") {
    await bot.db.collection<WizardState>("tgWizardState").deleteOne({ _id: wizard._id });
    await bot.searchCharacters(chat.id, from.id, link.clerkUserId, text, threadId);
    return;
  }

  if (wizard.step === "profile_name") {
    await bot.db.collection<WizardState>("tgWizardState").deleteOne({ _id: wizard._id });
    try {
      const response = await fetch(`${bot.apiBaseUrl}/api/me`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${bot.botSecret}`,
          "x-clerk-user-id": link.clerkUserId,
        },
        body: JSON.stringify({ displayName: text }),
      });
      const resData = await response.json();
      if (response.ok) {
        await bot.sendTelegram("sendMessage", {
          chat_id: chat.id,
          message_thread_id: threadId,
          text: `✅ Display name successfully updated to: *${resData.user.displayName}*`,
          parse_mode: "Markdown",
        });
      } else {
        throw new Error(resData.error?.message || "Failed to update profile.");
      }
    } catch (err: any) {
      await bot.sendTelegram("sendMessage", {
        chat_id: chat.id,
        message_thread_id: threadId,
        text: `❌ Failed to update name: ${err.message}`,
      });
    }
    return;
  }

  if (wizard.step === "profile_description") {
    await bot.db.collection<WizardState>("tgWizardState").deleteOne({ _id: wizard._id });
    try {
      const response = await fetch(`${bot.apiBaseUrl}/api/me`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${bot.botSecret}`,
          "x-clerk-user-id": link.clerkUserId,
        },
        body: JSON.stringify({ description: text }),
      });
      const resData = await response.json();
      if (response.ok) {
        await bot.sendTelegram("sendMessage", {
          chat_id: chat.id,
          message_thread_id: threadId,
          text: `✅ Bio/description successfully updated!`,
        });
      } else {
        throw new Error(resData.error?.message || "Failed to update profile.");
      }
    } catch (err: any) {
      await bot.sendTelegram("sendMessage", {
        chat_id: chat.id,
        message_thread_id: threadId,
        text: `❌ Failed to update bio: ${err.message}`,
      });
    }
    return;
  }

  if (wizard.step === "name") {
    await bot.db.collection<WizardState>("tgWizardState").updateOne(
      { _id: wizard._id },
      {
        $set: {
          step: "description",
          "data.name": text,
          updatedAt: new Date(),
        },
      }
    );
    await bot.sendTelegram("sendMessage", {
      chat_id: chat.id,
      message_thread_id: threadId,
      text: `Step 2/5: Enter a short description for ${text} (e.g. what is this character for?).`,
    });
  } else if (wizard.step === "description") {
    await bot.db.collection<WizardState>("tgWizardState").updateOne(
      { _id: wizard._id },
      {
        $set: {
          step: "systemPrompt",
          "data.description": text,
          updatedAt: new Date(),
        },
      }
    );
    await bot.sendTelegram("sendMessage", {
      chat_id: chat.id,
      message_thread_id: threadId,
      text: `Step 3/5: Enter the system prompt / behavior details for ${wizard.data.name}.`,
    });
  } else if (wizard.step === "systemPrompt") {
    await bot.db.collection<WizardState>("tgWizardState").updateOne(
      { _id: wizard._id },
      {
        $set: {
          step: "greeting",
          "data.systemPrompt": text,
          updatedAt: new Date(),
        },
      }
    );
    await bot.sendTelegram("sendMessage", {
      chat_id: chat.id,
      message_thread_id: threadId,
      text: `Step 4/5: Enter the official starting message / greeting for ${wizard.data.name} (or type 'none' to skip):`,
    });
  } else if (wizard.step === "greeting") {
    const greetingVal = (text.toLowerCase() === "none" || text.toLowerCase() === "skip") ? "" : text;
    await bot.db.collection<WizardState>("tgWizardState").updateOne(
      { _id: wizard._id },
      {
        $set: {
          step: "visibility",
          "data.greeting": greetingVal,
          updatedAt: new Date(),
        },
      }
    );
    await bot.sendTelegram("sendMessage", {
      chat_id: chat.id,
      message_thread_id: threadId,
      text: "Step 5/5: Visibility. Please choose character visibility:",
      reply_markup: {
        inline_keyboard: [
          [
            { text: "🔓 Public", callback_data: "wizard_vis:public" },
            { text: "🔒 Private", callback_data: "wizard_vis:private" }
          ]
        ]
      }
    });
  } else if (wizard.step === "visibility") {
    await bot.sendTelegram("sendMessage", {
      chat_id: chat.id,
      message_thread_id: threadId,
      text: "⚠️ Please use the inline buttons above to select the visibility.",
    });
  }
}

export async function handleWizardVisibility(
  bot: TelegramBot,
  chatId: number,
  tgUserId: number,
  visibility: "public" | "private",
  threadId?: number,
  editMessageId?: number
) {
  const wizard = await bot.db.collection<WizardState>("tgWizardState").findOne({
    tgUserId,
    tgChatId: chatId,
  });

  if (!wizard || wizard.step !== "visibility") {
    await bot.sendTelegram("sendMessage", {
      chat_id: chatId,
      message_thread_id: threadId,
      text: "❌ Wizard session expired or already completed.",
    });
    return;
  }

  const link = await bot.getUserLink(tgUserId);
  if (!link) {
    await bot.sendTelegram("sendMessage", {
      chat_id: chatId,
      message_thread_id: threadId,
      text: "❌ User authentication link not found.",
    });
    return;
  }

  const name = wizard.data.name!;
  const description = wizard.data.description!;
  const systemPrompt = wizard.data.systemPrompt!;
  const greeting = wizard.data.greeting || undefined;

  if (editMessageId) {
    try {
      await bot.sendTelegram("editMessageText", {
        chat_id: chatId,
        message_id: editMessageId,
        text: `Saving character ${name}...`,
      });
    } catch {
      // Ignored
    }
  } else {
    await bot.sendTelegram("sendMessage", {
      chat_id: chatId,
      message_thread_id: threadId,
      text: `Saving character ${name}...`,
    });
  }

  try {
    const response = await fetch(`${bot.apiBaseUrl}/api/characters`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${bot.botSecret}`,
        "x-clerk-user-id": link.clerkUserId,
      },
      body: JSON.stringify({
        name,
        description,
        systemPrompt,
        greeting,
        visibility,
        tags: [],
      }),
    });

    const resData = await response.json();
    if (response.ok) {
      const charId = resData.character.id;
      await bot.db.collection<WizardState>("tgWizardState").deleteOne({ _id: wizard._id });

      const text = `🎉 *Character Created!*\n\n*Name*: ${name}\n*ID*: \`${charId}\``;
      const inlineKeyboard = [
        [
          { text: "💬 Start Chatting", callback_data: `start_chat:${charId}` },
        ],
      ];

      if (editMessageId) {
        await bot.sendTelegram("editMessageText", {
          chat_id: chatId,
          message_id: editMessageId,
          text,
          parse_mode: "Markdown",
          reply_markup: { inline_keyboard: inlineKeyboard },
        });
      } else {
        await bot.sendTelegram("sendMessage", {
          chat_id: chatId,
          message_thread_id: threadId,
          text,
          parse_mode: "Markdown",
          reply_markup: { inline_keyboard: inlineKeyboard },
        });
      }
    } else {
      throw new Error(resData.error?.message || "Creation failed.");
    }
  } catch (err: any) {
    const text = `❌ Failed to create character: ${err.message}. Starting over.`;
    if (editMessageId) {
      await bot.sendTelegram("editMessageText", {
        chat_id: chatId,
        message_id: editMessageId,
        text,
      });
    } else {
      await bot.sendTelegram("sendMessage", {
        chat_id: chatId,
        message_thread_id: threadId,
        text,
      });
    }
    await bot.db.collection<WizardState>("tgWizardState").deleteOne({ _id: wizard._id });
  }
}
