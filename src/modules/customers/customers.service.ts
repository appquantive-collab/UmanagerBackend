import { Types } from "mongoose";
import { Customer } from "../../models/Customer";
import { Invoice } from "../../models/Invoice";
import { Order } from "../../models/Order";

export interface CustomerListItem {
  _id: string;
  name: string;
  phone?: string;
  creditLimit: number;
  isActive: boolean;
  totalPurchases: number;
  outstanding: number;
  lastPurchaseAt: string | null;
  createdAt: string;
}

// Powers the customer list — total purchases and outstanding balance are
// derived from real invoices (never stored on the Customer document itself),
// same ledger-derived principle used for stock levels.
export async function listCustomersWithStats(tenantId: string, search?: string): Promise<CustomerListItem[]> {
  const filter: Record<string, unknown> = { tenantId: new Types.ObjectId(tenantId) };
  if (search) filter.name = { $regex: search, $options: "i" };

  const customers = await Customer.find(filter).sort({ createdAt: -1 }).lean();
  if (customers.length === 0) return [];

  const stats = await Invoice.aggregate([
    { $match: { tenantId: new Types.ObjectId(tenantId), customerId: { $in: customers.map((c) => c._id) } } },
    {
      $group: {
        _id: "$customerId",
        totalPurchases: { $sum: "$totalAmount" },
        outstanding: { $sum: { $subtract: ["$totalAmount", "$amountPaid"] } },
        lastPurchaseAt: { $max: "$createdAt" },
      },
    },
  ]);

  const statsByCustomerId = new Map(stats.map((s) => [String(s._id), s]));

  return customers.map((c) => {
    const s = statsByCustomerId.get(String(c._id));
    return {
      _id: String(c._id),
      name: c.name,
      phone: c.phone,
      creditLimit: c.creditLimit,
      isActive: c.isActive,
      totalPurchases: s?.totalPurchases ?? 0,
      outstanding: Math.max(0, s?.outstanding ?? 0),
      lastPurchaseAt: s?.lastPurchaseAt ? new Date(s.lastPurchaseAt).toISOString() : null,
      createdAt: c.createdAt.toISOString(),
    };
  });
}

export interface CustomerPortfolio {
  customer: {
    _id: string;
    name: string;
    phone?: string;
    creditLimit: number;
    isActive: boolean;
    createdAt: string;
  };
  stats: {
    totalPurchases: number;
    totalPaid: number;
    outstanding: number;
    totalOrders: number;
    pendingOrders: number;
    totalInvoices: number;
    lastPurchaseAt: string | null;
  };
  orders: Array<{
    _id: string;
    itemCount: number;
    totalAmount: number;
    status: string;
    source: string;
    createdAt: string;
  }>;
  invoices: Array<{
    _id: string;
    invoiceNumber: string;
    billType: string;
    totalAmount: number;
    amountPaid: number;
    paymentStatus: string;
    createdAt: string;
  }>;
  payments: Array<{
    invoiceId: string;
    invoiceNumber: string;
    amount: number;
    method: string;
    paidAt: string;
    note?: string;
  }>;
}

// Full "party portfolio" for the customer detail view — profile plus every
// order, every invoice, and every payment ever recorded against them, so the
// user can see the whole relationship in one place instead of hunting across
// the Orders and Sales tabs.
export async function getCustomerPortfolio(tenantId: string, customerId: string): Promise<CustomerPortfolio | null> {
  const customer = await Customer.findOne({ _id: customerId, tenantId }).lean();
  if (!customer) return null;

  const [orders, invoices] = await Promise.all([
    Order.find({ tenantId, customerId }).sort({ createdAt: -1 }).lean(),
    Invoice.find({ tenantId, customerId }).sort({ createdAt: -1 }).lean(),
  ]);

  const totalPurchases = invoices.reduce((sum, inv) => sum + inv.totalAmount, 0);
  const totalPaid = invoices.reduce((sum, inv) => sum + inv.amountPaid, 0);
  const pendingOrders = orders.filter((o) => o.status === "pending" || o.status === "confirmed").length;

  const payments = invoices
    .flatMap((inv) =>
      inv.payments.map((p) => ({
        invoiceId: String(inv._id),
        invoiceNumber: inv.invoiceNumber,
        amount: p.amount,
        method: p.method,
        paidAt: new Date(p.paidAt).toISOString(),
        note: p.note,
      }))
    )
    .sort((a, b) => new Date(b.paidAt).getTime() - new Date(a.paidAt).getTime());

  return {
    customer: {
      _id: String(customer._id),
      name: customer.name,
      phone: customer.phone,
      creditLimit: customer.creditLimit,
      isActive: customer.isActive,
      createdAt: customer.createdAt.toISOString(),
    },
    stats: {
      totalPurchases,
      totalPaid,
      outstanding: Math.max(0, totalPurchases - totalPaid),
      totalOrders: orders.length,
      pendingOrders,
      totalInvoices: invoices.length,
      lastPurchaseAt: invoices[0] ? new Date(invoices[0].createdAt).toISOString() : null,
    },
    orders: orders.map((o) => ({
      _id: String(o._id),
      itemCount: o.items.length,
      totalAmount: o.totalAmount,
      status: o.status,
      source: o.source,
      createdAt: o.createdAt.toISOString(),
    })),
    invoices: invoices.map((inv) => ({
      _id: String(inv._id),
      invoiceNumber: inv.invoiceNumber,
      billType: inv.billType,
      totalAmount: inv.totalAmount,
      amountPaid: inv.amountPaid,
      paymentStatus: inv.paymentStatus,
      createdAt: inv.createdAt.toISOString(),
    })),
    payments,
  };
}
