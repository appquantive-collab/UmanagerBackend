import { Staff, type DaySchedule, type PayType, type StaffRole } from "../../models/Staff";

export interface CreateStaffInput {
  name: string;
  phone?: string;
  role: StaffRole;
  departmentId?: string;
  designationId?: string;
  weeklySchedule?: DaySchedule[];
  payType: PayType;
  monthlySalary?: number;
  dailyWage?: number;
}

export async function createStaff(tenantId: string, input: CreateStaffInput) {
  const staff = await Staff.create({
    tenantId,
    name: input.name,
    ...(input.phone ? { phone: input.phone } : {}),
    role: input.role,
    departmentId: input.departmentId || null,
    designationId: input.designationId || null,
    ...(input.weeklySchedule ? { weeklySchedule: input.weeklySchedule } : {}),
    payType: input.payType,
    monthlySalary: input.monthlySalary,
    dailyWage: input.dailyWage,
  });

  return staff;
}

export interface UpdateStaffInput {
  name?: string;
  phone?: string;
  role?: StaffRole;
  departmentId?: string | null;
  designationId?: string | null;
  weeklySchedule?: DaySchedule[];
  payType?: PayType;
  monthlySalary?: number;
  dailyWage?: number;
  isActive?: boolean;
}

export async function updateStaff(tenantId: string, staffId: string, input: UpdateStaffInput) {
  const staff = await Staff.findOne({ _id: staffId, tenantId });
  if (!staff) {
    throw new Error("Staff member not found");
  }

  if (input.name !== undefined) staff.name = input.name;
  if (input.phone !== undefined) staff.phone = input.phone;
  if (input.role !== undefined) staff.role = input.role;
  if (input.departmentId !== undefined) staff.departmentId = input.departmentId as never;
  if (input.designationId !== undefined) staff.designationId = input.designationId as never;
  if (input.weeklySchedule !== undefined) staff.weeklySchedule = input.weeklySchedule;
  if (input.payType !== undefined) staff.payType = input.payType;
  if (input.monthlySalary !== undefined) staff.monthlySalary = input.monthlySalary;
  if (input.dailyWage !== undefined) staff.dailyWage = input.dailyWage;
  if (input.isActive !== undefined) staff.isActive = input.isActive;

  await staff.save();
  return staff;
}
