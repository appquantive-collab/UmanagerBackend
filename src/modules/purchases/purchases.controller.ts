import { Router, type Response } from "express";
import { z } from "zod";
import { recordAudit } from "../audit/audit.service";
import { requireAuth, requireTenant } from "../../middleware/auth";
import { PurchaseError, createPurchase, getPurchase, listPurchases, recordPurchasePayment } from "./purchases.service";

export const purchasesRouter = Router();

purchasesRouter.use(requireAuth, requireTenant);

const paymentMethod = z.enum(["cash", "upi", "bank_transfer", "cheque", "credit", "other"]);
const objectId = z.string().regex(/^[a-f\d]{24}$/i, "Invalid id");

const createPurchaseSchema = z.object({
  supplierId: objectId,
  warehouseId: objectId.optional(),
  supplierBillNumber: z.string().trim().max(60).optional(),
  purchasedAt: z.string().datetime({ offset: true }).optional(),
  note: z.string().trim().max(500).optional(),
  items: z
    .array(
      z.object({
        productId: objectId,
        quantity: z.number().positive(),
        unitCost: z.number().min(0),
        gstPercent: z.number().min(0).max(100).optional(),
        unit: z.string().trim().max(20).optional(),
        batchNo: z.string().trim().max(40).optional(),
        expiryDate: z.string().optional(),
        serials: z.array(z.string().trim().min(1).max(40)).max(500).optional(),
      })
    )
    .min(1, "Add at least one item"),
  payment: z.object({ amount: z.number().min(0), method: paymentMethod }).optional(),
});

const paymentSchema = z.object({
  amount: z.number().positive(),
  method: paymentMethod,
  note: z.string().max(500).optional(),
});

function sendError(res: Response, err: unknown) {
  if (err instanceof PurchaseError) return res.status(err.status).json({ error: err.message });
  throw err;
}

purchasesRouter.get("/", async (req, res) => {
  res.json(await listPurchases(req.auth!.tenantId!));
});

purchasesRouter.get("/:id", async (req, res) => {
  try {
    res.json(await getPurchase(req.auth!.tenantId!, req.params.id));
  } catch (err) {
    sendError(res, err);
  }
});

purchasesRouter.post("/", async (req, res) => {
  const parsed = createPurchaseSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  try {
    const purchase = await createPurchase(req.auth!.tenantId!, req.auth!.userId, parsed.data);
    void recordAudit(req, "purchase.create", `${purchase.purchaseNumber}: ₹${Math.round(purchase.totalAmount)}${purchase.amountPaid > 0 ? `, paid ₹${purchase.amountPaid}` : ""}`, String(purchase._id), purchase.totalAmount);
    res.status(201).json(await getPurchase(req.auth!.tenantId!, String(purchase._id)));
  } catch (err) {
    sendError(res, err);
  }
});

purchasesRouter.post("/:id/payments", async (req, res) => {
  const parsed = paymentSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  try {
    const updated = await recordPurchasePayment(req.auth!.tenantId!, req.params.id, parsed.data.amount, parsed.data.method, parsed.data.note);
    void recordAudit(req, "purchase.payment", `Paid supplier ₹${parsed.data.amount} ${parsed.data.method}`, req.params.id, parsed.data.amount);
    res.json(updated);
  } catch (err) {
    sendError(res, err);
  }
});
