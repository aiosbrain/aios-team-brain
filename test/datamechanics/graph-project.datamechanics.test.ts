import { describe, expect, it } from "vitest";
import type { GraphitiClient, GraphEpisode, GraphEpisodeRef } from "@/lib/graph/graphiti-client";
import { projectSlackToGraph, projectItemsToGraph, deleteItemEpisodes, CHUNK_CHARS, MAX_EPISODE_CHUNKS, GROUP_SCAN_DEPTH } from "@/lib/graph/project";
import { runGraphProjection } from "@/lib/graph/run";
import { reconcileProjectedEpisodes } from "@/lib/graph/reconcile";
import { db, ingest, seedTeam } from "./helpers";

// Spec: the projector reads Slack transcripts from the brain and pushes them to Graphiti as
// episodes, idempotently, with tier-scoped group_ids. Verified on real Postgres with a MOCKED
// Graphiti client (no live graph service needed) — we assert the pushes + the graph_episodes state.

let fakeUuidCounter = 0;

/** In-memory Graphiti double: tracks episodes per group with server-assigned uuids, so
 * listEpisodes/deleteEpisode (M6, H3 reconcile) behave like the real REST surface. */
class FakeGraphiti {
  pushes: { groupId: string; episodes: GraphEpisode[] }[] = [];
  // groupId -> uuid -> episode (mirrors Graphiti's own per-group episode store)
  store = new Map<string, Map<string, GraphEpisodeRef>>();
  // Names that should be treated as "never landed" (simulates a worker crash before extraction).
  neverLands = new Set<string>();
  // When true, deleteEpisode throws — simulates a Graphiti blip so cleanup fails (B2).
  failDeletes = false;
  // Records the `lastN` each listEpisodes call requested, so a test can assert the deep scan (B2).
  listCalls: { groupId: string; lastN?: number }[] = [];
  readonly configured = true;

  async addEpisodes(groupId: string, episodes: GraphEpisode[]): Promise<void> {
    this.pushes.push({ groupId, episodes });
    const group = this.store.get(groupId) ?? new Map<string, GraphEpisodeRef>();
    for (const e of episodes) {
      if (e.name && this.neverLands.has(e.name)) continue; // simulated crash: never materializes
      const uuid = `fake-uuid-${++fakeUuidCounter}`;
      group.set(uuid, { uuid, name: e.name ?? "" });
    }
    this.store.set(groupId, group);
  }

  async listEpisodes(groupId: string, lastN?: number): Promise<GraphEpisodeRef[]> {
    this.listCalls.push({ groupId, lastN });
    return [...(this.store.get(groupId)?.values() ?? [])];
  }

  async deleteEpisode(uuid: string): Promise<void> {
    if (this.failDeletes) throw new Error("simulated Graphiti delete failure");
    for (const group of this.store.values()) group.delete(uuid);
  }
}

function client(fake: FakeGraphiti): GraphitiClient {
  return fake as unknown as GraphitiClient;
}

async function teamSlugFor(teamId: string): Promise<string> {
  const { data } = await db().from("teams").select("slug").eq("id", teamId).maybeSingle();
  return (data as { slug: string }).slug;
}

