import { z } from "zod";

// Form fields left blank arrive as "" rather than absent, so treat an empty
// string the same as undefined for genuinely-optional text fields.
const optionalText = () =>
  z.preprocess((val) => (val === "" ? undefined : val), z.string().optional());

const bomLineSchema = z.object({
  rawMaterialId: z.string().min(1),
  quantity: z.number().positive(),
  unit: z.string().min(1).default("pcs"),
});

export const createProductSchema = z.object({
  name: z.string().min(1),
  sku: optionalText(),
  barcode: optionalText(),
  category: optionalText(),
  brand: optionalText(),
  imageUrl: optionalText(),
  unit: z.string().min(1).default("pcs"),
  hsn: optionalText(),
  gstPercent: z.number().min(0).max(100).optional(),
  purchasePrice: z.number().min(0),
  wholesalePrice: z.number().min(0),
  retailPrice: z.number().min(0),
  minimumPrice: z.number().min(0).optional(),
  reorderLevel: z.number().min(0).default(0),
  isRawMaterial: z.boolean().default(false),
  bom: z.array(bomLineSchema).default([]),
});

export const updateProductSchema = createProductSchema.partial();
