import { Router } from "express";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { requireAuth } from "../../middleware/auth";
import { ipRateLimit } from "../../middleware/ipRateLimit";
import { User } from "../../models/User";
import { issueTokens } from "../auth/auth.service";

/**
 * Sign-in for the VoiceMunshi team (PLATFORM_ADMIN logins). Separate from the
 * shops' sign-in: its own page (/admin/login), its own token in the browser,
 * and it only accepts admin accounts (a shop owner's password never works here,
 * and an admin's never works in the shop app).
 */
export const adminAuthRouter = Router();

const loginLimit = ipRateLimit({ perIp: 10, total: 200, message: "Too many sign-in attempts. Please wait a minute." });

adminAuthRouter.post("/login", loginLimit, async (req, res) => {
  const parsed = z.object({ email: z.string().trim().toLowerCase().email(), password: z.string().min(1).max(200) }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Enter your email and password." });
  const user = await User.findOne({ email: parsed.data.email, role: "PLATFORM_ADMIN", isActive: true });
  // Same answer for "no such admin" and "wrong password".
  if (!user?.passwordHash || !(await bcrypt.compare(parsed.data.password, user.passwordHash))) {
    return res.status(401).json({ error: "Wrong email or password." });
  }
  const session = issueTokens(user);
  return res.json({ accessToken: session.accessToken, refreshToken: session.refreshToken, admin: { name: user.name, email: user.email } });
});

async function currentAdmin(userId: string) {
  const user = await User.findById(userId);
  return user && user.role === "PLATFORM_ADMIN" && user.isActive ? user : null;
}

adminAuthRouter.get("/me", requireAuth, async (req, res) => {
  const user = await currentAdmin(req.auth!.userId);
  if (!user) return res.status(403).json({ error: "Not an admin account", code: "FORBIDDEN" });
  return res.json({ name: user.name, email: user.email });
});

adminAuthRouter.post("/password", requireAuth, async (req, res) => {
  const parsed = z.object({ current: z.string().min(1), next: z.string().min(10, "Use at least 10 characters").max(200) }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Check the passwords" });
  const user = await currentAdmin(req.auth!.userId);
  if (!user) return res.status(403).json({ error: "Not an admin account", code: "FORBIDDEN" });
  if (!user.passwordHash || !(await bcrypt.compare(parsed.data.current, user.passwordHash))) {
    return res.status(400).json({ error: "Current password is wrong." });
  }
  user.passwordHash = await bcrypt.hash(parsed.data.next, 10);
  await user.save();
  return res.json({ ok: true });
});