describe("Slack → Graphiti projector (real Postgres, mocked Graphiti)", () => {
  it("projects each transcript with a tier-scoped group_id and records state", async () => {
    const seed = await seedTeam();
    const slug = await teamSlugFor(seed.teamId);
    await ingest(seed, { kind: "transcript", path: "slack/eng/1.md", body: "alex shipped the payments service", access: "team" });
    await ingest(seed, { kind: "transcript", path: "slack/client/2.md", body: "kickoff with acme client", access: "external" });

    const fake = new FakeGraphiti();
    const res = await projectSlackToGraph(db(), { teamId: seed.teamId, teamSlug: slug, client: client(fake) });

    expect(res.projected).toBe(2);
    expect(res.skipped).toBe(0);
    const groups = fake.pushes.map((p) => p.groupId).sort();
    expect(groups).toEqual([`${slug}_external`, `${slug}_team`]); // tier encoded in group_id (Graphiti-valid)

    // State recorded for both, keyed by source id.
    const { data: state } = await db().from("graph_episodes").select("source_id, group_id").eq("team_id", seed.teamId);
    expect((state ?? []).length).toBe(2);
  });

  it("is idempotent: a second run re-pushes nothing (unchanged content)", async () => {
    const seed = await seedTeam();
    const slug = await teamSlugFor(seed.teamId);
    await ingest(seed, { kind: "transcript", path: "slack/eng/1.md", body: "stable thread", access: "team" });

    const first = new FakeGraphiti();
    await projectSlackToGraph(db(), { teamId: seed.teamId, teamSlug: slug, client: client(first) });
    expect(first.pushes).toHaveLength(1);

    const second = new FakeGraphiti();
    const res = await projectSlackToGraph(db(), { teamId: seed.teamId, teamSlug: slug, client: client(second) });
    expect(second.pushes).toHaveLength(0); // nothing re-pushed
    expect(res.projected).toBe(0);
    expect(res.skipped).toBe(1);
  });

  it("re-projects when the content changes (content hash differs)", async () => {
    const seed = await seedTeam();
    const slug = await teamSlugFor(seed.teamId);
    await ingest(seed, { kind: "transcript", path: "slack/eng/1.md", body: "v1 of the thread", access: "team" });
    await projectSlackToGraph(db(), { teamId: seed.teamId, teamSlug: slug, client: client(new FakeGraphiti()) });

    // Same path, new body → item updated in place (ingest versions it).
    await ingest(seed, { kind: "transcript", path: "slack/eng/1.md", body: "v2 — decision reversed", access: "team" });
    const again = new FakeGraphiti();
    const res = await projectSlackToGraph(db(), { teamId: seed.teamId, teamSlug: slug, client: client(again) });
    expect(again.pushes).toHaveLength(1); // changed content re-pushed
    expect(res.projected).toBe(1);
  });
});

