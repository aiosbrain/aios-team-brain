import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { PgClient } from "@/lib/db/pg/client";
import { getPool } from "@/lib/db/pg/pool";
import type { DbClient } from "@/lib/db/types";
import { db, placeMemberByTier, seedTeam, type Seed } from "./helpers";

/**
 * AIO-1217 — legacy approval PERSISTENCE FAULTS against real Postgres (AC-08, fault half).
 *
 * Every assertion is derived from the accepted specification's decision table and persistence-fault
 * contract, not from the implementation. The lookup/claim side with no fault injected (governed
 * routing, link cardinality, readiness, precedence, standalone, competing claims) lives in
 * `server-action-approval-mechanics.datamechanics.test.ts` and is not repeated here.
 *
 *   F0 — ownership reads that fail are faults, never absence.
 *   F1 — the approval claim: a returned error or a throw assumes no decision; a genuinely lost claim
 *        is the normal already-decided outcome and is not a fault.
 *   F2 — post-claim prepare (approve) and deny: the human decision stays durable, nothing dispatches.
 *   F3 — [controls] handler success / returned failure / throw / missing handler with a confirmed
 *        terminal write, through the resolver and through the shared `runAction`.
 *   F4 — the terminal write kept apart from the handler outcome: completion uncertain, the outcome is
 *        not rewritten, nothing is replayed, no terminal event is fabricated.
 *   F5 — `runAction` requested→denied / →pending_approval link / →running, checked before any
 *        downstream effect.
 *   F6 — the dashboard action maps every such fault to "could not decide" and does not revalidate.
 *   F7 — projection observation: which statements actually loaded the execution payload.
 *
 * What is real: `resolveApproval`, `runAction`, `decideApproval`, `requireTeamAdmin`, the policy
 * engine, the built-in `code.run` handler (F6), the audit writer, and a real `PgClient` over the test
 * pool. Fixtures, barriers and every durable readback go straight to the pool, never through the
 * client under test. What is stubbed: "who is signed in", `revalidatePath`, the sandbox factory (its
 * `run` records and allocates nothing), `governedActions.decide`, and — in the direct resolver and
 * `runAction` cases — the `code.run` handler, replaced by a recording handler so each outcome is
 * deterministic.
 *
 * HOW A FAULT IS INJECTED — and what each form does and does not prove. `faultDb` wraps the builder
 * a real `PgClient` returns and identifies one statement by what the caller built (table, operation,
 * the status being written). It fires once; a later matching statement is NOT intercepted, so a
 * second write over the first would land and be read back.
 *
 *   returned error / throw    injected BEFORE the statement: Postgres never sees it. This is a
 *                             synthetic failure the test manufactures, not a driver failure.
 *   LOST RESPONSE             the statement really executes and commits (pool autocommit), THEN its
 *                             envelope is replaced by an error. The write stands; only the answer is lost.
 *   LOST RETURNING ACK        the statement really commits, THEN its returned rows are suppressed. The
 *                             caller sees zero rows for a write that happened — an uncertain ack, not
 *                             a genuine zero, and labelled apart from one.
 *   GENUINE ZERO ROWS         a barrier changes the row through the pool immediately before the
 *                             statement, which then really runs and really matches nothing.
 *
 * The barrier holds no connection (its own statement has returned before the held one starts) and
 * nothing depends on timing. Each test first proves, as a fixture premise, that its injection fired
 * exactly once in the labelled way; a premise failure is a broken fixture, not a security observation.
 *
 * Bounds of what is claimed. "not_started" means THIS invocation did not invoke the handler; it says
 * nothing about other workers. The sentinel check covers the new prefixed event and the thrown
 * error / returned result only: the adapter's own `[pg] …` stderr and the unchecked initial insert
 * are outside it, and no test asserts general console silence. F7 observes the statements issued
 * through the wrapped client and the rows Postgres returned to them; it is statement-level
 * instrumentation of this resolver, not a proof about any other reader. Audit is best effort, so the
 * oracle is the standing rows and the dispatch counts; audit is only checked for what must NOT appear.
 *
 * NOT covered here, and still owed elsewhere: the unchanged v1 route handler's 500 envelope, the
 * unit-tier fault cases, the 95-action denial fixtures and 15 scope connections, the People races,
 * the scanner, and the full validation run. Direct action execution is not Next action-wire proof,
 * and nothing here touches a live provider or the governed transaction.
 */

const FIXTURE = "FIXTURE PREMISE FAILED (setup, not a security observation):";

const h = vi.hoisted(() => ({
  sessionUser: null as { id: string; email: string } | null,
  /** When set, the client `adminClient()` hands the action under test: a fault-injecting adapter. */
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
// The real service client unless a test hands the action a fault-injecting adapter.
vi.mock("@/lib/db/admin", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/db/admin")>();
  return { ...original, adminClient: () => h.actionDb ?? original.adminClient() };
});

import { decideApproval } from "@/app/t/[team]/admin/approvals/actions";
import {
  LegacyActionPersistenceFault,
  resolveApproval,
  runAction,
  type ActionHandler,
  type ActionResult as HandlerResult,
  type SandboxRunner,
} from "@/lib/actions";
import { governedActions } from "@/lib/actions/governed";

type Row = Record<string, unknown>;
type Decision = "approved" | "denied";
type ActionStatus = "requested" | "denied" | "pending_approval" | "running" | "succeeded" | "failed";
type Envelope = { data: unknown; error: { message: string } | null; count: number | null };

const FAULT_EVENT = "[legacy_action_persistence_fault]";
const FAULT_MESSAGE = "action persistence unavailable";
const COULD_NOT_DECIDE = { ok: false, error: "could not decide" };

// Sentinels: each stands for a class of text that must never reach the new event or the caller.
const DRIVER_SENTINEL = "AIO1217_PG_DRIVER_SENTINEL";
const SQL_SENTINEL = "AIO1217_PRIVATE_SQL_SENTINEL";
const PRIVATE_PAYLOAD = "AIO1217_PRIVATE_PAYLOAD_SENTINEL";
const HANDLER_OUTPUT_SENTINEL = "AIO1217_HANDLER_OUTPUT_SENTINEL";
const HANDLER_ERROR = "AIO1217_HANDLER_ERROR_SENTINEL";
const SANDBOX_STDOUT = "AIO1217_SANDBOX_STDOUT_SENTINEL";
const SENTINELS = [DRIVER_SENTINEL, SQL_SENTINEL, PRIVATE_PAYLOAD, HANDLER_OUTPUT_SENTINEL, HANDLER_ERROR, SANDBOX_STDOUT];

const CODE_PARAMS = { language: "python", code: `print('${PRIVATE_PAYLOAD}')` };
/** What a leaky driver error would carry: its own text, the statement and the bound params. */
const DRIVER_MESSAGE = `${DRIVER_SENTINEL}: UPDATE actions SET status = $1 /* ${SQL_SENTINEL} */ params=${JSON.stringify(CODE_PARAMS)}`;
const HANDLER_OUTPUT = { marker: HANDLER_OUTPUT_SENTINEL };
const REQUESTER_ACTOR = "aio1217-fixture-requester";
const DECISION_NOTE = "aio1217 synthetic decision note";
const RIVAL_NOTE = "aio1217 rival decision note";
const DECISIONS: Decision[] = ["approved", "denied"];

/** The identifiers a readiness check may read before the tenant match is established. */
const MINIMAL_ACTION_COLUMNS = ["approval_request_id", "id", "status", "team_id"];
/** The approval's owner identifiers and context markers. */
const APPROVAL_OWNER_COLUMNS = ["context", "id", "status"];
/** The execution payload: loaded only by the team-bound, confirmed prepare. */
const PAYLOAD_COLUMNS = ["action_type", "actor", "member_id", "params", "resource", "result"];

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
  // Never the real governed transaction: nothing in this file is governed.
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

const isRow = (value: unknown): value is Row => typeof value === "object" && value !== null && !Array.isArray(value);
const recordingSandbox = (): SandboxRunner => ({ configured: true, run: h.sandboxRun });

/** Postgres timestamptz wire text: `YYYY-MM-DD HH:mm:ss[.ffffff]±HH[:MM]` (the short `+00` included). */
const PG_TIMESTAMPTZ = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})(\.\d{1,6})?([+-])(\d{2})(?::(\d{2}))?$/;

