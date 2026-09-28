import { Types } from "mongoose";
import { Order } from "../../models/Order";
import { Product } from "../../models/Product";
import { Customer } from "../../models/Customer";
import { Invoice, type BillType, type InvoiceLineItem, type PaymentMethod } from "../../models/Invoice";
import { generateSku } from "../../utils/sku";

async function nextInvoiceNumber(tenantId: string): Promise<string> {
  // Per-tenant sequential numbering: INV-0001, INV-0002, ... — count existing
  // invoices for this tenant rather than a global counter, since each tenant's
  // invoice sequence is independent (never shared or comparable across tenants).
  const count = await Invoice.countDocuments({ tenantId });
  return `INV-${String(count + 1).padStart(4, "0")}`;
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
  productId?: string;
  productName: string;
  quantity: number;
  unit: string;
  unitPrice: number;
}

interface CreateBillInput {
  customerId: string;
  orderIds: string[];
  items: BillLineItemInput[];
  billType: BillType;
  dueDate?: string;
}

// The user has already reviewed and can freely edit items by this point — this
// is where a typed-in new product actually gets created, same as order-saving.
export async function createBill(tenantId: string, userId: string, input: CreateBillInput) {
  const customer = await Customer.findOne({ _id: input.customerId, tenantId });
  if (!customer) {
    throw new Error("Customer not found");
  }

  if (input.orderIds.length > 0) {
    const orders = await Order.find({ _id: { $in: input.orderIds }, tenantId });
    if (orders.length !== input.orderIds.length) {
      throw new Error("One or more orders were not found");
    }
    if (orders.some((o) => o.status === "cancelled")) {
      throw new Error("Cannot bill a cancelled order");
    }
    if (orders.some((o) => o.status === "delivered")) {
      throw new Error("One or more of these orders has already been billed");
    }
  }

  const resolvedItems: { productId: Types.ObjectId; productName: string; quantity: number; unit: string; unitPrice: number }[] = [];
  for (const item of input.items) {
    let productId: Types.ObjectId;

    if (item.productId) {
      const existing = await Product.findOne({ _id: item.productId, tenantId });
      if (!existing) {
        throw new Error(`Product ${item.productId} not found`);
      }
      productId = existing._id;
    } else {
      const created = await Product.create({
        tenantId,
        name: item.productName,
        sku: generateSku(item.productName),
        unit: item.unit,
        purchasePrice: 0,
        wholesalePrice: item.unitPrice,
        retailPrice: item.unitPrice,
        reorderLevel: 0,
      });
      productId = created._id;
    }

    resolvedItems.push({
      productId,
      productName: item.productName,
      quantity: item.quantity,
      unit: item.unit,
      unitPrice: item.unitPrice,
    });
  }

  const gstByProductId = new Map<string, number>();
  if (input.billType === "gst") {
    const products = await Product.find({ _id: { $in: resolvedItems.map((i) => i.productId) }, tenantId });
    for (const p of products) gstByProductId.set(String(p._id), p.gstPercent ?? 0);
  }

  const items: InvoiceLineItem[] = resolvedItems.map((item) => {
    const gstPercent = input.billType === "gst" ? (gstByProductId.get(String(item.productId)) ?? 0) : 0;
    const lineSubtotal = item.quantity * item.unitPrice;
    const lineTax = (lineSubtotal * gstPercent) / 100;
    return {
      productId: item.productId,
      productName: item.productName,
      quantity: item.quantity,
      unit: item.unit,
      unitPrice: item.unitPrice,
      gstPercent,
      lineSubtotal,
      lineTax,
      lineTotal: lineSubtotal + lineTax,
    };
  });

  const subtotal = items.reduce((sum, i) => sum + i.lineSubtotal, 0);
  const taxTotal = items.reduce((sum, i) => sum + i.lineTax, 0);
  const totalAmount = subtotal + taxTotal;

  const invoiceNumber = await nextInvoiceNumber(tenantId);

  const invoice = await Invoice.create({
    tenantId,
    orderIds: input.orderIds,
    customerId: customer._id,
    invoiceNumber,
    billType: input.billType,
    items,
    subtotal,
    taxTotal,
    totalAmount,
    amountPaid: 0,
    paymentStatus: "unpaid",
    dueDate: input.dueDate ? new Date(input.dueDate) : undefined,
    createdBy: userId,
  });

  if (input.orderIds.length > 0) {
    await Order.updateMany({ _id: { $in: input.orderIds }, tenantId }, { $set: { status: "delivered" } });
  }

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
    throw new Error("Invoice not found");
  }
  if (invoice.paymentStatus === "paid") {
    throw new Error("Invoice is already fully paid");
  }

  const remaining = invoice.totalAmount - invoice.amountPaid;
  if (amount > remaining + 0.01) {
    throw new Error(`Payment exceeds the remaining balance of ${remaining.toFixed(2)}`);
  }

  invoice.payments.push({ amount, method, paidAt: new Date(), note });
  invoice.amountPaid += amount;
  invoice.paymentStatus = invoice.amountPaid >= invoice.totalAmount - 0.01 ? "paid" : "partial";

  await invoice.save();
  return invoice;
}
