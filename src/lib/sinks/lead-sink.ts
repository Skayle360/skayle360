/**
 * PENDING CLIENT ANSWER: where leads should land (assumed a Google Sheet).
 *
 * Postgres is the source of truth regardless of the answer. Any destination
 * the client names becomes an additional LeadSink implementation and a row in
 * the fan-out below — never a replacement for the database. A Sheet alone
 * loses leads: the API rate-limits, and a human editing the tab while a write
 * lands can drop a row with no error anywhere.
 */

export interface Lead {
  conversationId: string;
  name: string | null;
  email: string | null;
  company: string | null;
  interest: string | null;
  bookingRoute: string | null;
  sourceUrl: string | null;
}

export interface Escalation {
  conversationId: string;
  question: string;
  context: string | null;
  reason: "no_citation" | "thin_retrieval" | "model_requested" | "tool_error";
  transcript: Array<{ role: string; content: string }>;
  lead: Lead | null;
}

export interface LeadSink {
  readonly name: string;
  /** True when this sink holds the authoritative copy. Exactly one must be. */
  readonly authoritative: boolean;
  saveLead(lead: Lead): Promise<{ id: string }>;
  saveEscalation(escalation: Escalation & { leadId?: string | null }): Promise<{ id: string }>;
  /**
   * Records the outcome of a mirror write. Implemented by the authoritative
   * sink only — it owns the `mirror_status` column that the backfill reads.
   */
  markMirrored?(conversationId: string, ok: boolean, error?: string): Promise<void>;
}

/**
 * Writes to the authoritative sink first and fails the request if that write
 * fails. Mirrors are best-effort: a Sheets outage must never cost a lead or
 * surface an error to the visitor.
 */
export class FanOutLeadSink implements LeadSink {
  readonly name = "fan-out";
  readonly authoritative = true;
  private readonly primary: LeadSink;
  private readonly mirrors: LeadSink[];

  constructor(sinks: LeadSink[]) {
    const primary = sinks.find((s) => s.authoritative);
    if (!primary) throw new Error("no authoritative LeadSink configured");
    this.primary = primary;
    this.mirrors = sinks.filter((s) => s !== primary);
  }

  async saveLead(lead: Lead): Promise<{ id: string }> {
    const result = await this.primary.saveLead(lead);
    for (const mirror of this.mirrors) {
      // Fire and forget, but the outcome must be recorded either way: a live
      // write that succeeds and is never marked synced gets written a second
      // time by the next backfill, which is how mirrors grow duplicates.
      mirror
        .saveLead(lead)
        .then(() => this.primary.markMirrored?.(lead.conversationId, true))
        .catch((err) => {
          const message = err instanceof Error ? err.message : String(err);
          console.error(`[lead-sink] mirror ${mirror.name} failed:`, message);
          return this.primary.markMirrored?.(lead.conversationId, false, message);
        })
        .catch((err) => {
          console.error(`[lead-sink] could not record mirror status:`, err instanceof Error ? err.message : err);
        });
    }
    return result;
  }

  async saveEscalation(e: Escalation & { leadId?: string | null }): Promise<{ id: string }> {
    const result = await this.primary.saveEscalation(e);
    for (const mirror of this.mirrors) {
      mirror.saveEscalation(e).catch((err) => {
        console.error(`[lead-sink] mirror ${mirror.name} failed:`, err instanceof Error ? err.message : err);
      });
    }
    return result;
  }
}
