import { Router } from "express";
import mongoose from "mongoose";
import { z } from "zod";
import { AiCall } from "../../models/AiCall";
import { AiChatMessage } from "../../models/AiChatMessage";
import { AiUsage } from "../../models/AiUsage";
import { ACTIVE_INVOICE, Invoice } from "../../models/Invoice";
import { Purchase } from "../../models/Purchase";
import { SubscriptionPayment } from "../../models/SubscriptionPayment";
import { Tenant } from "../../models/Tenant";
import { User } from "../../models/User";
import { DEFAULT_PRICING, GROQ_PRICES_CHECKED, averageCostByKind, clearPriceCache, estimateTokensInr, getPricing, setPricing, type Pricing } from "../billing/ai-cost.service";
import { liveUsdToInr, refreshUsdToInr } from "../billing/exchange-rate.service";
import { AuditLog } from "../../models/AuditLog";
import { DEFAULT_AI_BUDGETS, getAiBudgets, setAiBudgets } from "../../models/PlatformSetting";
import { aiAllowance } from "../billing/subscription.service";
import { usageMonth } from "../billing/subscription.service";

/**
 * Founder reports (mounted under /api/admin, behind the same platform-admin
 * check): what AI costs in rupees, how the product is growing, and what each
 * business actually does in the app.
 */
export const reportsRouter = Router();

const DAY_MS = 24 * 60 * 60 * 1000;
const IST_MS = 5.5 * 60 * 60 * 1000;
const istDay = (d: Date) => new Date(d.getTime() + IST_MS).toISOString().slice(0, 10);
const round = (n: number, places = 2) => Math.round(n * 10 ** places) / 10 ** places;
/** Last n India dates, oldest first. */
const lastDays = (n: number) => Array.from({ length: n }, (_, i) => istDay(new Date(Date.now() - (n - 1 - i) * DAY_MS)));
/** Monday of the India week a date falls in. */
function weekOf(d: Date): string {
  const ist = new Date(d.getTime() + IST_MS);
  const dow = (ist.getUTCDay() + 6) % 7;
  return new Date(Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate() - dow)).toISOString().slice(0, 10);
}
const lastMonths = (n: number) => {
  const now = new Date(Date.now() + IST_MS);
  return Array.from({ length: n }, (_, i) => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - (n - 1 - i), 1)).toISOString().slice(0, 7));
};

/**
 * Rupees per business for a month: logged calls, plus an estimate for chat
 * tokens counted before per-call logging existed (AiUsage) and not yet logged.
 */
async function monthCosts(month: string, pricing: Pricing) {
  const [logged, usage] = await Promise.all([
    AiCall.aggregate([
      { $match: { month } },
      {
        $group: {
          _id: "$tenantId",
          inr: { $sum: "$costInr" },
          calls: { $sum: 1 },
          chatTokens: { $sum: { $cond: [{ $in: ["$kind", ["chat", "ask", "order_reading", "dashboard"]] }, { $add: ["$inputTokens", "$cachedTokens", "$outputTokens"] }, 0] } },
        },
      },
    ]),
    AiUsage.find({ month }).lean(),
  ]);
  const byTenant = new Map<string, { inr: number; calls: number; estimatedInr: number }>();
  for (const row of logged) byTenant.set(String(row._id), { inr: row.inr, calls: row.calls, estimatedInr: 0 });
  for (const u of usage) {
    const key = String(u.tenantId);
    const loggedChat = logged.find((r) => String(r._id) === key)?.chatTokens ?? 0;
    const missing = Math.max(0, (u.tokens ?? 0) - loggedChat);
    if (missing > 0) {
      const row = byTenant.get(key) ?? { inr: 0, calls: 0, estimatedInr: 0 };
      row.estimatedInr += estimateTokensInr(missing, pricing);
      byTenant.set(key, row);
    }
  }
  return byTenant;
}

// ---------- AI cost ----------

