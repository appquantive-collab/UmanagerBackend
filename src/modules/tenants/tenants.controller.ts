import { Router } from "express";
import { requireAuth, requireRole, requireTenant } from "../../middleware/auth";
import { Tenant } from "../../models/Tenant";
import { recordAudit } from "../audit/audit.service";
import { businessProfileSchema, onboardingSchema } from "./tenants.schemas";
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

// Business details (name, GSTIN, address, UPI, bank, bill terms). Owner/manager only.
tenantsRouter.patch("/profile", requireAuth, requireTenant, requireRole("OWNER", "MANAGER", "SUPER_ADMIN"), async (req, res) => {
  const parsed = businessProfileSchema.safeParse(req.body);
  if (!parsed.success) {
    const first = Object.values(parsed.error.flatten().fieldErrors).flat()[0];
    return res.status(400).json({ error: first ?? "Please check the details", fields: parsed.error.flatten().fieldErrors });
  }
  const set: Record<string, string> = {};
  const unset: Record<string, ""> = {};
  for (const [key, value] of Object.entries(parsed.data)) {
    if (value === undefined) continue;
    if (value === "" && key !== "businessName") unset[key] = "";
    else set[key] = value;
  }
  const tenant = await Tenant.findByIdAndUpdate(
    req.auth!.tenantId,
    { ...(Object.keys(set).length ? { $set: set } : {}), ...(Object.keys(unset).length ? { $unset: unset } : {}) },
    { new: true }
  );
  if (!tenant) return res.status(404).json({ error: "Business not found" });
  void recordAudit(req, "settings.business", `Changed business details: ${Object.keys(parsed.data).filter((k) => parsed.data[k as keyof typeof parsed.data] !== undefined).join(", ")}`);
  return res.json({
    businessName: tenant.businessName,
    phone: tenant.phone,
    gstin: tenant.gstin,
    address: tenant.address,
    stateCode: tenant.stateCode,
    upiId: tenant.upiId,
    bankName: tenant.bankName,
    bankAccount: tenant.bankAccount,
    bankIfsc: tenant.bankIfsc,
    invoiceTerms: tenant.invoiceTerms,
  });
});
