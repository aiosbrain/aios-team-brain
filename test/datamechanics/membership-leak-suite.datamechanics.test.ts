import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { db, ingest, seedTeam, sha, type Seed } from "./helpers";
import { GET as itemsGET } from "@/app/api/v1/items/route";
import { GET as membersGET } from "@/app/api/v1/members/route";
import { issueApiKey } from "@/lib/admin/keys";
import { createMember } from "@/lib/admin/members";
import { createGroup, addMemberToGroup, grantProjectToGroup } from "@/lib/access/groups";
import { ensureAccessBootstrap } from "@/lib/access/bootstrap";
import { backfillTeamContext } from "@/lib/projects/context/backfill";
import { visibleItemIds, memberEnforcement } from "@/lib/access/enforce";
import { visibleProjects } from "@/lib/access/oracle";
import { retrieve } from "@/lib/query/retrieve";
import { selectEnforcedGraphPartitions, resolveArcScope } from "@/lib/graph/partition-read";
import { getFusedArcs } from "@/lib/graph/arc-fusion";
import { writeArcCache } from "@/lib/graph/arc-cache";
import { projectGroupId } from "@/lib/graph/group";
import { projectItemsToGraph } from "@/lib/graph/project";
import { armProjectsForPrincipal, readyPartitions } from "@/lib/graph/arming";
import { mintAgentToken } from "@/lib/access/agent-tokens";
import { effectiveVisibleProjects } from "@/lib/access/oracle";
import { getWorkTimeline } from "@/lib/dashboard/work-timeline";
import { runSql } from "@/lib/db/pg/pool";
import { FakeGraphiti, client } from "./fake-graphiti";
import type { NarrativeArc } from "@/lib/graph/arcs";

// PRET-5 — the external-member proof (program docs/design/retire-permissive-model.md §7 AC3;
// slice spec docs/design/pret5-leak-suite.md §2). THE matrix: an external-invited member with
// membership in project X sees X's items (incl. access='team' rows — ruling 2), X's graph
// partition scope, X's fused arcs, the roster and org-structural legs, and X's timeline
// evidence; sees NOTHING of project Y; a delegated token stays attenuated (and is UNMINTABLE
// for an external launcher — the Phase-A refusal IS the token-semantics observable). Every
// absence assertion is mutation-verified per the spec's instantiated table.

const TERM_X = "obsidianfern";
const TERM_Y = "cinnabarwren";

interface Fixture {
  seed: Seed;
  external: string;
  externalKey: string;
  teamKey: string;
  projectXId: string;
  projectYId: string;
  groupX: string; // X's graph partition group id
  groupY: string;
  itemXId: string;
  itemYId: string;
  groupXMembersId: string; // the clients-x group (granted X)
}

async function mkInitiative(seed: Seed, slug: string): Promise<{ projectId: string; group: string }> {
  const { data, error } = await db()
    .from("projects")
    .insert({ team_id: seed.teamId, slug, name: slug, kind: "initiative" })
    .select("id")
    .single();
  expect(error).toBeNull();
  const projectId = (data as { id: string }).id;
  const group = projectGroupId(seed.teamId, projectId);
  await runSql("update projects set graph_group_id = $1 where id = $2", [group, projectId]);
  return { projectId, group };
}

/** Move an ingested item's include-membership from its backfill home into a target project. */
async function moveMembership(seed: Seed, itemId: string, projectId: string): Promise<void> {
  const { data: unit } = await db().from("project_context_units").select("id").eq("source_item_id", itemId).single();
  await db()
    .from("project_context_memberships")
    .update({ valid_to: new Date().toISOString() })
    .eq("context_unit_id", (unit as { id: string }).id);
  const { error } = await db().from("project_context_memberships").insert({
    team_id: seed.teamId,
    project_id: projectId,
    context_unit_id: (unit as { id: string }).id,
    method: "manual",
  });
  expect(error).toBeNull();
}

const ARC = (title: string): NarrativeArc[] => [
  { arc_id: `a-${sha(title).slice(0, 8)}`, title, summary: `${title} prose`, arc_type: "milestone", status: "active", people: [], itemIds: [] } as unknown as NarrativeArc,
];

