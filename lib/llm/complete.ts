import "server-only";
import Anthropic from "@anthropic-ai/sdk";
import { selectLlmBackend, reasoningActive, type LlmBackendKeys, type LlmRole } from "@/lib/query/llm-backend";
import { looksLikeBudgetRefusal, looksLikeInFlightRefusal, looksLikeSizeRefusal } from "@/lib/query/claude";
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
/** A garbage env value must not become `NaN`: `maxTokens + NaN` serializes to `max_tokens: null`, which
 *  the provider reads as "no limit" — the opposite of a budget. Fall back to the default instead. */
const envTokens = (raw: string | undefined, fallback: number): number => {
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
};

const REASONING_HEADROOM_TOKENS = envTokens(process.env.LLM_REASONING_HEADROOM_TOKENS, 6000);

/**
 * Headroom for a call that is ACTUALLY routed to a reasoning model (`role:"reasoning"` with a distinct
 * `teams.reasoning_model` set). The flat 6000 above is sized for "some model here might reason"; this is
 * sized for "this model definitely will, over a large input".
 *
 * MEASURED, not guessed (ARCHEAD-1). Arc synthesis asks for 4096, so the old ceiling was 10,096 for
 * reasoning + answer together. Across 19 prod runs on `qwen/qwen3.7-plus`: successful runs generated
 * 3,892–9,870 output tokens, and ALL THREE failures sat at 10,096/10,098 — every failure is the cap, and
 * the best success cleared it by 226 tokens. 30% of arc runs died there, each billing ~1.5¢ for a blank.
 *
 * Deliberately NOT a bump to the global default: that would lift `max_tokens` on every OpenRouter call,
 * including the small-model paths whose ceiling then trips the token-limit retry below on every request.
 * Billing is per token GENERATED, so a bigger cap adds no PER-TOKEN cost to runs that already fit — it
 * only lets the runs that were being thrown away finish. Not literally free, though: OpenRouter filters
 * candidate providers by whether they can serve the requested `max_tokens` and pre-authorizes against
 * the worst case, so a larger ask can route to a different (pricier or slower) provider, or be refused
 * outright on a low-credit account. The ladder below is what keeps that refusal from becoming a blank.
 */
const REASONING_ROLE_HEADROOM_TOKENS = envTokens(process.env.LLM_REASONING_ROLE_HEADROOM_TOKENS, 16000);

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
  record?: LlmRecord;
  /**
   * Meter this call's token spend into the `llm_usage` ledger (the brain-spend meter that feeds the
   * Pulse Spend KPI + the costs breakdown page). Opt-in per caller (needs a db + teamId). `source` is
   * the feature slice ("arcs", "meeting-extract", …); `memberId` is the human initiator, or omitted /
   * null for a system/background call. Cost is provider-metered on OpenRouter and a price estimate on
   * Anthropic; captured best-effort so it can never break the generation.
   */
  meter?: { db: DbClient; teamId: string; source: LlmUsageSource; memberId?: string | null };
}

/**
 * A PASS — one `ingest_runs` row covering N calls (LLMOBS-2).
 *
 * WHY IT EXISTS. `recordLlmOutcome` writes one row per call, and `attachPersonDaySummaries` calls the
 * model once per (person, day) on every rebuild: 39.5 calls/day measured over 14d (21.3/day over 60d), against a whole-table rate
 * of 333.7 rows/day and a 50-row Recent-runs panel. Wiring a per-call `record:` there would bury
 * connector evidence within a day and a half, which is why LLMOBS-1 deferred it — leaving the leg's
 * FOUNDING failure mode open for its highest-volume feature: a model failing every timeline summary
 * reads `healthy`, because `completeTextOrNull` swallows the failure and nothing records it.
 *
 * BRANDED — and the brand's job is narrower than an earlier version of this comment claimed. It makes
 * the union DISCRIMINATED for narrowing, so `isPass` keys on something a caller cannot produce by
 * accident. It does NOT prevent the flood: `LlmPass` carries `db`/`teamId`/`task`, so it remains
 * structurally assignable to the per-call member, and deleting the `isPass` early-return below still
 * compiles. Review corrected the overstatement. The actual pin against that mutation is the runtime
 * integration test ("a PASS accumulates and writes nothing per call"), not the type system.
 */
