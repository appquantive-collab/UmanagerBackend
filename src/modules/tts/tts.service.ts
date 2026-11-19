import { logAiCall } from "../billing/ai-cost.service";
import { getTtsSettings } from "../../models/PlatformSetting";
import { DEFAULT_SARVAM_VOICE, SARVAM_VOICES, type SarvamVoiceKey, sarvamSpeak, sarvamTtsAvailable } from "./sarvam-tts.service";
import { MsEdgeTTS, OUTPUT_FORMAT } from "msedge-tts";
import { env } from "../../config/env";
import { GROQ_CHAT_MODEL, GROQ_FALLBACK_MODEL, getGroqClient } from "../../config/groq";

// Munshi AI's voice: free Microsoft Edge "Read aloud" neural voices via the
// msedge-tts library (no API key). It's an unofficial use of that service and
// can break if Microsoft changes it; the web app then falls back to the
// browser's own voice.

export type TtsLanguage = "en" | "hi-Latn" | "hi";

// Indian male voices: Prabhat for English, Madhur for Hindi. Hinglish (Hindi in
// Latin letters) read by an English voice comes out with English pronunciation
// and sounds robotic, so Hindi and Hinglish replies are first turned into calm
// spoken Hindi in Devanagari (see toDevanagari) and read by Madhur. A touch
// slower than default, so Munshi sounds unhurried rather than rushed.
// Keep in sync with web/scripts/generate-voice.mjs and VOICE_IDS in web/src/lib/speech.ts.
const ENGLISH_VOICE = { name: "en-IN-PrabhatNeural", rate: "-5%" };
const HINDI_VOICE = { name: "hi-IN-MadhurNeural", rate: "-5%" };
const VOICES: Record<TtsLanguage, { name: string; rate: string }> = {
  en: ENGLISH_VOICE,
  "hi-Latn": HINDI_VOICE,
  hi: HINDI_VOICE,
};

// ---------- Hinglish → Devanagari, so the Hindi voice says it right ----------
const SCRIPT_CACHE_MAX = 500;
const scriptCache = new Map<string, string>();

const DEVANAGARI_PROMPT = `You prepare text for a Hindi text-to-speech voice. You get a reply exactly as it is shown on the screen (Hinglish in Roman letters, or Hindi). Write the SAME words, in the SAME order, in Devanagari script, so the voice reads out exactly what the person sees.
Rules:
- Do not rephrase, summarise, shorten, reorder, add or drop anything. Every word, name, number and item on the screen must be spoken, in the same order. This is transliteration, not rewriting.
- Hinglish words in Roman letters: spell them in proper Hindi (kya → क्या, apply karna hai → अप्लाई करना है, Tabla → तबला, Damru → डमरू).
- English words: write them in Devanagari the way Indians say them (bill → बिल, rate → रेट, percentage → परसेंटेज, stock → स्टॉक, order → ऑर्डर). GST → जीएसटी, AI → एआई, Munshi → मुंशी, VoiceMunshi → वॉइसमुंशी.
- Only change what a voice cannot read: drop markdown (**, bullets, list numbers, headings) and bracket marks but keep the words inside them; turn a list into sentences separated by commas or full stops, keeping every item.
- Symbols said as words: ₹500 → 500 रुपये, 18% → 18 प्रतिशत, - before a number → माइनस, & → और, / between words → या. Keep digits as digits.
- Reply with only the text to speak.

Examples
Screen: "Ravi ji ke bill ke liye GST rate kya apply karna hai? (percentage me)"
Spoken: "रवि जी के बिल के लिए जीएसटी रेट क्या अप्लाई करना है? परसेंटेज में।"
Screen: "Aaj ki bikri **₹15,316** hui hai. Sabse zyada udhaar **Gupta General Store** par hai."
Spoken: "आज की बिक्री 15,316 रुपये हुई है। सबसे ज़्यादा उधार गुप्ता जनरल स्टोर पर है।"`;

/** Share of letters still in Roman script (0 = all Devanagari). */
function latinShare(text: string): number {
  const latin = (text.match(/[A-Za-z]/g) ?? []).length;
  const deva = (text.match(/[ऀ-ॿ]/g) ?? []).length;
  return latin + deva === 0 ? 0 : latin / (latin + deva);
}

