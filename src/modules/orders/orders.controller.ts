import { Router } from "express";
import { Order } from "../../models/Order";
import { requireAuth, requireTenant } from "../../middleware/auth";
import { createOrderSchema, parseOrderTextSchema, updateOrderSchema, updateOrderStatusSchema } from "./orders.schemas";
import { previewOrderFromText, saveOrder, updateOrder, updateOrderStatus } from "./orders.service";
import { AiNotConfiguredError } from "./order-parser.service";

export const ordersRouter = Router();

ordersRouter.use(requireAuth, requireTenant);

ordersRouter.get("/", async (req, res) => {
  const filter: Record<string, unknown> = { tenantId: req.auth!.tenantId };
  // "Billable" = not yet invoiced and not cancelled. Once an order is billed via
  // POST /api/invoices, its status flips to "delivered" so it drops out of this list.
  if (req.query.billable === "true") {
    filter.status = { $in: ["pending", "confirmed"] };
  }

  const orders = await Order.find(filter).sort({ createdAt: -1 }).populate("customerId", "name phone");
  res.json(orders);
});

ordersRouter.get("/:id", async (req, res) => {
  const order = await Order.findOne({ _id: req.params.id, tenantId: req.auth!.tenantId }).populate(
    "customerId",
    "name phone"
  );
  if (!order) return res.status(404).json({ error: "Order not found" });
  res.json(order);
});

ordersRouter.post("/parse", async (req, res) => {
  const parsed = parseOrderTextSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  try {
    const preview = await previewOrderFromText(req.auth!.tenantId!, parsed.data.text);
    res.json(preview);
  } catch (err) {
    if (err instanceof AiNotConfiguredError) {
      return res.status(503).json({ error: err.message });
    }
    res.status(400).json({ error: (err as Error).message });
  }
});

ordersRouter.post("/", async (req, res) => {
  const parsed = createOrderSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  try {
    const { order, rawMaterialWarnings } = await saveOrder(req.auth!.tenantId!, req.auth!.userId, parsed.data);
    res.status(201).json({ ...order.toObject(), rawMaterialWarnings });
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

ordersRouter.patch("/:id", async (req, res) => {
  const parsed = updateOrderSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  try {
    const order = await updateOrder(req.auth!.tenantId!, req.params.id, parsed.data);
    res.json(order);
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

ordersRouter.patch("/:id/status", async (req, res) => {
  const parsed = updateOrderStatusSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  try {
    const order = await updateOrderStatus(req.auth!.tenantId!, req.params.id, parsed.data.status);
    res.json(order);
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});
