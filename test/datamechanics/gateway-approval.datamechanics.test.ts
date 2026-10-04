import { createHash, randomBytes, randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { POST as createPolicyRoute } from "@/app/api/internal/executor-gateway/v1/admin/[teamSlug]/policies/route";
import { getSessionUser } from "@/lib/auth/session";
import { PgClient, pgClient } from "@/lib/db/pg/client";
import { getPool } from "@/lib/db/pg/pool";
import type { SqlExecutor } from "@/lib/db/types";
import { gatewayAdminContext } from "@/lib/gateway/admin-http";
import { canonicalize } from "@/lib/gateway/canonical";
import {
  authorizeGatewayAdmin,
  createGatewayAdminPolicy,
  deleteGatewayAdminPolicy,
  decideGatewayApproval,
  GatewayAdminError,
  listGatewayCredentials,
  listGatewayApprovals,
  listGatewayAdminPolicies,
  revokeGatewayCredential,
  rotateGatewayCredential,
  updateGatewayAdminPolicy,
} from "@/lib/gateway/admin-persistence";
import { encryptGatewayRequestEnvelope } from "@/lib/gateway/envelope";
import {
  authenticateGatewayServiceCredential,
  authorizeLeaseAndCreateExecution,
  failGatewayCredentialSealing,
  issueResolutionLease,
  resumeClaimGatewayExecution,
} from "@/lib/gateway/persistence";
import { gatewayScope, seedGateway, type GatewaySeed } from "./gateway-helpers";
import { db, placeMemberByTier } from "./helpers";
import { createPolicy, listAllPolicies, updatePolicy } from "@/lib/policy/manage";

// The request-level arms below need "who is signed in" without a request scope. Only the session
// identity is stubbed; the authority (team, member, Everyone posture) is real Postgres throughout.
vi.mock("@/lib/auth/session", () => ({ getSessionUser: vi.fn() }));

const KEY = Buffer.alloc(32, 19);
const REQUEST_HASH = "4b18a1b9c0f093f7e46b4410e245fd88f011e6d820b34ef9446296ff9386f310";

async function approvedExecution(options: {
  approve?: boolean;
  approvalTtlMilliseconds?: number;
} = {}) {
  const seed = await seedGateway();
  await getPool().query(
    `update members set role='admin' where id=$1 and team_id=$2`,
    [seed.memberId, seed.teamId],
  );
  await getPool().query(
    `insert into policies(team_id,action,resource,effect,priority)
     values($1,'gateway.aios-github-readonly.github.repository.get',
       'github.repository:octo/project','require_approval',10)`,
    [seed.teamId],
  );
  const lease = await issueResolutionLease({
    ...gatewayScope(seed),
    connectionRef: seed.connectionRef,
    audience: "aios-github-readonly",
    correlationId: randomUUID(),
  });
  const executionId = randomUUID();
  const decision = await authorizeLeaseAndCreateExecution({
    serviceIdentityId: seed.serviceIdentityId,
    executionId,
    lease: lease.lease,
    audience: "aios-github-readonly",
    toolkit: "aios-github-readonly",
    tool: "github.repository.get",
    normalizedArgs: { owner: "octo", repo: "project" },
    requestHash: REQUEST_HASH,
    correlationId: randomUUID(),
    idempotencyKey: randomUUID(),
    requestEnvelope: encryptGatewayRequestEnvelope(
      { owner: "octo", repo: "project" },
      { executionId, serviceIdentityId: seed.serviceIdentityId },
      KEY,
    ),
    approvalTtlMilliseconds: options.approvalTtlMilliseconds,
  });
  if (decision.decision !== "require_approval")
    throw new Error("expected approval");
  const ctx = {
    teamId: seed.teamId,
    teamSlug: seed.teamSlug,
    memberId: seed.memberId,
  };
  if (options.approve !== false) {
    await decideGatewayApproval(
      ctx,
      decision.approvalId,
      "approve",
      randomUUID(),
    );
  }
  const service = await authenticateGatewayServiceCredential(
    `Bearer aios_gw_${seed.credentialId}_${seed.credentialSecret}`,
  );
  return { seed, ctx, service, executionId, approvalId: decision.approvalId };
}

const claimInput = (
  seed: GatewaySeed,
  executionId: string,
  service: Awaited<ReturnType<typeof authenticateGatewayServiceCredential>>,
  idempotencyKey: string,
  onPayload: () => void,
) => ({
  service,
  executionId,
  executorTenantId: seed.executorTenantId,
  executorSubjectId: seed.executorSubjectId,
  toolkit: "aios-github-readonly",
  tool: "github.repository.get",
  requestHash: REQUEST_HASH,
  correlationId: randomUUID(),
  idempotencyKey,
  useWinningPayload: async (payload: { encryptedRequestEnvelope: Buffer }) => {
    onPayload();
    expect(payload.encryptedRequestEnvelope.length).toBeGreaterThan(0);
    return "credential-bearing-response";
  },
});

// ---------------------------------------------------------------------------------------------
// AIO-1208 — browser gateway-admin authority (docs/design/aio1208-route-auth-inventory.md).
// Authority is role ∧ POSTURE, where posture is the member's row in the team's builtin `everyone`
// group. `members.tier` is the invite-default record: every arm below writes it deliberately so a
// stale record on EITHER side of the membership is observable, and reads the state back.
// ---------------------------------------------------------------------------------------------

type AuthorityFixture = {
  role?: "admin" | "lead" | "member";
  /** The legacy record. Never an authority input. */
  tier?: "team" | "external";
  status?: "active" | "disabled" | "invited";
  /** Whether the member holds the builtin Everyone membership. */
  everyone?: boolean;
};

const SCOPE_NOT_FOUND = { code: "gateway_scope_not_found", status: 422 } as const;
const FORBIDDEN = { code: "gateway_forbidden", status: 403 } as const;
const NOT_FOUND = { code: "gateway_not_found", status: 404 } as const;

async function removeEveryoneMembership(seed: { teamId: string; memberId: string }) {
  const removed = await getPool().query(
    `delete from group_members gm using groups g
      where g.team_id=gm.team_id and g.id=gm.group_id
        and g.slug='everyone' and g.is_builtin
        and gm.team_id=$1 and gm.member_id=$2`,
    [seed.teamId, seed.memberId],
  );
  expect(removed.rowCount).toBe(1);
}

/** Bind the seeded member to a fresh auth user and put it in exactly the requested authority state. */
async function authorityFixture(seed: GatewaySeed, fixture: AuthorityFixture = {}) {
  const authUserId = randomUUID();
  await getPool().query(`insert into auth_users(id,email) values($1,$2)`, [
    authUserId,
    `${randomUUID()}@test.local`,
  ]);
  await getPool().query(
    `update members set auth_user_id=$1,role=$2,tier=$3,status=$4 where id=$5 and team_id=$6`,
    [
      authUserId,
      fixture.role ?? "admin",
      fixture.tier ?? "team",
      fixture.status ?? "active",
      seed.memberId,
      seed.teamId,
    ],
  );
  if (fixture.everyone === false) await removeEveryoneMembership(seed);
  return authUserId;
}

async function authorityState(seed: { teamId: string; memberId: string }) {
  const state = await getPool().query(
    `select m.role::text,m.tier::text,m.status::text,
       (select count(*)::int from group_members gm
          join groups g on g.team_id=gm.team_id and g.id=gm.group_id
         where gm.team_id=m.team_id and gm.member_id=m.id
           and g.slug='everyone' and g.is_builtin) everyone_rows
     from members m where m.id=$1 and m.team_id=$2`,
    [seed.memberId, seed.teamId],
  );
  return state.rows[0] as { role: string; tier: string; status: string; everyone_rows: number };
}

const boundTable = (sql: string) =>
  /\bfrom\s+group_members\b/i.test(sql)
    ? "group_members"
    : /\bfrom\s+members\b/i.test(sql)
      ? "members"
      : /\bfrom\s+teams\b/i.test(sql)
        ? "teams"
        : "other";

const INJECTED_POSTURE_FAULT = "injected bound posture failure";

/**
 * A real PgClient whose transaction-session executor is instrumented: every bound statement is
 * recorded with the backend pid and transaction timestamp it ran under, and — when asked — ONLY
 * the bound `group_members` read is failed. A read that bypasses the session never reaches this
 * decorator, so it would neither be recorded nor fault.
 */
function observedClient(options: { failPosture?: boolean } = {}) {
  const statements: Array<{ table: string; pid: number; tx: string }> = [];
  const decorate = (executor: SqlExecutor): SqlExecutor =>
    async <T>(text: string, params?: unknown[]) => {
      const where = await executor<{ pid: number; tx: string }>(
        `select pg_backend_pid() pid, transaction_timestamp()::text tx`,
      );
      const table = boundTable(text);
      statements.push({ table, ...where.rows[0] });
      if (options.failPosture && table === "group_members") throw new Error(INJECTED_POSTURE_FAULT);
      return executor<T>(text, params);
    };
  return { client: new PgClient({ decorateSessionExecutor: decorate }), statements };
}

/** The authority reads (if any) that went through the process pool instead of a bound session. */
async function unboundAuthorityReads(run: () => Promise<unknown>): Promise<string[]> {
  const poolQuery = vi.spyOn(getPool(), "query");
  try {
    await run();
    return poolQuery.mock.calls
      .map(([first]) => (typeof first === "string" ? first : String((first as { text?: unknown })?.text ?? "")))
      .map(boundTable)
      .filter((table) => table !== "other");
  } finally {
    poolQuery.mockRestore();
  }
}

const policyRequest = (teamSlug: string) =>
  new Request(`http://local/api/internal/executor-gateway/v1/admin/${teamSlug}/policies`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      subject: { type: "team" },
      tool: "github.repository.get",
      resource: "github.repository:octo/project",
      effect: "require_approval",
      priority: 5,
      enabled: true,
      correlationId: randomUUID(),
    }),
  });