reportsRouter.get("/costs", async (req, res) => {
  const days = Math.min(90, Math.max(7, Number(req.query.days) || 30));
  const pricing = await getPricing();
  const from = lastDays(days)[0];
  const month = usageMonth();

  const [byDay, byKind, byModel, byTenantRange, monthMap, prevMonthMap] = await Promise.all([
    AiCall.aggregate([{ $match: { day: { $gte: from } } }, { $group: { _id: "$day", inr: { $sum: "$costInr" }, calls: { $sum: 1 } } }]),
    AiCall.aggregate([
      { $match: { day: { $gte: from } } },
      { $group: { _id: "$kind", inr: { $sum: "$costInr" }, calls: { $sum: 1 }, tokens: { $sum: { $add: ["$inputTokens", "$cachedTokens", "$outputTokens"] } }, seconds: { $sum: "$audioSeconds" } } },
    ]),
    AiCall.aggregate([
      { $match: { day: { $gte: from } } },
      { $group: { _id: { provider: "$provider", model: "$model" }, inr: { $sum: "$costInr" }, calls: { $sum: 1 }, input: { $sum: "$inputTokens" }, cached: { $sum: "$cachedTokens" }, output: { $sum: "$outputTokens" }, seconds: { $sum: "$audioSeconds" } } },
    ]),
    AiCall.aggregate([{ $match: { day: { $gte: from } } }, { $group: { _id: "$tenantId", inr: { $sum: "$costInr" }, calls: { $sum: 1 } } }, { $sort: { inr: -1 } }, { $limit: 15 }]),
    monthCosts(month, pricing),
    monthCosts(lastMonths(2)[0], pricing),
  ]);

  const tenants = await Tenant.find({ _id: { $in: byTenantRange.map((r) => r._id).filter(Boolean) } }, { businessName: 1 }).lean();
  const sum = (m: Map<string, { inr: number; estimatedInr: number }>) => [...m.values()].reduce((s, r) => s + r.inr + r.estimatedInr, 0);
  const businessCount = await Tenant.countDocuments({});
  const thisMonthInr = sum(monthMap);

  res.json({
    days,
    pricing,
    totals: {
      rangeInr: round(byDay.reduce((s, d) => s + d.inr, 0)),
      rangeCalls: byDay.reduce((s, d) => s + d.calls, 0),
      thisMonthInr: round(thisMonthInr),
      thisMonthEstimatedInr: round([...monthMap.values()].reduce((s, r) => s + r.estimatedInr, 0)),
      lastMonthInr: round(sum(prevMonthMap)),
      perBusinessInr: round(businessCount ? thisMonthInr / businessCount : 0),
      preLoginInr: round(byTenantRange.find((r) => r._id === null)?.inr ?? 0, 4),
    },
    byDay: lastDays(days).map((day) => {
      const row = byDay.find((d) => d._id === day);
      return { day, inr: round(row?.inr ?? 0, 4), calls: row?.calls ?? 0 };
    }),
    byKind: byKind
      .map((k) => ({ kind: k._id, inr: round(k.inr, 4), calls: k.calls, tokens: k.tokens, audioMinutes: round(k.seconds / 60, 1) }))
      .sort((a, b) => b.inr - a.inr),
    byModel: byModel
      .map((m) => ({ provider: m._id.provider, model: m._id.model, inr: round(m.inr, 4), calls: m.calls, inputTokens: m.input, cachedTokens: m.cached, outputTokens: m.output, audioMinutes: round(m.seconds / 60, 1) }))
      .sort((a, b) => b.inr - a.inr),
    topBusinesses: byTenantRange
      .filter((r) => r._id)
      .map((r) => ({ tenantId: String(r._id), businessName: tenants.find((t) => String(t._id) === String(r._id))?.businessName ?? "Deleted business", inr: round(r.inr, 4), calls: r.calls })),
  });
});

// ---------- Growth ----------

