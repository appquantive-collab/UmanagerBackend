import { z } from "zod";

const blankToUndefined = (v: unknown) => (typeof v === "string" && v.trim() === "" ? undefined : v);

export const registerSchema = z
  .object({
    businessName: z.string().min(2),
    businessType: z.string().min(2),
    ownerName: z.string().min(2),
    // Optional: many shopkeepers have no email. They then sign in with their mobile number.
    email: z.preprocess(blankToUndefined, z.string().trim().email().optional()),
    password: z.string().min(8),
    phone: z
      .string()
      .regex(/^\d{10}$/)
      .optional(),
    preferredLanguage: z.enum(["en", "hi", "hi-Latn"]).optional(),
  })
  .refine((v) => v.email || v.phone, { message: "Give an email or a mobile number", path: ["email"] });

export const loginSchema = z.object({
  /** Email, or the 10-digit mobile number the account was made with. */
  email: z
    .string()
    .trim()
    .refine((v) => /^\d{10}$/.test(v) || z.string().email().safeParse(v).success),
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

/** The signed-in person's own details. Blank email / mobile clears it (one of the two must stay). */
export const updateProfileSchema = z
  .object({
    preferredLanguage: z.enum(["en", "hi", "hi-Latn"]).optional(),
    name: z.string().trim().min(2).max(80).optional(),
    email: z.union([z.literal(""), z.string().trim().toLowerCase().email()]).optional(),
    phone: z.union([z.literal(""), z.string().trim().regex(/^\d{10}$/, "Enter a valid 10-digit mobile number")]).optional(),
    currentPassword: z.string().optional(),
    newPassword: z.string().min(8).optional(),
  })
  .strict();

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
