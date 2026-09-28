import { Tenant } from "../../models/Tenant";
import { generateDashboardLayout } from "./ai-dashboard.service";
import type { z } from "zod";
import type { onboardingSchema } from "./tenants.schemas";

type OnboardingInput = z.infer<typeof onboardingSchema>;

export async function saveOnboarding(tenantId: string, input: OnboardingInput) {
  const tenant = await Tenant.findById(tenantId);
  if (!tenant) {
    throw new Error("Tenant not found");
  }

  tenant.onboarding = {
    completed: true,
    category: input.category,
    customerType: input.customerType,
    orderVolume: input.orderVolume,
    warehouseCount: input.warehouseCount,
    staffCount: input.staffCount,
    painPoints: input.painPoints ?? null,
    goals: input.goals,
    completedAt: new Date(),
  };

  await tenant.save();
  return tenant.onboarding;
}

export async function personalizeDashboard(tenantId: string) {
  const tenant = await Tenant.findById(tenantId);
  if (!tenant) {
    throw new Error("Tenant not found");
  }
  if (!tenant.onboarding.completed) {
    throw new Error("Complete onboarding before generating a personalized dashboard");
  }

  const layout = await generateDashboardLayout(tenant.businessName, tenant.onboarding);

  tenant.aiDashboardLayout = {
    generatedAt: new Date(),
    welcomeMessage: layout.welcomeMessage,
    sections: layout.sections,
    quickActionLabels: layout.quickActionLabels,
  };

  await tenant.save();
  return tenant.aiDashboardLayout;
}