reportsRouter.get("/growth", async (_req, res) => {
  const weeks = 12;
  const now = Date.now();
  const firstWeek = weekOf(new Date(now - (weeks - 1) * 7 * DAY_MS));
  const since = new Date(new Date(`${firstWeek}T00:00:00Z`).getTime() - IST_MS);
  const weekKeys = Array.from({ length: weeks }, (_, i) => weekOf(new Date(now - (weeks - 1 - i) * 7 * DAY_MS)));

  const [tenants, bills, purchases, aiCalls, payments, chatTenants, multiUser, gstTenants, voiceTenants] = await Promise.all([
    Tenant.find({}, { createdAt: 1, subscription: 1, status: 1, "onboarding.completed": 1 }).lean(),
    Invoice.find({ ...ACTIVE_INVOICE, createdAt: { $gte: since } }, { tenantId: 1, createdAt: 1, totalAmount: 1 }).lean(),
    Purchase.find({ createdAt: { $gte: since } }, { tenantId: 1, createdAt: 1 }).lean(),
    AiCall.find({ at: { $gte: since }, tenantId: { $ne: null } }, { tenantId: 1, at: 1 }).lean(),
    SubscriptionPayment.find({ status: "paid" }, { amount: 1, paidAt: 1, createdAt: 1, tenantId: 1 }).lean(),
    AiChatMessage.distinct("tenantId", { role: "user" }),
    User.aggregate([{ $group: { _id: "$tenantId", n: { $sum: 1 } } }, { $match: { n: { $gt: 1 } } }]),
    Invoice.distinct("tenantId", { billType: "gst", ...ACTIVE_INVOICE }),
    AiCall.distinct("tenantId", { kind: "stt" }),
  ]);
  const [billTenants, purchaseTenants] = await Promise.all([Invoice.distinct("tenantId", ACTIVE_INVOICE), Purchase.distinct("tenantId")]);

  const weekly = weekKeys.map((week) => ({ week, signups: 0, active: new Set<string>(), bills: 0, gmv: 0 }));
  const at = (d: Date) => weekly.find((w) => w.week === weekOf(d));
  for (const t of tenants) {
    const w = at(t.createdAt);
    if (w) w.signups++;
  }
  for (const b of bills) {
    const w = at(b.createdAt);
    if (!w) continue;
    w.bills++;
    w.gmv += b.totalAmount;
    w.active.add(String(b.tenantId));
  }
  for (const p of purchases) at(p.createdAt)?.active.add(String(p.tenantId));
  for (const c of aiCalls) at(c.at)?.active.add(String(c.tenantId));

  const months = lastMonths(6);
  const revenue = months.map((month) => ({
    month,
    inr: Math.round(payments.filter((p) => istDay(p.paidAt ?? p.createdAt).slice(0, 7) === month).reduce((s, p) => s + p.amount, 0)),
    payments: payments.filter((p) => istDay(p.paidAt ?? p.createdAt).slice(0, 7) === month).length,
  }));

  const total = tenants.length;
  const paidEver = new Set(payments.map((p) => String(p.tenantId)));
  const trialOver = tenants.filter((t) => t.subscription?.trialEndsAt && t.subscription.trialEndsAt.getTime() < now).length;
  const pct = (n: number) => (total ? Math.round((n / total) * 100) : 0);

  res.json({
    weekly: weekly.map((w) => ({ week: w.week, signups: w.signups, activeBusinesses: w.active.size, bills: w.bills, gmv: Math.round(w.gmv) })),
    revenue,
    totals: {
      businesses: total,
      paidEver: paidEver.size,
      trialOver,
      conversionPct: trialOver ? Math.round((tenants.filter((t) => paidEver.has(String(t._id)) && t.subscription?.trialEndsAt && t.subscription.trialEndsAt.getTime() < now).length / trialOver) * 100) : 0,
      revenueAllTime: Math.round(payments.reduce((s, p) => s + p.amount, 0)),
    },
    adoption: [
      { key: "setup", count: tenants.filter((t) => t.onboarding?.completed).length },
      { key: "bills", count: billTenants.length },
      { key: "gstBills", count: gstTenants.length },
      { key: "purchases", count: purchaseTenants.length },
      { key: "munshiChat", count: chatTenants.length },
      { key: "voice", count: voiceTenants.filter(Boolean).length },
      { key: "team", count: multiUser.length },
    ].map((a) => ({ ...a, pct: pct(a.count) })),
  });
});

