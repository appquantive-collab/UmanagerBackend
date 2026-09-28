import { Schema, model, Types } from "mongoose";

export type OrderStatus = "pending" | "confirmed" | "delivered" | "cancelled";
export type OrderSource = "manual" | "ai_parsed";

export interface OrderLineItem {
  productId: Types.ObjectId;
  productName: string;
  quantity: number;
  unit: string;
  unitPrice: number;
  wasAutoCreated: boolean;
}

export interface OrderDocument {
  _id: Types.ObjectId;
  tenantId: Types.ObjectId;
  customerId: Types.ObjectId;
  items: OrderLineItem[];
  totalAmount: number;
  status: OrderStatus;
  source: OrderSource;
  rawText?: string;
  notes?: string;
  createdBy: Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

const orderLineItemSchema = new Schema<OrderLineItem>(
  {
    productId: { type: Schema.Types.ObjectId, ref: "Product", required: true },
    productName: { type: String, required: true, trim: true },
    quantity: { type: Number, required: true, min: 0.001 },
    unit: { type: String, required: true, default: "pcs" },
    unitPrice: { type: Number, required: true, min: 0 },
    wasAutoCreated: { type: Boolean, default: false },
  },
  { _id: false }
);

const orderSchema = new Schema<OrderDocument>(
  {
    tenantId: { type: Schema.Types.ObjectId, ref: "Tenant", required: true, index: true },
    customerId: { type: Schema.Types.ObjectId, ref: "Customer", required: true, index: true },
    items: { type: [orderLineItemSchema], required: true, validate: { validator: (v: unknown[]) => v.length > 0, message: "Order must have at least one item" } },
    totalAmount: { type: Number, required: true, default: 0 },
    status: { type: String, enum: ["pending", "confirmed", "delivered", "cancelled"], default: "pending" },
    source: { type: String, enum: ["manual", "ai_parsed"], default: "manual" },
    rawText: { type: String, trim: true },
    notes: { type: String, trim: true },
    createdBy: { type: Schema.Types.ObjectId, ref: "User", required: true },
  },
  { timestamps: true }
);

orderSchema.index({ tenantId: 1, createdAt: -1 });

export const Order = model<OrderDocument>("Order", orderSchema);
