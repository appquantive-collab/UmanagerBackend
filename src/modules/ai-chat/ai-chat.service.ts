import { HydratedDocument } from "mongoose";
import { env } from "../../config/env";
import { GROQ_FALLBACK_MODEL, chatWithFallback, getGroqClient } from "../../config/groq";
import { assertAiTokens, recordAiTokens } from "../billing/subscription.service";
import { AiChatMessage, type ActionType, type AiChatMessageDocument } from "../../models/AiChatMessage";
import { Customer } from "../../models/Customer";
import { Staff } from "../../models/Staff";
import { buildFullBusinessContext } from "./business-context";
import { Tenant } from "../../models/Tenant";
import { tradeLine } from "../tenants/trade.service";
import type { UserRole } from "../../models/User";
import { StepError, planSteps, runStep, stepSignature, stepsForHistory, workflowTools } from "./workflow";
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
  const [snapshot, tenant] = await Promise.all([
    buildFullBusinessContext(tenantId),
    Tenant.findById(tenantId, { "onboarding.trade": 1 }).lean(),
  ]);
  // How they buy and sell (kilo in, meter out…) so Munshi talks in their units.
  const trade = tradeLine(tenant?.onboarding?.trade);
  return trade ? `${snapshot}\n${trade}` : snapshot;
}

const SYSTEM_PROMPT = `You are Munshi AI, the business assistant inside VoiceMunshi — an app Indian wholesalers, distributors and shopkeepers use for sales, purchases, stock, customers, suppliers, staff and GST. You are like a sharp, friendly munshi (accountant) who knows this business's books by heart.

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
- If the question has nothing to do with business or VoiceMunshi, politely say you help with their business and the app, and offer an example question.
- After an answer (not when you propose steps or ask a question), add ONE last line that starts with ">> " and holds 3 short follow-up questions the owner would naturally ask next about THIS answer, separated by " | ", in the same language and script as your reply, each under 7 words. Example after a reorder answer: ">> Khartaal kitna mangwaun? | Supplier kaun hai? | Kal ki bikri kitni thi?"

## How VoiceMunshi works (use this to answer "how do I…" questions)
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

## Doing work (workflows)
When the user asks you to DO something that changes data, call tools to propose it. Each tool call becomes one step the user reviews and confirms in order; you cannot act directly.
- One message can hold several jobs. Put ALL of them in ONE propose_steps call as a list, one step per job, in the order they happened. Example: "Rajesh ji se 5 kg aalu liya, Ravi aur Kishan ko 1-1 kg becha, dono ke bill banao" → propose_steps with steps: record_purchase (Rajesh, Aalu 5 kg), create_bill (Ravi, Aalu 1 kg), create_bill (Kishan, Aalu 1 kg).
- Bought / took goods from someone (liya, kharida, mangwaya, aaya) → record_purchase. Sold / gave goods (becha, bech diya, de diya) or "bill banao" → create_bill, one per customer. A customer asking for goods to be sent later → create_order.
- You can do almost every job in the app: purchases, bills, orders, billing an order, money received from customers, paying suppliers, shop expenses, editing or cancelling a bill, changing a saved customer / supplier / item (name, phone, price) or staff member, fixing stock, attendance, adding staff. Use a step for any of these; never tell the owner to go and do it on a screen.
- To fix something already done ("pichla bill galat hai, 10 kg tha", "Ravi ka number galat hai", "dubara karo"), make the matching edit step (edit_bill with the bill number and the full corrected items, update_customer, update_product, adjust_stock…) instead of making a new one.
- "Staff / worker / karigar add karo" (with department, mobile, salary or daily wage if said) → one create_staff step per person; "Pulkit ko labour department mein daal do" sets that step's department. You CAN add staff: never send the owner to Settings for it.
- "Supplier/customer/item add karo" → a create_supplier / create_customer / create_product step. Missing suppliers, customers and items for purchases and bills are added automatically as extra steps; do not add them yourself, and never ask "item/supplier list mein nahi hai, add karein?": just propose the job.
- Use names, quantities, units and prices exactly as said; never invent prices, discounts or amounts. Leave a price out if it wasn't said (the item's saved price is used).
- If something essential is missing (the name of the person, which item, how many) or it's unclear whether they sold or only took an order, call ask_user with one short question and real tappable options (names from the snapshot or plain choices, never made-up names); you may also call propose_steps for whatever IS clear. If the user just says "supplier add karo" with no name, ask for the name.
- Quantity and rate in different units ("2 kilo kapda bech do, 50 rupaye per meter"): never put a per-meter rate on kilos. If the business data gives the conversion (e.g. "1 kg ≈ 7 meter"), convert the quantity to the rate's unit (2 kg ≈ 14 meter @ ₹50) and say in your text that you converted it so they can correct it; otherwise call ask_user ("2 kilo mein kitne meter hue?") and propose only the other steps.
- If the user corrects or adds to steps still waiting ("nahi, 10 kg tha", "inka naam Rajesh hai, mobile 99999 94422"), call propose_steps again with the full corrected list of the waiting steps; it replaces the old list. Never answer a correction in plain text.
- Keep your text short: one line saying what you've prepared (e.g. "Teen kaam taiyaar hain — ek-ek karke confirm kijiye."). Don't repeat every detail; the steps show them. Never write step or tool names (create_supplier, record_purchase…) in your text.
- Never call a tool for something the user only asked about.
- Steps shown in the history as "→ confirmed" are DONE and saved (the summary has the bill / purchase number). Never propose them again, and never ask the user to confirm them again. If the user asks why something is repeating or says it's already done, agree it's done, name what was made (e.g. "Ravi ji ka bill INV-0003 ban chuka hai"), apologise briefly, and stop; propose nothing.`;

