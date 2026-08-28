# SCALE UP Assistant — full build context

Handoff document for a session continuing work on this codebase. It records what
was built, what was verified, what was *corrected* from the original brief, and
why the non-obvious decisions were made. Everything below was checked against
the real files, the live site, or a running Postgres — nothing here is assumed.

Repository: `/home/haris-awais/skayle360-chatbot`
Source material: `/home/haris-awais/devminified/ai-agent/`
Built: 2026-08-27

---

## 1. The product

A grounded RAG chatbot for skayle360.com — Skayle 360, a growth consultancy near
Boston run by Chris Ciunci. Their product is SCALE UP: a 50-hour live Zoom
training program for Massachusetts small businesses and nonprofits, in 5 modules
(Strategy, Team, Marketing, Lead Generation, AI). The hook is that the
Massachusetts Workforce Training Fund Express Grant covers up to $3,000, so most
companies pay nothing.

The bot is a lead-generation assistant. Visitors are small business owners
evaluating the program, usually on a phone. The goal of every conversation is a
booked intro call.

Client's five requirements, verbatim:

1. Answers ONLY from a knowledge base I provide
2. Captures name/email/company
3. Routes visitors to the right booking link
4. Emails me when it can't answer
5. I can update the knowledge myself

---

## 2. Verified constants

Do not substitute or re-derive these. Each was checked.

```
BOOKING_URL      = https://calendly.com/chrisciunci/scale-up-discussion   (200 OK)
ESCALATION_EMAIL = cciunci@skayle360.com
SITE             = https://skayle360.com        (Webflow, behind Cloudflare)
STAGING          = https://skayle360.webflow.io
MODEL            = claude-opus-5
```

**The live site links to `calendly.com/chrisciunci/scale-up-grant-call`, which
404s. Never restore it.** There is a test asserting the 404 URL is never
returned (`tests/tools.test.ts`).

All four booking routes (`scale_up_cohort`, `ceo_roundtable`, `nonprofit`,
`general`) map to the one URL today. Routing is still a `route -> url` config map
so more links can be added without touching code.

---

## 3. Stack

- Next.js 15.5 (App Router) + TypeScript, for Vercel
- Postgres + pgvector (Neon or Supabase in production)
- `@anthropic-ai/sdk` 0.121, model `claude-opus-5`
- Preact 10 chat widget, bundled by esbuild, rendered in an iframe
- Resend for transactional email
- `googleapis` installed for the Sheets mirror (stub only — see §9)
- Node 24, `tsx` for scripts, `pdftotext` (poppler-utils) for PDF extraction

---

## 4. Corrections to the original brief

The brief was mostly accurate. Seven things turned out different once checked
against the real files and the live site. These matter because a fresh session
working from the brief alone would reintroduce them.

### 4.1 The site's accent colour is orange, not green

The brief said "green accent". `skayle360-410586.webflow.shared.387501f73.css`
declares exactly one brand variable — `--orange: #e87722` — against near-black
`#201e1b`. There is no green anywhere in the stylesheet. "Match the site's look"
was the real requirement, so the widget uses the verified brand colour.
`config/theme.ts` holds it as a single value.

### 4.2 The file counts are 159 → 137, not 150 → 129

Measured, with zip members expanded and the zip containers themselves not
counted: **159 member files, 137 unique by content hash.** The brief said
150 → 129. Nothing depends on the figure, but a continuing session should not
"fix" the pipeline to reproduce the brief's number.

### 4.3 There are 55 blank worksheets, not ~100

The five template archives hold 78 files: 12 prose documents (indexed in full),
6 confidential PrepU files (excluded), 4 archive-root duplicates, 1 hash
duplicate of the syllabus. That leaves **55** blank worksheets, catalogued by
name.

### 4.4 The blog archive contains 8 draft/final duplicate pairs

Not in the brief. The blog folder is a working directory, so posts exist twice
under different filenames — `Blog - The Value Stick.docx` and
`Blog Post - The Value Stick.docx` are 96% identical. Hash-dedupe misses these
because a few edited words change the bytes. Two near-identical chunks in the
index are worse than one: they crowd a retrieval slot a different fact should
have won, and the model may cite the stale draft.

