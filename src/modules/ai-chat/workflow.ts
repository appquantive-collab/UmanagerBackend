import { randomUUID } from "crypto";
import { z } from "zod";
import { Customer } from "../../models/Customer";
import { Department } from "../../models/Department";
import { Product } from "../../models/Product";
import { Staff } from "../../models/Staff";
import { Supplier } from "../../models/Supplier";
import { Tenant } from "../../models/Tenant";
import type { UserRole } from "../../models/User";
import { generateSku } from "../../utils/sku";
import { markAttendance } from "../attendance/attendance.service";
import { BillError, cancelBill, createBill, editBill, getCustomerPendingItems, recordPayment } from "../invoices/invoices.service";
import { saveOrder } from "../orders/orders.service";
import { PurchaseError, createPurchase, recordPurchasePayment } from "../purchases/purchases.service";
import { createStaff, updateStaff } from "../staff/staff.service";
import { defaultWarehouseId, stockBuckets, totalOf } from "../stock/ledger";
import { EXPENSE_CATEGORIES, Expense } from "../../models/Expense";
import { ACTIVE_INVOICE, Invoice, type PaymentMethod } from "../../models/Invoice";
import { Purchase } from "../../models/Purchase";
import { StockMovement } from "../../models/StockMovement";

/**
 * Munshi AI workflows: one message can turn into several steps ("Rajesh ji se
 * 5 kg aalu liya, Ravi aur Kishan ko 1-1 kg becha, Kishan ka bill banao" →
 * add supplier Rajesh → add item Aalu → record purchase → bill Ravi → bill
 * Kishan). Steps are only proposals: each one runs, through the app's normal
 * services and checks, when the user confirms it, in order. Missing parties
 * and items get their own "add" step in front, so nothing fails half-way.
 */

export const STEP_TYPES = [
  "create_customer",
  "create_supplier",
  "create_product",
  "record_purchase",
  "create_bill",
  "create_order",
  "mark_attendance",
  "create_staff",
  // Money in / out
  "receive_payment",
  "pay_supplier",
  "add_expense",
  // Bills and orders after the fact
  "edit_bill",
  "cancel_bill",
  "bill_order",
  // Changing what's already saved
  "update_customer",
  "update_supplier",
  "update_product",
  "update_staff",
  "adjust_stock",
] as const;
export type StepType = (typeof STEP_TYPES)[number];
export type StepStatus = "pending" | "confirmed" | "dismissed";

export interface WorkflowStep {
  id: string;
  type: StepType;
  payload: Record<string, unknown>;
  status: StepStatus;
  /** Added by Munshi because an earlier/later step needs it (e.g. a supplier that doesn't exist yet). */
  auto?: boolean;
  /** Skipped because the user corrected the list and a new one took its place. */
  replaced?: boolean;
  resultSummary?: string;
  /** Language-neutral reference shown after "done": a name, or bill number · amount. */
  /** What was made, for a "view" link (bill id, purchase id…). */
  resultId?: string;
}

// ---------- Payloads (checked again at confirm time, never trusted as-is) ----------

const money = z.coerce.number().min(0);
const qty = z.coerce.number().positive();
const optionalText = z
  .string()
  .trim()
  .max(400)
  .optional()
  .transform((v) => v || undefined);
// Said in any words ("GPay", "online", "NEFT", "nakad") → one of the app's methods.
const paymentMethod = z.preprocess((v) => {
  if (typeof v !== "string" || !v.trim()) return undefined;
  const s = v.toLowerCase();
  if (/upi|gpay|google ?pay|phone ?pe|paytm|bhim|online|qr/.test(s)) return "upi";
  if (/bank|neft|imps|rtgs|transfer|account/.test(s)) return "bank_transfer";
  if (/cheque|check|chek/.test(s)) return "cheque";
  return "cash";
}, z.enum(["cash", "upi", "bank_transfer", "cheque"]).optional());

const EXPENSE_WORDS: [RegExp, (typeof EXPENSE_CATEGORIES)[number]][] = [
  [/rent|kiraya|kiraa/, "rent"],
  [/salary|tankhwah|tankha|wage|majdoori|mazdoori/, "salary"],
  [/electric|bijli|light bill/, "electricity"],
  [/transport|bhada|bhaada|freight|auto|tempo|truck|petrol|diesel|courier/, "transport"],
  [/tea|chai|nashta|naashta|food|khana|snack/, "tea_food"],
  [/repair|marammat|theek/, "repairs"],
  [/phone|mobile|recharge|internet|wifi/, "phone_internet"],
  [/pack|carton|tape|polythene|bag/, "packing"],
  [/bank|charge|fee/, "bank_charges"],
  [/supplies|stationery|saman|safai|cleaning/, "shop_supplies"],
];

const lineSchema = z.object({
  productName: z.string().trim().min(1).max(120),
  quantity: qty,
  unit: optionalText,
  price: money.optional(),
});

export const stepSchemas = {
  create_customer: z.object({
    name: z.string().trim().min(1).max(120),
    phone: optionalText,
    kind: z.enum(["person", "business"]).optional(),
    gstin: optionalText,
    address: optionalText,
  }),
  create_supplier: z.object({
    name: z.string().trim().min(1).max(120),
    phone: optionalText,
    gstin: optionalText,
  }),
  create_product: z.object({
    name: z.string().trim().min(1).max(120),
    unit: optionalText,
    purchasePrice: money.optional(),
    salePrice: money.optional(),
  }),
  record_purchase: z.object({
    supplierName: z.string().trim().min(1).max(120),
    items: z.array(lineSchema).min(1).max(40),
    paidAmount: money.optional(),
    paymentMethod,
  }),
  create_bill: z.object({
    /** Empty = walk-in counter sale. */
    customerName: z.string().trim().max(120).optional().default(""),
    items: z.array(lineSchema).min(1).max(40),
    billType: z.enum(["gst", "record"]).optional(),
    paidAmount: money.optional(),
    paymentMethod,
  }),
  create_order: z.object({
    customerName: z.string().trim().min(1).max(120),
    items: z.array(lineSchema).min(1).max(40),
  }),
  mark_attendance: z.object({
    staffName: z.string().trim().min(1),
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    status: z.enum(["present", "absent", "half_day", "leave"]),
  }),
  create_staff: z.object({
    name: z.string().trim().min(2).max(120),
    phone: optionalText,
    /** Department name as said ("labour", "painting"); made if the business doesn't have it yet. */
    department: optionalText,
    role: z.enum(["MANAGER", "SALESMAN", "WAREHOUSE_STAFF"]).optional(),
    payType: z.enum(["salary", "daily_wage"]).optional(),
    monthlySalary: money.optional(),
    dailyWage: money.optional(),
  }),
  receive_payment: z.object({
    customerName: z.string().trim().min(1).max(120),
    amount: z.coerce.number().positive(),
    paymentMethod,
    /** Only this bill; else the oldest unpaid bills first. */
    billNumber: optionalText,
  }),
  pay_supplier: z.object({
    supplierName: z.string().trim().min(1).max(120),
    amount: z.coerce.number().positive(),
    paymentMethod,
    purchaseNumber: optionalText,
  }),
  add_expense: z.object({
    category: z.preprocess((v) => {
      if (typeof v !== "string" || !v.trim()) return undefined;
      const s = v.toLowerCase().trim();
      if ((EXPENSE_CATEGORIES as readonly string[]).includes(s)) return s;
      return EXPENSE_WORDS.find(([re]) => re.test(s))?.[1] ?? "other";
    }, z.enum(EXPENSE_CATEGORIES).optional()),
    amount: z.coerce.number().positive(),
    paymentMethod,
    note: optionalText,
  }),
  edit_bill: z.object({
    billNumber: z.string().trim().min(1).max(40),
    /** The bill's full new list of items. */
    items: z.array(lineSchema).min(1).max(40),
    billType: z.enum(["gst", "record"]).optional(),
  }),
  cancel_bill: z.object({
    billNumber: z.string().trim().min(1).max(40),
    reason: optionalText,
  }),
  bill_order: z.object({
    customerName: z.string().trim().min(1).max(120),
    billType: z.enum(["gst", "record"]).optional(),
    paidAmount: money.optional(),
    paymentMethod,
  }),
  update_customer: z.object({
    name: z.string().trim().min(1).max(120),
    newName: optionalText,
    phone: optionalText,
    address: optionalText,
    gstin: optionalText,
  }),
  update_supplier: z.object({
    name: z.string().trim().min(1).max(120),
    newName: optionalText,
    phone: optionalText,
    gstin: optionalText,
  }),
  update_product: z.object({
    name: z.string().trim().min(1).max(120),
    newName: optionalText,
    salePrice: money.optional(),
    purchasePrice: money.optional(),
    unit: optionalText,
    reorderLevel: money.optional(),
  }),
  update_staff: z.object({
    name: z.string().trim().min(1).max(120),
    newName: optionalText,
    phone: optionalText,
    department: optionalText,
    role: z.enum(["MANAGER", "SALESMAN", "WAREHOUSE_STAFF"]).optional(),
    monthlySalary: money.optional(),
    dailyWage: money.optional(),
  }),
  adjust_stock: z.object({
    productName: z.string().trim().min(1).max(120),
    /** How many units; direction says in or out (damage is always out). */
    quantity: z.preprocess(
      (v) => (typeof v === "string" ? v.replace(/[−–—]/g, "-") : v),
      z.coerce.number().refine((v) => v !== 0, "Quantity can't be 0")
    ),
    direction: z.enum(["in", "out"]).optional(),
    // Said in any words ("kharaab", "toot gaya", "expired") → damage; anything else → adjustment.
    reason: z.preprocess(
      (v) =>
        typeof v === "string" && v.trim()
          ? /damage|kharr?aa?b|toot|tut|broken|expir|sad|chori|stolen|lost|gum|फट|ख़राब|खराब|टूट/i.test(v)
            ? "damage"
            : "adjustment"
          : undefined,
      z.enum(["adjustment", "damage"]).optional()
    ),
    note: optionalText,
  }),
} satisfies Record<StepType, z.ZodTypeAny>;

