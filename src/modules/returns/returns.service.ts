import { Types } from "mongoose";
import { Invoice } from "../../models/Invoice";
import { Product } from "../../models/Product";
import { SaleReturn, type SaleReturnLine } from "../../models/SaleReturn";
import { StockMovement } from "../../models/StockMovement";
import type { PaymentMethod } from "../../models/Invoice";
import { BillError } from "../invoices/invoices.service";
import { defaultWarehouseId, round3, toBaseQty } from "../stock/ledger";

const round2 = (n: number) => Math.round(n * 100) / 100;

export interface CreateReturnInput {
  invoiceId: string;
  items: { productId: string; quantity: number; serials?: string[] }[];
  /** How money goes back if the bill was already paid. */
  refundMethod?: Exclude<PaymentMethod, "credit" | "credit_note">;
  reason?: string;
}

async function nextReturnNumber(tenantId: string) {
  const count = await SaleReturn.countDocuments({ tenantId });
  return `CN-${String(count + 1).padStart(4, "0")}`;
}

/** What can still come back on a bill: billed quantity minus earlier returns, per product line. */
export async function returnableItems(tenantId: string, invoiceId: string) {
  const invoice = await Invoice.findOne({ _id: invoiceId, tenantId });
  if (!invoice) throw new BillError("Bill not found", 404);
  const earlier = await SaleReturn.find({ tenantId, invoiceId: invoice._id }).lean();
  const returned = new Map<string, number>();
  const returnedSerials = new Set<string>();
  for (const r of earlier) {
    for (const line of r.items) {
      returned.set(String(line.productId), round3((returned.get(String(line.productId)) ?? 0) + line.quantity));
      line.serials?.forEach((s) => returnedSerials.add(s));
    }
  }
  // Same product on several lines: merge them (quantities and money).
  const merged = new Map<string, { productId: string; productName: string; unit: string; billed: number; subtotal: number; tax: number; gstPercent: number; serials: string[] }>();
  for (const line of invoice.items) {
    const key = String(line.productId);
    const entry = merged.get(key) ?? {
      productId: key,
      productName: line.productName,
      unit: line.unit,
      billed: 0,
      subtotal: 0,
      tax: 0,
      gstPercent: line.gstPercent,
      serials: [],
    };
    entry.billed = round3(entry.billed + line.quantity);
    entry.subtotal += line.lineSubtotal;
    entry.tax += line.lineTax;
    entry.serials.push(...(line.serials ?? []).filter((s) => !returnedSerials.has(s)));
    merged.set(key, entry);
  }
  return {
    invoice,
    earlier,
    items: [...merged.values()].map((m) => ({
      ...m,
      returned: returned.get(m.productId) ?? 0,
      returnable: Math.max(0, round3(m.billed - (returned.get(m.productId) ?? 0))),
      unitPrice: m.billed > 0 ? round2(m.subtotal / m.billed) : 0,
      unitTax: m.billed > 0 ? m.tax / m.billed : 0,
    })),
  };
}

/**
 * Goods back from a customer. Stock returns to where it was sold from; the
 * value first clears what they still owe on the bill (a credit note line on
 * the bill), and anything beyond that is refunded in money.
 */
