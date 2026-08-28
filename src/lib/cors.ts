import { ALLOWED_ORIGINS } from "../../config/app";

/**
 * The widget runs in an iframe on the client's Webflow site, so requests are
 * cross-origin by construction. The allowlist is exact-match: no wildcard, no
 * suffix matching (`evil-skayle360.com` must not pass), and no reflecting an
 * arbitrary Origin header back.
 *
 * In development any localhost port is accepted, because the dev server picks
 * whatever port is free and pinning one in the allowlist means the widget
 * silently stops working the moment it moves. This never applies in production:
 * NODE_ENV is "production" on Vercel, so only the configured origins pass.
 */
const LOCALHOST = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;

const isDevLocalhost = (origin: string): boolean =>
  process.env.NODE_ENV !== "production" && LOCALHOST.test(origin);

export function corsHeaders(origin: string | null): Record<string, string> {
  const allowed = origin !== null && isAllowedOrigin(origin);
  return {
    ...(allowed ? { "access-control-allow-origin": origin } : {}),
    "access-control-allow-methods": "POST, OPTIONS",
    "access-control-allow-headers": "content-type",
    "access-control-max-age": "86400",
    vary: "Origin",
  };
}

export const isAllowedOrigin = (origin: string | null): boolean =>
  origin !== null && (ALLOWED_ORIGINS.includes(origin) || isDevLocalhost(origin));
