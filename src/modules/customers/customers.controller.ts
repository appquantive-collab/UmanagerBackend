import { Router } from "express";
import { Customer } from "../../models/Customer";
import { requireAuth, requireTenant } from "../../middleware/auth";
import { createCustomerSchema, updateCustomerSchema } from "./customers.schemas";
import { getCustomerPortfolio, listCustomersWithStats } from "./customers.service";

export const customersRouter = Router();

customersRouter.use(requireAuth, requireTenant);

// All queries below are scoped by req.auth.tenantId, which comes only from
// the verified JWT — never from the client — per the tenant isolation rule in CLAUDE.md.

customersRouter.get("/", async (req, res) => {
  const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
  const customers = await listCustomersWithStats(req.auth!.tenantId!, q || undefined);
  res.json(customers);
});

customersRouter.get("/:id/portfolio", async (req, res) => {
  const portfolio = await getCustomerPortfolio(req.auth!.tenantId!, req.params.id);
  if (!portfolio) return res.status(404).json({ error: "Customer not found" });
  res.json(portfolio);
});

customersRouter.get("/:id", async (req, res) => {
  const customer = await Customer.findOne({ _id: req.params.id, tenantId: req.auth!.tenantId });
  if (!customer) return res.status(404).json({ error: "Customer not found" });
  res.json(customer);
});

/**
 * Fields worked out from what was typed: Aadhaar keeps only its last 4 digits
 * for display; a GSTIN fills the state (its first 2 digits) when none is picked.
 */
function withDerived<T extends { aadhaar?: string; gstin?: string; stateCode?: string }>(data: T, forUpdate = false) {
  const out: Record<string, unknown> = { ...data };
  if (data.aadhaar !== undefined) {
    out.aadhaar = data.aadhaar || undefined;
    out.aadhaarLast4 = data.aadhaar ? data.aadhaar.slice(-4) : undefined;
    if (!data.aadhaar && forUpdate) {
      delete out.aadhaar;
      delete out.aadhaarLast4;
      out.$unset = { aadhaar: "", aadhaarLast4: "" };
    }
  }
  if (data.gstin && !data.stateCode) out.stateCode = data.gstin.slice(0, 2);
  return out;
}

/** The full Aadhaar never leaves the server. */
function withoutAadhaar(customer: { toObject(): Record<string, unknown> }) {
  const { aadhaar: _hidden, ...rest } = customer.toObject();
  return rest;
}

customersRouter.post("/", async (req, res) => {
  const parsed = createCustomerSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const customer = await Customer.create({ ...withDerived(parsed.data), tenantId: req.auth!.tenantId });
  res.status(201).json(withoutAadhaar(customer));
});

customersRouter.patch("/:id", async (req, res) => {
  const parsed = updateCustomerSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const customer = await Customer.findOneAndUpdate(
    { _id: req.params.id, tenantId: req.auth!.tenantId },
    withDerived(parsed.data, true),
    { new: true }
  );
  if (!customer) return res.status(404).json({ error: "Customer not found" });
  res.json(withoutAadhaar(customer));
});

customersRouter.delete("/:id", async (req, res) => {
  const customer = await Customer.findOneAndDelete({ _id: req.params.id, tenantId: req.auth!.tenantId });
  if (!customer) return res.status(404).json({ error: "Customer not found" });
  res.status(204).send();
});
