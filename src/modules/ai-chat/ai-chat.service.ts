import { HydratedDocument } from "mongoose";
import { env } from "../../config/env";
import { GROQ_CHAT_MODEL, getGroqClient } from "../../config/groq";
import { assertAiTokens, recordAiTokens } from "../billing/subscription.service";
import { AiChatMessage, type ActionType, type AiChatMessageDocument } from "../../models/AiChatMessage";
import { Customer } from "../../models/Customer";
import { Staff } from "../../models/Staff";
import { buildFullBusinessContext } from "./business-context";
import { markAttendance } from "../attendance/attendance.service";
import { saveOrder } from "../orders/orders.service";
import {
  createOrderActionSchema,
  markAttendanceActionSchema,
} from "./ai-chat.schemas";

export class AiChatNotConfiguredError extends Error {
  constructor() {
    super("The AI business assistant is not configured (missing GROQ_API_KEY)");
    this.name = "AiChatNotConfiguredError";
  }
}

export type ReplyLanguage = "en" | "hi" | "hi-Latn";

const HINGLISH_RULE =
  'Reply ONLY in Hinglish: everyday Hindi written in Roman letters, every sentence of it — e.g. "Khartaal Wooden ka stock khatam ho gaya hai, jaldi mangwa lijiye." Use English only for business words people say anyway (stock, bill, GST, order, purchase, supplier). Never write full English sentences, even if earlier replies in this chat or the data are in English. Do not use Devanagari.';

/**
 * Which language to reply in, sent last so it wins over the chat history. The
 * app's language setting decides (an owner on Hinglish wants Hinglish even when
 * earlier replies drifted into English); typing in Devanagari always gets Hindi.
 */
