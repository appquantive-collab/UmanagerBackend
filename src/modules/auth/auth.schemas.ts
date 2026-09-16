import { z } from "zod";

export const registerSchema = z.object({
  businessName: z.string().min(2),
  businessType: z.string().min(2),
  ownerName: z.string().min(2),
  email: z.string().email(),
  password: z.string().min(8),
});

export const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
});

export const refreshSchema = z.object({
  refreshToken: z.string().min(1),
});
