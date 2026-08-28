/**
 * Phase 1 ingestion. Re-runnable by design: same inputs produce the same
 * corpus, the same doc ids and the same chunk ids, so a re-index is always a
 * safe operation.
 *
 *   npm run ingest                       # default source dir
 *   SOURCE_DIR=/path npm run ingest
 */
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join, extname } from "node:path";
import { unzipSync } from "fflate";
import { extract, type Segment } from "./lib/extract";
import { chunkDocument, type Chunk } from "./lib/chunk";
import { catalogEntry, renderCatalogDocument, type CatalogEntry } from "./lib/catalog";
import { dropNearDuplicates, type NearDupe } from "./lib/neardupe";
import { findCohortMentions, auditCohorts, type CohortMention } from "./lib/cohort";
import { fetchKnowledgeDoc } from "../src/lib/knowledge-doc";
import type { CrawledPage } from "./lib/crawl-core";
import {
  FULL_TEXT_BASENAMES,
  BLOG_ARCHIVES,
  TEMPLATE_ARCHIVES,
  EXCLUDED_ARCHIVES,
  CONFIDENTIAL_PATTERNS,
  UNSUPPORTED_EXTENSIONS,
  isArchiveRootDuplicate,
  moduleOf,
} from "../config/sources";

const SOURCE_DIR = process.env.SOURCE_DIR ?? "/home/haris-awais/devminified/ai-agent";
const OUT_DIR = process.env.OUT_DIR ?? new URL("../data", import.meta.url).pathname;
/** Jaccard over 5-token shingles. Every pair this catches in the blog folder was
 *  verified by hand to be a draft/final pair of the same post. */
const NEAR_DUPE_THRESHOLD = Number(process.env.NEAR_DUPE_THRESHOLD ?? 0.6);

export interface DocumentRecord {
  docId: string;
  title: string;
  /** Where a citation should say this came from. */
  sourceLabel: string;
  sourceType: "correction" | "program_document" | "module_deck" | "blog_post" | "template_catalog" | "website";
  origin: string;
  module: string | null;
  format: string;
  words: number;
  chunkCount: number;
  sha256: string;
}

interface Skipped {
  path: string;
  reason: string;
}

const documents: DocumentRecord[] = [];
const chunks: Chunk[] = [];
const skipped: Skipped[] = [];
const seenHashes = new Map<string, string>();
const catalogByModule = new Map<string, CatalogEntry[]>();
const nearDupes: NearDupe[] = [];
const cohortMentions: CohortMention[] = [];

const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
const basenameOf = (p: string) => p.slice(p.lastIndexOf("/") + 1);
const wordCount = (s: string) => (s.match(/\S+/g) ?? []).length;

function slug(s: string): string {
  return s
    .toLowerCase()
    .replace(/\.[a-z0-9]+$/, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 80);
}

function isConfidential(path: string): boolean {
  return CONFIDENTIAL_PATTERNS.some((re) => re.test(path));
}

function addFullText(opts: {
  path: string;
  bytes: Uint8Array;
  sourceType: DocumentRecord["sourceType"];
  origin: string;
  title?: string;
}) {
  const base = basenameOf(opts.path);
  let segments: Segment[];
  try {
    segments = extract(base, opts.bytes);
  } catch (err) {
    skipped.push({ path: opts.path, reason: `extraction failed: ${(err as Error).message}` });
    return;
  }
  const title = opts.title ?? base.replace(/\.[a-z0-9]+$/i, "");
  const docId = slug(title);
  const docChunks = chunkDocument(docId, segments);
  if (!docChunks.length) {
    skipped.push({ path: opts.path, reason: "no extractable text" });
    return;
  }
  chunks.push(...docChunks);
  cohortMentions.push(...findCohortMentions(title, segments.map((s) => s.text).join("\n")));
  documents.push({
    docId,
    title,
    sourceLabel: title,
    sourceType: opts.sourceType,
    origin: opts.origin,
    module: moduleOf(opts.path),
    format: extname(base).slice(1),
    words: segments.reduce((n, s) => n + wordCount(s.text), 0),
    chunkCount: docChunks.length,
    sha256: sha(opts.bytes),
  });
}

