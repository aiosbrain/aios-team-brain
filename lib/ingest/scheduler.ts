import "server-only";
import { runSlackIngestion, runPlaneIngestion, runLinearIngestion, runGithubIngestion } from "./run";
import type { ImportSummary, IngestSummary } from "./run";
import { adminClient } from "@/lib/db/admin";
import { recordIngestRun } from "./runs";
import { runLinearInbound } from "@/lib/pm-sync/inbound";
import { singleFlight } from "./single-flight";

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
    const db = adminClient();
    await runImport(db, "slack", runSlackIngestion);
    await runImport(db, "plane", runPlaneIngestion);
    await runImport(db, "linear", runLinearIngestion);
    // Inbound Linear→brain apply/adopt (brain-api v1.4) — sequenced AFTER the Linear ingest so
    // adopt sees freshly-imported mirror tasks. Per-team opt-in; quiet no-op otherwise.
    await runInbound(db);
    await runImport(db, "github", runGithubIngestion);
    await runAuthCleanup(db);
    // §11 access-bootstrap convergence: built-in groups/system projects/grants for every team.
    // Idempotent and cheap when converged; this is also how PRE-EXISTING teams get bootstrapped
    // on first deploy (SQL migrations cannot seed the edge tables — the single-writer guard
    // forbids it by design, so app code is the only legal seeder). Best-effort, traced.
    await runAccessBootstrap(db);
    // §11 context backfill convergence: partition every item into its unit + system-project
    // membership. The one-time migration for pre-existing content AND the backstop for any
    // item the on-push ingest hook missed (non-push ingest paths, a hook failure). Idempotent
    // and cheap when converged; sequenced AFTER bootstrap so the system projects exist. Traced.
    await runContextBackfill(db);
    // PRET-3 one-time post-activation sweep (rollout-race fix): marker-guarded, no-op forever
    // after its first successful run on the fleet.
    {
      const { runPret3BootSweep } = await import("@/lib/graph/pret3-boot-sweep");
      const s = await runPret3BootSweep(db);
      if (s.ran) console.info("[ingest] pret3 post-activation sweep ran (external-row wipe + correction re-key catch-up)");
      if (s.error) {
        console.error("[ingest] pret3 post-activation sweep FAILED:", s.error);
        await recordIngestRun(db, { teamId: null, source: "pret3_sweep", trigger: "scheduler", ok: false, errors: [s.error], startedAt: Date.now() }).catch(() => {});
      } else if (s.ran) {
        // Exactly one success row, ever — and it is what lets a CONFIRMED failure streak clear.
        // Without it: two failed marker-insert ticks reach `confirmed` and go loud, a later success
        // writes nothing, and the consumed marker forecloses every future row — so the loud banner
        // latches red permanently on every team, which no staleness threshold can undo (`failing`
        // includes `confirmed` regardless of age). `else if` because a post-marker failure sets BOTH
        // `ran` and `error`, and that tick must record the failure, not a success.
        await recordIngestRun(db, { teamId: null, source: "pret3_sweep", trigger: "scheduler", ok: true, startedAt: Date.now() }).catch(() => {});
      }
    }
    // PRET-4 one-time builtin materialization — the RETRY slot for the boot-time run
    // (instrumentation.register). Marker-guarded no-op after first fleet success; sequenced
    // early in the tick so a fresh fleet materializes before anything assesses posture.
    {
      const startedAt = Date.now();
      const { materializeBuiltinMembershipOnce } = await import("@/lib/access/groups");
      const m = await materializeBuiltinMembershipOnce(db).catch((err: unknown) => ({
        ok: false as const,
        error: err instanceof Error ? err.message : String(err),
      }));
      if (m.ok && (m as { ran?: boolean }).ran) console.info("[ingest] pret4 builtin materialization ran (explicit posture state live)");
      if (!m.ok) {
        console.error("[ingest] pret4 builtin materialization FAILED:", m.error);
        await recordIngestRun(db, { teamId: null, source: "pret4_materialize", trigger: "scheduler", ok: false, errors: [m.error ?? "unknown"], startedAt }).catch(() => {});
      }
    }
    // Turn freshly-synced meeting transcripts (source granola/zoom/… — never slack) into meeting
    // notes, so CLI-pushed meetings show up on the Meetings page automatically. Idempotent + cheap
    // when nothing new (finds 0 candidates → returns); best-effort, never fails the tick.
    await runMeetingNotesBackfill(db);
    // Recompute the persisted task↔evidence links (which items are the work behind each task) so
    // surfaces beyond the timeline (Query/CLI) can read them. Best-effort, per team; cheap when quiet.
    await runTaskEvidenceLinking(db);
    // Then the LOWER-confidence half: ask the model which UNLINKED docs belong to which task. Sequenced
    // AFTER the deterministic pass so a doc that just gained a real issue-key link is never scored.
    await runDocTaskInference(db);
    // Incremental dense (semantic) indexing of newly-synced items. No-op unless dense retrieval is
    // configured (EMBEDDINGS_URL + pgvector schema); best-effort — never fails the tick. A batch where
    // items were SCANNED but all FAILED (e.g. embeddings quota/outage) records an ERROR run so the
    // degraded stack shows on Admin → Integrations instead of silently indexing nothing.
    {
      const startedAt = Date.now();
      const { lastDenseRunFailed, alertDenseDegraded, alertDenseRecovered } = await import("@/lib/query/retrieval-alert");
      // Capture the leg's state BEFORE this tick so we can email admins only on the EDGE (ok→degraded
      // or degraded→ok), not once per tick during a sustained outage.
      const priorFailed = await lastDenseRunFailed(db).catch(() => false);
      try {
        const { indexPendingItems } = await import("@/lib/query/dense-index");
        const d = await indexPendingItems();
        if (d.indexed) console.info(`[ingest] dense: embedded ${d.indexed} items (${d.chunks} chunks)`);
        if (d.failed > 0) {
          console.error(`[ingest] dense: ${d.failed}/${d.scanned} items failed to embed — ${d.errorSample ?? "unknown error"}`);
          await recordIngestRun(db, {
            source: "dense",
            trigger: "scheduler",
            ok: false,
            created: d.indexed,
            errors: [`${d.failed} of ${d.scanned} items failed to embed: ${d.errorSample ?? "unknown error"}`],
            meta: { indexed: d.indexed, failed: d.failed, chunks: d.chunks },
            startedAt,
          });
          await alertDenseDegraded(db, priorFailed, { failed: d.failed, scanned: d.scanned, errorSample: d.errorSample });
        } else if (d.indexed > 0) {
          await recordIngestRun(db, {
            source: "dense",
            trigger: "scheduler",
            ok: true,
            created: d.indexed,
            meta: { indexed: d.indexed, chunks: d.chunks },
            startedAt,
          });
          await alertDenseRecovered(db, priorFailed, d.indexed);
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error("[ingest] dense index tick failed:", msg);
        await recordIngestRun(db, { source: "dense", trigger: "scheduler", ok: false, errors: [msg], startedAt });
        await alertDenseDegraded(db, priorFailed, { failed: 0, scanned: 0, errorSample: msg });
      }
    }

    // Graph pollution alarm (AIO-693, re-armed by ALARMFIX-1): the scheduled caller extraction
    // health never had. The 2026-07-30 bad-model incident was visible on every page that anyone
    // didn't open for four days; this pushes the transition to admins instead. Runs BOTH machines —
    // the name-collision census (pollution) and the blindness meta-alarm (an alarm that can't judge
    // and doesn't say so is the failure shape #490 left behind). Cheap per-group Neo4j aggregates
    // per tick; best-effort, edge-debounced (see lib/graph/extraction-alert).
    {
      const { runGraphHealthCheck } = await import("@/lib/graph/extraction-alert");
      const r = await runGraphHealthCheck(db);
      if (r.pollution !== "none" || r.blindness !== "none")
        console.warn(`[ingest] graph_health: pollution=${r.pollution} blindness=${r.blindness}`);
    }
  };

  // Inbound PM-sync step (brain-api v1.4): apply Linear board edits to brain tasks + adopt
  // Linear-native issues, for opted-in teams. Records to ingest_runs like the importers; a
  // quiet pass (nothing enabled / nothing changed / no conflicts) logs nothing.
  async function runInbound(db: ReturnType<typeof adminClient>): Promise<void> {
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
      await recordIngestRun(db, {
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
      await recordIngestRun(db, { source: "linear_inbound", trigger: "scheduler", ok: false, errors: [msg], startedAt });
    }
  }

  // Shared runner: run one source, log a line, and record the outcome to ingest_runs so a failure
  // (or a silent staleness) is diagnosable later instead of only living in container logs.
  async function runImport(
    db: ReturnType<typeof adminClient>,
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
          ? // `deleted` counts REMOVALS of stored content (threads deleted at the source).
            // Recorded because destructive work must
            // never be the one outcome the run log can't show — a purge that fires wrongly would
            // otherwise be indistinguishable from a quiet sync.
            {
              integrations: s.integrations,
              channels: s.channels,
              ...(s.deleted ? { deleted: s.deleted } : {}),
            }
          : { integrations: s.integrations, items: s.items, projects: s.projects };
      const removed = "channels" in s ? s.deleted : 0;
      if (s.created || s.updated || removed || s.errors.length) {
        const detail = "channels" in s ? `${s.channels} channels` : `${s.items} items, ${s.projects} projects`;
        const removedNote = removed ? ` -${removed} deleted` : "";
        console.info(
          `[ingest] ${label}: +${s.created} ~${s.updated} =${s.unchanged}${removedNote} (${detail}, ${s.integrations} integrations)` +
            (s.errors.length ? ` errors: ${s.errors.join("; ")}` : "")
        );
      }
      // Skip logging unconfigured sources with nothing to report (avoids a no-op row every tick);
      // still record configured sources (proves the poller ran) and anything with errors.
      if (s.integrations === 0 && s.errors.length === 0) return;
      await recordIngestRun(db, {
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
      await recordIngestRun(db, { source: label, trigger: "scheduler", ok: false, errors: [msg], startedAt });
    }
  }

  // Housekeeping: purge expired/used auth_tokens + oauth_states rows (lib/auth/cleanup). A
  // scheduler tick runs far more often than this needs to, so it's throttled to once/day —
  // checked via the last recorded 'auth_cleanup' ingest_runs row, the same "read the last
  // recorded run" pattern the dense-index leg uses for its own edge detection
  // (lib/query/retrieval-alert.lastDenseRunFailed). A throttled pass records nothing; a completed
  // sweep always records a run (that row IS the throttle bookkeeping) and logs only when it
  // actually purged something.
  const AUTH_CLEANUP_INTERVAL_MS = 24 * 60 * 60_000;
  async function runAuthCleanup(db: ReturnType<typeof adminClient>): Promise<void> {
    const startedAt = Date.now();
    try {
      const { data: last } = await db
        .from("ingest_runs")
        .select("started_at")
        .eq("source", "auth_cleanup")
        .order("started_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      const lastStartedAt = (last as { started_at: string } | null)?.started_at;
      if (lastStartedAt && Date.now() - new Date(lastStartedAt).getTime() < AUTH_CLEANUP_INTERVAL_MS) {
        return; // already ran within the last day
      }
      const { purgeExpiredAuthRows } = await import("@/lib/auth/cleanup");
      const result = await purgeExpiredAuthRows();
      if (result.authTokens || result.oauthStates) {
        console.info(
          `[ingest] auth-cleanup: purged ${result.authTokens} auth_tokens, ${result.oauthStates} oauth_states`
        );
      }
      await recordIngestRun(db, {
        source: "auth_cleanup",
        trigger: "scheduler",
        ok: true,
        updated: result.authTokens + result.oauthStates,
        meta: { authTokens: result.authTokens, oauthStates: result.oauthStates },
        startedAt,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error("[ingest] auth-cleanup tick failed:", msg);
      await recordIngestRun(db, { source: "auth_cleanup", trigger: "scheduler", ok: false, errors: [msg], startedAt });
    }
  }

  // Create meeting notes for freshly-synced meeting transcripts, per team. Best-effort; idempotent
  // (already-noted items are skipped), so this is a cheap no-op once caught up.
  async function runAccessBootstrap(db: ReturnType<typeof adminClient>): Promise<void> {
    const startedAt = Date.now();
    try {
      const { ensureAccessBootstrapAllTeams } = await import("@/lib/access/bootstrap");
      const { recordIngestRun } = await import("@/lib/ingest/runs");
      const r = await ensureAccessBootstrapAllTeams(db);
      // Failures are recorded PER TEAM with the actual refusal/error text, so one team's
      // permanent refusal (an initiative squatting 'general') reds only THAT team's health
      // card — a single instance-wide failed row would have turned every team's admin banner
      // red while hiding the cause in meta (slice-3 Codex Medium). The instance-wide row
      // stays the every-tick heartbeat for staleness.
      for (const f of r.failed) {
        if (f.teamId === "*") continue; // teams-read failure → instance row below carries it
        await recordIngestRun(db, {
          teamId: f.teamId,
          source: "access_bootstrap",
          trigger: "scheduler",
          ok: false,
          created: 0,
          errors: [f.error],
          startedAt,
        });
      }
      const globalFailure = r.failed.find((f) => f.teamId === "*");
      await recordIngestRun(db, {
        teamId: null,
        source: "access_bootstrap",
        trigger: "scheduler",
        ok: !globalFailure,
        created: 0,
        errors: globalFailure ? [globalFailure.error] : undefined,
        meta: { teams: r.teams, failedTeams: r.failed.length },
        startedAt,
      });
    } catch (err) {
      // An unexpected throw must still leave a failed trace — a silent catch left the
      // previous green row standing until it aged stale (slice-3 Codex Low).
      try {
        const { recordIngestRun } = await import("@/lib/ingest/runs");
        await recordIngestRun(db, {
          teamId: null,
          source: "access_bootstrap",
          trigger: "scheduler",
          ok: false,
          created: 0,
          errors: [err instanceof Error ? err.message : "bootstrap threw"],
          startedAt,
        });
      } catch {
        // recording itself failed — the console line below is the last resort
      }
      console.error("[ingest] access bootstrap failed", err);
    }
  }

  // PRET-2 (docs/design/pret2-convergence-gated-flip.md §1.2): the unattended flip pass.
  // AUTO_FLIP_ENABLED=false is the operator kill switch (the rate-limit env cannot express
  // zero) — same opt-out pattern as GRAPH_PROJECT_ENABLED.

  async function runContextBackfill(db: ReturnType<typeof adminClient>): Promise<void> {
    const startedAt = Date.now();
    try {
      const { backfillAllTeams } = await import("@/lib/projects/context/backfill");
      const { recordIngestRun } = await import("@/lib/ingest/runs");
      // Cutoff = tick start: bound this run to content that existed when the tick began, so a
      // concurrent push (which the on-push hook partitions itself) isn't chased mid-sweep.
      const cutoff = new Date(startedAt).toISOString();
      // BOUNDED (TICKSTALL-1). The stage used to drain to completion or not at all, which measured
      // 57-60 min against a 30-min interval and starved every stage below it. `batchSize: 100`, not
      // the 500 default, because the budget is checked at a BATCH boundary — a batch that has started
      // runs to completion, so the stage's real bound is `budget + one batch` and a smaller batch
      // keeps that overshoot near a couple of minutes instead of ~11.
      const r = await backfillAllTeams(db, cutoff, { batchSize: 100 });
      // Record a per-team outcome EVERY served turn (success AND failure), so a team that failed once
      // and later recovers gets a newer OK row rather than staying permanently red under distinct-on
      // (slice-5 Codex Medium). This row is ALSO the durable resume cursor and the rotation clock
      // (`lib/projects/context/backfill-cursor` reads it back), which is why every turn must write one
      // even when it did nothing: a turn that recorded nothing would never leave the front of the
      // rotation queue.
      //
      // `created` and `meta` carry what the pass ACTUALLY did. They used to be hardcoded `created: 0`,
      // so every row read identically whether the pass drained 2600 items or spun for an hour — which
      // is precisely why a 59-minute stage ran for six days without anyone noticing.
      for (const o of r.outcomes) {
        await recordIngestRun(db, {
          teamId: o.teamId,
          source: "context_backfill",
          trigger: "scheduler",
          ok: o.ok,
          created: o.membershipsCreated,
          errors: o.ok ? undefined : [o.error ?? "unknown"],
          meta: {
            scanned: o.scanned,
            unitsCreated: o.unitsCreated,
            membershipsCreated: o.membershipsCreated,
            truncated: o.truncated,
            drained: o.drained,
            shortCircuit: o.shortCircuit,
            elapsedMs: o.elapsedMs,
            cursor: o.cursor,
          },
          startedAt,
        });
      }
      const truncated = r.outcomes.filter((o) => o.truncated).length;
      if (truncated || r.deferred.length) {
        console.info(`[ingest] context backfill bounded by budget — ${truncated} truncated, ${r.deferred.length} deferred to the next pass`);
      }
      // Instance-wide heartbeat under a DISTINCT source ('context_backfill_all') so a per-team
      // failed 'context_backfill' row isn't masked by the newer global ok row under distinct-on
      // (slice-5 Fable Medium — the same latent shape access_bootstrap has; tracked separately).
      //
      // A budget-truncated pass is NOT a failure: `ok` stays true and the fact lives in
      // `meta.truncated`. Routing truncation through the failure path would put a healthy leg into the
      // BANNERFLAP-1 streak and redden the banner — re-introducing the bug BANNERFLAP-2 just fixed.
      await recordIngestRun(db, {
        teamId: null,
        source: "context_backfill_all",
        trigger: "scheduler",
        ok: !r.error,
        created: r.outcomes.reduce((n, o) => n + o.membershipsCreated, 0),
        errors: r.error ? [r.error] : undefined,
        meta: {
          teams: r.teams,
          served: r.outcomes.length,
          failedTeams: r.outcomes.filter((o) => !o.ok).length,
          truncated,
          deferred: r.deferred.length,
          scanned: r.outcomes.reduce((n, o) => n + o.scanned, 0),
        },
        startedAt,
      });
    } catch (err) {
      try {
        const { recordIngestRun } = await import("@/lib/ingest/runs");
        await recordIngestRun(db, {
          teamId: null,
          // instance-wide scope uses the _all source consistently (slice-5 Codex Medium) — a
          // teamId=null 'context_backfill' row would mask per-team rows under distinct-on.
          source: "context_backfill_all",
          trigger: "scheduler",
          ok: false,
          created: 0,
          errors: [err instanceof Error ? err.message : "context backfill threw"],
          startedAt,
        });
      } catch {
        // last resort is the console line
      }
      console.error("[ingest] context backfill failed", err);
    }
  }

  async function runMeetingNotesBackfill(db: ReturnType<typeof adminClient>): Promise<void> {
    try {
      const { backfillMeetingNotesFromItems } = await import("@/lib/meetings/from-items");
      const { resolveAnsweringKeys } = await import("@/lib/query/answering");
      const { recordIngestRun } = await import("@/lib/ingest/runs");
      const { data: teams } = await db.from("teams").select("id");
      for (const t of ((teams ?? []) as { id: string }[])) {
        const startedAt = Date.now();
        try {
          const keys = await resolveAnsweringKeys(db, t.id);
          const s = await backfillMeetingNotesFromItems(db, t.id, { keys });
          if (s.created) console.info(`[ingest] meeting-notes: created ${s.created} for team ${t.id}`);
          // Record the run so this LLM-driven leg is diagnosable on the dashboard like its siblings —
          // it was the one scheduler loop with no durable trace (a broken model silently made no notes).
          await recordIngestRun(db, {
            teamId: t.id,
            source: "meeting_notes",
            trigger: "scheduler",
            ok: true,
            created: s.created ?? 0,
            meta: { scanned: s.scanned ?? 0, merged: s.merged ?? 0 },
            startedAt,
          });
        } catch (err) {
          console.error(`[ingest] meeting-notes backfill (team ${t.id}) failed:`, err instanceof Error ? err.message : err);
          await recordIngestRun(db, {
            teamId: t.id,
            source: "meeting_notes",
            trigger: "scheduler",
            ok: false,
            errors: [err instanceof Error ? err.message : String(err)],
            startedAt,
          });
        }
      }
    } catch (err) {
      console.error("[ingest] meeting-notes backfill tick failed:", err instanceof Error ? err.message : err);
    }
  }

  // Persist deterministic task↔evidence links per team (issue-key references in item text). A
  // regenerable cache like arc_cache — not recorded to ingest_runs (not a monitored leg). Best-effort.
  async function runTaskEvidenceLinking(db: ReturnType<typeof adminClient>): Promise<void> {
    try {
      const { linkTaskEvidence } = await import("@/lib/dashboard/timeline-evidence");
      const { data: teams } = await db.from("teams").select("id");
      for (const t of ((teams ?? []) as { id: string }[])) {
        const r = await linkTaskEvidence(db, t.id); // best-effort; never throws
        if (r.linked) console.info(`[ingest] task-evidence: linked ${r.linked} for team ${t.id}`);
      }
    } catch (err) {
      console.error("[ingest] task-evidence linking tick failed:", err instanceof Error ? err.message : err);
    }
  }

  // LLM doc→task assignment: the docs a deterministic issue-key match can never catch (a design doc
  // rarely cites AIO-494). Per team, one batched call PER WORKER in the batch, and it short-circuits before spending anything
  // when the team has no model configured or its inputs are unchanged since the last run. Unlike the
  // deterministic sibling above this IS recorded to ingest_runs — it spends money, and the recorded
  // `meta.inputs_hash` is also what makes the skip work. Best-effort; never fails the tick.
  async function runDocTaskInference(db: ReturnType<typeof adminClient>): Promise<void> {
    try {
      const { runDocTaskInference: runOne } = await import("@/lib/dashboard/doc-task-infer-run");
      const { data: teams } = await db.from("teams").select("id");
      for (const t of ((teams ?? []) as { id: string }[])) {
        const r = await runOne(db, t.id); // best-effort; never throws
        if (r.linked) console.info(`[ingest] doc-task-infer: linked ${r.linked}/${r.scored} for team ${t.id}`);
      }
    } catch (err) {
      console.error("[ingest] doc-task inference tick failed:", err instanceof Error ? err.message : err);
    }
  }

  // Delay the first run so boot isn't blocked; then poll on the interval.
  //
  // SINGLE-FLIGHT (TICKSTALL-1). `setInterval` fires whether or not the previous tick finished, and
  // this chain can outlast its own interval — `runContextBackfill` was measured at ~59 min against a
  // 30-min interval, and the overlap is visible in prod as `slack` recording 13 times in 4.85h where
  // ~9.7 is expected. Beyond the wasted work, the backfill's durable resume cursor lives in
  // `ingest_runs.meta` with no compare-and-swap behind it, so a second in-flight pass can resurrect a
  // superseded cursor. One pass at a time is what makes that cursor sound.
  const guardedTick = singleFlight(tick);
  setTimeout(guardedTick, 20_000).unref?.();
  setInterval(guardedTick, intervalMs).unref?.();
  console.info(`[ingest] scheduler started — Slack + Plane + Linear + GitHub every ${minutes}m`);
}
