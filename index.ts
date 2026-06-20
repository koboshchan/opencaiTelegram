import { MongoClient } from "mongodb";
import dotenv from "dotenv";
import { TelegramBot } from "./bot.js";

dotenv.config();

const botToken = process.env.TELEGRAM_BOT_TOKEN!;
const apiBaseUrl = process.env.OPENCAI_API_BASE_URL!;
const botSecret = process.env.TELEGRAM_BOT_SECRET!;
const mongodbUri = process.env.MONGODB_URI || "mongodb://localhost:27017/opencai_bot";

if (!botToken || !apiBaseUrl || !botSecret) {
  console.error("Missing required environment variables. Please check your .env file.");
  process.exit(1);
}

async function run() {
  console.log("Connecting to MongoDB...");
  const client = new MongoClient(mongodbUri);
  await client.connect();
  const db = client.db();
  console.log("Connected to MongoDB.");

  const bot = new TelegramBot(db, botToken, apiBaseUrl, botSecret);
  await bot.init();

  let offset = 0;
  console.log("Starting Telegram updates polling loop...");

  while (true) {
    try {
      const response = await fetch(`https://api.telegram.org/bot${botToken}/getUpdates?offset=${offset}&timeout=30`, {
        method: "GET",
      });
      const data = (await response.json()) as { ok: boolean; result: any[] };

      if (data.ok && data.result.length > 0) {
        for (const update of data.result) {
          await bot.handleUpdate(update);
          offset = update.update_id + 1;
        }
      }
    } catch (err) {
      console.error("Error in updates polling loop:", err);
      // Wait 5 seconds before retrying if there's a connection issue
      await new Promise((resolve) => setTimeout(resolve, 5000));
    }
  }
}

run().catch((err) => {
  console.error("Fatal startup error:", err);
  process.exit(1);
});
