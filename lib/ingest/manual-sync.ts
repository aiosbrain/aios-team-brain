import "server-only";
import { runSlackIngestion, runPlaneIngestion, runLinearIngestion, runGithubIngestion } from "./run";
import { adminClient } from "@/lib/db/admin";
import { recordIngestRun } from "./runs";
import { runManualContextPass } from "@/lib/ingest/manual-context";
import { manualIngestionVerdict } from "@/lib/staging/ingest-policy";
import { runLinearInbound, type InboundRunSummary } from "@/lib/pm-sync/inbound";

/**
 * On-demand "scrape now" from the query box. `isSyncCommand` recognizes when a chat message is a
 * sync command (not a question) so the query route can pull the connectors instead of asking the
 * LLM; `runManualSync` runs every enabled source for the team and returns a markdown summary that
 * streams back as the brain's "answer". This is the user-facing twin of the admin "Run … now"
 * actions and the 30-min scheduler — same single-writer ingestion underneath.
 *
 * Since AUDITFIX-14 it also awaits ONE bounded project-context pass (`./manual-context`) after the
 * connector legs and the optional Linear inbound stage settle, so a small manual import is readable
 * without waiting for a tick that may never come. The summary reports BOTH halves honestly: a
 * pending or failed context pass is one issue, and the headline stops claiming "Scrape complete".
 */

// Whole-message commands only (so a real question like "what got synced from Slack?" never triggers).
const EXACT = new Set([
  "sync", "scrape", "refresh", "resync", "rescrape", "reindex",
  "sync now", "scrape now", "refresh now", "resync now", "scrape it", "sync it",
  "sync data", "scrape data", "refresh data", "sync the data", "scrape the data", "refresh the data",
  "pull latest", "pull now", "pull data", "update data", "fetch latest",
  "sync everything", "scrape everything", "refresh everything",
]);

/** True when the message is a scrape/sync command rather than a question for the brain. */
export function isSyncCommand(question: string): boolean {
  const q = question.trim().toLowerCase().replace(/[!.?\s]+$/g, "");
  if (!q) return false;
  if (q.startsWith("/sync") || q.startsWith("/scrape") || q.startsWith("/refresh")) return true;
  return EXACT.has(q);
}

export interface ManualSyncResult {
  summary: string; // markdown — streamed back as the brain's answer
  created: number;
  updated: number;
  errors: number;
  /**
   * The deployment refused the operation before it began (AC-07 copied staging). NOT an error and
   * NOT a completed scrape: zero counts here mean "nothing ran", never "nothing to do".
   */
  refused?: boolean;
}

type RunCounts = {
  created: number;
  updated: number;
  integrations: number;
  errors: string[];
  /** Process single-flight refused this import — NOT "already up to date". */
  skipped?: boolean;
};

/** What one connector leg did — including the case where it THREW after committing items. */
type Leg = {
  label: string;
  source: "slack" | "plane" | "linear" | "github";
  /** null ⟺ the leg threw; `thrown` then carries the diagnostic. */
  counts: RunCounts | null;
  thrown: string | null;
};

