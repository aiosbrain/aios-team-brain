import "server-only";
import Anthropic from "@anthropic-ai/sdk";
import { selectLlmBackend, reasoningActive, type LlmBackendKeys, type LlmRole } from "@/lib/query/llm-backend";
import { looksLikeTokenLimit } from "@/lib/query/claude";
import { recordIngestRun } from "@/lib/ingest/runs";
import { recordLlmUsage, recordLlmFailure, classifyLlmFailure, type LlmUsageSource } from "@/lib/costs/llm-usage";
import { estimateAnthropicCostUsd } from "@/lib/llm/cost";
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
  /**
   * Meter this call's token spend into the `llm_usage` ledger (the brain-spend meter that feeds the
   * Pulse Spend KPI + the costs breakdown page). Opt-in per caller (needs a db + teamId). `source` is
   * the feature slice ("arcs", "meeting-extract", …); `memberId` is the human initiator, or omitted /
   * null for a system/background call. Cost is provider-metered on OpenRouter and a price estimate on
   * Anthropic; captured best-effort so it can never break the generation.
   */
  meter?: { db: DbClient; teamId: string; source: LlmUsageSource; memberId?: string | null };
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
/**
 * A provider non-2xx, carrying the status so the failure ledger can file it as `http_<status>` rather
 * than the catch-all `network`. Without this the status only survives inside the message string, and a
 * 402 insufficient-credits reads as an infrastructure fault — sending an operator to chase the network
 * when the answer is "top up the account". Misattributing the reason is the thing that column exists
 * to prevent.
 */
class LlmHttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = "LlmHttpError";
  }
}
/** Config faults that throw before a request is on the wire (missing key, bad client options). */
const isConfigError = (err: unknown): boolean =>
  err instanceof Error && /api[_ ]?key|apiKey|could not resolve|missing credentials/i.test(err.message);

const httpError = (backend: { model: string; baseUrl?: string }, status: number, body: string): LlmHttpError =>
  new LlmHttpError(status, `LLM ${backend.model} @ ${backend.baseUrl ?? "?"}: ${status} ${body}`);

