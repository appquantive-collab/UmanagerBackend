import mongoose from "mongoose";
import { ACTIVE_INVOICE, Invoice } from "../../models/Invoice";
import { Purchase } from "../../models/Purchase";
import { Expense } from "../../models/Expense";
import { SaleReturn } from "../../models/SaleReturn";
import { Payroll } from "../../models/Payroll";
import { CashClosing } from "../../models/CashClosing";

const round2 = (n: number) => Math.round(n * 100) / 100;
const DAY_MS = 24 * 60 * 60 * 1000;

/** "2026-11-11" → that whole day in India time. */
export function istDayRange(date: string) {
  const start = new Date(`${date}T00:00:00+05:30`);
  if (Number.isNaN(start.getTime())) throw new Error("Invalid date");
  return { start, end: new Date(start.getTime() + DAY_MS) };
}

export function todayIst(): string {
  return new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10);
}

type ByMethod = Record<string, number>;
const toMap = (rows: { _id: string | null; total: number }[]): ByMethod =>
  Object.fromEntries(rows.map((r) => [r._id ?? "other", round2(r.total)]));
const sum = (m: ByMethod) => round2(Object.values(m).reduce((s, v) => s + v, 0));

/**
 * The day's money, the way a shopkeeper closes the galla: what came in and went
 * out in cash (and by UPI/bank, for reference), and what the drawer should hold.
 */
export async function getDaybook(tenantId: string, date: string) {
  const tid = new mongoose.Types.ObjectId(tenantId);
  const { start, end } = istDayRange(date);

  const [salesAgg, received, supplierPaid, expensesByMethod, expensesByCategory, refunds, salaries, returnsAgg, previousClosing, closing] =
    await Promise.all([
      Invoice.aggregate([
        { $match: { tenantId: tid, ...ACTIVE_INVOICE, createdAt: { $gte: start, $lt: end } } },
        { $group: { _id: null, total: { $sum: "$totalAmount" }, count: { $sum: 1 } } },
      ]),
      Invoice.aggregate([
        { $match: { tenantId: tid, ...ACTIVE_INVOICE, "payments.paidAt": { $gte: start, $lt: end } } },
        { $unwind: "$payments" },
        { $match: { "payments.paidAt": { $gte: start, $lt: end }, "payments.method": { $ne: "credit_note" } } },
        { $group: { _id: "$payments.method", total: { $sum: "$payments.amount" } } },
      ]),
      Purchase.aggregate([
        { $match: { tenantId: tid, "payments.paidAt": { $gte: start, $lt: end } } },
        { $unwind: "$payments" },
        { $match: { "payments.paidAt": { $gte: start, $lt: end } } },
        { $group: { _id: "$payments.method", total: { $sum: "$payments.amount" } } },
      ]),
      Expense.aggregate([
        { $match: { tenantId: tid, spentAt: { $gte: start, $lt: end } } },
        { $group: { _id: "$method", total: { $sum: "$amount" } } },
      ]),
      Expense.aggregate([
        { $match: { tenantId: tid, spentAt: { $gte: start, $lt: end } } },
        { $group: { _id: "$category", total: { $sum: "$amount" } } },
        { $sort: { total: -1 } },
      ]),
      SaleReturn.aggregate([
        { $match: { tenantId: tid, createdAt: { $gte: start, $lt: end }, refundAmount: { $gt: 0 } } },
        { $group: { _id: "$refundMethod", total: { $sum: "$refundAmount" } } },
      ]),
      // Salaries marked paid that day (paid in cash unless recorded otherwise as an expense).
      Payroll.aggregate([
        { $match: { tenantId: tid, status: "paid", paidAt: { $gte: start, $lt: end } } },
        { $group: { _id: "cash", total: { $sum: "$netAmount" } } },
      ]),
      SaleReturn.aggregate([
        { $match: { tenantId: tid, createdAt: { $gte: start, $lt: end } } },
        { $group: { _id: null, total: { $sum: "$totalAmount" }, count: { $sum: 1 } } },
      ]),
      CashClosing.findOne({ tenantId: tid, date: { $lt: date } }).sort({ date: -1 }).lean(),
      CashClosing.findOne({ tenantId: tid, date }).lean(),
    ]);

  const moneyIn = { sales: toMap(received) };
  const moneyOut = {
    suppliers: toMap(supplierPaid),
    expenses: toMap(expensesByMethod),
    refunds: toMap(refunds),
    salaries: toMap(salaries),
  };
  const cashIn = moneyIn.sales.cash ?? 0;
  const cashOut = round2(
    (moneyOut.suppliers.cash ?? 0) + (moneyOut.expenses.cash ?? 0) + (moneyOut.refunds.cash ?? 0) + (moneyOut.salaries.cash ?? 0)
  );
  const openingCash = closing?.openingCash ?? previousClosing?.countedCash ?? 0;
  const expectedCash = round2(openingCash + cashIn - cashOut);

  return {
    date,
    sales: { total: round2(salesAgg[0]?.total ?? 0), count: salesAgg[0]?.count ?? 0 },
    returns: { total: round2(returnsAgg[0]?.total ?? 0), count: returnsAgg[0]?.count ?? 0 },
    moneyIn,
    moneyOut,
    totals: {
      received: sum(moneyIn.sales),
      paidOut: round2(sum(moneyOut.suppliers) + sum(moneyOut.expenses) + sum(moneyOut.refunds) + sum(moneyOut.salaries)),
    },
    expensesByCategory: expensesByCategory.map((e) => ({ category: e._id as string, total: round2(e.total) })),
    cash: {
      opening: round2(openingCash),
      openingFrom: closing ? "saved" : previousClosing ? previousClosing.date : null,
      in: round2(cashIn),
      out: cashOut,
      expected: expectedCash,
    },
    closing: closing
      ? {
          countedCash: closing.countedCash,
          difference: closing.difference,
          note: closing.note,
          closedAt: closing.updatedAt,
        }
      : null,
  };
}

export async function closeDay(
  tenantId: string,
  userId: string,
  input: { date: string; countedCash: number; openingCash?: number; note?: string }
) {
  const book = await getDaybook(tenantId, input.date);
  const opening = input.openingCash ?? book.cash.opening;
  const expected = round2(opening + book.cash.in - book.cash.out);
  const difference = round2(input.countedCash - expected);
  return CashClosing.findOneAndUpdate(
    { tenantId, date: input.date },
    {
      $set: {
        openingCash: round2(opening),
        expectedCash: expected,
        countedCash: round2(input.countedCash),
        difference,
        note: input.note?.trim() || undefined,
        closedBy: userId,
      },
    },
    { upsert: true, new: true }
  );
}
