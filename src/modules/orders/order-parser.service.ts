import OpenAI from "openai";
import { env } from "../../config/env";

export class AiNotConfiguredError extends Error {
  constructor() {
    super("AI order parsing is not configured (missing OPENAI_API_KEY)");
    this.name = "AiNotConfiguredError";
  }
}

export interface ParsedOrderItem {
  productName: string;
  quantity: number;
  unit: string;
  matchedProductId: string | null;
}

export interface ParsedOrder {
  partyName: string | null;
  items: ParsedOrderItem[];
}

interface CatalogEntry {
  id: string;
  name: string;
}

function buildPrompt(text: string, catalog: CatalogEntry[]): string {
  const catalogList =
    catalog.length > 0
      ? catalog.map((c) => `- "${c.name}" (id: ${c.id})`).join("\n")
      : "(no products in catalog yet)";

  return `You extract structured wholesale order data from free-text order notes. The notes are often written by an Indian shopkeeper, mixing Hindi/Hinglish and English (e.g. "aaya hai", "wali", product descriptions with material/size/finish details).

Order text:
"""
${text}
"""

Existing product catalog for this business (match against these by meaning, not exact string — sizes/materials/finishes in the text should match the closest catalog entry even if worded differently):
${catalogList}

Respond with ONLY valid JSON matching this exact shape:
{
  "partyName": "<customer/party name mentioned in the text, or null if none is clearly stated>",
  "items": [
    {
      "productName": "<clean product name/description, e.g. 'Dholak Natbold (Aam Wood)', title-cased, no quantity in it>",
      "quantity": <number>,
      "unit": "<short unit like pcs, box, kg, inch — infer a sensible default if not stated, usually 'pcs'>",
      "matchedProductId": "<the id of the catalog entry this refers to, if you are confident it's the same product, otherwise null>"
    }
  ]
}

Rules:
- Extract every distinct line item mentioned, each with its own quantity.
- "matchedProductId" must be an exact id from the catalog list above, or null — never invent an id.
- Only set matchedProductId when reasonably confident it's the same product (same core item), not just a vague category match.
- If quantity isn't explicit for an item, use 1.
- Do not include any commentary, only the JSON object.`;
}

function parseAndValidate(raw: string, catalog: CatalogEntry[]): ParsedOrder {
  const cleaned = raw
    .trim()
    .replace(/^```(json)?/i, "")
    .replace(/```$/, "")
    .trim();
  const parsed = JSON.parse(cleaned);

  const validIds = new Set(catalog.map((c) => c.id));
  const partyName =
    typeof parsed.partyName === "string" && parsed.partyName.trim() ? parsed.partyName.trim().slice(0, 200) : null;

  const rawItems = Array.isArray(parsed.items) ? parsed.items : [];
  const items: ParsedOrderItem[] = [];

  for (const item of rawItems) {
    if (!item || typeof item.productName !== "string" || !item.productName.trim()) continue;
    const quantity = typeof item.quantity === "number" && item.quantity > 0 ? item.quantity : 1;
    const unit = typeof item.unit === "string" && item.unit.trim() ? item.unit.trim().slice(0, 20) : "pcs";
    const matchedProductId =
      typeof item.matchedProductId === "string" && validIds.has(item.matchedProductId) ? item.matchedProductId : null;

    items.push({
      productName: item.productName.trim().slice(0, 200),
      quantity,
      unit,
      matchedProductId,
    });
  }

  return { partyName, items };
}

export async function parseOrderText(text: string, catalog: CatalogEntry[]): Promise<ParsedOrder> {
  if (!env.openaiApiKey) {
    throw new AiNotConfiguredError();
  }

  const client = new OpenAI({ apiKey: env.openaiApiKey });
  const response = await client.chat.completions.create({
    model: "gpt-4o-mini",
    response_format: { type: "json_object" },
    messages: [{ role: "user", content: buildPrompt(text, catalog) }],
  });

  const raw = response.choices[0]?.message?.content;
  if (!raw) {
    throw new Error("AI returned an empty response");
  }

  return parseAndValidate(raw, catalog);
}
