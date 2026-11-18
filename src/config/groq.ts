import OpenAI from "openai";
import { env } from "./env";

// Groq hosts open models behind an OpenAI-compatible API, so the existing
// `openai` SDK is reused with a different baseURL instead of adding a second
// AI SDK dependency for one provider swap.
export const GROQ_CHAT_MODEL = "openai/gpt-oss-120b";

export function getGroqClient(): OpenAI {
  if (!env.groqApiKey) {
    throw new Error("GROQ_API_KEY is not configured");
  }
  return new OpenAI({ apiKey: env.groqApiKey, baseURL: "https://api.groq.com/openai/v1" });
}

/** Smaller model with its own rate limits on Groq: used when the main one is at its limit. */
export const GROQ_FALLBACK_MODEL = "openai/gpt-oss-20b";

/** Groq's per-minute / per-day limits are reached on both models: try again shortly. */
export class AiBusyError extends Error {
  constructor() {
    super("Munshi AI is busy right now. Please try again in a minute.");
    this.name = "AiBusyError";
  }
}

const isRateLimit = (err: unknown) => (err as { status?: number })?.status === 429;

/**
 * A chat completion on the main model, falling back to the smaller one when
 * Groq says the main model's token limit is reached (free tier: 8k tokens a
 * minute, 200k a day, shared by every business).
 */
export async function chatWithFallback<T>(create: (model: string) => Promise<T>): Promise<T> {
  try {
    return await create(GROQ_CHAT_MODEL);
  } catch (err) {
    if (!isRateLimit(err)) throw err;
    console.warn("[groq] main model rate-limited, using fallback:", (err as Error).message.slice(0, 160));
  }
  try {
    return await create(GROQ_FALLBACK_MODEL);
  } catch (err) {
    if (isRateLimit(err)) throw new AiBusyError();
    throw err;
  }
}
