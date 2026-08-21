import { describe, expect, it } from "vitest";
import type { GraphEpisode } from "@/lib/graph/graphiti-client";
import { projectItemsToGraph } from "@/lib/graph/project";
import { reconcileProjectedEpisodes, LANDED_SCAN_DEPTH } from "@/lib/graph/reconcile";
import type { EpisodeLookup, EpisodeRefLite } from "@/lib/graph/episode-lookup";
import { db, ingest, seedTeam } from "./helpers";
import { FakeGraphiti, client } from "./fake-graphiti";

// GRAPHSAT-2 ACs (docs/design/graphsat2-consecutive-absence.md §3): on the lookup path a never-landed
// row is proven LOST — and re-queued when the flag is on — iff it is older than the newest PRESENT
// landing by more than the margin (graphiti's worker is one serial FIFO that drops, never re-queues).
// Newer rows may still be queued: held. Anchors come from every present row, fresh or mature; both
// paths' decisions replay through one ordered tape.

const MARGIN = 10 * 60_000;
const H = 3_600_000;
function ep(name: string): GraphEpisode {
  return { content: "x", timestamp: "2020-01-01T00:00:00Z", sourceDescription: "x", name };
}
async function teamSlugFor(teamId: string): Promise<string> {
  const { data } = await db().from("teams").select("slug").eq("id", teamId).maybeSingle();
  return (data as { slug: string }).slug;
}
function lookupFromFake(fake: FakeGraphiti): EpisodeLookup {
  return async (groupId, itemIds) => {
    const stems = new Set(itemIds.map((id) => `items:${id}`));
    const out: EpisodeRefLite[] = [];
    for (const ref of fake.store.get(groupId)?.values() ?? []) {
      if (ref.name.startsWith("items:") && stems.has(ref.name.split("#")[0])) out.push({ uuid: ref.uuid, name: ref.name });
    }
    return out;
  };
}
async function row(teamId: string, itemId: string) {
  const { data } = await db().from("graph_episodes").select("content_sha256, first_seen_at, episode_uuid").eq("team_id", teamId).eq("source_id", itemId).single();
  return data as { content_sha256: string; first_seen_at: string; episode_uuid: string | null };
}
/** Stamp a row as a FIRST push `agoMs` ago: projected_at and first_seen_at a second apart (the reservation
 *  precedes the push), uuid cleared so backfill is observable. `firstSeenAgoMs` overrides first_seen_at for
 *  rows that must read as RE-pushes (created long before their latest push). */
async function stamp(teamId: string, itemId: string, agoMs: number, firstSeenAgoMs = agoMs + 1_000) {
  await db().from("graph_episodes").update({
    projected_at: new Date(Date.now() - agoMs).toISOString(),
    first_seen_at: new Date(Date.now() - firstSeenAgoMs).toISOString(),
    episode_uuid: null,
  }).eq("team_id", teamId).eq("source_id", itemId);
}
async function removeFromGraph(fake: FakeGraphiti, groupId: string, itemId: string) {
  const g = fake.store.get(groupId);
  for (const [uuid, ref] of g ?? []) if (ref.name === `items:${itemId}` || ref.name.startsWith(`items:${itemId}#`)) g!.delete(uuid);
}

/** items: `landed` (present), `old` (absent, projected 3 days ago), `fresh` (absent, projected 30 min ago). */
async function fixture() {
  const seed = await seedTeam();
  const slug = await teamSlugFor(seed.teamId);
  const teamGroup = `${slug}_team`;
  const ids: Record<string, string> = {};
  for (const k of ["landed", "old", "fresh"]) ids[k] = (await ingest(seed, { kind: "deliverable", path: `docs/${k}.md`, body: `${k} doc`, access: "team" })).id;
  const fake = new FakeGraphiti();
  await projectItemsToGraph(db(), { teamId: seed.teamId, teamSlug: slug, client: client(fake) });
  await removeFromGraph(fake, teamGroup, ids.old);
  await removeFromGraph(fake, teamGroup, ids.fresh);
  await stamp(seed.teamId, ids.landed, 2 * H);   // landed 2h ago (mature, present)
  await stamp(seed.teamId, ids.old, 72 * H);     // absent, 3 days old → older than the landing by ≫ margin
  await stamp(seed.teamId, ids.fresh, 2 * H - 60_000); // absent, 1 min NEWER than the landing → not proven lost (and past the grace)
  await fake.addEpisodes(teamGroup, Array.from({ length: LANDED_SCAN_DEPTH }, (_, i) => ep(`items:filler-${i}`)));
  return { seed, slug, teamGroup, fake, ids };
}
type F = Awaited<ReturnType<typeof fixture>>;
const rec = (f: F, opts: Record<string, unknown> = {}) => reconcileProjectedEpisodes(db(), client(f.fake), f.seed.teamId, { lookup: lookupFromFake(f.fake), deepRequeue: true, watermarkMarginMs: MARGIN, ...opts });