/**
 * Text already in Devanagari (Hindi replies) needs no AI: only the symbols a
 * voice can't read become words. Saves a whole AI round trip for Hindi.
 */
function spokenHindiByRules(text: string): string {
  return text
    .replace(/₹\s?([\d,]+(?:\.\d+)?)/g, "$1 रुपये")
    .replace(/(\d)\s?%/g, "$1 प्रतिशत")
    .replace(/\s&\s/g, " और ")
    .replace(/[()[\]{}]/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
}

async function convertWith(model: string, text: string, timeout: number, maxLatin: number): Promise<string | null> {
  const response = await getGroqClient().chat.completions.create(
    {
      model,
      reasoning_effort: "low",
      temperature: 0.1,
      max_completion_tokens: 1200,
      messages: [
        { role: "system", content: DEVANAGARI_PROMPT },
        { role: "user", content: text },
      ],
    },
    { timeout, maxRetries: 0 }
  );
  void logAiCall({ kind: "tts", model: response.model ?? model, usage: response.usage });
  const converted = response.choices[0]?.message?.content?.trim();
  // Must be (almost) all Devanagari, and not wildly longer/shorter than the input.
  if (!converted || latinShare(converted) > maxLatin || converted.length > text.length * 2 + 20) return null;
  return converted;
}

export async function toDevanagari(text: string): Promise<string | null> {
  const cached = scriptCache.get(text);
  if (cached) return cached;
  let converted: string | null = null;
  if (!/[A-Za-z]/.test(text)) converted = spokenHindiByRules(text);
  else if (env.groqApiKey) {
    // The small model answers in ~0.25s (the big one ~0.65s) but now and then
    // leaves words in Roman letters; then the big one does it properly.
    // Bill numbers and codes (INV-0012) may stay in Roman letters, so the last try is lenient.
    for (const [model, timeout, maxLatin] of [
      [GROQ_FALLBACK_MODEL, 3000, 0.12],
      [GROQ_CHAT_MODEL, 6000, 0.4],
    ] as const) {
      try {
        converted = await convertWith(model, text, timeout, maxLatin);
        if (converted) break;
      } catch (err) {
        console.error(`[tts] Hinglish → Devanagari (${model}) failed:`, (err as Error).message);
      }
    }
  }
  if (!converted) return null;
  scriptCache.set(text, converted);
  if (scriptCache.size > SCRIPT_CACHE_MAX) {
    const oldest = scriptCache.keys().next().value;
    if (oldest !== undefined) scriptCache.delete(oldest);
  }
  return converted;
}

const FORMAT = OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3;
const SYNTH_TIMEOUT_MS = 15_000;
const CACHE_MAX_ENTRIES = 300;

// Most of Munshi's lines are fixed prompts, so a small cache serves repeats instantly.
const cache = new Map<string, Buffer>();

function remember(key: string, audio: Buffer) {
  cache.delete(key);
  cache.set(key, audio);
  if (cache.size > CACHE_MAX_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
}

// msedge-tts accepts SSML in its input, so user-provided text (names, business
// names) must be escaped to stay plain text.
function escapeXml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

export class TtsUnavailableError extends Error {
  constructor(reason: string) {
    super(`Voice service unavailable: ${reason}`);
    this.name = "TtsUnavailableError";
  }
}

// One open connection per voice. Opening a connection costs ~1s per line;
// reusing it brings a line down to ~0.3s. Lines for the same voice are queued
// so they never share the connection at the same moment.
const connections = new Map<string, Promise<MsEdgeTTS>>();
const queues = new Map<string, Promise<unknown>>();

function getConnection(voiceName: string): Promise<MsEdgeTTS> {
  let connection = connections.get(voiceName);
  if (!connection) {
    connection = (async () => {
      const tts = new MsEdgeTTS();
      await tts.setMetadata(voiceName, FORMAT);
      return tts;
    })();
    connections.set(voiceName, connection);
    connection.catch(() => connections.delete(voiceName));
  }
  return connection;
}

function dropConnection(voiceName: string) {
  const connection = connections.get(voiceName);
  connections.delete(voiceName);
  connection?.then((tts) => tts.close()).catch(() => undefined);
}

function inQueue<T>(voiceName: string, task: () => Promise<T>): Promise<T> {
  const previous = queues.get(voiceName) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(task);
  queues.set(
    voiceName,
    next.catch(() => undefined)
  );
  return next;
}

async function synthOnce(voice: { name: string; rate: string }, text: string): Promise<Buffer> {
  const tts = await getConnection(voice.name);
  const { audioStream } = tts.toStream(escapeXml(text), { rate: voice.rate });

  const audio = await new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    const timer = setTimeout(() => {
      audioStream.destroy();
      reject(new TtsUnavailableError("timed out"));
    }, SYNTH_TIMEOUT_MS);
    audioStream.on("data", (chunk: Buffer) => chunks.push(chunk));
    audioStream.on("end", () => {
      clearTimeout(timer);
      resolve(Buffer.concat(chunks));
    });
    audioStream.on("error", (err: Error) => {
      clearTimeout(timer);
      reject(new TtsUnavailableError(err.message));
    });
  });

  if (audio.length === 0) throw new TtsUnavailableError("empty audio");
  return audio;
}

