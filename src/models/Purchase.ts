import { Schema, model, Types } from "mongoose";
import type { PaymentMethod } from "./Invoice";

// A purchase bill from a supplier: what was bought, at what cost, into which
// warehouse, and how much of it has been paid. Saving one adds the items to
// stock through "purchase" StockMovement entries (referenceId = purchase id),
// so the stock ledger stays the single source of truth for quantities.

export type PurchasePaymentStatus = "unpaid" | "partial" | "paid";

export interface PurchaseLineItem {
  productId: Types.ObjectId;
  productName: string;
  quantity: number;
  unit: string;
  unitCost: number;
  gstPercent: number;
  lineSubtotal: number;
  lineTax: number;
  lineTotal: number;
  batchNo?: string;
  expiryDate?: Date;
  serials?: string[];
}

export interface PurchasePayment {
  amount: number;
  method: PaymentMethod;
  paidAt: Date;
  note?: string;
}

export interface PurchaseDocument {
  _id: Types.ObjectId;
  tenantId: Types.ObjectId;
  supplierId: Types.ObjectId;
  warehouseId: Types.ObjectId;
  purchaseNumber: string;
  supplierBillNumber?: string;
  items: PurchaseLineItem[];
  subtotal: number;
  taxTotal: number;
  totalAmount: number;
  amountPaid: number;
  paymentStatus: PurchasePaymentStatus;
  payments: PurchasePayment[];
  purchasedAt: Date;
  note?: string;
  createdBy: Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

const lineItemSchema = new Schema<PurchaseLineItem>(
  {
    productId: { type: Schema.Types.ObjectId, ref: "Product", required: true },
    productName: { type: String, required: true },
    quantity: { type: Number, required: true, min: 0 },
    unit: { type: String, required: true },
    unitCost: { type: Number, required: true, min: 0 },
    gstPercent: { type: Number, default: 0, min: 0 },
    lineSubtotal: { type: Number, required: true },
    lineTax: { type: Number, required: true },
    lineTotal: { type: Number, required: true },
    batchNo: { type: String, trim: true },
    expiryDate: { type: Date },
    serials: { type: [String], default: undefined },
  },
  { _id: false }
);

const paymentSchema = new Schema<PurchasePayment>(
  {
    amount: { type: Number, required: true, min: 0 },
    method: { type: String, enum: ["cash", "upi", "bank_transfer", "cheque", "credit", "other"], required: true },
    paidAt: { type: Date, required: true },
    note: { type: String, trim: true },
  },
  { _id: false }
);

const purchaseSchema = new Schema<PurchaseDocument>(
  {
    tenantId: { type: Schema.Types.ObjectId, ref: "Tenant", required: true, index: true },
    supplierId: { type: Schema.Types.ObjectId, ref: "Supplier", required: true, index: true },
    warehouseId: { type: Schema.Types.ObjectId, ref: "Warehouse", required: true },
    purchaseNumber: { type: String, required: true },
    supplierBillNumber: { type: String, trim: true },
    items: { type: [lineItemSchema], required: true },
    subtotal: { type: Number, required: true },
    taxTotal: { type: Number, required: true },
    totalAmount: { type: Number, required: true },
    amountPaid: { type: Number, default: 0 },
    paymentStatus: { type: String, enum: ["unpaid", "partial", "paid"], default: "unpaid" },
    payments: { type: [paymentSchema], default: [] },
    purchasedAt: { type: Date, required: true },
    note: { type: String, trim: true },
    createdBy: { type: Schema.Types.ObjectId, ref: "User", required: true },
  },
  { timestamps: true }
);

purchaseSchema.index({ tenantId: 1, purchasedAt: -1 });
purchaseSchema.index({ tenantId: 1, purchaseNumber: 1 }, { unique: true });

export const Purchase = model<PurchaseDocument>("Purchase", purchaseSchema);
