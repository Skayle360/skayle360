# Pending client answers

Seven questions are with the client. Nothing below is guessed into the codebase;
each is a config value or one clearly marked block, so an answer is a one-line
change and — where relevant — a re-index.

| # | Question | Where the answer goes | Current behaviour |
|---|---|---|---|
| 1 | Who installs the Webflow snippet | Nothing in code | Launch-day logistics. Embed tag is in the README. |
| 2 | Lead destination (assumed a Google Sheet) | `src/lib/sinks/sheets-sink.ts` | Postgres is authoritative. Sheets mirror is a stub that throws if called, and is only registered when both `GOOGLE_SHEET_ID` and `ENABLE_SHEETS_MIRROR=true` are set. |
| 3 | DNS access for a sending domain | `MAIL_FROM`, `ESCALATION_TEST_INBOX`, `ESCALATION_LIVE` in `config/app.ts` | Escalations are recorded and queued. Sending needs an explicit opt-in. Plan for `notify.skayle360.com` — see README. |
| 4 | Final document list | `config/sources.ts` | The safe set is indexed. Ingestion is re-runnable and deterministic. |
| 5 | How much course content to give away | `src/lib/prompt.ts` → `CONTENT_DEPTH_POLICY` | Names the framework and why it matters, then invites a booking. Two alternatives are drafted in `CONTENT_DEPTH_ALTERNATIVES`; swapping is one line. |
| 6 | Cohort date | Nowhere — comes from the knowledge base | No date is hardcoded. The corpus currently disagrees (below); the bot declines to choose and offers the call. |
| 7 | Which contact email visitors see | `CONTACT_EMAIL` in `config/app.ts` | Defaults to `cciunci@skayle360.com`. |

## Findings to put to the client

### The cohort date genuinely conflicts, in four places

Not a site typo — the source documents disagree too:

| Source | Says |
|---|---|
| `skayle360.com/programs` | Cohort **Winter 2027**, Jan 19 – Apr 1, 2027 |
| `skayle360.com/` and `/grant-funding` | **Fall 2026** cohort, limited seats |
| `SCALE UP Training Syllabus.pdf` | "The **Winter 2027** cohort starts January 19" |
| `Chris Ciunci Bio.pdf` | "**Fall 2026** cohort: Sep 15 – Nov 19" |

Detected at ingest time (`npm run ingest` prints a CONFLICT block) and again per
request (`detectCohortConflict`), which logs a warning and instructs the model to
say the site lists more than one and offer the call. Fixing the sources and
re-running ingest is the whole remedy.

### The site's accent colour is orange, not green

The brief specified a green accent. `skayle360-410586.webflow.shared.387501f73.css`
declares exactly one brand variable, `--orange: #e87722`, against near-black
`#201e1b`. There is no green anywhere in the stylesheet. The widget matches the
real site; the accent is one value in `config/theme.ts` if the client wants
otherwise.

### `/training-videos` is behind a login

Returns HTTP 401 to an anonymous crawler, so it is not indexed. 8 of the 9
requested pages are. If the bot should answer questions about the training
videos, that content needs to be reachable, or supplied as a document.

### There are 55 blank worksheets, not ~100

The five template archives hold 78 files: 12 are prose documents (indexed in
full), 6 are confidential PrepU material (excluded), 4 are archive-root
duplicates, 1 is a hash duplicate of the syllabus. That leaves **55** blank
worksheets, catalogued by name.

### The "blank" worksheets are not entirely blank

They were indexed by name only, as instructed. Worth knowing: several carry real
teaching prose above the fill-in fields — `SCALE UP_Vision_Statement.docx` has
"WHAT IT IS", "WHAT IT ISN'T" and a "WHY THIS MATTERS" section before the first
blank. That is genuinely useful retrieval material currently left out.

The catalog already extracts one descriptive sentence from each worksheet for its
purpose line, so the entries are the documents' own words rather than guesses. If
the client wants more, the fix is to index the explanatory header region and stop
at the first form field — a change confined to `ingest/lib/catalog.ts`.

### Eight blog posts are draft/final duplicates

The blog archive is a working folder. Eight posts exist twice under different
filenames (e.g. `Blog - The Value Stick.docx` / `Blog Post - The Value Stick.docx`,
97% identical). Hash-dedupe misses these because a few edited words change the
bytes. Near-duplicate detection drops the shorter copy and reports every drop;
all eight were checked by hand. Threshold is `NEAR_DUPE_THRESHOLD`.
