import { describe, expect, it } from "vitest";
import type { GraphEpisode } from "@/lib/graph/graphiti-client";
import { projectItemsToGraph } from "@/lib/graph/project";
import { reconcileProjectedEpisodes, LANDED_SCAN_DEPTH, type DeepRequeueRef } from "@/lib/graph/reconcile";
import { runGraphProjection } from "@/lib/graph/run";
import { projectionRunInput, shouldRecordProjectionRun } from "@/lib/graph/projection-run";
import { recordIngestRun } from "@/lib/ingest/runs";
import type { EpisodeLookup, EpisodeRefLite } from "@/lib/graph/episode-lookup";
import { db, ingest, seedTeam, type Seed } from "./helpers";
import { FakeGraphiti, client } from "./fake-graphiti";

// GRAPHSAT-1 ACs (docs/design/graphsat1-saturated-group-healing.md §3): a group past the REST window
// is JUDGED through the per-ITEM lookup (injected here; the real Cypher is proven in the test:neo4j
// tier) on the SAME downstream code as the REST path; never-landed verdicts on that path are HELD
// unless re-queue is on (measurement mode); every lookup failure degrades to today's skip-and-count.

function ep(name: string): GraphEpisode {
  return { content: "x", timestamp: "2020-01-01T00:00:00Z", sourceDescription: "x", name };
}

/** A lookup backed by the fake's store — the production Cypher's contract (group-scoped, exact
 *  item STEM match, every present chunk) expressed over the double. */
function lookupFromFake(fake: FakeGraphiti, calls?: { groupId: string; itemIds: string[] }[]): EpisodeLookup {
  return async (groupId, itemIds) => {
    calls?.push({ groupId, itemIds: [...itemIds] });
    const stems = new Set(itemIds.map((id) => `items:${id}`));
    const out: EpisodeRefLite[] = [];
    for (const ref of fake.store.get(groupId)?.values() ?? []) {
      if (ref.name.startsWith("items:") && stems.has(ref.name.split("#")[0])) out.push({ uuid: ref.uuid, name: ref.name });
    }
    return out;
  };
}

async function teamSlugFor(teamId: string): Promise<string> {
  const { data } = await db().from("teams").select("slug").eq("id", teamId).maybeSingle();
  return (data as { slug: string }).slug;
}

async function ledgerRow(teamId: string, itemId: string) {
  const { data } = await db()
    .from("graph_episodes")
    .select("id, content_sha256, episode_uuid, chunk_shas, first_seen_at, projected_at")
    .eq("team_id", teamId)
    .eq("source_id", itemId)
    .single();
  return data as { id: string; content_sha256: string; episode_uuid: string | null; chunk_shas: string[]; first_seen_at: string; projected_at: string };
}

/** Replace an item's episodes in the fake's group store with the given names (simulating what the
 *  graph actually holds for it), leaving the ledger row as projected. */
async function setGraphEpisodes(fake: FakeGraphiti, groupId: string, itemId: string, names: string[]): Promise<void> {
  const group = fake.store.get(groupId);
  for (const [uuid, ref] of group ?? []) {
    if (ref.name === `items:${itemId}` || ref.name.startsWith(`items:${itemId}#`)) group!.delete(uuid);
  }
  if (names.length) await fake.addEpisodes(groupId, names.map(ep));
}

type Fixture = { seed: Seed; slug: string; teamGroup: string; fake: FakeGraphiti; ids: Record<"landed" | "shrink" | "grow" | "partial" | "never", string> };

/** Five ledger rows in one group, each in a distinct landed state, all past the landed grace. */
async function fixture(): Promise<Fixture> {
  const seed = await seedTeam();
  const slug = await teamSlugFor(seed.teamId);
  const teamGroup = `${slug}_team`;
  const ids = {} as Fixture["ids"];
  for (const k of ["landed", "shrink", "grow", "partial", "never"] as const) {
    const item = await ingest(seed, { kind: "deliverable", path: `docs/${k}.md`, body: `the ${k} doc`, access: "team" });
    ids[k] = item.id;
  }
  const fake = new FakeGraphiti();
  await projectItemsToGraph(db(), { teamId: seed.teamId, teamSlug: slug, client: client(fake) });
  // SHRINK 3→1: the ledger says one chunk (`items:x`), the graph holds only the legacy `#0..#2`.
  await setGraphEpisodes(fake, teamGroup, ids.shrink, [0, 1, 2].map((i) => `items:${ids.shrink}#${i}`));
  // GROW 1→3: the ledger says three chunks, the graph holds only the legacy bare name.
  await db().from("graph_episodes").update({ chunk_shas: ["a", "b", "c"] }).eq("team_id", seed.teamId).eq("source_id", ids.grow);
  // PARTIAL: three expected, `#2` missing.
  await db().from("graph_episodes").update({ chunk_shas: ["a", "b", "c"] }).eq("team_id", seed.teamId).eq("source_id", ids.partial);
  await setGraphEpisodes(fake, teamGroup, ids.partial, [`items:${ids.partial}#0`, `items:${ids.partial}#1`]);
  // NEVER LANDED: pushed (chunk ledger non-empty) but nothing in the graph.
  await setGraphEpisodes(fake, teamGroup, ids.never, []);
  // Past the landed grace; uuids cleared so the backfill is observable.
  await db().from("graph_episodes").update({ projected_at: "2020-01-01T00:00:00Z", episode_uuid: null }).eq("team_id", seed.teamId);
  return { seed, slug, teamGroup, fake, ids };
}

