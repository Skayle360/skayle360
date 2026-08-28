import type { Segment } from "@ingest/lib/extract";

export interface Chunk {
  /** Stable id: `${docId}#${index}` — re-running ingestion reproduces it exactly. */
  id: string;
  docId: string;
  index: number;
  text: string;
  /** Human-readable locator for the citation UI, e.g. "p. 4" or "slides 12–13". */
  locator: string | null;
  ordinalStart: number | null;
  ordinalEnd: number | null;
  heading: string | null;
  charCount: number;
}

const TARGET_CHARS = 1800;
const MAX_CHARS = 2600;
const OVERLAP_CHARS = 220;
const MIN_CHARS = 120;

interface Block {
  text: string;
  ordinal: number | null;
  heading: string | null;
}

/**
 * Section headers in this corpus are consistently short all-caps lines — the
 * decks and the branded worksheets both use them ("WHY THIS MATTERS",
 * "02 — MASSACHUSETTS WTFP EXPRESS GRANT"). Carrying the nearest one into each
 * chunk gives retrieval a topic anchor that the body prose often omits.
 */
function isHeading(line: string): boolean {
  const t = line.trim();
  if (t.length < 3 || t.length > 90) return false;
  if (/[.!?]$/.test(t)) return false;
  const letters = t.replace(/[^A-Za-z]/g, "");
  if (letters.length < 3) return false;
  return letters === letters.toUpperCase();
}

function toBlocks(segments: Segment[]): Block[] {
  const blocks: Block[] = [];
  let heading: string | null = null;
  for (const seg of segments) {
    for (const para of seg.text.split(/\n{2,}/)) {
      const trimmed = para.trim();
      if (!trimmed) continue;
      const lines = trimmed.split("\n");
      // A lone all-caps line is a header for what follows, not content itself.
      if (lines.length === 1 && isHeading(trimmed)) {
        heading = trimmed;
        continue;
      }
      if (lines[0] && isHeading(lines[0])) heading = lines[0].trim();
      blocks.push({ text: trimmed, ordinal: seg.ordinal, heading });
    }
  }
  return blocks;
}

/** Split a single oversized block on sentence boundaries. */
function splitOversized(text: string): string[] {
  const sentences = text.match(/[^.!?\n]+[.!?]*[\s]*/g) ?? [text];
  const out: string[] = [];
  let cur = "";
  for (const s of sentences) {
    if (cur.length + s.length > MAX_CHARS && cur) {
      out.push(cur.trim());
      cur = "";
    }
    cur += s;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

function formatLocator(label: Segment["ordinalLabel"], start: number | null, end: number | null): string | null {
  if (label === null || start === null) return null;
  if (end === null || end === start) return `${label}${start}`.replace("slide ", "slide ");
  return label === "p." ? `pp. ${start}–${end}` : `slides ${start}–${end}`;
}

export function chunkDocument(docId: string, segments: Segment[]): Chunk[] {
  const label = segments.find((s) => s.ordinalLabel)?.ordinalLabel ?? null;
  const blocks = toBlocks(segments).flatMap((b) =>
    b.text.length > MAX_CHARS ? splitOversized(b.text).map((t) => ({ ...b, text: t })) : [b],
  );

  const chunks: Chunk[] = [];
  let buf: Block[] = [];
  let bufLen = 0;

  const flush = () => {
    if (!buf.length) return;
    const text = buf.map((b) => b.text).join("\n\n");
    if (text.length < MIN_CHARS && chunks.length) {
      // Too small to stand alone — fold it into the previous chunk instead of
      // emitting a fragment that will never win a retrieval race.
      const prev = chunks[chunks.length - 1]!;
      prev.text += "\n\n" + text;
      prev.charCount = prev.text.length;
      const last = buf[buf.length - 1]!;
      if (last.ordinal !== null) prev.ordinalEnd = last.ordinal;
      prev.locator = formatLocator(label, prev.ordinalStart, prev.ordinalEnd);
      buf = [];
      bufLen = 0;
      return;
    }
    const ordinals = buf.map((b) => b.ordinal).filter((o): o is number => o !== null);
    const start = ordinals.length ? Math.min(...ordinals) : null;
    const end = ordinals.length ? Math.max(...ordinals) : null;
    const index = chunks.length;
    chunks.push({
      id: `${docId}#${index}`,
      docId,
      index,
      text,
      heading: buf.find((b) => b.heading)?.heading ?? null,
      ordinalStart: start,
      ordinalEnd: end,
      locator: formatLocator(label, start, end),
      charCount: text.length,
    });

    // Carry the tail forward so a fact split across the seam stays retrievable.
    const overlap: Block[] = [];
    let len = 0;
    for (let i = buf.length - 1; i >= 0 && len < OVERLAP_CHARS; i--) {
      overlap.unshift(buf[i]!);
      len += buf[i]!.text.length;
    }
    buf = overlap.length < buf.length ? overlap : [];
    bufLen = buf.reduce((n, b) => n + b.text.length, 0);
  };

  for (const block of blocks) {
    if (bufLen + block.text.length > TARGET_CHARS && bufLen > 0) flush();
    buf.push(block);
    bufLen += block.text.length + 2;
  }
  flush();
  return chunks;
}
