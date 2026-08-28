/**
 * Every verified constant and every pending-client-answer seam lives here.
 * Nothing in src/ hardcodes a URL, an address, or a cohort date.
 */

function env(name: string, fallback: string): string {
  const v = process.env[name];
  return v && v.trim() ? v.trim() : fallback;
}

/** Verified 2026-08-27: returns 200. */
export const BOOKING_URL = env("BOOKING_URL", "https://calendly.com/chrisciunci/scale-up-discussion");

/**
 * PENDING CLIENT ANSWER: which contact email visitors see.
 * Default is the address the client confirmed.
 */
export const CONTACT_EMAIL = env("CONTACT_EMAIL", "cciunci@skayle360.com");

/** Where escalations land. */
export const ESCALATION_EMAIL = env("ESCALATION_EMAIL", CONTACT_EMAIL);

/**
 * PENDING CLIENT ANSWER: DNS access for a sending domain.
 * Until the subdomain exists, escalations go to ESCALATION_TEST_INBOX so the
 * logic is exercised end to end without depending on unverified DNS.
 *
 * Plan when DNS lands: send from `notify.skayle360.com`, NOT the root domain.
 * The root SPF record already carries several mechanisms and adding another
 * include risks the 10-lookup limit, which fails the whole record — taking the
 * client's existing mail down with it.
 */
export const ESCALATION_TEST_INBOX = process.env.ESCALATION_TEST_INBOX ?? null;
export const MAIL_FROM = env("MAIL_FROM", "SCALE UP Assistant <assistant@notify.skayle360.com>");

/**
 * Mailing the client's real address requires an explicit opt-in. Without it, a
 * deploy that has a Resend key but no test inbox configured would start sending
 * to Chris from an unverified domain — mail that lands in spam at best, and
 * that nobody asked for while the project is still pre-launch. Fail toward the
 * test inbox instead.
 */
export const ESCALATION_LIVE = process.env.ESCALATION_LIVE === "true";

export function escalationRecipient(): string {
  if (ESCALATION_LIVE) return ESCALATION_EMAIL;
  if (ESCALATION_TEST_INBOX) return ESCALATION_TEST_INBOX;
  return ESCALATION_EMAIL; // reported only; sending is blocked below
}

/** Whether sending is permitted at all right now. */
export const canSendEscalationEmail = (): boolean => ESCALATION_LIVE || ESCALATION_TEST_INBOX !== null;

/**
 * Booking routes. Every route resolves to the same Calendly link today; the map
 * exists so adding a dedicated nonprofit or roundtable link later is a config
 * edit rather than a code change.
 *
 * The live site links to `.../scale-up-grant-call`, which 404s. Do not restore it.
 */
export const BOOKING_ROUTES = {
  scale_up_cohort: BOOKING_URL,
  ceo_roundtable: BOOKING_URL,
  nonprofit: BOOKING_URL,
  general: BOOKING_URL,
} as const satisfies Record<string, string>;

export type BookingRoute = keyof typeof BOOKING_ROUTES;
export const BOOKING_ROUTE_NAMES = Object.keys(BOOKING_ROUTES) as BookingRoute[];

export function bookingLink(route: string): { route: BookingRoute; url: string } {
  const key = (BOOKING_ROUTE_NAMES as string[]).includes(route) ? (route as BookingRoute) : "general";
  return { route: key, url: BOOKING_ROUTES[key] };
}

/** Widget embed origins. Anything else is refused by the API route. */
export const ALLOWED_ORIGINS = env("ALLOWED_ORIGINS", "https://skayle360.com,https://skayle360.webflow.io")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

export const MODEL = "claude-opus-5";

/**
 * Retrieval weighting by what a source is *about*.
 *
 * The corpus holds two different things. A small part describes the offering —
 * the website, the syllabus, the program summary, Chris's bio. The large part
 * is teaching material: a 61,000-word ebook, 46 blog posts, five module decks,
 * all *about* business topics rather than about SCALE UP.
 *
 * Visitors ask about the offering. The index is roughly ten to one against
 * them. Measured effect: "does this actually work? any proof?" returned
 * chapters on proving value to your own customers, because the corpus has far
 * more of that than it has of the results page carrying 34 exit surveys and 16
 * client videos. Same for eligibility questions, which drowned in Module 2's
 * people-management content.
 *
 * These are nudges, not filters — teaching material still wins when the
 * question is genuinely about a framework. Tune with
 * ingest/probe/pg-retrieval-test.ts.
 */
export const SOURCE_WEIGHTS: Readonly<Record<string, number>> = {
  correction: 2.5,        // the client's own overrides settle any disagreement
  website: 1.6,           // pages that exist to describe the offering
  template_catalog: 1.0,
  program_document: 1.0,  // mixed: the syllabus is about the program, the ebook is not
  module_deck: 1.0,
  blog_post: 0.85,        // written to attract readers, not to describe the program
};

/**
 * Documents that describe the offering, regardless of their source type.
 * Needed because `program_document` covers both the syllabus and the ebook.
 */
export const PROGRAM_DOC_IDS: readonly string[] = [
  "scale-up-training-syllabus",
  "scale-up-program-summary",
  "chris-ciunci-bio",
];
export const PROGRAM_DOC_BOOST = 1.6;

/** Retrieval shape. Top-K is what actually reaches the model as documents. */
export const RETRIEVAL = {
  candidatesPerArm: 40,
  topK: 8,
  /**
   * Floor for "retrieval returned nothing usable".
   *
   * Deliberately low. Measured on this corpus (ingest/probe/threshold-probe.ts),
   * BM25 scores for answerable questions run 5.0-21.2 and for unanswerable ones
   * 0.0-11.4 — the distributions overlap, so no score threshold separates
   * "we can answer this" from "we cannot". Term overlap is not answerability.
   *
   * So this is only a cheap pre-filter that skips an API call when nothing
   * matched at all. Real grounding is enforced after the model responds, by
   * requiring citations (src/lib/grounding.ts). Raising this number would
   * suppress answerable questions long before it caught unanswerable ones.
   */
  minLexScore: 1.0,
  minSemScore: 0.35,
} as const;