// ---------- One business: its work in the app ----------

reportsRouter.get("/businesses/:id/activity", async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(404).json({ error: "Business not found" });
  const tid = new mongoose.Types.ObjectId(req.params.id);
  const days = lastDays(30);
  const since = new Date(new Date(`${days[0]}T00:00:00Z`).getTime() - IST_MS);
  const pricing = await getPricing();

  const [bills, purchases, recentBills, recentPurchases, topItems, aiByKind, aiByMonth, usage] = await Promise.all([
    Invoice.find({ tenantId: tid, ...ACTIVE_INVOICE, createdAt: { $gte: since } }, { createdAt: 1, totalAmount: 1 }).lean(),
    Purchase.find({ tenantId: tid, createdAt: { $gte: since } }, { createdAt: 1, totalAmount: 1 }).lean(),
    Invoice.find({ tenantId: tid }, { invoiceNumber: 1, totalAmount: 1, amountPaid: 1, paymentStatus: 1, status: 1, billType: 1, createdAt: 1, "buyer.name": 1 }).sort({ createdAt: -1 }).limit(10).lean(),
    Purchase.find({ tenantId: tid }, { purchaseNumber: 1, totalAmount: 1, purchasedAt: 1, supplierId: 1 }).sort({ purchasedAt: -1 }).limit(8).populate("supplierId", "name").lean(),
    Invoice.aggregate([
      { $match: { tenantId: tid, ...ACTIVE_INVOICE, createdAt: { $gte: since } } },
      { $unwind: "$items" },
      { $group: { _id: "$items.productName", qty: { $sum: "$items.quantity" }, unit: { $first: "$items.unit" }, amount: { $sum: "$items.lineSubtotal" } } },
      { $sort: { amount: -1 } },
      { $limit: 8 },
    ]),
    AiCall.aggregate([{ $match: { tenantId: tid, month: usageMonth() } }, { $group: { _id: "$kind", inr: { $sum: "$costInr" }, calls: { $sum: 1 } } }, { $sort: { inr: -1 } }]),
    AiCall.aggregate([{ $match: { tenantId: tid } }, { $group: { _id: "$month", inr: { $sum: "$costInr" } } }]),
    AiUsage.find({ tenantId: tid }).lean(),
  ]);

  const daily = days.map((day) => ({ day, bills: 0, sales: 0, purchases: 0 }));
  for (const b of bills) {
    const row = daily.find((d) => d.day === istDay(b.createdAt));
    if (row) {
      row.bills++;
      row.sales += b.totalAmount;
    }
  }
  for (const p of purchases) {
    const row = daily.find((d) => d.day === istDay(p.createdAt));
    if (row) row.purchases += p.totalAmount;
  }
  const monthMap = await monthCosts(usageMonth(), pricing);
  const thisMonth = monthMap.get(String(tid));

  // AI allowance: last 30 days against the daily allowance, by login, the latest calls, and the activity log.
  const [allowance, aiDaily, aiByUser, recentCalls, audit] = await Promise.all([
    aiAllowance(String(tid)),
    AiCall.aggregate([{ $match: { tenantId: tid, day: { $gte: days[0] } } }, { $group: { _id: "$day", inr: { $sum: "$costInr" }, calls: { $sum: 1 } } }]),
    AiCall.aggregate([{ $match: { tenantId: tid, month: usageMonth() } }, { $group: { _id: "$userId", inr: { $sum: "$costInr" }, calls: { $sum: 1 } } }, { $sort: { inr: -1 } }]),
    AiCall.find({ tenantId: tid }, { at: 1, kind: 1, model: 1, provider: 1, costInr: 1, userId: 1, audioSeconds: 1, characters: 1, inputTokens: 1, outputTokens: 1 }).sort({ at: -1 }).limit(40).lean(),
    AuditLog.find({ tenantId: tid }, { userName: 1, action: 1, summary: 1, amount: 1, createdAt: 1 }).sort({ createdAt: -1 }).limit(50).lean(),
  ]);
  const userIds = [...new Set([...aiByUser.map((u) => String(u._id)), ...recentCalls.map((c) => String(c.userId))].filter((id) => id && id !== "null"))];
  const names = new Map((await User.find({ _id: { $in: userIds } }, { name: 1, role: 1 }).lean()).map((u) => [String(u._id), `${u.name}`]));

  res.json({
    daily: daily.map((d) => ({ ...d, sales: Math.round(d.sales), purchases: Math.round(d.purchases) })),
    totals30: {
      bills: bills.length,
      sales: Math.round(bills.reduce((s, b) => s + b.totalAmount, 0)),
      purchases: Math.round(purchases.reduce((s, p) => s + p.totalAmount, 0)),
      activeDays: daily.filter((d) => d.bills > 0 || d.purchases > 0).length,
    },
    topItems: topItems.map((i) => ({ name: i._id, qty: round(i.qty), unit: i.unit, amount: Math.round(i.amount) })),
    recentBills: recentBills.map((b) => ({
      invoiceNumber: b.invoiceNumber,
      customer: b.buyer?.name ?? null,
      total: b.totalAmount,
      paid: b.amountPaid,
      paymentStatus: b.paymentStatus,
      cancelled: b.status === "cancelled",
      billType: b.billType,
      createdAt: b.createdAt,
    })),
    recentPurchases: recentPurchases.map((p) => ({
      purchaseNumber: p.purchaseNumber,
      supplier: (p.supplierId as unknown as { name?: string } | null)?.name ?? null,
      total: p.totalAmount,
      purchasedAt: p.purchasedAt,
    })),
    ai: {
      thisMonthInr: round((thisMonth?.inr ?? 0) + (thisMonth?.estimatedInr ?? 0)),
      estimatedInr: round(thisMonth?.estimatedInr ?? 0),
      byKind: aiByKind.map((k) => ({ kind: k._id, inr: round(k.inr, 4), calls: k.calls })),
      byMonth: lastMonths(6).map((month) => {
        const logged = aiByMonth.find((m) => m._id === month)?.inr ?? 0;
        const tokens = usage.find((u) => u.month === month)?.tokens ?? 0;
        // Months before per-call logging: estimate from the token total.
        return { month, inr: round(logged || estimateTokensInr(tokens, pricing)), estimated: !logged && tokens > 0 };
      }),
      allowance: {
        unlimited: allowance.unlimited,
        monthlyInr: round(allowance.monthlyInr),
        dailyInr: round(allowance.dailyInr),
        todayInr: round(allowance.todayInr, 3),
        todayPct: allowance.todayPct,
        monthPct: allowance.monthPct,
        exhausted: allowance.exhausted,
      },
      daily: days.map((day) => {
        const row = aiDaily.find((d) => d._id === day);
        return { day, inr: round(row?.inr ?? 0, 3), calls: row?.calls ?? 0 };
      }),
      byUser: aiByUser.map((u) => ({ userId: u._id ? String(u._id) : null, name: u._id ? (names.get(String(u._id)) ?? "Deleted login") : "No login (system)", inr: round(u.inr, 3), calls: u.calls })),
      recentCalls: recentCalls.map((c) => ({
        at: c.at,
        kind: c.kind,
        model: c.model,
        provider: c.provider,
        inr: round(c.costInr, 4),
        user: c.userId ? (names.get(String(c.userId)) ?? null) : null,
        detail: c.audioSeconds ? `${Math.round(c.audioSeconds)}s audio` : c.characters ? `${c.characters} chars` : c.inputTokens || c.outputTokens ? `${c.inputTokens + c.outputTokens} tokens` : "",
      })),
    },
    activity: audit.map((a) => ({ at: a.createdAt, user: a.userName, action: a.action, summary: a.summary, amount: a.amount ?? null })),
  });
});

