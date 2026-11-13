import { Router, type Request } from "express";
import { z } from "zod";
import { env } from "../../config/env";
import { requireAuth, requireRole, requireTenant } from "../../middleware/auth";
import { Tenant } from "../../models/Tenant";
import { User } from "../../models/User";
import { AiUsage } from "../../models/AiUsage";
import { SubscriptionPayment } from "../../models/SubscriptionPayment";
import { priceFor, priceList } from "./plans";
import { aiUsage, applyPurchase, getPlanState, planState, usageMonth } from "./subscription.service";
import { createRazorpayOrder, razorpayConfigured, verifyPaymentSignature, verifyWebhookSignature } from "./razorpay";

export const billingRouter = Router();

const planSchema = z.enum(["basic", "pro"]);
const periodSchema = z.enum(["monthly", "quarterly", "annual"]);

// Public: the landing page shows the same prices the app charges.
billingRouter.get("/plans", (_req, res) => {
  res.json(priceList());
});

/** The business's plan, this month's AI tokens, and past purchases. */
billingRouter.get("/", requireAuth, requireTenant, async (req, res) => {
  const tenantId = req.auth!.tenantId!;
  const [state, usage, payments] = await Promise.all([
    getPlanState(tenantId),
    aiUsage(tenantId),
    SubscriptionPayment.find({ tenantId, status: "paid" }).sort({ paidAt: -1 }).limit(24).lean(),
  ]);
  res.json({
    state,
    usage: { ...usage, limit: state.aiTokenLimit },
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
    ...priceList(),
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
      businessName: tenant?.businessName ?? "SethSathi",
      prefill: { name: user?.name ?? "", email: user?.email ?? "", contact: user?.phone ?? tenant?.phone ?? "" },
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

// ---------- SethSathi team (platform admins) ----------

export async function isPlatformAdmin(userId: string): Promise<boolean> {
  if (env.platformAdminEmails.length === 0) return false;
  const user = await User.findById(userId, { email: 1 }).lean();
  return Boolean(user?.email && env.platformAdminEmails.includes(user.email.toLowerCase()));
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
