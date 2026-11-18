import { Schema, model } from "mongoose";

/** Which speech-to-text turns the final recording into text. */
export type SttEngine = "auto" | "sarvam" | "whisper";
/** Who speaks Munshi's Hindi/Hinglish replies: auto = Sarvam, Microsoft if it fails. */
export type TtsEngine = "auto" | "sarvam" | "edge";

/**
 * App-wide switches the VoiceMunshi team sets from the super admin panel (one
 * document, key "global"). Not per business.
 */
export interface PlatformSettingDocument {
  key: string;
  /** auto: Sarvam first, Whisper if it fails; sarvam: Sarvam only; whisper: Whisper only. */
  sttEngine: SttEngine;
  ttsEngine: TtsEngine;
  /** Sarvam voice key (see tts/sarvam-tts.service SARVAM_VOICES). */
  ttsVoice: string;
  /** AI price list for the cost report (see billing/ai-cost.service). */
  pricing?: Record<string, unknown> | null;
  updatedAt: Date;
}

const platformSettingSchema = new Schema<PlatformSettingDocument>(
  {
    key: { type: String, required: true, unique: true },
    sttEngine: { type: String, enum: ["auto", "sarvam", "whisper"], default: "auto" },
    ttsEngine: { type: String, enum: ["auto", "sarvam", "edge"], default: "auto" },
    ttsVoice: { type: String, default: "v3_shubh" },
    pricing: { type: Schema.Types.Mixed, default: null },
  },
  { timestamps: { createdAt: false, updatedAt: true } }
);

export const PlatformSetting = model<PlatformSettingDocument>("PlatformSetting", platformSettingSchema);

const CACHE_MS = 30_000;
let cached: { engine: SttEngine; at: number } | null = null;

/** The chosen speech-to-text engine (cached 30 s; "auto" when never set). */
export async function getSttEngine(): Promise<SttEngine> {
  if (cached && Date.now() - cached.at < CACHE_MS) return cached.engine;
  const doc = await PlatformSetting.findOne({ key: "global" }, { sttEngine: 1 }).lean();
  cached = { engine: doc?.sttEngine ?? "auto", at: Date.now() };
  return cached.engine;
}

export async function setSttEngine(engine: SttEngine): Promise<SttEngine> {
  await PlatformSetting.updateOne({ key: "global" }, { $set: { sttEngine: engine } }, { upsert: true });
  cached = { engine, at: Date.now() };
  return engine;
}

let ttsCached: { engine: TtsEngine; voice: string; at: number } | null = null;

/** Voice settings (cached 30 s). */
export async function getTtsSettings(): Promise<{ engine: TtsEngine; voice: string }> {
  if (ttsCached && Date.now() - ttsCached.at < CACHE_MS) return ttsCached;
  const doc = await PlatformSetting.findOne({ key: "global" }, { ttsEngine: 1, ttsVoice: 1 }).lean();
  ttsCached = { engine: doc?.ttsEngine ?? "auto", voice: doc?.ttsVoice ?? "v3_shubh", at: Date.now() };
  return ttsCached;
}

export async function setTtsSettings(patch: { engine?: TtsEngine; voice?: string }) {
  const set: Record<string, string> = {};
  if (patch.engine) set.ttsEngine = patch.engine;
  if (patch.voice) set.ttsVoice = patch.voice;
  await PlatformSetting.updateOne({ key: "global" }, { $set: set }, { upsert: true });
  ttsCached = null;
  return getTtsSettings();
}
