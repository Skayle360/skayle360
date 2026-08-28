import { Resend } from "resend";
import { db } from "./db";
import { MAIL_FROM, escalationRecipient, canSendEscalationEmail, ESCALATION_LIVE, ESCALATION_TEST_INBOX, CONTACT_EMAIL } from "../../config/app";
import type { Escalation } from "./sinks/lead-sink";

/**
 * PENDING CLIENT ANSWER: DNS access for a sending domain.
 *
 * Until the sending domain is verified, escalations go to ESCALATION_TEST_INBOX
 * so the whole path is exercised for real. The escalation row is written to
 * Postgres before the send is attempted, so a mail failure degrades to a
 * queued row rather than a lost question — `escalations_pending_idx` is the
 * retry queue.
 *
 * When DNS lands: verify `notify.skayle360.com`, NOT the root domain. The root
 * SPF record already carries several mechanisms and one more include risks the
 * 10-lookup limit, which invalidates the whole record and would take the
 * client's existing mail down with it.
 */

let resend: Resend | null = null;
function client(): Resend | null {
  if (!process.env.RESEND_API_KEY) return null;
  if (!resend) resend = new Resend(process.env.RESEND_API_KEY);
  return resend;
}

function renderTranscript(turns: Array<{ role: string; content: string }>): string {
  return turns.map((t) => `${t.role === "user" ? "Visitor" : "Assistant"}: ${t.content}`).join("\n\n");
}

const REASON_TEXT: Record<Escalation["reason"], string> = {
  no_citation: "The assistant produced an answer it could not cite to the knowledge base, so it was withheld.",
  thin_retrieval: "Nothing in the knowledge base matched the question.",
  model_requested: "The assistant judged that this needs a person.",
  tool_error: "An internal error interrupted the conversation.",
};

export async function sendEscalation(
  escalationId: string,
  e: Escalation,
  extra: { uncitedDraft?: string[]; sourceUrl?: string | null } = {},
): Promise<void> {
  const to = escalationRecipient();
  const lead = e.lead;
  const contact = lead?.email
    ? `${lead.name ?? "Name not given"} <${lead.email}>${lead.company ? ` — ${lead.company}` : ""}`
    : "No contact details captured.";

  const body = [
    `A visitor asked something the SCALE UP assistant could not answer.`,
    ``,
    `Why: ${REASON_TEXT[e.reason]}`,
    ``,
    `Question:`,
    e.question,
    ``,
    `Contact:`,
    contact,
    ``,
    extra.sourceUrl ? `Page: ${extra.sourceUrl}\n` : "",
    `Conversation:`,
    renderTranscript(e.transcript),
    ``,
    extra.uncitedDraft?.length
      ? `Withheld draft (the assistant wrote this but could not cite it — treat as unverified):\n${extra.uncitedDraft.join("\n")}\n`
      : "",
    `—`,
    `Escalation ${escalationId}`,
    ESCALATION_LIVE ? "" : `Sent to the test inbox. Live recipient once DNS is ready: ${CONTACT_EMAIL}`,
  ]
    .filter(Boolean)
    .join("\n");

  if (!canSendEscalationEmail()) {
    await mark(escalationId, "failed", "sending not enabled: set ESCALATION_TEST_INBOX, or ESCALATION_LIVE=true to mail the client directly");
    console.warn(
      `[escalation ${escalationId}] queued — sending is not enabled. Set ESCALATION_TEST_INBOX ` +
        `(pre-launch) or ESCALATION_LIVE=true (once notify.skayle360.com is verified). ` +
        `Row is durable and retryable from escalations_pending_idx.`,
    );
    return;
  }

  const mailer = client();
  if (!mailer) {
    await mark(escalationId, "failed", "RESEND_API_KEY is not set");
    console.warn(`[escalation ${escalationId}] queued — no RESEND_API_KEY. Would have emailed ${to}.`);
    return;
  }

  try {
    const { error } = await mailer.emails.send({
      from: MAIL_FROM,
      to,
      subject: `SCALE UP assistant needs you: "${e.question.slice(0, 60)}"`,
      text: body,
      replyTo: lead?.email ?? undefined,
    });
    if (error) throw new Error(error.message);
    await mark(escalationId, "sent", null);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await mark(escalationId, "failed", message);
    console.error(`[escalation ${escalationId}] send failed:`, message);
  }
}

async function mark(id: string, status: "sent" | "failed", error: string | null): Promise<void> {
  await db().query("UPDATE escalations SET email_status = $1, email_error = $2 WHERE id = $3", [status, error, id]);
}
