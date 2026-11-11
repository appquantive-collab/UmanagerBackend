import { createHmac, randomInt, timingSafeEqual } from "crypto";
import bcrypt from "bcryptjs";
import { env } from "../../config/env";
import { PhoneOtp } from "../../models/PhoneOtp";
import { Tenant } from "../../models/Tenant";
import { User, type PreferredLanguage } from "../../models/User";
import { signAccessToken, signRefreshToken } from "../../utils/tokens";
import { SmsNotConfiguredError, sendSms } from "./sms.service";

interface RegisterInput {
  businessName: string;
  businessType: string;
  ownerName: string;
  email: string;
  password: string;
  phone?: string;
  preferredLanguage?: PreferredLanguage;
}

export class AccountExistsError extends Error {
  constructor(
    message: string,
    readonly code: "EMAIL_TAKEN" | "PHONE_TAKEN"
  ) {
    super(message);
    this.name = "AccountExistsError";
  }
}

export async function registerTenantOwner(input: RegisterInput) {
  const existing = await User.findOne({ email: input.email.toLowerCase() });
  if (existing) {
    throw new AccountExistsError("An account with this email already exists", "EMAIL_TAKEN");
  }

  if (input.phone) {
    const existingPhone = await User.findOne({ phone: input.phone });
    if (existingPhone) {
      throw new AccountExistsError("An account with this mobile number already exists", "PHONE_TAKEN");
    }
  }

  const tenant = await Tenant.create({
    businessName: input.businessName,
    businessType: input.businessType,
    ownerEmail: input.email.toLowerCase(),
  });

  const passwordHash = await bcrypt.hash(input.password, 10);
  const user = await User.create({
    tenantId: tenant._id,
    name: input.ownerName,
    email: input.email.toLowerCase(),
    ...(input.phone ? { phone: input.phone } : {}),
    ...(input.preferredLanguage ? { preferredLanguage: input.preferredLanguage } : {}),
    passwordHash,
    role: "OWNER",
  });

  return issueTokens(user);
}

export async function login(email: string, password: string) {
  const user = await User.findOne({ email: email.toLowerCase(), isActive: true });
  if (!user) {
    throw new Error("Invalid credentials");
  }

  // Google/Apple accounts have no password.
  if (!user.passwordHash) {
    throw new Error("Invalid credentials");
  }
  const valid = await bcrypt.compare(password, user.passwordHash);
  if (!valid) {
    throw new Error("Invalid credentials");
  }

  return issueTokens(user);
}

const OTP_TTL_MS = 5 * 60 * 1000;
const RESEND_COOLDOWN_MS = 30 * 1000;
const SEND_WINDOW_MS = 60 * 60 * 1000;
const MAX_SENDS_PER_WINDOW = 5;
const MAX_VERIFY_ATTEMPTS = 5;

export type OtpErrorCode =
  | "NO_ACCOUNT"
  | "RESEND_COOLDOWN"
  | "TOO_MANY_REQUESTS"
  | "SMS_NOT_CONFIGURED"
  | "SMS_FAILED"
  | "CODE_EXPIRED"
  | "CODE_INVALID"
  | "TOO_MANY_ATTEMPTS";

// `code` lets the web app show a translated message instead of this English text.
export class OtpError extends Error {
  constructor(
    message: string,
    readonly code: OtpErrorCode,
    readonly status: number,
    readonly retryAfterSeconds?: number
  ) {
    super(message);
    this.name = "OtpError";
  }
}

function hashOtp(phone: string, code: string): string {
  return createHmac("sha256", env.jwt.accessSecret).update(`${phone}:${code}`).digest("hex");
}

