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

export const otpRequestSchema = z.object({
  phone: z.string().regex(/^\d{10}$/, "Enter a valid 10-digit mobile number"),
});

export const otpVerifySchema = z.object({
  phone: z.string().regex(/^\d{10}$/, "Enter a valid 10-digit mobile number"),
  code: z.string().regex(/^\d{6}$/, "Enter the 6-digit code"),
});

export const refreshSchema = z.object({
  refreshToken: z.string().min(1),
});

export const updateProfileSchema = z.object({
  preferredLanguage: z.enum(["en", "hi", "hi-Latn"]).optional(),
});

export const googleSignInSchema = z.object({
  credential: z.string().min(20),
});

export const appleSignInSchema = z.object({
  idToken: z.string().min(20),
  // Apple gives the name to the browser on the first sign-in only.
  name: z.string().trim().max(100).optional(),
});

export const socialCompleteSchema = z.object({
  signupToken: z.string().min(20),
  businessName: z.string().trim().min(2),
  phone: z.string().regex(/^\d{10}$/),
  preferredLanguage: z.enum(["en", "hi", "hi-Latn"]).optional(),
});