const PASS_BRAND: unique symbol = Symbol("llm-pass");

export interface LlmPass {
  readonly [PASS_BRAND]: true;
  readonly db: DbClient;
  readonly teamId: string;
  readonly task: string;
  /** Mutable counters. Shared across `CONCURRENCY = 6` in-flight calls at the timeline site, which is
   *  safe ONLY because these increments are synchronous — there is no `await` between read and write.
   *  Stated because this repo's immutability rule pushes a reader the other way, so a future refactor
   *  that introduces an await here knows what it is breaking. */
  calls: number;
  failures: number;
  /** The real wall-clock start, so the row's `duration_ms` reflects the pass rather than 0. */
  readonly startedAt: number;
  /** The backend model, captured from the first call. Stable within a pass (`selectLlmBackend` is
   *  deterministic per keys/role), and REQUIRED by the health card: `deriveTaskHealth` reads
   *  `meta.model` and `degradedNote` names it. A row without it drops the model name and the
   *  reasoning-starvation hint from the operator copy — the wrong-picker misattribution LLMOBS-1
   *  existed to remove, which review caught this slice reinstating. */
  model: string | null;
  /** The FIRST failure's message. `meta.failures` says how many more there were. */
  firstError: string | null;
  done: boolean;
}

export type LlmRecord = { db: DbClient; teamId: string; task: string } | LlmPass;

function isPass(record: LlmRecord): record is LlmPass {
  // `in` throws a TypeError on a truthy PRIMITIVE, and this function sits behind a "never throws"
  // contract — a JS or `any` caller passing `record: "x"` would otherwise let observability break the
  // generation it is observing. Review found the contract overpromised.
  if (typeof record !== "object" || record === null) return false;
  // Narrow on the BRAND, not on duck-typed fields. Checking `calls`/`done` would send a token down
  // the per-call branch the moment either is renamed — silently restoring the flood. The symbol is a
  // real runtime value (a `declare const` would be type-only and `[PASS_BRAND]` would be `undefined`,
  // which is how the first attempt failed) and cannot be produced accidentally by a caller.
  return PASS_BRAND in record;
}

/**
 * Run `body` with a pass, and write its single row when it settles — including on a throw.
 *
 * SCOPED rather than open/close, deliberately. The first design was `beginLlmPass()` + `finish()` in a
 * `finally`, policed by a source-text guard. Review showed that guard cannot work: it passes
 * `const p = begin(); if (skip) return; try {…} finally { p.finish(); }`, which leaks on the early
 * return with the regex fully satisfied, and it fails a legitimate open-in-A/finish-in-B split. Text
 * cannot check control flow. This shape deletes the leak class instead of policing it — the caller
 * never holds an open pass, and the `finally` lives once, here.
 */
export async function withLlmPass<T>(
  init: { db: DbClient; teamId: string; task: string },
  body: (pass: LlmPass) => Promise<T>
): Promise<T> {
  const pass = {
    [PASS_BRAND]: true,
    db: init.db,
    teamId: init.teamId,
    task: init.task,
    calls: 0,
    failures: 0,
    startedAt: Date.now(),
    model: null,
    firstError: null,
    done: false,
  } as unknown as LlmPass;
  try {
    return await body(pass);
  } catch (err) {
    // A throw BEFORE the first call would otherwise be indistinguishable from a quiet pass — both hit
    // `calls === 0 && failures === 0` and write nothing, leaving `llm` (which has no staleness clock)
    // silent forever. That is the exact class §2c calls "evidence, not absence", and the first version
    // covered only the one branch that marks itself explicitly. Review found the rest.
    if (pass.calls === 0) {
      failLlmPassBeforeFirstCall(pass, err instanceof Error ? err.message : "the pass threw before its first call");
    }
    throw err;
  } finally {
    await finishLlmPass(pass);
  }
}

