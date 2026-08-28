import { retrieve } from "@/lib/retrieval";
import { db } from "@/lib/db";

const ANSWERABLE = [
  "we're a nonprofit with 40 employees in Rhode Island - do we qualify?",
  "how much does the Express Grant cover?",
  "what is the CEO Roundtable?",
  "how long is the program?",
  "who is Chris Ciunci?",
  "is the training on zoom?",
  "what templates come with module 2?",
  "does Skayle 360 submit the grant application for me?",
];
const UNANSWERABLE = [
  "what is your refund policy if I cancel after week three",
  "can I pay in monthly instalments with a credit card",
  "who won the world cup in 1998",
  "do you have an office in Chicago I can visit",
  "what is the wifi password",
  "how do I reset my account password",
];

const stat = async (label: string, qs: string[]) => {
  const scores: number[] = [];
  for (const q of qs) {
    const hits = await retrieve(q);
    const best = Math.max(0, ...hits.map((h) => h.lexScore));
    scores.push(best);
    console.log(`  ${best.toFixed(2).padStart(7)}  ${q.slice(0, 62)}`);
  }
  console.log(`${label}: min=${Math.min(...scores).toFixed(2)} max=${Math.max(...scores).toFixed(2)}\n`);
};

console.log("ANSWERABLE (best BM25 score):");
await stat("answerable", ANSWERABLE);
console.log("UNANSWERABLE (best BM25 score):");
await stat("unanswerable", UNANSWERABLE);
await db().end();
