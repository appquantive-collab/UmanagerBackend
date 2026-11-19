import { logAiCall } from "./ai-cost.service";
import type { AiKind } from "../../models/AiCall";
import type { Response } from "express";
import { Types } from "mongoose";
import { Tenant, type BillingPeriod, type PlanKey, type Subscription } from "../../models/Tenant";
import { AiUsage } from "../../models/AiUsage";
import { AiCall } from "../../models/AiCall";
import { getAiBudgets, type AiBudgets } from "../../models/PlatformSetting";
import { PERIODS, PLANS, TRIAL_DAYS, TRIAL_PLAN, type ProFeature } from "./plans";

const DAY_MS = 86_400_000;
/** subscription.aiTokenLimit at or above this = no AI limit (the team's testing switch). */
export const UNLIMITED_AI = 1_000_000_000;

export type PlanErrorCode = "PLAN_EXPIRED" | "PRO_REQUIRED" | "AI_LIMIT";

/** Answered with HTTP 402 and a code the app turns into "choose / upgrade plan". */
export class PlanError extends Error {
  constructor(
    public code: PlanErrorCode,
    message: string,
    public details?: Record<string, unknown>
  ) {
    super(message);
  }
}

/** For controllers' catch blocks: answers plan errors, returns false for anything else. */
export function sendPlanError(res: Response, err: unknown): boolean {
  if (!(err instanceof PlanError)) return false;
  res.status(402).json({ error: err.message, code: err.code, details: err.details });
  return true;
}

export interface PlanState {
  /** Plan they paid for (null while on the trial or never paid). */
  plan: PlanKey | null;
  period: BillingPeriod | null;
  status: "trial" | "active" | "expired";
  /** Pro-only parts of the app are open (Pro plan, or the trial). */
  isPro: boolean;
  /** When the trial or paid time ends. */
  endsAt: Date | null;
  daysLeft: number;
  /** Which Munshi AI budget applies (null: plan ended, no AI). */
  aiBudgetKey: "basic" | "pro" | "trial" | null;
  /** Set by the VoiceMunshi team (testing): no AI limit. */
  aiUnlimited: boolean;
}

export function planState(sub: Subscription | null, now = new Date()): PlanState {
  const daysUntil = (d: Date) => Math.max(0, Math.ceil((d.getTime() - now.getTime()) / DAY_MS));
  if (sub?.plan && sub.currentPeriodEnd && sub.currentPeriodEnd > now) {
    return {
      plan: sub.plan,
      period: sub.period,
      status: "active",
      isPro: PLANS[sub.plan].proFeatures,
      endsAt: sub.currentPeriodEnd,
      daysLeft: daysUntil(sub.currentPeriodEnd),
      aiBudgetKey: sub.plan,
      aiUnlimited: (sub.aiTokenLimit ?? 0) >= UNLIMITED_AI,
    };
  }
  if (!sub?.plan && sub?.trialEndsAt && sub.trialEndsAt > now) {
    return {
      plan: null,
      period: null,
      status: "trial",
      isPro: PLANS[TRIAL_PLAN].proFeatures,
      endsAt: sub.trialEndsAt,
      daysLeft: daysUntil(sub.trialEndsAt),
      aiBudgetKey: "trial",
      aiUnlimited: (sub.aiTokenLimit ?? 0) >= UNLIMITED_AI,
    };
  }
  return {
    plan: sub?.plan ?? null,
    period: sub?.period ?? null,
    status: "expired",
    isPro: false,
    endsAt: sub?.currentPeriodEnd ?? sub?.trialEndsAt ?? null,
    daysLeft: 0,
    aiBudgetKey: null,
    aiUnlimited: (sub?.aiTokenLimit ?? 0) >= UNLIMITED_AI,
  };
}

/**
 * The business's subscription, starting the free trial the first time it's
 * needed (new sign-ups, and businesses that existed before plans did).
 */
export async function loadSubscription(tenantId: string): Promise<Subscription> {
  const tenant = await Tenant.findById(tenantId, { subscription: 1 }).lean();
  if (!tenant) throw new Error("Tenant not found");
  if (tenant.subscription) return tenant.subscription;
  const fresh: Subscription = { plan: null, period: null, trialEndsAt: new Date(Date.now() + TRIAL_DAYS * DAY_MS), currentPeriodEnd: null };
  // Only fills it if still empty, so two first requests can't start two trials.
  await Tenant.updateOne({ _id: tenantId, subscription: null }, { $set: { subscription: fresh } });
  const after = await Tenant.findById(tenantId, { subscription: 1 }).lean();
  return after?.subscription ?? fresh;
}

