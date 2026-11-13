import "dotenv/config";

function required(name: string, fallback?: string): string {
  const value = process.env[name] ?? fallback;
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

export const env = {
  port: Number(process.env.PORT ?? 4000),
  nodeEnv: process.env.NODE_ENV ?? "development",
  mongodbUri: required("MONGODB_URI", "mongodb://localhost:27017/umanager"),
  jwt: {
    accessSecret: required("JWT_ACCESS_SECRET", "dev-access-secret"),
    refreshSecret: required("JWT_REFRESH_SECRET", "dev-refresh-secret"),
    accessExpiresIn: process.env.JWT_ACCESS_EXPIRES_IN ?? "15m",
    refreshExpiresIn: process.env.JWT_REFRESH_EXPIRES_IN ?? "7d",
  },
  // Comma-separated list so the Vite dev server and the built PWA preview
  // can both call the API during development.
  corsOrigins: (process.env.CORS_ORIGIN ?? "http://localhost:5173,http://localhost:4173")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean),
  // Optional: AI features (dashboard personalization, order parsing, the AI
  // business assistant chat) fail gracefully until this is set. Groq hosts
  // open models behind an OpenAI-compatible API, so the same `openai` SDK is
  // reused with a different baseURL rather than adding a second SDK dependency.
  groqApiKey: process.env.GROQ_API_KEY || null,
  // Optional: product image upload is disabled (fails gracefully) until this is set.
  // The cloudinary SDK reads CLOUDINARY_URL from the environment itself; this
  // flag just lets the app know whether that happened.
  cloudinaryConfigured: Boolean(process.env.CLOUDINARY_URL),
  // Hosted Textbelt (textbelt.com) key for login OTP SMS. Without it, OTPs are
  // printed to the server console in development and refused in production.
  textbeltApiKey: process.env.TEXTBELT_API_KEY || null,
  // Social sign-in. Google: OAuth Web client ID. Apple: the Services ID used by Sign in with Apple JS.
  // Each provider stays off until its ID is set.
  googleClientId: process.env.GOOGLE_CLIENT_ID || null,
  appleClientId: process.env.APPLE_CLIENT_ID || null,
  // Plan payments. Online checkout stays off (owners see "contact us") until the
  // key ID and secret are set; use rzp_test_ keys first. The webhook secret is
  // the one entered in Razorpay Dashboard → Webhooks for /api/billing/webhook.
  razorpay: {
    keyId: process.env.RAZORPAY_KEY_ID || null,
    keySecret: process.env.RAZORPAY_KEY_SECRET || null,
    webhookSecret: process.env.RAZORPAY_WEBHOOK_SECRET || null,
  },
  // SethSathi's own team: these sign-in emails can see every business and give
  // or extend plans by hand (offline payments, free months). Comma-separated.
  platformAdminEmails: (process.env.PLATFORM_ADMIN_EMAILS ?? "")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean),
};
