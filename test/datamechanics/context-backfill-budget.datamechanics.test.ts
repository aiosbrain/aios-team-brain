import { describe, expect, it } from "vitest";
import { db, ingest, seedTeam, type Seed } from "./helpers";
import { backfillAllTeams } from "@/lib/projects/context/backfill";
import { readTeamBackfillState } from "@/lib/projects/context/backfill-cursor";
import { recordIngestRun } from "@/lib/ingest/runs";

/**
 * TICKSTALL-1 (`docs/design/tick-stall-backfill-budget.md`) — the budget/cursor/drain behaviour, on
 * real Postgres because all of it lives in keyset paging over `items` plus a cursor round-tripped
 * through `ingest_runs.meta`. FakeSupabase cannot run either.
 *
 * The criterion this file exists for above all others is RESUME. The spec's first draft asserted
 * "the next tick continues rather than restarting" while `backfillAllTeams` reset `cursor = null`
 * on every call — so a budgeted pass would have re-swept the same first batch forever and never
 * reached the tail, while LOOKING fixed because the downstream legs started running again.
 */

const CUTOFF = () => new Date(Date.now() + 60_000).toISOString();

/** A cursor is only meaningful across more than one batch, so fixtures must exceed batchSize.
 *  Deliberately NOT derived from any constant under test (a fixture seeded from the thing it
 *  checks makes the check vacuous) — BATCH is the knob, SIZE is an independent literal. */
const BATCH = 2;
const SIZE = 5;

async function seedItems(seed: Seed, n: number, prefix = "i"): Promise<void> {
  for (let k = 0; k < n; k++) {
    await ingest(seed, { path: `${prefix}/${k}.md`, body: `body ${k}`, access: "team", project: "src" });
  }
}

async function itemsWithoutMembership(seed: Seed): Promise<number> {
  const { data } = await db()
    .from("items")
    .select("id")
    .eq("team_id", seed.teamId);
  const ids = ((data ?? []) as { id: string }[]).map((i) => i.id);
  let missing = 0;
  for (const id of ids) {
    const { data: unit } = await db()
      .from("project_context_units")
      .select("id")
      .eq("team_id", seed.teamId)
      .eq("source_item_id", id)
      .maybeSingle();
    if (!unit) { missing++; continue; }
    const { data: mems } = await db()
      .from("project_context_memberships")
      .select("id")
      .eq("team_id", seed.teamId)
      .eq("context_unit_id", (unit as { id: string }).id)
      .is("valid_to", null);
    if (((mems ?? []) as unknown[]).length === 0) missing++;
  }
  return missing;
}

/** One served turn, persisting the SUBSET of the scheduler's row that the cursor read depends on
 *  (team_id / source / trigger / meta.cursor) — enough to prove the round-trip, but deliberately NOT
 *  a stand-in for the production writer. That the real call site writes these same keys is pinned
 *  separately by `test/guards/context-backfill-budget-single-parse`, because if it ever drifted this
 *  file would keep passing while the cursor silently read null forever. */
async function pass(seed: Seed, opts: { budgetMs: number }) {
  const r = await backfillAllTeams(db(), CUTOFF(), { budgetMs: opts.budgetMs, batchSize: BATCH });
  for (const o of r.outcomes) {
    await recordIngestRun(db(), {
      teamId: o.teamId,
      source: "context_backfill",
      trigger: "scheduler",
      ok: o.ok,
      created: o.membershipsCreated,
      meta: { truncated: o.truncated, drained: o.drained, cursor: o.cursor },
      startedAt: Date.now() - 1,
    });
  }
  return r;
}

