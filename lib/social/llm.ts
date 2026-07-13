import "server-only";
import Anthropic from "@anthropic-ai/sdk";
import type { DbClient } from "@/lib/db/types";
import type { ProviderKeys } from "@/lib/query/claude";
import { selectLlmBackend } from "@/lib/query/llm-backend";
import { resolveAnsweringKeys } from "@/lib/query/answering";

/**
 * Minimal single-shot text completion for content generation. Reuses the SAME backend selection as
 * the answer stream + title generator (lib/query/llm-backend), including the explicit
 * `teams.answering_provider` override + per-provider model — content generation is answer-like, so a
 * team's chosen model applies here too. Non-streaming; throws on failure (generation surfaces errors
 * rather than silently degrading like the best-effort title path).
 */

const LLM_BASE_URL = process.env.LLM_BASE_URL;
const LLM_MODEL = process.env.LLM_MODEL;

export interface CompleteArgs {
  system: string;
  prompt: string;
}

export interface CompleteOptions {
  keys?: ProviderKeys;
  maxTokens?: number;
  timeoutMs?: number;
}

/** Resolve a team's provider keys the same way the query routes do (single source of truth). */
export function resolveProviderKeys(db: DbClient, teamId: string): Promise<ProviderKeys> {
  return resolveAnsweringKeys(db, teamId);
}

/** Run one completion; returns the model's text. Throws on transport/model error. */
export async function completeText(args: CompleteArgs, opts: CompleteOptions = {}): Promise<string> {
  const keys = opts.keys ?? {};
  const maxTokens = opts.maxTokens ?? 1024;
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const backend = selectLlmBackend({ LLM_BASE_URL, LLM_MODEL }, keys);

  if (backend.kind !== "anthropic") {
    const apiKey = backend.apiKey ?? process.env.OPENAI_API_KEY ?? "local";
    const res = await fetch(`${backend.baseUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
        ...(backend.kind === "openrouter" ? backend.headers : {}),
      },
      body: JSON.stringify({
        model: backend.model,
        max_tokens: maxTokens,
        messages: [
          { role: "system", content: args.system },
          { role: "user", content: args.prompt },
        ],
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) {
      throw new Error(`LLM ${backend.model} @ ${backend.baseUrl}: ${res.status} ${await res.text().catch(() => "")}`);
    }
    const j = (await res.json()) as { choices?: { message?: { content?: string } }[] };
    const text = j.choices?.[0]?.message?.content ?? "";
    if (!text.trim()) throw new Error("LLM returned empty content");
    return text.trim();
  }

  const client = new Anthropic(keys.anthropicKey ? { apiKey: keys.anthropicKey } : undefined);
  const msg = await client.messages.create(
    {
      model: backend.model,
      max_tokens: maxTokens,
      system: args.system,
      messages: [{ role: "user", content: args.prompt }],
    },
    { timeout: timeoutMs, maxRetries: 1 }
  );
  const text = msg.content.map((b) => (b.type === "text" ? b.text : "")).join("").trim();
  if (!text) throw new Error("LLM returned empty content");
  return text;
}
