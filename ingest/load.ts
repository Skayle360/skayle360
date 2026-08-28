/**
 * Loads data/corpus.jsonl + manifest.json into Postgres, then embeds.
 *
 * Re-runnable and atomic: the whole swap happens in one transaction, so a
 * failed re-index leaves the live index untouched rather than half-replaced.
 *
 *   DATABASE_URL=... npm run ingest:load
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { db } from "../src/lib/db";
import { getEmbedder, toVectorLiteral, estimateTokens } from "../src/lib/embeddings";
import { excludedIds } from "../src/lib/exclusions";

const DATA_DIR = process.env.OUT_DIR ?? new URL("../data", import.meta.url).pathname;
/**
 * Token budget per embedding request. Sized to sit under the 10K-per-minute
 * allowance that a Voyage account without a payment method gets, so a fresh
 * key indexes the corpus unattended instead of dying on the first batch.
 * Raise it with EMBED_BATCH_TOKENS once the account has standard limits.
 */
const EMBED_BATCH_TOKENS = Number(process.env.EMBED_BATCH_TOKENS ?? 8_000);
const EMBED_PAUSE_MS = Number(process.env.EMBED_PAUSE_MS ?? 21_000);

interface Chunk { id: string; docId: string; index: number; text: string; heading: string | null; locator: string | null }
interface Doc { docId: string; title: string; sourceLabel: string; sourceType: string; origin: string; module: string | null; format: string; words: number; sha256: string }

const chunks: Chunk[] = readFileSync(join(DATA_DIR, "corpus.jsonl"), "utf-8").trim().split("\n").map((l) => JSON.parse(l));
const { documents } = JSON.parse(readFileSync(join(DATA_DIR, "manifest.json"), "utf-8")) as { documents: Doc[] };

const pool = db();

