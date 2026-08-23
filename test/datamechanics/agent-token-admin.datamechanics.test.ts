import { describe, expect, it, vi, beforeEach } from "vitest";
import { randomUUID } from "node:crypto";
import { db, seedTeam, type Seed } from "./helpers";

vi.mock("@/lib/auth/guard", () => ({ requireTeamAdmin: vi.fn() }));

import { requireTeamAdmin } from "@/lib/auth/guard";
import { mintAgentTokenAction, revokeAgentTokenAction } from "@/app/t/[team]/admin/agents/actions";
import { verifyAgentToken } from "@/lib/access/agent-tokens";

/**
 * AGENTUI-1 — the mint ACTION against real Postgres.
 *
 * The policy itself is unit-tested in `test/agent-token-policy.test.ts`. What this tier proves is
 * the OUTCOME the unit tier structurally cannot: that a refused request leaves NO ROW behind. A
 * policy that returns `{ok:false}` while the writer has already run would pass every unit test and
 * still mint the credential it claimed to refuse.
 */

const ADMIN_CTX = { teamId: "", memberId: "" };

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

    const { data: proj } = await db()
      .from("projects")
      .insert({ team_id: seed.teamId, slug: `p-${randomUUID().slice(0, 6)}` })
      .select("id")
      .single();
    const projectId = (proj as { id: string }).id;

    const res = await mintAgentTokenAction("any-slug", {
      memberId: agent,
      projectScope: [projectId],
      expiresAt: future(30),
    });
    expect(res.ok, res.error).toBe(true);

    const { data } = await db().from("agent_tokens").select("project_scope").eq("id", res.tokenRowId!).single();
    expect((data as { project_scope: string[] }).project_scope).toEqual([projectId]);
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
    expect(await verifyAgentToken(db(), minted.token!, seed.teamId)).not.toBeNull();

    const rev = await revokeAgentTokenAction("any-slug", minted.tokenRowId!);
    expect(rev.ok, rev.error).toBe(true);
    expect(await verifyAgentToken(db(), minted.token!, seed.teamId)).toBeNull();
  });
});
