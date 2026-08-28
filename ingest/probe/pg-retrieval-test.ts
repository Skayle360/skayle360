import { retrieve, isThin } from "@/lib/retrieval";
import { db } from "@/lib/db";

const CASES: Array<{ q: string; want: RegExp }> = [
  { q: "we're a nonprofit with 40 employees in Rhode Island - do we qualify?", want: /massachusetts/i },
  { q: "how much does the Express Grant cover?", want: /\$3,000/ },
  { q: "how many employees can my company have and still qualify?", want: /100 or fewer/i },
  { q: "what is the CEO Roundtable and how often does it meet?", want: /roundtable/i },
  { q: "how long is the program and how many modules?", want: /50 hours|five modules/i },
  { q: "when does the next cohort start?", want: /(winter|fall)\s+20\d{2}/i },
  { q: "who is Chris Ciunci?", want: /ciunci/i },
  { q: "what templates do I get in module 2 for assessing my team?", want: /9 box|performance/i },
  { q: "is the training in person or on zoom?", want: /zoom|virtual/i },
  { q: "does Skayle 360 help me submit the grant application?", want: /submit/i },
];

let pass = 0;
for (const c of CASES) {
  const hits = await retrieve(c.q);
  const ok = c.want.test(hits.map((h) => h.text).join("\n"));
  if (ok) pass++;
  const top = hits[0];
  console.log(`${ok ? "PASS" : "FAIL"}  ${c.q}`);
  console.log(`      top: ${top?.sourceLabel}${top?.locator ? ", " + top.locator : ""}  rrf=${top?.score.toFixed(4)}  arms=${top?.arms.join("+")}  thin=${isThin(hits)}`);
}
// A question the corpus genuinely cannot answer must be detected as thin.
const offTopic = await retrieve("what is your refund policy if I cancel after week three");
console.log(`\noff-topic control -> ${offTopic.length} hits, thin=${isThin(offTopic)}, top=${offTopic[0]?.score.toFixed(4) ?? "n/a"} (${offTopic[0]?.sourceLabel ?? "none"})`);
console.log(`\n${pass}/${CASES.length} pass via Postgres hybrid retrieval`);
await db().end();
