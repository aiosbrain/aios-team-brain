import { describe, expect, it } from "vitest";
import { db, ingest, seedTeam, type Seed } from "./helpers";
import { retrieve } from "@/lib/query/retrieve";
import { rankedFtsSearch } from "@/lib/query/fts-search";
import { backfillTeamContext } from "@/lib/projects/context/backfill";
import { visibleItemIds } from "@/lib/access/enforce";
import { createGroup, grantProjectToGroup } from "@/lib/access/groups";

// Phase B slice 2 (spec §5.2/§5.8b), post-PRET-6 — the enforced retrieval path is the only one.
// The proofs: the item legs filter to the member's vis-set so a restricted item's content NEVER
// reaches an outsider's answer; the unpartitionable legs stay omitted. Item-grounded content is
// what the answer cites, so a leak here is a live leak.

const TERM = "waffleberry"; // a rare term present in both bodies so FTS matches both

async function retrievedPaths(seed: Seed, memberId: string | null): Promise<string[]> {
  const enforce = memberId ? { visibleItemIds: (await visibleItemIds(db(), { teamId: seed.teamId, memberId })).ids } : null;
  const ctx = await retrieve(db(), seed.teamId, "team", `tell me about ${TERM}`, null, enforce);
  return ctx.sources.map((s) => s.path);
}

async function seedMember(seed: Seed): Promise<string> {
  const { randomUUID } = await import("node:crypto");
  const { data } = await db()
    .from("members")
    .insert({ team_id: seed.teamId, email: `${randomUUID()}@test.local`, display_name: "M", actor_handle: `h-${randomUUID().slice(0, 10)}`, role: "member", tier: "team", status: "active" })
    .select("id")
    .single();
  const { placeMemberByTier } = await import("./helpers");
  await placeMemberByTier(seed.teamId, data!.id as string, "team");
  return data!.id as string;
}

