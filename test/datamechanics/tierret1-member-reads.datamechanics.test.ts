import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { db, ingest, seedTeam, sha, type Seed } from "./helpers";
import { GET as itemsGET } from "@/app/api/v1/items/route";
import { GET as itemGET } from "@/app/api/v1/items/[id]/route";
import { GET as tasksGET } from "@/app/api/v1/tasks/route";
import { GET as decisionsGET } from "@/app/api/v1/decisions/route";
import { GET as okfGET } from "@/app/api/v1/okf-bundle/route";
import { GET as timelineGET } from "@/app/api/v1/timeline/route";
import { issueApiKey } from "@/lib/admin/keys";
import { createMember } from "@/lib/admin/members";
import { createGroup, addMemberToGroup, grantProjectToGroup } from "@/lib/access/groups";
import { ensureAccessBootstrap } from "@/lib/access/bootstrap";
import { backfillTeamContext } from "@/lib/projects/context/backfill";
import { visibleItemIds, visibleProjectCards, canSeeProjectRow } from "@/lib/access/enforce";
import { retrieve } from "@/lib/query/retrieve";
import { listMeetingNotesForTeam, getMeetingNote } from "@/lib/meetings/notes";
import { assessAccessHealth } from "@/lib/admin/access-health";
import { formatAccessHealth } from "@/lib/admin/access-health-format";
import { ingestItem } from "@/lib/ingest";
import { TierViolationError } from "@/lib/api/schemas";
import { settleTimelineRefreshes } from "@/lib/dashboard/timeline-cache";

/**
 * TIERRET-1 / AIO-1045 — membership is the ONLY member content read rule (accepted spec
 * docs/design/tierret1-membership-only.md). Every assertion below is derived from the spec's
 * acceptance matrix, NOT from the implementation: an EXTERNAL-labelled human who is OUTSIDE the
 * builtin Everyone group but is GRANTED a custom project receives that project's TEAM-labelled
 * items, their sourced tasks/decisions, meetings and grounding — identically to a team-posture
 * member with the same grant — while ungranted content, connectors/offroster keys and grantless
 * principals gain nothing.
 *
 * RED-FIRST: written before the implementation. The baseline run (coordinator, localhost:55047)
 * is recorded in the handoff ACCEPTANCE.md; the positive member assertions are expected RED on the
 * unmodified base, the negative controls GREEN on both.
 */

const TERM_X = "obsidianfern";
const TERM_X2 = "quartzheron";
const TERM_Y = "cinnabarwren";
const now = () => new Date().toISOString();

interface Fx {
  seed: Seed;
  srcId: string; // the ingest CONTAINER of every item (source project)
  X: string; // initiative granted to the clients group
  Y: string; // initiative granted to nobody but an internal group
  generalId: string;
  extSharedId: string;
  x: string;
  x2: string;
  y: string;
  meetX: string;
  meetY: string;
  noteX: string;
  noteY: string;
  external: string; // external-tier human, builtin External only, granted X via clients-x
  externalKey: string;
  teamPeer: string; // team-posture human, builtin Everyone AND granted X via the same group
  teamPeerKey: string;
  clientsGroup: string;
}

async function mkInitiative(seed: Seed, slug: string): Promise<string> {
  const { data, error } = await db()
    .from("projects")
    .insert({ team_id: seed.teamId, slug: `${slug}-${randomUUID().slice(0, 6)}`, name: slug, kind: "initiative" })
    .select("id")
    .single();
  expect(error).toBeNull();
  return (data as { id: string }).id;
}

/** Fixture-only custom placement (spec AC-01: "custom placements use test fixture membership writes"). */
async function moveMembership(seed: Seed, itemId: string, projectId: string): Promise<void> {
  const { data: unit } = await db().from("project_context_units").select("id").eq("source_item_id", itemId).single();
  await db()
    .from("project_context_memberships")
    .update({ valid_to: now() })
    .eq("context_unit_id", (unit as { id: string }).id)
    .is("valid_to", null);
  const { error } = await db().from("project_context_memberships").insert({
    team_id: seed.teamId,
    project_id: projectId,
    context_unit_id: (unit as { id: string }).id,
    method: "manual",
  });
  expect(error).toBeNull();
}

