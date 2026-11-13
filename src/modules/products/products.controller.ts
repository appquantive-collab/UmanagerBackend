import { Router } from "express";
import { assertPro, sendPlanError } from "../billing/subscription.service";
import QRCode from "qrcode";
import { Product } from "../../models/Product";
import { denyRoles, ownerOrManager, requireAuth, requireTenant } from "../../middleware/auth";
import { createProductSchema, createVariantsSchema, importProductsSchema, importRowSchema, updateProductSchema } from "./products.schemas";
import { StockMovement } from "../../models/StockMovement";
import { defaultWarehouseId } from "../stock/ledger";
import { recordAudit } from "../audit/audit.service";
import { generateSku } from "../../utils/sku";
import { validateBom } from "../assembly/assembly.service";

export const productsRouter = Router();

productsRouter.use(requireAuth, requireTenant);

// All queries below are scoped by req.auth.tenantId, which comes only from
// the verified JWT — never from the client — per the tenant isolation rule in CLAUDE.md.

productsRouter.get("/", async (req, res) => {
  const filter: Record<string, unknown> = { tenantId: req.auth!.tenantId };
  // ?rawMaterial=true|false filters between the Raw Materials tab and the
  // sellable catalog; omitted returns everything (e.g. for the BOM picker).
  if (req.query.rawMaterial === "true") filter.isRawMaterial = true;
  if (req.query.rawMaterial === "false") filter.isRawMaterial = false;

  const products = await Product.find(filter).sort({ createdAt: -1 });
  res.json(products);
});

productsRouter.get("/:id", async (req, res) => {
  const product = await Product.findOne({ _id: req.params.id, tenantId: req.auth!.tenantId });
  if (!product) return res.status(404).json({ error: "Product not found" });
  res.json(product);
});

// Encodes the product's SKU as a scannable QR code — printed and stuck on
// the item, then scanned during stock counts or sales to identify it.
productsRouter.get("/:id/qr", async (req, res) => {
  const product = await Product.findOne({ _id: req.params.id, tenantId: req.auth!.tenantId });
  if (!product) return res.status(404).json({ error: "Product not found" });

  try {
    const dataUrl = await QRCode.toDataURL(product.sku, { width: 400, margin: 1 });
    res.json({ sku: product.sku, qrDataUrl: dataUrl });
  } catch {
    res.status(500).json({ error: "Could not generate QR code" });
  }
});

productsRouter.post("/", async (req, res) => {
  const parsed = createProductSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  try {
    if (parsed.data.trackBatch) await assertPro(req.auth!.tenantId!, "batch");
    if (parsed.data.trackSerial) await assertPro(req.auth!.tenantId!, "serial");
    if (parsed.data.bom.length > 0) {
      await validateBom(req.auth!.tenantId!, parsed.data.bom);
    }
    const sku = parsed.data.sku || generateSku(parsed.data.name);
    const product = await Product.create({ ...parsed.data, sku, tenantId: req.auth!.tenantId });
    res.status(201).json(product);
  } catch (err) {
    if (sendPlanError(res, err)) return;
    res.status(409).json({ error: (err as Error).message });
  }
});

productsRouter.patch("/:id", denyRoles("SALESMAN"), async (req, res) => {
  const parsed = updateProductSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  try {
    if (parsed.data.bom && parsed.data.bom.length > 0) {
      await validateBom(req.auth!.tenantId!, parsed.data.bom);
    }
    const { altUnit, ...rest } = parsed.data;
    const update: Record<string, unknown> = { $set: rest };
    if (altUnit === null) update.$unset = { altUnit: "" };
    else if (altUnit) (update.$set as Record<string, unknown>).altUnit = altUnit;
    const before = await Product.findOne({ _id: req.params.id, tenantId: req.auth!.tenantId }).lean();
    if (parsed.data.trackBatch && !before?.trackBatch) await assertPro(req.auth!.tenantId!, "batch");
    if (parsed.data.trackSerial && !before?.trackSerial) await assertPro(req.auth!.tenantId!, "serial");
    const product = await Product.findOneAndUpdate({ _id: req.params.id, tenantId: req.auth!.tenantId }, update, { new: true });
    if (!product) return res.status(404).json({ error: "Product not found" });
    if (before && (before.retailPrice !== product.retailPrice || before.wholesalePrice !== product.wholesalePrice || before.purchasePrice !== product.purchasePrice)) {
      void recordAudit(req, "product.price", `${product.name}: retail ₹${before.retailPrice} → ₹${product.retailPrice}, wholesale ₹${before.wholesalePrice} → ₹${product.wholesalePrice}, cost ₹${before.purchasePrice} → ₹${product.purchasePrice}`, String(product._id));
    }
    res.json(product);
  } catch (err) {
    if (sendPlanError(res, err)) return;
    res.status(409).json({ error: (err as Error).message });
  }
});

