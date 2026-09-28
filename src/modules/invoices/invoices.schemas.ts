import { z } from "zod";

export const billLineItemSchema = z.object({
  productId: z.string().optional(),
  productName: z.string().min(1),
  quantity: z.number().positive(),
  unit: z.string().min(1).default("pcs"),
  unitPrice: z.number().min(0),
});

export const createBillSchema = z.object({
  customerId: z.string().min(1),
  orderIds: z.array(z.string()).default([]),
  items: z.array(billLineItemSchema).min(1),
  billType: z.enum(["gst", "record"]),
  dueDate: z.string().datetime().optional(),
});

export const recordPaymentSchema = z.object({
  amount: z.number().positive(),
  method: z.enum(["cash", "upi", "bank_transfer", "cheque", "credit", "other"]),
  note: z.string().max(500).optional(),
});
