/**
 * Create (or reset) a VoiceMunshi team login for the founder's console.
 *   npm run admin:create -- <email> "<name>" [password]
 * Without a password a strong one is generated and printed once.
 * Admin accounts have no business and sign in only at /admin/login.
 */
import "dotenv/config";
import { randomBytes } from "crypto";
import bcrypt from "bcryptjs";
import mongoose from "mongoose";
import { ensureUsableDns } from "../config/database";
import { User } from "../models/User";

async function main() {
  const [emailArg, nameArg, passwordArg] = process.argv.slice(2);
  const email = (emailArg ?? "").trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    console.error('Usage: npm run admin:create -- <email> "<name>" [password]');
    process.exit(1);
  }
  const name = (nameArg ?? "VoiceMunshi Admin").trim();
  const password = passwordArg ?? randomBytes(12).toString("base64url");
  if (password.length < 10) {
    console.error("Password must be at least 10 characters.");
    process.exit(1);
  }

  ensureUsableDns();
  await mongoose.connect(process.env.MONGODB_URI!);
  const passwordHash = await bcrypt.hash(password, 10);
  const existing = await User.findOne({ email, role: "PLATFORM_ADMIN" });
  if (existing) {
    existing.passwordHash = passwordHash;
    existing.name = name;
    existing.isActive = true;
    await existing.save();
    console.log(`Admin ${email}: password reset.`);
  } else {
    await User.create({ tenantId: null, name, email, role: "PLATFORM_ADMIN", passwordHash, isActive: true });
    console.log(`Admin ${email}: created.`);
  }
  if (!passwordArg) console.log(`Password (shown once, change it in Admin → Settings): ${password}`);
  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
