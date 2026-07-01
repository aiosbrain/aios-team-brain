import "server-only";
import { runSlackIngestion, runPlaneIngestion, runLinearIngestion, runGithubIngestion } from "./run";
import type { ImportSummary, IngestSummary } from "./run";
import { adminClient } from "@/lib/supabase/admin";
import { recordIngestRun } from "./runs";

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
    await runImport(supabase, "github", runGithubIngestion);
  };

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
