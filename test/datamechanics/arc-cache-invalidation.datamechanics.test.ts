import { describe, expect, it } from "vitest";
import { reconcileProjectedEpisodes } from "@/lib/graph/reconcile";
import { projectItemsToGraph } from "@/lib/graph/project";
import { writeArcCache, readArcCache, sweepStaleScopedArcCache } from "@/lib/graph/arc-cache";
import { episodeGroupId } from "@/lib/graph/group";
import { runSql } from "@/lib/db/pg/pool";
import { db, ingest, seedTeam } from "./helpers";
import { ensureAccessBootstrap } from "@/lib/access/bootstrap";
import { FakeGraphiti, client } from "./fake-graphiti";

/**
 * PCCC-7 — scoped arc-cache invalidation (design §5 as extended by the post-merge Codex round).
 * The leak this closes (Codex High 1 on merged 6b): a `p:` row synthesized BEFORE a restriction
 * move keeps restricted-derived SUMMARY prose — invisible to the evidence filter — and once the
 * partition's purge confirms and it returns from suppression, the old row is served again for up
 * to TTL. Purge, not stale-mark: SWR serves a stale row to the next reader. Spec-first.
 */

const ARC = [{ id: "a1", title: "arc with restricted prose", confidence: "high", summary: "S said X", participants: [], supporting_sources: [], evidence: [], derived_at: new Date().toISOString() }];

describe("PCCC-7 — restriction-driven purge of scoped arc rows", () => {
  it("a reconcile pass holding a SELF-purge hard-purges the partition's g: row BEFORE the flag can clear — the tier row survives (PPARC-4: the g: door stands alone)", async () => {
    const seed = await seedTeam();
    expect((await ensureAccessBootstrap(db(), seed.teamId)).ok).toBe(true);
    const teamGroup = episodeGroupId(seed.teamSlug, "team");
    // The partition row (the pre-restriction synthesis) and a tier row.
    await writeArcCache(db(), seed.teamId, `g:${teamGroup}`, ARC as never, "h1");
    await writeArcCache(db(), seed.teamId, teamGroup, ARC as never, "h2");

    // A ledger row owing a SELF purge (the restriction move-out / untag shape), past every grace,
    // with Graphiti verified empty — the exact pass that would clear the flag and un-suppress.
    const r = await ingest(seed, { body: "restricted content", path: "r.md", access: "team" });
    await runSql(
      `insert into graph_episodes (team_id, source_table, source_id, group_id, content_sha256, pending_delete_group_id, pending_delete_at, projected_at)
       values ($1, 'items', $2, $3, '', $3, now() - interval '2 days', now() - interval '2 days')`,
      [seed.teamId, r.id, teamGroup]
    );
    await reconcileProjectedEpisodes(db(), client(new FakeGraphiti()), seed.teamId);

    expect(await readArcCache(db(), seed.teamId, `g:${teamGroup}`)).toBeNull(); // purged
    expect(await readArcCache(db(), seed.teamId, teamGroup)).not.toBeNull(); // tier row untouched
  });
});

describe("PCCC-7 — the projector's OWN self-clear door (Fable High)", () => {
  it("a purgeBeforeRepush clear also purges the partition's g: row — the sibling door cannot resurrect a poisoned row", async () => {
    const seed = await seedTeam();
    expect((await ensureAccessBootstrap(db(), seed.teamId)).ok).toBe(true);
    const teamGroup = episodeGroupId(seed.teamSlug, "team");
    await writeArcCache(db(), seed.teamId, `g:${teamGroup}`, ARC as never, "h1");

    // The retract-failure/redaction shape: a live home row whose SELF flag is set (past every
    // grace), content unchanged — the projector's purgeBeforeRepush path confirms the purge
    // inline (Graphiti empty) and clears the flag WITHOUT reconcile ever running.
    const r = await ingest(seed, { body: "will be flagged", path: "pf.md", access: "team" });
    const fake = new FakeGraphiti();
    await projectItemsToGraph(db(), { teamId: seed.teamId, teamSlug: seed.teamSlug, client: client(fake) });
    await runSql(
      "update graph_episodes set pending_delete_group_id = group_id, pending_delete_at = now() - interval '2 days' where team_id = $1 and source_id = $2",
      [seed.teamId, r.id]
    );
    await projectItemsToGraph(db(), { teamId: seed.teamId, teamSlug: seed.teamSlug, client: client(fake) });

    const flag = await runSql<{ pending_delete_group_id: string | null }>(
      "select pending_delete_group_id from graph_episodes where team_id = $1 and source_id = $2",
      [seed.teamId, r.id]
    );
    expect(flag.rows[0].pending_delete_group_id).toBeNull(); // the projector DID clear (the door is live)
    expect(await readArcCache(db(), seed.teamId, `g:${teamGroup}`)).toBeNull(); // …and purged first
  });
});

