import { z } from "zod";

const STAFF_ROLES = ["MANAGER", "SALESMAN", "WAREHOUSE_STAFF"] as const;

export const createStaffSchema = z.object({
  name: z.string().min(2),
  phone: z
    .string()
    .regex(/^\d{10}$/)
    .optional(),
  role: z.enum(STAFF_ROLES),
  departmentId: z.string().optional(),
  designationId: z.string().optional(),
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
  isActive: z.boolean().optional(),
});

export const createDepartmentSchema = z.object({
  name: z.string().min(1),
});

export const createDesignationSchema = z.object({
  title: z.string().min(1),
});