`ingest/lib/neardupe.ts` clusters on 5-token shingle Jaccard at threshold 0.6,
keeps the longest member, and reports every drop. All 8 were verified by hand as
genuine draft/final pairs of the same post. 54 blog files become 46.

### 4.5 The cohort date conflicts in four places, not two

The brief flagged the site saying both Winter 2027 and Fall 2026. The **source
documents disagree too**:

| Source | Says |
|---|---|
| `skayle360.com/programs` | Cohort **Winter 2027**, Jan 19 – Apr 1, 2027 |
| `skayle360.com/` and `/grant-funding` | **Fall 2026** cohort, limited seats |
| `SCALE UP Training Syllabus.pdf` | "The **Winter 2027** cohort starts January 19" |
| `Chris Ciunci Bio.pdf` | "**Fall 2026** cohort: Sep 15 – Nov 19" |

No cohort date is hardcoded anywhere. Detected at ingest time (`npm run ingest`
prints a CONFLICT block) and again per request (`detectCohortConflict` in
`src/lib/grounding.ts`), which logs a warning and instructs the model to say the
site lists more than one and offer the call rather than choose.

### 4.6 `/training-videos` returns HTTP 401

One of the nine requested crawl paths is behind the site's login. 8 of 9 pages
are indexed. The crawler reports the miss rather than failing.

### 4.7 The "blank" worksheets are not entirely blank

They are indexed by name only, as instructed — but several carry real teaching
prose *above* the fill-in fields. `SCALE UP_Vision_Statement.docx` has
"WHAT IT IS", "WHAT IT ISN'T" and a "WHY THIS MATTERS" section before the first
blank. That is genuinely useful retrieval material currently left out.

Mitigation already in place: the catalog extracts one descriptive sentence from
each worksheet for its purpose line, so entries are the documents' own words
rather than guesses. If the client wants more, index the explanatory header
region and stop at the first form field — a change confined to
`ingest/lib/catalog.ts`.

---

## 5. Phase 1 — ingestion

`npm run ingest:crawl && npm run ingest && npm run ingest:load`

Deterministic and re-runnable: same inputs produce the same doc ids and chunk
ids, so a re-index is always safe. `ingest:load` replaces the corpus inside one
transaction, so a failed re-index leaves the live index untouched.

### Result

**80 documents / 981 chunks / 220,168 words.**

| Source type | Docs | Chunks | Words |
|---|---|---|---|
| program_document | 16 | 620 | 131,886 |
| module_deck | 5 | 168 | 37,414 |
| blog_post | 46 | 150 | 37,285 |
| website | 8 | 36 | 12,325 |
| template_catalog | 5 | 7 | 1,258 |

Largest single sources: Ebook 332 chunks (61,406w), Companion 104 (32,048w),
Module 3 deck 51 (11,525w), Module 1 deck 44 (9,336w), Module 4 deck 33 (7,621w).

Word counts match the brief exactly where it stated them: Ebook 61,406;
Companion 32,048; Syllabus 2,285; Bio 746; decks 37,414 total.

### Skipped — 22 entries

| Count | Reason |
|---|---|
| 8 | near-duplicate blog draft (jaccard 0.66–0.97, each verified by hand) |
| 6 | confidential third-party material (PrepU) — dropped before extraction |
| 4 | archive-root duplicate of the folder copy (`Module 4 Templates.zip`) |
| 1 | `MODULE 1 TEMPLATES (1).zip` — byte-identical, md5 `c40822185d17aeb3505effea9e15c8e6` |
| 1 | hash duplicate of the syllabus, inside `Module 4 Templates.zip` |
| 1 | `.xlsx` content calendar — unsupported format, catalogued by name |
| 1 | `.doc` AI Mega Prompt — legacy format, catalogued by name |

The 6 PrepU documents are another client's confidential strategy work; five are
stamped "PrepU Internal". They are filtered by filename **before extraction**,
never at query time, so their text never enters the pipeline at all.

### Extraction

Proven on these exact files:
- PDF: `pdftotext -layout`. Layout mode is essential — it preserves the
  multi-column callout boxes the syllabus and program summary are built from.
  Without it those columns interleave line-by-line into nonsense. Page numbers
  come from the form-feed separators, which is how citations get "p. 4".
