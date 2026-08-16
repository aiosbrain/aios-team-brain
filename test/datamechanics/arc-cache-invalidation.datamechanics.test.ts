import { describe, expect, it } from "vitest";
import { reconcileProjectedEpisodes } from "@/lib/graph/reconcile";
import { projectItemsToGraph } from "@/lib/graph/project";
import { writeArcCache, readArcCache, purgeScopedArcCache, sweepStaleScopedArcCache } from "@/lib/graph/arc-cache";
import { episodeGroupId } from "@/lib/graph/group";
import { runSql } from "@/lib/db/pg/pool";
import { db, ingest, seedTeam } from "./helpers";
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
  it("a reconcile pass holding a SELF-purge hard-purges the team's p: rows BEFORE the flag can clear — the tier row survives", async () => {
    const seed = await seedTeam();
    const teamGroup = episodeGroupId(seed.teamSlug, "team");
    // A scoped row (the pre-restriction synthesis) and a tier row.
    await writeArcCache(db(), seed.teamId, `p:${seed.teamId}:${teamGroup}`, ARC as never, "h1");
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

    expect(await readArcCache(db(), seed.teamId, `p:${seed.teamId}:${teamGroup}`)).toBeNull(); // purged
    expect(await readArcCache(db(), seed.teamId, teamGroup)).not.toBeNull(); // tier row untouched
  });

  it("purgeScopedArcCache deletes ONLY the p: namespace, and only this team's", async () => {
    const a = await seedTeam();
    const b = await seedTeam();
    await writeArcCache(db(), a.teamId, `p:${a.teamId}:g1`, ARC as never, "h");
    await writeArcCache(db(), a.teamId, "acme_team", ARC as never, "h");
    await writeArcCache(db(), b.teamId, `p:${b.teamId}:g1`, ARC as never, "h");

    await purgeScopedArcCache(db(), a.teamId);
    expect(await readArcCache(db(), a.teamId, `p:${a.teamId}:g1`)).toBeNull();
    expect(await readArcCache(db(), a.teamId, "acme_team")).not.toBeNull();
    expect(await readArcCache(db(), b.teamId, `p:${b.teamId}:g1`)).not.toBeNull();
  });
});

describe("PCCC-7 — the projector's OWN self-clear door (Fable High)", () => {
  it("a purgeBeforeRepush clear also purges the p: rows — the sibling door cannot resurrect a poisoned row", async () => {
    const seed = await seedTeam();
    const teamGroup = episodeGroupId(seed.teamSlug, "team");
    await writeArcCache(db(), seed.teamId, `p:${seed.teamId}:${teamGroup}`, ARC as never, "h1");

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
    expect(await readArcCache(db(), seed.teamId, `p:${seed.teamId}:${teamGroup}`)).toBeNull(); // …and purged first
  });
});

describe("PCCC-7 — the purge trigger is clear-imminent, not flag-exists", () => {
  it("a FRESH self flag (inside the cleanup grace) does not purge the team's p: rows", async () => {
    const seed = await seedTeam();
    const teamGroup = episodeGroupId(seed.teamSlug, "team");
    await writeArcCache(db(), seed.teamId, `p:${seed.teamId}:${teamGroup}`, ARC as never, "h1");
    const r = await ingest(seed, { body: "fresh flag", path: "ff.md", access: "team" });
    await runSql(
      `insert into graph_episodes (team_id, source_table, source_id, group_id, content_sha256, pending_delete_group_id, pending_delete_at, projected_at)
       values ($1, 'items', $2, $3, '', $3, now(), now())`,
      [seed.teamId, r.id, teamGroup]
    );
    await reconcileProjectedEpisodes(db(), client(new FakeGraphiti()), seed.teamId);
    // No clear was possible this pass (grace not elapsed) — readers' scoped rows must survive.
    expect(await readArcCache(db(), seed.teamId, `p:${seed.teamId}:${teamGroup}`)).not.toBeNull();
  });
});

describe("PCCC-7 — the orphaned-scope-key sweep", () => {
  it("sweeps p: rows past the age floor; fresh p: rows, tier rows, and CORRECTIONS are never touched", async () => {
    const seed = await seedTeam();
    await writeArcCache(db(), seed.teamId, `p:${seed.teamId}:old`, ARC as never, "h");
    await writeArcCache(db(), seed.teamId, `p:${seed.teamId}:fresh`, ARC as never, "h");
    await writeArcCache(db(), seed.teamId, "acme_team", ARC as never, "h");
    // Age the old scoped row and the tier row past the floor.
    await runSql("update arc_cache set computed_at = now() - interval '8 days' where team_id = $1 and group_key = any($2)", [
      seed.teamId,
      [`p:${seed.teamId}:old`, "acme_team"],
    ]);
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
    const kept = await runSql<{ n: number }>("select count(*)::int as n from arc_corrections where team_id = $1", [seed.teamId]);
    expect(kept.rows[0].n).toBe(1);
  });
});
