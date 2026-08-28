import { isAllowedOrigin, corsHeaders } from "@/lib/cors";
let bad = 0;
const t2 = (got: boolean, want: boolean, note: string) => {
  if (got !== want) { bad++; console.log(`FAIL  ${note} -> ${got}, wanted ${want}`); }
  else console.log(`PASS  ${note.padEnd(34)} ${got ? "allowed" : "blocked"}`);
};
const t = (origin: string | null, want: boolean, note: string) => {
  const got = isAllowedOrigin(origin);
  if (got !== want) { bad++; console.log(`FAIL  ${origin} -> ${got}, wanted ${want} (${note})`); }
  else console.log(`PASS  ${String(origin).padEnd(34)} ${got ? "allowed" : "blocked"}  ${note}`);
};
t("https://skayle360.com", true, "the client's site");
t("https://skayle360.webflow.io", true, "staging");
t("http://localhost:3000", true, "dev, any port");
t("http://localhost:3111", true, "dev, any port");
t("http://127.0.0.1:8080", true, "dev");
t("https://evil-skayle360.com", false, "lookalike domain");
t("https://skayle360.com.attacker.net", false, "suffix attack");
t("http://localhost.evil.com", false, "localhost lookalike");
t(null, false, "no origin header");
// Same-origin: a page this app serves calling this app's own API.
const sameOrigin = (o: string, host: string) =>
  Object.hasOwn(corsHeaders(o, host), "access-control-allow-origin");
t2(sameOrigin("https://skayle360.vercel.app", "skayle360.vercel.app"), true, "own deployment (same-origin)");
t2(sameOrigin("https://chat.skayle360.com", "chat.skayle360.com"), true, "own domain (same-origin)");
t2(sameOrigin("https://evil.com", "skayle360.vercel.app"), false, "other site claiming our host");

console.log(bad ? `\n${bad} FAILED` : "\nCORS boundary holds");
process.exit(bad ? 1 : 0);
