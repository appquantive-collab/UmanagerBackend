import { Schema, model, Types } from "mongoose";

export interface SupplierDocument {
  _id: Types.ObjectId;
  tenantId: Types.ObjectId;
  name: string;
  phone?: string;
  gstin?: string;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const supplierSchema = new Schema<SupplierDocument>(
  {
    tenantId: { type: Schema.Types.ObjectId, ref: "Tenant", required: true, index: true },
    name: { type: String, required: true, trim: true },
    phone: { type: String, trim: true },
    gstin: { type: String, trim: true, uppercase: true },
    isActive: { type: Boolean, default: true },
  },
  { timestamps: true }
);

supplierSchema.index({ tenantId: 1, name: 1 });

export const Supplier = model<SupplierDocument>("Supplier", supplierSchema);
