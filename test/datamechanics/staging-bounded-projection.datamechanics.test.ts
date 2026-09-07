import { describe, expect, it, vi } from "vitest";
import { runGraphProjection } from "@/lib/graph/run";
import { projectItemsToGraph } from "@/lib/graph/project";
import { readStagingMarker } from "@/lib/env/staging-marker";
import { runSql } from "@/lib/db/pg/pool";
import { db, ingest, seedTeam } from "./helpers";
import { FakeGraphiti, client } from "./fake-graphiti";

/**
 * STGENV-3 — the push gate, against real Postgres with a stubbed Graphiti.
 * Spec: docs/design/staging-bounded-projection.md, criteria C18-C24.
 *
 * This tier is where the bound is actually proved. The unit tier proves the DECISION produces a floor
 * and the guards prove the wiring exists; only a real `items` table with real `work_at` and `synced_at`
 * values can show that the right rows are held.
 */

const DAY = 86_400_000;
const iso = (msAgo: number) => new Date(Date.now() - msAgo).toISOString();

/** Set the two timestamps independently — the whole point is that they disagree. */
async function setDates(itemId: string, workAt: string, syncedAt: string): Promise<void> {
  const { error } = await db()
    .from("items")
    .update({ work_at: workAt, synced_at: syncedAt })
    .eq("id", itemId);
  if (error) throw new Error(`setDates failed: ${error.message}`);
}

async function episodeRows(teamId: string, itemId: string) {
  const { data } = await db()
    .from("graph_episodes")
    .select("group_id, deferred, content_sha256, pending_delete_group_id")
    .eq("team_id", teamId)
    .eq("source_id", itemId);
  return (data ?? []) as { group_id: string; deferred: boolean; content_sha256: string; pending_delete_group_id: string | null }[];
}

/**
 * The discriminating pair. A is OLD work but FRESHLY synced; B is RECENT work but STALELY synced.
 * Chosen so a gate on `synced_at` — the axis this slice exists to move off — gets BOTH arms
 * backwards, not just one: it would admit A and hold B.
 */
async function seedPair(seed: Awaited<ReturnType<typeof seedTeam>>) {
  const a = await ingest(seed, { kind: "deliverable", path: "old/a.md", body: "old work, synced today", access: "team" });
  const b = await ingest(seed, { kind: "deliverable", path: "new/b.md", body: "recent work, synced long ago", access: "team" });
  await setDates(a.id, iso(90 * DAY), iso(1000));       // work_at OLD, synced_at NOW
  await setDates(b.id, iso(1000), iso(90 * DAY));       // work_at RECENT, synced_at OLD
  return { a: a.id, b: b.id };
}