describe("PCCC-7 — the purge trigger is clear-imminent, not flag-exists", () => {
  it("a FRESH self flag (inside the cleanup grace) does not purge the partition's g: row", async () => {
    const seed = await seedTeam();
    expect((await ensureAccessBootstrap(db(), seed.teamId)).ok).toBe(true);
    const teamGroup = episodeGroupId(seed.teamSlug, "team");
    await writeArcCache(db(), seed.teamId, `g:${teamGroup}`, ARC as never, "h1");
    const r = await ingest(seed, { body: "fresh flag", path: "ff.md", access: "team" });
    await runSql(
      `insert into graph_episodes (team_id, source_table, source_id, group_id, content_sha256, pending_delete_group_id, pending_delete_at, projected_at)
       values ($1, 'items', $2, $3, '', $3, now(), now())`,
      [seed.teamId, r.id, teamGroup]
    );
    await reconcileProjectedEpisodes(db(), client(new FakeGraphiti()), seed.teamId);
    // No clear was possible this pass (grace not elapsed) — readers' partition rows must survive.
    expect(await readArcCache(db(), seed.teamId, `g:${teamGroup}`)).not.toBeNull();
  });
});

describe("PCCC-7 — the purge waits for a VERIFIED-CLEAN clear (Codex High 2)", () => {
  it("while Graphiti still holds the item's episodes, the partition's g: row survives — a cold miss must not rebuild from the dirty graph", async () => {
    const seed = await seedTeam();
    expect((await ensureAccessBootstrap(db(), seed.teamId)).ok).toBe(true);
    const teamGroup = episodeGroupId(seed.teamSlug, "team");
    await writeArcCache(db(), seed.teamId, `g:${teamGroup}`, ARC as never, "h1");

    // Self flag past grace, but the graph is NOT clean: Graphiti still lists an episode for the
    // item, so this pass cannot clear the flag — and must not purge either. An eager purge here
    // hands the next reader a cold miss that re-synthesizes FROM THE DIRTY GRAPH and persists the
    // poisoned row for a whole projection interval.
    const r = await ingest(seed, { body: "dirty group content", path: "dg.md", access: "team" });
    const fake = new FakeGraphiti();
    await fake.addEpisodes(teamGroup, [{ content: "x", timestamp: new Date().toISOString(), sourceDescription: "t", name: `items:${r.id}` }]);
    // Make the fake REFUSE deletion so the episode stays listed (deleteFailed → flag kept).
    (fake as unknown as { deleteEpisode: () => Promise<never> }).deleteEpisode = async () => {
      throw new Error("refusing");
    };
    await runSql(
      `insert into graph_episodes (team_id, source_table, source_id, group_id, content_sha256, pending_delete_group_id, pending_delete_at, projected_at)
       values ($1, 'items', $2, $3, 'aaa', $3, now() - interval '2 days', now() - interval '2 days')`,
      [seed.teamId, r.id, teamGroup]
    );
    await reconcileProjectedEpisodes(db(), client(fake), seed.teamId);

    const flag = await runSql<{ pending_delete_group_id: string | null }>(
      "select pending_delete_group_id from graph_episodes where team_id = $1 and source_id = $2",
      [seed.teamId, r.id]
    );
    expect(flag.rows[0].pending_delete_group_id).not.toBeNull(); // clear was impossible (dirty graph)
    expect(await readArcCache(db(), seed.teamId, `g:${teamGroup}`)).not.toBeNull(); // …so no purge either
  });
});