async function rawMember(
  seed: Seed,
  over: Partial<{ kind: string; tier: string; status: string; is_connector: boolean }> = {}
): Promise<string> {
  const { data, error } = await db()
    .from("members")
    .insert({
      team_id: seed.teamId,
      email: `${randomUUID()}@test.local`,
      display_name: `M-${randomUUID().slice(0, 6)}`,
      actor_handle: `h-${randomUUID().slice(0, 10)}`,
      role: "member",
      tier: over.tier ?? "team",
      status: over.status ?? "active",
      is_connector: over.is_connector ?? false,
      kind: over.kind ?? "human",
    })
    .select("id")
    .single();
  if (error || !data) throw new Error(`seed member failed: ${error?.message}`);
  return (data as { id: string }).id;
}

/** A PLANTED builtin row (raw edge write — the groups writer refuses non-humans into builtins). */
async function plantBuiltin(seed: Seed, memberId: string, slug: "everyone" | "external"): Promise<void> {
  const { data: g } = await db().from("groups").select("id").eq("team_id", seed.teamId).eq("slug", slug).eq("is_builtin", true).single();
  const { error } = await db().from("group_members").insert({ team_id: seed.teamId, group_id: (g as { id: string }).id, member_id: memberId });
  expect(error).toBeNull();
}

