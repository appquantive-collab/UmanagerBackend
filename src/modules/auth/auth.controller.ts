import { Router } from "express";
import { loginPhoneSchema, loginSchema, refreshSchema, registerSchema } from "./auth.schemas";
import { getProfile, login, loginByPhone, registerTenantOwner } from "./auth.service";
import { requireAuth } from "../../middleware/auth";
import { verifyRefreshToken } from "../../utils/tokens";
import { signAccessToken } from "../../utils/tokens";

export const authRouter = Router();

authRouter.post("/register", async (req, res) => {
  const parsed = registerSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }

  try {
    const result = await registerTenantOwner(parsed.data);
    return res.status(201).json(result);
  } catch (err) {
    return res.status(409).json({ error: (err as Error).message });
  }
});

authRouter.post("/login", async (req, res) => {
  const parsed = loginSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }

  try {
    const result = await login(parsed.data.email, parsed.data.password);
    return res.json(result);
  } catch (err) {
    return res.status(401).json({ error: (err as Error).message });
  }
});

authRouter.post("/login-phone", async (req, res) => {
  const parsed = loginPhoneSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }

  try {
    const result = await loginByPhone(parsed.data.phone, parsed.data.password);
    return res.json(result);
  } catch (err) {
    return res.status(401).json({ error: (err as Error).message });
  }
});

authRouter.get("/me", requireAuth, async (req, res) => {
  try {
    const profile = await getProfile(req.auth!.userId);
    return res.json(profile);
  } catch (err) {
    return res.status(404).json({ error: (err as Error).message });
  }
});

authRouter.post("/refresh", (req, res) => {
  const parsed = refreshSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }

  try {
    const payload = verifyRefreshToken(parsed.data.refreshToken);
    const accessToken = signAccessToken(payload);
    return res.json({ accessToken });
  } catch {
    return res.status(401).json({ error: "Invalid or expired refresh token" });
  }
});
