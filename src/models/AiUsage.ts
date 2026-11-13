import { Schema, model, Types } from "mongoose";

/** Munshi AI tokens a business used in one calendar month (IST), e.g. month "2026-11". */
export interface AiUsageDocument {
  tenantId: Types.ObjectId;
  month: string;
  tokens: number;
  calls: number;
}

const aiUsageSchema = new Schema<AiUsageDocument>(
  {
    tenantId: { type: Schema.Types.ObjectId, ref: "Tenant", required: true },
    month: { type: String, required: true },
    tokens: { type: Number, default: 0 },
    calls: { type: Number, default: 0 },
  },
  { timestamps: true }
);

aiUsageSchema.index({ tenantId: 1, month: 1 }, { unique: true });

export const AiUsage = model<AiUsageDocument>("AiUsage", aiUsageSchema);
