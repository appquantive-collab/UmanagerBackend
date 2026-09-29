import { Schema, model, Types } from "mongoose";

// Every stock change is an immutable ledger entry — never overwrite a quantity
// directly on Product. Current stock is derived by summing movements.
// See CLAUDE.md section 24 (Inventory Engine) and 25 (Stock Movement).
export type StockMovementType =
  | "opening"
  | "purchase"
  | "sale"
  | "customer_return"
  | "supplier_return"
  | "adjustment"
  | "damage"
  | "transfer_in"
  | "transfer_out"
  | "assembly_consume"
  | "assembly_produce";

export interface StockMovementDocument {
  _id: Types.ObjectId;
  tenantId: Types.ObjectId;
  productId: Types.ObjectId;
  warehouseId: Types.ObjectId;
  quantity: number; // signed: positive increases stock, negative decreases it
  movementType: StockMovementType;
  note?: string;
  referenceId?: string;
  createdBy: Types.ObjectId;
  createdAt: Date;
}

const stockMovementSchema = new Schema<StockMovementDocument>(
  {
    tenantId: { type: Schema.Types.ObjectId, ref: "Tenant", required: true, index: true },
    productId: { type: Schema.Types.ObjectId, ref: "Product", required: true, index: true },
    warehouseId: { type: Schema.Types.ObjectId, ref: "Warehouse", required: true, index: true },
    quantity: { type: Number, required: true, validate: { validator: (v: number) => v !== 0, message: "quantity must not be zero" } },
    movementType: {
      type: String,
      enum: [
        "opening",
        "purchase",
        "sale",
        "customer_return",
        "supplier_return",
        "adjustment",
        "damage",
        "transfer_in",
        "transfer_out",
        "assembly_consume",
        "assembly_produce",
      ],
      required: true,
    },
    note: { type: String, trim: true },
    referenceId: { type: String, trim: true },
    createdBy: { type: Schema.Types.ObjectId, ref: "User", required: true },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

stockMovementSchema.index({ tenantId: 1, productId: 1, createdAt: -1 });

export const StockMovement = model<StockMovementDocument>("StockMovement", stockMovementSchema);
