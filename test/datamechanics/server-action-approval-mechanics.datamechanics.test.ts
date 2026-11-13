import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { PgClient } from "@/lib/db/pg/client";
import { getPool } from "@/lib/db/pg/pool";
import type { PgEnvelopeContext } from "@/lib/db/pg/query-builder";
import type { DbClient } from "@/lib/db/types";
import { db, placeMemberByTier, seedTeam, type Seed } from "./helpers";

/**
 * AIO-1217 — legacy approval decision mechanics against real Postgres (AC-08, non-fault half).
 *
 * Every assertion is derived from the accepted specification's finite decision table, not from the
 * implementation. This file covers the lookup and claim side of a decision:
 *
 *   G — governed ownership is identity-derived: same-team routing, foreign identity answering like
 *       an absent id, and a governed marker that never falls back to the legacy resolver.
 *   L — legacy link cardinality and forward/reverse consistency.
 *   R — producer readiness: a `runAction` producer held after its approval insert, the unchanged
 *       early refusal for both decisions, resumption, then a consistent decision; a linked action
 *       that is no longer `pending_approval` is never resumed.
 *   P — decision precedence collisions and malformed ids.
 *   S — genuine standalone approvals (directly seeded: there is no production producer).
 *   C — two competing requests on one pending approval: exactly one winner, exact dispatch counts.
 *
 * What is real here: `requireTeamAdmin` and the posture resolver, `decideApproval`,
 * `resolveApprovalOwner`, `resolveApproval`, `runAction`, the policy engine, the built-in
 * `code.run` handler, the audit writer and the pg adapter. Link cardinality, tenant tuples and the
 * pending claim are real rows and real conditional statements; nothing about Postgres is faked.
 * What is stubbed: ONLY "who is signed in", `revalidatePath`, the sandbox factory (its `run` is a
 * recording fixture that allocates nothing) and `governedActions.decide` — the governed resolver is
 * a separate transactional owner with its own real-PG suite, so here it only records its routing.
 *
 * Barriers use the adapter's own envelope seam on a real `PgClient` over the same pool: a matching
 * statement is held AFTER it has executed and before its caller sees the result, so a paused
 * producer or contender holds no connection and no test depends on timing.
 *
 * NOT covered here, and still owed by separately supervised work: statement fault injection
 * (returned error / throw / zero rows) on claim, prepare, deny and finish; the checked shared
 * `runAction` transitions; handler success / returned failure / throw / missing separated from
 * terminal persistence; the `[legacy_action_persistence_fault]` event payload; and the unchanged
 * v1 route handler's 500 mapping. The only claim made about that event here is its absence on a
 * named refusal or a lost claim.
 */

const FIXTURE = "FIXTURE PREMISE FAILED (setup, not a security observation):";

const h = vi.hoisted(() => ({
  sessionUser: null as { id: string; email: string } | null,
  /** When set, the client `adminClient()` hands the action under test: a gated or tapped adapter. */
  actionDb: null as import("@/lib/db/types").DbClient | null,
  revalidatePath: vi.fn(),
  sandboxRun: vi.fn(),
  createE2BSandbox: vi.fn(),
}));

// Request identity only: the membership, role and posture behind this auth-user id are real rows.
vi.mock("@/lib/auth/session", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth/session")>()),
  getSessionUser: async () => h.sessionUser,
}));
vi.mock("next/cache", () => ({ revalidatePath: h.revalidatePath }));
// The factory is pure; `run` is the recording boundary. No E2B transport, loader or allocation.
vi.mock("@/lib/actions/sandbox/e2b", () => ({ createE2BSandbox: h.createE2BSandbox }));
// The real service client unless a test hands the action a real adapter with a barrier or a tap.
vi.mock("@/lib/db/admin", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/db/admin")>();
  return { ...original, adminClient: () => h.actionDb ?? original.adminClient() };
});

import { decideApproval } from "@/app/t/[team]/admin/approvals/actions";
import {
  resolveApproval,
  resolveApprovalOwner,
  runAction,
  type ApprovalOwner,
  type ResolveApprovalOutcome,
  type SandboxRunner,
} from "@/lib/actions";
import { governedActions, GovernedError } from "@/lib/actions/governed";

type Row = Record<string, unknown>;
type Decision = "approved" | "denied";
type ApprovalStatus = "pending" | "approved" | "denied" | "expired";
type ActionStatus = "requested" | "denied" | "pending_approval" | "running" | "succeeded" | "failed";
type ActionResult = { ok: boolean; error?: string; message?: string };
type GovernedStatus = Awaited<ReturnType<typeof governedActions.decide>>;

const FAULT_EVENT = "[legacy_action_persistence_fault]";
const SANDBOX_STDOUT = "aio1217-synthetic-sandbox-stdout";
const PRIVATE_PAYLOAD = "AIO1217_PRIVATE_PAYLOAD_SENTINEL";
const CODE_PARAMS = { language: "python", code: `print('${PRIVATE_PAYLOAD}')` };
const REQUESTER_ACTOR = "aio1217-fixture-requester";
const DECISION_NOTE = "aio1217 synthetic decision note";
const ORIGINAL_NOTE = "aio1217 original decision note";
const ORIGINAL_DECIDED_AT = "2026-09-01T12:00:00.000Z";
const ORIGINAL_RESULT = { output: { exitCode: 0, stdout: "aio1217 original terminal output", stderr: "" } };
const DECISIONS: Decision[] = ["approved", "denied"];
const NONPENDING: ApprovalStatus[] = ["approved", "denied", "expired"];
const NOT_PENDING_APPROVAL: ActionStatus[] = ["requested", "running", "succeeded", "failed", "denied"];

const APPROVAL_NOT_FOUND = { ok: false, error: "approval not found" };
const INVALID_REQUEST = { ok: false, error: "invalid request" };
const ADMINS_ONLY = { ok: false, error: "admins only" };
const ALREADY_DECIDED = { ok: false, error: "already decided by someone else" };
const COULD_NOT_DECIDE = { ok: false, error: "could not decide" };
const NOT_READY = { ok: false, error: "approval not ready" };

let governedDecide: MockInstance<typeof governedActions.decide>;
let consoleError: MockInstance<typeof console.error>;

beforeEach(() => {
  h.sessionUser = null;
  h.actionDb = null;
  h.revalidatePath.mockReset();
  h.sandboxRun.mockReset();
  h.sandboxRun.mockImplementation(async () => ({ exitCode: 0, stdout: SANDBOX_STDOUT, stderr: "" }));
  h.createE2BSandbox.mockReset();
  h.createE2BSandbox.mockImplementation(() => ({ configured: true, run: h.sandboxRun }));
  // Never the real governed transaction: a test that expects governed routing configures the outcome.
  governedDecide = vi.spyOn(governedActions, "decide").mockImplementation(async () => {
    throw new Error("unexpected governed dispatch");
  });
  consoleError = vi.spyOn(console, "error");
});

afterEach(() => {
  h.actionDb = null;
  governedDecide.mockRestore();
  consoleError.mockRestore();
});

// ── fixture plumbing ─────────────────────────────────────────────────────────────────────────────