// Items with history (stock entries, bills) are archived, not erased, so old
// bills and reports still show their names.
productsRouter.delete("/:id", ownerOrManager, async (req, res) => {
  const tenantId = req.auth!.tenantId!;
  const product = await Product.findOne({ _id: req.params.id, tenantId });
  if (!product) return res.status(404).json({ error: "Product not found" });
  const hasHistory = await StockMovement.exists({ tenantId, productId: product._id });
  if (hasHistory) {
    product.isActive = false;
    await product.save();
    void recordAudit(req, "product.archive", `Archived item ${product.name}`, String(product._id));
    return res.json({ archived: true });
  }
  await product.deleteOne();
  void recordAudit(req, "product.delete", `Deleted item ${product.name}`, String(product._id));
  res.status(204).send();
});

// Bulk add/update items from a spreadsheet (CSV or Excel, parsed in the app).
// Rows are checked one by one; bad rows are reported back, good rows are saved.
productsRouter.post("/import", ownerOrManager, async (req, res) => {
  const parsed = importProductsSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const tenantId = req.auth!.tenantId!;
  try {
    await assertPro(tenantId, "import");
  } catch (err) {
    if (sendPlanError(res, err)) return;
    throw err;
  }
  const existing = await Product.find({ tenantId }, { name: 1, sku: 1, barcode: 1 }).lean();
  const bySku = new Map(existing.map((p) => [p.sku.toLowerCase(), p._id]));
  const byBarcode = new Map(existing.filter((p) => p.barcode).map((p) => [p.barcode!.toLowerCase(), p._id]));
  const byName = new Map(existing.map((p) => [p.name.trim().toLowerCase(), p._id]));
  const warehouseId = await defaultWarehouseId(tenantId);

  let created = 0;
  let updated = 0;
  let skipped = 0;
  const errors: { row: number; message: string }[] = [];
  const openings: Record<string, unknown>[] = [];

  for (const [index, raw] of parsed.data.rows.entries()) {
    const row = importRowSchema.safeParse(raw);
    if (!row.success) {
      const issue = row.error.issues[0];
      errors.push({ row: index + 2, message: `${issue.path.join(".") || "row"}: ${issue.message}` });
      continue;
    }
    const { openingStock, ...data } = row.data;
    const fields = {
      ...data,
      wholesalePrice: data.wholesalePrice ?? data.retailPrice,
      gstPercent: data.gstPercent ?? 0,
      reorderLevel: data.reorderLevel ?? 0,
    };
    const matchId =
      (data.sku && bySku.get(data.sku.toLowerCase())) ||
      (data.barcode && byBarcode.get(data.barcode.toLowerCase())) ||
      byName.get(data.name.toLowerCase());
    try {
      if (matchId) {
        if (parsed.data.mode === "skip") {
          skipped += 1;
          continue;
        }
        const { sku: _sku, ...withoutSku } = fields;
        void _sku;
        await Product.updateOne({ _id: matchId, tenantId }, { $set: { ...withoutSku, isActive: true } });
        updated += 1;
      } else {
        const sku = data.sku || generateSku(data.name);
        const product = await Product.create({ ...fields, sku, tenantId });
        bySku.set(sku.toLowerCase(), product._id);
        byName.set(data.name.toLowerCase(), product._id);
        if (data.barcode) byBarcode.set(data.barcode.toLowerCase(), product._id);
        created += 1;
        if (openingStock && openingStock > 0) {
          openings.push({
            tenantId,
            productId: product._id,
            warehouseId,
            quantity: openingStock,
            movementType: "opening",
            note: "Opening stock (import)",
            createdBy: req.auth!.userId,
          });
        }
      }
    } catch (err) {
      errors.push({ row: index + 2, message: (err as Error).message.includes("duplicate") ? "SKU already used" : (err as Error).message });
    }
  }
  if (openings.length) await StockMovement.insertMany(openings);
  void recordAudit(req, "product.import", `Imported items: ${created} new, ${updated} updated, ${errors.length} with errors`);
  res.json({ created, updated, skipped, errors: errors.slice(0, 200), errorCount: errors.length });
});

// Garments/footwear: one design in many sizes and colours → one item per combination.
productsRouter.post("/variants", denyRoles("SALESMAN"), async (req, res) => {
  const parsed = createVariantsSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const { baseName, sizes, colors, ...rest } = parsed.data;
  const tenantId = req.auth!.tenantId!;
  try {
    await assertPro(tenantId, "variants");
  } catch (err) {
    if (sendPlanError(res, err)) return;
    throw err;
  }
  const sizeList: (string | undefined)[] = sizes.length ? sizes : [undefined];
  const colorList: (string | undefined)[] = colors.length ? colors : [undefined];
  const combos = sizeList.flatMap((size) => colorList.map((color) => ({ size, color })));
  if (combos.length > 200) return res.status(400).json({ error: "Too many combinations (max 200)" });
  const docs = combos.map(({ size, color }) => {
    const label = [size, color].filter(Boolean).join(" / ");
    const name = label ? `${baseName} - ${label}` : baseName;
    return { ...rest, tenantId, name, sku: generateSku(name), variantGroup: baseName, size, color };
  });
  const products = await Product.insertMany(docs);
  void recordAudit(req, "product.variants", `Added ${products.length} variants of ${baseName}`);
  res.status(201).json(products);
});
