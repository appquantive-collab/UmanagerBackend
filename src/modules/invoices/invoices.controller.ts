import { Router } from "express";
import { Invoice } from "../../models/Invoice";
import { requireAuth, requireTenant } from "../../middleware/auth";
import { createBillSchema, recordPaymentSchema } from "./invoices.schemas";
import { createBill, getCustomerPendingItems, recordPayment } from "./invoices.service";

export const invoicesRouter = Router();

invoicesRouter.use(requireAuth, requireTenant);

invoicesRouter.get("/", async (req, res) => {
  const invoices = await Invoice.find({ tenantId: req.auth!.tenantId })
    .sort({ createdAt: -1 })
    .populate("customerId", "name phone");
  res.json(invoices);
});

invoicesRouter.get("/:id", async (req, res) => {
  const invoice = await Invoice.findOne({ _id: req.params.id, tenantId: req.auth!.tenantId }).populate(
    "customerId",
    "name phone"
  );
  if (!invoice) return res.status(404).json({ error: "Invoice not found" });
  res.json(invoice);
});

// Powers "pick a party, see what they ordered" — merges every pending/confirmed
// order for that customer into one editable item list.
invoicesRouter.get("/pending-items/:customerId", async (req, res) => {
  try {
    const items = await getCustomerPendingItems(req.auth!.tenantId!, req.params.customerId);
    res.json({ items });
  } catch (err) {
    res.status(404).json({ error: (err as Error).message });
  }
});

invoicesRouter.post("/", async (req, res) => {
  const parsed = createBillSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  try {
    const invoice = await createBill(req.auth!.tenantId!, req.auth!.userId, parsed.data);
    res.status(201).json(invoice);
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

invoicesRouter.post("/:id/payments", async (req, res) => {
  const parsed = recordPaymentSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  try {
    const invoice = await recordPayment(
      req.auth!.tenantId!,
      req.params.id,
      parsed.data.amount,
      parsed.data.method,
      parsed.data.note
    );
    res.json(invoice);
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});