describe("PCCC-7 — the slug→teamId re-key migration (Codex High 1)", () => {
  it("rewrites a slug-keyed correction to the team-id namespace and drops slug-keyed cache rows — idempotently", async () => {
    const seed = await seedTeam();
    // A 6b-era row: scoped under the SLUG namespace.
    const { error } = await db()
      .from("arc_corrections")
      .insert({ team_id: seed.teamId, arc_id: "legacy-scoped", arc_title: "t", corrected_text: "human take", group_key: `p:${seed.teamSlug}:g_x` });
    expect(error).toBeNull();
    await writeArcCache(db(), seed.teamId, `p:${seed.teamSlug}:g_x`, ARC as never, "h");

    const MIG = (await import("node:fs")).readFileSync("postgres/migrations/20260816130000_arc_scope_keys_team_id.sql", "utf8");
    await runSql(MIG);
    await runSql(MIG); // replay-safe: the second run must be a no-op

    const rekeyed = await runSql<{ group_key: string }>(
      "select group_key from arc_corrections where team_id = $1 and arc_id = 'legacy-scoped'",
      [seed.teamId]
    );
    expect(rekeyed.rows[0].group_key).toBe(`p:${seed.teamId}:g_x`); // the human's edit follows the namespace
    expect(await readArcCache(db(), seed.teamId, `p:${seed.teamSlug}:g_x`)).toBeNull(); // regenerable — dropped
  });
});

describe("PCCC-7 — the orphaned-scope-key sweep", () => {
  it("sweeps p: rows past the age floor; fresh p: rows, tier rows, OTHER TEAMS' rows, and CORRECTIONS are never touched", async () => {
    const seed = await seedTeam();
    const other = await seedTeam();
    await writeArcCache(db(), seed.teamId, `p:${seed.teamId}:old`, ARC as never, "h");
    await writeArcCache(db(), seed.teamId, `p:${seed.teamId}:fresh`, ARC as never, "h");
    await writeArcCache(db(), seed.teamId, "acme_team", ARC as never, "h");
    // Another team's equally-aged straggler — team A's sweep has no business with it. Re-homed
    // from the retired purgeScopedArcCache test (PPARC-4): the team-scoping property outlives
    // the function that first carried it; the sweep is now the only p: deleter.
    await writeArcCache(db(), other.teamId, `p:${other.teamId}:old`, ARC as never, "h");
    // Age the old scoped rows (both teams') and the tier row past the floor.
    await runSql("update arc_cache set computed_at = now() - interval '8 days' where team_id = $1 and group_key = any($2)", [
      seed.teamId,
      [`p:${seed.teamId}:old`, "acme_team"],
    ]);
    await runSql("update arc_cache set computed_at = now() - interval '8 days' where team_id = $1", [other.teamId]);
    // A correction is HUMAN data — the sweep must never touch the corrections store (ruled in the
    // design: cache rows are regenerable, a person's edit is not).
    const { error } = await db()
      .from("arc_corrections")
      .insert({ team_id: seed.teamId, arc_id: "keep", arc_title: "t", corrected_text: "human take", group_key: `p:${seed.teamId}:old` });
    expect(error).toBeNull();

    await sweepStaleScopedArcCache(db(), seed.teamId);

    expect(await readArcCache(db(), seed.teamId, `p:${seed.teamId}:old`)).toBeNull(); // swept
    expect(await readArcCache(db(), seed.teamId, `p:${seed.teamId}:fresh`)).not.toBeNull();
    expect(await readArcCache(db(), seed.teamId, "acme_team")).not.toBeNull(); // tier rows are not the sweep's business
    expect(await readArcCache(db(), other.teamId, `p:${other.teamId}:old`)).not.toBeNull(); // another team's straggler survives
    const kept = await runSql<{ n: number }>("select count(*)::int as n from arc_corrections where team_id = $1", [seed.teamId]);
    expect(kept.rows[0].n).toBe(1);
  });
});
