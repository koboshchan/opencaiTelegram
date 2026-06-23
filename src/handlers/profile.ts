import type { TelegramBot } from "../../bot.js";

export async function showProfile(
  bot: TelegramBot,
  chatId: number,
  tgUserId: number,
  clerkUserId: string,
  threadId?: number,
  editMessageId?: number
) {
  try {
    const response = await fetch(`${bot.apiBaseUrl}/api/me`, {
      headers: {
        Authorization: `Bearer ${bot.botSecret}`,
        "x-clerk-user-id": clerkUserId,
      },
    });
    const data = await response.json();
    if (!response.ok) {
      throw new Error(data.error?.message || "Failed to fetch profile.");
    }
    const user = data.user;
    const profileText = `*Your Profile*\n\n` +
      `*Name*: ${user.displayName || "Not set"}\n` +
      `*Bio/Description*: ${user.description || "Not set"}\n` +
      `*Clerk User ID*: \`${user.clerkUserId}\`\n` +
      `*Email*: ${user.email || "Not set"}`;

    const replyMarkup = {
      inline_keyboard: [
        [
          { text: "Edit Name", callback_data: `profile_edit:name` },
          { text: "Edit Bio", callback_data: `profile_edit:bio` },
        ],
        [
          { text: "Refresh", callback_data: `profile_refresh` },
        ]
      ],
    };

    if (editMessageId) {
      await bot.sendTelegram("editMessageText", {
        chat_id: chatId,
        message_id: editMessageId,
        message_thread_id: threadId,
        text: profileText,
        parse_mode: "Markdown",
        reply_markup: replyMarkup,
      });
    } else {
      await bot.sendTelegram("sendMessage", {
        chat_id: chatId,
        message_thread_id: threadId,
        text: profileText,
        parse_mode: "Markdown",
        reply_markup: replyMarkup,
      });
    }
  } catch (err: any) {
    await bot.sendTelegram("sendMessage", {
      chat_id: chatId,
      message_thread_id: threadId,
      text: `Failed to load profile: ${err.message}`,
    });
  }
}
