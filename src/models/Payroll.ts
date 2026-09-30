import { Schema, model, Types } from "mongoose";

export type PayrollStatus = "unpaid" | "paid";

export interface PayrollDocument {
  _id: Types.ObjectId;
  tenantId: Types.ObjectId;
  staffId: Types.ObjectId;
  month: string; // "YYYY-MM"
  payType: "salary" | "daily_wage";
  // For salary: the fixed monthly amount at generation time. For daily_wage:
  // dailyWage × presentDays (half-days counted as 0.5), all snapshotted here
  // so a later change to the staff member's rate doesn't retroactively alter
  // an already-generated month.
  presentDays: number;
  halfDays: number;
  absentDays: number;
  leaveDays: number;
  grossAmount: number;
  deductions: number;
  netAmount: number;
  status: PayrollStatus;
  paidAt?: Date;
  note?: string;
  createdBy: Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

const payrollSchema = new Schema<PayrollDocument>(
  {
    tenantId: { type: Schema.Types.ObjectId, ref: "Tenant", required: true, index: true },
    staffId: { type: Schema.Types.ObjectId, ref: "Staff", required: true, index: true },
    month: { type: String, required: true },
    payType: { type: String, enum: ["salary", "daily_wage"], required: true },
    presentDays: { type: Number, required: true, default: 0 },
    halfDays: { type: Number, required: true, default: 0 },
    absentDays: { type: Number, required: true, default: 0 },
    leaveDays: { type: Number, required: true, default: 0 },
    grossAmount: { type: Number, required: true },
    deductions: { type: Number, required: true, default: 0 },
    netAmount: { type: Number, required: true },
    status: { type: String, enum: ["unpaid", "paid"], default: "unpaid" },
    paidAt: { type: Date },
    note: { type: String, trim: true },
    createdBy: { type: Schema.Types.ObjectId, ref: "User", required: true },
  },
  { timestamps: true }
);

payrollSchema.index({ tenantId: 1, staffId: 1, month: 1 }, { unique: true });
payrollSchema.index({ tenantId: 1, month: 1 });

export const Payroll = model<PayrollDocument>("Payroll", payrollSchema);
