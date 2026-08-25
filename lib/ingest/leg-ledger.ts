/**
 * The declared universe of `ingest_runs.source` values — every leg the pipeline can write
 * (BANNERFLAP-2, `docs/design/staleness-threshold-fit.md`).
 *
 * WHY IT IS A DECLARED LIST AND NOT DERIVED. A leg's staleness threshold lives in
 * `STALE_MS_BY_SOURCE` (`lib/ingest/pipeline-health`), and anything ABSENT from that map silently
 * inherits the 3h default. That default has now been wrong six times, and each time the leg was
 * discovered by a human noticing a red banner on a healthy job. A declared ledger turns "did anyone
 * think about this leg?" into a diff: `test/guards/ingest-leg-ledger.test.ts` SCANS the actual
 * `recordIngestRun` call sites and fails the build when a source is written that is not listed here,
 * so a new leg cannot reach production without someone answering the threshold question.
 *
 * CONSUMERS TODAY are the two guards (the scan above, and `test/pipeline-health-staleness.test.ts`,
 * which walks this list asserting no leg silently sits on the default). Stated plainly rather than
 * implied: this module exists to be checked against, not to be read at runtime.
 *
 * Keep it alphabetical. Adding a row here is the CHEAP half — the guard will not tell you what the
 * threshold should be, only that you owe an answer.
 */

/** Sources written by a real `recordIngestRun` call site. */
export const INGEST_LEG_SOURCES: readonly string[] = [
  "access_bootstrap",
  "access_bootstrap_all",
  "arcs",
  "auth_cleanup",

  "context_backfill",
  "context_backfill_all",
  "dense",
  "doc_task_infer",
  "github",
  "graph_health",
  "graph_project",
  "linear",
  "linear_inbound",
  "llm",
  "meeting_notes",
  "plane",
  "pm_sync",
  "pret3_sweep",
  "pret4_materialize",
  "scan",
  "slack",
];

/**
 * Sources the SCAN cannot see, with the reason each is legitimately invisible to it. Anything else
 * missing from the scan means the ledger has drifted from the code, which the guard also fails on.
 */
export const UNSCANNABLE_LEG_SOURCES: Readonly<Record<string, string>> = {
  // `runImport(db, label, …)` passes the connector type through a parameter, so the literal never
  // appears at the `recordIngestRun` call site. Same four types the `integrations` table uses.
  slack: "written via runImport's `label` parameter (lib/ingest/scheduler)",
  plane: "written via runImport's `label` parameter (lib/ingest/scheduler)",
  linear: "written via runImport's `label` parameter (lib/ingest/scheduler)",
  github: "written via runImport's `label` parameter (lib/ingest/scheduler)",
};

/**
 * Call sites that build the whole `recordIngestRun` argument elsewhere, so the scan can see no
 * `source:` at them — with what each actually writes and why that is acceptable (AUDITFIX-24).
 *
 * These used to be skipped SILENTLY, which is worse than the unresolved-source case the guard
 * already accounted for: `lib/graph/scheduler.ts` is `graph_project`'s SUCCESS-path scheduler write,
 * so its instance-wide partition was confirmed only by the catch-path site sitting next to it —
 * a coincidence, not a check. Keyed by file, because the point is the site, not the source.
 */
export const WRAPPER_RUN_SITES: Readonly<Record<string, string>> = {
  "lib/graph/scheduler.ts":
    "graph_project via projectionRunInput(s, 'scheduler', …) — instance-wide (no teamId argument)",
  "lib/ingest/manual-sync.ts":
    "the four connectors, source bound by the loop variable; trigger 'manual', so never a beat",
  "lib/meetings/schedule-backfill.ts":
    "meeting_notes via buildPushBackfillRunner's `record` hook — trigger 'api' (the on-push path)",
  "app/t/[team]/admin/integrations/actions.ts":
    "graph_project via projectionRunInput(…, 'manual', …) — an operator action, never a beat",
  "scripts/graph-window-battery/run-projection.ts":
    "graph_project via projectionRunInput(…, 'manual', …) — a battery script, not a deployed writer",
};

/**
 * The synthetic leg `getPipelineHealth` appends from a Neo4j/ledger probe. NOT in the ledger above
 * because nothing writes it to `ingest_runs`; it carries `stale: false` hardcoded and therefore never
 * reaches `staleThresholdMs`. If it ever starts recording real rows it must move into the ledger, or
 * it silently inherits the 3h default.
 */
export const SYNTHETIC_LEGS: readonly string[] = ["graph_extract"];