/** The full enforcing-team fixture — built PER TEST (the dm harness truncates between tests). */
async function buildFixture(): Promise<Fixture> {
  const seed = await seedTeam();
  const x = await ingest(seed, { path: "x.md", body: `alpha ${TERM_X}`, access: "team", project: "src" });
  const y = await ingest(seed, { path: "y.md", body: `beta ${TERM_Y}`, access: "team", project: "src" });
  await backfillTeamContext(db(), seed.teamId);

  // Recency-leg eligibility (the leg reads only attributed, source-dated items): both probes
  // must be visible to the recency leg or its gate's mutation is unobservable.
  await db()
    .from("items")
    .update({ member_id: seed.memberId, work_at: new Date().toISOString(), work_at_from_source: true })
    .in("id", [x.id, y.id]);

  const X = await mkInitiative(seed, `x-${randomUUID().slice(0, 6)}`);
  const Y = await mkInitiative(seed, `y-${randomUUID().slice(0, 6)}`);
  await moveMembership(seed, x.id, X.projectId);
  await moveMembership(seed, y.id, Y.projectId);

  // Graph substrate: project both initiatives (deferred rows), then arm + confirm X AND Y so
  // BOTH are ready-latched — Y's absence from the member's scope must be the ORACLE's doing,
  // never an unarmed-partition artifact (one-condition-per-fixture).
  await projectItemsToGraph(db(), { teamId: seed.teamId, teamSlug: seed.teamSlug, client: client(new FakeGraphiti()) });
  await armProjectsForPrincipal(db(), { teamId: seed.teamId, projectIds: [X.projectId, Y.projectId] });
  for (const g of [X.group, Y.group]) {
    await runSql("update graph_episodes set content_sha256 = $1, episode_uuid = $2 where team_id = $3 and group_id = $4", [
      sha(g),
      `ep-${g.slice(-8)}`,
      seed.teamId,
      g,
    ]);
  }
  const ready = await readyPartitions(db(), {
    teamId: seed.teamId,
    projects: [
      { id: X.projectId, group: X.group },
      { id: Y.projectId, group: Y.group },
    ],
  });
  expect(ready.ready.has(X.projectId), "X must be ready-latched or A3 is vacuous").toBe(true);
  expect(ready.ready.has(Y.projectId), "Y must be ready-latched too — its absence must be the oracle's doing").toBe(true);

  // PRET-6: no flip — every team is enforcing; the bootstrap the flip used to run is explicit.
  const boot = await ensureAccessBootstrap(db(), seed.teamId);
  expect(boot.ok, boot.error).toBe(true);

  // The external member: PRODUCTION creation (spec AC4 — never the fixture backdoor), then
  // activation, then deliberate membership in a group granted X only.
  const m = await createMember(db(), seed.teamId, {
    email: `${randomUUID()}@test.local`,
    displayName: "Collaborator",
    actorHandle: `c-${randomUUID().slice(0, 8)}`,
    role: "member",
    tier: "external",
  });
  await db().from("members").update({ status: "active" }).eq("id", m.id).eq("team_id", seed.teamId);
  const g = await createGroup(db(), seed.teamId, "clients-x", "Clients X", seed.memberId);
  expect(g.ok, g.error).toBe(true);
  expect((await addMemberToGroup(db(), seed.teamId, g.groupId!, m.id, seed.memberId)).ok).toBe(true);
  expect((await grantProjectToGroup(db(), seed.teamId, X.projectId, g.groupId!, seed.memberId)).ok).toBe(true);

  // Arc cache pre-seeds (spec A4 determinism): fresh g: rows for EVERY group the member's
  // scope resolves (X + external-shared) AND a distinctively-prosed row for Y — the absence
  // probe must exist to be absent.
  const { data: extShared } = await db()
    .from("projects")
    .select("graph_group_id")
    .eq("team_id", seed.teamId)
    .eq("slug", "external-shared")
    .single();
  const extGroup = (extShared as { graph_group_id: string }).graph_group_id;
  await writeArcCache(db(), seed.teamId, `g:${X.group}`, ARC("arc-x-prose"), "h1");
  await writeArcCache(db(), seed.teamId, `g:${extGroup}`, ARC("arc-ext-prose"), "h2");
  await writeArcCache(db(), seed.teamId, `g:${Y.group}`, ARC("arc-y-secret"), "h3");

  const { key: externalKey } = await issueApiKey(db(), seed.teamId, m.id, "ext");
  const { key: teamKey } = await issueApiKey(db(), seed.teamId, seed.memberId, "team");
  return {
    seed,
    external: m.id,
    externalKey,
    teamKey,
    projectXId: X.projectId,
    projectYId: Y.projectId,
    groupX: X.group,
    groupY: Y.group,
    itemXId: x.id,
    itemYId: y.id,
    groupXMembersId: g.groupId!,
  };
}

