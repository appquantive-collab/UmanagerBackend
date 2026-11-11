import { Router } from "express";
import type { Response } from "express";
import {
  appleSignInSchema,
  googleSignInSchema,
  loginSchema,
  otpRequestSchema,
  otpVerifySchema,
  refreshSchema,
  registerSchema,
  socialCompleteSchema,
  updateProfileSchema,
} from "./auth.schemas";
import {
  AccountExistsError,
  OtpError,
  getProfile,
  login,
  registerTenantOwner,
  requestLoginOtp,
  updateProfile,
  verifyLoginOtp,
} from "./auth.service";
import { requireAuth } from "../../middleware/auth";
import { User } from "../../models/User";
import { ipRateLimit } from "../../middleware/ipRateLimit";
import { SocialAuthError, completeSocialSignup, socialSignIn } from "./social.service";
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
    const code = err instanceof AccountExistsError ? err.code : undefined;
    return res.status(409).json({ error: (err as Error).message, code });
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

function sendOtpError(res: Response, err: unknown) {
  if (err instanceof OtpError) {
    return res
      .status(err.status)
      .json({ error: err.message, code: err.code, retryAfterSeconds: err.retryAfterSeconds });
  }
  console.error("[otp] unexpected error:", err);
  return res.status(500).json({ error: "Something went wrong. Please try again." });
}

authRouter.post("/otp/request", async (req, res) => {
  const parsed = otpRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }

  try {
    return res.json(await requestLoginOtp(parsed.data.phone));
  } catch (err) {
    return sendOtpError(res, err);
  }
});

authRouter.post("/otp/verify", async (req, res) => {
  const parsed = otpVerifySchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }

  try {
    return res.json(await verifyLoginOtp(parsed.data.phone, parsed.data.code));
  } catch (err) {
    return sendOtpError(res, err);
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

authRouter.patch("/me", requireAuth, async (req, res) => {
  const parsed = updateProfileSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }

  try {
    const result = await updateProfile(req.auth!.userId, parsed.data);
    return res.json(result);
  } catch (err) {
    return res.status(404).json({ error: (err as Error).message });
  }
});

// Re-reads the account so a role change or a turned-off login takes effect
// within one access-token lifetime, without the person signing out.
authRouter.post("/refresh", async (req, res) => {
  const parsed = refreshSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }

  let payload;
  try {
    payload = verifyRefreshToken(parsed.data.refreshToken);
  } catch {
    return res.status(401).json({ error: "Invalid or expired refresh token" });
  }
  const user = await User.findById(payload.userId, { role: 1, isActive: 1, tenantId: 1 }).lean();
  if (!user || !user.isActive) {
    return res.status(401).json({ error: "Invalid or expired refresh token" });
  }
  const accessToken = signAccessToken({
    userId: payload.userId,
    tenantId: user.tenantId ? String(user.tenantId) : null,
    role: user.role,
  });
  return res.json({ accessToken });
});

// ---------- Continue with Google / Apple ----------

const socialLimit = ipRateLimit({ perIp: 20, total: 400, message: "Too many sign-in attempts. Please wait a minute." });

function sendSocialError(res: Response, err: unknown) {
  if (err instanceof SocialAuthError) return res.status(err.status).json({ error: err.message, code: err.code });
  if (err instanceof AccountExistsError) return res.status(409).json({ error: err.message, code: err.code });
  console.error("[auth:social] unexpected error:", err);
  return res.status(500).json({ error: "Something went wrong. Please try again." });
}

authRouter.post("/google", socialLimit, async (req, res) => {
  const parsed = googleSignInSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  try {
    return res.json(await socialSignIn("google", parsed.data.credential));
  } catch (err) {
    return sendSocialError(res, err);
  }
});

authRouter.post("/apple", socialLimit, async (req, res) => {
  const parsed = appleSignInSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  try {
    return res.json(await socialSignIn("apple", parsed.data.idToken, parsed.data.name));
  } catch (err) {
    return sendSocialError(res, err);
  }
});

authRouter.post("/social/complete", socialLimit, async (req, res) => {
  const parsed = socialCompleteSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  try {
    return res.status(201).json(await completeSocialSignup(parsed.data));
  } catch (err) {
    return sendSocialError(res, err);
  }
});
