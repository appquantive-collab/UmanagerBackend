import { z } from "zod";

export const createMovementSchema = z.object({
  productId: z.string().min(1),
  warehouseId: z.string().min(1),
  // Positive to add stock, negative to reduce it — the sign is the source of truth.
  quantity: z.number().int().refine((v) => v !== 0, "quantity must not be zero"),
  movementType: z.enum([
    "opening",
    "purchase",
    "sale",
    "customer_return",
    "supplier_return",
    "adjustment",
    "damage",
    "transfer_in",
    "transfer_out",
  ]),
  note: z.string().optional(),
  referenceId: z.string().optional(),
});
