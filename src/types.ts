import { ObjectId } from "mongodb";
import { Context } from "grammy";

export type BotContext = Context;

export interface UserLink {
  _id?: ObjectId;
  tgUserId: number;
  clerkUserId: string;
  tgUsername?: string | null;
  createdAt: Date;
}

export interface AuthToken {
  _id?: ObjectId;
  token: string;
  tgUserId: number;
  tgChatId: number;
  tgUsername?: string | null;
  createdAt: Date;
}

export interface WizardState {
  _id?: ObjectId;
  tgUserId: number;
  tgChatId: number;
  step: "name" | "description" | "systemPrompt" | "greeting" | "visibility" | "import" | "profile_name" | "profile_description" | "search";
  data: {
    name?: string;
    description?: string;
    systemPrompt?: string;
    greeting?: string;
    visibility?: "public" | "private";
  };
  updatedAt: Date;
}

export interface TgChatMapping {
  _id?: ObjectId;
  tgChatId: number;
  tgThreadId: number;
  chatId: string;
  clerkUserId: string;
  lastAssistantTgMessageId?: number | null;
  lastUserTgMessageId?: number | null;
  thinkingEnabled?: boolean;
  createdAt: Date;
}
