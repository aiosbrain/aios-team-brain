import "server-only";
import { runSql } from "@/lib/db/pg/pool";

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

export type LlmHealthState = "unknown" | "healthy" | "degraded";

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

/** Derive the pure state from the latest recorded LLM outcome. Exported for unit tests. */
export function deriveLlmState(lastRun: { ok: boolean } | null): LlmHealthState {
  if (!lastRun) return "unknown";
  return lastRun.ok ? "healthy" : "degraded";
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
      `select ok, meta, errors, finished_at from ingest_runs
       where source = 'llm' and team_id = $1 order by finished_at desc, id desc limit 1`,
      [teamId]
    );
    const row = res.rows[0];
    if (!row) return empty;

    const meta = asObject(row.meta);
    const model = typeof meta.model === "string" ? meta.model : null;
    const finishedAt = row.finished_at instanceof Date ? row.finished_at.toISOString() : String(row.finished_at);

    if (row.ok) {
      return { state: "healthy", lastModel: model, lastError: null, lastOkAt: finishedAt, lastFailedAt: null };
    }

    const errors = asArray(row.errors);
    const lastError = typeof errors[0] === "string" ? (errors[0] as string) : "the answering model returned an error";
    const isEmptyOutput = /empty content|finish_reason/i.test(lastError);
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
