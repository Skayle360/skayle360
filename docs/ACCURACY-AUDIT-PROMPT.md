# Prompt: audit the chatbot's answer accuracy

Paste everything below the line into a fresh Claude Code session, in
`/home/haris-awais/skayle360-chatbot`.

---

You are auditing a live RAG chatbot for answer accuracy. Your job is to find
where it is wrong, prove it, and fix it. Not to confirm it works.

## The system

A grounded chatbot for skayle360.com (Skayle 360, a Massachusetts growth
consultancy). It must answer **only** from the client's own material — 81
documents, 982 chunks in Neon Postgres — and cite every factual claim.

Read `docs/CONTEXT.md` first for the full architecture. The short version:

1. A question goes to Postgres, which finds the 8 most relevant chunks
2. Those 8 chunks go to Claude, which answers from them and cites them
3. An uncited factual claim is withheld and escalated instead of shown

**Critical:** retrieval is currently **keyword-based (BM25), not embeddings.**
`embedded` is 0 of 982. This is the known weak point — see Failure Mode 1.

## Your tools

```bash
npm run ask -- "question"      # ask the bot; shows the answer and its sources
npm run search -- "topic"      # search the knowledge base directly, full text
npm test                       # 40 automated checks
```

`npm run search` is your ground truth. It shows the actual passages the bot
sees. **Never judge an answer without checking it against the source.**

## What "correct" means here

An answer is correct only if all of these hold:

1. **Every fact appears in the cited source.** Look it up with `npm run search`.
   Do not accept a plausible-sounding claim.
2. **It did not escalate a question the material can answer.** This is the most
   common failure and the hardest to spot — the bot says "I don't have that"
   confidently, and it is wrong.
3. **It did not answer a question the material cannot answer.** Inventing is
   worse than escalating.
4. **Length:** one short paragraph is the target, two is the ceiling.
5. **Relevance:** it answered what was asked and stopped. No extra facts bolted
   on because retrieval happened to return them.
6. **One call to action**, not two, and not on every message.
7. **Cohort dates are January 19 – March 25, 2027.** The syllabus in the corpus
   still says April 1. That is wrong and must never be repeated.
8. **It never promises grant approval.** Eligibility criteria come from the
   documents; the determination is the state's.
9. **It never mentions PrepU.** That is the client's separate company and those
   files are excluded.

## The two failure modes to hunt

### Failure Mode 1 — the vocabulary gap (most important)

Keyword search fails when the visitor's words differ from the document's words,
even though the answer is right there.

A confirmed example, already fixed: *"What days and times are the sessions?"*
The corpus says `"Tues & Thurs · 1:00–3:30 PM ET"` — containing none of "days",
"times" or "sessions". Retrieval returned a blog post about sales, and the bot
escalated a question it could have answered.

**Hunt for more of these.** Method:

1. Pick a fact you know is in the corpus (`npm run search`)
2. Ask about it the way a real small business owner would phrase it, using
   *their* words, not the document's
3. If the bot escalates or misses, you have found one

Try synonym pairs: schedule/timetable, cost/price/fee, refund/money back,
staff/employees/team, requirements/what do I need, start date/when does it begin.

### Failure Mode 2 — confident invention

Ask about things genuinely absent from the material. The bot must escalate.

Verify absence first with `npm run search`, then ask. If it produces a confident
answer where the source has nothing, that is the worst possible bug and must be
reported immediately.

## How to fix what you find

**A missing key fact** → add it to `knowledge/00-corrections.md` in plain
sentences, then `npm run ingest && npm run ingest:load`. This file is
authoritative and outranks every other source. Use it for facts visitors ask
about constantly. Do not use it to paper over a systemic retrieval problem.

**A retrieval problem** → the real fix is embeddings, which are built but
switched off. Note it in your report; do not enable it without asking.

**Wrong tone, length, or pushiness** → `src/lib/prompt.ts`. The content-depth
and lead-capture policies are in clearly marked blocks. Change the block, not
scattered wording.

**Grounding logic** → `src/lib/grounding.ts`. Be careful here: it has been
wrong in both directions before. It once withheld the bot's own greeting and
escalated it, because "would" and "grant" tripped the factual-claim detectors.
Add a regression test to `tests/grounding.test.ts` for anything you change.

## Rules

- **Verify before you claim.** Every finding must cite the passage you checked
  with `npm run search`. "This looks wrong" is not a finding.
- **Run `npm test` after every change.** 40 checks; all must pass.
- **Do not loosen the grounding rules to make answers look better.** Answering
  only from the client's material is the entire product.
- **Do not hardcode a cohort date anywhere in the code.** It comes from the
  knowledge base so a correction is a re-index, not a deploy.
- `npm run reset:testdata` clears test rows from Postgres and the Google Sheet.
  Run it when you finish so the client never sees your test leads.

## Deliverable

Test at least 40 questions across `docs/TEST-QUESTIONS.md` and your own, with
emphasis on Failure Mode 1. Then report:

1. **Every wrong answer**, with: the question, what it said, what the source
   actually says, and the `npm run search` output proving it
2. **Every false escalation** — questions it refused that the material covers
3. **Every invention** — answers with no support in the material
4. **What you fixed**, and what you deliberately did not
5. **Whether embeddings should be enabled**, with evidence from your testing —
   count how many failures were vocabulary-gap failures

Be blunt. If the answers are not good enough to put in front of a paying
client, say so plainly and say why.
