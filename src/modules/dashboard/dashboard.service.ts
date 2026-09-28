import mongoose from "mongoose";
import { Order } from "../../models/Order";
import { Invoice } from "../../models/Invoice";
import { Product } from "../../models/Product";
import { StockMovement } from "../../models/StockMovement";
import { Customer } from "../../models/Customer";

function startOfDay(date: Date): Date {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  return d;
}

function startOfMonth(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), 1);
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
  const yesterdayStart = new Date(todayStart.getTime() - 24 * 60 * 60 * 1000);

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
  ] = await Promise.all([
    Invoice.aggregate([
      { $match: { tenantId: tid, createdAt: { $gte: todayStart } } },
      { $group: { _id: null, total: { $sum: "$totalAmount" }, count: { $sum: 1 } } },
    ]),
    Invoice.aggregate([
      { $match: { tenantId: tid, createdAt: { $gte: yesterdayStart, $lt: todayStart } } },
      { $group: { _id: null, total: { $sum: "$totalAmount" } } },
    ]),
    Invoice.aggregate([
      { $match: { tenantId: tid, createdAt: { $gte: monthStart } } },
      { $group: { _id: null, total: { $sum: "$totalAmount" } } },
    ]),
    Invoice.aggregate([
      { $match: { tenantId: tid, paymentStatus: { $in: ["unpaid", "partial"] } } },
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
      { $match: { tenantId: tid } },
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
    Invoice.find({ tenantId }).sort({ createdAt: -1 }).limit(5).populate("customerId", "name"),
    Order.find({ tenantId }).sort({ createdAt: -1 }).limit(6).populate("customerId", "name"),
    Product.find({ tenantId, isActive: true }, { name: 1, reorderLevel: 1 }).lean(),
  ]);

  const stockByProduct = new Map(stockTotals.map((s) => [String(s._id), s.quantity]));

  const inventoryValue = products.reduce((sum, p) => {
    const qty = stockByProduct.get(String(p._id)) ?? 0;
    return sum + Math.max(0, qty) * (p.wholesalePrice ?? 0);
  }, 0);

  const totalSkus = products.length;

  const lowStockItems = lowStockCandidates
    .map((p) => ({ name: p.name, quantity: stockByProduct.get(String(p._id)) ?? 0, reorderLevel: p.reorderLevel ?? 0 }))
    .filter((p) => p.quantity <= p.reorderLevel);

  const overdueCustomerCount = await Invoice.distinct("customerId", {
    tenantId: tid,
    paymentStatus: { $in: ["unpaid", "partial"] },
  }).then((ids) => ids.length);

  const topOverdueCustomer = await Invoice.aggregate([
    { $match: { tenantId: tid, paymentStatus: { $in: ["unpaid", "partial"] } } },
    {
      $group: {
        _id: "$customerId",
        due: { $sum: { $subtract: ["$totalAmount", "$amountPaid"] } },
      },
    },
    { $sort: { due: -1 } },
    { $limit: 1 },
  ]);

  let topOverdueCustomerName: string | null = null;
  if (topOverdueCustomer.length > 0) {
    const customer = await Customer.findById(topOverdueCustomer[0]._id, { name: 1 }).lean();
    topOverdueCustomerName = customer?.name ?? null;
  }

  const sevenDaysAgo = new Date(todayStart.getTime() - 6 * 24 * 60 * 60 * 1000);
  const trendAgg = await Invoice.aggregate([
    { $match: { tenantId: tid, createdAt: { $gte: sevenDaysAgo } } },
    {
      $group: {
        _id: { $dateToString: { format: "%Y-%m-%d", date: "$createdAt" } },
        total: { $sum: "$totalAmount" },
      },
    },
  ]);
  const trendByDate = new Map(trendAgg.map((t) => [t._id, t.total]));
  const salesTrend = Array.from({ length: 7 }, (_, i) => {
    const d = new Date(sevenDaysAgo.getTime() + i * 24 * 60 * 60 * 1000);
    const key = d.toISOString().slice(0, 10);
    return { day: d.toLocaleDateString("en-US", { weekday: "short" }), sales: trendByDate.get(key) ?? 0 };
  });

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
    topOverdueAmount: topOverdueCustomer[0]?.due ?? 0,
    inventoryValue,
    totalSkus,
    salesTrend,
    lowStockCount: lowStockItems.length,
    lowStockItems: lowStockItems.slice(0, 5).map((i) => i.name),
    // Purchases/payables have no backing feature yet — reported honestly as zero
    // rather than fabricated, until a Purchases module exists.
    todayPurchases: 0,
    payables: 0,
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
