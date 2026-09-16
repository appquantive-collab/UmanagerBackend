import { Router } from "express";
import { Product } from "../../models/Product";
import { requireAuth, requireTenant } from "../../middleware/auth";
import { createProductSchema, updateProductSchema } from "./products.schemas";

export const productsRouter = Router();

productsRouter.use(requireAuth, requireTenant);

// All queries below are scoped by req.auth.tenantId, which comes only from
// the verified JWT — never from the client — per the tenant isolation rule in CLAUDE.md.

productsRouter.get("/", async (req, res) => {
  const products = await Product.find({ tenantId: req.auth!.tenantId }).sort({ createdAt: -1 });
  res.json(products);
});

productsRouter.get("/:id", async (req, res) => {
  const product = await Product.findOne({ _id: req.params.id, tenantId: req.auth!.tenantId });
  if (!product) return res.status(404).json({ error: "Product not found" });
  res.json(product);
});

productsRouter.post("/", async (req, res) => {
  const parsed = createProductSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  try {
    const product = await Product.create({ ...parsed.data, tenantId: req.auth!.tenantId });
    res.status(201).json(product);
  } catch (err) {
    res.status(409).json({ error: (err as Error).message });
  }
});

productsRouter.patch("/:id", async (req, res) => {
  const parsed = updateProductSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const product = await Product.findOneAndUpdate(
    { _id: req.params.id, tenantId: req.auth!.tenantId },
    parsed.data,
    { new: true }
  );
  if (!product) return res.status(404).json({ error: "Product not found" });
  res.json(product);
});

productsRouter.delete("/:id", async (req, res) => {
  const product = await Product.findOneAndDelete({ _id: req.params.id, tenantId: req.auth!.tenantId });
  if (!product) return res.status(404).json({ error: "Product not found" });
  res.status(204).send();
});
