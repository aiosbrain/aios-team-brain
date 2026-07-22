import { randomBytes, randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { getPool } from "@/lib/db/pg/pool";
import {
  authorizeGatewayAdmin,
  createGatewayAdminPolicy,
  deleteGatewayAdminPolicy,
  decideGatewayApproval,
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
import { db } from "./helpers";
import { createPolicy, listAllPolicies, updatePolicy } from "@/lib/policy/manage";

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

describe("gateway durable approval and resume", () => {
  it("enforces the admin/member/lead/external authorization matrix", async () => {
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
    await expect(authorizeGatewayAdmin(seed.teamSlug, authUserId)).resolves.toMatchObject({
      teamId: seed.teamId,
      memberId: seed.memberId,
    });
    for (const role of ["member", "lead"] as const) {
      await getPool().query(`update members set role=$1 where id=$2`, [role, seed.memberId]);
      await expect(authorizeGatewayAdmin(seed.teamSlug, authUserId)).rejects.toMatchObject({
        code: "gateway_forbidden",
        status: 403,
      });
    }
    await getPool().query(
      `update members set role='admin',tier='external' where id=$1`,
      [seed.memberId],
    );
    await expect(authorizeGatewayAdmin(seed.teamSlug, authUserId)).rejects.toMatchObject({
      code: "gateway_scope_not_found",
      status: 422,
    });
    await expect(authorizeGatewayAdmin("unknown-team", authUserId)).rejects.toMatchObject({
      code: "gateway_not_found",
      status: 404,
    });
    const foreign = await seedGateway();
    await expect(authorizeGatewayAdmin(foreign.teamSlug, authUserId)).rejects.toMatchObject({
      code: "gateway_not_found",
      status: 404,
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