- DOCX: unzip, read `word/document.xml`, break on `</w:p>`, strip tags.
- PPTX: unzip, read `ppt/slides/slideN.xml`, break on `</a:p>`. Slide number
  from the filename, so citations get "slide 12".

### Chunking

`ingest/lib/chunk.ts`. Target 1800 chars, max 2600, overlap 220, min 120.
Splits on paragraph boundaries, falls back to sentences for oversized blocks,
folds undersized tails into the previous chunk rather than emitting fragments
that never win a retrieval race.

Carries a `heading` into each chunk. Section headers in this corpus are
consistently short all-caps lines ("WHY THIS MATTERS", "02 — MASSACHUSETTS WTFP
EXPRESS GRANT"), and the nearest one gives retrieval a topic anchor the body
prose often omits.

### Website crawl

9 paths, weekly. `ingest/lib/crawl-core.ts` is shared by the CLI crawler and the
cron route so both fetch identically.

Strips Webflow chrome: lines appearing on ≥60% of pages are nav/CTA boilerplate,
not content, and indexing them makes every page look identical to a retriever.

**This crawl is not optional.** The CEO Roundtable and the cohort dates exist
only on the website, in no document supplied.

---

## 6. Phase 2 — grounded answering

`src/lib/chat.ts`.

### API shape

```ts
client.beta.messages.stream({
  model: "claude-opus-5",
  max_tokens: 16000,
  betas: ["server-side-fallback-2026-07-01"],
  fallbacks: "default",
  thinking: { type: "adaptive" },        // budget_tokens is REMOVED — 400 on Opus 5
  output_config: { effort: "low" },      // correct for chat, and cheaper
  system: cachedSystem(),
  tools: cachedTools(),
  messages,
})
```

`fallbacks: "default"` requires the beta `server-side-fallback-2026-07-01` and
the `client.beta.messages` namespace. The array form uses the older `-2026-06-01`
header; pairing either header with the other form returns 400.

### Prompt caching — mandatory, not an optimisation

Without it every message repays the full system prompt and tool definitions,
roughly 10x the cost. Render order is `tools` → `system` → `messages`, so
breakpoints go on the last tool definition and on the system block. Everything
volatile — the question, the retrieved documents — lives in `messages`, after
the breakpoint, where it cannot invalidate the prefix.

`TOOL_DEFINITIONS` is a frozen, deterministically ordered array for the same
reason. `SYSTEM_PROMPT` contains no timestamp or per-request value.

`tests/cache.test.ts` asserts `cache_read_input_tokens > 0` on a second request
and prints a render-order checklist on failure. It exits 2 (skip) with no API
key. The chat route also logs a warning if a request reads zero cache tokens —
cache failure is otherwise completely silent.

### Grounding — enforced mechanically

Retrieved chunks go in as `document` content blocks with
`citations: { enabled: true }`. The response comes back split into text blocks;
cited spans carry a `citations` array with `cited_text` and character offsets
into the exact text supplied.

**Citations and structured outputs are mutually exclusive** — sending
`output_config.format` alongside citations returns 400. Answer text uses
citations; everything structured (lead fields, routing) goes through tool calls.
This is why there is no structured-output path anywhere in the codebase.

`src/lib/grounding.ts` decides per content block, during streaming, whether a
block may be shown: it must be cited, or plainly conversational. Deciding at
block level means an uncited claim is never shown and then retracted. A response
that asserts something and cites nothing is withheld entirely and escalated.

**The conversational allowlist must fail closed.** The first version was a
blacklist of claim markers (digits, currency, domain keywords). It passed
*"You will definitely be approved."* — no digits, no currency, no keyword, and
the single most damaging sentence this bot could emit, since grant approval is
the state's determination and not ours. It is now a narrow allowlist of safe
shapes: questions, and short spans naming nothing in particular, both gated
behind claim-marker and assertion-marker tests. Withholding a friendly sentence
costs a little warmth; showing an uncited claim costs the client's credibility.

`tests/grounding.test.ts` — 13 checks, all passing.

### The content-depth policy block

`src/lib/prompt.ts` → `CONTENT_DEPTH_POLICY`. One clearly marked block, the only
place in the codebase expressing how much course content to give away. Two
alternatives are drafted in `CONTENT_DEPTH_ALTERNATIVES` (`more_open`,
`more_closed`); switching is a one-line assignment. No other prompt text depends
on its wording.

---

## 7. Retrieval — the part that needed the most work

`src/lib/retrieval.ts`. Three arms fused with reciprocal rank fusion (k=60).

RRF was chosen over score normalisation because `ts_rank_cd` and cosine
similarity are not on comparable scales and their ranges shift per query; RRF
needs only ranks, so one arm returning large raw numbers cannot dominate.

### Why BM25 in SQL, and not `ts_rank_cd`

This took three iterations. The path matters, because each fix looks unnecessary
until you see what it was fixing:

1. **`websearch_to_tsquery` ANDs every term.** "we're a nonprofit with 40
   employees in Rhode Island, do we qualify?" matched **zero rows** — the corpus
   contains the answer but no chunk contains all fourteen words. Result: 4/10.
2. **ORing the terms fixed recall but not ranking.** `ts_rank_cd` has no IDF
   component, so it ranked on "employees" (20% of chunks) rather than
   "Massachusetts" (2%) and returned a blog post about toxic employees.
   Result: 6/10.
3. **Corpus-derived IDF filtering** of near-stopwords helped but not enough —
   7/10.
4. **Real BM25 in SQL** — 10/10.

BM25 needs per-chunk term frequencies. `unnest(tsvector)` yields
`(lexeme, positions, weights)`, and the position array length is the term
frequency. `ingest/load.ts` expands every chunk's tsvector into `chunk_terms`
(134,205 rows) and rebuilds `lexeme_stats` (6,920 lexemes) and `corpus_stats`
(N=981, avg_len=195.1). Query lexemes come from `to_tsvector`, so they are
stemmed exactly the way `chunk_terms.word` was — no second stemming pass, no
drift between how the index and the query are tokenised.

**Any path that changes any chunk must rebuild all three tables.** A stale IDF
silently degrades every lexical query. Both `ingest/load.ts` and
`src/lib/website-sync.ts` do this.

### Retrieval score is not an answerability signal

Measured on this corpus (`ingest/probe/threshold-probe.ts`):

- answerable questions: best BM25 **5.0 – 21.2**
- unanswerable questions: best BM25 **0.0 – 11.4**

The distributions overlap, so **no threshold separates them**. Term overlap is
not answerability. `isThin()` is therefore only a cheap pre-filter that skips a
pointless API call when nothing matched at all (`minLexScore: 1.0`). Raising it
would suppress answerable questions long before it caught unanswerable ones.

Grounding is the real gate. This is the single most important architectural
consequence in the codebase — do not "fix" `isThin` by raising the threshold.

### Evaluation harness

`ingest/probe/pg-retrieval-test.ts` — 10 questions, **10/10 passing**, including
the hard case ("nonprofit, 40 employees, Rhode Island"), website-only content
(CEO Roundtable), and catalog-only content (Module 2 worksheets). Run it after
any change to chunking, the embedder, or the source policy.

### Vector arm

pgvector cosine over `vector(1024)`, HNSW index. Active only when
`VOYAGE_API_KEY` or `OPENAI_API_KEY` is set — Anthropic has no embeddings
endpoint, so the interface (`src/lib/embeddings.ts`) keeps the provider swap to
one file. Voyage uses `input_type` for asymmetric query/document embeddings.

**Currently inactive** — no key was available. Retrieval runs lexical-only and
`/api/health` reports `retrievalMode`. This is a supported state, not a bug, but
it must degrade loudly.

---

## 8. Phase 3 — tools

`src/lib/tools.ts`. Three, matching the brief:

- `capture_lead(name, email, company, interest)` — all optional. Upserts on
  `conversation_id` so a visitor giving a name early and an email later is one
  lead, not two; `COALESCE` keeps already-known fields. Rejects malformed
  emails and tells the model plainly — a malformed address is worse than none,
  because it looks contactable and is not. **The conversation is never gated
  behind a form.**
- `get_booking_link(route)` — resolves through `BOOKING_ROUTES`; unknown routes
  fall back to `general`. The model is told never to write a URL itself.
- `escalate_to_human(question, context)` — writes a durable row, then fires the
  email without awaiting, so a slow mail provider cannot stall the visitor.

`tests/tools.test.ts` — 17 checks against real Postgres, all passing.

---

## 9. Phases 4–5 — widget and lead storage

### Widget

Single tag for Webflow › Site Settings › Custom Code › Footer:

```html
<script src="https://chat.skayle360.com/widget.js" defer></script>
```

- **Everything is inside one iframe, including the launcher bubble.** Webflow
  ships a global stylesheet with broad element selectors; an in-page widget
  would inherit its button, input and box-sizing rules. The loader (1.3 KB)
  injects no CSS into the host page beyond positioning the frame.
- Preact, not React: 17.9 KB bundle, downloaded by every visitor on every page,
  most on a phone.
- The loader only obeys `postMessage` from its own frame — any page can post to
  the host window.
- Mobile: at ≤480px the open panel takes the viewport rather than floating a
  400px card. Composer input is 16px to stop iOS Safari zooming the page.
- CORS is exact-match against `ALLOWED_ORIGINS` — no wildcard, no suffix
  matching (`evil-skayle360.com` must not pass), no reflecting arbitrary Origin.
- `frame-ancestors` allows embedding from the two client origins.
  `X-Frame-Options` is deliberately **not** set — it has no allowlist form and
  would break the embed entirely.
- `/embed-test.html` renders the widget under deliberately hostile global CSS to
  verify the isolation.

Gotcha already fixed: `/widget` 404s and `/widget/` 308s into that 404, because
Next serves `public/` files only at their literal path. `next.config.ts` has a
rewrite `/widget → /widget/index.html`. Header rules need `/widget` and
`/widget/:path*` as **separate** entries — `/widget:path*` throws
`Can not repeat "path" without a prefix and suffix`.

### Lead storage

**Postgres is the source of truth.** `LeadSink` (`src/lib/sinks/`) fans out:
the authoritative sink must succeed or the request fails; mirrors are
best-effort, logged, and can never cost a lead or surface an error to a visitor.

`GoogleSheetsLeadSink` is a **deliberate stub that throws if called**, registered
only when both `GOOGLE_SHEET_ID`/`GOOGLE_SERVICE_ACCOUNT_JSON` and
`ENABLE_SHEETS_MIRROR=true` are set. A Sheet alone loses leads: the API
rate-limits, and a human editing the tab while a write lands can drop a row with
no error anywhere. The file documents exactly what implementing it needs,
including a backfill over `mirror_status <> 'synced'`.

### Escalation email

Rows are written **before** any send is attempted, so mail failure degrades to a
queued row. `escalations_pending_idx` is the retry queue.

Sending requires `ESCALATION_TEST_INBOX` **or** `ESCALATION_LIVE=true`. Without
one it stays queued. This guard was added deliberately: a deploy with a Resend
key but no test inbox would otherwise start mailing Chris from an unverified
domain, which is mail nobody asked for and which lands in spam at best.

**When DNS lands: verify `notify.skayle360.com`, not the root domain.** The root
SPF already carries several mechanisms and one more include risks the 10-lookup
limit, which invalidates the whole record and would take the client's existing
mail down with it.

---

## 10. Re-indexing — two paths, deliberately different

- **Documents change** → `npm run ingest && npm run ingest:load`. Needs the
  source files, so this runs locally or in CI.
- **Website changes** → weekly cron `GET /api/cron/crawl` (Vercel, Mondays
  07:00 UTC, `vercel.json`), bearer-authed with `CRON_SECRET`.

The cron replaces **only** `source_type = 'website'` rows. This is scoped on
purpose: the cron runs on Vercel, where the source PDFs and decks do not exist,
so a full re-ingest there would delete the document corpus. Verified: after a
live cron run the index still reports 80 docs / 981 chunks and retrieval still
scores 10/10.

---

## 11. Database

`db/schema.sql`, idempotent, safe to re-run on every deploy. Additive
`ALTER TABLE ... ADD COLUMN IF NOT EXISTS` for columns added after first
release, so an existing deployment picks them up without a manual migration.

Tables: `documents`, `chunks` (with a **generated** `tsv` column so the lexical
index can never drift out of sync with `text`), `chunk_terms`, `lexeme_stats`,
`corpus_stats`, `leads`, `escalations`, `conversations`, `turns`.

`leads` has a unique index on `conversation_id` — one lead per conversation.
`turns` stores citations, retrieved chunk ids and the grounded flag so answer
quality can be reviewed offline against what was actually retrieved.

---

## 12. Where every decision lives

| Concern | File |
|---|---|
| Booking routes, emails, CORS, retrieval tuning | `config/app.ts` |
| Which documents are indexed | `config/sources.ts` |
| Widget colours | `config/theme.ts` |
| How much course content to give away | `src/lib/prompt.ts` → `CONTENT_DEPTH_POLICY` |
| Grounding enforcement | `src/lib/grounding.ts` |
| Hybrid retrieval | `src/lib/retrieval.ts` |
| Lead destinations | `src/lib/sinks/` |
| Scoped website re-index | `src/lib/website-sync.ts` |

---

## 13. Seven pending client answers

Full detail in `docs/PENDING.md`. Summary of what each resolves to:

| # | Question | Resolves to |
|---|---|---|
| 1 | Who installs the Webflow snippet | Nothing in code — launch logistics |
| 2 | Lead destination (assumed a Sheet) | `src/lib/sinks/sheets-sink.ts` |
| 3 | DNS for a sending domain | `MAIL_FROM` / `ESCALATION_LIVE` in `config/app.ts` |
| 4 | Final document list | `config/sources.ts` + re-run ingest |
| 5 | Course content depth | `CONTENT_DEPTH_POLICY`, one marked block |
| 6 | Cohort date | Nowhere — comes from the knowledge base |
| 7 | Contact email visitors see | `CONTACT_EMAIL` in `config/app.ts` |

Every one is a config value or one marked block. None is scattered through the
codebase.

---

## 14. Verification status — what is and is not proven

**Verified against real infrastructure:**

- Ingestion across all 159 source files (zip members expanded); 137 unique by content hash
- Retrieval 10/10 against a live Postgres 16 + pgvector
- `tests/grounding.test.ts` 13/13
- `tests/tools.test.ts` 17/17 against real Postgres
- SSE streaming, thin-retrieval escalation, transcript persistence
- CORS allowlist rejecting `evil-skayle360.com`; preflight for both client origins
- `frame-ancestors` header on the widget document and its assets
- Live cron run: scoped re-index, document corpus intact, cohort conflict detected
- `next build` succeeds
- Live crawl of skayle360.com: 8/9 pages

**NOT verified — no `ANTHROPIC_API_KEY` was available in the build environment:**

- The model call itself. `runChat` has never executed a real request.
- Prompt caching. `tests/cache.test.ts` is written and asserts
  `cache_read_input_tokens > 0`, but exits 2 (skip) without a key.
- Citation parsing against real API responses. `enforceGrounding` is tested
  against synthetic blocks matching the documented shape, not live output.
- The tool-call loop end to end.

**NOT verified — no embeddings key:**

- The pgvector arm. Wired, indexed, and activates on `VOYAGE_API_KEY`, but has
  never returned a row. Lexical-only scores 10/10, so this is an improvement
  rather than a prerequisite.

**First thing a continuing session should do with a key:** run
`npm run test:cache`, then a real conversation through `/api/chat`, and confirm
citations parse into `SourceRef`s with correct locators.

---

## 15. Running it

```bash
cd /home/haris-awais/skayle360-chatbot
# .env exists with DATABASE_URL prefilled; add ANTHROPIC_API_KEY
npm run dev            # http://localhost:3000
```

Every npm script auto-loads `.env` via `node --env-file-if-exists`; `tsx` does
not do this on its own, which is why the scripts are shaped that way.

Local Postgres used during the build:

```bash
docker run -d --name skayle-pg -e POSTGRES_PASSWORD=dev -e POSTGRES_DB=skayle \
  -p 55432:5432 pgvector/pgvector:pg16
# DATABASE_URL=postgres://postgres:dev@localhost:55432/skayle
```

`pdftotext` (poppler-utils) is needed on the ingest machine only, not at runtime.

Endpoints: `/api/chat` (SSE), `/api/health`, `/api/cron/crawl` (bearer-authed),
`/widget`, `/widget.js`, `/embed-test.html`.
