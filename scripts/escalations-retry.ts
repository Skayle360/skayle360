/**
 * Re-sends escalations that were written to Postgres but never emailed.
 *
 * `escalations_pending_idx` is the retry queue: sendEscalation() always writes
 * the row before it attempts the mail, so an unconfigured mailer, a bad API key
 * or a Resend outage leaves a durable row rather than a lost question. This is
 * how those rows get delivered once sending works.
 *
 *   npm run escalations:retry              # send the whole backlog
 *   npm run escalations:retry -- --limit=1 # send the oldest one only
 *   npm run escalations:retry -- --dry-run # show what would be sent
 */
import { db } from "@/lib/db";
import { sendEscalation } from "@/lib/email";
import { escalationRecipient, canSendEscalationEmail, ESCALATION_LIVE, MAIL_FROM } from "@config/app";
import type { Escalation } from "@/lib/sinks/lead-sink";

const arg = (name: string): string | null => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : null;
};
const dryRun = process.argv.includes("--dry-run");
const limit = Number(arg("limit") ?? 100);

if (!canSendEscalationEmail() && !dryRun) {
  console.error(
    "Sending is not enabled. Set ESCALATION_TEST_INBOX to mail yourself, or ESCALATION_LIVE=true to mail the client.",
  );
  process.exit(1);
}

const { rows } = await db().query<{
  id: string;
  conversation_id: string;
  question: string;
  context: string | null;
  reason: Escalation["reason"];
  transcript: Array<{ role: string; content: string }>;
  email_status: string;
  email_error: string | null;
  created_at: Date;
  name: string | null;
  email: string | null;
  company: string | null;
  source_url: string | null;
}>(
  `SELECT e.id, e.conversation_id, e.question, e.context, e.reason, e.transcript,
          e.email_status, e.email_error, e.created_at,
          l.name, l.email, l.company, l.source_url
     FROM escalations e
     LEFT JOIN leads l ON l.id = e.lead_id
    WHERE e.email_status <> 'sent'
    ORDER BY e.created_at ASC
    LIMIT $1`,
  [limit],
);

console.log(`from:      ${MAIL_FROM}`);
console.log(`recipient: ${escalationRecipient()}${ESCALATION_LIVE ? "  (LIVE — this is the client)" : "  (test inbox)"}`);
console.log(`queued:    ${rows.length}\n`);

if (rows.length === 0) {
  console.log("Nothing to retry.");
  process.exit(0);
}

for (const r of rows) {
  const label = `${r.created_at.toISOString().slice(0, 16)}  ${r.reason.padEnd(16)} ${JSON.stringify(r.question.slice(0, 60))}`;
  if (dryRun) {
    console.log(`would send  ${label}`);
    continue;
  }

  const escalation: Escalation = {
    conversationId: r.conversation_id,
    question: r.question,
    context: r.context,
    reason: r.reason,
    transcript: r.transcript,
    lead:
      r.email || r.name
        ? {
            conversationId: r.conversation_id,
            name: r.name,
            email: r.email,
            company: r.company,
            interest: null,
            bookingRoute: null,
            sourceUrl: r.source_url,
          }
        : null,
  };

  await sendEscalation(r.id, escalation, { sourceUrl: r.source_url });

  const { rows: after } = await db().query<{ email_status: string; email_error: string | null }>(
    "SELECT email_status, email_error FROM escalations WHERE id = $1",
    [r.id],
  );
  const status = after[0]?.email_status ?? "unknown";
  console.log(`${status === "sent" ? "sent      " : "FAILED    "}  ${label}`);
  if (status !== "sent" && after[0]?.email_error) console.log(`            ${after[0].email_error}`);
}

process.exit(0);
