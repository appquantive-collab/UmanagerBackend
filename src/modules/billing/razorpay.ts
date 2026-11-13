import crypto from "crypto";
import { env } from "../../config/env";

/**
 * Razorpay Orders + Checkout, called over plain HTTPS (no SDK needed).
 * Flow: server creates an order for the exact plan price → the app opens
 * Razorpay Checkout → server checks the payment signature → plan starts.
 * The webhook (payment.captured / order.paid) is a backup if the app closes
 * before telling the server.
 */
export function razorpayConfigured(): boolean {
  return Boolean(env.razorpay.keyId && env.razorpay.keySecret);
}

export async function createRazorpayOrder(amountRupees: number, receipt: string, notes: Record<string, string>) {
  const auth = Buffer.from(`${env.razorpay.keyId}:${env.razorpay.keySecret}`).toString("base64");
  const res = await fetch("https://api.razorpay.com/v1/orders", {
    method: "POST",
    headers: { Authorization: `Basic ${auth}`, "Content-Type": "application/json" },
    body: JSON.stringify({ amount: Math.round(amountRupees * 100), currency: "INR", receipt, notes }),
  });
  const body = (await res.json().catch(() => ({}))) as { id?: string; amount?: number; currency?: string; error?: { description?: string } };
  if (!res.ok || !body.id) {
    throw new Error(`Razorpay order failed: ${body.error?.description ?? res.status}`);
  }
  return { id: body.id, amount: body.amount ?? Math.round(amountRupees * 100), currency: body.currency ?? "INR" };
}

function safeEqualHex(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}

/** Signature Razorpay Checkout returns: HMAC-SHA256(order_id|payment_id, key secret). */
export function verifyPaymentSignature(orderId: string, paymentId: string, signature: string): boolean {
  if (!env.razorpay.keySecret) return false;
  const expected = crypto.createHmac("sha256", env.razorpay.keySecret).update(`${orderId}|${paymentId}`).digest("hex");
  return safeEqualHex(expected, signature);
}

/** Webhook signature: HMAC-SHA256(raw body, webhook secret). */
export function verifyWebhookSignature(rawBody: Buffer, signature: string): boolean {
  if (!env.razorpay.webhookSecret) return false;
  const expected = crypto.createHmac("sha256", env.razorpay.webhookSecret).update(rawBody).digest("hex");
  return safeEqualHex(expected, signature);
}