// All ingestions (not just Slack) feed the graph: projectItemsToGraph projects every content-bearing
// kind and excludes config kinds (skill/blueprint). Verified on real Postgres with a mocked Graphiti.
describe("projectItemsToGraph — all ingestions (real Postgres, mocked Graphiti)", () => {
  it("projects all content kinds and excludes config kinds (skill)", async () => {
    const seed = await seedTeam();
    const slug = await teamSlugFor(seed.teamId);
    await ingest(seed, { kind: "transcript", path: "slack/eng/1.md", body: "slack thread", access: "team" });
    await ingest(seed, { kind: "deliverable", path: "notion/spec.md", body: "product spec", access: "team" });
    await ingest(seed, { kind: "decision", path: "decisions/d1.md", body: "we chose postgres", access: "team" });
    await ingest(seed, { kind: "task", path: "tasks/t1.md", body: "ship the graph", access: "team" });
    await ingest(seed, { kind: "skill", path: "skills/s.md", body: "skill manifest", access: "team" }); // excluded

    const fake = new FakeGraphiti();
    const res = await projectItemsToGraph(db(), { teamId: seed.teamId, teamSlug: slug, client: client(fake) });

    expect(res.projected).toBe(4); // transcript + deliverable + decision + task; skill excluded
    expect(fake.pushes).toHaveLength(4);
  });

  // Spec: a large item is CHUNKED into several small episodes (not truncated to one) so each stays
  // under Graphiti's extraction output cap — an oversized episode overflows it and never becomes facts
  // (prod 2026-06/07), so its work would be invisible in the graph + arcs. Chunking preserves content.
  it("chunks an oversized item into ≤ MAX_EPISODE_CHUNKS small episodes so extraction can't overflow", async () => {
    const seed = await seedTeam();
    const slug = await teamSlugFor(seed.teamId);
    const huge = "x ".repeat(40_000); // ~80k chars, far beyond one chunk
    await ingest(seed, { kind: "deliverable", path: "notion/huge.md", body: huge, access: "team" });

    const fake = new FakeGraphiti();
    await projectItemsToGraph(db(), { teamId: seed.teamId, teamSlug: slug, client: client(fake) });

    expect(fake.pushes).toHaveLength(1); // one addEpisodes call for the item…
    const eps = fake.pushes[0].episodes;
    expect(eps.length).toBe(MAX_EPISODE_CHUNKS); // …carrying several chunk episodes, capped
    for (const e of eps) expect(e.content.length).toBeLessThanOrEqual(CHUNK_CHARS); // each fits the extractor
    // Multi-chunk items get the `#k` suffix; each chunk still resolves back to the one item.
    expect(eps[0].name).toMatch(/^items:.+#0$/);
    expect(eps[1].name).toMatch(/^items:.+#1$/);
  });
});

// The runner (lib/graph/run.ts) is the on-ramp the admin action + scheduler call: it resolves the
// team from the DB, then projects. This exercises that team-resolution + aggregation on real Postgres.
describe("runGraphProjection runner (real Postgres, mocked Graphiti)", () => {
  it("resolves the team, projects its transcripts, and is idempotent on re-run", async () => {
    const seed = await seedTeam();
    const slug = await teamSlugFor(seed.teamId);
    await ingest(seed, { kind: "transcript", path: "slack/eng/1.md", body: "alpha thread", access: "team" });
    await ingest(seed, { kind: "transcript", path: "slack/client/2.md", body: "beta thread", access: "external" });

    const fake = new FakeGraphiti();
    const first = await runGraphProjection({ teamId: seed.teamId, client: client(fake), db: db() });
    expect(first.configured).toBe(true);
    expect(first.teams).toBe(1);
    expect(first.projected).toBe(2);
    expect(fake.pushes.map((p) => p.groupId).sort()).toEqual([`${slug}_external`, `${slug}_team`]);

    const second = await runGraphProjection({ teamId: seed.teamId, client: client(new FakeGraphiti()), db: db() });
    expect(second.projected).toBe(0);
    expect(second.skipped).toBe(2); // idempotent across the runner too
  });

  // Spec for audit H2: the runner must PAGE through the whole backlog. Before the fix it re-scanned
  // only the oldest `limit` rows every run, so items beyond that window were never projected.
  it("pages the full backlog beyond a single batch limit (audit H2)", async () => {
    const seed = await seedTeam();
    for (let i = 0; i < 5; i++) {
      await ingest(seed, { kind: "transcript", path: `slack/eng/${i}.md`, body: `thread ${i}`, access: "team" });
      // Stamp strictly-increasing synced_at so the cursor advances deterministically (no ties).
      await db()
        .from("items")
        .update({ synced_at: `2026-06-20T10:0${i}:00Z` })
        .eq("team_id", seed.teamId)
        .eq("path", `slack/eng/${i}.md`);
    }

    const fake = new FakeGraphiti();
    // limit=2: without paging only the oldest 2 ever project; with the cursor all 5 do.
    const res = await runGraphProjection({ teamId: seed.teamId, client: client(fake), db: db(), limit: 2 });
    expect(res.projected).toBe(5);
    expect(fake.pushes).toHaveLength(5);
    const { data: state } = await db().from("graph_episodes").select("source_id").eq("team_id", seed.teamId);
    expect((state ?? []).length).toBe(5);
  });
});

// Spec for audit M6: a tier reclassification (e.g. external→team) must not leave the old episode
// searchable in the old Graphiti group forever. Verified on real Postgres with the stateful fake.
describe("tier reclassification cleans up the stale episode (audit M6)", () => {
  it("deletes the episode from the old group when a re-synced item's access tier changes", async () => {
    const seed = await seedTeam();
    const slug = await teamSlugFor(seed.teamId);
    await ingest(seed, { kind: "deliverable", path: "docs/spec.md", body: "the spec", access: "external" });

    const fake = new FakeGraphiti();
    const first = await projectItemsToGraph(db(), { teamId: seed.teamId, teamSlug: slug, client: client(fake) });
    expect(first.projected).toBe(1);
    const externalGroup = `${slug}_external`;
    expect(await fake.listEpisodes(externalGroup)).toHaveLength(1);

    // Re-sync the same item, now team-tier (a legitimate access change on re-push — the real `aios
    // push` CLI hashes the whole file incl. frontmatter, so a tier change always changes the sha;
    // the test's `ingest()` helper hashes only `body`, so bump it here to model that honestly).
    await ingest(seed, { kind: "deliverable", path: "docs/spec.md", body: "the spec, now team-tier", access: "team" });
    const second = await projectItemsToGraph(db(), { teamId: seed.teamId, teamSlug: slug, client: client(fake) });
    expect(second.projected).toBe(1);

    // Old group no longer has it; new group does.
    expect(await fake.listEpisodes(externalGroup)).toHaveLength(0);
    const teamGroup = `${slug}_team`;
    expect(await fake.listEpisodes(teamGroup)).toHaveLength(1);

    // graph_episodes reflects the new group.
    const { data: state } = await db()
      .from("graph_episodes")
      .select("group_id")
      .eq("team_id", seed.teamId)
      .maybeSingle();
    expect((state as { group_id: string }).group_id).toBe(teamGroup);
  });
});

// Spec for Pass-1 review B2: the tier-reclassification cleanup must be DURABLE. The projector's inline
// delete is best-effort; if it silently fails (or misses a late-created chunk) and the ledger flips to
// the new group, the old-tier episodes must not stay searchable forever. `pending_delete_group_id`
// records the old group and reconcile retries the purge until the old group is verified empty.
describe("tier reclassification cleanup is durable across a failed inline delete (Pass-1 review B2)", () => {
  it("records the old group as pending-delete and reconcile finishes the purge after an inline delete failure", async () => {
    const seed = await seedTeam();
    const slug = await teamSlugFor(seed.teamId);
    const externalGroup = `${slug}_external`;
    const teamGroup = `${slug}_team`;
    await ingest(seed, { kind: "deliverable", path: "docs/spec.md", body: "the spec", access: "external" });

    const fake = new FakeGraphiti();
    await projectItemsToGraph(db(), { teamId: seed.teamId, teamSlug: slug, client: client(fake) });
    expect(await fake.listEpisodes(externalGroup)).toHaveLength(1);

    // Reclassify external→team, but the inline delete of the OLD group FAILS (a Graphiti blip).
    fake.failDeletes = true;
    await ingest(seed, { kind: "deliverable", path: "docs/spec.md", body: "the spec, now team-tier", access: "team" });
    await projectItemsToGraph(db(), { teamId: seed.teamId, teamSlug: slug, client: client(fake) });

    // New group has the episode; the OLD group STILL has it (inline delete failed) — pre-B2 this leaked
    // forever because the ledger flipped group_id and nothing retried.
    expect(await fake.listEpisodes(teamGroup)).toHaveLength(1);
    expect(await fake.listEpisodes(externalGroup)).toHaveLength(1);

    // The ledger points at the new group AND records the old group as pending cleanup.
    const { data: row } = await db()
      .from("graph_episodes")
      .select("id, group_id, pending_delete_group_id")
      .eq("team_id", seed.teamId)
      .maybeSingle();
    const r = row as { id: string; group_id: string; pending_delete_group_id: string | null };
    expect(r.group_id).toBe(teamGroup);
    expect(r.pending_delete_group_id).toBe(externalGroup);

    // Backdate projected_at past the 5-min grace so reconcile may finalize (not premature).
    await db().from("graph_episodes").update({ projected_at: "2020-01-01T00:00:00Z" }).eq("id", r.id);

    // Graphiti recovers. Pass 1 purges the old-group straggler (leak closed) but keeps the flag…
    fake.failDeletes = false;
    await reconcileProjectedEpisodes(db(), client(fake), seed.teamId);
    expect(await fake.listEpisodes(externalGroup)).toHaveLength(0);

    // …and pass 2 confirms the old group empty and clears the flag (converges).
    const pass2 = await reconcileProjectedEpisodes(db(), client(fake), seed.teamId);
    expect(pass2.cleaned).toBe(1);
    const { data: after } = await db()
      .from("graph_episodes")
      .select("pending_delete_group_id")
      .eq("team_id", seed.teamId)
      .maybeSingle();
    expect((after as { pending_delete_group_id: string | null }).pending_delete_group_id).toBeNull();
  });

  it("preserves the pending-cleanup flag when the NEW-group episode never lands (re-queue must not drop it)", async () => {
    // The conjunction Fable's review surfaced: the landed-check re-queues a row whose new-group episode
    // never landed (a worker crash — a documented failure mode) by DELETING it. If that row still owed an
    // old-group cleanup, the delete silently loses `pending_delete_group_id` and the projector's re-push
    // starts fresh (tierChanged false → flag null) — the old tier stays searchable forever with nothing
    // to retry it. The re-queue must therefore preserve a flagged row instead of deleting it.
    const seed = await seedTeam();
    const slug = await teamSlugFor(seed.teamId);
    const externalGroup = `${slug}_external`;
    const item = await ingest(seed, { kind: "deliverable", path: "docs/spec.md", body: "the spec", access: "external" });

    const fake = new FakeGraphiti();
    await projectItemsToGraph(db(), { teamId: seed.teamId, teamSlug: slug, client: client(fake) });
    expect(await fake.listEpisodes(externalGroup)).toHaveLength(1);

    // Reclassify external→team with BOTH failures: the old-group delete fails (flag set) AND the
    // new-group episode never materializes (worker crash → the landed-check will want to re-queue).
    fake.failDeletes = true;
    fake.neverLands.add(`items:${item.id}`);
    await ingest(seed, { kind: "deliverable", path: "docs/spec.md", body: "the spec, now team-tier", access: "team" });
    await projectItemsToGraph(db(), { teamId: seed.teamId, teamSlug: slug, client: client(fake) });

    // Past grace so the landed-check judges it (and would delete the row pre-fix).
    await db()
      .from("graph_episodes")
      .update({ projected_at: "2020-01-01T00:00:00Z" })
      .eq("team_id", seed.teamId);

    const res = await reconcileProjectedEpisodes(db(), client(fake), seed.teamId);
    expect(res.reQueued).toBe(1); // still re-queued for re-push…

    // …but the row SURVIVES carrying its cleanup debt (pre-fix this row was deleted → leak forever).
    const { data: row } = await db()
      .from("graph_episodes")
      .select("content_sha256, pending_delete_group_id")
      .eq("team_id", seed.teamId)
      .maybeSingle();
    expect(row).not.toBeNull();
    const r = row as { content_sha256: string; pending_delete_group_id: string | null };
    expect(r.pending_delete_group_id).toBe(externalGroup); // cleanup still owed + retryable
    expect(r.content_sha256).toBe(""); // sentinel → the projector re-pushes it like a deleted row

    // And once Graphiti recovers, the cleanup actually completes (converges, no permanent leak).
    fake.failDeletes = false;
    fake.neverLands.clear();
    await reconcileProjectedEpisodes(db(), client(fake), seed.teamId);
    expect(await fake.listEpisodes(externalGroup)).toHaveLength(0);
  });

  it("a content-only re-projection (same tier) does not clobber a pending-cleanup flag", async () => {
    // The flag's durability rests on the pg upsert only SETting columns present in the payload (the
    // projector omits `pending_delete_group_id` when the tier didn't change). Pin that behavior: a
    // routine content re-push mid-cleanup must not wipe the outstanding cleanup debt.
    const seed = await seedTeam();
    const slug = await teamSlugFor(seed.teamId);
    const externalGroup = `${slug}_external`;
    await ingest(seed, { kind: "deliverable", path: "docs/spec.md", body: "v1", access: "external" });

    const fake = new FakeGraphiti();
    await projectItemsToGraph(db(), { teamId: seed.teamId, teamSlug: slug, client: client(fake) });

    fake.failDeletes = true; // reclassification leaves cleanup owed
    await ingest(seed, { kind: "deliverable", path: "docs/spec.md", body: "v2 team-tier", access: "team" });
    await projectItemsToGraph(db(), { teamId: seed.teamId, teamSlug: slug, client: client(fake) });

    // A later ordinary content edit at the SAME tier → re-projection with tierChanged=false.
    await ingest(seed, { kind: "deliverable", path: "docs/spec.md", body: "v3 same tier", access: "team" });
    await projectItemsToGraph(db(), { teamId: seed.teamId, teamSlug: slug, client: client(fake) });

    const { data } = await db()
      .from("graph_episodes")
      .select("pending_delete_group_id")
      .eq("team_id", seed.teamId)
      .maybeSingle();
    expect((data as { pending_delete_group_id: string | null }).pending_delete_group_id).toBe(externalGroup);
  });

  it("does not clear the flag within the cleanup grace, even when the old group already looks empty", async () => {
    // Guards the grace itself: a straggler chunk still in Graphiti's extraction queue can land AFTER an
    // "empty" observation, so a fresh reclassification must not be declared clean yet.
    const seed = await seedTeam();
    const slug = await teamSlugFor(seed.teamId);
    await ingest(seed, { kind: "deliverable", path: "docs/spec.md", body: "the spec", access: "external" });

    const fake = new FakeGraphiti();
    await projectItemsToGraph(db(), { teamId: seed.teamId, teamSlug: slug, client: client(fake) });
    await ingest(seed, { kind: "deliverable", path: "docs/spec.md", body: "the spec, team-tier", access: "team" });
    await projectItemsToGraph(db(), { teamId: seed.teamId, teamSlug: slug, client: client(fake) });
    // The inline delete SUCCEEDED here, so the old group is already empty — but projected_at is now.

    const res = await reconcileProjectedEpisodes(db(), client(fake), seed.teamId);
    expect(res.cleaned).toBe(0); // too fresh to declare durable
    const { data } = await db()
      .from("graph_episodes")
      .select("pending_delete_group_id")
      .eq("team_id", seed.teamId)
      .maybeSingle();
    expect((data as { pending_delete_group_id: string | null }).pending_delete_group_id).not.toBeNull();
  });

  it("deleteItemEpisodes scans the group deep (not the 1000-episode default) so a large group can't hide the item", async () => {
    const seed = await seedTeam();
    const slug = await teamSlugFor(seed.teamId);
    const group = `${slug}_team`;
    const fake = new FakeGraphiti();
    await fake.addEpisodes(group, [{ content: "x", timestamp: "2020-01-01T00:00:00Z", sourceDescription: "x", name: "items:abc" }]);

    fake.listCalls = [];
    await deleteItemEpisodes(client(fake), group, "abc");
    // The default listEpisodes(lastN=1000) would silently miss an item beyond the newest 1000 in a large
    // group — the delete would "succeed" deleting nothing. The cleanup must request the deep scan.
    expect(fake.listCalls.some((c) => c.groupId === group && c.lastN === GROUP_SCAN_DEPTH)).toBe(true);
  });
});

// Spec for audit H3 (Option B): a recorded episode that never actually landed in Graphiti (the
// worker crashed before/while extracting it) must be cleared so the next projector run re-pushes
// it — and one that DID land gets its episode_uuid backfilled, not touched otherwise.
describe("reconcileProjectedEpisodes (audit H3, real Postgres)", () => {
  it("re-queues a recorded episode that never landed, and leaves a landed one alone (backfilling its uuid)", async () => {
    const seed = await seedTeam();
    const slug = await teamSlugFor(seed.teamId);
    const group = `${slug}_team`;
    const oldTimestamp = "2020-01-01T00:00:00Z"; // well outside the 5-min grace window

    // "Landed" row: the fake's store actually has this episode.
    const landedItem = await ingest(seed, { kind: "deliverable", path: "docs/landed.md", body: "landed", access: "team" });
    const fake = new FakeGraphiti();
    await fake.addEpisodes(group, [{ content: "landed", timestamp: oldTimestamp, sourceDescription: "x", name: `items:${landedItem.id}` }]);
    await db().from("graph_episodes").insert({
      team_id: seed.teamId, source_table: "items", source_id: landedItem.id,
      group_id: group, content_sha256: "deadbeef", projected_at: oldTimestamp,
    });

    // "Crashed" row: recorded as projected, but the fake never actually stored it.
    const crashedItem = await ingest(seed, { kind: "deliverable", path: "docs/crashed.md", body: "crashed", access: "team" });
    await db().from("graph_episodes").insert({
      team_id: seed.teamId, source_table: "items", source_id: crashedItem.id,
      group_id: group, content_sha256: "cafef00d", projected_at: oldTimestamp,
    });

    const res = await reconcileProjectedEpisodes(db(), client(fake), seed.teamId);
    expect(res.confirmed).toBe(1);
    expect(res.reQueued).toBe(1);

    // The landed row survives and now carries the resolved episode_uuid.
    const { data: landedRow } = await db()
      .from("graph_episodes")
      .select("episode_uuid")
      .eq("team_id", seed.teamId)
      .eq("source_id", landedItem.id)
      .maybeSingle();
    expect((landedRow as { episode_uuid: string | null }).episode_uuid).toBeTruthy();

    // The crashed row is gone — a subsequent projector run will treat it as unprojected.
    const { data: crashedRow } = await db()
      .from("graph_episodes")
      .select("id")
      .eq("team_id", seed.teamId)
      .eq("source_id", crashedItem.id)
      .maybeSingle();
    expect(crashedRow).toBeNull();

    const reproject = await projectItemsToGraph(db(), { teamId: seed.teamId, teamSlug: slug, client: client(fake) });
    expect(reproject.projected).toBeGreaterThanOrEqual(1); // the crashed item gets re-pushed
  });

  it("does not judge a row projected within the grace window (still may be processing)", async () => {
    const seed = await seedTeam();
    const slug = await teamSlugFor(seed.teamId);
    const group = `${slug}_team`;
    const item = await ingest(seed, { kind: "deliverable", path: "docs/fresh.md", body: "fresh", access: "team" });
    // Recorded just now, and the fake never stored it — but it's too fresh to judge.
    await db().from("graph_episodes").insert({
      team_id: seed.teamId, source_table: "items", source_id: item.id,
      group_id: group, content_sha256: "abc123", projected_at: new Date().toISOString(),
    });

    const res = await reconcileProjectedEpisodes(db(), client(new FakeGraphiti()), seed.teamId);
    expect(res.confirmed).toBe(0);
    expect(res.reQueued).toBe(0); // left alone, not prematurely cleared

    const { data } = await db().from("graph_episodes").select("id").eq("team_id", seed.teamId).eq("source_id", item.id).maybeSingle();
    expect(data).not.toBeNull();
  });
});
