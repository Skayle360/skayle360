import { db } from "./db";
import { chunkDocument } from "../../ingest/lib/chunk";
import { embedPending } from "./upload-pipeline";
import { createHash } from "node:crypto";
import { refreshStats } from "./corpus-stats";
import { recordVersion } from "./versions";

/**
 * The client-editable knowledge entry, stored in the database and edited
 * through the admin page.
 *
 * This is the same authoritative source as knowledge/00-corrections.md — it
 * outranks the website and the training documents wherever they disagree — but
 * it can be changed without a repository, a command, or a developer. That is
 * the whole of the client's fifth requirement: "I can update the knowledge
 * myself."
 *
 * Saving re-indexes only this one document. Everything else keeps its
 * embeddings, so an edit costs seconds rather than the forty minutes a full
 * re-index would.
 */
export const KNOWLEDGE_KEY = "client_knowledge";
export const KNOWLEDGE_DOC_ID = "client-knowledge";

const STARTER = `# Current cohort

The Winter 2027 cohort runs from January 19, 2027 to March 25, 2027.
Enrolment is open now.

# Anything else people keep asking

Add facts here in plain sentences. Anything written here overrides the website
and the training documents, so use it for things that change — dates, prices,
what is currently open.
`;

export async function loadKnowledge(): Promise<string> {
  const { rows } = await db().query<{ value: string }>("SELECT value FROM settings WHERE key = $1", [KNOWLEDGE_KEY]);
  return rows[0]?.value ?? STARTER;
}

export interface SaveResult {
  chunks: number;
  /** Always 0 — embedding is deferred so the save returns immediately. */
  embedded: number;
}

export async function saveKnowledge(text: string, who: string, restoredFrom?: string): Promise<SaveResult> {
  const body = text.trim();
  if (!body) throw new Error("Knowledge cannot be empty — clearing it would remove facts the assistant relies on");

  // Keep the previous text before replacing it. A wrong date typed here is
  // repeated confidently by the assistant, so being able to see and undo the
  // last edit matters more here than anywhere else in the system.
  const previous = await loadKnowledge();
  if (previous !== body) await recordVersion(KNOWLEDGE_KEY, previous, who, restoredFrom);

  await db().query(
    `INSERT INTO settings (key, value, updated_by) VALUES ($1,$2,$3)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now(), updated_by = EXCLUDED.updated_by`,
    [KNOWLEDGE_KEY, body, who],
  );

  const chunks = chunkDocument(KNOWLEDGE_DOC_ID, [{ ordinal: null, ordinalLabel: null, text: body }]);
  const client = await db().connect();
  try {
    await client.query("BEGIN");
    // Keep vectors for any paragraph that did not change, so a small edit does
    // not re-embed the whole entry.
    await client.query(`
      CREATE TEMP TABLE kept ON COMMIT DROP AS
      SELECT id, md5(text) AS h, embedding FROM chunks WHERE doc_id = $1 AND embedding IS NOT NULL`,
      [KNOWLEDGE_DOC_ID]);
    await client.query("DELETE FROM documents WHERE doc_id = $1", [KNOWLEDGE_DOC_ID]);
    await client.query(
      `INSERT INTO documents (doc_id, title, source_label, source_type, origin, module, format, words, sha256)
       VALUES ($1, 'Chris''s notes', 'Chris''s notes', 'correction', 'admin page', NULL, 'md', $2, $3)`,
      [KNOWLEDGE_DOC_ID, (body.match(/\S+/g) ?? []).length, createHash("sha256").update(body).digest("hex")],
    );
    for (const c of chunks) {
      await client.query(
        "INSERT INTO chunks (id, doc_id, chunk_index, text, heading, locator) VALUES ($1,$2,$3,$4,$5,$6)",
        [c.id, c.docId, c.index, c.text, c.heading, c.locator],
      );
    }
    await client.query(
      "UPDATE chunks c SET embedding = k.embedding FROM kept k WHERE k.id = c.id AND k.h = md5(c.text)");

    // Only this document's term rows need rewriting; the corpus totals are
    // one query each.
    await refreshStats(client, KNOWLEDGE_DOC_ID);

    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }

  // Embedding runs after the response, not inside it.
  //
  // The note is already answerable the moment the transaction commits, because
  // keyword search does not need vectors. Embedding does, and on a rate-limited
  // key it can take a minute — which turned a three-sentence edit into a
  // request that timed out while the save had in fact succeeded.
  void embedPending().catch((err) => {
    console.warn("[knowledge] embedding deferred:", err instanceof Error ? err.message : err);
  });
  return { chunks: chunks.length, embedded: 0 };
}
