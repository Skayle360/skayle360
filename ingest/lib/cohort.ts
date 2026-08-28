/**
 * PENDING CLIENT ANSWER: the site currently advertises two different cohorts —
 * /programs says "Winter 2027 · Jan 19—Apr 1, 2027" while / and /grant-funding
 * say "Fall 2026". No cohort date is hardcoded anywhere in this codebase; the
 * answer comes from the knowledge base, so a correction is a re-index rather
 * than a deploy. This detector exists so the conflict is loud at ingest time
 * and again at query time, instead of being discovered by a visitor.
 */
export const COHORT_DATE_PATTERN = /\b(winter|spring|summer|fall|autumn)\s+(20\d{2})\b/gi;

export interface CohortMention {
  cohort: string;
  source: string;
  excerpt: string;
}

export function findCohortMentions(source: string, text: string): CohortMention[] {
  const out: CohortMention[] = [];
  for (const m of text.matchAll(COHORT_DATE_PATTERN)) {
    const season = m[1]!.toLowerCase();
    const cohort = `${season[0]!.toUpperCase()}${season.slice(1)} ${m[2]}`;
    const at = m.index ?? 0;
    out.push({ cohort, source, excerpt: text.slice(Math.max(0, at - 60), at + 90).replace(/\s+/g, " ").trim() });
  }
  return out;
}

/** Distinct cohort labels found. More than one means the corpus disagrees. */
export function auditCohorts(mentions: CohortMention[]): { distinct: string[]; conflict: boolean } {
  const distinct = [...new Set(mentions.map((m) => m.cohort))].sort();
  return { distinct, conflict: distinct.length > 1 };
}
