import { describe, expect, it, vi, beforeEach } from "vitest";
import { randomUUID } from "node:crypto";
import { db, seedTeam, type Seed } from "./helpers";

vi.mock("@/lib/auth/guard", () => ({ requireTeamAdmin: vi.fn() }));

import { requireTeamAdmin } from "@/lib/auth/guard";
import { mintAgentTokenAction } from "@/app/t/[team]/admin/agents/actions";
import { mintAgentToken, type MintArgs, type MintResult } from "@/lib/access/agent-tokens";
import type { MintRequest } from "@/lib/access/agent-token-policy";

/**
 * AUDITFIX-19 (AIO-1050) — a mint request that says NOTHING about scope must be refused, at BOTH
 * issuance boundaries: the guarded writer `mintAgentToken` and the public admin action
 * `mintAgentTokenAction`. Before this fix, omission silently became `project_scope = NULL` — a token
 * inheriting the launcher's entire live visibility — with no deliberate choice behind it.
 *
 * Spec-first (SPEC v2.2 AC-01/AC-02): the refusal is asserted to the OBSERVABLE outcome — no token,
 * no row id, unchanged `agent_tokens` count, unchanged successful `access.token_minted` audit count —
 * not just `ok === false`. Inputs are runtime-cast to the existing request types so the same file
 * exercises the unchanged and the fixed implementations.
 *
 * Non-vacuity: each boundary has an explicit `{ kind: "all-reachable" }` control on the SAME harness
 * (same seed, same launcher, same admin gate, same expiry). The pre-fix code ignores the unknown
 * `scope` field and mints; the fixed code accepts the deliberate choice and mints. Either way it
 * proves the fixture can really issue a credential, so a refusal in the omission case is the scope
 * rule — not a missing member, an auth gate, or a broken fixture.
 *
 * Bearer secrets never enter assertion output: outcomes are reduced to `hasToken` before any
 * `expect`, and failure messages carry only row ids, counts and persisted scope.
 */

const ACTION_SLUG = "auditfix19-slug";

