import { createPublicKey, type JsonWebKey, type KeyObject } from "crypto";
import jwt from "jsonwebtoken";

// Verifies OpenID Connect ID tokens from Google and Apple with nothing but
// Node's crypto and jsonwebtoken: fetch the provider's published signing keys
// (cached), pick the one named in the token header, and check signature,
// issuer, audience and expiry.

interface Jwk extends JsonWebKey {
  kid?: string;
}

const KEY_CACHE_MS = 60 * 60 * 1000;
const keyCache = new Map<string, { keys: Map<string, KeyObject>; fetchedAt: number }>();

async function loadKeys(jwksUrl: string, forceRefresh = false): Promise<Map<string, KeyObject>> {
  const cached = keyCache.get(jwksUrl);
  if (cached && !forceRefresh && Date.now() - cached.fetchedAt < KEY_CACHE_MS) return cached.keys;

  const res = await fetch(jwksUrl);
  if (!res.ok) throw new Error(`Could not load signing keys (${res.status})`);
  const body = (await res.json()) as { keys: Jwk[] };
  const keys = new Map<string, KeyObject>();
  for (const jwk of body.keys) {
    if (jwk.kid) keys.set(jwk.kid, createPublicKey({ key: jwk, format: "jwk" }));
  }
  keyCache.set(jwksUrl, { keys, fetchedAt: Date.now() });
  return keys;
}

export interface IdTokenClaims {
  sub: string;
  email?: string;
  email_verified?: boolean | string;
  name?: string;
}

export async function verifyIdToken(
  token: string,
  options: { jwksUrl: string; issuers: [string, ...string[]]; audience: string }
): Promise<IdTokenClaims> {
  const decoded = jwt.decode(token, { complete: true });
  const kid = decoded && typeof decoded === "object" ? decoded.header.kid : undefined;
  if (!kid) throw new Error("Malformed ID token");

  let key = (await loadKeys(options.jwksUrl)).get(kid);
  // Providers rotate keys; refetch once if this one is new to us.
  if (!key) key = (await loadKeys(options.jwksUrl, true)).get(kid);
  if (!key) throw new Error("Unknown signing key");

  const claims = jwt.verify(token, key, {
    algorithms: ["RS256"],
    issuer: options.issuers,
    audience: options.audience,
  });
  if (typeof claims !== "object" || !claims.sub) throw new Error("ID token has no subject");
  return claims as IdTokenClaims;
}
