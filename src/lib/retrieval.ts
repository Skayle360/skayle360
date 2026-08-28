import { db } from "./db";
import { getEmbedder, toVectorLiteral } from "./embeddings";
import { RETRIEVAL, SOURCE_WEIGHTS, PROGRAM_DOC_IDS, PROGRAM_DOC_BOOST } from "../../config/app";

export interface RetrievedChunk {
  id: string;
  docId: string;
  text: string;
  heading: string | null;
  locator: string | null;
  title: string;
  sourceLabel: string;
  sourceType: string;
  origin: string;
  /** Fused rank score — for ordering only. */
  score: number;
  /** Best raw per-arm score — this is what thinness is judged on. */
  lexScore: number;
  semScore: number;
  arms: string[];
}

const RRF_K = 60;

/**
 * Cache of query vectors.
 *
 * Embedding the visitor's question is a call to a third party on the critical
 * path of every message — roughly 900ms measured. Visitors ask the same handful
 * of things ("how much does it cost", "do we qualify"), so a small cache
 * removes that call outright for repeat questions. Keyed on the normalised
 * question, capped so it cannot grow without bound.
 */
const QUERY_VECTOR_CACHE = new Map<string, number[]>();
const QUERY_CACHE_MAX = 500;

function cacheKey(q: string): string {
  return q.toLowerCase().replace(/\s+/g, " ").replace(/[^a-z0-9 ]/g, "").trim();
}

interface Row {
  id: string; doc_id: string; text: string; heading: string | null; locator: string | null;
  title: string; source_label: string; source_type: string; origin: string; raw: number;
}

const SELECT = `SELECT c.id, c.doc_id, c.text, c.heading, c.locator,
                       d.title, d.source_label, d.source_type, d.origin`;


/**
 * Visitors type whole sentences. `websearch_to_tsquery` and `plainto_tsquery`
 * both AND every term, so "we're a nonprofit with 40 employees in Rhode Island,
 * do we qualify?" matched zero rows — the corpus contains the answer but no
 * chunk contains all fourteen words.
 *
 * ORing the terms fixes recall but not ranking: `ts_rank_cd` has no IDF
 * component, so an OR query ranks on "employees" (20% of chunks) rather than
 * "Massachusetts" (2%) and returns a blog post about toxic employees. The
 * lexical arm therefore scores real BM25 against `chunk_terms` / `lexeme_stats`,
 * where IDF makes the rare, decisive term dominate. On the eligibility
 * questions this is the difference between a correct answer and a plausible
 * wrong one, so it is worth the extra table.
 */
const BM25_K1 = 1.2;
const BM25_B = 0.75;

/**
 * Lexical arm: BM25 over the query's lexemes.
 *
 * Query lexemes come from `to_tsvector` so they are stemmed exactly the way
 * `chunk_terms.word` was — no second stemming pass, no drift between how the
 * index and the query are tokenised.
 */
async function lexicalBm25(query: string, limit: number): Promise<Row[]> {
  const { rows } = await db().query<Row>(
    `WITH stats AS (SELECT chunk_count::float8 AS n, GREATEST(avg_len, 1) AS avg_len FROM corpus_stats WHERE id),
          terms AS (SELECT DISTINCT unnest(tsvector_to_array(to_tsvector('english', $1))) AS word),
          scored AS (
            SELECT ct.chunk_id,
                   SUM(
                     ln(1 + (stats.n - ls.ndoc + 0.5) / (ls.ndoc + 0.5))
                     * (ct.tf * (${BM25_K1} + 1))
                     / (ct.tf + ${BM25_K1} * (1 - ${BM25_B} + ${BM25_B} * (ch.token_count / stats.avg_len)))
                   ) AS raw
              FROM terms
              JOIN chunk_terms  ct ON ct.word = terms.word
              JOIN lexeme_stats ls ON ls.word = terms.word
              JOIN chunks       ch ON ch.id  = ct.chunk_id
             CROSS JOIN stats
             GROUP BY ct.chunk_id
          )
     ${SELECT}, scored.raw
       FROM scored
       JOIN chunks c ON c.id = scored.chunk_id
       JOIN documents d USING (doc_id)
      ORDER BY scored.raw DESC
      LIMIT $2`,
    [query, limit],
  );
  return rows;
}

/**
 * Phrase arm: every term present. Rarely fires on a long question, but when it
 * does the match is precise, so RRF should see it as its own ranking.
 */
async function lexicalStrict(query: string, limit: number): Promise<Row[]> {
  const { rows } = await db().query<Row>(
    `${SELECT}, ts_rank_cd(c.tsv, websearch_to_tsquery('english', $1)) AS raw
       FROM chunks c JOIN documents d USING (doc_id)
      WHERE c.tsv @@ websearch_to_tsquery('english', $1)
      ORDER BY raw DESC LIMIT $2`,
    [query, limit],
  );
  return rows;
}

/**
 * Vector arm. Returns nothing rather than blocking.
 *
 * Embedding the query means one call to a third party on the critical path of
 * every message. If that call is rate limited, slow, or down, the right
 * behaviour is to answer from the lexical arm alone — which on its own scored
 * 10/10 on the evaluation set — not to hold the visitor while it retries.
 */
