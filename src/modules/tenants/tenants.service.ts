import { Tenant } from "../../models/Tenant";
import { Category } from "../../models/Category";
import { generateDashboardLayout } from "./ai-dashboard.service";
import { assertPro } from "../billing/subscription.service";
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
    description: input.description?.trim() || null,
    roles: input.roles,
    sellsOnline: input.sellsOnline,
    onlineStoreUrl: input.onlineStoreUrl?.trim() || null,
    hasGst: input.hasGst ?? null,
    template: input.appSetup?.template ?? null,
    category: input.category,
    customerType: input.customerType,
    orderVolume: input.orderVolume,
    warehouseCount: input.warehouseCount,
    staffCount: input.staffCount,
    painPoints: input.painPoints ?? null,
    goals: input.goals,
    completedAt: new Date(),
  };

  // The chosen setup decides default bill type and which parts of the app show.
  if (input.appSetup) tenant.appSetup = input.appSetup;
  // A GSTIN given during setup goes straight onto bills (unless one is already saved).
  if (input.gstin && !tenant.gstin) {
    tenant.gstin = input.gstin;
    if (!tenant.stateCode) tenant.stateCode = input.gstin.slice(0, 2);
  }

  await tenant.save();

  // Starter item categories for this kind of business (existing ones are left alone).
  if (input.starterCategories.length > 0) {
    await Category.bulkWrite(
      input.starterCategories.map((name) => ({
        updateOne: {
          filter: { tenantId: tenant._id, name },
          update: { $setOnInsert: { tenantId: tenant._id, name } },
          upsert: true,
        },
      })),
      { ordered: false }
    ).catch(() => undefined);
  }

  return tenant.onboarding;
}

/** Turn parts of the app on/off later (Settings → Business setup). */
export async function updateAppSetup(
  tenantId: string,
  input: { defaultBillType?: "gst" | "record"; features?: Partial<NonNullable<import("../../models/Tenant").AppSetup>["features"]> }
) {
  const tenant = await Tenant.findById(tenantId);
  if (!tenant) throw new Error("Tenant not found");
  const current = tenant.appSetup ?? {
    template: "custom",
    defaultBillType: "record" as const,
    features: {
      counterSale: true,
      orders: true,
      purchases: true,
      warehouses: true,
      rawMaterials: true,
      batch: true,
      serial: true,
      variants: true,
      staff: true,
      creditLimits: true,
      cashbook: true,
    },
  };
  tenant.appSetup = {
    template: current.template,
    defaultBillType: input.defaultBillType ?? current.defaultBillType,
    features: { ...current.features, ...(input.features ?? {}) },
  };
  await tenant.save();
  return tenant.appSetup;
}

export async function personalizeDashboard(tenantId: string) {
  const tenant = await Tenant.findById(tenantId);
  if (!tenant) {
    throw new Error("Tenant not found");
  }
  if (!tenant.onboarding.completed) {
    throw new Error("Complete onboarding before generating a personalized dashboard");
  }

  await assertPro(tenantId, "aiInsights");
  const layout = await generateDashboardLayout(tenantId, tenant.businessName, tenant.onboarding);

  tenant.aiDashboardLayout = {
    generatedAt: new Date(),
    welcomeMessage: layout.welcomeMessage,
    sections: layout.sections,
    quickActionLabels: layout.quickActionLabels,
  };

  await tenant.save();
  return tenant.aiDashboardLayout;
}
