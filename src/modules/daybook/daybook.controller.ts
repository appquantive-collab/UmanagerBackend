import { Router } from "express";
import { z } from "zod";
import { requireAuth, requireTenant } from "../../middleware/auth";
import { recordAudit } from "../audit/audit.service";
import { closeDay, getDaybook, todayIst } from "./daybook.service";

export const daybookRouter = Router();
daybookRouter.use(requireAuth, requireTenant);

const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

// GET /daybook?date=YYYY-MM-DD (defaults to today, India time)
daybookRouter.get("/", async (req, res) => {
  const date = typeof req.query.date === "string" ? req.query.date : todayIst();
  if (!dateSchema.safeParse(date).success) return res.status(400).json({ error: "Invalid date" });
  res.json(await getDaybook(req.auth!.tenantId!, date));
});

const closeSchema = z.object({
  date: dateSchema,
  countedCash: z.number().min(0).max(1e10),
  openingCash: z.number().min(0).max(1e10).optional(),
  note: z.string().trim().max(300).optional(),
});

daybookRouter.post("/close", async (req, res) => {
  const parsed = closeSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const closing = await closeDay(req.auth!.tenantId!, req.auth!.userId, parsed.data);
  void recordAudit(
    req,
    "cash.close",
    `Closed cash for ${parsed.data.date}: counted ₹${closing.countedCash}, expected ₹${closing.expectedCash} (${closing.difference >= 0 ? "+" : ""}${closing.difference})`,
    String(closing._id),
    closing.countedCash
  );
  res.json(await getDaybook(req.auth!.tenantId!, parsed.data.date));
});
