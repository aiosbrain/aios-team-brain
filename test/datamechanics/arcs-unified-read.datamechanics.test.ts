import { describe, expect, it } from "vitest";
import { db, ingest, seedTeam, type Seed } from "./helpers";
import { runSql } from "@/lib/db/pg/pool";
import { readFileSync } from "node:fs";
import { backfillTeamContext } from "@/lib/projects/context/backfill";
import { ensureAccessBootstrap } from "@/lib/access/bootstrap";
import { setAccessEnforcement } from "@/lib/admin/access-enforcement";
import { episodeGroupId } from "@/lib/graph/group";
import { writeArcCache, readArcCache } from "@/lib/graph/arc-cache";
import { getFusedArcs } from "@/lib/graph/arc-fusion";
import { resolveArcScope } from "@/lib/graph/partition-read";
import { purgeExternalTierCaches } from "@/lib/cache/tier-invalidation";

/**
 * PRET-3 — arcs unification (spec docs/design/pret3-arcs-unification.md §4 criteria 1-2 + the
 * H2/H3 ruling pins). The fused panel is the ONLY arcs read: every reader class resolves through
 * `resolveArcScope` and is served from `g:` partition rows; the tier-row path stays COLD
 * (sentinel-content form — spec L3: a pre-seeded tier-key row's content must not appear, and no
 * NEW tier-key row may be minted by the read).
 */

const ARC = (s: string) => [{ id: `a-${s}`, title: `t-${s}`, confidence: "high", summary: s, participants: [], supporting_sources: [], evidence: [], derived_at: new Date().toISOString() }];
const KEYS = { anthropicApiKey: null, openaiApiKey: null } as never;

async function tierKeyRows(teamId: string): Promise<number> {
  const r = await runSql<{ n: number }>(
    "select count(*)::int as n from arc_cache where team_id = $1 and group_key not like 'g:%'",
    [teamId]
  );
  return r.rows[0].n;
}

describe("PRET-3 — resolveArcScope is mode-keyed (the one resolution, spec §3)", () => {
  it("permissive team-tier → built-in pointer partitions, arm false; external → the external built-in", async () => {
    const seed = await seedTeam();
    expect((await ensureAccessBootstrap(db(), seed.teamId)).ok).toBe(true);
    const teamGroup = episodeGroupId(seed.teamSlug, "team");
    const extGroup = episodeGroupId(seed.teamSlug, "external");

    const t = await resolveArcScope(db(), { teamId: seed.teamId, teamSlug: seed.teamSlug, memberId: seed.memberId, tier: "team" });
    expect(t.arm).toBe(false);
    expect([...t.groups].sort()).toEqual([extGroup, teamGroup].sort());

    const x = await resolveArcScope(db(), { teamId: seed.teamId, teamSlug: seed.teamSlug, memberId: seed.memberId, tier: "external" });
    expect(x.arm).toBe(false);
    expect(x.groups).toEqual([extGroup]);
  });

  it("enforcing team → the member's oracle scope, arm true — for EVERY tier (no external-specific branch)", async () => {
    const seed = await seedTeam();
    await ingest(seed, { path: "e.md", body: "enforced content", access: "team", project: "src" });
    await backfillTeamContext(db(), seed.teamId);
    expect((await setAccessEnforcement(db(), seed.teamId, "enforcing")).ok).toBe(true);

    const r = await resolveArcScope(db(), { teamId: seed.teamId, teamSlug: seed.teamSlug, memberId: seed.memberId, tier: "team" });
    expect(r.arm).toBe(true);
    expect(r.groups.length).toBeGreaterThan(0); // the oracle resolved their partitions
  });

  it("enforcing team, EXTERNAL member → their oracle resolves the external-shared partition, arm true (ruling 2's new surface — diff-review L3)", async () => {
    const { randomUUID } = await import("node:crypto");
    const seed = await seedTeam();
    await ingest(seed, { path: "x.md", body: "external shared content", access: "external", project: "src" });
    await backfillTeamContext(db(), seed.teamId);
    expect((await setAccessEnforcement(db(), seed.teamId, "enforcing")).ok).toBe(true);
    // A REAL external member, created through the admin path so the built-in group sync runs
    // (a raw insert would leave them ungrouped and the oracle would resolve nothing).
    const { createMember } = await import("@/lib/admin/members");
    const m = await createMember(db(), seed.teamId, { email: `${randomUUID()}@test.local`, displayName: "Ext", actorHandle: `x-${randomUUID().slice(0, 8)}`, role: "member", tier: "external" });
    expect(m.id).toBeTruthy();
    // createMember leaves the member INVITED (the oracle rightly resolves non-active members
    // to nothing) but — since PRET-4 — has already written their builtin row from the invite
    // default, so activation is just the status flip (no recompute exists to call).
    await db().from("members").update({ status: "active" }).eq("id", m.id);

    const r = await resolveArcScope(db(), { teamId: seed.teamId, teamSlug: seed.teamSlug, memberId: m.id, tier: "external" });
    expect(r.arm, "an enforcing member's read arms — any tier").toBe(true);
    const extGroup = episodeGroupId(seed.teamSlug, "external");
    expect(r.groups, "the external member's oracle resolves exactly the external-shared partition").toEqual([extGroup]);
  });
});