export async function createReturn(tenantId: string, userId: string, input: CreateReturnInput) {
  const { invoice, items: returnable } = await returnableItems(tenantId, input.invoiceId);
  if (invoice.status === "cancelled") throw new BillError("This bill is cancelled", 400, "CANCELLED");

  const byProduct = new Map(returnable.map((r) => [r.productId, r]));
  const lines: SaleReturnLine[] = [];
  for (const item of input.items) {
    if (item.quantity <= 0) continue;
    const source = byProduct.get(item.productId);
    if (!source) throw new BillError("This item is not on the bill");
    if (item.quantity > source.returnable + 1e-9) {
      throw new BillError(`Only ${source.returnable} ${source.unit} of ${source.productName} can come back`, 400, "RETURN_TOO_MUCH", {
        productName: source.productName,
        returnable: source.returnable,
      });
    }
    const serials = [...new Set((item.serials ?? []).map((s) => s.trim().toUpperCase()).filter(Boolean))];
    const notSold = serials.filter((s) => !source.serials.includes(s));
    if (notSold.length) throw new BillError(`Not sold on this bill: ${notSold.join(", ")}`, 400, "SERIAL_NOT_IN_STOCK");
    const lineSubtotal = round2(source.unitPrice * item.quantity);
    const lineTax = round2(source.unitTax * item.quantity);
    lines.push({
      productId: new Types.ObjectId(item.productId),
      productName: source.productName,
      quantity: item.quantity,
      unit: source.unit,
      unitPrice: source.unitPrice,
      gstPercent: source.gstPercent,
      lineSubtotal,
      lineTax,
      lineTotal: round2(lineSubtotal + lineTax),
      serials: serials.length ? serials : undefined,
    });
  }
  if (lines.length === 0) throw new BillError("Pick at least one item to return");

  const subtotal = round2(lines.reduce((s, l) => s + l.lineSubtotal, 0));
  const taxTotal = round2(lines.reduce((s, l) => s + l.lineTax, 0));
  const totalAmount = round2(subtotal + taxTotal);
  const due = Math.max(0, round2(invoice.totalAmount - invoice.amountPaid));
  const adjustedAmount = round2(Math.min(totalAmount, due));
  const refundAmount = round2(totalAmount - adjustedAmount);

  const saleReturn = await SaleReturn.create({
    tenantId,
    returnNumber: await nextReturnNumber(tenantId),
    invoiceId: invoice._id,
    invoiceNumber: invoice.invoiceNumber,
    customerId: invoice.customerId,
    items: lines,
    subtotal,
    taxTotal,
    totalAmount,
    adjustedAmount,
    refundAmount,
    refundMethod: refundAmount > 0 ? (input.refundMethod ?? "cash") : undefined,
    reason: input.reason?.trim() || undefined,
    createdBy: userId,
  });

  if (adjustedAmount > 0) {
    invoice.payments.push({ amount: adjustedAmount, method: "credit_note", paidAt: new Date(), note: `Return ${saleReturn.returnNumber}` });
    invoice.amountPaid = round2(invoice.amountPaid + adjustedAmount);
    invoice.paymentStatus = invoice.amountPaid >= invoice.totalAmount - 0.01 ? "paid" : "partial";
    await invoice.save();
  }

  // Back into stock: same warehouse/batch the sale took it from where we can tell.
  const products = await Product.find({ _id: { $in: lines.map((l) => l.productId) }, tenantId });
  const productById = new Map(products.map((p) => [String(p._id), p]));
  const saleMoves = await StockMovement.find({ tenantId, referenceId: String(invoice._id), movementType: "sale" }).lean();
  const mainId = await defaultWarehouseId(tenantId);
  const movements = lines.map((line) => {
    const product = productById.get(String(line.productId));
    const from = saleMoves.find((m) => String(m.productId) === String(line.productId));
    const qty = product ? toBaseQty(product, line.quantity, line.unit) : line.quantity;
    return {
      tenantId,
      productId: line.productId,
      warehouseId: from?.warehouseId ?? mainId,
      quantity: round3(qty),
      batchNo: from?.batchNo,
      expiryDate: from?.expiryDate,
      serials: line.serials,
      movementType: "customer_return",
      referenceId: String(saleReturn._id),
      note: `${saleReturn.returnNumber} · ${invoice.invoiceNumber}`,
      createdBy: userId,
    };
  });
  await StockMovement.insertMany(movements);

  return saleReturn;
}

export function listReturns(tenantId: string) {
  return SaleReturn.find({ tenantId }).sort({ createdAt: -1 }).limit(500).populate("customerId", "name phone").lean();
}
