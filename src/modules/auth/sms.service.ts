import { env } from "../../config/env";

export class SmsNotConfiguredError extends Error {
  constructor() {
    super("SMS sending is not configured (missing TEXTBELT_API_KEY)");
    this.name = "SmsNotConfiguredError";
  }
}

export class SmsSendError extends Error {
  constructor(reason: string) {
    super(`SMS could not be sent: ${reason}`);
    this.name = "SmsSendError";
  }
}

interface TextbeltResponse {
  success: boolean;
  textId?: string | number;
  quotaRemaining?: number;
  error?: string;
}

// `phone` is a 10-digit Indian mobile number; Textbelt expects E.164.
export async function sendSms(phone: string, message: string): Promise<void> {
  if (!env.textbeltApiKey) {
    if (env.nodeEnv !== "production") {
      console.log(`[sms:dev] to +91${phone}: ${message}`);
      return;
    }
    throw new SmsNotConfiguredError();
  }

  const res = await fetch("https://textbelt.com/text", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ phone: `+91${phone}`, message, key: env.textbeltApiKey }),
  });
  const body = (await res.json().catch(() => ({ success: false, error: `HTTP ${res.status}` }))) as TextbeltResponse;

  if (!body.success) {
    throw new SmsSendError(body.error ?? "unknown error");
  }
}
