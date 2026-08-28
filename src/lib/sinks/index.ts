import { FanOutLeadSink, type LeadSink } from "./lead-sink";
import { PostgresLeadSink } from "./postgres-sink";
import { GoogleSheetsLeadSink } from "./sheets-sink";

let sink: LeadSink | null = null;

export function leadSink(): LeadSink {
  if (!sink) {
    const sinks: LeadSink[] = [new PostgresLeadSink()];
    // Confirmed as the lead destination by the client on 2026-08-27. Still a
    // mirror: Postgres stays authoritative, and a Sheets failure is logged
    // rather than surfaced to the visitor.
    if (GoogleSheetsLeadSink.configured() && process.env.ENABLE_SHEETS_MIRROR === "true") {
      sinks.push(new GoogleSheetsLeadSink());
    }
    sink = new FanOutLeadSink(sinks);
  }
  return sink;
}

export * from "./lead-sink";
