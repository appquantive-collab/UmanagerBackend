import { liveUsdToInr } from "./exchange-rate.service";
import { AsyncLocalStorage } from "async_hooks";
import type { NextFunction, Request, Response } from "express";
import jwt from "jsonwebtoken";
import { Types } from "mongoose";
import { env } from "../../config/env";
import type { AuthPayload } from "../../middleware/auth";
import { AiCall, type AiKind } from "../../models/AiCall";
import { PlatformSetting } from "../../models/PlatformSetting";

/**
 * What AI costs VoiceMunshi, in rupees: every Groq / Sarvam call is written down
 * with its tokens or audio length and priced from the founder's price list
 * (admin → Settings). Calls are tied to the business whose request made them,
 * without passing the business id through every service: a request carries it
 * (AsyncLocalStorage), so speech, voice, setup and chat calls all land on the
 * right business.
 */

// ---------- Prices (Groq / Sarvam list prices, Nov 2026; editable in admin) ----------

export interface TokenPrice {
  /** USD per 1M tokens. */
  input: number;
  cachedInput: number;
  output: number;
}

export interface Pricing {
  /** Rupees per dollar used for Groq's dollar prices. With usdToInrAuto it's the live market rate. */
  usdToInr: number;
  /** true (default): follow the live rate, refreshed twice a day; false: use usdToInr as typed. */
  usdToInrAuto: boolean;
  tokens: Record<string, TokenPrice>;
  /** Whisper: USD per hour of audio. */
  whisperPerHourUsd: Record<string, number>;
  /** Groq bills at least this many seconds per Whisper request. */
  whisperMinSeconds: number;
  /** Sarvam speech-to-text: INR per minute (billed per second). */
  sarvamPerMinuteInr: number;
  /** Sarvam Bulbul voice: INR per 1,000 characters, by model. */
  sarvamTtsPer1kInr: Record<string, number>;
}

/**
 * Groq list prices (USD), checked against console.groq.com/docs/models and
 * /docs/speech-to-text on GROQ_PRICES_CHECKED. Cached input is half price
 * (docs/prompt-caching). Sarvam prices are in rupees already.
 */
export const GROQ_PRICES_CHECKED = "2026-11-19";

export const DEFAULT_PRICING: Pricing = {
  // Fallback only, used until the first live rate arrives (₹93.51 on 19 Nov 2026).
  usdToInr: 93.5,
  usdToInrAuto: true,
  tokens: {
    "openai/gpt-oss-120b": { input: 0.15, cachedInput: 0.075, output: 0.6 },
    "openai/gpt-oss-20b": { input: 0.075, cachedInput: 0.0375, output: 0.3 },
  },
  whisperPerHourUsd: { "whisper-large-v3": 0.111, "whisper-large-v3-turbo": 0.04 },
  whisperMinSeconds: 10,
  sarvamPerMinuteInr: 0.49,
  sarvamTtsPer1kInr: { "bulbul:v3": 3, "bulbul:v4-flash": 1 },
};

const PRICE_CACHE_MS = 60_000;
let priceCache: { pricing: Pricing; at: number } | null = null;

export async function getPricing(): Promise<Pricing> {
  if (priceCache && Date.now() - priceCache.at < PRICE_CACHE_MS) return priceCache.pricing;
  const doc = await PlatformSetting.findOne({ key: "global" }, { pricing: 1 }).lean();
  const saved = (doc?.pricing ?? {}) as Partial<Pricing>;
  const pricing: Pricing = {
    ...DEFAULT_PRICING,
    ...saved,
    tokens: { ...DEFAULT_PRICING.tokens, ...(saved.tokens ?? {}) },
    whisperPerHourUsd: { ...DEFAULT_PRICING.whisperPerHourUsd, ...(saved.whisperPerHourUsd ?? {}) },
    sarvamTtsPer1kInr: { ...DEFAULT_PRICING.sarvamTtsPer1kInr, ...(saved.sarvamTtsPer1kInr ?? {}) },
    usdToInrAuto: saved.usdToInrAuto !== false,
  };
  if (pricing.usdToInrAuto) {
    const live = await liveUsdToInr().catch(() => null);
    if (live) pricing.usdToInr = live.rate;
  }
  priceCache = { pricing, at: Date.now() };
  return pricing;
}

