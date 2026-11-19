import { Router, type Request } from "express";
import { z } from "zod";
import { env } from "../../config/env";
import { requireAuth, requireRole, requireTenant } from "../../middleware/auth";
import { isPlaceholderEmail } from "../auth/auth.service";
import { Tenant } from "../../models/Tenant";
import { User } from "../../models/User";
import { AiUsage } from "../../models/AiUsage";
import { SubscriptionPayment } from "../../models/SubscriptionPayment";
import { getAiBudgets, getSttEngine, getTtsSettings, setSttEngine, setTtsSettings } from "../../models/PlatformSetting";
import { chatMessageCostInr, rupeesPerToken, tokenYardsticks } from "./ai-cost.service";
import { SARVAM_VOICES, type SarvamVoiceKey, sarvamTtsAvailable } from "../tts/sarvam-tts.service";
import { synthesize } from "../tts/tts.service";
import { sarvamAvailable } from "../munshi/sarvam.service";
import { priceFor, priceList } from "./plans";
import { aiAllowance, aiTodayByUse, aiUsage, applyPurchase, getPlanState, planState, usageMonth } from "./subscription.service";
import { createRazorpayOrder, razorpayConfigured, verifyPaymentSignature, verifyWebhookSignature } from "./razorpay";

export const billingRouter = Router();

const planSchema = z.enum(["basic", "pro"]);
const periodSchema = z.enum(["monthly", "quarterly", "annual"]);

// Public: the landing page shows the same prices the app charges.
/** Roughly how many Munshi AI questions each plan's daily allowance covers (rounded down to 5s). */
async function aiQuestionsPerDay() {
  const [budgets, perMessage, rate] = await Promise.all([getAiBudgets(), chatMessageCostInr(), rupeesPerToken()]);
  const perDay = (rupeesPerMonth: number) => Math.max(1, Math.floor(rupeesPerMonth / 30 / perMessage / 5) * 5);
  // Daily tokens, rounded to a clean thousand.
  const tokensPerDay = (rupeesPerMonth: number) => Math.round(rupeesPerMonth / 30 / rate / 1000) * 1000;
  return { questions: { basic: perDay(budgets.basic), pro: perDay(budgets.pro) }, tokens: { basic: tokensPerDay(budgets.basic), pro: tokensPerDay(budgets.pro) } };
}

billingRouter.get("/plans", async (_req, res) => {
  const ai = await aiQuestionsPerDay();
  res.json(priceList(ai.questions, ai.tokens));
});

/** The business's plan, this month's AI tokens, and past purchases. */
billingRouter.get("/", requireAuth, requireTenant, async (req, res) => {
  const tenantId = req.auth!.tenantId!;
  const [state, allowance, payments, byUse, rate, stt] = await Promise.all([
    getPlanState(tenantId),
    aiAllowance(tenantId),
    SubscriptionPayment.find({ tenantId, status: "paid" }).sort({ paidAt: -1 }).limit(24).lean(),
    aiTodayByUse(tenantId),
    rupeesPerToken(),
    getSttEngine(),
  ]);
  const yard = await tokenYardsticks(stt);
  const tok = (inr: number) => Math.round(inr / rate);
  const remaining = Math.max(0, tok(allowance.dailyInr) - tok(allowance.todayInr));
  res.json({
    state,
    // Percentages only: businesses never see what AI costs us.
    usage: {
      todayPct: allowance.todayPct,
      monthPct: allowance.monthPct,
      unlimited: allowance.unlimited,
      exhausted: allowance.exhausted,
      resetsAt: allowance.resetsAt,
      // Tokens on one scale for everything AI (see ai-cost.service rupeesPerToken).
      todayTokens: tok(allowance.todayInr),
      dailyTokens: tok(allowance.dailyInr),
      remainingTokens: remaining,
      monthTokens: tok(allowance.monthInr),
      monthlyTokens: tok(allowance.monthlyInr),
      todayByUse: { questions: tok(byUse.questions), speaking: tok(byUse.speaking), voice: tok(byUse.voice), other: tok(byUse.other) },
      tokensPerQuestion: yard.perQuestion,
      tokensPerSpeechMinute: yard.perSpeechMinute,
      remainingQuestions: yard.perQuestion > 0 ? Math.floor(remaining / yard.perQuestion) : 0,
      remainingSpeechMinutes: yard.perSpeechMinute > 0 ? Math.floor((remaining / yard.perSpeechMinute) * 10) / 10 : 0,
    },
    payments: payments.map((p) => ({
      id: String(p._id),
      plan: p.plan,
      period: p.period,
      days: p.days,
      amount: p.amount,
      method: p.method,
      note: p.method === "manual" ? p.note : null,
      paidAt: p.paidAt,
      periodStart: p.periodStart,
      periodEnd: p.periodEnd,
    })),
    onlinePayments: razorpayConfigured(),
    ...(await aiQuestionsPerDay().then((ai) => priceList(ai.questions, ai.tokens))),
  });
});

const checkoutSchema = z.object({ plan: planSchema, period: periodSchema });

