import { Schema, model, Types } from "mongoose";

export type TenantStatus = "trial" | "active" | "suspended";

export interface TenantDocument {
  _id: Types.ObjectId;
  businessName: string;
  businessType: string;
  ownerEmail: string;
  phone?: string;
  country?: string;
  currency: string;
  timezone: string;
  plan: "starter" | "business" | "enterprise";
  status: TenantStatus;
  createdAt: Date;
  updatedAt: Date;
}

const tenantSchema = new Schema<TenantDocument>(
  {
    businessName: { type: String, required: true, trim: true },
    businessType: { type: String, required: true, trim: true },
    ownerEmail: { type: String, required: true, lowercase: true, trim: true },
    phone: { type: String, trim: true },
    country: { type: String, trim: true },
    currency: { type: String, default: "INR" },
    timezone: { type: String, default: "Asia/Kolkata" },
    plan: { type: String, enum: ["starter", "business", "enterprise"], default: "starter" },
    status: { type: String, enum: ["trial", "active", "suspended"], default: "trial" },
  },
  { timestamps: true }
);

export const Tenant = model<TenantDocument>("Tenant", tenantSchema);
