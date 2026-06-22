import type { TelegramBot } from "../../bot.js";
import { BotContext, TgChatMapping } from "../types.js";

export async function handleChatReply(bot: TelegramBot, ctxOrMsg: BotContext | any, mapping: TgChatMapping) {
  const isContext = ctxOrMsg && typeof ctxOrMsg.reply === "function";
  const message = isContext ? ctxOrMsg.message : ctxOrMsg;
  if (!message) return;
  const chatId = isContext ? ctxOrMsg.chat.id : message.chat.id;
  const text = message.text?.trim();
  if (!text) return;

  // Show typing immediately.
  const sendTyping = () => bot.grammyBot.api.sendChatAction(chatId, "typing").catch(() => {});
  await sendTyping();

  // Show the placeholder immediately — before the fetch — so the user sees
  // feedback right away instead of waiting for the full TTFT from the model.
  let placeholderMsg;
  if (isContext) {
    placeholderMsg = await ctxOrMsg.reply("⏳ ...", {
      message_thread_id: mapping.tgThreadId,
    });
  } else {
    placeholderMsg = await bot.grammyBot.api.sendMessage(chatId, "⏳ ...", {
      message_thread_id: mapping.tgThreadId,
    });
  }

  const lastMsgId = placeholderMsg.message_id;
  await bot.db.collection<TgChatMapping>("tgChats").updateOne(
    { _id: mapping._id },
    {
      $set: {
        lastAssistantTgMessageId: lastMsgId,
        lastUserTgMessageId: message.message_id,
      },
    }
  );

  // Telegram's typing action expires after ~5 seconds. Keep refreshing it
  // throughout the entire wait (TTFT + streaming).
  const typingInterval = setInterval(sendTyping, 4000);

  try {
    const response = await fetch(`${bot.apiBaseUrl}/api/chats/${mapping.chatId}/messages`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${bot.botSecret}`,
        "x-clerk-user-id": mapping.clerkUserId,
      },
      body: JSON.stringify({ content: text }),
    });

    if (!response.ok || !response.body) {
      const errData = await response.json().catch(() => ({}));
      throw new Error(errData.error?.message || "API completion failed.");
    }

    await streamToExistingMessage(bot, chatId, lastMsgId, response as any);
  } catch (err: any) {
    console.error("FAILED TO GENERATE in Telegram bot handleChatReply:", err);
    await bot.grammyBot.api
      .editMessageText(chatId, lastMsgId, `❌ API Error: ${err.message}`)
      .catch(() => {});
  } finally {
    // Stop typing only after streaming is fully done.
    clearInterval(typingInterval);
  }
}

export async function handleEditReply(bot: TelegramBot, ctx: BotContext, mapping: TgChatMapping) {
  const message = ctx.editedMessage;
  if (!message) return;
  const text = message.text?.trim();
  if (!text) return;

  await ctx.replyWithChatAction("typing");

  // 1. Delete last assistant response from DB
  try {
    const delResponse = await fetch(`${bot.apiBaseUrl}/api/chats/${mapping.chatId}/messages`, {
      method: "DELETE",
      headers: {
        Authorization: `Bearer ${bot.botSecret}`,
        "x-clerk-user-id": mapping.clerkUserId,
      },
    });
    if (!delResponse.ok) {
      console.warn("Failed to delete last message in API during edit:", await delResponse.text());
    }
  } catch (err) {
    console.warn("Failed to contact DELETE API during edit:", err);
  }

  // 2. Update last user message in DB with the new edited text
  try {
    const patchResponse = await fetch(`${bot.apiBaseUrl}/api/chats/${mapping.chatId}/messages`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${bot.botSecret}`,
        "x-clerk-user-id": mapping.clerkUserId,
      },
      body: JSON.stringify({
        content: text,
      }),
    });
    if (!patchResponse.ok) {
      console.warn("Failed to update user message in API during edit:", await patchResponse.text());
    }
  } catch (err) {
    console.warn("Failed to contact PATCH API during edit:", err);
  }

  // 3. Edit the existing bot Telegram message to "⏳ Regenerating..."
  const targetMessageId = mapping.lastAssistantTgMessageId;
  if (targetMessageId) {
    try {
      await ctx.api.editMessageText(ctx.chat!.id, targetMessageId, "⏳ Regenerating...");
    } catch (err) {
      console.warn("Could not edit message during edit regeneration:", err);
    }
  }

  // 4. POST to trigger regeneration and stream the response
  try {
    const response = await fetch(`${bot.apiBaseUrl}/api/chats/${mapping.chatId}/messages`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${bot.botSecret}`,
        "x-clerk-user-id": mapping.clerkUserId,
      },
      body: JSON.stringify({}),
    });

    if (!response.ok || !response.body) {
      const errData = await response.json().catch(() => ({}));
      throw new Error(errData.error?.message || "API completion failed.");
    }

    await streamToExistingMessage(bot, ctx.chat!.id, targetMessageId!, response as any);
  } catch (err: any) {
    console.error("FAILED TO GENERATE during edit regeneration:", err);
    await ctx.api.editMessageText(ctx.chat!.id, targetMessageId!, `❌ API Error: ${err.message}`).catch(() => {});
  }
}

export async function handleRegen(bot: TelegramBot, ctx: BotContext) {
  const message = ctx.message;
  if (!message) return;
  const chat = message.chat;
  const from = message.from;
  const threadId = message.message_thread_id;
  if (!from) return;

  if (!threadId) {
    await ctx.reply("⚠️ The /regen command can only be used in a character topic thread.", {
      message_thread_id: threadId,
    });
    return;
  }

  const mapping = await bot.db.collection<TgChatMapping>("tgChats").findOne({
    tgChatId: chat.id,
    tgThreadId: threadId,
  });

  if (!mapping) {
    await ctx.reply("⚠️ This thread is not associated with an AI character chat.", {
      message_thread_id: threadId,
    });
    return;
  }

  let targetMessageId = mapping.lastAssistantTgMessageId;

  if (targetMessageId) {
    try {
      await ctx.api.editMessageText(chat.id, targetMessageId, "⏳ Regenerating...");
    } catch (err) {
      console.warn("Could not edit message, sending new one instead:", err);
      const newMsg = await ctx.reply("⏳ Regenerating...", {
        message_thread_id: threadId,
      });
      targetMessageId = newMsg.message_id;
      await bot.db.collection<TgChatMapping>("tgChats").updateOne(
        { _id: mapping._id },
        { $set: { lastAssistantTgMessageId: targetMessageId } }
      );
    }
  } else {
    const newMsg = await ctx.reply("⏳ Regenerating...", {
      message_thread_id: threadId,
    });
    targetMessageId = newMsg.message_id;
    await bot.db.collection<TgChatMapping>("tgChats").updateOne(
      { _id: mapping._id },
      { $set: { lastAssistantTgMessageId: targetMessageId } }
    );
  }

  try {
    const delResponse = await fetch(`${bot.apiBaseUrl}/api/chats/${mapping.chatId}/messages`, {
      method: "DELETE",
      headers: {
        Authorization: `Bearer ${bot.botSecret}`,
        "x-clerk-user-id": mapping.clerkUserId,
      },
    });
    if (!delResponse.ok) {
      console.warn("Failed to delete last message in API during regen:", await delResponse.text());
    }
  } catch (err) {
    console.warn("Failed to contact DELETE API during regen:", err);
  }

  await ctx.replyWithChatAction("typing");

  try {
    const response = await fetch(`${bot.apiBaseUrl}/api/chats/${mapping.chatId}/messages`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${bot.botSecret}`,
        "x-clerk-user-id": mapping.clerkUserId,
      },
      body: JSON.stringify({}),
    });

    if (!response.ok || !response.body) {
      const errData = await response.json().catch(() => ({}));
      throw new Error(errData.error?.message || "API completion failed.");
    }

    await streamToExistingMessage(bot, chat.id, targetMessageId!, response as any);
  } catch (err: any) {
    console.error("FAILED TO GENERATE during /regen:", err);
    await ctx.api.editMessageText(chat.id, targetMessageId!, `❌ API Error: ${err.message}`).catch(() => {});
  }
}

