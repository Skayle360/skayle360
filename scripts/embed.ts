/**
 * Embeds only the chunks that do not have an embedding yet.
 *
 * Separate from `ingest:load` so it is resumable: a rate-limit stall or a
 * dropped connection costs you the current batch, not the whole run. Safe to
 * re-run as many times as needed.
 *
 *   npm run embed
 */
import { db } from "../src/lib/db";
import { getEmbedder, toVectorLiteral, estimateTokens } from "../src/lib/embeddings";

const BATCH_TOKENS = Number(process.env.EMBED_BATCH_TOKENS ?? 8_000);
const PAUSE_MS = Number(process.env.EMBED_PAUSE_MS ?? 21_000);

const embedder = getEmbedder();
if (!embedder) {
  console.error("No VOYAGE_API_KEY or OPENAI_API_KEY set.");
  process.exit(1);
}

const { rows } = await db().query<{ id: string; text: string; heading: string | null }>(
  "SELECT id, text, heading FROM chunks WHERE embedding IS NULL ORDER BY id",
);
if (!rows.length) {
  console.log("Every chunk is already embedded.");
  await db().end();
  process.exit(0);
}

const body = (r: { text: string; heading: string | null }) => (r.heading ? `${r.heading}\n\n${r.text}` : r.text);

const batches: (typeof rows)[] = [];
let current: typeof rows = [];
let tokens = 0;
for (const r of rows) {
  const t = estimateTokens(body(r));
  if (tokens + t > BATCH_TOKENS && current.length) {
    batches.push(current);
    current = [];
    tokens = 0;
  }
  current.push(r);
  tokens += t;
}
if (current.length) batches.push(current);

const total = rows.reduce((n, r) => n + estimateTokens(body(r)), 0);
console.log(`${rows.length} chunk(s) to embed with ${embedder.name}`);
console.log(`~${total.toLocaleString()} tokens in ${batches.length} batches, ${PAUSE_MS / 1000}s apart`);
console.log(`estimated ${Math.ceil((batches.length * PAUSE_MS) / 60000)} minute(s)\n`);

let done = 0;
for (const [i, batch] of batches.entries()) {
  const vectors = await embedder.embed(batch.map(body), "document");
  await Promise.all(
    batch.map((r, j) => db().query("UPDATE chunks SET embedding = $1 WHERE id = $2", [toVectorLiteral(vectors[j]!), r.id])),
  );
  done += batch.length;
  console.log(`  ${done}/${rows.length} chunks  (batch ${i + 1}/${batches.length})`);
  if (i < batches.length - 1 && PAUSE_MS > 0) await new Promise((r) => setTimeout(r, PAUSE_MS));
}

console.log("\nDone.");
await db().end();
