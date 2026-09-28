import OpenAI from "openai";
import { env } from "../../config/env";
import type { BusinessOnboarding } from "../../models/Tenant";

// The only dashboard sections/actions the model is allowed to reorder or relabel.
// Keeping this closed means a malformed or hallucinated response can only ever
// reorder/relabel real UI we already render — it can never inject new widgets.
const DASHBOARD_SECTIONS = [
  { key: "ai_brief", defaultLabel: "Autonomous Business Brief" },
  { key: "quick_actions", defaultLabel: "Quick Actions" },
  { key: "immediate_operations", defaultLabel: "Immediate Operations" },
  { key: "ledger_metrics", defaultLabel: "Ledger & Logistics Metrics" },
  { key: "order_flow", defaultLabel: "Live Order Flow" },
  { key: "sales_trend", defaultLabel: "Sales Trend" },
  { key: "top_products", defaultLabel: "Top Products" },
  { key: "recent_activity", defaultLabel: "Recent Activity" },
] as const;

const QUICK_ACTION_KEYS = ["new_order", "new_sale", "voice_order", "scan_stock"] as const;

export interface GeneratedDashboardLayout {
  welcomeMessage: string;
  sections: { key: string; label: string; priority: number }[];
  quickActionLabels: Record<string, string>;
}

export class AiNotConfiguredError extends Error {
  constructor() {
    super("AI dashboard personalization is not configured (missing OPENAI_API_KEY)");
    this.name = "AiNotConfiguredError";
  }
}

function buildPrompt(businessName: string, onboarding: BusinessOnboarding): string {
  const sectionKeys = DASHBOARD_SECTIONS.map((s) => s.key).join(", ");
  const actionKeys = QUICK_ACTION_KEYS.join(", ");

  return `You are personalizing a wholesale/inventory management dashboard for a business.

Business name: ${businessName}
Category: ${onboarding.category}
Customer type: ${onboarding.customerType}
Monthly order volume: ${onboarding.orderVolume}
Warehouses: ${onboarding.warehouseCount}
Staff: ${onboarding.staffCount}
Stated priorities: ${onboarding.goals.join(", ")}
Pain points (free text, may be empty): ${onboarding.painPoints ?? "(none given)"}

Respond with ONLY valid JSON matching this exact shape:
{
  "welcomeMessage": "one or two sentences, written directly to the business owner, referencing their business type/goals",
  "sections": [ { "key": "<one of: ${sectionKeys}>", "label": "<short relabeled section title>", "priority": <integer, 1 = shown first> } ],
  "quickActionLabels": { "<one of: ${actionKeys}>": "<short relabeled action label>" }
}

Rules:
- "sections" must include ALL ${DASHBOARD_SECTIONS.length} section keys listed above, each exactly once, with unique priority values 1-${DASHBOARD_SECTIONS.length}.
- Only reorder and relabel — do not invent new section keys or action keys.
- Labels should reflect the business category and goals (e.g. a pharmacy might rename a stock-alert section to reference expiry/batches; a B2B distributor might emphasize credit/receivables).
- Keep labels short (under 40 characters) and in the same tone as: "Immediate Operations", "Quick Actions".`;
}

function parseAndValidate(raw: string): GeneratedDashboardLayout {
  const cleaned = raw
    .trim()
    .replace(/^```(json)?/i, "")
    .replace(/```$/, "")
    .trim();
  const parsed = JSON.parse(cleaned);

  if (typeof parsed.welcomeMessage !== "string" || !parsed.welcomeMessage.trim()) {
    throw new Error("AI response missing welcomeMessage");
  }

  const validKeys = new Set(DASHBOARD_SECTIONS.map((s) => s.key));
  const sections = Array.isArray(parsed.sections) ? parsed.sections : [];
  const seenKeys = new Set<string>();
  const cleanSections: GeneratedDashboardLayout["sections"] = [];

  for (const s of sections) {
    if (!s || typeof s.key !== "string" || !validKeys.has(s.key) || seenKeys.has(s.key)) continue;
    if (typeof s.label !== "string" || !s.label.trim()) continue;
    if (typeof s.priority !== "number") continue;
    seenKeys.add(s.key);
    cleanSections.push({ key: s.key, label: s.label.trim().slice(0, 60), priority: s.priority });
  }

  // Any section the model omitted or mangled falls back to its default label/order
  // rather than disappearing from the dashboard.
  for (const s of DASHBOARD_SECTIONS) {
    if (!seenKeys.has(s.key)) {
      cleanSections.push({ key: s.key, label: s.defaultLabel, priority: DASHBOARD_SECTIONS.length + 1 });
    }
  }
  cleanSections.sort((a, b) => a.priority - b.priority);
  cleanSections.forEach((s, i) => (s.priority = i + 1));

  const quickActionLabels: Record<string, string> = {};
  if (parsed.quickActionLabels && typeof parsed.quickActionLabels === "object") {
    for (const key of QUICK_ACTION_KEYS) {
      const label = parsed.quickActionLabels[key];
      if (typeof label === "string" && label.trim()) {
        quickActionLabels[key] = label.trim().slice(0, 30);
      }
    }
  }

  return {
    welcomeMessage: parsed.welcomeMessage.trim().slice(0, 300),
    sections: cleanSections,
    quickActionLabels,
  };
}

export async function generateDashboardLayout(
  businessName: string,
  onboarding: BusinessOnboarding
): Promise<GeneratedDashboardLayout> {
  if (!env.openaiApiKey) {
    throw new AiNotConfiguredError();
  }

  const client = new OpenAI({ apiKey: env.openaiApiKey });
  const response = await client.chat.completions.create({
    model: "gpt-4o-mini",
    response_format: { type: "json_object" },
    messages: [{ role: "user", content: buildPrompt(businessName, onboarding) }],
  });

  const text = response.choices[0]?.message?.content;
  if (!text) {
    throw new Error("AI returned an empty response");
  }

  return parseAndValidate(text);
}
