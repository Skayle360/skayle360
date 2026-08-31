/**
 * Clears leads, escalations and conversations, and wipes the Sheet's data rows.
 *
 * This project runs one database for local work and production, so there is no
 * "test" copy to point this at — running it deletes real enquiries the client
 * has received. It therefore refuses unless CONFIRM_WIPE names the host it is
 * about to clear, and it shows what will be lost first.
 *
 *   CONFIRM_WIPE=<db host> npm run reset:testdata
 */
import { google } from "googleapis";
import { db } from "@/lib/db";

const host = new URL(process.env.DATABASE_URL ?? "postgres://x/y").host;

const { rows: [counts] } = await db().query<{ leads: string; escalations: string; conversations: string }>(
  `SELECT (SELECT count(*) FROM leads)::text AS leads,
          (SELECT count(*) FROM escalations)::text AS escalations,
          (SELECT count(*) FROM conversations)::text AS conversations`,
);

if (process.env.CONFIRM_WIPE !== host) {
  console.error(
    `\nThis deletes every lead and enquiry on ${host}:\n` +
      `  ${counts!.leads} lead(s)\n` +
      `  ${counts!.escalations} unanswered question(s)\n` +
      `  ${counts!.conversations} conversation(s)\n` +
      `and clears the Google Sheet.\n\n` +
      `There is no separate test database, so these may be real enquiries.\n` +
      `If you are sure, re-run with:\n\n` +
      `  CONFIRM_WIPE=${host} npm run reset:testdata\n`,
  );
  await db().end();
  process.exit(1);
}

const { rows } = await db().query<{ n: string }>("SELECT count(*)::text AS n FROM leads");
await db().query("TRUNCATE turns, escalations, leads, conversations RESTART IDENTITY CASCADE");
console.log(`Cleared ${rows[0]!.n} lead(s) from Postgres.`);

if (process.env.GOOGLE_SHEET_ID && process.env.GOOGLE_SERVICE_ACCOUNT_JSON) {
  const c = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
  const auth = new google.auth.JWT({
    email: c.client_email,
    key: c.private_key.replace(/\\n/g, "\n"),
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });
  const sheets = google.sheets({ version: "v4", auth });
  for (const tab of ["Leads", "Unanswered"]) {
    try {
      // Row 1 is the header and is kept.
      await sheets.spreadsheets.values.clear({
        spreadsheetId: process.env.GOOGLE_SHEET_ID,
        range: `${tab}!A2:H10000`,
      });
      console.log(`Cleared the ${tab} tab.`);
    } catch (err) {
      console.error(`  ${tab}: ${err instanceof Error ? err.message : err}`);
    }
  }
}
await db().end();
