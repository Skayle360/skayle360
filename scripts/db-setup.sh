#!/usr/bin/env bash
# Applies the schema and loads the knowledge base into whatever DATABASE_URL
# points at. Safe to re-run: the schema is idempotent and the load is a single
# transaction, so a failure leaves the previous index intact.
set -euo pipefail

# Read .env through node rather than sourcing it: values legitimately contain
# shell metacharacters (a Neon URL has `&`, the service-account key has quotes
# and braces), and sourcing splits on them.
if [ -z "${DATABASE_URL:-}" ] && [ -f .env ]; then
  DATABASE_URL=$(node --env-file=.env -e 'process.stdout.write(process.env.DATABASE_URL ?? "")')
  export DATABASE_URL
fi
: "${DATABASE_URL:?DATABASE_URL is not set — put it in .env first}"

# psql needs to be told where the trust store is for sslmode=verify-full.
# It cannot go in DATABASE_URL: the node driver reads sslrootcert as a file
# path and fails trying to open one literally named "system".
export PGSSLROOTCERT="${PGSSLROOTCERT:-system}"

host=$(printf '%s' "$DATABASE_URL" | sed -E 's#.*@([^/:]+).*#\1#')
echo "Target: $host"
echo

if [ ! -f data/corpus.jsonl ]; then
  echo "data/corpus.jsonl is missing — run 'npm run ingest:crawl && npm run ingest' first." >&2
  exit 1
fi

echo "1/2  Creating tables..."
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -q -f db/schema.sql

echo "2/2  Loading the knowledge base..."
npm run --silent ingest:load

echo
echo "Done. Checking what landed:"
psql "$DATABASE_URL" -t -c \
  "SELECT '  ' || (SELECT count(*) FROM documents) || ' documents, '
        || (SELECT count(*) FROM chunks)    || ' chunks, '
        || (SELECT count(*) FROM chunk_terms) || ' search index rows';"
