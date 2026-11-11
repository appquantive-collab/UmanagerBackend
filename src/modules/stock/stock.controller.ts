import { Router } from "express";
import mongoose from "mongoose";
import { StockMovement } from "../../models/StockMovement";
import { Product } from "../../models/Product";
import { Warehouse } from "../../models/Warehouse";
import { denyRoles, requireAuth, requireTenant } from "../../middleware/auth";
import { Invoice } from "../../models/Invoice";
import { recordAudit } from "../audit/audit.service";
import { serialsInStock } from "./ledger";
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

stockRouter.post("/movements", denyRoles("SALESMAN"), async (req, res) => {
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
    batchNo: parsed.data.batchNo?.toUpperCase() || undefined,
    expiryDate: parsed.data.expiryDate ? new Date(parsed.data.expiryDate) : undefined,
    tenantId: req.auth!.tenantId,
    createdBy: req.auth!.userId,
  });
  const sign = parsed.data.quantity > 0 ? "+" : "";
  void recordAudit(
    req,
    `stock.${parsed.data.movementType}`,
    `${product.name}: ${sign}${parsed.data.quantity} ${product.unit} in ${warehouse.name}${parsed.data.note ? ` · ${parsed.data.note}` : ""}`,
    String(movement._id)
  );

  res.status(201).json(movement);
});

// Batches running out of date: stock still on hand that expires within ?days= (default 60), soonest first.
stockRouter.get("/expiring", async (req, res) => {
  const days = Math.min(365, Math.max(1, Number(req.query.days) || 60));
  const until = new Date(Date.now() + days * 24 * 60 * 60 * 1000);
  const rows = await StockMovement.aggregate([
    { $match: { tenantId: new mongoose.Types.ObjectId(req.auth!.tenantId!), batchNo: { $exists: true, $ne: null } } },
    {
      $group: {
        _id: { productId: "$productId", batchNo: "$batchNo" },
        qty: { $sum: "$quantity" },
        expiryDate: { $max: "$expiryDate" },
      },
    },
    { $match: { qty: { $gt: 0 }, expiryDate: { $ne: null, $lte: until } } },
    { $sort: { expiryDate: 1 } },
    { $limit: 300 },
  ]);
  const products = await Product.find({ _id: { $in: rows.map((r) => r._id.productId) } }, { name: 1, unit: 1, purchasePrice: 1 }).lean();
  const byId = new Map(products.map((p) => [String(p._id), p]));
  res.json(
    rows.map((r) => {
      const p = byId.get(String(r._id.productId));
      return {
        productId: String(r._id.productId),
        productName: p?.name ?? "",
        unit: p?.unit ?? "",
        batchNo: r._id.batchNo,
        expiryDate: r.expiryDate,
        quantity: Math.round(r.qty * 1000) / 1000,
        value: Math.round(r.qty * (p?.purchasePrice ?? 0)),
        expired: new Date(r.expiryDate).getTime() < Date.now(),
      };
    })
  );
});

// Look up one IMEI/serial: which item, in stock or sold, and on which bill.
stockRouter.get("/serial/:serial", async (req, res) => {
  const serial = req.params.serial.trim().toUpperCase();
  const moves = await StockMovement.find({ tenantId: req.auth!.tenantId, serials: serial }).sort({ createdAt: 1 }).lean();
  if (moves.length === 0) return res.status(404).json({ error: "Serial not found" });
  const net = moves.reduce((sum, m) => sum + (m.quantity > 0 ? 1 : -1), 0);
  const product = await Product.findById(moves[0].productId, { name: 1 }).lean();
  const lastSale = [...moves].reverse().find((m) => m.movementType === "sale");
  const invoice = lastSale?.referenceId
    ? await Invoice.findOne({ _id: lastSale.referenceId, tenantId: req.auth!.tenantId }, { invoiceNumber: 1, createdAt: 1, buyer: 1 }).lean()
    : null;
  res.json({
    serial,
    productId: String(moves[0].productId),
    productName: product?.name ?? "",
    inStock: net > 0,
    history: moves.map((m) => ({ type: m.movementType, at: m.createdAt, note: m.note })),
    soldOn: invoice
      ? { invoiceId: String(invoice._id), invoiceNumber: invoice.invoiceNumber, at: invoice.createdAt, customer: invoice.buyer?.name }
      : null,
  });
});

// In-stock serials of one item (for picking at the counter).
stockRouter.get("/serials/:productId", async (req, res) => {
  if (!mongoose.Types.ObjectId.isValid(req.params.productId)) return res.status(400).json({ error: "Invalid id" });
  const map = await serialsInStock(req.auth!.tenantId!, new mongoose.Types.ObjectId(req.params.productId));
  res.json([...map.keys()].sort());
});
