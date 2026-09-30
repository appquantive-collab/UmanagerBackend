import { Router } from "express";
import { requireAuth, requireRole, requireTenant } from "../../middleware/auth";
import {
  generatePayrollForAllSchema,
  generatePayrollSchema,
  recordPayrollPaymentSchema,
  updatePayrollSchema,
} from "./payroll.schemas";
import {
  generatePayroll,
  generatePayrollForAll,
  listPayroll,
  recordPayrollPayment,
  updatePayroll,
} from "./payroll.service";

export const payrollRouter = Router();

payrollRouter.use(requireAuth, requireTenant, requireRole("OWNER", "MANAGER"));

payrollRouter.get("/", async (req, res) => {
  const { staffId, month } = req.query;
  const records = await listPayroll(req.auth!.tenantId!, {
    staffId: typeof staffId === "string" ? staffId : undefined,
    month: typeof month === "string" ? month : undefined,
  });
  res.json(records);
});

payrollRouter.post("/", async (req, res) => {
  const parsed = generatePayrollSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  try {
    const payroll = await generatePayroll(req.auth!.tenantId!, req.auth!.userId, parsed.data);
    res.status(201).json(payroll);
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

payrollRouter.post("/generate-all", async (req, res) => {
  const parsed = generatePayrollForAllSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const result = await generatePayrollForAll(req.auth!.tenantId!, req.auth!.userId, parsed.data.month);
  res.status(201).json(result);
});

payrollRouter.patch("/:id", async (req, res) => {
  const parsed = updatePayrollSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  try {
    const payroll = await updatePayroll(req.auth!.tenantId!, req.params.id, parsed.data);
    res.json(payroll);
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

payrollRouter.post("/:id/pay", async (req, res) => {
  const parsed = recordPayrollPaymentSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  try {
    const payroll = await recordPayrollPayment(req.auth!.tenantId!, req.params.id, parsed.data.note);
    res.json(payroll);
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});