export interface SendMessageResult {
  userMessage: HydratedDocument<AiChatMessageDocument>;
  assistantMessage: HydratedDocument<AiChatMessageDocument>;
  /** A step done by saying "haan": for the activity log. */
  audit?: StepAudit;
}

type StepAudit = { action: string; summary: string; entityId?: string; amount?: number };

export async function listMessages(tenantId: string) {
  return AiChatMessage.find({ tenantId }).sort({ createdAt: 1 }).limit(100);
}

export async function sendMessage(
  tenantId: string,
  userId: string,
  role: UserRole,
  content: string,
  language?: ReplyLanguage
): Promise<SendMessageResult> {
  if (!env.groqApiKey) {
    throw new AiChatNotConfiguredError();
  }

  // A workflow still waiting for confirmation: the user's message may answer or correct it.
  const waiting = await AiChatMessage.findOne({ tenantId, role: "assistant", "steps.status": "pending" }).sort({ createdAt: -1 });

  // "Haan / aage badho / theek hai" or "nahi / chhodo" while a step is open: do or skip
  // that step right here (by voice or text), no AI call needed.
  const intent = quickIntent(content);
  if (waiting && intent) {
    const userMessage = await AiChatMessage.create({ tenantId, role: "user", content, createdBy: userId });
    return answerOpenStep(tenantId, userId, role, waiting, intent, userMessage, language ?? "hi-Latn");
  }
  // Just "haan / theek hai / sahi h / ok" right after a list that's all done: a short
  // reply, no AI (asking the AI made it re-propose the steps already done). After a
  // question or a normal answer, "haan" still goes to Munshi, who needs it.
  const lastReply = intent ? await AiChatMessage.findOne({ tenantId, role: "assistant" }).sort({ createdAt: -1 }).lean() : null;
  const lastListDone = Boolean(lastReply?.steps?.length && lastReply.steps.every((s) => s.status !== "pending") && !lastReply.quickReplies?.length);
  if (intent && lastListDone) {
    const userMessage = await AiChatMessage.create({ tenantId, role: "user", content, createdBy: userId });
    const lang = language ?? "hi-Latn";
    const ack =
      intent === "yes"
        ? { "hi-Latn": "Theek hai ji 👍 Aur kuch karna ho to batayein.", hi: "ठीक है जी 👍 और कुछ करना हो तो बताइए।", en: "Okay 👍 Tell me if there's anything else." }[lang]
        : { "hi-Latn": "Theek hai, kuch nahi kiya. Aur kuch?", hi: "ठीक है, कुछ नहीं किया। और कुछ?", en: "Okay, nothing done. Anything else?" }[lang];
    const assistantMessage = await AiChatMessage.create({ tenantId, role: "assistant", content: ack, createdBy: userId });
    return { userMessage, assistantMessage };
  }

  await assertAiTokens(tenantId);

  const userMessage = await AiChatMessage.create({ tenantId, role: "user", content, createdBy: userId });

  const history = await AiChatMessage.find({ tenantId }).sort({ createdAt: -1 }).limit(10);
  const context = await buildBusinessContext(tenantId);
  const today = new Date().toISOString().slice(0, 10);

  const openWorkflow = waiting;

  const client = getGroqClient();
  const messages = [
    { role: "system" as const, content: SYSTEM_PROMPT },
    { role: "system" as const, content: `Today's date: ${today}. Business data snapshot (JSON): ${context}` },
    ...history
      .slice()
      .reverse()
      .slice(0, -1) // the just-created user message is appended explicitly below
      .map((m) => ({ role: m.role, content: m.content + (m.role === "assistant" ? stepsForHistory(m.steps) : "") })),
    ...(openWorkflow
      ? [
          {
            role: "system" as const,
            content:
              "Steps from your last list are still waiting for the user. If this message corrects or adds details to them (a name, phone, quantity, price, item), call propose_steps again with the FULL corrected list of the steps that are still waiting (not the done ones). Do not reply with the list as text.",
          },
        ]
      : []),
    { role: "system" as const, content: languageRule(content, language) },
    { role: "user" as const, content },
  ];
  const askOnce = (force: boolean) =>
    chatWithFallback((model) =>
      client.chat.completions.create({
        model,
        tools: workflowTools,
        ...(force ? { tool_choice: { type: "function" as const, function: { name: "propose_steps" } } } : {}),
        messages,
      })
    );
  // Groq rejects a reply whose tool call doesn't fit the schema ("tool call validation
  // failed"); the model usually gets it right on a second try.
  const ask = async (force: boolean) => {
    try {
      return await askOnce(force);
    } catch (err) {
      const e = err as { status?: number; message?: string };
      if (e.status !== 400 || !/tool call validation|tool_use_failed|failed to call a function/i.test(e.message ?? "")) throw err;
      console.warn("[ai-chat] tool call rejected, asking again:", (e.message ?? "").slice(0, 200));
      return askOnce(force);
    }
  };

  let response = await ask(false);
  await recordAiTokens(tenantId, response.usage, { kind: "chat", model: response.model });
  let choice = response.choices[0];
  // The model sometimes answers a correction by writing the steps out as text
  // ("create_supplier – name: Rajesh…"). Ask once more, this time for a card.
  const wroteStepsAsText = (text: string) =>
    /\b(create_\w+|update_\w+|record_purchase|mark_attendance|receive_payment|pay_supplier|add_expense|edit_bill|cancel_bill|bill_order|adjust_stock)\b/.test(text);
  if (!choice?.message?.tool_calls?.length && openWorkflow && wroteStepsAsText(choice?.message?.content ?? "")) {
    response = await ask(true);
    await recordAiTokens(tenantId, response.usage, { kind: "chat", model: response.model });
    choice = response.choices[0];
  }
  // Every tool call is one step, in the order the user said them.
  const calls = (choice?.message?.tool_calls ?? [])
    .filter((c) => c.type === "function")
    .map((c) => ({ name: c.function.name, arguments: c.function.arguments }));
  const { steps, question } = calls.length ? await planSteps(tenantId, calls) : { steps: [], question: undefined };

  // Never offer again a job already done in this chat (a bill, purchase or order with the
  // same party and items), unless the person clearly asks for it again.
  const alreadyDone: string[] = [];
  if (steps.length && !/\b(phir se|fir se|dobara|dubara|ek aur|aur ek|again|another|repeat)\b|फिर से|दोबारा|एक और/i.test(content)) {
    const recent = await AiChatMessage.find({ tenantId, role: "assistant", "steps.status": "confirmed" }, { steps: 1 })
      .sort({ createdAt: -1 })
      .limit(30)
      .lean();
    const done = new Map<string, string | undefined>();
    for (const m of recent) for (const s of m.steps ?? []) if (s.status === "confirmed") done.set(stepSignature(s.type, s.payload), s.resultSummary);
    for (let i = steps.length - 1; i >= 0; i--) {
      const sig = stepSignature(steps[i].type, steps[i].payload);
      if (done.has(sig)) {
        alreadyDone.unshift(done.get(sig) ?? steps[i].type);
        steps.splice(i, 1);
      }
    }
    // An "add Ravi first" step left on its own once its bill was dropped isn't wanted either.
    if (steps.length && steps.every((s) => s.auto)) steps.length = 0;
  }

  // A new list replaces the old one's waiting steps, so only one list is open at a time.
  // The same list again (the model re-sent it instead of moving on): keep the open one.
  const sameAsOpen =
    openWorkflow &&
    steps.length > 0 &&
    JSON.stringify(steps.map((s) => [s.type, s.payload])) ===
      JSON.stringify((openWorkflow.steps ?? []).filter((s) => s.status === "pending").map((s) => [s.type, s.payload]));
  if (sameAsOpen) steps.length = 0;

  // The user filled in or corrected the waiting steps (by voice or text): change them in
  // the same list, and if the open one changed, do it straight away and move to the next.
  const waitingSteps = openWorkflow ? (openWorkflow.steps ?? []).filter((s) => s.status === "pending") : [];
  if (openWorkflow && !question && steps.length && steps.length === waitingSteps.length && steps.every((s, i) => s.type === waitingSteps[i].type)) {
    const lang = language ?? "hi-Latn";
    const words = STEP_WORDS[lang];
    const openChanged = JSON.stringify(waitingSteps[0].payload) !== JSON.stringify(steps[0].payload);
    waitingSteps.forEach((s, i) => {
      s.payload = steps[i].payload;
    });
    openWorkflow.markModified("steps");
    await openWorkflow.save();
    let reply = words.updated;
    let audit: StepAudit | undefined;
    if (openChanged) {
      try {
        const result = await confirmStep(tenantId, userId, role, String(openWorkflow._id), waitingSteps[0].id, {});
        audit = result.audit;
        const ref = result.message.steps?.find((s) => s.id === waitingSteps[0].id)?.resultSummary;
        reply = `${words.done}${ref ? ` (${ref})` : ""}. ${(result.message.steps ?? []).some((s) => s.status === "pending") ? words.next : words.allDone}`;
      } catch (err) {
        reply = `${words.updated} ${words.failed} ${(err as Error).message}`;
      }
    }
    const assistantMessage = await AiChatMessage.create({ tenantId, role: "assistant", content: reply, createdBy: userId });
    return { userMessage, assistantMessage, audit };
  }

  if (steps.length && openWorkflow) {
    for (const step of openWorkflow.steps ?? []) {
      if (step.status === "pending") {
        step.status = "dismissed";
        step.replaced = true;
      }
    }
    openWorkflow.markModified("steps");
    await openWorkflow.save();
  }

  // Follow-up questions ride on the last ">> a | b | c" line: shown as chips, never as text or speech.
  const { text: replyText, followUps } = splitFollowUps(choice?.message?.content?.trim() || "");
  let assistantContent = replyText;
  // Never show internal step names; the card shows the steps.
  if (steps.length && wroteStepsAsText(assistantContent)) assistantContent = "";
  if (question) assistantContent = assistantContent ? `${assistantContent}\n\n${question.text}` : question.text;
  if (!assistantContent && steps.length) assistantContent = workflowIntro(steps.length, language ?? "hi-Latn");
  const lang = language ?? "hi-Latn";
  if (!steps.length && alreadyDone.length) {
    // What the AI wrote was about the duplicate it proposed: say plainly it's already done.
    const refs = alreadyDone.filter((r) => /\d/.test(r)).join(", ");
    assistantContent = {
      "hi-Latn": `Yeh kaam pehle hi ho chuka hai${refs ? ` (${refs})` : ""}, dobara nahi banaya. Phir se chahiye to "phir se banao" boliye.`,
      hi: `यह काम पहले ही हो चुका है${refs ? ` (${refs})` : ""}, दोबारा नहीं बनाया। फिर से चाहिए तो "फिर से बनाओ" बोलिए।`,
      en: `That's already done${refs ? ` (${refs})` : ""}, so I didn't make it again. Say "make it again" if you want another.`,
    }[lang];
  }
  if (!assistantContent) {
    console.warn(
      `[ai-chat] empty reply (finish ${choice?.finish_reason}, model ${response.model}, tool calls ${JSON.stringify(calls).slice(0, 400)}, text ${JSON.stringify(choice?.message?.content ?? "").slice(0, 200)})`
    );
    assistantContent = {
      "hi-Latn": "Maaf kijiye, yeh samajh nahi paya. Thoda alag tarah se batayenge?",
      hi: "माफ़ कीजिए, यह समझ नहीं पाया। थोड़ा अलग तरह से बताएँगे?",
      en: "Sorry, I couldn't come up with an answer. Could you rephrase that?",
    }[lang];
  }

  // The model forgot the ">>" line: the small model writes follow-ups for THIS answer,
  // so the chips are never the generic starters after a real answer.
  const finalFollowUps =
    !steps.length && !question && !alreadyDone.length && followUps.length === 0 && replyText
      ? await suggestFollowUps(tenantId, content, assistantContent, lang)
      : followUps;

  const assistantMessage = await AiChatMessage.create({
    tenantId,
    role: "assistant",
    content: assistantContent,
    ...(steps.length ? { steps } : {}),
    ...(question?.options.length ? { quickReplies: question.options } : {}),
    ...(!steps.length && !question && finalFollowUps.length ? { followUps: finalFollowUps } : {}),
    createdBy: userId,
  });

  return { userMessage, assistantMessage };
}

