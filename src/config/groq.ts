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
