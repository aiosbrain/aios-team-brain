import { randomBytes, randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PgClient } from "@/lib/db/pg/client";
import { getPool, runSql } from "@/lib/db/pg/pool";
import type { DbClient, SqlExecutor } from "@/lib/db/types";
import { placeMemberByTier, seedTeam, type Seed } from "./helpers";

/**
 * AIO-1217 — TWO MEMBER-TIER ACTIONS against real Postgres: the membership gate of
 * `createProjectAction` and the lead-or-admin gate of `recordFindingDecision`, executed as the
 * actual exported functions through the actual guard, the actual lower owners and the task's
 * data-mechanics Postgres. This is the PG complement of groups M and F of the unit-tier
 * `test/actions/aio1217-admin-operations-auth.test.ts`: that file doubles the creator grant, the
 * graph pointer writer, the `projects` insert and the decision function, and proves wiring; this one
 * doubles none of them and proves what they cannot — the rows, the constraint, the SQL function's own
 * predicates and the statements Postgres was actually sent.
 *
 *   M — createProjectAction: an admitted ordinary member on each of two teams, the role and posture
 *       variants that are admitted identically, then every refusal after an admitted control.
 *   F — recordFindingDecision: an admitted admin and lead on each of two teams, every refusal after
 *       an admitted control, and removal then restoration of the builtin Everyone row.
 *   T — what the lower owners own once a caller is admitted: the `projects` unique constraint, the
 *       team-bound codebase identity read, and the SQL function's own finding, owner and actor checks.
 *   Z — what this fixture does not supply, as executable TODOs naming the later owner.
 *
 * PER-EXPORT EVIDENCE RECORD. Key is `<repository path>#<export>`. Everything in this file is
 * SYNTHETIC-PG evidence: real adapter, real pool, real schema, synthetic rows and sessions.
 *
 *   app/actions/projects.ts#createProjectAction
 *     guard              MEM: `currentMember` — a session the real verifier accepts and an active
 *                        membership of the supplied team id. NO role and NO posture conjunct.
 *     admitted before    name/slug validation; the session cookie read; the `members` read bound to
 *                        the supplied team, the session's user and active status; the posture read
 *     refusal            { ok: false, error: "not a member of this team" }
 *     forbidden after    a second server-client acquisition; the `projects` insert; the creator's
 *                        person-singleton `groups` and `group_members` rows; the `project_groups`
 *                        grant; the `projects.graph_group_id` pointer write; any `audit_log` row
 *     admitted control   a role-member holding the builtin Everyone row → one initiative row for the
 *                        supplied team, the creator's singleton and grant, both access audit rows,
 *                        the minted pointer — the insert first, the grant before the pointer
 *     cases (group M)    "admitted: …"   "admitted identically: $name …" (4)   "refused: $name …" (7)
 *     cases (group T)    "…createProjectAction · a second member re-submitting a name the team
 *                        already holds …"
 *
 *   app/t/[team]/codebases/[slug]/actions.ts#recordFindingDecision
 *     guard              LEAD (tier=team): `currentMember`, then inline role admin OR lead, then
 *                        inline team posture (the builtin Everyone row)
 *     admitted before    schema validation; the `teams` read by slug (issued before the caller is
 *                        identified); the session cookie read; the `members` and posture reads
 *     refusal            { ok: false, error: "team leads or admins only" }
 *     forbidden after    the `codebases` identity read; the service client; the
 *                        `decide_codebase_finding` call; the `codebase_findings` update and its
 *                        `codebase_finding_events` row; the `codebase_finding.decision` audit row;
 *                        revalidation
 *     admitted control   an admin, and a lead, each holding the builtin Everyone row with legacy tier
 *                        `team` → the identity read bound to the resolved team, one function call
 *                        carrying the resolved team, codebase and actor, the finding row's decision
 *                        columns and nothing else in it, one event, one audit row, one revalidation
 *     cases (group F)    "admitted: an active $role …" (2)   "refused: $name …" (11)   "a prior
 *                        admitted lead, the builtin Everyone row then removed …"
 *     cases (group T)    "…recordFindingDecision · $name …" (3)   "…recordFindingDecision · a lead
 *                        whose legacy tier column says external …"
 *
 * What is real, and never mocked or handed a verdict: the two exports; `currentMember` →
 * `getSessionUser` → `verifySession` (jose HS256 against AUTH_SECRET) → `resolveViewerPosture`;
 * `slugify`; `lib/access/groups` `ensurePersonSingleton` and `grantProjectToGroup`;
 * `lib/graph/project-pointer` `ensureProjectGraphPointer`; `getCodebaseIdentity`;
 * `findingDecisionSchema` and `decideCodebaseFinding`; the SQL function `decide_codebase_finding`;
 * the `audit` writer; the query builder, the pg pool and Postgres.
 *
 * The synthetic seams, all of them:
 *   SEAM cookies     `next/headers` `cookies` — resolves the jar of the one request in flight. The
 *                    session in it is a real `signSession` token for a real auth_users row that a
 *                    real member row is bound to. AUTH_SECRET is synthetic per test.
 *   SEAM revalidate  `next/cache` `revalidatePath` — records the path.
 *   SEAM transport   `adminClient()` and `serverClient()` count their acquisitions and hand out, for
 *                    the duration of one request, a real `PgClient` whose SQL executor RECORDS and
 *                    then forwards to the real pool `runSql`. Nothing above the executor is replaced.
 *                    This seam is what shows a refused caller issued no statement after the guard's.
 *
 * THE FAULT IS SYNTHETIC. At most one fault is armed per request, for the first SELECT the server
 * client issues against a named guard table. That statement is NOT sent: the executor rejects, and
 * the real adapter turns the rejection into its own returned `{ error }` envelope. It is not a
 * native driver failure. Each fault case asserts the fault fired exactly once and that the adapter
 * surfaced it.
 *
 * Every request is one grouped assertion over: how the call settled; the session cookie read; every
 * statement either client issued, in order, with the equalities bound into it and the row count
 * Postgres answered; the client acquisitions; the durable difference, computed from whole rowsets
 * read from the pool before and after (rows, not counts); and the revalidation trace. A refusal owes
 * only the guard's own statements, no further acquisition, an empty difference and no revalidation —
 * with a fresh valid input, so an admitted call would have shown.
 *
 * Each refusal removes ONE conjunct after an admitted control on the same fixture — from the
 * request's session, from the real rows, or by one armed read fault — and then reads the caller's
 * authority rows back from the pool to show which. Fixture premises fail with the `FIXTURE` prefix
 * and are never a security observation; a failed admitted control says `CONTROL`.
 *
 * Bounds of what is claimed.
 *   - Two selected exports only: focused evidence for their two registry rows. Not completion of
 *     AC-04 or AC-05, not the 95-action or 15-connection evidence, not a census, and nothing about
 *     AIO-1225, AIO-1226, AIO-1227 or AIO-1228.
 *   - Direct calls of the exported functions: not Next action-wire, POST dispatch, origin, encryption
 *     or real cache-invalidation proof.
 *   - M's admitted assertions are for a member's FIRST creation: their person singleton does not yet
 *     exist. The lower owners' statements are asserted by anchor (the insert first, the grant before
 *     the pointer write, the set of tables written) and by durable effect, not enumerated one by one.
 *   - T pins CURRENT BEHAVIOR of the lower owners for an admitted caller. In particular the SQL
 *     function reads the LEGACY `members.tier` column for the actor and the owner, while the action
 *     reads membership-derived posture. Where the two disagree the action admits and the function
 *     refuses; that is recorded, not endorsed, and no policy is specified for it here.
 *   - The `teams` read of recordFindingDecision is not faulted. A faulted membership read is pinned
 *     as the fail-closed refusal the owner returns today, because it discards that read's error.
 *   - No provider, model, graph service or network path is reached: the pointer writer stores a
 *     computed id and calls nothing.
 *   - Membership is read per request: no revocation or linearizability claim is made.
 *
 * Run status at authoring: NOT RUN. This file was written without executing vitest, tsc or any other
 * command. Its expectations come from reading the sources above, not from an observed run; replace
 * this paragraph with the observed result once it has been executed.
 */

