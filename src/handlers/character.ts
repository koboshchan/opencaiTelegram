import type { TelegramBot } from "../../bot.js";
import { TgChatMapping } from "../types.js";

export async function handleImport(
  bot: TelegramBot,
  chatId: number,
  tgUserId: number,
  clerkUserId: string,
  url: string,
  threadId?: number
) {
  await bot.sendTelegram("sendMessage", {
    chat_id: chatId,
    message_thread_id: threadId,
    text: "📥 Importing character from Character.AI...",
  });

  try {
    const response = await fetch(`${bot.apiBaseUrl}/api/import-character`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${bot.botSecret}`,
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
      const charsResponse = await fetch(`${bot.apiBaseUrl}/api/characters`, {
        headers: {
          Authorization: `Bearer ${bot.botSecret}`,
          "x-clerk-user-id": clerkUserId,
        },
      });
      const charsData = await charsResponse.json();
      const latestChar = charsData.characters?.[0];

      if (latestChar) {
        await bot.sendTelegram("sendMessage", {
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
        await bot.sendTelegram("sendMessage", {
          chat_id: chatId,
          message_thread_id: threadId,
          text: "🎉 Character imported! Refresh your dashboard or run /characters to view.",
        });
      }
    } else {
      throw new Error(resData.error?.message || "Import failed.");
    }
  } catch (err: any) {
    await bot.sendTelegram("sendMessage", {
      chat_id: chatId,
      message_thread_id: threadId,
      text: `❌ Import failed: ${err.message}`,
    });
  }
}

export async function listCharacters(
  bot: TelegramBot,
  chatId: number,
  tgUserId: number,
  clerkUserId: string,
  threadId?: number,
  editMessageId?: number,
  page: number = 1
) {
  try {
    const response = await fetch(`${bot.apiBaseUrl}/api/characters`, {
      headers: {
        Authorization: `Bearer ${bot.botSecret}`,
        "x-clerk-user-id": clerkUserId,
      },
    });
    const data = await response.json();
    const characters = data.characters || [];

    if (!characters.length) {
      const text = "📭 You don't own any characters yet. Use /create to create one.";
      if (editMessageId) {
        await bot.sendTelegram("editMessageText", { chat_id: chatId, message_id: editMessageId, text });
      } else {
        await bot.sendTelegram("sendMessage", { chat_id: chatId, message_thread_id: threadId, text });
      }
      return;
    }

    const limit = 5;
    const totalPages = Math.ceil(characters.length / limit);
    const currentPage = Math.max(1, Math.min(page, totalPages));
    const startIndex = (currentPage - 1) * limit;
    const pageChars = characters.slice(startIndex, startIndex + limit);

    let text = `👥 *Your Characters* (Page ${currentPage}/${totalPages}):\n\n`;
    const inlineKeyboard: any[] = [];

    pageChars.forEach((char: any) => {
      text += `• *${char.name}* (ID: \`${char.id}\`)\n  _${char.description}_\n\n`;
      inlineKeyboard.push([
        { text: `ℹ️ ${char.name} details`, callback_data: `details:${char.id}` },
        { text: `💬 Chat`, callback_data: `start_chat:${char.id}` },
      ]);
    });

    const navRow: any[] = [];
    if (currentPage > 1) {
      navRow.push({ text: "⬅️ Previous", callback_data: `list_chars:${currentPage - 1}` });
    }
    if (currentPage < totalPages) {
      navRow.push({ text: "Next ➡️", callback_data: `list_chars:${currentPage + 1}` });
    }
    if (navRow.length > 0) {
      inlineKeyboard.push(navRow);
    }

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
  } catch (err: any) {
    await bot.sendTelegram("sendMessage", {
      chat_id: chatId,
      message_thread_id: threadId,
      text: `❌ Failed to fetch characters: ${err.message}`,
    });
  }
}

