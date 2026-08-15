import { describe, expect, it } from "vitest";
import { projectItemsToGraph } from "@/lib/graph/project";
import { selectEnforcedGraphPartitions } from "@/lib/graph/partition-read";
import { fetchGraphFactsForGroups } from "@/lib/query/retrieve";
import { episodeGroupId } from "@/lib/graph/group";
import { ensureAccessBootstrap } from "@/lib/access/bootstrap";
import { runSql } from "@/lib/db/pg/pool";
import { db, ingest, seedTeam, sha, type Seed } from "./helpers";
import { mkInitiative, tagItem } from "./graph-helpers";
import { FakeGraphiti, client } from "./fake-graphiti";

/**
 * PCCC-6 — the enforced read's partition selection (design §2.3 + the spec's expansion budget):
 * General always included, initiatives participate only ready∧unsuppressed, K-capped with
 * disclosure, arming as the read's side effect. Spec-first.
 */

async function landGroup(seed: Seed, group: string): Promise<void> {
  await runSql(
    "update graph_episodes set content_sha256 = $1, episode_uuid = 'landed', deferred = false where team_id = $2 and group_id = $3",
    [sha("landed"), seed.teamId, group]
  );
}

async function bootstrapWithInitiative(seed: Seed, slug: string) {
  expect((await ensureAccessBootstrap(db(), seed.teamId)).ok).toBe(true);
  const init = await mkInitiative(seed, slug);
  const r = await ingest(seed, { body: `content ${slug}`, path: `${slug}.md`, access: "team" });
  await tagItem(seed, r.id, init.projectId);
  await projectItemsToGraph(db(), { teamId: seed.teamId, teamSlug: seed.teamSlug, client: client(new FakeGraphiti()) });
  return { init, itemId: r.id };
}

async function visibleIds(seed: Seed, extra: string[]): Promise<string[]> {
  const { data } = await db().from("projects").select("id").eq("team_id", seed.teamId).eq("kind", "system");
  return [...((data ?? []) as { id: string }[]).map((p) => p.id), ...extra];
}