const v1 = (path: string, key: string) => new NextRequest(`http://test.local${path}`, { headers: { authorization: `Bearer ${key}` } });

describe("PRET-5 A1/A2 — items: X's team rows serve, Y's never (route + retrieve)", () => {
  it("A1: v1 items GET serves X's team item; Y's path ABSENT", async () => {
    const F: Fixture = await buildFixture();
    const res = await itemsGET(v1("/api/v1/items?all=1", F.externalKey));
    expect(res.status).toBe(200);
    const paths = ((await res.json()) as { items: { path: string }[] }).items.map((i) => i.path);
    expect(paths).toContain("x.md");
    expect(paths, "Y is the leak probe").not.toContain("y.md");
  });

  it("A2: the enforced retrieve grounds X's term; Y's term grounds NOTHING", async () => {
    const F: Fixture = await buildFixture();
    const vis = await visibleItemIds(db(), { teamId: F.seed.teamId, memberId: F.external });
    const enforce = { visibleItemIds: vis.ids, principal: "member" as const };
    const ctxX = await retrieve(db(), F.seed.teamId, "external", `about ${TERM_X}`, null, enforce);
    expect(ctxX.sources.map((s) => s.path)).toContain("x.md");
    const ctxY = await retrieve(db(), F.seed.teamId, "external", `about ${TERM_Y}`, null, enforce);
    expect(ctxY.sources.map((s) => s.path), "Y never grounds").not.toContain("y.md");

    // The RECENCY leg's own gate (its filter is a separate mutation target — a term-less
    // question makes fts empty, so sources come from the recency leg alone).
    const ctxR = await retrieve(db(), F.seed.teamId, "external", "what happened recently", null, enforce);
    expect(ctxR.sources.map((s) => s.path), "the recency leg never serves Y").not.toContain("y.md");
  });
});

describe("PRET-5 A3 — the graph scope is EXACTLY the membership set", () => {
  it("resolves {X's partition, external-shared's partition} — General ABSENT (the ruling-2 boundary), Y ABSENT", async () => {
    const F: Fixture = await buildFixture();
    const { projectIds } = await visibleProjects(db(), { teamId: F.seed.teamId, memberId: F.external });
    const scope = await selectEnforcedGraphPartitions(db(), {
      teamId: F.seed.teamId,
      visibleProjectIds: [...projectIds],
      k: Number.MAX_SAFE_INTEGER,
    });
    const { data: builtins } = await db()
      .from("projects")
      .select("slug, graph_group_id")
      .eq("team_id", F.seed.teamId)
      .in("slug", ["general", "external-shared"]);
    const bySlug = new Map((builtins ?? []).map((p: { slug: string; graph_group_id: string }) => [p.slug, p.graph_group_id]));
    expect(scope.groups, "Y's partition is the oracle's absence").not.toContain(F.groupY);
    expect(scope.groups, "General ABSENT — the exact ruling-2 boundary").not.toContain(bySlug.get("general"));
    // The spec's EXACT-set assertion (diff-review M1): nothing beyond the membership set.
    expect(new Set(scope.groups)).toEqual(new Set([F.groupX, bySlug.get("external-shared")]));
  });
});

describe("PRET-5 A4 — fused arcs over the member's scope only", () => {
  it("the route's composition serves X's arc prose; Y's pre-seeded prose ABSENT", async () => {
    const F: Fixture = await buildFixture();
    const enforce = await memberEnforcement(db(), { teamId: F.seed.teamId, memberId: F.external });
    expect(enforce, "enforcing team must yield an enforcement").not.toBeNull();
    const scope = await resolveArcScope(db(), {
      teamId: F.seed.teamId,
      teamSlug: F.seed.teamSlug,
      memberId: F.external,
      tier: "external",
      enforcement: enforce!,
    });
    const { arcs } = await getFusedArcs(db(), F.seed.teamId, F.seed.teamSlug, scope.groups, null);
    const titles = arcs.map((a) => a.title);
    expect(titles).toContain("arc-x-prose");
    expect(titles, "Y's partition prose never fuses into this member's panel").not.toContain("arc-y-secret");
  });
});

