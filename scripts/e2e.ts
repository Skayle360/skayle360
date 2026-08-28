/**
 * End-to-end check of the whole chain: retrieval -> model -> grounding ->
 * tools -> Postgres -> Google Sheet.
 *
 * Costs a few cents of API usage and writes two test leads, so run
 * `npm run reset:testdata` afterwards before showing anyone the Sheet.
 *
 *   npm run e2e
 */
import { randomUUID } from "node:crypto";
import { google } from "googleapis";
import { runChat } from "@/lib/chat";
import { db } from "@/lib/db";
import { BOOKING_URL } from "@config/app";

const ok = (s: string) => `\x1b[32m  PASS\x1b[0m  ${s}`;
const no = (s: string) => `\x1b[31m  FAIL\x1b[0m  ${s}`;
let failures = 0;
const check = (cond: boolean, label: string, detail = "") => {
  console.log(cond ? ok(label) : no(`${label}${detail ? " — " + detail : ""}`));
  if (!cond) failures++;
};

interface Run { text: string; sources: string[]; booking: string | null; escalated: boolean; grounded: boolean }

async function converse(message: string): Promise<Run> {
  const conversationId = randomUUID();
  await db().query("INSERT INTO conversations (id) VALUES ($1) ON CONFLICT DO NOTHING", [conversationId]);
  const r: Run = { text: "", sources: [], booking: null, escalated: false, grounded: false };
  await runChat({ conversationId, history: [], message, sourceUrl: "https://skayle360.com/programs" }, (e) => {
    if (e.type === "text") r.text += e.text;
    if (e.type === "sources") r.sources.push(...e.sources.map((s) => s.label));
    if (e.type === "booking") r.booking = e.url;
    if (e.type === "escalated") r.escalated = true;
    if (e.type === "done") r.grounded = e.grounded;
  });
  return r;
}

console.log("\n1. Index");
{
  const { rows } = await db().query<{ docs: string; chunks: string; corrections: string }>(
    `SELECT (SELECT count(*) FROM documents) AS docs,
            (SELECT count(*) FROM chunks)    AS chunks,
            (SELECT count(*) FROM documents WHERE source_type='correction') AS corrections`);
  const r = rows[0]!;
  console.log(`        ${r.docs} documents, ${r.chunks} chunks`);
  check(Number(r.chunks) > 900, "knowledge base is loaded");
  check(Number(r.corrections) > 0, "Chris's corrections file is indexed");
}

console.log("\n2. A visitor who qualifies, and volunteers their details");
{
  const r = await converse(
    "Hi, I'm Alex Nordin at alex@stonebridgevet.com. Stonebridge Veterinary, 24 staff in Lowell MA. When does the next cohort run?",
  );
  check(r.grounded, "answer is grounded in the knowledge base");
  check(/march 25|25 march/i.test(r.text), "uses the CORRECTED end date (March 25)", r.text.slice(0, 90));
  check(!/april 1|apr 1/i.test(r.text), "does not repeat the wrong April 1 date from the syllabus");
  check(r.sources.length > 0, "shows its sources");
  check(!r.escalated, "does not escalate a question it answered");

  const { rows } = await db().query<{ email: string; company: string; mirror_status: string }>(
    "SELECT email, company, mirror_status FROM leads WHERE email = 'alex@stonebridgevet.com'");
  check(rows.length === 1, "lead saved to Postgres", `${rows.length} row(s)`);
  check(rows[0]?.company?.includes("Stonebridge") ?? false, "company captured");
  // The mirror write is fire-and-forget; give it a moment to land.
  await new Promise((r) => setTimeout(r, 2500));
  const { rows: after } = await db().query<{ mirror_status: string }>(
    "SELECT mirror_status FROM leads WHERE email = 'alex@stonebridgevet.com'");
  check(after[0]?.mirror_status === "synced", "lead marked as mirrored to the Sheet", after[0]?.mirror_status);
}

console.log("\n3. A question the material cannot answer");
{
  const r = await converse("Do you offer monthly payment plans if the grant is declined?");
  check(r.escalated, "escalated to Chris");
  const { rows } = await db().query<{ reason: string; email_status: string }>(
    "SELECT reason, email_status FROM escalations ORDER BY created_at DESC LIMIT 1");
  check(rows.length === 1, "escalation recorded in Postgres");
  console.log(`        reason: ${rows[0]?.reason}, email: ${rows[0]?.email_status}`);
}

console.log("\n4. Booking link");
{
  const r = await converse("Can you send me the link to book a call with Chris?");
  check(r.booking === BOOKING_URL, "returns the verified Calendly URL", r.booking ?? "none");
  check(!(r.booking ?? "").includes("scale-up-grant-call"), "never returns the dead 404 link");
}

console.log("\n5. Google Sheet");
if (process.env.GOOGLE_SHEET_ID && process.env.GOOGLE_SERVICE_ACCOUNT_JSON) {
  const c = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
  const auth = new google.auth.JWT({
    email: c.client_email, key: c.private_key.replace(/\\n/g, "\n"),
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });
  const sheets = google.sheets({ version: "v4", auth });
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: process.env.GOOGLE_SHEET_ID, range: "Leads!A1:H200" });
  const rows = res.data.values ?? [];
  const found = rows.filter((r) => (r[2] ?? "").includes("alex@stonebridgevet.com"));
  check(found.length === 1, "lead appears in the Sheet exactly once", `${found.length} row(s) — duplicates mean the mirror is double-writing`);
} else {
  console.log("  SKIP  Sheet not configured");
}

console.log(
  failures === 0
    ? "\n\x1b[32mAll end-to-end checks passed.\x1b[0m Run `npm run reset:testdata` to clear the test rows.\n"
    : `\n\x1b[31m${failures} check(s) failed.\x1b[0m\n`,
);
await db().end();
process.exit(failures ? 1 : 0);
