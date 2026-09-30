import { z } from "zod";

const STAFF_ROLES = ["MANAGER", "SALESMAN", "WAREHOUSE_STAFF"] as const;
const PAY_TYPES = ["salary", "daily_wage"] as const;

const dayScheduleSchema = z.object({
  dayOfWeek: z.number().int().min(0).max(6),
  isDayOff: z.boolean().default(false),
  startTime: z.string().regex(/^\d{2}:\d{2}$/).optional(),
  endTime: z.string().regex(/^\d{2}:\d{2}$/).optional(),
});

export const createStaffSchema = z.object({
  name: z.string().min(2),
  phone: z
    .string()
    .regex(/^\d{10}$/)
    .optional(),
  role: z.enum(STAFF_ROLES),
  departmentId: z.string().optional(),
  designationId: z.string().optional(),
  weeklySchedule: z.array(dayScheduleSchema).length(7).optional(),
  payType: z.enum(PAY_TYPES).default("salary"),
  monthlySalary: z.number().min(0).optional(),
  dailyWage: z.number().min(0).optional(),
});

export const updateStaffSchema = z.object({
  name: z.string().min(2).optional(),
  phone: z
    .string()
    .regex(/^\d{10}$/)
    .optional(),
  role: z.enum(STAFF_ROLES).optional(),
  departmentId: z.string().nullable().optional(),
  designationId: z.string().nullable().optional(),
  weeklySchedule: z.array(dayScheduleSchema).length(7).optional(),
  payType: z.enum(PAY_TYPES).optional(),
  monthlySalary: z.number().min(0).optional(),
  dailyWage: z.number().min(0).optional(),
  isActive: z.boolean().optional(),
});

export const createDepartmentSchema = z.object({
  name: z.string().min(1),
});

export const createDesignationSchema = z.object({
  title: z.string().min(1),
});
