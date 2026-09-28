import { Schema, model, Types } from "mongoose";

export interface BrandDocument {
  _id: Types.ObjectId;
  tenantId: Types.ObjectId;
  name: string;
  createdAt: Date;
  updatedAt: Date;
}

const brandSchema = new Schema<BrandDocument>(
  {
    tenantId: { type: Schema.Types.ObjectId, ref: "Tenant", required: true, index: true },
    name: { type: String, required: true, trim: true },
  },
  { timestamps: true }
);

brandSchema.index({ tenantId: 1, name: 1 }, { unique: true });

export const Brand = model<BrandDocument>("Brand", brandSchema);