/**
 * WHICH PARTITION OF `ingest_runs` HOLDS A LEG'S POLLER HEARTBEAT — AUDITFIX-24.
 *
 * `getPipelineHealth`'s staleness clock used to read `distinct on (source)` across
 * `team_id = $1 or team_id is null`, i.e. whichever partition happened to be newer. That is how a
 * team with no scheduler row of its OWN came to be aged against an instance-wide row that says
 * nothing about it — and once AUDITFIX-22 stopped refreshing the instance-wide `access_bootstrap`
 * row on ordinary ticks (measured on prod: 51 rows/day → 0/day across the deploy), that row froze,
 * so every team created afterwards read STALE while perfectly healthy.
 *
 * The clock now comes from the partition the leg's POLLER writes, declared here:
 *
 *   `team`   — the scheduler writes one row per team. A team with none resolves NO clock and is not
 *              aged, which is the exemption `pipeline-health` already states in prose.
 *   `global` — the scheduler writes one instance-wide row. Every team reads it.
 *   `none`   — NO TRUSTWORTHY POLLER CLOCK. Not "never writes a scheduler row": `scan` takes its
 *              trigger from a client header (`app/api/v1/codebases/route.ts`) and `pm_sync` takes it
 *              as a caller parameter (`lib/pm-sync/runs.ts`), so a `scheduler` row is expressible in
 *              both. `none` is what stops a spoofed or incidental row becoming anyone's heartbeat.
 *              A `none` source may not carry a finite `STALE_MS_BY_SOURCE` threshold — a finite bar
 *              on a leg that can never resolve a clock is silence by construction.
 *
 * WHY DECLARED AND NOT DERIVED: a source with zero rows tells you nothing, and one stray row would
 * flip a derived answer. Declared beside the threshold question because it is the same question
 * shape with the same failure mode when nobody answers it — and, unlike the threshold, it is
 * CROSS-CHECKED against the writers by `test/guards/ingest-leg-ledger.test.ts`, which requires EVERY
 * attributable `trigger:'scheduler'` call site to use the declared partition. That universal form is
 * not pedantry: two review rounds let an existential "≥1 correct site" through, and `meeting_notes`
 * has two scheduler sites, so flipping one would have left the guard green.
 */
export type BeatScope = "team" | "global" | "none";

export const BEAT_SCOPE_BY_SOURCE: Readonly<Record<string, BeatScope>> = {
  // Per-team rows every tick (AUDITFIX-22). It ALSO writes instance-wide rows, but only on a
  // fleet-level failure / zero teams / a throw — those carry the VERDICT, never the beat, which is
  // why this is `team` and why the guard grants this source its one documented exception.
  access_bootstrap: "team",
  // The fleet-liveness heartbeat, unconditional every tick (AUDITFIX-24). Mirrors
  // `context_backfill_all`: a DISTINCT source, so restoring the instance-wide beat cannot re-create
  // the masking AUDITFIX-22 removed.
  access_bootstrap_all: "global",
  arcs: "none", // view-triggered SWR, deliberately `trigger:'api'`
  auth_cleanup: "global",
  context_backfill: "team",
  context_backfill_all: "global",
  dense: "global",
  doc_task_infer: "team",
  github: "global",
  graph_health: "global",
  graph_project: "global",
  linear: "global",
  linear_inbound: "global",
  llm: "none", // `trigger:'api'`, and NOT_PIPELINE_LEGS besides
  meeting_notes: "team",
  plane: "global",
  pm_sync: "none", // trigger is a caller parameter; no poller writes it today
  pret3_sweep: "global",
  pret4_materialize: "global",
  scan: "none", // trigger comes from a client header — spoofable, so never a heartbeat
  slack: "global",
};

/**
 * The declared beat scope, defaulting to `global` for a source the ledger does not name.
 *
 * THE DEFAULT IS DEFENSE-IN-DEPTH, NOT A GUARANTEE, and the first version of this comment claimed
 * otherwise. The scan cannot see every writer — a connector added as `runImport(db, "notion", …)`
 * introduces a source with no new `recordIngestRun` call site at all — so "undeclared" cannot be
 * proven to mean "retired". There is also no safe default in principle: `global` silences an
 * undeclared team poller and `team` would silence an undeclared global one. `global` is chosen
 * because every source that actually reaches it today is instance-wide (`auto_flip`, retired by
 * PRET-6, whose 51 production rows are all `team_id is null`).
 */
export function beatScopeOf(source: string): BeatScope {
  return BEAT_SCOPE_BY_SOURCE[source] ?? "global";
}
