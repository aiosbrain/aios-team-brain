import "server-only";
import { runSql } from "@/lib/db/pg/pool";
import { classifyFailure, foldStreak, FAILURES_TO_CONFIRM } from "@/lib/ingest/failure-streak";

/**
 * Answering-model health for the admin dashboard. Non-streaming LLM tasks funnel through
 * `lib/llm/complete`, which records an outcome to `ingest_runs` (source `llm`) WHEN THE CALLER OPTS IN
 * with `record:`. That opt-in is the whole story of this file, and of LLMOBS-1.
 *
 * WHAT WAS WRONG (LLMOBS-1 / AIO-905). Exactly ONE file opted in — `lib/graph/arcs.ts` — so every
 * `source='llm'` row that had ever existed was `arcs` (48 runs, 10 failures) or `arc-coherence` (17,
 * 0). Yet the degraded copy told operators that "Learning arcs and MEETING SUMMARIES may be blank".
 * The leg had never observed a meeting summary and could not: meeting extraction recorded nothing. So
 * it made a false claim, AND a model blanking meeting summaries read `healthy` — which is precisely
 * the silent failure this file was created to end (see the paragraph below it).
 *
 * `arcs` was also the least representative task to generalise from: it is the only caller requesting
 * `role: "reasoning"`, so it fails on reasoning-budget starvation, a mode the other tasks cannot hit.
 *
 * WHAT IT DOES NOW: one failure streak PER `meta.task`, with the leg reporting the worst state across
 * tasks that have run recently, and copy that names the task that actually failed with the model that
 * actually failed it.
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

/**
 * How long a task's newest run may be before it stops counting toward the verdict.
 *
 * WITHOUT THIS the per-task split is strictly worse than the single stream it replaces. A single
 * stream heals because ANY newer row clears it; per-task removes that path, so a task whose last two
 * runs failed and which then never runs again would be `confirmed` forever — and that is the NORMAL
 * state of several tasks here: `canReuseArcs` hash-skips when facts are unchanged, meetings only run
 * on upload, `doc_task_infer` is documented as legally silent for days. Two `meeting-summary` failures
 * in March would otherwise leave the card degraded in August, naming a feature nobody has used since,
 * unfixable by any operator action except uploading a meeting. Both cold reads blocked the spec on it.
 *
 * 14 days is measured against the observed cadences, not chosen: `arcs` ran 48 times in 27 days and
 * the meetings passes 42 times in 14, so a genuinely-live task always has a run inside the window. It
 * is a FIRST VALUE — if prod shows a live task ageing out, the response is to widen the window, not to
 * remove it, because removing it restores the forever-red bug.
 *
 * Ageing out only ever SILENCES, never accuses, and the transition is one-way per quiet period (a task
 * cannot re-enter without a new run, and a new run re-judges on fresh evidence), so there is no flap at
 * the boundary. The residual cost is real and bounded: an `arcs` failure followed by a fortnight of
 * hash-skips ages off THIS card — but the `arcs` PIPELINE leg has no recency window and stays loud,
 * which is the backstop.
 */
export const TASK_RECENCY_MS = 14 * 86_400_000;

/** One task's own verdict — the unit the leg is composed from, and the unit the copy names. */
export interface LlmTaskHealth {
  task: string;
  state: LlmHealthState;
  /** The model THIS task ran on. Deliberately per-task: `arcs` uses `teams.reasoning_model` and the
   *  rest the query model, so a leg-level model name would send an operator to the wrong picker. */
  model: string | null;
  lastError: string | null;
  lastFailedAt: string | null;
  lastOkAt: string | null;
}

export interface LlmHealth {
  state: LlmHealthState;
  /**
   * Per-task breakdown. Added by LLMOBS-1 because the leg-level fields below CANNOT express a
   * multi-task outage: the note must name every confirmed-failing task, and with `arcs` failing on the
   * reasoning model while `meeting-summary` fails on the query model, one `lastModel` slot describes
   * at most one of them. Both reviewers blocked the spec on that contradiction.
   *
   * Only tasks inside `TASK_RECENCY_MS` appear here — this is the set the verdict is computed over.
   */
  tasks: LlmTaskHealth[];
  /** The newest FAILING row across tasks (not the leg's newest row — that could be an unrelated
   *  success and would name the wrong model). Retained for the card's single detail line. */
  lastModel: string | null;
  lastError: string | null;
  lastOkAt: string | null;
  lastFailedAt: string | null;
  note?: string;
}

