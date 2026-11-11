import { Router } from "express";
import { z } from "zod";
import { requireAuth, requireTenant } from "../../middleware/auth";
import { BillError } from "../invoices/invoices.service";
import { recordAudit } from "../audit/audit.service";
import { createReturn, listReturns, returnableItems } from "./returns.service";

export const returnsRouter = Router();
returnsRouter.use(requireAuth, requireTenant);

const objectId = z.string().regex(/^[a-f\d]{24}$/i, "Invalid id");
const createReturnSchema = z.object({
  invoiceId: objectId,
  items: z
    .array(
      z.object({
        productId: objectId,
        quantity: z.number().positive(),
        serials: z.array(z.string().trim().min(1).max(40)).max(500).optional(),
      })
    )
    .min(1),
  refundMethod: z.enum(["cash", "upi", "bank_transfer", "cheque", "other"]).optional(),
  reason: z.string().trim().max(300).optional(),
});

function sendError(res: import("express").Response, err: unknown) {
  if (err instanceof BillError) return res.status(err.status).json({ error: err.message, code: err.code, details: err.details });
  return res.status(400).json({ error: (err as Error).message });
}

returnsRouter.get("/", async (req, res) => {
  res.json(await listReturns(req.auth!.tenantId!));
});

// What's still returnable on one bill.
returnsRouter.get("/invoice/:invoiceId", async (req, res) => {
  try {
    const { items, earlier } = await returnableItems(req.auth!.tenantId!, req.params.invoiceId);
    res.json({ items, returns: earlier });
  } catch (err) {
    sendError(res, err);
  }
});

returnsRouter.post("/", async (req, res) => {
  const parsed = createReturnSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  try {
    const saleReturn = await createReturn(req.auth!.tenantId!, req.auth!.userId, parsed.data);
    void recordAudit(
      req,
      "return.create",
      `${saleReturn.returnNumber} on ${saleReturn.invoiceNumber}: ₹${saleReturn.totalAmount}${saleReturn.refundAmount > 0 ? ` (refund ₹${saleReturn.refundAmount} ${saleReturn.refundMethod})` : ""}`,
      String(saleReturn._id),
      saleReturn.totalAmount
    );
    res.status(201).json(saleReturn);
  } catch (err) {
    sendError(res, err);
  }
});
