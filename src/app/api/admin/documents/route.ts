import { NextRequest } from "next/server";
import { isAuthenticated } from "@/lib/admin-auth";
import { listExclusions, excludeDocument, restoreDocument } from "@/lib/exclusions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

const deny = () => Response.json({ error: "unauthorized" }, { status: 401 });

export async function GET(req: NextRequest) {
  if (!isAuthenticated(req)) return deny();
  return Response.json({ excluded: await listExclusions() });
}

export async function DELETE(req: NextRequest) {
  if (!isAuthenticated(req)) return deny();
  const { docId, reason } = (await req.json().catch(() => ({}))) as { docId?: string; reason?: string };
  if (!docId) return Response.json({ error: "docId required" }, { status: 400 });
  try {
    await excludeDocument(docId, "admin", reason);
    return Response.json({ ok: true });
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : "failed" }, { status: 500 });
  }
}

/** Puts a document back in scope; it returns on the next ingest. */
export async function POST(req: NextRequest) {
  if (!isAuthenticated(req)) return deny();
  const { docId } = (await req.json().catch(() => ({}))) as { docId?: string };
  if (!docId) return Response.json({ error: "docId required" }, { status: 400 });
  await restoreDocument(docId);
  return Response.json({ ok: true });
}
