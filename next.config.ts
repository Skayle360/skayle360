import type { NextConfig } from "next";

const ALLOWED = (process.env.ALLOWED_ORIGINS ?? "https://skayle360.com,https://skayle360.webflow.io")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const config: NextConfig = {
  poweredByHeader: false,
  /**
   * The widget document is a static file in public/, which Next serves only at
   * its literal path. Without this rewrite `/widget` 404s and `/widget/` 308s
   * into that 404, so the embed URL would break on the first request.
   */
  async rewrites() {
    return [{ source: "/widget", destination: "/widget/index.html" }];
  },
  async headers() {
    return [
      {
        // The widget document is *meant* to be framed, but only by the client's
        // sites. frame-ancestors is the modern control; X-Frame-Options has no
        // allowlist form, so setting it here would break the embed entirely.
        source: "/widget",
        headers: [
          { key: "content-security-policy", value: `frame-ancestors 'self' ${ALLOWED.join(" ")}` },
          { key: "referrer-policy", value: "strict-origin-when-cross-origin" },
        ],
      },
      {
        // Same headers for the assets the document pulls in.
        source: "/widget/:path*",
        headers: [
          { key: "content-security-policy", value: `frame-ancestors 'self' ${ALLOWED.join(" ")}` },
          { key: "referrer-policy", value: "strict-origin-when-cross-origin" },
        ],
      },
      {
        // The loader is fetched by the host page, so it needs to be readable
        // cross-origin. It contains no secrets.
        source: "/widget.js",
        headers: [
          { key: "access-control-allow-origin", value: "*" },
          { key: "cache-control", value: "public, max-age=300, must-revalidate" },
          { key: "content-type", value: "application/javascript; charset=utf-8" },
        ],
      },
      {
        source: "/:path*",
        headers: [
          { key: "x-content-type-options", value: "nosniff" },
          { key: "strict-transport-security", value: "max-age=63072000; includeSubDomains" },
        ],
      },
    ];
  },
};

export default config;
