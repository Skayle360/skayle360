import { db } from "@/lib/db";
import { refreshStats } from "@/lib/corpus-stats";

/**
 * Documents taken out of the knowledge base through the admin page.
 *
 * Kept as a list rather than only deleted, because the ingested corpus is
 * rebuilt from the source folder on every `npm run ingest`. Without this, a
 * blog post removed for giving bad answers would quietly return on the next
 * re-index, and nobody would notice until a visitor saw it again.
 */
export interface Excluded { doc_id: string; title: string | null; reason: string | null; excluded_at: string }

export async function listExclusions(): Promise<Excluded[]> {
  const { rows } = await db().query<Excluded>(
    "SELECT doc_id, title, reason, excluded_at::text FROM excluded_documents ORDER BY excluded_at DESC",
  );
  return rows;
}

export async function excludedIds(): Promise<Set<string>> {
  const { rows } = await db().query<{ doc_id: string }>("SELECT doc_id FROM excluded_documents");
  return new Set(rows.map((r) => r.doc_id));
}

/** Removes a document now, and records it so a re-ingest does not restore it. */
export async function excludeDocument(docId: string, who: string, reason?: string): Promise<void> {
  const client = await db().connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query<{ title: string }>("SELECT title FROM documents WHERE doc_id = $1", [docId]);
    await client.query(
      `INSERT INTO excluded_documents (doc_id, title, reason, excluded_by) VALUES ($1,$2,$3,$4)
       ON CONFLICT (doc_id) DO UPDATE SET reason = EXCLUDED.reason, excluded_at = now()`,
      [docId, rows[0]?.title ?? null, reason ?? null, who],
    );
    // Chunks, vectors and term rows all cascade from the document row.
    await client.query("DELETE FROM documents WHERE doc_id = $1", [docId]);
    await client.query("UPDATE uploads SET status = 'removed', doc_id = NULL WHERE doc_id = $1", [docId]);
    await refreshStats(client);
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

/** Puts a document back in scope. It returns on the next ingest. */
export async function restoreDocument(docId: string): Promise<void> {
  await db().query("DELETE FROM excluded_documents WHERE doc_id = $1", [docId]);
}
