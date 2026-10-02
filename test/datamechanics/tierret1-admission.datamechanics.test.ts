import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { db, ingest, seedTeam, sha, type Seed } from "./helpers";
import { ingestItem } from "@/lib/ingest";
import { createMember } from "@/lib/admin/members";
import { createGroup, addMemberToGroup, grantProjectToGroup, removeMemberFromGroup } from "@/lib/access/groups";
import { ensureAccessBootstrap } from "@/lib/access/bootstrap";
import { backfillTeamContext } from "@/lib/projects/context/backfill";
import { visibleProjectRows } from "@/lib/access/enforce";
import { decisionsCardWindow, boardTaskWindow } from "@/lib/access/structured-windows";
import { getPulseMetrics } from "@/lib/metrics/pulse";
import { retrieve } from "@/lib/query/retrieve";
import { getCachedWorkTimeline, settleTimelineRefreshes, PAYLOAD_VERSION } from "@/lib/dashboard/timeline-cache";
// TIERRET-1 NEW surface (does not exist on the base — a baseline run reds on the import, which is
// the honest red for a not-yet-built resolver; the matrix below is what pins its behaviour).
import {
  resolveContentAdmission,
  resolveContentView,
  provenanceCtxFor,
  contentLabelTier,
  retrieveEnforceFor,
  ContentAdmissionError,
} from "@/lib/access/admission";
import { readableProjectRows, canReadProjectRow } from "@/lib/access/enforce";
import { purgeAdmissionTimelineNamespace, timelineViewKey } from "@/lib/dashboard/timeline-cache";

/**
 * TIERRET-1 — the ONE positive, fail-closed member-content admission resolver (AC-03/AC-04) and
 * the surfaces that consume it (AC-05 windows/Pulse/project rows, AC-11 graph scope carriage,
 * AC-12 cache namespace/isolation/rollback). Spec: docs/design/tierret1-membership-only.md.
 */