async function fx<T extends Row = Row>(label: string, text: string, params: unknown[] = []): Promise<T[]> {
  try {
    return (await getPool().query(text, params)).rows as T[];
  } catch (error) {
    throw new Error(`${FIXTURE} ${label}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function fxOne<T extends Row = Row>(label: string, text: string, params: unknown[] = []): Promise<T> {
  const rows = await fx<T>(label, text, params);
  if (rows.length !== 1) throw new Error(`${FIXTURE} ${label}: expected exactly one row, got ${rows.length}`);
  return rows[0];
}

function premise(label: string, actual: unknown, expected: unknown): void {
  expect(actual, `${FIXTURE} ${label}`).toEqual(expected);
}

const approvalsPath = (teamSlug: string) => `/t/${teamSlug}/admin/approvals`;
const recordingSandbox = (): SandboxRunner => ({ configured: true, run: h.sandboxRun });

const auditRows = () =>
  fx(
    "audit readback",
    `select id::text as id, team_id, actor_kind, member_id, api_key_id, action, target_type, target_id, meta
       from audit_log order by audit_log.id`,
  );

/** The audit rows written since `before` (the table is append-only and read in identity order). */
function auditSince(before: Row[], after: Row[]): Row[] {
  premise("audit prefix is append-only", after.slice(0, before.length), before);
  return after.slice(before.length);
}

/**
 * Audit is best effort and is not the settled-state oracle; with no fault injected the events land.
 * What the contract fixes is the decision event and the confirmed terminal event, so only those
 * two families are read out — in the order they were written.
 */
const decisionEvents = (written: Row[]) => ({
  approval: written.map((row) => String(row.action)).filter((action) => action.startsWith("approval.")),
  terminal: written.map((row) => String(row.action)).filter((action) => action === "action.succeeded" || action === "action.failed"),
});

/** Fresh readbacks straight from the pool: the standing rows, whatever any adapter reported. */
async function durableState() {
  return {
    approvals: await fx("approval readback", `select * from approval_requests order by id`),
    actions: await fx("action readback", `select * from actions order by id`),
    governed: await fx("governed readback", `select * from governed_actions order by id`),
    audit: await auditRows(),
  };
}

const effects = () => ({
  sandboxRuns: h.sandboxRun.mock.calls.length,
  revalidated: h.revalidatePath.mock.calls.map((call) => call[0]) as unknown[],
  governedDecides: governedDecide.mock.calls.length,
  faultEvents: consoleError.mock.calls.filter((call) => call[0] === FAULT_EVENT).length,
});
const NO_EFFECTS = { sandboxRuns: 0, revalidated: [], governedDecides: 0, faultEvents: 0 };

/** A distinct active same-team member holding the real builtin Everyone posture row. */
async function addMember(teamId: string): Promise<string> {
  const { id } = await fxOne<{ id: string }>(
    "member insert",
    `insert into members(team_id, email, display_name, actor_handle, role, tier, status)
     values($1, $2, $3, $4, 'member', 'team', 'active') returning id`,
    [teamId, `${randomUUID()}@test.local`, `Member ${randomUUID().slice(0, 6)}`, `m-${randomUUID().slice(0, 10)}`],
  );
  await placeMemberByTier(teamId, id, "team");
  return id;
}

/**
 * Bind `memberId` to a fresh auth user, give it `role`, read the authority state back, then make
 * that auth user the signed-in identity. Nothing about the guard is stubbed to success.
 */
async function signIn(teamId: string, memberId: string, role: "admin" | "member") {
  const user = { id: randomUUID(), email: `${randomUUID()}@test.local` };
  await fxOne("auth user insert", `insert into auth_users(id, email) values($1, $2) returning id`, [user.id, user.email]);
  await fxOne(
    "member session binding",
    `update members set auth_user_id = $1, role = $2 where id = $3 and team_id = $4 returning id`,
    [user.id, role, memberId, teamId],
  );
  premise(
    "signed-in authority",
    await fx(
      "authority readback",
      `select m.team_id, m.role::text as role, m.status::text as status, m.auth_user_id,
              (select count(*)::int from group_members gm
                 join groups g on g.team_id = gm.team_id and g.id = gm.group_id
                where gm.team_id = m.team_id and gm.member_id = m.id and g.slug = 'everyone' and g.is_builtin) as everyone_rows
         from members m where m.id = $1`,
      [memberId],
    ),
    [{ team_id: teamId, role, status: "active", auth_user_id: user.id, everyone_rows: 1 }],
  );
  h.sessionUser = user;
  return user;
}

// ── approval / action / governed fixtures (direct rows: the tuples a producer cannot be made to write) ──

/** An approval whose context carries the private params plus whatever markers the case needs. */
async function seedApproval(owner: Seed, opts: { context?: Row; status?: ApprovalStatus } = {}): Promise<string> {
  const id = randomUUID();
  const status = opts.status ?? "pending";
  const decided = status === "approved" || status === "denied";
  await fxOne(
    "approval insert",
    `insert into approval_requests(id, team_id, requested_by_member, requested_by_actor, action, resource, context,
                                   status, decided_by, decided_at, decision_note)
     values($1, $2, $3, $4, 'code.run', 'code:fixture', $5::jsonb, $6::approval_status, $7, $8, $9) returning id`,
    [
      id,
      owner.teamId,
      owner.memberId,
      REQUESTER_ACTOR,
      JSON.stringify({ params: CODE_PARAMS, ...opts.context }),
      status,
      decided ? owner.memberId : null,
      decided ? ORIGINAL_DECIDED_AT : null,
      decided ? ORIGINAL_NOTE : "",
    ],
  );
  return id;
}

async function seedAction(
  owner: Seed,
  opts: { id?: string; status?: ActionStatus; approvalId?: string | null } = {},
): Promise<string> {
  const id = opts.id ?? randomUUID();
  const status = opts.status ?? "pending_approval";
  const terminal = status === "succeeded" || status === "failed";
  await fxOne(
    "action insert",
    `insert into actions(id, team_id, member_id, actor, action_type, resource, params, status, decision,
                         approval_request_id, result)
     values($1, $2, $3, $4, 'code.run', 'code:fixture', $5::jsonb, $6::action_status, 'require_approval', $7, $8::jsonb)
     returning id`,
    [
      id,
      owner.teamId,
      owner.memberId,
      REQUESTER_ACTOR,
      JSON.stringify(CODE_PARAMS),
      status,
      opts.approvalId ?? null,
      JSON.stringify(terminal ? ORIGINAL_RESULT : {}),
    ],
  );
  return id;
}

/** A consistent legacy tuple: forward marker and reverse link agree, action linked in `actionStatus`. */
async function seedLinkedTuple(
  owner: Seed,
  opts: { approvalStatus?: ApprovalStatus; actionStatus?: ActionStatus; context?: Row } = {},
): Promise<{ approvalId: string; actionId: string }> {
  const actionId = randomUUID();
  const approvalId = await seedApproval(owner, {
    status: opts.approvalStatus,
    context: { action_id: actionId, ...opts.context },
  });
  await seedAction(owner, { id: actionId, status: opts.actionStatus, approvalId });
  return { approvalId, actionId };
}

/**
 * A governed owner row for `approvalId`. `governed_actions` has no team column: its tenant is the
 * identity's team, which the schema lets differ from the approval's — `identityOwner` picks it.
 */
async function seedGovernedOwner(approvalId: string, identityOwner: Seed, governedId: string = randomUUID()): Promise<string> {
  const tag = randomUUID().slice(0, 8);
  const project = await fxOne<{ id: string }>(
    "governed project insert",
    `insert into projects(team_id, slug) values($1, $2) returning id`,
    [identityOwner.teamId, `governed-${tag}`],
  );
  const credential = await fxOne<{ id: string }>(
    "governed credential insert",
    `insert into api_keys(team_id, member_id, key_id, key_hash) values($1, $2, $3, $4) returning id`,
    [identityOwner.teamId, identityOwner.memberId, `aio1217${tag}`, "0".repeat(64)],
  );
  const auditRef = await fxOne<{ id: string }>(
    "governed audit insert",
    `insert into audit_log(team_id, actor_kind, action) values($1, 'system', 'governed.fixture') returning id::text as id`,
    [identityOwner.teamId],
  );
  const identity = await fxOne<{ id: string }>(
    "governed identity insert",
    `insert into governed_action_identities(team_id, member_id, project_id, operation_key, canonical_request, request_hash)
     values($1, $2, $3, $4, '{}', $5) returning id`,
    [identityOwner.teamId, identityOwner.memberId, project.id, `operation-${tag}`, "a".repeat(64)],
  );
  await fxOne(
    "governed action insert",
    `insert into governed_actions(id, identity_id, attempt, credential_id, credential_fingerprint, request, status,
                                  result, audit_ref, approval_request_id)
     values($1, $2, 1, $3, 'fixture-fingerprint', '{}', 'pending_approval', '{}'::jsonb, $4::bigint, $5) returning id`,
    [governedId, identity.id, credential.id, auditRef.id, approvalId],
  );
  premise(
    "governed owner readback",
    await fx(
      "governed owner readback",
      `select g.approval_request_id, i.team_id as identity_team
         from governed_actions g join governed_action_identities i on i.id = g.identity_id where g.id = $1`,
      [governedId],
    ),
    [{ approval_request_id: approvalId, identity_team: identityOwner.teamId }],
  );
  return governedId;
}

const resolve = (
  client: DbClient,
  teamId: string,
  approvalRequestId: string,
  decision: Decision,
  deciderMemberId: string,
  note: string = DECISION_NOTE,
) => resolveApproval(client, { teamId, approvalRequestId, decision, deciderMemberId, note }, { sandbox: recordingSandbox() });

// ── refusal runner ───────────────────────────────────────────────────────────────────────────────

type Refusal = {
  name: string;
  /** Seeds the scenario for administrator team `a` (and bystander team `b`); returns the approval id. */
  seed: (a: Seed, b: Seed) => Promise<string>;
  owner: ApprovalOwner["owner"];
  dashboard: ActionResult;
  resolver: ResolveApprovalOutcome["status"];
};

/**
 * One refusal, observed through the owner lookup, the dashboard action and the resolver, for approve
 * AND deny. The durable rowsets (every team's), the dispatch, governed-routing, cache and fault-event
 * recorders are compared with the returned values in ONE grouped assertion, so a correct return
 * value cannot hide a write or a dispatch.
 */
function refusals(cases: Refusal[]): void {
  it.each(cases)("$name", async ({ seed, owner, dashboard, resolver }) => {
    const a = await seedTeam();
    const b = await seedTeam();
    await signIn(a.teamId, a.memberId, "admin");
    const approvalId = await seed(a, b);
    const before = await durableState();

    const observed = {
      owner: await resolveApprovalOwner(db(), { teamId: a.teamId, approvalRequestId: approvalId }),
      dashboard: [
        await decideApproval(a.teamSlug, approvalId, "approved", DECISION_NOTE),
        await decideApproval(a.teamSlug, approvalId, "denied", DECISION_NOTE),
      ],
      resolver: [
        await resolve(db(), a.teamId, approvalId, "approved", a.memberId),
        await resolve(db(), a.teamId, approvalId, "denied", a.memberId),
      ],
    };

    const after = await durableState();
    expect({
      owner: observed.owner.owner,
      dashboard: observed.dashboard,
      resolver: observed.resolver.map((outcome) => outcome.status),
      privatePayloadReturned: JSON.stringify(observed).includes(PRIVATE_PAYLOAD),
      ...after,
      ...effects(),
    }).toEqual({
      owner,
      dashboard: [dashboard, dashboard],
      resolver: [resolver, resolver],
      privatePayloadReturned: false,
      ...before,
      ...NO_EFFECTS,
    });
  });
}

// ── barriers ─────────────────────────────────────────────────────────────────────────────────────

type Gate = { db: DbClient; arrived(n: number): Promise<void>; release(): void };

/**
 * A real pg adapter over the same pool. Until released, each statement matching `at` is held after
 * it has executed and before its caller sees the envelope; once released the adapter is plain.
 */
function gatedDb(at: (statement: PgEnvelopeContext) => boolean): Gate {
  const held: Array<() => void> = [];
  const waiting: Array<{ n: number; wake: () => void }> = [];
  let arrivals = 0;
  let open = false;
  const client = new PgClient({
    envelopeInterceptor: async (statement, result) => {
      if (!open && at(statement)) {
        arrivals += 1;
        const resume = new Promise<void>((resolveHold) => held.push(resolveHold));
        for (const waiter of waiting.splice(0)) {
          if (arrivals >= waiter.n) waiter.wake();
          else waiting.push(waiter);
        }
        await resume;
      }
      return result;
    },
  });
  return {
    db: client as unknown as DbClient,
    arrived: (n) => (arrivals >= n ? Promise.resolve() : new Promise<void>((wake) => waiting.push({ n, wake }))),
    release: () => {
      open = true;
      for (const resume of held.splice(0)) resume();
    },
  };
}

/** Wait until `n` statements are held. A gated call settling first is a fixture failure, not a hang. */
async function reached(gate: Gate, n: number, calls: Array<Promise<unknown>>): Promise<void> {
  let atBarrier = false;
  const settledFirst = Promise.race(calls.map((call) => call.then(() => undefined, () => undefined))).then(() => {
    if (!atBarrier) throw new Error(`${FIXTURE} a gated call settled before reaching the barrier`);
  });
  await Promise.race([
    gate.arrived(n).then(() => {
      atBarrier = true;
    }),
    settledFirst,
  ]);
}

/** The producer's approval insert has landed; its action link has not. */
const approvalInsert = (statement: PgEnvelopeContext) =>
  statement.table === "approval_requests" && statement.operation === "insert";
/** The resolver has read link readiness; it has not claimed. */
const readinessRead = (statement: PgEnvelopeContext) => statement.table === "actions" && statement.operation === "select";

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// G — governed ownership
// ─────────────────────────────────────────────────────────────────────────────────────────────────

describe("AIO-1217 G · governed ownership is identity-derived and never falls back to the legacy resolver (AC-07, AC-08)", () => {
  it.each([
    { shape: "marker and owner row agree", marker: true, legacyLink: false },
    { shape: "marker and owner row agree, colliding with an otherwise-ready legacy link", marker: true, legacyLink: true },
    { shape: "owner row with no marker in the approval context", marker: false, legacyLink: false },
  ])(
    "[control] same-team governed owner · $shape: each decision is routed once to the governed resolver with the administrator's own team and member; the legacy resolver decides nothing, dispatches nothing and the linked legacy action is untouched",
    async ({ marker, legacyLink }) => {
      const a = await seedTeam();
      await signIn(a.teamId, a.memberId, "admin");
      const governedId = randomUUID();
      const legacyActionId = randomUUID();
      const approvalId = await seedApproval(a, {
        context: {
          ...(marker ? { governed_action_id: governedId } : {}),
          ...(legacyLink ? { action_id: legacyActionId } : {}),
        },
      });
      await seedGovernedOwner(approvalId, a, governedId);
      if (legacyLink) await seedAction(a, { id: legacyActionId, approvalId });
      const before = await durableState();
      governedDecide.mockResolvedValue({ status: "denied" } as unknown as GovernedStatus);

      // The legacy resolver, handed a governed approval directly, must not decide it.
      const owner = await resolveApprovalOwner(db(), { teamId: a.teamId, approvalRequestId: approvalId });
      const direct = [
        await resolve(db(), a.teamId, approvalId, "approved", a.memberId),
        await resolve(db(), a.teamId, approvalId, "denied", a.memberId),
      ];
      const afterDirect = { ...(await durableState()), ...effects() };
      const results = [
        await decideApproval(a.teamSlug, approvalId, "approved", DECISION_NOTE),
        await decideApproval(a.teamSlug, approvalId, "denied", DECISION_NOTE),
      ];
      const after = await durableState();

      expect({
        owner: owner.owner,
        legacyDecided: direct.filter((outcome) => outcome.status === "approved" || outcome.status === "denied").length,
        afterDirect,
      }).toEqual({ owner: "governed", legacyDecided: 0, afterDirect: { ...before, ...NO_EFFECTS } });
      expect(governedDecide.mock.calls).toEqual(
        DECISIONS.map((decision) => [
          { teamId: a.teamId, deciderMemberId: a.memberId, approvalRequestId: approvalId, decision, note: DECISION_NOTE },
        ]),
      );
      expect(results).toEqual([
        { ok: true, message: "Action denied." },
        { ok: true, message: "Action denied." },
      ]);
      // The governed resolver is a recording seam here, so any row change would be the legacy path's.
      expect({ ...after, sandboxRuns: h.sandboxRun.mock.calls.length, faultEvents: effects().faultEvents }).toEqual({
        ...before,
        sandboxRuns: 0,
        faultEvents: 0,
      });
      expect(effects().revalidated).toEqual([approvalsPath(a.teamSlug), approvalsPath(a.teamSlug)]);
    },
  );

  it("[control] same-team governed owner: a GovernedError from the governed resolver keeps its own message, with no legacy decision, dispatch or revalidation", async () => {
    const a = await seedTeam();
    await signIn(a.teamId, a.memberId, "admin");
    const governedId = randomUUID();
    const approvalId = await seedApproval(a, { context: { governed_action_id: governedId } });
    await seedGovernedOwner(approvalId, a, governedId);
    const before = await durableState();
    const refusal = new GovernedError("operation_in_progress", 409);
    governedDecide.mockRejectedValue(refusal);

    const result = await decideApproval(a.teamSlug, approvalId, "approved", DECISION_NOTE);

    expect({ result, ...(await durableState()), ...effects() }).toEqual({
      result: { ok: false, error: refusal.message },
      ...before,
      ...NO_EFFECTS,
      governedDecides: 1,
    });
  });

  refusals([
    {
      name: "foreign governed approval: team B's governed approval answers exactly like an absent id — approval not found, routed to neither resolver",
      seed: async (a, b) => {
        const governedId = randomUUID();
        const approvalId = await seedApproval(b, { context: { governed_action_id: governedId } });
        await seedGovernedOwner(approvalId, b, governedId);
        return approvalId;
      },
      owner: "not_found",
      dashboard: APPROVAL_NOT_FOUND,
      resolver: "not_found",
    },
    {
      name: "governed identity tenant mismatch: the administrator's own approval is owned by a governed action whose identity is team B's — approval not found, never routed governed",
      seed: async (a, b) => {
        const governedId = randomUUID();
        const approvalId = await seedApproval(a, { context: { governed_action_id: governedId } });
        await seedGovernedOwner(approvalId, b, governedId);
        return approvalId;
      },
      owner: "not_found",
      dashboard: APPROVAL_NOT_FOUND,
      resolver: "not_found",
    },
    {
      name: "governed identity tenant mismatch with no marker in the approval context: still approval not found",
      seed: async (a, b) => {
        const approvalId = await seedApproval(a);
        await seedGovernedOwner(approvalId, b);
        return approvalId;
      },
      owner: "not_found",
      dashboard: APPROVAL_NOT_FOUND,
      resolver: "not_found",
    },
    {
      name: "governed identity tenant mismatch colliding with a ready same-team legacy link: approval not found, no legacy fallback — the linked action neither runs nor is denied",
      seed: async (a, b) => {
        const governedId = randomUUID();
        const { approvalId } = await seedLinkedTuple(a, { context: { governed_action_id: governedId } });
        await seedGovernedOwner(approvalId, b, governedId);
        return approvalId;
      },
      owner: "not_found",
      dashboard: APPROVAL_NOT_FOUND,
      resolver: "not_found",
    },
    {
      name: "dangling governed marker (no owner row): could not decide — governed intent never becomes a standalone decision",
      seed: (a) => seedApproval(a, { context: { governed_action_id: randomUUID() } }),
      owner: "malformed_links",
      dashboard: COULD_NOT_DECIDE,
      resolver: "malformed_links",
    },
    {
      name: "dangling governed marker colliding with a ready same-team legacy link: could not decide, no legacy fallback — the linked action neither runs nor is denied",
      seed: async (a) => (await seedLinkedTuple(a, { context: { governed_action_id: randomUUID() } })).approvalId,
      owner: "malformed_links",
      dashboard: COULD_NOT_DECIDE,
      resolver: "malformed_links",
    },
    ...[42, "not-a-uuid", null].map(
      (marker): Refusal => ({
        name: `malformed governed marker ${JSON.stringify(marker)}: a present marker is governed intent — could not decide, never standalone`,
        seed: (a) => seedApproval(a, { context: { governed_action_id: marker } }),
        owner: "malformed_links",
        dashboard: COULD_NOT_DECIDE,
        resolver: "malformed_links",
      }),
    ),
    {
      name: "mismatched governed marker: the marker names a different governed id than the same-team owner row — could not decide, never routed governed",
      seed: async (a) => {
        const approvalId = await seedApproval(a, { context: { governed_action_id: randomUUID() } });
        await seedGovernedOwner(approvalId, a);
        return approvalId;
      },
      owner: "malformed_links",
      dashboard: COULD_NOT_DECIDE,
      resolver: "malformed_links",
    },
    {
      name: "borrowed governed marker: the marker names a real same-team governed action that owns ANOTHER approval — could not decide; the other approval and its owner are untouched",
      seed: async (a) => {
        const governedId = randomUUID();
        const otherApprovalId = await seedApproval(a, { context: { governed_action_id: governedId } });
        await seedGovernedOwner(otherApprovalId, a, governedId);
        return seedApproval(a, { context: { governed_action_id: governedId } });
      },
      owner: "malformed_links",
      dashboard: COULD_NOT_DECIDE,
      resolver: "malformed_links",
    },
  ]);
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// L — legacy link cardinality and forward/reverse consistency
// ─────────────────────────────────────────────────────────────────────────────────────────────────

describe("AIO-1217 L · legacy forward/reverse links are checked for identity, tenant and cardinality before any claim (AC-08)", () => {
  refusals([
    ...["not-a-uuid", 42, null, { nested: true }].map(
      (marker): Refusal => ({
        name: `malformed forward marker ${JSON.stringify(marker)}: a present invalid action_id is malformed intent — could not decide, never standalone`,
        seed: (a) => seedApproval(a, { context: { action_id: marker } }),
        owner: "legacy",
        dashboard: COULD_NOT_DECIDE,
        resolver: "malformed_links",
      }),
    ),
    {
      name: "malformed forward marker beside one otherwise-ready reverse-linked action: could not decide — the reverse-linked action neither runs nor is denied",
      seed: async (a) => {
        const approvalId = await seedApproval(a, { context: { action_id: "not-a-uuid" } });
        await seedAction(a, { approvalId });
        return approvalId;
      },
      owner: "legacy",
      dashboard: COULD_NOT_DECIDE,
      resolver: "malformed_links",
    },
    {
      name: "forward marker names an absent action: could not decide",
      seed: (a) => seedApproval(a, { context: { action_id: randomUUID() } }),
      owner: "legacy",
      dashboard: COULD_NOT_DECIDE,
      resolver: "malformed_links",
    },
    {
      name: "forward marker names team B's action: could not decide — the foreign action is untouched and its payload is not returned",
      seed: async (a, b) => seedApproval(a, { context: { action_id: await seedAction(b, { status: "requested" }) } }),
      owner: "legacy",
      dashboard: COULD_NOT_DECIDE,
      resolver: "malformed_links",
    },
    {
      name: "forward marker names a same-team action that is linked to a DIFFERENT approval: could not decide — the other tuple is untouched",
      seed: async (a) => seedApproval(a, { context: { action_id: (await seedLinkedTuple(a)).actionId } }),
      owner: "legacy",
      dashboard: COULD_NOT_DECIDE,
      resolver: "malformed_links",
    },
    {
      name: "reverse-linked action belongs to team B (forward marker names it): could not decide — a foreign action is never prepared, denied or dispatched",
      seed: async (a, b) => {
        const actionId = randomUUID();
        const approvalId = await seedApproval(a, { context: { action_id: actionId } });
        await seedAction(b, { id: actionId, approvalId });
        return approvalId;
      },
      owner: "legacy",
      dashboard: COULD_NOT_DECIDE,
      resolver: "malformed_links",
    },
    {
      name: "metadata-free approval whose only reverse-linked action belongs to team B: could not decide — neither a standalone decision nor a foreign dispatch",
      seed: async (a, b) => {
        const approvalId = await seedApproval(a);
        await seedAction(b, { approvalId });
        return approvalId;
      },
      owner: "legacy",
      dashboard: COULD_NOT_DECIDE,
      resolver: "malformed_links",
    },
    {
      name: "forward/reverse contradiction: the forward marker names action X while a different action Y is reverse-linked — could not decide, neither X nor Y changes",
      seed: async (a) => {
        const approvalId = await seedApproval(a, { context: { action_id: await seedAction(a, { status: "requested" }) } });
        await seedAction(a, { approvalId });
        return approvalId;
      },
      owner: "legacy",
      dashboard: COULD_NOT_DECIDE,
      resolver: "malformed_links",
    },
    {
      name: "two reverse-linked same-team actions (the forward marker names one of them): could not decide — neither is dispatched or denied",
      seed: async (a) => {
        const { approvalId } = await seedLinkedTuple(a);
        await seedAction(a, { approvalId });
        return approvalId;
      },
      owner: "legacy",
      dashboard: COULD_NOT_DECIDE,
      resolver: "ambiguous_links",
    },
    {
      name: "two reverse-linked same-team actions on a metadata-free approval: could not decide — neither is dispatched or denied",
      seed: async (a) => {
        const approvalId = await seedApproval(a);
        await seedAction(a, { approvalId });
        await seedAction(a, { approvalId });
        return approvalId;
      },
      owner: "legacy",
      dashboard: COULD_NOT_DECIDE,
      resolver: "ambiguous_links",
    },
    {
      name: "three reverse-linked same-team actions: could not decide — none is dispatched or denied",
      seed: async (a) => {
        const { approvalId } = await seedLinkedTuple(a);
        await seedAction(a, { approvalId });
        await seedAction(a, { approvalId });
        return approvalId;
      },
      owner: "legacy",
      dashboard: COULD_NOT_DECIDE,
      resolver: "ambiguous_links",
    },
  ]);

  it.each(DECISIONS)(
    "[control] one consistent same-team link · %s through the resolver: the decision is claimed, the action is resumed or denied exactly once, and a repeated approve and deny are already decided without a second dispatch or any further write",
    async (decision) => {
      const a = await seedTeam();
      const b = await seedTeam();
      const own = await seedLinkedTuple(a);
      await seedLinkedTuple(b);
      const before = await durableState();

      const outcome = await resolve(db(), a.teamId, own.approvalId, decision, a.memberId);

      const after = await durableState();
      expect(outcome).toMatchObject({
        approvalRequestId: own.approvalId,
        status: decision,
        actionId: own.actionId,
        actionStatus: decision === "approved" ? "succeeded" : "denied",
      });
      expect(after.approvals.find((row) => row.id === own.approvalId)).toMatchObject({
        team_id: a.teamId,
        status: decision,
        decided_by: a.memberId,
        decision_note: DECISION_NOTE,
      });
      expect(after.actions.find((row) => row.id === own.actionId)).toMatchObject(
        decision === "approved"
          ? { team_id: a.teamId, status: "succeeded", result: { output: { exitCode: 0, stdout: SANDBOX_STDOUT, stderr: "" } } }
          : { team_id: a.teamId, status: "denied", result: {} },
      );
      expect(h.sandboxRun).toHaveBeenCalledTimes(decision === "approved" ? 1 : 0);
      if (decision === "approved") expect(h.sandboxRun).toHaveBeenCalledWith(CODE_PARAMS);
      expect(after.approvals.filter((row) => row.team_id === b.teamId)).toEqual(
        before.approvals.filter((row) => row.team_id === b.teamId),
      );
      expect(after.actions.filter((row) => row.team_id === b.teamId)).toEqual(
        before.actions.filter((row) => row.team_id === b.teamId),
      );
      const written = auditSince(before.audit, after.audit);
      expect(written.every((row) => row.team_id === a.teamId)).toBe(true);
      expect(decisionEvents(written)).toEqual({
        approval: [`approval.${decision}`],
        terminal: decision === "approved" ? ["action.succeeded"] : [],
      });

      // The decided approval and its settled action are never replayed.
      const repeated = [
        await resolve(db(), a.teamId, own.approvalId, "approved", a.memberId),
        await resolve(db(), a.teamId, own.approvalId, "denied", a.memberId),
      ];
      expect({
        repeated: repeated.map((again) => again.status),
        ...(await durableState()),
        sandboxRuns: h.sandboxRun.mock.calls.length,
        faultEvents: effects().faultEvents,
      }).toEqual({
        repeated: ["already_decided", "already_decided"],
        ...after,
        sandboxRuns: decision === "approved" ? 1 : 0,
        faultEvents: 0,
      });
    },
  );

  it.each(DECISIONS)(
    "[control] old metadata-free approval with exactly one reverse-linked same-team pending_approval action · %s: decided through the dashboard, the action resumed or denied exactly once",
    async (decision) => {
      const a = await seedTeam();
      await signIn(a.teamId, a.memberId, "admin");
      const approvalId = await seedApproval(a);
      const actionId = await seedAction(a, { approvalId });

      const result = await decideApproval(a.teamSlug, approvalId, decision, DECISION_NOTE);

      const after = await durableState();
      expect(result.ok).toBe(true);
      expect(result.error).toBeUndefined();
      expect(result.message).toMatch(decision === "approved" ? /Approved.*succeeded/ : /Denied/);
      expect(after.approvals).toEqual([
        expect.objectContaining({ id: approvalId, team_id: a.teamId, status: decision, decided_by: a.memberId }),
      ]);
      expect(after.actions).toEqual([
        expect.objectContaining({
          id: actionId,
          team_id: a.teamId,
          status: decision === "approved" ? "succeeded" : "denied",
          approval_request_id: approvalId,
        }),
      ]);
      expect(h.sandboxRun).toHaveBeenCalledTimes(decision === "approved" ? 1 : 0);
      expect(effects()).toMatchObject({ revalidated: [approvalsPath(a.teamSlug)], governedDecides: 0, faultEvents: 0 });
    },
  );
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// R — producer readiness
// ─────────────────────────────────────────────────────────────────────────────────────────────────

describe("AIO-1217 R · a decision waits for the producer's link and never resumes an action that is no longer pending_approval (AC-08)", () => {
  refusals([
    {
      name: "forward-only tuple (the stranded-producer signature): the marker names a same-team requested action with no reverse link — approval not ready for approve AND deny, not an orphan to decide standalone",
      seed: async (a) => seedApproval(a, { context: { action_id: await seedAction(a, { status: "requested" }) } }),
      owner: "legacy",
      dashboard: NOT_READY,
      resolver: "not_ready",
    },
    ...NOT_PENDING_APPROVAL.map(
      (status): Refusal => ({
        name: `consistently linked action already ${status}: approval not ready for approve AND deny — no claim, no replay, the action row and its result unchanged`,
        seed: async (a) => (await seedLinkedTuple(a, { actionStatus: status })).approvalId,
        owner: "legacy",
        dashboard: NOT_READY,
        resolver: "not_ready",
      }),
    ),
    ...(["running", "succeeded"] as ActionStatus[]).map(
      (status): Refusal => ({
        name: `metadata-free approval whose one reverse-linked action is already ${status}: approval not ready — the state check applies without a forward marker`,
        seed: async (a) => {
          const approvalId = await seedApproval(a);
          await seedAction(a, { status, approvalId });
          return approvalId;
        },
        owner: "legacy",
        dashboard: NOT_READY,
        resolver: "not_ready",
      }),
    ),
  ]);

  it.each(DECISIONS)(
    "real producer held after its approval insert: approve AND deny are refused approval not ready with the tuple untouched, the producer then resumes to a linked pending_approval, and a later %s decides it consistently",
    async (laterDecision) => {
      const a = await seedTeam();
      await signIn(a.teamId, a.memberId, "admin");
      const requester = await addMember(a.teamId);
      await fxOne(
        "require_approval policy insert",
        `insert into policies(team_id, action, resource, effect) values($1, 'code.run', '*', 'require_approval') returning id`,
        [a.teamId],
      );
      const paused = gatedDb(approvalInsert);
      const producer = runAction(
        paused.db,
        {
          teamId: a.teamId,
          memberId: requester,
          principal: { role: "member", tier: "team", actor: REQUESTER_ACTOR },
          request: { type: "code.run", resource: "code:fixture", params: CODE_PARAMS },
        },
        { sandbox: recordingSandbox() },
      );
      producer.catch(() => undefined);

      try {
        await reached(paused, 1, [producer]);
        const held = await durableState();
        const actionId = String(held.actions[0]?.id);
        const approvalId = String(held.approvals[0]?.id);
        premise(
          "the producer is held between its approval insert and its action link",
          {
            approvals: held.approvals.map((row) => [row.team_id, row.status, (row.context as Row).action_id]),
            actions: held.actions.map((row) => [row.team_id, row.status, row.approval_request_id]),
          },
          { approvals: [[a.teamId, "pending", actionId]], actions: [[a.teamId, "requested", null]] },
        );

        const early = {
          dashboard: [
            await decideApproval(a.teamSlug, approvalId, "approved", DECISION_NOTE),
            await decideApproval(a.teamSlug, approvalId, "denied", DECISION_NOTE),
          ],
          resolver: [
            (await resolve(db(), a.teamId, approvalId, "approved", a.memberId)).status,
            (await resolve(db(), a.teamId, approvalId, "denied", a.memberId)).status,
          ],
        };
        expect({ early, ...(await durableState()), ...effects() }).toEqual({
          early: { dashboard: [NOT_READY, NOT_READY], resolver: ["not_ready", "not_ready"] },
          ...held,
          ...NO_EFFECTS,
        });

        // The early refusals changed nothing the producer depends on: it completes its own link.
        paused.release();
        const produced = await producer;
        const linked = await durableState();
        expect(produced).toEqual({
          actionId,
          status: "pending_approval",
          decision: "require_approval",
          approvalRequestId: approvalId,
        });
        expect(linked.approvals).toEqual(held.approvals);
        expect(linked.actions).toEqual([
          expect.objectContaining({ id: actionId, team_id: a.teamId, status: "pending_approval", approval_request_id: approvalId }),
        ]);
        expect(effects()).toEqual(NO_EFFECTS);

        const result = await decideApproval(a.teamSlug, approvalId, laterDecision, DECISION_NOTE);

        const after = await durableState();
        expect(result.ok).toBe(true);
        expect(result.error).toBeUndefined();
        expect(result.message).toMatch(laterDecision === "approved" ? /Approved.*succeeded/ : /Denied/);
        expect(after.approvals).toEqual([
          expect.objectContaining({
            id: approvalId,
            team_id: a.teamId,
            status: laterDecision,
            decided_by: a.memberId,
            decision_note: DECISION_NOTE,
          }),
        ]);
        expect(after.actions).toEqual([
          expect.objectContaining({
            id: actionId,
            team_id: a.teamId,
            member_id: requester,
            status: laterDecision === "approved" ? "succeeded" : "denied",
            approval_request_id: approvalId,
          }),
        ]);
        expect(h.sandboxRun).toHaveBeenCalledTimes(laterDecision === "approved" ? 1 : 0);
        if (laterDecision === "approved") expect(h.sandboxRun).toHaveBeenCalledWith(CODE_PARAMS);
        expect(effects()).toMatchObject({ revalidated: [approvalsPath(a.teamSlug)], governedDecides: 0, faultEvents: 0 });
      } finally {
        paused.release();
        await Promise.allSettled([producer]);
      }
    },
  );
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// P — decision precedence
// ─────────────────────────────────────────────────────────────────────────────────────────────────

describe("AIO-1217 P · precedence: admission and id shape, then tenant, then governed intent, then decided status, then legacy links (AC-08)", () => {
  it("malformed approval ids after administrator admission: invalid request for both decisions before any statement on the action's client; a well-formed absent id does reach the approval lookup", async () => {
    const a = await seedTeam();
    await signIn(a.teamId, a.memberId, "admin");
    const own = await seedLinkedTuple(a);
    const before = await durableState();
    const malformed = [
      "not-a-uuid",
      "",
      "' or 1=1 --",
      own.approvalId.replaceAll("-", ""),
      `${own.approvalId} `,
      `${own.approvalId}x`,
      own.approvalId.slice(0, -1),
    ];
    const statements: string[] = [];
    h.actionDb = new PgClient({
      envelopeInterceptor: (statement, result) => {
        statements.push(statement.table);
        return result;
      },
    }) as unknown as DbClient;

    const results: ActionResult[] = [];
    for (const id of malformed) {
      for (const decision of DECISIONS) results.push(await decideApproval(a.teamSlug, id, decision, DECISION_NOTE));
    }
    const statementsForMalformed = [...statements];
    // Non-vacuity of the tap: the same client does see the lookup for a well-formed id.
    const absent = await decideApproval(a.teamSlug, randomUUID(), "approved", DECISION_NOTE);
    h.actionDb = null;

    expect({ results, statementsForMalformed, ...(await durableState()), ...effects() }).toEqual({
      results: results.map(() => INVALID_REQUEST),
      statementsForMalformed: [],
      ...before,
      ...NO_EFFECTS,
    });
    expect({ absent, lookupReached: statements.includes("approval_requests") }).toEqual({
      absent: APPROVAL_NOT_FOUND,
      lookupReached: true,
    });
  });

  it("admission precedes id validation: a malformed id from an ordinary member, and from no session, is refused admins only", async () => {
    const a = await seedTeam();
    await seedLinkedTuple(a);
    const before = await durableState();

    await signIn(a.teamId, a.memberId, "member");
    const asMember = await decideApproval(a.teamSlug, "not-a-uuid", "approved", DECISION_NOTE);
    h.sessionUser = null;
    const anonymous = await decideApproval(a.teamSlug, "not-a-uuid", "approved", DECISION_NOTE);

    expect({ asMember, anonymous, ...(await durableState()), ...effects() }).toEqual({
      asMember: ADMINS_ONLY,
      anonymous: ADMINS_ONLY,
      ...before,
      ...NO_EFFECTS,
    });
  });

  refusals([
    {
      name: "tenant precedes links: team B's approval with a malformed forward marker and two reverse links is approval not found, not could not decide",
      seed: async (a, b) => {
        const approvalId = await seedApproval(b, { context: { action_id: "not-a-uuid" } });
        await seedAction(b, { approvalId });
        await seedAction(b, { approvalId });
        return approvalId;
      },
      owner: "not_found",
      dashboard: APPROVAL_NOT_FOUND,
      resolver: "not_found",
    },
    ...NONPENDING.map(
      (status): Refusal => ({
        name: `tenant precedes status: team B's ${status} approval is approval not found, not already decided`,
        seed: async (a, b) => (await seedLinkedTuple(b, { approvalStatus: status })).approvalId,
        owner: "not_found",
        dashboard: APPROVAL_NOT_FOUND,
        resolver: "not_found",
      }),
    ),
    {
      name: "tenant precedes governed intent: team B's approval with a dangling governed marker is approval not found, not could not decide",
      seed: (a, b) => seedApproval(b, { context: { governed_action_id: randomUUID() } }),
      owner: "not_found",
      dashboard: APPROVAL_NOT_FOUND,
      resolver: "not_found",
    },
    {
      name: "governed intent precedes decided status: an owned already-approved approval with a dangling governed marker is could not decide, never a legacy outcome",
      seed: (a) => seedApproval(a, { status: "approved", context: { governed_action_id: randomUUID() } }),
      owner: "malformed_links",
      dashboard: COULD_NOT_DECIDE,
      resolver: "malformed_links",
    },
    ...NONPENDING.map(
      (status): Refusal => ({
        name: `owned ${status} approval whose linked action is still pending_approval: already decided by someone else — the recorded decision is not rewritten and the action is neither resumed nor denied`,
        seed: async (a) => (await seedLinkedTuple(a, { approvalStatus: status })).approvalId,
        owner: "legacy",
        dashboard: ALREADY_DECIDED,
        resolver: "already_decided",
      }),
    ),
    {
      name: "decided status precedes links: an owned approved approval with a malformed forward marker is already decided, not could not decide",
      seed: (a) => seedApproval(a, { status: "approved", context: { action_id: "not-a-uuid" } }),
      owner: "legacy",
      dashboard: ALREADY_DECIDED,
      resolver: "already_decided",
    },
    {
      name: "decided status precedes cardinality: an owned denied approval with two reverse-linked actions is already decided, not could not decide",
      seed: async (a) => {
        const { approvalId } = await seedLinkedTuple(a, { approvalStatus: "denied" });
        await seedAction(a, { approvalId });
        return approvalId;
      },
      owner: "legacy",
      dashboard: ALREADY_DECIDED,
      resolver: "already_decided",
    },
    {
      name: "decided status precedes readiness: an owned approved approval whose linked action is running is already decided, not approval not ready",
      seed: async (a) => (await seedLinkedTuple(a, { approvalStatus: "approved", actionStatus: "running" })).approvalId,
      owner: "legacy",
      dashboard: ALREADY_DECIDED,
      resolver: "already_decided",
    },
    {
      name: "decided status precedes readiness: an owned approved approval with a forward-only requested action is already decided, not approval not ready",
      seed: async (a) =>
        seedApproval(a, { status: "approved", context: { action_id: await seedAction(a, { status: "requested" }) } }),
      owner: "legacy",
      dashboard: ALREADY_DECIDED,
      resolver: "already_decided",
    },
  ]);
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// S — genuine standalone approvals
// ─────────────────────────────────────────────────────────────────────────────────────────────────

