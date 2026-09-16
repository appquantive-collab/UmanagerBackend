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
}

export async function registerTenantOwner(input: RegisterInput) {
  const existing = await User.findOne({ email: input.email.toLowerCase() });
  if (existing) {
    throw new Error("An account with this email already exists");
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

function issueTokens(user: { _id: unknown; tenantId: unknown; role: string }) {
  const payload = {
    userId: String(user._id),
    tenantId: user.tenantId ? String(user.tenantId) : null,
    role: user.role as never,
  };

  return {
    accessToken: signAccessToken(payload),
    refreshToken: signRefreshToken(payload),
    user: payload,
  };
}
