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
 * The synthetic leg `getPipelineHealth` appends from a Neo4j/ledger probe. NOT in the ledger above
 * because nothing writes it to `ingest_runs`; it carries `stale: false` hardcoded and therefore never
 * reaches `staleThresholdMs`. If it ever starts recording real rows it must move into the ledger, or
 * it silently inherits the 3h default.
 */
export const SYNTHETIC_LEGS: readonly string[] = ["graph_extract"];
