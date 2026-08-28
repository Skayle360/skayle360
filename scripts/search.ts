/**
 * Search the knowledge base directly, without the bot in the way.
 *
 * This is how you check whether an answer was true: look up what the material
 * actually says, in full, and compare. The bot sees exactly these passages.
 *
 *   npm run search -- "express grant eligibility"
 *   npm run search -- "refund"          # nothing found = the bot cannot answer it
 */
import { retrieve } from "../src/lib/retrieval";
import { db } from "../src/lib/db";

const query = process.argv.slice(2).join(" ").trim();
if (!query) {
  console.error('Usage: npm run search -- "what you want to look up"');
  process.exit(1);
}

const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;
const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const mark = (s: string) => `\x1b[43m\x1b[30m${s}\x1b[0m`;

const hits = await retrieve(query, 5);
if (!hits.length) {
  console.log(`\nNothing in the knowledge base matches "${query}".`);
  console.log("The bot would escalate this question to Chris rather than answer it.\n");
  await db().end();
  process.exit(0);
}

const terms = (query.toLowerCase().match(/[a-z0-9$]{3,}/g) ?? []);
const highlight = (text: string) =>
  terms.reduce((t, term) => t.replace(new RegExp(`(${term})`, "gi"), (m) => mark(m)), text);

console.log(`\n${hits.length} passage(s) the bot would see for "${query}":\n`);

hits.forEach((h, i) => {
  const where = h.locator ? `${h.sourceLabel}, ${h.locator}` : h.sourceLabel;
  const tag = h.sourceType === "correction" ? " [AUTHORITATIVE CORRECTION]" : "";
  console.log(bold(`${i + 1}. ${where}${tag}`));
  console.log(dim(`   ${h.origin}`));
  console.log();
  for (const line of highlight(h.text).split("\n")) console.log(`   ${line}`);
  console.log(dim(`\n   ${"-".repeat(66)}\n`));
});

await db().end();
