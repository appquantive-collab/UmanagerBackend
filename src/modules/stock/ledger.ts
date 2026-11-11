import mongoose, { Types } from "mongoose";
import { StockMovement } from "../../models/StockMovement";
import { Warehouse } from "../../models/Warehouse";
import type { ProductDocument } from "../../models/Product";

/**
 * Shared stock-ledger reads used by billing, returns and purchases.
 * Stock is never stored — it is always the sum of movements, grouped here by
 * warehouse and batch so sales can take the right goods out.
 */

export interface StockBucket {
  warehouseId: string;
  batchNo?: string;
  expiryDate?: Date;
  qty: number;
}

export const round3 = (n: number) => Math.round(n * 1000) / 1000;

/** Quantity in the product's base unit (e.g. 2 box × 12 = 24 pcs). */
export function toBaseQty(product: Pick<ProductDocument, "unit" | "altUnit">, quantity: number, unit?: string): number {
  const alt = product.altUnit;
  if (alt && unit && unit.trim().toLowerCase() === alt.name.trim().toLowerCase() && unit !== product.unit) {
    return round3(quantity * alt.factor);
  }
  return quantity;
}

/** Stock of each product, split by warehouse and batch. */
export async function stockBuckets(tenantId: string, productIds: Types.ObjectId[]): Promise<Map<string, StockBucket[]>> {
  if (productIds.length === 0) return new Map();
  const rows = await StockMovement.aggregate([
    { $match: { tenantId: new mongoose.Types.ObjectId(tenantId), productId: { $in: productIds } } },
    {
      $group: {
        _id: { productId: "$productId", warehouseId: "$warehouseId", batchNo: { $ifNull: ["$batchNo", null] } },
        qty: { $sum: "$quantity" },
        expiryDate: { $max: "$expiryDate" },
      },
    },
  ]);
  const map = new Map<string, StockBucket[]>();
  for (const row of rows) {
    const key = String(row._id.productId);
    const list = map.get(key) ?? [];
    list.push({
      warehouseId: String(row._id.warehouseId),
      batchNo: row._id.batchNo ?? undefined,
      expiryDate: row.expiryDate ?? undefined,
      qty: round3(row.qty),
    });
    map.set(key, list);
  }
  return map;
}

export const totalOf = (buckets: StockBucket[] | undefined) => round3((buckets ?? []).reduce((s, b) => s + b.qty, 0));

/**
 * Which warehouse each in-stock serial (IMEI) is in. A serial is in stock when
 * it has come in more times than it has gone out.
 */
export async function serialsInStock(tenantId: string, productId: Types.ObjectId): Promise<Map<string, string>> {
  const rows = await StockMovement.aggregate([
    { $match: { tenantId: new mongoose.Types.ObjectId(tenantId), productId, serials: { $exists: true, $ne: [] } } },
    { $sort: { createdAt: 1 } },
    { $unwind: "$serials" },
    {
      $group: {
        _id: "$serials",
        net: { $sum: { $cond: [{ $gt: ["$quantity", 0] }, 1, -1] } },
        warehouseId: { $last: { $cond: [{ $gt: ["$quantity", 0] }, "$warehouseId", null] } },
      },
    },
    { $match: { net: { $gt: 0 } } },
  ]);
  return new Map(rows.map((r) => [String(r._id), r.warehouseId ? String(r.warehouseId) : ""]));
}

export async function defaultWarehouseId(tenantId: string): Promise<Types.ObjectId> {
  const warehouse =
    (await Warehouse.findOne({ tenantId, isActive: true, isDefault: true })) ??
    (await Warehouse.findOne({ tenantId, isActive: true }).sort({ createdAt: 1 })) ??
    (await Warehouse.create({ tenantId, name: "Main Warehouse", isDefault: true }));
  return warehouse._id;
}

/**
 * Plan which stock a sale takes: main warehouse first, then oldest expiry
 * first (FEFO) within it, then other warehouses the same way. Whatever can't
 * be covered (the shop chose "Bill anyway") comes from the main warehouse and
 * shows as minus stock until corrected.
 */
export function planTake(buckets: StockBucket[], quantity: number, mainId: string): StockBucket[] {
  const sorted = [...buckets]
    .filter((b) => b.qty > 1e-9)
    .sort((a, b) => {
      const main = Number(b.warehouseId === mainId) - Number(a.warehouseId === mainId);
      if (main !== 0) return main;
      const ea = a.expiryDate ? new Date(a.expiryDate).getTime() : Infinity;
      const eb = b.expiryDate ? new Date(b.expiryDate).getTime() : Infinity;
      if (ea !== eb) return ea - eb;
      return b.qty - a.qty;
    });
  const plan: StockBucket[] = [];
  let remaining = quantity;
  for (const bucket of sorted) {
    if (remaining <= 1e-9) break;
    const take = round3(Math.min(remaining, bucket.qty));
    if (take <= 0) continue;
    plan.push({ ...bucket, qty: take });
    bucket.qty = round3(bucket.qty - take);
    remaining = round3(remaining - take);
  }
  if (remaining > 1e-9) plan.push({ warehouseId: mainId, qty: remaining });
  return plan;
}
