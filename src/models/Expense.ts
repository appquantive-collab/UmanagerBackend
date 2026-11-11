import { Schema, model, Types } from "mongoose";

export const EXPENSE_CATEGORIES = [
  "rent",
  "salary",
  "electricity",
  "transport",
  "tea_food",
  "repairs",
  "phone_internet",
  "packing",
  "shop_supplies",
  "bank_charges",
  "other",
] as const;
export type ExpenseCategory = (typeof EXPENSE_CATEGORIES)[number];
export const EXPENSE_METHODS = ["cash", "upi", "bank_transfer", "cheque", "other"] as const;
export type ExpenseMethod = (typeof EXPENSE_METHODS)[number];

/** Money spent running the shop (not stock bought for sale). */
export interface ExpenseDocument {
  _id: Types.ObjectId;
  tenantId: Types.ObjectId;
  category: ExpenseCategory;
  amount: number;
  method: ExpenseMethod;
  note?: string;
  spentAt: Date;
  createdBy: Types.ObjectId;
  createdAt: Date;
}

const expenseSchema = new Schema<ExpenseDocument>(
  {
    tenantId: { type: Schema.Types.ObjectId, ref: "Tenant", required: true, index: true },
    category: { type: String, enum: EXPENSE_CATEGORIES, required: true },
    amount: { type: Number, required: true, min: 0.01 },
    method: { type: String, enum: EXPENSE_METHODS, required: true, default: "cash" },
    note: { type: String, trim: true },
    spentAt: { type: Date, required: true, default: Date.now },
    createdBy: { type: Schema.Types.ObjectId, ref: "User", required: true },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);
expenseSchema.index({ tenantId: 1, spentAt: -1 });

export const Expense = model<ExpenseDocument>("Expense", expenseSchema);
