import { Router } from "express";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { ownerOrManager, requireAuth, requireTenant } from "../../middleware/auth";
import { User } from "../../models/User";
import { recordAudit } from "../audit/audit.service";

/**
 * Login accounts for the shop's people (separate from Staff, which is for
 * attendance and salary). Each gets a role that decides what they can see.
 */
export const teamRouter = Router();
teamRouter.use(requireAuth, requireTenant, ownerOrManager);

const TEAM_ROLES = ["MANAGER", "SALESMAN", "WAREHOUSE_STAFF"] as const;

const createMemberSchema = z
  .object({
    name: z.string().trim().min(1).max(80),
    role: z.enum(TEAM_ROLES),
    phone: z.string().regex(/^\d{10}$/, "Enter a valid 10-digit mobile number").optional(),
    email: z.string().trim().email().optional(),
    password: z.string().min(6).max(100).optional(),
  })
  .refine((v) => v.phone || (v.email && v.password), { message: "Give a mobile number (login by OTP) or an email and password" });

const updateMemberSchema = z.object({
  role: z.enum(TEAM_ROLES).optional(),
  isActive: z.boolean().optional(),
  name: z.string().trim().min(1).max(80).optional(),
  password: z.string().min(6).max(100).optional(),
});

const view = (u: { _id: unknown; name: string; email: string; phone: string | null; role: string; isActive: boolean; createdAt: Date }) => ({
  _id: String(u._id),
  name: u.name,
  email: u.email.endsWith("@staff.sethsathi.local") ? null : u.email,
  phone: u.phone,
  role: u.role,
  isActive: u.isActive,
  createdAt: u.createdAt,
});

teamRouter.get("/", async (req, res) => {
  const users = await User.find({ tenantId: req.auth!.tenantId }).sort({ createdAt: 1 }).lean();
  res.json(users.map(view));
});

teamRouter.post("/", async (req, res) => {
  const parsed = createMemberSchema.safeParse(req.body);
  if (!parsed.success) {
    const first = parsed.error.issues[0]?.message;
    return res.status(400).json({ error: first ?? "Please check the details" });
  }
  const { name, role, phone, email, password } = parsed.data;
  // Only the owner can add another manager.
  if (role === "MANAGER" && req.auth!.role === "MANAGER") {
    return res.status(403).json({ error: "Only the owner can add a manager", code: "FORBIDDEN" });
  }
  if (phone && (await User.exists({ phone }))) {
    return res.status(409).json({ error: "An account with this mobile number already exists", code: "PHONE_TAKEN" });
  }
  const loginEmail = (email ?? `${phone}@staff.sethsathi.local`).toLowerCase();
  if (await User.exists({ email: loginEmail })) {
    return res.status(409).json({ error: "An account with this email already exists", code: "EMAIL_TAKEN" });
  }
  const user = await User.create({
    tenantId: req.auth!.tenantId,
    name,
    role,
    email: loginEmail,
    ...(phone ? { phone } : {}),
    ...(password ? { passwordHash: await bcrypt.hash(password, 10) } : {}),
  });
  void recordAudit(req, "team.add", `Added ${name} as ${role.toLowerCase().replace("_", " ")}`, String(user._id));
  res.status(201).json(view(user));
});

teamRouter.patch("/:id", async (req, res) => {
  const parsed = updateMemberSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Please check the details" });
  const user = await User.findOne({ _id: req.params.id, tenantId: req.auth!.tenantId });
  if (!user) return res.status(404).json({ error: "Account not found" });
  if (user.role === "OWNER") return res.status(403).json({ error: "The owner's account can't be changed here", code: "FORBIDDEN" });
  if (String(user._id) === req.auth!.userId) return res.status(400).json({ error: "You can't change your own access" });
  if (req.auth!.role === "MANAGER" && (user.role === "MANAGER" || parsed.data.role === "MANAGER")) {
    return res.status(403).json({ error: "Only the owner can change a manager", code: "FORBIDDEN" });
  }
  const changes: string[] = [];
  if (parsed.data.role && parsed.data.role !== user.role) {
    changes.push(`role ${user.role} → ${parsed.data.role}`);
    user.role = parsed.data.role;
  }
  if (parsed.data.isActive !== undefined && parsed.data.isActive !== user.isActive) {
    changes.push(parsed.data.isActive ? "login turned on" : "login turned off");
    user.isActive = parsed.data.isActive;
  }
  if (parsed.data.name) user.name = parsed.data.name;
  if (parsed.data.password) {
    user.passwordHash = await bcrypt.hash(parsed.data.password, 10);
    changes.push("password reset");
  }
  await user.save();
  if (changes.length) void recordAudit(req, "team.update", `${user.name}: ${changes.join(", ")}`, String(user._id));
  res.json(view(user));
});
