import { describe, expect, it } from "vitest";
import type { GraphitiClient, GraphEpisode } from "@/lib/graph/graphiti-client";
import { projectSlackToGraph, projectItemsToGraph } from "@/lib/graph/project";
import { runGraphProjection } from "@/lib/graph/run";
import { db, ingest, seedTeam } from "./helpers";

// Spec: the projector reads Slack transcripts from the brain and pushes them to Graphiti as
// episodes, idempotently, with tier-scoped group_ids. Verified on real Postgres with a MOCKED
// Graphiti client (no live graph service needed) — we assert the pushes + the graph_episodes state.

class FakeGraphiti {
  pushes: { groupId: string; episodes: GraphEpisode[] }[] = [];
  // runGraphProjection gates on `client.configured` — the fake reports configured so the run proceeds.
  readonly configured = true;
  async addEpisodes(groupId: string, episodes: GraphEpisode[]): Promise<void> {
    this.pushes.push({ groupId, episodes });
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
    const first = await runGraphProjection({ teamId: seed.teamId, client: client(fake), supabase: db() });
    expect(first.configured).toBe(true);
    expect(first.teams).toBe(1);
    expect(first.projected).toBe(2);
    expect(fake.pushes.map((p) => p.groupId).sort()).toEqual([`${slug}_external`, `${slug}_team`]);

    const second = await runGraphProjection({ teamId: seed.teamId, client: client(new FakeGraphiti()), supabase: db() });
    expect(second.projected).toBe(0);
    expect(second.skipped).toBe(2); // idempotent across the runner too
  });
});
