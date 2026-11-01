import { z } from "zod";

export const registerSchema = z.object({
  businessName: z.string().min(2),
  businessType: z.string().min(2),
  ownerName: z.string().min(2),
  email: z.string().email(),
  password: z.string().min(8),
  phone: z
    .string()
    .regex(/^\d{10}$/)
    .optional(),
  preferredLanguage: z.enum(["en", "hi", "hi-Latn"]).optional(),
});

export const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
});

export const loginPhoneSchema = z.object({
  phone: z.string().regex(/^\d{10}$/, "Enter a valid 10-digit mobile number"),
  password: z.string().min(8),
});

export const refreshSchema = z.object({
  refreshToken: z.string().min(1),
});

export const updateProfileSchema = z.object({
  preferredLanguage: z.enum(["en", "hi", "hi-Latn"]).optional(),
});
