import { z } from "zod";

export const createCustomerSchema = z.object({
  name: z.string().min(1),
  phone: z.string().optional(),
  creditLimit: z.number().min(0).default(0),
  gstin: z
    .string()
    .trim()
    .toUpperCase()
    .refine((v) => v === "" || /^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/.test(v), "GSTIN should look like 27ABCDE1234F1Z5")
    .optional(),
  kind: z.enum(["person", "business"]).optional(),
  email: z.string().trim().toLowerCase().refine((v) => v === "" || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v), "Enter a valid email").optional(),
  /** 12 digits (spaces allowed); "" removes it. */
  aadhaar: z
    .string()
    .transform((v) => v.replace(/\s+/g, ""))
    .refine((v) => v === "" || /^[2-9]\d{11}$/.test(v), "Aadhaar should be 12 digits")
    .optional(),
  address: z.string().trim().max(400).optional(),
  stateCode: z
    .string()
    .trim()
    .refine((v) => v === "" || /^\d{2}$/.test(v), "Pick a state")
    .optional(),
});

export const updateCustomerSchema = createCustomerSchema.partial();
