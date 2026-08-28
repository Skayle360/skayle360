/**
 * The blog archive is a working folder, not a published feed: several posts
 * exist twice as an early draft and a final version under different filenames
 * ("Blog - The Value Stick" / "Blog Post - The Value Stick"). Hash-dedupe misses
 * these because a handful of edited words changes the bytes. Two near-identical
 * chunks in the index are worse than one — they crowd a retrieval slot that a
 * different fact should have won, and the model may cite the stale draft.
 */

const SHINGLE = 5;

function shingles(text: string): Set<string> {
  const tokens = text.toLowerCase().match(/[a-z0-9']+/g) ?? [];
  const out = new Set<string>();
  for (let i = 0; i + SHINGLE <= tokens.length; i++) out.add(tokens.slice(i, i + SHINGLE).join(" "));
  return out;
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  let shared = 0;
  for (const s of small) if (large.has(s)) shared++;
  return shared / (a.size + b.size - shared);
}

export interface NearDupe {
  kept: string;
  dropped: string;
  similarity: number;
}

/**
 * Keeps the longest member of each near-duplicate cluster on the assumption
 * that the fuller draft is the finished one, and reports every drop.
 */
export function dropNearDuplicates<T extends { key: string; text: string }>(
  items: T[],
  threshold = 0.6,
): { kept: T[]; dupes: NearDupe[] } {
  const ordered = items.slice().sort((a, b) => b.text.length - a.text.length);
  const kept: Array<T & { shingles: Set<string> }> = [];
  const dupes: NearDupe[] = [];

  for (const item of ordered) {
    const sh = shingles(item.text);
    const match = kept.find((k) => jaccard(k.shingles, sh) >= threshold);
    if (match) {
      dupes.push({ kept: match.key, dropped: item.key, similarity: Number(jaccard(match.shingles, sh).toFixed(3)) });
      continue;
    }
    kept.push({ ...item, shingles: sh });
  }
  return { kept: kept.map(({ shingles: _s, ...rest }) => rest as unknown as T), dupes };
}
