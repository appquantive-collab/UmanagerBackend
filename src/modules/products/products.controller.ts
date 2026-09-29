import { Router } from "express";
import QRCode from "qrcode";
import { Product } from "../../models/Product";
import { requireAuth, requireTenant } from "../../middleware/auth";
import { createProductSchema, updateProductSchema } from "./products.schemas";
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
    if (parsed.data.bom.length > 0) {
      await validateBom(req.auth!.tenantId!, parsed.data.bom);
    }
    const sku = parsed.data.sku || generateSku(parsed.data.name);
    const product = await Product.create({ ...parsed.data, sku, tenantId: req.auth!.tenantId });
    res.status(201).json(product);
  } catch (err) {
    res.status(409).json({ error: (err as Error).message });
  }
});

productsRouter.patch("/:id", async (req, res) => {
  const parsed = updateProductSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  try {
    if (parsed.data.bom && parsed.data.bom.length > 0) {
      await validateBom(req.auth!.tenantId!, parsed.data.bom);
    }
    const product = await Product.findOneAndUpdate(
      { _id: req.params.id, tenantId: req.auth!.tenantId },
      parsed.data,
      { new: true }
    );
    if (!product) return res.status(404).json({ error: "Product not found" });
    res.json(product);
  } catch (err) {
    res.status(409).json({ error: (err as Error).message });
  }
});

productsRouter.delete("/:id", async (req, res) => {
  const product = await Product.findOneAndDelete({ _id: req.params.id, tenantId: req.auth!.tenantId });
  if (!product) return res.status(404).json({ error: "Product not found" });
  res.status(204).send();
});
