import { randomBytes, randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PgClient } from "@/lib/db/pg/client";
import { getPool, runSql } from "@/lib/db/pg/pool";
import type { DbClient, SqlExecutor } from "@/lib/db/types";
import { placeMemberByTier, seedTeam, type Seed } from "./helpers";

/**
 * AIO-1217 batch 7 — ONE BOUNDED NATIVE PROOF for
 * `app/t/[team]/codebases/[slug]/actions.ts#recordFindingDecision`: its inline team-posture conjunct,
 * executed as the actual exported function through a real signed session, the real `currentMember`
 * guard, membership-derived posture, `getCodebaseIdentity`, `decideCodebaseFinding` and the SQL
 * function `decide_codebase_finding` on the task's data-mechanics Postgres.
 *
 *   1. ADMITTED CONTROL — an active lead holding the team's builtin Everyone row decides an open
 *      finding of their own team. This shows the arrangement reaches the real owner path: the
 *      `codebases` identity read, the service client, one `decide_codebase_finding` call carrying the
 *      server-resolved team, codebase and actor, the finding's decision columns, one event, one
 *      `codebase_finding.decision` audit row and one revalidation.
 *   2. POSTURE REFUSAL — the same lead, the same session, on a NEW invocation, after ONLY their
 *      builtin Everyone row is removed (active same-team membership and the `lead` role retained),
 *      aiming at a fresh open finding in the same codebase. The export must return exactly
 *      `{ ok: false, error: "team leads or admins only" }`.
 *
 * What the refusal is held to.
 *   ordering   The session cookie is read; the `teams`, `members` and `group_members` reads are
 *              issued and answered (current-member identity is resolved: the membership read answers
 *              one row) — and nothing follows them: no `codebases` statement, no service-client
 *              acquisition, no `decide_codebase_finding` statement, no revalidation.
 *   durable    The refused target finding reads back identical, both as `to_jsonb(row)` (field for
 *              field) and as the row's own text record (byte for byte); the team's
 *              `codebase_finding_events` rows and its `codebase_finding.decision` audit rows are the
 *              very rows that stood before the call; the whole-rowset difference over every table
 *              snapshotted here is empty.
 *
 * What discriminates the inline conjunct. As read in postgres/schema.sql, the SQL function tests the
 * LEGACY `members.tier` column for the actor, which this case leaves at `team`: the owner's own
 * predicates are not what stops this caller. `getCodebaseIdentity` also returns null for a non-team
 * tier before it reads (its `canSeeCodebases` gate; lib/codebases/visibility is outside this slice's
 * read set), so the ABSENCE of a `codebases` statement alone does not separate the inline arm from
 * that lower gate. The returned error does: `team leads or admins only`, not `codebase not found`.
 *
 * What is real, and never mocked or handed a verdict: the export; `findingDecisionSchema`;
 * `currentMember` → `getSessionUser` → `verifySession` (jose HS256 against AUTH_SECRET) →
 * `resolveViewerPosture`; `getCodebaseIdentity`; `decideCodebaseFinding`; the SQL function; the
 * `audit` writer; the query builder, the pg pool and Postgres.
 *
 * The synthetic seams, all of them:
 *   SEAM cookies     `next/headers` `cookies` — resolves the jar of the one request in flight. The
 *                    session in it is a real `signSession` token for a real auth_users row that a
 *                    real member row is bound to. AUTH_SECRET is synthetic, random per test, and is
 *                    never logged, asserted on or returned.
 *   SEAM revalidate  `next/cache` `revalidatePath` — records the path.
 *   SEAM transport   `adminClient()` and `serverClient()` count their acquisitions and hand out, for
 *                    the duration of one request, a real `PgClient` whose SQL executor RECORDS and
 *                    then forwards to the real pool `runSql`. Nothing above the executor is replaced.
 *   SEAM adapter log `console.error` is captured for the duration of one request so that any failure
 *                    line the real adapter prints is accounted for (none is expected).
 * Rows are synthetic: seeded teams, members, auth users, a codebase and findings with made-up values.
 *
 * Fixture premises fail with the `FIXTURE` prefix and are never a security observation; a failed
 * admitted control says `CONTROL`.
 *
 * Bounds of what is claimed.
 *   - One export, one admitted control, one refusal: the posture conjunct for a LEAD. Not the role
 *     arm, not the membership chain, not an admin caller, not restoration of the Everyone row. Not
 *     AC-02, not action-inventory or registry completion, not mutation coverage.
 *   - A direct call of the exported function: not Next action-wire, POST dispatch, origin, action-id
 *     encryption or real cache-invalidation proof.
 *   - The audit writer's own statements (lib/api/audit is outside this slice's read set) are held to
 *     their durable row, not enumerated on the wire.
 *   - Membership is read per request: no revocation or linearizability claim is made.
 *   - No provider, model or network path is reached.
 *
 * Run status at authoring: NOT RUN. This file was written without executing vitest, tsc or any other
 * command. Its expectations come from reading the sources above, not from an observed run; replace
 * this paragraph with the observed result once it has been executed.
 */

