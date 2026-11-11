import { Schema, model, Types } from "mongoose";
import type { PaymentMethod } from "./Invoice";

/** Goods a customer brought back against a bill (a credit note, CN-0001…). */
export interface SaleReturnLine {
  productId: Types.ObjectId;
  productName: string;
  quantity: number;
  unit: string;
  unitPrice: number; // per unit, after the bill's discount, before tax
  gstPercent: number;
  lineSubtotal: number;
  lineTax: number;
  lineTotal: number;
  serials?: string[];
}

export interface SaleReturnDocument {
  _id: Types.ObjectId;
  tenantId: Types.ObjectId;
  returnNumber: string;
  invoiceId: Types.ObjectId;
  invoiceNumber: string;
  customerId: Types.ObjectId;
  items: SaleReturnLine[];
  subtotal: number;
  taxTotal: number;
  totalAmount: number;
  /** Taken off what the customer still owed on the bill. */
  adjustedAmount: number;
  /** Paid back in money (the bill was already paid). */
  refundAmount: number;
  refundMethod?: PaymentMethod;
  reason?: string;
  createdBy: Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

const lineSchema = new Schema<SaleReturnLine>(
  {
    productId: { type: Schema.Types.ObjectId, ref: "Product", required: true },
    productName: { type: String, required: true, trim: true },
    quantity: { type: Number, required: true, min: 0.001 },
    unit: { type: String, required: true },
    unitPrice: { type: Number, required: true },
    gstPercent: { type: Number, default: 0 },
    lineSubtotal: { type: Number, required: true },
    lineTax: { type: Number, required: true },
    lineTotal: { type: Number, required: true },
    serials: { type: [String], default: undefined },
  },
  { _id: false }
);

const saleReturnSchema = new Schema<SaleReturnDocument>(
  {
    tenantId: { type: Schema.Types.ObjectId, ref: "Tenant", required: true, index: true },
    returnNumber: { type: String, required: true, trim: true },
    invoiceId: { type: Schema.Types.ObjectId, ref: "Invoice", required: true, index: true },
    invoiceNumber: { type: String, required: true },
    customerId: { type: Schema.Types.ObjectId, ref: "Customer", required: true, index: true },
    items: { type: [lineSchema], required: true },
    subtotal: { type: Number, required: true },
    taxTotal: { type: Number, required: true },
    totalAmount: { type: Number, required: true },
    adjustedAmount: { type: Number, default: 0 },
    refundAmount: { type: Number, default: 0 },
    refundMethod: { type: String, enum: ["cash", "upi", "bank_transfer", "cheque", "other"] },
    reason: { type: String, trim: true },
    createdBy: { type: Schema.Types.ObjectId, ref: "User", required: true },
  },
  { timestamps: true }
);

saleReturnSchema.index({ tenantId: 1, returnNumber: 1 }, { unique: true });
saleReturnSchema.index({ tenantId: 1, createdAt: -1 });

export const SaleReturn = model<SaleReturnDocument>("SaleReturn", saleReturnSchema);
