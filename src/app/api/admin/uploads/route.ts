import { NextRequest } from "next/server";
import { createHash } from "node:crypto";
import { isAuthenticated } from "../../../../lib/admin-auth";
import { db } from "../../../../lib/db";
import { processUpload, removeUpload, isSupported, MAX_BYTES } from "../../../../lib/upload-pipeline";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

const deny = () => Response.json({ error: "unauthorized" }, { status: 401 });

/** Everything the admin page shows: uploads plus what is already indexed. */
export async function GET(req: NextRequest) {
  if (!isAuthenticated(req)) return deny();
  const { rows: uploads } = await db().query(
    `SELECT id, filename, media_type, size_bytes, status, error, doc_id, words, chunk_count, created_at, updated_at
       FROM uploads WHERE status <> 'removed' ORDER BY created_at DESC`,
  );
  const { rows: documents } = await db().query(
    `SELECT d.doc_id, d.title, d.source_type, d.words, d.origin,
            count(c.id)::int AS chunks,
            count(c.embedding)::int AS embedded
       FROM documents d LEFT JOIN chunks c USING (doc_id)
      GROUP BY d.doc_id, d.title, d.source_type, d.words, d.origin
      ORDER BY d.source_type, d.title`,
  );
  const { rows: excluded } = await db().query(
    "SELECT doc_id, title, reason, excluded_at::text FROM excluded_documents ORDER BY excluded_at DESC",
  );
  const { rows: totals } = await db().query(
    `SELECT (SELECT count(*) FROM documents)::int AS documents,
            (SELECT count(*) FROM chunks)::int AS chunks,
            (SELECT count(*) FROM chunks WHERE embedding IS NOT NULL)::int AS embedded`,
  );
  return Response.json({ uploads, documents, excluded, totals: totals[0] });
}

export async function POST(req: NextRequest) {
  if (!isAuthenticated(req)) return deny();

  const form = await req.formData().catch(() => null);
  const file = form?.get("file");
  if (!(file instanceof File)) return Response.json({ error: "No file supplied" }, { status: 400 });
  if (!isSupported(file.name)) {
    return Response.json({ error: `Unsupported file type. Accepts PDF, DOCX, PPTX, TXT, MD.` }, { status: 400 });
  }
  if (file.size > MAX_BYTES) {
    return Response.json({ error: `File is ${(file.size / 1e6).toFixed(1)}MB; the limit is 25MB.` }, { status: 400 });
  }

  const bytes = Buffer.from(await file.arrayBuffer());
  const sha = createHash("sha256").update(bytes).digest("hex");

  const { rows: existing } = await db().query<{ id: string; filename: string }>(
    "SELECT id, filename FROM uploads WHERE sha256 = $1 AND status <> 'removed'",
    [sha],
  );
  if (existing[0]) {
    return Response.json(
      { error: `Already uploaded as "${existing[0].filename}". Remove it first to replace it.` },
      { status: 409 },
    );
  }

  const { rows } = await db().query<{ id: string }>(
    `INSERT INTO uploads (filename, media_type, size_bytes, sha256, content, uploaded_by)
     VALUES ($1,$2,$3,$4,$5,'admin') RETURNING id`,
    [file.name, file.type || "application/octet-stream", file.size, sha, bytes],
  );
  const id = rows[0]!.id;

  // Processing continues after the response: extraction plus embedding takes
  // longer than a request should be held open, and the page polls for status.
  void processUpload(id);

  return Response.json({ id, status: "queued" }, { status: 202 });
}

export async function DELETE(req: NextRequest) {
  if (!isAuthenticated(req)) return deny();
  const { id } = (await req.json().catch(() => ({}))) as { id?: string };
  if (!id) return Response.json({ error: "id required" }, { status: 400 });
  try {
    await removeUpload(id);
    return Response.json({ ok: true });
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : "failed" }, { status: 500 });
  }
}
