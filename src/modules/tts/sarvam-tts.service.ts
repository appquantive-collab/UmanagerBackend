import { env } from "../../config/env";
import { logAiCall } from "../billing/ai-cost.service";

/**
 * Sarvam Bulbul text-to-speech: natural Indian voices with feeling, for Munshi
 * speaking Hindi / Hinglish. Text comes in already rewritten as spoken Hindi in
 * Devanagari (Sarvam reads Hindi best in its own script). The founder picks the
 * voice in Admin → Settings; on any failure the caller falls back to the
 * Microsoft voice. Docs: https://docs.sarvam.ai/api-reference-docs/text-to-speech/convert
 */

export interface SarvamVoice {
  model: "bulbul:v3" | "bulbul:v4-flash";
  speaker: string;
  label: string;
}

/** Male Indian voices to choose from (keys are stored in platform settings). */
export const SARVAM_VOICES = {
  v3_shubh: { model: "bulbul:v3", speaker: "shubh", label: "Shubh — warm, natural Hindi (Sarvam's top Hindi male pick)" },
  v3_ashutosh: { model: "bulbul:v3", speaker: "ashutosh", label: "Ashutosh — calm, mature Hindi" },
  v3_aditya: { model: "bulbul:v3", speaker: "aditya", label: "Aditya — friendly, younger Hindi" },
  v4_ratan_expressive: { model: "bulbul:v4-flash", speaker: "ratan_hi_customer_expressive", label: "Ratan — expressive, full of feeling (v4, cheaper)" },
  v4_shubh_companion: { model: "bulbul:v4-flash", speaker: "shubh_enhi_companion", label: "Shubh — Hinglish companion style (v4, cheaper)" },
  // v4 (₹1 per 1,000 characters). Styles are Sarvam's own (from the voice id); each was checked to exist.
  v4_shubh_customer: { model: "bulbul:v4-flash", speaker: "shubh_hi_customer", label: "Shubh — customer care (Sarvam's top v4 Hindi male pick)" },
  v4_shubh_ecomm: { model: "bulbul:v4-flash", speaker: "shubh_hi_ecomm", label: "Shubh — e-commerce" },
  v4_aayan: { model: "bulbul:v4-flash", speaker: "aayan_hi_conversational", label: "Aayan — conversational" },
  v4_amit: { model: "bulbul:v4-flash", speaker: "amit_hi_conversational", label: "Amit — conversational" },
  v4_ashutosh: { model: "bulbul:v4-flash", speaker: "ashutosh_hi_conversational", label: "Ashutosh — conversational" },
  v4_kabir: { model: "bulbul:v4-flash", speaker: "kabir_hi_conversational", label: "Kabir — conversational" },
  v4_manan: { model: "bulbul:v4-flash", speaker: "manan_hi_conversational", label: "Manan — conversational" },
  v4_rahul: { model: "bulbul:v4-flash", speaker: "rahul_hi_conversational", label: "Rahul — conversational" },
  v4_sumit: { model: "bulbul:v4-flash", speaker: "sumit_hi_conversational", label: "Sumit — conversational" },
  v4_aditya: { model: "bulbul:v4-flash", speaker: "aditya_hi_conversational", label: "Aditya — conversational" },
  v4_aditya_sales: { model: "bulbul:v4-flash", speaker: "aditya_hi_sales", label: "Aditya — sales" },
  v4_anand_news: { model: "bulbul:v4-flash", speaker: "anand_hi_news", label: "Anand — news reader" },
  v4_ashok_news: { model: "bulbul:v4-flash", speaker: "ashok_hi_news", label: "Ashok — news reader" },
  v4_ratan_documentary: { model: "bulbul:v4-flash", speaker: "ratan_hi_documentary", label: "Ratan — documentary narrator" },
  v4_mahesh_documentary: { model: "bulbul:v4-flash", speaker: "mahesh_hi_documentary", label: "Mahesh — documentary narrator" },
  v4_shubh_ads: { model: "bulbul:v4-flash", speaker: "shubh_enhi_ads", label: "Shubh — Hinglish, ads" },
  v4_shubh_banking: { model: "bulbul:v4-flash", speaker: "shubh_enhi_banking", label: "Shubh — Hinglish, banking" },
  v4_sunny: { model: "bulbul:v4-flash", speaker: "sunny_enhi_customer", label: "Sunny — Hinglish, customer care" },
} as const satisfies Record<string, SarvamVoice>;

export type SarvamVoiceKey = keyof typeof SARVAM_VOICES;
export const DEFAULT_SARVAM_VOICE: SarvamVoiceKey = "v3_shubh";

const URL_TTS = "https://api.sarvam.ai/text-to-speech";
const PAUSE_AFTER_ACCOUNT_ERROR_MS = 60 * 60 * 1000;
let pausedUntil = 0;

export function sarvamTtsAvailable(): boolean {
  return Boolean(env.sarvamApiKey) && Date.now() >= pausedUntil;
}

export class SarvamTtsError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = "SarvamTtsError";
  }
}

/** Speak Devanagari (Hindi / Hinglish) text with a Sarvam voice; returns MP3 bytes. */
export async function sarvamSpeak(text: string, voiceKey: SarvamVoiceKey): Promise<Buffer> {
  if (!env.sarvamApiKey) throw new SarvamTtsError("Sarvam key not set", 0);
  const voice = SARVAM_VOICES[voiceKey] ?? SARVAM_VOICES[DEFAULT_SARVAM_VOICE];
  const body: Record<string, unknown> = {
    text: text.slice(0, 2400),
    language_code: "hi-IN",
    model: voice.model,
    speaker: voice.speaker,
    // A touch slower than normal: a munshi talking across the counter, not a radio ad.
    pace: 0.95,
    speech_sample_rate: 24000,
    output_audio_codec: "mp3",
  };
  // v3's only expressiveness control: a little above default for more feeling.
  if (voice.model === "bulbul:v3") body.temperature = 0.7;

  const res = await fetch(URL_TTS, {
    method: "POST",
    headers: { "api-subscription-key": env.sarvamApiKey, "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) {
    const err = (await res.json().catch(() => null)) as { error?: { message?: string; code?: string } } | null;
    const code = err?.error?.code;
    if (res.status === 402 || res.status === 401 || res.status === 403 || code === "insufficient_quota_error" || code === "invalid_api_key_error") {
      pausedUntil = Date.now() + PAUSE_AFTER_ACCOUNT_ERROR_MS;
      console.error(`[sarvam-tts] ${res.status} ${code ?? ""}: pausing Sarvam voice for an hour, using Microsoft voice`);
    }
    throw new SarvamTtsError(err?.error?.message ?? `Sarvam voice failed (${res.status})`, res.status);
  }
  const data = (await res.json()) as { audios?: string[] };
  const audio = Buffer.from((data.audios ?? []).join(""), "base64");
  if (audio.length === 0) throw new SarvamTtsError("Sarvam returned no audio", 502);
  void logAiCall({ kind: "tts", provider: "sarvam", model: voice.model, characters: [...body.text as string].length });
  return audio;
}
