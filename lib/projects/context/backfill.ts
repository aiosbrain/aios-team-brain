import "server-only";
import type { DbClient } from "@/lib/db/types";
import { reconcileItemContext } from "@/lib/projects/context/reconcile-item";
import { ensureAccessBootstrap, GENERAL_SLUG, EXTERNAL_SHARED_SLUG } from "@/lib/access/bootstrap";
import { budgetExpired, contextBackfillBudgetMs } from "./backfill-budget";
import { orderByRotation, readTeamBackfillState, type TeamBackfillState } from "./backfill-cursor";
import { selectCandidateItemIds } from "./backfill-candidates";

/**
 * §11 backfill — the "give every existing item a membership" half of the migration. For each
 * item: reconcile its item-grain unit, then ensure an include membership into `general` if
 * `access='team'`, into `external-shared` if `access='external'`. Result per §11: **day-one
 * visibility byte-identical to today** — a team member sees General (all team content) and
 * external-shared; an external principal sees external-shared only. The topology those slugs
 * point at is created by ensureAccessBootstrap (slice 3), which this calls first.
 *
 * Resumable and batched: processes items in `id` order after a cursor, bounded per call, so a
 * scheduler leg or a one-shot admin run can chip through a large corpus without a long
 * transaction. Idempotent — a re-run over an already-backfilled item is two no-op ensures.
 */

export interface BackfillResult {
  ok: boolean;
  error?: string;
  scanned: number;
  unitsCreated: number;
  membershipsCreated: number;
  /** The last item id processed — pass as `afterId` to resume; null when the corpus is drained. */
  cursor: string | null;
}

/** Only the id is needed — `reconcileItemContext` re-reads the item. `access` was selected here
 *  and never read. */
type ItemRow = { id: string };

export async function backfillTeamContext(
  db: DbClient,
  teamId: string,
  opts: { batchSize?: number; afterId?: string | null; createdBefore?: string } = {}
): Promise<BackfillResult> {
  const batchSize = Math.min(Math.max(opts.batchSize ?? 500, 1), 2000);

  // The system projects + grants must exist before we can point memberships at them.
  const boot = await ensureAccessBootstrap(db, teamId);
  if (!boot.ok) return { ok: false, error: `bootstrap: ${boot.error}`, scanned: 0, unitsCreated: 0, membershipsCreated: 0, cursor: opts.afterId ?? null };

  const projectId = await resolveSystemProjectIds(db, teamId);
  if (!projectId.ok) return { ok: false, error: projectId.error, scanned: 0, unitsCreated: 0, membershipsCreated: 0, cursor: opts.afterId ?? null };

  // CANDIDATES ONLY (TICKSTALL-2). This used to select every item and lean on reconcile being
  // idempotent — ~1.3 s per item to re-confirm 2,672 finished ones in order to fix 6. The predicate
  // lives in `backfill-candidates`; getting it wrong the "no work" way silently leaves an item
  // visible to NOBODY, so read that file's header before touching it.
  //
  // Random uuids are stable once assigned, so id-keyset still covers each row at most once per pass.
  // The cutoff still bounds the run to the pre-existing corpus so a concurrent insert (which the
  // ingest hook partitions itself) can't be skipped-yet-reported-drained (slice-5 Codex Medium).
  let ids: string[];
  try {
    const page = await selectCandidateItemIds(teamId, {
      afterId: opts.afterId ?? null,
      createdBefore: opts.createdBefore ?? null,
      limit: batchSize,
    });
    ids = page.ids;
  } catch (e) {
    const msg = e instanceof Error ? e.message : "candidate query failed";
    return { ok: false, error: msg, scanned: 0, unitsCreated: 0, membershipsCreated: 0, cursor: opts.afterId ?? null };
  }

  const items: ItemRow[] = ids.map((id) => ({ id }));
  let unitsCreated = 0;
  let membershipsCreated = 0;
  let scanned = 0;
  // On failure the cursor is the last item that FULLY succeeded (or the incoming afterId if the
  // first item fails), so a resume RETRIES the failed item rather than skipping past it —
  // skipping would leave a unit with no membership, i.e. content visible to no one under a
  // Phase-B read (Fable H2). Progress within a failed batch is preserved (the successes before
  // it committed and are idempotent on retry).
  let lastGood: string | null = opts.afterId ?? null;
  for (const item of items) {
    // Per-item reconcile+route+move — the SAME core the ingest hook uses (spec §11.2), so the
    // one-time sweep and the on-push path can never diverge in how they partition an item.
    const r = await reconcileItemContext(db, teamId, item.id, projectId);
    if (!r.ok) return { ok: false, error: `${item.id}: ${r.error}`, scanned, unitsCreated, membershipsCreated, cursor: lastGood };
    if (r.unitCreated) unitsCreated++;
    if (r.membershipCreated) membershipsCreated++;
    scanned++;
    lastGood = item.id;
  }

  // Drained when the batch came back short.
  const cursor = items.length === batchSize ? items[items.length - 1].id : null;
  return { ok: true, scanned, unitsCreated, membershipsCreated, cursor };
}

