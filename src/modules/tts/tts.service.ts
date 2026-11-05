import { MsEdgeTTS, OUTPUT_FORMAT } from "msedge-tts";

// Munshi AI's voice: free Microsoft Edge "Read aloud" neural voices via the
// msedge-tts library (no API key). It's an unofficial use of that service and
// can break if Microsoft changes it; the web app then falls back to the
// browser's own voice.

export type TtsLanguage = "en" | "hi-Latn" | "hi";

// Indian male voices: Prabhat reads English and Hinglish (Latin script) with an
// Indian accent; Madhur reads Devanagari Hindi. Their default pace sounds like
// slow dictation, so each is sped up a little toward natural conversation.
const VOICES: Record<TtsLanguage, { name: string; rate: string }> = {
  en: { name: "en-IN-PrabhatNeural", rate: "+22%" },
  "hi-Latn": { name: "en-IN-PrabhatNeural", rate: "+22%" },
  hi: { name: "hi-IN-MadhurNeural", rate: "+16%" },
};

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

export async function synthesize(text: string, language: TtsLanguage): Promise<Buffer> {
  const voice = VOICES[language];
  const key = `${voice.name}|${voice.rate}|${text}`;
  const cached = cache.get(key);
  if (cached) {
    remember(key, cached);
    return cached;
  }

  const tts = new MsEdgeTTS();
  try {
    await tts.setMetadata(voice.name, OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3);
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
    remember(key, audio);
    return audio;
  } catch (err) {
    if (err instanceof TtsUnavailableError) throw err;
    throw new TtsUnavailableError(err instanceof Error ? err.message : String(err));
  } finally {
    tts.close();
  }
}