/**
 * The pool keeps timestamptz as the wire string (`lib/db/pg/pool.ts`), so a readback is never a
 * `Date`. True only for that exact text naming a real instant: every component is range-checked and
 * the day must exist in its month — nothing is left to `Date.parse` coercion.
 */
function isPgTimestamptz(value: unknown): boolean {
  if (typeof value !== "string") return false;
  const match = PG_TIMESTAMPTZ.exec(value);
  if (!match) return false;
  const [year, month, day, hour, minute, second] = match.slice(1, 7).map(Number);
  const offsetHour = Number(match[9]);
  const offsetMinute = Number(match[10] ?? "00");
  if (month < 1 || month > 12 || day < 1 || hour > 23 || minute > 59 || second > 59) return false;
  if (offsetHour > 15 || offsetMinute > 59) return false;
  // A day that does not exist (Feb 30) rolls over; it must come back as the same calendar day.
  const calendar = new Date(Date.UTC(year, month - 1, day));
  if (calendar.getUTCFullYear() !== year || calendar.getUTCMonth() !== month - 1 || calendar.getUTCDate() !== day) return false;
  // Normalized for parsing only: `T` separator, millisecond fraction, full `±HH:MM` offset.
  const millis = (match[7] ?? ".").slice(1, 4).padEnd(3, "0");
  const iso = `${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6]}.${millis}${match[8]}${match[9]}:${match[10] ?? "00"}`;
  return Number.isFinite(Date.parse(iso));
}

/** Asymmetric matcher for one column of a full-row comparison: a valid timestamptz string, whatever its instant. */
const pgTimestamptz = {
  $$typeof: Symbol.for("jest.asymmetricMatcher"),
  asymmetricMatch: (value: unknown) => isPgTimestamptz(value),
  toAsymmetricMatcher: () => "PgTimestamptz",
};

/** Fresh readbacks straight from the pool: the standing rows, whatever any adapter reported. */
async function durableState() {
  return {
    approvals: await fx("approval readback", `select * from approval_requests order by id`),
    actions: await fx("action readback", `select * from actions order by id`),
    audit: await fx(
      "audit readback",
      `select id::text as id, team_id, actor_kind, member_id, api_key_id, action, target_type, target_id, meta
         from audit_log order by audit_log.id`,
    ),
  };
}

/** The audit actions written since `before` (the table is append-only and read in identity order). */
function auditedSince(before: Row[], after: Row[]): string[] {
  premise("audit prefix is append-only", after.slice(0, before.length), before);
  return after.slice(before.length).map((row) => String(row.action));
}

const terminalAudits = (audited: string[]) => audited.filter((action) => action === "action.succeeded" || action === "action.failed");

/**
 * After a post-claim fault the only event that may exist is the durable decision's own, at most once
 * (audit is best effort, so its presence is not required). Anything else would be a fabricated event.
 */
function expectDecisionAuditAtMost(audited: string[], decision: Decision): void {
  expect(audited.filter((action) => action !== `approval.${decision}`)).toEqual([]);
  expect(audited.length).toBeLessThanOrEqual(1);
}

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

/** Bind the seed member to a fresh auth user as an admin and make that auth user the signed-in identity. */
async function signInAdmin(owner: Seed): Promise<void> {
  const user = { id: randomUUID(), email: `${randomUUID()}@test.local` };
  await fxOne("auth user insert", `insert into auth_users(id, email) values($1, $2) returning id`, [user.id, user.email]);
  await fxOne(
    "member session binding",
    `update members set auth_user_id = $1, role = 'admin' where id = $2 and team_id = $3 and status = 'active' returning id`,
    [user.id, owner.memberId, owner.teamId],
  );
  h.sessionUser = user;
}

/** A pending approval whose context carries the private params plus whatever markers the case needs. */
async function seedApproval(owner: Seed, context: Row = {}): Promise<string> {
  const id = randomUUID();
  await fxOne(
    "approval insert",
    `insert into approval_requests(id, team_id, requested_by_member, requested_by_actor, action, resource, context, status)
     values($1, $2, $3, $4, 'code.run', 'code:fixture', $5::jsonb, 'pending') returning id`,
    [id, owner.teamId, owner.memberId, REQUESTER_ACTOR, JSON.stringify({ params: CODE_PARAMS, ...context })],
  );
  return id;
}

async function seedAction(
  owner: Seed,
  opts: { id?: string; status?: ActionStatus; approvalId?: string | null } = {},
): Promise<string> {
  const id = opts.id ?? randomUUID();
  await fxOne(
    "action insert",
    `insert into actions(id, team_id, member_id, actor, action_type, resource, params, status, decision, approval_request_id)
     values($1, $2, $3, $4, 'code.run', 'code:fixture', $5::jsonb, $6::action_status, 'require_approval', $7) returning id`,
    [id, owner.teamId, owner.memberId, REQUESTER_ACTOR, JSON.stringify(CODE_PARAMS), opts.status ?? "pending_approval", opts.approvalId ?? null],
  );
  return id;
}

/** A consistent legacy tuple: forward marker and reverse link agree, the action is `pending_approval`. */
async function seedLinkedTuple(owner: Seed): Promise<{ approvalId: string; actionId: string }> {
  const actionId = randomUUID();
  const approvalId = await seedApproval(owner, { action_id: actionId });
  await seedAction(owner, { id: actionId, approvalId });
  return { approvalId, actionId };
}

async function policy(teamId: string, effect: "allow" | "deny" | "require_approval"): Promise<void> {
  await fxOne(
    "policy insert",
    `insert into policies(team_id, action, resource, effect) values($1, 'code.run', '*', $2::policy_effect) returning id`,
    [teamId, effect],
  );
}

// ── recording handlers ───────────────────────────────────────────────────────────────────────────

type HandlerKind = "succeeded" | "returned_failure" | "threw" | "missing_handler";
const HANDLER_KINDS: HandlerKind[] = ["succeeded", "returned_failure", "threw", "missing_handler"];
const TERMINAL: Record<HandlerKind, "succeeded" | "failed"> = {
  succeeded: "succeeded",
  returned_failure: "failed",
  threw: "failed",
  missing_handler: "failed",
};
/** Dispatch is actual handler invocation: a missing handler was never started. */
const DISPATCH: Record<HandlerKind, "attempted" | "not_started"> = {
  succeeded: "attempted",
  returned_failure: "attempted",
  threw: "attempted",
  missing_handler: "not_started",
};
const INVOCATIONS: Record<HandlerKind, number> = { succeeded: 1, returned_failure: 1, threw: 1, missing_handler: 0 };

/** A `code.run` handler with one fixed outcome; `execute` is the dispatch recorder. */
function recordingHandler(kind: HandlerKind) {
  const execute = vi.fn<ActionHandler["execute"]>(async (): Promise<HandlerResult> => {
    if (kind === "threw") throw new Error(HANDLER_ERROR);
    if (kind === "returned_failure") return { ok: false, error: HANDLER_ERROR };
    return { ok: true, output: HANDLER_OUTPUT };
  });
  const handlers: ActionHandler[] = kind === "missing_handler" ? [] : [{ type: "code.run", execute }];
  return { execute, handlers };
}

