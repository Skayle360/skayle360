/**
 * Ask the bot one question from the terminal and see exactly what it does:
 * the answer, the sources it cited, whether it stayed grounded, and what the
 * request cost. Faster than the browser for checking answer quality.
 *
 *   npm run ask -- "we're a nonprofit in Rhode Island, do we qualify?"
 */
import { randomUUID } from "node:crypto";
import { runChat } from "../src/lib/chat";
import { db } from "../src/lib/db";

const question = process.argv.slice(2).join(" ").trim();
if (!question) {
  console.error('Usage: npm run ask -- "your question here"');
  process.exit(1);
}
if (!process.env.ANTHROPIC_API_KEY) {
  console.error("ANTHROPIC_API_KEY is not set. Put it in .env first.");
  process.exit(1);
}

const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;
const green = (s: string) => `\x1b[32m${s}\x1b[0m`;
const red = (s: string) => `\x1b[31m${s}\x1b[0m`;

const conversationId = randomUUID();
await db().query("INSERT INTO conversations (id) VALUES ($1) ON CONFLICT DO NOTHING", [conversationId]);

console.log(`\n${bold("You:")} ${question}\n${bold("Bot:")} `);

let escalated = false;
await runChat(
  { conversationId, history: [], message: question, sourceUrl: null },
  (event) => {
    switch (event.type) {
      case "text":
        process.stdout.write(event.text);
        break;
      case "sources":
        console.log(`\n`);
        for (const s of event.sources) {
          console.log(dim(`  Source: ${s.label}`));
          if (s.quote) console.log(dim(`    "${s.quote.slice(0, 110).replace(/\s+/g, " ")}..."`));
        }
        break;
      case "booking":
        console.log(`\n  ${bold("Booking link:")} ${event.url}`);
        break;
      case "escalated":
        escalated = true;
        break;
      case "error":
        console.log(red(`\n  ERROR: ${event.message}`));
        break;
      case "done": {
        const u = event.usage;
        console.log(`\n${dim("─".repeat(70))}`);
        console.log(
          `  grounded: ${event.grounded ? green("yes — every claim is cited") : red("NO — answer was withheld")}`,
        );
        if (escalated) console.log(`  escalated: ${green("yes — sent to Chris")}`);
        console.log(
          dim(`  tokens: ${u.inputTokens} in / ${u.outputTokens} out · ` +
              `cache ${u.cacheReadInputTokens > 0 ? green(String(u.cacheReadInputTokens) + " read") : red("0 read — caching not working")}` +
              dim(`, ${u.cacheCreationInputTokens} written`)),
        );
        break;
      }
    }
  },
);

console.log();
await db().end();
