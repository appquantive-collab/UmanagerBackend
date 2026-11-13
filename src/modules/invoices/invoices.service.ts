import mongoose, { Types, type HydratedDocument } from "mongoose";
import { Order } from "../../models/Order";
import { Product, type ProductDocument } from "../../models/Product";
import { Customer } from "../../models/Customer";
import { Tenant } from "../../models/Tenant";
import { StockMovement } from "../../models/StockMovement";
import {
  ACTIVE_INVOICE,
  Invoice,
  type BillType,
  type InvoiceLineItem,
  type PaymentMethod,
  type InvoiceDocument,
} from "../../models/Invoice";
import { generateSku } from "../../utils/sku";
import {
  defaultWarehouseId,
  planTake,
  round3,
  serialsInStock,
  stockBuckets,
  toBaseQty,
  totalOf,
  type StockBucket,
} from "../stock/ledger";

/** A bill that can't be made as asked; `code` lets the app explain and offer an override. */
export class BillError extends Error {
  constructor(
    message: string,
    readonly status = 400,
    readonly code?:
      | "INSUFFICIENT_STOCK"
      | "CREDIT_LIMIT"
      | "HAS_PAYMENTS"
      | "ALREADY_CANCELLED"
      | "CANCELLED"
      | "SERIAL_REQUIRED"
      | "SERIAL_NOT_IN_STOCK"
      | "RETURN_TOO_MUCH"
      | "BILL_NUMBER_TAKEN"
      | "BELOW_PAID"
      | "HAS_RETURN",
    readonly details?: unknown
  ) {
    super(message);
    this.name = "BillError";
  }
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * Next bill number. Follows the shop's own series: after "AM/2026/014" comes
 * "AM/2026/015"; with no bills yet it's INV-0001. Cancelled bills keep their
 * number, so the series has no gaps (as GST rules expect). Skips any number
 * already used (e.g. typed by hand).
 */
export async function nextInvoiceNumber(tenantId: string): Promise<string> {
  const last = await Invoice.findOne({ tenantId }, { invoiceNumber: 1 }).sort({ createdAt: -1, _id: -1 }).lean();
  const count = await Invoice.countDocuments({ tenantId });
  const match = last?.invoiceNumber.match(/^(.*?)(\d+)$/);
  let prefix = "INV-";
  let n = count + 1;
  let width = 4;
  if (match) {
    prefix = match[1];
    n = Number(match[2]) + 1;
    width = match[2].length;
  }
  for (let i = 0; i < 1000; i++, n++) {
    const candidate = `${prefix}${String(n).padStart(width, "0")}`;
    if (!(await Invoice.exists({ tenantId, invoiceNumber: candidate }))) return candidate;
  }
  return `INV-${Date.now()}`;
}

/** A bill number must be unique within the business. */
export async function assertBillNumberFree(tenantId: string, invoiceNumber: string, exceptId?: string) {
  const clash = await Invoice.exists({ tenantId, invoiceNumber, ...(exceptId ? { _id: { $ne: exceptId } } : {}) });
  if (clash) throw new BillError(`Bill number ${invoiceNumber} is already used`, 409, "BILL_NUMBER_TAKEN", { invoiceNumber });
}

/** The shared "Walk-in customer" for quick counter sales (created on first use). */
export async function getWalkInCustomer(tenantId: string) {
  const existing = await Customer.findOne({ tenantId, isWalkIn: true });
  if (existing) return existing;
  return Customer.create({ tenantId, name: "Walk-in customer", isWalkIn: true, creditLimit: 0 });
}

/** GSTIN starts with the 2-digit state code; fall back to an explicitly saved state. */
function stateOf(party: { gstin?: string | null; stateCode?: string | null } | null | undefined): string | undefined {
  const fromGstin = party?.gstin?.trim().slice(0, 2);
  if (fromGstin && /^\d{2}$/.test(fromGstin)) return fromGstin;
  return party?.stateCode?.trim() || undefined;
}

export interface PendingItem {
  orderId: string;
  productId: string;
  productName: string;
  quantity: number;
  unit: string;
  unitPrice: number;
}

// Powers "pick a customer, see everything they've ordered" — merges every
// pending/confirmed order for that customer into one flat item list, each
// tagged with the order it came from so billing can mark all of them delivered.
export async function getCustomerPendingItems(tenantId: string, customerId: string): Promise<PendingItem[]> {
  const customer = await Customer.findOne({ _id: customerId, tenantId });
  if (!customer) {
    throw new Error("Customer not found");
  }

  const orders = await Order.find({
    tenantId,
    customerId,
    status: { $in: ["pending", "confirmed"] },
  }).sort({ createdAt: 1 });

  const items: PendingItem[] = [];
  for (const order of orders) {
    for (const item of order.items) {
      items.push({
        orderId: String(order._id),
        productId: String(item.productId),
        productName: item.productName,
        quantity: item.quantity,
        unit: item.unit,
        unitPrice: item.unitPrice,
      });
    }
  }
  return items;
}

interface BillLineItemInput {
  orderId?: string;
  productId?: string;
  productName: string;
  quantity: number;
  unit: string;
  unitPrice: number;
  discountPercent?: number;
  /** GST % picked on the bill (else the item's saved rate). */
  gstPercent?: number;
  /** IMEI / serial numbers sold, for serial-tracked items. */
  serials?: string[];
}

interface CreateBillInput {
  /** Omit for a walk-in counter sale. */
  customerId?: string;
  orderIds: string[];
  items: BillLineItemInput[];
  billType: BillType;
  /** Own bill number; omitted → next in the series. */
  invoiceNumber?: string;
  dueDate?: string;
  /** Round the total to the nearest rupee (default on). */
  roundOff?: boolean;
  /** The shop confirmed billing items it doesn't have enough stock of. */
  allowShortStock?: boolean;
  /** The shop confirmed going over the customer's credit limit. */
  allowOverCreditLimit?: boolean;
  /** Money received with the bill (saves a separate payment step). */
  payment?: { amount: number; method: PaymentMethod };
}

const cleanSerials = (serials?: string[]) => [...new Set((serials ?? []).map((s) => s.trim().toUpperCase()).filter(Boolean))];

/** How much a customer owes on bills that count. */
async function customerOutstanding(tenantId: string, customerId: Types.ObjectId): Promise<number> {
  const rows = await Invoice.aggregate([
    {
      $match: {
        tenantId: new mongoose.Types.ObjectId(tenantId),
        customerId,
        ...ACTIVE_INVOICE,
        paymentStatus: { $in: ["unpaid", "partial"] },
      },
    },
    { $group: { _id: null, due: { $sum: { $subtract: ["$totalAmount", "$amountPaid"] } } } },
  ]);
  return Math.max(0, rows[0]?.due ?? 0);
}

// Order of work: validate everything (orders, stock, credit) BEFORE saving
// anything, so a stopped bill leaves no stray products, numbers or stock entries.
/**
 * Makes a bill — or, with `editing`, re-makes an existing one in place (same
 * number and payments; see editBill, which has already put its old items back
 * in stock before calling this).
 */
export async function createBill(tenantId: string, userId: string, input: CreateBillInput, editing?: HydratedDocument<InvoiceDocument>) {
  const customer = input.customerId
    ? await Customer.findOne({ _id: input.customerId, tenantId })
    : await getWalkInCustomer(tenantId);
  if (!customer) {
    throw new BillError("Customer not found", 404);
  }

  if (!editing && input.orderIds.length > 0) {
    const orders = await Order.find({ _id: { $in: input.orderIds }, tenantId });
    if (orders.length !== input.orderIds.length) {
      throw new BillError("One or more orders were not found", 404);
    }
    if (orders.some((o) => o.status === "cancelled")) {
      throw new BillError("Cannot bill a cancelled order");
    }
    if (orders.some((o) => o.status === "delivered")) {
      throw new BillError("One or more of these orders has already been billed");
    }
  }

  const tenant = await Tenant.findById(tenantId);
  const sellerState = stateOf(tenant);
  const buyerState = stateOf(customer);
  // Different seller and buyer states → IGST; same state (or unknown) → CGST + SGST.
  const isInterState = input.billType === "gst" && Boolean(sellerState && buyerState && sellerState !== buyerState);

  // Existing products, looked up in one go.
  const existingIds = input.items.filter((i) => i.productId).map((i) => i.productId!);
  const products = await Product.find({ _id: { $in: existingIds }, tenantId });
  const productById = new Map(products.map((p) => [String(p._id), p]));
  const missing = existingIds.filter((id) => !productById.has(id));
  if (missing.length > 0) {
    throw new BillError("Some products were not found. Please refresh and try again.", 404);
  }

  // ---- IMEI / serial numbers: every serial-tracked piece sold must be one we have ----
  const serialPlaces = new Map<string, Map<string, string>>(); // productId → serial → warehouseId
  for (const item of input.items) {
    const product = item.productId ? productById.get(item.productId) : undefined;
    if (!product?.trackSerial) continue;
    const serials = cleanSerials(item.serials);
    const pieces = toBaseQty(product, item.quantity, item.unit);
    if (serials.length !== pieces) {
      throw new BillError(`Enter ${pieces} IMEI/serial number(s) for ${product.name}`, 400, "SERIAL_REQUIRED", {
        productName: product.name,
        needed: pieces,
        given: serials.length,
      });
    }
    const inStock = serialPlaces.get(item.productId!) ?? (await serialsInStock(tenantId, product._id));
    serialPlaces.set(item.productId!, inStock);
    const unknown = serials.filter((s) => !inStock.has(s));
    if (unknown.length > 0) {
      throw new BillError(`Not in stock: ${unknown.join(", ")}`, 400, "SERIAL_NOT_IN_STOCK", { productName: product.name, serials: unknown });
    }
  }

  // ---- Stock check in the base unit (typed-in new items have no stock yet) ----
  const requested = new Map<string, number>();
  for (const item of input.items) {
    const product = item.productId ? productById.get(item.productId) : undefined;
    if (product) requested.set(item.productId!, round3((requested.get(item.productId!) ?? 0) + toBaseQty(product, item.quantity, item.unit)));
  }
  const stock = await stockBuckets(tenantId, products.map((p) => p._id));
  const shortages = [...requested.entries()]
    .filter(([productId, qty]) => totalOf(stock.get(productId)) + 1e-9 < qty)
    .map(([productId, qty]) => ({
      productId,
      productName: productById.get(productId)!.name,
      unit: productById.get(productId)!.unit,
      requested: qty,
      available: Math.max(0, totalOf(stock.get(productId))),
    }));
  if (shortages.length > 0 && !input.allowShortStock) {
    throw new BillError("Not enough stock for some items", 409, "INSUFFICIENT_STOCK", { shortages });
  }

  // ---- Amounts: discount → GST (CGST+SGST or IGST) → round-off ----
  const lines = input.items.map((item) => {
    const product = item.productId ? productById.get(item.productId) : undefined;
    const gstPercent = input.billType === "gst" ? (item.gstPercent ?? product?.gstPercent ?? 0) : 0;
    const discountPercent = Math.min(100, Math.max(0, item.discountPercent ?? 0));
    const gross = item.quantity * item.unitPrice;
    const lineSubtotal = round2(gross * (1 - discountPercent / 100));
    const lineTax = round2((lineSubtotal * gstPercent) / 100);
    const half = round2(lineTax / 2);
    return {
      input: item,
      gross,
      line: {
        productName: item.productName,
        quantity: item.quantity,
        unit: item.unit,
        unitPrice: item.unitPrice,
        gstPercent,
        hsn: product?.hsn,
        discountPercent,
        lineSubtotal,
        lineTax,
        cgst: isInterState ? 0 : half,
        sgst: isInterState ? 0 : round2(lineTax - half),
        igst: isInterState ? lineTax : 0,
        lineTotal: round2(lineSubtotal + lineTax),
        orderId: item.orderId ? new mongoose.Types.ObjectId(item.orderId) : undefined,
        serials: product?.trackSerial ? cleanSerials(item.serials) : undefined,
      },
    };
  });

  const subtotal = round2(lines.reduce((s, l) => s + l.line.lineSubtotal, 0));
  const discountTotal = round2(lines.reduce((s, l) => s + (l.gross - l.line.lineSubtotal), 0));
  const taxTotal = round2(lines.reduce((s, l) => s + l.line.lineTax, 0));
  const beforeRounding = round2(subtotal + taxTotal);
  const totalAmount = input.roundOff === false ? beforeRounding : Math.round(beforeRounding);
  const roundOff = round2(totalAmount - beforeRounding);

  // ---- Credit limit (not for walk-in) ----
  // Counter (walk-in) sales are paid on the spot: with no payment given, the
  // whole amount is taken as received in cash, so "Walk-in" never shows as owing.
  // Editing: money already received stays; a counter sale stays fully paid.
  const paidNow = editing
    ? customer.isWalkIn
      ? totalAmount
      : editing.amountPaid
    : round2(Math.min(totalAmount, input.payment?.amount ?? (customer.isWalkIn ? totalAmount : 0)));
  if (editing && !customer.isWalkIn && editing.amountPaid > totalAmount + 0.01) {
    throw new BillError("The new total is less than the money already received. Make a return instead.", 409, "BELOW_PAID", {
      paid: editing.amountPaid,
      newTotal: totalAmount,
    });
  }
  const paidMethod: PaymentMethod = input.payment?.method ?? "cash";

  if (!customer.isWalkIn && customer.creditLimit > 0 && !input.allowOverCreditLimit) {
    // When editing, this bill's own old balance isn't counted twice.
    const outstanding =
      (await customerOutstanding(tenantId, customer._id)) - (editing ? Math.max(0, editing.totalAmount - editing.amountPaid) : 0);
    if (outstanding + totalAmount - paidNow > customer.creditLimit + 0.01) {
      throw new BillError("This bill takes the customer over their credit limit", 409, "CREDIT_LIMIT", {
        creditLimit: customer.creditLimit,
        outstanding: round2(outstanding),
        billTotal: totalAmount,
        afterBill: round2(outstanding + totalAmount - paidNow),
      });
    }
  }

  if (input.invoiceNumber && input.invoiceNumber !== editing?.invoiceNumber) {
    await assertBillNumberFree(tenantId, input.invoiceNumber, editing ? String(editing._id) : undefined);
  }

  // ---- All checks passed: now save ----
  // A GST rate picked on the bill for an item saved without one becomes its rate.
  if (input.billType === "gst") {
    for (const item of input.items) {
      const product = item.productId ? productById.get(item.productId) : undefined;
      if (product && !product.gstPercent && item.gstPercent) {
        await Product.updateOne({ _id: product._id, tenantId }, { $set: { gstPercent: item.gstPercent } });
      }
    }
  }
  const items: InvoiceLineItem[] = [];
  for (const { input: item, line } of lines) {
    let productId: Types.ObjectId;
    if (item.productId) {
      productId = productById.get(item.productId)!._id;
    } else {
      // A typed-in item the shop hasn't added to inventory yet.
      const created = await Product.create({
        tenantId,
        name: item.productName,
        sku: generateSku(item.productName),
        unit: item.unit,
        purchasePrice: 0,
        wholesalePrice: item.unitPrice,
        retailPrice: item.unitPrice,
        reorderLevel: 0,
        gstPercent: input.billType === "gst" ? item.gstPercent ?? 0 : 0,
      });
      productId = created._id;
    }
    items.push({ ...line, productId });
  }

  const fields = {
    tenantId,
    orderIds: input.orderIds,
    customerId: customer._id,
    invoiceNumber: input.invoiceNumber ?? (editing ? editing.invoiceNumber : await nextInvoiceNumber(tenantId)),
    billType: input.billType,
    status: "active",
    items,
    subtotal,
    discountTotal,
    taxTotal,
    cgstTotal: round2(items.reduce((s, i) => s + (i.cgst ?? 0), 0)),
    sgstTotal: round2(items.reduce((s, i) => s + (i.sgst ?? 0), 0)),
    igstTotal: round2(items.reduce((s, i) => s + (i.igst ?? 0), 0)),
    roundOff,
    totalAmount,
    amountPaid: paidNow,
    paymentStatus: totalAmount <= 0 || paidNow >= totalAmount - 0.01 ? "paid" : paidNow > 0 ? "partial" : "unpaid",
    payments: paidNow > 0 ? [{ amount: paidNow, method: paidMethod, paidAt: new Date() }] : [],
    isInterState,
    seller: tenant
      ? {
          name: tenant.businessName,
          phone: tenant.phone,
          gstin: tenant.gstin,
          address: tenant.address,
          stateCode: sellerState,
          upiId: tenant.upiId,
          bankName: tenant.bankName,
          bankAccount: tenant.bankAccount,
          bankIfsc: tenant.bankIfsc,
          terms: tenant.invoiceTerms,
        }
      : undefined,
    buyer: {
      name: customer.name,
      phone: customer.phone,
      gstin: customer.gstin,
      aadhaarLast4: customer.aadhaarLast4,
      address: customer.address,
      stateCode: buyerState,
    },
    dueDate: input.dueDate ? new Date(input.dueDate) : undefined,
    createdBy: userId,
  };

  let invoice: HydratedDocument<InvoiceDocument>;
  if (editing) {
    const first = editing.payments[0];
    editing.set({
      ...fields,
      orderIds: editing.orderIds,
      createdBy: editing.createdBy,
      dueDate: input.dueDate ? new Date(input.dueDate) : editing.dueDate,
      // Counter sale: the one cash/UPI payment follows the corrected total.
      payments: customer.isWalkIn
        ? [{ amount: totalAmount, method: first?.method ?? paidMethod, paidAt: first?.paidAt ?? new Date() }]
        : editing.payments,
      editedAt: new Date(),
    });
    invoice = await editing.save();
  } else {
    invoice = await Invoice.create(fields);
  }

  await deductStock(tenantId, userId, invoice.invoiceNumber, String(invoice._id), items, productById, stock, serialPlaces);

  if (!editing && input.orderIds.length > 0) {
    await applyFulfillment(
      tenantId,
      input.orderIds,
      items.map((i) => {
        const product = productById.get(String(i.productId));
        return {
          orderId: i.orderId ? String(i.orderId) : undefined,
          productId: i.productId,
          quantity: product ? toBaseQty(product, i.quantity, i.unit) : i.quantity,
        };
      })
    );
  }

  return invoice;
}

// Sold goods leave stock (in the base unit): main warehouse first, oldest
// expiry first for batch items, exact warehouses for serial items. Anything not
// covered (the shop chose "Bill anyway") comes out of the main warehouse and
// shows as minus stock to fix later.
async function deductStock(
  tenantId: string,
  userId: string,
  invoiceNumber: string,
  invoiceId: string,
  items: InvoiceLineItem[],
  productById: Map<string, ProductDocument>,
  stock: Map<string, StockBucket[]>,
  serialPlaces: Map<string, Map<string, string>>
) {
  const mainId = String(await defaultWarehouseId(tenantId));
  const movements: Record<string, unknown>[] = [];
  const base = { tenantId, movementType: "sale", referenceId: invoiceId, note: invoiceNumber, createdBy: userId };
  for (const item of items) {
    const productKey = String(item.productId);
    const product = productById.get(productKey);
    const qty = product ? toBaseQty(product, item.quantity, item.unit) : item.quantity;

    if (product?.trackSerial && item.serials?.length) {
      const places = serialPlaces.get(productKey) ?? new Map<string, string>();
      const byWarehouse = new Map<string, string[]>();
      for (const serial of item.serials) {
        const warehouseId = places.get(serial) || mainId;
        byWarehouse.set(warehouseId, [...(byWarehouse.get(warehouseId) ?? []), serial]);
      }
      for (const [warehouseId, serials] of byWarehouse) {
        movements.push({ ...base, productId: item.productId, warehouseId, quantity: -serials.length, serials });
      }
      continue;
    }

    const buckets = stock.get(productKey) ?? [];
    stock.set(productKey, buckets);
    for (const take of planTake(buckets, qty, mainId)) {
      movements.push({
        ...base,
        productId: item.productId,
        warehouseId: take.warehouseId,
        quantity: -round3(take.qty),
        batchNo: take.batchNo,
        expiryDate: take.expiryDate,
      });
    }
  }
  if (movements.length > 0) await StockMovement.insertMany(movements);
}

// Reduces each order's line items by exactly what was billed against them,
// rather than marking the whole order delivered — a bill only edited down to
// part of an order's quantity must leave the rest of that order pending so
// it can still be billed later. Matches bill items to order items by
// productId, since that's the one stable identity both sides share.
async function applyFulfillment(
  tenantId: string,
  orderIds: string[],
  billedItems: { orderId?: string; productId: Types.ObjectId; quantity: number }[]
) {
  const billedByOrderId = new Map<string, Map<string, number>>();
  for (const item of billedItems) {
    if (!item.orderId) continue;
    const productKey = String(item.productId);
    const perProduct = billedByOrderId.get(item.orderId) ?? new Map<string, number>();
    perProduct.set(productKey, (perProduct.get(productKey) ?? 0) + item.quantity);
    billedByOrderId.set(item.orderId, perProduct);
  }

  const orders = await Order.find({ _id: { $in: orderIds }, tenantId });
  for (const order of orders) {
    const billedForThisOrder = billedByOrderId.get(String(order._id));
    if (!billedForThisOrder) continue;

    const remainingItems = [];
    for (const orderItem of order.items) {
      const productKey = String(orderItem.productId);
      const billedQty = billedForThisOrder.get(productKey) ?? 0;
      const remainingQty = orderItem.quantity - billedQty;
      if (remainingQty > 0.001) {
        remainingItems.push({
          productId: orderItem.productId,
          productName: orderItem.productName,
          quantity: remainingQty,
          unit: orderItem.unit,
          unitPrice: orderItem.unitPrice,
          wasAutoCreated: orderItem.wasAutoCreated,
        });
      }
    }

    if (remainingItems.length === 0) {
      order.status = "delivered";
    } else {
      order.items = remainingItems;
      order.totalAmount = remainingItems.reduce((sum, i) => sum + i.quantity * i.unitPrice, 0);
    }
    await order.save();
  }
}

/**
 * Cancel a bill made by mistake: stock goes back, its orders reopen, and it no
 * longer counts in sales or dues. Bills with payments must have them sorted first.
 */
export async function cancelBill(tenantId: string, userId: string, invoiceId: string, reason?: string) {
  const invoice = await Invoice.findOne({ _id: invoiceId, tenantId });
  if (!invoice) throw new BillError("Bill not found", 404);
  if (invoice.status === "cancelled") throw new BillError("This bill is already cancelled", 400, "ALREADY_CANCELLED");
  if (invoice.amountPaid > 0) {
    // A paid counter sale made by mistake can be cancelled (the cash is handed
    // back and drops out of the day's takings). Customer accounts with money
    // received, or anything with a return on it, need a return instead.
    const walkIn = await Customer.exists({ _id: invoice.customerId, tenantId, isWalkIn: true });
    const hasReturn = invoice.payments.some((p) => p.method === "credit_note");
    if (!walkIn || hasReturn) {
      throw new BillError("This bill has payments recorded, so it can't be cancelled. Make a return instead.", 400, "HAS_PAYMENTS");
    }
  }

  // Put back exactly what this bill still holds out, warehouse by warehouse.
  await putBillStockBack(tenantId, userId, String(invoice._id), `Cancelled ${invoice.invoiceNumber}`);

  // Reopen the orders this bill came from, with the billed quantities restored.
  const byOrder = new Map<string, InvoiceLineItem[]>();
  for (const item of invoice.items) {
    if (!item.orderId) continue;
    const key = String(item.orderId);
    byOrder.set(key, [...(byOrder.get(key) ?? []), item]);
  }
  for (const [orderId, lines] of byOrder) {
    const order = await Order.findOne({ _id: orderId, tenantId });
    if (!order || order.status === "cancelled") continue;
    for (const line of lines) {
      const existing = order.items.find((i) => String(i.productId) === String(line.productId));
      if (existing && order.status !== "delivered") existing.quantity += line.quantity;
      else if (!existing || order.status === "delivered") {
        if (order.status === "delivered") {
          order.items = order.items.filter((i) => String(i.productId) !== String(line.productId));
        }
        order.items.push({
          productId: line.productId,
          productName: line.productName,
          quantity: line.quantity,
          unit: line.unit,
          unitPrice: line.unitPrice,
          wasAutoCreated: false,
        });
      }
    }
    order.status = "confirmed";
    order.totalAmount = order.items.reduce((sum, i) => sum + i.quantity * i.unitPrice, 0);
    await order.save();
  }

  invoice.status = "cancelled";
  invoice.cancelledAt = new Date();
  invoice.cancelReason = reason?.trim() || undefined;
  await invoice.save();
  return invoice;
}

export async function recordPayment(
  tenantId: string,
  invoiceId: string,
  amount: number,
  method: PaymentMethod,
  note?: string
) {
  const invoice = await Invoice.findOne({ _id: invoiceId, tenantId });
  if (!invoice) {
    throw new BillError("Invoice not found", 404);
  }
  if (invoice.status === "cancelled") {
    throw new BillError("This bill is cancelled", 400, "CANCELLED");
  }
  if (invoice.paymentStatus === "paid") {
    throw new BillError("Invoice is already fully paid");
  }

  const remaining = invoice.totalAmount - invoice.amountPaid;
  if (amount > remaining + 0.01) {
    throw new BillError(`Payment exceeds the remaining balance of ${remaining.toFixed(2)}`);
  }

  invoice.payments.push({ amount, method, paidAt: new Date(), note });
  invoice.amountPaid += amount;
  invoice.paymentStatus = invoice.amountPaid >= invoice.totalAmount - 0.01 ? "paid" : "partial";

  await invoice.save();
  return invoice;
}

/**
 * Returns to stock what a bill currently holds out: its sale entries minus any
 * earlier put-backs (an edited bill has both). Grouped by item, warehouse and
 * batch; IMEI/serial numbers are netted the same way.
 */
async function putBillStockBack(tenantId: string, userId: string, invoiceId: string, note: string) {
  const moves = await StockMovement.find({ tenantId, referenceId: invoiceId, movementType: { $in: ["sale", "adjustment"] } });
  const groups = new Map<string, { productId: Types.ObjectId; warehouseId: unknown; batchNo?: string; expiryDate?: Date; qty: number; serials: Map<string, number> }>();
  for (const m of moves) {
    const key = [String(m.productId), String(m.warehouseId ?? ""), m.batchNo ?? ""].join("|");
    const g = groups.get(key) ?? { productId: m.productId, warehouseId: m.warehouseId, batchNo: m.batchNo ?? undefined, expiryDate: m.expiryDate ?? undefined, qty: 0, serials: new Map<string, number>() };
    g.qty += m.quantity;
    for (const sn of m.serials ?? []) g.serials.set(sn, (g.serials.get(sn) ?? 0) + (m.quantity < 0 ? 1 : -1));
    groups.set(key, g);
  }
  const back = [...groups.values()]
    .filter((g) => g.qty < -1e-9)
    .map((g) => {
      const out = [...g.serials.entries()].filter(([, n]) => n > 0).map(([sn]) => sn);
      return {
        tenantId,
        productId: g.productId,
        warehouseId: g.warehouseId,
        quantity: Math.round(-g.qty * 1000) / 1000,
        movementType: "adjustment" as const,
        referenceId: invoiceId,
        batchNo: g.batchNo,
        expiryDate: g.expiryDate,
        serials: out.length ? out : undefined,
        note,
        createdBy: userId,
      };
    });
  if (back.length > 0) await StockMovement.insertMany(back);
  return back;
}

/**
 * Change a bill after it was made: items, quantities, rates, GST %, discount,
 * bill type or number. Same checks as a new bill (stock, credit limit, IMEI).
 * Money already received stays on the bill; the customer can't be changed here.
 * A bill with a return on it can't be edited (its credit note depends on it).
 */
export async function editBill(tenantId: string, userId: string, invoiceId: string, input: Omit<CreateBillInput, "customerId" | "orderIds" | "payment">) {
  const invoice = await Invoice.findOne({ _id: invoiceId, tenantId });
  if (!invoice) throw new BillError("Bill not found", 404);
  if (invoice.status === "cancelled") throw new BillError("This bill is cancelled", 400, "CANCELLED");
  if (invoice.payments.some((p) => p.method === "credit_note")) {
    throw new BillError("This bill has a return on it, so it can't be edited.", 400, "HAS_RETURN");
  }

  // 1. Old items go back into stock, so the new items are checked against real stock.
  const putBack = await putBillStockBack(tenantId, userId, String(invoice._id), `Editing ${invoice.invoiceNumber}: old items back`);
  try {
    // 2. Same path as a new bill, saved onto this one.
    return await createBill(
      tenantId,
      userId,
      { ...input, customerId: String(invoice.customerId), orderIds: invoice.orderIds.map(String) },
      invoice
    );
  } catch (err) {
    // 3. Stopped (short stock, credit limit…): take the old items out again, nothing else changed.
    if (putBack.length > 0) {
      await StockMovement.insertMany(
        putBack.map((m) => ({ ...m, quantity: -m.quantity, note: `Edit of ${invoice.invoiceNumber} not saved` }))
      );
    }
    throw err;
  }
}