// Write requests check the plan on every call; a short cache keeps that cheap.
const cache = new Map<string, { state: PlanState; at: number }>();
const CACHE_MS = Number(process.env.PLAN_CACHE_MS ?? 30_000);

export async function getPlanState(tenantId: string): Promise<PlanState> {
  const hit = cache.get(tenantId);
  if (hit && Date.now() - hit.at < CACHE_MS && (!hit.state.endsAt || hit.state.endsAt.getTime() > Date.now())) return hit.state;
  const state = planState(await loadSubscription(tenantId));
  cache.set(tenantId, { state, at: Date.now() });
  return state;
}

export function clearPlanCache(tenantId: string) {
  cache.delete(tenantId);
}

export async function assertPro(tenantId: string, feature: ProFeature): Promise<void> {
  const state = await getPlanState(tenantId);
  if (state.isPro) return;
  if (state.status === "expired") throw new PlanError("PLAN_EXPIRED", "Your plan has ended. Choose a plan to continue.");
  throw new PlanError("PRO_REQUIRED", "This feature is part of the Pro plan.", { feature });
}

function addMonths(from: Date, months: number): Date {
  const d = new Date(from);
  d.setMonth(d.getMonth() + months);
  return d;
}

/**
 * Adds a purchase to the business's plan and returns the time it covers.
 * - Same plan, still running: added after the current end (renewal).
 * - Different plan, still running: the unused time is converted at the two
 *   plans' monthly prices (e.g. 30 days of Basic ≈ 10 days of Pro) and the new
 *   time is added after it, so nothing already paid is lost.
 * - Trial or ended: starts now.
 */
export async function applyPurchase(
  tenantId: string,
  input: { plan: PlanKey; period?: BillingPeriod | null; days?: number | null }
): Promise<{ start: Date; end: Date }> {
  const sub = await loadSubscription(tenantId);
  const state = planState(sub);
  const now = new Date();
  let start = now;
  if (state.status === "active" && sub.plan && sub.currentPeriodEnd) {
    if (sub.plan === input.plan) {
      start = sub.currentPeriodEnd;
    } else {
      const unusedMs = sub.currentPeriodEnd.getTime() - now.getTime();
      const converted = (unusedMs * PLANS[sub.plan].monthlyPrice) / PLANS[input.plan].monthlyPrice;
      start = new Date(now.getTime() + converted);
    }
  }
  const end = input.period ? addMonths(start, PERIODS[input.period].months) : new Date(start.getTime() + (input.days ?? 0) * DAY_MS);
  const next: Subscription = {
    plan: input.plan,
    period: input.period ?? (sub.plan === input.plan ? sub.period : null),
    trialEndsAt: sub.trialEndsAt,
    currentPeriodEnd: end,
    aiTokenLimit: sub.aiTokenLimit ?? null,
  };
  await Tenant.updateOne({ _id: tenantId }, { $set: { subscription: next } });
  clearPlanCache(tenantId);
  return { start, end };
}

// ---------- Munshi AI tokens ----------

/** Calendar month in India time, e.g. "2026-11". */
export function usageMonth(now = new Date()): string {
  return new Date(now.getTime() + 330 * 60_000).toISOString().slice(0, 7);
}

export async function aiUsage(tenantId: string): Promise<{ month: string; used: number; calls: number }> {
  const month = usageMonth();
  const row = await AiUsage.findOne({ tenantId, month }).lean();
  return { month, used: row?.tokens ?? 0, calls: row?.calls ?? 0 };
}

// ---------- Munshi AI allowance (rupees, per day) ----------
//
// Each plan has a monthly AI budget in rupees (Admin → Settings; ₹999 plan ₹200,
// ₹2,999 plan ₹990, free trial ₹84.15 ≈ 2,00,000 tokens a day at ₹93.5/$). Like Claude's limits it is handed out per
// day: budget ÷ 30, fresh every midnight (India time), unused doesn't carry
// over. Everything AI counts: Munshi chat, speech-to-text, the voice, setup.
// Businesses see only percentages, never rupees.

const IST_MS = 330 * 60_000;
const istDay = (d = new Date()) => new Date(d.getTime() + IST_MS).toISOString().slice(0, 10);