const gatewayPolicyRows = async (teamId: string) =>
  (
    await getPool().query<{ policies: number; audits: number }>(
      `select
         (select count(*)::int from policies where team_id=$1
            and action like 'gateway.aios-github-readonly.%') policies,
         (select count(*)::int from gateway_audit_log where team_id=$1
            and event='policy_created') audits`,
      [teamId],
    )
  ).rows[0];

describe("gateway admin authority follows Everyone membership (AIO-1208)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    vi.mocked(getSessionUser).mockReset();
  });

  const ARMS: Array<{
    name: string;
    fixture: AuthorityFixture;
    outcome: "admitted" | typeof SCOPE_NOT_FOUND | typeof FORBIDDEN;
  }> = [
    { name: "active admin · Everyone · legacy tier team", fixture: {}, outcome: "admitted" },
    { name: "active admin · Everyone · STALE legacy tier external", fixture: { tier: "external" }, outcome: "admitted" },
    { name: "active admin · no Everyone · STALE legacy tier team", fixture: { everyone: false }, outcome: SCOPE_NOT_FOUND },
    { name: "active admin · no Everyone · legacy tier external", fixture: { tier: "external", everyone: false }, outcome: SCOPE_NOT_FOUND },
    { name: "active member · Everyone", fixture: { role: "member" }, outcome: FORBIDDEN },
    { name: "active lead · Everyone", fixture: { role: "lead" }, outcome: FORBIDDEN },
    { name: "active member · no Everyone (422 precedes 403)", fixture: { role: "member", everyone: false }, outcome: SCOPE_NOT_FOUND },
    { name: "active lead · no Everyone (422 precedes 403)", fixture: { role: "lead", everyone: false }, outcome: SCOPE_NOT_FOUND },
    { name: "disabled admin · Everyone", fixture: { status: "disabled" }, outcome: SCOPE_NOT_FOUND },
    { name: "invited admin · Everyone", fixture: { status: "invited" }, outcome: SCOPE_NOT_FOUND },
    { name: "disabled member · Everyone (inactive precedes role)", fixture: { role: "member", status: "disabled" }, outcome: SCOPE_NOT_FOUND },
  ];

  it.each(ARMS)("$name → $outcome", async ({ fixture, outcome }) => {
    const seed = await seedGateway();
    const authUserId = await authorityFixture(seed, fixture);
    // The arm's premise, read back: the record and the membership really are in this state.
    expect(await authorityState(seed)).toEqual({
      role: fixture.role ?? "admin",
      tier: fixture.tier ?? "team",
      status: fixture.status ?? "active",
      everyone_rows: fixture.everyone === false ? 0 : 1,
    });
    const verdict = authorizeGatewayAdmin(seed.teamSlug, authUserId);
    if (outcome === "admitted")
      await expect(verdict).resolves.toEqual({
        teamId: seed.teamId,
        teamSlug: seed.teamSlug,
        memberId: seed.memberId,
      });
    else await expect(verdict).rejects.toMatchObject(outcome);
  });

  it("keeps unknown teams, foreign teams and unknown users at 404", async () => {
    const seed = await seedGateway();
    const authUserId = await authorityFixture(seed);
    await expect(authorizeGatewayAdmin(seed.teamSlug, authUserId)).resolves.toMatchObject({ memberId: seed.memberId });
    await expect(authorizeGatewayAdmin("unknown-team", authUserId)).rejects.toMatchObject(NOT_FOUND);
    const foreign = await seedGateway();
    await expect(authorizeGatewayAdmin(foreign.teamSlug, authUserId)).rejects.toMatchObject(NOT_FOUND);
    await expect(authorizeGatewayAdmin(seed.teamSlug, randomUUID())).rejects.toMatchObject(NOT_FOUND);
  });

  it("never lets Everyone membership in ANOTHER team grant posture here", async () => {
    const seed = await seedGateway();
    const authUserId = await authorityFixture(seed, { everyone: false });
    // The same person is an enrolled, active admin of a second team.
    const foreign = await seedGateway();
    const other = await getPool().query<{ id: string }>(
      `insert into members(team_id,email,display_name,actor_handle,role,tier,status,auth_user_id)
       values($1,$2,'Elsewhere',$3,'admin','team','active',$4) returning id`,
      [foreign.teamId, `${randomUUID()}@test.local`, `elsewhere-${randomUUID().slice(0, 8)}`, authUserId],
    );
    await placeMemberByTier(foreign.teamId, other.rows[0].id, "team");
    expect(await authorityState({ teamId: foreign.teamId, memberId: other.rows[0].id })).toMatchObject({
      role: "admin",
      status: "active",
      everyone_rows: 1,
    });

    await expect(authorizeGatewayAdmin(seed.teamSlug, authUserId)).rejects.toMatchObject(SCOPE_NOT_FOUND);
    // Control: that membership does authorize the team it belongs to — and only as its own member.
    await expect(authorizeGatewayAdmin(foreign.teamSlug, authUserId)).resolves.toEqual({
      teamId: foreign.teamId,
      teamSlug: foreign.teamSlug,
      memberId: other.rows[0].id,
    });
  });

  it("restores authority on deliberate re-enrollment, never on a raw tier edit", async () => {
    const seed = await seedGateway();
    const authUserId = await authorityFixture(seed, { everyone: false, tier: "external" });
    await expect(authorizeGatewayAdmin(seed.teamSlug, authUserId)).rejects.toMatchObject(SCOPE_NOT_FOUND);
    await getPool().query(`update members set tier='team' where id=$1 and team_id=$2`, [seed.memberId, seed.teamId]);
    await expect(authorizeGatewayAdmin(seed.teamSlug, authUserId)).rejects.toMatchObject(SCOPE_NOT_FOUND);
    await placeMemberByTier(seed.teamId, seed.memberId, "team");
    await expect(authorizeGatewayAdmin(seed.teamSlug, authUserId)).resolves.toMatchObject({ memberId: seed.memberId });
  });

  it("the next REQUEST after a committed Everyone removal is refused (AC-10)", async () => {
    const seed = await seedGateway();
    const authUserId = await authorityFixture(seed);
    vi.mocked(getSessionUser).mockResolvedValue({ id: authUserId, email: "admin@test.local" });
    await expect(gatewayAdminContext(seed.teamSlug)).resolves.toEqual({
      teamId: seed.teamId,
      teamSlug: seed.teamSlug,
      memberId: seed.memberId,
    });
    await removeEveryoneMembership(seed);
    const refused = await gatewayAdminContext(seed.teamSlug);
    expect(refused).toBeInstanceOf(Response);
    expect((refused as Response).status).toBe(422);
    expect((await (refused as Response).json()).error.code).toBe("gateway_scope_not_found");
    // No session at all is still the 401 it always was.
    vi.mocked(getSessionUser).mockResolvedValue(null);
    expect(((await gatewayAdminContext(seed.teamSlug)) as Response).status).toBe(401);
  });

  it("reads teams → members → group_members on ONE bound connection in one transaction (AC-10)", async () => {
    const seed = await seedGateway();
    const authUserId = await authorityFixture(seed);
    const observed = observedClient();
    const unbound = await unboundAuthorityReads(async () => {
      await expect(authorizeGatewayAdmin(seed.teamSlug, authUserId, observed.client)).resolves.toEqual({
        teamId: seed.teamId,
        teamSlug: seed.teamSlug,
        memberId: seed.memberId,
      });
    });
    expect(observed.statements.map((statement) => statement.table)).toEqual(["teams", "members", "group_members"]);
    expect(new Set(observed.statements.map((statement) => statement.pid)).size).toBe(1);
    expect(new Set(observed.statements.map((statement) => statement.tx)).size).toBe(1);
    expect(unbound).toEqual([]);
  });

  it.each(["disabled", "invited"] as const)("performs NO posture read for a %s member (AC-10)", async (status) => {
    const seed = await seedGateway();
    const authUserId = await authorityFixture(seed, { status });
    const observed = observedClient({ failPosture: true });
    const unbound = await unboundAuthorityReads(async () => {
      await expect(authorizeGatewayAdmin(seed.teamSlug, authUserId, observed.client)).rejects.toMatchObject(
        SCOPE_NOT_FOUND,
      );
    });
    expect(observed.statements.map((statement) => statement.table)).toEqual(["teams", "members"]);
    expect(unbound).toEqual([]);
  });

  it("a bound posture failure throws — no legacy-tier fallback, no unbound re-read (AC-10)", async () => {
    // Every fallback would ADMIT this caller: active admin, Everyone member, legacy tier 'team'.
    const seed = await seedGateway();
    const authUserId = await authorityFixture(seed);
    expect(await authorityState(seed)).toEqual({ role: "admin", tier: "team", status: "active", everyone_rows: 1 });
    const failing = observedClient({ failPosture: true });
    let thrown: unknown;
    const unbound = await unboundAuthorityReads(async () => {
      thrown = await authorizeGatewayAdmin(seed.teamSlug, authUserId, failing.client).then(
        () => null,
        (error: unknown) => error,
      );
    });
    expect(thrown).toBeInstanceOf(Error);
    expect(thrown).not.toBeInstanceOf(GatewayAdminError);
    expect((thrown as Error).message).toContain(INJECTED_POSTURE_FAULT);
    // The fault was exercised on the bound session, as the third read.
    expect(failing.statements.map((statement) => statement.table)).toEqual(["teams", "members", "group_members"]);
    expect(new Set(failing.statements.map((statement) => statement.pid)).size).toBe(1);
    expect(unbound).toEqual([]);
    // Control: the same caller on an unfaulted bound client is admitted.
    await expect(authorizeGatewayAdmin(seed.teamSlug, authUserId, observedClient().client)).resolves.toMatchObject({
      memberId: seed.memberId,
    });
  });

  it("a bound posture failure is a generic 500 with no privileged dispatch (AC-10)", async () => {
    const seed = await seedGateway();
    const authUserId = await authorityFixture(seed);
    vi.mocked(getSessionUser).mockResolvedValue({ id: authUserId, email: "admin@test.local" });
    vi.stubEnv("AIOS_GATEWAY_INTERNAL_ENABLED", "true");
    const context = { params: Promise.resolve({ teamSlug: seed.teamSlug }) };
    const baseline = await gatewayPolicyRows(seed.teamId);

    // Route the helper's DEFAULT factory through the faulted bound client.
    const failing = observedClient({ failPosture: true });
    const factory = vi
      .spyOn(pgClient(), "transaction")
      .mockImplementation(((fn: never) => failing.client.transaction(fn)) as never);
    try {
      const wrapped = await gatewayAdminContext(seed.teamSlug);
      expect(wrapped).toBeInstanceOf(Response);
      expect((wrapped as Response).status).toBe(500);
      const wrappedBody = await (wrapped as Response).text();
      expect(JSON.parse(wrappedBody).error.code).toBe("gateway_internal");
      expect(wrappedBody).not.toContain(INJECTED_POSTURE_FAULT);

      const response = await createPolicyRoute(policyRequest(seed.teamSlug), context);
      expect(response.status).toBe(500);
      expect((await response.json()).error.code).toBe("gateway_internal");
      expect(factory).toHaveBeenCalledTimes(2);
      expect(failing.statements.filter((statement) => statement.table === "group_members")).toHaveLength(2);
      expect(await gatewayPolicyRows(seed.teamId)).toEqual(baseline);
    } finally {
      factory.mockRestore();
    }

    // Control: the identical request is otherwise valid — unfaulted, it creates and audits the policy.
    const created = await createPolicyRoute(policyRequest(seed.teamSlug), context);
    expect(created.status).toBe(201);
    expect(await gatewayPolicyRows(seed.teamId)).toEqual({
      policies: baseline.policies + 1,
      audits: baseline.audits + 1,
    });
  });
});

