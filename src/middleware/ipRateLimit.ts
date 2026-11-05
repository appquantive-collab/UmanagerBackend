import type { NextFunction, Request, Response } from "express";

// Small in-memory limiter for public (pre-login) endpoints. Per-instance only,
// which is fine for a single Render instance; it just stops casual abuse.

function clientIp(req: Request): string {
  // Render sits in front of the app, so the client is the first forwarded address.
  const forwarded = req.headers["x-forwarded-for"];
  const first = (Array.isArray(forwarded) ? forwarded[0] : forwarded)?.split(",")[0]?.trim();
  return first || req.ip || "unknown";
}

export function ipRateLimit(options: { perIp: number; total: number; windowMs?: number; message: string }) {
  const windowMs = options.windowMs ?? 60_000;
  const hits = new Map<string, { count: number; windowStart: number }>();
  let total = { count: 0, windowStart: Date.now() };

  return (req: Request, res: Response, next: NextFunction) => {
    const now = Date.now();
    if (now - total.windowStart > windowMs) total = { count: 0, windowStart: now };
    if (total.count >= options.total) return res.status(429).json({ error: options.message });

    const ip = clientIp(req);
    const entry = hits.get(ip);
    if (!entry || now - entry.windowStart > windowMs) {
      hits.set(ip, { count: 1, windowStart: now });
    } else {
      if (entry.count >= options.perIp) return res.status(429).json({ error: options.message });
      entry.count += 1;
    }
    total.count += 1;

    if (hits.size > 5000) {
      for (const [key, value] of hits) if (now - value.windowStart > windowMs) hits.delete(key);
    }
    return next();
  };
}
