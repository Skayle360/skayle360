import { db } from "@/lib/db";
import type { Escalation, Lead, LeadSink } from "@/lib/sinks/lead-sink";

/** The source of truth. Every other destination is a mirror of this table. */
export class PostgresLeadSink implements LeadSink {
  readonly name = "postgres";
  readonly authoritative = true;

  /**
   * Upsert on conversation_id: a visitor who gives a name early and an email
   * later is one lead, not two. COALESCE keeps already-known fields when a
   * later call omits them.
   */
  async saveLead(lead: Lead): Promise<{ id: string }> {
    const { rows } = await db().query<{ id: string }>(
      `INSERT INTO leads (conversation_id, name, email, company, interest, booking_route, source_url)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (conversation_id) DO UPDATE SET
         name          = COALESCE(EXCLUDED.name,          leads.name),
         email         = COALESCE(EXCLUDED.email,         leads.email),
         company       = COALESCE(EXCLUDED.company,       leads.company),
         interest      = COALESCE(EXCLUDED.interest,      leads.interest),
         booking_route = COALESCE(EXCLUDED.booking_route, leads.booking_route),
         source_url    = COALESCE(EXCLUDED.source_url,    leads.source_url),
         mirror_status = CASE WHEN leads.mirror_status = 'synced' THEN 'pending' ELSE leads.mirror_status END
       RETURNING id`,
      [lead.conversationId, lead.name, lead.email, lead.company, lead.interest, lead.bookingRoute, lead.sourceUrl],
    );
    return { id: rows[0]!.id };
  }

  /** Records whether the mirror write landed, so the backfill knows what to skip. */
  async markMirrored(conversationId: string, ok: boolean, error?: string): Promise<void> {
    await db().query(
      `UPDATE leads SET mirror_status = $2, mirror_error = $3,
              mirrored_at = CASE WHEN $2 = 'synced' THEN now() ELSE mirrored_at END
        WHERE conversation_id = $1`,
      [conversationId, ok ? "synced" : "failed", ok ? null : (error ?? "unknown")],
    );
  }

  async saveEscalation(e: Escalation & { leadId?: string | null }): Promise<{ id: string }> {
    const { rows } = await db().query<{ id: string }>(
      `INSERT INTO escalations (conversation_id, question, context, reason, transcript, lead_id)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
      [e.conversationId, e.question, e.context, e.reason, JSON.stringify(e.transcript), e.leadId ?? null],
    );
    return { id: rows[0]!.id };
  }
}
