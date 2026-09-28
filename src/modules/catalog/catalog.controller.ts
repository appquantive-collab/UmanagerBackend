import { Router } from "express";
import { Category } from "../../models/Category";
import { Brand } from "../../models/Brand";
import { requireAuth, requireTenant } from "../../middleware/auth";

export const catalogRouter = Router();

catalogRouter.use(requireAuth, requireTenant);

// Categories and brands are simple reusable, tenant-scoped picklists that
// back the Product form's dropdown-with-inline-create fields.

catalogRouter.get("/categories", async (req, res) => {
  const categories = await Category.find({ tenantId: req.auth!.tenantId }).sort({ name: 1 });
  res.json(categories);
});

catalogRouter.post("/categories", async (req, res) => {
  const name = typeof req.body.name === "string" ? req.body.name.trim() : "";
  if (!name) return res.status(400).json({ error: "Name is required" });

  try {
    const category = await Category.create({ tenantId: req.auth!.tenantId, name });
    res.status(201).json(category);
  } catch {
    res.status(409).json({ error: "A category with this name already exists" });
  }
});

catalogRouter.get("/brands", async (req, res) => {
  const brands = await Brand.find({ tenantId: req.auth!.tenantId }).sort({ name: 1 });
  res.json(brands);
});

catalogRouter.post("/brands", async (req, res) => {
  const name = typeof req.body.name === "string" ? req.body.name.trim() : "";
  if (!name) return res.status(400).json({ error: "Name is required" });

  try {
    const brand = await Brand.create({ tenantId: req.auth!.tenantId, name });
    res.status(201).json(brand);
  } catch {
    res.status(409).json({ error: "A brand with this name already exists" });
  }
});
