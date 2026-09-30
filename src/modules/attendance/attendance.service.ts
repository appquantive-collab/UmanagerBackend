import { Attendance, type AttendanceStatus } from "../../models/Attendance";
import { Staff } from "../../models/Staff";

export interface MarkAttendanceInput {
  staffId: string;
  date: string;
  status: AttendanceStatus;
  note?: string;
}

// Marking again for a staff member/date upserts rather than erroring — the
// owner correcting an earlier mistake for the same day is the common case,
// not an error condition.
export async function markAttendance(tenantId: string, markedBy: string, input: MarkAttendanceInput) {
  const staff = await Staff.findOne({ _id: input.staffId, tenantId });
  if (!staff) {
    throw new Error("Staff member not found");
  }

  const attendance = await Attendance.findOneAndUpdate(
    { tenantId, staffId: input.staffId, date: input.date },
    { status: input.status, note: input.note, markedBy },
    { new: true, upsert: true }
  );

  return attendance;
}

export interface BulkMarkAttendanceInput {
  date: string;
  entries: { staffId: string; status: AttendanceStatus; note?: string }[];
}

export async function bulkMarkAttendance(tenantId: string, markedBy: string, input: BulkMarkAttendanceInput) {
  const staffIds = input.entries.map((e) => e.staffId);
  const validStaff = await Staff.find({ _id: { $in: staffIds }, tenantId }, { _id: 1 });
  const validIds = new Set(validStaff.map((s) => String(s._id)));

  const results = [];
  for (const entry of input.entries) {
    if (!validIds.has(entry.staffId)) continue;
    const attendance = await Attendance.findOneAndUpdate(
      { tenantId, staffId: entry.staffId, date: input.date },
      { status: entry.status, note: entry.note, markedBy },
      { new: true, upsert: true }
    );
    results.push(attendance);
  }
  return results;
}

export interface AttendanceQuery {
  staffId?: string;
  date?: string;
  from?: string;
  to?: string;
}

export async function listAttendance(tenantId: string, query: AttendanceQuery) {
  const filter: Record<string, unknown> = { tenantId };
  if (query.staffId) filter.staffId = query.staffId;
  if (query.date) {
    filter.date = query.date;
  } else if (query.from || query.to) {
    const range: Record<string, string> = {};
    if (query.from) range.$gte = query.from;
    if (query.to) range.$lte = query.to;
    filter.date = range;
  }

  return Attendance.find(filter).sort({ date: -1 }).populate("staffId", "name role");
}

// Aggregated per-staff-member day counts for a month — the raw material for
// payroll generation (daily-wage pay = presentDays × rate) and for the
// attendance summary shown on the Staff detail view.
export async function getMonthlyAttendanceSummary(tenantId: string, staffId: string, month: string) {
  const records = await Attendance.find({
    tenantId,
    staffId,
    date: { $gte: `${month}-01`, $lte: `${month}-31` },
  });

  let presentDays = 0;
  let halfDays = 0;
  let absentDays = 0;
  let leaveDays = 0;

  for (const record of records) {
    if (record.status === "present") presentDays += 1;
    else if (record.status === "half_day") halfDays += 1;
    else if (record.status === "absent") absentDays += 1;
    else if (record.status === "leave") leaveDays += 1;
  }

  return { presentDays, halfDays, absentDays, leaveDays, totalMarked: records.length };
}
