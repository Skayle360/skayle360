/**
 * Clears leads, escalations and conversations from Postgres and wipes the
 * Sheet's data rows. For clearing out testing noise before a real run — never
 * point this at production.
 */
import { google } from "googleapis";
import { db } from "@/lib/db";

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
