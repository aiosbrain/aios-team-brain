import { describe, expect, it, vi, beforeEach } from "vitest";
import { randomUUID } from "node:crypto";
import { db, seedTeam, type Seed } from "./helpers";

vi.mock("@/lib/auth/guard", () => ({ requireTeamAdmin: vi.fn() }));

import { requireTeamAdmin } from "@/lib/auth/guard";
import { mintAgentTokenAction } from "@/app/t/[team]/admin/agents/actions";
import { mintAgentToken, type MintArgs, type MintResult } from "@/lib/access/agent-tokens";
import type { MintRequest } from "@/lib/access/agent-token-policy";
import { MAX_PROJECT_SCOPE, SCOPE_ERRORS } from "@/lib/access/agent-token-scope";
import type { DbClient } from "@/lib/db/types";

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

/**
 * Code review S1/S2 — adversarial IN-PROCESS objects (a browser cannot serialize these into a server
 * action; both boundaries nonetheless promise a refusal for untrusted runtime input).
 *
 * S1: a proxy over an array passes `Array.isArray` while its `length` trap answers "0". Before the fix
 * the parser returned a VALID EMPTY list and the core stored a live `project_scope = []` credential
 * plus a mint audit (reproduced on real Postgres by the coordinator). A hole the prototype answers
 * for is likewise not an explicit element.
 * S2: a throwing getter or proxy trap made both boundaries REJECT instead of resolving a refusal.
 *
 * Every case must resolve (never reject) to its rule's refusal with no token, no row id, no row and
 * no mint audit. The thrown text is a sentinel the refusal must never carry: refusals are compared by
 * rule NAME, so an echoed sentinel would surface as reason "other".
 */
const S2_SENTINEL = "S2_SENTINEL_THROWN_TEXT";
function boom(): never {
  throw new Error(S2_SENTINEL);
}

function lengthLiar(length: unknown, target: unknown[]): unknown[] {
  return new Proxy(target, {
    get: (t, key, recv) => (key === "length" ? length : Reflect.get(t, key, recv)),
  });
}

function withThrowingField(b: Base, field: "memberId" | "onBehalfOf" | "name" | "expiresAt"): unknown {
  const req: Record<string, unknown> = { ...b, scope: ALL_REACHABLE };
  delete req[field];
  return Object.defineProperty(req, field, { enumerable: true, get: boom });
}

const MALFORMED_OBJECTS: [label: string, build: (base: Base) => unknown, reason: keyof typeof KNOWN_REASONS][] = [
  ['proxied length "0" over an empty array (S1 reproduction)', (b) => ({ ...b, scope: { kind: "projects", projectIds: lengthLiar("0", []) } }), "projectIdsNotArray"],
  ['proxied length "1" over a one-id array', (b) => ({ ...b, scope: { kind: "projects", projectIds: lengthLiar("1", [randomUUID()]) } }), "projectIdsNotArray"],
  ["proxied length NaN", (b) => ({ ...b, scope: { kind: "projects", projectIds: lengthLiar(NaN, [randomUUID()]) } }), "projectIdsNotArray"],
  ["proxied length -1", (b) => ({ ...b, scope: { kind: "projects", projectIds: lengthLiar(-1, [randomUUID()]) } }), "projectIdsNotArray"],
  ["proxied length 1.5", (b) => ({ ...b, scope: { kind: "projects", projectIds: lengthLiar(1.5, [randomUUID()]) } }), "projectIdsNotArray"],
  [
    "a hole the prototype answers for with a valid distinct id",
    (b) => {
      const ids: unknown[] = new Array(2);
      ids[0] = randomUUID();
      Object.setPrototypeOf(ids, Object.assign(Object.create(Array.prototype), { 1: randomUUID() }));
      return { ...b, scope: { kind: "projects", projectIds: ids } };
    },
    "projectIdsNotUuids",
  ],
  [
    "a revoked whole-request proxy",
    (b) => {
      const r = Proxy.revocable({ ...b, scope: ALL_REACHABLE }, {});
      r.revoke();
      return r.proxy;
    },
    "invalidRequest",
  ],
  ["a throwing scope getter (S2 reproduction)", (b) => ({ ...b, get scope() { return boom(); } }), "invalidRequest"],
  ["a throwing kind getter", (b) => ({ ...b, scope: { get kind() { return boom(); } } }), "invalidRequest"],
  ["a scope proxy whose ownKeys trap throws", (b) => ({ ...b, scope: new Proxy({ kind: "all-reachable" }, { ownKeys: boom }) }), "invalidRequest"],
  ["a throwing projectIds getter", (b) => ({ ...b, scope: { kind: "projects", get projectIds() { return boom(); } } }), "invalidRequest"],
  [
    "a throwing length trap",
    (b) => ({ ...b, scope: { kind: "projects", projectIds: new Proxy([randomUUID()], { get: (t, k, r) => (k === "length" ? boom() : Reflect.get(t, k, r)) }) } }),
    "invalidRequest",
  ],
  [
    "a throwing index getter",
    (b) => {
      const ids: unknown[] = [];
      Object.defineProperty(ids, 0, { enumerable: true, get: boom });
      return { ...b, scope: { kind: "projects", projectIds: ids } };
    },
    "invalidRequest",
  ],
  ["a throwing memberId getter", (b) => withThrowingField(b, "memberId"), "invalidRequest"],
  ["a throwing onBehalfOf getter", (b) => withThrowingField(b, "onBehalfOf"), "invalidRequest"],
  ["a throwing name getter", (b) => withThrowingField(b, "name"), "invalidRequest"],
  ["a throwing expiresAt getter", (b) => withThrowingField(b, "expiresAt"), "invalidRequest"],
];

