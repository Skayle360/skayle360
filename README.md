# SCALE UP Assistant — Skayle 360

Grounded RAG chatbot for skayle360.com. Answers only from Skayle 360's own
material, cites every factual claim, captures leads, routes to the booking link,
and emails Chris when it can't answer.

## Quick start

```bash
npm install
cp .env.example .env            # fill in DATABASE_URL and ANTHROPIC_API_KEY
psql "$DATABASE_URL" -f db/schema.sql

npm run ingest:crawl            # website -> data/website.json
npm run ingest                  # documents + site -> data/corpus.jsonl
npm run ingest:load             # -> Postgres, then embeddings if a key is set

npm run build:widget
npm run dev                     # http://localhost:3000
```

Every script reads `.env` automatically; no need to prefix `DATABASE_URL=`.

`ANTHROPIC_API_KEY` is the only hard requirement for answering. Without
`VOYAGE_API_KEY` retrieval runs lexical-only, and without `RESEND_API_KEY` plus
`ESCALATION_TEST_INBOX` escalations are recorded but not emailed — both are
reported at `/api/health` and in the server log rather than failing quietly.

Requires `pdftotext` (poppler-utils) on the ingest machine. Not needed at runtime.

**No Postgres to hand?** One container gives you pgvector:

```bash
docker run -d --name skayle-pg -e POSTGRES_PASSWORD=dev -e POSTGRES_DB=skayle \
  -p 55432:5432 pgvector/pgvector:pg16
# DATABASE_URL=postgres://postgres:dev@localhost:55432/skayle
```

`/embed-test.html` renders the widget on a page with deliberately hostile global
CSS, to check the iframe isolation the way Webflow will exercise it.

Check the index at `/api/health`. Run `npm test` for retrieval, grounding, and
tool checks (needs `DATABASE_URL`).

## Embed

Webflow › Site Settings › Custom Code › Footer:

```html
<script src="https://chat.skayle360.com/widget.js" defer></script>
```

The widget renders inside an iframe, so Webflow's global stylesheet cannot reach
it. CORS and `frame-ancestors` are locked to `ALLOWED_ORIGINS`.

## How grounding is enforced

Retrieved chunks are sent as `document` blocks with `citations: {enabled: true}`,
so the model's response comes back split into text blocks, each cited span
carrying character offsets into the exact text we supplied.

A block reaches the visitor only if it is cited or is plainly conversational
(`src/lib/grounding.ts`). The check runs per block during streaming, so an
uncited claim is never shown and then retracted. A response that asserts
something and cites nothing is withheld entirely and escalated to Chris.

This is mechanical, not a prompt instruction: the model cannot drift out of it.

## Where things live

| Concern | File |
|---|---|
| Booking routes, emails, CORS, retrieval tuning | `config/app.ts` |
| Which documents are indexed | `config/sources.ts` |
| Widget colours | `config/theme.ts` |
| How much course content to give away | `src/lib/prompt.ts` → `CONTENT_DEPTH_POLICY` |
| Grounding enforcement | `src/lib/grounding.ts` |
| Hybrid retrieval (BM25 + pgvector, RRF) | `src/lib/retrieval.ts` |
| Lead destinations | `src/lib/sinks/` |

## Retrieval

Two arms fused with reciprocal rank fusion:

- **BM25 in SQL** over `chunk_terms` / `lexeme_stats`. Postgres `ts_rank_cd` has
  no IDF, so it ranked eligibility questions on "employees" (20% of chunks)
  instead of "Massachusetts" (2%). BM25's IDF is what makes the rare, decisive
  term win. This arm alone answers all ten evaluation questions.
- **pgvector cosine**, active only once `VOYAGE_API_KEY` or `OPENAI_API_KEY` is
  set. Without a key the system runs lexical-only and says so at `/api/health`.

`ingest/probe/pg-retrieval-test.ts` is the evaluation harness — run it after any
change to chunking, the embedder, or the source policy.

Retrieval score is **not** an answerability signal on this corpus: measured
BM25 scores for answerable questions run 5.0–21.2 and for unanswerable ones
0.0–11.4, so the distributions overlap. `isThin()` therefore only skips a
pointless API call; citations are the real gate.

## Re-indexing

Ingestion is re-runnable and deterministic — same inputs, same chunk ids.

- **Documents change** → `npm run ingest && npm run ingest:load` (needs the
  source files, so this runs locally or in CI).
- **Website changes** → weekly cron at `/api/cron/crawl`, or `npm run ingest:crawl`.
  The cron replaces only `source_type = 'website'` rows; it never touches the
  document corpus, because the source files do not exist on Vercel.

Both paths rebuild `chunk_terms`, `lexeme_stats` and `corpus_stats` — a stale
IDF silently degrades every lexical query.

## Leads

Postgres is the source of truth (`leads`, `escalations`). `LeadSink` fans out to
mirrors best-effort; a mirror failure is logged and never costs a lead or
surfaces an error to the visitor. The Google Sheets mirror is a stub pending
client confirmation — see `src/lib/sinks/sheets-sink.ts` for what it will need.

## Escalation email

Rows are written to `escalations` before any send is attempted, so mail failure
degrades to a queued row (`escalations_pending_idx` is the retry queue).

Sending requires either `ESCALATION_TEST_INBOX` or `ESCALATION_LIVE=true`.
Without one it stays queued — a deploy with a Resend key but no test inbox must
not start mailing the client from an unverified domain.

**When DNS is available:** verify `notify.skayle360.com`, not the root domain.
The root SPF already carries several mechanisms and one more include risks the
10-lookup limit, which invalidates the whole record and would take the client's
existing mail down with it.

## Admin page

`/admin`, password from `ADMIN_PASSWORD`. Three tabs:

- **Documents** — upload or remove sources, watch the pipeline, see what is
  indexed. Removals are recorded so a re-ingest does not restore them.
- **Chris's notes** — plain sentences that override the website and the
  documents. This is the client's "I can update the knowledge myself".
- **Prompts** — tone, length, how hard to ask for details, how much course
  content to give away. The grounding rules are shown but locked.

Both the notes and the prompts keep a full edit history with one-click restore.

## Deploying

See `docs/DEPLOY.md`.

## Open questions

The client answered all seven on 2026-08-27; `docs/PENDING.md` records the
answers and the findings that came with them.
