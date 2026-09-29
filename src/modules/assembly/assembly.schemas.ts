import { z } from "zod";

export const assembleSchema = z.object({
  productId: z.string().min(1),
  warehouseId: z.string().min(1),
  quantity: z.number().int().positive(),
  note: z.string().optional(),
});
