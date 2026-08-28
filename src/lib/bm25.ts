/**
 * Lexical half of hybrid retrieval.
 *
 * Vector search alone loses on exactly the questions this bot must not get
 * wrong: "Rhode Island", "$3,000", "100 or fewer W-2 employees" are rare tokens
 * whose presence or absence decides an eligibility answer, and embeddings blur
 * them into general topical similarity. In production the lexical rank comes
 * from Postgres `ts_rank_cd`; this in-process implementation backs the offline
 * evaluation harness so retrieval can be scored without a database.
 */

const STOPWORDS = new Set(
  "a an and are as at be by for from has have i in is it its of on or that the to was were will with you your we our do does can what how why when who".split(" "),
);

/**
 * Postgres `to_tsvector('english', ...)` stems, so the offline harness has to
 * stem too or it scores a different index than production does. This is the
 * Porter step-1 suffix set, which is where nearly all of the recall lives
 * ("assessing" -> "assess" is what connects a visitor's phrasing to a
 * worksheet named "9 Box Performance Model ... Assessment").
 */
function stem(token: string): string {
  let t = token;
  if (t.length <= 3) return t;
  t = t.replace(/(ss|i)es$/, "$1").replace(/([^aeious])s$/, "$1");
  for (const [re, sub] of [
    [/(at|bl|iz)(ing|ed)$/, "$1e"],
    [/([aeiou][a-z]{2,})(ing|edly|ed)$/, "$1"],
    [/(.{3,})(ment|ness|tion|ions|ance|ence)$/, "$1"],
    [/(.{3,})(ly|ility|ity|ive|ful)$/, "$1"],
  ] as Array<[RegExp, string]>) {
    const next = t.replace(re, sub);
    if (next !== t && next.length >= 3) return next;
  }
  return t;
}

export function tokenize(text: string): string[] {
  return (text.toLowerCase().match(/[a-z0-9][a-z0-9'$,.]*/g) ?? [])
    .map((t) => t.replace(/[',.]+$/, ""))
    .filter((t) => t.length > 1 && !STOPWORDS.has(t))
    .map((t) => (/[0-9$]/.test(t) ? t : stem(t)));
}

export interface Scored<T> {
  item: T;
  score: number;
}

export class Bm25Index<T extends { id: string; text: string }> {
  private readonly docs: T[] = [];
  private readonly termFreq: Array<Map<string, number>> = [];
  private readonly docFreq = new Map<string, number>();
  private readonly lengths: number[] = [];
  private avgLength = 0;

  constructor(
    docs: T[],
    private readonly k1 = 1.2,
    private readonly b = 0.75,
  ) {
    for (const doc of docs) {
      const tokens = tokenize(doc.text);
      const tf = new Map<string, number>();
      for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + 1);
      for (const t of tf.keys()) this.docFreq.set(t, (this.docFreq.get(t) ?? 0) + 1);
      this.docs.push(doc);
      this.termFreq.push(tf);
      this.lengths.push(tokens.length);
    }
    this.avgLength = this.lengths.reduce((a, b) => a + b, 0) / (this.lengths.length || 1);
  }

  search(query: string, limit = 10): Array<Scored<T>> {
    const terms = tokenize(query);
    const n = this.docs.length;
    const scores = new Float64Array(n);
    for (const term of terms) {
      const df = this.docFreq.get(term);
      if (!df) continue;
      const idf = Math.log(1 + (n - df + 0.5) / (df + 0.5));
      for (let i = 0; i < n; i++) {
        const f = this.termFreq[i]!.get(term);
        if (!f) continue;
        const norm = 1 - this.b + this.b * (this.lengths[i]! / this.avgLength);
        scores[i]! += idf * ((f * (this.k1 + 1)) / (f + this.k1 * norm));
      }
    }
    return Array.from(scores)
      .map((score, i) => ({ item: this.docs[i]!, score }))
      .filter((s) => s.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  }
}
