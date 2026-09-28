import { Router } from "express";
import mongoose from "mongoose";
import { StockMovement } from "../../models/StockMovement";
import { Product } from "../../models/Product";
import { Warehouse } from "../../models/Warehouse";
import { requireAuth, requireTenant } from "../../middleware/auth";
import { createMovementSchema } from "./stock.schemas";

export const stockRouter = Router();

stockRouter.use(requireAuth, requireTenant);

// Current stock per product, tenant-wide and broken down by warehouse.
// Derived by summing signed movements rather than trusting a stored counter.
stockRouter.get("/levels", async (req, res) => {
  const tenantId = new mongoose.Types.ObjectId(req.auth!.tenantId!);

  const totals = await StockMovement.aggregate([
    { $match: { tenantId } },
    {
      $group: {
        _id: { productId: "$productId", warehouseId: "$warehouseId" },
        quantity: { $sum: "$quantity" },
      },
    },
  ]);

  const byProduct = new Map<string, { total: number; warehouses: Record<string, number> }>();
  for (const row of totals) {
    const productId = String(row._id.productId);
    const warehouseId = String(row._id.warehouseId);
    const entry = byProduct.get(productId) ?? { total: 0, warehouses: {} };
    entry.total += row.quantity;
    entry.warehouses[warehouseId] = row.quantity;
    byProduct.set(productId, entry);
  }

  res.json(Object.fromEntries(byProduct));
});

stockRouter.get("/levels/:productId", async (req, res) => {
  const tenantId = new mongoose.Types.ObjectId(req.auth!.tenantId!);
  const productId = new mongoose.Types.ObjectId(req.params.productId);

  const totals = await StockMovement.aggregate([
    { $match: { tenantId, productId } },
    { $group: { _id: "$warehouseId", quantity: { $sum: "$quantity" } } },
  ]);

  const warehouses = Object.fromEntries(totals.map((row) => [String(row._id), row.quantity]));
  const total = totals.reduce((sum, row) => sum + row.quantity, 0);

  res.json({ total, warehouses });
});

stockRouter.get("/movements/:productId", async (req, res) => {
  const movements = await StockMovement.find({
    tenantId: req.auth!.tenantId,
    productId: req.params.productId,
  })
    .sort({ createdAt: -1 })
    .limit(100);

  res.json(movements);
});

stockRouter.post("/movements", async (req, res) => {
  const parsed = createMovementSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const { productId, warehouseId } = parsed.data;

  const [product, warehouse] = await Promise.all([
    Product.findOne({ _id: productId, tenantId: req.auth!.tenantId }),
    Warehouse.findOne({ _id: warehouseId, tenantId: req.auth!.tenantId }),
  ]);
  if (!product) return res.status(404).json({ error: "Product not found" });
  if (!warehouse) return res.status(404).json({ error: "Warehouse not found" });

  // Reductions (sales, damage, adjustments going down) must never take stock
  // negative — surface it as a validation error rather than silently allowing it.
  if (parsed.data.quantity < 0) {
    const existing = await StockMovement.aggregate([
      {
        $match: {
          tenantId: new mongoose.Types.ObjectId(req.auth!.tenantId!),
          productId: new mongoose.Types.ObjectId(productId),
          warehouseId: new mongoose.Types.ObjectId(warehouseId),
        },
      },
      { $group: { _id: null, quantity: { $sum: "$quantity" } } },
    ]);
    const currentQuantity = existing[0]?.quantity ?? 0;
    if (currentQuantity + parsed.data.quantity < 0) {
      return res.status(400).json({
        error: `Insufficient stock: ${currentQuantity} available in ${warehouse.name}, cannot remove ${Math.abs(parsed.data.quantity)}`,
      });
    }
  }

  const movement = await StockMovement.create({
    ...parsed.data,
    tenantId: req.auth!.tenantId,
    createdBy: req.auth!.userId,
  });

  res.status(201).json(movement);
});