async function resolveSystemProjectIds(
  db: DbClient,
  teamId: string
): Promise<{ ok: true; general: string; externalShared: string } | { ok: false; error: string }> {
  const { data, error } = await db
    .from("projects")
    .select("id, slug")
    .eq("team_id", teamId)
    // kind='system' matches `lib/projects/context/reconcile-item`, which has carried this filter
    // since slice 5. THIS resolver did not, so an initiative squatting the slug 'general' /
    // 'external-shared' resolved here but was refused there — the sweep and the hook partitioning
    // into different projects, the divergence the shared core exists to prevent. Found by the
    // TICKSTALL-2 spec review; the candidate SQL filters on it too, so all three now agree.
    .eq("kind", "system")
    .in("slug", [GENERAL_SLUG, EXTERNAL_SHARED_SLUG]);
  if (error) return { ok: false, error: error.message };
  const bySlug = new Map(((data ?? []) as { id: string; slug: string }[]).map((p) => [p.slug, p.id]));
  const general = bySlug.get(GENERAL_SLUG);
  const externalShared = bySlug.get(EXTERNAL_SHARED_SLUG);
  if (!general || !externalShared) return { ok: false, error: "system projects missing after bootstrap" };
  return { ok: true, general, externalShared };
}

const MAX_BATCHES = 10_000;

export interface DrainResult {
  ok: boolean;
  error?: string;
  unitsCreated: number;
  membershipsCreated: number;
  batches: number;
}

/**
 * Drain ONE team's backfill cursor to completion. The single-team counterpart to
 * `backfillAllTeams`, for callers that must know this team is fully partitioned before doing
 * something else — today that is the enforcement flip (`lib/admin/access-enforcement.ts`), which
 * cannot safely turn a team `enforcing` while any item still lacks a membership. Deliberately has
 * NO convergence short-circuit: the count heuristic `backfillAllTeams` uses is a cheap tick
 * optimization, and a caller about to change what a whole team can see needs the real drain.
 * Guard-exhaustion is reported as a FAILURE, never a silent partial (Fable M1).
 */
export async function drainTeamContext(
  db: DbClient,
  teamId: string,
  opts: { cutoff?: string } = {}
): Promise<DrainResult> {
  const cutoff = opts.cutoff ?? new Date().toISOString();
  let cursor: string | null = null;
  let unitsCreated = 0;
  let membershipsCreated = 0;
  for (let batch = 0; batch < MAX_BATCHES; batch++) {
    const r = await backfillTeamContext(db, teamId, { afterId: cursor, createdBefore: cutoff });
    unitsCreated += r.unitsCreated;
    membershipsCreated += r.membershipsCreated;
    if (!r.ok) return { ok: false, error: r.error, unitsCreated, membershipsCreated, batches: batch + 1 };
    if (r.cursor === null) return { ok: true, unitsCreated, membershipsCreated, batches: batch + 1 };
    cursor = r.cursor;
  }
  return {
    ok: false,
    error: `guard exhausted at cursor ${cursor} — corpus not fully backfilled`,
    unitsCreated,
    membershipsCreated,
    batches: MAX_BATCHES,
  };
}

