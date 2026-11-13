import type { BillingPeriod, PlanKey } from "../../models/Tenant";

/**
 * SethSathi plans. Prices are in rupees per month; longer periods get a discount.
 * Change prices, discounts or AI allowances here — the app and the landing page
 * read them from GET /api/billing/plans.
 */
export const PLANS: Record<PlanKey, { monthlyPrice: number; aiTokensPerMonth: number; proFeatures: boolean }> = {
  basic: { monthlyPrice: 999, aiTokensPerMonth: 2_000, proFeatures: false },
  pro: { monthlyPrice: 2999, aiTokensPerMonth: 20_000, proFeatures: true },
};

export const PERIODS: Record<BillingPeriod, { months: number; discount: number }> = {
  monthly: { months: 1, discount: 0 },
  quarterly: { months: 3, discount: 0.2 },
  annual: { months: 12, discount: 0.4 },
};

/** New businesses try everything (Pro) free for this many days. */
export const TRIAL_DAYS = 14;
/** The trial uses the Pro AI allowance. */
export const TRIAL_PLAN: PlanKey = "pro";

/**
 * Pro-only parts of the app. Basic keeps everything else (billing, stock,
 * udhaar, purchases, godowns, staff, manufacturing, reports, Munshi AI chat).
 */
export type ProFeature =
  | "batch" // batch & expiry tracking
  | "serial" // IMEI / serial numbers
  | "variants" // sizes & colours
  | "orderReading" // Munshi AI reads WhatsApp / voice orders
  | "aiInsights" // AI dashboard insights
  | "import" // Excel / CSV item import
  | "gstExport"; // GST / CA report export

export const PRO_FEATURES: ProFeature[] = ["batch", "serial", "variants", "orderReading", "aiInsights", "import", "gstExport"];

/** Full price for a plan and period, in whole rupees. */
export function priceFor(plan: PlanKey, period: BillingPeriod): number {
  const { months, discount } = PERIODS[period];
  return Math.round(PLANS[plan].monthlyPrice * months * (1 - discount));
}

export function isPlanKey(v: unknown): v is PlanKey {
  return v === "basic" || v === "pro";
}

export function isBillingPeriod(v: unknown): v is BillingPeriod {
  return v === "monthly" || v === "quarterly" || v === "annual";
}

/** Price list sent to the app. */
export function priceList() {
  return {
    trialDays: TRIAL_DAYS,
    proFeatures: PRO_FEATURES,
    plans: (Object.keys(PLANS) as PlanKey[]).map((key) => ({
      key,
      monthlyPrice: PLANS[key].monthlyPrice,
      aiTokensPerMonth: PLANS[key].aiTokensPerMonth,
      proFeatures: PLANS[key].proFeatures,
      prices: (Object.keys(PERIODS) as BillingPeriod[]).map((period) => ({
        period,
        months: PERIODS[period].months,
        discountPercent: Math.round(PERIODS[period].discount * 100),
        price: priceFor(key, period),
        fullPrice: PLANS[key].monthlyPrice * PERIODS[period].months,
      })),
    })),
  };
}
