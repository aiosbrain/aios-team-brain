import { describe, expect, it, vi, beforeEach } from "vitest";
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import { db, ingest, seedTeam, type Seed } from "./helpers";

vi.mock("@/lib/auth/guard", () => ({ requireTeamAdmin: vi.fn() }));

import { requireTeamAdmin } from "@/lib/auth/guard";
import { mintAgentTokenAction, revokeAgentTokenAction } from "@/app/t/[team]/admin/agents/actions";
import { verifyAgentToken, type MintResult } from "@/lib/access/agent-tokens";
import { SCOPE_ERRORS } from "@/lib/access/agent-token-scope";
import { addMemberToGroup, createGroup, grantProjectToGroup } from "@/lib/access/groups";
import { visibleProjectRows } from "@/lib/access/enforce";
import { effectiveVisibleProjects } from "@/lib/access/oracle";
import { GET as itemsGET } from "@/app/api/v1/items/route";

/**
 * AGENTUI-1 — the mint ACTION against real Postgres.
 *
 * The policy itself is unit-tested in `test/agent-token-policy.test.ts`. What this tier proves is
 * the OUTCOME the unit tier structurally cannot: that a refused request leaves NO ROW behind. A
 * policy that returns `{ok:false}` while the writer has already run would pass every unit test and
 * still mint the credential it claimed to refuse.
 *
 * AUDITFIX-19: every request states its scope explicitly. Each refusal case carries a VALID scope
 * unless scope is its subject, asserts its own rule-specific reason, and proves no token, no row id,
 * unchanged `agent_tokens` count and unchanged successful `access.token_minted` audit count.
 */

const ALL_REACHABLE = { kind: "all-reachable" } as const;

async function seedMember(seed: Seed, kind = "human"): Promise<string> {
  const { data, error } = await db()
    .from("members")
    .insert({
      team_id: seed.teamId,
      email: `${randomUUID()}@test.local`,
      display_name: `M-${randomUUID().slice(0, 6)}`,
      actor_handle: `h-${randomUUID().slice(0, 10)}`,
      role: "member",
      tier: "team",
      status: "active",
      kind,
    })
    .select("id")
    .single();
  if (error || !data) throw new Error(`seed member failed: ${error?.message}`);
  return data.id as string;
}

async function tokenCount(teamId: string): Promise<number> {
  const { data } = await db().from("agent_tokens").select("id").eq("team_id", teamId);
  return (data ?? []).length;
}

async function mintAuditCount(teamId: string): Promise<number> {
  const { data, error } = await db()
    .from("audit_log")
    .select("id")
    .eq("team_id", teamId)
    .eq("action", "access.token_minted");
  if (error) throw new Error(`audit_log count failed: ${error.message}`);
  return (data ?? []).length;
}

async function storedScope(tokenRowId: string): Promise<string[] | null> {
  const { data, error } = await db().from("agent_tokens").select("project_scope").eq("id", tokenRowId).single();
  if (error) throw new Error(`agent_tokens row read failed: ${error.message}`);
  return (data as { project_scope: string[] | null }).project_scope;
}

/** A project plus a group grant making it visible to `memberId` — the realistic admin setup. */
async function grantedProject(seed: Seed, memberId: string): Promise<string> {
  const { data, error } = await db()
    .from("projects")
    .insert({ team_id: seed.teamId, slug: `p-${randomUUID().slice(0, 6)}` })
    .select("id")
    .single();
  if (error || !data) throw new Error(`seed project failed: ${error?.message}`);
  await grantToMember(seed, data.id as string, memberId);
  return data.id as string;
}

/** A fresh group containing `memberId`, granted `projectId` — a genuine grant, nothing hand-entered. */
async function grantToMember(seed: Seed, projectId: string, memberId: string): Promise<void> {
  const g = await createGroup(db(), seed.teamId, `g-${randomUUID().slice(0, 6)}`, "g", seed.memberId);
  if (!g.ok) throw new Error(`create group failed: ${g.error}`);
  const added = await addMemberToGroup(db(), seed.teamId, g.groupId!, memberId, seed.memberId);
  if (!added.ok) throw new Error(`add member failed: ${added.error}`);
  const granted = await grantProjectToGroup(db(), seed.teamId, projectId, g.groupId!, seed.memberId);
  if (!granted.ok) throw new Error(`grant failed: ${granted.error}`);
}