/**
 * Task slug → operator copy. The slugs are developer literals (`meeting-summary`, `doc-task-infer`);
 * "The answering model failed on doc-task-infer" is not a sentence to show an admin.
 *
 * The FALLBACK is load-bearing, not defensive dressing: the coverage guard
 * (`test/guards/llm-record-coverage`) exists to make new tasks appear, so an unmapped slug is the
 * expected steady state after any new generation feature, not an error.
 */
const TASK_COPY = new Map<string, string>([
  ["arcs", "Learning arcs"],
  ["arc-coherence", "Learning arc coherence"],
  ["meeting-summary", "meeting summaries"],
  ["meeting-actions", "meeting action items"],
  ["meeting-merge", "meeting transcript merging"],
  ["attribution", "attribution corrections"],
  ["timeline-summary", "timeline summaries"],
  ["doc-task-infer", "task suggestions"],
]);

/**
 * A `Map`, not an object literal, for the same reason as the banner's copy of this: `task` comes from
 * `meta->>'task'`, so an object lookup walks the prototype chain and `TASK_COPY["constructor"]` returns
 * a function rather than falling through to the fallback. Static analysis flagged only the component;
 * this side had the identical sink and is fixed with it, because fixing the flagged instance alone is
 * how the same bug survives in the file nobody scanned.
 */
