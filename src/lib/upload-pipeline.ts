import { createHash } from "node:crypto";
import { db } from "@/lib/db";
import { extractAsync } from "@ingest/lib/extract";
import { chunkDocument } from "@ingest/lib/chunk";
import { getEmbedder, toVectorLiteral, estimateTokens } from "@/lib/embeddings";
import { refreshStats } from "@/lib/corpus-stats";

/**
 * Takes an uploaded file from bytes to answerable, updating its status as it
 * goes so the admin page can show where it is.
 *
 * Every stage writes its status before starting, so a crash leaves a row that
 * says what it was doing rather than a silent stall. The document itself is
 * inserted in one transaction at the end: a half-indexed document that answers
 * questions from three of its ten pages is worse than one that is not there.
 */
export type UploadStatus = "queued" | "extracting" | "chunking" | "embedding" | "live" | "failed" | "removed";

const SUPPORTED = [".pdf", ".docx", ".pptx", ".txt", ".md"];
export const MAX_BYTES = 25 * 1024 * 1024;

export const isSupported = (filename: string): boolean =>
  SUPPORTED.some((ext) => filename.toLowerCase().endsWith(ext));

const slug = (s: string) =>
  s.toLowerCase().replace(/\.[a-z0-9]+$/, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 70);

async function setStatus(id: string, status: UploadStatus, extra: Record<string, unknown> = {}): Promise<void> {
  const sets = ["status = $2", "updated_at = now()"];
  const values: unknown[] = [id, status];
  for (const [k, v] of Object.entries(extra)) {
    values.push(v);
    sets.push(`${k} = $${values.length}`);
  }
  await db().query(`UPDATE uploads SET ${sets.join(", ")} WHERE id = $1`, values);
}

export async function processUpload(uploadId: string): Promise<void> {
  const { rows } = await db().query<{ filename: string; content: Buffer }>(
    "SELECT filename, content FROM uploads WHERE id = $1",
    [uploadId],
  );
  const upload = rows[0];
  if (!upload) throw new Error(`upload ${uploadId} not found`);

  try {
    await setStatus(uploadId, "extracting", { error: null });
    const segments = await extractAsync(upload.filename, new Uint8Array(upload.content));
    const words = segments.reduce((n, s) => n + (s.text.match(/\S+/g)?.length ?? 0), 0);
    if (!words) throw new Error("No readable text found. A scanned PDF needs OCR before it can be indexed.");

    await setStatus(uploadId, "chunking", { words });
    const title = upload.filename.replace(/\.[a-z0-9]+$/i, "");
    // Namespaced so an upload can never collide with an ingested document.
    const docId = `upload-${slug(upload.filename)}`;
    const chunks = chunkDocument(docId, segments);
    if (!chunks.length) throw new Error("Extracted text produced no chunks");

    const client = await db().connect();
    try {
      await client.query("BEGIN");
      await client.query("DELETE FROM documents WHERE doc_id = $1", [docId]);
      await client.query(
        `INSERT INTO documents (doc_id, title, source_label, source_type, origin, module, format, words, sha256)
         VALUES ($1,$2,$3,'program_document',$4,NULL,$5,$6,$7)`,
        [docId, title, title, `upload:${upload.filename}`,
         upload.filename.split(".").pop() ?? "bin", words,
         createHash("sha256").update(upload.content).digest("hex")],
      );
      for (const c of chunks) {
        await client.query(
          "INSERT INTO chunks (id, doc_id, chunk_index, text, heading, locator) VALUES ($1,$2,$3,$4,$5,$6)",
          [c.id, c.docId, c.index, c.text, c.heading, c.locator],
        );
      }
      await refreshStats(client, docId);
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }

    await setStatus(uploadId, "embedding", { doc_id: docId, chunk_count: chunks.length });
    await embedPending();
    await setStatus(uploadId, "live");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[upload ${uploadId}] failed:`, message);
    await setStatus(uploadId, "failed", { error: message.slice(0, 500) });
  }
}

/** Embeds anything without a vector. Only the new chunks, never the whole corpus. */
export async function embedPending(): Promise<number> {
  const embedder = getEmbedder();
  if (!embedder) return 0;
  const { rows } = await db().query<{ id: string; text: string; heading: string | null }>(
    "SELECT id, text, heading FROM chunks WHERE embedding IS NULL ORDER BY id",
  );
  if (!rows.length) return 0;

  const body = (r: { text: string; heading: string | null }) => (r.heading ? `${r.heading}\n\n${r.text}` : r.text);
  const budget = Number(process.env.EMBED_BATCH_TOKENS ?? 8_000);
  let done = 0;
  let batch: typeof rows = [];
  let tokens = 0;

  const flush = async () => {
    if (!batch.length) return;
    const vectors = await embedder.embed(batch.map(body), "document");
    await Promise.all(
      batch.map((r, j) => db().query("UPDATE chunks SET embedding = $1 WHERE id = $2", [toVectorLiteral(vectors[j]!), r.id])),
    );
    done += batch.length;
    batch = [];
    tokens = 0;
  };

  for (const r of rows) {
    const t = estimateTokens(body(r));
    if (tokens + t > budget && batch.length) await flush();
    batch.push(r);
    tokens += t;
  }
  await flush();
  return done;
}

/** Removes a document from the index but keeps the upload row for the audit trail. */
export async function removeUpload(uploadId: string): Promise<void> {
  const { rows } = await db().query<{ doc_id: string | null }>("SELECT doc_id FROM uploads WHERE id = $1", [uploadId]);
  const docId = rows[0]?.doc_id;
  const client = await db().connect();
  try {
    await client.query("BEGIN");
    if (docId) await client.query("DELETE FROM documents WHERE doc_id = $1", [docId]);
    await client.query("UPDATE uploads SET status = 'removed', doc_id = NULL, updated_at = now() WHERE id = $1", [uploadId]);
    await refreshStats(client, docId ?? undefined);
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}