async function saturate(f: Fixture): Promise<void> {
  await f.fake.addEpisodes(f.teamGroup, Array.from({ length: LANDED_SCAN_DEPTH }, (_, i) => ep(`items:filler-${i}`)));
}

describe("GRAPHSAT-1 — the saturated group heals again (real Postgres, mocked Graphiti, injected lookup)", () => {
  it("AC1(a,b,c) a saturated group is JUDGED via the per-item lookup on the SAME downstream code: confirm + uuid backfill, shrink/grow/partial verdicts, never-landed HELD in measurement mode", async () => {
    const f = await fixture();
    // The REST verdict FIRST (unsaturated), so the deep pass can be held to it (the grow arm's claim).
    const rest = await reconcileProjectedEpisodes(db(), client(f.fake), f.seed.teamId, { lookup: async () => { throw new Error("must not be called when unsaturated"); } });
    expect(rest.deepResolvedGroups).toBe(0);
    expect(rest.confirmed).toBe(4); // landed, shrink, grow, partial
    expect(rest.partialItems).toBe(1); // partial only — grow's all-missing is the documented under-count
    expect(rest.reQueued).toBe(1); // REST path re-queues `never` (no hold there — unchanged behaviour)
    // Reset what the REST pass wrote so the deep pass judges the same fixture. GRAPHSAT-2 D5: a row
    // PARKED ('') by the REST pass is invisible to the lookup path (it awaits its re-push), so `never`
    // gets its real sha back here to be judged as a never-landed row again.
    await db().from("graph_episodes").update({ projected_at: "2020-01-01T00:00:00Z", episode_uuid: null }).eq("team_id", f.seed.teamId);
    expect((await ledgerRow(f.seed.teamId, f.ids.never)).content_sha256).toBe(""); // parked by the REST pass
    await db().from("graph_episodes").update({ content_sha256: "real" }).eq("team_id", f.seed.teamId).eq("source_id", f.ids.never);

    await saturate(f);
    const calls: { groupId: string; itemIds: string[] }[] = [];
    const deep = await reconcileProjectedEpisodes(db(), client(f.fake), f.seed.teamId, { lookup: lookupFromFake(f.fake, calls), deepRequeue: false });
    expect(deep.saturatedGroups, "judged, not skipped").toBe(0);
    expect(deep.deepResolvedGroups).toBe(1);
    expect(deep.deepRequeueEnabled).toBe(false);
    // Same verdicts as REST for everything REST could judge:
    expect(deep.confirmed).toBe(rest.confirmed);
    expect(deep.partialItems).toBe(rest.partialItems);
    expect(deep.partialDetail.sample.map((s) => s.itemId)).toEqual([f.ids.partial]);
    expect(deep.partialDetail.sample[0].missing).toEqual([`items:${f.ids.partial}#2`]);
    // uuid backfilled for a confirmed row:
    expect((await ledgerRow(f.seed.teamId, f.ids.landed)).episode_uuid).toMatch(/^fake-uuid-/);
    expect((await ledgerRow(f.seed.teamId, f.ids.shrink)).episode_uuid).toMatch(/^fake-uuid-/);
    // never-landed is HELD: counted, sampled with a STRUCTURED identity, NOT re-queued.
    expect(deep.reQueued).toBe(0);
    expect(deep.deepRequeueHeld).toBe(1);
    expect(deep.deepRequeueHeldByGroup).toEqual({ [f.teamGroup]: 1 });
    expect(deep.deepRequeueSample).toEqual([
      { teamId: f.seed.teamId, groupId: f.teamGroup, itemId: f.ids.never, projectedAt: expect.any(String) } satisfies DeepRequeueRef,
    ]);
    expect(deep.requeueThrottled, "held rows consume no throttle budget").toBe(0);
    // D5: the lookup was called with the ledger's group and EXACTLY its item ids.
    expect(calls).toHaveLength(1);
    expect(calls[0].groupId).toBe(f.teamGroup);
    expect([...calls[0].itemIds].sort()).toEqual(Object.values(f.ids).sort());
  });

  it("AC1(d) with deepRequeue ON the held row is re-queued: sentinel written, first_seen_at preserved (STALLSCOPE-1)", async () => {
    const f = await fixture();
    await saturate(f);
    // Give `never` a real sha so the re-queue is observable as a write — and (GRAPHSAT-2) make it OLDER
    // than the landed rows by more than the watermark margin, so the queue is proven to have passed it.
    await db().from("graph_episodes").update({ content_sha256: "real", projected_at: "2019-01-01T00:00:00Z" }).eq("team_id", f.seed.teamId).eq("source_id", f.ids.never);
    const before = await ledgerRow(f.seed.teamId, f.ids.never);
    const res = await reconcileProjectedEpisodes(db(), client(f.fake), f.seed.teamId, { lookup: lookupFromFake(f.fake), deepRequeue: true });
    expect(res.deepRequeueEnabled).toBe(true);
    expect(res.deepResolvedGroups).toBe(1);
    expect(res.reQueued).toBe(1);
    expect(res.deepRequeueHeld).toBe(0);
    expect(res.deepRequeueSample).toEqual([]);
    const after = await ledgerRow(f.seed.teamId, f.ids.never);
    expect(after.content_sha256).toBe("");
    expect(after.id).toBe(before.id);
    expect(after.first_seen_at).toBe(before.first_seen_at);
  });

  it("AC1(e) D2: a lookup that is UNCONFIGURED (null) or that THROWS leaves the group unjudged — today's verdict, ledger untouched", async () => {
    const f = await fixture();
    await saturate(f);
    for (const lookup of [async () => null, async () => { throw new Error("bolt down"); }] as EpisodeLookup[]) {
      const res = await reconcileProjectedEpisodes(db(), client(f.fake), f.seed.teamId, { lookup, deepRequeue: true });
      expect(res.saturatedGroups).toBe(1);
      expect(res.deepResolvedGroups).toBe(0);
      expect(res.reQueued).toBe(0);
      expect(res.confirmed).toBe(0);
      expect(res.deepRequeueHeld).toBe(0);
      const never = await ledgerRow(f.seed.teamId, f.ids.never);
      expect(never.content_sha256).not.toBe(""); // not re-queued
      expect((await ledgerRow(f.seed.teamId, f.ids.landed)).episode_uuid).toBeNull(); // not backfilled
    }
  });

  it("AC1(f) a present episode for a DIFFERENT item stem does not confirm this one", async () => {
    const f = await fixture();
    await saturate(f);
    // The lookup returns the fake's real refs PLUS a ref whose stem is `items:<never-id>d` — a longer
    // id sharing the prefix. (Real refs included so the REST-window oracle below holds; the foreign
    // stem must not confirm `never`.)
    const real = lookupFromFake(f.fake);
    const lookup: EpisodeLookup = async (g, ids) => [...((await real(g, ids)) ?? []), { uuid: "u-other", name: `items:${f.ids.never}d` }];
    const res = await reconcileProjectedEpisodes(db(), client(f.fake), f.seed.teamId, { lookup, deepRequeue: false });
    expect(res.deepResolvedGroups).toBe(1);
    expect(res.confirmed).toBe(4);
    expect(res.deepRequeueHeld, "`never` stays held — not confirmed through the foreign stem").toBe(1);
  });

  it("AC1(g) THE REST-WINDOW ORACLE (Fable diff review M1): a reachable-but-WRONG graph (lookup returns nothing for items the REST window confirms) is degraded to unjudged — never 'everything never landed'", async () => {
    const f = await fixture();
    // Keep `landed` INSIDE the REST window by adding filler BEFORE it: saturate, then re-push landed so
    // it is among the newest 5,000 and REST confirms it.
    await saturate(f);
    await setGraphEpisodes(f.fake, f.teamGroup, f.ids.landed, [`items:${f.ids.landed}`]);
    const wrongGraph: EpisodeLookup = async () => []; // reachable, empty — the wrong-DB shape
    const res = await reconcileProjectedEpisodes(db(), client(f.fake), f.seed.teamId, { lookup: wrongGraph, deepRequeue: true });
    expect(res.lookupMismatchGroups).toBe(1);
    expect(res.saturatedGroups, "unjudged, counted").toBe(1);
    expect(res.deepResolvedGroups).toBe(0);
    expect(res.reQueued, "NOTHING re-pushed even with the flag ON").toBe(0);
    expect(res.confirmed).toBe(0);
    expect((await ledgerRow(f.seed.teamId, f.ids.never)).content_sha256).not.toBe("");
    // And a lookup that agrees with the window for `landed` but is silent about the rest is NOT
    // flagged (the oracle is a subset check, not equality): it judges, and holds the rest.
    const partialButConsistent: EpisodeLookup = async () => [{ uuid: "u-l", name: `items:${f.ids.landed}` }];
    const ok = await reconcileProjectedEpisodes(db(), client(f.fake), f.seed.teamId, { lookup: partialButConsistent, deepRequeue: false });
    expect(ok.lookupMismatchGroups).toBe(0);
    expect(ok.deepResolvedGroups).toBe(1);
    expect(ok.confirmed).toBe(1);
    expect(ok.deepRequeueHeld).toBe(4);
  });

  it("AC1(h) SIX stable never-landed rows are ALL enumerated in the durable sample (Codex diff review M2), oldest first, none elided", async () => {
    const seed = await seedTeam();
    const slug = await teamSlugFor(seed.teamId);
    const teamGroup = `${slug}_team`;
    const ids: string[] = [];
    for (let i = 0; i < 6; i++) ids.push((await ingest(seed, { kind: "deliverable", path: `docs/n${i}.md`, body: `never ${i}`, access: "team" })).id);
    const fake = new FakeGraphiti();
    await projectItemsToGraph(db(), { teamId: seed.teamId, teamSlug: slug, client: client(fake) });
    fake.store.clear(); // nothing landed
    for (let i = 0; i < 6; i++) {
      await db().from("graph_episodes").update({ projected_at: `2020-01-0${i + 1}T00:00:00Z` }).eq("team_id", seed.teamId).eq("source_id", ids[i]);
    }
    await fake.addEpisodes(teamGroup, Array.from({ length: LANDED_SCAN_DEPTH }, (_, i) => ep(`items:filler-${i}`)));
    const res = await reconcileProjectedEpisodes(db(), client(fake), seed.teamId, { lookup: lookupFromFake(fake), deepRequeue: false });
    expect(res.deepRequeueHeld).toBe(6);
    expect(res.deepRequeueElided).toBe(0);
    expect(res.deepRequeueSample.map((r) => r.itemId), "every identity, oldest first").toEqual(ids);
    // Through the runner + meta too (the surface the operator reads).
    const summary = await runGraphProjection({ teamId: seed.teamId, client: client(fake), lookup: lookupFromFake(fake), deepRequeue: false });
    expect(summary.deepRequeueSample.map((r) => r.itemId)).toEqual(ids);
    expect(summary.deepRequeueElided).toBe(0);
    expect(projectionRunInput(summary, "scheduler", 1, 2).meta).toMatchObject({ deepRequeueHeld: 6, deepRequeueElided: 0 });
  });

  it("AC4 (end to end) a held-only run reaches ingest_runs through the runner + the shared gate, with the structured sample in meta", async () => {
    const f = await fixture();
    await saturate(f);
    const summary = await runGraphProjection({ teamId: f.seed.teamId, client: client(f.fake), lookup: lookupFromFake(f.fake), deepRequeue: false });
    expect(summary.deepResolvedGroups).toBe(1);
    expect(summary.deepRequeueHeld).toBe(1);
    expect(summary.deepRequeueEnabled).toBe(false);
    expect(summary.deepRequeueSample[0]).toMatchObject({ teamId: f.seed.teamId, groupId: f.teamGroup, itemId: f.ids.never });
    expect(shouldRecordProjectionRun(summary), "held work is a gate signal").toBe(true);
    const startedAt = Date.now() - 5;
    await recordIngestRun(db(), projectionRunInput(summary, "scheduler", startedAt, Date.now()));
    // Select THIS run's row by its own identity (the held group), not "newest" — another worktree's
    // scheduler row on a shared container must not win (Fable diff review L2).
    const { data: rows } = await db()
      .from("ingest_runs")
      .select("meta")
      .eq("source", "graph_project")
      .gte("started_at", new Date(startedAt - 1).toISOString())
      .order("finished_at", { ascending: false })
      .limit(20);
    const mine = ((rows ?? []) as { meta: Record<string, unknown> }[]).find((r) => (r.meta.deepRequeueHeldByGroup as Record<string, number> | undefined)?.[f.teamGroup] === 1);
    expect(mine, "the held-only run's durable row exists").toBeTruthy();
    const meta = mine!.meta;
    expect(meta).toMatchObject({
      deepResolvedGroups: 1,
      deepRequeueHeld: 1,
      deepRequeueEnabled: false,
      deepRequeueHeldByGroup: { [f.teamGroup]: 1 },
    });
    expect((meta.deepRequeueSample as DeepRequeueRef[])[0]).toMatchObject({ itemId: f.ids.never, groupId: f.teamGroup });
  });
});
