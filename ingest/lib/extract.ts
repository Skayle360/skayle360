import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { unzipSync } from "fflate";

/** A extraction unit that carries its own locator (page N / slide N). */
export interface Segment {
  /** 1-based page or slide number; null for flat documents. */
  ordinal: number | null;
  /** "p." for PDFs, "slide " for decks. */
  ordinalLabel: "p." | "slide " | null;
  text: string;
}

const decoder = new TextDecoder("utf-8");

function decodeXmlEntities(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h: string) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&amp;/g, "&");
}

/**
 * PDF renderers letter-space display headings by drawing each glyph
 * separately, and text extraction faithfully returns "M A S S A C H U S E T T S".
 * Left alone those headings match nothing — the search index sees thirteen
 * one-letter tokens instead of one rare, highly discriminating word.
 *
 * Collapses runs of four or more single characters separated by single spaces.
 * Four is the floor because shorter runs are usually real: "a b c" in a list,
 * or initials.
 */
export function collapseLetterSpacing(text: string): string {
  return text.replace(/(?:(?<![A-Za-z0-9])[A-Za-z0-9] ){3,}[A-Za-z0-9](?![A-Za-z0-9])/g, (run) =>
    run.replace(/ /g, ""),
  );
}

/** Collapse the whitespace noise that layout-mode PDF and Office XML both produce. */
export function normalizeWhitespace(s: string): string {
  return collapseLetterSpacing(s)
    .replace(/\r\n?/g, "\n")
    .replace(/ /g, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * PDF via `pdftotext -layout` (poppler-utils). Layout mode is what preserves the
 * multi-column callout boxes the syllabus and program summary are built from;
 * without it those columns interleave line-by-line into nonsense.
 */
export function extractPdfWithPoppler(bytes: Uint8Array): Segment[] {
  const dir = mkdtempSync(join(tmpdir(), "su-pdf-"));
  try {
    const src = join(dir, "in.pdf");
    writeFileSync(src, bytes);
    execFileSync("pdftotext", ["-layout", "-enc", "UTF-8", src, join(dir, "out.txt")], {
      stdio: ["ignore", "ignore", "pipe"],
    });
    const raw = readFileSync(join(dir, "out.txt"), "utf-8");
    // pdftotext separates pages with a form feed.
    return raw
      .split("\f")
      .map((page, i) => ({ ordinal: i + 1, ordinalLabel: "p." as const, text: normalizeWhitespace(page) }))
      .filter((s) => s.text.length > 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Strip Office XML to text, using paragraph tags as the only line breaks. */
function officeXmlToText(xml: string, paragraphTag: string): string {
  const withBreaks = xml
    .replace(new RegExp(`</${paragraphTag}>`, "g"), "\n")
    .replace(/<w:tab\b[^>]*\/>/g, " ")
    .replace(/<w:br\b[^>]*\/>/g, "\n")
    .replace(/<a:br\b[^>]*\/>/g, "\n");
  return normalizeWhitespace(decodeXmlEntities(withBreaks.replace(/<[^>]+>/g, "")));
}

export function extractDocx(bytes: Uint8Array): Segment[] {
  const files = unzipSync(bytes, { filter: (f) => f.name === "word/document.xml" });
  const doc = files["word/document.xml"];
  if (!doc) return [];
  const text = officeXmlToText(decoder.decode(doc), "w:p");
  return text ? [{ ordinal: null, ordinalLabel: null, text }] : [];
}

export function extractPptx(bytes: Uint8Array): Segment[] {
  const slidePattern = /^ppt\/slides\/slide(\d+)\.xml$/;
  const files = unzipSync(bytes, { filter: (f) => slidePattern.test(f.name) });
  return Object.entries(files)
    .map(([name, data]) => {
      const n = Number(slidePattern.exec(name)![1]);
      return { ordinal: n, ordinalLabel: "slide " as const, text: officeXmlToText(decoder.decode(data), "a:p") };
    })
    .filter((s) => s.text.length > 0)
    .sort((a, b) => a.ordinal! - b.ordinal!);
}

/** Whether the poppler binary is on this machine. Cached — it cannot appear mid-run. */
let popplerAvailable: boolean | null = null;
function hasPoppler(): boolean {
  if (popplerAvailable === null) {
    try {
      execFileSync("pdftotext", ["-v"], { stdio: "ignore" });
      popplerAvailable = true;
    } catch {
      popplerAvailable = false;
    }
  }
  return popplerAvailable;
}

/**
 * PDF text, preferring poppler and falling back to a pure-JS reader.
 *
 * Poppler's `-layout` mode is meaningfully better on this corpus: it keeps
 * multi-column callouts readable and preserves the word boundaries in
 * letter-spaced display headings, which the JS reader flattens to uniform
 * spaces ("M A S S A C H U S E T T S" is then unrecoverable — the same string
 * a real spaced-out heading would produce).
 *
 * The fallback exists because uploads are processed on the server, where there
 * is no binary to call. Slightly worse headings there is an acceptable trade
 * for being able to ingest a file the moment someone drops it in.
 */
export async function extractPdfAsync(bytes: Uint8Array): Promise<Segment[]> {
  if (hasPoppler()) return extractPdfWithPoppler(bytes);
  const { extractText, getDocumentProxy } = await import("unpdf");
  const pdf = await getDocumentProxy(new Uint8Array(bytes));
  const { text } = await extractText(pdf, { mergePages: false });
  const pages = Array.isArray(text) ? text : [text];
  return pages
    .map((page, i) => ({ ordinal: i + 1, ordinalLabel: "p." as const, text: normalizeWhitespace(page) }))
    .filter((s) => s.text.length > 0);
}

/** Synchronous entry point, used by the CLI ingest where poppler is present. */
export function extractPdf(bytes: Uint8Array): Segment[] {
  if (!hasPoppler()) {
    throw new Error("pdftotext is not installed — use extractAsync() for the pure-JS fallback");
  }
  return extractPdfWithPoppler(bytes);
}

/** Async extractor that works with or without poppler. Use this on the server. */
export async function extractAsync(basename: string, bytes: Uint8Array): Promise<Segment[]> {
  const ext = basename.slice(basename.lastIndexOf(".")).toLowerCase();
  if (ext === ".pdf") return extractPdfAsync(bytes);
  return extract(basename, bytes);
}

export function extract(basename: string, bytes: Uint8Array): Segment[] {
  const ext = basename.slice(basename.lastIndexOf(".")).toLowerCase();
  switch (ext) {
    case ".pdf":
      return extractPdf(bytes);
    case ".docx":
      return extractDocx(bytes);
    case ".pptx":
      return extractPptx(bytes);
    case ".txt":
    case ".md":
      return [{ ordinal: null, ordinalLabel: null, text: normalizeWhitespace(decoder.decode(bytes)) }];
    default:
      throw new Error(`no extractor for ${ext}`);
  }
}