describe("context backfill — bounded by a budget, resumable across ticks (data-mechanics)", () => {
  it("an expired budget stops after ONE batch per served team and leaves a resumable cursor", async () => {
    const seed = await seedTeam();
    await seedItems(seed, SIZE);

    const r = await pass(seed, { budgetMs: 0 }); // already expired on arrival
    const o = r.outcomes.find((x) => x.teamId === seed.teamId)!;

    expect(o.truncated, "an expired budget must truncate, not drain").toBe(true);
    expect(o.drained).toBe(false);
    expect(o.cursor, "a truncated pass must leave a resume point").not.toBeNull();
    // NEVER zero: a budget of 0 must still make one batch of progress, or the sweep is a stall
    // wearing a budget's clothes.
    expect(o.scanned).toBe(BATCH);
    // …and that progress is DURABLE — a truncated pass commits, it does not roll back.
    expect(await itemsWithoutMembership(seed)).toBe(SIZE - BATCH);
  });

  it("RESUMES across calls — successive budgeted passes advance past the first batch and drain", async () => {
    // The criterion that falsifies restart-from-null. With the old code every pass would re-scan
    // items 0..BATCH and `itemsWithoutMembership` would never reach 0.
    const seed = await seedTeam();
    await seedItems(seed, SIZE);

    const cursors: (string | null)[] = [];
    for (let i = 0; i < 10; i++) {
      const r = await pass(seed, { budgetMs: 0 });
      const o = r.outcomes.find((x) => x.teamId === seed.teamId)!;
      cursors.push(o.cursor);
      if (o.drained) break;
    }

    expect(await itemsWithoutMembership(seed), "every item must end up partitioned").toBe(0);
    const advanced = new Set(cursors.filter((c): c is string => c !== null));
    expect(advanced.size, `the cursor must MOVE, not repeat: ${JSON.stringify(cursors)}`).toBeGreaterThan(1);
  });

  it("RESETS the cursor on drain, so a later low-id item is still backstopped", async () => {
    // Without reset-on-drain an item the on-push hook misses whose id sorts BELOW the final cursor is
    // never swept again — a unit with no membership, i.e. content visible to nobody under an enforced
    // read. That is the silent-forever direction this whole slice is careful about.
    const seed = await seedTeam();
    await seedItems(seed, SIZE);
    for (let i = 0; i < 10; i++) {
      const r = await pass(seed, { budgetMs: 0 });
      if (r.outcomes[0]?.drained) break;
    }
    const drainedState = await readTeamBackfillState(db(), seed.teamId);
    expect(drainedState.cursor, "a drained pass must clear the cursor").toBeNull();

    // A new item whose membership is then CLOSED, to simulate a half-reconciled item.
    //
    // The previous version of this could not run: it looked the unit up before any backfill, but the
    // dm `ingest` helper calls `ingestItem` directly and the partition hook lives in the items ROUTE
    // — so the fresh item had no unit, `if (unit)` never fired, and the strip never happened. The
    // test still passed, because an unpartitioned item is a candidate anyway — it was proving the
    // arm-1 state while its comment claimed otherwise. An earlier fix corrected the `.itemId`/`.id`
    // key and CLAIMED to have fixed this; that claim was false, and it took a review to catch.
    // Now: backfill FIRST so the item genuinely has a current include, then close it.
    const late = await ingest(seed, { path: "late/x.md", body: "late", access: "team", project: "src" });
    for (let i = 0; i < 10; i++) {
      const r = await pass(seed, { budgetMs: 60_000 });
      if (r.outcomes[0]?.drained) break;
    }
    const lateUnit = await db()
      .from("project_context_units").select("id")
      .eq("team_id", seed.teamId).eq("source_item_id", late.id).maybeSingle();
    const lateUnitId = (lateUnit.data as { id: string } | null)?.id;
    expect(lateUnitId, "the backfill must have given it a unit before we can close its membership").toBeTruthy();
    const closed = await db().from("project_context_memberships")
      .update({ valid_to: new Date().toISOString() })
      .eq("team_id", seed.teamId).eq("context_unit_id", lateUnitId!).is("valid_to", null);
    expect(closed.error, "the strip must actually run — that is the whole point of this fixture").toBeFalsy();

    expect(await itemsWithoutMembership(seed)).toBeGreaterThan(0);

    for (let i = 0; i < 10; i++) {
      const r = await pass(seed, { budgetMs: 60_000 });
      if (r.outcomes[0]?.drained) break;
    }
    expect(await itemsWithoutMembership(seed), "the backstop must reach it after the reset").toBe(0);
  });

  it("a converged corpus reconciles NOTHING — attributable to the predicate, not a short-circuit", async () => {
    // TICKSTALL-2 removed the convergence short-circuit (it could report converged while a real
    // candidate existed). This assertion used to be satisfied by that heuristic never running the
    // sweep; now `scanned: 0` is the predicate's own result.
    const seed = await seedTeam();
    await seedItems(seed, SIZE);
    for (let i = 0; i < 10; i++) {
      const r = await pass(seed, { budgetMs: 60_000 });
      if (r.outcomes[0]?.drained) break;
    }

    const r = await pass(seed, { budgetMs: 60_000 });
    const o = r.outcomes.find((x) => x.teamId === seed.teamId)!;
    expect(o.scanned, "a converged corpus must reconcile nothing").toBe(0);
    expect(o.drained, "and drain immediately").toBe(true);
  });

  it("a budget-truncated turn is ok:true — it must NOT enter the failure path", async () => {
    // Routing truncation through ok:false would put a healthy leg into the BANNERFLAP-1 streak and
    // redden the banner, re-introducing the bug the sibling ticket just fixed.
    const seed = await seedTeam();
    await seedItems(seed, SIZE);
    const r = await pass(seed, { budgetMs: 0 });
    const o = r.outcomes.find((x) => x.teamId === seed.teamId)!;
    expect(o.truncated).toBe(true);
    expect(o.ok).toBe(true);
    expect(o.error).toBeUndefined();
  });

  it("the newest-row read is DETERMINISTIC under same-finished_at rows (id desc decides)", async () => {
    // Criterion 6. Two rows written in the same millisecond is not hypothetical — the stage writes a
    // per-team row and the instance row microseconds apart, and `lib/ingest/pipeline-health` already
    // had to learn this tie-break the hard way. Without `id desc` the resume point is arbitrary
    // between them, which silently means "resume from somewhere".
    const seed = await seedTeam();
    const sameInstant = new Date(Date.now() - 5_000).toISOString();
    for (const cur of ["cursor-written-first", "cursor-written-second"]) {
      await recordIngestRun(db(), {
        teamId: seed.teamId,
        source: "context_backfill",
        trigger: "scheduler",
        ok: true,
        meta: { cursor: cur },
        startedAt: Date.parse(sameInstant) - 1,
        finishedAt: Date.parse(sameInstant),
      });
    }
    const state = await readTeamBackfillState(db(), seed.teamId);
    expect(state.cursor, "the LAST row written must win, not an arbitrary one").toBe("cursor-written-second");
  });

  it("the stored cursor round-trips through ingest_runs.meta", async () => {
    const seed = await seedTeam();
    await seedItems(seed, SIZE);
    const r = await pass(seed, { budgetMs: 0 });
    const written = r.outcomes.find((x) => x.teamId === seed.teamId)!.cursor;
    const readBack = await readTeamBackfillState(db(), seed.teamId);
    expect(readBack.cursor, "the cursor must survive the tick — this is the whole resume mechanism").toBe(written);
    expect(readBack.lastServedAt, "the rotation clock must be set by a served turn").not.toBeNull();
  });
});
