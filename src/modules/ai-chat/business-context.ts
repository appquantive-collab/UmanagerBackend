import mongoose from "mongoose";
import { ACTIVE_INVOICE, Invoice } from "../../models/Invoice";
import { Order } from "../../models/Order";
import { Product } from "../../models/Product";
import { Purchase } from "../../models/Purchase";
import { Staff } from "../../models/Staff";
import { StockMovement } from "../../models/StockMovement";
import { Supplier } from "../../models/Supplier";
import { Expense } from "../../models/Expense";
import { SaleReturn } from "../../models/SaleReturn";
import { getDaybook, todayIst } from "../daybook/daybook.service";
import { getDashboardSummary } from "../dashboard/dashboard.service";
import { listAttendance } from "../attendance/attendance.service";
import { listCustomersWithStats } from "../customers/customers.service";
import { listWarehousesWithStats } from "../warehouses/warehouses.service";
import { supplierPurchaseStats } from "../purchases/purchases.service";

// Everything Munshi AI knows about the business, as compact JSON: the dashboard
// numbers plus products with live stock, customers and suppliers with balances,
// recent bills/purchases, pending orders, warehouses, staff, this month vs last
// month, a profit estimate and GST. Lists are capped so answers stay fast.

const IST_OFFSET_MS = 330 * 60 * 1000;

function istMonthStart(date: Date, monthsBack = 0): Date {
  const local = new Date(date.getTime() + IST_OFFSET_MS);
  return new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth() - monthsBack, 1) - IST_OFFSET_MS);
}

const istDate = (d: Date | string | null | undefined) =>
  d ? new Date(new Date(d).getTime() + IST_OFFSET_MS).toISOString().slice(0, 10) : null;

const round = (n: number) => Math.round(n * 100) / 100;

function nameOf(value: unknown): string {
  return value && typeof value === "object" && "name" in value ? String((value as { name: unknown }).name) : "Unknown";
}

