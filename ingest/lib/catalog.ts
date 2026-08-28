import { extract } from "@ingest/lib/extract";
import { moduleOf } from "@config/sources";

export interface CatalogEntry {
  name: string;
  module: string;
  purpose: string;
}

/** Markers that a line is a form field rather than prose. */
const BLANK_MARKERS = /(_{3,}|\.{5,}|\[\s*\]|^\s*[-–—]\s*$)/;
const BRAND_LINE = /skayle\s*360|skayle360\.com|scale\s*up\s*training/i;

/**
 * A worksheet's own opening description is a far better catalog line than
 * anything we could infer from the filename. We take exactly one sentence and
 * never index the body, so the fill-in-the-blank fields stay out of retrieval.
 */
function purposeFromBody(bytes: Uint8Array, basename: string): string | null {
  let text: string;
  try {
    text = extract(basename, bytes)
      .map((s) => s.text)
      .join("\n");
  } catch {
    return null;
  }
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (line.length < 25 || line.length > 240) continue;
    if (BLANK_MARKERS.test(line) || BRAND_LINE.test(line)) continue;
    if (line === line.toUpperCase()) continue;
    if (/^(your|list|write|enter|describe|fill)\b/i.test(line)) continue;
    const sentence = line.match(/^[^.!?]+[.!?]/)?.[0] ?? line;
    if (sentence.length < 25) continue;
    return sentence.trim();
  }
  return null;
}

function titleFromFilename(path: string): string {
  const base = path.slice(path.lastIndexOf("/") + 1).replace(/\.[a-z0-9]+$/i, "");
  return base
    .replace(/^SCALE[_ ]?UP[_ ]?/i, "")
    .replace(/[_]+/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
}

export function catalogEntry(
  archive: string,
  entryPath: string,
  bytes: Uint8Array | null,
): CatalogEntry {
  const name = titleFromFilename(entryPath);
  const module = moduleOf(archive) ?? moduleOf(entryPath) ?? "Unassigned";
  const basename = entryPath.slice(entryPath.lastIndexOf("/") + 1);
  const purpose =
    (bytes ? purposeFromBody(bytes, basename) : null) ??
    `${name} worksheet used during ${module} of the SCALE UP program.`;
  return { name, module, purpose };
}

/**
 * The catalog is retrievable prose, not a sidecar table: "what templates come
 * with Module 2?" is a real visitor question and it needs a document to cite.
 */
export function renderCatalogDocument(module: string, entries: CatalogEntry[]): string {
  const lines = entries
    .slice()
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((e) => `- ${e.name} — ${module} — ${e.purpose}`);
  return [
    `${module} — SCALE UP worksheet and template catalog`,
    ``,
    `The following ${entries.length} fill-in worksheets are provided to participants in ${module}. ` +
      `They are working templates completed during the live sessions; the descriptions below say what each one is for.`,
    ``,
    ...lines,
  ].join("\n");
}
