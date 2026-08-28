/**
 * Embeddings are pluggable because the provider is not a decision this project
 * should bake in. Anthropic has no embeddings endpoint, so the vector arm of
 * retrieval uses a third party; the interface keeps that swap to one file.
 *
 * Dimension must match `vector(1024)` in db/schema.sql. Both implementations
 * below are configured to produce 1024 dimensions.
 */
export const EMBEDDING_DIM = 1024;

export interface EmbedOptions {
  /**
   * How long to keep retrying a rate limit.
   *
   * Indexing can afford to wait minutes; a visitor cannot. A live query that
   * blocks on a 429 turns a two-second answer into a sixty-second one, which
   * is worse than answering without the vector arm at all.
   */
  maxAttempts?: number;
  timeoutMs?: number;
}

export interface Embedder {
  readonly name: string;
  embed(texts: string[], kind: "document" | "query", opts?: EmbedOptions): Promise<number[][]>;
}

class VoyageEmbedder implements Embedder {
  readonly name = "voyage-3-large";
  constructor(private readonly apiKey: string) {}

  /**
   * Retries on 429. A Voyage account with no payment method is capped at 3
   * requests and 10K tokens per minute — generous enough to index this corpus,
   * but only if the caller waits rather than failing the whole run. Backoff is
   * long because the window is per-minute, so a short retry just fails again.
   */
  async embed(texts: string[], kind: "document" | "query", opts: EmbedOptions = {}): Promise<number[][]> {
    // A query defaults to one attempt: the caller degrades to lexical search
    // rather than making someone wait out a rate-limit window.
    const maxAttempts = opts.maxAttempts ?? (kind === "query" ? 1 : 6);
    const timeoutMs = opts.timeoutMs ?? (kind === "query" ? 4_000 : 60_000);
    for (let attempt = 1; ; attempt++) {
      const res = await fetch("https://api.voyageai.com/v1/embeddings", {
        method: "POST",
        signal: AbortSignal.timeout(timeoutMs),
        headers: { "content-type": "application/json", authorization: `Bearer ${this.apiKey}` },
        body: JSON.stringify({
          model: this.name,
          input: texts,
          input_type: kind, // asymmetric embeddings: queries and documents differ
          output_dimension: EMBEDDING_DIM,
        }),
      });
      if (res.ok) {
        const json = (await res.json()) as { data: Array<{ embedding: number[]; index: number }> };
        return json.data.sort((a, b) => a.index - b.index).map((d) => d.embedding);
      }
      const body = await res.text();
      if (res.status !== 429 || attempt >= maxAttempts) {
        throw new Error(`Voyage ${res.status}: ${body.slice(0, 300)}`);
      }
      const waitMs = Math.min(75_000, 20_000 * attempt);
      process.stderr.write(`\n  rate limited, waiting ${Math.round(waitMs / 1000)}s (attempt ${attempt}/${maxAttempts})\n`);
      await new Promise((r) => setTimeout(r, waitMs));
    }
  }
}

class OpenAIEmbedder implements Embedder {
  readonly name = "text-embedding-3-large";
  constructor(private readonly apiKey: string) {}

  async embed(texts: string[], _kind: "document" | "query" = "document", opts: EmbedOptions = {}): Promise<number[][]> {
    const res = await fetch("https://api.openai.com/v1/embeddings", {
      method: "POST",
      signal: AbortSignal.timeout(opts.timeoutMs ?? 20_000),
      headers: { "content-type": "application/json", authorization: `Bearer ${this.apiKey}` },
      body: JSON.stringify({ model: this.name, input: texts, dimensions: EMBEDDING_DIM }),
    });
    if (!res.ok) throw new Error(`OpenAI ${res.status}: ${await res.text()}`);
    const json = (await res.json()) as { data: Array<{ embedding: number[]; index: number }> };
    return json.data.sort((a, b) => a.index - b.index).map((d) => d.embedding);
  }
}

/**
 * Returns null when no provider is configured. That is a supported state, not
 * an error: retrieval degrades to its lexical arm, which on this corpus already
 * answers every eligibility question correctly. It must degrade loudly, though —
 * callers log it.
 */
export function getEmbedder(): Embedder | null {
  if (process.env.VOYAGE_API_KEY) return new VoyageEmbedder(process.env.VOYAGE_API_KEY);
  if (process.env.OPENAI_API_KEY) return new OpenAIEmbedder(process.env.OPENAI_API_KEY);
  return null;
}

/**
 * Rough token count for batching. Voyage bills and rate-limits on tokens, so
 * batches have to be sized by tokens rather than by item count — 96 chunks of
 * this corpus is roughly 46K tokens, far over a 10K-per-minute allowance.
 */
export const estimateTokens = (text: string): number => Math.ceil(text.length / 4);

/** pgvector's text input format. */
export const toVectorLiteral = (v: number[]): string => `[${v.join(",")}]`;
