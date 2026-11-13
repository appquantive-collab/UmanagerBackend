import { z } from "zod";

export const invoiceNumberSchema = z
  .string()
  .trim()
  .min(1)
  .max(30)
  .regex(/^[A-Za-z0-9][A-Za-z0-9/_.-]*$/, "Bill number can use letters, numbers and / - _ .");

export const renumberBillSchema = z.object({ invoiceNumber: invoiceNumberSchema });
export const archiveBillSchema = z.object({ archived: z.boolean() });

export const billLineItemSchema = z.object({
  orderId: z.string().optional(),
  productId: z.string().optional(),
  productName: z.string().min(1),
  quantity: z.number().positive(),
  unit: z.string().min(1).default("pcs"),
  unitPrice: z.number().min(0),
  discountPercent: z.number().min(0).max(100).optional(),
  /** GST % chosen on the bill; defaults to the item's saved rate. */
  gstPercent: z.number().min(0).max(40).optional(),
  serials: z.array(z.string().trim().min(1).max(40)).max(500).optional(),
});

export const createBillSchema = z.object({
  // Leave out for a walk-in counter sale.
  customerId: z.string().min(1).optional(),
  orderIds: z.array(z.string()).default([]),
  items: z.array(billLineItemSchema).min(1),
  billType: z.enum(["gst", "record"]),
  /** Own bill number (e.g. AM/2026/014). Left out → the next number in the series. */
  invoiceNumber: invoiceNumberSchema.optional(),
  dueDate: z.string().datetime().optional(),
  roundOff: z.boolean().optional(),
  allowShortStock: z.boolean().optional(),
  allowOverCreditLimit: z.boolean().optional(),
  payment: z
    .object({ amount: z.number().min(0), method: z.enum(["cash", "upi", "bank_transfer", "cheque", "credit", "other"]) })
    .optional(),
});

/** Edit a bill: like a new bill, minus customer, orders and payment. */
export const editBillSchema = createBillSchema.omit({ customerId: true, orderIds: true, payment: true });

export const recordPaymentSchema = z.object({
  amount: z.number().positive(),
  method: z.enum(["cash", "upi", "bank_transfer", "cheque", "credit", "other"]),
  note: z.string().max(500).optional(),
});

export const cancelBillSchema = z.object({
  reason: z.string().max(300).optional(),
});
