import { HydratedDocument } from "mongoose";
import { env } from "../../config/env";
import { GROQ_CHAT_MODEL, getGroqClient } from "../../config/groq";
import { AiChatMessage, type ActionType, type AiChatMessageDocument } from "../../models/AiChatMessage";
import { Customer } from "../../models/Customer";
import { Staff } from "../../models/Staff";
import { getDashboardSummary } from "../dashboard/dashboard.service";
import { listAttendance, markAttendance } from "../attendance/attendance.service";
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

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function populatedName(value: unknown): string {
  if (value && typeof value === "object" && "name" in value) {
    return String((value as { name: unknown }).name);
  }
  return "Unknown";
}

// Compact, numbers-first snapshot of the business — fed to the model as
// context on every turn so answers use real figures instead of guessing.
async function buildBusinessContext(tenantId: string): Promise<string> {
  const today = new Date().toISOString().slice(0, 10);
  const [summary, todaysAttendance] = await Promise.all([
    getDashboardSummary(tenantId),
    listAttendance(tenantId, { date: today }),
  ]);

  return JSON.stringify({
    todaySales: summary.todaySales,
    todayOrderCount: summary.todayOrderCount,
    yesterdaySales: summary.yesterdaySales,
    monthSales: summary.monthSales,
    receivables: summary.receivables,
    overdueCustomerCount: summary.overdueCustomerCount,
    topOverdueCustomerName: summary.topOverdueCustomerName,
    topOverdueAmount: summary.topOverdueAmount,
    inventoryValue: summary.inventoryValue,
    totalSkus: summary.totalSkus,
    lowStockCount: summary.lowStockCount,
    lowStockItems: summary.lowStockItems,
    topProducts: summary.topProducts.slice(0, 5),
    recentOrders: summary.recentOrders.slice(0, 5),
    todaysAttendance: todaysAttendance.map((a) => ({
      staffName: populatedName(a.staffId),
      status: a.status,
    })),
  });
}

const SYSTEM_PROMPT = `You are Munshi AI, the business assistant inside SethSathi, a wholesale/inventory management app for Indian shopkeepers. You answer questions about the business using the JSON snapshot of real data given to you — never invent numbers that aren't in it or derivable from it. Users may write in Hindi, Hinglish, or English (e.g. "Aaj kitni sale hui?", "आज कितनी सेल हुई?") — reply in the same language AND the same script as the user's message, concise and direct, with real figures in ₹. If they wrote Hindi in Roman letters, reply in Roman-script Hinglish; if they wrote in Devanagari, reply in Devanagari using everyday spoken Hindi (not formal or Sanskritized words).

If the user explicitly asks you to DO something that changes data (mark attendance, create an order), call the matching tool with the details you can extract. Never call a tool for something the user only asked about — only when they are clearly asking you to perform the action. If required details are missing (e.g. which staff member, what date), ask a clarifying question in plain text instead of guessing or calling the tool with incomplete data.

You cannot act directly — calling a tool only proposes the action for the user to review and confirm themselves.`;

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

export async function sendMessage(tenantId: string, userId: string, content: string): Promise<SendMessageResult> {
  if (!env.groqApiKey) {
    throw new AiChatNotConfiguredError();
  }

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
      { role: "user", content },
    ],
  });

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
