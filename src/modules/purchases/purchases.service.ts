import mongoose, { Types } from "mongoose";
import { Purchase, type PurchaseLineItem } from "../../models/Purchase";
import type { PaymentMethod } from "../../models/Invoice";
import { Product } from "../../models/Product";
import { StockMovement } from "../../models/StockMovement";
import { Supplier } from "../../models/Supplier";
import { Warehouse } from "../../models/Warehouse";
import { round3, serialsInStock, toBaseQty } from "../stock/ledger";

export class PurchaseError extends Error {
  constructor(
    message: string,
    readonly status = 400
  ) {
    super(message);
    this.name = "PurchaseError";
  }
}

export interface CreatePurchaseInput {
  supplierId: string;
  warehouseId?: string;
  supplierBillNumber?: string;
  purchasedAt?: string;
  note?: string;
  items: {
    productId: string;
    quantity: number;
    unitCost: number;
    gstPercent?: number;
    /** The product's base unit or its bigger pack (e.g. "box"). */
    unit?: string;
    batchNo?: string;
    expiryDate?: string;
    serials?: string[];
  }[];
  payment?: { amount: number; method: PaymentMethod };
}

async function resolveWarehouse(tenantId: string, warehouseId?: string) {
  if (warehouseId) {
    const warehouse = await Warehouse.findOne({ _id: warehouseId, tenantId, isActive: true });
    if (!warehouse) throw new PurchaseError("Warehouse not found", 404);
    return warehouse;
  }
  const fallback =
    (await Warehouse.findOne({ tenantId, isActive: true, isDefault: true })) ??
    (await Warehouse.findOne({ tenantId, isActive: true }).sort({ createdAt: 1 }));
  return fallback ?? Warehouse.create({ tenantId, name: "Main Warehouse", isDefault: true });
}

// PUR-0001, PUR-0002, ... per business (same scheme as invoices).
async function nextPurchaseNumber(tenantId: string): Promise<string> {
  const count = await Purchase.countDocuments({ tenantId });
  return `PUR-${String(count + 1).padStart(4, "0")}`;
}

export async function createPurchase(tenantId: string, userId: string, input: CreatePurchaseInput) {
  const supplier = await Supplier.findOne({ _id: input.supplierId, tenantId });
  if (!supplier) throw new PurchaseError("Supplier not found", 404);
  const warehouse = await resolveWarehouse(tenantId, input.warehouseId);

  const productIds = [...new Set(input.items.map((i) => i.productId))];
  const products = await Product.find({ _id: { $in: productIds }, tenantId });
  const productById = new Map(products.map((p) => [String(p._id), p]));
  const missing = productIds.filter((id) => !productById.has(id));
  if (missing.length > 0) throw new PurchaseError("Some products were not found. Please refresh and try again.", 404);

  // Batch items need a batch; serial items need one IMEI per piece that isn't already in stock.
  const extras = new Map<number, { baseQty: number; batchNo?: string; expiryDate?: Date; serials?: string[] }>();
  for (const [index, item] of input.items.entries()) {
    const product = productById.get(item.productId)!;
    const unit = item.unit?.trim() || product.unit;
    const baseQty = toBaseQty(product, item.quantity, unit);
    const extra: { baseQty: number; batchNo?: string; expiryDate?: Date; serials?: string[] } = { baseQty };
    if (product.trackBatch) {
      if (!item.batchNo?.trim()) throw new PurchaseError(`Enter the batch number for ${product.name}`);
      extra.batchNo = item.batchNo.trim().toUpperCase();
      if (item.expiryDate) extra.expiryDate = new Date(item.expiryDate);
    }
    if (product.trackSerial) {
      const serials = [...new Set((item.serials ?? []).map((s) => s.trim().toUpperCase()).filter(Boolean))];
      if (serials.length !== baseQty) throw new PurchaseError(`Enter ${baseQty} IMEI/serial number(s) for ${product.name}`);
      const inStock = await serialsInStock(tenantId, product._id);
      const dupes = serials.filter((s) => inStock.has(s));
      if (dupes.length) throw new PurchaseError(`Already in stock: ${dupes.join(", ")}`);
      extra.serials = serials;
    }
    extras.set(index, extra);
  }

  const items: PurchaseLineItem[] = input.items.map((item, index) => {
    const product = productById.get(item.productId)!;
    const gstPercent = item.gstPercent ?? product.gstPercent ?? 0;
    const lineSubtotal = item.quantity * item.unitCost;
    const lineTax = (lineSubtotal * gstPercent) / 100;
    const extra = extras.get(index)!;
    return {
      productId: product._id,
      productName: product.name,
      quantity: item.quantity,
      unit: item.unit?.trim() || product.unit,
      unitCost: item.unitCost,
      gstPercent,
      lineSubtotal,
      lineTax,
      lineTotal: lineSubtotal + lineTax,
      batchNo: extra.batchNo,
      expiryDate: extra.expiryDate,
      serials: extra.serials,
    };
  });

  const subtotal = items.reduce((sum, i) => sum + i.lineSubtotal, 0);
  const taxTotal = items.reduce((sum, i) => sum + i.lineTax, 0);
  const totalAmount = subtotal + taxTotal;

  const payment = input.payment && input.payment.amount > 0 ? input.payment : undefined;
  if (payment && payment.amount > totalAmount + 0.01) {
    throw new PurchaseError("Paid amount can't be more than the purchase total");
  }
  const amountPaid = payment?.amount ?? 0;

  const purchasedAt = input.purchasedAt ? new Date(input.purchasedAt) : new Date();

  const purchaseData = {
    tenantId,
    supplierId: supplier._id,
    warehouseId: warehouse._id,
    supplierBillNumber: input.supplierBillNumber,
    items,
    subtotal,
    taxTotal,
    totalAmount,
    amountPaid,
    paymentStatus: amountPaid <= 0 ? "unpaid" : amountPaid >= totalAmount - 0.01 ? "paid" : "partial",
    payments: payment ? [{ amount: payment.amount, method: payment.method, paidAt: purchasedAt }] : [],
    purchasedAt,
    note: input.note,
    createdBy: userId,
  } as const;

  // Two purchases saved at the same moment can race for the same number; the
  // unique index rejects the second, so take the next number and retry once.
  let purchase;
  try {
    purchase = await Purchase.create({ ...purchaseData, purchaseNumber: await nextPurchaseNumber(tenantId) });
  } catch (err) {
    if ((err as { code?: number }).code !== 11000) throw err;
    purchase = await Purchase.create({ ...purchaseData, purchaseNumber: await nextPurchaseNumber(tenantId) });
  }

  // Goods in: one stock entry per line, tied back to this purchase.
  await StockMovement.insertMany(
    items
      .map((i, index) => ({ i, extra: extras.get(index)! }))
      .filter(({ extra }) => extra.baseQty > 0)
      .map(({ i, extra }) => ({
        tenantId,
        productId: i.productId,
        warehouseId: warehouse._id,
        quantity: round3(extra.baseQty),
        batchNo: extra.batchNo,
        expiryDate: extra.expiryDate,
        serials: extra.serials,
        movementType: "purchase",
        referenceId: String(purchase._id),
        note: `${purchase.purchaseNumber} · ${supplier.name}`,
        createdBy: userId,
      }))
  );

  // Keep each product's cost price current with what was actually paid.
  // (cost per base unit: a box at ₹120 with 12 pcs → ₹10 per pc)
  await Promise.all(
    items.map((i, index) => {
      const baseQty = extras.get(index)!.baseQty;
      const perBase = baseQty > 0 ? (i.unitCost * i.quantity) / baseQty : i.unitCost;
      return Product.updateOne({ _id: i.productId, tenantId }, { $set: { purchasePrice: Math.round(perBase * 100) / 100 } });
    })
  );

  return purchase;
}

