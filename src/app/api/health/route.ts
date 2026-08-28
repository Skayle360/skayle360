import { db } from "../../../lib/db";
import { getEmbedder } from "../../../lib/embeddings";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Cheap enough for an uptime check, specific enough to catch an empty index. */
export async function GET() {
  try {
    const { rows } = await db().query<{ chunks: string; embedded: string; docs: string; ingested: string | null }>(
      `SELECT (SELECT count(*) FROM chunks)                        AS chunks,
              (SELECT count(*) FROM chunks WHERE embedding IS NOT NULL) AS embedded,
              (SELECT count(*) FROM documents)                     AS docs,
              (SELECT max(ingested_at)::text FROM documents)       AS ingested`,
    );
    const r = rows[0]!;
    const chunks = Number(r.chunks);
    return Response.json({
      ok: chunks > 0,
      documents: Number(r.docs),
      chunks,
      embeddedChunks: Number(r.embedded),
      retrievalMode: Number(r.embedded) > 0 ? "hybrid" : "lexical-only",
      embedder: getEmbedder()?.name ?? null,
      lastIngest: r.ingested,
    }, { status: chunks > 0 ? 200 : 503 });
  } catch (err) {
    return Response.json({ ok: false, error: err instanceof Error ? err.message : "unknown" }, { status: 503 });
  }
}
