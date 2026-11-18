import { Router, type NextFunction, type Request, type Response } from "express";
import mongoose from "mongoose";
import { z } from "zod";
import { env } from "../../config/env";
import { requireAuth } from "../../middleware/auth";
import { forgetAccountState } from "../../middleware/accountGate";
import { AiUsage } from "../../models/AiUsage";
import { Customer } from "../../models/Customer";
import { ACTIVE_INVOICE, Invoice } from "../../models/Invoice";
import { Product } from "../../models/Product";
import { Purchase } from "../../models/Purchase";
import { SubscriptionPayment } from "../../models/SubscriptionPayment";
import { Supplier } from "../../models/Supplier";
import { Tenant } from "../../models/Tenant";
import { User } from "../../models/User";
import { isPlaceholderEmail } from "../auth/auth.service";
import { isPlatformAdmin } from "../billing/billing.controller";
import { planState, usageMonth } from "../billing/subscription.service";
import { reportsRouter } from "./reports.controller";
import { DeleteError, deleteBusiness, deleteUser } from "./delete.service";

/**
 * The founder's console (VoiceMunshi team, PLATFORM_ADMIN_EMAILS): every
 * business and every login on the platform. See it, give plans, lift AI
 * limits for testing, suspend a business or stop a login.
 */
export const adminRouter = Router();

adminRouter.use(requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  if (await isPlatformAdmin(req.auth!.userId)) return next();
  return res.status(403).json({ error: "Insufficient permissions", code: "FORBIDDEN" });
});

const DAY_MS = 24 * 60 * 60 * 1000;
const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const shownEmail = (email?: string | null) => (email && !isPlaceholderEmail(email) ? email : null);
const isAdminRole = (role?: string) => role === "PLATFORM_ADMIN";

/** Plan state as the app shows it (businesses that never opened the app since plans began count as trial). */
function stateOf(tenant: { subscription?: Parameters<typeof planState>[0] | null; status?: string }) {
  const state = planState(tenant.subscription ?? null);
  return tenant.subscription ? state : { ...state, status: "trial" as const, isPro: true };
}

// ---------- Overview ----------

adminRouter.get("/overview", async (_req, res) => {
  const now = Date.now();
  const tenants = await Tenant.find({}, { businessName: 1, subscription: 1, status: 1, createdAt: 1 }).lean();
  const counts = { total: tenants.length, today: 0, week: 0, trial: 0, paid: 0, expired: 0, suspended: 0 };
  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);
  for (const t of tenants) {
    if (t.createdAt >= startOfToday) counts.today++;
    if (now - t.createdAt.getTime() < 7 * DAY_MS) counts.week++;
    if (t.status === "suspended") counts.suspended++;
    const s = stateOf(t).status;
    if (s === "trial") counts.trial++;
    else if (s === "active") counts.paid++;
    else counts.expired++;
  }

  // Sign-ups per day, last 14 days (oldest first).
  const signups = Array.from({ length: 14 }, (_, i) => {
    const day = new Date(startOfToday.getTime() - (13 - i) * DAY_MS);
    return { date: day.toISOString().slice(0, 10), count: 0 };
  });
  for (const t of tenants) {
    const key = new Date(new Date(t.createdAt).setHours(0, 0, 0, 0)).toISOString().slice(0, 10);
    const row = signups.find((d) => d.date === key);
    if (row) row.count++;
  }

  const [userTotal, activeWeek, usage] = await Promise.all([
    User.countDocuments({}),
    User.countDocuments({ lastSeenAt: { $gte: new Date(now - 7 * DAY_MS) } }),
    AiUsage.aggregate([{ $match: { month: usageMonth() } }, { $group: { _id: null, tokens: { $sum: "$tokens" }, calls: { $sum: "$calls" } } }]),
  ]);

  const recent = [...tenants].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime()).slice(0, 8);
  const owners = await User.find({ tenantId: { $in: recent.map((t) => t._id) }, role: "OWNER" }, { tenantId: 1, name: 1 }).lean();
  res.json({
    businesses: counts,
    users: { total: userTotal, activeWeek },
    ai: { tokens: usage[0]?.tokens ?? 0, calls: usage[0]?.calls ?? 0 },
    signups,
    recent: recent.map((t) => ({
      tenantId: String(t._id),
      businessName: t.businessName,
      ownerName: owners.find((o) => String(o.tenantId) === String(t._id))?.name ?? null,
      createdAt: t.createdAt,
      status: t.status === "suspended" ? "suspended" : stateOf(t).status,
    })),
  });
});

