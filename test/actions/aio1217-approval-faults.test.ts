import { randomUUID } from "node:crypto";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import type { ApiAuth } from "@/lib/api/auth";
import type { DbClient } from "@/lib/db/types";
import { FakeSupabase } from "@/lib/ingest/fake-supabase";

/**
 * AIO-1217 — legacy action PERSISTENCE FAULTS, unit tier (AC-08), and the unchanged v1 route
 * handler's fault mapping.
 *
 * Every assertion is derived from the accepted specification's decision table and persistence-fault
 * contract, not from the implementation. The real-Postgres halves live in
 * `test/datamechanics/server-action-approval-{mechanics,faults}.datamechanics.test.ts`; this file
 * does not repeat their lost-acknowledgement forms, status displacement, competing claims, payload
 * projection or the dashboard mapping.
 *
 *   X  — the fixture's own contract: what the recording client returns and when it fires.
 *   U1 — `runAction` requested→denied / →pending_approval link / →running, checked before any
 *        downstream effect.
 *   U2 — `resolveApproval` before dispatch: ownership reads, the claim (a genuinely lost claim is
 *        the normal already-decided outcome, not a fault), post-claim prepare and deny.
 *   U3 — the handler outcome kept apart from terminal persistence, through `runAction` and through
 *        the resolver, with confirmed-terminal controls for every outcome.
 *   R  — the exported `POST` of `app/api/v1/actions/route.ts`: admission boundaries, the four
 *        normal statuses, then every checked `runAction` fault as the fixed 500 internal envelope.
 *
 * What is real: `runAction`, `resolveApproval`, the policy engine, the audit writer and — in R —
 * the route's exported `POST`, `actionRequestSchema`, `errorResponse`, `rateLimit` and the built-in
 * `code.run` handler. Neither `runAction` nor the `@/lib/actions` facade is mocked anywhere.
 *
 * The synthetic seams, all of them:
 *   SEAM auth        `@/lib/api/auth` `authenticateApiKey` — returns a fixed identity, or null.
 *   SEAM rate limit  the `rate_limit_hit` RPC on the recording client; the real `rateLimit` reads it.
 *   SEAM db          `@/lib/db/admin` `adminClient` — hands the route the recording client.
 *   SEAM sandbox     `@/lib/actions/sandbox/e2b` `createE2BSandbox` — the factory returns a runner
 *                    whose `run` records and allocates nothing. No E2B loader or transport.
 * U1–U3 additionally replace the `code.run` handler with a recording handler so each of the four
 * outcomes is deterministic; R runs the built-in handler against the sandbox seam.
 *
 * THE RECORDING CLIENT wraps `FakeSupabase` builders. Left alone it is a tap: every statement runs
 * against the fake, whose update/delete + select() returns exactly the rows it matched. One
 * statement, identified by what the caller built (table, operation, the status being written), can
 * be faulted once; a later matching statement is NOT intercepted, so a second write would land.
 *
 *   returned error   injected BEFORE the statement: nothing runs. The envelope carries sentinel
 *                    driver text, SQL and bound private params. Synthetic, not a driver failure.
 *   throw            the same, raised instead of returned.
 *   checked zero     the action row is displaced first (re-homed to another team, or its approval
 *                    link cleared), then the statement really runs and really matches nothing.
 *
 * The standing-state oracle is the snapshot taken when the faulted statement was issued: afterwards
 * the rows must be exactly as they stood then. A fixture that did not fire as labelled fails a
 * premise, which is a broken fixture and not a security observation.
 *
 * Bounds of what is claimed. The fake has no constraints, no concurrency and no atomicity: this
 * proves orchestration over checked envelopes, and nothing about PostgreSQL. Calling the exported
 * `POST` is handler-level evidence, not a built Next wire or HTTP server acceptance. The sentinel
 * check covers the new prefixed event, the thrown fault and the HTTP response only: nothing here
 * claims the adapter's own `[pg] …` stderr, the unchecked initial insert, or a handler's own error
 * text (including the missing-handler message) is sanitized. "not_started" means THIS invocation
 * did not invoke the handler. Audit is best effort, so it is only checked for what must NOT appear,
 * except in controls where nothing is faulted. There is no idempotency or exactly-once promise: the
 * last R case pins the disclosed residual that a fresh POST after uncertain completion creates and
 * executes another action.
 */

const FIXTURE = "FIXTURE PREMISE FAILED (setup, not a security observation):";

const h = vi.hoisted(() => ({
  /** SEAM auth: the identity `authenticateApiKey` resolves to; null is an unauthenticated request. */
  auth: null as import("@/lib/api/auth").ApiAuth | null,
  authenticateApiKey: vi.fn(),
  /** SEAM db: the recording client `adminClient()` hands the route. */
  db: null as import("@/lib/db/types").DbClient | null,
  /** SEAM rate limit: the count the `rate_limit_hit` RPC reports for this window. */
  rateLimitHits: 1,
  /** SEAM sandbox: the factory and the recording `run` of the runner it returns. */
  createE2BSandbox: vi.fn(),
  sandboxRun: vi.fn(),
}));

vi.mock("@/lib/api/auth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api/auth")>()),
  authenticateApiKey: h.authenticateApiKey,
}));
vi.mock("@/lib/db/admin", () => ({
  adminClient: () => {
    if (!h.db) throw new Error("FIXTURE PREMISE FAILED (setup, not a security observation): no recording client admitted");
    return h.db;
  },
}));
// The factory is pure; `run` is the recording boundary. No E2B transport, loader or allocation.
vi.mock("@/lib/actions/sandbox/e2b", () => ({ createE2BSandbox: h.createE2BSandbox }));

import { POST } from "@/app/api/v1/actions/route";
import {
  LegacyActionPersistenceFault,
  resolveApproval,
  runAction,
  type ActionHandler,
  type ActionResult as HandlerResult,
  type SandboxRunner,
} from "@/lib/actions";

type Row = Record<string, unknown>;
type Decision = "approved" | "denied";
type PolicyEffect = "allow" | "deny" | "require_approval";
type Envelope = { data: unknown; error: { message: string } | null; count?: number | null };

const FAULT_EVENT = "[legacy_action_persistence_fault]";
const FAULT_MESSAGE = "action persistence unavailable";

const TEAM = "00000000-0000-4000-8000-0000000a1217";
const OTHER_TEAM = "00000000-0000-4000-8000-0000000b1217";
const MEMBER = "00000000-0000-4000-8000-0000000c1217";
const DECIDER = "00000000-0000-4000-8000-0000000d1217";
const RIVAL = "00000000-0000-4000-8000-0000000e1217";
const API_KEY = "00000000-0000-4000-8000-0000000f1217";
const ACTOR = "aio1217-fixture-requester";
const RESOURCE = "code:fixture";
const DECISION_NOTE = "aio1217 synthetic decision note";
const RIVAL_NOTE = "aio1217 rival decision note";
const DECISIONS: Decision[] = ["approved", "denied"];
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