/** A project with NO grant to anyone — visible to no admin. */
async function ungrantedProject(seed: Seed): Promise<string> {
  const { data, error } = await db()
    .from("projects")
    .insert({ team_id: seed.teamId, slug: `u-${randomUUID().slice(0, 6)}` })
    .select("id")
    .single();
  if (error || !data) throw new Error(`seed project failed: ${error?.message}`);
  return data.id as string;
}

function future(days: number): string {
  return new Date(Date.now() + days * 86_400_000).toISOString();
}

/** A secret-free view of a mint result: the bearer string is reduced to whether one came back. */
function outcome(res: MintResult): { ok: boolean; error: string | undefined; hasToken: boolean; hasRowId: boolean } {
  return { ok: res.ok, error: res.error, hasToken: res.token !== undefined, hasRowId: res.tokenRowId !== undefined };
}

/** Refusal to the observable outcome: no credential, no row, no successful mint audit. */
async function expectNoWrite(res: MintResult, teamId: string, tokensBefore: number, auditsBefore: number): Promise<void> {
  const o = outcome(res);
  expect(o.ok).toBe(false);
  expect(o.hasToken, "a refusal returns no bearer").toBe(false);
  expect(o.hasRowId, "a refusal returns no row id").toBe(false);
  expect(await tokenCount(teamId), "a refused mint must not write a row").toBe(tokensBefore);
  expect(await mintAuditCount(teamId), "a refused mint must not emit access.token_minted").toBe(auditsBefore);
}