async function main() {
  // Anything removed through the admin page stays removed. Without this the
  // corpus is rebuilt from the source folder and a deliberate deletion is
  // silently undone.
  const excluded = await excludedIds().catch(() => new Set<string>());
  const keptDocs = documents.filter((d) => !excluded.has(d.docId));
  const keptIds = new Set(keptDocs.map((d) => d.docId));
  const keptChunks = chunks.filter((c) => keptIds.has(c.docId));
  if (excluded.size) {
    console.log(`Skipping ${documents.length - keptDocs.length} document(s) excluded from the admin page.`);
  }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // Carry embeddings across the rebuild.
    //
    // Chunk ids are deterministic (`docId#index`), so a chunk whose text is
    // unchanged is the same chunk and its vector is still valid. Without this
    // the cascade from DELETE took every embedding with it, and editing one
    // sentence of the knowledge base meant re-embedding all 982 chunks —
    // roughly forty minutes on a free-tier key, with the bot degraded
    // throughout. That makes self-serve editing unusable, which is the whole
    // point of the corrections file.
    await client.query(`
      CREATE TEMP TABLE kept_embeddings ON COMMIT DROP AS
      SELECT id, md5(text) AS text_md5, embedding
        FROM chunks WHERE embedding IS NOT NULL`);
    const { rows: [carry] } = await client.query<{ n: string }>("SELECT count(*)::text AS n FROM kept_embeddings");

    // Replace wholesale. A document removed from the source policy must
    // actually disappear from the index.
    await client.query("DELETE FROM documents");

    for (const d of keptDocs) {
      await client.query(
        `INSERT INTO documents (doc_id, title, source_label, source_type, origin, module, format, words, sha256)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [d.docId, d.title, d.sourceLabel, d.sourceType, d.origin, d.module, d.format, d.words, d.sha256],
      );
    }

    for (let i = 0; i < keptChunks.length; i += 500) {
      const batch = keptChunks.slice(i, i + 500);
      const values = batch.map((_, j) => `($${j * 6 + 1},$${j * 6 + 2},$${j * 6 + 3},$${j * 6 + 4},$${j * 6 + 5},$${j * 6 + 6})`).join(",");
      await client.query(
        `INSERT INTO chunks (id, doc_id, chunk_index, text, heading, locator) VALUES ${values}`,
        batch.flatMap((c) => [c.id, c.docId, c.index, c.text, c.heading, c.locator]),
      );
    }
    // Restore vectors for chunks that came back byte-identical.
    const { rowCount: restored } = await client.query(`
      UPDATE chunks c SET embedding = k.embedding
        FROM kept_embeddings k
       WHERE k.id = c.id AND k.text_md5 = md5(c.text)`);
    console.log(`Reused ${restored ?? 0} of ${carry!.n} existing embeddings; ${
      chunks.length - (restored ?? 0)} chunk(s) need embedding.`);

    // Expand each chunk's tsvector into per-term frequencies. `unnest(tsvector)`
    // yields (lexeme, positions, weights); the position array length is the
    // term frequency. Stopwords are already gone — to_tsvector dropped them.
    await client.query("DELETE FROM chunk_terms");
    await client.query(
      `INSERT INTO chunk_terms (chunk_id, word, tf)
       SELECT c.id, u.lexeme, GREATEST(COALESCE(array_length(u.positions, 1), 1), 1)
         FROM chunks c, unnest(c.tsv) AS u`,
    );
    await client.query(
      `UPDATE chunks c SET token_count = COALESCE(t.n, 0)
         FROM (SELECT chunk_id, SUM(tf)::int AS n FROM chunk_terms GROUP BY chunk_id) t
        WHERE t.chunk_id = c.id`,
    );

    // Corpus IDF, recomputed from the freshly loaded tsvectors.
    await client.query("DELETE FROM lexeme_stats");
    await client.query(
      `INSERT INTO lexeme_stats (word, ndoc)
       SELECT word, ndoc FROM ts_stat('SELECT tsv FROM chunks')`,
    );
    await client.query(
      `INSERT INTO corpus_stats (id, chunk_count, avg_len, updated_at)
       SELECT true, count(*), COALESCE(avg(token_count), 0), now() FROM chunks
       ON CONFLICT (id) DO UPDATE
          SET chunk_count = EXCLUDED.chunk_count, avg_len = EXCLUDED.avg_len, updated_at = now()`,
    );

    await client.query("COMMIT");
    const { rows: [stats] } = await client.query<{ n: string }>("SELECT count(*) AS n FROM lexeme_stats");
    console.log(`Loaded ${keptDocs.length} documents / ${keptChunks.length} chunks / ${stats!.n} lexemes`);
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }

  const embedder = getEmbedder();
  if (!embedder) {
    console.warn(
      "\nWARNING: no VOYAGE_API_KEY or OPENAI_API_KEY set. Chunks are loaded but NOT embedded.\n" +
        "Retrieval will run lexical-only (Postgres full-text). That answers the eligibility\n" +
        "questions correctly today, but set a key and re-run to enable the vector arm.",
    );
    await pool.end();
    return;
  }

  console.log(`Embedding ${chunks.length} chunks with ${embedder.name}...`);

  // Group by token budget, not by count.
  const batches: Chunk[][] = [];
  let current: Chunk[] = [];
  let tokens = 0;
  for (const c of chunks) {
    const t = estimateTokens(c.heading ? `${c.heading}\n\n${c.text}` : c.text);
    if (tokens + t > EMBED_BATCH_TOKENS && current.length) {
      batches.push(current);
      current = [];
      tokens = 0;
    }
    current.push(c);
    tokens += t;
  }
  if (current.length) batches.push(current);

  const totalTokens = chunks.reduce((n, c) => n + estimateTokens(c.text), 0);
  console.log(
    `  ~${totalTokens.toLocaleString()} tokens in ${batches.length} batches` +
      (EMBED_PAUSE_MS > 0 ? `, pausing ${EMBED_PAUSE_MS / 1000}s between (rate limit)` : ""),
  );

  let done = 0;
  for (const [i, batch] of batches.entries()) {
    const vectors = await embedder.embed(
      // The heading is part of what the chunk is about; embed it with the body.
      batch.map((c) => (c.heading ? `${c.heading}\n\n${c.text}` : c.text)),
      "document",
    );
    await Promise.all(
      batch.map((c, j) => pool.query("UPDATE chunks SET embedding = $1 WHERE id = $2", [toVectorLiteral(vectors[j]!), c.id])),
    );
    done += batch.length;
    process.stdout.write(`\r  ${done}/${chunks.length} chunks`);
    if (i < batches.length - 1 && EMBED_PAUSE_MS > 0) {
      await new Promise((r) => setTimeout(r, EMBED_PAUSE_MS));
    }
  }
  console.log("\nEmbeddings complete.");
  await pool.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
