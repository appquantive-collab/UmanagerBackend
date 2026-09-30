import { Schema, model, Types } from "mongoose";

export type AttendanceStatus = "present" | "absent" | "half_day" | "leave";

export interface AttendanceDocument {
  _id: Types.ObjectId;
  tenantId: Types.ObjectId;
  staffId: Types.ObjectId;
  date: string; // "YYYY-MM-DD" — a calendar day, not a timestamp, so timezone never shifts which day this is
  status: AttendanceStatus;
  note?: string;
  markedBy: Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

const attendanceSchema = new Schema<AttendanceDocument>(
  {
    tenantId: { type: Schema.Types.ObjectId, ref: "Tenant", required: true, index: true },
    staffId: { type: Schema.Types.ObjectId, ref: "Staff", required: true, index: true },
    date: { type: String, required: true },
    status: { type: String, enum: ["present", "absent", "half_day", "leave"], required: true },
    note: { type: String, trim: true },
    markedBy: { type: Schema.Types.ObjectId, ref: "User", required: true },
  },
  { timestamps: true }
);

// One attendance record per staff member per day — marking again for the
// same day updates the existing record rather than creating a duplicate.
attendanceSchema.index({ tenantId: 1, staffId: 1, date: 1 }, { unique: true });
attendanceSchema.index({ tenantId: 1, date: 1 });

export const Attendance = model<AttendanceDocument>("Attendance", attendanceSchema);