async function buildFixture(): Promise<Fx> {
  const seed = await seedTeam();
  await backfillTeamContext(db(), seed.teamId);
  const x = await ingest(seed, {
    path: "x.md",
    body: `# X doc\nalpha ${TERM_X} see [y](y.md), [x2](x2.md) and [gone](missing.md)`,
    access: "team",
    project: "src",
  });
  const x2 = await ingest(seed, { path: "x2.md", body: `x two ${TERM_X2}`, access: "team", project: "src" });
  const y = await ingest(seed, { path: "y.md", body: `beta ${TERM_Y}`, access: "team", project: "src" });
  const meetX = await ingest(seed, { kind: "transcript", path: "meetings/x-standup.md", body: "x standup transcript", access: "team", project: "src" });
  const meetY = await ingest(seed, { kind: "transcript", path: "meetings/y-board.md", body: "y board transcript", access: "team", project: "src" });
  await backfillTeamContext(db(), seed.teamId);
  const boot = await ensureAccessBootstrap(db(), seed.teamId);
  expect(boot.ok, boot.error).toBe(true);

  const X = await mkInitiative(seed, "x");
  const Y = await mkInitiative(seed, "y");
  for (const [item, proj] of [[x.id, X], [x2.id, X], [meetX.id, X], [y.id, Y], [meetY.id, Y]] as const) {
    await moveMembership(seed, item, proj);
  }
  const srcId = x.projectId!;
  const { data: sys } = await db().from("projects").select("id, slug").eq("team_id", seed.teamId).eq("kind", "system");
  const bySlug = new Map(((sys ?? []) as { id: string; slug: string }[]).map((p) => [p.slug, p.id]));

  // Sourced structured rows live in the INGEST container (src), like real materialization.
  for (const t of [
    { row_key: "LX-1", title: "X sourced task", source_item_id: x.id },
    { row_key: "LY-9", title: "Y secret task", source_item_id: y.id },
  ]) {
    const { error } = await db().from("tasks").insert({ team_id: seed.teamId, project_id: srcId, assignee: "Tester", status: "in_progress", audience: "team", origin: "sync", ...t });
    expect(error).toBeNull();
  }
  for (const d of [
    { row_key: "DX-1", title: "X decision", rationale: `because ${TERM_X}`, source_item_id: x.id },
    { row_key: "DY-1", title: "Y secret decision", rationale: `because ${TERM_Y}`, source_item_id: y.id },
  ]) {
    const { error } = await db().from("decisions").insert({ team_id: seed.teamId, project_id: srcId, decided_by: "tester", decided_at: now().slice(0, 10), still_valid: true, audience: "team", updated_at: new Date(Date.now() + 60_000).toISOString(), ...d });
    expect(error).toBeNull();
  }
  // Hand-entered rows (null source, created_by proof): one in the GRANTED project X, one in the
  // ungranted source container — AC-04's two arms.
  const ht = [
    { project_id: X, row_key: "HTX-1", title: "Hand-typed X task" },
    { project_id: srcId, row_key: "HTS-1", title: "Hand-typed src task" },
  ];
  for (const t of ht) {
    const { error } = await db().from("tasks").insert({ team_id: seed.teamId, assignee: "Tester", status: "in_progress", audience: "team", origin: "ui", source_item_id: null, created_by: seed.memberId, ...t });
    expect(error).toBeNull();
  }
  const { error: hdErr } = await db().from("decisions").insert({ team_id: seed.teamId, project_id: X, row_key: "HDX-1", title: "Hand decision X", decided_by: "tester", decided_at: now().slice(0, 10), still_valid: true, audience: "team", source_item_id: null, created_by: seed.memberId });
  expect(hdErr).toBeNull();
  // A hand-entered row whose creator was deleted → no provenance → hidden from everyone.
  const doomed = await rawMember(seed);
  await db().from("tasks").insert({ team_id: seed.teamId, project_id: X, row_key: "HTD-1", title: "Deleted creator task", assignee: "Tester", status: "in_progress", audience: "team", origin: "ui", source_item_id: null, created_by: doomed });
  await db().from("members").delete().eq("id", doomed);
  // A sync-origin row with NO source and NO creator (source-purged) → hidden from everyone.
  await db().from("tasks").insert({ team_id: seed.teamId, project_id: X, row_key: "HTN-1", title: "No provenance task", assignee: "Tester", status: "in_progress", audience: "team", origin: "sync", source_item_id: null, created_by: null });

  const mkNote = async (itemId: string, title: string) => {
    const { data, error } = await db().from("meeting_notes").insert({ team_id: seed.teamId, source_item_id: itemId, title, summary: title, occurred_at: now().slice(0, 10) }).select("id").single();
    expect(error).toBeNull();
    await db().from("meeting_note_attendees").insert({ meeting_note_id: (data as { id: string }).id, member_id: seed.memberId });
    return (data as { id: string }).id;
  };
  const noteX = await mkNote(meetX.id, "X standup");
  const noteY = await mkNote(meetY.id, "Y board prep");

  // The external collaborator: PRODUCTION creation path (external builtin only), then a deliberate grant.
  const m = await createMember(db(), seed.teamId, { email: `${randomUUID()}@test.local`, displayName: "Collaborator", actorHandle: `c-${randomUUID().slice(0, 8)}`, role: "member", tier: "external" });
  await db().from("members").update({ status: "active" }).eq("id", m.id).eq("team_id", seed.teamId);
  const g = await createGroup(db(), seed.teamId, `clients-${randomUUID().slice(0, 6)}`, "Clients X", seed.memberId);
  expect(g.ok, g.error).toBe(true);
  expect((await addMemberToGroup(db(), seed.teamId, g.groupId!, m.id, seed.memberId)).ok).toBe(true);
  expect((await grantProjectToGroup(db(), seed.teamId, X, g.groupId!, seed.memberId)).ok).toBe(true);
  // A Y-only internal group so Y is a real, granted, restricted project (its absence is the oracle's doing).
  const gy = await createGroup(db(), seed.teamId, `insiders-${randomUUID().slice(0, 6)}`, "Insiders Y", seed.memberId);
  expect((await grantProjectToGroup(db(), seed.teamId, Y, gy.groupId!, seed.memberId)).ok).toBe(true);

  // The team-posture peer with the SAME custom grant (posture must not change sourced content).
  const peer = await createMember(db(), seed.teamId, { email: `${randomUUID()}@test.local`, displayName: "Peer", actorHandle: `p-${randomUUID().slice(0, 8)}`, role: "member", tier: "team" });
  await db().from("members").update({ status: "active" }).eq("id", peer.id).eq("team_id", seed.teamId);
  expect((await addMemberToGroup(db(), seed.teamId, g.groupId!, peer.id, seed.memberId)).ok).toBe(true);

  const { key: externalKey } = await issueApiKey(db(), seed.teamId, m.id, "ext");
  const { key: teamPeerKey } = await issueApiKey(db(), seed.teamId, peer.id, "peer");
  return {
    seed,
    srcId,
    X,
    Y,
    generalId: bySlug.get("general")!,
    extSharedId: bySlug.get("external-shared")!,
    x: x.id,
    x2: x2.id,
    y: y.id,
    meetX: meetX.id,
    meetY: meetY.id,
    noteX,
    noteY,
    external: m.id,
    externalKey,
    teamPeer: peer.id,
    teamPeerKey,
    clientsGroup: g.groupId!,
  };
}

const req = (path: string, key: string) =>
  new NextRequest(`http://test.local${path}`, { headers: { authorization: `Bearer ${key}` } });

async function taskKeys(key: string, query = "?mode=table"): Promise<string[]> {
  const res = await tasksGET(req(`/api/v1/tasks${query}`, key));
  expect(res.status).toBe(200);
  const body = (await res.json()) as { tasks: { rows: { row_key: string }[] }[] };
  return body.tasks.flatMap((p) => p.rows.map((r) => r.row_key)).sort();
}

