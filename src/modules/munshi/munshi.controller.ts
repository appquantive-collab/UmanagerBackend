import { Router } from "express";
import { z } from "zod";
import { ipRateLimit } from "../../middleware/ipRateLimit";
import { MunshiUnavailableError, askMunshi } from "./munshi.service";

// Public: visitors ask Munshi AI about SethSathi before signing up.

export const munshiRouter = Router();

const askSchema = z.object({
  question: z.string().trim().min(1).max(300),
  lang: z.enum(["en", "hi-Latn", "hi"]).default("en"),
});

const limit = ipRateLimit({ perIp: 15, total: 300, message: "Too many questions. Please wait a minute." });

munshiRouter.post("/ask", limit, async (req, res) => {
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