export async function listPurchases(tenantId: string) {
  return Purchase.find({ tenantId })
    .sort({ purchasedAt: -1, createdAt: -1 })
    .limit(500)
    .populate("supplierId", "name phone gstin")
    .populate("warehouseId", "name");
}

export async function getPurchase(tenantId: string, purchaseId: string) {
  const purchase = await Purchase.findOne({ _id: purchaseId, tenantId })
    .populate("supplierId", "name phone gstin")
    .populate("warehouseId", "name");
  if (!purchase) throw new PurchaseError("Purchase not found", 404);
  return purchase;
}

export async function recordPurchasePayment(
  tenantId: string,
  purchaseId: string,
  amount: number,
  method: PaymentMethod,
  note?: string
) {
  const purchase = await Purchase.findOne({ _id: purchaseId, tenantId });
  if (!purchase) throw new PurchaseError("Purchase not found", 404);
  if (purchase.paymentStatus === "paid") throw new PurchaseError("This purchase is already fully paid");

  const remaining = purchase.totalAmount - purchase.amountPaid;
  if (amount > remaining + 0.01) throw new PurchaseError(`Payment is more than the ₹${remaining.toFixed(2)} still due`);

  purchase.payments.push({ amount, method, paidAt: new Date(), note });
  purchase.amountPaid += amount;
  purchase.paymentStatus = purchase.amountPaid >= purchase.totalAmount - 0.01 ? "paid" : "partial";
  await purchase.save();
  return getPurchase(tenantId, purchaseId);
}

/** Per-supplier totals for the Suppliers page: bought, still owed, last purchase. */
export async function supplierPurchaseStats(tenantId: string) {
  const rows = await Purchase.aggregate([
    { $match: { tenantId: new mongoose.Types.ObjectId(tenantId) } },
    {
      $group: {
        _id: "$supplierId",
        totalPurchased: { $sum: "$totalAmount" },
        outstanding: { $sum: { $subtract: ["$totalAmount", "$amountPaid"] } },
        purchaseCount: { $sum: 1 },
        lastPurchaseAt: { $max: "$purchasedAt" },
      },
    },
  ]);
  return new Map(
    rows.map((r) => [
      String(r._id as Types.ObjectId),
      {
        totalPurchased: r.totalPurchased as number,
        outstanding: Math.max(0, r.outstanding as number),
        purchaseCount: r.purchaseCount as number,
        lastPurchaseAt: r.lastPurchaseAt as Date,
      },
    ])
  );
}