export async function setPricing(pricing: Pricing): Promise<Pricing> {
  await PlatformSetting.updateOne({ key: "global" }, { $set: { pricing } }, { upsert: true });
  priceCache = null;
  return getPricing();
}

/** Forget the cached price list (after a fresh exchange rate). */
export function clearPriceCache() {
  priceCache = null;
}

/** Blended rate for old months that only have a token total (assume ~85% of tokens are prompt). */
export function estimateTokensInr(tokens: number, pricing: Pricing): number {
  const p = pricing.tokens["openai/gpt-oss-120b"] ?? DEFAULT_PRICING.tokens["openai/gpt-oss-120b"];
  const usd = (tokens * 0.85 * p.input + tokens * 0.15 * p.output) / 1_000_000;
  return usd * pricing.usdToInr;
}

// ---------- Which business a call belongs to ----------

const requestContext = new AsyncLocalStorage<{ tenantId: string | null; userId: string | null }>();

/** The signed-in business / login of the request being served (null before sign-up). */
export function currentTenantId(): string | null {
  return requestContext.getStore()?.tenantId ?? null;
}

/** Express middleware: remember the signed-in business for AI calls made while serving this request. */
export function aiAttribution(req: Request, _res: Response, next: NextFunction) {
  let tenantId: string | null = null;
  let userId: string | null = null;
  const header = req.headers.authorization;
  if (header?.startsWith("Bearer ")) {
    try {
      const payload = jwt.verify(header.slice("Bearer ".length), env.jwt.accessSecret) as AuthPayload;
      tenantId = payload.tenantId ?? null;
      userId = payload.userId ?? null;
    } catch {
      tenantId = null;
    }
  }
  requestContext.run({ tenantId, userId }, next);
}

// ---------- Writing calls down ----------

const istDate = (d: Date) => new Date(d.getTime() + 5.5 * 60 * 60 * 1000).toISOString().slice(0, 10);

interface Usage {
  prompt_tokens?: number;
  completion_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: number } | null;
}

/**
 * Record one AI call. Never throws (a cost log must not break a reply).
 * Pass either `usage` (chat models) or `audioSeconds` (speech-to-text).
 */