const FIXTURE = "FIXTURE PREMISE FAILED (setup, not a security observation):";
const CONTROL = "ADMITTED CONTROL FAILED (the posture refusal would be vacuous):";

const h = vi.hoisted(() => ({
  /** SEAM cookies: the async `cookies()` of the request in flight. */
  cookies: vi.fn(),
  /** SEAM revalidate: records the paths the action asks to revalidate. */
  revalidatePath: vi.fn(),
  /** When set, the client `adminClient()` hands out: a real adapter over a recording executor. */
  adminDb: null as import("@/lib/db/types").DbClient | null,
  /** When set, the client `serverClient()` hands out: another, sharing the same trace. */
  serverDb: null as import("@/lib/db/types").DbClient | null,
  /** How often each factory was asked for a client; reset at the start of every request. */
  acquired: { server: 0, admin: 0 },
}));

vi.mock("next/headers", () => ({ cookies: h.cookies }));
vi.mock("next/cache", () => ({ revalidatePath: h.revalidatePath }));
// The real service client unless a request is in flight.
vi.mock("@/lib/db/admin", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/db/admin")>();
  return {
    ...original,
    adminClient: () => {
      h.acquired.admin += 1;
      return h.adminDb ?? original.adminClient();
    },
  };
});
// The real server client unless a request is in flight.
vi.mock("@/lib/db/server", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/db/server")>();
  return {
    ...original,
    serverClient: async () => {
      h.acquired.server += 1;
      return h.serverDb ?? original.serverClient();
    },
  };
});

import { recordFindingDecision } from "@/app/t/[team]/codebases/[slug]/actions";
import { SESSION_COOKIE, signSession, verifySession, type SessionUser } from "@/lib/auth/pg-session";
import type { FindingDecision } from "@/lib/codebases/finding-ledger";

type Row = Record<string, unknown>;
type Via = "admin" | "server";

/** One team, two sessions, a control and a refusal, and whole-rowset snapshots around each. */
const ROOMY = 30_000;

const LEADS_OR_ADMINS_ONLY = { ok: false, error: "team leads or admins only" };
const DECISION_AUDIT_ACTION = "codebase_finding.decision";

// What became of a recorded statement.
const SENT = "sent";
const ANSWERED = "answered";
const NATIVE_ERROR = "native error:";

interface Statement {
  via: Via;
  op: string;
  table: string;
  /** The equality predicates of the compiled WHERE clause, with the values bound into them. */
  where: Row;
  text: string;
  params: unknown[];
  /** The row count Postgres really answered; null until it does. */
  rowCount: number | null;
  outcome: string;
  /** The client acquisitions counted when this statement was issued. */
  acquired: { server: number; admin: number };
}

/** One statement as the cases compare it: who issued it, what it was bound to, how many rows answered. */
interface Wire {
  via: Via;
  op: string;
  table: string;
  where: Row;
  rows: number | null;
}

interface Flight {
  jar: Map<string, string>;
  cookieReads: string[];
  statements: Statement[];
}

/** How a call ended: what it returned, or how its rejection classifies. */
type Settled = { returned: unknown } | { rejected: { error: boolean; message: string } };

interface Seen {
  outcome: Settled;
  before: Durable;
  after: Durable;
  statements: Statement[];
  cookieReads: string[];
  acquired: { server: number; admin: number };
  revalidated: unknown[];
}

