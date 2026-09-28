import bcrypt from "bcryptjs";
import { Tenant } from "../../models/Tenant";
import { User } from "../../models/User";
import { signAccessToken, signRefreshToken } from "../../utils/tokens";

interface RegisterInput {
  businessName: string;
  businessType: string;
  ownerName: string;
  email: string;
  password: string;
  phone?: string;
}

export async function registerTenantOwner(input: RegisterInput) {
  const existing = await User.findOne({ email: input.email.toLowerCase() });
  if (existing) {
    throw new Error("An account with this email already exists");
  }

  if (input.phone) {
    const existingPhone = await User.findOne({ phone: input.phone });
    if (existingPhone) {
      throw new Error("An account with this mobile number already exists");
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

  const valid = await bcrypt.compare(password, user.passwordHash);
  if (!valid) {
    throw new Error("Invalid credentials");
  }

  return issueTokens(user);
}

// No SMS/OTP provider is wired up yet, so phone sign-in authenticates with the
// account's real password rather than a one-time code. Revisit once SMS/OTP
// delivery exists.
export async function loginByPhone(phone: string, password: string) {
  const user = await User.findOne({ phone, isActive: true });
  if (!user) {
    throw new Error("No account found for this mobile number");
  }

  const valid = await bcrypt.compare(password, user.passwordHash);
  if (!valid) {
    throw new Error("Invalid credentials");
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
        }
      : null,
  };
}

function issueTokens(user: { _id: unknown; tenantId: unknown; role: string; name: string; email: string }) {
  const payload = {
    userId: String(user._id),
    tenantId: user.tenantId ? String(user.tenantId) : null,
    role: user.role as never,
  };

  return {
    accessToken: signAccessToken(payload),
    refreshToken: signRefreshToken(payload),
    user: { ...payload, name: user.name, email: user.email },
  };
}