describe("STGENV-3 — the work_at window holds the push (C18, C21)", () => {
  it("C18: holds the old-work item and projects the recent one, driven end to end", async () => {
    const seed = await seedTeam();
    const { a, b } = await seedPair(seed);
    const fake = new FakeGraphiti();

    const first = await runGraphProjection({
      teamId: seed.teamId,
      client: client(fake),
      db: db(),
      stagingMarker: async () => true,
      windowDays: "30",
    });

    expect(first.ok, first.errors.join("; ")).toBe(true);
    expect(first.windowHeld).toBe(1);
    // A is HELD: not pushed, and — the part a gate placed after the reservation INSERT would fail —
    // it leaves NO ledger row at all. A `''` sentinel there is silently skipped by reconcile as
    // "never pushed", and it makes `existingRow` non-null next pass, so the item would then push.
    expect(await episodeRows(seed.teamId, a)).toEqual([]);
    expect(await episodeRows(seed.teamId, b)).toHaveLength(1);

    // C18 pass 2: the hold is DURABLE, not a one-pass accident.
    const second = await runGraphProjection({
      teamId: seed.teamId,
      client: client(fake),
      db: db(),
      stagingMarker: async () => true,
      windowDays: "30",
    });
    expect(second.windowHeld).toBe(1);
    expect(await episodeRows(seed.teamId, a)).toEqual([]);
  });

  it("C21: with NO window and NO marker both are projected — production, unchanged", async () => {
    const seed = await seedTeam();
    const { a, b } = await seedPair(seed);
    const fake = new FakeGraphiti();

    const res = await runGraphProjection({
      teamId: seed.teamId,
      client: client(fake),
      db: db(),
      stagingMarker: async () => false,
      windowDays: undefined,
    });

    expect(res.ok, res.errors.join("; ")).toBe(true);
    expect(res.windowHeld).toBe(0);
    expect(await episodeRows(seed.teamId, a)).toHaveLength(1);
    expect(await episodeRows(seed.teamId, b)).toHaveLength(1);
  });

  it("C22: on a completed pass, scanned === projected + skipped + windowHeld", async () => {
    // A coverage tool, not an invariant: it does NOT hold on an aborted pass, because
    // `partialSummary()` reports the whole fetched page while the counters stop at the aborting row.
    const seed = await seedTeam();
    await seedPair(seed);
    const fake = new FakeGraphiti();
    const s = await projectItemsToGraph(db(), {
      teamId: seed.teamId,
      teamSlug: seed.teamSlug,
      client: client(fake),
      workAtFloor: iso(30 * DAY),
    });
    expect(s.windowHeld).toBeGreaterThan(0);
    expect(s.scanned).toBe(s.projected + s.skipped + s.windowHeld);
  });

  it("C18: the ORPHAN arm — a row in no recognised group must not admit a held item", async () => {
    // The one fixture inside D3e's permitted state space where the two candidate discriminators
    // disagree. An orphan row (a deleted initiative's group, or an old-slug home residual) is
    // `deferred = false` and matches neither home candidate, so `existingRow` is null while
    // `rowsForItem.length === 1`. Keying the hold on "no ledger row at all" would ADMIT this item and
    // push it. D3e permits this state by design — it is not a fan-out surface — so the hold has to
    // survive it. Without this arm the empty-ledger fixtures above cannot tell the two apart.
    const seed = await seedTeam();
    const o = await ingest(seed, { kind: "deliverable", path: "old/orphan.md", body: "old work with an orphan row", access: "team" });
    await setDates(o.id, iso(90 * DAY), iso(1000));
    const { error } = await db().from("graph_episodes").insert({
      team_id: seed.teamId,
      source_table: "items",
      source_id: o.id,
      group_id: "t_deleted_initiative_abcdef",
      content_sha256: "deadbeef",
      chunk_shas: [],
      deferred: false,
    });
    if (error) throw new Error(`orphan seed failed: ${error.message}`);

    const res = await runGraphProjection({
      teamId: seed.teamId,
      client: client(new FakeGraphiti()),
      db: db(),
      stagingMarker: async () => true,
      windowDays: "30",
    });

    expect(res.ok, res.errors.join("; ")).toBe(true);
    expect(res.windowHeld).toBe(1);
    // Still exactly the orphan row: nothing was pushed into a home group.
    const rows = await episodeRows(seed.teamId, o.id);
    expect(rows.map((r) => r.group_id)).toEqual(["t_deleted_initiative_abcdef"]);
  });
});

