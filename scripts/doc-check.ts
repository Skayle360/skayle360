/**
 * Reads a document the way the assistant will, and flags anything that should
 * not be shown to a visitor — before it is uploaded rather than after.
 *
 * The assistant quotes its sources verbatim under every answer, so whatever is
 * in a document can appear on the client's website. An internal research note
 * does not leak by malfunctioning; it leaks by working correctly.
 *
 *   npm run doc:check -- /path/to/file.docx
 */
import { readFileSync } from "node:fs";
import { extractAsync } from "@ingest/lib/extract";

const path = process.argv[2];
if (!path) {
  console.error("usage: npm run doc:check -- /path/to/file");
  process.exit(1);
}

const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;
const red = (s: string) => `\x1b[31m${s}\x1b[0m`;
const green = (s: string) => `\x1b[32m${s}\x1b[0m`;
const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;

const name = path.slice(path.lastIndexOf("/") + 1);
const segments = await extractAsync(name, new Uint8Array(readFileSync(path)));
const text = segments.map((s) => s.text).join("\n");
const words = (text.match(/\S+/g) ?? []).length;

console.log(`\n${bold(name)}`);
console.log(`  ${words.toLocaleString()} words, ${segments.length} page(s)/section(s)`);
if (!words) {
  console.log(red("\n  No readable text. A scanned PDF needs OCR before it can be indexed.\n"));
  process.exit(1);
}

/** Patterns that mark writing meant for the team rather than the customer. */
const RISKS: Array<[string, RegExp, string]> = [
  ["Named third parties", /\b[A-Z][a-z]+ [A-Z][a-z]+\b(?=[^.]{0,40}\b(said|told|confirmed|verified|phone|call|board|contact)\b)/g,
    "Officials or contacts named with call details"],
  ["Internal research framing", /\b(this analysis|was wrong|earlier assumption|prior version|we modeled|our research|verified by phone|resolved the question)\b/gi,
    "Reads as working notes, not customer material"],
  ["Sales or pricing strategy", /\b(sales message|can be pitched|pitch(ed|ing)? the way|our margin|our cost|revenue|markup|upsell)\b/gi,
    "Exposes how the offer is sold or priced internally"],
  ["Other clients", /\b(PrepU|prep u)\b/gi,
    "Another client's confidential material"],
  ["Unpublished figures", /\$[\d,]+(?:\s*(?:per|margin|cost|profit))/gi,
    "Money figures that may not be public"],
];

let flagged = 0;
console.log(`\n${bold("Safe to show a visitor?")}`);
for (const [label, re, why] of RISKS) {
  const hits = [...new Set(text.match(re) ?? [])];
  if (!hits.length) {
    console.log(`  ${green("ok")}   ${label}`);
    continue;
  }
  flagged++;
  console.log(`  ${red("!!")}   ${bold(label)} — ${why}`);
  for (const h of hits.slice(0, 4)) {
    const at = text.indexOf(h);
    const quote = text.slice(Math.max(0, at - 55), at + 75).replace(/\s+/g, " ").trim();
    console.log(dim(`         "…${quote}…"`));
  }
  if (hits.length > 4) console.log(dim(`         and ${hits.length - 4} more`));
}

console.log(
  flagged === 0
    ? green("\n  Nothing flagged. Safe to upload.\n")
    : red(`\n  ${flagged} thing(s) to check before uploading. The assistant quotes sources\n` +
          `  verbatim, so anything above can appear on the client's website.\n`),
);
process.exit(flagged ? 1 : 0);
