import { Types } from "mongoose";
import { Customer } from "../../models/Customer";
import { Product } from "../../models/Product";
import { Order, type OrderStatus } from "../../models/Order";
import { parseOrderText, type ParsedOrder } from "./order-parser.service";
import { generateSku } from "../../utils/sku";
import { getProducibleQuantity } from "../assembly/assembly.service";
import type { z } from "zod";
import type { createOrderSchema, updateOrderSchema } from "./orders.schemas";

type CreateOrderInput = z.infer<typeof createOrderSchema>;
type UpdateOrderInput = z.infer<typeof updateOrderSchema>;

export interface ParsePreviewItem {
  productId: string | null;
  productName: string;
  quantity: number;
  unit: string;
  unitPrice: number;
  isNewProduct: boolean;
}

export interface ParsePreview {
  partyName: string | null;
  matchedCustomers: { id: string; name: string; phone?: string }[];
  items: ParsePreviewItem[];
}

// Preview only: never writes anything. Matches against the tenant's real
// product catalog so the model can recognize existing SKUs by meaning, and
// separately looks up customer name candidates — but nothing is created here.
// Customer creation always stays an explicit user action (see saveOrder).
export async function previewOrderFromText(tenantId: string, text: string): Promise<ParsePreview> {
  const products = await Product.find({ tenantId, isActive: true }, { name: 1 }).lean();
  const catalog = products.map((p) => ({ id: String(p._id), name: p.name }));

  const parsed: ParsedOrder = await parseOrderText(text, catalog);

  const matchedCustomers = parsed.partyName
    ? await Customer.find(
        { tenantId, name: { $regex: escapeRegex(parsed.partyName), $options: "i" }, isActive: true },
        { name: 1, phone: 1 }
      ).limit(5)
    : [];

  const productById = new Map(products.map((p) => [String(p._id), p]));

  const items: ParsePreviewItem[] = parsed.items.map((item) => {
    const matched = item.matchedProductId ? productById.get(item.matchedProductId) : null;
    return {
      productId: matched ? String(matched._id) : null,
      productName: matched ? matched.name : item.productName,
      quantity: item.quantity,
      unit: item.unit,
      unitPrice: matched?.wholesalePrice ?? 0,
      isNewProduct: !matched,
    };
  });

  return {
    partyName: parsed.partyName,
    matchedCustomers: matchedCustomers.map((c) => ({ id: String(c._id), name: c.name, phone: c.phone })),
    items,
  };
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function resolveOrderItems(tenantId: string, items: CreateOrderInput["items"]) {
  const resolvedItems = [];
  for (const item of items) {
    let productId: Types.ObjectId;
    let wasAutoCreated = false;

    if (item.productId && !item.isNewProduct) {
      const existing = await Product.findOne({ _id: item.productId, tenantId });
      if (!existing) {
        throw new Error(`Product ${item.productId} not found`);
      }
      productId = existing._id;
    } else {
      const created = await Product.create({
        tenantId,
        name: item.productName,
        sku: generateSku(item.productName),
        unit: item.unit,
        purchasePrice: 0,
        wholesalePrice: item.unitPrice,
        retailPrice: item.unitPrice,
        reorderLevel: 0,
      });
      productId = created._id;
      wasAutoCreated = true;
    }

    resolvedItems.push({
      productId,
      productName: item.productName,
      quantity: item.quantity,
      unit: item.unit,
      unitPrice: item.unitPrice,
      wasAutoCreated,
    });
  }
  return resolvedItems;
}

export interface RawMaterialWarning {
  productId: string;
  productName: string;
  orderedQuantity: number;
  producibleQuantity: number;
}

// Checked after saving, never before — an order always saves regardless of
// raw material availability (per product decision: warn, don't block). Only
// products with a configured BOM are checked; everything else is skipped.
async function checkRawMaterialAvailability(
  tenantId: string,
  items: { productId: Types.ObjectId; productName: string; quantity: number }[]
): Promise<RawMaterialWarning[]> {
  const warnings: RawMaterialWarning[] = [];
  for (const item of items) {
    const product = await Product.findOne({ _id: item.productId, tenantId }, { bom: 1 });
    if (!product || product.bom.length === 0) continue;

    const { producibleQuantity } = await getProducibleQuantity(tenantId, String(item.productId));
    if (producibleQuantity < item.quantity) {
      warnings.push({
        productId: String(item.productId),
        productName: item.productName,
        orderedQuantity: item.quantity,
        producibleQuantity,
      });
    }
  }
  return warnings;
}

// Saving is where products actually get created — the user has already reviewed
// and confirmed (or edited) every flagged item by this point.
export async function saveOrder(tenantId: string, userId: string, input: CreateOrderInput) {
  const customer = await Customer.findOne({ _id: input.customerId, tenantId });
  if (!customer) {
    throw new Error("Customer not found");
  }

  const resolvedItems = await resolveOrderItems(tenantId, input.items);
  const totalAmount = resolvedItems.reduce((sum, i) => sum + i.quantity * i.unitPrice, 0);

  const order = await Order.create({
    tenantId,
    customerId: customer._id,
    items: resolvedItems,
    totalAmount,
    status: "pending",
    source: input.source,
    rawText: input.rawText,
    notes: input.notes,
    createdBy: userId,
  });

  const rawMaterialWarnings = await checkRawMaterialAvailability(tenantId, resolvedItems);

  return { order, rawMaterialWarnings };
}

// Orders can only be edited before they've been billed or cancelled — once
// delivered (billed) or cancelled, the order is a closed historical record.
export async function updateOrder(tenantId: string, orderId: string, input: UpdateOrderInput) {
  const order = await Order.findOne({ _id: orderId, tenantId });
  if (!order) {
    throw new Error("Order not found");
  }
  if (order.status === "delivered" || order.status === "cancelled") {
    throw new Error(`Cannot edit an order that is already ${order.status}`);
  }

  if (input.items) {
    const resolvedItems = await resolveOrderItems(tenantId, input.items);
    order.items = resolvedItems;
    order.totalAmount = resolvedItems.reduce((sum, i) => sum + i.quantity * i.unitPrice, 0);
  }
  if (input.notes !== undefined) {
    order.notes = input.notes;
  }

  await order.save();
  return order;
}

const ALLOWED_STATUS_TRANSITIONS: Record<OrderStatus, OrderStatus[]> = {
  pending: ["confirmed", "cancelled"],
  confirmed: ["pending", "cancelled"],
  delivered: [],
  cancelled: [],
};

export async function updateOrderStatus(tenantId: string, orderId: string, status: OrderStatus) {
  const order = await Order.findOne({ _id: orderId, tenantId });
  if (!order) {
    throw new Error("Order not found");
  }
  if (!ALLOWED_STATUS_TRANSITIONS[order.status].includes(status)) {
    throw new Error(`Cannot move an order from ${order.status} to ${status}`);
  }

  order.status = status;
  await order.save();
  return order;
}
