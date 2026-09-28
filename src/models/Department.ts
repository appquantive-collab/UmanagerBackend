import { Schema, model, Types } from "mongoose";

export interface DepartmentDocument {
  _id: Types.ObjectId;
  tenantId: Types.ObjectId;
  name: string;
  createdAt: Date;
  updatedAt: Date;
}

const departmentSchema = new Schema<DepartmentDocument>(
  {
    tenantId: { type: Schema.Types.ObjectId, ref: "Tenant", required: true, index: true },
    name: { type: String, required: true, trim: true },
  },
  { timestamps: true }
);

departmentSchema.index({ tenantId: 1, name: 1 }, { unique: true });

export const Department = model<DepartmentDocument>("Department", departmentSchema);
