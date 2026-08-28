import { db } from "@/lib/db";
import { getEmbedder, toVectorLiteral } from "@/lib/embeddings";
import { chunkDocument } from "@ingest/lib/chunk";
import { findCohortMentions, auditCohorts } from "@ingest/lib/cohort";
import { crawlSite, type CrawledPage } from "@ingest/lib/crawl-core";
import { fetchKnowledgeDoc } from "@/lib/knowledge-doc";
import { createHash } from "node:crypto";

/**
 * Re-crawls the website and replaces only the `website` documents.
 *
 * Scoped on purpose. The weekly cron runs on Vercel, where the source PDFs and
 * decks do not exist — a full re-ingest there would delete the document corpus.
 * Document changes go through `npm run ingest` locally; the site, which the
 * client edits in Webflow and which is the only home of the Roundtable pages
 * and the cohort dates, syncs on its own schedule.
 */
export interface SyncResult {
  pages: number;
  chunks: number;
  embedded: number;
  missing: string[];
  knowledgeDoc: string | null;
  cohorts: { distinct: string[]; conflict: boolean };
}

const slug = (s: string) =>
  s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 80);
const wordCount = (s: string) => (s.match(/\S+/g) ?? []).length;

export async function syncWebsite(): Promise<SyncResult> {
  const { pages, missing } = await crawlSite();
  if (!pages.length) throw new Error("crawl returned no pages — refusing to delete the existing website index");

  // The client's own knowledge doc refreshes on the same schedule as his site,
  // so an edit reaches the bot within the week without anyone running anything.
  const knowledgeDoc = await fetchKnowledgeDoc().catch((err) => {
    console.warn(`[website-sync] knowledge doc unreadable: ${(err as Error).message}`);
    return null;
  });

  const client = await db().connect();
  const inserted: Array<{ id: string; text: string; heading: string | null }> = [];
  const cohortMentions = pages.flatMap((p: CrawledPage) => findCohortMentions(p.url, p.text));

  try {
    await client.query("BEGIN");
    // Preserve vectors for text that has not changed, so a weekly sync does not
    // silently strip the embeddings off everything it touches.
    await client.query(`
      CREATE TEMP TABLE kept_embeddings ON COMMIT DROP AS
      SELECT id, md5(text) AS text_md5, embedding FROM chunks WHERE embedding IS NOT NULL`);

    // Only the website slice, plus the client's doc if we could read it.
    await client.query("DELETE FROM documents WHERE source_type = 'website'");
    if (knowledgeDoc) {
      await client.query("DELETE FROM documents WHERE origin = $1", [knowledgeDoc.url]);
    }

    for (const page of pages) {
      const docId = slug(`site ${page.path === "/" ? "home" : page.path}`);
      const chunks = chunkDocument(docId, [{ ordinal: null, ordinalLabel: null, text: page.text }]);
      if (!chunks.length) continue;

      await client.query(
        `INSERT INTO documents (doc_id, title, source_label, source_type, origin, module, format, words, sha256)
         VALUES ($1,$2,$3,'website',$4,NULL,'html',$5,$6)`,
        [docId, page.title, `skayle360.com${page.path}`, page.url, wordCount(page.text),
         createHash("sha256").update(page.text).digest("hex")],
      );
      for (const c of chunks) {
        await client.query(
          "INSERT INTO chunks (id, doc_id, chunk_index, text, heading, locator) VALUES ($1,$2,$3,$4,$5,$6)",
          [c.id, c.docId, c.index, c.text, c.heading, c.locator],
        );
        inserted.push({ id: c.id, text: c.text, heading: c.heading });
      }
    }

    if (knowledgeDoc) {
      const docId = slug("client knowledge");
      const chunks = chunkDocument(docId, [{ ordinal: null, ordinalLabel: null, text: knowledgeDoc.text }]);
      await client.query(
        `INSERT INTO documents (doc_id, title, source_label, source_type, origin, module, format, words, sha256)
         VALUES ($1,$2,$3,'correction',$4,NULL,'gdoc',$5,$6)`,
        [docId, knowledgeDoc.title, knowledgeDoc.title, knowledgeDoc.url, wordCount(knowledgeDoc.text),
         createHash("sha256").update(knowledgeDoc.text).digest("hex")],
      );
      for (const c of chunks) {
        await client.query(
          "INSERT INTO chunks (id, doc_id, chunk_index, text, heading, locator) VALUES ($1,$2,$3,$4,$5,$6)",
          [c.id, c.docId, c.index, c.text, c.heading, c.locator],
        );
        inserted.push({ id: c.id, text: c.text, heading: c.heading });
      }
      cohortMentions.push(...findCohortMentions(knowledgeDoc.title, knowledgeDoc.text));
    }

    await client.query(`
      UPDATE chunks c SET embedding = k.embedding
        FROM kept_embeddings k WHERE k.id = c.id AND k.text_md5 = md5(c.text)`);

    // Term stats cover the whole corpus, so they must be rebuilt whenever any
    // slice changes — a stale IDF silently degrades every lexical query.
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
    await client.query("DELETE FROM lexeme_stats");
    await client.query(
      "INSERT INTO lexeme_stats (word, ndoc) SELECT word, ndoc FROM ts_stat('SELECT tsv FROM chunks')",
    );
    await client.query(
      `INSERT INTO corpus_stats (id, chunk_count, avg_len, updated_at)
       SELECT true, count(*), COALESCE(avg(token_count), 0), now() FROM chunks
       ON CONFLICT (id) DO UPDATE
          SET chunk_count = EXCLUDED.chunk_count, avg_len = EXCLUDED.avg_len, updated_at = now()`,
    );
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }

  let embedded = 0;
  const embedder = getEmbedder();
  if (embedder) {
    // Only what actually needs it — unchanged text kept its vector above.
    const { rows: pending } = await db().query<{ id: string; text: string; heading: string | null }>(
      "SELECT id, text, heading FROM chunks WHERE embedding IS NULL",
    );
    for (let i = 0; i < pending.length; i += 24) {
      const batch = pending.slice(i, i + 24);
      const vectors = await embedder.embed(
        batch.map((c) => (c.heading ? `${c.heading}\n\n${c.text}` : c.text)),
        "document",
      );
      await Promise.all(
        batch.map((c, j) => db().query("UPDATE chunks SET embedding = $1 WHERE id = $2", [toVectorLiteral(vectors[j]!), c.id])),
      );
      embedded += batch.length;
    }
  }

  const cohorts = auditCohorts(cohortMentions);
  if (cohorts.conflict) {
    console.warn(
      `[website-sync] the site advertises ${cohorts.distinct.join(" and ")}. ` +
        `No cohort date is hardcoded, so the bot will decline to choose — but the site needs fixing.`,
    );
  }
  return { pages: pages.length, chunks: inserted.length, embedded, missing, knowledgeDoc: knowledgeDoc?.title ?? null, cohorts };
}