/** Run every enabled source for the team and summarize. One source failing never fails the others. */
export async function runManualSync(teamId: string): Promise<ManualSyncResult> {
  // AC-07: on a copied staging deployment the WHOLE operation is disabled — no connector leg, no
  // Linear inbound stage, no context pass, no ledger row. Deliberately the first statement: letting
  // the legs run and refuse would hand the AUDITFIX-14 context stage the very trigger it is designed
  // to act on (a failed import is not evidence that nothing was written), and a disabled deployment
  // would then do reconciliation work it was told not to do. This also covers `scripts/connectors.ts`,
  // which calls straight in here with no route or action above it.
  const gate = await manualIngestionVerdict();
  if (!gate.allowed) {
    return { summary: `**Scrape unavailable** — ${gate.message}`, created: 0, updated: 0, errors: 0, refused: true };
  }
  const attempt = async (label: string, source: Leg["source"], p: Promise<RunCounts>): Promise<Leg> => {
    try {
      return { label, source, counts: await p, thrown: null };
    } catch (e) {
      // AUDITFIX-14: a throw is neither "unconfigured" nor proof that nothing was written. The old
      // `safe()` collapsed it to null, and the summary then OMITTED the source — so a failed import
      // could read as a clean run next to a successful context line.
      return { label, source, counts: null, thrown: e instanceof Error ? e.message : "the import threw" };
    }
  };
  const startedAt = Date.now();
  const legs = await Promise.all([
    attempt("Slack", "slack", runSlackIngestion({ teamId })),
    attempt("Plane", "plane", runPlaneIngestion({ teamId })),
    attempt("Linear", "linear", runLinearIngestion({ teamId })),
    // TICKFIT-1 D2f: a manual "sync now" promises a REAL pass — bypass the watermark.
    attempt("GitHub", "github", runGithubIngestion({ teamId, force: true })),
  ]);
  const linear = legs.find((l) => l.source === "linear")?.counts ?? null;

  // Inbound Linear→brain apply/adopt (brain-api v1.4): runs AFTER the Linear ingest leg above has
  // resolved (never in parallel with it) so adopt sees freshly-imported mirror tasks. Per-team
  // opt-in — a team without inboundApply gets a quiet no-op.
  let inbound: InboundRunSummary | null = null;
  let inboundError: string | null = null;
  if (linear?.integrations) {
    try {
      inbound = await runLinearInbound({ teamId });
      if (inbound.skipped || !inbound.teams) inbound = null;
    } catch (e) {
      inbound = null;
      inboundError = e instanceof Error ? e.message : "the inbound stage threw";
    }
  }

  // Record each configured source's run so a manual /sync failure is diagnosable in the runs log.
  const runsDb = adminClient();
  for (const leg of legs) {
    const s = leg.counts;
    if (!s || (!s.integrations && !s.errors.length)) continue; // unconfigured + clean → nothing to log
    const source = leg.source;
    await recordIngestRun(runsDb, {
      teamId,
      source,
      trigger: "manual",
      ok: s.errors.length === 0,
      created: s.created,
      updated: s.updated,
      errors: s.errors,
      meta: { integrations: s.integrations },
      startedAt,
    });
  }

  if (inbound && (inbound.applied || inbound.adopted || inbound.conflicts || inbound.errors.length)) {
    await recordIngestRun(runsDb, {
      teamId,
      source: "linear_inbound",
      trigger: "manual",
      ok: inbound.ok,
      created: inbound.adopted,
      updated: inbound.applied,
      unchanged: inbound.noops,
      errors: inbound.errors,
      meta: { conflicts: inbound.conflicts, skipped: inbound.skippedReasons },
      startedAt,
    });
  }

  // AUDITFIX-14: ONE bounded project-context pass, AFTER every leg and the optional inbound stage
  // have settled. Deliberately NOT gated on a leg succeeding or reporting a nonzero count — a
  // committed partial import and an older candidate backlog are both invisible in the returned
  // counts, and with the poller disabled nothing else will partition them.
  const context = await runManualContextPass(teamId, "manual_sync");

  const lines: string[] = [];
  let created = 0;
  let updated = 0;
  let errors = 0;
  /** A leg the single-flight refused: not a failure, but not a completed scrape either. */
  let busy = false;

  for (const leg of legs) {
    const s = leg.counts;
    if (!s) {
      errors += 1;
      lines.push(`- **${leg.label}**: import failed — ${leg.thrown ?? "the import threw"}`);
      continue;
    }
    if (s.skipped) {
      busy = true;
      lines.push(`- **${leg.label}**: skipped — another sync is already running; try again in a moment.`);
      continue;
    }
    if (!s.integrations && !s.errors.length) continue; // source not configured for this team — omit
    created += s.created;
    updated += s.updated;
    errors += s.errors.length;
    const errText = s.errors.join("; ");
    if (!s.integrations) {
      // An error-only result with ZERO integrations keeps its label and its text. Omitting it left
      // the "no connectors are configured" line below to describe a FAILED import as an empty team.
      lines.push(`- **${leg.label}**: import failed — ${errText}`);
      continue;
    }
    const errNote = s.errors.length
      ? ` — ${s.errors.length} error${s.errors.length > 1 ? "s" : ""}: ${errText}`
      : "";
    lines.push(`- **${leg.label}**: +${s.created} new, ~${s.updated} updated${errNote}`);
  }

  if (inboundError) {
    errors += 1;
    lines.push(`- **Linear inbound**: failed — ${inboundError}`);
  } else if (inbound && (inbound.applied || inbound.adopted || inbound.conflicts)) {
    errors += inbound.errors.length;
    const conflictNote = inbound.conflicts
      ? ` — ${inbound.conflicts} conflict${inbound.conflicts > 1 ? "s" : ""} (see Admin → PM sync)`
      : "";
    lines.push(`- **Linear inbound**: ${inbound.applied} applied, ${inbound.adopted} adopted${conflictNote}`);
  }

  // Reconciliation counts are NOT imported items, so they never touch created/updated. An incomplete
  // or failed context pass IS one issue: some imported content may not be readable yet.
  if (context.status !== "complete") errors += 1;
  const contextLine = `- **Project context**: ${context.message}`;

  let summary: string;
  if (!lines.length) {
    summary =
      "No connectors are configured for this team yet, so there was nothing to scrape. " +
      "An admin can add **Slack / Plane / Linear / GitHub** under **Admin → Integrations**." +
      `\n\n${contextLine}`;
  } else {
    const head =
      errors || busy
        ? "**Scrape finished with issues** — some work did not complete:"
        : created || updated
          ? "**Scrape complete** — pulled the latest from your connectors:"
          : "**Scrape complete** — everything was already up to date:";
    summary = `${head}\n\n${[...lines, contextLine].join("\n")}`;
  }

  return { summary, created, updated, errors };
}
