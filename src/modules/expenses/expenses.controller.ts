import { Router } from "express";
import { z } from "zod";
import { requireAuth, requireTenant } from "../../middleware/auth";
import { EXPENSE_CATEGORIES, EXPENSE_METHODS, Expense } from "../../models/Expense";
import { recordAudit } from "../audit/audit.service";

export const expensesRouter = Router();
expensesRouter.use(requireAuth, requireTenant);

const createExpenseSchema = z.object({
  category: z.enum(EXPENSE_CATEGORIES),
  amount: z.number().positive().max(1e9),
  method: z.enum(EXPENSE_METHODS).default("cash"),
  note: z.string().trim().max(300).optional(),
  spentAt: z.string().datetime({ offset: true }).optional(),
});

// ?from=&to= (ISO) — newest first.
expensesRouter.get("/", async (req, res) => {
  const filter: Record<string, unknown> = { tenantId: req.auth!.tenantId };
  const range: Record<string, Date> = {};
  if (typeof req.query.from === "string" && !Number.isNaN(Date.parse(req.query.from))) range.$gte = new Date(req.query.from);
  if (typeof req.query.to === "string" && !Number.isNaN(Date.parse(req.query.to))) range.$lt = new Date(req.query.to);
  if (Object.keys(range).length) filter.spentAt = range;
  const expenses = await Expense.find(filter).sort({ spentAt: -1 }).limit(1000).lean();
  res.json(expenses);
});

expensesRouter.post("/", async (req, res) => {
  const parsed = createExpenseSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const expense = await Expense.create({
    ...parsed.data,
    spentAt: parsed.data.spentAt ? new Date(parsed.data.spentAt) : new Date(),
    tenantId: req.auth!.tenantId,
    createdBy: req.auth!.userId,
  });
  void recordAudit(req, "expense.create", `Expense ₹${expense.amount} · ${expense.category}${expense.note ? ` · ${expense.note}` : ""}`, String(expense._id), expense.amount);
  res.status(201).json(expense);
});

expensesRouter.delete("/:id", async (req, res) => {
  const expense = await Expense.findOneAndDelete({ _id: req.params.id, tenantId: req.auth!.tenantId });
  if (!expense) return res.status(404).json({ error: "Expense not found" });
  void recordAudit(req, "expense.delete", `Deleted expense ₹${expense.amount} · ${expense.category}`, String(expense._id), expense.amount);
  res.status(204).send();
});
