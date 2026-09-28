import { Router } from "express";
import { z } from "zod";
import { Warehouse } from "../../models/Warehouse";
import { requireAuth, requireTenant } from "../../middleware/auth";

export const warehousesRouter = Router();

warehousesRouter.use(requireAuth, requireTenant);

const createWarehouseSchema = z.object({
  name: z.string().min(1),
  location: z.string().optional(),
});

warehousesRouter.get("/", async (req, res) => {
  const warehouses = await Warehouse.find({ tenantId: req.auth!.tenantId, isActive: true }).sort({
    isDefault: -1,
    name: 1,
  });

  // Every tenant needs at least one warehouse to record stock against; create
  // a default on first access rather than forcing a setup step before use.
  if (warehouses.length === 0) {
    const created = await Warehouse.create({
      tenantId: req.auth!.tenantId,
      name: "Main Warehouse",
      isDefault: true,
    });
    return res.json([created]);
  }

  res.json(warehouses);
});

warehousesRouter.post("/", async (req, res) => {
  const parsed = createWarehouseSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  try {
    const warehouse = await Warehouse.create({ ...parsed.data, tenantId: req.auth!.tenantId });
    res.status(201).json(warehouse);
  } catch (err) {
    res.status(409).json({ error: (err as Error).message });
  }
});
