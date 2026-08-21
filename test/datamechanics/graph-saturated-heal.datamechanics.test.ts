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
    // Reset what the REST pass wrote so the deep pass judges the same fixture.
    await db().from("graph_episodes").update({ projected_at: "2020-01-01T00:00:00Z", episode_uuid: null }).eq("team_id", f.seed.teamId);
    const neverRow = await ledgerRow(f.seed.teamId, f.ids.never);
    expect(neverRow.content_sha256).toBe(""); // parked by the REST pass; still judged never-landed (chunk ledger non-empty)

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
    // Give `never` a real sha so the re-queue is observable as a write.
    await db().from("graph_episodes").update({ content_sha256: "real" }).eq("team_id", f.seed.teamId).eq("source_id", f.ids.never);
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
    // The lookup returns a ref whose stem is `items:<never-id>d` — a longer id sharing the prefix.
    const lookup: EpisodeLookup = async () => [{ uuid: "u-other", name: `items:${f.ids.never}d` }];
    const res = await reconcileProjectedEpisodes(db(), client(f.fake), f.seed.teamId, { lookup, deepRequeue: false });
    expect(res.deepResolvedGroups).toBe(1);
    expect(res.confirmed).toBe(0);
    expect(res.deepRequeueHeld, "every row judged never-landed and held — none confirmed through the foreign stem").toBe(5);
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
    const { data } = await db()
      .from("ingest_runs")
      .select("meta")
      .eq("source", "graph_project")
      .gte("started_at", new Date(startedAt - 1).toISOString())
      .order("finished_at", { ascending: false })
      .limit(1)
      .single();
    const meta = (data as { meta: Record<string, unknown> }).meta;
    expect(meta).toMatchObject({
      deepResolvedGroups: 1,
      deepRequeueHeld: 1,
      deepRequeueEnabled: false,
      deepRequeueHeldByGroup: { [f.teamGroup]: 1 },
    });
    expect((meta.deepRequeueSample as DeepRequeueRef[])[0]).toMatchObject({ itemId: f.ids.never, groupId: f.teamGroup });
  });
});
