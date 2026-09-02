import { getDownloadable } from "@/lib/materials";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Serves a file the client has marked downloadable.
 *
 * Public by design — a visitor follows this link from the chat. Only files
 * explicitly flagged in the admin page are reachable; every other upload
 * returns 404, so indexing a document for answers never exposes the file.
 */
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) return new Response("Not found", { status: 404 });

  const file = await getDownloadable(id).catch(() => null);
  if (!file) return new Response("Not found", { status: 404 });

  return new Response(new Uint8Array(file.content), {
    headers: {
      "content-type": file.mediaType,
      // `inline` so a PDF opens in the browser rather than landing in a
      // downloads folder unseen; the filename is still used if they save it.
      "content-disposition": `inline; filename="${file.filename.replace(/"/g, "")}"`,
      "cache-control": "public, max-age=300",
      "x-content-type-options": "nosniff",
    },
  });
}