// Who may confirm what — same rules as the app's own screens (see app.ts).
const DENIED: Partial<Record<StepType, UserRole[]>> = {
  create_customer: ["WAREHOUSE_STAFF"],
  create_bill: ["WAREHOUSE_STAFF"],
  create_order: ["WAREHOUSE_STAFF"],
  create_supplier: ["SALESMAN"],
  record_purchase: ["SALESMAN"],
  create_product: ["SALESMAN"],
  mark_attendance: ["SALESMAN", "WAREHOUSE_STAFF"],
  create_staff: ["SALESMAN", "WAREHOUSE_STAFF"],
  receive_payment: ["WAREHOUSE_STAFF"],
  pay_supplier: ["SALESMAN"],
  add_expense: ["SALESMAN", "WAREHOUSE_STAFF"],
  edit_bill: ["SALESMAN", "WAREHOUSE_STAFF"],
  cancel_bill: ["SALESMAN", "WAREHOUSE_STAFF"],
  bill_order: ["WAREHOUSE_STAFF"],
  update_customer: ["WAREHOUSE_STAFF"],
  update_supplier: ["SALESMAN"],
  update_product: ["SALESMAN"],
  update_staff: ["SALESMAN", "WAREHOUSE_STAFF"],
  adjust_stock: ["SALESMAN"],
};

// ---------- Tools the model can call (each call = one proposed step) ----------

const lineItems = {
  type: "array",
  description: "Goods in this step",
  items: {
    type: "object",
    properties: {
      productName: { type: "string", description: "Item name as the user said it, e.g. 'Aalu', 'Rexine black'" },
      quantity: { type: "number" },
      unit: { type: "string", description: "kg, meter, pcs, box… as said; omit if not said" },
      price: { type: "number", description: "Price per unit ONLY if the user said it (cost for purchases, selling price for bills/orders)" },
    },
    required: ["productName", "quantity"],
  },
};

/**
 * Two tools: propose_steps carries every job in the message as a list (the
 * model returns one tool call per reply, so one call must hold them all), and
 * ask_user asks one question with tappable answers.
 */
/**
 * Groq checks every tool call against its schema and rejects the whole reply
 * when the model writes null for a field it has nothing for (salePrice: null),
 * so every optional field also accepts null (nulls are dropped before use).
 */
function allowNulls(schema: Record<string, unknown>, isStep = false): Record<string, unknown> {
  const out: Record<string, unknown> = { ...schema };
  if (out.type === "object" && out.properties) {
    const required = new Set((out.required as string[] | undefined) ?? []);
    out.properties = Object.fromEntries(
      Object.entries(out.properties as Record<string, Record<string, unknown>>).map(([key, prop]) => {
        // propose_steps → steps[] → each step's own fields. Line items keep their
        // plain types, so a price that was said is never swapped for a null.
        if (key === "steps" && prop.type === "array" && prop.items) return [key, { ...prop, items: allowNulls(prop.items as Record<string, unknown>, true) }];
        if (!isStep || required.has(key) || typeof prop.type !== "string" || prop.type === "array") return [key, prop];
        return [key, { ...prop, type: [prop.type, "null"], ...(Array.isArray(prop.enum) ? { enum: [...prop.enum, null] } : {}) }];
      })
    );
  }
  return out;
}

/**
 * The model sometimes names a field the way another step does (staffName for a
 * new staff member's name, customerName for a party being changed): take it.
 */
function withAliases(type: StepType, args: Record<string, unknown>): Record<string, unknown> {
  const out = { ...args };
  const fill = (key: string, ...from: string[]) => {
    if (out[key] !== undefined && out[key] !== "") return;
    const source = from.find((f) => out[f] !== undefined && out[f] !== "");
    if (source) out[key] = out[source];
  };
  if (type === "create_staff" || type === "update_staff") fill("name", "staffName");
  if (type === "create_customer" || type === "update_customer") fill("name", "customerName");
  if (type === "create_supplier" || type === "update_supplier") fill("name", "supplierName");
  if (type === "create_product" || type === "update_product") fill("name", "productName");
  if (type === "mark_attendance") fill("staffName", "name");
  if (type === "adjust_stock") fill("productName", "name");
  if (type === "receive_payment" || type === "bill_order" || type === "create_order") fill("customerName", "name");
  if (type === "pay_supplier" || type === "record_purchase") fill("supplierName", "name");
  if (type === "receive_payment" || type === "pay_supplier" || type === "add_expense") fill("amount", "paidAmount");
  return out;
}

/** Drop nulls the model wrote for "nothing here", at any depth. */
function withoutNulls(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutNulls);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== null).map(([k, v]) => [k, withoutNulls(v)]));
  }
  return value;
}