/** Next midnight in India. */
export function aiResetsAt(now = new Date()): Date {
  const ist = new Date(now.getTime() + IST_MS);
  return new Date(Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate() + 1) - IST_MS);
}

export interface AiAllowance {
  unlimited: boolean;
  /** Plan ended: no AI. */
  ended: boolean;
  monthlyInr: number;
  dailyInr: number;
  todayInr: number;
  monthInr: number;
  todayPct: number;
  monthPct: number;
  exhausted: boolean;
  resetsAt: Date;
}

export function dailyAllowanceInr(state: PlanState, budgets: AiBudgets): number {
  return state.aiBudgetKey ? budgets[state.aiBudgetKey] / 30 : 0;
}

export async function aiAllowance(tenantId: string): Promise<AiAllowance> {
  const [state, budgets] = await Promise.all([getPlanState(tenantId), getAiBudgets()]);
  const tid = new Types.ObjectId(tenantId);
  const [today, month] = await Promise.all([
    AiCall.aggregate([{ $match: { tenantId: tid, day: istDay() } }, { $group: { _id: null, inr: { $sum: "$costInr" } } }]),
    AiCall.aggregate([{ $match: { tenantId: tid, month: usageMonth() } }, { $group: { _id: null, inr: { $sum: "$costInr" } } }]),
  ]);
  const monthlyInr = state.aiBudgetKey ? budgets[state.aiBudgetKey] : 0;
  const dailyInr = monthlyInr / 30;
  const todayInr = today[0]?.inr ?? 0;
  const monthInr = month[0]?.inr ?? 0;
  const pct = (used: number, of: number) => (of > 0 ? Math.min(100, Math.round((used / of) * 100)) : 100);
  return {
    unlimited: state.aiUnlimited,
    ended: state.status === "expired",
    monthlyInr,
    dailyInr,
    todayInr,
    monthInr,
    todayPct: state.aiUnlimited ? 0 : pct(todayInr, dailyInr),
    monthPct: state.aiUnlimited ? 0 : pct(monthInr, monthlyInr),
    exhausted: !state.aiUnlimited && (state.status === "expired" || todayInr >= dailyInr),
    resetsAt: aiResetsAt(),
  };
}

/** Before an AI call: the plan must be running and today's AI allowance not used up. */
export async function assertAiTokens(tenantId: string): Promise<void> {
  const allowance = await aiAllowance(tenantId);
  if (allowance.ended && !allowance.unlimited) throw new PlanError("PLAN_EXPIRED", "Your plan has ended. Choose a plan to continue.");
  if (allowance.exhausted) {
    throw new PlanError("AI_LIMIT", "Today's Munshi AI is used up. It refills at midnight.", { resetsAt: allowance.resetsAt.toISOString(), todayPct: 100 });
  }
}

/** After an AI call: add the tokens the model reports (prompt + answer). */
export async function recordAiTokens(
  tenantId: string,
  usage: (Parameters<typeof logAiCall>[0]["usage"] & { total_tokens?: number }) | null | undefined,
  /** What the call was for and which model answered: written to the founder's cost report. */
  meta?: { kind: AiKind; model: string }
): Promise<void> {
  if (meta) void logAiCall({ kind: meta.kind, model: meta.model, usage, tenantId });
  const tokens = Math.max(0, Math.round(usage?.total_tokens ?? 0));
  await AiUsage.updateOne(
    { tenantId: new Types.ObjectId(tenantId), month: usageMonth() },
    { $inc: { tokens, calls: 1 } },
    { upsert: true }
  );
}

/** Today's AI spend for a business, grouped the way people think of it. */
export async function aiTodayByUse(tenantId: string): Promise<{ questions: number; speaking: number; voice: number; other: number }> {
  const rows = await AiCall.aggregate([
    { $match: { tenantId: new Types.ObjectId(tenantId), day: new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10) } },
    { $group: { _id: "$kind", inr: { $sum: "$costInr" } } },
  ]);
  const out = { questions: 0, speaking: 0, voice: 0, other: 0 };
  for (const r of rows) {
    if (r._id === "chat" || r._id === "ask") out.questions += r.inr;
    else if (r._id === "stt" || r._id === "stt_live" || r._id === "stt_cleanup") out.speaking += r.inr;
    else if (r._id === "tts") out.voice += r.inr;
    else out.other += r.inr;
  }
  return out;
}
