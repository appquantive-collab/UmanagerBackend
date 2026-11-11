import { Schema, model, Types } from "mongoose";

/** Who did what, and when — for owners to see staff activity. Never edited. */
export interface AuditLogDocument {
  _id: Types.ObjectId;
  tenantId: Types.ObjectId;
  userId: Types.ObjectId;
  userName: string;
  action: string; // e.g. "bill.create", "bill.cancel", "stock.adjust"
  entityId?: string;
  summary: string;
  amount?: number;
  createdAt: Date;
}

const auditLogSchema = new Schema<AuditLogDocument>(
  {
    tenantId: { type: Schema.Types.ObjectId, ref: "Tenant", required: true, index: true },
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    userName: { type: String, required: true, trim: true },
    action: { type: String, required: true },
    entityId: { type: String },
    summary: { type: String, required: true, trim: true },
    amount: { type: Number },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);
auditLogSchema.index({ tenantId: 1, createdAt: -1 });

export const AuditLog = model<AuditLogDocument>("AuditLog", auditLogSchema);
