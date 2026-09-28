import { z } from "zod";

export const parseOrderTextSchema = z.object({
  text: z.string().min(3).max(2000),
});

export const orderLineItemInputSchema = z.object({
  productId: z.string().optional(), // present if matched to an existing product
  productName: z.string().min(1),
  quantity: z.number().positive(),
  unit: z.string().min(1).default("pcs"),
  unitPrice: z.number().min(0),
  isNewProduct: z.boolean().default(false),
});

export const createOrderSchema = z.object({
  customerId: z.string().min(1),
  items: z.array(orderLineItemInputSchema).min(1),
  notes: z.string().max(1000).optional(),
  source: z.enum(["manual", "ai_parsed"]).default("manual"),
  rawText: z.string().max(2000).optional(),
});

export const updateOrderSchema = z.object({
  items: z.array(orderLineItemInputSchema).min(1).optional(),
  notes: z.string().max(1000).optional(),
});

export const updateOrderStatusSchema = z.object({
  status: z.enum(["pending", "confirmed", "cancelled"]),
});
