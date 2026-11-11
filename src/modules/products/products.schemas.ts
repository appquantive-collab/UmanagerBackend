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
  // null clears the bigger pack
  altUnit: z
    .object({ name: z.string().trim().min(1).max(20), factor: z.number().positive().max(100000) })
    .nullable()
    .optional(),
  trackBatch: z.boolean().optional(),
  trackSerial: z.boolean().optional(),
  variantGroup: optionalText(),
  size: optionalText(),
  color: optionalText(),
});

export const updateProductSchema = createProductSchema.partial();

/** One spreadsheet row. Numbers may arrive as text from CSV/Excel. */
const num = (fallback?: number) =>
  z.preprocess((v) => {
    if (v === "" || v === null || v === undefined) return fallback;
    const n = typeof v === "number" ? v : Number(String(v).replace(/[₹,\s]/g, ""));
    return Number.isFinite(n) ? n : v;
  }, fallback === undefined ? z.number().min(0).optional() : z.number().min(0));

export const importRowSchema = z.object({
  name: z.string().trim().min(1).max(120),
  sku: optionalText(),
  barcode: optionalText(),
  category: optionalText(),
  brand: optionalText(),
  unit: z.preprocess((v) => (v === "" || v == null ? "pcs" : v), z.string().trim().min(1).max(20)),
  hsn: optionalText(),
  gstPercent: num(),
  purchasePrice: num(0),
  wholesalePrice: num(),
  retailPrice: num(0),
  reorderLevel: num(),
  openingStock: num(),
});

export const importProductsSchema = z.object({
  rows: z.array(z.unknown()).min(1).max(3000),
  /** When a row matches an existing item (by SKU, barcode or exact name): update it, or leave it alone. */
  mode: z.enum(["update", "skip"]).default("update"),
});

export const createVariantsSchema = z.object({
  baseName: z.string().trim().min(1).max(100),
  sizes: z.array(z.string().trim().min(1).max(20)).max(30).default([]),
  colors: z.array(z.string().trim().min(1).max(30)).max(30).default([]),
  unit: z.string().trim().min(1).default("pcs"),
  category: optionalText(),
  brand: optionalText(),
  hsn: optionalText(),
  gstPercent: z.number().min(0).max(100).optional(),
  purchasePrice: z.number().min(0).default(0),
  wholesalePrice: z.number().min(0).default(0),
  retailPrice: z.number().min(0).default(0),
  reorderLevel: z.number().min(0).default(0),
});
