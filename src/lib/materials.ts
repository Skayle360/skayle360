import { db } from "@/lib/db";

export interface Material {
  id: string;
  name: string;
  filename: string;
  mediaType: string;
  sizeBytes: number;
  url: string;
}

/** Files the client has chosen to let visitors download. */
export async function listMaterials(): Promise<Material[]> {
  const { rows } = await db().query<{
    id: string; filename: string; display_name: string | null; media_type: string; size_bytes: number;
  }>(
    `SELECT id, filename, display_name, media_type, size_bytes
       FROM uploads WHERE downloadable = true AND status = 'live'
      ORDER BY COALESCE(display_name, filename)`,
  );
  return rows.map((r) => ({
    id: r.id,
    name: r.display_name ?? r.filename.replace(/\.[a-z0-9]+$/i, ""),
    filename: r.filename,
    mediaType: r.media_type,
    sizeBytes: r.size_bytes,
    url: `/api/files/${r.id}`,
  }));
}

export async function getDownloadable(id: string): Promise<
  { filename: string; mediaType: string; content: Buffer } | null
> {
  const { rows } = await db().query<{ filename: string; media_type: string; content: Buffer }>(
    `SELECT filename, media_type, content FROM uploads
      WHERE id = $1 AND downloadable = true AND status = 'live'`,
    [id],
  );
  if (!rows[0]) return null;
  // Best-effort: a failed counter update must not fail the download.
  db().query("UPDATE uploads SET download_count = download_count + 1 WHERE id = $1", [id]).catch(() => {});
  return { filename: rows[0].filename, mediaType: rows[0].media_type, content: rows[0].content };
}
