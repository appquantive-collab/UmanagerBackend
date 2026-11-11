import { z } from "zod";

export const onboardingSchema = z.object({
  category: z.enum([
    "fmcg",
    "electronics",
    "mobile_accessories",
    "pharma",
    "apparel",
    "footwear",
    "textiles_fabric",
    "auto_parts",
    "two_wheeler_parts",
    "grocery",
    "hardware",
    "sanitary_plumbing",
    "electrical_goods",
    "paints_chemicals",
    "building_materials",
    "furniture",
    "musical_instruments",
    "sports_goods",
    "toys_games",
    "stationery_books",
    "gift_items",
    "cosmetics_beauty",
    "jewellery_artificial",
    "bags_luggage",
    "kitchenware_utensils",
    "plastic_goods",
    "packaging_materials",
    "confectionery_bakery",
    "dry_fruits_spices",
    "tea_coffee",
    "dairy_products",
    "agro_seeds_fertilizers",
    "cattle_feed",
    "tiles_sanitaryware",
    "glass_hardware",
    "computer_it",
    "printing_stationery",
    "cleaning_supplies",
    "fireworks",
    "readymade_garments",
    "saree_ethnic_wear",
    "watches_eyewear",
    "religious_puja_items",
    "other",
  ]),
  customerType: z.enum(["wholesale", "retail", "both"]),
  orderVolume: z.enum(["lt_100", "100_500", "500_2000", "gt_2000"]),
  warehouseCount: z.number().int().min(0).max(1000),
  staffCount: z.number().int().min(0).max(10000),
  painPoints: z.string().trim().max(1000).optional(),
  goals: z
    .array(z.enum(["inventory_tracking", "credit_payments", "multi_warehouse", "staff_management", "ai_insights", "reporting"]))
    .min(1)
    .max(6),
});

const optionalText = (max: number) => z.string().trim().max(max).optional();

/** Business details printed on bills (Settings → Business / Tax / Invoice). */
export const businessProfileSchema = z.object({
  businessName: z.string().trim().min(1).max(120).optional(),
  phone: optionalText(20),
  gstin: z
    .string()
    .trim()
    .toUpperCase()
    .refine((v) => v === "" || /^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/.test(v), "GSTIN should look like 27ABCDE1234F1Z5")
    .optional(),
  address: optionalText(400),
  stateCode: z
    .string()
    .trim()
    .refine((v) => v === "" || /^\d{2}$/.test(v), "Pick a state")
    .optional(),
  upiId: z
    .string()
    .trim()
    .refine((v) => v === "" || /^[\w.\-]{2,}@[a-zA-Z]{2,}$/.test(v), "UPI ID should look like name@bank")
    .optional(),
  bankName: optionalText(80),
  bankAccount: optionalText(30),
  bankIfsc: z
    .string()
    .trim()
    .toUpperCase()
    .refine((v) => v === "" || /^[A-Z]{4}0[A-Z0-9]{6}$/.test(v), "IFSC should look like SBIN0001234")
    .optional(),
  invoiceTerms: optionalText(600),
});