describe("AIO-1217 S · a genuine standalone approval is a decision-only claim (AC-08)", () => {
  it.each(DECISIONS)(
    "[control] directly seeded standalone approval · %s through the resolver: the pending claim is recorded with no action and no dispatch, and a later opposite decision is already decided without rewriting it",
    async (decision) => {
      const a = await seedTeam();
      const approvalId = await seedApproval(a);
      const before = await durableState();
      premise(
        "the approval is standalone: no forward marker, no governed marker, no reverse-linked action, no governed owner",
        {
          context: before.approvals.map((row) => Object.keys(row.context as Row)),
          actions: before.actions,
          governed: before.governed,
        },
        { context: [["params"]], actions: [], governed: [] },
      );

      const outcome = await resolve(db(), a.teamId, approvalId, decision, a.memberId);

      const after = await durableState();
      expect({
        status: outcome.status,
        actionId: outcome.actionId ?? null,
        actionStatus: outcome.actionStatus ?? null,
        actions: after.actions,
        ...effects(),
      }).toEqual({ status: decision, actionId: null, actionStatus: null, actions: [], ...NO_EFFECTS });
      expect(after.approvals).toEqual([
        expect.objectContaining({
          id: approvalId,
          team_id: a.teamId,
          status: decision,
          decided_by: a.memberId,
          decision_note: DECISION_NOTE,
        }),
      ]);
      expect(after.approvals[0].decided_at).not.toBeNull();
      // Best-effort audit: whatever landed is the approval event under this team, never an action event.
      expect(auditSince(before.audit, after.audit).map((row) => [row.team_id, row.action])).toEqual([
        [a.teamId, `approval.${decision}`],
      ]);

      const opposite: Decision = decision === "approved" ? "denied" : "approved";
      const rival = await addMember(a.teamId);
      const again = await resolve(db(), a.teamId, approvalId, opposite, rival, "aio1217 later rival note");

      expect({ again: again.status, ...(await durableState()), ...effects() }).toEqual({
        again: "already_decided",
        ...after,
        ...NO_EFFECTS,
      });
    },
  );
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// C — competing claims
// ─────────────────────────────────────────────────────────────────────────────────────────────────

describe("AIO-1217 C · two requests on one pending approval: the conditional claim admits exactly one (AC-08)", () => {
  const FIRST_NOTE = "aio1217 first decider note";
  const SECOND_NOTE = "aio1217 second decider note";

  /** A resolver call on its own gated adapter, held once it has read link readiness. */
  function contender(teamId: string, approvalId: string, decision: Decision, decider: string, note: string) {
    const gate = gatedDb(readinessRead);
    const call = resolve(gate.db, teamId, approvalId, decision, decider, note);
    call.catch(() => undefined);
    return { gate, call, decision, decider, note };
  }

  it.each([
    { first: "approved", second: "denied" },
    { first: "denied", second: "approved" },
    { first: "approved", second: "approved" },
    { first: "denied", second: "denied" },
  ] as Array<{ first: Decision; second: Decision }>)(
    "both requests pass readiness while the approval is pending; $first claims first, then $second: the first decision stands with its own decider and note, the second is already decided and writes, audits and dispatches nothing",
    async ({ first, second }) => {
      const a = await seedTeam();
      const rival = await addMember(a.teamId);
      const own = await seedLinkedTuple(a);
      const before = await durableState();
      const winner = contender(a.teamId, own.approvalId, first, a.memberId, FIRST_NOTE);
      const loser = contender(a.teamId, own.approvalId, second, rival, SECOND_NOTE);

      try {
        await reached(winner.gate, 1, [winner.call]);
        await reached(loser.gate, 1, [loser.call]);
        premise("both requests are past readiness and nothing is claimed yet", { ...(await durableState()), ...effects() }, {
          ...before,
          ...NO_EFFECTS,
        });

        winner.gate.release();
        const won = await winner.call;
        const settled = await durableState();
        const dispatchedByWinner = h.sandboxRun.mock.calls.length;
        loser.gate.release();
        const lost = await loser.call;

        expect({
          won: [won.status, won.actionId, won.actionStatus],
          dispatchedByWinner,
          lost: lost.status,
          ...(await durableState()),
          ...effects(),
        }).toEqual({
          won: [first, own.actionId, first === "approved" ? "succeeded" : "denied"],
          dispatchedByWinner: first === "approved" ? 1 : 0,
          lost: "already_decided",
          ...settled,
          ...NO_EFFECTS,
          sandboxRuns: first === "approved" ? 1 : 0,
        });
        expect(settled.approvals).toEqual([
          expect.objectContaining({ id: own.approvalId, status: first, decided_by: a.memberId, decision_note: FIRST_NOTE }),
        ]);
        expect(settled.actions).toEqual([
          expect.objectContaining({
            id: own.actionId,
            status: first === "approved" ? "succeeded" : "denied",
            approval_request_id: own.approvalId,
          }),
        ]);
        const written = auditSince(before.audit, settled.audit);
        expect({ byLoser: written.filter((row) => row.member_id === rival), ...decisionEvents(written) }).toEqual({
          byLoser: [],
          approval: [`approval.${first}`],
          terminal: first === "approved" ? ["action.succeeded"] : [],
        });
      } finally {
        winner.gate.release();
        loser.gate.release();
        await Promise.allSettled([winner.call, loser.call]);
      }
    },
  );

  it.each([
    { tuple: "linked", left: "approved", right: "denied" },
    { tuple: "linked", left: "approved", right: "approved" },
    { tuple: "linked", left: "denied", right: "denied" },
    { tuple: "standalone", left: "approved", right: "denied" },
    { tuple: "standalone", left: "approved", right: "approved" },
  ] as Array<{ tuple: "linked" | "standalone"; left: Decision; right: Decision }>)(
    "$tuple approval · $left and $right released together after both passed readiness: exactly one claim wins in Postgres, the stored decision is wholly the winner's, and the action is dispatched at most once and only for a winning approve",
    async ({ tuple, left, right }) => {
      const a = await seedTeam();
      const rival = await addMember(a.teamId);
      const own = tuple === "linked" ? await seedLinkedTuple(a) : { approvalId: await seedApproval(a), actionId: null };
      const before = await durableState();
      const contenders = [
        contender(a.teamId, own.approvalId, left, a.memberId, FIRST_NOTE),
        contender(a.teamId, own.approvalId, right, rival, SECOND_NOTE),
      ];
      const calls = contenders.map((each) => each.call);

      try {
        for (const each of contenders) await reached(each.gate, 1, [each.call]);
        premise("both requests are past readiness and nothing is claimed yet", { ...(await durableState()), ...effects() }, {
          ...before,
          ...NO_EFFECTS,
        });

        for (const each of contenders) each.gate.release();
        const outcomes = await Promise.all(calls);

        const after = await durableState();
        const winners = contenders.filter((_, index) => outcomes[index].status !== "already_decided");
        expect(outcomes.map((outcome) => outcome.status).filter((status) => status === "already_decided")).toHaveLength(1);
        expect(winners).toHaveLength(1);
        const [winner] = winners;
        expect(outcomes[contenders.indexOf(winner)].status).toBe(winner.decision);
        expect(after.approvals).toEqual([
          expect.objectContaining({
            id: own.approvalId,
            status: winner.decision,
            decided_by: winner.decider,
            decision_note: winner.note,
          }),
        ]);
        const dispatched = tuple === "linked" && winner.decision === "approved";
        expect(after.actions).toEqual(
          tuple === "linked"
            ? [expect.objectContaining({ id: own.actionId, status: dispatched ? "succeeded" : "denied" })]
            : [],
        );
        const written = auditSince(before.audit, after.audit);
        const loser = contenders.find((each) => each !== winner);
        expect({
          sandboxRuns: h.sandboxRun.mock.calls.length,
          faultEvents: effects().faultEvents,
          byLoser: written.filter((row) => row.member_id === loser?.decider),
          ...decisionEvents(written),
        }).toEqual({
          sandboxRuns: dispatched ? 1 : 0,
          faultEvents: 0,
          byLoser: [],
          approval: [`approval.${winner.decision}`],
          terminal: dispatched ? ["action.succeeded"] : [],
        });
      } finally {
        for (const each of contenders) each.gate.release();
        await Promise.allSettled(calls);
      }
    },
  );

  it.each(DECISIONS)(
    "dashboard: two administrators decide the same linked approval at once (approved vs %s): exactly one confirmed result and one revalidation, the other is already decided by someone else, and the sandbox runs at most once",
    async (rivalDecision) => {
      const a = await seedTeam();
      const rival = await addMember(a.teamId);
      const firstAdmin = await signIn(a.teamId, a.memberId, "admin");
      const rivalAdmin = await signIn(a.teamId, rival, "admin");
      const own = await seedLinkedTuple(a);
      const before = await durableState();
      const deciders = [
        { member: a.memberId, decision: "approved" as Decision, note: FIRST_NOTE },
        { member: rival, decision: rivalDecision, note: SECOND_NOTE },
      ];
      const gate = gatedDb(readinessRead);
      const calls: Array<Promise<ActionResult>> = [];
      const start = (user: { id: string; email: string }, decider: (typeof deciders)[number]) => {
        h.sessionUser = user;
        const call = decideApproval(a.teamSlug, own.approvalId, decider.decision, decider.note);
        call.catch(() => undefined);
        calls.push(call);
      };

      try {
        h.actionDb = gate.db;
        // Each request is admitted under its own identity before the next one starts.
        start(firstAdmin, deciders[0]);
        await reached(gate, 1, calls);
        start(rivalAdmin, deciders[1]);
        await reached(gate, 2, calls);
        premise("both requests are past readiness and nothing is claimed yet", { ...(await durableState()), ...effects() }, {
          ...before,
          ...NO_EFFECTS,
        });

        gate.release();
        const results = await Promise.all(calls);

        const after = await durableState();
        const stored = after.approvals[0];
        const winner = deciders.find((decider) => decider.member === stored.decided_by);
        expect(after.approvals).toEqual([
          expect.objectContaining({ id: own.approvalId, status: winner?.decision, decision_note: winner?.note }),
        ]);
        const confirmed = results.filter((result) => result.ok);
        expect(confirmed).toHaveLength(1);
        expect(confirmed[0].message).toMatch(winner?.decision === "approved" ? /Approved.*succeeded/ : /Denied/);
        expect(results.filter((result) => !result.ok)).toEqual([ALREADY_DECIDED]);
        expect(after.actions).toEqual([
          expect.objectContaining({ id: own.actionId, status: winner?.decision === "approved" ? "succeeded" : "denied" }),
        ]);
        expect(effects()).toEqual({
          sandboxRuns: winner?.decision === "approved" ? 1 : 0,
          revalidated: [approvalsPath(a.teamSlug)],
          governedDecides: 0,
          faultEvents: 0,
        });
        const written = auditSince(before.audit, after.audit);
        expect({
          approvalDeciders: written.filter((row) => String(row.action).startsWith("approval.")).map((row) => row.member_id),
          ...decisionEvents(written),
        }).toEqual({
          approvalDeciders: [winner?.member],
          approval: [`approval.${winner?.decision}`],
          terminal: winner?.decision === "approved" ? ["action.succeeded"] : [],
        });
      } finally {
        gate.release();
        h.actionDb = null;
        await Promise.allSettled(calls);
      }
    },
  );
});