async function rawMember(seed: Seed, over: Partial<{ kind: string; tier: string; status: string; is_connector: boolean }> = {}): Promise<string> {
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

async function plantBuiltin(seed: Seed, memberId: string, slug: "everyone" | "external"): Promise<void> {
  const { data: g } = await db().from("groups").select("id").eq("team_id", seed.teamId).eq("slug", slug).eq("is_builtin", true).single();
  const { error } = await db().from("group_members").insert({ team_id: seed.teamId, group_id: (g as { id: string }).id, member_id: memberId });
  expect(error).toBeNull();
}

async function moveMembership(seed: Seed, itemId: string, projectId: string): Promise<void> {
  const { data: unit } = await db().from("project_context_units").select("id").eq("source_item_id", itemId).single();
  await db().from("project_context_memberships").update({ valid_to: new Date().toISOString() }).eq("context_unit_id", (unit as { id: string }).id).is("valid_to", null);
  const { error } = await db().from("project_context_memberships").insert({ team_id: seed.teamId, project_id: projectId, context_unit_id: (unit as { id: string }).id, method: "manual" });
  expect(error).toBeNull();
}

interface Fx { seed: Seed; X: string; Y: string; srcId: string; x: string; y: string; external: string; group: string }

async function fixture(): Promise<Fx> {
  const seed = await seedTeam();
  await backfillTeamContext(db(), seed.teamId);
  const x = await ingest(seed, { path: "x.md", body: "alpha xenolith", access: "team", project: "src" });
  const y = await ingest(seed, { path: "y.md", body: "beta yttrium", access: "team", project: "src" });
  await backfillTeamContext(db(), seed.teamId);
  expect((await ensureAccessBootstrap(db(), seed.teamId)).ok).toBe(true);
  const mk = async (slug: string) => ((await db().from("projects").insert({ team_id: seed.teamId, slug: `${slug}-${randomUUID().slice(0, 6)}`, name: slug, kind: "initiative" }).select("id").single()).data as { id: string }).id;
  const X = await mk("x");
  const Y = await mk("y");
  await moveMembership(seed, x.id, X);
  await moveMembership(seed, y.id, Y);
  const m = await createMember(db(), seed.teamId, { email: `${randomUUID()}@test.local`, displayName: "Ext", actorHandle: `e-${randomUUID().slice(0, 8)}`, role: "member", tier: "external" });
  await db().from("members").update({ status: "active" }).eq("id", m.id);
  const g = await createGroup(db(), seed.teamId, `cx-${randomUUID().slice(0, 6)}`, "CX", seed.memberId);
  expect((await addMemberToGroup(db(), seed.teamId, g.groupId!, m.id, seed.memberId)).ok).toBe(true);
  expect((await grantProjectToGroup(db(), seed.teamId, X, g.groupId!, seed.memberId)).ok).toBe(true);
  const gy = await createGroup(db(), seed.teamId, `iy-${randomUUID().slice(0, 6)}`, "IY", seed.memberId);
  expect((await grantProjectToGroup(db(), seed.teamId, Y, gy.groupId!, seed.memberId)).ok).toBe(true);
  return { seed, X, Y, srcId: x.projectId!, x: x.id, y: y.id, external: m.id, group: g.groupId! };
}

describe("TIERRET-1 AC-03 — positive admission: who enters the member arm", () => {
  it("active humans and standing agents are members; connector, offroster and inactive rows are legacy", async () => {
    const F = await fixture();
    const everyoneHuman = await resolveContentAdmission(db(), F.seed.teamId, F.seed.memberId);
    expect(everyoneHuman).toMatchObject({ kind: "member", everyone: true });

    const ext = await resolveContentAdmission(db(), F.seed.teamId, F.external);
    expect(ext).toMatchObject({ kind: "member", everyone: false, posture: "external" });
    expect(ext.kind === "member" && [...ext.grantedProjectIds]).toEqual(expect.arrayContaining([F.X]));

    const agent = await rawMember(F.seed, { kind: "agent" });
    await plantBuiltin(F.seed, agent, "everyone");
    const a = await resolveContentAdmission(db(), F.seed.teamId, agent);
    expect(a, "a planted builtin row on an agent is posture-only — never the Everyone all arm (N3)").toMatchObject({ kind: "member", everyone: false, posture: "team" });

    for (const [label, over] of [
      ["connector", { is_connector: true }],
      ["offroster", { kind: "offroster" }],
      ["invited (inactive) human", { status: "invited" }],
    ] as const) {
      const id = await rawMember(F.seed, over);
      await plantBuiltin(F.seed, id, "everyone");
      const r = await resolveContentAdmission(db(), F.seed.teamId, id);
      expect(r.kind, `${label} never enters the member arm`).toBe("legacy");
    }
  });

  it("missing, foreign-team and unreadable members fail CLOSED (throw), never manufacture memberhood", async () => {
    const F = await fixture();
    const other = await seedTeam();
    await expect(resolveContentAdmission(db(), F.seed.teamId, randomUUID())).rejects.toBeInstanceOf(ContentAdmissionError);
    await expect(resolveContentAdmission(db(), F.seed.teamId, other.memberId), "a foreign team's member").rejects.toBeInstanceOf(ContentAdmissionError);
    const broken = {
      from: () => {
        const b = { select: () => b, eq: () => b, in: () => b, maybeSingle: () => Promise.resolve({ data: null, error: { message: "down" } }), then: (r: (v: unknown) => unknown) => r({ data: null, error: { message: "down" } }) };
        return b;
      },
      rpc: () => Promise.resolve({ data: null, error: { message: "down" } }),
    } as unknown as ReturnType<typeof db>;
    await expect(resolveContentAdmission(broken, F.seed.teamId, F.external)).rejects.toThrow();
  });

  it("the legacy arm keeps baseline label/unsourced semantics and gets NO graph scope; the member arm's graph scope is the oracle set", async () => {
    const F = await fixture();
    const connector = await rawMember(F.seed, { is_connector: true });
    await plantBuiltin(F.seed, connector, "everyone");
    const legacy = await resolveContentView(db(), F.seed.teamId, connector);
    expect(legacy.ids.size, "a non-principal sees no sourced items").toBe(0);
    const legacyEnforce = retrieveEnforceFor(legacy);
    expect(legacyEnforce.principal).toBe("legacy");
    expect(legacyEnforce.graphProjectIds, "no new graph authority for a legacy key (AC-11)").toBeUndefined();
    expect(contentLabelTier(legacy.admission), "baseline posture ceiling").toBe("team");

    const member = await resolveContentView(db(), F.seed.teamId, F.external);
    const memberEnforce = retrieveEnforceFor(member);
    expect(memberEnforce.principal).toBe("member");
    expect([...(memberEnforce.graphProjectIds ?? [])].sort(), "graph scope = the oracle's granted set, never a fallback").toEqual([...member.projectIds].sort());
    expect(contentLabelTier(member.admission), "a positively admitted member has no label ceiling").toBe("team");

    const extConnector = await rawMember(F.seed, { is_connector: true, tier: "external" });
    await plantBuiltin(F.seed, extConnector, "external");
    expect(contentLabelTier((await resolveContentView(db(), F.seed.teamId, extConnector)).admission)).toBe("external");
  });

  it("the legacy connector key keeps its baseline org-structure legs and gains no graph/sourced content through retrieval", async () => {
    const F = await fixture();
    const connector = await rawMember(F.seed, { is_connector: true });
    await plantBuiltin(F.seed, connector, "everyone");
    await db().from("graph_entities").insert({ team_id: F.seed.teamId, entity_id: `member:${randomUUID()}`, entity_type: "actor", name: "Rosterina Legacy", attrs: {} });
    const view = await resolveContentView(db(), F.seed.teamId, connector);
    const ctx = await retrieve(db(), F.seed.teamId, view.admission.posture, "who reports to whom about xenolith", null, retrieveEnforceFor(view));
    expect(ctx.structured ?? "", "baseline org-structure preserved for legacy keys (not revoked here)").toContain("Rosterina Legacy");
    expect(ctx.sources.map((s) => s.path), "no sourced items").toEqual([]);
    expect(ctx.graphScope, "no graph leg").toBeUndefined();
  });
});

describe("TIERRET-1 AC-05 — project READ rows widen; the WRITER predicate does not", () => {
  it("the source container is readable through granted content but stays out of the writable set", async () => {
    const F = await fixture();
    const principal = { teamId: F.seed.teamId, memberId: F.external };
    const readable = await readableProjectRows(db(), principal);
    expect(readable.ids.has(F.srcId), "content-visible container is readable").toBe(true);
    expect(readable.ids.has(F.X)).toBe(true);
    expect(readable.ids.has(F.Y), "ungranted Y never").toBe(false);
    expect(await canReadProjectRow(db(), principal, F.srcId)).toBe(true);
    const writable = await visibleProjectRows(db(), principal);
    expect(writable.ids.has(F.srcId), "the create dropdown / actions predicate is unchanged").toBe(false);
  });
});

describe("TIERRET-1 AC-05 — capped windows rank over the SERVED set", () => {
  it("ten newer hidden decisions cannot starve the 8-row card; the granted team-audience decision serves", async () => {
    const F = await fixture();
    const day = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);
    for (let i = 0; i < 10; i++) {
      await db().from("decisions").insert({ team_id: F.seed.teamId, project_id: F.srcId, row_key: `DY-${i}`, title: `hidden ${i}`, decided_by: "t", decided_at: day(1), still_valid: true, audience: "team", source_item_id: F.y });
    }
    await db().from("decisions").insert({ team_id: F.seed.teamId, project_id: F.srcId, row_key: "DX-OLD", title: "granted older decision", decided_by: "t", decided_at: day(5), still_valid: true, audience: "team", source_item_id: F.x });
    const view = await resolveContentView(db(), F.seed.teamId, F.external);
    const card = await decisionsCardWindow(F.seed.teamId, provenanceCtxFor(view), contentLabelTier(view.admission) === "external");
    expect(card.map((d) => d.title)).toContain("granted older decision");
    expect(card.map((d) => d.title).some((t) => t.startsWith("hidden"))).toBe(false);
  });

  it("the board window and Pulse count granted team-labelled content for the external member", async () => {
    const F = await fixture();
    await db().from("tasks").insert({ team_id: F.seed.teamId, project_id: F.srcId, row_key: "LX-1", title: "granted task", assignee: "T", status: "in_progress", audience: "team", origin: "sync", source_item_id: F.x });
    await db().from("tasks").insert({ team_id: F.seed.teamId, project_id: F.X, row_key: "HTX-1", title: "granted hand task", assignee: "T", status: "ready", audience: "team", origin: "ui", source_item_id: null, created_by: F.seed.memberId });
    await db().from("tasks").insert({ team_id: F.seed.teamId, project_id: F.srcId, row_key: "HTS-1", title: "src hand task", assignee: "T", status: "ready", audience: "team", origin: "ui", source_item_id: null, created_by: F.seed.memberId });
    const view = await resolveContentView(db(), F.seed.teamId, F.external);
    const board = await boardTaskWindow<{ row_key: string }>(F.seed.teamId, provenanceCtxFor(view), contentLabelTier(view.admission) === "external");
    expect(board.map((t) => t.row_key).sort()).toEqual(["HTX-1", "LX-1"]);

    const pulse = await getPulseMetrics(db(), F.seed.teamId, "7d", { isAdmin: false, memberId: F.external, tier: contentLabelTier(view.admission), provCtx: provenanceCtxFor(view) });
    const grown = pulse.knowledge.reduce((n, p) => n + Object.values(p).filter((v): v is number => typeof v === "number").reduce((a, b) => a + b, 0), 0);
    expect(grown, "knowledge growth counts the granted team-labelled item").toBeGreaterThan(0);
    const funnelTotal = pulse.funnel.reduce((n, f) => n + f.count, 0);
    expect(funnelTotal, "the funnel counts exactly the two served tasks").toBe(2);
  });
});

