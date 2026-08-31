import type Anthropic from "@anthropic-ai/sdk";
import { bookingLink, BOOKING_ROUTE_NAMES } from "@config/app";
import { leadSink, type Escalation, type Lead } from "@/lib/sinks";
import { sendEscalation } from "@/lib/email";

/**
 * Structured work goes through tools because citations and
 * `output_config.format` are mutually exclusive — sending both returns a 400.
 * Answer text carries citations; lead fields and routing come back as tool
 * calls instead.
 *
 * Definitions are frozen and ordered deterministically: they sit in the cached
 * prefix, so any per-request variation here would silently destroy the cache.
 */
export const TOOL_DEFINITIONS: Anthropic.Tool[] = [
  {
    name: "capture_lead",
    description:
      "Record a visitor's contact details. Call this the moment a visitor volunteers a name, email, or company — you do not need all three, and you must not withhold help until you have them. Calling it again with more detail updates the same record.",
    input_schema: {
      type: "object",
      properties: {
        name: { type: "string", description: "The visitor's name, if given." },
        email: { type: "string", description: "Email address, if given." },
        company: { type: "string", description: "Company or nonprofit name, if given." },
        interest: {
          type: "string",
          description: "One sentence, in your words, on what they are trying to work out. Give Chris something useful to open with.",
        },
      },
      required: [],
      additionalProperties: false,
    },
  },
  {
    name: "get_booking_link",
    description:
      "Return the booking URL to give a visitor. Always call this rather than writing a URL yourself — booking links are configured server-side and change without any change to your instructions.",
    input_schema: {
      type: "object",
      properties: {
        route: {
          type: "string",
          enum: BOOKING_ROUTE_NAMES,
          description:
            "scale_up_cohort for the training program, ceo_roundtable for the CEO or Executive Director roundtables, nonprofit for a nonprofit asking about either, general when unclear.",
        },
      },
      required: ["route"],
      additionalProperties: false,
    },
  },
  {
    name: "escalate_to_human",
    description:
      "Send this conversation to Chris. Call this ONLY when you could not answer: the documents do not cover the question, you cannot cite what you would need to say, or the visitor asked for a person. " +
      "Do NOT call this when you have already answered from the documents — including when the answer is bad news for the visitor. Telling someone they do not qualify IS an answer, and escalating it sends Chris a lead he cannot help. " +
      "Offering the booking link is also not a reason to escalate; the two are separate.",
    input_schema: {
      type: "object",
      properties: {
        question: { type: "string", description: "What the visitor actually wants to know, in one sentence." },
        context: { type: "string", description: "What you already tried, and anything Chris should know before replying." },
      },
      required: ["question"],
      additionalProperties: false,
    },
  },
];

export interface ToolContext {
  conversationId: string;
  sourceUrl: string | null;
  transcript: Array<{ role: string; content: string }>;
  /** Populated as capture_lead fires, so an escalation carries whatever is known. */
  lead: Lead;
}

export interface ToolOutcome {
  result: string;
  /** Surfaced to the widget so it can render a booking button. */
  bookingUrl?: string;
  escalated?: boolean;
  leadCaptured?: boolean;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export async function runTool(name: string, input: unknown, ctx: ToolContext): Promise<ToolOutcome> {
  const args = (input ?? {}) as Record<string, unknown>;
  const str = (k: string): string | null => {
    const v = args[k];
    return typeof v === "string" && v.trim() ? v.trim() : null;
  };

  switch (name) {
    case "capture_lead": {
      const email = str("email");
      // A malformed address is worse than none: it looks like a contactable
      // lead and is not. Record the rest and tell the model plainly.
      const validEmail = email && EMAIL_RE.test(email) ? email : null;
      ctx.lead = {
        ...ctx.lead,
        name: str("name") ?? ctx.lead.name,
        email: validEmail ?? ctx.lead.email,
        company: str("company") ?? ctx.lead.company,
        interest: str("interest") ?? ctx.lead.interest,
      };
      await leadSink().saveLead(ctx.lead);
      return {
        result:
          email && !validEmail
            ? `Saved, but "${email}" is not a valid email address — ask the visitor to confirm it.`
            : "Saved.",
        leadCaptured: true,
      };
    }

    case "get_booking_link": {
      const { route, url } = bookingLink(str("route") ?? "general");
      return { result: JSON.stringify({ route, url }), bookingUrl: url };
    }

    case "escalate_to_human": {
      const question = str("question") ?? ctx.transcript.filter((t) => t.role === "user").at(-1)?.content ?? "(not stated)";
      const escalation: Escalation = {
        conversationId: ctx.conversationId,
        question,
        context: str("context"),
        reason: "model_requested",
        transcript: ctx.transcript,
        lead: ctx.lead,
      };
      // Attach the lead record, so Chris opens the escalation with the
      // visitor's details rather than having to match them up by hand.
      const leadId = ctx.lead.email || ctx.lead.name ? (await leadSink().saveLead(ctx.lead)).id : null;
      const { id } = await leadSink().saveEscalation({ ...escalation, leadId });
      // Fire and forget: a slow mail provider must not stall the visitor's
      // reply. The row is already durable, and failures are retryable from it.
      void sendEscalation(id, escalation, { sourceUrl: ctx.sourceUrl });
      return { result: "Sent to Chris. Tell the visitor he will follow up by email.", escalated: true };
    }

    default:
      return { result: `Unknown tool ${name}.` };
  }
}