function languageRule(message: string, language?: ReplyLanguage): string {
  if (/[ऀ-ॿ]/.test(message) || language === "hi") {
    return "Reply in everyday spoken Hindi written in Devanagari (not formal or Sanskritized), every sentence of it, even if earlier replies were in another language.";
  }
  if (language === "hi-Latn") return HINGLISH_RULE;
  // English app (or an old app version that sends no language): follow how they wrote.
  return "The user wrote in Roman (Latin) letters: reply ONLY in Roman letters — Hinglish if they used Hindi words, simple English if they wrote English. Do not use Devanagari. Keep to one language for the whole reply.";
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Full snapshot of the business (see business-context.ts) — fed to the model
// on every turn so answers use real figures instead of guessing.
async function buildBusinessContext(tenantId: string): Promise<string> {
  return buildFullBusinessContext(tenantId);
}

const SYSTEM_PROMPT = `You are Munshi AI, the business assistant inside SethSathi — an app Indian wholesalers, distributors and shopkeepers use for sales, purchases, stock, customers, suppliers, staff and GST. You are like a sharp, friendly munshi (accountant) who knows this business's books by heart.

## Language
Reply in the same language AND script as the user's latest message. Hindi in Roman letters → Roman-script Hinglish. Devanagari → everyday spoken Hindi in Devanagari (not formal/Sanskritized). English → simple English. Keep business words people actually use (stock, bill, GST, udhaar, party).
Stay in that one language for the whole reply: a Hinglish reply must never switch to full English sentences (say "Agar kisi par udhaar hua to Customers → Khata mein dikhega", not "If a customer starts owing, you can check…"). Replies are often read aloud, so write the way a person speaks.

## Answering business questions
- A JSON snapshot of the business's real data is provided every turn: sales (today, yesterday, last 7 days, this/last month, top products), profit estimate, GST this month, purchases, dues, every product with live stock/prices/reorder level, warehouses, customers and suppliers with balances, recent bills and purchases, pending orders and staff with today's attendance.
- Answer ANY question about the business from it: totals, comparisons ("this month vs last month"), a product's stock or price, who owes the most, which items to reorder, best sellers, a customer's or supplier's balance, a bill's status, GST payable, profit, staff present today, etc. Work things out (sums, differences, percentages, averages) when the data allows.
- Never invent numbers, names or dates that are not in the snapshot or derivable from it. If something isn't in the data, say so plainly and tell them where in the app to look or how to record it.
- If a value is 0 or a list is empty, say so clearly and suggest the next step (e.g. "No stock recorded yet — record a purchase or use Stock in/out in Inventory").
- Tone: calm, warm and respectful, like a trusted munshi talking to the owner across the counter. Start with one short, natural sentence that answers (e.g. "6 cheezein khatam ho gayi hain, inhe jaldi mangwa lijiye."), not a cold heading like "Reorder karne ke liye sabhi items:". Show a little care where it fits ("chinta mat kijiye", "achhi baat hai"), never over the top.
- Then at most 2–3 short supporting lines. Use **bold** for key figures and short "- " bullet lists when listing items; list at most the 5 most important and say how many more there are. No tables, no headings. Amounts in ₹ with Indian digit grouping (₹1,25,000). Say negative stock plainly ("stock minus mein hai — bina stock ke bill bane hain").
- You may give short, practical business advice when asked (pricing, reorder timing, collecting udhaar, slow-moving stock, GST basics), grounded in their data. For legal or tax filing, add that they should confirm with their CA.
- If the question has nothing to do with business or SethSathi, politely say you help with their business and the app, and offer an example question.

## How SethSathi works (use this to answer "how do I…" questions)
- Sales: "New order" notes what a customer asked for (Munshi can read a pasted WhatsApp message). "New sale" makes a bill: tap "Counter sale" for a walk-in (no name; paid by cash/UPI/bank on the spot) or pick a customer (their pending order items load). Search items by name/SKU/barcode; set quantity, box or piece, discount %; choose simple or GST bill. Selling more than stock, or going over a customer's credit limit, shows a warning with "Bill anyway". Selling reduces stock automatically.
- A bill can be printed (A4 or small thermal receipt), saved as PDF, or sent on WhatsApp; it shows a UPI QR for the amount due if the UPI ID is set in Settings → Bills. GST bills split CGST+SGST (same state) or IGST (other state) and show HSN, discount and round-off.
- On a bill: record payments (part payments allowed), "Return items" makes a credit note (stock comes back; it first reduces what they owe, else refund by cash/UPI), owner/manager can "Cancel this bill" if made by mistake (only bills without payments, except counter sales).
- Purchases: "New purchase" records a supplier bill — stock goes up automatically and the supplier's balance grows by what's unpaid. Batch number + expiry for medicines/food items, IMEI numbers for mobiles. Pay suppliers from the purchase.
- Inventory: add items with cost, wholesale and retail price, GST rate and HSN, reorder level; "More options" sets a bigger pack (1 box = 12 pcs), batch & expiry tracking, IMEI/serial tracking, size and colour. "Import from Excel" brings a whole item list; "Sizes & colours" creates every size/colour of a design at once. Expiring-soon batches are listed. Raw materials + recipe (BOM) and assembly; QR labels.
- Cash book (Rokad bahi): the day's sales, money received by cash/UPI/bank, money paid out (suppliers, expenses, refunds, salaries), and how much cash should be in the galla; add expenses (rent, electricity, tea, transport) and close the day by entering the counted cash.
- Customers: phone, credit limit (max udhaar), GSTIN/address/state for GST bills, khata (ledger), WhatsApp reminders.
- Suppliers, Warehouses (godowns/shops with stock value), Staff (schedules, attendance, payroll).
- Reports: Sales, Purchases, Profit (estimate), Stock (incl. items not selling), Dues and GST, by period incl. the financial year; every table downloads as CSV for Excel/CA.
- Settings: Business (name, phone, address, state), GST (GSTIN), Bills (UPI ID, bank details, terms; preview), Team (staff logins: manager, salesman, godown staff — each sees only their work), Activity (who made/cancelled which bill, price and stock changes), language, display size.
- Search (top bar or Ctrl+K) finds any customer, product, bill, purchase, or an IMEI number.

## Actions
If the user explicitly asks you to DO something that changes data (mark attendance, create an order), call the matching tool with the details you can extract. Never call a tool for something the user only asked about. If required details are missing (which staff member, what date, which items), ask a short clarifying question instead of guessing. You cannot act directly — calling a tool only proposes the action for the user to review and confirm.`;

const tools = [
  {
    type: "function" as const,
    function: {
      name: "mark_attendance",
      description: "Propose marking a staff member's attendance for a specific date.",
      parameters: {
        type: "object",
        properties: {
          staffName: { type: "string", description: "The staff member's name as mentioned by the user" },
          date: { type: "string", description: "Date in YYYY-MM-DD format. Use today's date if the user says 'today'." },
          status: { type: "string", enum: ["present", "absent", "half_day", "leave"] },
        },
        required: ["staffName", "date", "status"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "create_order",
      description: "Propose creating a new sales order for a customer.",
      parameters: {
        type: "object",
        properties: {
          customerName: { type: "string", description: "The customer/party name as mentioned by the user" },
          items: {
            type: "array",
            items: {
              type: "object",
              properties: {
                productName: { type: "string" },
                quantity: { type: "number" },
                unit: { type: "string" },
                unitPrice: { type: "number", description: "Use 0 if not mentioned" },
              },
              required: ["productName", "quantity"],
            },
          },
        },
        required: ["customerName", "items"],
      },
    },
  },
];

export interface SendMessageResult {
  userMessage: HydratedDocument<AiChatMessageDocument>;
  assistantMessage: HydratedDocument<AiChatMessageDocument>;
}

export async function listMessages(tenantId: string) {
  return AiChatMessage.find({ tenantId }).sort({ createdAt: 1 }).limit(100);
}

export async function sendMessage(tenantId: string, userId: string, content: string, language?: ReplyLanguage): Promise<SendMessageResult> {
  if (!env.groqApiKey) {
    throw new AiChatNotConfiguredError();
  }
  await assertAiTokens(tenantId);

  const userMessage = await AiChatMessage.create({ tenantId, role: "user", content, createdBy: userId });

  const history = await AiChatMessage.find({ tenantId }).sort({ createdAt: -1 }).limit(10);
  const context = await buildBusinessContext(tenantId);
  const today = new Date().toISOString().slice(0, 10);

  const client = getGroqClient();
  const response = await client.chat.completions.create({
    model: GROQ_CHAT_MODEL,
    tools,
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "system", content: `Today's date: ${today}. Business data snapshot (JSON): ${context}` },
      ...history
        .slice()
        .reverse()
        .slice(0, -1) // the just-created user message is appended explicitly below
        .map((m) => ({ role: m.role, content: m.content })),
      { role: "system", content: languageRule(content, language) },
      { role: "user", content },
    ],
  });

  await recordAiTokens(tenantId, response.usage);
  const choice = response.choices[0];
  const rawToolCall = choice?.message?.tool_calls?.[0];
  const toolCall = rawToolCall && rawToolCall.type === "function" ? rawToolCall : undefined;

  let assistantContent = choice?.message?.content?.trim() || "";
  let proposedAction: { type: ActionType; payload: Record<string, unknown>; status: "pending" } | undefined;

  if (toolCall && (toolCall.function.name === "mark_attendance" || toolCall.function.name === "create_order")) {
    const actionType = toolCall.function.name;
    try {
      const args = JSON.parse(toolCall.function.arguments);
      proposedAction = { type: actionType, payload: args, status: "pending" };
      if (!assistantContent) {
        assistantContent =
          actionType === "mark_attendance"
            ? `I'll mark ${args.staffName} as ${String(args.status).replace("_", " ")} on ${args.date}. Confirm to save it.`
            : `I'll create a new order for ${args.customerName}. Confirm to save it.`;
      }
    } catch {
      // malformed tool arguments — fall back to a plain text reply, never
      // propose an action from data we couldn't even parse.
      assistantContent = assistantContent || "Sorry, I couldn't understand that clearly. Could you rephrase?";
    }
  }

  if (!assistantContent) {
    assistantContent = "Sorry, I couldn't come up with an answer. Could you rephrase that?";
  }

  const assistantMessage = await AiChatMessage.create({
    tenantId,
    role: "assistant",
    content: assistantContent,
    proposedAction,
    createdBy: userId,
  });

  return { userMessage, assistantMessage };
}

export async function confirmAction(tenantId: string, userId: string, messageId: string) {
  const message = await AiChatMessage.findOne({ _id: messageId, tenantId });
  if (!message || !message.proposedAction) {
    throw new Error("No proposed action found for this message");
  }
  if (message.proposedAction.status !== "pending") {
    throw new Error("This action has already been handled");
  }

  let resultSummary: string;

  if (message.proposedAction.type === "mark_attendance") {
    const parsed = markAttendanceActionSchema.safeParse(message.proposedAction.payload);
    if (!parsed.success) throw new Error("Invalid attendance action data");

    const staff = await Staff.findOne({
      tenantId,
      name: { $regex: `^${escapeRegex(parsed.data.staffName)}$`, $options: "i" },
    });
    if (!staff) throw new Error(`No staff member named "${parsed.data.staffName}" found`);

    await markAttendance(tenantId, userId, {
      staffId: String(staff._id),
      date: parsed.data.date,
      status: parsed.data.status,
    });
    resultSummary = `Marked ${staff.name} as ${parsed.data.status.replace("_", " ")} on ${parsed.data.date}.`;
  } else if (message.proposedAction.type === "create_order") {
    const parsed = createOrderActionSchema.safeParse(message.proposedAction.payload);
    if (!parsed.success) throw new Error("Invalid order action data");

    const customer = await Customer.findOne({
      tenantId,
      name: { $regex: `^${escapeRegex(parsed.data.customerName)}$`, $options: "i" },
      isActive: true,
    });
    if (!customer) {
      throw new Error(`No customer named "${parsed.data.customerName}" found — add them first, then retry.`);
    }

    const { order } = await saveOrder(tenantId, userId, {
      customerId: String(customer._id),
      items: parsed.data.items.map((i) => ({
        productName: i.productName,
        quantity: i.quantity,
        unit: i.unit,
        unitPrice: i.unitPrice,
        isNewProduct: true,
      })),
      source: "ai_parsed",
    });
    resultSummary = `Created order ${String(order._id).slice(-6).toUpperCase()} for ${customer.name}.`;
  } else {
    throw new Error("Unknown action type");
  }

  message.proposedAction.status = "confirmed";
  message.proposedAction.resultSummary = resultSummary;
  await message.save();

  return message;
}

export async function dismissAction(tenantId: string, messageId: string) {
  const message = await AiChatMessage.findOne({ _id: messageId, tenantId });
  if (!message || !message.proposedAction) {
    throw new Error("No proposed action found for this message");
  }
  if (message.proposedAction.status !== "pending") {
    throw new Error("This action has already been handled");
  }

  message.proposedAction.status = "dismissed";
  await message.save();
  return message;
}

/**
 * AI search: a one-off question answered from the business snapshot. Not saved
 * to the Munshi AI chat history and never proposes actions — just a short answer.
 */
export async function askBusinessQuestion(tenantId: string, question: string, language?: ReplyLanguage): Promise<string> {
  if (!env.groqApiKey) {
    throw new AiChatNotConfiguredError();
  }
  await assertAiTokens(tenantId);
  const context = await buildBusinessContext(tenantId);
  const today = new Date().toISOString().slice(0, 10);

  const response = await getGroqClient().chat.completions.create({
    model: GROQ_CHAT_MODEL,
    reasoning_effort: "low",
    max_completion_tokens: 900,
    temperature: 0.3,
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      {
        role: "system",
        content:
          "This is a quick search, not a chat: answer in 1 to 3 short sentences (or a very short list), lead with the number or name asked for, no markdown headings. Do not offer to create orders or mark attendance here.",
      },
      { role: "system", content: `Today's date: ${today}. Business data snapshot (JSON): ${context}` },
      { role: "system", content: languageRule(question, language) },
      { role: "user", content: question },
    ],
  });
  await recordAiTokens(tenantId, response.usage);
  return response.choices[0]?.message?.content?.trim() || "";
}
