import "server-only";
import Anthropic from "@anthropic-ai/sdk";
import { selectLlmBackend, type LlmBackendKeys } from "@/lib/query/llm-backend";

/**
 * THE single-shot text-completion primitive for every non-streaming LLM task in the brain — meeting
 * extraction, narrative-arc synthesis, social content, chat titles. It resolves the backend through
 * `selectLlmBackend`, so it honors the team's **answering-provider** setting (`teams.answering_provider`)
 * and per-provider model exactly like the Query box — including OpenRouter, which the old per-feature
 * callers silently ignored. There must be no other place that opens an Anthropic client or POSTs to
 * `/chat/completions`; a guard (`test/guards/llm-single-caller.test.ts`) enforces it.
 *
 * `completeText` throws on failure; `completeTextOrNull` swallows to null for best-effort callers
 * (arc/meeting extraction degrade to "no result" rather than failing the request).
 */

const LLM_BASE_URL = process.env.LLM_BASE_URL;
const LLM_MODEL = process.env.LLM_MODEL;

export interface CompleteArgs {
  system: string;
  prompt: string;
}

export interface CompleteOptions {
  /** Full backend keys (resolve via `lib/query/answering.resolveAnsweringKeys`). */
  keys?: LlmBackendKeys;
  maxTokens?: number;
  timeoutMs?: number;
  /** Ask for strict JSON: sets `response_format` on OpenAI-compatible + nudges every provider. */
  jsonObject?: boolean;
}

/** Run one completion; returns the model's text. Throws on transport/model error or empty output. */
export async function completeText(args: CompleteArgs, opts: CompleteOptions = {}): Promise<string> {
  const keys = opts.keys ?? {};
  const maxTokens = opts.maxTokens ?? 1024;
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const backend = selectLlmBackend({ LLM_BASE_URL, LLM_MODEL }, keys);

  // For JSON mode, nudge every provider (OpenAI's json_object mode also requires "json" in the
  // messages, which this satisfies) — harmless when the system prompt already asks for JSON.
  const prompt = opts.jsonObject ? `${args.prompt}\n\nReturn ONLY the JSON object.` : args.prompt;

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
        ...(opts.jsonObject ? { response_format: { type: "json_object" } } : {}),
        messages: [
          { role: "system", content: args.system },
          { role: "user", content: prompt },
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
      messages: [{ role: "user", content: prompt }],
    },
    { timeout: timeoutMs, maxRetries: 1 }
  );
  const text = msg.content.map((b) => (b.type === "text" ? b.text : "")).join("").trim();
  if (!text) throw new Error("LLM returned empty content");
  return text;
}

/** Best-effort variant: returns null on any failure (transport, empty, no key) instead of throwing. */
export async function completeTextOrNull(args: CompleteArgs, opts: CompleteOptions = {}): Promise<string | null> {
  try {
    return await completeText(args, opts);
  } catch (err) {
    console.error("[llm] completion failed:", err instanceof Error ? err.message : err);
    return null;
  }
}
