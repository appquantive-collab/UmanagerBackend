import { Schema, model, Types } from "mongoose";
import type { BillingPeriod, PlanKey } from "./Tenant";

/**
 * One plan purchase: a Razorpay checkout (created → paid / failed) or a plan
 * given by a platform admin (manual: offline payment, free months, support).
 */
export interface SubscriptionPaymentDocument {
  tenantId: Types.ObjectId;
  plan: PlanKey;
  period: BillingPeriod | null;
  /** Extra days given (manual grants without a period). */
  days: number | null;
  /** Rupees. */
  amount: number;
  method: "razorpay" | "manual";
  status: "created" | "paid" | "failed";
  razorpayOrderId: string | null;
  razorpayPaymentId: string | null;
  note: string | null;
  createdBy: Types.ObjectId | null;
  /** Access this purchase added. */
  periodStart: Date | null;
  periodEnd: Date | null;
  paidAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

const subscriptionPaymentSchema = new Schema<SubscriptionPaymentDocument>(
  {
    tenantId: { type: Schema.Types.ObjectId, ref: "Tenant", required: true, index: true },
    plan: { type: String, enum: ["basic", "pro"], required: true },
    period: { type: String, enum: ["monthly", "quarterly", "annual"], default: null },
    days: { type: Number, default: null },
    amount: { type: Number, required: true, min: 0 },
    method: { type: String, enum: ["razorpay", "manual"], required: true },
    status: { type: String, enum: ["created", "paid", "failed"], default: "created" },
    razorpayOrderId: { type: String, default: null },
    razorpayPaymentId: { type: String, default: null },
    note: { type: String, trim: true, default: null },
    createdBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
    periodStart: { type: Date, default: null },
    periodEnd: { type: Date, default: null },
    paidAt: { type: Date, default: null },
  },
  { timestamps: true }
);

subscriptionPaymentSchema.index({ razorpayOrderId: 1 }, { unique: true, partialFilterExpression: { razorpayOrderId: { $type: "string" } } });

export const SubscriptionPayment = model<SubscriptionPaymentDocument>("SubscriptionPayment", subscriptionPaymentSchema);
