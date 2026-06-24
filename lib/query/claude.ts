import "server-only";
import Anthropic from "@anthropic-ai/sdk";
import type { RetrievedContext } from "./retrieve";

/**
 * Thin adapter around the Claude API so a future agent backend (e.g. Hermes)
 * is a one-module swap. Stable cached system prefix; numbered sources;
 * question last (keeps the cacheable prefix stable per team).
 *
 * Backend selection is env-driven:
 *   - LLM_BASE_URL set  → stream from a local OpenAI-compatible endpoint
 *     (Ollama / Hermes / llama.cpp). LLM_MODEL picks the model; cost is $0.
 *   - LLM_BASE_URL unset → the original Anthropic path (unchanged).
 */

const MODEL = "claude-opus-4-8";
// $5 / $25 per MTok; cache reads ~0.1x input
const INPUT_PER_TOKEN = 5 / 1_000_000;
const OUTPUT_PER_TOKEN = 25 / 1_000_000;
const CACHE_READ_PER_TOKEN = 0.5 / 1_000_000;

// Local OpenAI-compatible backend (Ollama/Hermes). Unset → cloud Anthropic.
const LLM_BASE_URL = process.env.LLM_BASE_URL;
const LLM_MODEL = process.env.LLM_MODEL ?? "llama3.1-8b-64k:latest";

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

/**
 * Per-team provider keys (resolved from the encrypted integrations store by the caller). When a key
 * is null/absent the SDK / fetch falls back to the process env, preserving the original env-only
 * behavior for instances that haven't set a key in the dashboard.
 */
export interface ProviderKeys {
  anthropicKey?: string | null;
  openaiKey?: string | null;
}

export async function* streamAnswer(
  ctx: RetrievedContext,
  question: string,
  keys: ProviderKeys = {}
): AsyncGenerator<
  | { type: "delta"; text: string }
  | { type: "done"; usage: QueryUsage }
> {
  const sourcesBlock = ctx.sources
    .map(
      (s) =>
        `<source id="${s.sid}" project="${s.project}" path="${s.path}" kind="${s.kind}" synced="${s.synced_at}">\n${s.text}\n</source>`
    )
    .join("\n\n");

  // Local OpenAI-compatible backend (Ollama/Hermes) — fully on-machine, $0.
  if (LLM_BASE_URL) {
    yield* streamLocal(ctx.structured, sourcesBlock, question, keys.openaiKey);
    return;
  }

  // Per-team key wins; otherwise the SDK reads ANTHROPIC_API_KEY from the env.
  const client = new Anthropic(keys.anthropicKey ? { apiKey: keys.anthropicKey } : undefined);

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

/**
 * Stream from a local OpenAI-compatible chat endpoint (Ollama/Hermes/llama.cpp).
 * Same `delta`/`done` contract as the Anthropic path; cost is always $0.
 * Strips any `<think>…</think>` reasoning spans so the Team Brain answer stays
 * clean even when LLM_MODEL points at a reasoning model.
 */
async function* streamLocal(
  structured: string,
  sourcesBlock: string,
  question: string,
  openaiKey?: string | null
): AsyncGenerator<
  | { type: "delta"; text: string }
  | { type: "done"; usage: QueryUsage }
> {
  const userContent =
    `<structured_context>\n${structured}\n</structured_context>\n\n` +
    `${sourcesBlock || "<no document sources matched>"}\n\n` +
    `Question: ${question}`;

  const res = await fetch(`${LLM_BASE_URL!.replace(/\/$/, "")}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${openaiKey ?? process.env.OPENAI_API_KEY ?? "local"}`,
    },
    body: JSON.stringify({
      model: LLM_MODEL,
      max_tokens: 4096,
      stream: true,
      stream_options: { include_usage: true },
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: userContent },
      ],
    }),
  });

  if (!res.ok || !res.body) {
    throw new Error(`local LLM ${LLM_MODEL} @ ${LLM_BASE_URL}: ${res.status} ${await res.text().catch(() => "")}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let inThink = false;
  let prompt = 0;
  let completion = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split("\n");
    buf = lines.pop() ?? "";
    for (const line of lines) {
      const t = line.trim();
      if (!t.startsWith("data:")) continue;
      const data = t.slice(5).trim();
      if (data === "[DONE]") continue;
      let j: {
        choices?: { delta?: { content?: string } }[];
        usage?: { prompt_tokens?: number; completion_tokens?: number };
      };
      try {
        j = JSON.parse(data);
      } catch {
        continue;
      }
      if (j.usage) {
        prompt = j.usage.prompt_tokens ?? prompt;
        completion = j.usage.completion_tokens ?? completion;
      }
      let piece: string = j.choices?.[0]?.delta?.content ?? "";
      if (!piece) continue;
      // Drop <think>…</think> reasoning spans (token-by-token aware).
      let out = "";
      while (piece.length) {
        if (inThink) {
          const end = piece.indexOf("</think>");
          if (end === -1) { piece = ""; break; }
          piece = piece.slice(end + 8);
          inThink = false;
        } else {
          const start = piece.indexOf("<think>");
          if (start === -1) { out += piece; piece = ""; break; }
          out += piece.slice(0, start);
          piece = piece.slice(start + 7);
          inThink = true;
        }
      }
      if (out) yield { type: "delta", text: out };
    }
  }

  yield {
    type: "done",
    usage: {
      input_tokens: prompt,
      output_tokens: completion,
      cache_read_tokens: 0,
      cost_usd: 0,
    },
  };
}
