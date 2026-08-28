import { google } from "googleapis";
import type { sheets_v4 } from "googleapis";
import type { Escalation, Lead, LeadSink } from "./lead-sink";

/**
 * Mirrors leads into Chris's Google Sheet. Confirmed as the destination by the
 * client on 2026-08-27.
 *
 * A mirror, never the source of truth. The Sheets API rate-limits, and a human
 * editing the tab while a write lands can drop a row with no error surfacing
 * anywhere. Postgres holds the authoritative copy; this makes the leads visible
 * somewhere Chris already works.
 *
 * Setup:
 *   1. Google Cloud console -> new service account -> create a JSON key
 *   2. Enable the Google Sheets API for that project
 *   3. Share the Sheet with the service account's email as an Editor
 *   4. GOOGLE_SERVICE_ACCOUNT_JSON = the whole JSON key, on one line
 *      GOOGLE_SHEET_ID            = the id from the Sheet's URL
 *      ENABLE_SHEETS_MIRROR       = true
 */

const LEAD_TAB = process.env.GOOGLE_SHEET_LEAD_TAB ?? "Leads";
const ESCALATION_TAB = process.env.GOOGLE_SHEET_ESCALATION_TAB ?? "Unanswered";

const LEAD_HEADERS = ["When", "Name", "Email", "Company", "What they asked about", "Route", "Page", "Conversation"];
const ESCALATION_HEADERS = ["When", "Question", "Why", "Name", "Email", "Company", "Conversation"];

export class GoogleSheetsLeadSink implements LeadSink {
  readonly name = "google-sheets";
  readonly authoritative = false;
  private client: sheets_v4.Sheets | null = null;
  private readonly ensured = new Set<string>();

  static configured(): boolean {
    return Boolean(process.env.GOOGLE_SHEET_ID && process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
  }

  private sheetId(): string {
    const id = process.env.GOOGLE_SHEET_ID;
    if (!id) throw new Error("GOOGLE_SHEET_ID is not set");
    return id;
  }

  private async sheets(): Promise<sheets_v4.Sheets> {
    if (this.client) return this.client;
    const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
    if (!raw) throw new Error("GOOGLE_SERVICE_ACCOUNT_JSON is not set");
    let credentials: { client_email: string; private_key: string };
    try {
      credentials = JSON.parse(raw);
    } catch {
      throw new Error("GOOGLE_SERVICE_ACCOUNT_JSON is not valid JSON");
    }
    const auth = new google.auth.JWT({
      email: credentials.client_email,
      // Pasting the JSON into an env var turns real newlines into the two
      // characters \ and n, which breaks the key unless they are restored.
      key: credentials.private_key.replace(/\\n/g, "\n"),
      scopes: ["https://www.googleapis.com/auth/spreadsheets"],
    });
    this.client = google.sheets({ version: "v4", auth });
    return this.client;
  }

  /** Creates the tab and its header row the first time we write to it. */
  private async ensureTab(title: string, headers: string[]): Promise<void> {
    if (this.ensured.has(title)) return;
    const sheets = await this.sheets();
    const spreadsheetId = this.sheetId();

    const meta = await sheets.spreadsheets.get({ spreadsheetId });
    const exists = meta.data.sheets?.some((s) => s.properties?.title === title);
    if (!exists) {
      await sheets.spreadsheets.batchUpdate({
        spreadsheetId,
        requestBody: { requests: [{ addSheet: { properties: { title } } }] },
      });
    }

    const first = await sheets.spreadsheets.values.get({ spreadsheetId, range: `${title}!A1:H1` });
    if (!first.data.values?.length) {
      await sheets.spreadsheets.values.update({
        spreadsheetId,
        range: `${title}!A1`,
        valueInputOption: "RAW",
        requestBody: { values: [headers] },
      });
    }
    this.ensured.add(title);
  }

  private async append(tab: string, headers: string[], row: Array<string | null>): Promise<void> {
    await this.ensureTab(tab, headers);
    const sheets = await this.sheets();
    await sheets.spreadsheets.values.append({
      spreadsheetId: this.sheetId(),
      range: `${tab}!A1`,
      valueInputOption: "RAW",
      insertDataOption: "INSERT_ROWS",
      requestBody: { values: [row.map((v) => v ?? "")] },
    });
  }

  async saveLead(lead: Lead): Promise<{ id: string }> {
    await this.append(LEAD_TAB, LEAD_HEADERS, [
      new Date().toISOString(),
      lead.name,
      lead.email,
      lead.company,
      lead.interest,
      lead.bookingRoute,
      lead.sourceUrl,
      lead.conversationId,
    ]);
    return { id: lead.conversationId };
  }

  async saveEscalation(e: Escalation): Promise<{ id: string }> {
    await this.append(ESCALATION_TAB, ESCALATION_HEADERS, [
      new Date().toISOString(),
      e.question,
      e.reason,
      e.lead?.name ?? null,
      e.lead?.email ?? null,
      e.lead?.company ?? null,
      e.conversationId,
    ]);
    return { id: e.conversationId };
  }
}