// ---------- Businesses ----------

adminRouter.get("/businesses", async (req, res) => {
  const q = String(req.query.q ?? "").trim();
  const filter = String(req.query.filter ?? "all");
  const owners = q
    ? await User.find({ $or: [{ name: new RegExp(escapeRegex(q), "i") }, { phone: new RegExp(escapeRegex(q), "i") }, { email: new RegExp(escapeRegex(q), "i") }] }, { tenantId: 1 }).lean()
    : [];
  const match = q
    ? { $or: [{ businessName: new RegExp(escapeRegex(q), "i") }, { phone: new RegExp(escapeRegex(q), "i") }, { _id: { $in: owners.map((o) => o.tenantId) } }] }
    : {};
  const tenants = await Tenant.find(match, { businessName: 1, phone: 1, subscription: 1, status: 1, createdAt: 1, "onboarding.category": 1 })
    .sort({ createdAt: -1 })
    .limit(300)
    .lean();
  const ids = tenants.map((t) => t._id);
  const [users, usage] = await Promise.all([
    User.find({ tenantId: { $in: ids } }, { tenantId: 1, name: 1, email: 1, phone: 1, role: 1, lastSeenAt: 1 }).lean(),
    AiUsage.find({ tenantId: { $in: ids }, month: usageMonth() }).lean(),
  ]);
  const rows = tenants.map((t) => {
    const team = users.filter((u) => String(u.tenantId) === String(t._id));
    const owner = team.find((u) => u.role === "OWNER") ?? team[0];
    const lastSeen = team.reduce<Date | null>((latest, u) => (u.lastSeenAt && (!latest || u.lastSeenAt > latest) ? u.lastSeenAt : latest), null);
    const state = stateOf(t);
    return {
      tenantId: String(t._id),
      businessName: t.businessName,
      category: t.onboarding?.category ?? null,
      ownerName: owner?.name ?? null,
      ownerEmail: shownEmail(owner?.email),
      ownerPhone: owner?.phone ?? t.phone ?? null,
      users: team.length,
      createdAt: t.createdAt,
      lastSeenAt: lastSeen,
      suspended: t.status === "suspended",
      state,
      aiTokensUsed: usage.find((u) => String(u.tenantId) === String(t._id))?.tokens ?? 0,
      aiTokenLimitOverride: t.subscription?.aiTokenLimit ?? null,
    };
  });
  const filtered = rows.filter((r) =>
    filter === "suspended" ? r.suspended : filter === "trial" ? r.state.status === "trial" : filter === "paid" ? r.state.status === "active" : filter === "expired" ? r.state.status === "expired" : true
  );
  res.json(filtered);
});

