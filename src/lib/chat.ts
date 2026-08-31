import Anthropic from "@anthropic-ai/sdk";
import { MODEL, bookingLink } from "@config/app";
import { buildSystemPrompt } from "@/lib/prompt";
import { loadSettings } from "@/lib/settings";
import { TOOL_DEFINITIONS, runTool, type ToolContext } from "@/lib/tools";
import { retrieve, isThin, type RetrievedChunk } from "@/lib/retrieval";
import { enforceGrounding, shouldShowBlock, detectCohortConflict, type SourceRef } from "@/lib/grounding";
import { leadSink, type Escalation } from "@/lib/sinks";
import { sendEscalation } from "@/lib/email";

let anthropic: Anthropic | null = null;
const client = (): Anthropic => (anthropic ??= new Anthropic());

/** Enables the `fallbacks: "default"` scalar form. */
const BETAS = ["server-side-fallback-2026-07-01"];
const MAX_TOOL_ROUNDS = 4;

export type ChatEvent =
  | { type: "text"; text: string }
  | { type: "sources"; sources: SourceRef[] }
  | { type: "booking"; url: string }
  | { type: "escalated" }
  | { type: "done"; grounded: boolean; usage: UsageSummary }
  | { type: "error"; message: string };

export interface UsageSummary {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
}

export interface ChatRequest {
  conversationId: string;
  history: Array<{ role: "user" | "assistant"; content: string }>;
  message: string;
  sourceUrl: string | null;
}

/**
 * Retrieved chunks become `document` blocks with citations enabled, so the API
 * returns character offsets into the exact text we supplied. That is what makes
 * grounding checkable rather than merely requested.
 *
 * `context` carries the locator: it is visible to the model for phrasing but is
 * not part of the citable body, so a page number can never be cited as if it
 * were a fact from the document.
 */
function toDocuments(chunks: RetrievedChunk[]): Anthropic.Beta.BetaRequestDocumentBlock[] {
  return chunks.map((c) => ({
    type: "document" as const,
    source: { type: "text" as const, media_type: "text/plain" as const, data: c.text },
    title: c.sourceLabel,
    context:
      [
        c.sourceType === "correction"
          ? "AUTHORITATIVE CORRECTION — written by Chris. Overrides the website and the training documents wherever they disagree with this."
          : null,
        c.locator ? `Location: ${c.locator}` : null,
        c.heading ? `Section: ${c.heading}` : null,
      ]
        .filter(Boolean)
        .join(" · ") || undefined,
    citations: { enabled: true },
  }));
}

/**
 * Prompt caching is not an optimisation here — without it every message repays
 * the full system prompt and tool definitions, roughly ten times the cost.
 *
 * Render order is tools -> system -> messages, so the breakpoint goes on the
 * last tool and on the system block. Everything volatile (the question, the
 * retrieved documents) lives in `messages`, after the breakpoint, where it
 * cannot invalidate the prefix.
 */
function cachedTools(): Anthropic.Beta.BetaToolUnion[] {
  return TOOL_DEFINITIONS.map((tool, i) => ({
    ...tool,
    ...(i === TOOL_DEFINITIONS.length - 1 ? { cache_control: { type: "ephemeral" as const } } : {}),
  }));
}

async function cachedSystem(): Promise<Anthropic.Beta.BetaTextBlockParam[]> {
  const blocks = await loadSettings();
  return [{ type: "text", text: buildSystemPrompt(blocks), cache_control: { type: "ephemeral" } }];
}

