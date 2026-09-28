import { Schema, model, Types } from "mongoose";

export interface WarehouseDocument {
  _id: Types.ObjectId;
  tenantId: Types.ObjectId;
  name: string;
  location?: string;
  isDefault: boolean;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const warehouseSchema = new Schema<WarehouseDocument>(
  {
    tenantId: { type: Schema.Types.ObjectId, ref: "Tenant", required: true, index: true },
    name: { type: String, required: true, trim: true },
    location: { type: String, trim: true },
    isDefault: { type: Boolean, default: false },
    isActive: { type: Boolean, default: true },
  },
  { timestamps: true }
);

warehouseSchema.index({ tenantId: 1, name: 1 }, { unique: true });

export const Warehouse = model<WarehouseDocument>("Warehouse", warehouseSchema);