async function decisionKeys(key: string, since = "1970-01-01T00:00:00Z"): Promise<string[]> {
  const res = await decisionsGET(req(`/api/v1/decisions?since=${encodeURIComponent(since)}`, key));
  expect(res.status).toBe(200);
  const body = (await res.json()) as { decisions: { rows: { row_key: string }[] }[] };
  return body.decisions.flatMap((p) => p.rows.map((r) => r.row_key)).sort();
}

async function okfNodes(key: string, query = ""): Promise<{ path: string; links: string[] }[]> {
  const res = await okfGET(req(`/api/v1/okf-bundle${query}`, key));
  expect(res.status).toBe(200);
  return ((await res.json()) as { bundle: { nodes: { path: string; links: string[] }[] } }).bundle.nodes;
}

const memberEnforce = async (teamId: string, memberId: string) => {
  const { ids, projectIds } = await visibleItemIds(db(), { teamId, memberId });
  // `memberEveryone`/`memberProjectIds` are the TIERRET-1 member authority fields; an unmodified
  // base ignores them (so the baseline run measures the CURRENT filters, not a type error).
  return { visibleItemIds: ids, principal: "member" as const, graphProjectIds: projectIds, memberEveryone: false, memberProjectIds: projectIds };
};

describe("TIERRET-1 AC-01 — a granted external human receives the granted project's team-labelled content", () => {
  it("by-id item read serves the granted team-labelled item (the list already does); ungranted Y 404s", async () => {
    const F = await buildFixture();
    const list = await itemsGET(req("/api/v1/items", F.externalKey));
    const paths = ((await list.json()) as { items: { path: string }[] }).items.map((i) => i.path);
    expect(paths, "positive control: the list is already membership-only").toContain("x.md");
    expect(paths).not.toContain("y.md");

    const byId = await itemGET(req(`/api/v1/items/${F.x}`, F.externalKey), { params: Promise.resolve({ id: F.x }) });
    expect(byId.status, "list/by-id must agree for granted member content (AC-05)").toBe(200);
    const hidden = await itemGET(req(`/api/v1/items/${F.y}`, F.externalKey), { params: Promise.resolve({ id: F.y }) });
    expect(hidden.status, "ungranted Y stays indistinguishable from absent").toBe(404);
  });

  it("sourced tasks and decisions follow their source item, not the row's audience label", async () => {
    const F = await buildFixture();
    const tasks = await taskKeys(F.externalKey);
    expect(tasks, "the X-sourced team-audience task serves").toContain("LX-1");
    expect(tasks, "Y-sourced never").not.toContain("LY-9");
    const decisions = await decisionKeys(F.externalKey);
    expect(decisions, "the X-sourced team-audience decision serves").toContain("DX-1");
    expect(decisions).not.toContain("DY-1");
  });

  it("identical grants → identical SOURCED member content regardless of posture", async () => {
    const F = await buildFixture();
    const sourced = (keys: string[]) => keys.filter((k) => k.startsWith("L") || k.startsWith("D"));
    expect(sourced(await taskKeys(F.externalKey)), "external vs team posture, same grant").toEqual(
      sourced(await taskKeys(F.teamPeerKey)).filter((k) => k !== "LY-9")
    );
    // The team peer is ALSO in Everyone (General), which grants no Y content — so LY-9 must be
    // absent for the peer too: the filter above is a no-op the next line proves.
    expect(await taskKeys(F.teamPeerKey)).not.toContain("LY-9");
  });
});

