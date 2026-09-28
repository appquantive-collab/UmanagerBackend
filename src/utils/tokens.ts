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
  const decoded = jwt.verify(token, env.jwt.refreshSecret) as AuthPayload & { iat?: number; exp?: number };
  // jsonwebtoken refuses to sign a payload that already carries iat/exp when
  // an `expiresIn` option is also given, so strip the claims from the
  // decoded refresh token before reusing it to mint a new access token.
  const { iat: _iat, exp: _exp, ...payload } = decoded;
  return payload;
}
