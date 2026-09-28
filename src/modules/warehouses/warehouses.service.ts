import { Types } from "mongoose";
import { Warehouse } from "../../models/Warehouse";
import { Product } from "../../models/Product";
import { StockMovement } from "../../models/StockMovement";

export interface WarehouseListItem {
  _id: string;
  name: string;
  location?: string;
  isDefault: boolean;
  isActive: boolean;
  stockValue: number;
  skuCount: number;
  createdAt: string;
}

// Powers the Warehouses list — stock value and SKU count are derived from the
// same StockMovement ledger the Stock page uses, never a stored counter.
export async function listWarehousesWithStats(tenantId: string): Promise<WarehouseListItem[]> {
  const tenantObjectId = new Types.ObjectId(tenantId);

  let warehouses = await Warehouse.find({ tenantId, isActive: true }).sort({ isDefault: -1, name: 1 }).lean();
  if (warehouses.length === 0) {
    const created = await Warehouse.create({ tenantId, name: "Main Warehouse", isDefault: true });
    warehouses = [created.toObject()];
  }

  const [movementTotals, products] = await Promise.all([
    StockMovement.aggregate([
      { $match: { tenantId: tenantObjectId } },
      { $group: { _id: { warehouseId: "$warehouseId", productId: "$productId" }, quantity: { $sum: "$quantity" } } },
    ]),
    Product.find({ tenantId }, { wholesalePrice: 1 }).lean(),
  ]);

  const priceByProductId = new Map(products.map((p) => [String(p._id), p.wholesalePrice]));

  const statsByWarehouseId = new Map<string, { stockValue: number; skuCount: number }>();
  for (const row of movementTotals) {
    if (row.quantity <= 0) continue;
    const warehouseId = String(row._id.warehouseId);
    const productId = String(row._id.productId);
    const price = priceByProductId.get(productId) ?? 0;
    const entry = statsByWarehouseId.get(warehouseId) ?? { stockValue: 0, skuCount: 0 };
    entry.stockValue += row.quantity * price;
    entry.skuCount += 1;
    statsByWarehouseId.set(warehouseId, entry);
  }

  return warehouses.map((w) => {
    const stats = statsByWarehouseId.get(String(w._id));
    return {
      _id: String(w._id),
      name: w.name,
      location: w.location,
      isDefault: w.isDefault,
      isActive: w.isActive,
      stockValue: stats?.stockValue ?? 0,
      skuCount: stats?.skuCount ?? 0,
      createdAt: w.createdAt.toISOString(),
    };
  });
}