describe("TIERRET-1 AC-04 — hand-entered (unsourced) rows: Everyone humans ALL, other members GRANTED projects only", () => {
  it("the granted external member sees the X hand-typed task/decision but NOT the src one; deleted-creator and no-provenance rows stay hidden", async () => {
    const F = await buildFixture();
    const keys = await taskKeys(F.externalKey);
    expect(keys, "granted-project hand-typed row (team audience) serves").toContain("HTX-1");
    expect(keys, "an ungranted container's hand-typed row does not").not.toContain("HTS-1");
    expect(keys, "deleted creator → no provenance → hidden").not.toContain("HTD-1");
    expect(keys, "no source, no creator → hidden").not.toContain("HTN-1");
    expect(await decisionKeys(F.externalKey), "hand-typed decision in the granted project").toContain("HDX-1");
  });

  it("an oracle-accepted Everyone human keeps ALL hand-entered rows (existing contract preserved)", async () => {
    const F = await buildFixture();
    const keys = await taskKeys(F.teamPeerKey);
    expect(keys).toContain("HTX-1");
    expect(keys, "Everyone's broader hand-entered audience is preserved").toContain("HTS-1");
    expect(keys).not.toContain("HTD-1");
    expect(keys).not.toContain("HTN-1");
  });

  it("a grantless external human and a grantless standing agent see NO hand-entered rows and no project names", async () => {
    const F = await buildFixture();
    const lone = await createMember(db(), F.seed.teamId, { email: `${randomUUID()}@test.local`, displayName: "Lone", actorHandle: `l-${randomUUID().slice(0, 8)}`, role: "member", tier: "external" });
    await db().from("members").update({ status: "active" }).eq("id", lone.id);
    const agent = await rawMember(F.seed, { kind: "agent", tier: "external" });
    for (const id of [lone.id, agent]) {
      const { key } = await issueApiKey(db(), F.seed.teamId, id, "k");
      const keys = await taskKeys(key);
      for (const k of ["HTX-1", "HTS-1", "LX-1", "LY-9"]) expect(keys, `${k} must not reach a grantless principal`).not.toContain(k);
      const cards = await visibleProjectCards(db(), { teamId: F.seed.teamId, memberId: id });
      expect(cards.rows.map((r) => r.id), "no hidden project names").not.toContain(F.X);
      expect(cards.rows.map((r) => r.id)).not.toContain(F.srcId);
      expect(cards.rows.map((r) => r.id)).not.toContain(F.Y);
    }
  });

  it("a PLANTED builtin Everyone row on a standing agent does NOT grant the all arm (N3)", async () => {
    const F = await buildFixture();
    const agent = await rawMember(F.seed, { kind: "agent", tier: "team" });
    await plantBuiltin(F.seed, agent, "everyone");
    expect((await addMemberToGroup(db(), F.seed.teamId, F.clientsGroup, agent, F.seed.memberId)).ok, "agents are eligible for custom grants").toBe(true);
    const { key } = await issueApiKey(db(), F.seed.teamId, agent, "agent");
    const keys = await taskKeys(key);
    expect(keys, "the agent's custom grant admits X's sourced and hand-typed rows").toEqual(expect.arrayContaining(["LX-1", "HTX-1"]));
    expect(keys, "the planted Everyone row must not open every hand-entered project").not.toContain("HTS-1");
  });

  it("negative control: new READ visibility does not make the source container a WRITE destination", async () => {
    const F = await buildFixture();
    const cards = await visibleProjectCards(db(), { teamId: F.seed.teamId, memberId: F.external });
    const src = cards.rows.find((r) => r.id === F.srcId);
    expect(src, "the source container is now READ-visible through granted content (AC-05 counts)").toBeDefined();
    expect(src!.visibleItems, "its card counts the granted team-labelled items it holds").toBeGreaterThanOrEqual(2);
    expect(
      await canSeeProjectRow(db(), { teamId: F.seed.teamId, memberId: F.external }, F.srcId),
      "the create-action predicate (canSeeProjectRow) keeps its legacy rule — no new write destination"
    ).toBe(false);
    expect(await canSeeProjectRow(db(), { teamId: F.seed.teamId, memberId: F.external }, F.X), "a granted project stays writable").toBe(true);
  });
});

describe("TIERRET-1 AC-03 — legacy connector/offroster keys gain NOTHING (baseline preserved, not revoked)", () => {
  it("a connector key with an Everyone row keeps its pre-existing hand-entered rows but gains no sourced content", async () => {
    const F = await buildFixture();
    const connector = await rawMember(F.seed, { is_connector: true, tier: "team" });
    await plantBuiltin(F.seed, connector, "everyone");
    const { key } = await issueApiKey(db(), F.seed.teamId, connector, "connector");
    const keys = await taskKeys(key);
    expect(keys, "baseline legacy all-arm preserved (AC-03 requires no GAIN, not denial)").toEqual(expect.arrayContaining(["HTX-1", "HTS-1"]));
    expect(keys, "a connector is not a principal — no sourced content").not.toContain("LX-1");
    expect(keys).not.toContain("LY-9");
    const byId = await itemGET(req(`/api/v1/items/${F.x}`, key), { params: Promise.resolve({ id: F.x }) });
    expect(byId.status).toBe(404);
    expect(await okfNodes(key), "no OKF nodes for a non-principal").toEqual([]);
  });

  it("an external-posture connector and an offroster key read nothing", async () => {
    const F = await buildFixture();
    const connector = await rawMember(F.seed, { is_connector: true, tier: "external" });
    await plantBuiltin(F.seed, connector, "external");
    const offroster = await rawMember(F.seed, { kind: "offroster", tier: "external" });
    for (const id of [connector, offroster]) {
      const { key } = await issueApiKey(db(), F.seed.teamId, id, "legacy");
      expect(await taskKeys(key), "legacy external arm: no rows").toEqual([]);
      expect(await decisionKeys(key)).toEqual([]);
    }
  });

  it("pushes keep their existing admission: an external key cannot overwrite the granted team item and a fresh push is coerced to external", async () => {
    const F = await buildFixture();
    const auth = { teamId: F.seed.teamId, memberId: F.external, apiKeyId: randomUUID() };
    const changed = "x body rewritten by a collaborator";
    await expect(
      ingestItem(db(), auth, { project: "src", kind: "deliverable", actor: "c", frontmatter: {}, path: "x.md", body: changed, content_sha256: sha(changed) }, "team", undefined, "external")
    ).rejects.toBeInstanceOf(TierViolationError);
    const fresh = await ingestItem(db(), auth, { project: "src", kind: "deliverable", actor: "c", frontmatter: {}, path: "fresh-from-client.md", body: "client note", content_sha256: sha("client note") }, "team", undefined, "external");
    const { data } = await db().from("items").select("access").eq("id", fresh.id).single();
    expect((data as { access: string }).access, "a fresh external push keeps baseline coercion").toBe("external");
  });
});

