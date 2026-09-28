import { Router } from "express";
import { Supplier } from "../../models/Supplier";
import { requireAuth, requireTenant } from "../../middleware/auth";
import { createSupplierSchema, updateSupplierSchema } from "./suppliers.schemas";

export const suppliersRouter = Router();

suppliersRouter.use(requireAuth, requireTenant);

// All queries below are scoped by req.auth.tenantId, which comes only from
// the verified JWT — never from the client — per the tenant isolation rule in CLAUDE.md.

suppliersRouter.get("/", async (req, res) => {
  const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
  const filter: Record<string, unknown> = { tenantId: req.auth!.tenantId };
  if (q) filter.name = { $regex: q, $options: "i" };

  const suppliers = await Supplier.find(filter).sort({ createdAt: -1 });
  res.json(suppliers);
});

suppliersRouter.get("/:id", async (req, res) => {
  const supplier = await Supplier.findOne({ _id: req.params.id, tenantId: req.auth!.tenantId });
  if (!supplier) return res.status(404).json({ error: "Supplier not found" });
  res.json(supplier);
});

suppliersRouter.post("/", async (req, res) => {
  const parsed = createSupplierSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const supplier = await Supplier.create({ ...parsed.data, tenantId: req.auth!.tenantId });
  res.status(201).json(supplier);
});

suppliersRouter.patch("/:id", async (req, res) => {
  const parsed = updateSupplierSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const supplier = await Supplier.findOneAndUpdate(
    { _id: req.params.id, tenantId: req.auth!.tenantId },
    parsed.data,
    { new: true }
  );
  if (!supplier) return res.status(404).json({ error: "Supplier not found" });
  res.json(supplier);
});

suppliersRouter.delete("/:id", async (req, res) => {
  const supplier = await Supplier.findOneAndDelete({ _id: req.params.id, tenantId: req.auth!.tenantId });
  if (!supplier) return res.status(404).json({ error: "Supplier not found" });
  res.status(204).send();
});