describe("PRET-5 A5 — structure serves every member", () => {
  it("v1 members returns the same roster a team key gets; org-structural legs serve this member", async () => {
    const F: Fixture = await buildFixture();
    const ext = await membersGET(v1("/api/v1/members", F.externalKey));
    expect(ext.status).toBe(200);
    const team = await membersGET(v1("/api/v1/members", F.teamKey));
    const byId = (arr: { id: string }[]) => [...arr].sort((a, b) => a.id.localeCompare(b.id));
    const extMembers = byId(((await ext.json()) as { members: { id: string }[] }).members);
    const teamMembers = byId(((await team.json()) as { members: { id: string }[] }).members);
    // Deep payload equality (diff-review L1): the SAME roster objects, not just the same ids —
    // a future per-posture field redaction would silently pass an id-only check.
    expect(extMembers).toEqual(teamMembers);

    // Org-structural legs (the QMIR inversion, re-asserted inside the matrix): seed one actor +
    // REPORTS_TO edge, then read through the enforced member arm.
    await db().from("graph_entities").insert({
      team_id: F.seed.teamId,
      entity_id: `member:${randomUUID()}`,
      entity_type: "actor",
      name: "Rosterina Example",
      attrs: {},
    });
    const vis = await visibleItemIds(db(), { teamId: F.seed.teamId, memberId: F.external });
    const ctx = await retrieve(db(), F.seed.teamId, "external", "who reports to whom", null, {
      visibleItemIds: vis.ids,
      principal: "member",
    });
    expect(ctx.structured ?? "").toContain("Rosterina Example");
  });
});