adminRouter.get("/businesses/:id", async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(404).json({ error: "Business not found" });
  const tenant = await Tenant.findById(req.params.id).lean();
  if (!tenant) return res.status(404).json({ error: "Business not found" });
  const tid = tenant._id;
  const [users, products, customers, suppliers, purchases, bills, sales, usage, payments] = await Promise.all([
    User.find({ tenantId: tid }, { name: 1, email: 1, phone: 1, role: 1, isActive: 1, lastSeenAt: 1, createdAt: 1 }).sort({ createdAt: 1 }).lean(),
    Product.countDocuments({ tenantId: tid }),
    Customer.countDocuments({ tenantId: tid, isWalkIn: { $ne: true } }),
    Supplier.countDocuments({ tenantId: tid }),
    Purchase.countDocuments({ tenantId: tid }),
    Invoice.countDocuments({ tenantId: tid, ...ACTIVE_INVOICE }),
    Invoice.aggregate([{ $match: { tenantId: tid, ...ACTIVE_INVOICE } }, { $group: { _id: null, total: { $sum: "$totalAmount" } } }]),
    AiUsage.find({ tenantId: tid }).sort({ month: -1 }).limit(6).lean(),
    SubscriptionPayment.find({ tenantId: tid }).sort({ createdAt: -1 }).limit(10).lean(),
  ]);
  res.json({
    tenantId: String(tid),
    businessName: tenant.businessName,
    phone: tenant.phone ?? null,
    gstin: tenant.gstin ?? null,
    address: tenant.address ?? null,
    createdAt: tenant.createdAt,
    suspended: tenant.status === "suspended",
    state: stateOf(tenant),
    aiTokenLimitOverride: tenant.subscription?.aiTokenLimit ?? null,
    setup: {
      completed: Boolean(tenant.onboarding?.completed),
      description: tenant.onboarding?.description ?? null,
      category: tenant.onboarding?.category ?? null,
      template: tenant.appSetup?.template ?? null,
      trade: tenant.onboarding?.trade ?? null,
    },
    counts: { products, customers, suppliers, purchases, bills, salesTotal: Math.round(sales[0]?.total ?? 0) },
    aiUsage: usage.map((u) => ({ month: u.month, tokens: u.tokens, calls: u.calls })),
    payments: payments.map((p) => ({ plan: p.plan, period: p.period, days: p.days, amount: p.amount, method: p.method, status: p.status, note: p.note, paidAt: p.paidAt, createdAt: p.createdAt })),
    users: users.map((u) => ({
      userId: String(u._id),
      name: u.name,
      email: shownEmail(u.email),
      phone: u.phone ?? null,
      role: u.role,
      isActive: u.isActive,
      lastSeenAt: u.lastSeenAt ?? null,
      createdAt: u.createdAt,
      platformAdmin: isAdminRole(u.role),
    })),
  });
});

const businessPatchSchema = z.object({
  suspended: z.boolean().optional(),
  /** Munshi AI tokens a month for this business; null goes back to the plan's limit. */
  aiTokenLimit: z.number().int().min(0).max(1_000_000_000).nullable().optional(),
});

adminRouter.patch("/businesses/:id", async (req, res) => {
  const parsed = businessPatchSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(404).json({ error: "Business not found" });
  const tenant = await Tenant.findById(req.params.id);
  if (!tenant) return res.status(404).json({ error: "Business not found" });

  if (parsed.data.suspended !== undefined) {
    // The founder's own business can't be suspended from here (it would lock the console out).
    const me = await User.findById(req.auth!.userId, { tenantId: 1 }).lean();
    if (parsed.data.suspended && String(me?.tenantId) === String(tenant._id)) {
      return res.status(400).json({ error: "You can't suspend your own business." });
    }
    tenant.status = parsed.data.suspended ? "suspended" : "active";
  }
  if (parsed.data.aiTokenLimit !== undefined) {
    // A business with no subscription yet gets one with only the override set.
    tenant.subscription = { ...(tenant.subscription ?? { plan: null, period: null, trialEndsAt: null, currentPeriodEnd: null }), aiTokenLimit: parsed.data.aiTokenLimit };
    tenant.markModified("subscription");
  }
  await tenant.save();
  forgetAccountState({ tenantId: String(tenant._id) });
  res.json({ suspended: tenant.status === "suspended", aiTokenLimitOverride: tenant.subscription?.aiTokenLimit ?? null });
});

// ---------- Users (every login on the platform) ----------

