import { describe, expect, it, vi, beforeEach } from "vitest";
import { randomUUID } from "node:crypto";
import { db, seedTeam, type Seed } from "./helpers";

vi.mock("@/lib/auth/guard", () => ({ requireTeamAdmin: vi.fn() }));

import { requireTeamAdmin } from "@/lib/auth/guard";
import { mintAgentTokenAction } from "@/app/t/[team]/admin/agents/actions";
import { mintAgentToken, type MintArgs, type MintResult } from "@/lib/access/agent-tokens";
import type { MintRequest } from "@/lib/access/agent-token-policy";
import { MAX_PROJECT_SCOPE, SCOPE_ERRORS } from "@/lib/access/agent-token-scope";

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
 * Secret hygiene: no bearer, hash or raw error/audit string ever enters an assertion's received
 * value or failure message. Outcomes are reduced to booleans (`hasToken`, `errorLeaksCredential`) and
 * the refusal reason to the NAME of the expected rule it matched (`reasonKey`), so even an
 * unexpected leak cannot be printed by a failing test. Row reads never select `token_hash`.
 */

const ACTION_SLUG = "auditfix19-slug";
const ALL_REACHABLE = { kind: "all-reachable" } as const;

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

/** A bare project row with no grant and no content — visible to nobody. */
async function bareProject(seed: Seed): Promise<string> {
  const { data, error } = await db()
    .from("projects")
    .insert({ team_id: seed.teamId, slug: `b-${randomUUID().slice(0, 6)}` })
    .select("id")
    .single();
  if (error || !data) throw new Error(`seed project failed: ${error?.message}`);
  return data.id as string;
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

type StoredRow = {
  project_scope: string[] | null;
  member_id: string;
  on_behalf_of: string | null;
  created_by: string | null;
  name: string;
  expires_at: string | null;
};

async function storedRow(tokenRowId: string): Promise<StoredRow | null> {
  const { data, error } = await db()
    .from("agent_tokens")
    .select("project_scope, member_id, on_behalf_of, created_by, name, expires_at")
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
type Outcome = {
  ok: boolean;
  hasToken: boolean;
  tokenRowId: string | undefined;
  /** Name of the known refusal rule the error equals, or "none"/"other" — never the raw string. */
  reason: string;
  errorLeaksCredential: boolean;
};

const KNOWN_REASONS: Record<string, string> = {
  ...SCOPE_ERRORS,
  invalidRequest: "invalid request",
  adminsOnly: "admins only",
};

function reasonKey(error: string | undefined): string {
  if (error === undefined) return "none";
  const hit = Object.entries(KNOWN_REASONS).find(([, text]) => text === error);
  return hit ? hit[0] : "other";
}

function redact(res: MintResult): Outcome {
  return {
    ok: res.ok,
    hasToken: res.token !== undefined,
    tokenRowId: res.tokenRowId,
    reason: reasonKey(res.error),
    errorLeaksCredential: /aiosd_/.test(res.error ?? ""),
  };
}

/**
 * Describe what an omitted-scope request actually did — counts, the persisted scope and the NAME of
 * the matched refusal rule only; never the token and never the raw error string. This is the RED
 * evidence against the pre-fix implementation.
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
    `reason=${out.reason}`
  );
}

async function expectRefusedWithoutWrite(
  out: Outcome,
  teamId: string,
  tokensBefore: number,
  auditsBefore: number,
  expectedReason: keyof typeof KNOWN_REASONS = "required"
): Promise<void> {
  const tokensAfter = await tokenCount(teamId);
  const auditsAfter = await mintAuditCount(teamId);
  const why = await describeOmission(out, [tokensBefore, tokensAfter], [auditsBefore, auditsAfter]);

  expect(out.ok, why).toBe(false);
  expect(out.hasToken, why).toBe(false);
  expect(out.tokenRowId, why).toBeUndefined();
  expect(tokensAfter, why).toBe(tokensBefore);
  expect(auditsAfter, why).toBe(auditsBefore);
  // A USEFUL refusal names the rule it applied, and never carries credential material. Both are
  // compared as non-secret values (a rule name and a boolean), so a failure cannot print a bearer.
  expect(out.reason, why).toBe(expectedReason);
  expect(out.errorLeaksCredential, "credential material in a refusal error").toBe(false);
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
    `reason=${out.reason}`;

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
  expect(/aiosd_/.test(JSON.stringify(minted[0].meta)), "credential material in mint audit meta").toBe(false);
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
    expect(res.error === "admins only", "refusal must come from the scope rule, not the gate").toBe(false);
    await expectRefusedWithoutWrite(redact(res), seed.teamId, tokensBefore, auditsBefore);
  });
});

/**
 * AC-01 / AC-03 at BOTH boundaries — every malformed, ambiguous, inherited or legacy request is
 * refused for its own rule and writes nothing. `build(base)` receives the boundary's valid base
 * fields (launcher + expiry) and returns the request under test, so each case varies only its
 * subject. Whole-request null/primitive/array cases return the existing invalid-request refusal
 * instead of throwing during field capture.
 */
type Base = { memberId: string; expiresAt: string };
const BAD_REQUESTS: [label: string, build: (base: Base) => unknown, reason: keyof typeof KNOWN_REASONS][] = [
  ["whole request null", () => null, "invalidRequest"],
  ["whole request undefined", () => undefined, "invalidRequest"],
  ["whole request string", () => "all-reachable", "invalidRequest"],
  ["whole request number", () => 7, "invalidRequest"],
  ["whole request array", (b) => [{ ...b, scope: ALL_REACHABLE }], "invalidRequest"],
  ["omitted scope", (b) => ({ ...b }), "required"],
  ["own undefined scope", (b) => ({ ...b, scope: undefined }), "required"],
  ["null scope", (b) => ({ ...b, scope: null }), "required"],
  ["inherited scope", (b) => Object.assign(Object.create({ scope: ALL_REACHABLE }), b), "required"],
  ["legacy projectScope null (alone)", (b) => ({ ...b, projectScope: null }), "legacyKey"],
  ["legacy projectScope undefined beside a valid choice", (b) => ({ ...b, scope: ALL_REACHABLE, projectScope: undefined }), "legacyKey"],
  ["legacy projectScope null beside a valid choice", (b) => ({ ...b, scope: ALL_REACHABLE, projectScope: null }), "legacyKey"],
  ["legacy projectScope [] beside a valid choice", (b) => ({ ...b, scope: ALL_REACHABLE, projectScope: [] }), "legacyKey"],
  ["string scope", (b) => ({ ...b, scope: "all-reachable" }), "notObject"],
  ["array scope", (b) => ({ ...b, scope: [randomUUID()] }), "notObject"],
  ["empty object scope", (b) => ({ ...b, scope: {} }), "badKind"],
  ["unknown kind", (b) => ({ ...b, scope: { kind: "inherit" } }), "badKind"],
  ["inherited kind", (b) => ({ ...b, scope: Object.create(ALL_REACHABLE) }), "badKind"],
  ["all-reachable + projectIds", (b) => ({ ...b, scope: { kind: "all-reachable", projectIds: [randomUUID()] } }), "allReachableExtra"],
  ["projects + stray field", (b) => ({ ...b, scope: { kind: "projects", projectIds: [randomUUID()], extra: 1 } }), "projectsExtra"],
  ["projects without projectIds", (b) => ({ ...b, scope: { kind: "projects" } }), "projectIdsRequired"],
  ["non-array projectIds", (b) => ({ ...b, scope: { kind: "projects", projectIds: randomUUID() } }), "projectIdsNotArray"],
  ["empty projectIds", (b) => ({ ...b, scope: { kind: "projects", projectIds: [] } }), "projectIdsEmpty"],
  ["bad uuid", (b) => ({ ...b, scope: { kind: "projects", projectIds: ["not-a-uuid"] } }), "projectIdsNotUuids"],
  [
    "sparse projectIds (a hole beside a valid id)",
    (b) => {
      const ids: unknown[] = new Array(2);
      ids[1] = randomUUID();
      return { ...b, scope: { kind: "projects", projectIds: ids } };
    },
    "projectIdsNotUuids",
  ],
  ["present undefined id", (b) => ({ ...b, scope: { kind: "projects", projectIds: [randomUUID(), undefined] } }), "projectIdsNotUuids"],
  [
    "mixed-case duplicate",
    (b) => {
      const id = randomUUID();
      return { ...b, scope: { kind: "projects", projectIds: [id, id.toUpperCase()] } };
    },
    "projectIdsDuplicate",
  ],
  [
    `${MAX_PROJECT_SCOPE + 1} ids`,
    (b) => ({ ...b, scope: { kind: "projects", projectIds: Array.from({ length: MAX_PROJECT_SCOPE + 1 }, () => randomUUID()) } }),
    "projectIdsTooMany",
  ],
];

describe("AUDITFIX-19 AC-01/AC-03 — core writer refuses every malformed choice without writing", () => {
  for (const [label, build, reason] of BAD_REQUESTS) {
    it(`core refuses ${label} (${reason}) with no row and no mint audit`, async () => {
      const seed = await seedTeam();
      const launcher = await seedMember(seed, "agent");
      const tokensBefore = await tokenCount(seed.teamId);
      const auditsBefore = await mintAuditCount(seed.teamId);

      const res = await mintAgentToken(db(), seed.teamId, build({ memberId: launcher, expiresAt: future(30) }) as MintArgs, seed.memberId);

      await expectRefusedWithoutWrite(redact(res), seed.teamId, tokensBefore, auditsBefore, reason);
    });
  }

  it("core accepts a projects choice naming a project NOBODY can see — intersection-only authority, persisted canonical", async () => {
    // The core primitive is not the admin policy: an explicit list only ever NARROWS, so it need not
    // be currently visible. The public action applies its stricter subset checks (AC-05).
    const seed = await seedTeam();
    const launcher = await seedMember(seed, "agent");
    const p = await bareProject(seed);
    const res = await mintAgentToken(
      db(),
      seed.teamId,
      { memberId: launcher, scope: { kind: "projects", projectIds: [p.toUpperCase()] } },
      seed.memberId
    );
    const out = redact(res);
    expect(out.ok, `reason=${out.reason}`).toBe(true);
    const row = await storedRow(out.tokenRowId!);
    expect(row!.project_scope, "canonical lowercase copy of the chosen list").toEqual([p.toLowerCase()]);
    const audit = await mintAuditFor(seed.teamId, out.tokenRowId!);
    expect([audit.length, audit[0].meta.scoped, audit[0].meta.scope_size]).toEqual([1, true, 1]);
  });

  it("core keeps its eligibility refusals with a VALID scope (non-vacuous: the refusal is the leg rule)", async () => {
    const seed = await seedTeam();
    const tokensBefore = await tokenCount(seed.teamId);
    const res = await mintAgentToken(db(), seed.teamId, { memberId: randomUUID(), scope: ALL_REACHABLE }, seed.memberId);
    expect(res.ok).toBe(false);
    expect(res.error === "launching member not found", "the launcher-leg rule refused").toBe(true);
    expect(await tokenCount(seed.teamId)).toBe(tokensBefore);
  });
});

/**
 * AC-04 — the core captures its request BEFORE its first await. The test mutates the caller's
 * ORIGINAL object synchronously right after starting the mint (i.e. while the first member read is
 * pending), using a valid, fully eligible request. If the writer re-read any field after that await,
 * the row or the audit would show the mutated value.
 */
describe("AUDITFIX-19 AC-04 — core mint consumes its captured snapshot across awaits", () => {
  it("mutating launcher, acting-as, name, expiry and scope during the pending member read changes nothing persisted or audited", async () => {
    const seed = await seedTeam();
    const launcher = await seedMember(seed, "agent");
    const represented = await seedMember(seed, "human");
    const otherLauncher = await seedMember(seed, "agent");
    const otherRepresented = await seedMember(seed, "human");
    const p = await bareProject(seed);
    const q = await bareProject(seed);
    const expiresAt = future(20);

    const args = {
      memberId: launcher,
      onBehalfOf: represented as string | null,
      name: "original name",
      expiresAt,
      scope: { kind: "projects", projectIds: [p] } as { kind: string; projectIds: string[] },
    };
    const pending = mintAgentToken(db(), seed.teamId, args as unknown as MintArgs, seed.memberId);
    // Synchronous mutation — the mint is suspended at its first member read.
    args.memberId = otherLauncher;
    args.onBehalfOf = otherRepresented;
    args.name = "mutated name";
    args.expiresAt = future(300);
    args.scope.projectIds[0] = q;
    args.scope.projectIds.push(p);
    args.scope.kind = "all-reachable";
    (args as Record<string, unknown>).projectScope = [];
    const out = redact(await pending);

    expect(out.ok, `reason=${out.reason}`).toBe(true);
    const row = await storedRow(out.tokenRowId!);
    expect(row!.member_id, "the captured launcher is stored").toBe(launcher);
    expect(row!.on_behalf_of, "the captured acting-as leg is stored").toBe(represented);
    expect(row!.name).toBe("original name");
    expect(Date.parse(row!.expires_at!)).toBe(Date.parse(expiresAt));
    expect(row!.project_scope, "the originally validated [P] is stored").toEqual([p]);

    const audit = await mintAuditFor(seed.teamId, out.tokenRowId!);
    expect(audit.length).toBe(1);
    expect(audit[0].meta.member_id, "audit launcher leg agrees with the row").toBe(row!.member_id);
    expect(audit[0].meta.on_behalf_of, "audit acting-as leg agrees with the row").toBe(row!.on_behalf_of);
    expect([audit[0].meta.scoped, audit[0].meta.scope_size]).toEqual([true, 1]);
  });
});

describe("AUDITFIX-19 AC-02/AC-03 — public action refuses every malformed choice without writing", () => {
  beforeEach(() => vi.mocked(requireTeamAdmin).mockReset());

  for (const [label, build, reason] of BAD_REQUESTS) {
    it(`action refuses ${label} (${reason}) after the admin gate, with no row and no mint audit`, async () => {
      const seed = await seedTeam();
      await promoteToAdmin(seed);
      const launcher = await seedMember(seed, "agent");
      vi.mocked(requireTeamAdmin).mockResolvedValue({ teamId: seed.teamId, memberId: seed.memberId });
      const tokensBefore = await tokenCount(seed.teamId);
      const auditsBefore = await mintAuditCount(seed.teamId);

      const res = await mintAgentTokenAction(ACTION_SLUG, build({ memberId: launcher, expiresAt: future(30) }) as MintRequest);

      expect(vi.mocked(requireTeamAdmin)).toHaveBeenCalledWith(ACTION_SLUG);
      await expectRefusedWithoutWrite(redact(res), seed.teamId, tokensBefore, auditsBefore, reason);
    });
  }
});