export async function completeText(args: CompleteArgs, opts: CompleteOptions = {}): Promise<string> {
  const keys = opts.keys ?? {};
  const maxTokens = opts.maxTokens ?? 1024;
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const backend = selectLlmBackend({ LLM_BASE_URL, LLM_MODEL }, keys, { role: opts.role });
  const startedAt = Date.now();

  // For JSON mode, nudge every provider (OpenAI's json_object mode also requires "json" in the
  // messages, which this satisfies) — harmless when the system prompt already asks for JSON.
  const prompt = opts.jsonObject ? `${args.prompt}\n\nReturn ONLY the JSON object.` : args.prompt;

  // Token/cost capture for the llm_usage meter (opts.meter). Populated per-branch below.
  // Set once the empty-content path has already metered + filed, so the catch doesn't double-file.
  let metered = false;
  let inTok = 0;
  let outTok = 0;
  let costUsd = 0;
  let estimated = false;

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
            // Ask OpenRouter for the real generation cost (mirrors the streaming answer path); read
            // below as `usage.cost`. Harmless no-op on providers that already include usage.
            ...(backend.kind === "openrouter" ? { usage: { include: true } } : {}),
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
            throw httpError(backend, res.status, await res.text().catch(() => ""));
          }
        } else {
          throw httpError(backend, res.status, firstErrBody);
        }
      }
      const j = (await res.json()) as {
        choices?: { message?: { content?: string }; finish_reason?: string }[];
        usage?: { prompt_tokens?: number; completion_tokens?: number; cost?: number };
      };
      inTok = j.usage?.prompt_tokens ?? 0;
      outTok = j.usage?.completion_tokens ?? 0;
      if (typeof j.usage?.cost === "number") {
        // OpenRouter reports the real charge here — metered, authoritative.
        costUsd = j.usage.cost;
        estimated = false;
      } else {
        // No provider-reported charge. A bare LOCAL endpoint is genuinely free ($0, authoritative).
        // An OpenAI-cloud backend IS paid but we have no price table for it — record $0 but flag it as
        // NOT a real charge so it doesn't read as an authoritative $0 and silently undercount spend.
        costUsd = 0;
        estimated = backend.provider !== "local";
      }
      const choice = j.choices?.[0];
      text = (choice?.message?.content ?? "").trim();
      if (!text) {
        // METER BEFORE THROWING. The provider generated (and billed for) those tokens — `usage.cost`
        // above is the real charge, already in scope. Throwing first discarded dollars we had literally
        // just read, which is spend the ledger could always have captured and instead handed to the
        // Costs page's "can't be attributed" remainder. The generation failing does not un-bill it.
        if (opts.meter) {
          await recordLlmUsage(opts.meter.db, {
            teamId: opts.meter.teamId,
            memberId: opts.meter.memberId ?? null,
            source: opts.meter.source,
            provider: backend.provider,
            model: backend.model,
            inputTokens: inTok,
            outputTokens: outTok,
            costUsd,
            estimated,
          });
          // NOT also filed to `llm_failures`. That table means "billed, but nothing to price" — this
          // call IS priced, on the line above. Filing both would double-count the same attempt against
          // `calls` and `failed_attempts`, and make the Costs page's "their dollars are never in these
          // bars" read false. Why it produced nothing is already durable in `ingest_runs` via
          // `recordLlmOutcome`. `metered` stops the catch below filing it as a transport failure.
          metered = true;
        }
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
      // Anthropic doesn't hand back a dollar charge — estimate from list prices (estimated=true).
      // Computed BEFORE the empty check, mirroring the OpenAI branch: an empty completion is still
      // billed, and throwing first discarded the tokens we already had. Same leak, other branch.
      inTok = msg.usage?.input_tokens ?? 0;
      outTok = msg.usage?.output_tokens ?? 0;
      costUsd = estimateAnthropicCostUsd(inTok, outTok);
      estimated = true;
      if (!text) {
        if (opts.meter) {
          await recordLlmUsage(opts.meter.db, {
            teamId: opts.meter.teamId,
            memberId: opts.meter.memberId ?? null,
            source: opts.meter.source,
            provider: backend.provider,
            model: backend.model,
            inputTokens: inTok,
            outputTokens: outTok,
            costUsd,
            estimated,
          });
          metered = true;
        }
        throw new Error("LLM returned empty content");
      }
    }
    await recordLlmOutcome(opts.record, { ok: true, model: backend.model, startedAt });
    if (opts.meter) {
      await recordLlmUsage(opts.meter.db, {
        teamId: opts.meter.teamId,
        memberId: opts.meter.memberId ?? null,
        source: opts.meter.source,
        provider: backend.provider,
        model: backend.model,
        inputTokens: inTok,
        outputTokens: outTok,
        costUsd,
        estimated,
      });
    }
    return text;
  } catch (err) {
    await recordLlmOutcome(opts.record, {
      ok: false,
      model: backend.model,
      error: err instanceof Error ? err.message : String(err),
      startedAt,
    });
    // File the billed-but-unmeterable attempt so the Costs page can name which feature lost the money.
    // ONE row per logical call here, unlike the graph proxy where each SDK retry is its own request —
    // this function's only retry is the token-limit re-ask, so a two-attempt call under-counts by one.
    // Stated rather than fixed: over-counting a spend gap is worse than under-counting it.
    // A failure that never reached a provider spent nothing, so it must not enter a ledger whose only
    // job is explaining money — the Anthropic SDK throws at CONSTRUCTION when no key resolves, and a
    // malformed base URL throws a TypeError before any request. Both are configuration faults, already
    // surfaced by `recordLlmOutcome` above; filing them here would inflate the spend gap with $0 rows.
    const reachedProvider = !(err instanceof TypeError) && !isConfigError(err);
    if (opts.meter && !metered && reachedProvider) {
      await recordLlmFailure(opts.meter.db, {
        teamId: opts.meter.teamId,
        memberId: opts.meter.memberId ?? null,
        source: opts.meter.source,
        provider: backend.provider,
        model: backend.model,
        reason: err instanceof LlmHttpError ? (`http_${err.status}` as `http_${number}`) : classifyLlmFailure(err),
        durationMs: Date.now() - startedAt,
      });
    }
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