interface Cast {
  label: string;
  team: Seed;
  memberId: string;
  user: SessionUser;
  /** `signSession(user)` under this test's AUTH_SECRET. */
  session: string;
}

/** The conjuncts the action's gate reads off a member's rows, and the legacy column it does not. */
interface Standing {
  role: string;
  status: string;
  tier: string;
  everyone_rows: number;
  external_rows: number;
}

/** An active lead holding the builtin Everyone row, with the legacy tier column agreeing. */
const IN_TEAM_POSTURE: Standing = { role: "lead", status: "active", tier: "team", everyone_rows: 1, external_rows: 0 };
/** The same lead with ONLY the Everyone row gone: role, status and the legacy tier column untouched. */
const OUT_OF_TEAM_POSTURE: Standing = { ...IN_TEAM_POSTURE, everyone_rows: 0 };

/** The one request in flight; null between requests. */
let inFlight: Flight | null = null;
/** Makes every seeded input distinct, so a wrongly admitted call cannot hide behind an equal row. */
let serial = 0;
const next = (): number => ++serial;

beforeEach(() => {
  vi.stubEnv("AUTH_SECRET", randomBytes(32).toString("hex"));
  inFlight = null;
  serial = 0;
  h.adminDb = null;
  h.serverDb = null;
  h.revalidatePath.mockReset();
  h.cookies.mockReset();
  h.cookies.mockImplementation(async () => {
    // Bound to the request in flight when `cookies()` was called.
    const flight = inFlight;
    if (!flight) throw new Error(`${FIXTURE} cookies() called with no request in flight`);
    return {
      get: (name: string) => {
        flight.cookieReads.push(name);
        const value = flight.jar.get(name);
        return value === undefined ? undefined : { name, value };
      },
    };
  });
});

