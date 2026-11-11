import { Router } from "express";
import { Types } from "mongoose";
import { requireAuth, requireRole, requireTenant } from "../../middleware/auth";
import { AuditLog } from "../../models/AuditLog";

export const auditRouter = Router();

auditRouter.use(requireAuth, requireTenant, requireRole("OWNER", "MANAGER", "SUPER_ADMIN"));

// Newest first; ?before=<iso date> pages back, ?userId= and ?action=bill filter.
auditRouter.get("/", async (req, res) => {
  const filter: Record<string, unknown> = { tenantId: req.auth!.tenantId };
  if (typeof req.query.userId === "string" && Types.ObjectId.isValid(req.query.userId)) filter.userId = req.query.userId;
  if (typeof req.query.action === "string" && /^[a-z_]+$/.test(req.query.action)) filter.action = { $regex: `^${req.query.action}\.` };
  if (typeof req.query.before === "string" && !Number.isNaN(Date.parse(req.query.before))) {
    filter.createdAt = { $lt: new Date(req.query.before) };
  }
  const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 100));
  const entries = await AuditLog.find(filter).sort({ createdAt: -1 }).limit(limit).lean();
  res.json(entries);
});
