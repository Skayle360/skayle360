-- Skayle 360 chatbot. Postgres 15+ with pgvector.
-- Idempotent: safe to re-run on every deploy and after every re-ingest.

CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- ---------------------------------------------------------------- knowledge

CREATE TABLE IF NOT EXISTS documents (
  doc_id        text PRIMARY KEY,
  title         text        NOT NULL,
  source_label  text        NOT NULL,   -- what a citation shows the visitor
  source_type   text        NOT NULL,   -- program_document | module_deck | blog_post | template_catalog | website
  origin        text        NOT NULL,   -- file path or URL
  module        text,
  format        text        NOT NULL,
  words         integer     NOT NULL,
  sha256        text        NOT NULL,
  ingested_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS chunks (
  id            text PRIMARY KEY,
  doc_id        text        NOT NULL REFERENCES documents(doc_id) ON DELETE CASCADE,
  chunk_index   integer     NOT NULL,
  text          text        NOT NULL,
  heading       text,
  locator       text,                   -- "p. 4" / "slides 12-13"
  embedding     vector(1024),           -- NULL until the embedding pass runs
  -- Generated so the lexical arm can never drift out of sync with `text`.
  tsv           tsvector GENERATED ALWAYS AS (to_tsvector('english', coalesce(heading,'') || ' ' || text)) STORED
);

CREATE INDEX IF NOT EXISTS chunks_tsv_idx    ON chunks USING gin (tsv);
CREATE INDEX IF NOT EXISTS chunks_doc_idx    ON chunks (doc_id);
-- HNSW over cosine distance. Built only once embeddings exist; harmless before.
CREATE INDEX IF NOT EXISTS chunks_embed_idx  ON chunks USING hnsw (embedding vector_cosine_ops);

-- ------------------------------------------------------------------- leads
-- Postgres is the source of truth. The Google Sheet is a mirror and may lag,
-- lose rows to rate limits, or be edited by hand; it must never be the only copy.

CREATE TABLE IF NOT EXISTS leads (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id uuid       NOT NULL,
  name           text,
  email          text,
  company        text,
  interest       text,
  booking_route  text,
  source_url     text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  -- Mirror state, so a failed Sheets write is retryable and visible.
  mirror_status  text        NOT NULL DEFAULT 'pending',  -- pending | synced | failed | disabled
  mirror_error   text,
  mirrored_at    timestamptz
);

CREATE INDEX IF NOT EXISTS leads_conversation_idx ON leads (conversation_id);
CREATE INDEX IF NOT EXISTS leads_mirror_idx       ON leads (mirror_status) WHERE mirror_status <> 'synced';
-- One lead row per conversation; later detail arrives as an update, not a new row.
CREATE UNIQUE INDEX IF NOT EXISTS leads_conversation_uniq ON leads (conversation_id);

CREATE TABLE IF NOT EXISTS escalations (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id uuid       NOT NULL,
  question       text        NOT NULL,
  context        text,
  reason         text        NOT NULL,   -- no_citation | thin_retrieval | model_requested | tool_error
  transcript     jsonb       NOT NULL,
  lead_id        uuid        REFERENCES leads(id) ON DELETE SET NULL,
  email_status   text        NOT NULL DEFAULT 'pending',  -- pending | sent | failed
  email_error    text,
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS escalations_pending_idx ON escalations (email_status) WHERE email_status <> 'sent';

-- ----------------------------------------------------------------- sessions
-- Transcripts, so an escalation email can carry the whole conversation and so
-- answer quality can be reviewed against what was actually retrieved.

CREATE TABLE IF NOT EXISTS conversations (
  id           uuid PRIMARY KEY,
  started_at   timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  source_url   text,
  user_agent   text
);

CREATE TABLE IF NOT EXISTS turns (
  id              bigserial PRIMARY KEY,
  conversation_id uuid        NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  role            text        NOT NULL,
  content         text        NOT NULL,
  citations       jsonb,
  retrieved       jsonb,       -- chunk ids + scores, for offline quality review
  grounded        boolean,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS turns_conversation_idx ON turns (conversation_id, created_at);

-- --------------------------------------------------------------- lexeme IDF
-- `ts_rank_cd` has no IDF component, so without this a question about a
-- Massachusetts nonprofit ranks on "employees" (20% of chunks) rather than
-- "Massachusetts" (2%). Refreshed by the loader after every re-index.

CREATE TABLE IF NOT EXISTS lexeme_stats (
  word  text PRIMARY KEY,
  ndoc  integer NOT NULL
);

CREATE TABLE IF NOT EXISTS corpus_stats (
  id          boolean PRIMARY KEY DEFAULT true CHECK (id),
  chunk_count integer NOT NULL,
  avg_len     double precision NOT NULL DEFAULT 0,
  updated_at  timestamptz NOT NULL DEFAULT now()
);

-- Per-chunk term frequencies, expanded from the tsvector's own positions at
-- load time. This is what lets the lexical arm score real BM25 in SQL rather
-- than `ts_rank_cd`: BM25's IDF is what makes "Massachusetts" outweigh
-- "employees" on an eligibility question, and ts_rank_cd has no IDF at all.
CREATE TABLE IF NOT EXISTS chunk_terms (
  chunk_id text    NOT NULL REFERENCES chunks(id) ON DELETE CASCADE,
  word     text    NOT NULL,
  tf       integer NOT NULL,
  PRIMARY KEY (chunk_id, word)
);

CREATE INDEX IF NOT EXISTS chunk_terms_word_idx ON chunk_terms (word);

ALTER TABLE chunks       ADD COLUMN IF NOT EXISTS token_count integer NOT NULL DEFAULT 0;
-- Additive, so an existing deployment picks these up without a manual migration.
ALTER TABLE corpus_stats ADD COLUMN IF NOT EXISTS avg_len double precision NOT NULL DEFAULT 0;

-- ------------------------------------------------------------ admin uploads
-- Files added through the admin page, with their progress through the
-- pipeline. The bytes live here rather than in object storage: the largest
-- source file in this corpus is 19MB, Neon handles that comfortably, and it
-- avoids standing up an S3 bucket and its credentials for a handful of files.

CREATE TABLE IF NOT EXISTS uploads (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  filename     text        NOT NULL,
  media_type   text        NOT NULL,
  size_bytes   integer     NOT NULL,
  sha256       text        NOT NULL,
  content      bytea       NOT NULL,
  -- queued -> extracting -> chunking -> embedding -> live | failed | removed
  status       text        NOT NULL DEFAULT 'queued',
  error        text,
  doc_id       text        REFERENCES documents(doc_id) ON DELETE SET NULL,
  words        integer,
  chunk_count  integer,
  uploaded_by  text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS uploads_status_idx ON uploads (status, created_at DESC);
-- The same file uploaded twice is the same document, not two.
CREATE UNIQUE INDEX IF NOT EXISTS uploads_sha_uniq ON uploads (sha256) WHERE status <> 'removed';

-- ----------------------------------------------------------------- settings
-- Editable prompt blocks. Only the tunable ones live here; the grounding and
-- eligibility rules stay in code so they cannot be edited away by accident.

CREATE TABLE IF NOT EXISTS settings (
  key        text PRIMARY KEY,
  value      text        NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by text
);

-- ------------------------------------------------------------- version trail
-- Every edit to a prompt block or to Chris's notes, kept.
--
-- Without this an edit is destructive: change the tone, notice a week later
-- that answers got worse, and there is no record of what it used to be. Both
-- the prompt blocks and the knowledge notes are stored in `settings`, so one
-- trail covers both.

CREATE TABLE IF NOT EXISTS setting_versions (
  id         bigserial PRIMARY KEY,
  key        text        NOT NULL,
  value      text        NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by text,
  -- Set when this row was produced by restoring an earlier version, so the
  -- trail records the restore rather than looking like an ordinary edit.
  restored_from bigint REFERENCES setting_versions(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS setting_versions_key_idx ON setting_versions (key, created_at DESC);

-- --------------------------------------------------------- excluded sources
-- Documents removed through the admin page.
--
-- Recorded rather than merely deleted: the ingested corpus is rebuilt from the
-- source folder, so a plain DELETE would be undone by the next `npm run
-- ingest`. The exclusion is what makes a removal stick.

CREATE TABLE IF NOT EXISTS excluded_documents (
  doc_id      text PRIMARY KEY,
  title       text,
  reason      text,
  excluded_at timestamptz NOT NULL DEFAULT now(),
  excluded_by text
);
