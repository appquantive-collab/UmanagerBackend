import { z } from "zod";

export const billLineItemSchema = z.object({
  orderId: z.string().optional(),
  productId: z.string().optional(),
  productName: z.string().min(1),
  quantity: z.number().positive(),
  unit: z.string().min(1).default("pcs"),
  unitPrice: z.number().min(0),
  discountPercent: z.number().min(0).max(100).optional(),
  serials: z.array(z.string().trim().min(1).max(40)).max(500).optional(),
});

export const createBillSchema = z.object({
  // Leave out for a walk-in counter sale.
  customerId: z.string().min(1).optional(),
  orderIds: z.array(z.string()).default([]),
  items: z.array(billLineItemSchema).min(1),
  billType: z.enum(["gst", "record"]),
  dueDate: z.string().datetime().optional(),
  roundOff: z.boolean().optional(),
  allowShortStock: z.boolean().optional(),
  allowOverCreditLimit: z.boolean().optional(),
  payment: z
    .object({ amount: z.number().min(0), method: z.enum(["cash", "upi", "bank_transfer", "cheque", "credit", "other"]) })
    .optional(),
});

export const recordPaymentSchema = z.object({
  amount: z.number().positive(),
  method: z.enum(["cash", "upi", "bank_transfer", "cheque", "credit", "other"]),
  note: z.string().max(500).optional(),
});

export const cancelBillSchema = z.object({
  reason: z.string().max(300).optional(),
});
