import { z } from "zod";

export const createProductSchema = z.object({
  name: z.string().min(1),
  sku: z.string().min(1),
  barcode: z.string().optional(),
  category: z.string().optional(),
  brand: z.string().optional(),
  unit: z.string().min(1).default("pcs"),
  hsn: z.string().optional(),
  gstPercent: z.number().min(0).max(100).optional(),
  purchasePrice: z.number().min(0),
  wholesalePrice: z.number().min(0),
  retailPrice: z.number().min(0),
  minimumPrice: z.number().min(0).optional(),
  reorderLevel: z.number().min(0).default(0),
});

export const updateProductSchema = createProductSchema.partial();
