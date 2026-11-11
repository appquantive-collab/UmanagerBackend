import mongoose from "mongoose";
import { Order } from "../../models/Order";
import { ACTIVE_INVOICE, Invoice } from "../../models/Invoice";
import { Product } from "../../models/Product";
import { StockMovement } from "../../models/StockMovement";
import { Customer } from "../../models/Customer";
import { Purchase } from "../../models/Purchase";

// Business days are counted in Indian time (no daylight saving, fixed +05:30).
// The server runs in UTC, so plain setHours(0) would start "today" at 5:30 am IST.
const BUSINESS_TIMEZONE = "Asia/Kolkata";
const IST_OFFSET_MS = 330 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

function startOfDay(date: Date): Date {
  const local = new Date(date.getTime() + IST_OFFSET_MS);
  local.setUTCHours(0, 0, 0, 0);
  return new Date(local.getTime() - IST_OFFSET_MS);
}

function startOfMonth(date: Date): Date {
  const local = new Date(date.getTime() + IST_OFFSET_MS);
  return new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), 1) - IST_OFFSET_MS);
}

/** YYYY-MM-DD of the Indian calendar day that `instant` falls in. */
function istDateKey(instant: Date): string {
  return new Date(instant.getTime() + IST_OFFSET_MS).toISOString().slice(0, 10);
}

function populatedName(value: unknown, fallback: string): string {
  if (value && typeof value === "object" && "name" in value) {
    return String((value as { name: unknown }).name);
  }
  return fallback;
}