describe("TIERRET-1 AC-05 — counts/unknown_keys describe the SERVED rows", () => {
  it("by-key lookup: a granted team-audience key is known; an ungranted one is unknown", async () => {
    const F = await buildFixture();
    const res = await tasksGET(req("/api/v1/tasks?mode=table&keys=LX-1,LY-9,NOPE-1", F.externalKey));
    const body = (await res.json()) as { unknown_keys: string[] | null };
    expect(body.unknown_keys?.sort()).toEqual(["LY-9", "NOPE-1"]);
  });
});

describe("TIERRET-1 AC-06 — grounding counts the granted team-labelled corpus", () => {
  it("an external-posture member's specific granted term grounds; a hidden-only term does not", async () => {
    const F = await buildFixture();
    const enforce = await memberEnforce(F.seed.teamId, F.external);
    const granted = await retrieve(db(), F.seed.teamId, "external", `about ${TERM_X2}`, null, enforce);
    expect(granted.sources.map((s) => s.path)).toContain("x2.md");
    expect(granted.grounded, "the term-specificity corpus must include granted team-labelled items").toBe(true);
    const hidden = await retrieve(db(), F.seed.teamId, "external", `about ${TERM_Y}`, null, enforce);
    expect(hidden.sources.map((s) => s.path)).not.toContain("y.md");
    expect(hidden.grounded, "a hidden-only term cannot change grounded evidence").toBe(false);
  });

  it("the structured digest carries the granted sourced task and decision; never Y's", async () => {
    const F = await buildFixture();
    const enforce = await memberEnforce(F.seed.teamId, F.external);
    const ctx = await retrieve(db(), F.seed.teamId, "external", `what about ${TERM_X}`, null, enforce);
    expect(ctx.structured).toContain("X sourced task");
    expect(ctx.structured).toContain("X decision");
    expect(ctx.structured).not.toContain("Y secret task");
    expect(ctx.structured).not.toContain("Y secret decision");
  });
});

describe("TIERRET-1 AC-07 — meetings follow the transcript oracle at either posture", () => {
  it("list and detail serve the granted note to the external member; the hidden note never", async () => {
    const F = await buildFixture();
    const list = await listMeetingNotesForTeam(db(), F.seed.teamId, { memberId: F.external, tier: "external" });
    expect(list.map((n) => n.title)).toContain("X standup");
    expect(list.map((n) => n.title)).not.toContain("Y board prep");
    expect(await getMeetingNote(db(), F.seed.teamId, F.noteX, { memberId: F.external, tier: "external" })).not.toBeNull();
    expect(await getMeetingNote(db(), F.seed.teamId, F.noteY, { memberId: F.external, tier: "external" })).toBeNull();
  });
});

