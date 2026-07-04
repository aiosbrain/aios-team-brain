import "server-only";
import { runSlackIngestion, runPlaneIngestion, runLinearIngestion, runGithubIngestion } from "./run";
import { adminClient } from "@/lib/supabase/admin";
import { recordIngestRun } from "./runs";
import { runLinearInbound, type InboundRunSummary } from "@/lib/pm-sync/inbound";

/**
 * On-demand "scrape now" from the query box. `isSyncCommand` recognizes when a chat message is a
 * sync command (not a question) so the query route can pull the connectors instead of asking the
 * LLM; `runManualSync` runs every enabled source for the team and returns a markdown summary that
 * streams back as the brain's "answer". This is the user-facing twin of the admin "Run … now"
 * actions and the 30-min scheduler — same single-writer ingestion underneath.
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
}

type RunCounts = { created: number; updated: number; integrations: number; errors: string[] } | null;

/** Run every enabled source for the team and summarize. One source failing never fails the others. */
export async function runManualSync(teamId: string): Promise<ManualSyncResult> {
  const safe = async (p: Promise<RunCounts>): Promise<RunCounts> => {
    try {
      return await p;
    } catch {
      return null;
    }
  };
  const startedAt = Date.now();
  const [slack, plane, linear, github] = await Promise.all([
    safe(runSlackIngestion({ teamId })),
    safe(runPlaneIngestion({ teamId })),
    safe(runLinearIngestion({ teamId })),
    safe(runGithubIngestion({ teamId })),
  ]);

  // Inbound Linear→brain apply/adopt (brain-api v1.4): runs AFTER the Linear ingest leg above has
  // resolved (never in parallel with it) so adopt sees freshly-imported mirror tasks. Per-team
  // opt-in — a team without inboundApply gets a quiet no-op.
  let inbound: InboundRunSummary | null = null;
  if (linear?.integrations) {
    try {
      inbound = await runLinearInbound({ teamId });
      if (inbound.skipped || !inbound.teams) inbound = null;
    } catch {
      inbound = null;
    }
  }

  // Record each configured source's run so a manual /sync failure is diagnosable in the runs log.
  const runsDb = adminClient();
  for (const [source, s] of [["slack", slack], ["plane", plane], ["linear", linear], ["github", github]] as const) {
    if (!s || (!s.integrations && !s.errors.length)) continue; // unconfigured + clean → nothing to log
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

  const lines: string[] = [];
  let created = 0;
  let updated = 0;
  let errors = 0;

  const add = (label: string, s: RunCounts) => {
    if (!s || !s.integrations) return; // source not configured for this team — omit
    created += s.created;
    updated += s.updated;
    errors += s.errors.length;
    const errNote = s.errors.length ? ` — ${s.errors.length} error${s.errors.length > 1 ? "s" : ""}` : "";
    lines.push(`- **${label}**: +${s.created} new, ~${s.updated} updated${errNote}`);
  };
  add("Slack", slack);
  add("Plane", plane);
  add("Linear", linear);
  add("GitHub", github);

  if (inbound && (inbound.applied || inbound.adopted || inbound.conflicts)) {
    errors += inbound.errors.length;
    const conflictNote = inbound.conflicts
      ? ` — ${inbound.conflicts} conflict${inbound.conflicts > 1 ? "s" : ""} (see Admin → PM sync)`
      : "";
    lines.push(`- **Linear inbound**: ${inbound.applied} applied, ${inbound.adopted} adopted${conflictNote}`);
  }

  let summary: string;
  if (!lines.length) {
    summary =
      "No connectors are configured for this team yet, so there was nothing to scrape. " +
      "An admin can add **Slack / Plane / Linear / GitHub** under **Admin → Integrations**.";
  } else {
    const head =
      created || updated
        ? "**Scrape complete** — pulled the latest from your connectors:"
        : "**Scrape complete** — everything was already up to date:";
    summary = `${head}\n\n${lines.join("\n")}`;
  }

  return { summary, created, updated, errors };
}
