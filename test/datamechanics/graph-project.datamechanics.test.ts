import { describe, expect, it } from "vitest";
import type { GraphitiClient, GraphEpisode, GraphEpisodeRef } from "@/lib/graph/graphiti-client";
import { projectSlackToGraph, projectItemsToGraph, CHUNK_CHARS, MAX_EPISODE_CHUNKS } from "@/lib/graph/project";
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

  async listEpisodes(groupId: string): Promise<GraphEpisodeRef[]> {
    return [...(this.store.get(groupId)?.values() ?? [])];
  }

  async deleteEpisode(uuid: string): Promise<void> {
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
