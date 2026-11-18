import { Router, type Request, type Response } from "express";
import multer from "multer";
import { z } from "zod";
import { ipRateLimit } from "../../middleware/ipRateLimit";
import { MunshiUnavailableError, askMunshi, transcribeFinal, transcribeSpeech } from "./munshi.service";

// Public: visitors talk to Munshi AI about VoiceMunshi before signing up.

export const munshiRouter = Router();

const languageSchema = z.enum(["en", "hi-Latn", "hi"]).default("en");

const askSchema = z.object({
  question: z.string().trim().min(1).max(300),
  lang: languageSchema,
});

const askLimit = ipRateLimit({ perIp: 15, total: 300, message: "Too many questions. Please wait a minute." });

munshiRouter.post("/ask", askLimit, async (req, res) => {
  const parsed = askSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  try {
    return res.json({ reply: await askMunshi(parsed.data.question, parsed.data.lang) });
  } catch (err) {
    if (err instanceof MunshiUnavailableError) {
      console.error("[munshi]", err.message);
      return res.status(503).json({ error: "Munshi AI can't answer right now." });
    }
    throw err;
  }
});

// Hold-to-talk voice messages: a few seconds of audio, transcribed by Whisper.
const audioUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => cb(null, file.mimetype.startsWith("audio/") || file.mimetype === "video/webm"),
});

const transcribeSchema = z.object({
  lang: languageSchema,
  kind: z.enum(["text", "phone", "email"]).default("text"),
  /** Set on the final read of free speech: an AI pass fixes what Whisper misheard. */
  purpose: z.enum(["business", "order", "chat"]).optional(),
  /** Clip length in ms (from the app), for the cost report. */
  durationMs: z.coerce.number().min(0).max(30 * 60 * 1000).optional(),
});

const transcribeLimit = ipRateLimit({ perIp: 20, total: 300, message: "Too many voice messages. Please wait a minute." });
// Live transcript while the mic is on: the clip-so-far is re-read every few
// seconds, so it gets its own (larger) budget and never eats the final one.
const liveTranscribeLimit = ipRateLimit({ perIp: 40, total: 600, message: "Too many voice messages. Please wait a minute." });

munshiRouter.post("/transcribe", transcribeLimit, audioUpload.single("audio"), transcribeHandler);
munshiRouter.post("/transcribe/live", liveTranscribeLimit, audioUpload.single("audio"), transcribeHandler);

async function transcribeHandler(req: Request, res: Response) {
  const parsed = transcribeSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  if (!req.file || req.file.size === 0) return res.status(400).json({ error: "No audio received." });

  try {
    // Live previews stay quick and raw; the final read of free speech uses the
    // accurate model plus an AI cleanup of what was misheard.
    const live = req.path.endsWith("/live");
    const seconds = parsed.data.durationMs ? parsed.data.durationMs / 1000 : undefined;
    const text =
      parsed.data.kind === "text" && !live
        ? await transcribeFinal(req.file.buffer, req.file.mimetype, parsed.data.lang, parsed.data.purpose, seconds)
        : await transcribeSpeech(req.file.buffer, req.file.mimetype, parsed.data.lang, parsed.data.kind, { audioSeconds: seconds, live });
    return res.json({ text });
  } catch (err) {
    if (err instanceof MunshiUnavailableError) {
      console.error("[munshi] transcribe:", err.message);
      return res.status(503).json({ error: "Couldn't understand the voice message right now." });
    }
    throw err;
  }
}