const resolve = (client: DbClient, decider: Seed, approvalRequestId: string, decision: Decision, handlers?: ActionHandler[]) =>
  resolveApproval(
    client,
    { teamId: decider.teamId, approvalRequestId, decision, deciderMemberId: decider.memberId, note: DECISION_NOTE },
    { sandbox: recordingSandbox(), ...(handlers ? { handlers } : {}) },
  );

const produce = (client: DbClient, requester: Seed, handlers: ActionHandler[]) =>
  runAction(
    client,
    {
      teamId: requester.teamId,
      memberId: requester.memberId,
      principal: { role: "member", tier: "team", actor: REQUESTER_ACTOR },
      request: { type: "code.run", resource: "code:fixture", params: CODE_PARAMS },
    },
    { sandbox: recordingSandbox(), handlers },
  );

// ── fault-injecting adapter ──────────────────────────────────────────────────────────────────────

type Operation = "select" | "insert" | "update" | "upsert" | "delete";
/** What the caller built, read off the builder calls — never off the SQL text. */
type Built = { table: string; operation: Operation; payload: unknown; filters: Array<[string, unknown]> };
type Matcher = (statement: Built) => boolean;
type Injection = "error" | "throw" | "lost-ack-error" | "lost-ack-empty";
type Rule = { at: Matcher; before?: () => Promise<void>; inject?: Injection };
/** One statement issued through the wrapped client, with what Postgres actually returned to it. */
type Statement = {
  table: string;
  operation: Operation;
  /** The status a mutation writes, if any. */
  to: string | null;
  /** The value of the statement's `team_id` equality filter; null when it is not team-bound. */
  team: unknown;
  executed: boolean;
  failed: boolean;
  rows: number;
  /** The columns of the rows Postgres returned. */
  columns: string[];
  /** The rows Postgres returned carried the private payload sentinel. */
  payload: boolean;
};
type Fired = Statement & { mode: Injection | "barrier" };
type FaultDb = { db: DbClient; statements: Statement[]; fired: Fired[] };

const statusOf = (payload: unknown): string | null => (isRow(payload) && typeof payload.status === "string" ? payload.status : null);
const returnedRows = (data: unknown): Row[] => (Array.isArray(data) ? data.filter(isRow) : isRow(data) ? [data] : []);

/**
 * A real pg adapter whose builders are observed, and where at most one statement is faulted.
 * With no rule it is a plain recording tap.
 */
function faultDb(rule?: Rule): FaultDb {
  const real = new PgClient();
  const statements: Statement[] = [];
  const fired: Fired[] = [];
  let armed: Rule | null = rule ?? null;

  const from = (table: string) => {
    const target = real.from(table);
    const built: Built = { table, operation: "select", payload: undefined, filters: [] };

    const run = async (): Promise<Envelope> => {
      const hit = armed !== null && armed.at(built) ? armed : null;
      if (hit) armed = null;
      const shape = {
        table,
        operation: built.operation,
        to: statusOf(built.payload),
        team: built.filters.find(([column]) => column === "team_id")?.[1] ?? null,
      };
      const execute = async (): Promise<{ result: Envelope; seen: Statement }> => {
        const result = (await target) as Envelope;
        const rows = returnedRows(result.data);
        const seen: Statement = {
          ...shape,
          executed: true,
          failed: result.error !== null,
          rows: rows.length,
          columns: [...new Set(rows.flatMap((row) => Object.keys(row)))].sort(),
          payload: JSON.stringify(result.data ?? null).includes(PRIVATE_PAYLOAD),
        };
        statements.push(seen);
        return { result, seen };
      };

      if (!hit) return (await execute()).result;
      if (hit.before) await hit.before();
      if (hit.inject === "error" || hit.inject === "throw") {
        const skipped: Statement = { ...shape, executed: false, failed: false, rows: 0, columns: [], payload: false };
        statements.push(skipped);
        fired.push({ ...skipped, mode: hit.inject });
        if (hit.inject === "throw") throw new Error(DRIVER_MESSAGE);
        return { data: null, error: { message: DRIVER_MESSAGE }, count: null };
      }
      const { result, seen } = await execute();
      fired.push({ ...seen, mode: hit.inject ?? "barrier" });
      if (hit.inject === "lost-ack-error") return { data: null, error: { message: DRIVER_MESSAGE }, count: null };
      if (hit.inject === "lost-ack-empty") return { data: [], error: null, count: null };
      return result;
    };

    const proxy: object = new Proxy(target, {
      get(builder, prop) {
        if (prop === "then") {
          return (onFulfilled?: ((value: Envelope) => unknown) | null, onRejected?: ((reason: unknown) => unknown) | null) =>
            run().then(onFulfilled, onRejected);
        }
        const member: unknown = Reflect.get(builder, prop, builder);
        if (typeof member !== "function") return member;
        return (...args: unknown[]) => {
          if (prop === "insert" || prop === "update" || prop === "upsert") {
            built.operation = prop;
            built.payload = args[0];
          } else if (prop === "delete") {
            built.operation = "delete";
          } else if (prop === "eq") {
            built.filters.push([String(args[0]), args[1]]);
          }
          const out: unknown = member.apply(builder, args);
          return out === builder ? proxy : out;
        };
      },
    });
    return proxy;
  };

  return {
    db: { from, rpc: real.rpc.bind(real), transaction: real.transaction.bind(real) } as unknown as DbClient,
    statements,
    fired,
  };
}

const reads = (table: string): Matcher => (statement) => statement.table === table && statement.operation === "select";
/** The transition that writes one of `to` — identified by the state it moves to, not by its predicate. */
const writes = (table: string, ...to: string[]): Matcher => (statement) =>
  statement.table === table &&
  statement.operation === "update" &&
  (to.length === 0 || to.includes(statusOf(statement.payload) ?? ""));

const ownerRead = reads("approval_requests");
const readinessRead = reads("actions");
const claimWrite = writes("approval_requests");
const runningWrite = writes("actions", "running");
const denyWrite = writes("actions", "denied");
const linkWrite = writes("actions", "pending_approval");
const terminalWrite = writes("actions", "succeeded", "failed");

const terminalWritesAttempted = (client: FaultDb) =>
  client.statements
    .filter((statement) => statement.table === "actions" && statement.operation === "update")
    .map((statement) => statement.to)
    .filter((to) => to === "succeeded" || to === "failed");

/** Statements on `actions` whose returned rows carried the execution payload, with their position. */
const actionPayloadReads = (client: FaultDb) =>
  client.statements
    .map((statement, index) => ({ ...statement, index }))
    .filter(
      (statement) =>
        statement.table === "actions" &&
        (statement.payload || statement.columns.some((column) => PAYLOAD_COLUMNS.includes(column))),
    );

// ── labelled faults ──────────────────────────────────────────────────────────────────────────────

type Displace = "status" | "link" | "team";
type Fault = { label: string; kind: Injection } | { label: string; kind: "zero"; displace: Displace };

const RETURNED_ERROR: Fault = { label: "returned error injected before the statement (synthetic; nothing executed)", kind: "error" };
const THROWN: Fault = { label: "throw injected before the statement (synthetic; nothing executed)", kind: "throw" };
const LOST_RESPONSE: Fault = {
  label: "LOST RESPONSE — the statement committed, then its envelope was replaced by an error",
  kind: "lost-ack-error",
};
const LOST_RETURNING: Fault = {
  label: "LOST RETURNING ACK — the statement committed, then its returned rows were suppressed (uncertain ack, not a genuine zero)",
  kind: "lost-ack-empty",
};
const DISPLACED: Record<Displace, string> = {
  status: "another writer moved the action to failed",
  link: "the action's approval link was cleared",
  team: "the action was re-homed to another team",
};
const zero = (displace: Displace): Fault => ({
  label: `GENUINE ZERO ROWS — ${DISPLACED[displace]} immediately before the statement`,
  kind: "zero",
  displace,
});