describe("PRET-5 A6 — the timeline wall drop (the §1 change)", () => {
  it("X's team evidence reaches the member's ledger; Y's ABSENT; a null-source hand-typed team task ABSENT; a meeting note in X ABSENT", async () => {
    const F: Fixture = await buildFixture();
    // Evidence: git + slack items in X, one in Y; a sourced task heading X's evidence; a
    // decision sourced from X; a null-source hand-typed task; a meeting note sourced from X.
    const now = new Date().toISOString();
    const gitX = await ingest(F.seed, {
      path: "commits/x1.md",
      body: `feat: x work (LX-1) ${TERM_X}`,
      access: "team",
      project: "src",
      kind: "deliverable",
      frontmatter: { source: "git", author: "tester" },
    });
    const gitY = await ingest(F.seed, {
      path: "commits/y1.md",
      body: `feat: y secret (LY-9) ${TERM_Y}`,
      access: "team",
      project: "src",
      kind: "deliverable",
      frontmatter: { source: "git", author: "tester" },
    });
    // A visible citer for the hand-typed task: without one the evidence-gated grouper never
    // surfaces HT-1 for ANY viewer and the H2 absence is vacuous (its mutation survived —
    // the one-condition-per-fixture rule caught it).
    const gitHT = await ingest(F.seed, {
      path: "commits/ht1.md",
      body: `chore: hand-typed follow-up (HT-1) ${TERM_X}`,
      access: "team",
      project: "src",
      kind: "deliverable",
      frontmatter: { source: "git", author: "tester" },
    });
    await backfillTeamContext(db(), F.seed.teamId);
    await moveMembership(F.seed, gitX.id, F.projectXId);
    await moveMembership(F.seed, gitHT.id, F.projectXId);
    await moveMembership(F.seed, gitY.id, F.projectYId);
    await db().from("items").update({ member_id: F.external, work_at: now, work_at_from_source: true }).in("id", [gitX.id, gitY.id, gitHT.id]);

    const xTaskErr = (
      await db()
        .from("tasks")
        .insert({ team_id: F.seed.teamId, project_id: F.projectXId, row_key: "LX-1", title: "X sourced task", assignee: "Tester", status: "done", source_item_id: gitX.id, audience: "team", origin: "sync" })
    ).error;
    expect(JSON.stringify(xTaskErr ?? null), "the sourced task fixture must insert").toBe("null");
    await db()
      .from("tasks")
      .insert({ team_id: F.seed.teamId, project_id: F.projectXId, row_key: "HT-1", title: "Hand-typed team task", assignee: "Tester", status: "in_progress", source_item_id: null, created_by: F.seed.memberId, audience: "team", origin: "ui" });
    // The link-target leak channel (Codex M1): a NON-ACTIVE task sourced from INVISIBLE Y,
    // whose key is cited by VISIBLE X evidence — reachable only via the all-status read; its
    // title must never surface for this member.
    await db()
      .from("tasks")
      .insert({ team_id: F.seed.teamId, project_id: F.projectYId, row_key: "LY-9", title: "Y secret linked task", assignee: "Tester", status: "done", source_item_id: gitY.id, audience: "team", origin: "sync" });
    const citerErr = (
      await ingest(F.seed, {
        path: "commits/xcite.md",
        body: `chore: cross-cite (LY-9) ${TERM_X}`,
        access: "team",
        project: "src",
        kind: "deliverable",
        frontmatter: { source: "git", author: "tester" },
      })
    );
    await backfillTeamContext(db(), F.seed.teamId);
    await moveMembership(F.seed, citerErr.id, F.projectXId);
    await db().from("items").update({ member_id: F.external, work_at: now, work_at_from_source: true }).eq("id", citerErr.id);
    const decErr = (
      await db()
        .from("decisions")
        .insert({ team_id: F.seed.teamId, project_id: F.projectXId, row_key: "DX-1", title: "X decision", decided_by: "tester", decided_at: now.slice(0, 10), still_valid: true, source_item_id: gitX.id, audience: "team" })
    ).error;
    expect(JSON.stringify(decErr ?? null), "decision fixture must insert").toBe("null");
    const { data: mtg, error: mtgErr } = await db()
      .from("meeting_notes")
      .insert({ team_id: F.seed.teamId, source_item_id: gitX.id, title: "X standup", summary: "standup", occurred_at: now.slice(0, 10) })
      .select("id")
      .single();
    expect(JSON.stringify(mtgErr ?? null), "meeting fixture must insert").toBe("null");
    // Credited attendee — an unattributable note is dropped for EVERY viewer, which made the
    // carve-out absence vacuous (diff-review H1, the third catch of this fixture class).
    const attErr = (await db().from("meeting_note_attendees").insert({ meeting_note_id: (mtg as { id: string }).id, member_id: F.seed.memberId })).error;
    expect(JSON.stringify(attErr ?? null), "attendee fixture must insert").toBe("null");

    const enforce = await memberEnforcement(db(), { teamId: F.seed.teamId, memberId: F.external });
    const days = await getWorkTimeline(db(), F.seed.teamId, "external", 14, enforce);
    const flat = JSON.stringify(days);
    expect(flat, "X's team git evidence flows (ruling 2 on the timeline)").toContain("x work");
    expect(flat, "X's sourced task header flows — reachable ONLY via the all-status :488 read (status done, Codex M1)").toContain("X sourced task");
    expect(flat, "an invisible-source task's title never surfaces via link-target maps (Codex M1's leak channel)").not.toContain("Y secret linked task");
    expect(flat, "X's decision flows").toContain("X decision");
    expect(flat, "Y's evidence never flows").not.toContain("y secret");
    expect(flat, "the null-source hand-typed team task stays walled (H2 ruling)").not.toContain("Hand-typed team task");
    expect(flat, "meeting notes keep the posture gate (the kept carve-out)").not.toContain("X standup");

    // POSITIVE CONTROL for the carve-out (diff-review H1): a TEAM-POSTURE member GRANTED X
    // does see the meeting — so the external absence above is provably the posture gate, not
    // an unattributable-note artifact (nor an oracle one: this viewer has the same X grant).
    expect((await addMemberToGroup(db(), F.seed.teamId, F.groupXMembersId, F.seed.memberId, F.seed.memberId)).ok).toBe(true);
    const teamDays = await getWorkTimeline(db(), F.seed.teamId, "team", 14, await memberEnforcement(db(), { teamId: F.seed.teamId, memberId: F.seed.memberId }));
    expect(JSON.stringify(teamDays), "the entitled viewer sees the meeting").toContain("X standup");
  });
});

