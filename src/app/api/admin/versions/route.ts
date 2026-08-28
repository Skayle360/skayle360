import { NextRequest } from "next/server";
import { isAuthenticated } from "../../../../lib/admin-auth";
import { listVersions, getVersion } from "../../../../lib/versions";
import { EDITABLE, saveSetting, type SettingKey } from "../../../../lib/settings";
import { KNOWLEDGE_KEY, saveKnowledge } from "../../../../lib/knowledge-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

const deny = () => Response.json({ error: "unauthorized" }, { status: 401 });
const known = (key: string) => key === KNOWLEDGE_KEY || key in EDITABLE;

export async function GET(req: NextRequest) {
  if (!isAuthenticated(req)) return deny();
  const key = req.nextUrl.searchParams.get("key");
  if (!key || !known(key)) return Response.json({ error: "unknown key" }, { status: 400 });
  return Response.json({ versions: await listVersions(key) });
}

/** Restores an earlier version by writing it as a new one. */
export async function POST(req: NextRequest) {
  if (!isAuthenticated(req)) return deny();
  const { id } = (await req.json().catch(() => ({}))) as { id?: string };
  if (!id) return Response.json({ error: "id required" }, { status: 400 });

  const version = await getVersion(id);
  if (!version) return Response.json({ error: "version not found" }, { status: 404 });

  try {
    if (version.key === KNOWLEDGE_KEY) await saveKnowledge(version.value, "admin", id);
    else await saveSetting(version.key as SettingKey, version.value, "admin", id);
    return Response.json({ ok: true, restored: version.created_at });
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : "restore failed" }, { status: 500 });
  }
}
