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

/** A bigger pack the item is also bought/sold in, e.g. 1 box = 12 pcs. Stock is always kept in the base unit. */
export interface AltUnit {
  name: string;
  factor: number;
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
  altUnit?: AltUnit;
  /** Medicines, food, cosmetics: stock is kept per batch with an expiry date; oldest expiry sells first. */
  trackBatch: boolean;
  /** Mobiles, electronics: every piece has an IMEI/serial number recorded on purchase and sale. */
  trackSerial: boolean;
  /** Garments/footwear: items that are sizes/colours of one design share a group name. */
  variantGroup?: string;
  size?: string;
  color?: string;
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
    altUnit: {
      type: new Schema<AltUnit>(
        {
          name: { type: String, required: true, trim: true },
          factor: { type: Number, required: true, min: 0.001 },
        },
        { _id: false }
      ),
    },
    trackBatch: { type: Boolean, default: false },
    trackSerial: { type: Boolean, default: false },
    variantGroup: { type: String, trim: true, index: true },
    size: { type: String, trim: true },
    color: { type: String, trim: true },
  },
  { timestamps: true }
);

productSchema.index({ tenantId: 1, sku: 1 }, { unique: true });

export const Product = model<ProductDocument>("Product", productSchema);