describe("gateway durable approval and resume", () => {
  // AIO-1208 AC-09: browser gateway-admin authority follows deliberate Everyone membership, not
  // the legacy members.tier column. Only the membership row changes here; tier stays 'team'.
  it("denies an active legacy tier='team' admin who holds no Everyone membership (AIO-1208)", async () => {
    const seed = await seedGateway();
    const authUserId = randomUUID();
    await getPool().query(`insert into auth_users(id,email) values($1,$2)`, [
      authUserId,
      `${randomUUID()}@test.local`,
    ]);
    await getPool().query(
      `update members set auth_user_id=$1,role='admin',tier='team',status='active'
        where id=$2 and team_id=$3`,
      [authUserId, seed.memberId, seed.teamId],
    );
    // Control: the same row is admitted while it still holds the builtin Everyone membership.
    await expect(authorizeGatewayAdmin(seed.teamSlug, authUserId)).resolves.toMatchObject({
      teamId: seed.teamId,
      memberId: seed.memberId,
    });
    const removed = await getPool().query(
      `delete from group_members gm using groups g
        where g.team_id=gm.team_id and g.id=gm.group_id
          and g.slug='everyone' and g.is_builtin
          and gm.team_id=$1 and gm.member_id=$2`,
      [seed.teamId, seed.memberId],
    );
    expect(removed.rowCount).toBe(1);
    const stale = await getPool().query(
      `select m.role::text,m.tier::text,m.status::text,
         (select count(*)::int from group_members gm
            join groups g on g.team_id=gm.team_id and g.id=gm.group_id
           where gm.team_id=m.team_id and gm.member_id=m.id
             and g.slug='everyone' and g.is_builtin) everyone_rows
       from members m where m.id=$1 and m.team_id=$2`,
      [seed.memberId, seed.teamId],
    );
    expect(stale.rows[0]).toEqual({
      role: "admin",
      tier: "team",
      status: "active",
      everyone_rows: 0,
    });
    await expect(authorizeGatewayAdmin(seed.teamSlug, authUserId)).rejects.toMatchObject({
      code: "gateway_scope_not_found",
      status: 422,
    });
  });

  it("returns one credential-bearing winner and credential-free identical retries", async () => {
    const { seed, service, executionId } = await approvedExecution();
    const idempotencyKey = randomUUID();
    let payloads = 0;
    const attempts = await Promise.all(
      Array.from({ length: 8 }, () =>
        resumeClaimGatewayExecution(
          claimInput(seed, executionId, service, idempotencyKey, () => payloads++),
        ),
      ),
    );
    expect(payloads).toBe(1);
    expect(attempts.filter((value) => value.status === "claimed")).toHaveLength(1);
    expect(
      attempts.filter((value) => value.status === "already_claimed"),
    ).toHaveLength(7);
    await expect(
      resumeClaimGatewayExecution(
        claimInput(seed, executionId, service, randomUUID(), () => payloads++),
      ),
    ).rejects.toMatchObject({ code: "gateway_idempotency_conflict" });
    expect(payloads).toBe(1);
    service.secretBytes.fill(0);
  });

  it("never re-exposes a post-commit payload and settles seal failure as credential", async () => {
    const { seed, service, executionId } = await approvedExecution();
    const idempotencyKey = randomUUID();
    let payloads = 0;
    await expect(
      resumeClaimGatewayExecution({
        ...claimInput(seed, executionId, service, idempotencyKey, () => payloads++),
        useWinningPayload: async () => {
          payloads++;
          throw new Error("injected seal failure");
        },
      }),
    ).rejects.toThrow("injected seal failure");
    expect(payloads).toBe(1);
    expect(
      await getPool().query(`select state from gateway_executions where id=$1`, [
        executionId,
      ]),
    ).toMatchObject({ rows: [{ state: "claimed" }] });
    await failGatewayCredentialSealing({
      serviceIdentityId: seed.serviceIdentityId,
      executionId,
      correlationId: randomUUID(),
    });
    const restartedService = await authenticateGatewayServiceCredential(
      `Bearer aios_gw_${seed.credentialId}_${seed.credentialSecret}`,
    );
    const retry = await resumeClaimGatewayExecution(
      claimInput(
        seed,
        executionId,
        restartedService,
        idempotencyKey,
        () => payloads++,
      ),
    );
    expect(retry).toEqual({
      status: "already_claimed",
      executionId,
      state: "failed",
    });
    expect(payloads).toBe(1);
    const settled = await getPool().query(
      `select state,outcome_classification from gateway_executions where id=$1`,
      [executionId],
    );
    expect(settled.rows[0]).toEqual({
      state: "failed",
      outcome_classification: "credential",
    });
    restartedService.secretBytes.fill(0);
    service.secretBytes.fill(0);
  });

  it("rolls the resumable claim back when strict claim audit fails", async () => {
    const { seed, service, executionId } = await approvedExecution();
    const correlationId = randomUUID();
    await getPool().query(`
      create or replace function gateway_test_reject_resumable_claim()
      returns trigger language plpgsql as $$
      begin
        if new.event='execution_claimed' and new.correlation_id='${correlationId}'::uuid
          then raise exception 'resumable claim audit rejected'; end if;
        return new;
      end $$;
      drop trigger if exists gateway_test_reject_resumable_claim on gateway_audit_log;
      create trigger gateway_test_reject_resumable_claim before insert on gateway_audit_log
      for each row execute function gateway_test_reject_resumable_claim()
    `);
    let payloads = 0;
    try {
      await expect(
        resumeClaimGatewayExecution({
          ...claimInput(seed, executionId, service, randomUUID(), () => payloads++),
          correlationId,
        }),
      ).rejects.toThrow("resumable claim audit rejected");
      expect(payloads).toBe(0);
      const state = await getPool().query(
        `select state,claimed_at from gateway_executions where id=$1`,
        [executionId],
      );
      expect(state.rows[0]).toEqual({ state: "approved", claimed_at: null });
    } finally {
      service.secretBytes.fill(0);
      await getPool().query(`
        drop trigger if exists gateway_test_reject_resumable_claim on gateway_audit_log;
        drop function if exists gateway_test_reject_resumable_claim()
      `);
    }
  });

  it("cancels an approved execution when the frozen principal changes", async () => {
    const { seed, service, executionId, approvalId } = await approvedExecution();
    await getPool().query(
      `update members set role='lead' where id=$1 and team_id=$2`,
      [seed.memberId, seed.teamId],
    );
    await expect(
      resumeClaimGatewayExecution(
        claimInput(seed, executionId, service, randomUUID(), () => undefined),
      ),
    ).rejects.toMatchObject({ code: "gateway_scope_not_found" });
    const state = await getPool().query(
      `select e.state,a.status from gateway_executions e
       join gateway_approvals a on a.execution_id=e.id where e.id=$1 and a.id=$2`,
      [executionId, approvalId],
    );
    expect(state.rows[0]).toEqual({ state: "cancelled", status: "cancelled" });
    service.secretBytes.fill(0);
  });

  it("cancels without a credential when actor, tier, connection, or policy scope changes", async () => {
    const changes: Array<{
      name: string;
      apply: (seed: GatewaySeed) => Promise<unknown>;
    }> = [
      {
        name: "actor",
        apply: (seed) => getPool().query(
          `update members set actor_handle=$1 where id=$2 and team_id=$3`,
          [`changed-${randomUUID()}`, seed.memberId, seed.teamId],
        ),
      },
      {
        name: "tier",
        apply: (seed) => getPool().query(
          `update members set tier='external' where id=$1 and team_id=$2`,
          [seed.memberId, seed.teamId],
        ),
      },
      {
        name: "connection",
        apply: (seed) => getPool().query(
          `update gateway_connections set enabled=false,revoked_at=now(),updated_at=now()
            where id=$1 and team_id=$2`,
          [seed.connectionId, seed.teamId],
        ),
      },
      {
        name: "policy",
        apply: (seed) => getPool().query(
          `insert into policies(team_id,action,resource,effect,priority)
           values($1,'gateway.aios-github-readonly.github.repository.get',
             'github.repository:octo/project','deny',100)`,
          [seed.teamId],
        ),
      },
    ];
    for (const change of changes) {
      const { seed, service, executionId, approvalId } = await approvedExecution();
      await change.apply(seed);
      let payloads = 0;
      await expect(
        resumeClaimGatewayExecution(
          claimInput(seed, executionId, service, randomUUID(), () => payloads++),
        ),
        change.name,
      ).rejects.toMatchObject({ code: "gateway_scope_not_found" });
      expect(payloads, change.name).toBe(0);
      const state = await getPool().query(
        `select e.state,a.status from gateway_executions e
         join gateway_approvals a on a.execution_id=e.id where e.id=$1 and a.id=$2`,
        [executionId, approvalId],
      );
      expect(state.rows[0], change.name).toEqual({
        state: "cancelled",
        status: "cancelled",
      });
      service.secretBytes.fill(0);
    }
  });

  it("keeps rotated credentials overlapping until lock-linearized revocation", async () => {
    const { seed, ctx, service, executionId } = await approvedExecution();
    const credentialId = randomBytes(16).toString("base64url");
    const secret = randomBytes(32).toString("base64url");
    const rotated = await rotateGatewayCredential(ctx, seed.serviceIdentityId, {
      credentialId,
      secret,
      replacesCredentialId: seed.credentialId,
      correlationId: randomUUID(),
    });
    expect(rotated).not.toHaveProperty("secret");
    expect(await listGatewayCredentials(ctx, seed.serviceIdentityId)).toHaveLength(2);
    const oldAuth = await authenticateGatewayServiceCredential(
      `Bearer aios_gw_${seed.credentialId}_${seed.credentialSecret}`,
    );
    const newAuth = await authenticateGatewayServiceCredential(
      `Bearer aios_gw_${credentialId}_${secret}`,
    );
    expect(oldAuth.id).toBe(newAuth.id);
    expect(oldAuth.credentialRowId).not.toBe(newAuth.credentialRowId);
    await resumeClaimGatewayExecution(
      claimInput(seed, executionId, newAuth, randomUUID(), () => undefined),
    );
    const claimed = await getPool().query(
      `select claimed_credential_id from gateway_executions where id=$1`,
      [executionId],
    );
    expect(claimed.rows[0].claimed_credential_id).toBe(newAuth.credentialRowId);
    await revokeGatewayCredential(
      ctx,
      seed.serviceIdentityId,
      credentialId,
      randomUUID(),
    );
    await expect(
      authenticateGatewayServiceCredential(
        `Bearer aios_gw_${credentialId}_${secret}`,
      ),
    ).rejects.toMatchObject({ code: "gateway_unauthorized" });
    const stillActive = await authenticateGatewayServiceCredential(
      `Bearer aios_gw_${seed.credentialId}_${seed.credentialSecret}`,
    );
    oldAuth.secretBytes.fill(0);
    newAuth.secretBytes.fill(0);
    stillActive.secretBytes.fill(0);
    service.secretBytes.fill(0);
  });

  it("resolves an identical retry after credential rotation instead of 409ing (AIO-407 amendment)", async () => {
    const { seed, ctx, service, executionId } = await approvedExecution();
    const idempotencyKey = randomUUID();
    let payloads = 0;
    const winner = await resumeClaimGatewayExecution(
      claimInput(seed, executionId, service, idempotencyKey, () => payloads++),
    );
    expect(winner.status).toBe("claimed");
    expect(payloads).toBe(1);
    const credentialId = randomBytes(16).toString("base64url");
    const secret = randomBytes(32).toString("base64url");
    await rotateGatewayCredential(ctx, seed.serviceIdentityId, {
      credentialId,
      secret,
      replacesCredentialId: seed.credentialId,
      correlationId: randomUUID(),
    });
    const rotatedAuth = await authenticateGatewayServiceCredential(
      `Bearer aios_gw_${credentialId}_${secret}`,
    );
    expect(rotatedAuth.id).toBe(service.id);
    expect(rotatedAuth.credentialRowId).not.toBe(service.credentialRowId);
    // The defect: with credentialId/credentialVersion in the fingerprint this
    // identical retry was permanently 409'd after rotation.
    const retry = await resumeClaimGatewayExecution(
      claimInput(seed, executionId, rotatedAuth, idempotencyKey, () => payloads++),
    );
    expect(retry).toEqual({
      status: "already_claimed",
      executionId,
      state: "claimed",
    });
    expect(payloads).toBe(1);
    // A change in any OTHER fingerprint field must still conflict.
    await expect(
      resumeClaimGatewayExecution({
        ...claimInput(seed, executionId, rotatedAuth, idempotencyKey, () => payloads++),
        requestHash: "a".repeat(64),
      }),
    ).rejects.toMatchObject({ code: "gateway_idempotency_conflict" });
    expect(payloads).toBe(1);
    rotatedAuth.secretBytes.fill(0);
    service.secretBytes.fill(0);
  });

  it("resolves legacy pre-amendment stored fingerprints without widening acceptance", async () => {
    const { seed, ctx, service, executionId } = await approvedExecution();
    const idempotencyKey = randomUUID();
    let payloads = 0;
    await resumeClaimGatewayExecution(
      claimInput(seed, executionId, service, idempotencyKey, () => payloads++),
    );
    // Rewrite the stored fingerprint to the pre-amendment (legacy) form that
    // included the claiming credential's credentialId/credentialVersion —
    // exactly what a row claimed before this fix carries in production.
    const claimedRow = await getPool().query(
      `select e.member_id, cc.credential_id, cc.version
         from gateway_executions e
         join gateway_service_credentials cc on cc.id=e.claimed_credential_id
        where e.id=$1`,
      [executionId],
    );
    const legacyFingerprint = createHash("sha256")
      .update(
        canonicalize({
          credentialId: claimedRow.rows[0].credential_id,
          credentialVersion: claimedRow.rows[0].version,
          executionId,
          executorSubjectId: seed.executorSubjectId,
          executorTenantId: seed.executorTenantId,
          memberId: claimedRow.rows[0].member_id,
          requestHash: REQUEST_HASH,
          serviceIdentityId: seed.serviceIdentityId,
          teamId: seed.teamId,
          tool: "github.repository.get",
          toolkit: "aios-github-readonly",
        }),
        "utf8",
      )
      .digest("hex");
    // resume_fingerprint is write-once (gateway_executions_protect), so plant
    // the legacy value the way pre-fix code wrote it: toggle the trigger
    // inside one transaction (ALTER TABLE is transactional, so the guard is
    // never observably disabled outside it). Values are inlined because a
    // multi-statement simple query cannot take bind parameters.
    await getPool().query(`
      begin;
      alter table gateway_executions disable trigger gateway_executions_protect;
      update gateway_executions set resume_fingerprint='${legacyFingerprint}'
        where id='${executionId}';
      alter table gateway_executions enable trigger gateway_executions_protect;
      commit;
    `);
    // Identical retry with the same credential resolves via the legacy match.
    const sameCredential = await resumeClaimGatewayExecution(
      claimInput(seed, executionId, service, idempotencyKey, () => payloads++),
    );
    expect(sameCredential).toEqual({
      status: "already_claimed",
      executionId,
      state: "claimed",
    });
    // Identical retry with a rotated sibling credential resolves too: the
    // legacy fallback recomputes from the RECORDED claiming credential, not
    // the authenticating one — legacy rows get the amended semantics.
    const credentialId = randomBytes(16).toString("base64url");
    const secret = randomBytes(32).toString("base64url");
    await rotateGatewayCredential(ctx, seed.serviceIdentityId, {
      credentialId,
      secret,
      replacesCredentialId: seed.credentialId,
      correlationId: randomUUID(),
    });
    const rotatedAuth = await authenticateGatewayServiceCredential(
      `Bearer aios_gw_${credentialId}_${secret}`,
    );
    const rotated = await resumeClaimGatewayExecution(
      claimInput(seed, executionId, rotatedAuth, idempotencyKey, () => payloads++),
    );
    expect(rotated).toEqual({
      status: "already_claimed",
      executionId,
      state: "claimed",
    });
    // A different fingerprint field never matches the legacy form either.
    await expect(
      resumeClaimGatewayExecution({
        ...claimInput(seed, executionId, rotatedAuth, idempotencyKey, () => payloads++),
        requestHash: "a".repeat(64),
      }),
    ).rejects.toMatchObject({ code: "gateway_idempotency_conflict" });
    expect(payloads).toBe(1);
    rotatedAuth.secretBytes.fill(0);
    service.secretBytes.fill(0);
  });

  it("keeps gateway policy CRUD transactional and isolated from generic policies", async () => {
    const { ctx, service } = await approvedExecution();
    const correlationId = randomUUID();
    const created = await createGatewayAdminPolicy(ctx, {
      subject: { type: "team" },
      tool: "github.issues.list",
      resource: "github.repository:*",
      effect: "allow",
      priority: 2,
      enabled: true,
      correlationId,
    });
    expect(created.effect).toBe("allow");
    const updated = await updateGatewayAdminPolicy(ctx, created.id, {
      subject: { type: "tier", tier: "team" },
      tool: "github.issues.list",
      resource: "github.repository:octo/project",
      effect: "block",
      priority: 4,
      enabled: true,
      correlationId: randomUUID(),
    });
    expect(updated).toMatchObject({ effect: "block", priority: 4 });
    expect(await listGatewayAdminPolicies(ctx)).toContainEqual(
      expect.objectContaining({ id: created.id }),
    );
    expect(await listAllPolicies(db(), ctx.teamId)).not.toContainEqual(
      expect.objectContaining({ id: created.id }),
    );
    await expect(
      createPolicy(db(), ctx.teamId, {
        action: "gateway.aios-github-readonly.*",
        effect: "allow",
      }),
    ).rejects.toThrow("Managed gateway administration");
    await expect(
      updatePolicy(db(), ctx.teamId, created.id, {
        action: "item.read",
        effect: "allow",
      }),
    ).rejects.toThrow("Managed gateway administration");
    await deleteGatewayAdminPolicy(ctx, created.id, randomUUID());
    expect(await listGatewayAdminPolicies(ctx)).not.toContainEqual(
      expect.objectContaining({ id: created.id }),
    );
    const policyEvents = await getPool().query<{ event: string }>(
      `select event from gateway_audit_log where policy_rule_id=$1 order by id`,
      [created.id],
    );
    expect(policyEvents.rows.map(({ event }) => event)).toEqual([
      "policy_created",
      "policy_updated",
      "policy_deleted",
    ]);
    service.secretBytes.fill(0);
  });

  it("rolls credential rotation back when its strict audit insert fails", async () => {
    const { seed, ctx, service } = await approvedExecution();
    await getPool().query(`
      create or replace function gateway_test_reject_rotation()
      returns trigger language plpgsql as $$
      begin
        if new.event='credential_rotated' then raise exception 'audit rejected'; end if;
        return new;
      end $$;
      drop trigger if exists gateway_test_reject_rotation on gateway_audit_log;
      create trigger gateway_test_reject_rotation before insert on gateway_audit_log
      for each row execute function gateway_test_reject_rotation()
    `);
    try {
      await expect(
        rotateGatewayCredential(ctx, seed.serviceIdentityId, {
          credentialId: randomBytes(16).toString("base64url"),
          secret: randomBytes(32).toString("base64url"),
          replacesCredentialId: seed.credentialId,
          correlationId: randomUUID(),
        }),
      ).rejects.toThrow("audit rejected");
      expect(await listGatewayCredentials(ctx, seed.serviceIdentityId)).toHaveLength(1);
    } finally {
      service.secretBytes.fill(0);
      await getPool().query(`
        drop trigger if exists gateway_test_reject_rotation on gateway_audit_log;
        drop function if exists gateway_test_reject_rotation()
      `);
    }
  });

  it("serializes concurrent rotations into distinct credential versions", async () => {
    const { seed, ctx, service } = await approvedExecution();
    const rotated = await Promise.all(
      Array.from({ length: 2 }, () =>
        rotateGatewayCredential(ctx, seed.serviceIdentityId, {
          credentialId: randomBytes(16).toString("base64url"),
          secret: randomBytes(32).toString("base64url"),
          replacesCredentialId: seed.credentialId,
          correlationId: randomUUID(),
        }),
      ),
    );
    expect(rotated.map((value) => value.version).sort()).toEqual([2, 3]);
    expect(await listGatewayCredentials(ctx, seed.serviceIdentityId)).toHaveLength(3);
    service.secretBytes.fill(0);
  });

  it("allows exactly one concurrent admin decision and one decision audit", async () => {
    const { ctx, approvalId, executionId, service } = await approvedExecution({
      approve: false,
    });
    const attempts = await Promise.allSettled(
      Array.from({ length: 8 }, () =>
        decideGatewayApproval(ctx, approvalId, "approve", randomUUID()),
      ),
    );
    expect(attempts.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
    expect(attempts.filter(({ status }) => status === "rejected")).toHaveLength(7);
    const decision = await getPool().query(
      `select e.state,a.status,count(l.id)::int audit_count
         from gateway_executions e
         join gateway_approvals a on a.execution_id=e.id
         left join gateway_audit_log l on l.approval_id=a.id
           and l.event in ('approval_approved','approval_denied')
        where e.id=$1 and a.id=$2 group by e.state,a.status`,
      [executionId, approvalId],
    );
    expect(decision.rows[0]).toEqual({
      state: "approved",
      status: "approved",
      audit_count: 1,
    });
    service.secretBytes.fill(0);
  });

  it("uses database time to expire decision races exactly once", async () => {
    const { ctx, approvalId, executionId, service } = await approvedExecution({
      approve: false,
      approvalTtlMilliseconds: 100,
    });
    const queue = await listGatewayApprovals(ctx);
    expect(queue).toHaveLength(1);
    expect(queue[0]).toEqual(
      expect.objectContaining({
        approvalId,
        executionId,
        requestHashPrefix: REQUEST_HASH.slice(0, 12),
      }),
    );
    expect(queue[0]).not.toHaveProperty("requestHash");
    expect(queue[0]).not.toHaveProperty("encryptedRequestEnvelope");
    await new Promise((resolve) => setTimeout(resolve, 120));
    const settled = await Promise.allSettled([
      decideGatewayApproval(ctx, approvalId, "approve", randomUUID()),
      decideGatewayApproval(ctx, approvalId, "deny", randomUUID()),
    ]);
    expect(settled.every((result) => result.status === "rejected")).toBe(true);
    const row = await getPool().query(
      `select e.state,a.status,
        (select count(*)::int from gateway_audit_log
          where approval_id=a.id and event='approval_expired') audits
       from gateway_executions e join gateway_approvals a on a.execution_id=e.id
       where e.id=$1`,
      [executionId],
    );
    expect(row.rows[0]).toEqual({ state: "expired", status: "expired", audits: 1 });
    service.secretBytes.fill(0);
  });

  // A claim leaves the approval row 'approved' (claims never retire it). Model that end-state directly:
  // an approved-then-expired approval whose execution advanced to a claimed/terminal state.
  async function claimedThenExpired() {
    const res = await approvedExecution({ approve: true, approvalTtlMilliseconds: 400 });
    await new Promise((r) => setTimeout(r, 500)); // approval now past its TTL
    // The execution was claimed while the approval was still valid (executions permit state transitions).
    await getPool().query(`update gateway_executions set state='claimed',updated_at=now() where id=$1`, [res.executionId]);
    return res;
  }
  const stateAndFalseAudits = (executionId: string) =>
    getPool().query(
      `select state,
         (select count(*)::int from gateway_audit_log where execution_id=$1 and event='approval_expired') audits
       from gateway_executions where id=$1`,
      [executionId],
    );

  it("the expiry SWEEP does not clobber an already-claimed execution back to 'expired' (H1 audit-integrity)", async () => {
    const { ctx, executionId, service } = await claimedThenExpired();
    await listGatewayApprovals(ctx); // runs the sweep
    // Pre-fix the sweep flipped it to 'expired' + wrote a false approval_expired row; both must not happen.
    expect((await stateAndFalseAudits(executionId)).rows[0]).toEqual({ state: "claimed", audits: 0 });
    service.secretBytes.fill(0);
  });

  it("deciding an expired approval does not clobber an already-claimed execution (H1 audit-integrity)", async () => {
    const { ctx, executionId, approvalId, service } = await claimedThenExpired();
    // decide() enters its expired branch (it rejects with 410 after committing) — but must leave the
    // claimed execution's terminal state alone.
    await expect(decideGatewayApproval(ctx, approvalId, "approve", randomUUID())).rejects.toMatchObject({
      code: "gateway_approval_expired",
    });
    expect((await stateAndFalseAudits(executionId)).rows[0]).toEqual({ state: "claimed", audits: 0 });
    service.secretBytes.fill(0);
  });

  it("deciding an already-denied approval after expiry returns a clean 410, not a raw trigger 500", async () => {
    const { ctx, approvalId, service } = await approvedExecution({ approve: false, approvalTtlMilliseconds: 400 });
    await decideGatewayApproval(ctx, approvalId, "deny", randomUUID()); // pending → denied (while valid)
    await new Promise((r) => setTimeout(r, 500)); // now past TTL
    // The expired branch must NOT attempt a denied → expired transition (trigger-illegal → 500); the
    // status-guarded no-op keeps it a clean 410.
    await expect(decideGatewayApproval(ctx, approvalId, "approve", randomUUID())).rejects.toMatchObject({
      code: "gateway_approval_expired",
      status: 410,
    });
    service.secretBytes.fill(0);
  });
});