describe("TIERRET-1 AC-08 — authenticated OKF export", () => {
  it("default member export includes granted team-labelled nodes and links; explicit external export excludes them", async () => {
    const F = await buildFixture();
    const nodes = await okfNodes(F.externalKey);
    const x = nodes.find((n) => n.path === "x.md");
    expect(x, "granted team-labelled node is exported by default").toBeDefined();
    expect(x!.links, "granted present target preserved").toContain("x2.md");
    expect(x!.links, "invisible present target stays redacted").not.toContain("y.md");
    expect(x!.links, "dangling target keeps existing semantics (preserved)").toContain("missing.md");
    expect(nodes.map((n) => n.path)).not.toContain("y.md");

    const ext = await okfNodes(F.externalKey, "?tier=external");
    expect(ext.map((n) => n.path), "explicit tier=external still narrows by label").not.toContain("x.md");
  });

  it("invalid credentials still deny", async () => {
    const res = await okfGET(req("/api/v1/okf-bundle", "aios_bad_key"));
    expect(res.status).toBe(401);
  });
});

describe("TIERRET-1 AC-12 — timeline via the production cache path", () => {
  // Fixture TEARDOWN, not an assertion: a cold miss schedules a background synopsis pass that writes
  // `work_timeline_cache` for this team. Unsettled, it races the next test's per-test TRUNCATE and logs
  // a team FK violation (seen in the baseline run) — noise that must never be read as a product result.
  afterEach(async () => {
    await settleTimelineRefreshes();
  });

  it("the external member's timeline variant serves X evidence, the X meeting and the granted hand-typed task header; never Y", async () => {
    const F = await buildFixture();
    // Timeline-eligible evidence in X (attributed + source-dated), citing HT-X and LX-1.
    const commit = await ingest(F.seed, { path: "commits/x-work.md", body: `feat: x work (LX-1) (HTX-1) ${TERM_X}`, access: "team", project: "src", kind: "deliverable", frontmatter: { source: "git", author: "tester" } });
    const commitY = await ingest(F.seed, { path: "commits/y-work.md", body: `feat: y secret (LY-9) ${TERM_Y}`, access: "team", project: "src", kind: "deliverable", frontmatter: { source: "git", author: "tester" } });
    await backfillTeamContext(db(), F.seed.teamId);
    await moveMembership(F.seed, commit.id, F.X);
    await moveMembership(F.seed, commitY.id, F.Y);
    await db().from("items").update({ member_id: F.seed.memberId, work_at: now(), work_at_from_source: true }).in("id", [commit.id, commitY.id]);

    const res = await timelineGET(req("/api/v1/timeline", F.externalKey));
    expect(res.status).toBe(200);
    const flat = JSON.stringify(await res.json());
    expect(flat, "X evidence flows").toContain("x work");
    expect(flat, "the granted transcript's meeting flows at external posture").toContain("X standup");
    expect(flat, "the granted hand-typed task heads its group").toContain("Hand-typed X task");
    expect(flat, "Y evidence never").not.toContain("y secret");
    expect(flat).not.toContain("Y board prep");

    const { data } = await db().from("work_timeline_cache").select("group_key").eq("team_id", F.seed.teamId);
    const keys = ((data ?? []) as { group_key: string }[]).map((r) => r.group_key);
    expect(keys.some((k) => k.startsWith("adm:")), `the new authorization namespace is written, got ${keys.join()}`).toBe(true);
    expect(keys.some((k) => k.startsWith("vis:")), "old-namespace rows are never written by the new code").toBe(false);
  });

  it("a connector and a grantless member at the same posture/empty-project hash do NOT share a variant", async () => {
    const F = await buildFixture();
    const connector = await rawMember(F.seed, { is_connector: true, tier: "team" });
    await plantBuiltin(F.seed, connector, "everyone");
    const grantlessAgent = await rawMember(F.seed, { kind: "agent", tier: "team" });
    await plantBuiltin(F.seed, grantlessAgent, "everyone");
    for (const id of [connector, grantlessAgent]) {
      const { key } = await issueApiKey(db(), F.seed.teamId, id, "k");
      expect((await timelineGET(req("/api/v1/timeline", key))).status).toBe(200);
    }
    const { data } = await db().from("work_timeline_cache").select("group_key").eq("team_id", F.seed.teamId);
    const keys = ((data ?? []) as { group_key: string }[]).map((r) => r.group_key);
    expect(new Set(keys).size, `legacy and member variants must be distinct rows, got ${keys.join()}`).toBe(2);
  });
});

describe("TIERRET-1 AC-14 — a full re-pull recovers older newly admitted rows without duplicates", () => {
  it("advanced cursors return nothing; epoch re-pull returns the newly admitted rows once, idempotently", async () => {
    const F = await buildFixture();
    const future = new Date(Date.now() + 86_400_000).toISOString();
    expect(await taskKeys(F.externalKey, `?since=${encodeURIComponent(future)}`), "an advanced cursor hides older rows").toEqual([]);
    expect(await decisionKeys(F.externalKey, future)).toEqual([]);
    const first = await taskKeys(F.externalKey);
    const second = await taskKeys(F.externalKey);
    expect(first).toContain("LX-1");
    expect(first, "repeat pulls are byte-stable by row key").toEqual(second);
    expect(new Set(first).size, "no duplicate row keys").toBe(first.length);
    const okf = (await okfNodes(F.externalKey)).map((n) => n.path);
    expect(okf).toContain("x.md");
    expect(new Set(okf).size).toBe(okf.length);
  });
});