describe("enforced retrieval (Phase B slice 2)", () => {
  // Deleted WITH its subject (PRET-6): "permissive: retrieve returns both items (byte-identical
  // — enforce arg is null)" — a null view now THROWS (fail closed; with the posture walls gone
  // it would have run the item legs unfiltered). The member breadth control is below.
  it("a team member's retrieval reaches the whole General corpus (breadth control)", async () => {
    const seed = await seedTeam();
    await ingest(seed, { path: "open.md", body: `open ${TERM} note`, access: "team", project: "src" });
    await ingest(seed, { path: "other.md", body: `other ${TERM} note`, access: "team", project: "src" });
    await backfillTeamContext(db(), seed.teamId);
    const member = await seedMember(seed);
    const got = await retrievedPaths(seed, member);
    expect(got).toContain("open.md");
    expect(got).toContain("other.md");
  });

  it("retrieve WITHOUT an enforcement view throws — the fail-open seam is closed (PRET-6)", async () => {
    const seed = await seedTeam();
    await ingest(seed, { path: "seam.md", body: `seam ${TERM}`, access: "team", project: "src" });
    await backfillTeamContext(db(), seed.teamId);
    await expect(retrieve(db(), seed.teamId, "team", `about ${TERM}`, null, null)).rejects.toThrow(/enforcement view/);
  });

  it("enforcing: an outsider's answer cites the General item but NOT a restricted-project item (the leak this closes)", async () => {
    const seed = await seedTeam();
    const outsider = await seedMember(seed);
    const openItem = await ingest(seed, { path: "shared.md", body: `shared ${TERM} note`, access: "team", project: "src" });
    const secret = await ingest(seed, { path: "restricted.md", body: `restricted ${TERM} secret`, access: "team", project: "src" });
    await backfillTeamContext(db(), seed.teamId);

    // Move the secret into a restricted project the outsider can't see.
    const restricted = await db().from("projects").insert({ team_id: seed.teamId, slug: "vault", name: "Vault", kind: "initiative" }).select("id").single();
    const g = await createGroup(db(), seed.teamId, "vaultgroup", "Vault", seed.memberId);
    await grantProjectToGroup(db(), seed.teamId, restricted.data!.id, g.groupId!, seed.memberId);
    const { data: unit } = await db().from("project_context_units").select("id").eq("source_item_id", secret.id).single();
    await db().from("project_context_memberships").update({ valid_to: new Date().toISOString() }).eq("context_unit_id", unit!.id);
    await db().from("project_context_memberships").insert({ team_id: seed.teamId, project_id: restricted.data!.id, context_unit_id: unit!.id, method: "manual" });

    const got = await retrievedPaths(seed, outsider); // enforcing (visibleItemIds computed)
    expect(got, "General content still reaches the answer").toContain("shared.md");
    expect(got, "restricted content must NEVER reach an outsider's retrieval").not.toContain("restricted.md");
    void openItem;
  });

  it("enforcing: the commitments leg stays OMITTED — even for the member arm (QMIR-1: no production writer; a future one must be partition-classed from birth)", async () => {
    const seed = await seedTeam();
    await ingest(seed, { path: "g.md", body: `g ${TERM}`, access: "team", project: "src" });
    await backfillTeamContext(db(), seed.teamId);
    // Plant a commitment graph entity — served to NOBODY post-PRET-6 (the permissive control
    // that used to prove the leg live died with its mode; non-vacuity: the row exists, below).
    await db().from("graph_entities").insert({ team_id: seed.teamId, entity_id: `c-${Date.now()}`, entity_type: "commitment", name: "ship the widget", attrs: { status: "open" } });
    const member = await seedMember(seed);
    const { data: planted } = await db().from("graph_entities").select("id").eq("team_id", seed.teamId).eq("entity_type", "commitment");
    expect((planted ?? []).length, "non-vacuity: the commitment row exists").toBe(1);

    // The MEMBER arm — the strongest form: QMIR-1 reopened the org-structural legs for exactly
    // this principal, and the commitments leg must stay closed even so. (The actors-half
    // INVERSION is pinned in test/datamechanics/query-mirror-legs.datamechanics.test.ts.)
    const enforce = { visibleItemIds: (await visibleItemIds(db(), { teamId: seed.teamId, memberId: member })).ids, principal: "member" as const };
    const enforcing = await retrieve(db(), seed.teamId, "team", `about ${TERM}`, null, enforce);
    expect(enforcing.structured, "enforcing OMITS commitments (type allowlist, QMIR-1)").not.toContain("ship the widget");
  });

  it("enforcing: a decision AND task tied to a RESTRICTED item are dropped from the structured block (source-item gate)", async () => {
    const seed = await seedTeam();
    const item = await ingest(seed, { path: "d.md", body: `d ${TERM}`, access: "team", project: "src" });
    const srcProj = (await db().from("projects").select("id").eq("team_id", seed.teamId).eq("slug", "src").single()).data!.id;
    const decErr = (await db().from("decisions").insert({ team_id: seed.teamId, row_key: "DEC-9", title: `${TERM} decision`, decided_by: "chetan", still_valid: true, source_item_id: item.id, project_id: srcProj })).error;
    expect(decErr, "decision fixture must insert").toBeNull();
    const taskErr = (await db().from("tasks").insert({ team_id: seed.teamId, row_key: "TSK-9", title: `${TERM} task`, status: "in_progress", origin: "sync", source_item_id: item.id, project_id: srcProj })).error;
    expect(taskErr, "task fixture must insert").toBeNull();
    await backfillTeamContext(db(), seed.teamId);

    // PRESENCE control (the permissive one died with its mode): an ENTITLED member sees both.
    const insider = await seedMember(seed);
    const insiderView = { visibleItemIds: (await visibleItemIds(db(), { teamId: seed.teamId, memberId: insider })).ids };
    const present = await retrieve(db(), seed.teamId, "team", `${TERM} decision`, null, insiderView);
    expect(present.structured).toContain("DEC-9");
    expect(present.structured).toContain("TSK-9");

    // Restrict the item away from the outsider, then enforce.
    const outsider = await seedMember(seed);
    const restricted = await db().from("projects").insert({ team_id: seed.teamId, slug: "dv", name: "DV", kind: "initiative" }).select("id").single();
    const g = await createGroup(db(), seed.teamId, "dvg", "DV", seed.memberId);
    await grantProjectToGroup(db(), seed.teamId, restricted.data!.id, g.groupId!, seed.memberId);
    const { data: unit } = await db().from("project_context_units").select("id").eq("source_item_id", item.id).single();
    await db().from("project_context_memberships").update({ valid_to: new Date().toISOString() }).eq("context_unit_id", unit!.id);
    await db().from("project_context_memberships").insert({ team_id: seed.teamId, project_id: restricted.data!.id, context_unit_id: unit!.id, method: "manual" });

    const enforce = { visibleItemIds: (await visibleItemIds(db(), { teamId: seed.teamId, memberId: outsider })).ids };
    const enforcing = await retrieve(db(), seed.teamId, "team", `${TERM} decision`, null, enforce);
    expect(enforcing.structured, "restricted decision must not surface").not.toContain("DEC-9");
    expect(enforcing.structured, "restricted task must not surface").not.toContain("TSK-9");
  });

  it("the people-activity digest AND the full-corpus task-count are omitted for every member (unpartitionable legs, parked pending partition-classing)", async () => {
    // The permissive live-leg control died with its mode; the fixture still QUALIFIES for the
    // digest (attributed, non-git source, activity-intent question), so the omission is the
    // filter's doing, not a missing precondition.
    const seed = await seedTeam();
    await ingest(seed, { path: "act.md", body: `act ${TERM}`, access: "team", project: "src", frontmatter: { source: "slack" } });
    await db().from("items").update({ member_id: seed.memberId }).eq("team_id", seed.teamId).eq("path", "act.md");
    await backfillTeamContext(db(), seed.teamId);
    const member = await seedMember(seed);
    const q = "who is working on what this week";

    const enforce = { visibleItemIds: (await visibleItemIds(db(), { teamId: seed.teamId, memberId: member })).ids };
    const enforcing = await retrieve(db(), seed.teamId, "team", q, null, enforce);
    expect(enforcing.structured, "the people-activity digest is omitted (would name restricted work)").not.toContain("## Activity by person");
    expect(enforcing.structured, "the full-corpus task-count is omitted").not.toMatch(/## Task counts \(all \d+ tasks/);
    expect(enforcing.structured).toContain("## Tasks visible to you");
  });

  it("enforcing: the FTS membership filter is IN-QUERY — louder invisible rows can't crowd a visible item out of the top-N (under-return)", async () => {
    const seed = await seedTeam();
    // Two rows the principal can't see, ranking ABOVE the visible one (the term repeated), and a
    // limit of 2. A post-filter would fill the top-2 with the invisible rows and return nothing.
    const loud = `${TERM} ${TERM} ${TERM} ${TERM}`;
    await ingest(seed, { path: "invis-1.md", body: `${loud} secret one`, access: "team", project: "src" });
    await ingest(seed, { path: "invis-2.md", body: `${loud} secret two`, access: "team", project: "src" });
    const vis = await ingest(seed, { path: "vis.md", body: `quiet ${TERM} note`, access: "team", project: "src" });
    const hits = await rankedFtsSearch(seed.teamId, "team", TERM, 2, null, [vis.id]);
    expect(hits.map((h) => h.path), "limit must rank over VISIBLE rows only").toEqual(["vis.md"]);
  });

  it("enforcing: the recency membership filter is IN-QUERY — 8 newer invisible items can't crowd out the visible one", async () => {
    const seed = await seedTeam();
    // The visible item is the OLDEST and matches the question only via recency (no TERM in body),
    // so it reaches sources through the recency leg alone. 8 newer invisible items fill the leg's
    // limit(8) page if the filter is applied after the page is cut.
    const vis = await ingest(seed, { path: "vis-old.md", body: "quiet old note", access: "team", project: "src" });
    for (let i = 0; i < 8; i++) {
      await ingest(seed, { path: `fresh-${i}.md`, body: `fresh note ${i}`, access: "team", project: "src" });
    }
    await db().from("items").update({ work_at: "2020-01-01T00:00:00Z" }).eq("team_id", seed.teamId).eq("path", "vis-old.md");
    await backfillTeamContext(db(), seed.teamId);
    const ctx = await retrieve(db(), seed.teamId, "team", "what is happening lately", null, { visibleItemIds: new Set([vis.id]) });
    expect(ctx.sources.map((s) => s.path), "the recency page must be cut over VISIBLE rows").toContain("vis-old.md");
  });

  it("a HAND-TYPED task (created_by set, null source) reaches a team member's digest; a purged-basis synced task never does; external posture gets neither (Codex diff-review H2 — the timeline's provenance rule, applied to retrieve)", async () => {
    const seed = await seedTeam();
    await ingest(seed, { path: "t.md", body: `t ${TERM}`, access: "team", project: "src" });
    const srcProj = (await db().from("projects").select("id").eq("team_id", seed.teamId).eq("slug", "src").single()).data!.id;
    const handErr = (await db().from("tasks").insert({ team_id: seed.teamId, row_key: "ui-1", title: "Hand-typed dashboard task", status: "backlog", origin: "ui", source_item_id: null, created_by: seed.memberId, project_id: srcProj })).error;
    expect(handErr).toBeNull();
    const purgedErr = (await db().from("tasks").insert({ team_id: seed.teamId, row_key: "SYNC-9", title: "Purged-basis synced task", status: "in_progress", origin: "sync", source_item_id: null, created_by: null, project_id: srcProj })).error;
    expect(purgedErr).toBeNull();
    await backfillTeamContext(db(), seed.teamId);
    const member = await seedMember(seed);

    const teamView = { visibleItemIds: (await visibleItemIds(db(), { teamId: seed.teamId, memberId: member })).ids };
    const asTeam = await retrieve(db(), seed.teamId, "team", `${TERM} tasks`, null, teamView);
    expect(asTeam.structured, "the hand-typed task survives for a team member").toContain("Hand-typed dashboard task");
    expect(asTeam.structured, "a purged-basis synced task stays dropped").not.toContain("Purged-basis synced task");

    const { externalMember } = await import("./helpers");
    const ext = await externalMember(seed);
    const extView = { visibleItemIds: (await visibleItemIds(db(), { teamId: seed.teamId, memberId: ext })).ids };
    const asExt = await retrieve(db(), seed.teamId, "external", `${TERM} tasks`, null, extView);
    expect(asExt.structured, "a hand-typed row has no membership axis — the posture wall holds").not.toContain("Hand-typed dashboard task");
  });

  it("enforcing: a member in NO groups retrieves nothing (fail closed)", async () => {
    const seed = await seedTeam();
    await ingest(seed, { path: "x.md", body: `x ${TERM}`, access: "team", project: "src" });
    await backfillTeamContext(db(), seed.teamId);
    const lonely = await seedMember(seed);
    const { data: everyone } = await db().from("groups").select("id").eq("team_id", seed.teamId).eq("slug", "everyone").single();
    await db().from("group_members").delete().eq("group_id", everyone!.id).eq("member_id", lonely);
    const got = await retrievedPaths(seed, lonely);
    expect(got).toEqual([]);
  });
});

describe("ENFB-1 AC5 — the grounding existence-oracle closes", () => {
  it("a restricted-only term abstains for the outsider (grounded=false), grounds for the entitled member, and a statistic FAILURE never widens past the visible legs", async () => {
    const seed = await seedTeam();
    const outsider = await seedMember(seed);
    const insider = await seedMember(seed);
    // The restricted-only term: present in exactly ONE item, which moves into an initiative
    // granted to the insider alone. Pre-ENFB-1 the whole-corpus df>=1 flipped grounded=true for
    // EVERYONE — the answer path's abstain was an existence oracle for the codename.
    const secret = await ingest(seed, { path: "gr.md", body: "the zephyrquill contract details", access: "team", project: "src" });
    await ingest(seed, { path: "noise.md", body: "unrelated prose", access: "team", project: "src" });
    await backfillTeamContext(db(), seed.teamId);
    const restricted = await db().from("projects").insert({ team_id: seed.teamId, slug: "grv", name: "GRV", kind: "initiative" }).select("id").single();
    const g = await createGroup(db(), seed.teamId, "grvg", "GRV", seed.memberId);
    await grantProjectToGroup(db(), seed.teamId, restricted.data!.id, g.groupId!, seed.memberId);
    const { addMemberToGroup } = await import("@/lib/access/groups");
    await addMemberToGroup(db(), seed.teamId, g.groupId!, insider, seed.memberId);
    const { data: unit } = await db().from("project_context_units").select("id").eq("source_item_id", secret.id).single();
    await db().from("project_context_memberships").update({ valid_to: new Date().toISOString() }).eq("context_unit_id", unit!.id);
    await db().from("project_context_memberships").insert({ team_id: seed.teamId, project_id: restricted.data!.id, context_unit_id: unit!.id, method: "manual" });

    const outsiderView = { visibleItemIds: (await visibleItemIds(db(), { teamId: seed.teamId, memberId: outsider })).ids };
    const asOutsider = await retrieve(db(), seed.teamId, "team", "tell me about zephyrquill", null, outsiderView);
    expect(asOutsider.grounded, "a restricted-only term must ABSTAIN for the outsider — df over the visible corpus is 0").toBe(false);
    expect(asOutsider.sources.map((s) => s.path)).not.toContain("gr.md");

    const insiderView = { visibleItemIds: (await visibleItemIds(db(), { teamId: seed.teamId, memberId: insider })).ids };
    const asInsider = await retrieve(db(), seed.teamId, "team", "tell me about zephyrquill", null, insiderView);
    expect(asInsider.grounded, "the entitled member grounds on the same term").toBe(true);
    expect(asInsider.sources.map((s) => s.path)).toContain("gr.md");

    // §2.6 error contract, direct: a statistic failure yields the conservative shape, so
    // grounding falls to the (vis-scoped) fts evidence — never the whole corpus.
    const { analyzeTermSpecificity } = await import("@/lib/query/grounding");
    const broken = await analyzeTermSpecificity(seed.teamId, "team", ["zephyrquill"], ["not-a-uuid"]);
    expect(broken, "a failing statistic degrades conservative").toEqual({ specificMatching: false, allCommon: true });
  });
});