export function taskLabel(task: string): string {
  return TASK_COPY.get(task) ?? `a background task (${task})`;
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
 * One recorded run, as the per-task read returns it.
 */
export interface LlmRun {
  ok: boolean;
  task: string;
  model: string | null;
  error: string | null;
  finishedAt: string;
}

/** Worst-first, so "the leg is the worst of its tasks" is a max over this order. */
const SEVERITY: Record<LlmHealthState, number> = { unknown: 0, healthy: 1, unstable: 2, degraded: 3 };

/**
 * Per-task verdicts from recorded runs, NEWEST FIRST overall.
 *
 * Takes a list rather than one row since BANNERFLAP-1 (one failed row is a sample of size one — on
 * this install `llm` heals on the next attempt 6 times out of 10), and now groups by task since
 * LLMOBS-1.
 *
 * WHY GROUPING IS NOT OPTIONAL once more than one task records. The two meetings passes run
 * back-to-back on every trigger with ACTION ITEMS LAST, so a failure that hits only the summary pass
 * produces `fail(summary), ok(actions)` per upload. Under one shared stream the newest row is then
 * always `ok` and the leg reads `healthy` — not even `unstable` — while every meeting summary is
 * blank. That is the exact silent failure this file exists to end, and an earlier draft of this slice
 * reintroduced it by giving both passes one task string. Grouping is what makes the split real.
 *
 * `nowMs` is injected rather than read from the clock so the recency window is testable.
 */
export function deriveTaskHealth(runsNewestFirst: readonly LlmRun[] | null, nowMs: number): LlmTaskHealth[] {
  if (!runsNewestFirst || runsNewestFirst.length === 0) return [];
  const byTask = new Map<string, LlmRun[]>();
  for (const run of runsNewestFirst) {
    const bucket = byTask.get(run.task);
    if (bucket) bucket.push(run);
    else byTask.set(run.task, [run]);
  }
  const out: LlmTaskHealth[] = [];
  for (const [task, runs] of byTask) {
    const newest = runs[0];
    // TASK-LEVEL windowing, not row-level — the two classify differently and the spec picked this
    // one deliberately: a newest failure yesterday whose predecessor is 16 days old is `confirmed`
    // here and `unconfirmed` under a row filter. The streak asks "has this task failed repeatedly",
    // and a 16-day-old failure is still the last thing that happened to this task.
    // An UNPARSEABLE timestamp yields NaN, and `NaN > x` is false, so the task is INCLUDED rather than
    // aged out. That is the safe direction here — ageing out silences, and silencing on a value we
    // failed to read would hide an outage on ignorance. Stated because it is a real branch, not
    // because it is reachable: these are `timestamptz` columns through a single writer.
    if (nowMs - Date.parse(newest.finishedAt) > TASK_RECENCY_MS) continue;
    const streak = foldStreak(runs.map((r) => ({ ok: r.ok, finishedAt: r.finishedAt })));
    const newestFailure = runs.find((r) => !r.ok) ?? null;
    const newestOk = runs.find((r) => r.ok) ?? null;
    const klass = classifyFailure(streak);
    const state: LlmHealthState = klass === "ok" ? "healthy" : klass === "unconfirmed" ? "unstable" : "degraded";
    out.push({
      task,
      state,
      // The model the task's STATE is about: for a failing task that is the failing run's model, not
      // the newest run's — a task can fail on one model and be retried on another, and naming the
      // retry's model sends an operator to the wrong picker.
      model: state === "healthy" ? newest.model : (newestFailure?.model ?? newest.model),
      lastError: newestFailure?.error ?? null,
      lastFailedAt: newestFailure?.finishedAt ?? null,
      lastOkAt: newestOk?.finishedAt ?? null,
    });
  }
  return out;
}

/**
 * The leg's state: the WORST across participating tasks.
 *
 * `unknown` when NO task participates — either nothing was ever recorded, or every task's newest run
 * has aged past `TASK_RECENCY_MS`. The card's existing "no recent activity recorded" copy is, in that
 * state, exactly true for once. Both cold reads flagged that an earlier draft left this undefined.
 */
export function deriveLlmState(tasks: readonly LlmTaskHealth[]): LlmHealthState {
  if (tasks.length === 0) return "unknown";
  return tasks.reduce<LlmHealthState>(
    (worst, t) => (SEVERITY[t.state] > SEVERITY[worst] ? t.state : worst),
    "healthy"
  );
}

/**
 * The operator sentence for a degraded leg — names every confirmed-failing task, each with its OWN
 * model and its OWN error.
 *
 * The old copy hard-coded "Learning arcs and meeting summaries may be blank" for every failure, which
 * was false in both directions: it named a feature the leg had never observed, and it named only two
 * when more could be failing. Pure and exported so the sentence is testable without a database.
 */
export function degradedNote(tasks: readonly LlmTaskHealth[]): string {
  const failing = tasks.filter((t) => t.state === "degraded");
  if (failing.length === 0) return "";
  const parts = failing.map((t) => {
    const model = t.model ? ` (${t.model})` : "";
    return `${taskLabel(t.task)}${model}`;
  });
  const names = parts.length === 1 ? parts[0] : `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
  const errs = failing.map((t) => t.lastError).filter((e): e is string => typeof e === "string");
  // The reasoning-starvation hint is PER TASK now: it is the signature of a reasoning model, and only
  // `arcs` requests one, so attaching it to every failure would send an operator to the wrong picker.
  const starved = failing.some((t) => t.lastError && /empty content|finish_reason/i.test(t.lastError));
  // HEALTHY only, not merely "not degraded". An `unstable` task's newest run FAILED, so listing it as
  // still working is an observation claim its own newest observation contradicts.
  const healthy = tasks.filter((t) => t.state === "healthy").map((t) => taskLabel(t.task));
  const unaffected = healthy.length > 0 ? ` Still working: ${healthy.join(", ")}.` : "";
  return (
    `The answering model is failing for ${names} — output is missing there.` +
    (starved
      ? " It returned empty output, the signature of a reasoning model starving its own answer; pick a non-reasoning model in Admin → Active answering model."
      : " Check the model and key in Admin → Active answering model.") +
    unaffected +
    (errs.length > 0 ? ` (${errs[0]})` : "")
  );
}

/**
 * Which task the leg's SINGULAR fields describe — extracted and exported so it is unit-testable.
 *
 * It was inline in `getLlmHealth` and therefore only reachable through Postgres, which is exactly how
 * it shipped wrong and then how its FIX shipped untested: a mutation reinstating the bug survived the
 * whole suite. A behaviour a reviewer had to find deserves a pure seam.
 *
 * NON-HEALTHY tasks only, worst first. A HEALTHY task still carries `lastFailedAt` whenever its window
 * holds a failure that later healed — this install's measured normal (heals 6 times in 10). Selecting
 * on `lastFailedAt !== null` alone therefore let a healed `arcs` blip supply `lastModel`/`lastError`
 * during a `meeting-summary` outage, so the card's detail line named the REASONING model — taken from
 * arcs' SUCCESSFUL newest run — directly above a note naming meeting summaries on the query model.
 * That is the wrong-picker misattribution this slice exists to remove, arriving through the
 * healed-blip path. Both reviewers caught it.
 */
export function pickReportedFailure(tasks: readonly LlmTaskHealth[]): LlmTaskHealth | undefined {
  const severity = (t: LlmTaskHealth): number => (t.state === "degraded" ? 2 : t.state === "unstable" ? 1 : 0);
  return tasks
    .filter((t) => t.state !== "healthy" && t.lastFailedAt !== null)
    .sort((a, b) => severity(b) - severity(a) || Date.parse(b.lastFailedAt!) - Date.parse(a.lastFailedAt!))[0];
}

/**
 * Read the recent runs PER TASK.
 *
 * THE OUTER ORDER-BY CARRIES `id desc` TOO, not just the window. The window picks WHICH rows come
 * back; the outer order decides the sequence `deriveTaskHealth` hands to `foldStreak`, whose contract
 * is newest-first. Without it a same-millisecond fail-then-retry is planner-dependent: `runs[0]` for
 * that task could be the FAIL, so a healed task classifies `unstable`. Both reviewers found it — and
 * the data-mechanics test named "breaks a same-millisecond tie by id" had been passing only because
 * small scans tend to preserve window order, i.e. flaky by construction, which is worse than absent.
 *
 * A per-task window, not the old global `limit 2`: once more than one task records, the two newest
 * rows overall are typically both from the chattiest task, which starves a failing one of the evidence
 * it needs to confirm. `STREAK_SQL` in `lib/ingest/pipeline-health` is the in-repo precedent for the
 * shape, including the `finished_at desc, id desc` tie-break — two runs can share a millisecond (a
 * fast fail then a retry in the same tick) and without the PK tie-break "the latest run" is arbitrary.
 */
const PER_TASK_SQL = `
  with scoped as (
    select id, ok, meta, errors, finished_at,
           coalesce(meta->>'task', '(untagged)') as task,
           row_number() over (
             partition by coalesce(meta->>'task', '(untagged)')
             order by finished_at desc, id desc
           ) as rn
      from ingest_runs
     where source = 'llm' and team_id = $1
  )
  select ok, meta, errors, finished_at, task from scoped where rn <= $2
   -- id desc HERE TOO, not just in the window -- see the note above the constant.
   -- (No backticks in this string: it is a JS template literal. Second time; noted in the fold.)
   order by finished_at desc, id desc`;

export async function getLlmHealth(teamId: string): Promise<LlmHealth> {
  const empty: LlmHealth = {
    state: "unknown",
    tasks: [],
    lastModel: null,
    lastError: null,
    lastOkAt: null,
    lastFailedAt: null,
  };
  try {
    const res = await runSql<{
      ok: boolean;
      meta: unknown;
      errors: unknown;
      finished_at: string | Date;
      task: string;
    }>(PER_TASK_SQL, [teamId, FAILURES_TO_CONFIRM]);
    if (res.rows.length === 0) return empty;

    const runs: LlmRun[] = res.rows.map((r) => {
      const meta = asObject(r.meta);
      const errors = asArray(r.errors);
      return {
        ok: r.ok,
        task: r.task,
        model: typeof meta.model === "string" ? meta.model : null,
        error: r.ok ? null : typeof errors[0] === "string" ? (errors[0] as string) : "the answering model returned an error",
        finishedAt: r.finished_at instanceof Date ? r.finished_at.toISOString() : String(r.finished_at),
      };
    });

    const tasks = deriveTaskHealth(runs, Date.now());
    const state = deriveLlmState(tasks);
    // The singular fields describe the newest FAILING row across tasks — not the leg's newest row,
    // which could be an unrelated success and would name the wrong task's model.
    const newestFailing = pickReportedFailure(tasks);
    const newestOkAt = tasks
      .map((t) => t.lastOkAt)
      .filter((a): a is string => a !== null)
      .sort((a, b) => Date.parse(b) - Date.parse(a))[0];

    return {
      state,
      tasks,
      lastModel: newestFailing?.model ?? runs[0]?.model ?? null,
      lastError: newestFailing?.lastError ?? null,
      lastOkAt: state === "healthy" ? (newestOkAt ?? null) : null,
      lastFailedAt: newestFailing?.lastFailedAt ?? null,
      // An UNCONFIRMED failure keeps `lastError`/`lastFailedAt` — it happened, and the card shows it —
      // but carries NO `note`. `note` drives the red paragraph and the Pulse banner; a blip the next
      // call will very likely clear has not earned either. (Measured: heals on the next run 6/10.)
      ...(state === "degraded" ? { note: degradedNote(tasks) } : {}),
    };
  } catch {
    return empty;
  }
}
