import { describe, expect, it, vi, beforeEach } from "vitest";
import { randomUUID } from "node:crypto";
import { db, seedTeam, type Seed } from "./helpers";

vi.mock("@/lib/auth/guard", () => ({ requireTeamAdmin: vi.fn() }));

import { requireTeamAdmin } from "@/lib/auth/guard";
import { mintAgentTokenAction, revokeAgentTokenAction } from "@/app/t/[team]/admin/agents/actions";
import { verifyAgentToken } from "@/lib/access/agent-tokens";
import { addMemberToGroup, createGroup, grantProjectToGroup } from "@/lib/access/groups";

/**
 * AGENTUI-1 — the mint ACTION against real Postgres.
 *
 * The policy itself is unit-tested in `test/agent-token-policy.test.ts`. What this tier proves is
 * the OUTCOME the unit tier structurally cannot: that a refused request leaves NO ROW behind. A
 * policy that returns `{ok:false}` while the writer has already run would pass every unit test and
 * still mint the credential it claimed to refuse.
 */

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

/** A project plus a group grant making it visible to `memberId` — the realistic admin setup. */
async function grantedProject(seed: Seed, memberId: string): Promise<string> {
  const { data, error } = await db()
    .from("projects")
    .insert({ team_id: seed.teamId, slug: `p-${randomUUID().slice(0, 6)}` })
    .select("id")
    .single();
  if (error || !data) throw new Error(`seed project failed: ${error?.message}`);
  const g = await createGroup(db(), seed.teamId, `g-${randomUUID().slice(0, 6)}`, "g", seed.memberId);
  await addMemberToGroup(db(), seed.teamId, g.groupId!, memberId, seed.memberId);
  await grantProjectToGroup(db(), seed.teamId, data.id as string, g.groupId!, seed.memberId);
  return data.id as string;
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

describe("AGENTUI-1 — mintAgentTokenAction against real Postgres", () => {
  beforeEach(() => vi.mocked(requireTeamAdmin).mockReset());

  it("a legal request mints exactly one row, and the stored hash is not the returned token", async () => {
    const seed = await seedTeam();
    const agent = await seedMember(seed, "agent");
    vi.mocked(requireTeamAdmin).mockResolvedValue({ teamId: seed.teamId, memberId: agent });

    const before = await tokenCount(seed.teamId);
    const res = await mintAgentTokenAction("any-slug", {
      memberId: agent,
      name: "status agent",
      expiresAt: future(30),
    });

    expect(res.ok, res.error).toBe(true);
    expect(res.token).toMatch(/^aiosd_/);
    expect(await tokenCount(seed.teamId)).toBe(before + 1);

    const { data } = await db()
      .from("agent_tokens")
      .select("token_hash, project_scope, on_behalf_of, expires_at")
      .eq("id", res.tokenRowId!)
      .single();
    const row = data as { token_hash: string; project_scope: string[] | null; on_behalf_of: string | null };
    expect(row.token_hash).not.toBe(res.token);
    expect(row.project_scope, "omitted scope must persist as NULL (inherit), never []").toBeNull();
    expect(row.on_behalf_of).toBeNull();
  });

  /**
   * Each case asserts the ROW COUNT is unchanged. Asserting only `res.ok === false` would pass even
   * if the writer had run — which is the failure this tier exists to catch.
   */
  const REFUSED: [name: string, input: () => Record<string, unknown>, match: RegExp][] = [
    ["acting-as", () => ({ onBehalfOf: randomUUID(), expiresAt: future(30) }), /self-only/],
    ["absent expiry", () => ({}), /required/],
    ["null expiry", () => ({ expiresAt: null }), /required/],
    ["past expiry", () => ({ expiresAt: new Date(Date.now() - 1000).toISOString() }), /in the future/],
    ["expiry beyond the cap", () => ({ expiresAt: future(400) }), /365-day maximum/],
    ["empty project scope", () => ({ projectScope: [], expiresAt: future(30) }), /at least one project/],
  ];

  for (const [label, extra, match] of REFUSED) {
    it(`refuses ${label} AND writes no row`, async () => {
      const seed = await seedTeam();
      const agent = await seedMember(seed, "agent");
      vi.mocked(requireTeamAdmin).mockResolvedValue({ teamId: seed.teamId, memberId: agent });

      const before = await tokenCount(seed.teamId);
      const res = await mintAgentTokenAction("any-slug", { memberId: agent, ...extra() } as never);

      expect(res.ok).toBe(false);
      expect(res.error).toMatch(match);
      expect(await tokenCount(seed.teamId), "a refused mint must not write").toBe(before);
    });
  }

  it("a populated scope persists as the array it was given (distinguishable from NULL)", async () => {
    const seed = await seedTeam();
    const agent = await seedMember(seed, "agent");
    vi.mocked(requireTeamAdmin).mockResolvedValue({ teamId: seed.teamId, memberId: agent });

    const projectId = await grantedProject(seed, agent);

    const res = await mintAgentTokenAction("any-slug", {
      memberId: agent,
      projectScope: [projectId],
      expiresAt: future(30),
    });
    expect(res.ok, res.error).toBe(true);

    const { data } = await db().from("agent_tokens").select("project_scope").eq("id", res.tokenRowId!).single();
    expect((data as { project_scope: string[] }).project_scope).toEqual([projectId]);
  });

  /**
   * The property the commit claims: an admin cannot scope a token to a project they cannot see.
   * Enforced in the ACTION, not the picker — the picker is a web page and the action is a public
   * endpoint. Asserted in BOTH directions so it cannot pass by refusing everything.
   */
  it("REFUSES a scope naming a project the admin cannot see, and writes no row", async () => {
    const seed = await seedTeam();
    const agent = await seedMember(seed, "agent");
    vi.mocked(requireTeamAdmin).mockResolvedValue({ teamId: seed.teamId, memberId: agent });

    const unseen = await ungrantedProject(seed);
    const before = await tokenCount(seed.teamId);
    const res = await mintAgentTokenAction("any-slug", {
      memberId: agent,
      projectScope: [unseen],
      expiresAt: future(30),
    });

    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/cannot see/);
    expect(await tokenCount(seed.teamId), "a refused scope must not write").toBe(before);
  });

  /**
   * ADMIN and LAUNCHER are different identities, and the earlier test made them the same member —
   * which hid the distinction entirely (Codex diff review). The token reads AS the launcher, so a
   * project only the ADMIN can see would mint a scope that silently grants nothing.
   */
  it("REFUSES a project the admin can see but the LAUNCHING member cannot", async () => {
    const seed = await seedTeam();
    const adminM = await seedMember(seed, "human");
    const launcher = await seedMember(seed, "agent");
    vi.mocked(requireTeamAdmin).mockResolvedValue({ teamId: seed.teamId, memberId: adminM });

    // Granted to the ADMIN only — the launcher is in no group that reaches it.
    const adminOnly = await grantedProject(seed, adminM);

    const before = await tokenCount(seed.teamId);
    const res = await mintAgentTokenAction("any-slug", {
      memberId: launcher,
      projectScope: [adminOnly],
      expiresAt: future(30),
    });

    expect(res.ok).toBe(false);
    expect(res.error, "must name the LAUNCHER, not the admin").toMatch(/launching member cannot see/);
    expect(await tokenCount(seed.teamId)).toBe(before);
  });

  it("ACCEPTS a project BOTH the admin and the launcher can see (non-vacuity for the pair)", async () => {
    const seed = await seedTeam();
    const adminM = await seedMember(seed, "human");
    const launcher = await seedMember(seed, "agent");
    vi.mocked(requireTeamAdmin).mockResolvedValue({ teamId: seed.teamId, memberId: adminM });

    const shared = await grantedProject(seed, adminM);
    await grantProjectToGroup(
      db(),
      seed.teamId,
      shared,
      (await createGroup(db(), seed.teamId, `g2-${randomUUID().slice(0, 6)}`, "g2", seed.memberId)).groupId!,
      seed.memberId
    );
    // Put the launcher in a group that also reaches `shared`.
    const g = await createGroup(db(), seed.teamId, `g3-${randomUUID().slice(0, 6)}`, "g3", seed.memberId);
    await addMemberToGroup(db(), seed.teamId, g.groupId!, launcher, seed.memberId);
    await grantProjectToGroup(db(), seed.teamId, shared, g.groupId!, seed.memberId);

    const res = await mintAgentTokenAction("any-slug", {
      memberId: launcher,
      projectScope: [shared],
      expiresAt: future(30),
    });
    expect(res.ok, res.error).toBe(true);
  });

  it("a non-admin caller mints nothing (pins the action's own gate, not the gate's internals)", async () => {
    const seed = await seedTeam();
    const agent = await seedMember(seed, "agent");
    vi.mocked(requireTeamAdmin).mockResolvedValue(null);

    const before = await tokenCount(seed.teamId);
    const res = await mintAgentTokenAction("any-slug", { memberId: agent, expiresAt: future(30) });
    expect(res).toEqual({ ok: false, error: "admins only" });
    expect(await tokenCount(seed.teamId)).toBe(before);
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

    const res = await mintAgentTokenAction("any-slug", { memberId: agent, expiresAt: future(30) });
    expect(res.ok, res.error).toBe(true);
    expect(res.token, "the secret must survive a revalidation fault — it is shown exactly once").toMatch(/^aiosd_/);
    expect(await tokenCount(seed.teamId)).toBe(1);
  });

  it("revoke marks the row and verification then fails", async () => {
    const seed = await seedTeam();
    const agent = await seedMember(seed, "agent");
    vi.mocked(requireTeamAdmin).mockResolvedValue({ teamId: seed.teamId, memberId: agent });

    const minted = await mintAgentTokenAction("any-slug", { memberId: agent, expiresAt: future(30) });
    expect(minted.ok, minted.error).toBe(true);
    expect(await verifyAgentToken(db(), minted.token!)).not.toBeNull();

    const rev = await revokeAgentTokenAction("any-slug", minted.tokenRowId!);
    expect(rev.ok, rev.error).toBe(true);
    expect(await verifyAgentToken(db(), minted.token!)).toBeNull();
  });
});
