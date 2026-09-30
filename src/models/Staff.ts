import { Schema, model, Types } from "mongoose";

// Staff are HR-style records only — they never log in to the platform, so
// unlike User there is no email/password here at all.
export type StaffRole = "MANAGER" | "SALESMAN" | "WAREHOUSE_STAFF";
export type PayType = "salary" | "daily_wage";

// One entry per day of the week (0=Sunday .. 6=Saturday). A per-day schedule
// rather than a shared shift template, since different staff can have
// completely different days off and hours.
export interface DaySchedule {
  dayOfWeek: number;
  isDayOff: boolean;
  startTime?: string; // "HH:mm", only meaningful when isDayOff is false
  endTime?: string;
}

export interface StaffDocument {
  _id: Types.ObjectId;
  tenantId: Types.ObjectId;
  name: string;
  phone?: string;
  role: StaffRole;
  departmentId: Types.ObjectId | null;
  designationId: Types.ObjectId | null;
  weeklySchedule: DaySchedule[];
  payType: PayType;
  monthlySalary?: number;
  dailyWage?: number;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const dayScheduleSchema = new Schema<DaySchedule>(
  {
    dayOfWeek: { type: Number, required: true, min: 0, max: 6 },
    isDayOff: { type: Boolean, default: false },
    startTime: { type: String, trim: true },
    endTime: { type: String, trim: true },
  },
  { _id: false }
);

function defaultWeeklySchedule(): DaySchedule[] {
  // Mon–Sat 09:00–18:00, Sunday off — a sensible starting point the owner can edit per staff member.
  return Array.from({ length: 7 }, (_, dayOfWeek) => ({
    dayOfWeek,
    isDayOff: dayOfWeek === 0,
    startTime: dayOfWeek === 0 ? undefined : "09:00",
    endTime: dayOfWeek === 0 ? undefined : "18:00",
  }));
}

const staffSchema = new Schema<StaffDocument>(
  {
    tenantId: { type: Schema.Types.ObjectId, ref: "Tenant", required: true, index: true },
    name: { type: String, required: true, trim: true },
    phone: { type: String, trim: true },
    role: { type: String, enum: ["MANAGER", "SALESMAN", "WAREHOUSE_STAFF"], required: true },
    departmentId: { type: Schema.Types.ObjectId, ref: "Department", default: null },
    designationId: { type: Schema.Types.ObjectId, ref: "Designation", default: null },
    weeklySchedule: { type: [dayScheduleSchema], default: defaultWeeklySchedule },
    payType: { type: String, enum: ["salary", "daily_wage"], default: "salary" },
    monthlySalary: { type: Number, min: 0 },
    dailyWage: { type: Number, min: 0 },
    isActive: { type: Boolean, default: true },
  },
  { timestamps: true }
);

staffSchema.index({ tenantId: 1, name: 1 });

export const Staff = model<StaffDocument>("Staff", staffSchema);
