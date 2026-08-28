import { db } from "@/lib/db";

/**
 * History for anything editable through the admin page — the prompt blocks and
 * Chris's notes alike.
 *
 * A version is written *before* the new value takes effect, so the trail always
 * contains what was live previously. Restoring writes a new version rather than
 * rewinding, so the history is append-only and a restore is itself recoverable.
 */
export interface Version {
  id: string;
  key: string;
  value: string;
  created_at: string;
  created_by: string | null;
  restored_from: string | null;
}

const KEEP_PER_KEY = 50;

/** Records the value that is being replaced. Call before writing the new one. */
export async function recordVersion(key: string, previous: string, who: string, restoredFrom?: string): Promise<void> {
  await db().query(
    "INSERT INTO setting_versions (key, value, created_by, restored_from) VALUES ($1,$2,$3,$4)",
    [key, previous, who, restoredFrom ?? null],
  );
  // Keep the trail useful rather than unbounded; fifty edits is far more
  // history than anyone reviews, and this table holds full prompt text.
  await db().query(
    `DELETE FROM setting_versions
      WHERE key = $1 AND id NOT IN (
        SELECT id FROM setting_versions WHERE key = $1 ORDER BY created_at DESC LIMIT $2)`,
    [key, KEEP_PER_KEY],
  );
}

export async function listVersions(key: string, limit = 20): Promise<Version[]> {
  const { rows } = await db().query<Version>(
    `SELECT id::text, key, value, created_at::text, created_by, restored_from::text
       FROM setting_versions WHERE key = $1 ORDER BY created_at DESC LIMIT $2`,
    [key, limit],
  );
  return rows;
}

export async function getVersion(id: string): Promise<Version | null> {
  const { rows } = await db().query<Version>(
    `SELECT id::text, key, value, created_at::text, created_by, restored_from::text
       FROM setting_versions WHERE id = $1`,
    [id],
  );
  return rows[0] ?? null;
}
