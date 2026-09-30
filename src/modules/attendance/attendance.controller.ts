import { Router } from "express";
import { requireAuth, requireRole, requireTenant } from "../../middleware/auth";
import { bulkMarkAttendanceSchema, markAttendanceSchema } from "./attendance.schemas";
import {
  bulkMarkAttendance,
  getMonthlyAttendanceSummary,
  listAttendance,
  markAttendance,
} from "./attendance.service";

export const attendanceRouter = Router();

attendanceRouter.use(requireAuth, requireTenant);

attendanceRouter.get("/", async (req, res) => {
  const { staffId, date, from, to } = req.query;
  const records = await listAttendance(req.auth!.tenantId!, {
    staffId: typeof staffId === "string" ? staffId : undefined,
    date: typeof date === "string" ? date : undefined,
    from: typeof from === "string" ? from : undefined,
    to: typeof to === "string" ? to : undefined,
  });
  res.json(records);
});

attendanceRouter.get("/summary/:staffId/:month", async (req, res) => {
  const summary = await getMonthlyAttendanceSummary(req.auth!.tenantId!, req.params.staffId, req.params.month);
  res.json(summary);
});

attendanceRouter.post("/", requireRole("OWNER", "MANAGER"), async (req, res) => {
  const parsed = markAttendanceSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  try {
    const attendance = await markAttendance(req.auth!.tenantId!, req.auth!.userId, parsed.data);
    res.status(201).json(attendance);
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

// Marks attendance for every staff member on one date in a single request —
// powers the daily register view (list all staff, pick a status for each, save once).
attendanceRouter.post("/bulk", requireRole("OWNER", "MANAGER"), async (req, res) => {
  const parsed = bulkMarkAttendanceSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  try {
    const records = await bulkMarkAttendance(req.auth!.tenantId!, req.auth!.userId, parsed.data);
    res.status(201).json(records);
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});
