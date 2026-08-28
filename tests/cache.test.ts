/**
 * Asserts prompt caching actually engages.
 *
 * Caching is mandatory here, not an optimisation: without it every message
 * repays the full system prompt and tool definitions, roughly ten times the
 * cost per message. It also fails silently — a stray timestamp in the prefix
 * costs money and changes nothing observable — so it gets an explicit test.
 *
 *   ANTHROPIC_API_KEY=... DATABASE_URL=... npx tsx tests/cache.test.ts
 */
import Anthropic from "@anthropic-ai/sdk";
import { MODEL } from "@config/app";
import { SYSTEM_PROMPT } from "@/lib/prompt";
import { TOOL_DEFINITIONS } from "@/lib/tools";

if (!process.env.ANTHROPIC_API_KEY) {
  console.error("SKIP: ANTHROPIC_API_KEY is not set — cannot verify caching without a live call.");
  process.exit(2);
}

const client = new Anthropic();

const tools: Anthropic.Beta.BetaToolUnion[] = TOOL_DEFINITIONS.map((tool, i) => ({
  ...tool,
  ...(i === TOOL_DEFINITIONS.length - 1 ? { cache_control: { type: "ephemeral" as const } } : {}),
}));
const system: Anthropic.Beta.BetaTextBlockParam[] = [
  { type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } },
];

async function ask(question: string) {
  const stream = client.beta.messages.stream({
    model: MODEL,
    max_tokens: 1024,
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    thinking: { type: "adaptive" },
    output_config: { effort: "low" },
    system,
    tools,
    // Only the question varies, and it sits after the last breakpoint.
    messages: [{ role: "user", content: question }],
  });
  return (await stream.finalMessage()).usage;
}

const first = await ask("Say the word ready.");
console.log(
  `first : input=${first.input_tokens} cache_write=${first.cache_creation_input_tokens} cache_read=${first.cache_read_input_tokens}`,
);

const second = await ask("Say the word again.");
console.log(
  `second: input=${second.input_tokens} cache_write=${second.cache_creation_input_tokens} cache_read=${second.cache_read_input_tokens}`,
);

const cacheRead = second.cache_read_input_tokens ?? 0;
if (cacheRead > 0) {
  console.log(`\nPASS  ${cacheRead} tokens served from cache on the second request`);
  process.exit(0);
}
console.error(
  "\nFAIL  cache_read_input_tokens was 0 on the second request.\n" +
    "Something in the prefix varies per request. Check, in render order:\n" +
    "  tools    — TOOL_DEFINITIONS must be a frozen, deterministically ordered array\n" +
    "  system   — SYSTEM_PROMPT must contain no timestamp, date, or per-request value\n" +
    "  messages — retrieved documents belong here, after the last breakpoint, never in system",
);
process.exit(1);
