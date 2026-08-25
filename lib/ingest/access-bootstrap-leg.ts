import "server-only";
import type { DbClient } from "@/lib/db/types";
import { recordIngestRun } from "@/lib/ingest/runs";
import { ensureAccessBootstrapAllTeams } from "@/lib/access/bootstrap";

/**
 * AUDITFIX-22 — the `access_bootstrap` ingest leg, extracted from the scheduler closure so the
 * ledger contract is testable against a real Postgres instead of only reachable by starting a
 * scheduler. Same seam and same reason as `lib/access/revoke-verb.ts`.
 *
 * WHAT CHANGED AND WHY. This leg used to write a per-team row ONLY for a FAILING team, plus an
 * unconditional instance-wide heartbeat every tick. `getPipelineHealth`'s `newest` CTE is
 * `distinct on (source)` over `team_id = $1 or team_id is null` ordered `finished_at desc, id desc`
 * (`lib/ingest/pipeline-health.ts`), and the heartbeat was written LAST — so the global `ok:true`
 * row won, and a wedged team's failure was invisible on its own health card. Its streak was
 * invisible too: the streak join takes the WINNING partition's. That mattered from the moment
 * AUDITFIX-3 shipped a refusal that wedges a team's bootstrap and, through
 * `backfillTeamContext`, its context backfill as well.
 *
 * The fix is not a second source. On an ordinary tick a team's OWN row is its heartbeat, so the
 * global success row has no job left — and it is exactly what does the masking. So:
 *
 *   - a row per team, every tick, on success AS WELL AS failure;
 *   - the `team_id is null` row ONLY when the failure is fleet-level (the teams read failed, or
 *     this function threw) or there are NO teams to report on.
 *
 * ZERO TEAMS WRITES `ok: true`, deliberately. An empty successful read means there was nothing to
 * converge, not that convergence failed; `ok:false` would manufacture a failure and, being global,
 * would falsely red a team created moments later. But SOMETHING must be written, because a leg with
 * no rows at all is ABSENT from `legs`, and an absent leg reads as healthy with staleness unable to
 * fire on it.
 *
 * ⚠️ `trigger` IS LOAD-BEARING. The staleness clock reads `trigger = 'scheduler'` rows ONLY
 * (`lib/ingest/pipeline-health.ts`), so these rows must carry it: they are now the only
 * scheduler-triggered evidence this leg produces, and a non-scheduler trigger here would freeze the
 * beat at deploy and redden every team's banner about three hours later, permanently. No behavioural
 * test can catch that — a fresh test DB has no scheduler rows at all, so the leg is never aged and
 * the suite stays green. The data-mechanics tier asserts the trigger VALUE directly instead.
 * (The row `lib/admin/teams.ts` writes at team creation is the mirror image: it must NOT claim
 * `scheduler`, because team creation is not the poller.)
 *
 * AUDITFIX-24 PUT THE FLEET HEARTBEAT BACK, UNDER A DIFFERENT NAME. Removing the instance-wide
 * `ok:true` row was right — it was the thing doing the masking — but it also deleted the only
 * evidence that the POLLER ITSELF is alive for a team that has no rows of its own yet. Measured on
 * prod: instance-wide `access_bootstrap` scheduler rows went 51/day to 0/day across the deploy. Two
 * spec-review rounds then produced the corner that decides it: a fresh install ticks (this leg is
 * stage 6, `runContextBackfill` is stage 7), hangs before stage 7 so no `context_backfill_all` row
 * ever lands, a team is created, and the scheduler dies — with the beat scoped per team, NOTHING
 * would age, ever.
 *
 * So `access_bootstrap_all` is written unconditionally every tick, exactly mirroring
 * `context_backfill_all`. A DISTINCT source is what makes that safe: the masking AUDITFIX-22 removed
 * came from a global row competing with team rows under `distinct on (source)`, and a different
 * source name cannot compete. This leg's own `team_id is null` rows keep their post-AUDITFIX-22
 * meaning — fleet-level failure, zero teams, or a throw — and its AC4/AC5 contracts are untouched.
 */
export async function runAccessBootstrapLeg(
  db: DbClient,
  opts: { startedAt?: number } = {}
): Promise<void> {
  const startedAt = opts.startedAt ?? Date.now();
  try {
    // The per-team row is written by this callback as each team COMPLETES, not from the returned
    // summary after the loop: a summary cannot be recorded until the last team finishes, so one slow
    // team would delay every team's row and a process death would lose all of them.
    const r = await ensureAccessBootstrapAllTeams(db, {
      onOutcome: async (o) => {
        await recordIngestRun(db, {
          teamId: o.teamId,
          source: "access_bootstrap",
          trigger: "scheduler",
          ok: o.ok,
          created: 0,
          errors: o.ok ? undefined : [o.error ?? "unknown"],
          startedAt,
        });
      },
    });

    // NOTE there is no `for (const f of r.failed)` loop here any more, and re-adding one alongside
    // the callback would write TWO ok:false rows per failing team per tick — which reaches the
    // BANNERFLAP-1 confirmation threshold (2) after a SINGLE failed tick and makes a lone failure
    // loud. The data-mechanics tier pins the per-tick row count for exactly that reason.
    // The FLEET-LIVENESS beat (AUDITFIX-24) — attempted on every path, whatever the pass did, because
    // its whole job is to prove the poller REACHED this stage. Written under its own source so it
    // cannot mask the per-team rows above.
    //
    // ⚠️ `ok: true` EVEN WHEN THE FLEET FAILED, and that is the deliberate part. This row asserts
    // LIVENESS, not correctness; the fleet-level failure is already carried by the instance-wide
    // `access_bootstrap` row below, which AUDITFIX-22's AC5 depends on. A diff review caught the
    // alternative: mirroring the failure here makes ONE failed teams-read confirm on TWO sources, and
    // the banner then says "2 ingestion legs are broken" about a single event — the exact
    // double-count that put `llm` in NOT_PIPELINE_LEGS after the 2026-08-11 incident. The outcome is
    // still recorded, in `meta`, where it is diagnosable without being counted twice.
    const globalFailure = r.failed.find((f) => f.teamId === "*");
    await recordIngestRun(db, {
      teamId: null,
      source: "access_bootstrap_all",
      trigger: "scheduler",
      ok: true,
      created: 0,
      meta: { teams: r.teams, failedTeams: r.failed.length, fleetOk: !globalFailure },
      startedAt,
    });

    if (globalFailure || r.teams === 0) {
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
    }
  } catch (err) {
    // An unexpected throw must still leave a failed trace — a silent catch left the previous green
    // row standing until it aged stale (slice-3 Codex Low). This is fleet-level by definition: the
    // loop itself died, so it is the instance-wide row that carries it.
    try {
      // Both rows on this path, and they say DIFFERENT things: the heartbeat proves the poller
      // reached this stage (LIVENESS — `ok:true` for the same no-double-count reason as above, with
      // the throw in `meta`), and the source-`access_bootstrap` row is the fleet-level FAILURE that
      // AUDITFIX-22's AC5 depends on.
      await recordIngestRun(db, {
        teamId: null,
        source: "access_bootstrap_all",
        trigger: "scheduler",
        ok: true,
        created: 0,
        meta: { fleetOk: false, threw: err instanceof Error ? err.message : "bootstrap threw" },
        startedAt,
      });
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
      // recording itself failed — the caller's console line is the last resort
    }
    throw err;
  }
}
