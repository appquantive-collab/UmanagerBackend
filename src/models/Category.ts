import { Schema, model, Types } from "mongoose";

export interface CategoryDocument {
  _id: Types.ObjectId;
  tenantId: Types.ObjectId;
  name: string;
  createdAt: Date;
  updatedAt: Date;
}

const categorySchema = new Schema<CategoryDocument>(
  {
    tenantId: { type: Schema.Types.ObjectId, ref: "Tenant", required: true, index: true },
    name: { type: String, required: true, trim: true },
  },
  { timestamps: true }
);

categorySchema.index({ tenantId: 1, name: 1 }, { unique: true });

export const Category = model<CategoryDocument>("Category", categorySchema);