describe("TIERRET-1 AC-10 — access-health drift blocker: external-tier human in builtin Everyone", () => {
  async function team(): Promise<Seed> {
    const seed = await seedTeam();
    await ingest(seed, { path: "h.md", body: "h", access: "team", project: "src" });
    expect((await ensureAccessBootstrap(db(), seed.teamId)).ok).toBe(true);
    expect((await backfillTeamContext(db(), seed.teamId)).ok).toBe(true);
    return seed;
  }

  it("active external-tier human in Everyone → healthy=false with a named, actionable blocker; clearing it clears the blocker", async () => {
    const seed = await team();
    const drifted = await rawMember(seed, { tier: "external" });
    await plantBuiltin(seed, drifted, "everyone");
    const h = await assessAccessHealth(db(), seed.teamId);
    expect(h.healthy).toBe(false);
    const blocker = h.blockers.find((b) => /Everyone/.test(b) && /external/i.test(b));
    expect(blocker, `expected the external-in-Everyone blocker, got: ${h.blockers.join(" | ")}`).toBeDefined();
    expect(blocker, "actionable: it says Everyone grants General").toMatch(/General/);
    expect((h as unknown as { externalTierInEveryone?: { memberId: string }[] }).externalTierInEveryone?.map((m) => m.memberId)).toContain(drifted);
    expect(formatAccessHealth(h).join("\n"), "the CLI formatter exposes the identity").toContain(drifted);

    const { data: g } = await db().from("groups").select("id").eq("team_id", seed.teamId).eq("slug", "everyone").eq("is_builtin", true).single();
    await db().from("group_members").delete().eq("group_id", (g as { id: string }).id).eq("member_id", drifted);
    await plantBuiltin(seed, drifted, "external");
    const after = await assessAccessHealth(db(), seed.teamId);
    expect(after.blockers.some((b) => /Everyone/.test(b) && /external-tier/i.test(b))).toBe(false);
  });

  it("both builtins + persisted external tier triggers it; external-only, inactive, custom-grant and look-alike groups do not", async () => {
    const seed = await team();
    const both = await rawMember(seed, { tier: "external" });
    await plantBuiltin(seed, both, "everyone");
    await plantBuiltin(seed, both, "external");
    const extOnly = await rawMember(seed, { tier: "external" });
    await plantBuiltin(seed, extOnly, "external");
    const inactive = await rawMember(seed, { tier: "external", status: "invited" });
    await plantBuiltin(seed, inactive, "everyone");
    const lookalike = await rawMember(seed, { tier: "external" });
    await plantBuiltin(seed, lookalike, "external");
    const g = await createGroup(db(), seed.teamId, `everyone-${randomUUID().slice(0, 4)}`, "Everyone", seed.memberId);
    expect((await addMemberToGroup(db(), seed.teamId, g.groupId!, lookalike, seed.memberId)).ok).toBe(true);
    const crossTeam = await rawMember(seed, { tier: "team" }); // deliberate cross-enrollment, tier=team
    await plantBuiltin(seed, crossTeam, "everyone");
    await plantBuiltin(seed, crossTeam, "external");

    const h = await assessAccessHealth(db(), seed.teamId);
    const flagged = ((h as unknown as { externalTierInEveryone?: { memberId: string }[] }).externalTierInEveryone ?? []).map((m) => m.memberId);
    expect(flagged).toContain(both);
    for (const id of [extOnly, inactive, lookalike, crossTeam]) expect(flagged, `${id} must not be flagged`).not.toContain(id);
  });

  it("a read error cannot return clean health", async () => {
    const seed = await team();
    const real = db();
    const broken = {
      from: (t: string) =>
        t === "group_members"
          ? { select() { return this; }, eq() { return this; }, in() { return this; }, then(r: (v: unknown) => void) { r({ data: null, error: { message: "boom" } }); } }
          : real.from(t),
      rpc: real.rpc.bind(real),
    } as unknown as ReturnType<typeof db>;
    await expect(assessAccessHealth(broken, seed.teamId)).rejects.toThrow();
  });
});