describe("TIERRET-1 AC-12 — timeline cache: new namespace, v16, admission-separated, revocation, purge, rollback", () => {
  async function timelineFixture() {
    const F = await fixture();
    const now = new Date().toISOString();
    const c = await ingest(F.seed, { path: "commits/xc.md", body: "feat: xenolith work (LX-1)", access: "team", project: "src", kind: "deliverable", frontmatter: { source: "git", author: "t" } });
    await backfillTeamContext(db(), F.seed.teamId);
    await moveMembership(F.seed, c.id, F.X);
    await db().from("items").update({ member_id: F.seed.memberId, work_at: now, work_at_from_source: true }).eq("id", c.id);
    return { F, commitId: c.id };
  }
  const keysOf = async (teamId: string) =>
    (((await db().from("work_timeline_cache").select("group_key, payload").eq("team_id", teamId)).data ?? []) as { group_key: string; payload: { v: number } }[]);

  it("cold then warm: the granted content is served under adm:<class>:<tier>:<hash> at payload v16", async () => {
    const { F } = await timelineFixture();
    expect(PAYLOAD_VERSION, "15 is reserved by PR 714").toBe(16);
    const cold = await getCachedWorkTimeline(db(), F.seed.teamId, "external", F.external);
    await settleTimelineRefreshes();
    const warm = await getCachedWorkTimeline(db(), F.seed.teamId, "external", F.external);
    for (const r of [cold, warm]) expect(JSON.stringify(r.days)).toContain("xenolith work");
    const rows = await keysOf(F.seed.teamId);
    const key = await timelineViewKey(db(), F.seed.teamId, "external", F.external);
    expect(key.startsWith("adm:"), key).toBe(true);
    expect(rows.find((r) => r.group_key === key)?.payload.v).toBe(16);
  });

  it("revoking the grant moves the member to a different variant that no longer names the work", async () => {
    const { F } = await timelineFixture();
    await getCachedWorkTimeline(db(), F.seed.teamId, "external", F.external);
    await settleTimelineRefreshes();
    const before = await timelineViewKey(db(), F.seed.teamId, "external", F.external);
    expect((await removeMemberFromGroup(db(), F.seed.teamId, F.group, F.external, F.seed.memberId)).ok).toBe(true);
    const after = await timelineViewKey(db(), F.seed.teamId, "external", F.external);
    expect(after).not.toBe(before);
    const { days } = await getCachedWorkTimeline(db(), F.seed.teamId, "external", F.external);
    expect(JSON.stringify(days)).not.toContain("xenolith work");
  });

  it("an admission resolution error writes NO success cache row", async () => {
    const { F } = await timelineFixture();
    const real = db();
    const broken = {
      from: (t: string) => {
        if (t !== "group_members") return real.from(t);
        const b = { select: () => b, eq: () => b, in: () => b, then: (r: (v: unknown) => unknown) => r({ data: null, error: { message: "boom" } }) };
        return b;
      },
      rpc: real.rpc.bind(real),
    } as unknown as ReturnType<typeof db>;
    await expect(getCachedWorkTimeline(broken, F.seed.teamId, "external", F.external)).rejects.toThrow();
    expect((await keysOf(F.seed.teamId)).filter((r) => r.group_key.startsWith("adm:"))).toEqual([]);
  });

  it("external→team reclassification removes the external member's new-namespace variant before it can serve the narrowed title", async () => {
    const F = await fixture();
    const now = new Date().toISOString();
    const e = await ingest(F.seed, { path: "commits/ext.md", body: "feat: shared cobaltine work", access: "external", project: "src", kind: "deliverable", frontmatter: { source: "git", author: "t" } });
    await backfillTeamContext(db(), F.seed.teamId);
    await db().from("items").update({ member_id: F.seed.memberId, work_at: now, work_at_from_source: true }).eq("id", e.id);
    expect(JSON.stringify((await getCachedWorkTimeline(db(), F.seed.teamId, "external", F.external)).days)).toContain("cobaltine");
    await settleTimelineRefreshes();
    // Narrow through the production ingest path (reclassify → tier invalidation).
    await ingestItem(db(), { teamId: F.seed.teamId, memberId: F.seed.memberId, apiKeyId: randomUUID() }, { project: "src", kind: "deliverable", actor: "t", frontmatter: { source: "git", author: "t" }, path: "commits/ext.md", body: "feat: shared cobaltine work", content_sha256: sha("feat: shared cobaltine work") }, "team", undefined, "team");
    const key = await timelineViewKey(db(), F.seed.teamId, "external", F.external);
    const { data: row } = await db().from("work_timeline_cache").select("payload").eq("team_id", F.seed.teamId).eq("group_key", key).maybeSingle();
    expect(JSON.stringify(row ?? null), "the persisted variant must be gone or rebuilt without the narrowed title").not.toContain("cobaltine");
    const { days } = await getCachedWorkTimeline(db(), F.seed.teamId, "external", F.external);
    expect(JSON.stringify(days), "never served from memory either").not.toContain("cobaltine");
  });

  it("rollback isolation: old code's exact-key lookup (vis:<tier>:<hash>) and salvage cannot reach the wider new rows", async () => {
    const { F } = await timelineFixture();
    await getCachedWorkTimeline(db(), F.seed.teamId, "external", F.external);
    await settleTimelineRefreshes();
    const rows = await keysOf(F.seed.teamId);
    expect(rows.every((r) => !r.group_key.startsWith("vis:")), "new code never writes the namespace old code reads").toBe(true);
    // The OLD reader's key for this member: vis:<posture>:<sha16(sorted granted projects)>.
    const { memberVisibility } = await import("@/lib/access/enforce");
    const oldKey = `vis:external:${(await memberVisibility(db(), { teamId: F.seed.teamId, memberId: F.external })).visibilityHash}`;
    const { data } = await db().from("work_timeline_cache").select("payload").eq("team_id", F.seed.teamId).eq("group_key", oldKey).maybeSingle();
    expect(data, "old-code lookup (and its same-key salvage) finds nothing").toBeNull();
  });

  it("roll-forward after rollback: the namespace purge deletes pre-rollback summaries before the new code serves", async () => {
    const { F } = await timelineFixture();
    const key = await timelineViewKey(db(), F.seed.teamId, "external", F.external);
    // A row written BEFORE a rollback, naming work that was narrowed while old code (which cannot
    // purge this namespace) was live.
    await db().from("work_timeline_cache").upsert({
      team_id: F.seed.teamId,
      group_key: key,
      payload: JSON.stringify({ v: PAYLOAD_VERSION, days: [{ date: new Date().toISOString().slice(0, 10), people: [{ memberId: F.seed.memberId, name: "X", summary: "STALE-PRE-ROLLBACK prose", tasks: [], other: [], unlinked: 0, total: 0, signals: [] }] }] }),
      computed_at: new Date().toISOString(),
    }, { onConflict: "team_id,group_key" });
    const purged = await purgeAdmissionTimelineNamespace(db());
    expect(purged.ok).toBe(true);
    const { days } = await getCachedWorkTimeline(db(), F.seed.teamId, "external", F.external);
    expect(JSON.stringify(days), "the documented roll-forward step leaves nothing stale to serve or salvage").not.toContain("STALE-PRE-ROLLBACK");
  });
});