const baseWorkflowTools = [
  {
    type: "function" as const,
    function: {
      name: "propose_steps",
      description:
        "Propose the work the user asked for, as an ordered list of steps (one per job, in the order it happened). The user reviews and confirms each step. A supplier, customer or item that isn't saved yet is added automatically as its own step: never ask whether to add it, just propose the purchase / bill / order. Step types:\n" +
        "- record_purchase: goods bought/taken from a supplier (liya, kharida, mangwaya). Needs supplierName, items. Stock goes up.\n" +
        "- create_bill: goods sold (becha, bech diya, de diya) or a bill asked for. One step per customer. customerName empty = walk-in counter sale. Stock goes down.\n" +
        "- create_order: a customer's order to deliver/bill later (not goods already sold). Needs customerName, items.\n" +
        "- create_customer / create_supplier: add a new party (name, phone, gstin, address, kind). Only when the user asks to add one; purchases and bills add missing parties themselves.\n" +
        "- create_product: add a new item (name, unit, purchasePrice, salePrice). Only when asked; purchases and bills add missing items themselves.\n" +
        "- mark_attendance: staffName, date (YYYY-MM-DD), status.\n" +
        "- create_staff: add a staff member / worker / karigar (name; phone, department, role, payType, monthlySalary or dailyWage only if said). One step per person. department = the department/kaam they're put in, as said (e.g. 'Labour', 'Painting'); it's created if missing. role: WAREHOUSE_STAFF for godown, labour, helpers, karigar and workers; SALESMAN for counter/sales; MANAGER only if said.\n" +
        "- receive_payment: a customer paid money (paise aaye, jama kiye, udhaar chukaya). customerName, amount, paymentMethod; billNumber only if said (else oldest unpaid bills first).\n" +
        "- pay_supplier: money paid to a supplier. supplierName, amount, paymentMethod; purchaseNumber only if said.\n" +
        "- add_expense: shop spending, not goods (kiraya/rent, salary, bijli/electricity, transport, chai-nashta/tea_food, repairs, phone_internet, packing, shop_supplies, bank_charges, other). category, amount, paymentMethod, note.\n" +
        "- edit_bill: change a bill already made (wrong quantity/rate/item, 'pichla bill galat hai'). billNumber (from the chat history or data) and the bill's FULL corrected items list.\n" +
        "- cancel_bill: cancel a bill. billNumber, reason.\n" +
        "- bill_order: make the bill for a customer's pending order(s) (order ka bill bana do). customerName.\n" +
        "- update_customer / update_supplier: change a saved party: name (as saved now), newName, phone, address, gstin; only what changes.\n" +
        "- update_product: change a saved item: name (as saved now), newName, salePrice, purchasePrice, unit, reorderLevel; only what changes.\n" +
        "- update_staff: change a staff member: name, newName, phone, department, role, monthlySalary, dailyWage; only what changes.\n" +
        "- adjust_stock: fix stock without a bill/purchase (counted, damaged, lost, found). productName, quantity (positive number of units), direction 'in' (found, counted more) or 'out' (damaged, broken, lost, counted less), reason (damage for kharab/toota/expired, else adjustment).\n" +
        "To fix something done earlier in this chat ('pichla galat ho gaya', 'dubara karo', 'edit karo'), use edit_bill / update_* / adjust_stock on what was made (the history shows its bill number or name). A purchase can't be edited: say so and offer adjust_stock or pay_supplier instead.",
      parameters: {
        type: "object",
        properties: {
          steps: {
            type: "array",
            items: {
              type: "object",
              properties: {
                type: { type: "string", enum: [...STEP_TYPES] },
                supplierName: { type: "string" },
                customerName: { type: "string" },
                items: lineItems,
                billType: { type: "string", enum: ["gst", "record"], description: "Only if the user said GST bill or kaccha/simple bill" },
                paidAmount: { type: "number", description: "Money paid/received now, only if said" },
                paymentMethod: { type: "string", enum: ["cash", "upi", "bank_transfer", "cheque"] },
                name: { type: "string", description: "For create_* and update_* (for update_*: the name as saved now)" },
                department: { type: "string", description: "For create_staff: department as said" },
                role: { type: "string", enum: ["MANAGER", "SALESMAN", "WAREHOUSE_STAFF"], description: "For create_staff" },
                payType: { type: "string", enum: ["salary", "daily_wage"], description: "For create_staff, only if said" },
                monthlySalary: { type: "number", description: "For create_staff, only if said" },
                dailyWage: { type: "number", description: "For create_staff / update_staff, only if said" },
                amount: { type: "number", description: "For receive_payment / pay_supplier / add_expense" },
                billNumber: { type: "string", description: "For receive_payment / edit_bill / cancel_bill, e.g. INV-0012" },
                purchaseNumber: { type: "string" },
                category: { type: "string", enum: ["rent", "salary", "electricity", "transport", "tea_food", "repairs", "phone_internet", "packing", "shop_supplies", "bank_charges", "other"] },
                note: { type: "string" },
                reason: { type: "string", description: "cancel_bill: why; adjust_stock: adjustment or damage" },
                newName: { type: "string", description: "update_*: the new name, only if it changes" },
                reorderLevel: { type: "number" },
                productName: { type: "string", description: "For adjust_stock" },
                quantity: { type: "number", description: "For adjust_stock: how many units (positive)" },
                direction: { type: "string", enum: ["in", "out"], description: "For adjust_stock: in = add to stock, out = take out" },
                phone: { type: "string" },
                gstin: { type: "string" },
                address: { type: "string" },
                kind: { type: "string", enum: ["person", "business"] },
                unit: { type: "string", description: "For create_product" },
                purchasePrice: { type: "number" },
                salePrice: { type: "number" },
                staffName: { type: "string" },
                date: { type: "string" },
                status: { type: "string", enum: ["present", "absent", "half_day", "leave"] },
              },
              required: ["type"],
            },
          },
        },
        required: ["steps"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "ask_user",
      description:
        "Ask ONE short question when something essential is missing or unclear (a name, which item, how many, sold or only ordered?), with 2-5 short tappable answers. Options must be real: names from the business data snapshot, or plain choices like 'Haan' / 'Nahi' / 'Bill banao' / 'Sirf order'. Never make up names. If the answer is free text (a new name, a phone number), pass an EMPTY options list; the user will type or speak it. Never offer options like 'Enter name' or 'Cancel'.",
      parameters: {
        type: "object",
        properties: {
          question: { type: "string" },
          options: { type: "array", items: { type: "string" } },
        },
        required: ["question", "options"],
      },
    },
  },
];

export const workflowTools = baseWorkflowTools.map((tool) => ({
  ...tool,
  function: { ...tool.function, parameters: allowNulls(tool.function.parameters) },
}));

// ---------- Matching names the way people say them ----------

const HONORIFICS = /\b(ji|jee|bhai|bhaiya|sahab|saheb|seth|sethji|uncle|didi|madam|mr|mrs|shri|sri)\b\.?/g;

/** "Rajesh ji" ≈ "rajesh"; "Aalu" ≈ "aloo" (long vowels written either way). */
export function normalizeName(name: string): string {
  return name
    .toLowerCase()
    .replace(HONORIFICS, " ")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/aa/g, "a")
    .replace(/oo|uu/g, "u")
    .replace(/ee|ii/g, "i")
    .replace(/\s+/g, " ")
    .trim();
}

function pickByName<T extends { name: string }>(rows: T[], wanted: string): T | null {
  const key = normalizeName(wanted);
  if (!key) return null;
  const exact = rows.filter((r) => normalizeName(r.name) === key);
  if (exact.length) return exact[0];
  // "Rajesh" → "Rajesh Kumar", only when there's exactly one such party.
  const starts = rows.filter((r) => normalizeName(r.name).startsWith(`${key} `));
  return starts.length === 1 ? starts[0] : null;
}

async function findCustomer(tenantId: string, name: string) {
  const rows = await Customer.find({ tenantId, isActive: true, isWalkIn: { $ne: true } }, { name: 1, phone: 1 }).lean();
  return pickByName(rows, name);
}
async function findSupplier(tenantId: string, name: string) {
  const rows = await Supplier.find({ tenantId }, { name: 1 }).lean();
  return pickByName(rows, name);
}
async function findProduct(tenantId: string, name: string) {
  const rows = await Product.find({ tenantId, isActive: true }, { name: 1, unit: 1, purchasePrice: 1, retailPrice: 1, altUnit: 1 }).lean();
  return pickByName(rows, name);
}

async function findStaff(tenantId: string, name: string) {
  const rows = await Staff.find({ tenantId, isActive: true }, { name: 1 }).lean();
  return pickByName(rows, name);
}

/** "labour department" / "painting vibhag" → "Labour" / "Painting"; matched to an existing one or made. */
async function departmentFor(tenantId: string, said: string): Promise<{ id: string; name: string } | null> {
  const name = tidy(said.replace(/\b(department|dept|vibhag|vibhaag|section|team)\b|विभाग/gi, " ").replace(/\s+/g, " ").trim());
  if (!name) return null;
  const all = await Department.find({ tenantId }, { name: 1 }).lean();
  const found = pickByName(all, name);
  if (found) return { id: String(found._id), name: found.name };
  const made = await Department.create({ tenantId, name });
  return { id: String(made._id), name: made.name };
}

/** New names start with a capital letter ("aalu" → "Aalu"); the rest is kept as said. */
const tidy = (name: string) => name.trim().charAt(0).toLocaleUpperCase("en-IN") + name.trim().slice(1);

const isWalkIn = (name: string | undefined) => !name || /^(walk[\s-]?in|counter|cash|nakad|grahak)$/i.test(name.trim());

// ---------- Planning: tool calls → ordered steps with "add first" steps ----------

export interface ToolCallLike {
  name: string;
  arguments: string;
}

export interface PlannedReply {
  steps: WorkflowStep[];
  question?: { text: string; options: string[] };
}

export async function planSteps(tenantId: string, calls: ToolCallLike[]): Promise<PlannedReply> {
  const proposed: { type: StepType; payload: Record<string, unknown> }[] = [];
  let question: PlannedReply["question"];

  // propose_steps carries a list; single-step tool names still work too.
  const flat: ToolCallLike[] = [];
  for (const call of calls) {
    if (call.name !== "propose_steps") {
      flat.push(call);
      continue;
    }
    try {
      const list = (JSON.parse(call.arguments || "{}") as { steps?: unknown }).steps;
      for (const step of Array.isArray(list) ? list : []) {
        if (step && typeof step === "object" && typeof (step as { type?: unknown }).type === "string") {
          const { type, ...rest } = step as Record<string, unknown>;
          flat.push({ name: String(type), arguments: JSON.stringify(rest) });
        }
      }
    } catch {
      // unreadable list: propose nothing from it
    }
  }

  for (const call of flat) {
    let args: Record<string, unknown>;
    try {
      args = withoutNulls(JSON.parse(call.arguments || "{}")) as Record<string, unknown>;
    } catch {
      continue; // never act on arguments we can't even read
    }
    if (call.name === "ask_user") {
      const options = Array.isArray(args.options) ? args.options.filter((o): o is string => typeof o === "string" && o.trim() !== "").slice(0, 5) : [];
      if (typeof args.question === "string" && args.question.trim()) question = { text: args.question.trim(), options };
      continue;
    }
    if (!(STEP_TYPES as readonly string[]).includes(call.name)) continue;
    const type = call.name as StepType;
    const parsed = stepSchemas[type].safeParse(withAliases(type, args));
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      console.warn(`[workflow] dropped ${type}: ${issue?.path.join(".")} ${issue?.message} · ${JSON.stringify(args).slice(0, 300)}`);
      continue;
    }
    // Don't offer to add what's already saved (e.g. the item a step just created).
    const name = String((parsed.data as { name?: unknown }).name ?? "");
    if (type === "create_product" && (await findProduct(tenantId, name))) continue;
    if (type === "create_customer" && (await findCustomer(tenantId, name))) continue;
    if (type === "create_supplier" && (await findSupplier(tenantId, name))) continue;
    if (type === "create_staff" && (await findStaff(tenantId, name))) continue;
    proposed.push({ type, payload: parsed.data as Record<string, unknown> });
  }

  // Who and what this plan already adds, so the same party/item isn't added twice.
  const adding = { customer: new Set<string>(), supplier: new Set<string>(), product: new Set<string>() };
  for (const p of proposed) {
    const name = normalizeName(String(p.payload.name ?? ""));
    if (p.type === "create_customer") adding.customer.add(name);
    if (p.type === "create_supplier") adding.supplier.add(name);
    if (p.type === "create_product") adding.product.add(name);
  }

  const steps: WorkflowStep[] = [];
  const add = (type: StepType, payload: Record<string, unknown>, auto = false) =>
    steps.push({ id: randomUUID(), type, payload, status: "pending", ...(auto ? { auto: true } : {}) });

  for (const p of proposed) {
    const items = (p.payload.items as z.infer<typeof lineSchema>[] | undefined) ?? [];
    if (p.type === "record_purchase") {
      const supplierName = String(p.payload.supplierName);
      const key = normalizeName(supplierName);
      if (!adding.supplier.has(key) && !(await findSupplier(tenantId, supplierName))) {
        adding.supplier.add(key);
        add("create_supplier", { name: tidy(supplierName) }, true);
      }
    }
    if (p.type === "create_bill" || p.type === "create_order") {
      const customerName = String(p.payload.customerName ?? "");
      const key = normalizeName(customerName);
      if (!isWalkIn(customerName) && !adding.customer.has(key) && !(await findCustomer(tenantId, customerName))) {
        adding.customer.add(key);
        add("create_customer", { name: tidy(customerName) }, true);
      }
    }
    if (p.type === "record_purchase" || p.type === "create_bill") {
      for (const item of items) {
        const key = normalizeName(item.productName);
        if (adding.product.has(key) || (await findProduct(tenantId, item.productName))) continue;
        adding.product.add(key);
        add(
          "create_product",
          {
            name: tidy(item.productName),
            ...(item.unit ? { unit: item.unit } : {}),
            ...(item.price !== undefined ? (p.type === "record_purchase" ? { purchasePrice: item.price } : { salePrice: item.price }) : {}),
          },
          true
        );
      }
    }
    add(p.type, p.payload);
  }

  return { steps, question };
}