export async function runChat(req: ChatRequest, emit: (e: ChatEvent) => void): Promise<void> {
  const chunks = await retrieve(req.message);

  const ctx: ToolContext = {
    conversationId: req.conversationId,
    sourceUrl: req.sourceUrl,
    transcript: [...req.history, { role: "user", content: req.message }],
    lead: {
      conversationId: req.conversationId,
      name: null, email: null, company: null, interest: null,
      bookingRoute: null, sourceUrl: req.sourceUrl,
    },
  };

  // Nothing matched at all — calling the model would only invite a guess.
  if (isThin(chunks)) {
    await escalate(req, ctx, "thin_retrieval", [], emit);
    emit({ type: "text", text: escalationReply(ctx, "That isn't something Skayle 360 has published, so I'd only be guessing.") });
    emit({ type: "done", grounded: false, usage: emptyUsage() });
    return;
  }

  // A correction in play settles the matter, so it is not a conflict to report.
  const hasCorrection = chunks.some((c) => c.sourceType === "correction");
  const conflict = hasCorrection ? [] : detectCohortConflict(chunks);
  if (conflict.length) {
    // PENDING CLIENT ANSWER: the corpus advertises more than one cohort.
    console.warn(
      `[cohort-conflict] conversation=${req.conversationId} retrieval returned ${conflict.join(" and ")} — ` +
        `the knowledge base disagrees with itself. Fix the source and re-run ingest; do not hardcode a date.`,
    );
  }

  const messages: Anthropic.Beta.BetaMessageParam[] = [
    ...req.history.map((h) => ({ role: h.role, content: h.content }) as Anthropic.Beta.BetaMessageParam),
    {
      role: "user",
      content: [
        ...toDocuments(chunks),
        {
          type: "text",
          text:
            `Visitor's question: ${req.message}\n\n` +
            `Answer only from the documents above, and cite them.` +
            (conflict.length
              ? `\n\nNote: the documents give more than one upcoming cohort (${conflict.join(", ")}). Do not choose between them — say the site lists more than one and offer the call to confirm.`
              : ""),
        },
      ],
    },
  ];

  // Resolved once per conversation turn, not per tool round: the prompt is the
  // cached prefix, so it must be byte-identical across the whole exchange.
  const answerText: string[] = [];
  const emitText = (text: string) => {
    answerText.push(text);
    emit({ type: "text", text });
  };
  const systemPrompt = await cachedSystem();
  const usage: UsageSummary = emptyUsage();
  // Whether a tool did the work this exchange — a booking link fetched, details
  // captured, a question handed to Chris.
  //
  // The turn after a tool runs is an acknowledgement, not an answer: "here's a
  // link to book", "thanks, got it". It carries no citations because it claims
  // nothing, so judging it as an answer escalated the two most direct
  // intentions a visitor can have. "How do I book a meeting?" fetched the link
  // and then escalated the sentence offering it.
  let toolActed = false;
  // Whether a booking button has actually been sent to the widget this turn.
  let bookingOffered = false;
  let grounded = false;
  let anyText = false;

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const stream = client().beta.messages.stream({
      model: MODEL,
      max_tokens: 16000,
      betas: BETAS,
      fallbacks: "default",
      thinking: { type: "adaptive" },
      output_config: { effort: "low" },
      system: systemPrompt,
      tools: cachedTools(),
      messages,
    });

    // The answer is buffered, judged, then shown whole — never streamed
    // sentence-by-sentence with a per-sentence citation filter.
    //
    // That filter was the first design and it broke the writing: the model
    // cites the load-bearing clauses and writes ordinary connective prose
    // around them, so suppressing uncited blocks left quoted fragments jammed
    // together. Grounding is a property of the whole answer, so it is decided
    // on the whole answer. The cost is that text appears at once rather than
    // typing in; for two or three short paragraphs that is the right trade
    // against ever showing an uncited claim.
    for await (const event of stream) {
      if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
        // Consumed to keep the stream flowing; nothing is emitted yet.
      }
    }

    const message = await stream.finalMessage();
    accumulate(usage, message.usage);

    if (message.stop_reason === "refusal") {
      // The whole fallback chain declined. Hand off rather than say nothing.
      await escalate(req, ctx, "model_requested", [], emit);
      if (!anyText) emit({ type: "text", text: escalationReply(ctx, "That one's better answered by a person.") });
      emit({ type: "done", grounded: false, usage });
      return;
    }

    const verdict = enforceGrounding(message.content, chunks);

    const toolUses = message.content.filter(
      (b): b is Anthropic.Beta.BetaToolUseBlock => b.type === "tool_use",
    );

    if (verdict.text) {
      if (verdict.grounded) {
        emitText((anyText ? "\n\n" : "") + verdict.text);
        if (verdict.sources.length) emit({ type: "sources", sources: verdict.sources });
        grounded = true;
        anyText = true;
      } else if (grounded || toolActed || toolUses.length > 0) {
        // Text that accompanies or follows a tool call. These are lead-ins and
        // sign-offs — "here's the link to book fifteen minutes", "I've sent
        // that to Chris" — which carry no citations because they assert
        // nothing.
        //
        // `toolUses.length` covers the turn the tool is requested on, because
        // `toolActed` is only set once the tool has run. Without it the lead-in
        // was dropped and the reply began mid-thought: "He'll come back to you
        // by email" with nothing before it to say who or why.
        //
        // Short ones are shown; anything long enough to smuggle in a claim is
        // dropped, but neither case escalates.
        const CLOSING_LINE_LIMIT = 320;
        if (verdict.text.length <= CLOSING_LINE_LIMIT) {
          emitText((anyText ? "\n\n" : "") + verdict.text);
          anyText = true;
        } else {
          console.warn(
            `[grounding] dropped a long uncited follow-up on conversation ${req.conversationId} ` +
              `(${verdict.text.length} chars); the cited answer above still stands`,
          );
        }
      } else if (!toolUses.length && !toolActed) {
        // Asserted something it could not support: exactly the failure this bot
        // exists to prevent. Withhold the draft entirely and hand off.
        console.warn(
          `[grounding] withheld a ${verdict.reason} answer on conversation ${req.conversationId} ` +
            `(cited ratio ${verdict.citedRatio.toFixed(2)})`,
        );
        await escalate(req, ctx, "no_citation", verdict.uncited, emit);
        emit({ type: "text", text: escalationReply(ctx, "I can't answer that without guessing, and I'd rather not.") });
        emit({ type: "done", grounded: false, usage });
        return;
      }
    }

    if (!toolUses.length) {
      ensureBookingLink(answerText.join(" "), bookingOffered, emit);
      emit({ type: "done", grounded, usage });
      return;
    }

    messages.push({ role: "assistant", content: message.content });
    const results: Anthropic.Beta.BetaToolResultBlockParam[] = [];

    // All tool results must return in a single user message, or parallel tool
    // use silently degrades on later turns.
    for (const use of toolUses) {
      try {
        const outcome = await runTool(use.name, use.input, ctx);
        if (outcome.bookingUrl) {
          emit({ type: "booking", url: outcome.bookingUrl });
          bookingOffered = true;
        }
        if (outcome.escalated) emit({ type: "escalated" });
        toolActed = true;
        results.push({ type: "tool_result", tool_use_id: use.id, content: outcome.result });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[tool ${use.name}] failed:`, msg);
        results.push({ type: "tool_result", tool_use_id: use.id, content: `Failed: ${msg}`, is_error: true });
      }
    }
    messages.push({ role: "user", content: results });
  }

  emit({ type: "done", grounded, usage });
}


/**
 * What to say when the assistant hands a question to Chris.
 *
 * Two versions, because promising a reply the system cannot deliver is worse
 * than admitting the gap. If nothing contactable has been captured, Chris has
 * no way to reach this visitor — so the message asks, rather than assuring them
 * of a follow-up that will never arrive.
 *
 * Deliberately free of internal vocabulary. A visitor does not know or care
 * what "the Skayle 360 material" is; they asked a question and want to know
 * whether they will get an answer.
 */
function escalationReply(ctx: ToolContext, opening: string): string {
  const reachable = Boolean(ctx.lead.email);
  return reachable
    ? `${opening} I've passed it to Chris and he'll email you.`
    : `${opening} Chris can answer it properly — if you leave your name, email and company I'll send it straight to him. Otherwise you can book a quick call with him and ask directly.`;
}


/**
 * Keeps the promise the answer made.
 *
 * The prompt tells the model to fetch a booking link whenever it invites
 * someone to a call, but a prompt is guidance, not a guarantee — in practice it
 * complies on some turns and not others, leaving replies that say "here's a
 * link to book fifteen minutes with Chris" with no button underneath. That is
 * the exact dead end the client reported.
 *
 * So the promise is checked against what was actually sent, and the link is
 * supplied if the model forgot. Cheap, and it cannot be forgotten.
 */
const PROMISES_A_LINK =
  /\b(here'?s? (?:a|the) link|link to book|book (?:a|fifteen|15)|booking link|link below|link above|schedule a call|book that call)\b/i;

function ensureBookingLink(
  text: string,
  alreadyOffered: boolean,
  emit: (e: ChatEvent) => void,
): void {
  if (alreadyOffered || !PROMISES_A_LINK.test(text)) return;
  console.warn("[booking] the reply promised a link the model did not fetch; supplying the default");
  emit({ type: "booking", url: bookingLink("general").url });
}

async function escalate(
  req: ChatRequest,
  ctx: ToolContext,
  reason: Escalation["reason"],
  uncited: string[],
  emit: (e: ChatEvent) => void,
): Promise<void> {
  const escalation: Escalation = {
    conversationId: req.conversationId,
    question: req.message,
    context: reason === "no_citation" ? "The assistant drafted an answer it could not cite." : null,
    reason,
    transcript: ctx.transcript,
    lead: ctx.lead,
  };
  try {
    const leadId = ctx.lead.email || ctx.lead.name ? (await leadSink().saveLead(ctx.lead)).id : null;
    const { id } = await leadSink().saveEscalation({ ...escalation, leadId });
    void sendEscalation(id, escalation, { uncitedDraft: uncited, sourceUrl: req.sourceUrl });
    emit({ type: "escalated" });
  } catch (err) {
    console.error("[escalate] failed to record:", err instanceof Error ? err.message : err);
  }
}

const emptyUsage = (): UsageSummary => ({
  inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0,
});

function accumulate(into: UsageSummary, u: Anthropic.Beta.BetaUsage): void {
  into.inputTokens += u.input_tokens ?? 0;
  into.outputTokens += u.output_tokens ?? 0;
  into.cacheReadInputTokens += u.cache_read_input_tokens ?? 0;
  into.cacheCreationInputTokens += u.cache_creation_input_tokens ?? 0;
}
