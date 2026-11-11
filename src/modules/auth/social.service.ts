import { createHash } from "crypto";
import jwt from "jsonwebtoken";
import { env } from "../../config/env";
import { Tenant } from "../../models/Tenant";
import { User, type PreferredLanguage } from "../../models/User";
import { verifyIdToken } from "../../utils/idToken";
import { AccountExistsError, issueTokens } from "./auth.service";

// "Continue with Google / Apple". Existing users (matched by provider ID, or by
// verified email, which then gets linked) are signed in straight away. New
// users get a short-lived sign-up token and finish in the Munshi AI chat by
// giving their business name and mobile number.

export type SocialProvider = "google" | "apple";

export class SocialAuthError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: "NOT_CONFIGURED" | "INVALID_TOKEN" | "EMAIL_UNVERIFIED" | "SIGNUP_EXPIRED"
  ) {
    super(message);
    this.name = "SocialAuthError";
  }
}

interface SocialIdentity {
  provider: SocialProvider;
  sub: string;
  email: string;
  name: string;
}

async function verifyProviderToken(provider: SocialProvider, token: string, nameHint?: string): Promise<SocialIdentity> {
  const audience = provider === "google" ? env.googleClientId : env.appleClientId;
  if (!audience) {
    throw new SocialAuthError(`${provider === "google" ? "Google" : "Apple"} sign-in isn't set up yet.`, 503, "NOT_CONFIGURED");
  }

  let claims;
  try {
    claims =
      provider === "google"
        ? await verifyIdToken(token, {
            jwksUrl: "https://www.googleapis.com/oauth2/v3/certs",
            issuers: ["https://accounts.google.com", "accounts.google.com"],
            audience,
          })
        : await verifyIdToken(token, {
            jwksUrl: "https://appleid.apple.com/auth/keys",
            issuers: ["https://appleid.apple.com"],
            audience,
          });
  } catch (err) {
    console.error(`[auth:${provider}] token rejected:`, (err as Error).message);
    throw new SocialAuthError("We couldn't verify that sign-in. Please try again.", 401, "INVALID_TOKEN");
  }

  const verified = claims.email_verified === true || claims.email_verified === "true";
  if (!claims.email || !verified) {
    throw new SocialAuthError("Your account's email isn't verified, so we can't use it to sign in.", 400, "EMAIL_UNVERIFIED");
  }

  // Apple only sends the name to the browser on the first sign-in, never in the token.
  const name = (claims.name || nameHint || "").trim() || claims.email.split("@")[0];
  return { provider, sub: claims.sub, email: claims.email.toLowerCase(), name };
}

const providerField = (provider: SocialProvider) => (provider === "google" ? "googleId" : "appleId");

// A separate key from the session secrets, so a sign-up token can never pass as a session.
function signupSecret(): string {
  return createHash("sha256").update(`${env.jwt.refreshSecret}:social-signup`).digest("hex");
}

export type SocialSignInResult =
  | ({ status: "signed_in" } & ReturnType<typeof issueTokens>)
  | { status: "needs_details"; signupToken: string; profile: { name: string; email: string } };

export async function socialSignIn(provider: SocialProvider, token: string, nameHint?: string): Promise<SocialSignInResult> {
  const identity = await verifyProviderToken(provider, token, nameHint);
  const field = providerField(provider);

  let user = await User.findOne({ [field]: identity.sub, isActive: true });
  if (!user) {
    // Same verified email as an existing account: link it rather than create a duplicate.
    user = await User.findOne({ email: identity.email, isActive: true });
    if (user) {
      user.set(field, identity.sub);
      await user.save();
    }
  }
  if (user) return { status: "signed_in", ...issueTokens(user) };

  const signupToken = jwt.sign({ ...identity }, signupSecret(), { expiresIn: "30m", audience: "social-signup" });
  return { status: "needs_details", signupToken, profile: { name: identity.name, email: identity.email } };
}

export async function completeSocialSignup(input: {
  signupToken: string;
  businessName: string;
  phone: string;
  preferredLanguage?: PreferredLanguage;
}) {
  let identity: SocialIdentity;
  try {
    identity = jwt.verify(input.signupToken, signupSecret(), { audience: "social-signup" }) as SocialIdentity;
  } catch {
    throw new SocialAuthError("This sign-up has expired. Please continue with Google or Apple again.", 401, "SIGNUP_EXPIRED");
  }

  if (await User.findOne({ email: identity.email })) {
    throw new AccountExistsError("An account with this email already exists", "EMAIL_TAKEN");
  }
  if (await User.findOne({ phone: input.phone })) {
    throw new AccountExistsError("An account with this mobile number already exists", "PHONE_TAKEN");
  }

  const tenant = await Tenant.create({
    businessName: input.businessName,
    businessType: "Wholesale",
    ownerEmail: identity.email,
  });
  const user = await User.create({
    tenantId: tenant._id,
    name: identity.name,
    email: identity.email,
    phone: input.phone,
    [providerField(identity.provider)]: identity.sub,
    ...(input.preferredLanguage ? { preferredLanguage: input.preferredLanguage } : {}),
    role: "OWNER",
  });
  return issueTokens(user);
}