const YES = /^(haan|han|ha|haa|haanji|ji|ji haan|haan ji|ok|okay|ok ji|theek|thik|theek hai|thik hai|sahi|sahi hai|aage|aage badho|aage chalo|chalo|kar do|kardo|karo|kar dijiye|confirm|confirm karo|yes|yep|sure|done|go ahead|proceed|bilkul|हाँ|हां|हाँ जी|जी|ठीक|ठीक है|सही है|आगे|आगे बढ़ो|कर दो|करो)$/;
const NO = /^(nahi|nahin|na|no|skip|chhodo|chhod do|chodo|rehne do|mat karo|cancel|नहीं|ना|छोड़ो|छोड़ दो|रहने दो)$/;

/** A short yes / no to the open step (words like "bhai", "please" and punctuation ignored); null for anything else. */
export function quickIntent(text: string): "yes" | "no" | null {
  const words = text
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}\s]+/gu, " ")
    .replace(/[.,!?।"'\x60]+/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => (w === "h" || w === "he" || w === "hain" ? "hai" : w));
  if (words.length === 0 || words.length > 6) return null;
  // Fillers around the answer ("theek hai bhai", "yes please") don't change it.
  const FILLER = new Set(["bhai", "bhaiya", "please", "plz", "to", "toh", "abhi", "ab", "phir", "sir", "भाई", "अब"]);
  const core = words.filter((w) => !FILLER.has(w));
  const t = (core.length ? core : words).join(" ");
  // "Haan kariye fatafat", "theek hai bana do", "ji jaldi karo": a yes word first, then only
  // words that push it along (no numbers or changes, those go to Munshi).
  const LEAD_YES = new Set(["haan", "han", "ha", "haa", "haanji", "ji", "ok", "okay", "theek", "thik", "sahi", "yes", "हाँ", "हां", "ठीक", "जी"]);
  const PUSH_ON = new Set([
    "hai", "ji", "kariye", "kijiye", "karo", "kar", "karein", "karen", "do", "dijiye", "de", "dena", "jaldi", "fatafat", "please", "abhi", "ab",
    "chalo", "aage", "badho", "banao", "bana", "banaiye", "banado", "confirm", "theek", "thik", "sahi", "ok", "haan", "bilkul",
    "करो", "कर", "दो", "दीजिए", "करिए", "करें", "जल्दी", "फटाफट", "बनाओ", "बनाइए", "है", "जी", "हाँ",
  ]);
  const said = core.length ? core : words;
  if (LEAD_YES.has(said[0]) && said.slice(1).every((w) => PUSH_ON.has(w))) return "yes";
  if (YES.test(t)) return "yes";
  if (NO.test(t)) return "no";
  // "theek hai aage badho", "haan kar do": every part is a yes phrase.
  const parts = t.split(/ (?=aage|kar|chalo|confirm|theek|thik|haan|sahi|आगे|कर|ठीक)/);
  if (parts.length > 1 && parts.every((p) => YES.test(p.trim()))) return "yes";
  return null;
}

const STEP_WORDS: Record<ReplyLanguage, { done: string; skipped: string; next: string; allDone: string; failed: string; updated: string }> = {
  "hi-Latn": {
    updated: "Badal diya, upar list mein dekh lijiye.",
    done: "Ho gaya ✓",
    skipped: "Theek hai, yeh kaam chhod diya.",
    next: "Agla kaam upar list mein khula hai. Sahi ho to \"haan\" boliye, ya wahin badliye.",
    allDone: "List ke saare kaam ho gaye.",
    failed: "Yeh kaam nahi ho paaya:",
  },
  hi: {
    updated: "बदल दिया, ऊपर सूची में देख लीजिए।",
    done: "हो गया ✓",
    skipped: "ठीक है, यह काम छोड़ दिया।",
    next: "अगला काम ऊपर सूची में खुला है। सही हो तो \"हाँ\" बोलिए, या वहीं बदलिए।",
    allDone: "सूची के सारे काम हो गए।",
    failed: "यह काम नहीं हो पाया:",
  },
  en: {
    updated: "Changed it, see the list above.",
    done: "Done ✓",
    skipped: "Okay, skipped that one.",
    next: "The next step is open in the list above. Say \"yes\" if it's right, or change it there.",
    allDone: "Everything in the list is done.",
    failed: "That step couldn't be done:",
  },
};

async function answerOpenStep(
  tenantId: string,
  userId: string,
  role: UserRole,
  waiting: HydratedDocument<AiChatMessageDocument>,
  intent: "yes" | "no",
  userMessage: HydratedDocument<AiChatMessageDocument>,
  language: ReplyLanguage
): Promise<SendMessageResult> {
  const words = STEP_WORDS[language];
  const step = (waiting.steps ?? []).find((s) => s.status === "pending")!;
  let reply: string;
  let audit: StepAudit | undefined;
  try {
    if (intent === "yes") {
      const result = await confirmStep(tenantId, userId, role, String(waiting._id), step.id, {});
      audit = result.audit;
      const ref = result.message.steps?.find((s) => s.id === step.id)?.resultSummary;
      reply = `${words.done}${ref ? ` (${ref})` : ""}.`;
    } else {
      await dismissStep(tenantId, String(waiting._id), step.id);
      reply = words.skipped;
    }
    const fresh = await AiChatMessage.findById(waiting._id);
    reply += " " + ((fresh?.steps ?? []).some((s) => s.status === "pending") ? words.next : words.allDone);
  } catch (err) {
    // Stock/credit warnings and missing parties: the card above shows the details and "do it anyway".
    reply = `${words.failed} ${(err as Error).message}`;
  }
  const assistantMessage = await AiChatMessage.create({ tenantId, role: "assistant", content: reply, createdBy: userId });
  return { userMessage, assistantMessage, audit };
}

const FOLLOW_UP_LANG: Record<ReplyLanguage, string> = {
  "hi-Latn": "Hinglish in Roman letters (like: Kal ki bikri kitni thi?)",
  hi: "Hindi in Devanagari",
  en: "simple English",
};

/**
 * Three short questions the shop owner would naturally ask next about this
 * answer (shown as tap-chips). Small fast model; on any failure, no chips.
 */
async function suggestFollowUps(tenantId: string, question: string, answer: string, language: ReplyLanguage): Promise<string[]> {
  try {
    const response = await getGroqClient().chat.completions.create(
      {
        model: GROQ_FALLBACK_MODEL,
        reasoning_effort: "low",
        temperature: 0.4,
        max_completion_tokens: 400,
        messages: [
          {
            role: "system",
            content: `You suggest what an Indian shop owner would tap next in a chat with Munshi, their business assistant (it knows their sales, stock, bills, udhaar, suppliers and can create bills, sales, purchases, customers). Given their question and Munshi's answer, write exactly 3 short follow-ups (each under 7 words) that continue THIS answer: dig deeper, act on it, or the obvious next check. Write them as the owner speaking, in ${FOLLOW_UP_LANG[language]}. No numbering. Reply with only one line: a | b | c`,
          },
          { role: "user", content: `Owner: ${question.slice(0, 400)}\nMunshi: ${answer.slice(0, 1200)}` },
        ],
      },
      { timeout: 2500, maxRetries: 0 }
    );
    await recordAiTokens(tenantId, response.usage, { kind: "chat", model: response.model });
    const line = (response.choices[0]?.message?.content ?? "").split("\n").find((l) => l.includes("|")) ?? "";
    return splitFollowUps(`>> ${line.replace(/^>>\s*/, "")}`).followUps.slice(0, 3);
  } catch (err) {
    console.warn("[ai-chat] follow-ups failed:", (err as Error).message.slice(0, 120));
    return [];
  }
}

/** Pull the ">> a | b | c" follow-up line (if any) off the end of a reply. */
export function splitFollowUps(raw: string): { text: string; followUps: string[] } {
  const lines = raw.split("\n");
  const followUps: string[] = [];
  const kept = lines.filter((line) => {
    const m = line.trim().match(/^(?:>>|»)\s*(.+)$/);
    if (!m) return true;
    for (const q of m[1].split("|")) {
      const clean = q.replace(/\*\*/g, "").trim();
      if (clean && clean.length <= 80 && followUps.length < 4) followUps.push(clean);
    }
    return false;
  });
  return { text: kept.join("\n").trim(), followUps };
}

function workflowIntro(count: number, language: ReplyLanguage): string {
  if (language === "en") return count === 1 ? "Here it is — check and confirm." : `I've made ${count} steps. Check each one and confirm.`;
  if (language === "hi") return count === 1 ? "यह रहा — देखकर पक्का कीजिए।" : `मैंने ${count} काम बनाए हैं। एक-एक करके देखिए और पक्का कीजिए।`;
  return count === 1 ? "Yeh raha — dekh kar confirm kijiye." : `Maine ${count} kaam banaye hain. Ek-ek karke dekhiye aur confirm kijiye.`;
}

/**
 * Do one step of a workflow (edited payload allowed). Steps go in order: an
 * earlier step still waiting must be done or skipped first, since later steps
 * may need what it adds (a supplier before their purchase).
 */
export async function confirmStep(
  tenantId: string,
  userId: string,
  role: UserRole,
  messageId: string,
  stepId: string,
  options: { payload?: Record<string, unknown>; force?: boolean }
) {
  const message = await AiChatMessage.findOne({ _id: messageId, tenantId });
  const steps = message?.steps ?? [];
  const index = steps.findIndex((s) => s.id === stepId);
  if (!message || index < 0) throw new StepError("Step not found", 404);
  const step = steps[index];
  if (step.status !== "pending") throw new StepError("This step has already been handled", 409);
  if (steps.slice(0, index).some((s) => s.status === "pending")) throw new StepError("Pehle upar wala kaam poora ya skip kijiye.", 409);

  const { payload, result } = await runStep(tenantId, userId, role, step.type, options.payload ?? step.payload, Boolean(options.force));
  // Update the stored step in place (spreading a Mongoose sub-document loses its fields).
  step.payload = payload;
  step.status = "confirmed";
  step.resultSummary = result.summary;
  if (result.resultId) step.resultId = result.resultId;
  message.markModified("steps");
  await message.save();
  return { message, audit: result.audit };
}

export async function dismissStep(tenantId: string, messageId: string, stepId: string) {
  const message = await AiChatMessage.findOne({ _id: messageId, tenantId });
  const steps = message?.steps ?? [];
  const index = steps.findIndex((s) => s.id === stepId);
  if (!message || index < 0) throw new StepError("Step not found", 404);
  if (steps[index].status !== "pending") throw new StepError("This step has already been handled", 409);
  steps[index].status = "dismissed";
  message.markModified("steps");
  await message.save();
  return message;
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

  const response = await chatWithFallback((model) => getGroqClient().chat.completions.create({
    model,
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
  }));
  await recordAiTokens(tenantId, response.usage, { kind: "ask", model: response.model });
  return response.choices[0]?.message?.content?.trim() || "";
}
