import { Schema, model, Types } from "mongoose";

export interface DesignationDocument {
  _id: Types.ObjectId;
  tenantId: Types.ObjectId;
  title: string;
  createdAt: Date;
  updatedAt: Date;
}

const designationSchema = new Schema<DesignationDocument>(
  {
    tenantId: { type: Schema.Types.ObjectId, ref: "Tenant", required: true, index: true },
    title: { type: String, required: true, trim: true },
  },
  { timestamps: true }
);

designationSchema.index({ tenantId: 1, title: 1 }, { unique: true });

export const Designation = model<DesignationDocument>("Designation", designationSchema);
