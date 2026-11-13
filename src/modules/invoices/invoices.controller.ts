import { Router } from "express";
import { Invoice } from "../../models/Invoice";
import { ownerOrManager, requireAuth, requireTenant } from "../../middleware/auth";
import { recordAudit } from "../audit/audit.service";
import { archiveBillSchema, cancelBillSchema, createBillSchema, editBillSchema, recordPaymentSchema, renumberBillSchema } from "./invoices.schemas";
import { BillError, assertBillNumberFree, cancelBill, createBill, editBill, getCustomerPendingItems, nextInvoiceNumber, recordPayment } from "./invoices.service";
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
    .populate("customerId", "name phone aadhaarLast4");
  res.json(invoices);
});

// Prefilled (and editable) bill number for the next sale.
invoicesRouter.get("/next-number", async (req, res) => {
  res.json({ invoiceNumber: await nextInvoiceNumber(req.auth!.tenantId!) });
});

invoicesRouter.get("/:id", async (req, res) => {
  const invoice = await Invoice.findOne({ _id: req.params.id, tenantId: req.auth!.tenantId }).populate(
    "customerId",
    "name phone aadhaarLast4"
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

/** Edit a bill's items, rates, GST, discount, type or number. Owner/manager. */
invoicesRouter.put("/:id", ownerOrManager, async (req, res) => {
  const parsed = editBillSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  try {
    const before = await Invoice.findOne({ _id: req.params.id, tenantId: req.auth!.tenantId }, { totalAmount: 1 }).lean();
    const invoice = await editBill(req.auth!.tenantId!, req.auth!.userId, req.params.id, parsed.data);
    void recordAudit(req, "bill.edit", `Edited ${invoice.invoiceNumber}: ₹${before?.totalAmount ?? "?"} → ₹${invoice.totalAmount}`, String(invoice._id), invoice.totalAmount);
    await invoice.populate("customerId", "name phone aadhaarLast4");
    res.json(invoice);
  } catch (err) {
    sendBillError(res, err);
  }
});

/** Change a bill's number (typo, or matching a paper bill book). Owner/manager. */
invoicesRouter.patch("/:id/number", ownerOrManager, async (req, res) => {
  const parsed = renumberBillSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const tenantId = req.auth!.tenantId!;
  try {
    const invoice = await Invoice.findOne({ _id: req.params.id, tenantId });
    if (!invoice) return res.status(404).json({ error: "Invoice not found" });
    const before = invoice.invoiceNumber;
    if (before !== parsed.data.invoiceNumber) {
      await assertBillNumberFree(tenantId, parsed.data.invoiceNumber, String(invoice._id));
      invoice.invoiceNumber = parsed.data.invoiceNumber;
      await invoice.save();
      void recordAudit(req, "bill.renumber", `Bill number ${before} → ${invoice.invoiceNumber}`, String(invoice._id));
    }
    await invoice.populate("customerId", "name phone aadhaarLast4");
    res.json(invoice);
  } catch (err) {
    sendBillError(res, err);
  }
});

/**
 * Archive: hide a bill from the list without touching accounts or stock
 * (cancelling is what reverses a bill). Owner/manager.
 */
invoicesRouter.patch("/:id/archive", ownerOrManager, async (req, res) => {
  const parsed = archiveBillSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const invoice = await Invoice.findOneAndUpdate(
    { _id: req.params.id, tenantId: req.auth!.tenantId },
    { $set: { archivedAt: parsed.data.archived ? new Date() : null } },
    { new: true }
  ).populate("customerId", "name phone aadhaarLast4");
  if (!invoice) return res.status(404).json({ error: "Invoice not found" });
  void recordAudit(
    req,
    parsed.data.archived ? "bill.archive" : "bill.unarchive",
    `${parsed.data.archived ? "Archived" : "Restored"} ${invoice.invoiceNumber}`,
    String(invoice._id)
  );
  res.json(invoice);
});