// Sentinels: each stands for a class of text that must never reach the new event, the fault or the response.
const DRIVER_SENTINEL = "AIO1217_PG_DRIVER_SENTINEL";
const SQL_SENTINEL = "AIO1217_PRIVATE_SQL_SENTINEL";
const PRIVATE_PAYLOAD = "AIO1217_PRIVATE_PAYLOAD_SENTINEL";
const HANDLER_OUTPUT_SENTINEL = "AIO1217_HANDLER_OUTPUT_SENTINEL";
const HANDLER_ERROR = "AIO1217_HANDLER_ERROR_SENTINEL";
const SANDBOX_STDOUT = "AIO1217_SANDBOX_STDOUT_SENTINEL";
const SANDBOX_ERROR = "AIO1217_SANDBOX_ERROR_SENTINEL";
const SENTINELS = [
  DRIVER_SENTINEL,
  SQL_SENTINEL,
  PRIVATE_PAYLOAD,
  HANDLER_OUTPUT_SENTINEL,
  HANDLER_ERROR,
  SANDBOX_STDOUT,
  SANDBOX_ERROR,
];

const CODE_PARAMS = { language: "python", code: `print('${PRIVATE_PAYLOAD}')` };
const REQUEST = { type: "code.run", resource: RESOURCE, params: CODE_PARAMS };
/** What a leaky driver error would carry: its own text, the statement and the bound params. */
const DRIVER_MESSAGE = `${DRIVER_SENTINEL}: UPDATE actions SET status = $1 /* ${SQL_SENTINEL} */ params=${JSON.stringify(CODE_PARAMS)}`;
const HANDLER_OUTPUT = { marker: HANDLER_OUTPUT_SENTINEL };

const AUTH: ApiAuth = {
  teamId: TEAM,
  memberId: MEMBER,
  memberTier: "team",
  memberRole: "member",
  apiKeyId: API_KEY,
  actorHandle: ACTOR,
  displayName: null,
  email: null,
};

let consoleError: MockInstance<typeof console.error>;

beforeEach(() => {
  h.auth = AUTH;
  h.db = null;
  h.rateLimitHits = 1;
  h.authenticateApiKey.mockReset();
  h.authenticateApiKey.mockImplementation(async () => h.auth);
  h.sandboxRun.mockReset();
  h.sandboxRun.mockImplementation(SANDBOX.ok);
  h.createE2BSandbox.mockReset();
  h.createE2BSandbox.mockImplementation(() => ({ configured: true, run: h.sandboxRun }));
  consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
  h.db = null;
  consoleError.mockRestore();
});

// ── fixture plumbing ─────────────────────────────────────────────────────────────────────────────

function premise(label: string, actual: unknown, expected: unknown): void {
  expect(actual, `${FIXTURE} ${label}`).toEqual(expected);
}

const isRow = (value: unknown): value is Row => typeof value === "object" && value !== null && !Array.isArray(value);
const recordingSandbox = (): SandboxRunner => ({ configured: true, run: h.sandboxRun });

type SandboxBehaviour = "ok" | "exit1" | "throws";
const SANDBOX: Record<SandboxBehaviour, SandboxRunner["run"]> = {
  ok: async () => ({ exitCode: 0, stdout: SANDBOX_STDOUT, stderr: "" }),
  exit1: async () => ({ exitCode: 1, stdout: SANDBOX_STDOUT, stderr: SANDBOX_ERROR }),
  throws: async () => {
    throw new Error(SANDBOX_ERROR);
  },
};

/** The standing rows, read straight off the fake — whatever any wrapped statement reported. */
const durable = (fake: FakeSupabase) =>
  structuredClone({
    approvals: fake.tables.approval_requests ?? [],
    actions: fake.tables.actions ?? [],
    audit: fake.tables.audit_log ?? [],
  });
type Durable = ReturnType<typeof durable>;

const statuses = (rows: Row[]) => rows.map((row) => row.status);
const audited = (state: Durable) => state.audit.map((row) => String(row.action));
const terminalAudits = (state: Durable) =>
  audited(state).filter((action) => action === "action.succeeded" || action === "action.failed");

/**
 * After a post-claim fault the only event that may exist is the durable decision's own, at most once
 * (audit is best effort, so its presence is not required). Anything else would be a fabricated event.
 */
function expectDecisionAuditAtMost(state: Durable, decision: Decision): void {
  expect(audited(state).filter((action) => action !== `approval.${decision}`)).toEqual([]);
  expect(state.audit.length).toBeLessThanOrEqual(1);
}

function seedPolicy(fake: FakeSupabase, effect: PolicyEffect): void {
  fake.tables.policies ??= [];
  fake.tables.policies.push({
    id: randomUUID(),
    team_id: TEAM,
    priority: 1,
    subject_role: null,
    subject_tier: null,
    subject_actor: null,
    action: "code.run",
    resource: "*",
    effect,
    enabled: true,
  });
}