/** Await a boundary call, reducing a rejection to a boolean so a thrown value is never printed. */
async function settle(call: () => Promise<MintResult>): Promise<{ rejected: boolean; out: Outcome | null }> {
  try {
    return { rejected: false, out: redact(await call()) };
  } catch {
    return { rejected: true, out: null };
  }
}

/** A real client whose `.from()` calls are counted — proves a refusal happened before any DB read. */
function countingDb(): { client: DbClient; fromCalls: () => number } {
  const real = db();
  let calls = 0;
  const client = new Proxy(real, {
    get(t, key, recv) {
      if (key !== "from") return Reflect.get(t, key, recv);
      return (...args: Parameters<DbClient["from"]>) => {
        calls += 1;
        return t.from(...args);
      };
    },
  });
  return { client, fromCalls: () => calls };
}

describe("AUDITFIX-19 review S1/S2 — core writer refuses malformed runtime objects, resolving, before any DB read", () => {
  for (const [label, build, reason] of MALFORMED_OBJECTS) {
    it(`core refuses ${label} (${reason}) with no row and no mint audit`, async () => {
      const seed = await seedTeam();
      const launcher = await seedMember(seed, "agent");
      const tokensBefore = await tokenCount(seed.teamId);
      const auditsBefore = await mintAuditCount(seed.teamId);
      const { client, fromCalls } = countingDb();

      const settled = await settle(() =>
        mintAgentToken(client, seed.teamId, build({ memberId: launcher, expiresAt: future(30) }) as MintArgs, seed.memberId)
      );

      expect(settled.rejected, "the core must resolve a refusal, not reject").toBe(false);
      expect(fromCalls(), "refused before the first member read").toBe(0);
      await expectRefusedWithoutWrite(settled.out!, seed.teamId, tokensBefore, auditsBefore, reason);
    });
  }

  it("control: a LEGITIMATE proxied list with an honest length mints the canonical list on the same harness", async () => {
    const seed = await seedTeam();
    const launcher = await seedMember(seed, "agent");
    const p = await bareProject(seed);
    let lengthReads = 0;
    const ids = new Proxy([p.toUpperCase()], {
      get(t, key, recv) {
        if (key === "length") lengthReads += 1;
        return Reflect.get(t, key, recv);
      },
    });

    const out = redact(await mintAgentToken(db(), seed.teamId, { memberId: launcher, scope: { kind: "projects", projectIds: ids } }, seed.memberId));

    expect(out.ok, `reason=${out.reason}`).toBe(true);
    expect(lengthReads, "length read once").toBe(1);
    expect((await storedRow(out.tokenRowId!))!.project_scope).toEqual([p.toLowerCase()]);
    const audit = await mintAuditFor(seed.teamId, out.tokenRowId!);
    expect([audit.length, audit[0].meta.scoped, audit[0].meta.scope_size]).toEqual([1, true, 1]);
  });
});

