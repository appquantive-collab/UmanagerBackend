import { MsEdgeTTS, OUTPUT_FORMAT } from "msedge-tts";
import { env } from "../../config/env";
import { GROQ_CHAT_MODEL, getGroqClient } from "../../config/groq";

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

const DEVANAGARI_PROMPT = `You are Munshi, a calm, warm assistant at an Indian shop. You get a reply that was written for the screen (Hinglish or Hindi, maybe with lists) and turn it into what you would SAY out loud to the shop owner, in everyday spoken Hindi written in Devanagari, for a Hindi text-to-speech voice.
Rules:
- Keep names and the numbers that matter correct, and never add facts, advice or greetings. You may leave out minor details and summarise a list the way a person would (the full text is on the screen).
- Sound like a person talking calmly and kindly, not reading a list or a table. Group items that share a status and say the status once ("डमरू 88, जेयर और खड़ताल का स्टॉक खत्म हो गया है, और तबला हैंडल भी कम है।"). Never repeat the same words after every item. Leave out details a person wouldn't say aloud (like reorder levels) unless they are the point. Use commas and full stops for natural pauses. No headings, dashes, symbols, brackets or bullet marks.
- If a list has more than 5 items, say the 5 most important, then say how many more there are and that the full list is on the screen.
- Hindi words written in Roman letters are Hindi: spell them in proper Hindi (Tabla → तबला, Damru → डमरू, Khartaal → खड़ताल, Dholak → ढोलक).
- Write English words in Devanagari the way Indians say them (order → ऑर्डर, bill → बिल, stock → स्टॉक, Google → गूगल). SethSathi → सेठसाथी, Munshi → मुंशी, AI → एआई, GST → जीएसटी.
- Negative numbers are said with "माइनस" (stock -22 → स्टॉक माइनस 22). Keep digits and ₹ amounts as digits.
- Keep it short and simple, the way you'd say it across the counter.
- Reply with only the words to speak.

Example
Screen: "Ye items kam hain:. Tabla Handle – stock 20 (low). Damru 88 – stock -1 (out of stock). Jeyar – stock -22 (out of stock)."
Spoken: "डमरू 88 और जेयर का स्टॉक खत्म हो गया है, बल्कि माइनस में चला गया है। और तबला हैंडल भी अब कम बचा है।"`;

export async function toDevanagari(text: string): Promise<string | null> {
  const cached = scriptCache.get(text);
  if (cached) return cached;
  if (!env.groqApiKey) return null;
  try {
    const response = await getGroqClient().chat.completions.create({
      model: GROQ_CHAT_MODEL,
      reasoning_effort: "low",
      temperature: 0.3,
      max_completion_tokens: 800,
      messages: [
        { role: "system", content: DEVANAGARI_PROMPT },
        { role: "user", content: text },
      ],
    }, { timeout: 6000, maxRetries: 0 });
    const converted = response.choices[0]?.message?.content?.trim();
    // Must be mostly Devanagari, and not wildly longer/shorter than the input.
    if (!converted || !/[ऀ-ॿ]/.test(converted) || converted.length > text.length * 2 + 20) return null;
    scriptCache.set(text, converted);
    if (scriptCache.size > SCRIPT_CACHE_MAX) {
      const oldest = scriptCache.keys().next().value;
      if (oldest !== undefined) scriptCache.delete(oldest);
    }
    return converted;
  } catch (err) {
    console.error("[tts] Hinglish → Devanagari failed:", (err as Error).message);
    return null;
  }
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

export async function synthesize(input: string, language: TtsLanguage): Promise<Buffer> {
  let voice = VOICES[language];
  let text = speakable(input);
  if (language === "hi-Latn" || language === "hi") {
    // Calm spoken Hindi for the Hindi voice (lists become sentences, symbols go).
    const spoken = await toDevanagari(text);
    if (spoken) text = spoken;
    // Couldn't convert Hinglish: the English voice still reads Latin letters better than the Hindi one.
    else if (language === "hi-Latn") voice = ENGLISH_VOICE;
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
