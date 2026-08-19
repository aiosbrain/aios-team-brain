import { describe, expect, it } from "vitest";
import { projectItemsToGraph } from "@/lib/graph/project";
import { episodeGroupId } from "@/lib/graph/group";
import { visibleTierGroupIds, builtinTierGroupId } from "@/lib/graph/tier-groups";
import { ensureAccessBootstrap } from "@/lib/access/bootstrap";
import { runSql } from "@/lib/db/pg/pool";
import { db, ingest, seedTeam, type Seed } from "./helpers";
import { FakeGraphiti, client } from "./fake-graphiti";

/**
 * A TEAM SLUG RENAME MUST NOT ORPHAN THE KNOWLEDGE GRAPH.
 *
 * Found 2026-08-18: a demo team was renamed and within minutes every graph-backed surface went
 * empty — while every diagnostic reported the graph as healthy (the right episode count, facts in
 * the store, "Graph memory: on · last projected just now"). The two sides of the seam disagreed
 * about what a group id is. The projector follows the IMMUTABLE `projects.graph_group_id` pointer,
 * which `lib/graph/project-pointer.ts` explicitly documents may be "a frozen legacy id (possibly
 * under an old slug — the rename doctrine)". The read legs recomputed it from the LIVE slug. So the
 * writer wrote `<old>_team` and the readers searched `<new>_team`, a group that has never been
 * written to. No error, no empty-graph banner, and no recovery — ever.
 *
 * This is the data-mechanics tier because the claim is a PERSISTENCE-AND-ACCESS outcome: where the
 * episodes actually are versus where a reader actually looks (CLAUDE.md §4). A call-site reading
 * would not have caught it — every call site was individually defensible.
 *
 * These assertions are RED against the pre-fix reader (`visibleGroupIds(teamSlug, tier)` returns the
 * new-slug ids, which the `NOTHING was ever written` expectations below prove name an empty graph).
 */

const RENAMED = "renamed-after-projection";

async function bootstrapAndProject(seed: Seed, fake: FakeGraphiti) {
  expect((await ensureAccessBootstrap(db(), seed.teamId)).ok).toBe(true);
  await ingest(seed, { body: "a team-tier fact worth keeping", path: "team.md", access: "team" });
  await ingest(seed, { body: "an external-tier fact worth keeping", path: "ext.md", access: "external" });
  await projectItemsToGraph(db(), { teamId: seed.teamId, teamSlug: seed.teamSlug, client: client(fake) });
}

/** The rename as it actually happened: a direct database update. There is no product flow for it. */
async function renameTeam(seed: Seed, slug: string): Promise<void> {
  await runSql("update teams set slug = $1 where id = $2", [slug, seed.teamId]);
}