// ---------- Plan AI budgets (rupees a month per plan; given out per day) ----------

reportsRouter.get("/ai-budgets", async (_req, res) => {
  const [budgets, avg] = await Promise.all([getAiBudgets(), averageCostByKind()]);
  const pricing = await getPricing();
  // What one unit of each kind costs (measured where there's data, else list-price estimates).
  const unit = {
    chatMessage: avg.chat ?? 0.07,
    sarvamSpeechMinute: pricing.sarvamPerMinuteInr,
    whisperSpeechMinute: ((pricing.whisperPerHourUsd["whisper-large-v3"] ?? 0.111) / 60) * pricing.usdToInr,
    voiceReply: ((avg.tts ?? 0) > 0 ? avg.tts : 0.3) as number,
  };
  const per = (rupeesPerDay: number) => ({
    chatMessages: Math.floor(rupeesPerDay / unit.chatMessage),
    sarvamSpeechMinutes: round(rupeesPerDay / unit.sarvamSpeechMinute, 1),
    whisperSpeechMinutes: Math.floor(rupeesPerDay / unit.whisperSpeechMinute),
    voiceReplies: Math.floor(rupeesPerDay / unit.voiceReply),
  });
  res.json({
    budgets,
    defaults: DEFAULT_AI_BUDGETS,
    unitCostInr: Object.fromEntries(Object.entries(unit).map(([k, v]) => [k, round(v, 4)])),
    measured: Object.keys(avg),
    perDay: Object.fromEntries((Object.keys(budgets) as (keyof typeof budgets)[]).map((k) => [k, { rupees: round(budgets[k] / 30), ...per(budgets[k] / 30) }])),
  });
});

