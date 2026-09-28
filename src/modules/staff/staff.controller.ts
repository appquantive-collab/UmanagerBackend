import { Router } from "express";
import { Staff } from "../../models/Staff";
import { Department } from "../../models/Department";
import { Designation } from "../../models/Designation";
import { requireAuth, requireRole, requireTenant } from "../../middleware/auth";
import {
  createDepartmentSchema,
  createDesignationSchema,
  createStaffSchema,
  updateStaffSchema,
} from "./staff.schemas";
import { createStaff, updateStaff } from "./staff.service";

export const staffRouter = Router();

staffRouter.use(requireAuth, requireTenant);

// Staff, departments, and designations are all tenant-scoped via req.auth.tenantId
// from the verified JWT — never from the client — per the tenant isolation rule.

staffRouter.get("/", async (req, res) => {
  const staff = await Staff.find({ tenantId: req.auth!.tenantId })
    .populate("departmentId", "name")
    .populate("designationId", "title")
    .sort({ createdAt: -1 });
  res.json(staff);
});

staffRouter.post("/", requireRole("OWNER", "MANAGER"), async (req, res) => {
  const parsed = createStaffSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  try {
    const staff = await createStaff(req.auth!.tenantId!, parsed.data);
    res.status(201).json(staff);
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

staffRouter.patch("/:id", requireRole("OWNER", "MANAGER"), async (req, res) => {
  const parsed = updateStaffSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  try {
    const staff = await updateStaff(req.auth!.tenantId!, req.params.id, parsed.data);
    res.json(staff);
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

// Departments

staffRouter.get("/departments", async (req, res) => {
  const departments = await Department.find({ tenantId: req.auth!.tenantId }).sort({ name: 1 });
  res.json(departments);
});

staffRouter.post("/departments", requireRole("OWNER", "MANAGER"), async (req, res) => {
  const parsed = createDepartmentSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  try {
    const department = await Department.create({ ...parsed.data, tenantId: req.auth!.tenantId });
    res.status(201).json(department);
  } catch {
    res.status(409).json({ error: "A department with this name already exists" });
  }
});

// Designations

staffRouter.get("/designations", async (req, res) => {
  const designations = await Designation.find({ tenantId: req.auth!.tenantId }).sort({ title: 1 });
  res.json(designations);
});

staffRouter.post("/designations", requireRole("OWNER", "MANAGER"), async (req, res) => {
  const parsed = createDesignationSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  try {
    const designation = await Designation.create({ ...parsed.data, tenantId: req.auth!.tenantId });
    res.status(201).json(designation);
  } catch {
    res.status(409).json({ error: "A designation with this title already exists" });
  }
});
