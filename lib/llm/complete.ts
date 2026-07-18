import "server-only";
import Anthropic from "@anthropic-ai/sdk";
import { selectLlmBackend, reasoningActive, type LlmBackendKeys, type LlmRole } from "@/lib/query/llm-backend";
import { looksLikeTokenLimit } from "@/lib/query/claude";
import { recordIngestRun } from "@/lib/ingest/runs";
import type { DbClient } from "@/lib/db/types";

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

/**
 * Reasoning models (e.g. OpenRouter's `qwen/qwen3.7-plus`, o-series) spend completion tokens on
 * HIDDEN reasoning BEFORE emitting any answer, and `max_tokens` caps reasoning+answer TOGETHER. With
 * only the caller's answer-sized budget, reasoning can consume all of it → empty `content` → callers
 * silently degrade (this is exactly what blanked the Learning page in 2026-07). So we give the
 * OpenAI-compatible/OpenRouter path headroom ON TOP of the requested answer budget: you're billed only
 * for tokens actually generated, so this is free for non-reasoning models and makes any model choice
 * work. Override with LLM_REASONING_HEADROOM_TOKENS. (The Anthropic path uses a separate thinking
 * budget and isn't affected.)
 */
const REASONING_HEADROOM_TOKENS = Number(process.env.LLM_REASONING_HEADROOM_TOKENS ?? 6000);

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
  /**
   * Which team model to use. `"query"` (default) = the direct/extraction model, with reasoning turned
   * OFF on OpenRouter (extraction doesn't need chain-of-thought and a reasoning model would starve
   * the answer). `"reasoning"` = the team's distinct reasoning model (`teams.reasoning_model`) with
   * reasoning left ON — for genuinely reasoning-heavy tasks like narrative arc synthesis.
   */
  role?: LlmRole;
  /**
   * Durably record this call's outcome (ok/fail + model) to `ingest_runs` (source `llm`), so the
   * answering-model health leg on the dashboard can show when the model is failing (empty output /
   * transport / auth) instead of the failure being an invisible `null`. Opt-in per caller (needs a
   * db + teamId), so high-frequency incidental calls (e.g. chat titles) don't flood the ledger.
   */
  record?: { db: DbClient; teamId: string; task: string };
}

/** Best-effort durable record of one LLM outcome — never throws (observability can't break the call). */
async function recordLlmOutcome(
  record: CompleteOptions["record"],
  outcome: { ok: boolean; model: string; error?: string; startedAt: number }
): Promise<void> {
  if (!record) return;
  await recordIngestRun(record.db, {
    teamId: record.teamId,
    source: "llm",
    trigger: "api",
    ok: outcome.ok,
    errors: outcome.ok ? [] : [outcome.error ?? "llm failed"],
    meta: { task: record.task, model: outcome.model },
    startedAt: outcome.startedAt,
  });
}

/** Run one completion; returns the model's text. Throws on transport/model error or empty output. */
export async function completeText(args: CompleteArgs, opts: CompleteOptions = {}): Promise<string> {
  const keys = opts.keys ?? {};
  const maxTokens = opts.maxTokens ?? 1024;
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const backend = selectLlmBackend({ LLM_BASE_URL, LLM_MODEL }, keys, { role: opts.role });
  const startedAt = Date.now();

  // For JSON mode, nudge every provider (OpenAI's json_object mode also requires "json" in the
  // messages, which this satisfies) — harmless when the system prompt already asks for JSON.
  const prompt = opts.jsonObject ? `${args.prompt}\n\nReturn ONLY the JSON object.` : args.prompt;

  try {
    let text: string;
    if (backend.kind !== "anthropic") {
      const apiKey = backend.apiKey ?? process.env.OPENAI_API_KEY ?? "local";
      const doPost = (maxTokensToSend: number) =>
        fetch(`${backend.baseUrl.replace(/\/$/, "")}/chat/completions`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${apiKey}`,
            ...(backend.kind === "openrouter" ? backend.headers : {}),
          },
          body: JSON.stringify({
            model: backend.model,
            max_tokens: maxTokensToSend,
            // Turn reasoning OFF on OpenRouter unless it's genuinely ACTIVE (`reasoningActive`: a
            // reasoning-role task that resolved to a DISTINCT reasoning model). This covers the query
            // role (extraction/short generation) AND — critically — a reasoning role that fell back to
            // the query model because `teams.reasoning_model` is unset: if that model is itself a
            // reasoning model, leaving reasoning on would spend the whole budget on hidden thinking and
            // return empty (what blanked the Learning arcs). Only a real distinct reasoning model keeps
            // reasoning on. Ignored by non-reasoning models. Override with LLM_DISABLE_REASONING=0.
            ...(backend.kind === "openrouter" &&
            !reasoningActive(opts.role, keys) &&
            process.env.LLM_DISABLE_REASONING !== "0"
              ? { reasoning: { enabled: false } }
              : {}),
            ...(opts.jsonObject ? { response_format: { type: "json_object" } } : {}),
            messages: [
              { role: "system", content: args.system },
              { role: "user", content: prompt },
            ],
          }),
          signal: AbortSignal.timeout(timeoutMs),
        });

      // First attempt: answer budget + reasoning headroom (so a reasoning model's hidden tokens don't
      // starve the answer to empty). If the headroom pushes max_tokens past a SMALL model's ceiling
      // (400), retry once with just the answer budget — mirrors the streaming path (lib/query/claude);
      // without this, every non-streaming task 400s on a small local backend while Query still works.
      let res = await doPost(maxTokens + REASONING_HEADROOM_TOKENS);
      if (!res.ok) {
        const firstErrBody = await res.text().catch(() => "");
        if (looksLikeTokenLimit(res.status, firstErrBody)) {
          res = await doPost(maxTokens);
          if (!res.ok) {
            throw new Error(`LLM ${backend.model} @ ${backend.baseUrl}: ${res.status} ${await res.text().catch(() => "")}`);
          }
        } else {
          throw new Error(`LLM ${backend.model} @ ${backend.baseUrl}: ${res.status} ${firstErrBody}`);
        }
      }
      const j = (await res.json()) as {
        choices?: { message?: { content?: string }; finish_reason?: string }[];
      };
      const choice = j.choices?.[0];
      text = (choice?.message?.content ?? "").trim();
      if (!text) {
        // Name WHY it's empty — `finish_reason:"length"` on empty content is the reasoning-model
        // starvation signature (all of max_tokens went to hidden reasoning). Loud so a blank panel is
        // never a silent, undiagnosable one.
        throw new Error(
          `LLM returned empty content (model=${backend.model}, finish_reason=${choice?.finish_reason ?? "?"})`
        );
      }
    } else {
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
      text = msg.content.map((b) => (b.type === "text" ? b.text : "")).join("").trim();
      if (!text) throw new Error("LLM returned empty content");
    }
    await recordLlmOutcome(opts.record, { ok: true, model: backend.model, startedAt });
    return text;
  } catch (err) {
    await recordLlmOutcome(opts.record, {
      ok: false,
      model: backend.model,
      error: err instanceof Error ? err.message : String(err),
      startedAt,
    });
    throw err;
  }
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