adminRouter.get("/users", async (req, res) => {
  const q = String(req.query.q ?? "").trim();
  const match = q
    ? { $or: [{ name: new RegExp(escapeRegex(q), "i") }, { email: new RegExp(escapeRegex(q), "i") }, { phone: new RegExp(escapeRegex(q), "i") }] }
    : {};
  const users = await User.find(match, { name: 1, email: 1, phone: 1, role: 1, isActive: 1, lastSeenAt: 1, createdAt: 1, tenantId: 1 })
    .sort({ createdAt: -1 })
    .limit(300)
    .lean();
  const tenants = await Tenant.find({ _id: { $in: users.map((u) => u.tenantId).filter(Boolean) } }, { businessName: 1, status: 1 }).lean();
  res.json(
    users.map((u) => {
      const tenant = tenants.find((t) => String(t._id) === String(u.tenantId));
      return {
        userId: String(u._id),
        name: u.name,
        email: shownEmail(u.email),
        phone: u.phone ?? null,
        role: u.role,
        isActive: u.isActive,
        lastSeenAt: u.lastSeenAt ?? null,
        createdAt: u.createdAt,
        tenantId: u.tenantId ? String(u.tenantId) : null,
        businessName: tenant?.businessName ?? null,
        businessSuspended: tenant?.status === "suspended",
        platformAdmin: isAdminRole(u.role),
      };
    })
  );
});

adminRouter.patch("/users/:id", async (req, res) => {
  const parsed = z.object({ isActive: z.boolean() }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(404).json({ error: "User not found" });
  if (req.params.id === req.auth!.userId && !parsed.data.isActive) return res.status(400).json({ error: "You can't stop your own login." });
  const user = await User.findByIdAndUpdate(req.params.id, { $set: { isActive: parsed.data.isActive } }, { new: true });
  if (!user) return res.status(404).json({ error: "User not found" });
  forgetAccountState({ userId: String(user._id) });
  res.json({ userId: String(user._id), isActive: user.isActive });
});

// Reports (AI cost in ₹, growth, a business's work) live in their own file; same founder-only check.
adminRouter.use(reportsRouter);

// ---------- Permanent delete (cannot be undone) ----------

/** The UI makes the founder type the name; the server checks it too. */
const confirmSchema = z.object({ confirmName: z.string().trim().min(1) });
const sameName = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

function sendDeleteError(res: Response, err: unknown) {
  if (err instanceof DeleteError) return res.status(err.status).json({ error: err.message, code: err.code });
  console.error("[admin] delete failed:", (err as Error).message);
  return res.status(500).json({ error: "Delete failed part-way. Open the business again to see what is left, then retry." });
}

adminRouter.delete("/businesses/:id", async (req, res) => {
  const parsed = confirmSchema.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ error: "Type the business name to confirm." });
  const tenant = mongoose.isValidObjectId(req.params.id) ? await Tenant.findById(req.params.id, { businessName: 1 }).lean() : null;
  if (!tenant) return res.status(404).json({ error: "Business not found" });
  if (!sameName(parsed.data.confirmName, tenant.businessName)) return res.status(400).json({ error: "The name you typed doesn't match the business name." });
  try {
    const result = await deleteBusiness(req.params.id);
    console.log(`[admin] ${req.auth!.userId} deleted business "${result.businessName}" (${req.params.id}):`, JSON.stringify(result.removed));
    res.json(result);
  } catch (err) {
    sendDeleteError(res, err);
  }
});

adminRouter.delete("/users/:id", async (req, res) => {
  const parsed = confirmSchema.extend({ withBusiness: z.boolean().optional() }).safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ error: "Type the name to confirm." });
  const user = mongoose.isValidObjectId(req.params.id) ? await User.findById(req.params.id, { name: 1, tenantId: 1 }).lean() : null;
  if (!user) return res.status(404).json({ error: "User not found" });
  // Deleting an owner with their business: the business name is what they type.
  const business = parsed.data.withBusiness && user.tenantId ? await Tenant.findById(user.tenantId, { businessName: 1 }).lean() : null;
  const expected = business?.businessName ?? user.name;
  if (!sameName(parsed.data.confirmName, expected)) return res.status(400).json({ error: "The name you typed doesn't match." });
  try {
    const result = await deleteUser(req.params.id, req.auth!.userId, Boolean(parsed.data.withBusiness));
    console.log(`[admin] ${req.auth!.userId} deleted ${result.deleted} for user ${req.params.id}`);
    res.json(result);
  } catch (err) {
    sendDeleteError(res, err);
  }
});