/** What one team's turn did. `truncated` and `drained` are DIFFERENT facts:
 *  hit the budget / reached the end of the corpus / skipped because the convergence predicate held.
 *  An earlier draft folded them into one flag called `converged`, which lied — it meant "this call hit
 *  the budget" while any reader takes it as "this team satisfies the predicate". */
export interface TeamBackfillOutcome {
  teamId: string;
  ok: boolean;
  error?: string;
  scanned: number;
  unitsCreated: number;
  membershipsCreated: number;
  truncated: boolean;
  drained: boolean;
  /** Wall-clock this team's turn consumed — the per-team number the aggregate `duration_ms` cannot
   *  give, and the one that says whether the budget is well-sized. */
  elapsedMs: number;
  /** Resume point for the next pass; null when drained (or short-circuited). */
  cursor: string | null;
}

export interface AllTeamsResult {
  teams: number;
  outcomes: TeamBackfillOutcome[];
  /** Teams never reached this pass because the budget ran out — they lead the next rotation. */
  deferred: string[];
  /** Instance-wide read failure (the `teams` select itself). */
  error?: string;
}

/**
 * Backfill teams within a wall-clock BUDGET, resuming each from its stored cursor and serving them
 * least-recently-first (TICKSTALL-1). Best-effort per team.
 *
 * The budget is checked AFTER each batch, so every team whose turn begins makes at least one batch of
 * progress — a budget of zero (mis-set env, clock jump) must not halt the sweep at nothing. The stage
 * therefore runs for at most `budget + one batch`; the scheduler passes a small `batchSize` to keep
 * that overshoot near one batch.
 *
 * `now` is injectable so the budget is testable without sleeping.
 */
export async function backfillAllTeams(
  db: DbClient,
  cutoff: string,
  opts: { budgetMs?: number; batchSize?: number; now?: () => number } = {}
): Promise<AllTeamsResult> {
  const now = opts.now ?? Date.now;
  const budgetMs = opts.budgetMs ?? contextBackfillBudgetMs();
  const startedAt = now();
  const { data: teams, error } = await db.from("teams").select("id");
  if (error) return { teams: 0, outcomes: [], deferred: [], error: `teams read failed: ${error.message}` };
  const all = (teams ?? []) as { id: string }[];

  // Rotation: read each team's cursor + clock, then serve least-recently-served first. Without this,
  // a stage-wide budget plus the old sequential loop starves every team behind one that never
  // converges — invisible on single-team prod, permanent everywhere else.
  //
  // KNOWN, DEFERRED (Codex review): the clock lives in the row `recordIngestRun` writes, and that
  // writer SWALLOWS its errors. If `ingest_runs` writes fail persistently, every team reads as
  // never-served, so the first team by id is served every pass and the rest are deferred forever —
  // livelock, though not data loss (the reconcile is idempotent; nothing is skipped). Not fixed here
  // because the precondition is a total failure of the run ledger, which is ALREADY alarmed by a
  // different mechanism: the upstream connector legs stop recording too and go stale within 3h. A
  // fix belongs with whatever makes `recordIngestRun` failures visible, not inside the rotation.
  const states = await Promise.all(all.map((t) => readTeamBackfillState(db, t.id)));
  const ordered = orderByRotation(states);

  const outcomes: TeamBackfillOutcome[] = [];
  const deferred: string[] = [];
  for (const state of ordered) {
    if (outcomes.length > 0 && budgetExpired(startedAt, now(), budgetMs)) {
      // Out of budget BEFORE this team's turn began — defer it. It leads the next rotation, which is
      // what bounds every team to being served within `team_count` passes.
      deferred.push(state.teamId);
      continue;
    }
    outcomes.push(await backfillOneTeamTurn(db, state, cutoff, { budgetMs, batchSize: opts.batchSize, now, startedAt }));
  }
  return { teams: all.length, outcomes, deferred };
}

