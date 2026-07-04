import "server-only";
import { runSlackIngestion, runPlaneIngestion, runLinearIngestion, runGithubIngestion } from "./run";
import type { ImportSummary, IngestSummary } from "./run";
import { adminClient } from "@/lib/supabase/admin";
import { recordIngestRun } from "./runs";
import { runLinearInbound } from "@/lib/pm-sync/inbound";

/**
 * In-process poller — the single-service alternative to a separate cron worker.
 * Started once from instrumentation.register() on server boot (Node runtime only).
 * Config-driven: each tick syncs whatever Slack integrations are enabled (tokens
 * come from the dashboard-stored encrypted secret or SLACK_BOT_TOKEN). A deploy
 * with nothing configured polls cheaply and logs nothing. Opt out with
 * INGEST_POLL_ENABLED=false.
 */

let started = false;

export function startIngestScheduler(): void {
  if (started) return;
  started = true;

  const minutes = Number(process.env.INGEST_POLL_MINUTES ?? 30);
  const intervalMs = Math.max(1, minutes) * 60_000;

  const tick = async () => {
    const supabase = adminClient();
    await runImport(supabase, "slack", runSlackIngestion);
    await runImport(supabase, "plane", runPlaneIngestion);
    await runImport(supabase, "linear", runLinearIngestion);
    // Inbound Linear→brain apply/adopt (brain-api v1.4) — sequenced AFTER the Linear ingest so
    // adopt sees freshly-imported mirror tasks. Per-team opt-in; quiet no-op otherwise.
    await runInbound(supabase);
    await runImport(supabase, "github", runGithubIngestion);
    // Incremental dense (semantic) indexing of newly-synced items. No-op unless dense retrieval is
    // configured (EMBEDDINGS_URL + pgvector schema); best-effort — never fails the tick.
    try {
      const { indexPendingItems } = await import("@/lib/query/dense-index");
      const d = await indexPendingItems();
      if (d.indexed) console.info(`[ingest] dense: embedded ${d.indexed} items (${d.chunks} chunks)`);
    } catch (err) {
      console.error("[ingest] dense index tick failed:", err instanceof Error ? err.message : err);
    }
  };

  // Inbound PM-sync step (brain-api v1.4): apply Linear board edits to brain tasks + adopt
  // Linear-native issues, for opted-in teams. Records to ingest_runs like the importers; a
  // quiet pass (nothing enabled / nothing changed / no conflicts) logs nothing.
  async function runInbound(supabase: ReturnType<typeof adminClient>): Promise<void> {
    const startedAt = Date.now();
    try {
      const s = await runLinearInbound();
      if (s.skipped) return; // another run in-flight
      const active = s.applied || s.adopted || s.conflicts || s.errors.length || s.skippedReasons.length;
      if (!s.teams || !active) return;
      console.info(
        `[ingest] linear-inbound: applied ${s.applied}, adopted ${s.adopted}, conflicts ${s.conflicts} (${s.teams} teams)` +
          (s.errors.length ? ` errors: ${s.errors.join("; ")}` : "")
      );
      await recordIngestRun(supabase, {
        source: "linear_inbound",
        trigger: "scheduler",
        ok: s.ok,
        created: s.adopted,
        updated: s.applied,
        unchanged: s.noops,
        errors: s.errors,
        meta: { teams: s.teams, conflicts: s.conflicts, skipped: s.skippedReasons },
        startedAt,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[ingest] linear-inbound tick failed:`, msg);
      await recordIngestRun(supabase, { source: "linear_inbound", trigger: "scheduler", ok: false, errors: [msg], startedAt });
    }
  }

  // Shared runner: run one source, log a line, and record the outcome to ingest_runs so a failure
  // (or a silent staleness) is diagnosable later instead of only living in container logs.
  async function runImport(
    supabase: ReturnType<typeof adminClient>,
    label: string,
    run: () => Promise<ImportSummary | IngestSummary>
  ): Promise<void> {
    const startedAt = Date.now();
    try {
      const s = await run();
      if (s.skipped) return; // another run in-flight — it will record its own outcome
      // Source-specific extras: slack reports channels; the task importers report items/projects.
      const meta: Record<string, unknown> =
        "channels" in s
          ? { integrations: s.integrations, channels: s.channels }
          : { integrations: s.integrations, items: s.items, projects: s.projects };
      if (s.created || s.updated || s.errors.length) {
        const detail = "channels" in s ? `${s.channels} channels` : `${s.items} items, ${s.projects} projects`;
        console.info(
          `[ingest] ${label}: +${s.created} ~${s.updated} =${s.unchanged} (${detail}, ${s.integrations} integrations)` +
            (s.errors.length ? ` errors: ${s.errors.join("; ")}` : "")
        );
      }
      // Skip logging unconfigured sources with nothing to report (avoids a no-op row every tick);
      // still record configured sources (proves the poller ran) and anything with errors.
      if (s.integrations === 0 && s.errors.length === 0) return;
      await recordIngestRun(supabase, {
        source: label,
        trigger: "scheduler",
        ok: s.ok,
        created: s.created,
        updated: s.updated,
        unchanged: s.unchanged,
        errors: s.errors,
        meta,
        startedAt,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[ingest] ${label} tick failed:`, msg);
      await recordIngestRun(supabase, { source: label, trigger: "scheduler", ok: false, errors: [msg], startedAt });
    }
  }

  // Delay the first run so boot isn't blocked; then poll on the interval.
  setTimeout(tick, 20_000).unref?.();
  setInterval(tick, intervalMs).unref?.();
  console.info(`[ingest] scheduler started — Slack + Plane + Linear + GitHub every ${minutes}m`);
}
