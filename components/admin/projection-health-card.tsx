import { relativeAge } from "@/lib/ingest/runs-format";
import type { ProjectionHealth } from "@/lib/pm-sync/runs";

/**
 * Admin → PM sync "last projection run" card (AIO-357). Surfaces when the brain→PM projection
 * engine last ran and whether it worked — the diagnosability gap the issue was filed for ("a task
 * edit that doesn't appear in Linear is undiagnosable"). Projection is reactive (fires on task
 * push / UI edits, plus the manual "Project board now" button), so this is "last time projection
 * code ran", not a scheduled-tick SLA — see lib/pm-sync/runs.ts.
 */

const DOT: Record<ProjectionHealth["status"], string> = {
  ok: "bg-emerald-500",
  stale: "bg-amber-500",
  failed: "bg-red-500",
  never_run: "bg-ink-tertiary/40",
};

const LABEL: Record<ProjectionHealth["status"], string> = {
  ok: "ok",
  stale: "stale",
  failed: "failed",
  never_run: "never run",
};

export function ProjectionHealthCard({ health }: { health: ProjectionHealth }) {
  const run = health.lastRun;
  const provider = (run?.meta as { provider?: string } | undefined)?.provider;
  const items = run ? `+${run.created} synced, ${run.unchanged} unchanged${run.error_count ? `, ${run.error_count} failed` : ""}` : null;

  return (
    <div className="prism-card flex flex-col gap-1 p-4" data-projection-health={health.status}>
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold text-ink">Last projection run</h2>
        <span className="text-xs text-ink-tertiary">brain → PM tool</span>
      </div>
      <div className="flex items-center gap-2.5 py-1.5">
        <span className={`size-2 shrink-0 rounded-full ${DOT[health.status]}`} />
        <span
          className={`text-sm font-medium ${
            health.status === "failed" ? "text-red-600" : health.status === "stale" ? "text-amber-600" : "text-ink"
          }`}
        >
          {LABEL[health.status]}
        </span>
        {run ? (
          <span className="text-xs text-ink-secondary" title={run.finished_at}>
            · {relativeAge(new Date(run.finished_at).getTime())}
            {provider ? ` · ${provider}` : ""}
            {items ? ` · ${items}` : ""} · {run.trigger}
          </span>
        ) : null}
      </div>
      {health.status === "never_run" ? (
        <p className="mt-1 text-xs text-ink-secondary">
          No projection run has been recorded yet. Push a task edit or use{" "}
          <span className="font-medium text-ink">Project board now</span> below to run one.
        </p>
      ) : null}
      {health.status === "stale" ? (
        <p className="mt-2 rounded-lg border border-amber-400/25 bg-amber-400/10 px-3 py-2 text-xs text-amber-600 dark:text-amber-300">
          No successful projection run in over 24h. If tasks have changed since, they likely
          haven&apos;t reached the PM tool yet — check for a misconfigured integration or run{" "}
          <span className="font-medium">Project board now</span>.
        </p>
      ) : null}
      {health.status === "failed" && run?.errors.length ? (
        <p className="mt-2 rounded-lg border border-red-400/30 bg-red-400/10 px-3 py-2 text-xs text-red-600 dark:text-red-300">
          {run.errors[0]}
        </p>
      ) : null}
      {/*
        ADOPTUNIQ-1 — the DB backstop's state, surfaced HERE because this is the page an operator
        already opens when PM sync misbehaves. It is deliberately rendered on the same card rather
        than exported and left unwired: the signal this replaces (a `last_error` stamp) died partly
        because nothing displayed it. Silent only when the backstop is installed — a healthy schema
        should not cost a line of UI.
      */}
      {health.backstop !== "installed" ? (
        <p
          className="mt-2 rounded-lg border border-amber-400/25 bg-amber-400/10 px-3 py-2 text-xs text-amber-600 dark:text-amber-300"
          data-backstop={health.backstop}
        >
          {health.backstop === "missing"
            ? "The one-issue-one-row database backstop is NOT installed. The most likely cause is duplicate provider_resource_id rows, which the migration deliberately skips rather than aborting the release — that skip does not repair itself. Two links can currently claim the same issue."
            : health.backstop === "malformed"
              ? "An index named task_pm_links_provider_resource_uq exists but does not match the expected definition (columns, order, predicate, uniqueness or validity), so it is not enforcing the invariant."
              : "Could not read the database catalog to confirm the one-issue-one-row backstop. Treating it as unverified rather than healthy."}
        </p>
      ) : null}
    </div>
  );
}