async function semantic(query: string, limit: number): Promise<Row[]> {
  const embedder = getEmbedder();
  if (!embedder) return [];
  const key = cacheKey(query);
  let vector = QUERY_VECTOR_CACHE.get(key);
  if (!vector) {
    try {
      [vector] = await embedder.embed([query], "query");
    } catch (err) {
      console.warn(`[retrieval] vector arm unavailable, using lexical only: ${err instanceof Error ? err.message : err}`);
      return [];
    }
    if (!vector) return [];
    // Oldest-first eviction; Map preserves insertion order.
    if (QUERY_VECTOR_CACHE.size >= QUERY_CACHE_MAX) {
      QUERY_VECTOR_CACHE.delete(QUERY_VECTOR_CACHE.keys().next().value!);
    }
    QUERY_VECTOR_CACHE.set(key, vector);
  }
  const { rows } = await db().query<Row>(
    `${SELECT}, 1 - (c.embedding <=> $1::vector) AS raw
       FROM chunks c JOIN documents d USING (doc_id)
      WHERE c.embedding IS NOT NULL
      ORDER BY c.embedding <=> $1::vector LIMIT $2`,
    [toVectorLiteral(vector), limit],
  );
  return rows;
}

/**
 * Reciprocal rank fusion. Chosen over score normalisation because `ts_rank_cd`
 * and cosine similarity are not on comparable scales and their ranges shift
 * per query; RRF needs only the ranks, so one arm returning large raw numbers
 * cannot dominate the other.
 */
export async function retrieve(query: string, topK: number = RETRIEVAL.topK): Promise<RetrievedChunk[]> {
  const n = RETRIEVAL.candidatesPerArm;
  const [bm25, strict, sem] = await Promise.all([
    lexicalBm25(query, n),
    lexicalStrict(query, n),
    semantic(query, n),
  ]);

  /**
   * Fusion is between two *independent* signals: keyword and meaning.
   *
   * BM25 and the phrase arm are both keyword search over the same index, so
   * they agree on the same chunks and, fused separately, each contributed its
   * own score. A word-matching chunk therefore collected two votes to a
   * semantic-only chunk's one, and keyword won every close call by
   * construction rather than by being right.
   *
   * Measured cost of that: for "how big can my company be?" the chunk stating
   * "100 or fewer W-2 employees" was found by the semantic arm but fused to
   * rank 28, so it never reached the model and the bot escalated a question it
   * could answer. Collapsing the two keyword arms into one signal — best rank
   * wins, not sum — makes it a fair contest between words and meaning.
   */
  const keyword = new Map<string, { row: Row; rank: number; raw: number }>();
  const consider = (rows: Row[], bonus: number) => {
    rows.forEach((row, i) => {
      const rank = i * bonus;
      const prev = keyword.get(row.id);
      if (!prev || rank < prev.rank) keyword.set(row.id, { row, rank, raw: Number(row.raw) });
      else prev.raw = Math.max(prev.raw, Number(row.raw));
    });
  };
  consider(bm25, 1);
  // An exact all-terms match is a stronger keyword signal, so it earns a better
  // effective rank — but still inside the single keyword vote, not beside it.
  consider(strict, 0.8);

  const fused = new Map<string, { row: Row; score: number; lex: number; sem: number; arms: string[] }>();
  const add = (row: Row, rank: number, arm: string, raw: number) => {
    const e = fused.get(row.id) ?? { row, score: 0, lex: 0, sem: 0, arms: [] };
    e.score += 1 / (RRF_K + rank + 1);
    if (arm === "semantic") e.sem = Math.max(e.sem, raw);
    else e.lex = Math.max(e.lex, raw);
    e.arms.push(arm);
    fused.set(row.id, e);
  };

  [...keyword.values()]
    .sort((a, b) => a.rank - b.rank)
    .forEach((k, i) => add(k.row, i, "keyword", k.raw));
  sem.forEach((row, i) => add(row, i, "semantic", Number(row.raw)));

  // Weight by what the source is about, not only by how well its words match.
  // A visitor asking about the program should reach the pages describing the
  // program, not the far larger body of material that teaches business topics.
  for (const e of fused.values()) {
    e.score *= SOURCE_WEIGHTS[e.row.source_type] ?? 1;
    if (PROGRAM_DOC_IDS.includes(e.row.doc_id)) e.score *= PROGRAM_DOC_BOOST;
  }

  return [...fused.values()]
    .sort((a, b) => b.score - a.score)
    .slice(0, topK)
    .map(({ row, score, lex, sem: s, arms }) => ({
      id: row.id, docId: row.doc_id, text: row.text, heading: row.heading, locator: row.locator,
      title: row.title, sourceLabel: row.source_label, sourceType: row.source_type, origin: row.origin,
      score, lexScore: lex, semScore: s, arms,
    }));
}

/**
 * Whether retrieval came back empty enough that calling the model is pointless.
 *
 * NOT an answerability test — see the note on RETRIEVAL.minLexScore. Grounding
 * is enforced afterwards, by requiring citations on the response.
 *
 * Judged on raw per-arm scores, never on the fused score: RRF values are
 * rank-derived constants (a top hit is always ~1/61 regardless of how good it
 * is), so thresholding those would only ask "did anything come back at all".
 */
export function isThin(results: RetrievedChunk[]): boolean {
  if (!results.length) return true;
  const bestLex = Math.max(...results.map((r) => r.lexScore));
  const bestSem = Math.max(...results.map((r) => r.semScore));
  return bestLex < RETRIEVAL.minLexScore && bestSem < RETRIEVAL.minSemScore;
}
