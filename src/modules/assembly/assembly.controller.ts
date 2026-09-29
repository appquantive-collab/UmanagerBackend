import { Router } from "express";
import { requireAuth, requireTenant } from "../../middleware/auth";
import { assembleSchema } from "./assembly.schemas";
import { assembleProduct, getProducibleQuantity } from "./assembly.service";

export const assemblyRouter = Router();

assemblyRouter.use(requireAuth, requireTenant);

// How many more finished units could be made right now from current raw
// material stock — powers the "can only make N more" warning on the product
// page and when placing an order for a BOM product.
assemblyRouter.get("/producible/:productId", async (req, res) => {
  try {
    const result = await getProducibleQuantity(req.auth!.tenantId!, req.params.productId);
    res.json(result);
  } catch (err) {
    res.status(404).json({ error: (err as Error).message });
  }
});

assemblyRouter.post("/", async (req, res) => {
  const parsed = assembleSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  try {
    const result = await assembleProduct(
      req.auth!.tenantId!,
      req.auth!.userId,
      parsed.data.productId,
      parsed.data.warehouseId,
      parsed.data.quantity,
      parsed.data.note
    );
    res.status(201).json(result);
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});