/** Starts a Razorpay payment for a plan. Only the owner pays. */
billingRouter.post("/checkout", requireAuth, requireTenant, requireRole("OWNER", "SUPER_ADMIN"), async (req, res) => {
  const parsed = checkoutSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  if (!razorpayConfigured()) {
    return res.status(503).json({ error: "Online payment is not switched on yet.", code: "PAYMENTS_OFF" });
  }
  const tenantId = req.auth!.tenantId!;
  const { plan, period } = parsed.data;
  const amount = priceFor(plan, period);
  const [tenant, user] = await Promise.all([Tenant.findById(tenantId).lean(), User.findById(req.auth!.userId).lean()]);
  try {
    const order = await createRazorpayOrder(amount, `ss_${tenantId.slice(-8)}_${Date.now()}`, { tenantId, plan, period });
    await SubscriptionPayment.create({
      tenantId,
      plan,
      period,
      amount,
      method: "razorpay",
      status: "created",
      razorpayOrderId: order.id,
      createdBy: req.auth!.userId,
    });
    res.json({
      keyId: env.razorpay.keyId,
      orderId: order.id,
      amount: order.amount,
      currency: order.currency,
      businessName: tenant?.businessName ?? "VoiceMunshi",
      prefill: { name: user?.name ?? "", email: user?.email && !isPlaceholderEmail(user.email) ? user.email : "", contact: user?.phone ?? tenant?.phone ?? "" },
    });
  } catch (err) {
    console.error("[billing] checkout:", (err as Error).message);
    res.status(502).json({ error: "Could not start the payment. Please try again." });
  }
});

/**
 * Marks a Razorpay order paid and adds the plan time — exactly once, whether
 * the app (verify) or Razorpay (webhook) reports it first.
 */
async function settleOrder(orderId: string, paymentId: string) {
  const payment = await SubscriptionPayment.findOneAndUpdate(
    { razorpayOrderId: orderId, status: "created" },
    { $set: { status: "paid", razorpayPaymentId: paymentId, paidAt: new Date() } },
    { new: true }
  );
  if (!payment) return false; // already settled (or unknown order)
  const { start, end } = await applyPurchase(String(payment.tenantId), { plan: payment.plan, period: payment.period });
  payment.periodStart = start;
  payment.periodEnd = end;
  await payment.save();
  return true;
}

const verifySchema = z.object({
  orderId: z.string().min(1),
  paymentId: z.string().min(1),
  signature: z.string().min(1),
});

billingRouter.post("/verify", requireAuth, requireTenant, async (req, res) => {
  const parsed = verifySchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const { orderId, paymentId, signature } = parsed.data;
  const tenantId = req.auth!.tenantId!;
  const payment = await SubscriptionPayment.findOne({ razorpayOrderId: orderId, tenantId }).lean();
  if (!payment) return res.status(404).json({ error: "Payment not found" });
  if (!verifyPaymentSignature(orderId, paymentId, signature)) {
    return res.status(400).json({ error: "Payment could not be verified.", code: "PAYMENT_UNVERIFIED" });
  }
  await settleOrder(orderId, paymentId);
  res.json({ state: await getPlanState(tenantId) });
});

/** Razorpay → server. Set this URL and secret in Razorpay Dashboard → Webhooks. */
billingRouter.post("/webhook", async (req: Request & { rawBody?: Buffer }, res) => {
  const signature = String(req.headers["x-razorpay-signature"] ?? "");
  if (!req.rawBody || !signature || !verifyWebhookSignature(req.rawBody, signature)) {
    return res.status(400).json({ error: "Invalid signature" });
  }
  const event = String(req.body?.event ?? "");
  const entity = req.body?.payload?.payment?.entity as { id?: string; order_id?: string } | undefined;
  if ((event === "payment.captured" || event === "order.paid") && entity?.id && entity.order_id) {
    try {
      await settleOrder(entity.order_id, entity.id);
    } catch (err) {
      console.error("[billing] webhook settle:", (err as Error).message);
      return res.status(500).json({ error: "Could not apply payment" });
    }
  }
  res.json({ ok: true });
});

// ---------- VoiceMunshi team (platform admins) ----------

/** The VoiceMunshi team: a PLATFORM_ADMIN login (no business), still active. */
export async function isPlatformAdmin(userId: string): Promise<boolean> {
  const user = await User.findById(userId, { role: 1, isActive: 1 }).lean();
  return user?.role === "PLATFORM_ADMIN" && user.isActive;
}

const platformAdminOnly = [
  requireAuth,
  async (req: Request, res: import("express").Response, next: import("express").NextFunction) => {
    if (await isPlatformAdmin(req.auth!.userId)) return next();
    return res.status(403).json({ error: "Insufficient permissions", code: "FORBIDDEN" });
  },
];

