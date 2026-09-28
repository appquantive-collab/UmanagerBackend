import { Router } from "express";
import { Customer } from "../../models/Customer";
import { requireAuth, requireTenant } from "../../middleware/auth";
import { createCustomerSchema, updateCustomerSchema } from "./customers.schemas";

export const customersRouter = Router();

customersRouter.use(requireAuth, requireTenant);

// All queries below are scoped by req.auth.tenantId, which comes only from
// the verified JWT — never from the client — per the tenant isolation rule in CLAUDE.md.

customersRouter.get("/", async (req, res) => {
  const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
  const filter: Record<string, unknown> = { tenantId: req.auth!.tenantId };
  if (q) filter.name = { $regex: q, $options: "i" };

  const customers = await Customer.find(filter).sort({ createdAt: -1 });
  res.json(customers);
});

customersRouter.get("/:id", async (req, res) => {
  const customer = await Customer.findOne({ _id: req.params.id, tenantId: req.auth!.tenantId });
  if (!customer) return res.status(404).json({ error: "Customer not found" });
  res.json(customer);
});

customersRouter.post("/", async (req, res) => {
  const parsed = createCustomerSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const customer = await Customer.create({ ...parsed.data, tenantId: req.auth!.tenantId });
  res.status(201).json(customer);
});

customersRouter.patch("/:id", async (req, res) => {
  const parsed = updateCustomerSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const customer = await Customer.findOneAndUpdate(
    { _id: req.params.id, tenantId: req.auth!.tenantId },
    parsed.data,
    { new: true }
  );
  if (!customer) return res.status(404).json({ error: "Customer not found" });
  res.json(customer);
});

customersRouter.delete("/:id", async (req, res) => {
  const customer = await Customer.findOneAndDelete({ _id: req.params.id, tenantId: req.auth!.tenantId });
  if (!customer) return res.status(404).json({ error: "Customer not found" });
  res.status(204).send();
});