describe("PCCC-6 — enforced partition selection", () => {
  it("General is ALWAYS included; an un-ready initiative is omitted (fail closed) while its arming begins", async () => {
    const seed = await seedTeam();
    const { init } = await bootstrapWithInitiative(seed, "cold-init");
    const scope = await selectEnforcedGraphPartitions(db(), {
      teamId: seed.teamId,
      visibleProjectIds: await visibleIds(seed, [init.projectId]),
    });
    expect(scope.groups).toContain(`${seed.teamSlug}_team`); // General's grandfathered partition
    expect(scope.groups).not.toContain(init.group); // armed by this read, but not yet landed → omitted
    const armed = await runSql<{ n: number }>(
      "select count(*)::int as n from graph_project_arming where team_id = $1 and project_id = $2",
      [seed.teamId, init.projectId]
    );
    expect(armed.rows[0].n).toBe(1); // the read WAS the arming trigger
  });

  it("a ready initiative joins the read set; a SUPPRESSED (self-purge) one drops out without un-latching", async () => {
    const seed = await seedTeam();
    const { init } = await bootstrapWithInitiative(seed, "warm-init");
    const first = await selectEnforcedGraphPartitions(db(), {
      teamId: seed.teamId,
      visibleProjectIds: await visibleIds(seed, [init.projectId]),
    });
    expect(first.groups).not.toContain(init.group);
    await landGroup(seed, init.group);

    const ready = await selectEnforcedGraphPartitions(db(), {
      teamId: seed.teamId,
      visibleProjectIds: await visibleIds(seed, [init.projectId]),
    });
    expect(ready.groups).toContain(init.group);

    // Self-purge → suppressed; cross-purge (tier-flip shape) must NOT suppress.
    await runSql("update graph_episodes set pending_delete_group_id = group_id where team_id = $1 and group_id = $2", [
      seed.teamId,
      init.group,
    ]);
    const suppressed = await selectEnforcedGraphPartitions(db(), {
      teamId: seed.teamId,
      visibleProjectIds: await visibleIds(seed, [init.projectId]),
    });
    expect(suppressed.groups).not.toContain(init.group);
    expect(suppressed.groups).toContain(`${seed.teamSlug}_team`);
  });

  it("a CROSS-purge (tier-flip hygiene pointing at the OLD group) does not suppress a home partition", async () => {
    const seed = await seedTeam();
    expect((await ensureAccessBootstrap(db(), seed.teamId)).ok).toBe(true);
    const r = await ingest(seed, { body: "tier flipping content", path: "tf.md", access: "external" });
    const fake = new FakeGraphiti();
    await projectItemsToGraph(db(), { teamId: seed.teamId, teamSlug: seed.teamSlug, client: client(fake) });
    expect((await db().from("items").update({ access: "team" }).eq("id", r.id)).error).toBeNull();
    await projectItemsToGraph(db(), { teamId: seed.teamId, teamSlug: seed.teamSlug, client: client(fake) });
    // The moved home row now points at the OLD (_external) group — a cross-purge.
    const scope = await selectEnforcedGraphPartitions(db(), {
      teamId: seed.teamId,
      visibleProjectIds: await visibleIds(seed, []),
    });
    expect(scope.groups).toContain(`${seed.teamSlug}_team`); // routine hygiene never blanks the leg
  });

  it("the K-cap keeps General plus the most recent others, and DISCLOSES covered/total", async () => {
    const seed = await seedTeam();
    expect((await ensureAccessBootstrap(db(), seed.teamId)).ok).toBe(true);
    const a = await mkInitiative(seed, "init-a");
    const b = await mkInitiative(seed, "init-b");
    for (const init of [a, b]) {
      const r = await ingest(seed, { body: `content ${init.group}`, path: `${init.group}.md`, access: "team" });
      await tagItem(seed, r.id, init.projectId);
    }
    await projectItemsToGraph(db(), { teamId: seed.teamId, teamSlug: seed.teamSlug, client: client(new FakeGraphiti()) });
    for (const init of [a, b]) await landGroup(seed, init.group);
    // Recency comes from the PARTITION's latest real push (review High 4b: last_synced_at is
    // ingest-only and perpetually null for initiatives — seeding it proved the sort, not the
    // feature). Age group A's ledger rows; keep B's fresh.
    await runSql("update graph_episodes set projected_at = now() - interval '30 days' where team_id = $1 and group_id = $2", [seed.teamId, a.group]);

    const ids = await visibleIds(seed, [a.projectId, b.projectId]);
    const scope = await selectEnforcedGraphPartitions(db(), { teamId: seed.teamId, visibleProjectIds: ids, k: 2 });
    expect(scope.groups).toContain(`${seed.teamSlug}_team`); // General survives every cap
    expect(scope.groups).toContain(b.group); // most recent wins the remaining slot
    expect(scope.groups).not.toContain(a.group);
    expect(scope.covered).toBe(2);
    expect(scope.total).toBe(ids.length);
  });

  it("SOURCE projects never enter the selection — their minted partitions are empty by construction (review High 4a)", async () => {
    const seed = await seedTeam();
    expect((await ensureAccessBootstrap(db(), seed.teamId)).ok).toBe(true);
    // A pointered, freshly-synced source project (the ingest path creates these for every push).
    const r = await ingest(seed, { body: "source content", path: "s.md", access: "team", project: "src-proj" });
    expect(r.id).toBeTruthy();
    const { data: src } = await db()
      .from("projects").select("id, graph_group_id").eq("team_id", seed.teamId).eq("slug", "src-proj").single();
    const srcRow = src as { id: string; graph_group_id: string };
    expect(srcRow.graph_group_id).toBeTruthy();

    const scope = await selectEnforcedGraphPartitions(db(), {
      teamId: seed.teamId,
      visibleProjectIds: await visibleIds(seed, [srcRow.id]),
      k: 2,
    });
    expect(scope.groups).not.toContain(srcRow.graph_group_id); // an empty partition can't spend a K slot
    expect(scope.total).toBe(2); // and can't inflate the disclosure denominator (the two built-ins)
  });

  it("arm:false (the permissive union path) reads ready partitions without arming anything", async () => {
    const seed = await seedTeam();
    const { init } = await bootstrapWithInitiative(seed, "no-arm");
    await selectEnforcedGraphPartitions(db(), {
      teamId: seed.teamId,
      visibleProjectIds: await visibleIds(seed, [init.projectId]),
      arm: false,
    });
    const armed = await runSql<{ n: number }>(
      "select count(*)::int as n from graph_project_arming where team_id = $1",
      [seed.teamId]
    );
    expect(armed.rows[0].n).toBe(0); // a permissive read is not a reader-signal
    const deferredStill = await runSql<{ deferred: boolean }>(
      "select deferred from graph_episodes where team_id = $1 and group_id = $2",
      [seed.teamId, init.group]
    );
    expect(deferredStill.rows[0].deferred).toBe(true); // and costs zero LLM
  });

  it("fetchGraphFactsForGroups searches EXACTLY the selected groups (the wiring pin)", async () => {
    const fake = new FakeGraphiti();
    const searches: string[][] = [];
    (fake as unknown as { search: (q: string, g: string[], n: number) => Promise<unknown[]> }).search = async (
      _q: string,
      g: string[]
    ) => {
      searches.push(g);
      return [];
    };
    await fetchGraphFactsForGroups("what changed", ["g1", "g2"], client(fake));
    expect(searches).toEqual([["g1", "g2"]]);
    // Empty set short-circuits — an empty group list must NEVER reach the wire (no-filter = everything).
    await fetchGraphFactsForGroups("what changed", [], client(fake));
    expect(searches).toHaveLength(1);
  });
});
