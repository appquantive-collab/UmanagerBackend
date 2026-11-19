import { Schema, model, Types } from "mongoose";

/** What an AI call was for (for the founder's cost report). */
export type AiKind =
  | "chat" // Munshi AI chat
  | "ask" // quick AI search
  | "order_reading" // pasted WhatsApp order → items
  | "dashboard" // personalised dashboard words
  | "setup" // setup wizard: understand, buy/sell lookup, AI setups
  | "stt" // final speech-to-text
  | "stt_live" // live words while the mic is on
  | "stt_cleanup" // AI fix-up of what speech-to-text heard
  | "tts" // Hindi rewrite before speaking a reply
  | "pre_login"; // Munshi on the welcome screen (no business yet)

/**
 * One AI call and what it cost, priced when it happened (prices change; old
 * rows keep the cost they had). tenantId is null before sign-up.
 */
export interface AiCallDocument {
  _id: Types.ObjectId;
  tenantId: Types.ObjectId | null;
  /** The login that made it (null before sign-up or for system jobs). */
  userId?: Types.ObjectId | null;
  at: Date;
  /** India date / month, for daily and monthly totals. */
  day: string;
  month: string;
  kind: AiKind;
  provider: "groq" | "sarvam";
  model: string;
  inputTokens: number;
  cachedTokens: number;
  outputTokens: number;
  audioSeconds: number;
  /** Text-to-speech: characters spoken. */
  characters: number;
  costInr: number;
}

const aiCallSchema = new Schema<AiCallDocument>({
  tenantId: { type: Schema.Types.ObjectId, ref: "Tenant", default: null },
  userId: { type: Schema.Types.ObjectId, ref: "User", default: null },
  at: { type: Date, required: true },
  day: { type: String, required: true },
  month: { type: String, required: true },
  kind: { type: String, required: true },
  provider: { type: String, required: true },
  model: { type: String, required: true },
  inputTokens: { type: Number, default: 0 },
  cachedTokens: { type: Number, default: 0 },
  outputTokens: { type: Number, default: 0 },
  audioSeconds: { type: Number, default: 0 },
  characters: { type: Number, default: 0 },
  costInr: { type: Number, required: true },
});

aiCallSchema.index({ month: 1, tenantId: 1 });
aiCallSchema.index({ day: 1 });
aiCallSchema.index({ tenantId: 1, at: -1 });
aiCallSchema.index({ tenantId: 1, day: 1 });

export const AiCall = model<AiCallDocument>("AiCall", aiCallSchema);
