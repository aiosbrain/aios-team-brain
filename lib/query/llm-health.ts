import "server-only";
import { runSql } from "@/lib/db/pg/pool";
import { classifyFailure, foldStreak, FAILURES_TO_CONFIRM } from "@/lib/ingest/failure-streak";

/**
 * Answering-model health for the admin dashboard. Every non-streaming LLM task funnels through
 * `lib/llm/complete`, which (when the caller opts in) records each outcome to `ingest_runs` with
 * source `llm`. This reads the most recent such row so "is the configured model actually producing
 * output right now?" is answerable on the dashboard — the blind spot that let a reasoning model
 * blank the Learning page with zero signal.
 *
 * Best-effort: "unknown" on any error or when nothing has been recorded yet; never throws into a
 * page render.
 */

/**
 * `unstable` is a lone, UNCONFIRMED failure (BANNERFLAP-1): the newest run failed and the one before
 * it succeeded. Real and worth showing — quietly — but not evidence that the answering model is
 * broken. It exists because a single blip used to read exactly like an outage: one arc-synthesis
 * failure on 2026-08-11 painted "2 ingestion legs are broken" for ~5h48m and the very next run
 * succeeded.
 *
 * Consumers MUST map this union exhaustively (a `Record<LlmHealthState, …>`, not a ternary chain).
 * The first draft let `unstable` fall through the card's `healthy ? … : degraded ? … : "off"` chain
 * to a GREY dot captioned "no recent activity recorded" — a false statement about a leg that had just
 * failed. A text-matching guard cannot catch that class (a future `state !== "healthy"` derived
 * boolean slips right past it), so the compiler does that half.
 */
export type LlmHealthState = "unknown" | "healthy" | "unstable" | "degraded";

export interface LlmHealth {
  state: LlmHealthState;
  lastModel: string | null;
  lastError: string | null;
  lastOkAt: string | null;
  lastFailedAt: string | null;
  note?: string;
}

function asObject(v: unknown): Record<string, unknown> {
  if (v && typeof v === "object") return v as Record<string, unknown>;
  if (typeof v === "string") {
    try {
      const p = JSON.parse(v);
      return p && typeof p === "object" ? (p as Record<string, unknown>) : {};
    } catch {
      return {};
    }
  }
  return {};
}

function asArray(v: unknown): unknown[] {
  if (Array.isArray(v)) return v;
  if (typeof v === "string") {
    try {
      const p = JSON.parse(v);
      return Array.isArray(p) ? p : [];
    } catch {
      return [];
    }
  }
  return [];
}

/**
 * Derive the state from the recent recorded LLM outcomes, NEWEST FIRST. Exported for unit tests.
 *
 * Takes a list rather than one row since BANNERFLAP-1: one failed row is a sample of size one, and on
 * this install `llm` heals on the next attempt 6 times out of 10 (60d of prod). A lone failure is
 * `unstable`; a streak is `degraded`.
 *
 * KNOWN LIMITATION, recorded rather than hidden: source `llm` multiplexes EVERY completion task, so a
 * model failing only on long prompts records failures interleaved with cheap-title successes and the
 * streak may never reach two. That is equally true of the single-row read this replaces (the newest
 * row was just as likely to be an unrelated success), so this does not worsen it; detection rides on
 * the separate `arcs` leg, which records one row per failed synthesis. De-multiplexing by `meta.task`
 * is named as deferred in the spec.
 */
export function deriveLlmState(runsNewestFirst: readonly { ok: boolean }[] | null): LlmHealthState {
  if (!runsNewestFirst || runsNewestFirst.length === 0) return "unknown";
  const streak = foldStreak(runsNewestFirst.map((r) => ({ ok: r.ok, finishedAt: "" })));
  const klass = classifyFailure(streak);
  return klass === "ok" ? "healthy" : klass === "unconfirmed" ? "unstable" : "degraded";
}

export async function getLlmHealth(teamId: string): Promise<LlmHealth> {
  const empty: LlmHealth = {
    state: "unknown",
    lastModel: null,
    lastError: null,
    lastOkAt: null,
    lastFailedAt: null,
  };
  try {
    const res = await runSql<{ ok: boolean; meta: unknown; errors: unknown; finished_at: string | Date }>(
      // Tie-break by `id desc`: two runs can share a millisecond `finished_at` (a fast fail then a retry
      // in the same tick), and without the tie-break "the latest run" is arbitrary — the row's `ok` then
      // flickers between degraded/healthy. `id` is the bigserial PK, so the most-recently-inserted run
      // wins deterministically (the correct "latest").
      //
      // `limit $2`, not `limit 1`, since BANNERFLAP-1: the verdict now needs the run BEFORE the newest
      // one to tell a blip from an outage. Only `FAILURES_TO_CONFIRM` rows are needed to classify —
      // `failingSince` is not rendered for this leg, so the unbounded streak the pipeline query
      // computes would be work with no consumer here.
      `select ok, meta, errors, finished_at from ingest_runs
       where source = 'llm' and team_id = $1 order by finished_at desc, id desc limit $2`,
      [teamId, FAILURES_TO_CONFIRM]
    );
    const row = res.rows[0];
    if (!row) return empty;

    const meta = asObject(row.meta);
    const model = typeof meta.model === "string" ? meta.model : null;
    const finishedAt = row.finished_at instanceof Date ? row.finished_at.toISOString() : String(row.finished_at);
    const state = deriveLlmState(res.rows);

    if (row.ok) {
      return { state: "healthy", lastModel: model, lastError: null, lastOkAt: finishedAt, lastFailedAt: null };
    }

    const errors = asArray(row.errors);
    const lastError = typeof errors[0] === "string" ? (errors[0] as string) : "the answering model returned an error";
    const isEmptyOutput = /empty content|finish_reason/i.test(lastError);
    // An UNCONFIRMED failure keeps `lastError`/`lastFailedAt` — it happened, and the card shows it —
    // but carries NO `note`. `note` is what drives the red paragraph and the "may be blank" warning;
    // a blip that the next call will very likely clear has not earned either. (Measured: `llm` heals
    // on the next run 6 times out of 10.)
    if (state === "unstable") {
      return { state, lastModel: model, lastError, lastOkAt: null, lastFailedAt: finishedAt };
    }
    return {
      state: "degraded",
      lastModel: model,
      lastError,
      lastOkAt: null,
      lastFailedAt: finishedAt,
      note:
        `The answering model${model ? ` (${model})` : ""} recently failed to produce output — Learning arcs and meeting summaries may be blank.` +
        (isEmptyOutput
          ? " It returned empty output, which is the signature of a reasoning model starving its own answer; pick a non-reasoning model in Admin → Active answering model."
          : " Check the model and key in Admin → Active answering model.") +
        ` (${lastError})`,
    };
  } catch {
    return empty;
  }
}