async function seedMember(seed: Seed, kind: "human" | "agent"): Promise<string> {
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

/** The seeded human becomes a genuine team admin; the gate mock below then reports that identity. */
async function promoteToAdmin(seed: Seed): Promise<void> {
  const { error } = await db()
    .from("members")
    .update({ role: "admin" })
    .eq("team_id", seed.teamId)
    .eq("id", seed.memberId);
  if (error) throw new Error(`promote admin failed: ${error.message}`);
}

async function tokenCount(teamId: string): Promise<number> {
  const { data, error } = await db().from("agent_tokens").select("id").eq("team_id", teamId);
  if (error) throw new Error(`agent_tokens count failed: ${error.message}`);
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

type StoredRow = { project_scope: string[] | null; member_id: string; created_by: string | null };

async function storedRow(tokenRowId: string): Promise<StoredRow | null> {
  const { data, error } = await db()
    .from("agent_tokens")
    .select("project_scope, member_id, created_by")
    .eq("id", tokenRowId)
    .maybeSingle();
  if (error) throw new Error(`agent_tokens row read failed: ${error.message}`);
  return (data as StoredRow | null) ?? null;
}

type MintAudit = { member_id: string | null; meta: Record<string, unknown> };

async function mintAuditFor(teamId: string, tokenRowId: string): Promise<MintAudit[]> {
  const { data, error } = await db()
    .from("audit_log")
    .select("member_id, meta")
    .eq("team_id", teamId)
    .eq("action", "access.token_minted")
    .eq("target_id", tokenRowId);
  if (error) throw new Error(`audit_log row read failed: ${error.message}`);
  return (data ?? []) as MintAudit[];
}

function future(days: number): string {
  return new Date(Date.now() + days * 86_400_000).toISOString();
}

/** A secret-free view of a mint result: the bearer string is reduced to whether one came back. */
type Outcome = { ok: boolean; error: string | undefined; hasToken: boolean; tokenRowId: string | undefined };

function redact(res: MintResult): Outcome {
  return { ok: res.ok, error: res.error, hasToken: res.token !== undefined, tokenRowId: res.tokenRowId };
}

/**
 * Describe what an omitted-scope request actually did — counts and the persisted scope only, never
 * the token. This is the RED evidence against the pre-fix implementation.
 */
async function describeOmission(
  out: Outcome,
  tokens: [before: number, after: number],
  audits: [before: number, after: number]
): Promise<string> {
  const row = out.tokenRowId ? await storedRow(out.tokenRowId) : null;
  const persisted = row ? JSON.stringify(row.project_scope) : "no row";
  return (
    `omitted scope must be refused; observed ok=${out.ok} hasToken=${out.hasToken} ` +
    `tokenRowId=${out.tokenRowId ?? "none"} persisted project_scope=${persisted} ` +
    `agent_tokens ${tokens[0]}->${tokens[1]} access.token_minted ${audits[0]}->${audits[1]} ` +
    `error=${JSON.stringify(out.error)}`
  );
}

async function expectRefusedWithoutWrite(
  out: Outcome,
  teamId: string,
  tokensBefore: number,
  auditsBefore: number
): Promise<void> {
  const tokensAfter = await tokenCount(teamId);
  const auditsAfter = await mintAuditCount(teamId);
  const why = await describeOmission(out, [tokensBefore, tokensAfter], [auditsBefore, auditsAfter]);

  expect(out.ok, why).toBe(false);
  expect(out.hasToken, why).toBe(false);
  expect(out.tokenRowId, why).toBeUndefined();
  expect(tokensAfter, why).toBe(tokensBefore);
  expect(auditsAfter, why).toBe(auditsBefore);
  // A USEFUL refusal names the missing decision, and never carries credential material.
  expect(out.error ?? "", why).toMatch(/scope/i);
  expect(out.error ?? "", why).not.toMatch(/aiosd_/);
}

async function expectAllReachableMinted(
  out: Outcome,
  teamId: string,
  launcher: string,
  actor: string,
  tokensBefore: number,
  auditsBefore: number
): Promise<void> {
  const tokensAfter = await tokenCount(teamId);
  const auditsAfter = await mintAuditCount(teamId);
  const why =
    `explicit all-reachable control must mint on this harness; observed ok=${out.ok} ` +
    `hasToken=${out.hasToken} tokenRowId=${out.tokenRowId ?? "none"} ` +
    `agent_tokens ${tokensBefore}->${tokensAfter} access.token_minted ${auditsBefore}->${auditsAfter} ` +
    `error=${JSON.stringify(out.error)}`;

  expect(out.ok, why).toBe(true);
  expect(out.hasToken, why).toBe(true);
  expect(out.tokenRowId, why).toMatch(/^[0-9a-f-]{36}$/i);
  expect(tokensAfter, why).toBe(tokensBefore + 1);
  expect(auditsAfter, why).toBe(auditsBefore + 1);

  const row = await storedRow(out.tokenRowId!);
  expect(row, why).not.toBeNull();
  expect(row!.project_scope, "explicit all-reachable persists NULL (live inheritance), never []").toBeNull();
  expect(row!.member_id).toBe(launcher);
  expect(row!.created_by).toBe(actor);

  const minted = await mintAuditFor(teamId, out.tokenRowId!);
  expect(minted.length, why).toBe(1);
  expect(minted[0].member_id).toBe(actor);
  expect(minted[0].meta.member_id).toBe(launcher);
  expect(minted[0].meta.scoped).toBe(false);
  expect(minted[0].meta.scope_size ?? null).toBeNull();
  expect(JSON.stringify(minted[0].meta)).not.toMatch(/aiosd_/);
}

describe("AUDITFIX-19 — core mintAgentToken requires an explicit scope choice", () => {
  it("control: an explicit all-reachable choice mints a real NULL-scope credential + one mint audit", async () => {
    const seed = await seedTeam();
    const launcher = await seedMember(seed, "agent");

    const tokensBefore = await tokenCount(seed.teamId);
    const auditsBefore = await mintAuditCount(seed.teamId);
    const res = await mintAgentToken(
      db(),
      seed.teamId,
      { memberId: launcher, scope: { kind: "all-reachable" } } as unknown as MintArgs,
      seed.memberId
    );

    await expectAllReachableMinted(redact(res), seed.teamId, launcher, seed.memberId, tokensBefore, auditsBefore);
  });

  it("REFUSES an omitted scope: no token, no row id, no agent_tokens row, no access.token_minted audit", async () => {
    const seed = await seedTeam();
    const launcher = await seedMember(seed, "agent");

    const tokensBefore = await tokenCount(seed.teamId);
    const auditsBefore = await mintAuditCount(seed.teamId);
    const res = await mintAgentToken(
      db(),
      seed.teamId,
      { memberId: launcher } as unknown as MintArgs,
      seed.memberId
    );

    await expectRefusedWithoutWrite(redact(res), seed.teamId, tokensBefore, auditsBefore);
  });
});

describe("AUDITFIX-19 — public mintAgentTokenAction requires an explicit scope choice", () => {
  beforeEach(() => vi.mocked(requireTeamAdmin).mockReset());

  /** A genuine team admin minting for a distinct, eligible agent launcher with a bounded expiry. */
  async function adminHarness(): Promise<{ seed: Seed; launcher: string }> {
    const seed = await seedTeam();
    await promoteToAdmin(seed);
    const launcher = await seedMember(seed, "agent");
    vi.mocked(requireTeamAdmin).mockResolvedValue({ teamId: seed.teamId, memberId: seed.memberId });
    return { seed, launcher };
  }

  it("control: an authorized admin's explicit all-reachable request mints a real NULL-scope credential + one mint audit", async () => {
    const { seed, launcher } = await adminHarness();

    const tokensBefore = await tokenCount(seed.teamId);
    const auditsBefore = await mintAuditCount(seed.teamId);
    const res = await mintAgentTokenAction(ACTION_SLUG, {
      memberId: launcher,
      scope: { kind: "all-reachable" },
      name: "auditfix19 control",
      expiresAt: future(30),
    } as unknown as MintRequest);

    expect(vi.mocked(requireTeamAdmin)).toHaveBeenCalledWith(ACTION_SLUG);
    await expectAllReachableMinted(redact(res), seed.teamId, launcher, seed.memberId, tokensBefore, auditsBefore);
  });

  it("REFUSES an omitted scope from an authorized admin: no token, no row id, no agent_tokens row, no access.token_minted audit", async () => {
    const { seed, launcher } = await adminHarness();

    const tokensBefore = await tokenCount(seed.teamId);
    const auditsBefore = await mintAuditCount(seed.teamId);
    const res = await mintAgentTokenAction(ACTION_SLUG, {
      memberId: launcher,
      name: "auditfix19 omitted",
      expiresAt: future(30),
    } as unknown as MintRequest);

    // The gate genuinely admitted this caller — a refusal here is not "admins only".
    expect(vi.mocked(requireTeamAdmin)).toHaveBeenCalledWith(ACTION_SLUG);
    expect(res.error ?? "").not.toBe("admins only");
    await expectRefusedWithoutWrite(redact(res), seed.teamId, tokensBefore, auditsBefore);
  });
});
