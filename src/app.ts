import cors from "cors";
import express from "express";
import helmet from "helmet";
import morgan from "morgan";
import { env } from "./config/env";
import { authRouter } from "./modules/auth/auth.controller";
import { productsRouter } from "./modules/products/products.controller";
import { stockRouter } from "./modules/stock/stock.controller";
import { warehousesRouter } from "./modules/warehouses/warehouses.controller";
import { tenantsRouter } from "./modules/tenants/tenants.controller";
import { customersRouter } from "./modules/customers/customers.controller";
import { suppliersRouter } from "./modules/suppliers/suppliers.controller";
import { ordersRouter } from "./modules/orders/orders.controller";
import { invoicesRouter } from "./modules/invoices/invoices.controller";
import { dashboardRouter } from "./modules/dashboard/dashboard.controller";
import { staffRouter } from "./modules/staff/staff.controller";
import { catalogRouter } from "./modules/catalog/catalog.controller";
import { uploadsRouter } from "./modules/uploads/uploads.controller";
import { assemblyRouter } from "./modules/assembly/assembly.controller";
import { attendanceRouter } from "./modules/attendance/attendance.controller";
import { payrollRouter } from "./modules/payroll/payroll.controller";
import { aiChatRouter } from "./modules/ai-chat/ai-chat.controller";
import { ttsRouter } from "./modules/tts/tts.controller";
import { munshiRouter } from "./modules/munshi/munshi.controller";
import { purchasesRouter } from "./modules/purchases/purchases.controller";
import { returnsRouter } from "./modules/returns/returns.controller";
import { expensesRouter } from "./modules/expenses/expenses.controller";
import { daybookRouter } from "./modules/daybook/daybook.controller";
import { teamRouter } from "./modules/team/team.controller";
import { auditRouter } from "./modules/audit/audit.controller";
import { denyRoles, ownerOrManager, requireAuth } from "./middleware/auth";

export function createApp() {
  const app = express();

  app.use(helmet());
  app.use(cors({ origin: env.corsOrigins, credentials: true }));
  app.use(express.json());
  app.use(morgan(env.nodeEnv === "development" ? "dev" : "combined"));

  app.get("/health", (_req, res) => res.json({ status: "ok" }));

  // Who can open what (owner and manager: everything):
  // - salesman: selling, customers, items (read), stock levels — not buying, staff, cash book or settings
  // - warehouse staff: items, stock, warehouses, purchases (goods in), suppliers — not selling or money
  const notSalesman = [requireAuth, denyRoles("SALESMAN")];
  const notWarehouse = [requireAuth, denyRoles("WAREHOUSE_STAFF")];
  const managersOnly = [requireAuth, ownerOrManager];

  app.use("/api/auth", authRouter);
  app.use("/api/products", productsRouter);
  app.use("/api/warehouses", warehousesRouter);
  app.use("/api/stock", stockRouter);
  app.use("/api/tenants", tenantsRouter);
  app.use("/api/customers", ...notWarehouse, customersRouter);
  app.use("/api/suppliers", ...notSalesman, suppliersRouter);
  app.use("/api/orders", ...notWarehouse, ordersRouter);
  app.use("/api/invoices", ...notWarehouse, invoicesRouter);
  app.use("/api/returns", ...notWarehouse, returnsRouter);
  app.use("/api/dashboard", dashboardRouter);
  app.use("/api/staff", ...managersOnly, staffRouter);
  app.use("/api/catalog", catalogRouter);
  app.use("/api/uploads", uploadsRouter);
  app.use("/api/assembly", ...notSalesman, assemblyRouter);
  app.use("/api/attendance", ...managersOnly, attendanceRouter);
  app.use("/api/payroll", payrollRouter);
  app.use("/api/ai-chat", aiChatRouter);
  app.use("/api/tts", ttsRouter);
  app.use("/api/munshi", munshiRouter);
  app.use("/api/purchases", ...notSalesman, purchasesRouter);
  app.use("/api/expenses", ...notWarehouse, denyRoles("SALESMAN"), expensesRouter);
  app.use("/api/daybook", ...managersOnly, daybookRouter);
  app.use("/api/team", teamRouter);
  app.use("/api/audit", auditRouter);

  app.use((_req, res) => {
    res.status(404).json({ error: "Not found" });
  });

  return app;
}