function readArchive(zipPath: string): Record<string, Uint8Array> {
  return unzipSync(readFileSync(zipPath), { filter: (f) => !f.name.endsWith("/") });
}

// ------------------------------------------------------- client-edited doc
// Requirement #5: the client updates the knowledge himself. Whatever he has
// written in the Google Doc is pulled in as an authoritative source, exactly
// like the local corrections file.
const knowledgeDoc = await fetchKnowledgeDoc().catch((err) => {
  console.warn(`WARNING: could not read the knowledge doc — ${(err as Error).message}`);
  console.warn("         Keeping the previously indexed copy rather than dropping it.");
  return null;
});
if (knowledgeDoc) {
  addFullText({
    path: "client-knowledge.md",
    bytes: new TextEncoder().encode(knowledgeDoc.text),
    sourceType: "correction",
    origin: knowledgeDoc.url,
    title: knowledgeDoc.title,
  });
  console.log(`Knowledge doc: "${knowledgeDoc.title}" (${knowledgeDoc.text.length} chars)`);
}

// -------------------------------------------------------------- corrections
// Chris edits knowledge/*.md directly. These are authoritative: they override
// the website and the documents where those disagree, which is how a cohort
// date gets corrected without waiting on a Webflow edit.
const KNOWLEDGE_DIR = process.env.KNOWLEDGE_DIR ?? new URL("../knowledge", import.meta.url).pathname;
if (existsSync(KNOWLEDGE_DIR)) {
  for (const name of readdirSync(KNOWLEDGE_DIR).filter((f) => f.endsWith(".md")).sort()) {
    const bytes = new Uint8Array(readFileSync(join(KNOWLEDGE_DIR, name)));
    addFullText({ path: name, bytes, sourceType: "correction", origin: `knowledge/${name}` });
  }
}

// ---------------------------------------------------------------- top level
const topLevel = readdirSync(SOURCE_DIR)
  .filter((f) => !f.startsWith("."))
  .sort();

for (const name of topLevel) {
  if (EXCLUDED_ARCHIVES[name]) {
    skipped.push({ path: name, reason: EXCLUDED_ARCHIVES[name]! });
    continue;
  }
  if (name.endsWith(".zip")) continue; // handled below
  if (!FULL_TEXT_BASENAMES.includes(name)) continue;

  const bytes = new Uint8Array(readFileSync(join(SOURCE_DIR, name)));
  const h = sha(bytes);
  if (seenHashes.has(h)) {
    skipped.push({ path: name, reason: `duplicate content of ${seenHashes.get(h)}` });
    continue;
  }
  seenHashes.set(h, name);
  addFullText({
    path: name,
    bytes,
    sourceType: name.endsWith(".pptx") ? "module_deck" : "program_document",
    origin: name,
  });
}