describe("AGENTUI-1 — mintAgentTokenAction against real Postgres", () => {
  beforeEach(() => vi.mocked(requireTeamAdmin).mockReset());

  it("an explicit all-reachable request mints exactly one row, persists NULL, and the stored hash is not the returned token", async () => {
    const seed = await seedTeam();
    const agent = await seedMember(seed, "agent");
    vi.mocked(requireTeamAdmin).mockResolvedValue({ teamId: seed.teamId, memberId: agent });

    const before = await tokenCount(seed.teamId);
    const res = await mintAgentTokenAction("any-slug", {
      memberId: agent,
      scope: ALL_REACHABLE,
      name: "status agent",
      expiresAt: future(30),
    });

    expect(res.ok, res.error).toBe(true);
    expect(/^aiosd_/.test(res.token ?? ""), "a bearer token is returned once").toBe(true);
    expect(await tokenCount(seed.teamId)).toBe(before + 1);

    const { data } = await db()
      .from("agent_tokens")
      .select("token_hash, project_scope, on_behalf_of, expires_at")
      .eq("id", res.tokenRowId!)
      .single();
    const row = data as { token_hash: string; project_scope: string[] | null; on_behalf_of: string | null };
    expect(row.token_hash === res.token, "the stored hash must not be the returned token").toBe(false);
    expect(row.project_scope, "explicit all-reachable must persist as NULL (live inheritance), never []").toBeNull();
    expect(row.on_behalf_of).toBeNull();
    expect((await verifyAgentToken(db(), res.token!))!.projectScope, "verified principal carries NULL").toBeNull();
  });

  /**
   * AUDITFIX-19 supersedes the old "legal omitted-scope request persists NULL" expectation: that was
   * the defect. Omission is now a no-write refusal; NULL comes only from the explicit choice above.
   */
  it("REFUSES an omitted scope from an authorized admin AND writes no row or mint audit", async () => {
    const seed = await seedTeam();
    const agent = await seedMember(seed, "agent");
    vi.mocked(requireTeamAdmin).mockResolvedValue({ teamId: seed.teamId, memberId: agent });

    const tokensBefore = await tokenCount(seed.teamId);
    const auditsBefore = await mintAuditCount(seed.teamId);
    const res = await mintAgentTokenAction("any-slug", { memberId: agent, expiresAt: future(30) } as never);

    expect(res.error).toBe(SCOPE_ERRORS.required);
    await expectNoWrite(res, seed.teamId, tokensBefore, auditsBefore);
  });

  /**
   * Each case asserts the ROW COUNT and MINT AUDIT COUNT are unchanged. Asserting only
   * `res.ok === false` would pass even if the writer had run — which is the failure this tier exists
   * to catch. Every non-scope case carries a VALID scope so it cannot pass on a scope refusal, and
   * every expiry matcher names `expiresAt` (a bare `/required/` would also match "scope is required").
   */
  const REFUSED: [name: string, input: () => Record<string, unknown>, error: string][] = [
    ["acting-as", () => ({ onBehalfOf: randomUUID(), scope: ALL_REACHABLE, expiresAt: future(30) }), "acting-as is not available in this version — tokens are self-only"],
    ["absent expiry", () => ({ scope: ALL_REACHABLE }), "expiresAt is required"],
    ["null expiry", () => ({ scope: ALL_REACHABLE, expiresAt: null }), "expiresAt is required"],
    ["past expiry", () => ({ scope: ALL_REACHABLE, expiresAt: new Date(Date.now() - 1000).toISOString() }), "expiresAt must be in the future"],
    ["expiry beyond the cap", () => ({ scope: ALL_REACHABLE, expiresAt: future(400) }), "expiresAt is beyond the 365-day maximum"],
    ["empty project list", () => ({ scope: { kind: "projects", projectIds: [] }, expiresAt: future(30) }), SCOPE_ERRORS.projectIdsEmpty],
    ["legacy projectScope: null", () => ({ projectScope: null, expiresAt: future(30) }), SCOPE_ERRORS.legacyKey],
  ];

  for (const [label, extra, error] of REFUSED) {
    it(`refuses ${label} AND writes no row or mint audit`, async () => {
      const seed = await seedTeam();
      const agent = await seedMember(seed, "agent");
      vi.mocked(requireTeamAdmin).mockResolvedValue({ teamId: seed.teamId, memberId: agent });

      const tokensBefore = await tokenCount(seed.teamId);
      const auditsBefore = await mintAuditCount(seed.teamId);
      const res = await mintAgentTokenAction("any-slug", { memberId: agent, ...extra() } as never);

      expect(res.error).toBe(error);
      await expectNoWrite(res, seed.teamId, tokensBefore, auditsBefore);
    });
  }

  it("a populated project list persists as the list it was given (distinguishable from NULL)", async () => {
    const seed = await seedTeam();
    const agent = await seedMember(seed, "agent");
    vi.mocked(requireTeamAdmin).mockResolvedValue({ teamId: seed.teamId, memberId: agent });

    const projectId = await grantedProject(seed, agent);

    const res = await mintAgentTokenAction("any-slug", {
      memberId: agent,
      scope: { kind: "projects", projectIds: [projectId] },
      expiresAt: future(30),
    });
    expect(res.ok, res.error).toBe(true);
    expect(await storedScope(res.tokenRowId!)).toEqual([projectId]);
  });

  it("AUDITFIX-19: an UPPERCASE project id passes both visibility checks and persists canonical lowercase", async () => {
    const seed = await seedTeam();
    const agent = await seedMember(seed, "agent");
    vi.mocked(requireTeamAdmin).mockResolvedValue({ teamId: seed.teamId, memberId: agent });
    const projectId = await grantedProject(seed, agent);

    const res = await mintAgentTokenAction("any-slug", {
      memberId: agent,
      scope: { kind: "projects", projectIds: [projectId.toUpperCase()] },
      expiresAt: future(30),
    });
    expect(res.ok, res.error).toBe(true);
    expect(await storedScope(res.tokenRowId!)).toEqual([projectId.toLowerCase()]);
  });

  it("AUDITFIX-19: a MIXED-CASE duplicate is refused, never silently deduplicated", async () => {
    const seed = await seedTeam();
    const agent = await seedMember(seed, "agent");
    vi.mocked(requireTeamAdmin).mockResolvedValue({ teamId: seed.teamId, memberId: agent });
    const projectId = await grantedProject(seed, agent);

    const tokensBefore = await tokenCount(seed.teamId);
    const auditsBefore = await mintAuditCount(seed.teamId);
    const res = await mintAgentTokenAction("any-slug", {
      memberId: agent,
      scope: { kind: "projects", projectIds: [projectId.toUpperCase(), projectId] },
      expiresAt: future(30),
    });
    expect(res.error).toBe(SCOPE_ERRORS.projectIdsDuplicate);
    await expectNoWrite(res, seed.teamId, tokensBefore, auditsBefore);
  });

  /**
   * Selected-projects mode: a project nobody can see is refused. Admin and launcher are the SAME
   * identity here, so this case alone cannot tell the two subset checks apart — the distinct-identity
   * cases in the AC-05 block below do that.
   */
  it("REFUSES a project list naming a project the admin cannot see, and writes no row", async () => {
    const seed = await seedTeam();
    const agent = await seedMember(seed, "agent");
    vi.mocked(requireTeamAdmin).mockResolvedValue({ teamId: seed.teamId, memberId: agent });

    const unseen = await ungrantedProject(seed);
    const tokensBefore = await tokenCount(seed.teamId);
    const auditsBefore = await mintAuditCount(seed.teamId);
    const res = await mintAgentTokenAction("any-slug", {
      memberId: agent,
      scope: { kind: "projects", projectIds: [unseen] },
      expiresAt: future(30),
    });

    expect(res.error).toBe("scope.projectIds names project(s) you cannot see");
    await expectNoWrite(res, seed.teamId, tokensBefore, auditsBefore);
  });

  it("REFUSES a FOREIGN team's project id, and writes no row", async () => {
    const seed = await seedTeam();
    const other = await seedTeam();
    const agent = await seedMember(seed, "agent");
    vi.mocked(requireTeamAdmin).mockResolvedValue({ teamId: seed.teamId, memberId: agent });
    const foreign = await grantedProject(other, other.memberId);

    const tokensBefore = await tokenCount(seed.teamId);
    const auditsBefore = await mintAuditCount(seed.teamId);
    const res = await mintAgentTokenAction("any-slug", {
      memberId: agent,
      scope: { kind: "projects", projectIds: [foreign] },
      expiresAt: future(30),
    });
    expect(res.error).toMatch(/^scope\.projectIds names project\(s\) /);
    await expectNoWrite(res, seed.teamId, tokensBefore, auditsBefore);
  });

  it("a non-admin caller mints nothing (pins the action's own gate, not the gate's internals)", async () => {
    const seed = await seedTeam();
    const agent = await seedMember(seed, "agent");
    vi.mocked(requireTeamAdmin).mockResolvedValue(null);

    const tokensBefore = await tokenCount(seed.teamId);
    const auditsBefore = await mintAuditCount(seed.teamId);
    // A fully VALID request, so the refusal can only be the gate.
    const res = await mintAgentTokenAction("any-slug", { memberId: agent, scope: ALL_REACHABLE, expiresAt: future(30) });
    expect(res).toEqual({ ok: false, error: "admins only" });
    expect(await tokenCount(seed.teamId)).toBe(tokensBefore);
    expect(await mintAuditCount(seed.teamId)).toBe(auditsBefore);

    // Authorization comes FIRST: a malformed request from a non-admin gets the gate's refusal, not
    // a validation detail.
    for (const bad of [null, { memberId: agent }, { memberId: agent, projectScope: null }]) {
      expect(await mintAgentTokenAction("any-slug", bad as never)).toEqual({ ok: false, error: "admins only" });
    }
    expect(await tokenCount(seed.teamId)).toBe(tokensBefore);
  });

  /**
   * REGRESSION (found by this tier): `revalidatePath` runs AFTER the row is written and throws
   * outside a request context. Because the secret is returned exactly once, an exception there
   * loses the token while the credential stays live — a stale list is cosmetic, an unreadable live
   * credential is not. This test calls the action with no Next request context, which is exactly
   * the condition that threw.
   */
  it("a mint still returns its token when cache revalidation cannot run", async () => {
    const seed = await seedTeam();
    const agent = await seedMember(seed, "agent");
    vi.mocked(requireTeamAdmin).mockResolvedValue({ teamId: seed.teamId, memberId: agent });

    const res = await mintAgentTokenAction("any-slug", { memberId: agent, scope: ALL_REACHABLE, expiresAt: future(30) });
    expect(res.ok, res.error).toBe(true);
    expect(/^aiosd_/.test(res.token ?? ""), "the secret must survive a revalidation fault — it is shown exactly once").toBe(true);
    expect(await tokenCount(seed.teamId)).toBe(1);
  });

  it("revoke marks the row and verification then fails", async () => {
    const seed = await seedTeam();
    const agent = await seedMember(seed, "agent");
    vi.mocked(requireTeamAdmin).mockResolvedValue({ teamId: seed.teamId, memberId: agent });

    const minted = await mintAgentTokenAction("any-slug", { memberId: agent, scope: ALL_REACHABLE, expiresAt: future(30) });
    expect(minted.ok, minted.error).toBe(true);
    expect(await verifyAgentToken(db(), minted.token!)).not.toBeNull();

    const rev = await revokeAgentTokenAction("any-slug", minted.tokenRowId!);
    expect(rev.ok, rev.error).toBe(true);
    expect(await verifyAgentToken(db(), minted.token!)).toBeNull();
  });
});

