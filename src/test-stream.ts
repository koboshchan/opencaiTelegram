import { MongoClient } from "mongodb";
import dotenv from "dotenv";

dotenv.config();

const mongodbUri = process.env.MONGODB_URI || "mongodb://localhost:27017/opencai_bot";
const apiBaseUrl = process.env.OPENCAI_API_BASE_URL!;
const botSecret = process.env.TELEGRAM_BOT_SECRET!;

async function main() {
  console.log("Connecting to MongoDB at:", mongodbUri);
  const uri = mongodbUri;
  const client = new MongoClient(uri);
  try {
    await client.connect();
    console.log("Connected to MongoDB.");
    const db = client.db();
    const mapping = await db.collection("tgChats").findOne({});
    if (!mapping) {
      console.error("No tgChats mapping found in DB. Cannot test fetch.");
      process.exit(1);
    }
    console.log("Found mapping:", mapping);

    const url = `${apiBaseUrl.replace(/\/+$/, "")}/api/chats/${mapping.chatId}/messages`;
    console.log("Fetching from:", url);

    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${botSecret}`,
        "x-clerk-user-id": mapping.clerkUserId,
      },
      body: JSON.stringify({ content: "Explain in 3 long paragraphs what quantum computing is and how it differs from classical computing." }),
    });

    console.log("Response status:", response.status);
    console.log("Response headers:", Object.fromEntries(response.headers.entries()));

    if (!response.ok || !response.body) {
      console.error("Fetch failed:", await response.text());
      process.exit(1);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let totalLength = 0;
    let chunkCount = 0;
    const startTime = Date.now();

    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        console.log("\nStream finished.");
        break;
      }
      chunkCount++;
      const text = decoder.decode(value, { stream: true });
      totalLength += text.length;
      console.log(`[${Date.now() - startTime}ms] Chunk #${chunkCount} received: length=${text.length}, content preview: ${JSON.stringify(text.slice(0, 30))}`);
    }

    console.log(`Summary: Total chunks: ${chunkCount}, Total length: ${totalLength}`);
  } catch (err) {
    console.error("Error in test-stream:", err);
  } finally {
    await client.close();
  }
}

main();
