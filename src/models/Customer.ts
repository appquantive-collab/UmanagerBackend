import { Schema, model, Types } from "mongoose";

export interface CustomerDocument {
  _id: Types.ObjectId;
  tenantId: Types.ObjectId;
  name: string;
  phone?: string;
  creditLimit: number;
  /** "person" (walk-in / retail buyer) or "business" (shop, firm). */
  kind: "person" | "business";
  email?: string;
  gstin?: string;
  /** Full Aadhaar — never sent to the app (select: false); only the last 4 digits are. */
  aadhaar?: string;
  aadhaarLast4?: string;
  address?: string;
  stateCode?: string; // 2-digit GST state code, e.g. "27" for Maharashtra
  isWalkIn: boolean; // the shared "Walk-in customer" for counter sales
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const customerSchema = new Schema<CustomerDocument>(
  {
    tenantId: { type: Schema.Types.ObjectId, ref: "Tenant", required: true, index: true },
    name: { type: String, required: true, trim: true },
    phone: { type: String, trim: true },
    creditLimit: { type: Number, default: 0 },
    kind: { type: String, enum: ["person", "business"], default: "person" },
    email: { type: String, trim: true, lowercase: true },
    gstin: { type: String, trim: true, uppercase: true },
    aadhaar: { type: String, trim: true, select: false },
    aadhaarLast4: { type: String, trim: true },
    address: { type: String, trim: true },
    stateCode: { type: String, trim: true },
    isWalkIn: { type: Boolean, default: false },
    isActive: { type: Boolean, default: true },
  },
  { timestamps: true }
);

customerSchema.index({ tenantId: 1, name: 1 });

export const Customer = model<CustomerDocument>("Customer", customerSchema);
