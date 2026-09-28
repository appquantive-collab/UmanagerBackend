import { Schema, model, Types } from "mongoose";

export type UserRole = "SUPER_ADMIN" | "OWNER" | "MANAGER" | "SALESMAN" | "WAREHOUSE_STAFF";

export interface UserDocument {
  _id: Types.ObjectId;
  tenantId: Types.ObjectId | null;
  name: string;
  email: string;
  phone: string | null;
  passwordHash: string;
  role: UserRole;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const userSchema = new Schema<UserDocument>(
  {
    tenantId: { type: Schema.Types.ObjectId, ref: "Tenant", default: null, index: true },
    name: { type: String, required: true, trim: true },
    email: { type: String, required: true, lowercase: true, trim: true },
    phone: { type: String, trim: true },
    passwordHash: { type: String, required: true },
    role: {
      type: String,
      enum: ["SUPER_ADMIN", "OWNER", "MANAGER", "SALESMAN", "WAREHOUSE_STAFF"],
      required: true,
    },
    isActive: { type: Boolean, default: true },
  },
  { timestamps: true }
);

userSchema.index({ tenantId: 1, email: 1 }, { unique: true });
userSchema.index({ phone: 1 }, { unique: true, sparse: true });

export const User = model<UserDocument>("User", userSchema);
