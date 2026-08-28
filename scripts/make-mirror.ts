/**
 * Rebuilds public/mirror/index.html — a local copy of the client's homepage
 * with the widget injected, for testing against their real Webflow CSS.
 *
 * Development only. It is gitignored and must never be deployed: served from
 * chat.skayle360.com it would republish the client's own homepage on their own
 * subdomain.
 *
 *   npm run dev:mirror
 */
import { mkdirSync, writeFileSync } from "node:fs";

const SITE = process.env.SITE_URL ?? "https://skayle360.com";
const res = await fetch(SITE, { headers: { "user-agent": "Mozilla/5.0 (compatible; Skayle360Bot/1.0)" } });
if (!res.ok) throw new Error(`${SITE} returned ${res.status}`);

let html = await res.text();
// Absolute asset URLs so their CSS, fonts and images load from the real CDN.
html = html.replace(/(href|src)="\/(?!\/)/g, `$1="${SITE}/`);

const banner =
  `<div style="position:fixed;top:0;left:0;right:0;z-index:2147482000;background:#201e1b;color:#fff;` +
  `font:600 13px system-ui;padding:8px 14px;text-align:center">LOCAL MIRROR of ${SITE} &mdash; ` +
  `real Webflow CSS, widget served from localhost. Not the live site.</div>`;

html = html.replace("</body>", `${banner}\n<script src="/widget.js" defer></script>\n</body>`);

mkdirSync("public/mirror", { recursive: true });
writeFileSync("public/mirror/index.html", html);
console.log(`public/mirror/index.html rebuilt (${html.length.toLocaleString()} chars)`);
