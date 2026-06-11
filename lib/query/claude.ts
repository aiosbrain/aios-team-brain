import "server-only";
import Anthropic from "@anthropic-ai/sdk";
import type { RetrievedContext } from "./retrieve";

/**
 * Thin adapter around the Claude API so a future agent backend (e.g. Hermes)
 * is a one-module swap. Stable cached system prefix; numbered sources;
 * question last (keeps the cacheable prefix stable per team).
 */

const MODEL = "claude-opus-4-8";
// $5 / $25 per MTok; cache reads ~0.1x input
const INPUT_PER_TOKEN = 5 / 1_000_000;
const OUTPUT_PER_TOKEN = 25 / 1_000_000;
const CACHE_READ_PER_TOKEN = 0.5 / 1_000_000;

const SYSTEM_PROMPT = `You are the Team Brain — the shared memory and coordination assistant for a team using AIOS.

Rules:
- Answer ONLY from the provided sources and structured context. If they don't cover the question, say so plainly — never invent facts, decisions, or attributions.
- Cite sources inline using their markers, e.g. [S2]. Cite the structured context as [CTX].
- Be concise and operational: lead with the answer, then the supporting evidence.
- Decisions marked [SUPERSEDED] are no longer valid — say so if relevant.
- Never speculate about content above the caller's access tier; what you were given is what they may see.`;

export type QueryUsage = {
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cost_usd: number;
};

export async function* streamAnswer(
  ctx: RetrievedContext,
  question: string
): AsyncGenerator<
  | { type: "delta"; text: string }
  | { type: "done"; usage: QueryUsage }
> {
  const client = new Anthropic();

  const sourcesBlock = ctx.sources
    .map(
      (s) =>
        `<source id="${s.sid}" project="${s.project}" path="${s.path}" kind="${s.kind}" synced="${s.synced_at}">\n${s.text}\n</source>`
    )
    .join("\n\n");

  const stream = client.messages.stream({
    model: MODEL,
    max_tokens: 4096,
    thinking: { type: "adaptive" },
    system: [
      {
        type: "text",
        text: SYSTEM_PROMPT,
        cache_control: { type: "ephemeral" },
      },
    ],
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: `<structured_context>\n${ctx.structured}\n</structured_context>` },
          { type: "text", text: sourcesBlock || "<no document sources matched>" },
          { type: "text", text: `Question: ${question}` },
        ],
      },
    ],
  });

  for await (const event of stream) {
    if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
      yield { type: "delta", text: event.delta.text };
    }
  }

  const final = await stream.finalMessage();
  const u = final.usage;
  const cost =
    (u.input_tokens ?? 0) * INPUT_PER_TOKEN +
    (u.output_tokens ?? 0) * OUTPUT_PER_TOKEN +
    (u.cache_read_input_tokens ?? 0) * CACHE_READ_PER_TOKEN;
  yield {
    type: "done",
    usage: {
      input_tokens: u.input_tokens ?? 0,
      output_tokens: u.output_tokens ?? 0,
      cache_read_tokens: u.cache_read_input_tokens ?? 0,
      cost_usd: Math.round(cost * 100000) / 100000,
    },
  };
}