export async function checkDeletedMessages(bot: TelegramBot) {
  // Find all mappings that have both lastUserTgMessageId and lastAssistantTgMessageId set
  const mappings = await bot.db
    .collection<TgChatMapping>("tgChats")
    .find({
      lastUserTgMessageId: { $ne: null, $exists: true },
      lastAssistantTgMessageId: { $ne: null, $exists: true }
    })
    .toArray();

  for (const mapping of mappings) {
    const chatId = mapping.tgChatId;
    const userMsgId = mapping.lastUserTgMessageId!;
    const assistantMsgId = mapping.lastAssistantTgMessageId!;

    let isDeleted = false;
    try {
      // Clear reactions on the user message. This acts as a lightweight check if the message exists.
      // It succeeds silently if the message exists (clearing/doing nothing if no reaction exists).
      // It fails with "message to react not found" if the message has been deleted.
      await bot.grammyBot.api.setMessageReaction(chatId, userMsgId, []);
    } catch (err: any) {
      const errMsg = String(err.message || "").toLowerCase();
      if (errMsg.includes("message to react not found") || errMsg.includes("message not found") || errMsg.includes("message_to_react_not_found")) {
        isDeleted = true;
      }
    }

    if (isDeleted) {
      console.log(`[Delete Sync] Detected deleted user message ${userMsgId} in chat ${chatId}. Syncing deletion.`);
      
      // 1. Delete bot reply on Telegram
      try {
        await bot.grammyBot.api.deleteMessage(chatId, assistantMsgId);
      } catch (e) {
        console.warn(`[Delete Sync] Failed to delete assistant message ${assistantMsgId} on Telegram:`, e);
      }

      // 2. Delete both messages in web app DB
      try {
        const delResponse = await fetch(`${bot.apiBaseUrl}/api/chats/${mapping.chatId}/messages?all=true`, {
          method: "DELETE",
          headers: {
            Authorization: `Bearer ${bot.botSecret}`,
            "x-clerk-user-id": mapping.clerkUserId,
          },
        });
        if (!delResponse.ok) {
          console.warn("[Delete Sync] Failed to delete messages in DB:", await delResponse.text());
        }
      } catch (err) {
        console.warn("[Delete Sync] Failed to contact DELETE API:", err);
      }

      // 3. Clear message IDs in DB mapping
      await bot.db.collection<TgChatMapping>("tgChats").updateOne(
        { _id: mapping._id },
        {
          $set: {
            lastUserTgMessageId: null,
            lastAssistantTgMessageId: null
          }
        }
      );
    }
  }
}

