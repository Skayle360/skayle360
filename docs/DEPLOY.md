# Deploying

Vercel plus Neon. The whole app is one Next.js project; there is no separate
backend.

## 1. Push to GitHub

`.gitignore` already excludes `.env`, `data/`, build output, and
`public/mirror/`. Verify before the first push:

```bash
git status --porcelain | grep -E '\.env|mirror/' && echo "STOP — secrets or the mirror would be committed"
```

## 2. Import the repo into Vercel

Framework preset: **Next.js**. Build command and output directory are detected;
`npm run build` already builds the widget before Next.

**Pick a US East region** — the same region as your Neon database. Measured from
elsewhere, every database round trip costs ~300ms and the app makes several per
message. Same-region is single-digit milliseconds.

## 3. Environment variables

Set these in Vercel → Settings → Environment Variables. Values come from your
local `.env`; do not commit them.

| Variable | Needed for |
|---|---|
| `DATABASE_URL` | Everything. Use Neon's **pooled** connection string. |
| `ANTHROPIC_API_KEY` | Answering |
| `VOYAGE_API_KEY` | The vector half of search. Without it, keyword only. |
| `ADMIN_PASSWORD` | The admin page. **Change it from the local value.** |
| `ADMIN_SECRET` | Signs admin sessions. 24+ chars, generate a fresh one. |
| `CRON_SECRET` | Guards the weekly crawl endpoint |
| `GOOGLE_SHEET_ID` | Lead mirror |
| `GOOGLE_SERVICE_ACCOUNT_JSON` | Lead mirror. The whole JSON on one line. |
| `ENABLE_SHEETS_MIRROR` | `true` |
| `RESEND_API_KEY` | Escalation email (once DNS is ready) |
| `ESCALATION_TEST_INBOX` | Where escalations go before go-live |
| `ESCALATION_LIVE` | `true` only once `notify.skayle360.com` is verified |

`ALLOWED_ORIGINS` is not needed — the default is already the client's two
domains. Setting it locally is only to permit `localhost`.

Generate fresh admin secrets:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
```

## 4. The domain

Add `chat.skayle360.com` in Vercel → Domains, then create the DNS record it
gives you. Until this exists the widget has nowhere to load from.

## 5. Seed the database

Run once from your machine — ingestion needs the source files, which are not in
the repo:

```bash
DATABASE_URL="<neon pooled url>" npm run db:setup
```

Then check `https://chat.skayle360.com/api/health`. It should report the
document and chunk counts and `"retrievalMode":"hybrid"`.

## 6. Install on the client's site

Webflow → Site Settings → Custom Code → Footer:

```html
<script src="https://chat.skayle360.com/widget.js" defer></script>
```

**Use `skayle360.webflow.io` first.** It is already in the allowed origins, so
you can verify on staging before touching the live site.

## After deploying

- **Rotate every secret** that has been shared anywhere — the Google key, the
  Neon password, the admin password.
- **Add a payment method to Voyage.** It stays free (200M tokens), but the
  unpaid tier caps at 3 requests a minute, which switches the vector half of
  search off whenever more than a couple of visitors arrive together.
- The weekly crawl runs Mondays 07:00 UTC via `vercel.json`. It re-reads the
  website only, never the documents — those files do not exist on Vercel.
