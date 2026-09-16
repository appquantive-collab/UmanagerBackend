import { NextFunction, Request, Response } from "express";
import jwt from "jsonwebtoken";
import { env } from "../config/env";
import { UserRole } from "../models/User";

export interface AuthPayload {
  userId: string;
  tenantId: string | null;
  role: UserRole;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      auth?: AuthPayload;
    }
  }
}

export function requireAuth(req: Request, res: Response, next: NextFunction) {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) {
    return res.status(401).json({ error: "Missing or invalid Authorization header" });
  }

  const token = header.slice("Bearer ".length);

  try {
    const payload = jwt.verify(token, env.jwt.accessSecret) as AuthPayload;
    req.auth = payload;
    return next();
  } catch {
    return res.status(401).json({ error: "Invalid or expired token" });
  }
}

// Resolves tenant context strictly from the authenticated token, never from
// client-supplied params/body/query. Per CLAUDE.md, tenantId must never be trusted from the frontend.
export function requireTenant(req: Request, res: Response, next: NextFunction) {
  if (!req.auth?.tenantId) {
    return res.status(403).json({ error: "No tenant context for this account" });
  }
  return next();
}

export function requireRole(...roles: UserRole[]) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!req.auth || !roles.includes(req.auth.role)) {
      return res.status(403).json({ error: "Insufficient permissions" });
    }
    return next();
  };
}