export async function streamToExistingMessage(
  bot: TelegramBot,
  chatId: number,
  messageId: number,
  response: Response
) {
  const reader = response.body?.getReader();
  if (!reader) {
    throw new Error("No response body stream available.");
  }
  const decoder = new TextDecoder();
  let fullText = "";
  let lastSentText = "";
  let chunkIndex = 0;

  // Push edits to Telegram at a fixed cadence, decoupled from chunk arrival rate.
  // This prevents the "all at once" problem when chunks arrive faster than the
  // time threshold or the response has no newlines (e.g. single-paragraph roleplay).
  const pushUpdate = async () => {
    if (fullText.trim() && fullText !== lastSentText) {
      const snapshot = fullText;
      try {
        await bot.grammyBot.api.editMessageText(chatId, messageId, snapshot, {
          parse_mode: "Markdown",
        });
      } catch {
        await bot.grammyBot.api.editMessageText(chatId, messageId, snapshot).catch(() => {});
      }
      lastSentText = snapshot;
    }
  };

  const intervalId = setInterval(pushUpdate, 600);

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      const chunkText = decoder.decode(value, { stream: true });
      chunkIndex++;
      console.log(`[Stream] Chunk #${chunkIndex} received: length=${chunkText.length}`);
      fullText += chunkText;
    }
  } catch (err: any) {
    console.error("Error streaming to existing message:", err);
    fullText += `\n\n❌ Stream interrupted: ${err.message}`;
  } finally {
    clearInterval(intervalId);
    reader.releaseLock();
  }

  // Final push — send whatever is left that hasn't been sent yet.
  await pushUpdate();
}

export async function* getStreamGenerator(response: Response) {
  const reader = response.body?.getReader();
  if (!reader) {
    throw new Error("No response body stream available.");
  }
  const decoder = new TextDecoder();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      yield decoder.decode(value);
    }
  } catch (err: any) {
    console.error("Stream reading error:", err);
    yield `\n\n❌ Stream interrupted: ${err.message}`;
  } finally {
    reader.releaseLock();
  }
}
