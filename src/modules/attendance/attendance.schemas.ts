import { z } from "zod";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export const markAttendanceSchema = z.object({
  staffId: z.string().min(1),
  date: z.string().regex(DATE_RE, "date must be YYYY-MM-DD"),
  status: z.enum(["present", "absent", "half_day", "leave"]),
  note: z.string().max(500).optional(),
});

export const bulkMarkAttendanceSchema = z.object({
  date: z.string().regex(DATE_RE, "date must be YYYY-MM-DD"),
  entries: z
    .array(
      z.object({
        staffId: z.string().min(1),
        status: z.enum(["present", "absent", "half_day", "leave"]),
        note: z.string().max(500).optional(),
      })
    )
    .min(1),
});

export const attendanceRangeQuerySchema = z.object({
  staffId: z.string().optional(),
  from: z.string().regex(DATE_RE).optional(),
  to: z.string().regex(DATE_RE).optional(),
  date: z.string().regex(DATE_RE).optional(),
});