export async function getDashboardSummary(tenantId: string) {
  const tid = new mongoose.Types.ObjectId(tenantId);
  const now = new Date();
  const todayStart = startOfDay(now);
  const monthStart = startOfMonth(now);
  const yesterdayStart = new Date(todayStart.getTime() - DAY_MS);

  const [
    todaySalesAgg,
    yesterdaySalesAgg,
    monthSalesAgg,
    receivablesAgg,
    stockTotals,
    products,
    topProductsAgg,
    recentInvoices,
    recentOrders,
    lowStockCandidates,
    pendingOrderCount,
    todayPurchasesAgg,
    payablesAgg,
  ] = await Promise.all([
    Invoice.aggregate([
      { $match: { tenantId: tid, ...ACTIVE_INVOICE, createdAt: { $gte: todayStart } } },
      { $group: { _id: null, total: { $sum: "$totalAmount" }, count: { $sum: 1 } } },
    ]),
    Invoice.aggregate([
      { $match: { tenantId: tid, ...ACTIVE_INVOICE, createdAt: { $gte: yesterdayStart, $lt: todayStart } } },
      { $group: { _id: null, total: { $sum: "$totalAmount" } } },
    ]),
    Invoice.aggregate([
      { $match: { tenantId: tid, ...ACTIVE_INVOICE, createdAt: { $gte: monthStart } } },
      { $group: { _id: null, total: { $sum: "$totalAmount" } } },
    ]),
    Invoice.aggregate([
      { $match: { tenantId: tid, ...ACTIVE_INVOICE, paymentStatus: { $in: ["unpaid", "partial"] } } },
      {
        $group: {
          _id: null,
          total: { $sum: { $subtract: ["$totalAmount", "$amountPaid"] } },
          count: { $sum: 1 },
        },
      },
    ]),
    StockMovement.aggregate([
      { $match: { tenantId: tid } },
      { $group: { _id: "$productId", quantity: { $sum: "$quantity" } } },
    ]),
    Product.find({ tenantId }, { name: 1, wholesalePrice: 1, reorderLevel: 1 }).lean(),
    Invoice.aggregate([
      { $match: { tenantId: tid, ...ACTIVE_INVOICE } },
      { $unwind: "$items" },
      {
        $group: {
          _id: "$items.productId",
          productName: { $last: "$items.productName" },
          revenue: { $sum: "$items.lineSubtotal" },
          quantity: { $sum: "$items.quantity" },
        },
      },
      { $sort: { revenue: -1 } },
      { $limit: 5 },
    ]),
    Invoice.find({ tenantId, ...ACTIVE_INVOICE }).sort({ createdAt: -1 }).limit(5).populate("customerId", "name"),
    Order.find({ tenantId }).sort({ createdAt: -1 }).limit(6).populate("customerId", "name"),
    Product.find({ tenantId, isActive: true }, { name: 1, reorderLevel: 1 }).lean(),
    Order.countDocuments({ tenantId: tid, status: { $in: ["pending", "confirmed"] } }),
    Purchase.aggregate([
      { $match: { tenantId: tid, purchasedAt: { $gte: todayStart } } },
      { $group: { _id: null, total: { $sum: "$totalAmount" } } },
    ]),
    Purchase.aggregate([
      { $match: { tenantId: tid, paymentStatus: { $in: ["unpaid", "partial"] } } },
      { $group: { _id: null, total: { $sum: { $subtract: ["$totalAmount", "$amountPaid"] } } } },
    ]),
  ]);

  const stockByProduct = new Map(stockTotals.map((s) => [String(s._id), s.quantity]));

  const inventoryValue = products.reduce((sum, p) => {
    const qty = stockByProduct.get(String(p._id)) ?? 0;
    return sum + Math.max(0, qty) * (p.wholesalePrice ?? 0);
  }, 0);

  const totalSkus = products.length;

  const lowStockItems = lowStockCandidates
    .map((p) => ({
      productId: String(p._id),
      name: p.name,
      quantity: stockByProduct.get(String(p._id)) ?? 0,
      reorderLevel: p.reorderLevel ?? 0,
    }))
    .filter((p) => p.quantity <= p.reorderLevel)
    // Out of stock first, then whatever is furthest below its reorder level.
    .sort((a, b) => a.quantity - a.reorderLevel - (b.quantity - b.reorderLevel));

  const overdueCustomerCount = await Invoice.distinct("customerId", {
    tenantId: tid,
    ...ACTIVE_INVOICE,
    paymentStatus: { $in: ["unpaid", "partial"] },
  }).then((ids) => ids.length);

  const topDueAgg = await Invoice.aggregate([
    { $match: { tenantId: tid, ...ACTIVE_INVOICE, paymentStatus: { $in: ["unpaid", "partial"] } } },
    {
      $group: {
        _id: "$customerId",
        due: { $sum: { $subtract: ["$totalAmount", "$amountPaid"] } },
        invoiceCount: { $sum: 1 },
        oldestInvoiceAt: { $min: "$createdAt" },
      },
    },
    { $match: { due: { $gt: 0 } } },
    { $sort: { due: -1 } },
    { $limit: 3 },
  ]);
  const dueCustomers = await Customer.find({ _id: { $in: topDueAgg.map((d) => d._id) } }, { name: 1, phone: 1 }).lean();
  const customerById = new Map(dueCustomers.map((c) => [String(c._id), c]));
  const topDues = topDueAgg.map((d) => {
    const customer = customerById.get(String(d._id));
    return {
      customerId: String(d._id),
      name: customer?.name ?? "Customer",
      phone: customer?.phone ?? null,
      due: d.due as number,
      invoiceCount: d.invoiceCount as number,
      oldestInvoiceAt: d.oldestInvoiceAt as Date,
    };
  });
  const topOverdueCustomerName = topDues[0]?.name ?? null;

  const sevenDaysAgo = new Date(todayStart.getTime() - 6 * DAY_MS);
  const trendAgg = await Invoice.aggregate([
    { $match: { tenantId: tid, ...ACTIVE_INVOICE, createdAt: { $gte: sevenDaysAgo } } },
    {
      $group: {
        _id: { $dateToString: { format: "%Y-%m-%d", date: "$createdAt", timezone: BUSINESS_TIMEZONE } },
        total: { $sum: "$totalAmount" },
      },
    },
  ]);
  const trendByDate = new Map(trendAgg.map((t) => [t._id, t.total]));
  const salesTrend = Array.from({ length: 7 }, (_, i) => {
    const dayStart = new Date(sevenDaysAgo.getTime() + i * DAY_MS);
    const key = istDateKey(dayStart);
    return {
      date: key,
      day: dayStart.toLocaleDateString("en-US", { weekday: "short", timeZone: BUSINESS_TIMEZONE }),
      sales: trendByDate.get(key) ?? 0,
    };
  });
  const weekSales = salesTrend.reduce((sum, d) => sum + d.sales, 0);

  const todaySales = todaySalesAgg[0]?.total ?? 0;
  const yesterdaySales = yesterdaySalesAgg[0]?.total ?? 0;
  const salesChangePercent = yesterdaySales > 0 ? ((todaySales - yesterdaySales) / yesterdaySales) * 100 : null;

  return {
    todaySales,
    todayOrderCount: todaySalesAgg[0]?.count ?? 0,
    yesterdaySales,
    salesChangePercent,
    monthSales: monthSalesAgg[0]?.total ?? 0,
    receivables: receivablesAgg[0]?.total ?? 0,
    overdueInvoiceCount: receivablesAgg[0]?.count ?? 0,
    overdueCustomerCount,
    topOverdueCustomerName,
    topOverdueAmount: topDues[0]?.due ?? 0,
    topDues,
    pendingOrderCount,
    weekSales,
    inventoryValue,
    totalSkus,
    salesTrend,
    lowStockCount: lowStockItems.length,
    lowStockItems: lowStockItems.slice(0, 5).map((i) => i.name),
    lowStockDetails: lowStockItems.slice(0, 5),
    todayPurchases: todayPurchasesAgg[0]?.total ?? 0,
    payables: Math.max(0, payablesAgg[0]?.total ?? 0),
    topProducts: topProductsAgg.map((p) => ({
      productId: String(p._id),
      name: p.productName,
      revenue: p.revenue,
      quantity: p.quantity,
    })),
    recentActivity: recentInvoices.map((inv) => ({
      id: String(inv._id),
      type: "Sale" as const,
      description: `${populatedName(inv.customerId, "Customer")} — ${inv.invoiceNumber}`,
      amount: inv.totalAmount,
      time: inv.createdAt,
    })),
    recentOrders: recentOrders.map((o) => ({
      id: String(o._id),
      customerName: populatedName(o.customerId, "Customer"),
      itemCount: o.items.length,
      amount: o.totalAmount,
      status: o.status,
      createdAt: o.createdAt,
    })),
  };
}