describe("PRET-5 A7 — token semantics, byte-unchanged", () => {
  it("(a) a team-launcher token with empty scope reads NOTHING of X or Y; (b) minting for the external member is REFUSED", async () => {
    const F: Fixture = await buildFixture();
    const minted = await mintAgentToken(db(), F.seed.teamId, { memberId: F.seed.memberId, projectScope: [] }, F.seed.memberId);
    expect(minted.ok, (minted as { error?: string }).error).toBe(true);
    // The claims→scope round-trip (diff-review L2): the token VERIFIES and its principal
    // carries the empty scope the mint bound.
    const { verifyAgentToken } = await import("@/lib/access/agent-tokens");
    const principal = await verifyAgentToken(db(), minted.token!);
    expect(principal, "the minted token verifies").not.toBeNull();
    expect(principal!.projectScope, "the empty scope survives the round-trip").toEqual([]);
    const effective = await effectiveVisibleProjects(db(), {
      teamId: F.seed.teamId,
      memberId: F.seed.memberId,
      onBehalfOf: null,
      projectScope: [],
    });
    expect(effective.size, "an empty scope sees nothing — the attenuation proof").toBe(0);

    const refused = await mintAgentToken(db(), F.seed.teamId, { memberId: F.external, projectScope: null }, F.seed.memberId);
    expect(refused.ok).toBe(false);
    expect((refused as { error?: string }).error).toMatch(/external-tier delegation/);
  });
});

// PRET-5's A8 ("the permissive control — no stealth widen") is DELETED WITH ITS SUBJECT
// (PRET-6): its property — "the posture wall stands where enforcement is off" — died with the
// permissive mode itself. What replaces it is a DIFFERENT property, not a paraphrase: the
// INVITE-DEFAULT FLOOR — an external-invited member holding NOTHING beyond their invite default
// (no grants, no group adds) on a second (necessarily enforcing) team sees exactly the
// external-shared corpus, through the oracle alone.
describe("PRET-6 A8′ — the invite-default floor (second team, oracle only)", () => {
  it("an external-invited member with NO grants reads only external-shared content — items route AND their own timeline vis-variant", async () => {
    const seed2 = await seedTeam();
    const t2 = await ingest(seed2, {
      path: "t2.md",
      body: "internal two",
      access: "team",
      project: "src",
      frontmatter: { title: "Internal Two Doc" },
    });
    const e2 = await ingest(seed2, { path: "e2.md", body: "shared two", access: "external", project: "src" });
    await backfillTeamContext(db(), seed2.teamId);
    // Timeline-eligible (attributed + source-dated) so the pin is REAL — the first draft probed
    // a payload-unreachable body string on ineligible items (PRET-5 diff-review H2).
    await db()
      .from("items")
      .update({ member_id: seed2.memberId, work_at: new Date().toISOString(), work_at_from_source: true })
      .in("id", [t2.id, e2.id]);
    const m2 = await createMember(db(), seed2.teamId, {
      email: `${randomUUID()}@test.local`,
      displayName: "Collaborator Two",
      actorHandle: `c2-${randomUUID().slice(0, 8)}`,
      role: "member",
      tier: "external", // the invite default writes the external builtin row — their whole floor
    });
    await db().from("members").update({ status: "active" }).eq("id", m2.id).eq("team_id", seed2.teamId);
    const { key } = await issueApiKey(db(), seed2.teamId, m2.id, "ext2");
    const res = await itemsGET(v1("/api/v1/items?all=1", key));
    const paths = ((await res.json()) as { items: { path: string }[] }).items.map((i) => i.path);
    expect(paths, "the external-shared corpus is the floor, not zero").toContain("e2.md");
    expect(paths, "General-only content never reaches the invite default").not.toContain("t2.md");

    // ...and their timeline serves through their OWN vis-variant — probed on the
    // payload-reachable TITLE, with the entitled-viewer positive control.
    const enforce2 = await memberEnforcement(db(), { teamId: seed2.teamId, memberId: m2.id });
    const extDays = await getWorkTimeline(db(), seed2.teamId, "external", 14, enforce2);
    expect(JSON.stringify(extDays), "the floor holds on the timeline").not.toContain("Internal Two Doc");
    const teamDays2 = await getWorkTimeline(db(), seed2.teamId, "team", 14, await memberEnforcement(db(), { teamId: seed2.teamId, memberId: seed2.memberId }));
    expect(JSON.stringify(teamDays2), "the entitled viewer's variant sees it").toContain("Internal Two Doc");
  });
});