/**
 * Write the pass row. Idempotent — `done` guards it.
 *
 * Idempotence is NOT for "a finally after an early return", which review pointed out runs exactly
 * once; it is for a caller who adds a defensive explicit finish alongside the one this helper already
 * guarantees. Two rows for one pass would be two streak entries for one event.
 *
 * QUIET vs FAILED-BEFORE-THE-FIRST-CALL, a distinction the first draft collapsed. A pass with zero
 * calls and nothing to do writes NO row: `ok: true` would claim a model that was never asked, and
 * `ok: false` would accuse on no evidence. But a pass that FAILED before it could call anything —
 * `attachPersonDaySummaries` returns `degraded: true` with zero calls when `resolveAnsweringKeys`
 * throws, which the code itself calls "a failure, not a configuration choice" — is evidence, and it
 * records `ok: false` with `calls: 0`. Without that it was silent FOREVER: `llm` has no staleness
 * clock, is not a pipeline leg, and ages to `unknown` after `TASK_RECENCY_MS`.
 */
export async function finishLlmPass(pass: LlmPass): Promise<void> {
  if (pass.done) return;
  pass.done = true;
  // Nothing attempted and nothing failed ⇒ nothing to say.
  if (pass.calls === 0 && pass.failures === 0) return;
  // `ok` is "not every call failed" — see docs/design/llm-pass-recording.md §2b for why this is not a
  // threshold, and for the honest bound (one success in forty clears a pass).
  const ok = pass.calls > pass.failures;
  await recordIngestRun(pass.db, {
    teamId: pass.teamId,
    source: "llm",
    trigger: "api",
    ok,
    // `errors` must stay EMPTY on an ok pass: `recordIngestRun` forces `ok: run.ok && !errors.length`,
    // so putting the error there would silently flip a mostly-successful pass to failed.
    errors: ok ? [] : [pass.firstError ?? "every call in the pass failed"],
    meta: {
      task: pass.task,
      // `null`, not `""` — an empty string is a value that survives `??` downstream and would hand the
      // card `lastModel: ""` where every other path yields a name or null (review).
      model: pass.model,
      calls: pass.calls,
      failures: pass.failures,
      // UNCONDITIONALLY, including on an ok pass. Otherwise a 39-of-40-failures pass records its
      // counts and drops the error text entirely — nowhere in `errors` (see above) and nowhere in
      // meta — for what the timeline site itself calls "the common outcome of a flaky or rate-limited
      // provider". The counts say how many; this says what happened.
      firstError: pass.firstError,
    },
    startedAt: pass.startedAt,
  });
}

/** Mark a pass as failed before it made any call — see `finishLlmPass`. */
export function failLlmPassBeforeFirstCall(pass: LlmPass, error: string): void {
  pass.failures += 1;
  pass.firstError = pass.firstError ?? error;
}

/**
 * Best-effort durable record of one LLM outcome — never throws (observability can't break the call).
 *
 * EXPORTED for tests, deliberately. This is where a per-call record and a pass diverge, and a
 * mutation that made the pass branch unreachable — restoring the per-call flood — survived a suite
 * that drove the pass counters through a hand-written helper instead of through here. A simulation of
 * the integration is not the integration.
 */
