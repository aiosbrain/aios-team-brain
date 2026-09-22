import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { arcCorrectionVersion, recordArcCorrections, listArcCorrections, rollbackArcCorrection } from "@/lib/graph/arc-corrections";
import { runSql } from "@/lib/db/pg/pool";
import { writeArcCache } from "@/lib/graph/arc-cache";
import { db, seedTeam } from "./helpers";

/**
 * Spec (Pass-1 review H13): a human correction to a narrative arc is the ONLY human-authored input in
 * the learning layer, and it lived exclusively in Neo4j.
 *
 * `recomputeArcs` wrote each correction as a `correction:<arc_id>` episode inside a swallowed `catch`,
 * with no Postgres row and no ledger entry for reconcile to heal. Two consequences, both real:
 *   • a Graphiti rollback (which has actually happened here) permanently destroyed every correction;
 *   • a failed episode write silently reverted the user's edit within one cache TTL — they saw their
 *     change land, then watched it disappear, with nothing logged.
 *
 * Both are the same root cause: a projection was being used as the record. Postgres is the record now,
 * and the graph is a derived copy — so the durability question is "does it survive the graph", which is
 * what these specs ask.
 */

describe("arc corrections are durable in Postgres (real Postgres)", () => {
  it("persists a correction and reads it back — with no Graphiti involved at all", async () => {
    // The whole point: this path must not touch the graph. `GRAPHITI_URL` is unset in this tier, so a
    // correction that only survives via an episode would be gone.
    const seed = await seedTeam();
    await recordArcCorrections(db(), seed.teamId, seed.memberId, [
      { arc_id: "arc-abc", arc_title: "Payments migration", corrected_text: "Dana led this, not Alex." },
    ], "acme_external,acme_team");

    const { corrections: stored, ok } = await listArcCorrections(db(), seed.teamId, { groupKey: "acme_external,acme_team", includeLegacy: true });
    expect(ok).toBe(true);
    expect(stored.map((c) => c.corrected_text)).toEqual(["Dana led this, not Alex."]);
  });

  it("keeps the LATEST correction per arc rather than stacking duplicates", async () => {
    // A user correcting the same arc twice means the second supersedes the first — feeding both to the
    // prompt would have them argue with each other.
    const seed = await seedTeam();
    const one = { arc_id: "arc-abc", arc_title: "Payments migration", corrected_text: "first take" };
    await recordArcCorrections(db(), seed.teamId, seed.memberId, [one], "acme_external,acme_team");
    await recordArcCorrections(db(), seed.teamId, seed.memberId, [{ ...one, corrected_text: "second take" }], "acme_external,acme_team");

    const { corrections: stored, ok } = await listArcCorrections(db(), seed.teamId, { groupKey: "acme_external,acme_team", includeLegacy: true });
    expect(ok).toBe(true);
    expect(stored).toHaveLength(1);
    expect(stored[0].corrected_text).toBe("second take");
  });

  it("appends immutable revisions, preserves dependency lineage, and rolls back by pointer", async () => {
    const seed = await seedTeam();
    const sourceA = randomUUID();
    const sourceB = randomUUID();
    await recordArcCorrections(db(), seed.teamId, seed.memberId, [{
      arc_id: "immutable", arc_title: "Immutable", corrected_text: "first",
      provenance_state: "complete", source_item_ids: [sourceA], captured_authorization_epoch: 1,
    }], "g:immutable");
    const first = (await listArcCorrections(db(), seed.teamId, { groupKey: "g:immutable", includeLegacy: false })).corrections[0];
    await recordArcCorrections(db(), seed.teamId, seed.memberId, [{
      arc_id: "immutable", arc_title: "Immutable", corrected_text: "second",
      provenance_state: "complete", source_item_ids: [sourceA, sourceB],
      source_correction_revision_ids: [first.revision_id!], captured_authorization_epoch: 1,
    }], "g:immutable");
    const current = (await listArcCorrections(db(), seed.teamId, { groupKey: "g:immutable", includeLegacy: false })).corrections[0];
    expect(current.corrected_text).toBe("second");
    expect((await db().from("arc_correction_revisions").select("id").eq("correction_id", current.id)).data).toHaveLength(2);
    expect((await db().from("arc_correction_revision_dependencies").select("source_item_id")
      .eq("revision_id", first.revision_id!)).data).toEqual([{ source_item_id: sourceA }]);
    expect((await db().from("arc_correction_revision_parents").select("parent_revision_id")
      .eq("revision_id", current.revision_id!)).data).toEqual([{ parent_revision_id: first.revision_id }]);
    const versionBeforeRollback = await arcCorrectionVersion(seed.teamId);
    await rollbackArcCorrection(seed.teamId, current.id, first.revision_id!);
    const rolledBack = (await listArcCorrections(db(), seed.teamId, { groupKey: "g:immutable", includeLegacy: false })).corrections[0];
    expect(rolledBack.corrected_text).toBe("first");
    expect(await arcCorrectionVersion(seed.teamId)).toBe(versionBeforeRollback + 1);
  });

  it("rejects a paused old correction-version publisher even when dependency count is unchanged", async () => {
    const seed = await seedTeam();
    const source = randomUUID();
    const edit = (text: string) => recordArcCorrections(db(), seed.teamId, seed.memberId, [{
      arc_id: "paused", arc_title: "Paused", corrected_text: text,
      provenance_state: "complete" as const, source_item_ids: [source], captured_authorization_epoch: 1,
    }], "g:paused");
    await edit("A");
    const pausedVersion = await arcCorrectionVersion(seed.teamId);
    await edit("B");
    expect(await writeArcCache(db(), seed.teamId, "g:paused", [], "same-count", {
      authorizationEpoch: 1,
      correctionVersion: pausedVersion,
    })).toBe(false);
  });

  it("scopes corrections to their team", async () => {
    const a = await seedTeam();
    const b = await seedTeam();
    await recordArcCorrections(db(), a.teamId, a.memberId, [
      { arc_id: "x", arc_title: "t", corrected_text: "team A only" },
    ], "acme_external,acme_team");
    expect((await listArcCorrections(db(), b.teamId, { groupKey: "acme_external,acme_team", includeLegacy: true })).corrections).toEqual([]);
  });

  it("records WHO corrected it, so the edit is attributable", async () => {
    const seed = await seedTeam();
    await recordArcCorrections(db(), seed.teamId, seed.memberId, [
      { arc_id: "x", arc_title: "t", corrected_text: "mine" },
    ], "acme_external,acme_team");
    const { data } = await db()
      .from("arc_corrections")
      .select("created_by, arc_title")
      .eq("team_id", seed.teamId)
      .maybeSingle();
    const row = data as { created_by: string; arc_title: string };
    expect(row.created_by).toBe(seed.memberId);
    // The TITLE is stored alongside the id because `arc_id` is a hash of the title and churns on every
    // recompute (M7). Without it a correction becomes an un-diagnosable orphan the moment arcs re-rank.
    expect(row.arc_title).toBe("t");
  });

  it("a failed write is NOT swallowed — the user must not be told an edit saved when it didn't", async () => {
    const seed = await seedTeam();
    await expect(
      // No such member → FK violation. Previously the whole writeback lived in a bare `catch {}`.
      recordArcCorrections(db(), seed.teamId, "00000000-0000-4000-8000-000000000000", [
        { arc_id: "x", arc_title: "t", corrected_text: "should not silently vanish" },
      ], "acme_external,acme_team")
    ).rejects.toThrow();
  });

  it("PCCC6B-1: a correction NEVER feeds a different scope — exact group_key match only", async () => {
    const seed = await seedTeam();
    await recordArcCorrections(db(), seed.teamId, seed.memberId, [
      { arc_id: "a1", arc_title: "t", corrected_text: "scope X prose" },
    ], "p:acme:g_x");
    // Another scope on the same team: invisible, both ways.
    const other = await listArcCorrections(db(), seed.teamId, { groupKey: "p:acme:g_y", includeLegacy: false });
    expect(other.ok).toBe(true);
    expect(other.corrections).toEqual([]);
    // The correction's own scope: visible.
    const own = await listArcCorrections(db(), seed.teamId, { groupKey: "p:acme:g_x", includeLegacy: false });
    expect(own.corrections.map((c) => c.corrected_text)).toEqual(["scope X prose"]);
  });

  it("PCCC6B-1: the same arc corrected in TWO scopes is two independent rows — one member's edit can never MOVE another's (Fable 6b High 2)", async () => {
    const seed = await seedTeam();
    await recordArcCorrections(db(), seed.teamId, seed.memberId, [
      { arc_id: "shared-title", arc_title: "t", corrected_text: "scope A take" },
    ], "p:acme:g_a");
    await recordArcCorrections(db(), seed.teamId, seed.memberId, [
      { arc_id: "shared-title", arc_title: "t", corrected_text: "scope B take" },
    ], "p:acme:g_b");
    // Scope A's row survives B's write — under the old team-global unique, B's upsert MOVED it.
    const a = await listArcCorrections(db(), seed.teamId, { groupKey: "p:acme:g_a", includeLegacy: false });
    expect(a.corrections.map((c) => c.corrected_text)).toEqual(["scope A take"]);
    const b = await listArcCorrections(db(), seed.teamId, { groupKey: "p:acme:g_b", includeLegacy: false });
    expect(b.corrections.map((c) => c.corrected_text)).toEqual(["scope B take"]);
  });

  it("PCCC6B-1: a tier-path RE-correction supersedes its pre-6b legacy row — one take per arc reaches the prompt (second-pass Medium)", async () => {
    const seed = await seedTeam();
    // The legacy row (pre-6b: group_key ''), then the post-6b re-correction under the tier key —
    // two DIFFERENT rows under the per-scope arbiter, both admitted by the tier read.
    const { error } = await db()
      .from("arc_corrections")
      .insert({ team_id: seed.teamId, arc_id: "arc-re", arc_title: "t", corrected_text: "the REJECTED take" });
    expect(error).toBeNull();
    await recordArcCorrections(db(), seed.teamId, seed.memberId, [
      { arc_id: "arc-re", arc_title: "t", corrected_text: "the CURRENT take" },
    ], "acme_external,acme_team");

    const tier = await listArcCorrections(db(), seed.teamId, {
      groupKey: "acme_external,acme_team",
      includeLegacy: true,
    });
    expect(tier.corrections.map((c) => c.corrected_text)).toEqual(["the CURRENT take"]);
  });

  it("the re-correction supersedes even when the legacy row's timestamp reads NEWER — the clock-inversion CI caught (deterministic)", async () => {
    // The latent shape: recordArcCorrections stamps the APP clock at ms precision; the legacy
    // row carries the DB clock at µs precision. Written <1ms apart (fast CI) or under app/DB
    // clock skew, the legacy timestamp reads newer and newest-first resurrected the rejected
    // take. Force that inversion EXPLICITLY so the test cannot depend on execution speed.
    const seed = await seedTeam();
    const { error } = await db()
      .from("arc_corrections")
      .insert({ team_id: seed.teamId, arc_id: "arc-inv", arc_title: "t", corrected_text: "the REJECTED take" });
    expect(error).toBeNull();
    await recordArcCorrections(db(), seed.teamId, seed.memberId, [
      { arc_id: "arc-inv", arc_title: "t", corrected_text: "the CURRENT take" },
    ], "acme_external,acme_team");
    // Backdate nothing — FORWARD-date the legacy row past the scoped one by sub-millisecond.
    await runSql(
      `update arc_corrections set updated_at =
         (select updated_at from arc_corrections where team_id = $1 and arc_id = 'arc-inv' and group_key <> '') + interval '0.7 milliseconds'
       where team_id = $1 and arc_id = 'arc-inv' and group_key = ''`,
      [seed.teamId]
    );

    const tier = await listArcCorrections(db(), seed.teamId, {
      groupKey: "acme_external,acme_team",
      includeLegacy: true,
    });
    expect(tier.corrections.map((c) => c.corrected_text), "scoped beats legacy regardless of clock").toEqual(["the CURRENT take"]);
  });

  it("PCCC6B-1: legacy '' rows feed ONLY a scope that opts in (the tier path) — a partition scope refuses them", async () => {
    const seed = await seedTeam();
    // A pre-6b row: written before group_key existed (simulated by the column default).
    const { error } = await db()
      .from("arc_corrections")
      .insert({ team_id: seed.teamId, arc_id: "legacy", arc_title: "old", corrected_text: "pre-6b tier prose" });
    expect(error).toBeNull();

    const tier = await listArcCorrections(db(), seed.teamId, {
      groupKey: "acme_external,acme_team",
      includeLegacy: true,
    });
    expect(tier.corrections.map((c) => c.arc_id)).toEqual(["legacy"]);

    const partition = await listArcCorrections(db(), seed.teamId, { groupKey: "p:acme:g_x", includeLegacy: false });
    expect(partition.corrections).toEqual([]);
  });

  it("migration is additive/replay-safe and legacy corrections default to unproven", async () => {
    const seed = await seedTeam();
    await db().from("arc_corrections").insert({
      team_id: seed.teamId, arc_id: "legacy-provenance", arc_title: "Legacy",
      corrected_text: "history only", group_key: "g:legacy",
    });
    const migration = readFileSync(
      "postgres/migrations/20260922160000_arc_correction_source_dependencies.sql",
      "utf8",
    );
    await runSql(migration, []);
    await runSql(migration, []);
    const revisionsMigration = readFileSync(
      "postgres/migrations/20260922170000_arc_correction_immutable_revisions.sql",
      "utf8",
    );
    await runSql(revisionsMigration, []);
    await runSql(revisionsMigration, []);
    const { data } = await db().from("arc_corrections")
      .select("provenance_state,source_dependency_count,captured_authorization_epoch")
      .eq("team_id", seed.teamId).eq("arc_id", "legacy-provenance").single();
    expect(data).toEqual({
      provenance_state: "unproven",
      source_dependency_count: 0,
      captured_authorization_epoch: null,
    });
    const { data: logical } = await db().from("arc_corrections")
      .select("current_revision_id").eq("team_id", seed.teamId).eq("arc_id", "legacy-provenance").single();
    expect((logical as { current_revision_id: string }).current_revision_id).toBeTruthy();
    const { data: revision } = await db().from("arc_correction_revisions")
      .select("provenance_state,parent_revision_count")
      .eq("id", (logical as { current_revision_id: string }).current_revision_id).single();
    expect(revision).toEqual({ provenance_state: "unproven", parent_revision_count: 0 });
  });
});