function escapeRegex(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Every business with its plan and this month's AI use. */
billingRouter.get("/admin/tenants", ...platformAdminOnly, async (req, res) => {
  const q = String(req.query.q ?? "").trim();
  const filter = q
    ? { $or: [{ businessName: new RegExp(escapeRegex(q), "i") }, { ownerEmail: new RegExp(escapeRegex(q), "i") }, { phone: new RegExp(escapeRegex(q), "i") }] }
    : {};
  const tenants = await Tenant.find(filter, { businessName: 1, ownerEmail: 1, phone: 1, subscription: 1, createdAt: 1 })
    .sort({ createdAt: -1 })
    .limit(100)
    .lean();
  const usage = await AiUsage.find({ tenantId: { $in: tenants.map((t) => t._id) }, month: usageMonth() }).lean();
  const usedBy = new Map(usage.map((u) => [String(u.tenantId), u.tokens]));
  res.json(
    tenants.map((t) => {
      const state = planState(t.subscription ?? null);
      return {
        tenantId: String(t._id),
        businessName: t.businessName,
        ownerEmail: t.ownerEmail,
        phone: t.phone ?? null,
        createdAt: t.createdAt,
        // Businesses that haven't opened the app since plans began have no trial yet.
        state: t.subscription ? state : { ...state, status: "trial" as const, isPro: true },
        aiTokensUsed: usedBy.get(String(t._id)) ?? 0,
      };
    })
  );
});

const grantSchema = z
  .object({
    tenantId: z.string().regex(/^[a-f0-9]{24}$/i),
    plan: planSchema,
    period: periodSchema.optional(),
    days: z.number().int().min(1).max(730).optional(),
    amount: z.number().min(0).max(1_000_000).default(0),
    note: z.string().trim().max(300).optional(),
  })
  .refine((v) => Boolean(v.period) !== Boolean(v.days), { message: "Give either a period or a number of days" });

/** Give or extend a plan by hand (offline UPI/bank payment, free month, support). */
billingRouter.post("/admin/grant", ...platformAdminOnly, async (req, res) => {
  const parsed = grantSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const { tenantId, plan, period, days, amount, note } = parsed.data;
  if (!(await Tenant.exists({ _id: tenantId }))) return res.status(404).json({ error: "Business not found" });
  const { start, end } = await applyPurchase(tenantId, { plan, period: period ?? null, days: days ?? null });
  await SubscriptionPayment.create({
    tenantId,
    plan,
    period: period ?? null,
    days: days ?? null,
    amount,
    method: "manual",
    status: "paid",
    note: note ?? null,
    createdBy: req.auth!.userId,
    periodStart: start,
    periodEnd: end,
    paidAt: new Date(),
  });
  res.json({ state: await getPlanState(tenantId) });
});

// ---------- App-wide settings (super admin) ----------

/** Speech-to-text engine for every business, plus whether Sarvam is ready. */
async function settingsView() {
  const tts = await getTtsSettings();
  return {
    sttEngine: await getSttEngine(),
    sarvamConfigured: Boolean(env.sarvamApiKey),
    sarvamAvailable: sarvamAvailable(),
    ttsEngine: tts.engine,
    ttsVoice: tts.voice,
    sarvamVoiceAvailable: sarvamTtsAvailable(),
    voices: Object.entries(SARVAM_VOICES).map(([key, v]) => ({ key, label: v.label, model: v.model })),
  };
}

billingRouter.get("/admin/settings", ...platformAdminOnly, async (_req, res) => {
  res.json(await settingsView());
});

billingRouter.patch("/admin/settings", ...platformAdminOnly, async (req, res) => {
  const parsed = z
    .object({
      sttEngine: z.enum(["auto", "sarvam", "whisper"]).optional(),
      ttsEngine: z.enum(["auto", "sarvam", "edge"]).optional(),
      ttsVoice: z.enum(Object.keys(SARVAM_VOICES) as [SarvamVoiceKey, ...SarvamVoiceKey[]]).optional(),
    })
    .safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  if (parsed.data.sttEngine) await setSttEngine(parsed.data.sttEngine);
  if (parsed.data.ttsEngine || parsed.data.ttsVoice) await setTtsSettings({ engine: parsed.data.ttsEngine, voice: parsed.data.ttsVoice });
  res.json(await settingsView());
});

/** Hear a Sarvam voice before choosing it (costs a few characters of Sarvam credit). */
billingRouter.post("/admin/voice-preview", ...platformAdminOnly, async (req, res) => {
  const parsed = z
    .object({ voice: z.enum(Object.keys(SARVAM_VOICES) as [SarvamVoiceKey, ...SarvamVoiceKey[]]), text: z.string().trim().min(1).max(300).optional() })
    .safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  try {
    const audio = await synthesize(parsed.data.text ?? "Namaste ji! Aaj ki bikri achhi rahi, chaudah hazaar paanch sau rupaye. Ravi ji par teen hazaar ka udhaar baaki hai, unhe yaad dila dijiye.", "hi-Latn", { voiceOverride: parsed.data.voice });
    res.setHeader("Content-Type", audio.subarray(0, 4).toString("latin1") === "RIFF" ? "audio/wav" : "audio/mpeg");
    res.send(audio);
  } catch (err) {
    res.status(503).json({ error: (err as Error).message });
  }
});