export async function recordLlmOutcome(
  record: CompleteOptions["record"],
  outcome: { ok: boolean; model: string; error?: string; startedAt: number }
): Promise<void> {
  if (!record) return;
  // NARROW ON THE BRAND FIRST. A pass accumulates into ONE row written at the end; taking the
  // per-call branch here is exactly the flood this slice removes, and it would be invisible — the
  // coverage guard matches `record: pass` just as happily.
  if (isPass(record)) {
    record.calls += 1;
    record.model = record.model ?? outcome.model;
    if (!outcome.ok) {
      record.failures += 1;
      record.firstError = record.firstError ?? outcome.error ?? "llm failed";
    }
    return;
  }
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
/** Extra attempts for an IN-FLIGHT refusal (LLMCREDIT-2) — bounded, and the caller's `timeoutMs` still
 *  governs the whole call, so a wedged provider cannot stall a rebuild. */
export const IN_FLIGHT_RETRIES = 2;
const IN_FLIGHT_BASE_MS = 1_200;
/** No provider gets to park a background rebuild for longer than this, whatever its header says. */
export const IN_FLIGHT_MAX_WAIT_MS = 8_000;

/**
 * How long to wait before re-sending a request the provider refused for IN-FLIGHT budget.
 *
 * `Retry-After` when the header is present and sane (seconds, per RFC 9110), otherwise exponential
 * backoff. ⚠️ JITTER IS PART OF THE DESIGN, not a flourish: the refusals arrive because SIX siblings
 * were in flight together, so a fixed delay would release all six at the same instant and reproduce
 * the collision that caused them. `rand` is injected so the criterion is deterministic.
 *
 * The header is CLAMPED. An absent, negative, non-numeric or absurd value falls back to the computed
 * backoff — a provider should not be able to stall a background rebuild for as long as it likes.
 */
export function inFlightWaitMs(retryAfter: string | null, attempt: number, rand: () => number = Math.random): number {
  const header = Number(retryAfter);
  if (retryAfter !== null && Number.isFinite(header) && header > 0) {
    const ms = header * 1000;
    if (ms <= IN_FLIGHT_MAX_WAIT_MS) return ms;
  }
  const base = Math.min(IN_FLIGHT_BASE_MS * 2 ** attempt, IN_FLIGHT_MAX_WAIT_MS);
  return Math.round(base * (0.5 + rand() * 0.5)); // 50-100% of the base — spreads the burst
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

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
      // A LADDER, not a cliff. On a token-limit refusal we step DOWN one rung at a time instead of
      // dropping straight to the bare answer budget. That mattered the moment the reasoning rung got
      // bigger: a provider whose output ceiling sits between the two rungs would refuse the top ask and
      // land the retry on `maxTokens` alone — 4096 for arcs, combined with reasoning still ON, which is
      // BELOW the 3,892 minimum a successful run has ever needed. The old 30%-of-runs failure would have
      // become ~100%. Verified once against prod that `qwen/qwen3.7-plus` accepts the top rung (HTTP 200,
      // finish=stop), so this is insurance for the next model rather than a live bug — but it is the
      // difference between degrading and falling over.
      const rungs = [...new Set([
        maxTokens + (reasoningActive(opts.role, keys) ? REASONING_ROLE_HEADROOM_TOKENS : REASONING_HEADROOM_TOKENS),
        maxTokens + REASONING_HEADROOM_TOKENS, // the budget prod ran on for months — known-accepted
        maxTokens,
      ])].sort((a, b) => b - a);
      /**
       * One rung, with the IN-FLIGHT refusal waited out in place (LLMCREDIT-2).
       *
       * Returns the body alongside the response because a `Response` body can only be read once and
       * this has to classify it before deciding. Reading it here — rather than cloning — keeps the
       * single-read contract obvious at the call sites below.
       *
       * ⚠️ THE SAME RUNG, deliberately. A smaller request does not help when the refusal is about the
       * OTHER requests in flight; that is the difference between this and the size ladder underneath.
       */
      const postRung = async (mt: number): Promise<{ res: Response; errBody: string }> => {
        let r = await doPost(mt);
        for (let attempt = 0; attempt < IN_FLIGHT_RETRIES && !r.ok; attempt++) {
          const body = await r.text().catch(() => "");
          if (!looksLikeInFlightRefusal(r.status, body)) return { res: r, errBody: body };
          // ⚠️ A REAL DEADLINE, because `timeoutMs` does NOT bound this on its own: the abort signal is
          // built inside `doPost`, so EVERY attempt gets its own fresh `timeoutMs` and the wall clock
          // is the sum. An earlier draft of the spec claimed the caller's budget clamped the total —
          // it did not, and waiting is the one thing this change adds that a caller cannot see. So the
          // added waiting is bounded by that same budget, which makes the claim true instead of just
          // correcting it.
          if (Date.now() - startedAt >= timeoutMs) return { res: r, errBody: body };
          // Filed even when the retry then succeeds — same reason as the budget refusal below: a
          // throttle we recover from silently is how a depleted balance stays invisible.
          if (opts.meter) {
            await recordLlmFailure(opts.meter.db, {
              teamId: opts.meter.teamId,
              memberId: opts.meter.memberId ?? null,
              source: opts.meter.source,
              provider: backend.provider,
              model: backend.model,
              reason: "http_402_in_flight",
              durationMs: Date.now() - startedAt,
            }).catch(() => {});
          }
          await sleep(inFlightWaitMs(r.headers?.get?.("retry-after") ?? null, attempt));
          r = await doPost(mt);
        }
        return { res: r, errBody: r.ok ? "" : await r.text().catch(() => "") };
      };

      let { res, errBody: bodyOfLastRefusal } = await postRung(rungs[0]);
      for (let i = 1; i < rungs.length && !res.ok; i++) {
        const errBody = bodyOfLastRefusal;
        // Only a SIZE refusal is worth retrying smaller; anything else is a real error and must
        // surface immediately rather than being re-sent two more times.
        //
        // LLMCREDIT-1 widened "size" to include a budget-shaped 402. OpenRouter prices a request by
        // its max_tokens CEILING, so a nearly-empty balance refuses the top rung while still affording
        // the bottom one — and the ladder walking down is exactly the remedy the provider names in its
        // own response. Measured on prod 2026-08-25: timeline summaries and doc-task inference were
        // failing at 6,200 and 6,900 tokens while their real budgets (200, 900) sat well inside the
        // 3,116 the account could still afford. ⚠️ NOT every task recovers this way — a leg whose
        // ANSWER budget alone exceeds what is affordable (arcs at 4,096) still fails, and must.
        if (!looksLikeSizeRefusal(res.status, errBody)) throw httpError(backend, res.status, errBody);
        // ⚠️ FILED EVEN IF THE NEXT RUNG SUCCEEDS. A budget refusal that we quietly recover from is the
        // silent-degrade failure this repo has already been bitten by: service looks fine while the
        // account empties. `llm_failures` is the ledger for provider refusals and surfaces as
        // `failed_attempts` in the cost breakdown, so filing here makes "we are nearly out of credit"
        // visible WITHOUT reddening a banner about work that did get done.
        if (looksLikeBudgetRefusal(res.status, errBody) && opts.meter) {
          await recordLlmFailure(opts.meter.db, {
            teamId: opts.meter.teamId,
            memberId: opts.meter.memberId ?? null,
            source: opts.meter.source,
            provider: backend.provider,
            model: backend.model,
            reason: `http_${res.status}` as `http_${number}`,
            durationMs: Date.now() - startedAt,
          }).catch(() => {});
        }
        ({ res, errBody: bodyOfLastRefusal } = await postRung(rungs[i]));
      }
      if (!res.ok) {
        throw httpError(backend, res.status, bodyOfLastRefusal);
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
    // this function's only retries are the token-limit LADDER's re-asks (up to two step-downs), so a
    // laddered call under-counts by however many rungs were refused. Those refusals are pre-generation
    // 400s that billed nothing, so the money under-count is ~zero — it is the ATTEMPT count that is low.
    // Stated rather than fixed: over-counting a spend gap is worse than under-counting it.
    // A failure that never reached a provider spent nothing, so it must not enter a ledger whose only
    // job is explaining money — the Anthropic SDK throws at CONSTRUCTION when no key resolves, and a
    // malformed base URL throws a TypeError before any request. Both are configuration faults, already
    // surfaced by `recordLlmOutcome` above; filing them here would inflate the spend gap with $0 rows.
    // ⚠️ "one row per logical call" is no longer strictly true, and the ARCHITECTURE row says so:
    // LLMCREDIT-1 files a budget-shaped 402 from INSIDE the ladder as well, so a call refused at an
    // upper rung and then failing here contributes both rows. Each maps to a real refused HTTP
    // request, which is what this ledger counts — but a reader comparing row counts to call counts
    // needs to know the unit changed.
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
