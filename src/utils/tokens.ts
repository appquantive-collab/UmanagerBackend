import jwt, { SignOptions } from "jsonwebtoken";
import { env } from "../config/env";
import { AuthPayload } from "../middleware/auth";

export function signAccessToken(payload: AuthPayload): string {
  const options: SignOptions = { expiresIn: env.jwt.accessExpiresIn as SignOptions["expiresIn"] };
  return jwt.sign(payload, env.jwt.accessSecret, options);
}

export function signRefreshToken(payload: AuthPayload): string {
  const options: SignOptions = { expiresIn: env.jwt.refreshExpiresIn as SignOptions["expiresIn"] };
  return jwt.sign(payload, env.jwt.refreshSecret, options);
}

export function verifyRefreshToken(token: string): AuthPayload {
  return jwt.verify(token, env.jwt.refreshSecret) as AuthPayload;
}