describe("AUDITFIX-19 review S1/S2 — public action refuses malformed runtime objects after its gate, resolving", () => {
  beforeEach(() => vi.mocked(requireTeamAdmin).mockReset());

  for (const [label, build, reason] of MALFORMED_OBJECTS) {
    it(`action refuses ${label} (${reason}) with no row and no mint audit`, async () => {
      const seed = await seedTeam();
      await promoteToAdmin(seed);
      const launcher = await seedMember(seed, "agent");
      vi.mocked(requireTeamAdmin).mockResolvedValue({ teamId: seed.teamId, memberId: seed.memberId });
      const tokensBefore = await tokenCount(seed.teamId);
      const auditsBefore = await mintAuditCount(seed.teamId);

      const settled = await settle(() =>
        mintAgentTokenAction(ACTION_SLUG, build({ memberId: launcher, expiresAt: future(30) }) as MintRequest)
      );

      expect(settled.rejected, "the action must resolve a refusal, not reject").toBe(false);
      expect(vi.mocked(requireTeamAdmin)).toHaveBeenCalledWith(ACTION_SLUG);
      await expectRefusedWithoutWrite(settled.out!, seed.teamId, tokensBefore, auditsBefore, reason);
    });
  }

  it("an UNAUTHORIZED caller is refused at the gate without a single read of the request's getters", async () => {
    const seed = await seedTeam();
    vi.mocked(requireTeamAdmin).mockResolvedValue(null);
    let reads = 0;
    const touch = (): never => {
      reads += 1;
      return boom();
    };
    const req = Object.defineProperties({} as Record<string, unknown>, {
      memberId: { enumerable: true, get: touch },
      scope: { enumerable: true, get: touch },
      expiresAt: { enumerable: true, get: touch },
    });
    const tokensBefore = await tokenCount(seed.teamId);
    const auditsBefore = await mintAuditCount(seed.teamId);

    const settled = await settle(() => mintAgentTokenAction(ACTION_SLUG, req as unknown as MintRequest));

    expect(settled.rejected).toBe(false);
    expect(reads, "authorization runs before any field of the request is read").toBe(0);
    await expectRefusedWithoutWrite(settled.out!, seed.teamId, tokensBefore, auditsBefore, "adminsOnly");
  });

  it("control: non-throwing getters are read ONCE and their first values mint on the same harness", async () => {
    const seed = await seedTeam();
    await promoteToAdmin(seed);
    const launcher = await seedMember(seed, "agent");
    vi.mocked(requireTeamAdmin).mockResolvedValue({ teamId: seed.teamId, memberId: seed.memberId });
    const otherLauncher = await seedMember(seed, "agent");
    const expiresAt = future(30);
    const reads: Record<string, number> = {};
    const once = (key: string, first: unknown, later: unknown) => () => {
      reads[key] = (reads[key] ?? 0) + 1;
      return reads[key] === 1 ? first : later;
    };
    const req = Object.defineProperties({} as Record<string, unknown>, {
      memberId: { enumerable: true, get: once("memberId", launcher, otherLauncher) },
      name: { enumerable: true, get: once("name", "getter control", "later") },
      expiresAt: { enumerable: true, get: once("expiresAt", expiresAt, future(300)) },
      scope: { enumerable: true, get: once("scope", { kind: "all-reachable" }, { kind: "projects", projectIds: [randomUUID()] }) },
    });
    const tokensBefore = await tokenCount(seed.teamId);
    const auditsBefore = await mintAuditCount(seed.teamId);

    const out = redact(await mintAgentTokenAction(ACTION_SLUG, req as unknown as MintRequest));

    await expectAllReachableMinted(out, seed.teamId, launcher, seed.memberId, tokensBefore, auditsBefore);
    expect(reads).toEqual({ memberId: 1, name: 1, expiresAt: 1, scope: 1 });
    const row = await storedRow(out.tokenRowId!);
    expect([row!.name, Date.parse(row!.expires_at!)]).toEqual(["getter control", Date.parse(expiresAt)]);
  });
});
