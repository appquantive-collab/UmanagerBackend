import { z } from "zod";

export const createSupplierSchema = z.object({
  name: z.string().min(1),
  phone: z.string().optional(),
  gstin: z.string().optional(),
});

export const updateSupplierSchema = createSupplierSchema.partial();
