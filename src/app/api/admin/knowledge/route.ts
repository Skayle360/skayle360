import { NextRequest } from "next/server";
import { isAuthenticated } from "../../../../lib/admin-auth";
import { loadKnowledge, saveKnowledge } from "../../../../lib/knowledge-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

const deny = () => Response.json({ error: "unauthorized" }, { status: 401 });

export async function GET(req: NextRequest) {
  if (!isAuthenticated(req)) return deny();
  return Response.json({ text: await loadKnowledge() });
}

export async function PUT(req: NextRequest) {
  if (!isAuthenticated(req)) return deny();
  const { text } = (await req.json().catch(() => ({}))) as { text?: string };
  if (typeof text !== "string") return Response.json({ error: "text required" }, { status: 400 });
  if (text.length > 40_000) return Response.json({ error: "That is too long — keep it to facts that change." }, { status: 400 });
  try {
    const result = await saveKnowledge(text, "admin");
    return Response.json({ ok: true, ...result });
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : "save failed" }, { status: 400 });
  }
}
