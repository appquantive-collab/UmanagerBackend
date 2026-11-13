import type { NextFunction, Request, Response } from "express";
import jwt from "jsonwebtoken";
import { env } from "../config/env";
import type { AuthPayload } from "./auth";
import { getPlanState } from "../modules/billing/subscription.service";

// Still allowed after the plan ends: signing in, paying, and business settings.
const ALWAYS_OPEN = ["/api/auth", "/api/billing", "/api/tenants", "/api/munshi"];

/**
 * When a business's trial or plan has ended, the app turns read-only: they can
 * still open and look at everything (and download it), but saving anything new
 * answers 402 PLAN_EXPIRED until a plan is chosen.
 * Runs before the routers; requests without a valid token pass through to
 * them unchanged (they reject it themselves).
 */
export async function planGate(req: Request, res: Response, next: NextFunction) {
  if (req.method === "GET" || req.method === "HEAD" || req.method === "OPTIONS") return next();
  if (ALWAYS_OPEN.some((prefix) => req.path === prefix || req.path.startsWith(`${prefix}/`))) return next();
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) return next();
  let payload: AuthPayload;
  try {
    payload = jwt.verify(header.slice("Bearer ".length), env.jwt.accessSecret) as AuthPayload;
  } catch {
    return next();
  }
  if (!payload.tenantId) return next();
  try {
    const state = await getPlanState(payload.tenantId);
    if (state.status === "expired") {
      return res.status(402).json({ error: "Your plan has ended. Choose a plan to continue.", code: "PLAN_EXPIRED" });
    }
  } catch (err) {
    // Never lock a shop out because the plan check itself failed.
    console.error("[plan] check failed:", (err as Error).message);
  }
  return next();
}