describe("STGENV-3 — D3e refuses rather than gates (C19)", () => {
  const runWith = async (teamId: string, windowDays: string | undefined) =>
    runGraphProjection({
      teamId,
      client: client(new FakeGraphiti()),
      db: db(),
      stagingMarker: async () => true,
      windowDays,
    });

  it("C19 (a): a pointed initiative REFUSES the run", async () => {
    const seed = await seedTeam();
    await seedPair(seed);
    const { error } = await db().from("projects").insert({
      team_id: seed.teamId,
      slug: "an-initiative",
      name: "An initiative",
      kind: "initiative",
      graph_group_id: "t_init_abcdef",
    });
    if (error) throw new Error(`initiative seed failed: ${error.message}`);

    const res = await runWith(seed.teamId, "30");
    expect(res.ok).toBe(false);
    expect(res.refused).toBe("window-with-fanout");
    expect(res.errors.join(" ")).toContain("GRAPH_PROJECT_WINDOW_DAYS");
  });

  it("C19 (b): a DEFERRED ledger row alone REFUSES, with no initiative anywhere", async () => {
    // Without this arm, an implementation that checks only initiatives passes every other assertion
    // in this file — the two OR terms would never be tested apart.
    const seed = await seedTeam();
    const { a } = await seedPair(seed);
    const { error } = await db().from("graph_episodes").insert({
      team_id: seed.teamId,
      source_table: "items",
      source_id: a,
      group_id: "t_orphan_deferred",
      content_sha256: "",
      chunk_shas: [],
      deferred: true,
    });
    if (error) throw new Error(`deferred seed failed: ${error.message}`);

    const res = await runWith(seed.teamId, "30");
    expect(res.ok).toBe(false);
    expect(res.refused).toBe("window-with-fanout");
  });

  it("C19 (negative): no initiative AND no deferred row PROCEEDS bounded", async () => {
    // The fixture must explicitly contain no deferred rows: "no initiative" alone does not establish
    // permission to proceed, and a negative arm that only removes one term proves only one term.
    const seed = await seedTeam();
    await seedPair(seed);
    const res = await runWith(seed.teamId, "30");
    expect(res.ok, res.errors.join("; ")).toBe(true);
    expect(res.refused).toBeUndefined();
    expect(res.windowHeld).toBe(1);
  });

  it("C19 (no window): the detection is not issued AT ALL", async () => {
    // Not merely "does not refuse" — a windowless production instance must be byte-identical, so the
    // observable is the ABSENCE of the detection. Watched on an injected seam rather than on table
    // names: `projects` is read by the projector's own pointer lookup on every page, so a table spy
    // can never express this criterion. (That is exactly what the first version of this test got
    // wrong — it asserted an observable the code does not have.)
    const seed = await seedTeam();
    await seedPair(seed);
    const fanoutSurface = vi.fn(async () => ({ ok: true as const, present: false }));

    const off = await runGraphProjection({
      teamId: seed.teamId,
      client: client(new FakeGraphiti()),
      db: db(),
      stagingMarker: async () => false,
      windowDays: undefined,
      fanoutSurface,
    });
    expect(off.ok, off.errors.join("; ")).toBe(true);
    expect(fanoutSurface).not.toHaveBeenCalled();

    // ...and the SAME run with a window does issue it — a negative control, so "never called" cannot
    // pass merely because the seam was never wired in.
    const on = await runGraphProjection({
      teamId: seed.teamId,
      client: client(new FakeGraphiti()),
      db: db(),
      stagingMarker: async () => false,
      windowDays: "30",
      fanoutSurface,
    });
    expect(on.ok, on.errors.join("; ")).toBe(true);
    expect(fanoutSurface).toHaveBeenCalledWith(seed.teamId);
  });

  it("C19 (throw): a detection read that FAILS refuses, preserving the error", async () => {
    // An unsuccessful read cannot mean "no fan-out" — that would convert a database blip into the
    // extraction this exists to prevent.
    const seed = await seedTeam();
    await seedPair(seed);
    const res = await runGraphProjection({
      teamId: seed.teamId,
      client: client(new FakeGraphiti()),
      db: db(),
      stagingMarker: async () => true,
      windowDays: "30",
      fanoutSurface: async () => ({ ok: false as const, error: "relation projects does not exist" }),
    });
    expect(res.ok).toBe(false);
    // A DISTINCT reason from the surface-exists case: an operator told "unset the window" when the
    // real problem is an unreadable `projects` table fixes the wrong thing.
    expect(res.refused).toBe("fanout-state-unknown");
    expect(res.errors.join(" ")).toContain("relation projects does not exist");
  });

});

describe("STGENV-3 — the real detector (C24)", () => {
  it("C24: reads TRUE with staging_marker present and FALSE without", async () => {
    // The one thing the unit tier cannot prove: that the actual `to_regclass` SQL answers correctly.
    // The table is dropped in `finally` — the dm harness truncates ROWS, not DDL, so a leaked marker
    // would turn every later projector dm test into a refusal that reads like a product bug.
    expect(await readStagingMarker()).toBe(false);
    try {
      await runSql("create table if not exists public.staging_marker (note text)", []);
      expect(await readStagingMarker()).toBe(true);
    } finally {
      await runSql("drop table if exists public.staging_marker", []);
    }
    expect(await readStagingMarker()).toBe(false);
  });
});

