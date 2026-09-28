import { Router } from "express";
import { requireAuth, requireTenant } from "../../middleware/auth";
import { getDashboardSummary } from "./dashboard.service";

export const dashboardRouter = Router();

dashboardRouter.use(requireAuth, requireTenant);

dashboardRouter.get("/summary", async (req, res) => {
  try {
    const summary = await getDashboardSummary(req.auth!.tenantId!);
    res.json(summary);
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});