// ------------------------------------------------------------ template zips
for (const archive of TEMPLATE_ARCHIVES) {
  const entries = readArchive(join(SOURCE_DIR, archive));
  for (const [entryPath, bytes] of Object.entries(entries).sort(([a], [b]) => a.localeCompare(b))) {
    const label = `${archive}:${entryPath}`;
    if (isConfidential(entryPath)) {
      skipped.push({ path: label, reason: "confidential third-party material (PrepU) — never indexed" });
      continue;
    }
    if (isArchiveRootDuplicate(archive, entryPath)) {
      skipped.push({ path: label, reason: "archive-root duplicate of the folder copy" });
      continue;
    }
    const h = sha(bytes);
    if (seenHashes.has(h)) {
      skipped.push({ path: label, reason: `duplicate content of ${seenHashes.get(h)}` });
      continue;
    }
    seenHashes.set(h, label);

    const base = basenameOf(entryPath);
    if (FULL_TEXT_BASENAMES.includes(base)) {
      addFullText({ path: entryPath, bytes, sourceType: "program_document", origin: label });
      continue;
    }
    if (UNSUPPORTED_EXTENSIONS.includes(extname(base).toLowerCase())) {
      // Still worth a catalog line — the participant does receive this file.
      const entry = catalogEntry(archive, entryPath, null);
      catalogByModule.set(entry.module, [...(catalogByModule.get(entry.module) ?? []), entry]);
      skipped.push({ path: label, reason: `unsupported format ${extname(base)} — cataloged by name only` });
      continue;
    }
    const entry = catalogEntry(archive, entryPath, bytes);
    catalogByModule.set(entry.module, [...(catalogByModule.get(entry.module) ?? []), entry]);
  }
}

// ------------------------------------------------------------------- blogs
// The blog folder is a working directory, so drafts and final versions coexist
// under different filenames. Cluster on content before indexing anything.
for (const archive of BLOG_ARCHIVES) {
  const entries = readArchive(join(SOURCE_DIR, archive));
  const candidates: Array<{ key: string; text: string; path: string; bytes: Uint8Array }> = [];

  for (const [entryPath, bytes] of Object.entries(entries).sort(([a], [b]) => a.localeCompare(b))) {
    const label = `${archive}:${entryPath}`;
    if (isConfidential(entryPath)) {
      skipped.push({ path: label, reason: "confidential third-party material (PrepU) — never indexed" });
      continue;
    }
    const h = sha(bytes);
    if (seenHashes.has(h)) {
      skipped.push({ path: label, reason: `duplicate content of ${seenHashes.get(h)}` });
      continue;
    }
    seenHashes.set(h, label);
    const base = basenameOf(entryPath);
    let text: string;
    try {
      text = extract(base, bytes).map((s) => s.text).join("\n");
    } catch (err) {
      skipped.push({ path: label, reason: `extraction failed: ${(err as Error).message}` });
      continue;
    }
    candidates.push({ key: entryPath, text, path: entryPath, bytes });
  }

  const { kept, dupes } = dropNearDuplicates(candidates, NEAR_DUPE_THRESHOLD);
  nearDupes.push(...dupes);
  for (const d of dupes) {
    skipped.push({
      path: `${archive}:${d.dropped}`,
      reason: `near-duplicate draft of "${basenameOf(d.kept)}" (jaccard ${d.similarity})`,
    });
  }
  for (const c of kept.sort((a, b) => a.path.localeCompare(b.path))) {
    addFullText({ path: c.path, bytes: c.bytes, sourceType: "blog_post", origin: `${archive}:${c.path}` });
  }
}

// ----------------------------------------------------------------- website
// The crawl cache is optional so ingestion still runs offline, but its absence
// means no Roundtable and no cohort dates — the report says so loudly.
const crawlCachePath = join(OUT_DIR, "website.json");
if (existsSync(crawlCachePath)) {
  const pages: CrawledPage[] = JSON.parse(readFileSync(crawlCachePath, "utf-8"));
  for (const page of pages.sort((a, b) => a.path.localeCompare(b.path))) {
    const docId = slug(`site ${page.path === "/" ? "home" : page.path}`);
    const docChunks = chunkDocument(docId, [{ ordinal: null, ordinalLabel: null, text: page.text }]);
    if (!docChunks.length) continue;
    chunks.push(...docChunks);
    cohortMentions.push(...findCohortMentions(page.url, page.text));
    documents.push({
      docId,
      title: page.title,
      sourceLabel: `skayle360.com${page.path}`,
      sourceType: "website",
      origin: page.url,
      module: null,
      format: "html",
      words: wordCount(page.text),
      chunkCount: docChunks.length,
      sha256: sha(new TextEncoder().encode(page.text)),
    });
  }
} else {
  console.warn("WARNING: no data/website.json — run `npm run ingest:crawl` first. Roundtable and cohort dates will be missing.");
}

