/**
 * Diffs two audit runs so a retrieval change can be judged on the same
 * questions rather than on impressions.
 *
 *   npm run audit:compare -- data/audit-before-embeddings.json data/audit.json
 */
import { readFileSync } from "node:fs";

interface Row { q: string; text: string; sources: string[]; escalated: boolean; grounded: boolean }
const [beforePath, afterPath] = process.argv.slice(2);
if (!beforePath || !afterPath) { console.error("usage: npm run audit:compare -- <before.json> <after.json>"); process.exit(1); }

const before: Row[] = JSON.parse(readFileSync(beforePath, "utf-8"));
const after: Row[] = JSON.parse(readFileSync(afterPath, "utf-8"));
const byQ = new Map(after.map((r) => [r.q, r]));

const green = (s: string) => `\x1b[32m${s}\x1b[0m`;
const red = (s: string) => `\x1b[31m${s}\x1b[0m`;
const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;

let fixed = 0, broke = 0, same = 0;
for (const b of before) {
  const a = byQ.get(b.q);
  if (!a) continue;
  if (b.escalated && !a.escalated) {
    fixed++;
    console.log(green(`FIXED    ${b.q}`));
    console.log(dim(`         now: ${a.text.slice(0, 120).replace(/\n/g, " ")}`));
    console.log(dim(`         src: ${a.sources.slice(0, 2).join(", ")}\n`));
  } else if (!b.escalated && a.escalated) {
    broke++;
    console.log(red(`REGRESSED ${b.q}`));
    console.log(dim(`         was: ${b.text.slice(0, 100).replace(/\n/g, " ")}\n`));
  } else same++;
}

const escBefore = before.filter((r) => r.escalated).length;
const escAfter = after.filter((r) => r.escalated).length;
console.log(`\nescalations: ${escBefore} -> ${escAfter} of ${before.length}`);
console.log(`fixed ${fixed}, regressed ${broke}, unchanged ${same}`);