/** Symbols a voice would read out ("right arrow") or stumble on become pauses. */
function speakable(text: string): string {
  return text
    .replace(/\s*[→←⇒➜➝»]\s*/g, ", ")
    .replace(/\s+[–—-]\s+/g, ", ")
    .replace(/[•·|*_#`]/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
}

export async function synthesize(input: string, language: TtsLanguage, options: { voiceOverride?: SarvamVoiceKey } = {}): Promise<Buffer> {
  let voice = VOICES[language];
  let text = speakable(input);
  let spokenHindi = false;
  if (language === "hi-Latn" || language === "hi") {
    // Calm spoken Hindi for the Hindi voice (lists become sentences, symbols go).
    const spoken = await toDevanagari(text);
    if (spoken) {
      text = spoken;
      spokenHindi = true;
    }
    // Couldn't convert Hinglish: the English voice still reads Latin letters better than the Hindi one.
    else if (language === "hi-Latn") voice = ENGLISH_VOICE;
  }

  // Hindi / Hinglish: Sarvam's natural Indian male voice first (Admin → Settings picks it);
  // the Microsoft voice below is the backup. Sarvam needs the Devanagari text.
  const tts = await getTtsSettings();
  const useSarvam = spokenHindi && (options.voiceOverride !== undefined || tts.engine === "sarvam" || (tts.engine === "auto" && sarvamTtsAvailable()));
  if (useSarvam) {
    const voiceKey = (options.voiceOverride ?? (tts.voice in SARVAM_VOICES ? tts.voice : DEFAULT_SARVAM_VOICE)) as SarvamVoiceKey;
    const sarvamKey = `sarvam|${voiceKey}|${text}`;
    const hit = cache.get(sarvamKey);
    if (hit) {
      remember(sarvamKey, hit);
      return hit;
    }
    try {
      const audio = await sarvamSpeak(text, voiceKey);
      remember(sarvamKey, audio);
      return audio;
    } catch (err) {
      if (tts.engine === "sarvam" || options.voiceOverride) throw new TtsUnavailableError(`Sarvam: ${(err as Error).message}`);
      console.warn("[tts] Sarvam voice failed, using Microsoft voice:", (err as Error).message.slice(0, 160));
    }
  }
  const key = `${voice.name}|${voice.rate}|${text}`;
  const cached = cache.get(key);
  if (cached) {
    remember(key, cached);
    return cached;
  }

  const audio = await inQueue(voice.name, async () => {
    try {
      return await synthOnce(voice, text);
    } catch {
      // The kept-open connection may have been closed by the service; reconnect once.
      dropConnection(voice.name);
      try {
        return await synthOnce(voice, text);
      } catch (err) {
        dropConnection(voice.name);
        if (err instanceof TtsUnavailableError) throw err;
        throw new TtsUnavailableError(err instanceof Error ? err.message : String(err));
      }
    }
  });

  remember(key, audio);
  return audio;
}

/** Open the voice connections at startup so the first visitor doesn't pay for it. */
export function warmUpVoices() {
  for (const name of new Set(Object.values(VOICES).map((voice) => voice.name))) {
    getConnection(name).catch((err) => console.error("[tts] warm-up failed:", (err as Error).message));
  }
}
