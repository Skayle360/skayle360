import { createHmac, timingSafeEqual, randomBytes } from "node:crypto";
import type { NextRequest } from "next/server";

/**
 * Admin authentication.
 *
 * Internal tool for the build team, so this is a shared password rather than
 * per-user accounts — but the admin surface can delete the knowledge base and
 * rewrite the bot's instructions, so it is a real session, not a header check.
 *
 * The password is never stored in the cookie. The cookie holds an expiry and an
 * HMAC over it, signed with ADMIN_SECRET, so a cookie cannot be forged without
 * the secret and cannot be replayed past its expiry.
 */
const COOKIE = "skayle_admin";
const TTL_MS = 12 * 60 * 60 * 1000;

function secret(): string {
  const s = process.env.ADMIN_SECRET;
  if (!s || s.length < 24) {
    throw new Error("ADMIN_SECRET must be set to at least 24 characters");
  }
  return s;
}

export function adminConfigured(): boolean {
  return Boolean(process.env.ADMIN_PASSWORD && process.env.ADMIN_SECRET);
}

/** Constant-time compare so the password cannot be recovered by timing. */
export function passwordMatches(supplied: string): boolean {
  const expected = process.env.ADMIN_PASSWORD ?? "";
  if (!expected) return false;
  const a = Buffer.from(supplied);
  const b = Buffer.from(expected);
  if (a.length !== b.length) {
    // Still do the work, so a wrong length is not faster than a wrong password.
    timingSafeEqual(b, b);
    return false;
  }
  return timingSafeEqual(a, b);
}

const sign = (payload: string): string => createHmac("sha256", secret()).update(payload).digest("base64url");

export function issueSession(): { name: string; value: string; maxAge: number } {
  const expires = Date.now() + TTL_MS;
  const nonce = randomBytes(9).toString("base64url");
  const payload = `${expires}.${nonce}`;
  return { name: COOKIE, value: `${payload}.${sign(payload)}`, maxAge: Math.floor(TTL_MS / 1000) };
}

export function isAuthenticated(req: NextRequest): boolean {
  const raw = req.cookies.get(COOKIE)?.value;
  if (!raw) return false;
  const parts = raw.split(".");
  if (parts.length !== 3) return false;
  const [expires, nonce, mac] = parts as [string, string, string];
  const payload = `${expires}.${nonce}`;
  let expected: string;
  try {
    expected = sign(payload);
  } catch {
    return false;
  }
  const a = Buffer.from(mac);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return false;
  return Number(expires) > Date.now();
}

export const clearSession = () => ({ name: COOKIE, value: "", maxAge: 0 });