afterEach(() => {
  h.adminDb = null;
  h.serverDb = null;
  vi.unstubAllEnvs();
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

const DURABLE_TABLES = [
  "teams",
  "members",
  "groups",
  "group_members",
  "codebases",
  "codebase_findings",
  "codebase_finding_events",
  "audit_log",
] as const;
type DurableTable = (typeof DURABLE_TABLES)[number];
type Durable = Record<DurableTable, Row[]>;
type Changed = Partial<Record<DurableTable, { added: Row[]; removed: Row[] }>>;

/** Every row of every durable table, every column, in an order that depends on content only. */
async function durable(): Promise<Durable> {
  const snapshot = {} as Durable;
  for (const table of DURABLE_TABLES) {
    const rows = await fx<{ row: Row }>(
      `${table} snapshot`,
      `select to_jsonb(t) as row from ${table} t order by to_jsonb(t)::text`,
    );
    snapshot[table] = rows.map((entry) => entry.row);
  }
  return snapshot;
}

/** The rows a request added and removed, per table; a changed row is one of each. Empty when none. */
function changes(before: Durable, after: Durable): Changed {
  const changed: Changed = {};
  for (const table of DURABLE_TABLES) {
    const was = new Set(before[table].map((row) => JSON.stringify(row)));
    const is = new Set(after[table].map((row) => JSON.stringify(row)));
    const added = after[table].filter((row) => !was.has(JSON.stringify(row)));
    const removed = before[table].filter((row) => !is.has(JSON.stringify(row)));
    if (added.length > 0 || removed.length > 0) changed[table] = { added, removed };
  }
  return changed;
}

/** One finding twice over: every column as jsonb (field for field) and the row's text record (byte for byte). */
const findingRow = (id: string): Promise<{ row: Row; record: string }> =>
  fxOne<{ row: Row; record: string }>(
    "codebase_findings readback",
    `select to_jsonb(t) as row, t::text as record from codebase_findings t where t.id = $1`,
    [id],
  );

/** Every finding event of the team, whole rows. Only operator decisions write any in this fixture. */
const findingEvents = async (team: Seed): Promise<Row[]> =>
  (
    await fx<{ row: Row }>(
      "codebase_finding_events readback",
      `select to_jsonb(t) as row from codebase_finding_events t where t.team_id = $1 order by to_jsonb(t)::text`,
      [team.teamId],
    )
  ).map((entry) => entry.row);

/** Every `codebase_finding.decision` audit row of the team, whole rows. */
const decisionAudits = async (team: Seed): Promise<Row[]> =>
  (
    await fx<{ row: Row }>(
      "audit_log readback",
      `select to_jsonb(t) as row from audit_log t where t.team_id = $1 and t.action = $2 order by to_jsonb(t)::text`,
      [team.teamId, DECISION_AUDIT_ACTION],
    )
  ).map((entry) => entry.row);

async function authority(memberId: string) {
  const builtinRows = (slug: string) =>
    `(select count(*)::int from group_members gm
        join groups g on g.team_id = gm.team_id and g.id = gm.group_id
       where gm.team_id = m.team_id and gm.member_id = m.id and g.slug = '${slug}' and g.is_builtin)`;
  return fxOne(
    "authority readback",
    `select m.team_id, m.role::text as role, m.status::text as status, m.tier::text as tier, m.auth_user_id,
            ${builtinRows("everyone")} as everyone_rows, ${builtinRows("external")} as external_rows
       from members m where m.id = $1`,
    [memberId],
  );
}

async function standingOf(cast: Cast): Promise<Standing> {
  const { role, status, tier, everyone_rows, external_rows } = await authority(cast.memberId);
  return { role, status, tier, everyone_rows, external_rows } as Standing;
}

/** How many group rows the posture read will be answered with for this member. */
const groupRows = async (cast: Cast): Promise<number> =>
  (
    await fxOne<{ n: number }>(
      "group row count",
      `select count(*)::int as n from group_members where team_id = $1 and member_id = $2`,
      [cast.team.teamId, cast.memberId],
    )
  ).n;

/**
 * A distinct active member in team posture (the builtin Everyone row, legacy tier `team`) bound to a
 * fresh auth user, and a real session signed for that auth user. Nothing about the guard is stubbed.
 */
async function seedCast(team: Seed, label: string, role: "lead" | "member"): Promise<Cast> {
  const user = { id: randomUUID(), email: `${label}-${randomUUID().slice(0, 8)}@aio1217.fixture.test` };
  await fxOne("auth user insert", `insert into auth_users(id, email) values($1, $2) returning id`, [user.id, user.email]);
  const { id } = await fxOne<{ id: string }>(
    "member insert",
    `insert into members(team_id, email, display_name, actor_handle, role, tier, status, auth_user_id)
     values($1, $2, $3, $4, $5, 'team', 'active', $6) returning id`,
    [team.teamId, user.email, `AIO1217 ${label}`, `${label}-${randomUUID().slice(0, 8)}`, role, user.id],
  );
  await placeMemberByTier(team.teamId, id, "team");
  premise(`${label}'s authority`, await authority(id), {
    team_id: team.teamId,
    auth_user_id: user.id,
    role,
    status: "active",
    tier: "team",
    everyone_rows: 1,
    external_rows: 0,
  });
  const session = await signSession(user);
  premise(`${label}'s session verifies under the real verifier`, await verifySession(session), user);
  return { label, team, memberId: id, user, session };
}

async function seedCodebase(team: Seed): Promise<{ id: string; slug: string }> {
  return fxOne<{ id: string; slug: string }>(
    "codebase insert",
    `insert into codebases(team_id, slug) values($1, $2) returning id, slug`,
    [team.teamId, `aio1217-codebase-${next()}`],
  );
}

/** A fresh open finding of `team` in the given codebase; returns its id. */
async function seedFinding(team: Seed, codebaseId: string): Promise<string> {
  const finding = await fxOne<{ id: string }>(
    "finding insert",
    `insert into codebase_findings(team_id, codebase_id, fingerprint, status, check_id, axis, kind, severity,
                                   evidence_status, remediation_tier, occurrence_count, first_seen_sha,
                                   last_seen_sha, first_seen_at, last_seen_at)
     values($1, $2, $3, 'open', 'coverage_lines_pct', 'test_rigor', 'quality_issue', 'high',
            'complete', 1, 2, $4, $5, now() - interval '10 days', now() - interval '10 days')
     returning id`,
    [team.teamId, codebaseId, randomBytes(32).toString("hex"), "1".repeat(40), "2".repeat(40)],
  );
  return finding.id;
}

/** A decision the real schema and the SQL function both accept for an open finding. */
const decision = (findingId: string, ownerMemberId: string): FindingDecision => ({
  findingId,
  ownerMemberId,
  status: "risk_accepted",
  reason: `AIO1217 synthetic decision reason ${next()}`,
  expiresAt: new Date(Date.now() + 30 * 86_400_000).toISOString(),
});

async function removeEveryone(cast: Cast): Promise<void> {
  await fxOne(
    "everyone row removal",
    `delete from group_members gm using groups g
      where g.team_id = gm.team_id and g.id = gm.group_id and g.slug = 'everyone' and g.is_builtin
        and gm.team_id = $1 and gm.member_id = $2
      returning gm.member_id`,
    [cast.team.teamId, cast.memberId],
  );
}

// ── the recording transport ──────────────────────────────────────────────────────────────────────

const EQUALITY = /([a-z_][a-z0-9_.]*) = \$(\d+)/g;

/** The `column = $n` terms of a compiled clause, with the value bound to each placeholder. */
function equalities(clause: string, params: unknown[]): Row {
  const bound: Row = {};
  for (const match of clause.matchAll(EQUALITY)) bound[match[1]] = params[Number(match[2]) - 1];
  return bound;
}

/**
 * What the real adapter compiled, read off its statement heads. A function call (`SELECT fn(...)`,
 * no FROM) is an `rpc` on that function. Embedded resources compile to lowercase subselects, so the
 * last uppercase FROM of a SELECT is its own table and the first uppercase WHERE its own clause.
 */
function compiled(text: string, params: unknown[]): Pick<Statement, "op" | "table" | "where"> {
  const call = /^SELECT ([a-z_]+)\(/.exec(text);
  if (call && !text.includes(" FROM ")) return { op: "rpc", table: call[1], where: {} };
  const insert = /^INSERT INTO ([a-z_]+) \(/.exec(text);
  if (insert) return { op: text.includes(" ON CONFLICT (") ? "upsert" : "insert", table: insert[1], where: {} };
  const at = text.indexOf(" WHERE ");
  const head = at === -1 ? text : text.slice(0, at);
  const where = at === -1 ? {} : equalities(text.slice(at), params);
  const update = /^UPDATE ([a-z_]+) SET /.exec(head);
  if (update) return { op: "update", table: update[1], where };
  const remove = /^DELETE FROM ([a-z_]+) /.exec(text);
  if (remove) return { op: "delete", table: remove[1], where };
  const select = /^SELECT [\s\S]* FROM ([a-z_]+) /.exec(text);
  if (select) return { op: "select", table: select[1], where };
  return { op: (text.trim().split(/\s+/)[0] ?? "").toLowerCase(), table: "", where: {} };
}

/**
 * A real `PgClient` whose executor records each compiled statement, forwards it to the real pool
 * and records the row count Postgres answered. The recorder decides nothing and never throws on its
 * own account.
 */
function recordingClient(via: Via, flight: Flight): DbClient {
  const record =
    (inner: SqlExecutor): SqlExecutor =>
    async <T = Row>(text: string, params: unknown[] = []) => {
      const statement: Statement = {
        via,
        ...compiled(text, params),
        text,
        params: [...params],
        rowCount: null,
        outcome: SENT,
        acquired: { ...h.acquired },
      };
      flight.statements.push(statement);
      try {
        const answered = await inner<T>(text, params);
        statement.rowCount = answered.rowCount;
        statement.outcome = ANSWERED;
        return answered;
      } catch (error) {
        statement.outcome = `${NATIVE_ERROR} ${error instanceof Error ? error.message : String(error)}`;
        throw error;
      }
    };
  return new PgClient({ executor: record(runSql), decorateSessionExecutor: record }) as unknown as DbClient;
}

async function settle(start: () => Promise<unknown>): Promise<Settled> {
  try {
    return { returned: await start() };
  } catch (thrown) {
    return {
      rejected: { error: thrown instanceof Error, message: thrown instanceof Error ? thrown.message : String(thrown) },
    };
  }
}

/**
 * A new request with its own cookie jar and trace: snapshot, run the actual export, snapshot again.
 * No statement is expected to be refused by Postgres and no adapter failure line is expected; either
 * fails a fixture premise.
 */
async function request(session: string, action: () => Promise<unknown>): Promise<Seen> {
  const flight: Flight = { jar: new Map([[SESSION_COOKIE, session]]), cookieReads: [], statements: [] };
  h.revalidatePath.mockClear();
  // The real adapter logs each failure it converts; captured so every such line is accounted for.
  const adapterLog = vi.spyOn(console, "error").mockImplementation(() => {});
  let logged: string[] = [];
  let acquired = { server: 0, admin: 0 };

  const before = await durable();
  inFlight = flight;
  h.adminDb = recordingClient("admin", flight);
  h.serverDb = recordingClient("server", flight);
  h.acquired.server = 0;
  h.acquired.admin = 0;
  let outcome: Settled;
  try {
    outcome = await settle(action);
  } finally {
    acquired = { server: h.acquired.server, admin: h.acquired.admin };
    inFlight = null;
    h.adminDb = null;
    h.serverDb = null;
    logged = adapterLog.mock.calls.map((call) => String(call[0]));
    adapterLog.mockRestore();
  }
  const after = await durable();

  premise(
    "Postgres refused no statement of this request",
    flight.statements
      .filter((statement) => statement.outcome.startsWith(NATIVE_ERROR))
      .map((statement) => ({ op: statement.op, table: statement.table, outcome: statement.outcome })),
    [],
  );
  premise(
    "the real adapter surfaced no failure of its own",
    logged.filter((line) => line.startsWith("[pg]")),
    [],
  );

  return {
    outcome,
    before,
    after,
    statements: flight.statements,
    cookieReads: flight.cookieReads,
    acquired,
    revalidated: h.revalidatePath.mock.calls.map((call) => call[0]),
  };
}

/** Every statement either client issued, in order, each reduced to what it was bound to. */
const wireOf = (seen: Seen): Wire[] =>
  seen.statements.map(({ via, op, table, where, rowCount }) => ({ via, op, table, where, rows: rowCount }));

/** Every recorded statement naming the owner function, whichever client issued it and however it compiled. */
const ownerCalls = (seen: Seen): Statement[] =>
  seen.statements.filter((statement) => /\bdecide_codebase_finding\b/i.test(statement.text));

// ── what the guard and the owner put on the wire ─────────────────────────────────────────────────

// The statements the action and its guard issue before admission, as read from the action file,
// lib/auth/guard and lib/access/posture; and the identity read and owner call that follow it.
const teamRead = (team: Seed): Wire => ({
  via: "server",
  op: "select",
  table: "teams",
  where: { slug: team.teamSlug },
  rows: 1,
});
const memberRead = (team: Seed, user: SessionUser, rows: number): Wire => ({
  via: "server",
  op: "select",
  table: "members",
  where: { team_id: team.teamId, auth_user_id: user.id, status: "active" },
  rows,
});
const postureRead = (team: Seed, memberId: string, rows: number): Wire => ({
  via: "server",
  op: "select",
  table: "group_members",
  where: { team_id: team.teamId, member_id: memberId },
  rows,
});
const codebaseRead = (team: Seed, slug: string, rows: number): Wire => ({
  via: "server",
  op: "select",
  table: "codebases",
  where: { team_id: team.teamId, slug },
  rows,
});
const DECISION_CALL = { via: "admin", op: "rpc", table: "decide_codebase_finding", where: {} } as const;

const codebasePath = (team: Seed, codebaseSlug: string) => `/t/${team.teamSlug}/codebases/${codebaseSlug}`;

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// F — app/t/[team]/codebases/[slug]/actions.ts#recordFindingDecision · the inline posture conjunct
// ─────────────────────────────────────────────────────────────────────────────────────────────────

describe("F — app/t/[team]/codebases/[slug]/actions.ts#recordFindingDecision (the inline team-posture conjunct: real session, real guard, real Postgres owner)", () => {
  it(
    "a lead admitted in team posture on a same-team finding, the builtin Everyone row then removed, is refused on a NEW invocation with exactly `team leads or admins only` — after the membership and posture reads and before the codebases read, the service client, the decide_codebase_finding call, the audit row and revalidation; the target finding, the team's finding events and its decision audit rows stand unchanged",
    async () => {
      const team = await seedTeam();
      const alice = await seedCast(team, "alice", "lead");
      const owner = await seedCast(team, "owner", "member");
      const codebase = await seedCodebase(team);
      const team_id = team.teamId;

      // ── 1. admitted control: the arrangement reaches the real owner path ─────────────────────────
      const controlFindingId = await seedFinding(team, codebase.id);
      const controlInput = decision(controlFindingId, owner.memberId);
      const standingControl = await findingRow(controlFindingId);
      const controlPostureRows = await groupRows(alice);

      const admitted = await request(alice.session, () =>
        recordFindingDecision(team.teamSlug, codebase.slug, controlInput),
      );

      const decided = (await findingRow(controlFindingId)).row;
      expect(
        {
          outcome: admitted.outcome,
          identity: admitted.cookieReads,
          // Up to and including the owner call; the audit writer's statements are held to their durable row.
          admission: wireOf(admitted).slice(0, 5),
          ownerCalls: ownerCalls(admitted).map(({ via, params, acquired }) => ({ via, params, acquired })),
          changed: changes(admitted.before, admitted.after),
          expiresAtInstant: Date.parse(String(decided.decision_expires_at)),
          revalidated: admitted.revalidated,
          standing: await standingOf(alice),
        },
        CONTROL,
      ).toEqual({
        outcome: { returned: { ok: true } },
        identity: [SESSION_COOKIE],
        admission: [
          // The team is read by slug before the caller is identified.
          teamRead(team),
          memberRead(team, alice.user, 1),
          postureRead(team, alice.memberId, controlPostureRows),
          codebaseRead(team, codebase.slug, 1),
          { ...DECISION_CALL, rows: 1 },
        ],
        ownerCalls: [
          {
            via: "admin",
            // Team, codebase and actor are the server's; finding, owner, status, reason and expiry are forwarded.
            params: [
              team_id,
              codebase.id,
              controlFindingId,
              alice.memberId,
              owner.memberId,
              controlInput.status,
              controlInput.reason,
              controlInput.expiresAt,
            ],
            // The action's server client and the guard's, then the one service client the owner call rides.
            acquired: { server: 2, admin: 1 },
          },
        ],
        changed: {
          // Only the decision columns of the bound finding moved.
          codebase_findings: {
            added: [
              {
                ...standingControl.row,
                status: controlInput.status,
                decision_reason: controlInput.reason,
                decision_owner_member_id: owner.memberId,
                decision_by_member_id: alice.memberId,
                decision_at: expect.any(String),
                decision_expires_at: expect.any(String),
                updated_at: expect.any(String),
              },
            ],
            removed: [standingControl.row],
          },
          codebase_finding_events: {
            added: [
              expect.objectContaining({
                team_id,
                codebase_id: codebase.id,
                finding_id: controlFindingId,
                metrics_id: null,
                event_type: controlInput.status,
                from_status: "open",
                to_status: controlInput.status,
                details: expect.objectContaining({
                  reason: controlInput.reason,
                  owner_member_id: owner.memberId,
                  actor_member_id: alice.memberId,
                }),
              }),
            ],
            removed: [],
          },
          audit_log: {
            added: [
              expect.objectContaining({
                team_id,
                actor_kind: "member",
                member_id: alice.memberId,
                action: DECISION_AUDIT_ACTION,
                target_type: "codebase_finding",
                target_id: controlFindingId,
                meta: {
                  status: controlInput.status,
                  owner_member_id: owner.memberId,
                  expires_at: controlInput.expiresAt,
                },
              }),
            ],
            removed: [],
          },
        },
        expiresAtInstant: Date.parse(controlInput.expiresAt),
        revalidated: [codebasePath(team, codebase.slug)],
        standing: IN_TEAM_POSTURE,
      });

      // ── 2. the one conjunct removed: the builtin Everyone row, and nothing else ──────────────────
      // A fresh open finding in the same codebase: had the gate admitted the call, its row would show.
      const targetFindingId = await seedFinding(team, codebase.id);
      await removeEveryone(alice);
      premise(
        "the lead keeps an active same-team lead membership and the legacy tier column, and holds no builtin row",
        await standingOf(alice),
        OUT_OF_TEAM_POSTURE,
      );
      const input = decision(targetFindingId, owner.memberId);
      const standingTarget = await findingRow(targetFindingId);
      const standingEvents = await findingEvents(team);
      const standingAudits = await decisionAudits(team);
      premise(
        "before the refused call the target finding is open and undecided, and the only event and decision audit row are the control's",
        {
          target: [standingTarget.row.status, standingTarget.row.decision_at, standingTarget.row.decision_by_member_id],
          events: standingEvents.map((event) => event.finding_id),
          audits: standingAudits.map((entry) => entry.target_id),
        },
        { target: ["open", null, null], events: [controlFindingId], audits: [controlFindingId] },
      );
      const postureRows = await groupRows(alice);

      // The same session, on a new invocation.
      const refused = await request(alice.session, () => recordFindingDecision(team.teamSlug, codebase.slug, input));

      // The action's actual return contract, exactly.
      expect(refused.outcome).toStrictEqual({ returned: { ok: false, error: "team leads or admins only" } });
      // The owner function was never put on the wire by either client, and nothing was revalidated.
      expect(ownerCalls(refused)).toEqual([]);
      expect(h.revalidatePath).not.toHaveBeenCalled();
      // The refused target finding: field for field, and byte for byte.
      expect(await findingRow(targetFindingId)).toStrictEqual(standingTarget);

      expect({
        outcome: refused.outcome,
        identity: refused.cookieReads,
        wire: wireOf(refused),
        acquired: refused.acquired,
        changed: changes(refused.before, refused.after),
        findingEvents: await findingEvents(team),
        decisionAudits: await decisionAudits(team),
        revalidated: refused.revalidated,
        standing: await standingOf(alice),
      }).toEqual({
        outcome: { returned: LEADS_OR_ADMINS_ONLY },
        identity: [SESSION_COOKIE],
        // Current-member identity is resolved (the membership read answers one row) and posture is
        // read; no `codebases` statement, owner call or audit insert follows.
        wire: [
          teamRead(team),
          memberRead(team, alice.user, 1),
          postureRead(team, alice.memberId, postureRows),
        ],
        // The action's own server client, then the guard's; never the service client.
        acquired: { server: 2, admin: 0 },
        changed: {},
        // No decision event and no `codebase_finding.decision` audit row was added: the control's stand alone.
        findingEvents: standingEvents,
        decisionAudits: standingAudits,
        revalidated: [],
        standing: OUT_OF_TEAM_POSTURE,
      });
    },
    ROOMY,
  );
});

// Each TODO names evidence this slice was not supplied with; none is implied by the case above.
describe("Z — follow-up evidence this fixture does NOT supply (executable TODOs: none is run, none is passed)", () => {
  it.todo(
    "LOOKUP-ERROR: with every authority row standing, fail in turn the action's `teams` read, the guard's `members` read and the posture `group_members` read — record what recordFindingDecision returns or rejects with for each (the action discards the `teams` and `members` read errors; the posture owner throws and the action does not catch it) and that no codebases read, service client, decide_codebase_finding call, audit row or revalidation follows",
  );
  it.todo(
    "CROSS-TEAM OWNER: an admitted lead supplying an ownerMemberId, a findingId or a codebase slug that another team holds — the team-bound identity read and the SQL function's own same-team finding and owner predicates, with no finding of either team changed, no event, no audit row and no revalidation",
  );
  it.todo(
    "ACTION-REGISTRATION: tie this file's collected case name and an observed run result to the recordFindingDecision row of the server-action registry/inventory, and prove the export through the Next action wire (registered action id, POST dispatch, origin check) rather than by direct call",
  );
  it.todo(
    "MUTATION (isolated copy, actual import): drop recordFindingDecision's inline `me.tier !== \"team\"` arm and run this case — record whether the refusal then fails on the returned error only (getCodebaseIdentity's own tier gate may still stop the codebases read) or also on the wire and the durable difference; then drop the null-member arm and the role arm and record the same",
  );
});
