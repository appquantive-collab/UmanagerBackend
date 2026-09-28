import { Schema, model, Types } from "mongoose";

export type InvoicePaymentStatus = "unpaid" | "partial" | "paid";
export type PaymentMethod = "cash" | "upi" | "bank_transfer" | "cheque" | "credit" | "other";
export type BillType = "gst" | "record";

export interface InvoiceLineItem {
  productId: Types.ObjectId;
  productName: string;
  quantity: number;
  unit: string;
  unitPrice: number;
  gstPercent: number;
  lineSubtotal: number; // quantity * unitPrice, before tax
  lineTax: number;
  lineTotal: number; // lineSubtotal + lineTax
}

export interface InvoicePayment {
  amount: number;
  method: PaymentMethod;
  paidAt: Date;
  note?: string;
}

export interface InvoiceDocument {
  _id: Types.ObjectId;
  tenantId: Types.ObjectId;
  orderIds: Types.ObjectId[];
  customerId: Types.ObjectId;
  invoiceNumber: string;
  billType: BillType;
  items: InvoiceLineItem[];
  subtotal: number;
  taxTotal: number;
  totalAmount: number;
  amountPaid: number;
  paymentStatus: InvoicePaymentStatus;
  payments: InvoicePayment[];
  dueDate?: Date;
  createdBy: Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

const invoiceLineItemSchema = new Schema<InvoiceLineItem>(
  {
    productId: { type: Schema.Types.ObjectId, ref: "Product", required: true },
    productName: { type: String, required: true, trim: true },
    quantity: { type: Number, required: true, min: 0.001 },
    unit: { type: String, required: true, default: "pcs" },
    unitPrice: { type: Number, required: true, min: 0 },
    gstPercent: { type: Number, required: true, default: 0 },
    lineSubtotal: { type: Number, required: true },
    lineTax: { type: Number, required: true },
    lineTotal: { type: Number, required: true },
  },
  { _id: false }
);

const invoicePaymentSchema = new Schema<InvoicePayment>(
  {
    amount: { type: Number, required: true, min: 0.01 },
    method: { type: String, enum: ["cash", "upi", "bank_transfer", "cheque", "credit", "other"], required: true },
    paidAt: { type: Date, required: true, default: Date.now },
    note: { type: String, trim: true },
  },
  { _id: false }
);

const invoiceSchema = new Schema<InvoiceDocument>(
  {
    tenantId: { type: Schema.Types.ObjectId, ref: "Tenant", required: true, index: true },
    orderIds: { type: [Schema.Types.ObjectId], ref: "Order", default: [], index: true },
    customerId: { type: Schema.Types.ObjectId, ref: "Customer", required: true, index: true },
    invoiceNumber: { type: String, required: true, trim: true },
    billType: { type: String, enum: ["gst", "record"], required: true, default: "record" },
    items: { type: [invoiceLineItemSchema], required: true },
    subtotal: { type: Number, required: true },
    taxTotal: { type: Number, required: true },
    totalAmount: { type: Number, required: true },
    amountPaid: { type: Number, required: true, default: 0 },
    paymentStatus: { type: String, enum: ["unpaid", "partial", "paid"], default: "unpaid" },
    payments: { type: [invoicePaymentSchema], default: [] },
    dueDate: { type: Date },
    createdBy: { type: Schema.Types.ObjectId, ref: "User", required: true },
  },
  { timestamps: true }
);

invoiceSchema.index({ tenantId: 1, invoiceNumber: 1 }, { unique: true });
invoiceSchema.index({ tenantId: 1, createdAt: -1 });

export const Invoice = model<InvoiceDocument>("Invoice", invoiceSchema);
