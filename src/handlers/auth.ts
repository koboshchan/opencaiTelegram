import crypto from "crypto";
import type { TelegramBot } from "../../bot.js";
import { AuthToken, UserLink } from "../types.js";

export async function handleStart(bot: TelegramBot, message: any) {
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

        const tokenDoc = await bot.db.collection<AuthToken>("authTokens").findOne({ token, tgUserId: from.id });
        if (tokenDoc) {
          // Linked!
          await bot.db.collection<UserLink>("userLinks").updateOne(
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

          await bot.db.collection<AuthToken>("authTokens").deleteOne({ _id: tokenDoc._id });

          await bot.sendTelegram("sendMessage", {
            chat_id: chat.id,
            message_thread_id: threadId,
            text: `Account successfully linked! You are logged in as Clerk User: ${clerkUserId}. You can now run bot commands.`,
          });
          return;
        } else {
          await bot.sendTelegram("sendMessage", {
            chat_id: chat.id,
            message_thread_id: threadId,
            text: "Invalid or expired linking token. Please try again.",
          });
          return;
        }
      }
    }
  }

  const isPrivate = chat.type === "private";
  let welcomeText = "Welcome to OpenCai Bot! Link your account to start managing and chatting with AI characters.\n\nUse /characters to see your list, /create to make one, or /import to import from Character.AI.";
  if (isPrivate) {
    welcomeText += "\n\n*Note*: This bot is designed to run in a Group Chat with Topics (Forum) enabled. Please add it to a topic-enabled group chat to use commands and chat with characters.";
  }

  await bot.sendTelegram("sendMessage", {
    chat_id: chat.id,
    message_thread_id: threadId,
    text: welcomeText,
    parse_mode: "Markdown",
  });

  const link = await bot.getUserLink(from.id);
  if (!link) {
    await sendAuthLink(bot, chat.id, from.id, from.username, threadId);
  }
}

export async function sendAuthLink(
  bot: TelegramBot,
  chatId: number,
  tgUserId: number,
  tgUsername: string | null,
  threadId?: number
) {
  const token = crypto.randomBytes(8).toString("hex");
  await bot.db.collection<AuthToken>("authTokens").updateOne(
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

  const botName = bot.botUsername || "opencai_bot";
  const authUrl = `${bot.apiBaseUrl}/tg-auth?token=${token}&bot=${botName}`;

  await bot.sendTelegram("sendMessage", {
    chat_id: chatId,
    message_thread_id: threadId,
    text: `*Authentication Required*\n\nPlease login with Clerk to link your Telegram account:\n\n[Login and Link Account](${authUrl})`,
    parse_mode: "Markdown",
  });
}