/** A consistent legacy tuple: forward marker and reverse link agree, the action is `pending_approval`. */
function seedLinkedTuple(fake: FakeSupabase): { approvalId: string; actionId: string } {
  const approvalId = randomUUID();
  const actionId = randomUUID();
  fake.tables.approval_requests ??= [];
  fake.tables.approval_requests.push({
    id: approvalId,
    team_id: TEAM,
    requested_by_member: MEMBER,
    requested_by_actor: ACTOR,
    action: "code.run",
    resource: RESOURCE,
    context: { params: CODE_PARAMS, action_id: actionId },
    status: "pending",
  });
  fake.tables.actions ??= [];
  fake.tables.actions.push({
    id: actionId,
    team_id: TEAM,
    member_id: MEMBER,
    actor: ACTOR,
    action_type: "code.run",
    resource: RESOURCE,
    params: CODE_PARAMS,
    status: "pending_approval",
    decision: "require_approval",
    approval_request_id: approvalId,
  });
  return { approvalId, actionId };
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

// ── recording client ─────────────────────────────────────────────────────────────────────────────

type Operation = "select" | "insert" | "update" | "upsert" | "delete";
/** What the caller built, read off the builder calls. */
type Built = { table: string; operation: Operation; payload: unknown; filters: Array<[string, unknown]> };
type Matcher = (statement: Built) => boolean;
type Injection = "error" | "throw";
type Rule = { at: Matcher; inject?: Injection; before?: () => void };
/** One statement issued through the recording client, with what the fake actually returned to it. */
type Statement = {
  table: string;
  operation: Operation;
  /** The status a mutation writes, if any. */
  to: string | null;
  /** The value of the statement's `team_id` equality filter; null when it is not team-bound. */
  team: unknown;
  executed: boolean;
  rows: number;
};
type Fired = Statement & { mode: Injection | "barrier" };
type RecordingDb = {
  db: DbClient;
  statements: Statement[];
  fired: Fired[];
  rpcCalls: string[];
  /** The standing rows when the faulted statement was issued (after its barrier, if it had one). */
  atFault: Durable | null;
};

const statusOf = (payload: unknown): string | null => (isRow(payload) && typeof payload.status === "string" ? payload.status : null);
const returnedRows = (data: unknown): Row[] => (Array.isArray(data) ? data.filter(isRow) : isRow(data) ? [data] : []);

/**
 * `FakeSupabase` behind observed builders, where at most one statement is faulted. With no rule it
 * is a plain recording tap. Its only RPC is the rate-limit seam.
 */
function recordingDb(fake: FakeSupabase, rule?: Rule): RecordingDb {
  const statements: Statement[] = [];
  const fired: Fired[] = [];
  const rpcCalls: string[] = [];
  let armed: Rule | null = rule ?? null;

  const from = (table: string) => {
    const target = fake.from(table);
    const built: Built = { table, operation: "select", payload: undefined, filters: [] };

    const run = async (terminal: () => PromiseLike<Envelope>): Promise<Envelope> => {
      const hit = armed !== null && armed.at(built) ? armed : null;
      if (hit) armed = null;
      const shape = {
        table,
        operation: built.operation,
        to: statusOf(built.payload),
        team: built.filters.find(([column]) => column === "team_id")?.[1] ?? null,
      };
      if (hit?.inject) {
        recording.atFault = durable(fake);
        const skipped: Statement = { ...shape, executed: false, rows: 0 };
        statements.push(skipped);
        fired.push({ ...skipped, mode: hit.inject });
        if (hit.inject === "throw") throw new Error(DRIVER_MESSAGE);
        return { data: null, error: { message: DRIVER_MESSAGE }, count: null };
      }
      if (hit) {
        hit.before?.();
        recording.atFault = durable(fake);
      }
      const result = await terminal();
      const seen: Statement = { ...shape, executed: true, rows: returnedRows(result.data).length };
      statements.push(seen);
      if (hit) fired.push({ ...seen, mode: "barrier" });
      return result;
    };

    const proxy: object = new Proxy(target, {
      get(builder, prop) {
        if (prop === "then") {
          return (onFulfilled?: ((value: Envelope) => unknown) | null, onRejected?: ((reason: unknown) => unknown) | null) =>
            run(() => builder as unknown as PromiseLike<Envelope>).then(onFulfilled, onRejected);
        }
        const member: unknown = Reflect.get(builder, prop, builder);
        if (typeof member !== "function") return member;
        // The fake's single()/maybeSingle() execute at once, so they are terminals here too.
        if (prop === "single" || prop === "maybeSingle") {
          return () => run(() => member.call(builder) as PromiseLike<Envelope>);
        }
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

  const rpc = async (fn: string) => {
    rpcCalls.push(fn);
    if (fn !== "rate_limit_hit") throw new Error(`${FIXTURE} unexpected rpc ${fn}`);
    return { data: h.rateLimitHits, error: null };
  };

  const recording: RecordingDb = { db: { from, rpc } as unknown as DbClient, statements, fired, rpcCalls, atFault: null };
  return recording;
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

const terminalWritesAttempted = (client: RecordingDb) =>
  client.statements
    .filter((statement) => statement.table === "actions" && statement.operation === "update")
    .map((statement) => statement.to)
    .filter((to) => to === "succeeded" || to === "failed");

// ── labelled faults ──────────────────────────────────────────────────────────────────────────────

type Form = Injection | "zero";
const RETURNED_ERROR = { form: "error" as Form, label: "returned error injected before the statement (synthetic; nothing ran)" };
const THROWN = { form: "throw" as Form, label: "throw injected before the statement (synthetic; nothing ran)" };
const CHECKED_ZERO = {
  form: "zero" as Form,
  label: "CHECKED ZERO ROWS — the action is displaced first, then the statement really runs and matches nothing",
};
const FORMS = [RETURNED_ERROR, THROWN, CHECKED_ZERO];

/** How a checked-zero fault makes the transition's own predicate miss, without moving `status`. */
type Displace = "team" | "link";

/**
 * Displace the one action row in place. Returns null instead of throwing when the fixture is not in
 * the expected shape: a throw here would be swallowed by the code under test and read as its fault.
 */
function displaceAction(fake: FakeSupabase, how: Displace): Row | null {
  const rows = fake.tables.actions ?? [];
  if (rows.length !== 1) return null;
  if (how === "team") rows[0].team_id = OTHER_TEAM;
  else rows[0].approval_request_id = null;
  return structuredClone(rows[0]);
}

/** Arm one labelled fault at `at`; a checked-zero fault displaces the action first. */
function arm(fake: FakeSupabase, at: Matcher, form: Form, how: Displace = "team") {
  const displaced: { row: Row | null } = { row: null };
  const client =
    form === "zero"
      ? recordingDb(fake, {
          at,
          before: () => {
            displaced.row = displaceAction(fake, how);
          },
        })
      : recordingDb(fake, { at, inject: form });
  return { client, displaced };
}

function firedOnce(client: RecordingDb, form: Form, displaced: Row | null): void {
  premise(
    "the injection fired exactly once, at the intended statement, in the labelled way",
    {
      fired: client.fired.map(({ mode, executed, rows }) => ({ mode, executed, rows })),
      displaced: displaced !== null,
    },
    {
      fired: [{ mode: form === "zero" ? "barrier" : form, executed: form === "zero", rows: 0 }],
      displaced: form === "zero",
    },
  );
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
  const text = typeof value === "string" ? value : (JSON.stringify(value) ?? "");
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

const resolve = (client: RecordingDb, approvalRequestId: string, decision: Decision, handlers: ActionHandler[]) =>
  resolveApproval(
    client.db,
    { teamId: TEAM, approvalRequestId, decision, deciderMemberId: DECIDER, note: DECISION_NOTE },
    { sandbox: recordingSandbox(), handlers },
  );

const produce = (client: RecordingDb, handlers: ActionHandler[]) =>
  runAction(
    client.db,
    {
      teamId: TEAM,
      memberId: MEMBER,
      apiKeyId: API_KEY,
      principal: { role: "member", tier: "team", actor: ACTOR },
      request: REQUEST,
    },
    { sandbox: recordingSandbox(), handlers },
  );

// ── request transitions (shared by U1 and R) ─────────────────────────────────────────────────────

type RequestTransition = {
  transition: string;
  effect: PolicyEffect;
  at: Matcher;
  phase: "request_deny" | "request_approval_link" | "request_running";
  /** The status a confirmed transition would have answered with. */
  confirmed: 403 | 202 | 200;
};
const REQUEST_TRANSITIONS: RequestTransition[] = [
  { transition: "requested→denied", effect: "deny", at: denyWrite, phase: "request_deny", confirmed: 403 },
  {
    transition: "requested→pending_approval link",
    effect: "require_approval",
    at: linkWrite,
    phase: "request_approval_link",
    confirmed: 202,
  },
  { transition: "requested→running", effect: "allow", at: runningWrite, phase: "request_running", confirmed: 200 },
];

/** The approval a failed producer link leaves behind: still pending, still naming its action. */
const strandedApprovals = (phase: RequestTransition["phase"], state: Durable) =>
  phase === "request_approval_link"
    ? {
        expected: [{ team_id: TEAM, status: "pending", forward: state.actions[0]?.id }],
        actual: state.approvals.map((row) => ({
          team_id: row.team_id,
          status: row.status,
          forward: isRow(row.context) ? row.context.action_id : undefined,
        })),
      }
    : { expected: [], actual: state.approvals };

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// X — the fixture's own contract
// ─────────────────────────────────────────────────────────────────────────────────────────────────

describe("AIO-1217 X · [fixture contract] the recording client is a truthful tap and faults exactly one statement", () => {
  const twoTeams = () => {
    const fake = new FakeSupabase();
    fake.tables.actions = [
      { id: "a", team_id: TEAM, status: "requested" },
      { id: "b", team_id: OTHER_TEAM, status: "requested" },
    ];
    return fake;
  };
  const toRunning = (client: RecordingDb) =>
    client.db.from("actions").update({ status: "running" }).eq("team_id", TEAM).eq("status", "requested").select("id");

  it("unarmed, every terminal returns what the fake matched — a hit, a miss, maybeSingle and single — and records it", async () => {
    const fake = twoTeams();
    const client = recordingDb(fake);

    const hit = await toRunning(client);
    const miss = await toRunning(client);
    const one = await client.db.from("actions").select("id").eq("id", "b").maybeSingle();
    const none = await client.db.from("actions").select("id").eq("id", "absent").single();

    expect({ hit: hit.data, miss: miss.data, one: one.data, none: { data: none.data, error: none.error } }).toEqual({
      hit: [{ id: "a", team_id: TEAM, status: "running" }],
      miss: [],
      one: { id: "b", team_id: OTHER_TEAM, status: "requested" },
      none: { data: null, error: { message: "no rows" } },
    });
    expect({ statements: client.statements, fired: client.fired, standing: statuses(fake.tables.actions) }).toEqual({
      statements: [
        { table: "actions", operation: "update", to: "running", team: TEAM, executed: true, rows: 1 },
        { table: "actions", operation: "update", to: "running", team: TEAM, executed: true, rows: 0 },
        { table: "actions", operation: "select", to: null, team: null, executed: true, rows: 1 },
        { table: "actions", operation: "select", to: null, team: null, executed: true, rows: 0 },
      ],
      fired: [],
      standing: ["running", "requested"],
    });
  });

  it.each([RETURNED_ERROR, THROWN])(
    "$label: the armed statement never runs and carries the driver text; the next identical statement is not intercepted",
    async ({ form }) => {
      const fake = twoTeams();
      const { client } = arm(fake, runningWrite, form);

      const first = await settle(Promise.resolve(toRunning(client)));
      const untouched = statuses(fake.tables.actions);
      const second = await toRunning(client);

      expect(
        form === "throw"
          ? { thrown: first.thrown instanceof Error ? first.thrown.message : first.thrown }
          : { returned: first.value },
      ).toEqual(
        form === "throw"
          ? { thrown: DRIVER_MESSAGE }
          : { returned: { data: null, error: { message: DRIVER_MESSAGE }, count: null } },
      );
      expect({ untouched, second: second.data, fired: client.fired, executed: client.statements.map((s) => s.executed) }).toEqual({
        untouched: ["requested", "requested"],
        second: [{ id: "a", team_id: TEAM, status: "running" }],
        fired: [{ table: "actions", operation: "update", to: "running", team: TEAM, executed: false, rows: 0, mode: form }],
        executed: [false, true],
      });
    },
  );

  it("a barrier runs before its statement, which then really executes and matches zero rows", async () => {
    const fake = new FakeSupabase();
    fake.tables.actions = [{ id: "a", team_id: TEAM, status: "requested" }];
    const { client, displaced } = arm(fake, runningWrite, "zero");

    const result = await toRunning(client);

    expect({ data: result.data, error: result.error, displaced: displaced.row, standing: fake.tables.actions, atFault: client.atFault?.actions }).toEqual({
      data: [],
      error: null,
      displaced: { id: "a", team_id: OTHER_TEAM, status: "requested" },
      standing: [{ id: "a", team_id: OTHER_TEAM, status: "requested" }],
      atFault: [{ id: "a", team_id: OTHER_TEAM, status: "requested" }],
    });
    firedOnce(client, "zero", displaced.row);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// U1 — runAction request transitions
// ─────────────────────────────────────────────────────────────────────────────────────────────────

describe("AIO-1217 U1 · runAction checks requested→denied, the pending_approval link and requested→running before any downstream effect (AC-08)", () => {
  it.each(REQUEST_TRANSITIONS.flatMap((request) => FORMS.map((fault) => ({ ...request, ...fault }))))(
    "$transition · $label: the fixed typed fault with phase $phase and no settled outcome; the handler is never invoked, the action is still requested, and no action event exists",
    async ({ effect, at, phase, form }) => {
      const fake = new FakeSupabase();
      seedPolicy(fake, effect);
      const handler = recordingHandler("succeeded");
      const { client, displaced } = arm(fake, at, form);

      const settled = await settle(produce(client, handler.handlers));
      const after = durable(fake);

      firedOnce(client, form, displaced.row);
      expectFault(settled);
      premise("the producer recorded exactly one action", after.actions.length, 1);
      const stranded = strandedApprovals(phase, after);
      expectFaultEvents([
        {
          phase,
          teamId: TEAM,
          actionId: after.actions[0].id,
          ...(phase === "request_approval_link" ? { approvalRequestId: after.approvals[0]?.id } : {}),
          dispatch: "not_started",
        },
      ]);
      // A pending approval may remain after a failed producer link; nothing else may have been written.
      expect({
        standing: after,
        actions: statuses(after.actions),
        approvals: stranded.actual,
        audited: audited(after),
        terminalWrites: terminalWritesAttempted(client),
        dispatched: handler.execute.mock.calls.length,
        sandboxRuns: h.sandboxRun.mock.calls.length,
      }).toEqual({
        standing: client.atFault,
        actions: ["requested"],
        approvals: stranded.expected,
        audited: [],
        terminalWrites: [],
        dispatched: 0,
        sandboxRuns: 0,
      });
    },
  );
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// U2 — resolveApproval before dispatch
// ─────────────────────────────────────────────────────────────────────────────────────────────────

describe("AIO-1217 U2 · resolveApproval: a failed ownership read, claim, prepare or deny is a fault; a lost claim is not (AC-08)", () => {
  it.each(
    [
      { read: "approval ownership read", at: ownerRead, phase: "approval_ownership" },
      { read: "linked-action readiness read", at: readinessRead, phase: "action_ownership" },
    ].flatMap((target) => [RETURNED_ERROR, THROWN].map((fault) => ({ ...target, ...fault }))),
  )(
    "$read · $label: the fixed typed fault with phase $phase and no established action — never absence or readiness; nothing is claimed, dispatched or audited",
    async ({ at, phase, form }) => {
      const fake = new FakeSupabase();
      const own = seedLinkedTuple(fake);
      const before = durable(fake);
      const handler = recordingHandler("succeeded");
      const { client, displaced } = arm(fake, at, form);

      const settled = await settle(resolve(client, own.approvalId, "approved", handler.handlers));

      firedOnce(client, form, displaced.row);
      expectFault(settled);
      expectFaultEvents([
        { phase, teamId: TEAM, actionId: null, approvalRequestId: own.approvalId, dispatch: "not_started" },
      ]);
      expect({ ...durable(fake), dispatched: handler.execute.mock.calls.length, sandboxRuns: h.sandboxRun.mock.calls.length }).toEqual({
        ...before,
        dispatched: 0,
        sandboxRuns: 0,
      });
    },
  );

  it.each(DECISIONS.flatMap((decision) => [RETURNED_ERROR, THROWN].map((fault) => ({ decision, ...fault }))))(
    "approval claim · $decision · $label: the fixed typed fault with phase approval_claim; the approval is still pending, the action untouched, and nothing is audited or dispatched",
    async ({ decision, form }) => {
      const fake = new FakeSupabase();
      const own = seedLinkedTuple(fake);
      const before = durable(fake);
      const handler = recordingHandler("succeeded");
      const { client, displaced } = arm(fake, claimWrite, form);

      const settled = await settle(resolve(client, own.approvalId, decision, handler.handlers));

      firedOnce(client, form, displaced.row);
      expectFault(settled);
      expectFaultEvents([
        { phase: "approval_claim", teamId: TEAM, actionId: own.actionId, approvalRequestId: own.approvalId, dispatch: "not_started" },
      ]);
      expect({ ...durable(fake), dispatched: handler.execute.mock.calls.length, sandboxRuns: h.sandboxRun.mock.calls.length }).toEqual({
        ...before,
        dispatched: 0,
        sandboxRuns: 0,
      });
    },
  );

  it.each(DECISIONS)(
    "[control] a genuinely lost claim · %s — a rival decided immediately before the claim, which really runs and matches nothing: already decided, with no fault event, audit, dispatch or change to the rival's decision",
    async (decision) => {
      const fake = new FakeSupabase();
      const own = seedLinkedTuple(fake);
      const handler = recordingHandler("succeeded");
      const rival: Decision = decision === "approved" ? "denied" : "approved";
      const client = recordingDb(fake, {
        at: claimWrite,
        before: () => {
          Object.assign(fake.tables.approval_requests[0], { status: rival, decided_by: RIVAL, decision_note: RIVAL_NOTE });
        },
      });

      const settled = await settle(resolve(client, own.approvalId, decision, handler.handlers));
      const after = durable(fake);

      premise(
        "the barrier fired once and the claim really ran against the rival's row",
        client.fired.map(({ mode, executed, rows, to }) => ({ mode, executed, rows, to })),
        [{ mode: "barrier", executed: true, rows: 0, to: decision }],
      );
      expect(settled).toEqual({ value: { approvalRequestId: own.approvalId, status: "already_decided" } });
      expect({
        standing: after,
        approval: after.approvals.map((row) => ({ status: row.status, decided_by: row.decided_by, decision_note: row.decision_note })),
        actions: statuses(after.actions),
        audited: audited(after),
        dispatched: handler.execute.mock.calls.length,
        sandboxRuns: h.sandboxRun.mock.calls.length,
        faultEvents: faultEvents().length,
      }).toEqual({
        standing: client.atFault,
        approval: [{ status: rival, decided_by: RIVAL, decision_note: RIVAL_NOTE }],
        actions: ["pending_approval"],
        audited: [],
        dispatched: 0,
        sandboxRuns: 0,
        faultEvents: 0,
      });
    },
  );

  it.each(
    [
      { step: "prepare (pending_approval→running)", decision: "approved" as Decision, at: runningWrite, phase: "action_prepare" },
      { step: "deny (pending_approval→denied)", decision: "denied" as Decision, at: denyWrite, phase: "action_deny" },
    ].flatMap((target) => FORMS.map((fault) => ({ ...target, ...fault }))),
  )(
    "post-claim $step · $label: the fixed typed fault with phase $phase; the human decision stays durable, the action is still pending_approval and known not dispatched, and no terminal event exists",
    async ({ decision, at, phase, form }) => {
      const fake = new FakeSupabase();
      const own = seedLinkedTuple(fake);
      const handler = recordingHandler("succeeded");
      // Clearing the approval link makes the (team, action, approval, pending_approval) predicate miss.
      const { client, displaced } = arm(fake, at, form, "link");

      const settled = await settle(resolve(client, own.approvalId, decision, handler.handlers));
      const after = durable(fake);

      firedOnce(client, form, displaced.row);
      expectFault(settled);
      expectFaultEvents([
        { phase, teamId: TEAM, actionId: own.actionId, approvalRequestId: own.approvalId, dispatch: "not_started" },
      ]);
      expect({
        standing: after,
        approval: after.approvals.map((row) => ({ status: row.status, decided_by: row.decided_by, decision_note: row.decision_note })),
        actions: statuses(after.actions),
        terminalWrites: terminalWritesAttempted(client),
        dispatched: handler.execute.mock.calls.length,
        sandboxRuns: h.sandboxRun.mock.calls.length,
      }).toEqual({
        standing: client.atFault,
        approval: [{ status: decision, decided_by: DECIDER, decision_note: DECISION_NOTE }],
        actions: ["pending_approval"],
        terminalWrites: [],
        dispatched: 0,
        sandboxRuns: 0,
      });
      expectDecisionAuditAtMost(after, decision);
    },
  );
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// U3 — handler outcome, apart from terminal persistence
// ─────────────────────────────────────────────────────────────────────────────────────────────────

describe("AIO-1217 U3 · the handler outcome is one thing and its persistence another: an unconfirmed terminal write is uncertain completion (AC-08)", () => {
  it.each(HANDLER_KINDS)(
    "[control] runAction · handler %s: the allowed action reaches its confirmed terminal status with exactly the expected handler invocations, one terminal write, one terminal event and no fault event",
    async (kind) => {
      const fake = new FakeSupabase();
      seedPolicy(fake, "allow");
      const handler = recordingHandler(kind);
      const client = recordingDb(fake);

      const outcome = await produce(client, handler.handlers);
      const after = durable(fake);

      premise("the producer recorded exactly one action", after.actions.length, 1);
      expect(outcome).toMatchObject({ actionId: after.actions[0].id, status: TERMINAL[kind], decision: "allow" });
      if (kind === "succeeded") expect(outcome.result).toEqual(HANDLER_OUTPUT);
      expect({
        actions: statuses(after.actions),
        dispatched: handler.execute.mock.calls.length,
        terminalWrites: terminalWritesAttempted(client),
        terminalEvents: terminalAudits(after),
        faultEvents: faultEvents().length,
      }).toEqual({
        actions: [TERMINAL[kind]],
        dispatched: INVOCATIONS[kind],
        terminalWrites: [TERMINAL[kind]],
        terminalEvents: [`action.${TERMINAL[kind]}`],
        faultEvents: 0,
      });
    },
  );

  it.each(HANDLER_KINDS)(
    "[control] resolver · handler %s: an approved linked action reaches its confirmed terminal status with exactly the expected handler invocations, one terminal write, one terminal event and no fault event",
    async (kind) => {
      const fake = new FakeSupabase();
      const own = seedLinkedTuple(fake);
      const handler = recordingHandler(kind);
      const client = recordingDb(fake);

      const outcome = await resolve(client, own.approvalId, "approved", handler.handlers);
      const after = durable(fake);

      expect(outcome).toMatchObject({
        approvalRequestId: own.approvalId,
        status: "approved",
        actionId: own.actionId,
        actionStatus: TERMINAL[kind],
      });
      expect({
        approvals: statuses(after.approvals),
        actions: statuses(after.actions),
        dispatched: handler.execute.mock.calls.length,
        terminalWrites: terminalWritesAttempted(client),
        terminalEvents: terminalAudits(after),
        faultEvents: faultEvents().length,
      }).toEqual({
        approvals: ["approved"],
        actions: [TERMINAL[kind]],
        dispatched: INVOCATIONS[kind],
        terminalWrites: [TERMINAL[kind]],
        terminalEvents: [`action.${TERMINAL[kind]}`],
        faultEvents: 0,
      });
    },
  );

  it.each(HANDLER_KINDS.flatMap((kind) => FORMS.map((fault) => ({ kind, ...fault }))))(
    "runAction · handler $kind · terminal write · $label: the fixed typed fault carrying the true outcome and no settled response; the handler was not replayed, exactly one terminal write was attempted and it was not relabelled, the action is still running, and no action event exists",
    async ({ kind, form }) => {
      const fake = new FakeSupabase();
      seedPolicy(fake, "allow");
      const handler = recordingHandler(kind);
      const { client, displaced } = arm(fake, terminalWrite, form);

      const settled = await settle(produce(client, handler.handlers));
      const after = durable(fake);

      firedOnce(client, form, displaced.row);
      expectFault(settled);
      premise("the producer recorded exactly one action", after.actions.length, 1);
      expectFaultEvents([
        { phase: "action_finish", teamId: TEAM, actionId: after.actions[0].id, dispatch: DISPATCH[kind], outcome: kind },
      ]);
      // One terminal write, carrying what the handler actually did — never a second "failed" over it.
      expect({
        standing: after,
        actions: statuses(after.actions),
        approvals: after.approvals,
        dispatched: handler.execute.mock.calls.length,
        terminalWrites: terminalWritesAttempted(client),
        audited: audited(after),
        sandboxRuns: h.sandboxRun.mock.calls.length,
      }).toEqual({
        standing: client.atFault,
        actions: ["running"],
        approvals: [],
        dispatched: INVOCATIONS[kind],
        terminalWrites: [TERMINAL[kind]],
        audited: [],
        sandboxRuns: 0,
      });
    },
  );

  // The terminal write is the one statement runAction and the resolver share; the form cross is
  // above. Here each outcome is carried through the resolver's entry with its approval id.
  it.each(HANDLER_KINDS)(
    "resolver · handler %s · terminal write · returned error: the fixed typed fault carrying the true outcome and the approval id; the decision stays durable, the handler was not replayed, exactly one unrelabelled terminal write was attempted, the action is still running, and no terminal event exists",
    async (kind) => {
      const fake = new FakeSupabase();
      const own = seedLinkedTuple(fake);
      const handler = recordingHandler(kind);
      const { client, displaced } = arm(fake, terminalWrite, "error");

      const settled = await settle(resolve(client, own.approvalId, "approved", handler.handlers));
      const after = durable(fake);

      firedOnce(client, "error", displaced.row);
      expectFault(settled);
      expectFaultEvents([
        {
          phase: "action_finish",
          teamId: TEAM,
          actionId: own.actionId,
          approvalRequestId: own.approvalId,
          dispatch: DISPATCH[kind],
          outcome: kind,
        },
      ]);
      expect({
        standing: after,
        approval: after.approvals.map((row) => ({ status: row.status, decided_by: row.decided_by })),
        actions: statuses(after.actions),
        dispatched: handler.execute.mock.calls.length,
        terminalWrites: terminalWritesAttempted(client),
        terminalEvents: terminalAudits(after),
        sandboxRuns: h.sandboxRun.mock.calls.length,
      }).toEqual({
        standing: client.atFault,
        approval: [{ status: "approved", decided_by: DECIDER }],
        actions: ["running"],
        dispatched: INVOCATIONS[kind],
        terminalWrites: [TERMINAL[kind]],
        terminalEvents: [],
        sandboxRuns: 0,
      });
      expectDecisionAuditAtMost(after, "approved");
    },
  );
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// R — the exported POST of app/api/v1/actions/route.ts
// ─────────────────────────────────────────────────────────────────────────────────────────────────

describe("AIO-1217 R · POST /api/v1/actions (exported handler, unchanged): checked runAction faults answer with the fixed 500 internal envelope (AC-08)", () => {
  const ENDPOINT = "http://local/api/v1/actions";

  /** Hand the route this recording client (SEAM db). */
  function admit(client: RecordingDb): RecordingDb {
    h.db = client.db;
    return client;
  }

  const post = (body: unknown) =>
    POST(
      new NextRequest(ENDPOINT, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer aio1217-synthetic", "x-aios-team": TEAM },
        body: typeof body === "string" ? body : JSON.stringify(body),
      }),
    );

  type Seen = { status: number; contentType: string | null; wire: string; body: unknown };

  /** The response as a client would hold it: status, content type, and every header and body byte. */
  async function read(res: Response): Promise<Seen> {
    const text = await res.text();
    return {
      status: res.status,
      contentType: res.headers.get("content-type"),
      wire: `${JSON.stringify([...res.headers])}\n${text}`,
      body: JSON.parse(text) as unknown,
    };
  }

  /** `errorResponse`'s envelope: exactly `{ error: { code, message, request_id } }`, as JSON. */
  function expectErrorEnvelope(seen: Seen, status: number, code: string, message: unknown = expect.any(String)): void {
    expect({ status: seen.status, json: /^application\/json\b/.test(seen.contentType ?? "") }).toEqual({ status, json: true });
    expect(seen.body).toStrictEqual({ error: { code, message, request_id: expect.stringMatching(UUID_V4) } });
  }

  const admission = (client: RecordingDb) => ({
    authenticated: h.authenticateApiKey.mock.calls.length,
    rateLimitHits: client.rpcCalls,
  });
  const ADMITTED = { authenticated: 1, rateLimitHits: ["rate_limit_hit"] };

  const actionStatements = (client: RecordingDb) => client.statements.filter((statement) => statement.table === "actions");

  // ── admission boundaries: what a refused request looks like, so an admitted one is not vacuous ──

  it("boundary · no authenticated key: 401 unauthorized before the service client, the rate limiter, the body or any action", async () => {
    const fake = new FakeSupabase();
    seedPolicy(fake, "allow");
    const client = admit(recordingDb(fake));
    h.auth = null;

    const seen = await read(await post(REQUEST));

    expectErrorEnvelope(seen, 401, "unauthorized");
    expect({ ...admission(client), statements: client.statements, sandboxRuns: h.sandboxRun.mock.calls.length, faultEvents: faultEvents().length }).toEqual({
      authenticated: 1,
      rateLimitHits: [],
      statements: [],
      sandboxRuns: 0,
      faultEvents: 0,
    });
  });

  it("boundary · over the per-key limit: 429 rate_limited before the body is read or any action is recorded", async () => {
    const fake = new FakeSupabase();
    seedPolicy(fake, "allow");
    const client = admit(recordingDb(fake));
    h.rateLimitHits = 61;

    const seen = await read(await post(REQUEST));

    expectErrorEnvelope(seen, 429, "rate_limited");
    expect({ ...admission(client), statements: client.statements, sandboxRuns: h.sandboxRun.mock.calls.length, faultEvents: faultEvents().length }).toEqual({
      ...ADMITTED,
      statements: [],
      sandboxRuns: 0,
      faultEvents: 0,
    });
  });

  it.each([
    { name: "a body that is not JSON", body: "{" },
    { name: "a JSON body with no action type", body: { resource: RESOURCE, params: CODE_PARAMS } },
  ])("boundary · $name: 422 invalid_payload after admission, with no action recorded and nothing dispatched", async ({ body }) => {
    const fake = new FakeSupabase();
    seedPolicy(fake, "allow");
    const client = admit(recordingDb(fake));

    const seen = await read(await post(body));

    expectErrorEnvelope(seen, 422, "invalid_payload");
    expect({ ...admission(client), statements: client.statements, sandboxRuns: h.sandboxRun.mock.calls.length, faultEvents: faultEvents().length }).toEqual({
      ...ADMITTED,
      statements: [],
      sandboxRuns: 0,
      faultEvents: 0,
    });
  });

  // ── the four normal statuses, through the real runAction and the built-in code.run handler ──

  type Control = {
    name: string;
    effect: PolicyEffect;
    sandbox: SandboxBehaviour;
    status: 200 | 202 | 403 | 422;
    outcome: "succeeded" | "pending_approval" | "denied" | "failed";
    decision: "allow" | "require_approval" | "deny";
    runs: 0 | 1;
  };
  const CONTROLS: Control[] = [
    { name: "allowed, sandbox exit 0", effect: "allow", sandbox: "ok", status: 200, outcome: "succeeded", decision: "allow", runs: 1 },
    { name: "approval required", effect: "require_approval", sandbox: "ok", status: 202, outcome: "pending_approval", decision: "require_approval", runs: 0 },
    { name: "denied by policy", effect: "deny", sandbox: "ok", status: 403, outcome: "denied", decision: "deny", runs: 0 },
    { name: "allowed, sandbox exit 1", effect: "allow", sandbox: "exit1", status: 422, outcome: "failed", decision: "allow", runs: 1 },
  ];

  it.each(CONTROLS)(
    "[control] $name → $status $outcome: the admitted request settles for the authenticated key's team and member, with that standing action, exactly $runs sandbox run(s) and no fault event",
    async ({ effect, sandbox, status, outcome, decision, runs }) => {
      const fake = new FakeSupabase();
      seedPolicy(fake, effect);
      h.sandboxRun.mockImplementation(SANDBOX[sandbox]);
      const client = admit(recordingDb(fake));

      const seen = await read(await post(REQUEST));
      const after = durable(fake);

      premise("the request was admitted", admission(client), ADMITTED);
      premise("exactly one action was recorded", after.actions.length, 1);
      const terminal = outcome === "succeeded" || outcome === "failed";
      expect({ status: seen.status, json: /^application\/json\b/.test(seen.contentType ?? "") }).toEqual({ status, json: true });
      expect(seen.body).toMatchObject({
        actionId: after.actions[0].id,
        status: outcome,
        decision,
        ...(outcome === "pending_approval" ? { approvalRequestId: after.approvals[0]?.id } : {}),
        ...(terminal ? { result: { stdout: SANDBOX_STDOUT } } : {}),
      });
      expect({
        action: after.actions.map((row) => ({ team_id: row.team_id, member_id: row.member_id, actor: row.actor, status: row.status })),
        approvals: after.approvals.map((row) => ({ team_id: row.team_id, status: row.status, linked: row.id === after.actions[0].approval_request_id })),
        sandbox: h.sandboxRun.mock.calls,
        terminalWrites: terminalWritesAttempted(client),
        terminalEvents: terminalAudits(after),
        faultEvents: faultEvents().length,
      }).toEqual({
        action: [{ team_id: TEAM, member_id: MEMBER, actor: ACTOR, status: outcome }],
        approvals: outcome === "pending_approval" ? [{ team_id: TEAM, status: "pending", linked: true }] : [],
        sandbox: runs === 1 ? [[{ language: CODE_PARAMS.language, code: CODE_PARAMS.code }]] : [],
        terminalWrites: terminal ? [outcome] : [],
        terminalEvents: terminal ? [`action.${outcome}`] : [],
        faultEvents: 0,
      });
    },
  );

  // ── faults ──

  type RouteFault = {
    at: Matcher;
    name: string;
    effect: PolicyEffect;
    phase: string;
    sandbox: SandboxBehaviour;
    /** Sandbox runs this invocation must show: zero before dispatch, exactly one after. */
    runs: 0 | 1;
    dispatch: "not_started" | "attempted";
    outcome?: HandlerKind;
    /** Where the action must still stand. */
    standing: "requested" | "running";
    /** The status a confirmed transition would have answered with. */
    confirmed: number;
    form: Form;
    label: string;
  };
  const finish = (sandbox: SandboxBehaviour, outcome: HandlerKind, confirmed: number) => ({
    at: terminalWrite,
    name: `after dispatch · code.run ${outcome} · terminal write`,
    effect: "allow" as PolicyEffect,
    phase: "action_finish",
    sandbox,
    runs: 1 as const,
    dispatch: "attempted" as const,
    outcome,
    standing: "running" as const,
    confirmed,
  });
  const ROUTE_FAULTS: RouteFault[] = [
    ...REQUEST_TRANSITIONS.flatMap((request) =>
      FORMS.map((fault) => ({
        at: request.at,
        name: `before dispatch · ${request.transition}`,
        effect: request.effect,
        phase: request.phase,
        sandbox: "ok" as SandboxBehaviour,
        runs: 0 as const,
        dispatch: "not_started" as const,
        standing: "requested" as const,
        confirmed: request.confirmed,
        ...fault,
      })),
    ),
    ...FORMS.map((fault) => ({ ...finish("ok", "succeeded", 200), ...fault })),
    // A handler known to have failed is still not a settled 422 when its terminal write is unconfirmed.
    { ...finish("exit1", "returned_failure", 422), ...RETURNED_ERROR },
    { ...finish("throws", "threw", 422), ...CHECKED_ZERO },
  ];

  it.each(ROUTE_FAULTS)(
    "$name · $label: 500 internal with the fixed message — never the $confirmed a confirmed transition would give; no driver text, SQL, params, output or action id in the response, one allowlisted event with phase $phase / the action id / dispatch $dispatch, exactly $runs sandbox run(s), and the action still $standing",
    async ({ at, effect, phase, sandbox, runs, dispatch, outcome, standing, form }) => {
      const fake = new FakeSupabase();
      seedPolicy(fake, effect);
      h.sandboxRun.mockImplementation(SANDBOX[sandbox]);
      const { client, displaced } = arm(fake, at, form);
      admit(client);

      const seen = await read(await post(REQUEST));
      const after = durable(fake);

      firedOnce(client, form, displaced.row);
      premise("the request was admitted", admission(client), ADMITTED);
      premise(
        "exactly one action was recorded for the authenticated member",
        after.actions.map((row) => ({ member_id: row.member_id, actor: row.actor })),
        [{ member_id: MEMBER, actor: ACTOR }],
      );
      const actionId = String(after.actions[0].id);

      expectErrorEnvelope(seen, 500, "internal", FAULT_MESSAGE);
      // The envelope is the whole response: no invented action id field, and no id by any other route.
      expect({ leaks: leaks(seen.wire), namesAction: seen.wire.includes(actionId) }).toEqual({ leaks: [], namesAction: false });
      expectFaultEvents([
        {
          phase,
          teamId: TEAM,
          actionId,
          ...(phase === "request_approval_link" ? { approvalRequestId: after.approvals[0]?.id } : {}),
          dispatch,
          ...(outcome ? { outcome } : {}),
        },
      ]);
      expect({
        sandboxRuns: h.sandboxRun.mock.calls.length,
        terminalWrites: terminalWritesAttempted(client),
        standing: after,
        actions: statuses(after.actions),
        audited: audited(after),
      }).toEqual({
        sandboxRuns: runs,
        terminalWrites: outcome ? [TERMINAL[outcome]] : [],
        standing: client.atFault,
        actions: [standing],
        audited: [],
      });
    },
  );

  it("RESIDUAL (disclosed, not a guarantee) · no idempotency: after an uncertain completion the invocation itself never replays, but a fresh POST of the same body records a second action and executes it again, leaving the first still running", async () => {
    const fake = new FakeSupabase();
    seedPolicy(fake, "allow");
    const { client, displaced } = arm(fake, terminalWrite, "error");
    admit(client);

    const first = await read(await post(REQUEST));
    const uncertain = durable(fake);
    const runsAfterFirst = h.sandboxRun.mock.calls.length;
    const second = await read(await post(REQUEST));
    const after = durable(fake);

    firedOnce(client, "error", displaced.row);
    expectErrorEnvelope(first, 500, "internal", FAULT_MESSAGE);
    expect({ runsAfterFirst, uncertain: statuses(uncertain.actions) }).toEqual({ runsAfterFirst: 1, uncertain: ["running"] });

    // The first response named no action, so the client cannot tell the two apart: this is the residual.
    expect(second.status).toBe(200);
    expect(second.body).toMatchObject({ actionId: after.actions[1]?.id, status: "succeeded" });
    expect({
      first: after.actions[0],
      distinct: after.actions[0].id !== after.actions[1]?.id,
      actions: statuses(after.actions),
      inserts: actionStatements(client).filter((statement) => statement.operation === "insert").length,
      sandboxRuns: h.sandboxRun.mock.calls.length,
      terminalWrites: terminalWritesAttempted(client),
      faultEvents: faultEvents().length,
    }).toEqual({
      first: uncertain.actions[0],
      distinct: true,
      actions: ["running", "succeeded"],
      inserts: 2,
      sandboxRuns: 2,
      terminalWrites: ["succeeded", "succeeded"],
      faultEvents: 1,
    });
  });
});
