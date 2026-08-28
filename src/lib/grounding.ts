import type Anthropic from "@anthropic-ai/sdk";
import type { RetrievedChunk } from "./retrieval";

/**
 * Grounding is enforced mechanically here, not by asking the prompt nicely.
 *
 * With `citations: {enabled: true}` the response comes back split into text
 * blocks; a block whose sentence is drawn from a document carries a `citations`
 * array. A block with no citations is the model writing from its own weights.
 * We refuse to show those, rather than trusting an instruction the model can
 * drift away from under an unusual question.
 */

export interface SourceRef {
  /** "SCALE UP Syllabus, p. 4" — what the visitor sees. */
  label: string;
  docId: string;
  chunkId: string;
  quote: string;
  origin: string;
}

export interface GroundedAnswer {
  /** Text safe to display. */
  text: string;
  sources: SourceRef[];
  grounded: boolean;
  /** Why it failed, when it did. */
  reason: "ok" | "no_citation" | "thinly_cited" | "empty";
  /** Uncited spans, kept for the escalation email so Chris can see the near-miss. */
  uncited: string[];
  /** Share of the answer's characters that sit inside a cited span. */
  citedRatio: number;
}

/**
 * How much of an answer must be directly cited for the whole answer to be
 * shown.
 *
 * Grounding is judged per *response*, not per sentence. An earlier version
 * suppressed every uncited text block individually, which held the guarantee
 * but destroyed the writing: the model cites the load-bearing clauses and
 * writes ordinary connective prose around them, so dropping the uncited blocks
 * left quoted fragments concatenated without spaces —
 * "physical location in the stateone W-2 Massachusetts employee".
 *
 * The connective prose is not where claims live; the cited clauses are. So the
 * rule is that a response must be substantially cited, and then it is shown
 * whole. A response that writes three paragraphs and cites one clause is still
 * caught.
 */
export const MIN_CITED_RATIO = 0.2;

/**
 * Sentences that assert nothing about the world need no source. Without an
 * exemption, "Happy to help — what kind of business do you run?" would count as
 * an ungrounded factual claim and escalate, which would make the bot unusable.
 *
 * This is a narrow allowlist of safe shapes, not a blacklist of unsafe ones,
 * and it fails closed: anything it is unsure about is withheld. An earlier
 * blacklist version passed "You will definitely be approved." — no digits, no
 * currency, no keyword — which is the single most damaging sentence this bot
 * could emit, since grant approval is the state's call and not ours.
 *
 * Withholding a friendly sentence costs a little warmth. Showing an uncited
 * claim costs the client's credibility, so the trade is not close.
 */
const MAX_SPAN = 180;

/** Domain facts: anything numeric, monetary, or about the offer itself. */
const CLAIM_MARKERS =
  /\d|\$|%|\b(?:covers?|costs?|includes?|requires?|qualif|eligib|grant|hours?|modules?|weeks?|employees?|cohort|starts?|deadline|price|fee|funded)\b/i;