export async function showCharacterDetails(
  bot: TelegramBot,
  chatId: number,
  clerkUserId: string,
  charId: string,
  threadId?: number,
  editMessageId?: number
) {
  try {
    const response = await fetch(`${bot.apiBaseUrl}/api/characters`, {
      headers: {
        Authorization: `Bearer ${bot.botSecret}`,
        "x-clerk-user-id": clerkUserId,
      },
    });
    const data = await response.json();
    const character = (data.characters || []).find((c: any) => c.id === charId);

    if (!character) {
      await bot.sendTelegram("sendMessage", {
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

    await bot.sendTelegram("editMessageText", {
      chat_id: chatId,
      message_id: editMessageId,
      text,
      parse_mode: "Markdown",
      reply_markup: { inline_keyboard: inlineKeyboard },
    });
  } catch (err: any) {
    await bot.sendTelegram("sendMessage", {
      chat_id: chatId,
      message_thread_id: threadId,
      text: `❌ Failed to fetch details: ${err.message}`,
    });
  }
}

export async function initiateTopicChat(
  bot: TelegramBot,
  chatId: number,
  tgUserId: number,
  clerkUserId: string,
  charId: string,
  threadId?: number
) {
  try {
    const response = await fetch(`${bot.apiBaseUrl}/api/characters`, {
      headers: {
        Authorization: `Bearer ${bot.botSecret}`,
        "x-clerk-user-id": clerkUserId,
      },
    });
    const data = await response.json();
    const character = (data.characters || []).find((c: any) => c.id === charId);

    if (!character) {
      throw new Error("Character not found.");
    }

    // 1. Create a forum topic on Telegram
    const topicResult = await bot.callTelegram("createForumTopic", {
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
    const chatResponse = await fetch(`${bot.apiBaseUrl}/api/characters/${charId}/chats`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${bot.botSecret}`,
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
    await bot.db.collection<TgChatMapping>("tgChats").insertOne(mapping);

    // 4. Send the character's official greeting directly to the topic thread
    let greetingText = character.greeting?.trim() || "";
    if (!greetingText) {
      greetingText = `👋 Hello! I am ${character.name}. Let's chat!`;
    }

    try {
      await bot.sendTelegram("sendMessage", {
        chat_id: chatId,
        message_thread_id: newThreadId,
        text: greetingText,
        parse_mode: "Markdown",
      });
    } catch (err) {
      // Fallback to plain text if markdown parsing fails
      await bot.sendTelegram("sendMessage", {
        chat_id: chatId,
        message_thread_id: newThreadId,
        text: greetingText,
      });
    }

    // 5. Notify in Controls topic
    await bot.sendTelegram("sendMessage", {
      chat_id: chatId,
      message_thread_id: threadId,
      text: `💬 Topic *${character.name}* created successfully! Click on the topic thread to start chatting.`,
      parse_mode: "Markdown",
    });
  } catch (err: any) {
    await bot.sendTelegram("sendMessage", {
      chat_id: chatId,
      message_thread_id: threadId,
      text: `❌ Failed to initiate chat: ${err.message}`,
    });
  }
}

export async function searchCharacters(
  bot: TelegramBot,
  chatId: number,
  tgUserId: number,
  clerkUserId: string,
  query: string,
  threadId?: number
) {
  try {
    const response = await fetch(`${bot.apiBaseUrl}/api/characters/search?query=${encodeURIComponent(query)}`, {
      headers: {
        Authorization: `Bearer ${bot.botSecret}`,
        "x-clerk-user-id": clerkUserId,
      },
    });
    const data = await response.json();
    const characters = data.characters || [];

    if (!characters.length) {
      await bot.sendTelegram("sendMessage", {
        chat_id: chatId,
        message_thread_id: threadId,
        text: `🔍 No characters found matching: *${query}*`,
        parse_mode: "Markdown",
      });
      return;
    }

    let text = `🔍 *Search Results for "${query}"*:\n\n`;
    const inlineKeyboard: any[] = [];

    characters.forEach((char: any) => {
      text += `• *${char.name}* (ID: \`${char.id}\`)\n  _${char.description}_\n\n`;
      inlineKeyboard.push([
        { text: `ℹ️ ${char.name} details`, callback_data: `details:${char.id}` },
        { text: `💬 Chat`, callback_data: `start_chat:${char.id}` },
      ]);
    });

    await bot.sendTelegram("sendMessage", {
      chat_id: chatId,
      message_thread_id: threadId,
      text,
      parse_mode: "Markdown",
      reply_markup: { inline_keyboard: inlineKeyboard },
    });
  } catch (err: any) {
    await bot.sendTelegram("sendMessage", {
      chat_id: chatId,
      message_thread_id: threadId,
      text: `❌ Search failed: ${err.message}`,
    });
  }
}