const FIXTURE = "FIXTURE PREMISE FAILED (setup, not a security observation):";
const CONTROL = "ADMITTED CONTROL FAILED (the paired refusal would be vacuous):";

const h = vi.hoisted(() => ({
  /** SEAM cookies: the async `cookies()` of the request in flight. */
  cookies: vi.fn(),
  /** SEAM revalidate: records the paths an action asks to revalidate. */
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

import { createProjectAction } from "@/app/actions/projects";
import { recordFindingDecision } from "@/app/t/[team]/codebases/[slug]/actions";
import { SESSION_COOKIE, signSession, verifySession, type SessionUser } from "@/lib/auth/pg-session";
import type { FindingDecision } from "@/lib/codebases/finding-ledger";
import { projectGroupId } from "@/lib/graph/group";

type Row = Record<string, unknown>;
type Role = "admin" | "lead" | "member";
type Tier = "team" | "external";
type Via = "admin" | "server";

/** Two teams, several sessions, a control and a refusal, and whole-rowset snapshots around each. */
const ROOMY = 30_000;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const NOT_A_MEMBER = { ok: false, error: "not a member of this team" };
const LEADS_OR_ADMINS_ONLY = { ok: false, error: "team leads or admins only" };

const FAULT_MESSAGE = "aio1217 synthetic guard read fault";

// What became of a recorded statement.
const SENT = "sent";
const ANSWERED = "answered";
const FAULTED = "injected rejection: statement not sent";
const NATIVE_ERROR = "native error:";

interface Statement {
  via: Via;
  op: string;
  table: string;
  /** The equality predicates of the compiled WHERE clause, with the values bound into them. */
  where: Row;
  /** The tuple an INSERT writes, or the assignments of an UPDATE, with the values bound. */
  values: Row;
  text: string;
  params: unknown[];
  /** The row count Postgres really answered; null until it does. */
  rowCount: number | null;
  outcome: string;
}

/** One statement as the cases compare it: who issued it, what it was bound to, how many rows answered. */
interface Wire {
  via: Via;
  op: string;
  table: string;
  where: Row;
  rows: number | null;
}

interface Fault {
  via: Via;
  table: string;
}

/** A statement Postgres itself is expected to refuse, and what its message must say. */
interface Native {
  op: string;
  table: string;
  message: RegExp;
}

interface Flight {
  jar: Map<string, string>;
  cookieReads: string[];
  statements: Statement[];
  fault: (Fault & { fired: number }) | null;
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

interface World {
  a: Seed;
  b: Seed;
}

/** A codebase of one team and one open finding in it. */
interface Target {
  codebaseId: string;
  codebaseSlug: string;
  findingId: string;
}

/** The conjuncts the two gates read off a member's rows, and the legacy column neither gate reads. */
interface Standing {
  role: string;
  status: string;
  tier: string;
  everyone_rows: number;
  external_rows: number;
}

let authSecret = "";
/** The one request in flight; null between requests. */
let inFlight: Flight | null = null;
/** Makes every seeded input distinct, so a wrongly admitted call cannot hide behind an equal row. */
let serial = 0;
const next = (): number => ++serial;

beforeEach(() => {
  authSecret = randomBytes(32).toString("hex");
  vi.stubEnv("AUTH_SECRET", authSecret);
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
  "projects",
  "project_groups",
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

const rowOf = async (table: string, id: string): Promise<Row> =>
  (await fxOne<{ row: Row }>(`${table} readback`, `select to_jsonb(t) as row from ${table} t where t.id = $1`, [id])).row;

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

/** An active member holding the builtin Everyone row, with the legacy tier column agreeing. */
const healthy = (role: Role): Standing => ({ role, status: "active", tier: "team", everyone_rows: 1, external_rows: 0 });

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
 * A distinct active member bound to a fresh auth user, and a real session signed for that auth
 * user. `posture` is the builtin row they hold (null for none); `legacyTier` is the `members.tier`
 * column, which no guard reads and which need not agree with it. Nothing about the guard is stubbed.
 */
async function seedCast(
  team: Seed,
  label: string,
  role: Role,
  placed: { posture?: Tier | null; legacyTier?: Tier } = {},
): Promise<Cast> {
  const posture = placed.posture === undefined ? "team" : placed.posture;
  const legacyTier = placed.legacyTier ?? "team";
  const user = { id: randomUUID(), email: `${label}-${randomUUID().slice(0, 8)}@aio1217.fixture.test` };
  await fxOne("auth user insert", `insert into auth_users(id, email) values($1, $2) returning id`, [user.id, user.email]);
  const { id } = await fxOne<{ id: string }>(
    "member insert",
    `insert into members(team_id, email, display_name, actor_handle, role, tier, status, auth_user_id)
     values($1, $2, $3, $4, $5, $6, 'active', $7) returning id`,
    [team.teamId, user.email, `AIO1217 ${label}`, `${label}-${randomUUID().slice(0, 8)}`, role, legacyTier, user.id],
  );
  if (posture) await placeMemberByTier(team.teamId, id, posture);
  premise(`${label}'s authority`, await authority(id), {
    team_id: team.teamId,
    auth_user_id: user.id,
    role,
    status: "active",
    tier: legacyTier,
    everyone_rows: posture === "team" ? 1 : 0,
    external_rows: posture === "external" ? 1 : 0,
  });
  const session = await signSession(user);
  premise(`${label}'s session verifies under the real verifier`, await verifySession(session), user);
  return { label, team, memberId: id, user, session };
}

async function seedWorld(): Promise<World> {
  const a = await seedTeam();
  const b = await seedTeam();
  premise("the two teams are distinct", [a.teamId === b.teamId, a.teamSlug === b.teamSlug], [false, false]);
  return { a, b };
}

/** A fresh codebase of `team` holding one open finding. */
async function seedTarget(team: Seed): Promise<Target> {
  const codebase = await fxOne<{ id: string; slug: string }>(
    "codebase insert",
    `insert into codebases(team_id, slug) values($1, $2) returning id, slug`,
    [team.teamId, `aio1217-codebase-${next()}`],
  );
  const finding = await fxOne<{ id: string }>(
    "finding insert",
    `insert into codebase_findings(team_id, codebase_id, fingerprint, status, check_id, axis, kind, severity,
                                   evidence_status, remediation_tier, occurrence_count, first_seen_sha,
                                   last_seen_sha, first_seen_at, last_seen_at)
     values($1, $2, $3, 'open', 'coverage_lines_pct', 'test_rigor', 'quality_issue', 'high',
            'complete', 1, 2, $4, $5, now() - interval '10 days', now() - interval '10 days')
     returning id`,
    [team.teamId, codebase.id, randomBytes(32).toString("hex"), "1".repeat(40), "2".repeat(40)],
  );
  return { codebaseId: codebase.id, codebaseSlug: codebase.slug, findingId: finding.id };
}

/** A valid project name and the slug the action derives from it, written out by hand. */
const projectInput = () => {
  const n = next();
  return { name: `AIO1217 Initiative ${n}`, slug: `aio1217-initiative-${n}` };
};

/** A decision the real schema and the SQL function both accept for an open finding. */
const decision = (findingId: string, ownerMemberId: string): FindingDecision => ({
  findingId,
  ownerMemberId,
  status: "risk_accepted",
  reason: `AIO1217 synthetic decision reason ${next()}`,
  expiresAt: new Date(Date.now() + 30 * 86_400_000).toISOString(),
});

async function setMembership(cast: Cast, column: "role" | "status", value: string): Promise<void> {
  await fxOne(
    `membership ${column} change`,
    `update members set ${column} = $1 where id = $2 and team_id = $3 returning id`,
    [value, cast.memberId, cast.team.teamId],
  );
}

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

async function moveToExternal(cast: Cast): Promise<void> {
  await removeEveryone(cast);
  await placeMemberByTier(cast.team.teamId, cast.memberId, "external");
}

/** The caller's claims, really signed — under a secret this request's verifier does not hold. */
async function sessionUnderAnotherSecret(user: SessionUser): Promise<string> {
  vi.stubEnv("AUTH_SECRET", randomBytes(32).toString("hex"));
  let token: string;
  try {
    token = await signSession(user);
  } finally {
    vi.stubEnv("AUTH_SECRET", authSecret);
  }
  premise("the real verifier rejects the foreign-secret session", await verifySession(token), null);
  return token;
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
function compiled(text: string, params: unknown[]): Pick<Statement, "op" | "table" | "where" | "values"> {
  const call = /^SELECT ([a-z_]+)\(/.exec(text);
  if (call && !text.includes(" FROM ")) return { op: "rpc", table: call[1], where: {}, values: {} };
  const insert = /^INSERT INTO ([a-z_]+) \(([^)]*)\) VALUES /.exec(text);
  if (insert) {
    const columns = insert[2].split(", ");
    return {
      op: text.includes(" ON CONFLICT (") ? "upsert" : "insert",
      table: insert[1],
      where: {},
      values: Object.fromEntries(columns.map((column, index) => [column, params[index]])),
    };
  }
  const at = text.indexOf(" WHERE ");
  const head = at === -1 ? text : text.slice(0, at);
  const where = at === -1 ? {} : equalities(text.slice(at), params);
  const update = /^UPDATE ([a-z_]+) SET /.exec(head);
  if (update) return { op: "update", table: update[1], where, values: equalities(head, params) };
  const remove = /^DELETE FROM ([a-z_]+) /.exec(text);
  if (remove) return { op: "delete", table: remove[1], where, values: {} };
  const select = /^SELECT [\s\S]* FROM ([a-z_]+) /.exec(text);
  if (select) return { op: "select", table: select[1], where, values: {} };
  return { op: (text.trim().split(/\s+/)[0] ?? "").toLowerCase(), table: "", where: {}, values: {} };
}

/**
 * A real `PgClient` whose executor records each compiled statement, forwards it to the real pool
 * and records the row count Postgres answered. The recorder never throws on its own account: only
 * the armed fault rejects, in place of sending its statement.
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
      };
      flight.statements.push(statement);
      const fault = flight.fault;
      if (fault && fault.fired === 0 && fault.via === via && fault.table === statement.table && statement.op === "select") {
        fault.fired += 1;
        statement.outcome = FAULTED;
        throw new Error(FAULT_MESSAGE);
      }
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
 * `session` is the session cookie, or null for none. `fault` arms one guard read fault; `native`
 * names the one statement Postgres itself is expected to refuse. Any other refused statement, and
 * any other adapter failure line, fails a fixture premise.
 */
async function request(
  session: string | null,
  action: () => Promise<unknown>,
  expecting: { fault?: Fault; native?: Native } = {},
): Promise<Seen> {
  const jar = new Map<string, string>();
  if (session !== null) jar.set(SESSION_COOKIE, session);
  const flight: Flight = {
    jar,
    cookieReads: [],
    statements: [],
    fault: expecting.fault ? { ...expecting.fault, fired: 0 } : null,
  };
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

  const { fault } = flight;
  const { native } = expecting;
  premise(
    "the statements Postgres itself refused are exactly the expected one",
    flight.statements
      .filter((statement) => statement.outcome.startsWith(NATIVE_ERROR))
      .map((statement) => ({ op: statement.op, table: statement.table, outcome: statement.outcome })),
    native ? [{ op: native.op, table: native.table, outcome: expect.stringMatching(native.message) }] : [],
  );
  if (fault) premise("the armed fault fired exactly once", fault.fired, 1);
  premise(
    "the real adapter surfaced exactly the expected failures as its own returned errors",
    logged.filter((line) => line.startsWith("[pg]")),
    [
      ...(fault ? [`[pg] select ${fault.table}: ${FAULT_MESSAGE}`] : []),
      ...(native ? [expect.stringMatching(native.message)] : []),
    ],
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

/** One request as the cases compare it. */
const observe = (seen: Seen) => ({
  outcome: seen.outcome,
  identity: seen.cookieReads,
  wire: wireOf(seen),
  acquired: seen.acquired,
  changed: changes(seen.before, seen.after),
  revalidated: seen.revalidated,
});

// ── what the guard and the owners put on the wire ────────────────────────────────────────────────

// The statements the action and its guard issue before admission, as read from the two action
// files, lib/auth/guard and lib/access/posture; and the one identity read that follows it.
const teamRead = (team: Seed): Wire => ({
  via: "server",
  op: "select",
  table: "teams",
  where: { slug: team.teamSlug },
  rows: 1,
});
const memberRead = (team: Seed, user: SessionUser, rows: number | null): Wire => ({
  via: "server",
  op: "select",
  table: "members",
  where: { team_id: team.teamId, auth_user_id: user.id, status: "active" },
  rows,
});
const postureRead = (team: Seed, memberId: string, rows: number | null): Wire => ({
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

// ── refusals ─────────────────────────────────────────────────────────────────────────────────────

interface Refusal {
  name: string;
  /** Removes one conjunct after the admitted control; returns the refused request's session cookie. */
  arrange(caller: Cast, outsider: Cast): Promise<string | null>;
  fault?: Fault;
  /** Whose auth user the membership read is bound to and what answers it; absent when it is never issued. */
  member?: { of: "caller" | "outsider"; rows: number | null };
  /** Whether the posture read is issued, and whether it is answered. */
  posture?: "answered" | "faulted";
  /** Set when the export rejects with this message instead of answering with its refusal. */
  rejects?: string;
  /** What the caller's rows say afterwards: which conjunct the case removed. */
  standing: Partial<Standing>;
}

/** The reads `currentMember` issues before it answers, in order, for this refusal. */
async function chainReads(refusal: Refusal, team: Seed, caller: Cast, outsider: Cast): Promise<Wire[]> {
  if (!refusal.member) return [];
  const user = refusal.member.of === "caller" ? caller.user : outsider.user;
  const reads = [memberRead(team, user, refusal.member.rows)];
  if (refusal.posture) {
    reads.push(postureRead(team, caller.memberId, refusal.posture === "faulted" ? null : await groupRows(caller)));
  }
  return reads;
}

const refusedAs = (refusal: Refusal, shape: unknown): Settled =>
  refusal.rejects ? { rejected: { error: true, message: refusal.rejects } } : { returned: shape };

/** The seven ways a caller fails the membership chain both exports share. */
const MEMBERSHIP_REFUSALS: Refusal[] = [
  {
    name: "no session cookie, with the membership and Everyone row standing",
    arrange: async () => null,
    standing: {},
  },
  {
    name: "a session cookie carrying the caller's claims signed under another secret",
    arrange: (caller) => sessionUnderAnotherSecret(caller.user),
    standing: {},
  },
  {
    name: "a healthy member of the other team naming this team",
    arrange: async (_caller, outsider) => outsider.session,
    member: { of: "outsider", rows: 0 },
    standing: {},
  },
  {
    name: "a disabled same-team membership, the Everyone row still standing",
    arrange: async (caller) => {
      await setMembership(caller, "status", "disabled");
      return caller.session;
    },
    member: { of: "caller", rows: 0 },
    standing: { status: "disabled" },
  },
  {
    name: "an invited same-team membership, the Everyone row still standing",
    arrange: async (caller) => {
      await setMembership(caller, "status", "invited");
      return caller.session;
    },
    member: { of: "caller", rows: 0 },
    standing: { status: "invited" },
  },
  {
    // `currentMember` discards this read's error and treats the caller as no member: fail closed.
    name: "a faulted membership read (synthetic), every row standing",
    arrange: async (caller) => caller.session,
    fault: { via: "server", table: "members" },
    member: { of: "caller", rows: null },
    standing: {},
  },
  {
    // The posture owner throws on its read error and neither export catches it: the call rejects.
    name: "a faulted posture read (synthetic) after the session and active membership are admitted",
    arrange: async (caller) => caller.session,
    fault: { via: "server", table: "group_members" },
    member: { of: "caller", rows: 1 },
    posture: "faulted",
    rejects: `posture read failed: ${FAULT_MESSAGE}`,
    standing: {},
  },
];

/** The membership admits; recordFindingDecision's inline role arm or team-posture arm does not. */
const ROLE_OR_POSTURE_REFUSALS: Refusal[] = [
  {
    name: "an active member holding the team's builtin Everyone row (role denial)",
    arrange: async (caller) => {
      await setMembership(caller, "role", "member");
      return caller.session;
    },
    member: { of: "caller", rows: 1 },
    posture: "answered",
    standing: { role: "member" },
  },
  {
    // The legacy tier column still says `team`: the stale direction that must deny.
    name: "an active admin holding only the team's builtin External row, legacy tier still team (posture denial)",
    arrange: async (caller) => {
      await moveToExternal(caller);
      return caller.session;
    },
    member: { of: "caller", rows: 1 },
    posture: "answered",
    standing: { everyone_rows: 0, external_rows: 1 },
  },
  {
    name: "an active lead holding only the team's builtin External row (posture denial)",
    arrange: async (caller) => {
      await setMembership(caller, "role", "lead");
      await moveToExternal(caller);
      return caller.session;
    },
    member: { of: "caller", rows: 1 },
    posture: "answered",
    standing: { role: "lead", everyone_rows: 0, external_rows: 1 },
  },
  {
    name: "an active admin holding no builtin row at all (posture denial)",
    arrange: async (caller) => {
      await removeEveryone(caller);
      return caller.session;
    },
    member: { of: "caller", rows: 1 },
    posture: "answered",
    standing: { everyone_rows: 0 },
  },
];

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// M — app/actions/projects.ts#createProjectAction
// ─────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Run the actual export under `who`'s session with a valid name and hold it to what a member's
 * FIRST creation owes: the insert as the first statement after admission, the creator's singleton
 * and grant before the pointer write, and exactly those rows as the durable difference.
 */
async function admitProject(who: Cast, label: string, input = projectInput()): Promise<void> {
  const postureRows = await groupRows(who);
  const seen = await request(who.session, () => createProjectAction({ teamId: who.team.teamId, name: input.name }));

  const wire = wireOf(seen);
  const written = seen.statements.filter((statement) => statement.op !== "select");
  const order = written.map((statement) => `${statement.op} ${statement.table}`);
  const grantAt = order.indexOf("upsert project_groups");
  const pointerAt = order.indexOf("update projects");
  const changed = changes(seen.before, seen.after);
  const project = changed.projects?.added[0] ?? {};
  const singleton = changed.groups?.added[0] ?? {};
  const team_id = who.team.teamId;
  const accessAudit = (action: string, targetId: unknown, meta: Row) =>
    expect.objectContaining({
      team_id,
      actor_kind: "member",
      member_id: who.memberId,
      api_key_id: null,
      action,
      target_type: "access",
      target_id: targetId,
      meta,
    });

  expect(
    {
      outcome: seen.outcome,
      identity: seen.cookieReads,
      admission: wire.slice(0, 3),
      inserted: seen.statements[2]?.values,
      clients: [...new Set(wire.map((statement) => statement.via))],
      acquired: seen.acquired,
      order: { first: order[0], grantBeforePointer: grantAt > 0 && grantAt < pointerAt },
      tablesWritten: [...new Set(written.map((statement) => statement.table))].sort(),
      changed,
      auditRows: changed.audit_log?.added.length,
      revalidated: seen.revalidated,
    },
    label,
  ).toEqual({
    outcome: { returned: { ok: true, project: { id: project.id, slug: input.slug, name: input.name } } },
    identity: [SESSION_COOKIE],
    // The membership and posture reads, bound to the supplied team and the session's user, then the insert.
    admission: [
      memberRead(who.team, who.user, 1),
      postureRead(who.team, who.memberId, postureRows),
      { via: "server", op: "insert", table: "projects", where: {}, rows: 1 },
    ],
    inserted: { team_id, slug: input.slug, name: input.name, kind: "initiative" },
    // The action never asks for the service client: every statement is the server client's.
    clients: ["server"],
    acquired: { server: 2, admin: 0 },
    order: { first: "insert projects", grantBeforePointer: true },
    tablesWritten: ["audit_log", "group_members", "groups", "project_groups", "projects"],
    changed: {
      projects: {
        added: [
          expect.objectContaining({
            id: expect.stringMatching(UUID),
            team_id,
            slug: input.slug,
            name: input.name,
            kind: "initiative",
            // The pointer the real writer minted for this team and this row.
            graph_group_id: UUID.test(String(project.id))
              ? projectGroupId(team_id, String(project.id))
              : "<no project row was created>",
          }),
        ],
        removed: [],
      },
      // The creator's person singleton, holding exactly the creator.
      groups: {
        added: [
          expect.objectContaining({
            id: expect.stringMatching(UUID),
            team_id,
            slug: `person-${who.memberId}`,
            is_builtin: false,
            person_member_id: who.memberId,
          }),
        ],
        removed: [],
      },
      group_members: {
        added: [
          expect.objectContaining({ team_id, group_id: singleton.id, member_id: who.memberId, added_by: who.memberId }),
        ],
        removed: [],
      },
      // The grant: the new project to the creator's singleton, and to nothing else.
      project_groups: {
        added: [
          expect.objectContaining({ team_id, project_id: project.id, group_id: singleton.id, added_by: who.memberId }),
        ],
        removed: [],
      },
      audit_log: {
        added: expect.arrayContaining([
          accessAudit("access.singleton_created", singleton.id, { memberId: who.memberId }),
          accessAudit("access.project_granted", project.id, { groupId: singleton.id }),
        ]),
        removed: [],
      },
    },
    auditRows: 2,
    // The action revalidates nothing.
    revalidated: [],
  });
}

describe("M — app/actions/projects.ts#createProjectAction (active same-team member, real Postgres)", () => {
  it(
    "admitted: an ordinary member of team A creates an initiative in team A, and an ordinary member of team B creates the same name in team B — each call's row, creator singleton, grant, audit rows and pointer bind only its own supplied team and server-resolved member",
    async () => {
      const world = await seedWorld();
      const dana = await seedCast(world.a, "dana", "member");
      const bob = await seedCast(world.b, "bob", "member");
      const input = projectInput();

      await admitProject(dana, "Dana on team A", input);
      // Only the session and the team id differ: the slug is free in team B, and nothing of team A's moves.
      await admitProject(bob, "Bob on team B", input);
    },
    ROOMY,
  );

  it.each([
    { name: "an active lead holding the builtin Everyone row", role: "lead" as const, posture: "team" as const },
    { name: "an active admin holding the builtin Everyone row", role: "admin" as const, posture: "team" as const },
    {
      name: "an active member holding only the builtin External row (external posture)",
      role: "member" as const,
      posture: "external" as const,
    },
    {
      name: "an active member holding no builtin row at all (external posture)",
      role: "member" as const,
      posture: null,
    },
  ])(
    "admitted identically: $name — neither role nor posture is a conjunct of this export, and the same row, creator grant and pointer follow",
    async ({ role, posture }) => {
      const world = await seedWorld();
      const caller = await seedCast(world.a, "caller", role, { posture });

      await admitProject(caller, "the variant caller on team A");
    },
    ROOMY,
  );

  it.each(MEMBERSHIP_REFUSALS)(
    "refused: $name — after an admitted control on the same fixture, only the guard's own reads run: no second server client, no projects insert, no creator singleton or grant, no pointer write, no ledger entry",
    async (refusal) => {
      const world = await seedWorld();
      const dana = await seedCast(world.a, "dana", "member");
      const bob = await seedCast(world.b, "bob", "member");
      await admitProject(dana, CONTROL);

      const session = await refusal.arrange(dana, bob);
      const chain = await chainReads(refusal, world.a, dana, bob);
      // A fresh valid name for team A: had the gate admitted the call, its row would show.
      const input = projectInput();

      const refused = await request(
        session,
        () => createProjectAction({ teamId: world.a.teamId, name: input.name }),
        { fault: refusal.fault },
      );

      expect({ ...observe(refused), standing: await standingOf(dana) }).toEqual({
        outcome: refusedAs(refusal, NOT_A_MEMBER),
        identity: [SESSION_COOKIE],
        wire: chain,
        // Without an identity not even the guard's server client is acquired; the action's own never is.
        acquired: { server: chain.length > 0 ? 1 : 0, admin: 0 },
        changed: {},
        revalidated: [],
        standing: { ...healthy("member"), ...refusal.standing },
      });
    },
    ROOMY,
  );
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// F — app/t/[team]/codebases/[slug]/actions.ts#recordFindingDecision
// ─────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Run the actual export under `who`'s session against a finding of their own team and hold it to
 * what an admitted decision owes: the identity read bound to the resolved team, one function call
 * carrying the resolved team, codebase and actor, the finding's decision columns and nothing else in
 * the row, one event, one audit row and one revalidation.
 */
async function admitDecision(who: Cast, target: Target, ownerMemberId: string, label: string): Promise<void> {
  const input = decision(target.findingId, ownerMemberId);
  const postureRows = await groupRows(who);
  const standingFinding = await rowOf("codebase_findings", target.findingId);
  const seen = await request(who.session, () => recordFindingDecision(who.team.teamSlug, target.codebaseSlug, input));
  const team_id = who.team.teamId;

  expect({ ...observe(seen), call: seen.statements.find((statement) => statement.op === "rpc")?.params }, label).toEqual({
    outcome: { returned: { ok: true } },
    identity: [SESSION_COOKIE],
    wire: [
      // The team is read by slug before the caller is identified.
      teamRead(who.team),
      memberRead(who.team, who.user, 1),
      postureRead(who.team, who.memberId, postureRows),
      codebaseRead(who.team, target.codebaseSlug, 1),
      { ...DECISION_CALL, rows: 1 },
      { via: "admin", op: "insert", table: "audit_log", where: {}, rows: 1 },
    ],
    acquired: { server: 2, admin: 1 },
    changed: {
      // Only the decision columns of the bound finding moved.
      codebase_findings: {
        added: [
          {
            ...standingFinding,
            status: input.status,
            decision_reason: input.reason,
            decision_owner_member_id: ownerMemberId,
            decision_by_member_id: who.memberId,
            decision_at: expect.any(String),
            decision_expires_at: expect.any(String),
            updated_at: expect.any(String),
          },
        ],
        removed: [standingFinding],
      },
      codebase_finding_events: {
        added: [
          expect.objectContaining({
            team_id,
            codebase_id: target.codebaseId,
            finding_id: target.findingId,
            metrics_id: null,
            event_type: input.status,
            from_status: standingFinding.status,
            to_status: input.status,
            details: expect.objectContaining({
              reason: input.reason,
              owner_member_id: ownerMemberId,
              actor_member_id: who.memberId,
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
            member_id: who.memberId,
            api_key_id: null,
            action: "codebase_finding.decision",
            target_type: "codebase_finding",
            target_id: target.findingId,
            meta: { status: input.status, owner_member_id: ownerMemberId, expires_at: input.expiresAt },
          }),
        ],
        removed: [],
      },
    },
    revalidated: [codebasePath(who.team, target.codebaseSlug)],
    // Team, codebase and actor are the server's; finding, owner, status, reason and expiry are forwarded.
    call: [
      team_id,
      target.codebaseId,
      target.findingId,
      who.memberId,
      ownerMemberId,
      input.status,
      input.reason,
      input.expiresAt,
    ],
  });
}

describe("F — app/t/[team]/codebases/[slug]/actions.ts#recordFindingDecision (active same-team admin or lead in team posture, real Postgres)", () => {
  it.each([{ role: "admin" as const }, { role: "lead" as const }])(
    "admitted: an active $role holding the builtin Everyone row decides team A's finding as themselves, and another decides team B's — each call's identity read, function call, finding row, event, audit row and revalidation bind only its own server-resolved team, codebase and actor",
    async ({ role }) => {
      const world = await seedWorld();
      const alice = await seedCast(world.a, "alice", role);
      const bob = await seedCast(world.b, "bob", role);
      const ownerA = await seedCast(world.a, "owner-a", "member");
      const ownerB = await seedCast(world.b, "owner-b", "member");
      const targetA = await seedTarget(world.a);
      const targetB = await seedTarget(world.b);

      await admitDecision(alice, targetA, ownerA.memberId, "Alice on team A");
      // Only the session, the slugs and the ids differ: nothing of team A's is bound or changed.
      await admitDecision(bob, targetB, ownerB.memberId, "Bob on team B");
    },
    ROOMY,
  );

  it.each([...MEMBERSHIP_REFUSALS, ...ROLE_OR_POSTURE_REFUSALS])(
    "refused: $name — after an admitted control on the same fixture, only the team read and the guard's own reads run: no codebase identity read, no service client, no function call, no finding change, no event, no ledger entry, no revalidation",
    async (refusal) => {
      const world = await seedWorld();
      const alice = await seedCast(world.a, "alice", "admin");
      const bob = await seedCast(world.b, "bob", "admin");
      const owner = await seedCast(world.a, "owner", "member");
      await admitDecision(alice, await seedTarget(world.a), owner.memberId, CONTROL);

      // A fresh open finding of team A's: had the gate admitted the call, its row would show.
      const target = await seedTarget(world.a);
      const input = decision(target.findingId, owner.memberId);
      const session = await refusal.arrange(alice, bob);
      const chain = await chainReads(refusal, world.a, alice, bob);

      const refused = await request(
        session,
        () => recordFindingDecision(world.a.teamSlug, target.codebaseSlug, input),
        { fault: refusal.fault },
      );

      expect({ ...observe(refused), standing: await standingOf(alice) }).toEqual({
        outcome: refusedAs(refusal, LEADS_OR_ADMINS_ONLY),
        identity: [SESSION_COOKIE],
        // No `codebases` statement follows: the refusal precedes the identity read.
        wire: [teamRead(world.a), ...chain],
        // The action's own server client, then the guard's once an identity exists; never the service client.
        acquired: { server: chain.length > 0 ? 2 : 1, admin: 0 },
        changed: {},
        revalidated: [],
        standing: { ...healthy("admin"), ...refusal.standing },
      });
    },
    ROOMY,
  );

  it(
    "a prior admitted lead, the builtin Everyone row then removed, is refused on a NEW invocation before the identity read; with the row restored the same session is admitted again",
    async () => {
      const world = await seedWorld();
      const alice = await seedCast(world.a, "alice", "lead");
      const owner = await seedCast(world.a, "owner", "member");
      const target = await seedTarget(world.a);
      await admitDecision(alice, target, owner.memberId, CONTROL);

      await removeEveryone(alice);
      const input = decision(target.findingId, owner.memberId);
      const refused = await request(alice.session, () =>
        recordFindingDecision(world.a.teamSlug, target.codebaseSlug, input),
      );
      expect({ ...observe(refused), standing: await standingOf(alice) }).toEqual({
        outcome: { returned: LEADS_OR_ADMINS_ONLY },
        identity: [SESSION_COOKIE],
        wire: [
          teamRead(world.a),
          memberRead(world.a, alice.user, 1),
          postureRead(world.a, alice.memberId, await groupRows(alice)),
        ],
        acquired: { server: 2, admin: 0 },
        changed: {},
        revalidated: [],
        standing: { ...healthy("lead"), everyone_rows: 0 },
      });

      await placeMemberByTier(world.a.teamId, alice.memberId, "team");
      await admitDecision(alice, target, owner.memberId, "Alice with the Everyone row restored");
    },
    ROOMY,
  );
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// T — what the lower owners own once a caller is admitted
// ─────────────────────────────────────────────────────────────────────────────────────────────────

/** What an admitted lead supplies in place of their own team's slug, finding or owner. */
interface Crossing {
  name: string;
  aim(own: Target, foreign: Target, ownOwner: Cast, foreignMember: Cast): {
    codebaseSlug: string;
    findingId: string;
    ownerMemberId: string;
  };
  /** How many rows answer the identity read bound to the acting team. */
  codebaseRows: number;
  /** The SQL function's own refusal, or null when the call stops at the identity read. */
  raised: string | null;
}

const CROSSINGS: Crossing[] = [
  {
    name: "a codebase slug only the other team holds is `codebase not found` at the team-bound identity read, before the service client",
    aim: (own, foreign, ownOwner) => ({
      codebaseSlug: foreign.codebaseSlug,
      findingId: own.findingId,
      ownerMemberId: ownOwner.memberId,
    }),
    codebaseRows: 0,
    raised: null,
  },
  {
    name: "a finding id the other team holds is refused by the SQL function's own (id, team, codebase) lookup",
    aim: (own, foreign, ownOwner) => ({
      codebaseSlug: own.codebaseSlug,
      findingId: foreign.findingId,
      ownerMemberId: ownOwner.memberId,
    }),
    codebaseRows: 1,
    raised: "finding not found",
  },
  {
    name: "an owner member id the other team holds is refused by the SQL function's own same-team owner check",
    aim: (own, _foreign, _ownOwner, foreignMember) => ({
      codebaseSlug: own.codebaseSlug,
      findingId: own.findingId,
      ownerMemberId: foreignMember.memberId,
    }),
    codebaseRows: 1,
    raised: "finding decision owner must be an active team member",
  },
];

describe("T — the ids an admitted member supplies are bound by the lower owners (real Postgres; current behavior, pinned)", () => {
  it(
    "app/actions/projects.ts#createProjectAction · a second member re-submitting a name the team already holds is refused by the `projects` unique constraint — and gains no singleton, grant, pointer write or ledger entry",
    async () => {
      const world = await seedWorld();
      const dana = await seedCast(world.a, "dana", "member");
      const erin = await seedCast(world.a, "erin", "member");
      const input = projectInput();
      await admitProject(dana, CONTROL, input);
      const { id: projectId } = await fxOne<{ id: string }>(
        "created project readback",
        `select id from projects where team_id = $1 and slug = $2`,
        [world.a.teamId, input.slug],
      );

      const seen = await request(
        erin.session,
        () => createProjectAction({ teamId: world.a.teamId, name: input.name }),
        { native: { op: "insert", table: "projects", message: /duplicate key value violates unique constraint/ } },
      );

      expect(observe(seen)).toEqual({
        outcome: { returned: { ok: false, error: `a project "${input.slug}" already exists` } },
        identity: [SESSION_COOKIE],
        wire: [
          memberRead(world.a, erin.user, 1),
          postureRead(world.a, erin.memberId, 1),
          // Refused by Postgres, not by the action.
          { via: "server", op: "insert", table: "projects", where: {}, rows: null },
          // The duplicate arm reads the standing row and its pointer, and writes neither.
          { via: "server", op: "select", table: "projects", where: { team_id: world.a.teamId, slug: input.slug }, rows: 1 },
          { via: "server", op: "select", table: "projects", where: { id: projectId, team_id: world.a.teamId }, rows: 1 },
        ],
        acquired: { server: 2, admin: 0 },
        // Erin was admitted as a member and gained nothing: no singleton, no grant, no ledger entry.
        changed: {},
        revalidated: [],
      });
    },
    ROOMY,
  );

  it.each(CROSSINGS)(
    "app/t/[team]/codebases/[slug]/actions.ts#recordFindingDecision · $name — no finding of either team changes, and no event, ledger entry or revalidation follows",
    async (crossing) => {
      const world = await seedWorld();
      const alice = await seedCast(world.a, "alice", "lead");
      const ownOwner = await seedCast(world.a, "owner-a", "member");
      const foreignMember = await seedCast(world.b, "member-b", "member");
      const own = await seedTarget(world.a);
      const foreign = await seedTarget(world.b);
      await admitDecision(alice, own, ownOwner.memberId, CONTROL);

      const aimed = crossing.aim(own, foreign, ownOwner, foreignMember);
      const input = decision(aimed.findingId, aimed.ownerMemberId);
      const seen = await request(
        alice.session,
        () => recordFindingDecision(world.a.teamSlug, aimed.codebaseSlug, input),
        crossing.raised
          ? { native: { op: "rpc", table: "decide_codebase_finding", message: new RegExp(crossing.raised) } }
          : {},
      );

      expect(observe(seen)).toEqual({
        outcome: {
          returned: {
            ok: false,
            error: crossing.raised ? `finding decision failed: ${crossing.raised}` : "codebase not found",
          },
        },
        identity: [SESSION_COOKIE],
        wire: [
          teamRead(world.a),
          memberRead(world.a, alice.user, 1),
          postureRead(world.a, alice.memberId, await groupRows(alice)),
          // Bound to the acting team whatever slug was supplied.
          codebaseRead(world.a, aimed.codebaseSlug, crossing.codebaseRows),
          ...(crossing.raised ? [{ ...DECISION_CALL, rows: null }] : []),
        ],
        acquired: { server: 2, admin: crossing.raised ? 1 : 0 },
        changed: {},
        revalidated: [],
      });
    },
    ROOMY,
  );

  it(
    "app/t/[team]/codebases/[slug]/actions.ts#recordFindingDecision · a lead whose legacy tier column says external while they hold the builtin Everyone row is ADMITTED by the action and then refused by the SQL function, which reads that column — the two predicates disagree (pinned as current, not endorsed)",
    async () => {
      const world = await seedWorld();
      const healthyLead = await seedCast(world.a, "healthy-lead", "lead");
      const staleLead = await seedCast(world.a, "stale-lead", "lead", { legacyTier: "external", posture: "team" });
      const owner = await seedCast(world.a, "owner", "member");
      const target = await seedTarget(world.a);
      await admitDecision(healthyLead, target, owner.memberId, CONTROL);

      const raised = "finding decisions require an active team lead or admin";
      const input = decision(target.findingId, owner.memberId);
      const seen = await request(
        staleLead.session,
        () => recordFindingDecision(world.a.teamSlug, target.codebaseSlug, input),
        { native: { op: "rpc", table: "decide_codebase_finding", message: new RegExp(raised) } },
      );

      expect({ ...observe(seen), standing: await standingOf(staleLead) }).toEqual({
        outcome: { returned: { ok: false, error: `finding decision failed: ${raised}` } },
        identity: [SESSION_COOKIE],
        // The action's own gate admitted: the identity read and the function call were both issued.
        wire: [
          teamRead(world.a),
          memberRead(world.a, staleLead.user, 1),
          postureRead(world.a, staleLead.memberId, 1),
          codebaseRead(world.a, target.codebaseSlug, 1),
          { ...DECISION_CALL, rows: null },
        ],
        acquired: { server: 2, admin: 1 },
        changed: {},
        revalidated: [],
        standing: { ...healthy("lead"), tier: "external" },
      });
    },
    ROOMY,
  );
});

// Each TODO names the later batch that owns it, in the terms of the two plans this slice follows.
describe("Z — follow-up evidence this fixture does NOT supply (executable TODOs: none is run, none is passed)", () => {
  it.todo(
    "PHASE-2 BATCH 7 · AC-02: record this file and test/actions/aio1217-admin-operations-auth.test.ts as the executing evidence of the createProjectAction and recordFindingDecision rows in test/guards/helpers/server-action-auth.ts, with the collected case names and the coordinator's run results",
  );
  it.todo(
    "PHASE-2 BATCH 4 · MUTANTS (coordinator isolated-copy actual-import run, recorded for AC-12 in Batch 7): against this fixture, ignore the null currentMember verdict in each export and drop recordFindingDecision's inline role arm, then its inline tier arm — the matching refusals must fail on the wire and on the durable difference, not on a compile or fixture error",
  );
});