/** Assertions about what is or will be true — the "definitely approved" class. */
const ASSERTION_MARKERS =
  /\b(?:will|won't|would|shall|must|guarantee[ds]?|definitely|certainly|absolutely|approved?|approval|always|never|ensures?|entitled)\b/i;

const ALLOWED_PROPER_NOUNS = /\b(?:I|I'm|I'll|Chris|Skayle|SCALE|UP|Massachusetts)\b/g;

/** A number, a price or a percentage is a claim wherever it appears. */
const HARD_FACTS = /\d|\$|%/;

function isConversational(span: string): boolean {
  const t = span.trim();
  if (!t) return true;
  if (t.length > MAX_SPAN) return false;

  // A number or a price is a claim in any grammatical form.
  if (HARD_FACTS.test(t)) return false;

  // A question asserts nothing, so it is safe to name a topic or use a modal
  // inside one. This must be checked before the marker lists below, both of
  // which fire on ordinary politeness: "what *would* you like to know about
  // the *grant*?" hit two of them, so the bot's own greeting was withheld and
  // escalated to Chris.
  if (t.endsWith("?")) return true;

  // Outside a question, a promise or a domain word means a fact is being stated.
  if (ASSERTION_MARKERS.test(t) || CLAIM_MARKERS.test(t)) return false;

  // Otherwise only short spans, and only when they name nothing in particular:
  // a capitalised token mid-sentence usually means a named thing being asserted.
  if (t.length > 90) return false;
  const stripped = t.replace(ALLOWED_PROPER_NOUNS, "");
  return !/(?<!^)(?<![.!?]\s)\b[A-Z][a-z]{2,}/.test(stripped);
}

/**
 * Per-block display gate, used while streaming: a block reaches the visitor
 * only if it is cited or is plainly conversational. Deciding at block level
 * means an ungrounded claim is never shown and then retracted.
 */
export function shouldShowBlock(text: string, hasCitations: boolean): boolean {
  return hasCitations || isConversational(text);
}

function labelFor(chunk: RetrievedChunk | undefined, fallbackTitle: string): string {
  if (!chunk) return fallbackTitle;
  return chunk.locator ? `${chunk.sourceLabel}, ${chunk.locator}` : chunk.sourceLabel;
}

/**
 * Splits the response into shown text and sources, and decides whether it is
 * safe to show at all.
 *
 * `documents` must be the same array, in the same order, that was sent to the
 * API — citations address documents by index.
 */
export function enforceGrounding(
  blocks: Anthropic.Beta.BetaContentBlock[],
  documents: RetrievedChunk[],
): GroundedAnswer {
  const sources: SourceRef[] = [];
  const seen = new Set<string>();
  const uncited: string[] = [];
  let text = "";
  let citedSpans = 0;
  let citedChars = 0;

  for (const block of blocks) {
    if (block.type !== "text") continue;
    text += block.text;

    const citations = (block as Anthropic.Beta.BetaTextBlock).citations ?? [];
    if (citations.length === 0) {
      if (!isConversational(block.text)) uncited.push(block.text.trim());
      continue;
    }
    citedSpans++;
    citedChars += block.text.length;

    for (const citation of citations) {
      if (!("document_index" in citation)) continue;
      const chunk = documents[citation.document_index];
      const key = chunk?.id ?? String(citation.document_index);
      if (seen.has(key)) continue;
      seen.add(key);
      sources.push({
        label: labelFor(chunk, citation.document_title ?? "Knowledge base"),
        docId: chunk?.docId ?? "",
        chunkId: chunk?.id ?? "",
        quote: "cited_text" in citation ? citation.cited_text : "",
        origin: chunk?.origin ?? "",
      });
    }
  }

  const trimmed = text.trim();
  if (!trimmed) return { text: "", sources: [], grounded: false, reason: "empty", uncited, citedRatio: 0 };

  const citedRatio = citedChars / trimmed.length;

  // A response that asserts something but cites nothing is exactly the failure
  // mode this bot exists to avoid. Escalate rather than show it.
  if (citedSpans === 0 && uncited.length > 0) {
    return { text: trimmed, sources: [], grounded: false, reason: "no_citation", uncited, citedRatio };
  }

  // Mostly-invented with a token citation attached is the subtler version of
  // the same failure, so it is treated the same way.
  if (citedSpans > 0 && uncited.length > 0 && citedRatio < MIN_CITED_RATIO) {
    return { text: trimmed, sources, grounded: false, reason: "thinly_cited", uncited, citedRatio };
  }

  return { text: trimmed, sources, grounded: true, reason: "ok", uncited, citedRatio };
}

/**
 * PENDING CLIENT ANSWER: the site advertises two cohorts at once. When the
 * documents behind an answer disagree, say so instead of picking one.
 */
const COHORT_RE = /\b(winter|spring|summer|fall|autumn)\s+(20\d{2})\b/gi;

export function detectCohortConflict(documents: RetrievedChunk[]): string[] {
  const found = new Set<string>();
  for (const doc of documents) {
    for (const m of doc.text.matchAll(COHORT_RE)) {
      found.add(`${m[1]![0]!.toUpperCase()}${m[1]!.slice(1).toLowerCase()} ${m[2]}`);
    }
  }
  return found.size > 1 ? [...found].sort() : [];
}
