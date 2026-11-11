import type { Request } from "express";
import { AuditLog } from "../../models/AuditLog";
import { User } from "../../models/User";

const nameCache = new Map<string, { name: string; at: number }>();

async function userName(userId: string): Promise<string> {
  const cached = nameCache.get(userId);
  if (cached && Date.now() - cached.at < 10 * 60_000) return cached.name;
  const user = await User.findById(userId, { name: 1 }).lean();
  const name = user?.name ?? "Unknown";
  nameCache.set(userId, { name, at: Date.now() });
  return name;
}

/**
 * Notes who did what. Never throws and never blocks the action itself — a
 * missed log line must not stop a sale.
 */
export async function recordAudit(req: Request, action: string, summary: string, entityId?: string, amount?: number) {
  try {
    const auth = req.auth;
    if (!auth?.tenantId) return;
    await AuditLog.create({
      tenantId: auth.tenantId,
      userId: auth.userId,
      userName: await userName(auth.userId),
      action,
      summary: summary.slice(0, 500),
      entityId,
      amount,
    });
  } catch (err) {
    console.error("[audit] could not record", action, (err as Error).message);
  }
}