/**
 * AUDITFIX-19 AC-05 — the selected-projects issuance policy, isolated by DISTINCT identities.
 *
 * A is a GENUINE team-posture admin: the seeded human (placed in Everyone by `seedTeam`) promoted to
 * role admin; the mocked gate reports exactly that identity. L is a distinct eligible agent launcher.
 * Every project's issuance visibility comes from a real group grant (plus, for Q, current curation of
 * Q's own item into Q) — no hand-entered task/decision and no unrelated curation reach. Preconditions
 * are established with the SAME writer predicate the action uses (`visibleProjectRows`); the READ
 * outcome is checked separately with the oracle and the items route.
 */
describe("AUDITFIX-19 AC-05 — selected-projects mode keeps BOTH subset checks; all-reachable follows the launcher", () => {
  beforeEach(() => vi.mocked(requireTeamAdmin).mockReset());

  async function genuineAdminAndLauncher(): Promise<{ seed: Seed; admin: string; launcher: string }> {
    const seed = await seedTeam();
    const { error } = await db().from("members").update({ role: "admin" }).eq("team_id", seed.teamId).eq("id", seed.memberId);
    if (error) throw new Error(`promote admin failed: ${error.message}`);
    const { data: everyone } = await db()
      .from("groups")
      .select("id")
      .eq("team_id", seed.teamId)
      .eq("slug", "everyone")
      .eq("is_builtin", true)
      .single();
    const { data: placed } = await db()
      .from("group_members")
      .select("member_id")
      .eq("group_id", (everyone as { id: string }).id)
      .eq("member_id", seed.memberId)
      .maybeSingle();
    if (!placed) throw new Error("fixture: the admin must keep its explicit Everyone (team-posture) placement");
    const launcher = await seedMember(seed, "agent");
    vi.mocked(requireTeamAdmin).mockResolvedValue({ teamId: seed.teamId, memberId: seed.memberId });
    return { seed, admin: seed.memberId, launcher };
  }

  async function issuanceVisible(seed: Seed, memberId: string): Promise<ReadonlySet<string>> {
    const rows = await visibleProjectRows(db(), { teamId: seed.teamId, memberId });
    if (rows.error) throw new Error("fixture: visibleProjectRows failed");
    return rows.ids;
  }

  /** Q: an ingested item whose CURRENT membership is curated into Q only, and Q granted to L only. */
  async function launcherOnlyProjectWithContent(seed: Seed, launcher: string): Promise<{ q: string; path: string }> {
    const path = `q/launcher-only-${randomUUID().slice(0, 6)}.md`;
    const item = await ingest(seed, { path, body: `launcher-only ${randomUUID()}`, access: "team", project: `qproj-${randomUUID().slice(0, 6)}` });
    const { backfillTeamContext } = await import("@/lib/projects/context/backfill");
    const bf = await backfillTeamContext(db(), seed.teamId);
    if (!bf.ok) throw new Error(`backfill failed: ${bf.error}`);
    const { data: itemRow } = await db().from("items").select("project_id").eq("id", item.id).single();
    const q = (itemRow as { project_id: string }).project_id;
    const { data: unit } = await db().from("project_context_units").select("id").eq("source_item_id", item.id).single();
    await db().from("project_context_memberships").update({ valid_to: new Date().toISOString() }).eq("context_unit_id", unit!.id).is("valid_to", null);
    const { error } = await db().from("project_context_memberships").insert({ team_id: seed.teamId, project_id: q, context_unit_id: unit!.id, method: "manual" });
    if (error) throw new Error(`curate failed: ${error.message}`);
    await grantToMember(seed, q, launcher);
    return { q, path };
  }

  it("A sees P, L sees P and Q: projects [Q] is refused with the ADMIN-specific reason; explicit all-reachable mints NULL and reads Q as L", async () => {
    const { seed, admin, launcher } = await genuineAdminAndLauncher();
    const p = await grantedProject(seed, admin);
    await grantToMember(seed, p, launcher);
    const { q, path } = await launcherOnlyProjectWithContent(seed, launcher);

    // Issuance preconditions — the action's own predicate.
    const adminSet = await issuanceVisible(seed, admin);
    const launcherSet = await issuanceVisible(seed, launcher);
    expect(adminSet.has(p) && launcherSet.has(p), "precondition: both A and L can file into P").toBe(true);
    expect(adminSet.has(q), "precondition: Q is NOT issuance-visible to A").toBe(false);
    expect(launcherSet.has(q), "precondition: Q IS issuance-visible to L — so the launcher check alone would pass").toBe(true);

    // Selected mode: refused by the ADMIN subset check specifically. Because L does see Q, removing
    // only the admin branch would let this mint succeed — that is what makes this case non-vacuous.
    const tokensBefore = await tokenCount(seed.teamId);
    const auditsBefore = await mintAuditCount(seed.teamId);
    const refused = await mintAgentTokenAction("any-slug", {
      memberId: launcher,
      scope: { kind: "projects", projectIds: [q] },
      expiresAt: future(30),
    });
    expect(refused.error).toBe("scope.projectIds names project(s) you cannot see");
    await expectNoWrite(refused, seed.teamId, tokensBefore, auditsBefore);

    // All-reachable: no enumeration, no admin-visibility intersection — a deliberate dynamic choice.
    const minted = await mintAgentTokenAction("any-slug", { memberId: launcher, scope: ALL_REACHABLE, expiresAt: future(30) });
    expect(minted.ok, minted.error).toBe(true);
    expect(await storedScope(minted.tokenRowId!), "explicit all-reachable persists NULL").toBeNull();
    expect(await tokenCount(seed.teamId)).toBe(tokensBefore + 1);
    expect(await mintAuditCount(seed.teamId)).toBe(auditsBefore + 1);

    // READ outcome (distinct from the issuance predicate): the oracle and the real route.
    const readAsL = await effectiveVisibleProjects(db(), { teamId: seed.teamId, memberId: launcher, onBehalfOf: null, projectScope: null });
    const readAsA = await effectiveVisibleProjects(db(), { teamId: seed.teamId, memberId: admin, onBehalfOf: null, projectScope: null });
    expect(readAsL.has(q), "the read oracle serves Q to L").toBe(true);
    expect(readAsA.has(q), "A has no direct content reach into Q").toBe(false);
    const res = await itemsGET(
      new Request("http://test/api/v1/items", { headers: { authorization: `Bearer ${minted.token!}` } }) as unknown as NextRequest
    );
    expect(res.status).toBe(200);
    const paths = ((await res.json()).items as { path: string }[]).map((i) => i.path);
    expect(paths.includes(path), "the all-reachable token reads Q's item under L's live authority").toBe(true);
  });

  it("converse — A sees P, L does not: projects [P] is refused with the LAUNCHER-specific reason and writes nothing", async () => {
    const { seed, admin, launcher } = await genuineAdminAndLauncher();
    const adminOnly = await grantedProject(seed, admin);

    const adminSet = await issuanceVisible(seed, admin);
    const launcherSet = await issuanceVisible(seed, launcher);
    expect(adminSet.has(adminOnly), "precondition: A can file into P").toBe(true);
    expect(launcherSet.has(adminOnly), "precondition: L cannot").toBe(false);

    const tokensBefore = await tokenCount(seed.teamId);
    const auditsBefore = await mintAuditCount(seed.teamId);
    const res = await mintAgentTokenAction("any-slug", {
      memberId: launcher,
      scope: { kind: "projects", projectIds: [adminOnly] },
      expiresAt: future(30),
    });
    expect(res.error, "must name the LAUNCHER, not the admin").toBe(
      "scope.projectIds names project(s) the launching member cannot see"
    );
    await expectNoWrite(res, seed.teamId, tokensBefore, auditsBefore);
  });

  it("both visible — A and L both see S: projects [S] mints and persists [S] (non-vacuity for the pair)", async () => {
    const { seed, admin, launcher } = await genuineAdminAndLauncher();
    const shared = await grantedProject(seed, admin);
    await grantToMember(seed, shared, launcher);

    const adminSet = await issuanceVisible(seed, admin);
    const launcherSet = await issuanceVisible(seed, launcher);
    expect(adminSet.has(shared) && launcherSet.has(shared), "precondition: both can file into S").toBe(true);

    const res = await mintAgentTokenAction("any-slug", {
      memberId: launcher,
      scope: { kind: "projects", projectIds: [shared] },
      expiresAt: future(30),
    });
    expect(res.ok, res.error).toBe(true);
    expect(await storedScope(res.tokenRowId!)).toEqual([shared]);
    const { data } = await db().from("audit_log").select("meta").eq("team_id", seed.teamId).eq("action", "access.token_minted").eq("target_id", res.tokenRowId!).single();
    const meta = (data as { meta: Record<string, unknown> }).meta;
    expect([meta.member_id, meta.scoped, meta.scope_size]).toEqual([launcher, true, 1]);
  });
});