export async function requestLoginOtp(phone: string) {
  const user = await User.findOne({ phone, isActive: true });
  if (!user) {
    throw new OtpError("No account found for this mobile number", "NO_ACCOUNT", 404);
  }

  const now = Date.now();
  const existing = await PhoneOtp.findOne({ phone });
  let sendCount = 0;
  let windowStartedAt = new Date(now);

  if (existing) {
    const sinceLastSend = now - existing.lastSentAt.getTime();
    if (sinceLastSend < RESEND_COOLDOWN_MS) {
      const wait = Math.ceil((RESEND_COOLDOWN_MS - sinceLastSend) / 1000);
      throw new OtpError(`Please wait ${wait}s before requesting a new code`, "RESEND_COOLDOWN", 429, wait);
    }
    if (now - existing.windowStartedAt.getTime() < SEND_WINDOW_MS) {
      if (existing.sendCount >= MAX_SENDS_PER_WINDOW) {
        throw new OtpError("Too many codes requested. Please try again later.", "TOO_MANY_REQUESTS", 429);
      }
      sendCount = existing.sendCount;
      windowStartedAt = existing.windowStartedAt;
    }
  }

  const code = randomInt(0, 1_000_000).toString().padStart(6, "0");
  await PhoneOtp.findOneAndUpdate(
    { phone },
    {
      phone,
      codeHash: hashOtp(phone, code),
      expiresAt: new Date(now + OTP_TTL_MS),
      attempts: 0,
      sendCount: sendCount + 1,
      windowStartedAt,
      lastSentAt: new Date(now),
    },
    { upsert: true }
  );

  const timing = { resendAfterSeconds: RESEND_COOLDOWN_MS / 1000, expiresInSeconds: OTP_TTL_MS / 1000 };

  // Temporary: until an SMS/WhatsApp provider is configured, hand the code back so
  // the app can show it in a popup. Setting TEXTBELT_API_KEY switches this off.
  if (!env.textbeltApiKey) {
    return { ...timing, code };
  }

  try {
    await sendSms(phone, `${code} is your SethSathi login code. It expires in 5 minutes. Do not share it with anyone.`);
  } catch (err) {
    // The send counter is kept so a failing provider can't be hammered, but the unsent code must not stay valid.
    await PhoneOtp.updateOne({ phone }, { expiresAt: new Date(0) });
    if (err instanceof SmsNotConfiguredError) {
      throw new OtpError("SMS login isn't set up yet. Please sign in with email.", "SMS_NOT_CONFIGURED", 503);
    }
    console.error("[otp] SMS send failed:", (err as Error).message);
    throw new OtpError("We couldn't send the code. Please try again.", "SMS_FAILED", 502);
  }

  return timing;
}

export async function verifyLoginOtp(phone: string, code: string) {
  const record = await PhoneOtp.findOne({ phone });
  if (!record || record.expiresAt.getTime() < Date.now()) {
    throw new OtpError("This code has expired. Please request a new one.", "CODE_EXPIRED", 400);
  }
  if (record.attempts >= MAX_VERIFY_ATTEMPTS) {
    throw new OtpError("Too many wrong attempts. Please request a new code.", "TOO_MANY_ATTEMPTS", 429);
  }

  record.attempts += 1;
  const matches = timingSafeEqual(Buffer.from(hashOtp(phone, code), "hex"), Buffer.from(record.codeHash, "hex"));
  if (!matches) {
    await record.save();
    throw new OtpError("Incorrect code. Please check and try again.", "CODE_INVALID", 400);
  }

  record.expiresAt = new Date(0);
  await record.save();

  const user = await User.findOne({ phone, isActive: true });
  if (!user) {
    throw new OtpError("No account found for this mobile number", "NO_ACCOUNT", 404);
  }
  return issueTokens(user);
}

export async function getProfile(userId: string) {
  const user = await User.findById(userId);
  if (!user || !user.isActive) {
    throw new Error("Account not found");
  }

  const tenant = user.tenantId ? await Tenant.findById(user.tenantId) : null;

  return {
    userId: String(user._id),
    name: user.name,
    email: user.email,
    phone: user.phone,
    role: user.role,
    preferredLanguage: user.preferredLanguage,
    tenant: tenant
      ? {
          tenantId: String(tenant._id),
          businessName: tenant.businessName,
          businessType: tenant.businessType,
          plan: tenant.plan,
          status: tenant.status,
          currency: tenant.currency,
          onboarding: tenant.onboarding,
          aiDashboardLayout: tenant.aiDashboardLayout,
          phone: tenant.phone,
          gstin: tenant.gstin,
          address: tenant.address,
          stateCode: tenant.stateCode,
          upiId: tenant.upiId,
          bankName: tenant.bankName,
          bankAccount: tenant.bankAccount,
          bankIfsc: tenant.bankIfsc,
          invoiceTerms: tenant.invoiceTerms,
        }
      : null,
  };
}

export function issueTokens(user: {
  _id: unknown;
  tenantId: unknown;
  role: string;
  name: string;
  email: string;
  preferredLanguage: PreferredLanguage;
}) {
  const payload = {
    userId: String(user._id),
    tenantId: user.tenantId ? String(user.tenantId) : null,
    role: user.role as never,
  };

  return {
    accessToken: signAccessToken(payload),
    refreshToken: signRefreshToken(payload),
    user: { ...payload, name: user.name, email: user.email, preferredLanguage: user.preferredLanguage },
  };
}

export async function updateProfile(userId: string, patch: { preferredLanguage?: PreferredLanguage }) {
  const user = await User.findById(userId);
  if (!user || !user.isActive) {
    throw new Error("Account not found");
  }

  if (patch.preferredLanguage) {
    user.preferredLanguage = patch.preferredLanguage;
  }
  await user.save();

  return { preferredLanguage: user.preferredLanguage };
}
