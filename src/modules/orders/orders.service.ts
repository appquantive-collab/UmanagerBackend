import { Types } from "mongoose";
import { Customer } from "../../models/Customer";
import { Product } from "../../models/Product";
import { Order } from "../../models/Order";
import { parseOrderText, type ParsedOrder } from "./order-parser.service";
import type { z } from "zod";
import type { createOrderSchema } from "./orders.schemas";

type CreateOrderInput = z.infer<typeof createOrderSchema>;

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

// Saving is where products actually get created — the user has already reviewed
// and confirmed (or edited) every flagged item by this point.
export async function saveOrder(tenantId: string, userId: string, input: CreateOrderInput) {
  const customer = await Customer.findOne({ _id: input.customerId, tenantId });
  if (!customer) {
    throw new Error("Customer not found");
  }

  const resolvedItems = [];
  for (const item of input.items) {
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

  return order;
}

function generateSku(name: string): string {
  const base = name
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 24);
  const suffix = Math.random().toString(36).slice(2, 6).toUpperCase();
  return `${base || "ITEM"}-${suffix}`;
}