describe("PRET-3 — the tier-row path stays COLD for re-routed readers (criterion 1, sentinel form)", () => {
  it("a permissive member's panel serves g: content; the tier-key sentinel never appears; no new tier row is minted", async () => {
    const seed = await seedTeam();
    expect((await ensureAccessBootstrap(db(), seed.teamId)).ok).toBe(true);
    const teamGroup = episodeGroupId(seed.teamSlug, "team");
    const extGroup = episodeGroupId(seed.teamSlug, "external");
    await writeArcCache(db(), seed.teamId, `g:${teamGroup}`, ARC("partition-team-prose") as never, "h1");
    await writeArcCache(db(), seed.teamId, `g:${extGroup}`, ARC("partition-ext-prose") as never, "h2");
    // The SENTINEL: a tier-key row whose content must never be served post-cutover.
    const tierKey = [teamGroup, extGroup].sort().join(",");
    await writeArcCache(db(), seed.teamId, tierKey, ARC("TIER-SENTINEL-PROSE") as never, "h3");
    const before = await tierKeyRows(seed.teamId);

    const scope = await resolveArcScope(db(), { teamId: seed.teamId, teamSlug: seed.teamSlug, memberId: seed.memberId, tier: "team" });
    const panel = await getFusedArcs(db(), seed.teamId, seed.teamSlug, scope.groups, KEYS);
    const summaries = panel.arcs.map((a) => a.summary).join(" ");
    expect(summaries).toContain("partition-team-prose");
    expect(summaries).toContain("partition-ext-prose");
    expect(summaries, "the retired path's content must not be served").not.toContain("TIER-SENTINEL-PROSE");
    expect(await tierKeyRows(seed.teamId), "a cold tier read would have minted a new tier-key row").toBe(before);
  });

  it("an external member's panel is the external partition's row only", async () => {
    const seed = await seedTeam();
    expect((await ensureAccessBootstrap(db(), seed.teamId)).ok).toBe(true);
    const teamGroup = episodeGroupId(seed.teamSlug, "team");
    const extGroup = episodeGroupId(seed.teamSlug, "external");
    await writeArcCache(db(), seed.teamId, `g:${teamGroup}`, ARC("team-only-prose") as never, "h1");
    await writeArcCache(db(), seed.teamId, `g:${extGroup}`, ARC("ext-shared-prose") as never, "h2");

    const scope = await resolveArcScope(db(), { teamId: seed.teamId, teamSlug: seed.teamSlug, memberId: seed.memberId, tier: "external" });
    const panel = await getFusedArcs(db(), seed.teamId, seed.teamSlug, scope.groups, KEYS);
    const summaries = panel.arcs.map((a) => a.summary).join(" ");
    expect(summaries).toContain("ext-shared-prose");
    expect(summaries, "team partitions must never reach an external panel").not.toContain("team-only-prose");
  });
});

