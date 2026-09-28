import { Router } from "express";
import { z } from "zod";
import { Warehouse } from "../../models/Warehouse";
import { requireAuth, requireTenant } from "../../middleware/auth";
import { listWarehousesWithStats } from "./warehouses.service";

export const warehousesRouter = Router();

warehousesRouter.use(requireAuth, requireTenant);

const createWarehouseSchema = z.object({
  name: z.string().min(1),
  location: z.string().optional(),
});

warehousesRouter.get("/", async (req, res) => {
  const warehouses = await listWarehousesWithStats(req.auth!.tenantId!);
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
