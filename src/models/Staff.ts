import { Schema, model, Types } from "mongoose";

// Staff are HR-style records only — they never log in to the platform, so
// unlike User there is no email/password here at all.
export type StaffRole = "MANAGER" | "SALESMAN" | "WAREHOUSE_STAFF";

export interface StaffDocument {
  _id: Types.ObjectId;
  tenantId: Types.ObjectId;
  name: string;
  phone?: string;
  role: StaffRole;
  departmentId: Types.ObjectId | null;
  designationId: Types.ObjectId | null;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const staffSchema = new Schema<StaffDocument>(
  {
    tenantId: { type: Schema.Types.ObjectId, ref: "Tenant", required: true, index: true },
    name: { type: String, required: true, trim: true },
    phone: { type: String, trim: true },
    role: { type: String, enum: ["MANAGER", "SALESMAN", "WAREHOUSE_STAFF"], required: true },
    departmentId: { type: Schema.Types.ObjectId, ref: "Department", default: null },
    designationId: { type: Schema.Types.ObjectId, ref: "Designation", default: null },
    isActive: { type: Boolean, default: true },
  },
  { timestamps: true }
);

staffSchema.index({ tenantId: 1, name: 1 });

export const Staff = model<StaffDocument>("Staff", staffSchema);