const committed = (fault: Fault) => fault.kind === "lost-ack-error" || fault.kind === "lost-ack-empty";

/** Change the one `from`-state action of `teamId` through the pool, guarded to exactly one row. */
async function displace(how: Displace, teamId: string, from: ActionStatus, otherTeamId: string): Promise<Row> {
  const guard = `where team_id = $1 and status = $2::action_status returning *`;
  if (how === "team") {
    return fxOne("barrier: re-home the action", `update actions set team_id = $3 ${guard}`, [teamId, from, otherTeamId]);
  }
  if (how === "link") {
    return fxOne("barrier: clear the approval link", `update actions set approval_request_id = null ${guard}`, [teamId, from]);
  }
  return fxOne("barrier: move the action to failed", `update actions set status = 'failed' ${guard}`, [teamId, from]);
}

const NO_BARRIER = (): Promise<Row> => Promise.reject(new Error(`${FIXTURE} this case arms no barrier`));

/** Arm one labelled fault at `at`; a genuine-zero fault runs `barrier` first and keeps the row it left. */
function arm(at: Matcher, fault: Fault, barrier: (how: Displace) => Promise<Row> = NO_BARRIER) {
  const displaced: { row: Row | null } = { row: null };
  const client =
    fault.kind === "zero"
      ? faultDb({
          at,
          before: async () => {
            displaced.row = await barrier(fault.displace);
          },
        })
      : faultDb({ at, inject: fault.kind });
  return { client, displaced };
}

function firedOnce(client: FaultDb, fault: Fault): void {
  premise(
    "the injection fired exactly once, at the intended statement, in the labelled way",
    client.fired.map(({ mode, executed, failed, rows }) => ({ mode, executed, failed, rows })),
    [
      {
        mode: fault.kind === "zero" ? "barrier" : fault.kind,
        executed: fault.kind === "zero" || committed(fault),
        failed: false,
        rows: committed(fault) ? 1 : 0,
      },
    ],
  );
}

/** The action row this invocation must have left, given what the faulted statement really did. */
function standing(fault: Fault, displacedRow: Row | null, untouched: unknown, afterCommit: unknown): unknown {
  if (fault.kind === "zero") return displacedRow;
  return committed(fault) ? afterCommit : untouched;
}

// ── fault observation ────────────────────────────────────────────────────────────────────────────

type Settled<T> = { value?: T; thrown?: unknown };

async function settle<T>(call: Promise<T>): Promise<Settled<T>> {
  try {
    return { value: await call };
  } catch (thrown) {
    return { thrown };
  }
}

const leaks = (value: unknown): string[] => {
  const text = JSON.stringify(value) ?? "";
  return SENTINELS.filter((sentinel) => text.includes(sentinel));
};

/** Everything an error object carries, including its stack and any cause. */
function exposed(thrown: unknown): Row {
  if (!(thrown instanceof Error)) return { thrown };
  return Object.fromEntries(
    Object.getOwnPropertyNames(thrown).map((key) => [key, String((thrown as unknown as Row)[key])]),
  );
}

/** The call did not settle; it raised the typed fault with the fixed message, no cause and no private text. */
function expectFault(settled: Settled<unknown>): void {
  expect({ settledWith: settled.value, typed: settled.thrown instanceof LegacyActionPersistenceFault }).toEqual({
    settledWith: undefined,
    typed: true,
  });
  const carried = exposed(settled.thrown);
  expect({ message: carried.message, name: carried.name, cause: carried.cause }).toEqual({
    message: FAULT_MESSAGE,
    name: "LegacyActionPersistenceFault",
    cause: undefined,
  });
  expect(leaks(carried)).toEqual([]);
}

const faultEvents = () => consoleError.mock.calls.filter((call) => call[0] === FAULT_EVENT);

