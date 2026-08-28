/**
 * Batch-runs audit questions and records what the bot did, as JSON, so the
 * answers can be checked against the sources afterwards.
 *
 *   npm run audit -- questions.txt
 */
import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { runChat } from "@/lib/chat";
import { db } from "@/lib/db";

const file = process.argv[2];
if (!file) { console.error("usage: npm run audit -- <file of questions>"); process.exit(1); }

const questions = readFileSync(file, "utf-8").split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));

/**
 * Pace between questions.
 *
 * Each question costs one embedding call, and a Voyage account without a
 * payment method allows three per minute. Run flat out, the vector arm is rate
 * limited away after the first question and the audit silently measures
 * keyword search instead — which is exactly what invalidated the first run.
 */
const PACE_MS = Number(process.env.AUDIT_PACE_MS ?? 0);
const out: Array<Record<string, unknown>> = [];

for (const [i, q] of questions.entries()) {
  const conversationId = randomUUID();
  await db().query("INSERT INTO conversations (id) VALUES ($1) ON CONFLICT DO NOTHING", [conversationId]);
  let text = "", escalated = false, grounded = false;
  const sources: string[] = [];
  try {
    await runChat({ conversationId, history: [], message: q, sourceUrl: null }, (e) => {
      if (e.type === "text") text += e.text;
      if (e.type === "sources") sources.push(...e.sources.map((s) => s.label));
      if (e.type === "escalated") escalated = true;
      if (e.type === "done") grounded = e.grounded;
    });
  } catch (err) {
    text = `ERROR: ${err instanceof Error ? err.message : err}`;
  }
  out.push({ q, text: text.trim(), sources: [...new Set(sources)], escalated, grounded, words: text.split(/\s+/).length });
  process.stderr.write(`\r  ${i + 1}/${questions.length}`);
  if (PACE_MS > 0 && i < questions.length - 1) await new Promise((r) => setTimeout(r, PACE_MS));
}

writeFileSync("data/audit.json", JSON.stringify(out, null, 2));
console.error(`\n-> data/audit.json`);
await db().end();