describe("a team slug rename does not orphan the graph (VIB-341)", () => {
  it("the tier read set follows the FROZEN pointers, and that is where the episodes actually are", async () => {
    const seed = await seedTeam();
    const fake = new FakeGraphiti();
    await bootstrapAndProject(seed, fake);
    const before = await visibleTierGroupIds(db(), { teamId: seed.teamId, teamSlug: seed.teamSlug, tier: "team" });

    await renameTeam(seed, RENAMED);
    const after = await visibleTierGroupIds(db(), { teamId: seed.teamId, teamSlug: RENAMED, tier: "team" });

    // The read set is UNCHANGED by the rename — the whole point.
    expect(after.slice().sort()).toEqual(before.slice().sort());
    expect(after).toContain(episodeGroupId(seed.teamSlug, "team"));

    // …and it is where the content is. Both halves matter: the ids being stable is worthless if the
    // graph moved, and the graph being intact is worthless if nothing addresses it.
    for (const group of after) expect(await fake.listEpisodes(group)).not.toHaveLength(0);

    // The pre-fix reader's answer, shown to be empty. This is the assertion that makes the test a
    // REGRESSION rather than a restatement: `<new-slug>_team` is a group nothing has ever written to.
    expect(await fake.listEpisodes(episodeGroupId(RENAMED, "team"))).toHaveLength(0);
    expect(await fake.listEpisodes(episodeGroupId(RENAMED, "external"))).toHaveLength(0);
  });

  it("history stays reachable with NO re-projection — the fix must not cost an extraction bill", async () => {
    const seed = await seedTeam();
    const fake = new FakeGraphiti();
    await bootstrapAndProject(seed, fake);
    const pushesBefore = fake.pushes.length;

    await renameTeam(seed, RENAMED);
    const groups = await visibleTierGroupIds(db(), { teamId: seed.teamId, teamSlug: RENAMED, tier: "team" });

    // Reading after a rename must not re-push a single episode. Re-extraction on a large graph is a
    // real LLM bill, and it is what the rejected "re-mint on rename" approach would have required.
    expect(fake.pushes.length).toBe(pushesBefore);
    const names = groups.flatMap((g) => [...(fake.store.get(g)?.values() ?? [])].map((e) => e.name));
    expect(names.some((n) => n.startsWith("items:"))).toBe(true);
  });

  it("the tier fence survives the rename: an external viewer never resolves the team group", async () => {
    // CLAUDE.md §5 — `group_id` IS the isolation, with no RLS backstop, so a change to how it is
    // resolved is a change to the fence. Post-fix the fence is project identity (`external-shared`),
    // which a renamed slug cannot spell wrong.
    const seed = await seedTeam();
    await bootstrapAndProject(seed, new FakeGraphiti());
    await renameTeam(seed, RENAMED);

    const ext = await visibleTierGroupIds(db(), { teamId: seed.teamId, teamSlug: RENAMED, tier: "external" });
    expect(ext).toEqual([episodeGroupId(seed.teamSlug, "external")]);
    expect(ext).not.toContain(episodeGroupId(seed.teamSlug, "team"));
    expect(ext).not.toContain(episodeGroupId(RENAMED, "team"));
  });

  it("a renamed team cannot read a group whose history belongs to a DIFFERENT team", async () => {
    // The spec's tier-safety AC. Slug reuse after a rename is the dangerous shape: team A renames
    // away, team B takes the freed slug. B's reader must resolve B's OWN pointers — the `team_id`
    // scope is what guarantees it, and `project-pointer.ts`'s foreign-history refusal (untouched
    // here) is the matching guard on the write side.
    const a = await seedTeam();
    await bootstrapAndProject(a, new FakeGraphiti());
    const aGroups = await visibleTierGroupIds(db(), { teamId: a.teamId, teamSlug: a.teamSlug, tier: "team" });
    await renameTeam(a, RENAMED);

    const b = await seedTeam();
    await bootstrapAndProject(b, new FakeGraphiti());
    // B now occupies A's former slug. Its read set must be B's pointers, and must share NOTHING
    // with A's — a reader that keyed on the slug would hand B every fact A ever extracted.
    await renameTeam(b, a.teamSlug);
    const bGroups = await visibleTierGroupIds(db(), { teamId: b.teamId, teamSlug: a.teamSlug, tier: "team" });

    expect(bGroups).toEqual(expect.arrayContaining([episodeGroupId(b.teamSlug, "team")]));
    for (const g of aGroups) expect(bGroups).not.toContain(g);
  });

  it("a team CREATED on a freed slug is refused, not silently handed the old team's graph", async () => {
    // Review High 1 — the ordering the test above does NOT cover, and the only one that actually
    // reaches the slug fallback. B is created ON A's freed slug BEFORE bootstrapping, so B's
    // `ensureProjectGraphPointer` hits project-pointer.ts's FOREIGN-HISTORY REFUSAL, which returns
    // before filling. B's built-ins keep `graph_group_id = NULL` permanently (lib/admin/teams.ts
    // swallows the bootstrap result and every scheduler tick re-refuses), so B's readers fall back
    // to the slug — which is A's live partition. The read authority must refuse it.
    const a = await seedTeam();
    await bootstrapAndProject(a, new FakeGraphiti());
    const freed = a.teamSlug;
    await renameTeam(a, RENAMED);

    const b = await seedTeam();
    await renameTeam(b, freed); // B now occupies A's old slug, and has NO pointers yet

    // The write side refuses to mint (this is what leaves the pointers null) …
    expect((await ensureAccessBootstrap(db(), b.teamId)).ok).toBe(false);
    const { data: ptrs } = await db()
      .from("projects")
      .select("graph_group_id")
      .eq("team_id", b.teamId)
      .eq("kind", "system");
    expect(((ptrs ?? []) as { graph_group_id: string | null }[]).every((p) => p.graph_group_id == null)).toBe(true);

    // … and the read side must refuse too, rather than resolving A's group and serving A's facts
    // to B's members with no error anywhere.
    await expect(
      visibleTierGroupIds(db(), { teamId: b.teamId, teamSlug: freed, tier: "team" })
    ).rejects.toThrow(/holds ANOTHER team's episode history/);
    await expect(
      builtinTierGroupId(db(), { teamId: b.teamId, teamSlug: freed, access: "team" })
    ).rejects.toThrow(/holds ANOTHER team's episode history/);
  });

  it("a correction written AFTER a rename targets the group the reader reads", async () => {
    // The spec's second automated AC. `recomputeArcs`' tier write-back used to spell
    // `episodeGroupId(<live-slug>, "team")`, so a correction written post-rename landed in a group
    // nothing reads — a dead correction, silently. It resolves the pointer now.
    const seed = await seedTeam();
    await bootstrapAndProject(seed, new FakeGraphiti());
    await renameTeam(seed, RENAMED);

    const target = await builtinTierGroupId(db(), { teamId: seed.teamId, teamSlug: RENAMED, access: "team" });
    const readSet = await visibleTierGroupIds(db(), { teamId: seed.teamId, teamSlug: RENAMED, tier: "team" });
    expect(readSet).toContain(target);
    expect(target).toBe(episodeGroupId(seed.teamSlug, "team"));
  });
});
