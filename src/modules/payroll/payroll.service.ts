import { Payroll } from "../../models/Payroll";
import { Staff } from "../../models/Staff";
import { getMonthlyAttendanceSummary } from "../attendance/attendance.service";

export interface GeneratePayrollInput {
  staffId: string;
  month: string;
  deductions?: number;
  note?: string;
}

// Salary staff: fixed monthly amount, attendance only informs the record for
// visibility (not the pay itself) — matches how a salaried role normally works.
// Daily-wage staff: gross = dailyWage × (presentDays + halfDays × 0.5); an
// unmarked day is treated as unpaid, same as absent, since no one confirmed
// they showed up.
export async function generatePayroll(tenantId: string, userId: string, input: GeneratePayrollInput) {
  const staff = await Staff.findOne({ _id: input.staffId, tenantId });
  if (!staff) {
    throw new Error("Staff member not found");
  }

  const existing = await Payroll.findOne({ tenantId, staffId: input.staffId, month: input.month });
  if (existing) {
    throw new Error(`Payroll for ${input.month} already exists for this staff member`);
  }

  const summary = await getMonthlyAttendanceSummary(tenantId, input.staffId, input.month);

  let grossAmount: number;
  if (staff.payType === "salary") {
    if (!staff.monthlySalary) {
      throw new Error("This staff member has no monthly salary configured");
    }
    grossAmount = staff.monthlySalary;
  } else {
    if (!staff.dailyWage) {
      throw new Error("This staff member has no daily wage configured");
    }
    grossAmount = staff.dailyWage * (summary.presentDays + summary.halfDays * 0.5);
  }

  const deductions = input.deductions ?? 0;
  const netAmount = Math.max(0, grossAmount - deductions);

  const payroll = await Payroll.create({
    tenantId,
    staffId: input.staffId,
    month: input.month,
    payType: staff.payType,
    presentDays: summary.presentDays,
    halfDays: summary.halfDays,
    absentDays: summary.absentDays,
    leaveDays: summary.leaveDays,
    grossAmount,
    deductions,
    netAmount,
    status: "unpaid",
    note: input.note,
    createdBy: userId,
  });

  return payroll;
}

// Generates payroll for every active staff member for a month in one go —
// skips anyone who already has a record for that month or is missing their
// pay rate, and reports both so the caller can show what happened.
export async function generatePayrollForAll(tenantId: string, userId: string, month: string) {
  const allStaff = await Staff.find({ tenantId, isActive: true });
  const created = [];
  const skipped: { staffId: string; name: string; reason: string }[] = [];

  for (const staff of allStaff) {
    try {
      const payroll = await generatePayroll(tenantId, userId, { staffId: String(staff._id), month });
      created.push(payroll);
    } catch (err) {
      skipped.push({ staffId: String(staff._id), name: staff.name, reason: (err as Error).message });
    }
  }

  return { created, skipped };
}

export async function recordPayrollPayment(tenantId: string, payrollId: string, note?: string) {
  const payroll = await Payroll.findOne({ _id: payrollId, tenantId });
  if (!payroll) {
    throw new Error("Payroll record not found");
  }
  if (payroll.status === "paid") {
    throw new Error("This payroll has already been marked as paid");
  }

  payroll.status = "paid";
  payroll.paidAt = new Date();
  if (note) payroll.note = note;

  await payroll.save();
  return payroll;
}

export interface UpdatePayrollInput {
  deductions?: number;
  note?: string;
}

export async function updatePayroll(tenantId: string, payrollId: string, input: UpdatePayrollInput) {
  const payroll = await Payroll.findOne({ _id: payrollId, tenantId });
  if (!payroll) {
    throw new Error("Payroll record not found");
  }
  if (payroll.status === "paid") {
    throw new Error("Cannot edit a payroll record that has already been paid");
  }

  if (input.deductions !== undefined) {
    payroll.deductions = input.deductions;
    payroll.netAmount = Math.max(0, payroll.grossAmount - input.deductions);
  }
  if (input.note !== undefined) payroll.note = input.note;

  await payroll.save();
  return payroll;
}

export interface PayrollQuery {
  staffId?: string;
  month?: string;
}

export async function listPayroll(tenantId: string, query: PayrollQuery) {
  const filter: Record<string, unknown> = { tenantId };
  if (query.staffId) filter.staffId = query.staffId;
  if (query.month) filter.month = query.month;

  return Payroll.find(filter).sort({ month: -1 }).populate("staffId", "name role payType");
}
