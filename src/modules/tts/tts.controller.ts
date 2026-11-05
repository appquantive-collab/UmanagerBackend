import { Router } from "express";
import { z } from "zod";
import { ipRateLimit } from "../../middleware/ipRateLimit";
import { TtsUnavailableError, synthesize } from "./tts.service";

// Public on purpose: Munshi speaks in the sign-up chat before anyone has an
// account. Short texts and per-IP limits keep it from becoming a free TTS proxy.

export const ttsRouter = Router();

const ttsSchema = z.object({
  text: z.string().trim().min(1).max(600),
  lang: z.enum(["en", "hi-Latn", "hi"]).default("en"),
});

const limit = ipRateLimit({ perIp: 40, total: 600, message: "Too many voice requests. Please wait a minute." });

// POST (not GET) so spoken text — which can include names and emails — stays out of request logs.
ttsRouter.post("/", limit, async (req, res) => {
  const parsed = ttsSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  try {
    const audio = await synthesize(parsed.data.text, parsed.data.lang);
    res.setHeader("Content-Type", "audio/mpeg");
    res.setHeader("Cache-Control", "private, max-age=86400");
    return res.send(audio);
  } catch (err) {
    if (err instanceof TtsUnavailableError) {
      console.error("[tts]", err.message);
      return res.status(503).json({ error: "Voice is unavailable right now." });
    }
    throw err;
  }
});
