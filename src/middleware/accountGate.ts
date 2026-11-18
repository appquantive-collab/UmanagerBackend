import type { NextFunction, Request, Response } from "express";
import jwt from "jsonwebtoken";
import { env } from "../config/env";
import { Tenant } from "../models/Tenant";
import { User } from "../models/User";
import type { AuthPayload } from "./auth";

/**
 * Turns away requests from a business the VoiceMunshi team has suspended, or a
 * login that has been stopped (from the founder's admin panel), right away:
 * not only at the next sign-in. Results are cached briefly per business/user;
 * the admin panel clears the cache when it changes one.
 */
const CACHE_MS = 30_000;
const tenantCache = new Map<string, { suspended: boolean; at: number }>();
const userCache = new Map<string, { active: boolean; at: number }>();

export function forgetAccountState(which: { tenantId?: string; userId?: string }) {
  if (which.tenantId) tenantCache.delete(which.tenantId);
  if (which.userId) userCache.delete(which.userId);
}

async function tenantSuspended(tenantId: string): Promise<boolean> {
  const hit = tenantCache.get(tenantId);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.suspended;
  const tenant = await Tenant.findById(tenantId, { status: 1 }).lean();
  const suspended = tenant?.status === "suspended";
  tenantCache.set(tenantId, { suspended, at: Date.now() });
  return suspended;
}

async function userActive(userId: string): Promise<boolean> {
  const hit = userCache.get(userId);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.active;
  const user = await User.findById(userId, { isActive: 1 }).lean();
  const active = Boolean(user?.isActive);
  userCache.set(userId, { active, at: Date.now() });
  return active;
}

export async function accountGate(req: Request, res: Response, next: NextFunction) {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) return next();
  let payload: AuthPayload;
  try {
    payload = jwt.verify(header.slice("Bearer ".length), env.jwt.accessSecret) as AuthPayload;
  } catch {
    return next(); // the routers reject bad tokens themselves
  }
  try {
    if (!(await userActive(payload.userId))) {
      return res.status(403).json({ error: "This login has been stopped. Please contact your business owner or VoiceMunshi.", code: "ACCOUNT_DISABLED" });
    }
    if (payload.tenantId && (await tenantSuspended(payload.tenantId))) {
      return res.status(403).json({ error: "This business account is suspended. Please contact VoiceMunshi.", code: "ACCOUNT_SUSPENDED" });
    }
  } catch (err) {
    // Never lock everyone out because the check itself failed.
    console.error("[account] check failed:", (err as Error).message);
  }
  return next();
}