/** Exactly these prefixed events, each with exactly the allowlisted fields and no private text. */
function expectFaultEvents(expected: Row[]): void {
  const events = faultEvents();
  expect(events).toStrictEqual(expected.map((fields) => [FAULT_EVENT, fields]));
  expect(leaks(events)).toEqual([]);
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// F0 — ownership reads
// ─────────────────────────────────────────────────────────────────────────────────────────────────

describe("AIO-1217 F0 · an ownership read that fails is a persistence fault, never absence or readiness (AC-08)", () => {
  it.each(
    [
      { read: "approval ownership read", at: ownerRead, phase: "approval_ownership" },
      { read: "linked-action readiness read", at: readinessRead, phase: "action_ownership" },
    ].flatMap((target) =>
      DECISIONS.flatMap((decision) => [RETURNED_ERROR, THROWN].map((fault) => ({ ...target, decision, fault }))),
    ),
  )(
    "$read · $decision · $fault.label: the fixed typed fault with phase $phase and no established action; nothing is claimed, dispatched or audited",
    async ({ at, phase, decision, fault }) => {
      const a = await seedTeam();
      const own = await seedLinkedTuple(a);
      const before = await durableState();
      const handler = recordingHandler("succeeded");
      const { client } = arm(at, fault);

      const settled = await settle(resolve(client.db, a, own.approvalId, decision, handler.handlers));

      firedOnce(client, fault);
      expectFault(settled);
      expectFaultEvents([
        { phase, teamId: a.teamId, actionId: null, approvalRequestId: own.approvalId, dispatch: "not_started" },
      ]);
      expect({
        ...(await durableState()),
        dispatched: handler.execute.mock.calls.length,
        sandboxRuns: h.sandboxRun.mock.calls.length,
        actionPayloadReads: actionPayloadReads(client),
      }).toEqual({ ...before, dispatched: 0, sandboxRuns: 0, actionPayloadReads: [] });
    },
  );
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// F1 — the approval claim
// ─────────────────────────────────────────────────────────────────────────────────────────────────

describe("AIO-1217 F1 · approval claim: a fault assumes no decision; a genuinely lost claim is already decided, not a fault (AC-08)", () => {
  it.each(
    DECISIONS.flatMap((decision) =>
      (["linked", "standalone"] as const).flatMap((tuple) => [RETURNED_ERROR, THROWN].map((fault) => ({ decision, tuple, fault }))),
    ),
  )(
    "$tuple approval · $decision · $fault.label: the fixed typed fault with phase approval_claim; the approval is still pending, the action untouched, and nothing is audited or dispatched",
    async ({ decision, tuple, fault }) => {
      const a = await seedTeam();
      const own = tuple === "linked" ? await seedLinkedTuple(a) : { approvalId: await seedApproval(a), actionId: null };
      const before = await durableState();
      const handler = recordingHandler("succeeded");
      const { client } = arm(claimWrite, fault);

      const settled = await settle(resolve(client.db, a, own.approvalId, decision, handler.handlers));

      firedOnce(client, fault);
      expectFault(settled);
      expectFaultEvents([
        { phase: "approval_claim", teamId: a.teamId, actionId: own.actionId, approvalRequestId: own.approvalId, dispatch: "not_started" },
      ]);
      expect({
        ...(await durableState()),
        dispatched: handler.execute.mock.calls.length,
        sandboxRuns: h.sandboxRun.mock.calls.length,
        actionPayloadReads: actionPayloadReads(client),
      }).toEqual({ ...before, dispatched: 0, sandboxRuns: 0, actionPayloadReads: [] });
    },
  );

  it.each(DECISIONS)(
    "LOST RESPONSE on the claim · %s — the claim committed, then its envelope was replaced by an error: the invocation raises the fault and assumes no decision (no audit, no dispatch); the readback shows the decision standing against a still-pending_approval action, and a retry is already decided without dispatch",
    async (decision) => {
      const a = await seedTeam();
      const own = await seedLinkedTuple(a);
      const before = await durableState();
      const handler = recordingHandler("succeeded");
      const { client } = arm(claimWrite, LOST_RESPONSE);

      const settled = await settle(resolve(client.db, a, own.approvalId, decision, handler.handlers));
      const after = await durableState();

      firedOnce(client, LOST_RESPONSE);
      expectFault(settled);
      expectFaultEvents([
        { phase: "approval_claim", teamId: a.teamId, actionId: own.actionId, approvalRequestId: own.approvalId, dispatch: "not_started" },
      ]);
      expect(after.approvals).toEqual([
        expect.objectContaining({ id: own.approvalId, team_id: a.teamId, status: decision, decided_by: a.memberId, decision_note: DECISION_NOTE }),
      ]);
      expect({
        actions: after.actions,
        audited: auditedSince(before.audit, after.audit),
        dispatched: handler.execute.mock.calls.length,
        sandboxRuns: h.sandboxRun.mock.calls.length,
      }).toEqual({ actions: before.actions, audited: [], dispatched: 0, sandboxRuns: 0 });

      // The operator signature stands; this invocation's retry does not resume or deny the action.
      const again = [
        (await resolve(db(), a, own.approvalId, "approved", handler.handlers)).status,
        (await resolve(db(), a, own.approvalId, "denied", handler.handlers)).status,
      ];
      expect({ again, ...(await durableState()), dispatched: handler.execute.mock.calls.length, faultEvents: faultEvents().length }).toEqual({
        again: ["already_decided", "already_decided"],
        ...after,
        dispatched: 0,
        faultEvents: 1,
      });
    },
  );

  it.each(DECISIONS)(
    "LOST RETURNING ACK on the claim · %s — the claim committed, then its returned rows were suppressed (uncertain ack, not a genuine zero): the invocation cannot confirm a win, so it answers already decided with no fault event, no audit and no dispatch; the readback shows its own decision standing against a still-pending_approval action",
    async (decision) => {
      const a = await seedTeam();
      const own = await seedLinkedTuple(a);
      const before = await durableState();
      const handler = recordingHandler("succeeded");
      const { client } = arm(claimWrite, LOST_RETURNING);

      const settled = await settle(resolve(client.db, a, own.approvalId, decision, handler.handlers));
      const after = await durableState();

      firedOnce(client, LOST_RETURNING);
      expect({ thrown: settled.thrown, status: settled.value?.status }).toEqual({ thrown: undefined, status: "already_decided" });
      expectFaultEvents([]);
      expect(after.approvals).toEqual([
        expect.objectContaining({ id: own.approvalId, team_id: a.teamId, status: decision, decided_by: a.memberId, decision_note: DECISION_NOTE }),
      ]);
      expect({
        actions: after.actions,
        audited: auditedSince(before.audit, after.audit),
        dispatched: handler.execute.mock.calls.length,
        sandboxRuns: h.sandboxRun.mock.calls.length,
      }).toEqual({ actions: before.actions, audited: [], dispatched: 0, sandboxRuns: 0 });
    },
  );

  it.each(DECISIONS)(
    "GENUINE ZERO ROWS on the claim · %s — a rival's opposite decision lands immediately before the claim statement, which then really matches nothing: the normal already-decided outcome, NOT a fault; the rival's decision stands unrewritten and nothing is audited or dispatched",
    async (decision) => {
      const a = await seedTeam();
      const rival = await addMember(a.teamId);
      const own = await seedLinkedTuple(a);
      const before = await durableState();
      const handler = recordingHandler("succeeded");
      const rivalDecision: Decision = decision === "approved" ? "denied" : "approved";
      const decided: { row: Row | null } = { row: null };
      const client = faultDb({
        at: claimWrite,
        before: async () => {
          decided.row = await fxOne(
            "barrier: the rival decision",
            `update approval_requests set status = $2::approval_status, decided_by = $3, decided_at = now(), decision_note = $4
              where id = $1 and status = 'pending' returning *`,
            [own.approvalId, rivalDecision, rival, RIVAL_NOTE],
          );
        },
      });

      const settled = await settle(resolve(client.db, a, own.approvalId, decision, handler.handlers));
      const after = await durableState();

      firedOnce(client, zero("status"));
      expect({ thrown: settled.thrown, status: settled.value?.status }).toEqual({ thrown: undefined, status: "already_decided" });
      expectFaultEvents([]);
      expect({
        approvals: after.approvals,
        actions: after.actions,
        audited: auditedSince(before.audit, after.audit),
        dispatched: handler.execute.mock.calls.length,
        sandboxRuns: h.sandboxRun.mock.calls.length,
      }).toEqual({ approvals: [decided.row], actions: before.actions, audited: [], dispatched: 0, sandboxRuns: 0 });
    },
  );
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// F2 — post-claim prepare and deny
// ─────────────────────────────────────────────────────────────────────────────────────────────────

describe("AIO-1217 F2 · after a won claim, a prepare or deny that cannot be confirmed keeps the human decision and dispatches nothing (AC-08)", () => {
  it.each(
    DECISIONS.flatMap((decision) =>
      [RETURNED_ERROR, THROWN, LOST_RESPONSE, LOST_RETURNING, zero("status"), zero("link"), zero("team")].map((fault) => ({
        decision,
        transition: decision === "approved" ? "prepare pending_approval→running" : "deny pending_approval→denied",
        fault,
      })),
    ),
  )(
    "$decision · $transition · $fault.label: the fixed typed fault, known not dispatched; the approval stays $decision by its decider, the action is left exactly where the statement left it, no terminal event exists, and a retry is already decided without dispatch",
    async ({ decision, fault }) => {
      const a = await seedTeam();
      const b = await seedTeam();
      const own = await seedLinkedTuple(a);
      const before = await durableState();
      const handler = recordingHandler("succeeded");
      const { client, displaced } = arm(decision === "approved" ? runningWrite : denyWrite, fault, (how) =>
        displace(how, a.teamId, "pending_approval", b.teamId),
      );

      const settled = await settle(resolve(client.db, a, own.approvalId, decision, handler.handlers));
      const after = await durableState();

      firedOnce(client, fault);
      expectFault(settled);
      expectFaultEvents([
        {
          phase: decision === "approved" ? "action_prepare" : "action_deny",
          teamId: a.teamId,
          actionId: own.actionId,
          approvalRequestId: own.approvalId,
          dispatch: "not_started",
        },
      ]);
      // The human decision is durable and is not undone.
      expect(after.approvals).toEqual([
        expect.objectContaining({ id: own.approvalId, team_id: a.teamId, status: decision, decided_by: a.memberId, decision_note: DECISION_NOTE }),
      ]);
      expect(after.approvals[0].decided_at).not.toBeNull();
      expect(after.actions).toEqual([
        standing(fault, displaced.row, before.actions[0], {
          ...before.actions[0],
          status: decision === "approved" ? "running" : "denied",
          updated_at: pgTimestamptz,
        }),
      ]);
      expect({ dispatched: handler.execute.mock.calls.length, sandboxRuns: h.sandboxRun.mock.calls.length }).toEqual({
        dispatched: 0,
        sandboxRuns: 0,
      });
      const audited = auditedSince(before.audit, after.audit);
      expectDecisionAuditAtMost(audited, decision);
      expect(terminalAudits(audited)).toEqual([]);

      // No automatic replay: the decided approval is never resumed, denied or dispatched by a retry.
      const again = [
        (await resolve(db(), a, own.approvalId, "approved", handler.handlers)).status,
        (await resolve(db(), a, own.approvalId, "denied", handler.handlers)).status,
      ];
      expect({ again, ...(await durableState()), dispatched: handler.execute.mock.calls.length, faultEvents: faultEvents().length }).toEqual({
        again: ["already_decided", "already_decided"],
        ...after,
        dispatched: 0,
        faultEvents: 1,
      });
    },
  );
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// F3 — handler outcome controls
// ─────────────────────────────────────────────────────────────────────────────────────────────────

describe("AIO-1217 F3 · [controls] each handler outcome with a confirmed terminal write is a normal settled result, not a fault (AC-08)", () => {
  it.each(HANDLER_KINDS)(
    "[control] resolver · handler %s: the approval is approved, the action reaches its confirmed terminal status with exactly the expected handler invocations, one terminal event, and no fault event",
    async (kind) => {
      const a = await seedTeam();
      const own = await seedLinkedTuple(a);
      const before = await durableState();
      const handler = recordingHandler(kind);
      const client = faultDb();

      const outcome = await resolve(client.db, a, own.approvalId, "approved", handler.handlers);
      const after = await durableState();

      expect(outcome).toMatchObject({ approvalRequestId: own.approvalId, status: "approved", actionId: own.actionId, actionStatus: TERMINAL[kind] });
      if (kind === "succeeded") expect(outcome.result).toEqual(HANDLER_OUTPUT);
      expect(handler.execute).toHaveBeenCalledTimes(INVOCATIONS[kind]);
      expect(after.approvals).toEqual([expect.objectContaining({ id: own.approvalId, status: "approved", decided_by: a.memberId })]);
      expect(after.actions).toEqual([
        expect.objectContaining({ id: own.actionId, team_id: a.teamId, status: TERMINAL[kind], approval_request_id: own.approvalId }),
      ]);
      if (kind === "succeeded") expect(after.actions[0].result).toEqual({ output: HANDLER_OUTPUT });
      expect({
        terminalWrites: terminalWritesAttempted(client),
        audited: auditedSince(before.audit, after.audit),
        sandboxRuns: h.sandboxRun.mock.calls.length,
        faultEvents: faultEvents().length,
      }).toEqual({
        terminalWrites: [TERMINAL[kind]],
        audited: ["approval.approved", `action.${TERMINAL[kind]}`],
        sandboxRuns: 0,
        faultEvents: 0,
      });
    },
  );

  it.each(HANDLER_KINDS)(
    "[control] runAction · handler %s: the allowed action reaches its confirmed terminal status with exactly the expected handler invocations, one terminal event, and no fault event",
    async (kind) => {
      const a = await seedTeam();
      await policy(a.teamId, "allow");
      const before = await durableState();
      const handler = recordingHandler(kind);
      const client = faultDb();

      const outcome = await produce(client.db, a, handler.handlers);
      const after = await durableState();

      expect(after.actions).toEqual([
        expect.objectContaining({ team_id: a.teamId, member_id: a.memberId, status: TERMINAL[kind], approval_request_id: null }),
      ]);
      expect(outcome).toMatchObject({ actionId: after.actions[0].id, status: TERMINAL[kind], decision: "allow" });
      if (kind === "succeeded") {
        expect(outcome.result).toEqual(HANDLER_OUTPUT);
        expect(after.actions[0].result).toEqual({ output: HANDLER_OUTPUT });
      }
      expect(handler.execute).toHaveBeenCalledTimes(INVOCATIONS[kind]);
      expect({
        approvals: after.approvals,
        terminalWrites: terminalWritesAttempted(client),
        audited: auditedSince(before.audit, after.audit),
        sandboxRuns: h.sandboxRun.mock.calls.length,
        faultEvents: faultEvents().length,
      }).toEqual({
        approvals: [],
        terminalWrites: [TERMINAL[kind]],
        audited: [`action.${TERMINAL[kind]}`],
        sandboxRuns: 0,
        faultEvents: 0,
      });
    },
  );
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// F4 — terminal persistence, apart from the handler outcome
// ─────────────────────────────────────────────────────────────────────────────────────────────────

describe("AIO-1217 F4 · a terminal write that cannot be confirmed is uncertain completion: the handler outcome is not rewritten, replayed or announced (AC-08)", () => {
  const RESOLVER_CASES: Array<{ kind: HandlerKind; fault: Fault }> = [
    ...HANDLER_KINDS.flatMap((kind) => [RETURNED_ERROR, THROWN, zero("status")].map((fault) => ({ kind, fault }))),
    { kind: "succeeded", fault: zero("team") },
    ...(["succeeded", "returned_failure"] as HandlerKind[]).flatMap((kind) =>
      [LOST_RESPONSE, LOST_RETURNING].map((fault) => ({ kind, fault })),
    ),
  ];

  it.each(RESOLVER_CASES)(
    "resolver · handler $kind · terminal write · $fault.label: the fixed typed fault carrying the true outcome; exactly one terminal write was attempted and it was not relabelled, the action is left exactly where that statement left it, no terminal event exists, and a retry neither replays the handler nor decides again",
    async ({ kind, fault }) => {
      const a = await seedTeam();
      const b = await seedTeam();
      const own = await seedLinkedTuple(a);
      const before = await durableState();
      const handler = recordingHandler(kind);
      const { client, displaced } = arm(terminalWrite, fault, (how) => displace(how, a.teamId, "running", b.teamId));

      const settled = await settle(resolve(client.db, a, own.approvalId, "approved", handler.handlers));
      const after = await durableState();

      firedOnce(client, fault);
      expectFault(settled);
      expectFaultEvents([
        {
          phase: "action_finish",
          teamId: a.teamId,
          actionId: own.actionId,
          approvalRequestId: own.approvalId,
          dispatch: DISPATCH[kind],
          outcome: kind,
        },
      ]);
      expect(handler.execute).toHaveBeenCalledTimes(INVOCATIONS[kind]);
      // One terminal write, carrying what the handler actually did — never a second "failed" over it.
      expect(terminalWritesAttempted(client)).toEqual([TERMINAL[kind]]);
      expect(after.approvals).toEqual([
        expect.objectContaining({ id: own.approvalId, team_id: a.teamId, status: "approved", decided_by: a.memberId }),
      ]);
      expect(after.actions).toEqual([
        standing(
          fault,
          displaced.row,
          { ...before.actions[0], status: "running", updated_at: pgTimestamptz },
          expect.objectContaining({ id: own.actionId, team_id: a.teamId, status: TERMINAL[kind], approval_request_id: own.approvalId }),
        ),
      ]);
      const audited = auditedSince(before.audit, after.audit);
      expectDecisionAuditAtMost(audited, "approved");
      expect(terminalAudits(audited)).toEqual([]);

      const again = [
        (await resolve(db(), a, own.approvalId, "approved", handler.handlers)).status,
        (await resolve(db(), a, own.approvalId, "denied", handler.handlers)).status,
      ];
      expect({
        again,
        ...(await durableState()),
        dispatched: handler.execute.mock.calls.length,
        sandboxRuns: h.sandboxRun.mock.calls.length,
        faultEvents: faultEvents().length,
      }).toEqual({
        again: ["already_decided", "already_decided"],
        ...after,
        dispatched: INVOCATIONS[kind],
        sandboxRuns: 0,
        faultEvents: 1,
      });
    },
  );

  const RUN_ACTION_CASES: Array<{ kind: HandlerKind; fault: Fault }> = [
    ...HANDLER_KINDS.map((kind) => ({ kind, fault: RETURNED_ERROR })),
    ...[THROWN, zero("status"), LOST_RESPONSE].map((fault) => ({ kind: "succeeded" as HandlerKind, fault })),
  ];

  it.each(RUN_ACTION_CASES)(
    "runAction · handler $kind · terminal write · $fault.label: the fixed typed fault carrying the true outcome and no settled response; exactly one terminal write was attempted and it was not relabelled, the one action is left exactly where that statement left it, and no action event exists",
    async ({ kind, fault }) => {
      const a = await seedTeam();
      const b = await seedTeam();
      await policy(a.teamId, "allow");
      const before = await durableState();
      const handler = recordingHandler(kind);
      const { client, displaced } = arm(terminalWrite, fault, (how) => displace(how, a.teamId, "running", b.teamId));

      const settled = await settle(produce(client.db, a, handler.handlers));
      const after = await durableState();

      firedOnce(client, fault);
      expectFault(settled);
      premise("the producer recorded exactly one action", after.actions.length, 1);
      expectFaultEvents([
        { phase: "action_finish", teamId: a.teamId, actionId: after.actions[0].id, dispatch: DISPATCH[kind], outcome: kind },
      ]);
      expect(handler.execute).toHaveBeenCalledTimes(INVOCATIONS[kind]);
      expect(terminalWritesAttempted(client)).toEqual([TERMINAL[kind]]);
      expect(after.actions).toEqual([
        standing(
          fault,
          displaced.row,
          expect.objectContaining({ team_id: a.teamId, status: "running", approval_request_id: null, result: {} }),
          expect.objectContaining({ team_id: a.teamId, status: TERMINAL[kind], approval_request_id: null }),
        ),
      ]);
      expect({
        approvals: after.approvals,
        actionEvents: auditedSince(before.audit, after.audit).filter((action) => action.startsWith("action.")),
        sandboxRuns: h.sandboxRun.mock.calls.length,
      }).toEqual({ approvals: [], actionEvents: [], sandboxRuns: 0 });
    },
  );
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// F5 — runAction request transitions
// ─────────────────────────────────────────────────────────────────────────────────────────────────

describe("AIO-1217 F5 · runAction checks requested→denied, the pending_approval link and requested→running before any downstream effect (AC-08)", () => {
  type RequestTransition = {
    transition: string;
    effect: "allow" | "deny" | "require_approval";
    to: "denied" | "pending_approval" | "running";
    phase: string;
  };
  const DENY: RequestTransition = { transition: "requested→denied", effect: "deny", to: "denied", phase: "request_deny" };
  const LINK: RequestTransition = {
    transition: "requested→pending_approval link",
    effect: "require_approval",
    to: "pending_approval",
    phase: "request_approval_link",
  };
  const RUNNING: RequestTransition = { transition: "requested→running", effect: "allow", to: "running", phase: "request_running" };
  const AT: Record<RequestTransition["to"], Matcher> = { denied: denyWrite, pending_approval: linkWrite, running: runningWrite };

  const CASES: Array<RequestTransition & { fault: Fault }> = [
    ...[DENY, LINK, RUNNING].flatMap((request) => [RETURNED_ERROR, THROWN, zero("status")].map((fault) => ({ ...request, fault }))),
    { ...RUNNING, fault: LOST_RESPONSE },
  ];

  it.each(CASES)(
    "$transition · $fault.label: the fixed typed fault with phase $phase and no settled response; the handler is never invoked, the action is left exactly where the statement left it, and no action event exists",
    async ({ effect, to, phase, fault }) => {
      const a = await seedTeam();
      const b = await seedTeam();
      await policy(a.teamId, effect);
      const before = await durableState();
      const handler = recordingHandler("succeeded");
      const { client, displaced } = arm(AT[to], fault, (how) => displace(how, a.teamId, "requested", b.teamId));

      const settled = await settle(produce(client.db, a, handler.handlers));
      const after = await durableState();

      firedOnce(client, fault);
      expectFault(settled);
      premise("the producer recorded exactly one action", after.actions.length, 1);
      premise("an approval exists only for the require_approval producer", after.approvals.length, to === "pending_approval" ? 1 : 0);
      const actionId = String(after.actions[0].id);
      const approvalId = to === "pending_approval" ? String(after.approvals[0].id) : null;
      expectFaultEvents([
        { phase, teamId: a.teamId, actionId, ...(approvalId ? { approvalRequestId: approvalId } : {}), dispatch: "not_started" },
      ]);
      expect({ dispatched: handler.execute.mock.calls.length, sandboxRuns: h.sandboxRun.mock.calls.length }).toEqual({
        dispatched: 0,
        sandboxRuns: 0,
      });
      expect(after.actions).toEqual([
        standing(
          fault,
          displaced.row,
          expect.objectContaining({ team_id: a.teamId, status: "requested", approval_request_id: null, result: {} }),
          expect.objectContaining({ team_id: a.teamId, status: to, result: {} }),
        ),
      ]);
      // The approval was already filed and stays pending: the link, not the request, is what failed.
      expect(after.approvals).toEqual(
        approvalId
          ? [
              expect.objectContaining({
                id: approvalId,
                team_id: a.teamId,
                status: "pending",
                decided_by: null,
                context: expect.objectContaining({ action_id: actionId }),
              }),
            ]
          : [],
      );
      expect(auditedSince(before.audit, after.audit).filter((action) => action.startsWith("action."))).toEqual([]);

      // The stranded-producer signature: a later decision is refused not ready, for approve AND deny.
      if (approvalId && fault.kind !== "zero") {
        const later = [
          (await resolve(db(), a, approvalId, "approved", handler.handlers)).status,
          (await resolve(db(), a, approvalId, "denied", handler.handlers)).status,
        ];
        expect({ later, ...(await durableState()), dispatched: handler.execute.mock.calls.length, faultEvents: faultEvents().length }).toEqual({
          later: ["not_ready", "not_ready"],
          ...after,
          dispatched: 0,
          faultEvents: 1,
        });
      }
    },
  );
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// F6 — the dashboard action's mapping
// ─────────────────────────────────────────────────────────────────────────────────────────────────

describe("AIO-1217 F6 · decideApproval maps a persistence fault to could not decide and leaves the cache alone (AC-08)", () => {
  const CASES: Array<{
    at: string;
    matcher: Matcher;
    decision: Decision;
    phase: string;
    dispatch: "not_started" | "attempted";
    outcome?: HandlerKind;
    approval: "pending" | Decision;
    action: ActionStatus;
  }> = [
    { at: "claim", matcher: claimWrite, decision: "approved", phase: "approval_claim", dispatch: "not_started", approval: "pending", action: "pending_approval" },
    { at: "prepare", matcher: runningWrite, decision: "approved", phase: "action_prepare", dispatch: "not_started", approval: "approved", action: "pending_approval" },
    { at: "deny", matcher: denyWrite, decision: "denied", phase: "action_deny", dispatch: "not_started", approval: "denied", action: "pending_approval" },
    { at: "terminal write", matcher: terminalWrite, decision: "approved", phase: "action_finish", dispatch: "attempted", outcome: "succeeded", approval: "approved", action: "running" },
  ];

  it.each(CASES)(
    "returned error at the $at · $decision through the dashboard with the built-in code.run handler: exactly could not decide with no private text, zero revalidation and zero governed routing; the sandbox ran only if dispatch was $dispatch, and the standing rows are approval $approval / action $action with no terminal event",
    async ({ matcher, decision, phase, dispatch, outcome, approval, action }) => {
      const a = await seedTeam();
      await signInAdmin(a);
      const own = await seedLinkedTuple(a);
      const before = await durableState();
      const { client } = arm(matcher, RETURNED_ERROR);
      h.actionDb = client.db;

      const result = await decideApproval(a.teamSlug, own.approvalId, decision, DECISION_NOTE);
      h.actionDb = null;
      const after = await durableState();

      firedOnce(client, RETURNED_ERROR);
      expect({
        result,
        leaked: leaks(result),
        revalidated: h.revalidatePath.mock.calls.length,
        governedDecides: governedDecide.mock.calls.length,
        sandboxRuns: h.sandboxRun.mock.calls,
      }).toEqual({
        result: COULD_NOT_DECIDE,
        leaked: [],
        revalidated: 0,
        governedDecides: 0,
        sandboxRuns: dispatch === "attempted" ? [[CODE_PARAMS]] : [],
      });
      expectFaultEvents([
        {
          phase,
          teamId: a.teamId,
          actionId: own.actionId,
          approvalRequestId: own.approvalId,
          dispatch,
          ...(outcome ? { outcome } : {}),
        },
      ]);
      expect({
        approvals: after.approvals.map((row) => [row.id, row.status]),
        actions: after.actions.map((row) => [row.id, row.status, row.result]),
      }).toEqual({ approvals: [[own.approvalId, approval]], actions: [[own.actionId, action, {}]] });
      const audited = auditedSince(before.audit, after.audit);
      if (approval === "pending") expect(audited).toEqual([]);
      else expectDecisionAuditAtMost(audited, decision);
      expect(terminalAudits(audited)).toEqual([]);
    },
  );
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// F7 — projection observation
// ─────────────────────────────────────────────────────────────────────────────────────────────────

describe("AIO-1217 F7 · projection observation: the execution payload is loaded only by the team-bound, confirmed prepare (AC-07, AC-08)", () => {
  it("another team's linked approval: across approve AND deny, no statement returned the approval row or any row carrying the private payload — the refusal reads nothing private, it does not merely withhold it", async () => {
    const a = await seedTeam();
    const b = await seedTeam();
    const foreign = await seedLinkedTuple(b);
    const before = await durableState();
    const handler = recordingHandler("succeeded");
    const tap = faultDb();

    const outcomes = [
      (await resolve(tap.db, a, foreign.approvalId, "approved", handler.handlers)).status,
      (await resolve(tap.db, a, foreign.approvalId, "denied", handler.handlers)).status,
    ];

    premise(
      "the tap is on the resolver's client: it saw the approval lookup bound to the administrator's own team",
      tap.statements.some(
        (statement) => statement.table === "approval_requests" && statement.operation === "select" && statement.team === a.teamId,
      ),
      true,
    );
    expect({
      outcomes,
      approvalRowsRead: tap.statements.filter((statement) => statement.table === "approval_requests").reduce((n, s) => n + s.rows, 0),
      privatePayloadReads: tap.statements.filter((statement) => statement.payload),
      actionPayloadReads: actionPayloadReads(tap),
      ...(await durableState()),
      dispatched: handler.execute.mock.calls.length,
      faultEvents: faultEvents().length,
    }).toEqual({
      outcomes: ["not_found", "not_found"],
      approvalRowsRead: 0,
      privatePayloadReads: [],
      actionPayloadReads: [],
      ...before,
      dispatched: 0,
      faultEvents: 0,
    });
  });

  it.each([
    {
      shape: "forward-only tuple (producer not yet linked)",
      status: "not_ready",
      seed: async (a: Seed) => seedApproval(a, { action_id: await seedAction(a, { status: "requested" }) }),
    },
    {
      shape: "reverse-linked action belonging to another team",
      status: "malformed_links",
      seed: async (a: Seed, b: Seed) => {
        const approvalId = await seedApproval(a);
        await seedAction(b, { approvalId });
        return approvalId;
      },
    },
    {
      shape: "two reverse-linked actions",
      status: "ambiguous_links",
      seed: async (a: Seed) => {
        const { approvalId } = await seedLinkedTuple(a);
        await seedAction(a, { approvalId });
        return approvalId;
      },
    },
  ])(
    "own-team approval refused before the claim · $shape: every row read from actions held only minimal identifiers; the private payload was returned only by approval reads bound to the administrator's own team, and those returned only owner identifiers and the context",
    async ({ status, seed }) => {
      const a = await seedTeam();
      const b = await seedTeam();
      const approvalId = await seed(a, b);
      const before = await durableState();
      const handler = recordingHandler("succeeded");
      const tap = faultDb();

      const outcomes = [
        (await resolve(tap.db, a, approvalId, "approved", handler.handlers)).status,
        (await resolve(tap.db, a, approvalId, "denied", handler.handlers)).status,
      ];

      const actionReads = tap.statements.filter((statement) => statement.table === "actions");
      premise("the readiness check really read at least one action row", actionReads.some((statement) => statement.rows > 0), true);
      expect({
        outcomes,
        nonMinimalActionColumns: actionReads.flatMap((statement) =>
          statement.columns.filter((column) => !MINIMAL_ACTION_COLUMNS.includes(column)),
        ),
        actionPayloadReads: actionPayloadReads(tap),
        privatePayloadReadsOutsideOwnTeamApproval: tap.statements.filter(
          (statement) => statement.payload && !(statement.table === "approval_requests" && statement.team === a.teamId),
        ),
        nonOwnerApprovalColumns: tap.statements
          .filter((statement) => statement.table === "approval_requests")
          .flatMap((statement) => statement.columns.filter((column) => !APPROVAL_OWNER_COLUMNS.includes(column))),
        ...(await durableState()),
        dispatched: handler.execute.mock.calls.length,
        faultEvents: faultEvents().length,
      }).toEqual({
        outcomes: [status, status],
        nonMinimalActionColumns: [],
        actionPayloadReads: [],
        privatePayloadReadsOutsideOwnTeamApproval: [],
        nonOwnerApprovalColumns: [],
        ...before,
        dispatched: 0,
        faultEvents: 0,
      });
    },
  );

  it("[control] admitted approve: the execution payload is returned by exactly one actions statement — the team-bound update to running, after the claim was confirmed — every earlier actions read held only minimal identifiers, and the handler then received that stored payload under the stored requester", async () => {
    const a = await seedTeam();
    const requester = await addMember(a.teamId);
    const actionId = randomUUID();
    const approvalId = await seedApproval(a, { action_id: actionId });
    await seedAction({ ...a, memberId: requester }, { id: actionId, approvalId });
    const handler = recordingHandler("succeeded");
    const tap = faultDb();

    const outcome = await resolve(tap.db, a, approvalId, "approved", handler.handlers);

    expect(outcome).toMatchObject({ status: "approved", actionId, actionStatus: "succeeded" });
    const claimedAt = tap.statements.findIndex(
      (statement) => statement.table === "approval_requests" && statement.operation === "update" && statement.rows === 1,
    );
    premise("the tap saw the confirmed claim", claimedAt >= 0, true);
    const payloadReads = actionPayloadReads(tap);
    expect(payloadReads).toEqual([
      expect.objectContaining({ operation: "update", to: "running", team: a.teamId, rows: 1, payload: true }),
    ]);
    expect(payloadReads[0].index).toBeGreaterThan(claimedAt);
    expect(
      tap.statements
        .slice(0, payloadReads[0].index)
        .filter((statement) => statement.table === "actions")
        .flatMap((statement) => statement.columns.filter((column) => !MINIMAL_ACTION_COLUMNS.includes(column))),
    ).toEqual([]);
    expect(tap.statements.filter((statement) => statement.payload && statement.team !== a.teamId)).toEqual([]);
    // Non-vacuity: the payload the tap attributes to the prepare is the one the handler ran with.
    // The stored requester resumes as role member / tier team; it is not re-derived.
    expect(handler.execute).toHaveBeenCalledTimes(1);
    expect(handler.execute.mock.calls[0][0]).toMatchObject({
      teamId: a.teamId,
      memberId: requester,
      apiKeyId: null,
      principal: { role: "member", tier: "team", actor: REQUESTER_ACTOR },
    });
    expect(handler.execute.mock.calls[0][1]).toEqual(CODE_PARAMS);
  });
});
