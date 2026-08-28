import { readFileSync } from "node:fs";
import { Bm25Index } from "@/lib/bm25";

interface Chunk { id: string; docId: string; text: string; locator: string | null; heading: string | null }
const chunks: Chunk[] = readFileSync("data/corpus.jsonl", "utf-8").trim().split("\n").map((l) => JSON.parse(l));
const manifest = JSON.parse(readFileSync("data/manifest.json", "utf-8"));
const titleOf = new Map<string, string>(manifest.documents.map((d: any) => [d.docId, d.sourceLabel]));
const index = new Bm25Index(chunks);

const CASES: Array<{ q: string; mustContain: RegExp; note: string }> = [
  { q: "we're a nonprofit with 40 employees in Rhode Island - do we qualify for the grant?", mustContain: /massachusetts/i, note: "must retrieve MA-only eligibility" },
  { q: "how much does the Express Grant cover?", mustContain: /\$3,000/, note: "the $3,000 cap" },
  { q: "how many employees can my company have and still qualify?", mustContain: /100 or fewer/i, note: "100 W-2 employee ceiling" },
  { q: "what is the CEO Roundtable and how often does it meet?", mustContain: /roundtable/i, note: "website-only content" },
  { q: "how long is the program and how many modules?", mustContain: /50 hours|five modules|5 modules/i, note: "program shape" },
  { q: "when does the next cohort start?", mustContain: /(winter|fall)\s+20\d{2}/i, note: "cohort date - expect conflicting sources" },
  { q: "who is Chris Ciunci?", mustContain: /ciunci/i, note: "bio" },
  { q: "what templates do I get in module 2 for assessing my team?", mustContain: /9.box|performance/i, note: "catalog-only worksheets" },
  { q: "is the training in person or on zoom?", mustContain: /zoom|virtual/i, note: "delivery format" },
  { q: "does Skayle 360 help me submit the grant application?", mustContain: /submit/i, note: "grant admin help" },
];

let pass = 0;
for (const c of CASES) {
  const hits = index.search(c.q, 6);
  const joined = hits.map((h) => h.item.text).join("\n");
  const ok = c.mustContain.test(joined);
  if (ok) pass++;
  const top = hits[0];
  console.log(`${ok ? "PASS" : "FAIL"}  ${c.q}`);
  console.log(`      want ${c.mustContain}  (${c.note})`);
  if (top) console.log(`      top: ${titleOf.get(top.item.docId) ?? top.item.docId}${top.item.locator ? ", " + top.item.locator : ""}  score=${top.score.toFixed(1)}`);
  if (!ok) console.log(`      hits: ${hits.map((h) => titleOf.get(h.item.docId)).join(" | ")}`);
}
console.log(`\n${pass}/${CASES.length} lexical retrieval cases pass over ${chunks.length} chunks`);
