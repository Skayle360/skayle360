import { google } from "googleapis";

/**
 * Client requirement #5: "I can update the knowledge myself."
 *
 * Chris edits a Google Doc. Nothing else — no repository, no command, no admin
 * password. The doc is read on the same weekly schedule that re-reads his
 * website, and anything in it is authoritative: it outranks his own PDFs and
 * his own site wherever they disagree.
 *
 * A Google Doc rather than a custom admin page because he already works in
 * Google (his leads land in a Google Sheet), the service account we created for
 * that Sheet can read Docs with no new credentials, and he gets revision
 * history and comments for free. An admin page would be a second password to
 * remember and a worse editor.
 *
 * Setup:
 *   1. Create a Doc, e.g. "SCALE UP — Bot Knowledge"
 *   2. Share it with the service account email as Viewer
 *   3. Enable the Google Docs API in the same Cloud project
 *   4. KNOWLEDGE_DOC_ID = the id from the Doc's URL
 */

export function knowledgeDocConfigured(): boolean {
  return Boolean(process.env.KNOWLEDGE_DOC_ID && process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
}

/** Flattens the Docs API's nested structure into plain text. */
function docToText(doc: { body?: { content?: unknown[] } }): string {
  const lines: string[] = [];

  const walk = (elements: unknown[]): void => {
    for (const el of elements as Array<Record<string, any>>) {
      if (el.paragraph) {
        const text = (el.paragraph.elements ?? [])
          .map((e: Record<string, any>) => e.textRun?.content ?? "")
          .join("")
          .replace(/\v/g, "\n")
          .trimEnd();
        // Headings become markdown so the chunker's heading detection sees them.
        const style: string = el.paragraph.paragraphStyle?.namedStyleType ?? "";
        const level = /^HEADING_(\d)$/.exec(style)?.[1];
        lines.push(level ? `${"#".repeat(Number(level))} ${text}` : text);
      } else if (el.table) {
        // Tables read row by row; a knowledge doc's tables are usually
        // fact/value pairs, and flattening keeps both halves together.
        for (const row of el.table.tableRows ?? []) {
          const cells = (row.tableCells ?? []).map((c: Record<string, any>) => {
            const collected: string[] = [];
            for (const inner of c.content ?? []) {
              if (inner.paragraph) {
                collected.push(
                  (inner.paragraph.elements ?? [])
                    .map((e: Record<string, any>) => e.textRun?.content ?? "")
                    .join("")
                    .trim(),
                );
              }
            }
            return collected.join(" ").trim();
          });
          if (cells.some(Boolean)) lines.push(cells.filter(Boolean).join(" — "));
        }
      } else if (el.tableOfContents) {
        continue;
      }
    }
  };

  walk(doc.body?.content ?? []);
  return lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

export interface KnowledgeDoc {
  title: string;
  text: string;
  url: string;
  fetchedAt: string;
}

export async function fetchKnowledgeDoc(): Promise<KnowledgeDoc | null> {
  if (!knowledgeDocConfigured()) return null;
  const documentId = process.env.KNOWLEDGE_DOC_ID!;
  const creds = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON!);
  const auth = new google.auth.JWT({
    email: creds.client_email,
    key: creds.private_key.replace(/\\n/g, "\n"),
    scopes: ["https://www.googleapis.com/auth/documents.readonly"],
  });
  const docs = google.docs({ version: "v1", auth });
  const { data } = await docs.documents.get({ documentId });
  const text = docToText(data as never);
  if (!text.trim()) {
    // An empty doc must not silently erase the knowledge it replaces.
    throw new Error("The knowledge doc is empty — refusing to index nothing over the existing entries");
  }
  return {
    title: data.title ?? "Bot Knowledge",
    text,
    url: `https://docs.google.com/document/d/${documentId}/edit`,
    fetchedAt: new Date().toISOString(),
  };
}