describe("STGENV-3 — repair survives the window, and the counter survives an abort (C20, C23)", () => {
  it("C20: an OUT-OF-WINDOW item with a home row still gets its tier-change cleanup", async () => {
    // The property a SELECTION filter would have broken. An item excluded from the query is also
    // excluded from the tier-move branch, so its flip never records a pending delete and reconcile has
    // nothing to retry — the old tier stays searchable forever (the leak B2 closes). Run independently
    // of C18, so a mutation that reddens C18 cannot be mistaken for proving this.
    const seed = await seedTeam();
    const item = await ingest(seed, { kind: "deliverable", path: "old/flip.md", body: "old work that flips tier", access: "external" });
    const fake = new FakeGraphiti();

    // Project it while it is still in window, so it acquires a HOME row.
    await setDates(item.id, iso(1000), iso(1000));
    const first = await runGraphProjection({
      teamId: seed.teamId, client: client(fake), db: db(), stagingMarker: async () => false, windowDays: undefined,
    });
    expect(first.ok, first.errors.join("; ")).toBe(true);
    const before = await episodeRows(seed.teamId, item.id);
    expect(before).toHaveLength(1);
    const oldGroup = before[0].group_id;

    // Now age it OUT of the window and flip its tier.
    await setDates(item.id, iso(90 * DAY), iso(1000));
    const { error } = await db().from("items").update({ access: "team" }).eq("id", item.id);
    if (error) throw new Error(`tier flip failed: ${error.message}`);

    const second = await runGraphProjection({
      teamId: seed.teamId, client: client(fake), db: db(), stagingMarker: async () => true, windowDays: "30",
    });
    expect(second.ok, second.errors.join("; ")).toBe(true);
    // The item has a home row, so it is NOT held — and the durable move lands: the row moves to the
    // NEW group with `pending_delete_group_id` naming the OLD one. (Asserted in that shape: there is
    // no surviving old-group row to look for.)
    const after = await episodeRows(seed.teamId, item.id);
    expect(after).toHaveLength(1);
    expect(after[0].group_id).not.toBe(oldGroup);
    expect(after[0].pending_delete_group_id).toBe(oldGroup);
  });

  it("C23: an ABORTED pass still reports what the window held", async () => {
    // Ordered the OPPOSITE way to C18's pair: the HELD item must be processed FIRST (rows are ordered
    // by `synced_at` ascending), then the pushing item throws. Without a staged abort, dropping
    // `windowHeld` from `partialSummary()` or from the abort merge is unobservable.
    const seed = await seedTeam();
    const held = await ingest(seed, { kind: "deliverable", path: "old/held.md", body: "old work, held", access: "team" });
    const boom = await ingest(seed, { kind: "deliverable", path: "new/boom.md", body: "recent work, push explodes", access: "team" });
    await setDates(held.id, iso(90 * DAY), iso(90 * DAY)); // processed FIRST
    await setDates(boom.id, iso(1000), iso(1000));

    const fake = new FakeGraphiti();
    fake.addEpisodes = async () => {
      throw new Error("simulated Graphiti outage");
    };

    const res = await runGraphProjection({
      teamId: seed.teamId, client: client(fake), db: db(), stagingMarker: async () => true, windowDays: "30",
    });

    expect(res.ok).toBe(false);
    expect(res.errors.join(" ")).toContain("simulated Graphiti outage");
    // The abort merge carried it. A bounded run that aborts must not look like it did nothing.
    expect(res.windowHeld).toBe(1);
  });
});

describe("STGENV-3 — the floor reaches EVERY page (C11)", () => {
  it("C11: holds an item that lands on a LATER page, driven through runGraphProjection", async () => {
    // The failure every other criterion stays green through, and it had no test until the pre-push
    // review found it: forward `workAtFloor` on the first page only (or hoist page-1 args and reuse
    // them) and page 1 holds correctly while every later page projects unbounded — on staging that is
    // ~3,000 of 3,049 rows extracting, the ~$190 this slice exists to prevent, with C2/C6/C18 green.
    //
    // Rows page by `synced_at` ASCENDING, so the HELD item is given the NEWEST `synced_at` and lands
    // last. `limit: 1` forces one row per page. A single-page fixture cannot express this at all.
    const seed = await seedTeam();
    const early1 = await ingest(seed, { kind: "deliverable", path: "p/1.md", body: "in window, page one", access: "team" });
    const early2 = await ingest(seed, { kind: "deliverable", path: "p/2.md", body: "in window, page two", access: "team" });
    const late = await ingest(seed, { kind: "deliverable", path: "p/3.md", body: "OLD work, last page", access: "team" });
    await setDates(early1.id, iso(1000), iso(90 * DAY));
    await setDates(early2.id, iso(1000), iso(60 * DAY));
    await setDates(late.id, iso(90 * DAY), iso(1000)); // old work_at, NEWEST synced_at ⇒ final page

    const res = await runGraphProjection({
      teamId: seed.teamId,
      client: client(new FakeGraphiti()),
      db: db(),
      stagingMarker: async () => true,
      windowDays: "30",
      limit: 1,
    });

    expect(res.ok, res.errors.join("; ")).toBe(true);
    // Proof the walk actually paged — otherwise the fixture degenerates to the single-page case and
    // the criterion is vacuous again.
    expect(res.scanned).toBeGreaterThan(1);
    expect(res.windowHeld).toBe(1);
    expect(await episodeRows(seed.teamId, late.id)).toEqual([]);
    expect(await episodeRows(seed.teamId, early1.id)).toHaveLength(1);
    expect(await episodeRows(seed.teamId, early2.id)).toHaveLength(1);
  });
});
