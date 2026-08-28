/**
 * Grounding is the whole product promise, so it is checked against synthetic
 * response blocks rather than only in live conversation.
 *   npx tsx tests/grounding.test.ts
 */
import { enforceGrounding, shouldShowBlock, detectCohortConflict } from "@/lib/grounding";
import type { RetrievedChunk } from "@/lib/retrieval";

const chunk = (id: string, text: string, locator: string | null, label: string): RetrievedChunk => ({
  id, docId: id, text, heading: null, locator, title: label, sourceLabel: label,
  sourceType: "program_document", origin: `${id}.pdf`, score: 0.02, lexScore: 12, semScore: 0, arms: ["lexical"],
});

const docs = [
  chunk("syllabus", "Massachusetts businesses and nonprofits with 100 or fewer W-2 employees qualify.", "p. 4", "SCALE UP Syllabus"),
  chunk("site-programs", "Cohort Winter 2027. Dates Jan 19 - Apr 1, 2027.", null, "skayle360.com/programs"),
  chunk("site-grant", "Fall 2026 cohort - limited seats.", null, "skayle360.com/grant-funding"),
];

const cited = (text: string, index: number) => ({
  type: "text" as const, text,
  citations: [{ type: "char_location" as const, cited_text: "Massachusetts businesses and nonprofits", document_index: index, document_title: docs[index]!.sourceLabel, start_char_index: 0, end_char_index: 39 }],
});
const uncited = (text: string) => ({ type: "text" as const, text, citations: null });

let failures = 0;
const check = (name: string, cond: boolean, detail = "") => {
  if (!cond) { failures++; console.log(`FAIL  ${name} ${detail}`); } else console.log(`PASS  ${name}`);
};

// 1. A cited answer is shown, with a locator-bearing source label.
{
  const v = enforceGrounding([cited("The grant covers Massachusetts employers.", 0)] as never, docs);
  check("cited answer is grounded", v.grounded && v.reason === "ok");
  check("source label carries the page number", v.sources[0]?.label === "SCALE UP Syllabus, p. 4", `got "${v.sources[0]?.label}"`);
}

// 2. A factual claim with no citation is withheld and escalated.
{
  const v = enforceGrounding([uncited("The program costs $4,500 and starts in March.")] as never, docs);
  check("uncited factual claim is not grounded", !v.grounded && v.reason === "no_citation");
  check("uncited draft is kept for the escalation email", v.uncited.length === 1);
}

// 3. Conversational filler is not treated as an ungrounded claim.
{
  check("greeting shows without a citation", shouldShowBlock("Happy to help - what kind of work do you do?", false));
  check("claim is withheld without a citation", !shouldShowBlock("The grant covers up to $3,000 per course.", false));
  check("claim shows once cited", shouldShowBlock("The grant covers up to $3,000 per course.", true));
  // Regression: politeness words tripped the claim detectors and withheld the
  // bot's own greeting, escalating a visitor who had only said hello.
  check("greeting with a modal shows", shouldShowBlock("Hello — what would you like to know?", false));
  check("question naming a topic shows", shouldShowBlock("What would you like to know about the grant?", false));
  check("promise still withheld", !shouldShowBlock("You will definitely be approved.", false));
  check("number still withheld", !shouldShowBlock("It runs for 50 hours.", false));
}

// 4. Mixed response: cited claim shown, uncited claim withheld alongside it.
{
  const v = enforceGrounding([cited("Massachusetts employers qualify.", 0), uncited("You will definitely be approved.")] as never, docs);
  check("mixed response stays grounded", v.grounded);
  check("the uncited span is recorded, not shown", v.uncited.some((u) => u.includes("definitely be approved")));
}

// 5. Empty response.
{
  const v = enforceGrounding([] as never, docs);
  check("empty response is not grounded", !v.grounded && v.reason === "empty");
}

// 6. Cohort conflict detection - the live corpus really does disagree.
{
  check("conflicting cohorts detected", detectCohortConflict(docs).join(",") === "Fall 2026,Winter 2027", detectCohortConflict(docs).join(","));
  check("single cohort is not a conflict", detectCohortConflict([docs[0]!, docs[1]!]).length === 0);
}

// 7. Deduplication of repeated citations to the same chunk.
{
  const v = enforceGrounding([cited("One.", 0), cited("Two.", 0)] as never, docs);
  check("repeated citations dedupe to one source", v.sources.length === 1, `got ${v.sources.length}`);
}

console.log(failures ? `\n${failures} FAILED` : "\nAll grounding checks passed");
process.exit(failures ? 1 : 0);