reportsRouter.put("/ai-budgets", async (req, res) => {
  const parsed = z.object({ basic: z.number().min(0).max(100000), pro: z.number().min(0).max(100000), trial: z.number().min(0).max(100000) }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  res.json({ budgets: await setAiBudgets(parsed.data) });
});

/** ₹ this month for every business (for the businesses list). */
reportsRouter.get("/costs/by-business", async (_req, res) => {
  const map = await monthCosts(usageMonth(), await getPricing());
  res.json(Object.fromEntries([...map.entries()].map(([id, r]) => [id, round(r.inr + r.estimatedInr)])));
});

// ---------- Price list ----------

const pricingSchema = z.object({
  usdToInr: z.number().positive().max(1000),
  usdToInrAuto: z.boolean().default(true),
  tokens: z.record(z.string(), z.object({ input: z.number().min(0), cachedInput: z.number().min(0), output: z.number().min(0) })),
  whisperPerHourUsd: z.record(z.string(), z.number().min(0)),
  whisperMinSeconds: z.number().min(0).max(120),
  sarvamPerMinuteInr: z.number().min(0).max(100),
  sarvamTtsPer1kInr: z.record(z.string(), z.number().min(0)).default({}),
});

const pricingView = async () => ({
  pricing: await getPricing(),
  defaults: DEFAULT_PRICING,
  fx: await liveUsdToInr().catch(() => null),
  groqPricesChecked: GROQ_PRICES_CHECKED,
  sources: { groq: "https://console.groq.com/docs/models" },
});

reportsRouter.get("/pricing", async (_req, res) => {
  res.json(await pricingView());
});

/** Fetch today's USD → INR rate now. */
reportsRouter.post("/pricing/refresh-rate", async (_req, res) => {
  await refreshUsdToInr();
  clearPriceCache();
  res.json(await pricingView());
});

reportsRouter.put("/pricing", async (req, res) => {
  const parsed = pricingSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  await setPricing(parsed.data);
  res.json(await pricingView());
});
