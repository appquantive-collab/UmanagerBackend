import { Schema, model, Types } from "mongoose";

export type InvoicePaymentStatus = "unpaid" | "partial" | "paid";
export type PaymentMethod = "cash" | "upi" | "bank_transfer" | "cheque" | "credit" | "other" | "credit_note";
export type BillType = "gst" | "record";
export type InvoiceStatus = "active" | "cancelled";

export interface InvoiceLineItem {
  productId: Types.ObjectId;
  productName: string;
  quantity: number;
  unit: string;
  unitPrice: number;
  gstPercent: number;
  hsn?: string;
  discountPercent?: number;
  lineSubtotal: number; // quantity * unitPrice less discount, before tax
  lineTax: number;
  cgst?: number;
  sgst?: number;
  igst?: number;
  lineTotal: number; // lineSubtotal + lineTax
  orderId?: Types.ObjectId; // order this line was billed from (restored if the bill is cancelled)
  serials?: string[]; // IMEI / serial numbers sold
}

export interface InvoicePayment {
  amount: number;
  method: PaymentMethod;
  paidAt: Date;
  note?: string;
}

/** Who was on the bill when it was made (kept as-is even if a profile changes later). */
export interface PartySnapshot {
  name?: string;
  phone?: string;
  gstin?: string;
  address?: string;
  stateCode?: string;
}

export interface SellerSnapshot extends PartySnapshot {
  upiId?: string;
  bankName?: string;
  bankAccount?: string;
  bankIfsc?: string;
  terms?: string;
}

export interface InvoiceDocument {
  _id: Types.ObjectId;
  tenantId: Types.ObjectId;
  orderIds: Types.ObjectId[];
  customerId: Types.ObjectId;
  invoiceNumber: string;
  billType: BillType;
  status: InvoiceStatus;
  items: InvoiceLineItem[];
  subtotal: number;
  discountTotal: number;
  taxTotal: number;
  cgstTotal: number;
  sgstTotal: number;
  igstTotal: number;
  roundOff: number;
  totalAmount: number;
  amountPaid: number;
  paymentStatus: InvoicePaymentStatus;
  payments: InvoicePayment[];
  isInterState: boolean;
  seller?: SellerSnapshot;
  buyer?: PartySnapshot;
  dueDate?: Date;
  cancelledAt?: Date;
  cancelReason?: string;
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
    hsn: { type: String, trim: true },
    discountPercent: { type: Number, min: 0, max: 100, default: 0 },
    lineSubtotal: { type: Number, required: true },
    lineTax: { type: Number, required: true },
    cgst: { type: Number, default: 0 },
    sgst: { type: Number, default: 0 },
    igst: { type: Number, default: 0 },
    lineTotal: { type: Number, required: true },
    orderId: { type: Schema.Types.ObjectId, ref: "Order" },
    serials: { type: [String], default: undefined },
  },
  { _id: false }
);

const invoicePaymentSchema = new Schema<InvoicePayment>(
  {
    amount: { type: Number, required: true, min: 0.01 },
    method: { type: String, enum: ["cash", "upi", "bank_transfer", "cheque", "credit", "other", "credit_note"], required: true },
    paidAt: { type: Date, required: true, default: Date.now },
    note: { type: String, trim: true },
  },
  { _id: false }
);

const partySnapshotSchema = new Schema<SellerSnapshot>(
  {
    name: { type: String, trim: true },
    phone: { type: String, trim: true },
    gstin: { type: String, trim: true },
    address: { type: String, trim: true },
    stateCode: { type: String, trim: true },
    upiId: { type: String, trim: true },
    bankName: { type: String, trim: true },
    bankAccount: { type: String, trim: true },
    bankIfsc: { type: String, trim: true },
    terms: { type: String, trim: true },
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
    // Cancelled bills stay on record (numbering has no gaps) but count nowhere.
    status: { type: String, enum: ["active", "cancelled"], default: "active", index: true },
    items: { type: [invoiceLineItemSchema], required: true },
    subtotal: { type: Number, required: true },
    discountTotal: { type: Number, default: 0 },
    taxTotal: { type: Number, required: true },
    cgstTotal: { type: Number, default: 0 },
    sgstTotal: { type: Number, default: 0 },
    igstTotal: { type: Number, default: 0 },
    roundOff: { type: Number, default: 0 },
    totalAmount: { type: Number, required: true },
    amountPaid: { type: Number, required: true, default: 0 },
    paymentStatus: { type: String, enum: ["unpaid", "partial", "paid"], default: "unpaid" },
    payments: { type: [invoicePaymentSchema], default: [] },
    isInterState: { type: Boolean, default: false },
    seller: { type: partySnapshotSchema },
    buyer: { type: partySnapshotSchema },
    dueDate: { type: Date },
    cancelledAt: { type: Date },
    cancelReason: { type: String, trim: true },
    createdBy: { type: Schema.Types.ObjectId, ref: "User", required: true },
  },
  { timestamps: true }
);

invoiceSchema.index({ tenantId: 1, invoiceNumber: 1 }, { unique: true });
invoiceSchema.index({ tenantId: 1, createdAt: -1 });

/** Filter for bills that count in totals (old bills have no status = active). */
export const ACTIVE_INVOICE = { status: { $ne: "cancelled" } } as const;

export const Invoice = model<InvoiceDocument>("Invoice", invoiceSchema);
