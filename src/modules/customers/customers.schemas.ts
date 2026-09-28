import { z } from "zod";

export const createCustomerSchema = z.object({
  name: z.string().min(1),
  phone: z.string().optional(),
  creditLimit: z.number().min(0).default(0),
});

export const updateCustomerSchema = createCustomerSchema.partial();
