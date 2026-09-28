import { Router } from "express";
import { requireAuth, requireTenant } from "../../middleware/auth";
import { onboardingSchema } from "./tenants.schemas";
import { personalizeDashboard, saveOnboarding } from "./tenants.service";
import { AiNotConfiguredError } from "./ai-dashboard.service";

export const tenantsRouter = Router();

tenantsRouter.post("/onboarding", requireAuth, requireTenant, async (req, res) => {
  const parsed = onboardingSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }

  try {
    const onboarding = await saveOnboarding(req.auth!.tenantId!, parsed.data);
    return res.json({ onboarding });
  } catch (err) {
    return res.status(404).json({ error: (err as Error).message });
  }
});

tenantsRouter.post("/personalize-dashboard", requireAuth, requireTenant, async (req, res) => {
  try {
    const aiDashboardLayout = await personalizeDashboard(req.auth!.tenantId!);
    return res.json({ aiDashboardLayout });
  } catch (err) {
    if (err instanceof AiNotConfiguredError) {
      return res.status(503).json({ error: err.message });
    }
    return res.status(400).json({ error: (err as Error).message });
  }
});
