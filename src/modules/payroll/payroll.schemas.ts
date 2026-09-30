import { z } from "zod";

const MONTH_RE = /^\d{4}-\d{2}$/;

export const generatePayrollSchema = z.object({
  staffId: z.string().min(1),
  month: z.string().regex(MONTH_RE, "month must be YYYY-MM"),
  deductions: z.number().min(0).default(0),
  note: z.string().max(500).optional(),
});

export const generatePayrollForAllSchema = z.object({
  month: z.string().regex(MONTH_RE, "month must be YYYY-MM"),
});

export const recordPayrollPaymentSchema = z.object({
  note: z.string().max(500).optional(),
});

export const updatePayrollSchema = z.object({
  deductions: z.number().min(0).optional(),
  note: z.string().max(500).optional(),
});
