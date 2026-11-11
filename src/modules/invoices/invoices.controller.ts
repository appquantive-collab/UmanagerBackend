import { Router } from "express";
import { Invoice } from "../../models/Invoice";
import { ownerOrManager, requireAuth, requireTenant } from "../../middleware/auth";
import { recordAudit } from "../audit/audit.service";
import { cancelBillSchema, createBillSchema, recordPaymentSchema } from "./invoices.schemas";
import { BillError, cancelBill, createBill, getCustomerPendingItems, recordPayment } from "./invoices.service";
import type { Response } from "express";

function sendBillError(res: Response, err: unknown) {
  if (err instanceof BillError) {
    return res.status(err.status).json({ error: err.message, code: err.code, details: err.details });
  }
  return res.status(400).json({ error: (err as Error).message });
}

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
    const overrides = [parsed.data.allowShortStock && "billed with short stock", parsed.data.allowOverCreditLimit && "over credit limit"].filter(Boolean);
    void recordAudit(
      req,
      "bill.create",
      `${invoice.invoiceNumber} for ${invoice.buyer?.name ?? "customer"}: ₹${invoice.totalAmount}${overrides.length ? ` (${overrides.join(", ")})` : ""}`,
      String(invoice._id),
      invoice.totalAmount
    );
    res.status(201).json(invoice);
  } catch (err) {
    sendBillError(res, err);
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
    void recordAudit(req, "bill.payment", `₹${parsed.data.amount} ${parsed.data.method} on ${invoice.invoiceNumber}`, String(invoice._id), parsed.data.amount);
    res.json(invoice);
  } catch (err) {
    sendBillError(res, err);
  }
});


// Cancel a bill made by mistake (only while no payment is recorded on it).
invoicesRouter.post("/:id/cancel", ownerOrManager, async (req, res) => {
  const parsed = cancelBillSchema.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  try {
    const invoice = await cancelBill(req.auth!.tenantId!, req.auth!.userId, req.params.id, parsed.data.reason);
    void recordAudit(req, "bill.cancel", `Cancelled ${invoice.invoiceNumber} (₹${invoice.totalAmount})${invoice.cancelReason ? ` · ${invoice.cancelReason}` : ""}`, String(invoice._id), invoice.totalAmount);
    res.json(invoice);
  } catch (err) {
    sendBillError(res, err);
  }
});