async function backfillOneTeamTurn(
  db: DbClient,
  state: TeamBackfillState,
  cutoff: string,
  o: { budgetMs: number; batchSize?: number; now: () => number; startedAt: number }
): Promise<TeamBackfillOutcome> {
  const base: TeamBackfillOutcome = {
    teamId: state.teamId,
    ok: true,
    scanned: 0,
    unitsCreated: 0,
    membershipsCreated: 0,
    truncated: false,
    drained: false,
    elapsedMs: 0,
    cursor: state.cursor,
  };
  const turnStartedAt = o.now();
  const t = { id: state.teamId };
  {
    try {
      // NO CONVERGENCE SHORT-CIRCUIT (TICKSTALL-2). It compared a global `items` count to a global
      // count of all current memberships — no `decision`, no target project, no per-item grain —
      // while the schema permits multiple current memberships per unit across projects and tests
      // deliberately preserve initiative memberships across a move. So `memberships >= items` could
      // be TRUE while a real candidate existed and the sweep was skipped: a pre-existing path that
      // silently dropped work. The candidate query is the cheap check now, and it is exact.
      //
      // Cost, honestly: a converged team still walks its items via an index-probed anti-join, which
      // is cost-PARITY with the two exact `count(*)`s this replaces — those were O(N) too. What
      // collapses is the ~1.3 s-per-item reconcile loop, not the query.
      let cursor: string | null = state.cursor;
      let drained = false;
      let truncated = false;
      let scanned = 0;
      let unitsCreated = 0;
      let membershipsCreated = 0;
      for (let guard = 0; guard < MAX_BATCHES; guard++) {
        const r: BackfillResult = await backfillTeamContext(db, t.id, {
          afterId: cursor,
          createdBefore: cutoff,
          batchSize: o.batchSize,
        });
        scanned += r.scanned;
        unitsCreated += r.unitsCreated;
        membershipsCreated += r.membershipsCreated;
        if (!r.ok) {
          // A failure keeps the cursor at the last FULLY-succeeded item so the next pass RETRIES the
          // offending item instead of stepping over it — skipping would leave a unit with no
          // membership, i.e. content visible to nobody under an enforced read.
          return { ...base, elapsedMs: o.now() - turnStartedAt, ok: false, error: r.error ?? "unknown", scanned, unitsCreated, membershipsCreated, cursor: r.cursor };
        }
        if (r.cursor === null) {
          drained = true;
          break;
        }
        cursor = r.cursor;
        // AFTER the batch, never before: every team's turn makes at least one batch of progress, so a
        // zero/mis-set budget cannot halt the sweep at nothing.
        if (budgetExpired(o.startedAt, o.now(), o.budgetMs)) {
          truncated = true;
          break;
        }
      }
      if (!drained && !truncated) {
        // Fail LOUD on a silent partial: a corpus larger than MAX_BATCHES*batchSize left un-drained
        // would otherwise report as covered (Fable M1). Distinct from `truncated`, which is a
        // deliberate stop with a resumable cursor.
        return {
          ...base, ok: false, scanned, unitsCreated, membershipsCreated, cursor,
          error: `guard exhausted at cursor ${cursor} — corpus not fully backfilled`,
        };
      }
      // Reset on drain. Without it, an item the on-push hook misses whose id sorts BELOW the final
      // cursor is never swept again — the silent-forever direction.
      return { ...base, elapsedMs: o.now() - turnStartedAt, scanned, unitsCreated, membershipsCreated, truncated, drained, cursor: drained ? null : cursor };
    } catch (e) {
      return { ...base, elapsedMs: o.now() - turnStartedAt, ok: false, error: e instanceof Error ? e.message : "threw" };
    }
  }
}
