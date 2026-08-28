import { NextRequest } from "next/server";
import { z } from "zod";
import { runChat, type ChatEvent } from "../../../lib/chat";
import { corsHeaders, isAllowedOrigin } from "../../../lib/cors";
import { db } from "../../../lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const Body = z.object({
  conversationId: z.string().uuid(),
  message: z.string().min(1).max(2000),
  history: z
    .array(z.object({ role: z.enum(["user", "assistant"]), content: z.string().max(8000) }))
    .max(40)
    .default([]),
  sourceUrl: z.string().url().max(500).nullable().default(null),
});

export async function OPTIONS(req: NextRequest) {
  return new Response(null, { status: 204, headers: corsHeaders(req.headers.get("origin")) });
}

export async function POST(req: NextRequest) {
  const origin = req.headers.get("origin");
  const headers = corsHeaders(origin);

  // Same-origin requests (the widget page itself) send no Origin header.
  if (origin !== null && !isAllowedOrigin(origin)) {
    return Response.json({ error: "origin not allowed" }, { status: 403, headers });
  }

  let body: z.infer<typeof Body>;
  try {
    body = Body.parse(await req.json());
  } catch {
    return Response.json({ error: "invalid request" }, { status: 400, headers });
  }

  await recordConversation(body.conversationId, body.sourceUrl, req.headers.get("user-agent"));

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (event: ChatEvent) => {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
      };
      const answer: string[] = [];
      try {
        await runChat(
          { conversationId: body.conversationId, history: body.history, message: body.message, sourceUrl: body.sourceUrl },
          (event) => {
            if (event.type === "text") answer.push(event.text);
            if (event.type === "done") {
              // Cache health is only observable per request; a silent
              // invalidation would otherwise cost ~10x with no symptom.
              const { cacheReadInputTokens, inputTokens } = event.usage;
              if (cacheReadInputTokens === 0 && inputTokens > 1000) {
                console.warn(
                  `[cache] no cache read on conversation ${body.conversationId} ` +
                    `(input=${inputTokens}). Expected after the first request — check for a changed system prompt or tool list.`,
                );
              }
              void persistTurns(body, answer.join(""), event.grounded);
            }
            send(event);
          },
        );
      } catch (err) {
        const message = err instanceof Error ? err.message : "unknown error";
        console.error("[chat] failed:", message);
        send({ type: "error", message: "Something went wrong on our end. Please try again." });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      ...headers,
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
    },
  });
}

async function recordConversation(id: string, sourceUrl: string | null, userAgent: string | null): Promise<void> {
  try {
    await db().query(
      `INSERT INTO conversations (id, source_url, user_agent) VALUES ($1,$2,$3)
       ON CONFLICT (id) DO UPDATE SET last_seen_at = now()`,
      [id, sourceUrl, userAgent],
    );
  } catch (err) {
    // Transcript logging must never take the chat down with it.
    console.error("[conversation] record failed:", err instanceof Error ? err.message : err);
  }
}

async function persistTurns(body: z.infer<typeof Body>, answer: string, grounded: boolean): Promise<void> {
  try {
    await db().query(
      `INSERT INTO turns (conversation_id, role, content, grounded) VALUES ($1,'user',$2,NULL), ($1,'assistant',$3,$4)`,
      [body.conversationId, body.message, answer, grounded],
    );
  } catch (err) {
    console.error("[turns] persist failed:", err instanceof Error ? err.message : err);
  }
}
