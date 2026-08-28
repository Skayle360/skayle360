/**
 * SOURCE POLICY — the single edit point for what enters the knowledge base.
 *
 * PENDING CLIENT ANSWER: "final document list". Ingestion is re-runnable, so a
 * change here plus `npm run ingest` is the whole cost of a revision. No other
 * file encodes which documents are in or out.
 */

export type Disposition = "full_text" | "catalog_only" | "exclude";

/** Files whose full prose enters the retrieval index. */
export const FULL_TEXT_BASENAMES: readonly string[] = [
  // Top-level program documents
  "SCALE UP Ebook (1).pdf",
  "The Small Business Growth Companion.docx",
  "SCALE UP Training Syllabus.pdf",
  "Chris Ciunci Bio.pdf",
  // Module decks
  "Module 1 - Strategic Planning.pptx",
  "Module 2 - Strengthening Your Team.pptx",
  "Module 3 - Marketing Strategy.pptx",
  "Module 4 - Lead Generation.pptx",
  "Module 5_ AI For Growth.pptx",
  // The 12 prose documents living inside the template zips. These are written
  // guides, not fill-in forms. SCALE UP_Program Summary.pdf is among the best
  // overview documents in the whole set.
  "SCALE UP_Program Summary.pdf",
  "SCALE UP Module 2 Summary.docx",
  "SCALE UP_Module 3 Summary.docx",
  "SCALE UP_Module 3_Summary_Nonprofit.docx",
  "SCALE UP_Module 4 Summary.pdf",
  "SCALE UP_Module 4 Summary_Nonprofit.pdf",
  "SCALE UP_SEO Best Practices.docx",
  "SCALE UP_Website Best Practices.docx",
  "SCALE UP_Prompt Library.docx",
  "SCALE UP_AI Prompt Best Practices.pdf",
  "Skayle 360 Comprehensive Marketing Plan.docx",
  "SCALE UP Key Pillars Summary.docx",
];

/** Archives read as blog collections — every member is full text. */
export const BLOG_ARCHIVES: readonly string[] = ["Blog Posts.zip"];

/** Archives whose non-allowlisted members become catalog lines only. */
export const TEMPLATE_ARCHIVES: readonly string[] = [
  "MODULE 1 TEMPLATES.zip",
  "Module 2 Growth Templates.zip",
  "SCALE UP Module 3 Templates.zip",
  "Module 4 Templates.zip",
  "SCALE UP Module 5 Growth Templates.zip",
];

/** Archives dropped whole, with the reason recorded in the ingest report. */
export const EXCLUDED_ARCHIVES: Readonly<Record<string, string>> = {
  "MODULE 1 TEMPLATES (1).zip":
    "byte-identical duplicate of MODULE 1 TEMPLATES.zip (md5 c40822185d17aeb3505effea9e15c8e6)",
};

/**
 * Confidential third-party material. Six PrepU documents are another client's
 * strategy work; five carry a "PrepU Internal" stamp. A public bot must never
 * surface these, so they are dropped before extraction, not filtered at query
 * time.
 */
export const CONFIDENTIAL_PATTERNS: readonly RegExp[] = [/(^|[^a-z])prepu([^a-z]|$)/i];

/**
 * Module 4 Templates.zip stores four files twice: once at the archive root and
 * once under the `Module 4 Templates/` folder. The folder copy is canonical.
 */
export function isArchiveRootDuplicate(archive: string, entryPath: string): boolean {
  if (archive !== "Module 4 Templates.zip") return false;
  return !entryPath.startsWith("Module 4 Templates/");
}

/** Formats we cannot usefully extract prose from. */
export const UNSUPPORTED_EXTENSIONS: readonly string[] = [".xlsx", ".doc", ".png", ".jpg", ".jpeg"];

export function moduleOf(path: string): string | null {
  const m = path.match(/module\s*_?(\d)/i);
  return m ? `Module ${m[1]}` : null;
}
