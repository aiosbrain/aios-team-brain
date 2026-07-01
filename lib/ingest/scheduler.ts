import "server-only";
import { runSlackIngestion, runPlaneIngestion, runLinearIngestion, runGithubIngestion } from "./run";
import type { ImportSummary } from "./run";

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
    try {
      const s = await runSlackIngestion();
      if (s.created || s.updated || s.errors.length) {
        console.info(
          `[ingest] slack: +${s.created} ~${s.updated} =${s.unchanged} ` +
            `(${s.channels} channels, ${s.integrations} integrations)` +
            (s.errors.length ? ` errors: ${s.errors.join("; ")}` : "")
        );
      }
    } catch (err) {
      console.error("[ingest] slack tick failed:", err instanceof Error ? err.message : err);
    }
    await runImport("plane", runPlaneIngestion);
    await runImport("linear", runLinearIngestion);
    await runImport("github", runGithubIngestion);
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

  // Shared runner for the task-importers (Plane/Linear/GitHub): same summary shape + log line.
  async function runImport(label: string, run: () => Promise<ImportSummary>): Promise<void> {
    try {
      const s = await run();
      if (s.created || s.updated || s.errors.length) {
        console.info(
          `[ingest] ${label}: +${s.created} ~${s.updated} =${s.unchanged} ` +
            `(${s.items} items, ${s.projects} projects, ${s.integrations} integrations)` +
            (s.errors.length ? ` errors: ${s.errors.join("; ")}` : "")
        );
      }
    } catch (err) {
      console.error(`[ingest] ${label} tick failed:`, err instanceof Error ? err.message : err);
    }
  }

  // Delay the first run so boot isn't blocked; then poll on the interval.
  setTimeout(tick, 20_000).unref?.();
  setInterval(tick, intervalMs).unref?.();
  console.info(`[ingest] scheduler started — Slack + Plane + Linear + GitHub every ${minutes}m`);
}
