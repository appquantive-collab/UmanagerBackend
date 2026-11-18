import { env } from "../../config/env";
import { logAiCall } from "../billing/ai-cost.service";

/**
 * Sarvam AI speech-to-text (saaras:v4): built for Indian languages and
 * Hinglish, so it hears shop talk far better than Whisper. Used first for the
 * final read of what someone said; when it fails (credits used up, key wrong,
 * clip over 30 s, service down) the caller falls back to Whisper.
 * Docs: https://docs.sarvam.ai/api-reference-docs/speech-to-text/transcribe
 */

const URL_STT = "https://api.sarvam.ai/speech-to-text";
const MODEL = "saaras:v4";
/** After a quota or key error, don't try Sarvam again for this long. */
const PAUSE_AFTER_ACCOUNT_ERROR_MS = 60 * 60 * 1000;

let pausedUntil = 0;

export class SarvamError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string
  ) {
    super(message);
    this.name = "SarvamError";
  }
}

export function sarvamAvailable(): boolean {
  return Boolean(env.sarvamApiKey) && Date.now() >= pausedUntil;
}

/**
 * mode "codemix": English words stay in English, Hindi in Devanagari (the
 * cleanup then writes it in the person's script); "translit": everything in
 * Roman letters; "transcribe": plain, for English.
 */
export async function sarvamTranscribe(
  audio: Buffer,
  mimeType: string,
  languageCode: "hi-IN" | "en-IN" | "unknown",
  mode: "codemix" | "translit" | "transcribe",
  /** Clip length, for the cost report. */
  audioSeconds?: number
): Promise<string> {
  if (!env.sarvamApiKey) throw new SarvamError("Sarvam key not set", 0);
  const type = mimeType || "audio/webm";
  const extension = type.includes("mp4") ? "m4a" : type.includes("ogg") ? "ogg" : type.includes("mpeg") ? "mp3" : type.includes("wav") ? "wav" : "webm";

  const form = new FormData();
  form.append("file", new Blob([new Uint8Array(audio)], { type }), `speech.${extension}`);
  form.append("model", MODEL);
  form.append("mode", mode);
  form.append("language_code", languageCode);

  const res = await fetch(URL_STT, {
    method: "POST",
    headers: { "api-subscription-key": env.sarvamApiKey },
    body: form,
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: { message?: string; code?: string } } | null;
    const code = body?.error?.code;
    // Out of credits or a bad key won't fix itself in a minute: rest Sarvam for an hour.
    if (
      res.status === 402 ||
      res.status === 401 ||
      res.status === 403 ||
      code === "insufficient_quota_error" ||
      code === "invalid_api_key_error" ||
      code === "authentication_error"
    ) {
      pausedUntil = Date.now() + PAUSE_AFTER_ACCOUNT_ERROR_MS;
      console.error(`[sarvam] ${res.status} ${code ?? ""}: pausing Sarvam for an hour, using Whisper`);
    }
    throw new SarvamError(body?.error?.message ?? `Sarvam speech-to-text failed (${res.status})`, res.status, code);
  }
  void logAiCall({ kind: "stt", provider: "sarvam", model: MODEL, audioSeconds: audioSeconds ?? Math.max(1, audio.length / 4000) });
  const data = (await res.json()) as { transcript?: string };
  return (data.transcript ?? "").trim();
}
