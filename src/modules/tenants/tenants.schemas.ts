import { z } from "zod";

export const onboardingSchema = z.object({
  category: z.enum(["fmcg", "electronics", "pharma", "apparel", "auto_parts", "grocery", "hardware", "other"]),
  customerType: z.enum(["wholesale", "retail", "both"]),
  orderVolume: z.enum(["lt_100", "100_500", "500_2000", "gt_2000"]),
  warehouseCount: z.number().int().min(0).max(1000),
  staffCount: z.number().int().min(0).max(10000),
  painPoints: z.string().trim().max(1000).optional(),
  goals: z
    .array(z.enum(["inventory_tracking", "credit_payments", "multi_warehouse", "staff_management", "ai_insights", "reporting"]))
    .min(1)
    .max(3),
});
