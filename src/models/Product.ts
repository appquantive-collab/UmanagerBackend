import { Schema, model, Types } from "mongoose";

// A BOM line references another Product (one flagged isRawMaterial: true) and
// how much of it goes into one unit of the finished product. Raw materials
// are ordinary Product documents — same StockMovement ledger, same
// purchase-price/unit fields — just flagged so they render in their own
// "Raw Materials" tab instead of the sellable catalog.
export interface BomLine {
  rawMaterialId: Types.ObjectId;
  quantity: number;
  unit: string;
}

export interface ProductDocument {
  _id: Types.ObjectId;
  tenantId: Types.ObjectId;
  name: string;
  sku: string;
  barcode?: string;
  category?: string;
  brand?: string;
  imageUrl?: string;
  unit: string;
  hsn?: string;
  gstPercent?: number;
  purchasePrice: number;
  wholesalePrice: number;
  retailPrice: number;
  minimumPrice?: number;
  reorderLevel: number;
  isActive: boolean;
  isRawMaterial: boolean;
  bom: BomLine[];
  createdAt: Date;
  updatedAt: Date;
}

const bomLineSchema = new Schema<BomLine>(
  {
    rawMaterialId: { type: Schema.Types.ObjectId, ref: "Product", required: true },
    quantity: { type: Number, required: true, min: 0.001 },
    unit: { type: String, required: true, default: "pcs" },
  },
  { _id: false }
);

const productSchema = new Schema<ProductDocument>(
  {
    tenantId: { type: Schema.Types.ObjectId, ref: "Tenant", required: true, index: true },
    name: { type: String, required: true, trim: true },
    sku: { type: String, required: true, trim: true },
    barcode: { type: String, trim: true },
    category: { type: String, trim: true },
    brand: { type: String, trim: true },
    imageUrl: { type: String, trim: true },
    unit: { type: String, required: true, default: "pcs" },
    hsn: { type: String, trim: true },
    gstPercent: { type: Number, default: 0 },
    purchasePrice: { type: Number, required: true, default: 0 },
    wholesalePrice: { type: Number, required: true, default: 0 },
    retailPrice: { type: Number, required: true, default: 0 },
    minimumPrice: { type: Number },
    reorderLevel: { type: Number, default: 0 },
    isActive: { type: Boolean, default: true },
    isRawMaterial: { type: Boolean, default: false, index: true },
    bom: { type: [bomLineSchema], default: [] },
  },
  { timestamps: true }
);

productSchema.index({ tenantId: 1, sku: 1 }, { unique: true });

export const Product = model<ProductDocument>("Product", productSchema);
