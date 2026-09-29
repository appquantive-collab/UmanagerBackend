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

export function createApp() {
  const app = express();

  app.use(helmet());
  app.use(cors({ origin: env.corsOrigins, credentials: true }));
  app.use(express.json());
  app.use(morgan(env.nodeEnv === "development" ? "dev" : "combined"));

  app.get("/health", (_req, res) => res.json({ status: "ok" }));

  app.use("/api/auth", authRouter);
  app.use("/api/products", productsRouter);
  app.use("/api/warehouses", warehousesRouter);
  app.use("/api/stock", stockRouter);
  app.use("/api/tenants", tenantsRouter);
  app.use("/api/customers", customersRouter);
  app.use("/api/suppliers", suppliersRouter);
  app.use("/api/orders", ordersRouter);
  app.use("/api/invoices", invoicesRouter);
  app.use("/api/dashboard", dashboardRouter);
  app.use("/api/staff", staffRouter);
  app.use("/api/catalog", catalogRouter);
  app.use("/api/uploads", uploadsRouter);
  app.use("/api/assembly", assemblyRouter);

  app.use((_req, res) => {
    res.status(404).json({ error: "Not found" });
  });

  return app;
}
