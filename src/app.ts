import cors from "cors";
import express from "express";
import helmet from "helmet";
import morgan from "morgan";
import { env } from "./config/env";
import { authRouter } from "./modules/auth/auth.controller";
import { productsRouter } from "./modules/products/products.controller";

export function createApp() {
  const app = express();

  app.use(helmet());
  app.use(cors({ origin: env.corsOrigin, credentials: true }));
  app.use(express.json());
  app.use(morgan(env.nodeEnv === "development" ? "dev" : "combined"));

  app.get("/health", (_req, res) => res.json({ status: "ok" }));

  app.use("/api/auth", authRouter);
  app.use("/api/products", productsRouter);

  app.use((_req, res) => {
    res.status(404).json({ error: "Not found" });
  });

  return app;
}