describe("GRAPHSAT-2 — the landed watermark (real Postgres, mocked Graphiti, injected lookup)", () => {
  it("AC1(a) flag ON: the row older than the newest landing is RE-QUEUED (first_seen_at preserved); the newer one is HELD; requeueEligible 1, deepRequeueHeld 1", async () => {
    const f = await fixture();
    const before = await row(f.seed.teamId, f.ids.old);
    const r = await rec(f);
    expect(r.deepResolvedGroups).toBe(1);
    expect(r.requeueEligible).toBe(1);
    expect(r.reQueued).toBe(1);
    expect(r.deepRequeueHeld).toBe(1);
    expect(r.deepRequeueSample.map((s) => s.itemId)).toEqual([f.ids.fresh]);
    const old = await row(f.seed.teamId, f.ids.old);
    expect(old.content_sha256).toBe("");
    expect(old.first_seen_at).toBe(before.first_seen_at);
    expect((await row(f.seed.teamId, f.ids.fresh)).content_sha256).not.toBe("");
    expect((await row(f.seed.teamId, f.ids.landed)).episode_uuid).toMatch(/^fake-uuid-/); // confirmed + backfilled
  });

  it("AC1(b) flag OFF: both HELD, requeueEligible 1 still reported (the count is the evidence the human reads)", async () => {
    const f = await fixture();
    const r = await rec(f, { deepRequeue: false });
    expect(r.requeueEligible).toBe(1);
    expect(r.reQueued).toBe(0);
    expect(r.deepRequeueHeld).toBe(2);
    expect((await row(f.seed.teamId, f.ids.old)).content_sha256).not.toBe("");
  });

  it("AC1(c) no present row anywhere → no watermark → everything HELD, requeueEligible 0", async () => {
    const f = await fixture();
    await removeFromGraph(f.fake, f.teamGroup, f.ids.landed);
    const r = await rec(f);
    expect(r.requeueEligible).toBe(0);
    expect(r.reQueued).toBe(0);
    expect(r.deepRequeueHeld).toBe(3);
  });

  it("AC1(c2) a WIPED graph is the REST empty-listing path, not the watermark: emptyListingGroups fires and the bounded REST re-queue heals", async () => {
    const f = await fixture();
    f.fake.store.clear();
    const r = await rec(f, { maxRequeuePerPass: 2 });
    expect(r.emptyListingGroups).toBe(1);
    expect(r.deepResolvedGroups).toBe(0);
    expect(r.reQueued).toBe(2);
    expect(r.requeueThrottled).toBe(1);
  });

  it("AC1(c3) a FRESH landing (inside the grace) anchors the watermark but does not count as confirmed", async () => {
    const f = await fixture();
    await stamp(f.seed.teamId, f.ids.landed, 5 * 60_000); // landed 5 min ago — inside the 1h grace
    await stamp(f.seed.teamId, f.ids.fresh, 72 * H); // make both absent rows old
    const r = await rec(f);
    expect(r.confirmed, "the fresh landing is not confirmed (grace) …").toBe(0);
    expect(r.requeueEligible, "… but it anchors the watermark").toBe(2);
    expect(r.reQueued).toBe(2);
  });

  it("AC1(c4) a PARKED row on the lookup path is neither eligible, nor held, nor re-written across a second reconcile", async () => {
    const f = await fixture();
    await rec(f); // parks `old`
    const parked = await row(f.seed.teamId, f.ids.old);
    expect(parked.content_sha256).toBe("");
    const r2 = await rec(f);
    expect(r2.requeueEligible).toBe(0);
    expect(r2.reQueued).toBe(0);
    expect(r2.deepRequeueHeld, "only `fresh` is held; the parked row is invisible to the lookup path").toBe(1);
  });

  it("AC1(d) the watermark is TEAM-wide: a landing in the EXTERNAL group (REST-judged) proves General's old row lost", async () => {
    const f = await fixture();
    await removeFromGraph(f.fake, f.teamGroup, f.ids.landed); // no landing in General itself
    const ext = await ingest(f.seed, { kind: "deliverable", path: "docs/x.md", body: "external doc", access: "external" });
    await projectItemsToGraph(db(), { teamId: f.seed.teamId, teamSlug: f.slug, client: client(f.fake) });
    await stamp(f.seed.teamId, ext.id, 2 * H); // external landing 2h ago, present
    const r = await rec(f);
    expect(r.requeueEligible).toBe(1);
    expect(r.reQueued).toBe(1);
    expect((await row(f.seed.teamId, f.ids.old)).content_sha256).toBe("");
  });

  it("AC1(e) the margin: an absent row older than the newest landing by LESS than the margin is HELD", async () => {
    const f = await fixture();
    await stamp(f.seed.teamId, f.ids.old, 2 * H + MARGIN - 60_000); // 9 min older than the landing
    const r = await rec(f);
    expect(r.requeueEligible).toBe(0);
    expect(r.reQueued).toBe(0);
    await stamp(f.seed.teamId, f.ids.old, 2 * H + MARGIN + 60_000); // 11 min older
    const r2 = await rec(f);
    expect(r2.requeueEligible).toBe(1);
  });

  it("AC1(f) a re-queued row, re-pushed and landed, is an ordinary confirmed row with no residue", async () => {
    const f = await fixture();
    await rec(f); // parks `old`
    await projectItemsToGraph(db(), { teamId: f.seed.teamId, teamSlug: f.slug, client: client(f.fake) }); // re-push
    await stamp(f.seed.teamId, f.ids.old, 2 * H); // let it mature
    const r = await rec(f);
    expect(r.confirmed).toBeGreaterThanOrEqual(2);
    expect((await row(f.seed.teamId, f.ids.old)).content_sha256).not.toBe("");
    expect(r.requeueEligible).toBe(0);
  });

  it("AC1(g) an UNREACHABLE listing pass and a MISMATCH pass form no verdicts and re-queue nothing", async () => {
    const f = await fixture();
    f.fake.failListFor.add(f.teamGroup);
    const r = await rec(f);
    expect(r.unreachableGroups).toBe(1);
    expect(r.requeueEligible).toBe(0);
    expect(r.reQueued).toBe(0);
    f.fake.failListFor.delete(f.teamGroup);
    // Mismatch: keep `landed` in the REST window but make the lookup return nothing.
    await f.fake.addEpisodes(f.teamGroup, [ep(`items:${f.ids.landed}`)]);
    const r2 = await rec(f, { lookup: async () => [] });
    expect(r2.lookupMismatchGroups).toBe(1);
    expect(r2.requeueEligible).toBe(0);
    expect(r2.reQueued).toBe(0);
  });

  it("AC1(g2) ORDER: with one throttle slot, a REST-path absent row traversed FIRST takes it; the lookup-eligible row is throttled, not reordered ahead", async () => {
    // Build the REST group FIRST so its ledger rows precede the team group's in traversal order.
    const seed = await seedTeam();
    const slug = await teamSlugFor(seed.teamId);
    const fake = new FakeGraphiti();
    const ext = await ingest(seed, { kind: "deliverable", path: "docs/x.md", body: "external doc", access: "external" });
    await projectItemsToGraph(db(), { teamId: seed.teamId, teamSlug: slug, client: client(fake) });
    const teamIds: string[] = [];
    for (const k of ["landed", "old"]) teamIds.push((await ingest(seed, { kind: "deliverable", path: `docs/${k}.md`, body: `${k} doc`, access: "team" })).id);
    await projectItemsToGraph(db(), { teamId: seed.teamId, teamSlug: slug, client: client(fake) });
    const teamGroup = `${slug}_team`;
    await removeFromGraph(fake, `${slug}_external`, ext.id); // REST-path absent row
    await removeFromGraph(fake, teamGroup, teamIds[1]); // lookup-path absent row
    await stamp(seed.teamId, ext.id, 72 * H);
    await stamp(seed.teamId, teamIds[0], 2 * H);
    await stamp(seed.teamId, teamIds[1], 72 * H);
    await fake.addEpisodes(teamGroup, Array.from({ length: LANDED_SCAN_DEPTH }, (_, i) => ep(`items:filler-${i}`)));
    const r = await reconcileProjectedEpisodes(db(), client(fake), seed.teamId, { lookup: lookupFromFake(fake), deepRequeue: true, watermarkMarginMs: MARGIN, maxRequeuePerPass: 1 });
    expect(r.groupsChecked).toBe(2);
    expect(r.reQueued).toBe(1);
    expect(r.requeueThrottled).toBe(1);
    expect((await row(seed.teamId, ext.id)).content_sha256, "the REST row, traversed first, took the one slot").toBe("");
    expect((await row(seed.teamId, teamIds[1])).content_sha256, "the lookup-eligible row was throttled, not moved ahead").not.toBe("");
  });

  it("AC1(i) THE BLOCKER: an EDITED retaining item (old episodes present, new push still queued) does NOT anchor — a queued row newer than the real landing stays HELD", async () => {
    const f = await fixture();
    // `landed` is re-pushed 5 min ago (stamp fresh) but was CREATED 2 days ago: its presence is its OLD
    // episodes; its new push is queued. `fresh` (absent, projected 2h−1min ago) is a queued row that a
    // naive "newest present stamp" watermark (5 min) would have judged lost.
    await stamp(f.seed.teamId, f.ids.landed, 5 * 60_000, 48 * H);
    const r = await rec(f);
    // The only first-push anchor left is none (landed is a re-push) → no watermark → `old` held too.
    expect(r.requeueEligible, "no first-push anchor → nothing proven lost").toBe(0);
    expect(r.reQueued).toBe(0);
    expect((await row(f.seed.teamId, f.ids.fresh)).content_sha256).not.toBe("");
    // Add a genuine FIRST push that landed 2h ago → `old` (3 days) is proven lost, `fresh` (2h−1min) is not.
    const anchor = await ingest(f.seed, { kind: "deliverable", path: "docs/anchor.md", body: "anchor doc", access: "team" });
    await projectItemsToGraph(db(), { teamId: f.seed.teamId, teamSlug: f.slug, client: client(f.fake) });
    await stamp(f.seed.teamId, anchor.id, 2 * H);
    const r2 = await rec(f);
    expect(r2.requeueEligible).toBe(1);
    expect((await row(f.seed.teamId, f.ids.old)).content_sha256).toBe("");
    expect((await row(f.seed.teamId, f.ids.fresh)).content_sha256).not.toBe("");
  });

  it("AC1(j) a TOMBSTONED-but-still-present row ('' + pending flag after a failed delete) does not anchor", async () => {
    const f = await fixture();
    // A row CREATED and tombstoned within the slack (a just-ingested item purged before its delete
    // succeeded): only the sha/pending guard stands between it and anchoring.
    const now = new Date().toISOString();
    await db().from("graph_episodes").update({ content_sha256: "", pending_delete_group_id: f.teamGroup, pending_delete_at: now, projected_at: now, first_seen_at: now }).eq("team_id", f.seed.teamId).eq("source_id", f.ids.landed);
    const r = await rec(f);
    expect(r.requeueEligible, "the tombstone's fresh stamp must not anchor").toBe(0);
    expect(r.reQueued).toBe(0);
  });

  it("AC1(h) REST-path (small group) re-queue is today's: past the grace, absent → re-queued regardless of any watermark", async () => {
    const seed = await seedTeam();
    const slug = await teamSlugFor(seed.teamId);
    const item = await ingest(seed, { kind: "deliverable", path: "docs/a.md", body: "a", access: "team" });
    const fake = new FakeGraphiti();
    await projectItemsToGraph(db(), { teamId: seed.teamId, teamSlug: slug, client: client(fake) });
    await removeFromGraph(fake, `${slug}_team`, item.id);
    await stamp(seed.teamId, item.id, 2 * H);
    const r = await reconcileProjectedEpisodes(db(), client(fake), seed.teamId, { lookup: async () => null, deepRequeue: false });
    expect(r.deepResolvedGroups).toBe(0);
    expect(r.reQueued).toBe(1);
    expect(r.requeueEligible).toBe(0);
  });
});
