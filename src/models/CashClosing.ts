import { Schema, model, Types } from "mongoose";

/** End-of-day galla count: what the cash drawer should hold vs what was counted. */
export interface CashClosingDocument {
  _id: Types.ObjectId;
  tenantId: Types.ObjectId;
  date: string; // YYYY-MM-DD (India time)
  openingCash: number;
  expectedCash: number;
  countedCash: number;
  difference: number; // counted - expected
  note?: string;
  closedBy: Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

const cashClosingSchema = new Schema<CashClosingDocument>(
  {
    tenantId: { type: Schema.Types.ObjectId, ref: "Tenant", required: true, index: true },
    date: { type: String, required: true },
    openingCash: { type: Number, required: true },
    expectedCash: { type: Number, required: true },
    countedCash: { type: Number, required: true },
    difference: { type: Number, required: true },
    note: { type: String, trim: true },
    closedBy: { type: Schema.Types.ObjectId, ref: "User", required: true },
  },
  { timestamps: true }
);
cashClosingSchema.index({ tenantId: 1, date: 1 }, { unique: true });

export const CashClosing = model<CashClosingDocument>("CashClosing", cashClosingSchema);
