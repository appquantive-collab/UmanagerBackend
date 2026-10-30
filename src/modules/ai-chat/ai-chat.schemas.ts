import { z } from "zod";

export const sendMessageSchema = z.object({
  content: z.string().min(1).max(1000),
});

export const markAttendanceActionSchema = z.object({
  staffName: z.string().min(1),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  status: z.enum(["present", "absent", "half_day", "leave"]),
});

export const createOrderActionSchema = z.object({
  customerName: z.string().min(1),
  items: z
    .array(
      z.object({
        productName: z.string().min(1),
        quantity: z.number().positive(),
        unit: z.string().min(1).default("pcs"),
        unitPrice: z.number().min(0).default(0),
      })
    )
    .min(1),
});
