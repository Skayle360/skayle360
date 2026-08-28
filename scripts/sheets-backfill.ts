/**
 * Copies leads that Postgres holds but the Sheet does not into the Sheet, and
 * marks them synced.
 *
 * Needed because the mirror can be off — before the client confirmed the
 * destination, during an outage, or whenever a Sheets write failed. Postgres
 * kept those leads; this is how they reach the Sheet afterwards.
 *
 *   npm run sheets:backfill
 */
import { db } from "@/lib/db";
import { GoogleSheetsLeadSink } from "@/lib/sinks/sheets-sink";

if (!GoogleSheetsLeadSink.configured()) {
  console.error("GOOGLE_SHEET_ID and GOOGLE_SERVICE_ACCOUNT_JSON must both be set.");
  process.exit(1);
}

const sink = new GoogleSheetsLeadSink();
const { rows } = await db().query<{
  id: string; conversation_id: string; name: string | null; email: string | null;
  company: string | null; interest: string | null; booking_route: string | null; source_url: string | null;
}>("SELECT * FROM leads WHERE mirror_status <> 'synced' ORDER BY created_at");

console.log(`${rows.length} lead(s) not yet in the Sheet.`);
let ok = 0;

for (const r of rows) {
  try {
    await sink.saveLead({
      conversationId: r.conversation_id, name: r.name, email: r.email, company: r.company,
      interest: r.interest, bookingRoute: r.booking_route, sourceUrl: r.source_url,
    });
    await db().query(
      "UPDATE leads SET mirror_status = 'synced', mirrored_at = now(), mirror_error = NULL WHERE id = $1", [r.id]);
    ok++;
    process.stdout.write(`\r  ${ok}/${rows.length}`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await db().query("UPDATE leads SET mirror_status = 'failed', mirror_error = $1 WHERE id = $2", [message, r.id]);
    console.error(`\n  ${r.email ?? r.conversation_id}: ${message}`);
  }
}

console.log(`\nSynced ${ok} of ${rows.length}.`);
await db().end();