// ---------- Doing a step (on confirm) ----------

/** Bill lines from what was said: saved items get their unit and price, the rest go in as typed. */
async function billLines(tenantId: string, lines: z.infer<typeof lineSchema>[]) {
  const items = [];
  for (const line of lines) {
    const product = await findProduct(tenantId, line.productName);
    const unit = product ? (line.unit && (line.unit === product.unit || line.unit === product.altUnit?.name) ? line.unit : product.unit) : line.unit || "pcs";
    const price = line.price ?? product?.retailPrice ?? 0;
    items.push({
      ...(product ? { productId: String(product._id) } : {}),
      productName: product?.name ?? line.productName,
      quantity: line.quantity,
      unit,
      // Price in the line's unit: a saved per-piece price × pack size when billing a box.
      unitPrice: line.price === undefined && product?.altUnit && unit === product.altUnit.name ? price * product.altUnit.factor : price,
    });
  }
  return items;
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** "INV-0012", "inv 12" or just "12" → the bill (newest match). */
async function findInvoice(tenantId: string, ref: string) {
  const exact = await Invoice.findOne({ tenantId, invoiceNumber: new RegExp(`^${escapeRe(ref.trim())}$`, "i") });
  if (exact) return exact;
  const digits = ref.replace(/\D/g, "");
  if (!digits) return null;
  return Invoice.findOne({ tenantId, invoiceNumber: new RegExp(`(^|\\D)0*${Number(digits)}$`) }).sort({ createdAt: -1 });
}

async function findPurchase(tenantId: string, ref: string) {
  const exact = await Purchase.findOne({ tenantId, purchaseNumber: new RegExp(`^${escapeRe(ref.trim())}$`, "i") });
  if (exact) return exact;
  const digits = ref.replace(/\D/g, "");
  if (!digits) return null;
  return Purchase.findOne({ tenantId, purchaseNumber: new RegExp(`(^|\\D)0*${Number(digits)}$`) }).sort({ createdAt: -1 });
}

const rupees = (n: number) => `₹${Math.round(n).toLocaleString("en-IN")}`;
const due = (doc: { totalAmount: number; amountPaid: number }) => Math.round((doc.totalAmount - doc.amountPaid) * 100) / 100;

/** Money received: one bill, or spread over the oldest unpaid bills. Never more than is owed. */
async function receivePayment(tenantId: string, customerId: string, amount: number, method: PaymentMethod, billRef?: string) {
  const open = billRef
    ? [await findInvoice(tenantId, billRef)].filter((b): b is NonNullable<typeof b> => Boolean(b && String(b.customerId) === customerId))
    : await Invoice.find({ tenantId, customerId, ...ACTIVE_INVOICE, paymentStatus: { $ne: "paid" } }).sort({ createdAt: 1 });
  if (billRef && open.length === 0) throw new StepError(`Bill "${billRef}" is customer ka nahi mila.`, 404);
  const owed = open.reduce((s, b) => s + Math.max(0, due(b)), 0);
  if (owed <= 0) throw new StepError("Is customer ka koi udhaar baaki nahi hai.");
  if (amount > owed + 0.5) throw new StepError(`Udhaar sirf ${rupees(owed)} baaki hai; ${rupees(amount)} zyada hai.`);
  let left = amount;
  const paid: string[] = [];
  for (const bill of open) {
    if (left <= 0) break;
    const part = Math.min(left, due(bill));
    if (part <= 0) continue;
    await recordPayment(tenantId, String(bill._id), Math.round(part * 100) / 100, method, "Munshi AI");
    paid.push(bill.invoiceNumber);
    left -= part;
  }
  return paid;
}

async function paySupplier(tenantId: string, supplierId: string, amount: number, method: PaymentMethod, purchaseRef?: string) {
  const open = purchaseRef
    ? [await findPurchase(tenantId, purchaseRef)].filter((p): p is NonNullable<typeof p> => Boolean(p && String(p.supplierId) === supplierId))
    : await Purchase.find({ tenantId, supplierId, paymentStatus: { $ne: "paid" } }).sort({ createdAt: 1 });
  if (purchaseRef && open.length === 0) throw new StepError(`Purchase "${purchaseRef}" is supplier ki nahi mili.`, 404);
  const owed = open.reduce((s, p) => s + Math.max(0, due(p)), 0);
  if (owed <= 0) throw new StepError("Is supplier ka koi paisa dena baaki nahi hai.");
  if (amount > owed + 0.5) throw new StepError(`Supplier ka sirf ${rupees(owed)} dena baaki hai; ${rupees(amount)} zyada hai.`);
  let left = amount;
  const paid: { id: string; number: string }[] = [];
  for (const purchase of open) {
    if (left <= 0) break;
    const part = Math.min(left, due(purchase));
    if (part <= 0) continue;
    await recordPurchasePayment(tenantId, String(purchase._id), Math.round(part * 100) / 100, method, "Munshi AI");
    paid.push({ id: String(purchase._id), number: purchase.purchaseNumber });
    left -= part;
  }
  return paid;
}

export class StepError extends Error {
  constructor(
    message: string,
    readonly status = 400,
    /** INSUFFICIENT_STOCK / CREDIT_LIMIT: the user can choose to go ahead anyway. */
    readonly code?: string,
    readonly details?: unknown
  ) {
    super(message);
    this.name = "StepError";
  }
}

export interface StepResult {
  summary: string;
  resultId?: string;
  audit?: { action: string; summary: string; entityId?: string; amount?: number };
}

export async function runStep(
  tenantId: string,
  userId: string,
  role: UserRole,
  type: StepType,
  rawPayload: Record<string, unknown>,
  force: boolean
): Promise<{ payload: Record<string, unknown>; result: StepResult }> {
  if (DENIED[type]?.includes(role)) throw new StepError("Your login can't do this. Ask the owner or manager.", 403);
  const parsed = stepSchemas[type].safeParse(rawPayload);
  if (!parsed.success) throw new StepError(parsed.error.issues[0]?.message ?? "Please check the details");
  const payload = parsed.data as Record<string, unknown>;

  switch (type) {
    case "create_customer": {
      const p = payload as z.infer<typeof stepSchemas.create_customer>;
      const existing = await findCustomer(tenantId, p.name);
      if (existing) return { payload, result: { summary: existing.name, resultId: String(existing._id) } };
      const gstin = p.gstin?.toUpperCase();
      const customer = await Customer.create({
        tenantId,
        name: p.name,
        ...(p.phone ? { phone: p.phone } : {}),
        ...(p.kind ? { kind: p.kind } : gstin ? { kind: "business" } : {}),
        ...(gstin ? { gstin, stateCode: gstin.slice(0, 2) } : {}),
        ...(p.address ? { address: p.address } : {}),
      });
      return { payload, result: { summary: customer.name, resultId: String(customer._id), audit: { action: "customer.create", summary: `Added customer ${customer.name} (Munshi AI)`, entityId: String(customer._id) } } };
    }

    case "create_supplier": {
      const p = payload as z.infer<typeof stepSchemas.create_supplier>;
      const existing = await findSupplier(tenantId, p.name);
      if (existing) return { payload, result: { summary: existing.name, resultId: String(existing._id) } };
      const supplier = await Supplier.create({ tenantId, name: p.name, ...(p.phone ? { phone: p.phone } : {}), ...(p.gstin ? { gstin: p.gstin } : {}) });
      return { payload, result: { summary: supplier.name, resultId: String(supplier._id), audit: { action: "supplier.create", summary: `Added supplier ${supplier.name} (Munshi AI)`, entityId: String(supplier._id) } } };
    }

    case "create_product": {
      const p = payload as z.infer<typeof stepSchemas.create_product>;
      const existing = await findProduct(tenantId, p.name);
      if (existing) return { payload, result: { summary: existing.name, resultId: String(existing._id) } };
      // No unit said: the unit this business sells in (setup → how you buy and sell).
      const tenant = await Tenant.findById(tenantId, { "onboarding.trade": 1 }).lean();
      const unit = p.unit || tenant?.onboarding?.trade?.sellUnit || "pcs";
      const product = await Product.create({
        tenantId,
        name: p.name,
        sku: generateSku(p.name),
        unit,
        purchasePrice: p.purchasePrice ?? 0,
        wholesalePrice: p.salePrice ?? 0,
        retailPrice: p.salePrice ?? 0,
      });
      return { payload, result: { summary: `${product.name} (${unit})`, resultId: String(product._id), audit: { action: "product.create", summary: `Added item ${product.name} (Munshi AI)`, entityId: String(product._id) } } };
    }

    case "record_purchase": {
      const p = payload as z.infer<typeof stepSchemas.record_purchase>;
      const supplier = await findSupplier(tenantId, p.supplierName);
      if (!supplier) throw new StepError(`Supplier "${p.supplierName}" nahi mile. Pehle unhe jodiye.`, 404);
      const items = [];
      for (const line of p.items) {
        const product = await findProduct(tenantId, line.productName);
        if (!product) throw new StepError(`Item "${line.productName}" list mein nahi hai. Pehle use jodiye.`, 404);
        const unit = line.unit && (line.unit === product.unit || line.unit === product.altUnit?.name) ? line.unit : product.unit;
        items.push({ productId: String(product._id), quantity: line.quantity, unitCost: line.price ?? product.purchasePrice ?? 0, unit });
      }
      try {
        const purchase = await createPurchase(tenantId, userId, {
          supplierId: String(supplier._id),
          items,
          ...(p.paidAmount ? { payment: { amount: p.paidAmount, method: p.paymentMethod ?? "cash" } } : {}),
        });
        return {
          payload,
          result: {
            summary: `${purchase.purchaseNumber} · ₹${Math.round(purchase.totalAmount).toLocaleString("en-IN")}`,
            resultId: String(purchase._id),
            audit: { action: "purchase.create", summary: `${purchase.purchaseNumber}: ₹${Math.round(purchase.totalAmount)} (Munshi AI)`, entityId: String(purchase._id), amount: purchase.totalAmount },
          },
        };
      } catch (err) {
        if (err instanceof PurchaseError) throw new StepError(err.message, err.status);
        throw err;
      }
    }

    case "create_bill": {
      const p = payload as z.infer<typeof stepSchemas.create_bill>;
      let customerId: string | undefined;
      if (!isWalkIn(p.customerName)) {
        const customer = await findCustomer(tenantId, p.customerName);
        if (!customer) throw new StepError(`Customer "${p.customerName}" nahi mile. Pehle unhe jodiye.`, 404);
        customerId = String(customer._id);
      }
      const items = await billLines(tenantId, p.items);
      const tenant = await Tenant.findById(tenantId, { appSetup: 1 }).lean();
      try {
        const invoice = await createBill(tenantId, userId, {
          ...(customerId ? { customerId } : {}),
          orderIds: [],
          items,
          billType: p.billType ?? tenant?.appSetup?.defaultBillType ?? "record",
          allowShortStock: force,
          allowOverCreditLimit: force,
          ...(p.paidAmount ? { payment: { amount: p.paidAmount, method: p.paymentMethod ?? "cash" } } : {}),
        });
        return {
          payload,
          result: {
            summary: `${invoice.invoiceNumber} · ₹${Math.round(invoice.totalAmount).toLocaleString("en-IN")}`,
            resultId: String(invoice._id),
            audit: {
              action: "bill.create",
              summary: `${invoice.invoiceNumber} for ${invoice.buyer?.name ?? "customer"}: ₹${invoice.totalAmount} (Munshi AI${force ? ", confirmed despite warning" : ""})`,
              entityId: String(invoice._id),
              amount: invoice.totalAmount,
            },
          },
        };
      } catch (err) {
        if (err instanceof BillError) throw new StepError(err.message, err.status, err.code, err.details);
        throw err;
      }
    }

    case "create_order": {
      const p = payload as z.infer<typeof stepSchemas.create_order>;
      const customer = await findCustomer(tenantId, p.customerName);
      if (!customer) throw new StepError(`Customer "${p.customerName}" nahi mile. Pehle unhe jodiye.`, 404);
      // Saved items are linked (not made again); their price is used when none was said.
      const items = [];
      for (const i of p.items) {
        const product = await findProduct(tenantId, i.productName);
        items.push(
          product
            ? { productId: String(product._id), productName: product.name, quantity: i.quantity, unit: i.unit ?? product.unit, unitPrice: i.price ?? product.retailPrice ?? 0, isNewProduct: false }
            : { productName: tidy(i.productName), quantity: i.quantity, unit: i.unit ?? "pcs", unitPrice: i.price ?? 0, isNewProduct: true }
        );
      }
      const { order } = await saveOrder(tenantId, userId, { customerId: String(customer._id), items, source: "ai_parsed" });
      return { payload, result: { summary: String(order._id).slice(-6).toUpperCase(), resultId: String(order._id) } };
    }

    case "mark_attendance": {
      const p = payload as z.infer<typeof stepSchemas.mark_attendance>;
      const staff = await Staff.find({ tenantId }, { name: 1 }).lean().then((rows) => pickByName(rows, p.staffName));
      if (!staff) throw new StepError(`"${p.staffName}" naam ka staff nahi mila.`, 404);
      await markAttendance(tenantId, userId, { staffId: String(staff._id), date: p.date, status: p.status });
      return { payload, result: { summary: staff.name } };
    }

    case "create_staff": {
      const p = payload as z.infer<typeof stepSchemas.create_staff>;
      const existing = await findStaff(tenantId, p.name);
      if (existing) return { payload, result: { summary: existing.name, resultId: String(existing._id) } };
      const digits = (p.phone ?? "").replace(/\D/g, "").slice(-10);
      if (p.phone && digits.length !== 10) throw new StepError("Mobile number 10 ank ka hona chahiye.");
      const department = p.department ? await departmentFor(tenantId, p.department) : null;
      const payType = p.payType ?? (p.dailyWage !== undefined && p.monthlySalary === undefined ? "daily_wage" : "salary");
      const staff = await createStaff(tenantId, {
        name: tidy(p.name),
        ...(digits ? { phone: digits } : {}),
        role: p.role ?? "WAREHOUSE_STAFF",
        ...(department ? { departmentId: department.id } : {}),
        payType,
        ...(p.monthlySalary !== undefined ? { monthlySalary: p.monthlySalary } : {}),
        ...(p.dailyWage !== undefined ? { dailyWage: p.dailyWage } : {}),
      });
      const summary = department ? `${staff.name} · ${department.name}` : staff.name;
      return {
        payload,
        result: { summary, resultId: String(staff._id), audit: { action: "staff.create", summary: `Added staff ${summary} (Munshi AI)`, entityId: String(staff._id) } },
      };
    }

    case "receive_payment": {
      const p = payload as z.infer<typeof stepSchemas.receive_payment>;
      const customer = await findCustomer(tenantId, p.customerName);
      if (!customer) throw new StepError(`Customer "${p.customerName}" nahi mile.`, 404);
      try {
        const bills = await receivePayment(tenantId, String(customer._id), p.amount, p.paymentMethod ?? "cash", p.billNumber);
        const summary = `${customer.name} · ${rupees(p.amount)} · ${bills.join(", ")}`;
        return { payload, result: { summary, resultId: String(customer._id), audit: { action: "bill.payment", summary: `Received ${rupees(p.amount)} from ${customer.name} (${bills.join(", ")}, Munshi AI)`, entityId: String(customer._id), amount: p.amount } } };
      } catch (err) {
        if (err instanceof BillError) throw new StepError(err.message, err.status, err.code);
        throw err;
      }
    }

    case "pay_supplier": {
      const p = payload as z.infer<typeof stepSchemas.pay_supplier>;
      const supplier = await findSupplier(tenantId, p.supplierName);
      if (!supplier) throw new StepError(`Supplier "${p.supplierName}" nahi mile.`, 404);
      try {
        const paid = await paySupplier(tenantId, String(supplier._id), p.amount, p.paymentMethod ?? "cash", p.purchaseNumber);
        const summary = `${supplier.name} · ${rupees(p.amount)} · ${paid.map((x) => x.number).join(", ")}`;
        return { payload, result: { summary, resultId: paid[0]?.id, audit: { action: "purchase.payment", summary: `Paid ${rupees(p.amount)} to ${supplier.name} (Munshi AI)`, entityId: String(supplier._id), amount: p.amount } } };
      } catch (err) {
        if (err instanceof PurchaseError) throw new StepError(err.message, err.status);
        throw err;
      }
    }

    case "add_expense": {
      const p = payload as z.infer<typeof stepSchemas.add_expense>;
      const category = p.category ?? "other";
      const expense = await Expense.create({
        tenantId,
        category,
        amount: p.amount,
        method: p.paymentMethod ?? "cash",
        ...(p.note ? { note: p.note } : {}),
        spentAt: new Date(),
        createdBy: userId,
      });
      return {
        payload,
        result: {
          summary: `${rupees(p.amount)} · ${category.replace("_", " ")}${p.note ? ` · ${p.note}` : ""}`,
          resultId: String(expense._id),
          audit: { action: "expense.create", summary: `Expense ${rupees(p.amount)} · ${category}${p.note ? ` · ${p.note}` : ""} (Munshi AI)`, entityId: String(expense._id), amount: p.amount },
        },
      };
    }

    case "edit_bill": {
      const p = payload as z.infer<typeof stepSchemas.edit_bill>;
      const invoice = await findInvoice(tenantId, p.billNumber);
      if (!invoice) throw new StepError(`Bill "${p.billNumber}" nahi mila.`, 404);
      // "2 kg tha" without a rate keeps the rate that item had on this bill.
      const oldRate = new Map(invoice.items.map((it) => [normalizeName(it.productName), it.unitPrice]));
      const lines = p.items.map((l) => (l.price === undefined && oldRate.has(normalizeName(l.productName)) ? { ...l, price: oldRate.get(normalizeName(l.productName)) } : l));
      try {
        const edited = await editBill(tenantId, userId, String(invoice._id), {
          items: await billLines(tenantId, lines),
          billType: p.billType ?? invoice.billType,
          allowShortStock: force,
          allowOverCreditLimit: force,
        });
        return {
          payload,
          result: {
            summary: `${edited.invoiceNumber} · ${rupees(edited.totalAmount)}`,
            resultId: String(edited._id),
            audit: { action: "bill.edit", summary: `Edited ${edited.invoiceNumber}: ${rupees(invoice.totalAmount)} → ${rupees(edited.totalAmount)} (Munshi AI)`, entityId: String(edited._id), amount: edited.totalAmount },
          },
        };
      } catch (err) {
        if (err instanceof BillError) throw new StepError(err.message, err.status, err.code, err.details);
        throw err;
      }
    }

    case "cancel_bill": {
      const p = payload as z.infer<typeof stepSchemas.cancel_bill>;
      const invoice = await findInvoice(tenantId, p.billNumber);
      if (!invoice) throw new StepError(`Bill "${p.billNumber}" nahi mila.`, 404);
      try {
        const cancelled = await cancelBill(tenantId, userId, String(invoice._id), p.reason);
        return {
          payload,
          result: {
            summary: `${cancelled.invoiceNumber} · ${rupees(cancelled.totalAmount)}`,
            resultId: String(cancelled._id),
            audit: { action: "bill.cancel", summary: `Cancelled ${cancelled.invoiceNumber} (${rupees(cancelled.totalAmount)})${p.reason ? ` · ${p.reason}` : ""} (Munshi AI)`, entityId: String(cancelled._id), amount: cancelled.totalAmount },
          },
        };
      } catch (err) {
        if (err instanceof BillError) throw new StepError(err.message, err.status, err.code);
        throw err;
      }
    }

    case "bill_order": {
      const p = payload as z.infer<typeof stepSchemas.bill_order>;
      const customer = await findCustomer(tenantId, p.customerName);
      if (!customer) throw new StepError(`Customer "${p.customerName}" nahi mile.`, 404);
      const pending = await getCustomerPendingItems(tenantId, String(customer._id));
      if (pending.length === 0) throw new StepError(`${customer.name} ka koi order baaki nahi hai.`, 404);
      const tenant = await Tenant.findById(tenantId, { appSetup: 1 }).lean();
      // An order taken without a rate is billed at the item's saved price.
      const saved = await Product.find({ tenantId, _id: { $in: pending.map((i) => i.productId).filter(Boolean) } }, { retailPrice: 1 }).lean();
      const priceOf = new Map(saved.map((x) => [String(x._id), x.retailPrice]));
      try {
        const invoice = await createBill(tenantId, userId, {
          customerId: String(customer._id),
          orderIds: [...new Set(pending.map((i) => i.orderId))],
          items: pending.map((i) => ({
            orderId: i.orderId,
            productId: i.productId,
            productName: i.productName,
            quantity: i.quantity,
            unit: i.unit,
            unitPrice: i.unitPrice || priceOf.get(String(i.productId)) || 0,
          })),
          billType: p.billType ?? tenant?.appSetup?.defaultBillType ?? "record",
          allowShortStock: force,
          allowOverCreditLimit: force,
          ...(p.paidAmount ? { payment: { amount: p.paidAmount, method: p.paymentMethod ?? "cash" } } : {}),
        });
        return {
          payload,
          result: {
            summary: `${invoice.invoiceNumber} · ${rupees(invoice.totalAmount)}`,
            resultId: String(invoice._id),
            audit: { action: "bill.create", summary: `${invoice.invoiceNumber} for ${customer.name} from order: ${rupees(invoice.totalAmount)} (Munshi AI)`, entityId: String(invoice._id), amount: invoice.totalAmount },
          },
        };
      } catch (err) {
        if (err instanceof BillError) throw new StepError(err.message, err.status, err.code, err.details);
        throw err;
      }
    }

    case "update_customer": {
      const p = payload as z.infer<typeof stepSchemas.update_customer>;
      const customer = await findCustomer(tenantId, p.name);
      if (!customer) throw new StepError(`Customer "${p.name}" nahi mile.`, 404);
      const gstin = p.gstin?.toUpperCase();
      const set: Record<string, unknown> = {
        ...(p.newName ? { name: tidy(p.newName) } : {}),
        ...(p.phone ? { phone: p.phone.replace(/\D/g, "").slice(-10) } : {}),
        ...(p.address ? { address: p.address } : {}),
        ...(gstin ? { gstin, stateCode: gstin.slice(0, 2), kind: "business" } : {}),
      };
      if (!Object.keys(set).length) throw new StepError("Kya badalna hai, yeh batayein.");
      await Customer.updateOne({ _id: customer._id, tenantId }, { $set: set });
      const name = (set.name as string | undefined) ?? customer.name;
      return { payload, result: { summary: name, resultId: String(customer._id), audit: { action: "customer.update", summary: `Updated customer ${name} (Munshi AI)`, entityId: String(customer._id) } } };
    }

    case "update_supplier": {
      const p = payload as z.infer<typeof stepSchemas.update_supplier>;
      const supplier = await findSupplier(tenantId, p.name);
      if (!supplier) throw new StepError(`Supplier "${p.name}" nahi mile.`, 404);
      const set: Record<string, unknown> = {
        ...(p.newName ? { name: tidy(p.newName) } : {}),
        ...(p.phone ? { phone: p.phone.replace(/\D/g, "").slice(-10) } : {}),
        ...(p.gstin ? { gstin: p.gstin.toUpperCase() } : {}),
      };
      if (!Object.keys(set).length) throw new StepError("Kya badalna hai, yeh batayein.");
      await Supplier.updateOne({ _id: supplier._id, tenantId }, { $set: set });
      const name = (set.name as string | undefined) ?? supplier.name;
      return { payload, result: { summary: name, resultId: String(supplier._id), audit: { action: "supplier.update", summary: `Updated supplier ${name} (Munshi AI)`, entityId: String(supplier._id) } } };
    }

    case "update_product": {
      const p = payload as z.infer<typeof stepSchemas.update_product>;
      const found = await findProduct(tenantId, p.name);
      if (!found) throw new StepError(`Item "${p.name}" nahi mila.`, 404);
      const before = await Product.findOne({ _id: found._id, tenantId }).lean();
      if (!before) throw new StepError(`Item "${p.name}" nahi mila.`, 404);
      const set: Record<string, unknown> = {
        ...(p.newName ? { name: tidy(p.newName) } : {}),
        ...(p.unit ? { unit: p.unit } : {}),
        ...(p.purchasePrice !== undefined ? { purchasePrice: p.purchasePrice } : {}),
        ...(p.reorderLevel !== undefined ? { reorderLevel: p.reorderLevel } : {}),
        // Sale price is the shop price; the wholesale price follows it only when they were the same.
        ...(p.salePrice !== undefined ? { retailPrice: p.salePrice, ...(before.wholesalePrice === before.retailPrice ? { wholesalePrice: p.salePrice } : {}) } : {}),
      };
      if (!Object.keys(set).length) throw new StepError("Kya badalna hai, yeh batayein.");
      await Product.updateOne({ _id: found._id, tenantId }, { $set: set });
      const name = (set.name as string | undefined) ?? before.name;
      const priceNote = [
        p.salePrice !== undefined ? `bikri ${rupees(before.retailPrice)} → ${rupees(p.salePrice)}` : "",
        p.purchasePrice !== undefined ? `kharid ${rupees(before.purchasePrice)} → ${rupees(p.purchasePrice)}` : "",
      ].filter(Boolean).join(", ");
      return {
        payload,
        result: {
          summary: priceNote ? `${name} · ${priceNote}` : name,
          resultId: String(found._id),
          audit: { action: priceNote ? "product.price" : "product.update", summary: `${name}${priceNote ? `: ${priceNote}` : " updated"} (Munshi AI)`, entityId: String(found._id) },
        },
      };
    }

    case "update_staff": {
      const p = payload as z.infer<typeof stepSchemas.update_staff>;
      const staff = await findStaff(tenantId, p.name);
      if (!staff) throw new StepError(`"${p.name}" naam ka staff nahi mila.`, 404);
      const digits = (p.phone ?? "").replace(/\D/g, "").slice(-10);
      if (p.phone && digits.length !== 10) throw new StepError("Mobile number 10 ank ka hona chahiye.");
      const department = p.department ? await departmentFor(tenantId, p.department) : null;
      const updated = await updateStaff(tenantId, String(staff._id), {
        ...(p.newName ? { name: tidy(p.newName) } : {}),
        ...(digits ? { phone: digits } : {}),
        ...(department ? { departmentId: department.id } : {}),
        ...(p.role ? { role: p.role } : {}),
        ...(p.monthlySalary !== undefined ? { monthlySalary: p.monthlySalary, payType: "salary" as const } : {}),
        ...(p.dailyWage !== undefined ? { dailyWage: p.dailyWage, payType: "daily_wage" as const } : {}),
      });
      const summary = department ? `${updated.name} · ${department.name}` : updated.name;
      return { payload, result: { summary, resultId: String(staff._id), audit: { action: "staff.update", summary: `Updated staff ${summary} (Munshi AI)`, entityId: String(staff._id) } } };
    }

    case "adjust_stock": {
      const p = payload as z.infer<typeof stepSchemas.adjust_stock>;
      const product = await findProduct(tenantId, p.productName);
      if (!product) throw new StepError(`Item "${p.productName}" nahi mila.`, 404);
      const warehouseId = await defaultWarehouseId(tenantId);
      const buckets = await stockBuckets(tenantId, [product._id]);
      const now = totalOf(buckets.get(String(product._id)));
      // Damaged goods always go out; otherwise "out" (or a minus sign) takes out.
      const out = p.reason === "damage" || p.direction === "out" || (p.direction === undefined && p.quantity < 0);
      const change = out ? -Math.abs(p.quantity) : Math.abs(p.quantity);
      if (change < 0 && now + change < 0) throw new StepError(`${product.name} ka stock sirf ${now} ${product.unit} hai; ${Math.abs(change)} nahi nikal sakte.`);
      const reason = p.reason ?? (change < 0 ? "damage" : "adjustment");
      await StockMovement.create({
        tenantId,
        productId: product._id,
        warehouseId,
        quantity: change,
        movementType: reason,
        note: p.note ? `${p.note} (Munshi AI)` : "Munshi AI",
        createdBy: userId,
      });
      const after = Math.round((now + change) * 1000) / 1000;
      return {
        payload,
        result: {
          summary: `${product.name}: ${now} → ${after} ${product.unit}`,
          resultId: String(product._id),
          audit: { action: "stock.adjust", summary: `${product.name}: ${change > 0 ? "+" : ""}${change} ${product.unit} (${reason}, Munshi AI)`, entityId: String(product._id) },
        },
      };
    }
  }
}

/** One line per step for the chat history, so Munshi knows what's done and what's waiting. */
export function stepsForHistory(steps: WorkflowStep[] | undefined): string {
  if (!steps?.length) return "";
  const state = (s: WorkflowStep) =>
    s.status === "confirmed"
      ? `DONE and saved by the user${s.resultSummary ? ` (${s.resultSummary})` : ""}; nothing more to confirm`
      : s.status === "dismissed"
        ? s.replaced
          ? "replaced by a later list"
          : "skipped by the user"
        : "still waiting for the user to confirm";
  return `\n[What happened to these steps: ${steps.map((s, i) => `${i + 1}. ${s.type} ${JSON.stringify(s.payload)}: ${state(s)}`).join("; ")}]`;
}

/**
 * Identity of a job, to spot the same bill / purchase / order proposed again:
 * type + party + items (name, quantity, unit, price), with names normalised
 * ("Ravi ji" = "ravi"). Steps that only add a party or item use their name.
 */
export function stepSignature(type: string, payload: Record<string, unknown>): string {
  const p = payload as {
    name?: string;
    customerName?: string;
    supplierName?: string;
    productName?: string;
    items?: { productName: string; quantity: number; unit?: string; price?: number }[];
    staffName?: string;
    date?: string;
    amount?: number;
    quantity?: number;
    billNumber?: string;
  };
  const items = (p.items ?? [])
    .map((i) => `${normalizeName(i.productName)}:${Number(i.quantity)}:${(i.unit ?? "").toLowerCase()}:${i.price ?? ""}`)
    .sort()
    .join(",");
  const party = normalizeName(p.customerName ?? p.supplierName ?? p.productName ?? p.name ?? p.staffName ?? "");
  return `${type}|${party}|${items}|${p.date ?? ""}|${p.amount ?? p.quantity ?? ""}|${(p.billNumber ?? "").toUpperCase()}`;
}
