import { Schema, model, Types } from "mongoose";

export type TenantStatus = "trial" | "active" | "suspended";

export type BusinessCategory =
  | "fmcg"
  | "electronics"
  | "pharma"
  | "apparel"
  | "auto_parts"
  | "grocery"
  | "hardware"
  | "other";

export type CustomerType = "wholesale" | "retail" | "both";

export type OrderVolume = "lt_100" | "100_500" | "500_2000" | "gt_2000";

export type BusinessGoal =
  | "inventory_tracking"
  | "credit_payments"
  | "multi_warehouse"
  | "staff_management"
  | "ai_insights"
  | "reporting";

export interface BusinessOnboarding {
  completed: boolean;
  category: BusinessCategory | null;
  customerType: CustomerType | null;
  orderVolume: OrderVolume | null;
  warehouseCount: number | null;
  staffCount: number | null;
  painPoints: string | null;
  goals: BusinessGoal[];
  completedAt: Date | null;
}

export interface DashboardLayoutSection {
  key: string;
  label: string;
  priority: number;
}

export interface AiDashboardLayout {
  generatedAt: Date;
  welcomeMessage: string;
  sections: DashboardLayoutSection[];
  quickActionLabels: Record<string, string>;
}

export interface TenantDocument {
  _id: Types.ObjectId;
  businessName: string;
  businessType: string;
  ownerEmail: string;
  phone?: string;
  country?: string;
  currency: string;
  timezone: string;
  plan: "starter" | "business" | "enterprise";
  status: TenantStatus;
  onboarding: BusinessOnboarding;
  aiDashboardLayout: AiDashboardLayout | null;
  createdAt: Date;
  updatedAt: Date;
}

const onboardingSchema = new Schema<BusinessOnboarding>(
  {
    completed: { type: Boolean, default: false },
    category: {
      type: String,
      enum: ["fmcg", "electronics", "pharma", "apparel", "auto_parts", "grocery", "hardware", "other"],
      default: null,
    },
    customerType: { type: String, enum: ["wholesale", "retail", "both"], default: null },
    orderVolume: { type: String, enum: ["lt_100", "100_500", "500_2000", "gt_2000"], default: null },
    warehouseCount: { type: Number, default: null },
    staffCount: { type: Number, default: null },
    painPoints: { type: String, trim: true, default: null },
    goals: {
      type: [String],
      enum: ["inventory_tracking", "credit_payments", "multi_warehouse", "staff_management", "ai_insights", "reporting"],
      default: [],
    },
    completedAt: { type: Date, default: null },
  },
  { _id: false }
);

const aiDashboardLayoutSchema = new Schema<AiDashboardLayout>(
  {
    generatedAt: { type: Date, required: true },
    welcomeMessage: { type: String, required: true },
    sections: [
      {
        _id: false,
        key: { type: String, required: true },
        label: { type: String, required: true },
        priority: { type: Number, required: true },
      },
    ],
    quickActionLabels: { type: Schema.Types.Mixed, default: {} },
  },
  { _id: false }
);

const tenantSchema = new Schema<TenantDocument>(
  {
    businessName: { type: String, required: true, trim: true },
    businessType: { type: String, required: true, trim: true },
    ownerEmail: { type: String, required: true, lowercase: true, trim: true },
    phone: { type: String, trim: true },
    country: { type: String, trim: true },
    currency: { type: String, default: "INR" },
    timezone: { type: String, default: "Asia/Kolkata" },
    plan: { type: String, enum: ["starter", "business", "enterprise"], default: "starter" },
    status: { type: String, enum: ["trial", "active", "suspended"], default: "trial" },
    onboarding: { type: onboardingSchema, default: () => ({}) },
    aiDashboardLayout: { type: aiDashboardLayoutSchema, default: null },
  },
  { timestamps: true }
);

export const Tenant = model<TenantDocument>("Tenant", tenantSchema);
