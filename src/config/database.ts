import dns from "node:dns";
import mongoose from "mongoose";
import { env } from "./env";

/* Some networks (an iPhone hotspot, for one) hand Windows only an IPv6
   link-local DNS server, which Node's resolver can't use — it falls back to
   127.0.0.1 and the mongodb+srv lookup fails with querySrv ECONNREFUSED.
   When Node is left with nothing but loopback, use public resolvers instead. */
function ensureUsableDns(): void {
  const servers = dns.getServers();
  const onlyLoopback = servers.length === 0 || servers.every((s) => s === "127.0.0.1" || s === "::1");
  if (onlyLoopback) {
    dns.setServers(["1.1.1.1", "8.8.8.8"]);
    console.log("[db] system DNS not usable by Node — using 1.1.1.1 / 8.8.8.8");
  }
}

export async function connectDatabase(): Promise<void> {
  mongoose.set("strictQuery", true);
  ensureUsableDns();
  await mongoose.connect(env.mongodbUri);
  console.log(`[db] connected to MongoDB`);
}
