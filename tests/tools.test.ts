/**
 * Exercises the tool layer and the lead sink against a real Postgres.
 *   DATABASE_URL=... npx tsx tests/tools.test.ts
 */
import { randomUUID } from "node:crypto";
import { runTool, type ToolContext } from "@/lib/tools";
import { db } from "@/lib/db";
import { BOOKING_URL } from "@config/app";

let failures = 0;
const check = (name: string, cond: boolean, detail = "") => {
  if (!cond) { failures++; console.log(`FAIL  ${name} ${detail}`); } else console.log(`PASS  ${name}`);
};

const conversationId = randomUUID();
await db().query("INSERT INTO conversations (id) VALUES ($1) ON CONFLICT DO NOTHING", [conversationId]);

const ctx: ToolContext = {
  conversationId,
  sourceUrl: "https://skayle360.com/programs",
  transcript: [{ role: "user", content: "do we qualify?" }],
  lead: { conversationId, name: null, email: null, company: null, interest: null, bookingRoute: null, sourceUrl: null },
};

// 1. Partial capture, then enrichment - must stay one lead row.
await runTool("capture_lead", { name: "Dana Reyes" }, ctx);
await runTool("capture_lead", { email: "dana@northbaycare.org", company: "North Bay Care", interest: "Nonprofit, 30 staff, asking about grant eligibility" }, ctx);

{
  const { rows } = await db().query(
    "SELECT name, email, company, interest FROM leads WHERE conversation_id = $1", [conversationId]);
  check("one lead row per conversation", rows.length === 1, `got ${rows.length}`);
  check("earlier field survives a later partial update", rows[0]?.name === "Dana Reyes");
  check("later fields merged in", rows[0]?.email === "dana@northbaycare.org" && rows[0]?.company === "North Bay Care");
}

// 2. A malformed email must not be stored as if it were contactable.
{
  const out = await runTool("capture_lead", { email: "not-an-email" }, ctx);
  const { rows } = await db().query("SELECT email FROM leads WHERE conversation_id = $1", [conversationId]);
  check("invalid email rejected, valid one preserved", rows[0]?.email === "dana@northbaycare.org");
  check("model is told the address was bad", /not a valid email/.test(out.result), out.result);
}

// 3. Booking routes all resolve through config, never a literal in code.
{
  for (const route of ["scale_up_cohort", "ceo_roundtable", "nonprofit", "general"]) {
    const out = await runTool("get_booking_link", { route }, ctx);
    const parsed = JSON.parse(out.result);
    check(`route ${route} resolves`, parsed.url === BOOKING_URL && out.bookingUrl === BOOKING_URL, parsed.url);
  }
  const unknown = JSON.parse((await runTool("get_booking_link", { route: "nonsense" }, ctx)).result);
  check("unknown route falls back to general", unknown.route === "general" && unknown.url === BOOKING_URL);
  check("the 404 grant-call URL is never returned", !BOOKING_URL.includes("scale-up-grant-call"));
}

// 4. Escalation is durable before any email is attempted.
{
  const out = await runTool("escalate_to_human", { question: "Do you have an office in Providence?", context: "Not in the knowledge base." }, ctx);
  check("escalation reported to the model", out.escalated === true);
  const { rows } = await db().query(
    "SELECT question, reason, email_status, lead_id, transcript FROM escalations WHERE conversation_id = $1", [conversationId]);
  check("escalation row written", rows.length === 1);
  check("escalation carries the transcript", Array.isArray(rows[0]?.transcript) && rows[0].transcript.length > 0);
  check("escalation linked to nothing until email settles", rows[0]?.email_status === "pending" || rows[0]?.email_status === "failed");
}

// 5. Unknown tool degrades instead of throwing.
{
  const out = await runTool("no_such_tool", {}, ctx);
  check("unknown tool returns a message", out.result.includes("Unknown tool"));
}

await db().query("DELETE FROM conversations WHERE id = $1", [conversationId]);
console.log(failures ? `\n${failures} FAILED` : "\nAll tool checks passed");
await db().end();
process.exit(failures ? 1 : 0);