export async function buildFullBusinessContext(tenantId: string): Promise<string> {
  const tid = new mongoose.Types.ObjectId(tenantId);
  const now = new Date();
  const today = istDate(now)!;
  const thisMonth = istMonthStart(now);
  const lastMonth = istMonthStart(now, 1);

  const [
    summary,
    attendance,
    customers,
    warehouses,
    supplierStats,
    suppliers,
    products,
    stockTotals,
    recentInvoices,
    recentPurchases,
    pendingOrders,
    staff,
    monthInvoices,
    lastMonthSalesAgg,
    monthPurchasesAgg,
    monthExpensesAgg,
    monthReturnsAgg,
    todayBook,
  ] = await Promise.all([
    getDashboardSummary(tenantId),
    listAttendance(tenantId, { date: today }),
    listCustomersWithStats(tenantId),
    listWarehousesWithStats(tenantId),
    supplierPurchaseStats(tenantId),
    Supplier.find({ tenantId }, { name: 1, phone: 1, gstin: 1 }).lean(),
    Product.find({ tenantId, isActive: true }).sort({ name: 1 }).limit(400).lean(),
    StockMovement.aggregate([{ $match: { tenantId: tid } }, { $group: { _id: "$productId", qty: { $sum: "$quantity" } } }]),
    Invoice.find({ tenantId, ...ACTIVE_INVOICE }).sort({ createdAt: -1 }).limit(12).populate("customerId", "name").lean(),
    Purchase.find({ tenantId }).sort({ purchasedAt: -1 }).limit(8).populate("supplierId", "name").lean(),
    Order.find({ tenantId, status: { $in: ["pending", "confirmed"] } }).sort({ createdAt: -1 }).limit(12).populate("customerId", "name").lean(),
    Staff.find({ tenantId }, { name: 1, role: 1, isActive: 1, payType: 1 }).limit(60).lean(),
    Invoice.find({ tenantId, ...ACTIVE_INVOICE, createdAt: { $gte: thisMonth } }, { items: 1, billType: 1, taxTotal: 1, subtotal: 1, totalAmount: 1 }).lean(),
    Invoice.aggregate([
      { $match: { tenantId: tid, ...ACTIVE_INVOICE, createdAt: { $gte: lastMonth, $lt: thisMonth } } },
      { $group: { _id: null, total: { $sum: "$totalAmount" }, count: { $sum: 1 } } },
    ]),
    Purchase.aggregate([
      { $match: { tenantId: tid, purchasedAt: { $gte: thisMonth } } },
      { $group: { _id: null, total: { $sum: "$totalAmount" }, tax: { $sum: "$taxTotal" }, count: { $sum: 1 } } },
    ]),
    Expense.aggregate([
      { $match: { tenantId: tid, spentAt: { $gte: thisMonth } } },
      { $group: { _id: "$category", total: { $sum: "$amount" } } },
      { $sort: { total: -1 } },
    ]),
    SaleReturn.aggregate([
      { $match: { tenantId: tid, createdAt: { $gte: thisMonth } } },
      { $group: { _id: null, total: { $sum: "$totalAmount" }, subtotal: { $sum: "$subtotal" }, tax: { $sum: "$taxTotal" }, count: { $sum: 1 } } },
    ]),
    getDaybook(tenantId, todayIst()).catch(() => null),
  ]);
  const monthExpenses = monthExpensesAgg.reduce((sum, e) => sum + (e.total as number), 0);
  const monthReturns = monthReturnsAgg[0] ?? { total: 0, subtotal: 0, tax: 0, count: 0 };

  const stockBy = new Map(stockTotals.map((s) => [String(s._id), s.qty as number]));
  const costBy = new Map(products.map((p) => [String(p._id), p.purchasePrice ?? 0]));

  // This month: profit estimate (sales before GST minus current cost of what was sold) and GST on sales.
  let monthRevenue = 0;
  let monthCost = 0;
  let monthOutputGst = 0;
  for (const invoice of monthInvoices) {
    if (invoice.billType === "gst") monthOutputGst += invoice.taxTotal ?? 0;
    for (const item of invoice.items) {
      monthRevenue += item.lineSubtotal ?? 0;
      monthCost += (costBy.get(String(item.productId)) ?? 0) * item.quantity;
    }
  }

  const productRows = products
    .map((p) => {
      const stock = stockBy.get(String(p._id)) ?? 0;
      return {
        name: p.name,
        sku: p.sku,
        unit: p.unit,
        category: p.category || undefined,
        rawMaterial: p.isRawMaterial || undefined,
        stock: round(stock),
        reorderAt: p.reorderLevel,
        status: stock <= 0 ? "out_of_stock" : stock <= (p.reorderLevel ?? 0) ? "low" : "ok",
        cost: p.purchasePrice,
        wholesale: p.wholesalePrice,
        retail: p.retailPrice,
        gst: p.gstPercent || undefined,
      };
    })
    // Keep problem items and the most valuable stock when there are many products.
    .sort((a, b) => (a.status === "ok" ? 1 : 0) - (b.status === "ok" ? 1 : 0) || b.stock * b.cost - a.stock * a.cost)
    .slice(0, 120);

  const customerRows = [...customers]
    .sort((a, b) => b.outstanding - a.outstanding || b.totalPurchases - a.totalPurchases)
    .slice(0, 40)
    .map((c) => ({
      name: c.name,
      phone: c.phone || undefined,
      totalBought: round(c.totalPurchases),
      owesUs: round(c.outstanding),
      creditLimit: c.creditLimit || undefined,
      lastPurchase: istDate(c.lastPurchaseAt),
    }));

  const supplierRows = suppliers
    .map((s) => {
      const stats = supplierStats.get(String(s._id));
      return {
        name: s.name,
        phone: s.phone || undefined,
        gstin: s.gstin || undefined,
        totalBought: round(stats?.totalPurchased ?? 0),
        weOwe: round(stats?.outstanding ?? 0),
        lastPurchase: istDate(stats?.lastPurchaseAt),
      };
    })
    .sort((a, b) => b.weOwe - a.weOwe || b.totalBought - a.totalBought)
    .slice(0, 25);

  return JSON.stringify({
    today,
    currency: "INR",
    sales: {
      today: summary.todaySales,
      billsToday: summary.todayOrderCount,
      yesterday: summary.yesterdaySales,
      changeVsYesterdayPercent: summary.salesChangePercent === null ? null : round(summary.salesChangePercent),
      last7Days: summary.salesTrend.map((d) => ({ date: d.date, sales: d.sales })),
      thisMonth: summary.monthSales,
      lastMonth: lastMonthSalesAgg[0]?.total ?? 0,
      lastMonthBills: lastMonthSalesAgg[0]?.count ?? 0,
      topProductsAllTime: summary.topProducts.slice(0, 8).map((p) => ({ name: p.name, revenue: p.revenue, qty: p.quantity })),
    },
    thisMonthProfitEstimate: {
      salesBeforeGst: round(monthRevenue),
      costOfGoodsSold: round(monthCost),
      grossProfit: round(monthRevenue - monthCost),
      returnsBeforeGst: round(monthReturns.subtotal),
      expenses: round(monthExpenses),
      netProfitEstimate: round(monthRevenue - monthReturns.subtotal - monthCost - monthExpenses),
      note: "Estimate using each product's current cost price. Net = sales − returns − cost of goods − recorded expenses (salaries only if recorded as expenses).",
    },
    expensesThisMonth: monthExpensesAgg.map((e) => ({ category: e._id, total: round(e.total) })),
    returnsThisMonth: { count: monthReturns.count, total: round(monthReturns.total) },
    cashBookToday: todayBook
      ? {
          moneyReceivedByMethod: todayBook.moneyIn.sales,
          paidOut: todayBook.moneyOut,
          cashExpectedInGalla: todayBook.cash.expected,
          dayClosed: todayBook.closing ? { countedCash: todayBook.closing.countedCash, difference: todayBook.closing.difference } : null,
        }
      : null,
    gstThisMonth: {
      outputGstOnSales: round(monthOutputGst),
      gstOnReturns: round(monthReturns.tax),
      inputGstOnPurchases: round(monthPurchasesAgg[0]?.tax ?? 0),
      estimatedNetPayable: round(monthOutputGst - monthReturns.tax - (monthPurchasesAgg[0]?.tax ?? 0)),
    },
    purchases: {
      today: summary.todayPurchases,
      thisMonth: monthPurchasesAgg[0]?.total ?? 0,
      thisMonthBills: monthPurchasesAgg[0]?.count ?? 0,
      recent: recentPurchases.map((p) => ({
        number: p.purchaseNumber,
        supplier: nameOf(p.supplierId),
        date: istDate(p.purchasedAt),
        total: p.totalAmount,
        unpaid: round(p.totalAmount - p.amountPaid),
        items: p.items.map((i) => `${i.productName} x${i.quantity}`).join(", "),
      })),
    },
    dues: {
      customersOweUsTotal: summary.receivables,
      customersWithDues: summary.overdueCustomerCount,
      weOweSuppliersTotal: summary.payables,
    },
    inventory: {
      valueAtCost: round(productRows.reduce((s, p) => s + Math.max(0, p.stock) * (p.cost ?? 0), 0)),
      productCount: products.length,
      lowOrOutCount: summary.lowStockCount,
      products: productRows,
    },
    warehouses: warehouses.map((w) => ({ name: w.name, main: w.isDefault || undefined, stockValue: round(w.stockValue), products: w.skuCount })),
    customers: { count: customers.length, list: customerRows },
    suppliers: { count: suppliers.length, list: supplierRows },
    recentBills: recentInvoices.map((i) => ({
      number: i.invoiceNumber,
      customer: nameOf(i.customerId),
      date: istDate(i.createdAt),
      total: i.totalAmount,
      paid: i.amountPaid,
      status: i.paymentStatus,
      type: i.billType,
    })),
    pendingOrders: {
      count: summary.pendingOrderCount ?? pendingOrders.length,
      list: pendingOrders.map((o) => ({
        customer: nameOf(o.customerId),
        date: istDate(o.createdAt),
        status: o.status,
        total: o.totalAmount,
        items: o.items.map((i) => `${i.productName} x${i.quantity}`).join(", "),
      })),
    },
    staff: {
      count: staff.filter((s) => s.isActive).length,
      list: staff.map((s) => ({ name: s.name, role: s.role, active: s.isActive, pay: s.payType })),
      todaysAttendance: attendance.map((a) => ({ staffName: nameOf(a.staffId), status: a.status })),
    },
  });
}
