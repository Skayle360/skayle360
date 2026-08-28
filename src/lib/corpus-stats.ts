type Queryable = { query: (text: string, values?: unknown[]) => Promise<unknown> };

/**
 * Refreshes the search statistics after a change.
 *
 * `chunk_terms` is per-chunk, so only the affected document's rows need
 * rewriting. `lexeme_stats` and `corpus_stats` are corpus-wide and must be
 * recomputed either way — but each is a single server-side query, which is
 * cheap.
 *
 * The earlier version deleted and reinserted all 134,266 term rows for every
 * change. Over a link with 300ms of latency that turned a three-sentence edit
 * into a two-minute save, and it timed out. Scoping the expensive part to one
 * document makes an edit near-instant while keeping the statistics exact.
 */
export async function refreshStats(client: Queryable, docId?: string): Promise<void> {
  if (docId) {
    await client.query("DELETE FROM chunk_terms WHERE chunk_id IN (SELECT id FROM chunks WHERE doc_id = $1)", [docId]);
    await client.query(
      `INSERT INTO chunk_terms (chunk_id, word, tf)
       SELECT c.id, u.lexeme, GREATEST(COALESCE(array_length(u.positions, 1), 1), 1)
         FROM chunks c, unnest(c.tsv) AS u
        WHERE c.doc_id = $1`,
      [docId],
    );
    await client.query(
      `UPDATE chunks c SET token_count = COALESCE(t.n, 0)
         FROM (SELECT chunk_id, SUM(tf)::int AS n FROM chunk_terms GROUP BY chunk_id) t
        WHERE t.chunk_id = c.id AND c.doc_id = $1`,
      [docId],
    );
  } else {
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
  }

  // Corpus-wide, but one query each: a word's document frequency changes for
  // every document when any document changes, so these cannot be scoped.
  await client.query("DELETE FROM lexeme_stats");
  await client.query("INSERT INTO lexeme_stats (word, ndoc) SELECT word, ndoc FROM ts_stat('SELECT tsv FROM chunks')");
  await client.query(
    `INSERT INTO corpus_stats (id, chunk_count, avg_len, updated_at)
     SELECT true, count(*), COALESCE(avg(token_count), 0), now() FROM chunks
     ON CONFLICT (id) DO UPDATE
        SET chunk_count = EXCLUDED.chunk_count, avg_len = EXCLUDED.avg_len, updated_at = now()`,
  );
}
