import { NextRequest } from "next/server";
import { syncWebsite } from "../../../../lib/website-sync";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * Weekly website re-crawl. Vercel Cron calls this with CRON_SECRET as a bearer
 * token; the check also covers manual invocation, since this endpoint rewrites
 * part of the index and must not be publicly triggerable.
 */
export async function GET(req: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return Response.json({ error: "CRON_SECRET is not configured" }, { status: 500 });
  if (req.headers.get("authorization") !== `Bearer ${secret}`) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }

  try {
    const result = await syncWebsite();
    return Response.json({ ok: true, ...result });
  } catch (err) {
    const message = err instanceof Error ? err.message : "unknown error";
    console.error("[cron/crawl] failed:", message);
    // The sync is transactional, so a failure leaves the previous index intact.
    return Response.json({ ok: false, error: message }, { status: 500 });
  }
}