// ---------------------------------------------------------------- catalogs
for (const [module, entries] of [...catalogByModule.entries()].sort()) {
  const docId = slug(`catalog ${module}`);
  const text = renderCatalogDocument(module, entries);
  const docChunks = chunkDocument(docId, [{ ordinal: null, ordinalLabel: null, text }]);
  chunks.push(...docChunks);
  documents.push({
    docId,
    title: `${module} — Worksheet & Template Catalog`,
    sourceLabel: `${module} template catalog`,
    sourceType: "template_catalog",
    origin: "generated from template archive filenames",
    module,
    format: "catalog",
    words: wordCount(text),
    chunkCount: docChunks.length,
    sha256: sha(new TextEncoder().encode(text)),
  });
}

// ------------------------------------------------------------------ output
mkdirSync(OUT_DIR, { recursive: true });
writeFileSync(join(OUT_DIR, "corpus.jsonl"), chunks.map((c) => JSON.stringify(c)).join("\n") + "\n");
writeFileSync(
  join(OUT_DIR, "manifest.json"),
  JSON.stringify({ generatedFrom: SOURCE_DIR, documents, skipped, nearDupes, cohorts: auditCohorts(cohortMentions), cohortMentions }, null, 2),
);

// ------------------------------------------------------------------ report
const byType = new Map<string, { docs: number; chunks: number; words: number }>();
for (const d of documents) {
  const agg = byType.get(d.sourceType) ?? { docs: 0, chunks: 0, words: 0 };
  agg.docs++;
  agg.chunks += d.chunkCount;
  agg.words += d.words;
  byType.set(d.sourceType, agg);
}

console.log("\n=== CHUNKS PER SOURCE ===");
for (const d of documents.slice().sort((a, b) => b.chunkCount - a.chunkCount)) {
  console.log(`${String(d.chunkCount).padStart(5)}  ${String(d.words).padStart(7)}w  ${d.title}`);
}
console.log("\n=== BY SOURCE TYPE ===");
for (const [type, agg] of byType) {
  console.log(`${type.padEnd(20)} ${String(agg.docs).padStart(4)} docs  ${String(agg.chunks).padStart(5)} chunks  ${agg.words.toLocaleString()} words`);
}
console.log(`\nTOTAL: ${documents.length} documents, ${chunks.length} chunks, ${documents.reduce((n, d) => n + d.words, 0).toLocaleString()} words`);
console.log(`Catalog-only worksheets: ${[...catalogByModule.values()].reduce((n, e) => n + e.length, 0)}`);

console.log("\n=== SKIPPED ===");
const reasons = new Map<string, number>();
for (const s of skipped) {
  const key = s.reason.replace(/duplicate content of .*/, "duplicate content (hash match)");
  reasons.set(key, (reasons.get(key) ?? 0) + 1);
}
for (const [reason, n] of [...reasons.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`${String(n).padStart(4)}  ${reason}`);
}
const cohorts = auditCohorts(cohortMentions);
console.log("\n=== COHORT DATES FOUND ===");
if (cohorts.conflict) {
  console.warn(`CONFLICT: the corpus advertises ${cohorts.distinct.length} different cohorts: ${cohorts.distinct.join(", ")}`);
  for (const c of cohorts.distinct) {
    const m = cohortMentions.find((x) => x.cohort === c)!;
    console.warn(`  ${c.padEnd(12)} ${m.source} — "${m.excerpt.slice(0, 100)}"`);
  }
  console.warn("No cohort date is hardcoded; fix the source and re-run ingest.");
} else {
  console.log(`  ${cohorts.distinct.join(", ") || "none found"}`);
}

console.log(`\nWrote ${join(OUT_DIR, "corpus.jsonl")} and manifest.json`);