export async function logAiCall(entry: {
  kind: AiKind;
  model: string;
  provider?: "groq" | "sarvam";
  usage?: Usage | null;
  audioSeconds?: number;
  /** Text-to-speech: characters spoken. */
  characters?: number;
  tenantId?: string | null;
}): Promise<void> {
  try {
    const pricing = await getPricing();
    const provider = entry.provider ?? "groq";
    const cached = Math.max(0, entry.usage?.prompt_tokens_details?.cached_tokens ?? 0);
    const input = Math.max(0, (entry.usage?.prompt_tokens ?? 0) - cached);
    const output = Math.max(0, entry.usage?.completion_tokens ?? 0);
    const seconds = Math.max(0, entry.audioSeconds ?? 0);

    let costInr = 0;
    if (provider === "sarvam" && entry.model.startsWith("bulbul")) {
      costInr = ((entry.characters ?? 0) / 1000) * (pricing.sarvamTtsPer1kInr[entry.model] ?? 3);
    } else if (provider === "sarvam") {
      costInr = (seconds / 60) * pricing.sarvamPerMinuteInr;
    } else if (entry.model.startsWith("whisper")) {
      const perHour = pricing.whisperPerHourUsd[entry.model] ?? 0;
      costInr = (Math.max(seconds, pricing.whisperMinSeconds) / 3600) * perHour * pricing.usdToInr;
    } else {
      // Groq may answer with a dated model name; match on the family.
      const key = Object.keys(pricing.tokens).find((k) => entry.model === k || entry.model.startsWith(k)) ?? "openai/gpt-oss-120b";
      const p = pricing.tokens[key];
      costInr = ((input * p.input + cached * p.cachedInput + output * p.output) / 1_000_000) * pricing.usdToInr;
    }

    const tenantId = entry.tenantId !== undefined ? entry.tenantId : (requestContext.getStore()?.tenantId ?? null);
    const now = new Date();
    const day = istDate(now);
    const userId = requestContext.getStore()?.userId ?? null;
    await AiCall.create({
      tenantId: tenantId && Types.ObjectId.isValid(tenantId) ? new Types.ObjectId(tenantId) : null,
      userId: userId && Types.ObjectId.isValid(userId) ? new Types.ObjectId(userId) : null,
      at: now,
      day,
      month: day.slice(0, 7),
      kind: entry.kind,
      provider,
      model: entry.model,
      inputTokens: input,
      cachedTokens: cached,
      outputTokens: output,
      audioSeconds: Math.round(seconds * 10) / 10,
      characters: entry.characters ?? 0,
      costInr: Math.round(costInr * 10000) / 10000,
    });
  } catch (err) {
    console.error("[ai-cost] could not record call:", (err as Error).message);
  }
}

/** Average rupees per call by kind over the last 30 days (for "≈ N a day" estimates). */
export async function averageCostByKind(): Promise<Record<string, number>> {
  const since = istDateDaysAgo(30);
  const rows = await AiCall.aggregate([{ $match: { day: { $gte: since }, costInr: { $gt: 0 } } }, { $group: { _id: "$kind", avg: { $avg: "$costInr" }, n: { $sum: 1 } } }]);
  return Object.fromEntries(rows.filter((r) => r.n >= 5).map((r) => [r._id, r.avg]));
}

/** One Munshi chat message, in rupees (measured; ₹0.07 until there's enough data). */
export async function chatMessageCostInr(): Promise<number> {
  const avg = await averageCostByKind();
  return avg.chat ?? 0.07;
}

function istDateDaysAgo(days: number): string {
  return istDate(new Date(Date.now() - days * 86_400_000));
}

// ---------- One "token" for everything AI ----------
//
// Businesses see AI use in tokens. Chat models are billed in tokens already;
// speech-to-text (per second) and the voice (per character) are not, so all of
// it is put on one scale: 1 token = the price of one input token of Munshi's
// main model. A chat message then shows roughly its real token count (answer
// tokens weigh 4× — they cost 4×), and a minute of speech shows what it costs
// in the same units. The limit itself is still the rupee budget.

const MAIN_MODEL = "openai/gpt-oss-120b";

/** Rupees per token on that one scale. */
export async function rupeesPerToken(): Promise<number> {
  const pricing = await getPricing();
  const main = pricing.tokens[MAIN_MODEL] ?? DEFAULT_PRICING.tokens[MAIN_MODEL];
  return (main.input / 1_000_000) * pricing.usdToInr;
}

/** Tokens a typical Munshi question takes, and a minute of speech-to-text (for "≈ N questions / minutes"). */
export async function tokenYardsticks(sttEngine: "auto" | "sarvam" | "whisper"): Promise<{ perQuestion: number; perSpeechMinute: number }> {
  const [rate, pricing, perMessage] = await Promise.all([rupeesPerToken(), getPricing(), chatMessageCostInr()]);
  const speechMinuteInr =
    sttEngine === "whisper" ? ((pricing.whisperPerHourUsd["whisper-large-v3"] ?? 0.111) / 60) * pricing.usdToInr : pricing.sarvamPerMinuteInr;
  return { perQuestion: Math.round(perMessage / rate), perSpeechMinute: Math.round(speechMinuteInr / rate) };
}
