import { randomUUID } from "crypto";
import { z } from "zod";
import { Customer } from "../../models/Customer";
import { Product } from "../../models/Product";
import { Staff } from "../../models/Staff";
import { Supplier } from "../../models/Supplier";
import { Tenant } from "../../models/Tenant";
import type { UserRole } from "../../models/User";
import { generateSku } from "../../utils/sku";
import { markAttendance } from "../attendance/attendance.service";
import { BillError, createBill } from "../invoices/invoices.service";
import { saveOrder } from "../orders/orders.service";
import { PurchaseError, createPurchase } from "../purchases/purchases.service";

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
const paymentMethod = z.enum(["cash", "upi", "bank_transfer", "cheque"]).optional();

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
export const workflowTools = [
  {
    type: "function" as const,
    function: {
      name: "propose_steps",
      description:
        "Propose the work the user asked for, as an ordered list of steps (one per job, in the order it happened). The user reviews and confirms each step. Step types:\n" +
        "- record_purchase: goods bought/taken from a supplier (liya, kharida, mangwaya). Needs supplierName, items. Stock goes up.\n" +
        "- create_bill: goods sold (becha, bech diya, de diya) or a bill asked for. One step per customer. customerName empty = walk-in counter sale. Stock goes down.\n" +
        "- create_order: a customer's order to deliver/bill later (not goods already sold). Needs customerName, items.\n" +
        "- create_customer / create_supplier: add a new party (name, phone, gstin, address, kind). Only when the user asks to add one; purchases and bills add missing parties themselves.\n" +
        "- create_product: add a new item (name, unit, purchasePrice, salePrice). Only when asked; purchases and bills add missing items themselves.\n" +
        "- mark_attendance: staffName, date (YYYY-MM-DD), status.",
      parameters: {
        type: "object",
        properties: {
          steps: {
            type: "array",
            items: {
              type: "object",
              properties: {
                type: { type: "string", enum: ["record_purchase", "create_bill", "create_order", "create_customer", "create_supplier", "create_product", "mark_attendance"] },
                supplierName: { type: "string" },
                customerName: { type: "string" },
                items: lineItems,
                billType: { type: "string", enum: ["gst", "record"], description: "Only if the user said GST bill or kaccha/simple bill" },
                paidAmount: { type: "number", description: "Money paid/received now, only if said" },
                paymentMethod: { type: "string", enum: ["cash", "upi", "bank_transfer", "cheque"] },
                name: { type: "string", description: "For create_customer / create_supplier / create_product" },
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
      args = JSON.parse(call.arguments || "{}");
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
    const parsed = stepSchemas[type].safeParse(args);
    if (!parsed.success) continue;
    // Don't offer to add what's already saved (e.g. the item a step just created).
    const name = String((parsed.data as { name?: unknown }).name ?? "");
    if (type === "create_product" && (await findProduct(tenantId, name))) continue;
    if (type === "create_customer" && (await findCustomer(tenantId, name))) continue;
    if (type === "create_supplier" && (await findSupplier(tenantId, name))) continue;
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
      const items = [];
      for (const line of p.items) {
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
      const { order } = await saveOrder(tenantId, userId, {
        customerId: String(customer._id),
        items: p.items.map((i) => ({ productName: i.productName, quantity: i.quantity, unit: i.unit ?? "pcs", unitPrice: i.price ?? 0, isNewProduct: true })),
        source: "ai_parsed",
      });
      return { payload, result: { summary: String(order._id).slice(-6).toUpperCase(), resultId: String(order._id) } };
    }

    case "mark_attendance": {
      const p = payload as z.infer<typeof stepSchemas.mark_attendance>;
      const staff = await Staff.find({ tenantId }, { name: 1 }).lean().then((rows) => pickByName(rows, p.staffName));
      if (!staff) throw new StepError(`"${p.staffName}" naam ka staff nahi mila.`, 404);
      await markAttendance(tenantId, userId, { staffId: String(staff._id), date: p.date, status: p.status });
      return { payload, result: { summary: staff.name } };
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
  const p = payload as { name?: string; customerName?: string; supplierName?: string; items?: { productName: string; quantity: number; unit?: string; price?: number }[]; staffName?: string; date?: string };
  const items = (p.items ?? [])
    .map((i) => `${normalizeName(i.productName)}:${Number(i.quantity)}:${(i.unit ?? "").toLowerCase()}:${i.price ?? ""}`)
    .sort()
    .join(",");
  const party = normalizeName(p.customerName ?? p.supplierName ?? p.name ?? p.staffName ?? "");
  return `${type}|${party}|${items}|${p.date ?? ""}`;
}
