import type { Response } from "express";
import { Types } from "mongoose";
import { Tenant, type BillingPeriod, type PlanKey, type Subscription } from "../../models/Tenant";
import { AiUsage } from "../../models/AiUsage";
import { PERIODS, PLANS, TRIAL_DAYS, TRIAL_PLAN, type ProFeature } from "./plans";

const DAY_MS = 86_400_000;

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
  aiTokenLimit: number;
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
      aiTokenLimit: PLANS[sub.plan].aiTokensPerMonth,
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
      aiTokenLimit: PLANS[TRIAL_PLAN].aiTokensPerMonth,
    };
  }
  return {
    plan: sub?.plan ?? null,
    period: sub?.period ?? null,
    status: "expired",
    isPro: false,
    endsAt: sub?.currentPeriodEnd ?? sub?.trialEndsAt ?? null,
    daysLeft: 0,
    aiTokenLimit: 0,
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

/** Before an AI call: the plan must be running and this month's tokens not used up. */
export async function assertAiTokens(tenantId: string): Promise<void> {
  const state = await getPlanState(tenantId);
  if (state.status === "expired") throw new PlanError("PLAN_EXPIRED", "Your plan has ended. Choose a plan to continue.");
  const { used } = await aiUsage(tenantId);
  if (used >= state.aiTokenLimit) {
    throw new PlanError("AI_LIMIT", "This month's Munshi AI tokens are used up.", { used, limit: state.aiTokenLimit });
  }
}

/** After an AI call: add the tokens the model reports (prompt + answer). */
export async function recordAiTokens(tenantId: string, usage: { total_tokens?: number } | null | undefined): Promise<void> {
  const tokens = Math.max(0, Math.round(usage?.total_tokens ?? 0));
  await AiUsage.updateOne(
    { tenantId: new Types.ObjectId(tenantId), month: usageMonth() },
    { $inc: { tokens, calls: 1 } },
    { upsert: true }
  );
}