describe("PRET-3 H2 — tier-keyed corrections are re-keyed, not stranded", () => {
  it("the migration re-keys a tier-set correction to g:<slug>_team, idempotently; '' rows stay unread-but-kept", async () => {
    const seed = await seedTeam();
    // The migration resolves the STORED General pointer — the bootstrap must have run (as it
    // has on every real team; the scheduler tick guarantees it fleet-wide).
    expect((await ensureAccessBootstrap(db(), seed.teamId)).ok).toBe(true);
    const teamGroup = episodeGroupId(seed.teamSlug, "team");
    const extGroup = episodeGroupId(seed.teamSlug, "external");
    const tierKey = [teamGroup, extGroup].sort().join(",");
    const { error } = await db()
      .from("arc_corrections")
      .insert({ team_id: seed.teamId, arc_id: "arc-tier", arc_title: "t", corrected_text: "the human take", group_key: tierKey });
    expect(error).toBeNull();
    const { error: e2 } = await db()
      .from("arc_corrections")
      .insert({ team_id: seed.teamId, arc_id: "arc-legacy", arc_title: "t", corrected_text: "pre-6b", group_key: "" });
    expect(e2).toBeNull();

    // Diff-review H1/H2 fixtures: a kept-p: multi-group row (the PPARC-3 ruling must survive
    // this migration) and a COLLIDING second tier-era row for the same arc (two eligible
    // siblings mapping to one target must not violate the per-scope unique and halt a deploy).
    const { error: e3 } = await db()
      .from("arc_corrections")
      .insert({ team_id: seed.teamId, arc_id: "arc-multi", arc_title: "t", corrected_text: "union take", group_key: `p:${seed.teamId}:${teamGroup},${extGroup}` });
    expect(e3).toBeNull();
    const { error: e4 } = await db()
      .from("arc_corrections")
      .insert({ team_id: seed.teamId, arc_id: "arc-tier", arc_title: "t", corrected_text: "the OLDER sibling", group_key: `${teamGroup}` });
    expect(e4).toBeNull();
    await runSql("update arc_corrections set updated_at = now() - interval '1 day' where team_id = $1 and corrected_text = 'the OLDER sibling'", [seed.teamId]);

    const MIG = readFileSync("postgres/migrations/20260817150000_arc_corrections_tier_rekey.sql", "utf8");
    await runSql(MIG);
    await runSql(MIG); // replay-safe

    const rekeyed = await runSql<{ group_key: string }>(
      "select group_key from arc_corrections where team_id = $1 and arc_id = 'arc-tier'",
      [seed.teamId]
    );
    expect(rekeyed.rows[0].group_key).toBe(`g:${teamGroup}`);
    const legacy = await runSql<{ group_key: string }>(
      "select group_key from arc_corrections where team_id = $1 and arc_id = 'arc-legacy'",
      [seed.teamId]
    );
    expect(legacy.rows[0].group_key, "'' rows keep the PPARC-3 disposition — kept, unread").toBe("");
    const multi = await runSql<{ group_key: string }>(
      "select group_key from arc_corrections where team_id = $1 and arc_id = 'arc-multi'",
      [seed.teamId]
    );
    expect(multi.rows[0].group_key, "p: multi-group rows keep THEIR ruling too — never laundered into General").toContain("p:");
    const siblings = await runSql<{ group_key: string }>(
      "select group_key from arc_corrections where team_id = $1 and arc_id = 'arc-tier' order by group_key",
      [seed.teamId]
    );
    // The NEWEST eligible sibling won the slot; the older one stays kept-unread — no collision.
    expect(siblings.rows.map((r) => r.group_key)).toEqual([`${teamGroup}`, `g:${teamGroup}`].sort());
  });
});

describe("PRET-3 H3 — the reclassification purge door covers the external PARTITION row", () => {
  it("purgeExternalTierCaches hard-deletes g:<slug>_external — the SWR leak stays closed for external readers", async () => {
    const seed = await seedTeam();
    expect((await ensureAccessBootstrap(db(), seed.teamId)).ok).toBe(true);
    const teamGroup = episodeGroupId(seed.teamSlug, "team");
    const extGroup = episodeGroupId(seed.teamSlug, "external");
    await writeArcCache(db(), seed.teamId, `g:${extGroup}`, ARC("pre-narrowing external prose") as never, "h1");
    await writeArcCache(db(), seed.teamId, `g:${teamGroup}`, ARC("team prose") as never, "h2");

    await purgeExternalTierCaches(db(), seed.teamId, seed.teamSlug);

    expect(await readArcCache(db(), seed.teamId, `g:${extGroup}`), "hard-deleted, not stale-marked").toBeNull();
    expect(await readArcCache(db(), seed.teamId, `g:${teamGroup}`), "the team partition is not the door's business").not.toBeNull();
  });

  it("…and on a RENAMED team the door follows the FROZEN pointer, not the current slug (review H4)", async () => {
    const seed = await seedTeam();
    expect((await ensureAccessBootstrap(db(), seed.teamId)).ok).toBe(true);
    const frozenExt = episodeGroupId(seed.teamSlug, "external"); // the pointer minted pre-rename
    await writeArcCache(db(), seed.teamId, `g:${frozenExt}`, ARC("pre-rename external prose") as never, "h1");
    // The rename: the slug moves, the built-in's pointer stays frozen (the rename doctrine).
    const newSlug = `${seed.teamSlug}x`;
    await runSql("update teams set slug = $2 where id = $1", [seed.teamId, newSlug]);

    await purgeExternalTierCaches(db(), seed.teamId, newSlug);

    expect(
      await readArcCache(db(), seed.teamId, `g:${frozenExt}`),
      "a slug-derived key would miss the frozen pointer and leave the served row alive"
    ).toBeNull();
  });
});
