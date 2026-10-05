import { randomBytes, randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PgClient } from "@/lib/db/pg/client";
import { getPool, runSql } from "@/lib/db/pg/pool";
import type { DbClient, SqlExecutor } from "@/lib/db/types";
import { placeMemberByTier, seedTeam, type Seed } from "./helpers";

/**
 * AIO-1217 — REAL PM ADMIN ACTION, NO PRIMARY PROVIDER, against real Postgres: what
 * `app/t/[team]/admin/pm-sync/actions.ts#projectBoardAction` itself returns and writes, executed as
 * the actual exported function through the actual `requireTeamAdmin` chain and the actual lower PM
 * path, over synthetic session, team, member, group, project and task rows in the task's
 * data-mechanics Postgres, for teams in which NO PM provider is configured.
 *
 * This is the owner-side complement of two files. `aio1217-admin-guard-association` binds this export
 * to the gate with every lower owner a recording double that writes nothing; here the lower owners
 * RUN. `aio1217-pm-after-write-no-primary` runs the reactive single-task caller with no guard; here
 * the caller is the admin action, under its guard.
 *
 *   1 — admitted admin of team A, which holds two projects: the result, the owned-project selection,
 *       the per-project `projectAllTasks` answers, the one stored run, and team B's confinement.
 *   2 — three refusals by real session and row state, in both states of team A, each after an
 *       admitted control: no session cookie; an active role-member; an active role-admin holding only
 *       the builtin External row.
 *   3 — the foreign-slug direction, both ways, then both admitted controls.
 *   4 — OBSERVED: where this action's audit row and revalidation are, and are not, reached.
 *   Z — what this file does not supply, as executable TODOs naming the owner.
 *
 * SOURCE FACTS the expectations are read from (app/t/[team]/admin/pm-sync/actions.ts):
 *   :25-26  `requireAdmin(teamSlug)`; a null verdict returns `{ ok: false, error: "admins only" }`.
 *   :28-30  only then `adminClient()`, `startedAt = Date.now()`, and the `projects` read by `ctx.teamId`.
 *   :36-41  one `projectAllTasks(db, ctx.teamId, id)` per owned project; `provider` and `reason` are
 *           each the LAST project's answer (reason only when set).
 *   :45-52  ONE `recordProjectionRun` for the whole invocation: trigger `manual`, the accumulated
 *           reports, and `reason` only while no provider resolved.
 *   :54     `if (!provider && reason) return { ok: false, error: reason }` — BEFORE the audit write
 *           (:59-67) and `revalidatePath` (:69).
 * and beneath it: lib/pm-sync/project.ts:518-521 (`projectAllTasks` answers `{ provider, reports: [],
 * reason }` for an unresolved primary, before it reads any task) and :142 (the none-enabled reason);
 * lib/pm-sync/runs.ts:77-91 (a reasoned run is stored not-ok with the reason as its one line);
 * lib/ingest/runs.ts:59-82 (the single writer); lib/api/audit.ts:19-45 (the audit writer).
 *
 * THE AUDIT ROW IS NOT WRITTEN ON THE NO-PRIMARY PATH. For a team that holds projects and has no
 * enabled PM integration, :54 returns before :59. Such an invocation stores a `pm_sync` run and NO
 * `team.project_board` audit row, and asks for no revalidation. Cases 1, 2 and 3 assert that absence
 * over the whole `audit_log` table. Case 4 pins the only no-provider state in which this action does
 * reach its audit write: a team holding NO project, where the loop never runs, no reason is set, and
 * the action returns `ok: true`. That is an observation of the source as it stands; neither behavior
 * is declared correct here.
 *
 * What is real, and never mocked or handed a verdict: the export; `requireTeamAdmin` →
 * `getSessionUser` → `verifySession` (jose HS256 against AUTH_SECRET) → the team, member and posture
 * reads; the action's own `projects` read; `projectAllTasks` → `resolvePrimaryProvider` and the reads
 * it makes; `recordProjectionRun` with its roll-up; `recordIngestRun`; `audit`; the query builder,
 * the pg pool and Postgres. A caller is admitted only by a cookie the real verifier accepts and by
 * team, member and builtin-group rows the real owners read themselves.
 *
 * The synthetic seams, all of them:
 *   SEAM cookies     `next/headers` `cookies` — resolves the jar of the one request in flight. The
 *                    session in it is a real `signSession` token for a real auth_users row that a
 *                    real member row is bound to. AUTH_SECRET is synthetic per test.
 *   SEAM revalidate  `next/cache` `revalidatePath` — records the path and does nothing else. Needed
 *                    because the action calls it outside any Next request. What it records is that
 *                    the action ASKED; it is not evidence of Next cache or runtime behavior.
 *   SEAM transport   `adminClient()` and `serverClient()` record their acquisitions and hand out, for
 *                    the duration of one request, a real `PgClient` whose SQL executor RECORDS and
 *                    then forwards to the real pool `runSql`. Nothing above the executor is replaced.
 *   SEAM observe     `@/lib/pm-sync` is the ORIGINAL module with `projectAllTasks` and
 *                    `recordProjectionRun` wrapped by PASS-THROUGH recorders: each records the client
 *                    and arguments it was handed, CALLS THE ORIGINAL with exactly those arguments,
 *                    records what it settled with and returns that. No answer is supplied by this
 *                    file. The barrel's own source was not read: that it exports both names is the
 *                    association file's convention.
 *   SEAM tripwires   `next/headers` `headers` and global `fetch`. Each records and throws. "No
 *                    provider-network call" is a zero of global `fetch` during the request, together
 *                    with an answer `projectAllTasks` gives before it selects an adapter. A transport
 *                    other than global `fetch` would not be counted.
 *
 * Every request is: whole-rowset snapshots of ten tables read from the pool by raw SQL immediately
 * before and after; how the call settled and the key list of what it returned; ONE ORDERED TRACE of
 * the session cookie read, each client acquisition, each statement either client issued with the
 * equalities bound into it and the row count Postgres answered, each pass-through call with its
 * arguments and answer, and each revalidation; the acquisition counts; the seams' own call logs; and
 * every identifier the request's statements bound, searched for the other team's.
 *
 * WHAT OF THE TRACE IS ASSERTED. The guard's reads exactly, in the shapes the association file
 * establishes. Beyond the guard: the service client's acquisition, the `projects` read, each
 * pass-through call, each service-client read of a table this file snapshots (other than
 * `integrations`), each write as `{ via, op, table }`, and each revalidation — in order. Service-client
 * SELECTs on any other table are SET ASIDE and counted by nothing: they are the integrations read
 * beneath `resolvePrimaryProvider`, whose source is outside this slice's read list. They are still
 * searched for the other team's identifiers.
 *
 * Bounds of what is claimed.
 *   - ONE EXPORT, ONE BRANCH FAMILY. Only `projectBoardAction`, and of it only the refusal, the
 *     unresolved-primary return and the no-project return. `reconcileDivergenceAction` is not called.
 *   - NO TEAM HOLDS AN INTEGRATION, enabled or not, and no team names a primary provider. So that
 *     team A's resolution reads team A's integration rows alone is NOT evidenced by content: a
 *     resolution bound to the wrong team would answer the same. What is evidenced is that no
 *     statement of an admitted request binds any identifier of the other team.
 *   - CONFINEMENT IS OF EFFECTS AND BINDINGS. Team B's rows are unchanged over whole tables and no
 *     team B identifier is bound. No task is read on these branches, so nothing here is evidence of a
 *     task-level content boundary.
 *   - THE REFUSALS VARY SESSION, ROLE AND POSTURE, one at a time. `lib/auth/session`,
 *     `lib/integrations/read` and `lib/access/posture` were not read: for the no-session, role-member
 *     and foreign-slug refusals the trace is asserted as a prefix followed by guard reads only (cookie
 *     reads and server-client SELECTs), and what else the gate reads on those paths is not asserted.
 *   - Direct calls of the exported function: not Next action-wire, POST dispatch, origin, encryption
 *     or cache-invalidation proof. Membership is read per request: no revocation claim is made.
 *   - Nothing about API keys or AIO-1226; not an action inventory and not acceptance of any AIO-1217
 *     criterion.
 *   - `ingest_runs` is not in the tier's truncate list; it is emptied by the cascade from `teams`.
 *     Every world reads that back as a premise before any run is counted.
 *
 * NOTHING HERE IS A CREDENTIAL. No integration row, secret, token or provider account is created or
 * read by this file. Emails, handles, slugs, row keys and titles are synthetic.
 *
 * Run status. NOT RUN. This file was written without executing vitest, tsc, lint or any other
 * command; every expectation comes from reading the sources named above, not from an observed run.
 * Replace this paragraph with the observed result once the file has been executed.
 */

const FIXTURE = "FIXTURE PREMISE FAILED (setup, not a security observation):";
const CONTROL = "ADMITTED CONTROL FAILED (the paired refusal would be vacuous):";

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
  /** The ordered trace of the request in flight; null between requests. */
  trace: null as Array<Record<string, unknown>> | null,
  /** SEAM observe: the two pass-through recorders. */
  projectAllTasks: vi.fn(),
  recordProjectionRun: vi.fn(),
  /** SEAM observe: the originals the recorders forward to, captured when the module is first loaded. */
  real: {
    projectAllTasks: null as (typeof import("@/lib/pm-sync"))["projectAllTasks"] | null,
    recordProjectionRun: null as (typeof import("@/lib/pm-sync"))["recordProjectionRun"] | null,
  },
  /** SEAM tripwires. */
  headers: vi.fn(),
  fetch: vi.fn(),
}));

vi.mock("next/headers", () => ({ cookies: h.cookies, headers: h.headers }));
vi.mock("next/cache", () => ({ revalidatePath: h.revalidatePath }));
// The real service client unless a request is in flight.
vi.mock("@/lib/db/admin", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/db/admin")>();
  return {
    ...original,
    adminClient: () => {
      h.acquired.admin += 1;
      h.trace?.push({ step: "client", via: "admin" });
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
      h.trace?.push({ step: "client", via: "server" });
      return h.serverDb ?? original.serverClient();
    },
  };
});
// The original module; the two lower owners the action calls are wrapped, not replaced.
vi.mock("@/lib/pm-sync", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/pm-sync")>();
  h.real.projectAllTasks = original.projectAllTasks;
  h.real.recordProjectionRun = original.recordProjectionRun;
  return { ...original, projectAllTasks: h.projectAllTasks, recordProjectionRun: h.recordProjectionRun };
});

import { projectBoardAction } from "@/app/t/[team]/admin/pm-sync/actions";
import { SESSION_COOKIE, signSession, verifySession, type SessionUser } from "@/lib/auth/pg-session";

type PmSync = typeof import("@/lib/pm-sync");
type Row = Record<string, unknown>;
type Role = "admin" | "member";
type Tier = "team" | "external";
type Via = "admin" | "server";
/** One entry of a request's ordered trace: `step` names its kind, the rest is what it carried. */
type Step = Row;

/** Two teams, several sessions, up to three requests, and whole-rowset snapshots around each. */
const ROOMY = 30_000;
/** Case 2 makes eight requests. */
const ROOMIER = 60_000;

const ADMINS_ONLY = { ok: false, error: "admins only" };

/** `resolvePrimaryProvider`'s own reason for a team with no enabled PM integration and no primary. */
const NO_PROVIDER_REASON = "no enabled PM integration";

/** What the real `projectAllTasks` answers for such a team, whatever the project holds. */
const UNRESOLVED = { provider: null, reports: [], reason: NO_PROVIDER_REASON };

/** The key list of either refusal-shaped return: no provider, counts or reports key. */
const REFUSED_KEYS = ["error", "ok"];

/** What a pass-through recorder notes when it was handed the service client of the request in flight. */
const REQUEST_SERVICE_CLIENT = "the service client of this request";
const SOME_OTHER_CLIENT = "NOT the service client of this request";

/** What a pass-through step holds until its original settles. */
const UNSETTLED = "the original never settled";

const NATIVE_ERROR = "native error:";

interface Flight {
  jar: Map<string, string>;
  trace: Step[];
  /** The statements Postgres itself refused; a fixture premise holds this empty. */
  refused: string[];
  /** Every statement either client issued, as its text and its bound parameters. */
  bound: string[];
}

/** How a call ended: what it returned, or how its rejection classifies. */
type Settled = { returned: unknown } | { rejected: { error: boolean; message: string } };

interface Seen {
  outcome: Settled;
  /** The sorted key list of what the call returned; null when it returned no object. */
  shape: string[] | null;
  before: Durable;
  after: Durable;
  trace: Step[];
  acquired: { server: number; admin: number };
  /** How often each seam was called, by name, read off its own call log; absent when never. */
  seams: Record<string, number>;
  bound: string[];
  /** This process's clock immediately around the call. */
  window: { earliest: number; latest: number };
}

interface Cast {
  label: string;
  team: Seed;
  memberId: string;
  user: SessionUser;
  /** `signSession(user)` under this test's AUTH_SECRET. */
  session: string;
}

/** One team with the projects and keyed tasks this file gave it. */
interface Board {
  team: Seed;
  projectIds: string[];
  taskIds: string[];
}

interface World {
  a: Board;
  b: Board;
  /** Team A's active admin holding its builtin Everyone row. */
  alice: Cast;
  /** The same in team B. */
  bob: Cast;
}

let authSecret = "";
/** The one request in flight; null between requests. */
let inFlight: Flight | null = null;

/** Every seam whose own call log is read back per request. */
const SEAMS = {
  revalidatePath: h.revalidatePath,
  projectAllTasks: h.projectAllTasks,
  recordProjectionRun: h.recordProjectionRun,
  headers: h.headers,
  fetch: h.fetch,
};

/** The request a seam was reached in. None of them has a caller between requests. */
function flightOf(seam: string): Flight {
  const flight = inFlight;
  if (!flight) throw new Error(`${FIXTURE} ${seam} was reached with no request in flight`);
  return flight;
}

const clientOf = (db: unknown): string =>
  h.adminDb !== null && db === h.adminDb ? REQUEST_SERVICE_CLIENT : SOME_OTHER_CLIENT;

function realOf<K extends keyof typeof h.real>(owner: K): NonNullable<(typeof h.real)[K]> {
  const original = h.real[owner];
  if (!original) throw new Error(`${FIXTURE} the original ${owner} was never captured`);
  return original as NonNullable<(typeof h.real)[K]>;
}

/** SEAM observe: record the call, run the original, record what it settled with, return that. */
async function passThrough<T>(owner: string, db: unknown, args: Row, original: () => Promise<T>): Promise<T> {
  const step: Step = { step: "lower", owner, client: clientOf(db), args, answered: UNSETTLED };
  flightOf(owner).trace.push(step);
  const answered = await original();
  step.answered = answered ?? null;
  return answered;
}

beforeEach(() => {
  authSecret = randomBytes(32).toString("hex");
  vi.stubEnv("AUTH_SECRET", authSecret);
  vi.stubGlobal("fetch", h.fetch);
  inFlight = null;
  h.adminDb = null;
  h.serverDb = null;
  h.trace = null;

  h.cookies.mockReset();
  h.cookies.mockImplementation(async () => {
    // Bound to the request in flight when `cookies()` was called.
    const flight = inFlight;
    if (!flight) throw new Error(`${FIXTURE} cookies() called with no request in flight`);
    return {
      get: (name: string) => {
        flight.trace.push({ step: "cookie", name });
        const value = flight.jar.get(name);
        return value === undefined ? undefined : { name, value };
      },
    };
  });
  h.revalidatePath.mockReset();
  h.revalidatePath.mockImplementation((path: string) => {
    flightOf("revalidatePath").trace.push({ step: "revalidate", path });
  });

  h.projectAllTasks.mockReset();
  h.projectAllTasks.mockImplementation(async (...args: Parameters<PmSync["projectAllTasks"]>) => {
    const [db, teamId, projectId] = args;
    return passThrough("projectAllTasks", db, { teamId, projectId }, () => realOf("projectAllTasks")(...args));
  });
  h.recordProjectionRun.mockReset();
  h.recordProjectionRun.mockImplementation(async (...args: Parameters<PmSync["recordProjectionRun"]>) => {
    const [db, input] = args;
    const handed = {
      teamId: input.teamId,
      provider: input.provider,
      trigger: input.trigger,
      reports: [...input.reports],
      reason: input.reason ?? null,
      startedAt: input.startedAt,
      finishedAt: input.finishedAt ?? null,
    };
    return passThrough("recordProjectionRun", db, handed, () => realOf("recordProjectionRun")(...args));
  });

  h.headers.mockReset();
  h.headers.mockImplementation(() => {
    flightOf("headers()").trace.push({ step: "tripwire", name: "headers" });
    throw new Error(`${FIXTURE} headers() was read`);
  });
  h.fetch.mockReset();
  h.fetch.mockImplementation(() => {
    flightOf("fetch").trace.push({ step: "tripwire", name: "fetch" });
    throw new Error(`${FIXTURE} fetch was called: no transport may be reached from this file`);
  });
});

afterEach(() => {
  inFlight = null;
  h.adminDb = null;
  h.serverDb = null;
  h.trace = null;
  vi.unstubAllGlobals();
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

const countOf = async (label: string, text: string, params: unknown[] = []): Promise<number> =>
  Number((await fx<{ n: number }>(label, text, params))[0]?.n);

// The guard's tables, the tables the action and its lower path write, and the ones a projection would.
const DURABLE_TABLES = [
  "teams",
  "members",
  "groups",
  "group_members",
  "projects",
  "tasks",
  "task_pm_links",
  "integrations",
  "ingest_runs",
  "audit_log",
] as const;
type DurableTable = (typeof DURABLE_TABLES)[number];
type Durable = Record<DurableTable, Row[]>;
type Changed = Partial<Record<DurableTable, { added: Row[]; removed: Row[] }>>;

/** A stored run with its two instants as epoch ms, so they compare with this process's clock. */
const clocked = (row: Row): Row => ({
  ...row,
  started_at: Date.parse(String(row.started_at)),
  finished_at: Date.parse(String(row.finished_at)),
});

/** Every row of every durable table, every column, in an order that depends on content only. */
async function durable(): Promise<Durable> {
  const snapshot = {} as Durable;
  for (const table of DURABLE_TABLES) {
    const rows = await fx<{ row: Row }>(
      `${table} snapshot`,
      `select to_jsonb(t) as row from ${table} t order by to_jsonb(t)::text`,
    );
    snapshot[table] = rows.map((entry) => (table === "ingest_runs" ? clocked(entry.row) : entry.row));
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
 * A distinct ACTIVE member bound to a fresh auth user, and a real session signed for that auth user.
 * `role` is the member's role and `posture` the one builtin row they hold; the legacy `members.tier`
 * column is written to agree with it. Nothing about the guard is stubbed: which conjunct a cast
 * lacks is read back from the pool here.
 */
async function seedCast(team: Seed, label: string, placed: { role?: Role; posture?: Tier } = {}): Promise<Cast> {
  const role = placed.role ?? "admin";
  const posture = placed.posture ?? "team";
  const user = { id: randomUUID(), email: `${label}-${randomUUID().slice(0, 8)}@aio1217.fixture.test` };
  await fxOne("auth user insert", `insert into auth_users(id, email) values($1, $2) returning id`, [user.id, user.email]);
  const { id } = await fxOne<{ id: string }>(
    "member insert",
    `insert into members(team_id, email, display_name, actor_handle, role, tier, status, auth_user_id)
     values($1, $2, $3, $4, $5, $6, 'active', $7) returning id`,
    [team.teamId, user.email, `AIO1217 ${label}`, `${label}-${randomUUID().slice(0, 8)}`, role, posture, user.id],
  );
  await placeMemberByTier(team.teamId, id, posture);
  premise(`${label}'s authority`, await authority(id), {
    team_id: team.teamId,
    auth_user_id: user.id,
    role,
    status: "active",
    tier: posture,
    everyone_rows: posture === "team" ? 1 : 0,
    external_rows: posture === "external" ? 1 : 0,
  });
  const session = await signSession(user);
  premise(`${label}'s session verifies under the real verifier`, await verifySession(session), user);
  return { label, team, memberId: id, user, session };
}

/**
 * SETUP WRITE: one more project of the board's team, holding two keyed tasks, origin `ui`. The tasks
 * are what a configured provider would be handed; on the branches this file reaches none is read.
 */
async function seedProject(board: Board, tag: string): Promise<void> {
  const ordinal = board.projectIds.length + 1;
  const { id } = await fxOne<{ id: string }>(
    "project insert",
    `insert into projects(team_id, slug, name) values($1, $2, $3) returning id`,
    [board.team.teamId, `aio1217-pb-${randomUUID().slice(0, 8)}`, "AIO1217 project board synthetic project"],
  );
  board.projectIds.push(id);
  for (const n of [1, 2]) {
    const key = `AIO1217-PB-${tag}${ordinal}-${n}`;
    const task = await fxOne<{ id: string }>(
      "task insert",
      `insert into tasks(team_id, project_id, row_key, title, origin) values($1, $2, $3, $4, 'ui') returning id`,
      [board.team.teamId, id, key, `aio1217 synthetic task ${key}`],
    );
    board.taskIds.push(task.id);
  }
}

/** The team's project ids as the pool reads them back, sorted as strings. */
const ownedProjects = async (team: Seed): Promise<string[]> =>
  (await fx<{ id: string }>("owned project readback", `select id from projects where team_id = $1`, [team.teamId]))
    .map((row) => row.id)
    .sort();

/** Every stored run's id, team and verdict, in the order they were written. */
const runsHeld = (): Promise<Row[]> =>
  // Ordered by the qualified column: a bare `id` would name the text output column and sort "10" before "9".
  fx("ingest_runs readback", `select id::text as id, team_id, ok from ingest_runs order by ingest_runs.id`);

/** Every audit row this action writes, of any team, in the order they were written. */
const boardAudits = (): Promise<Row[]> =>
  fx(
    "audit_log readback",
    `select team_id, member_id, action from audit_log where action = 'team.project_board' order by audit_log.id`,
  );

/**
 * Two teams, each with one admitted admin and a signed session. Team A holds `projects.a` projects;
 * team B always holds one, with its tasks: a bystander's rows, so "team B is unchanged" is a
 * statement about rows that exist. Read back: no team names a primary provider, and there is no
 * integration, task link or run anywhere.
 */
async function seedWorld(projects: { a: number }): Promise<World> {
  const a: Board = { team: await seedTeam(), projectIds: [], taskIds: [] };
  const b: Board = { team: await seedTeam(), projectIds: [], taskIds: [] };
  premise("the two teams are distinct", [a.team.teamId === b.team.teamId, a.team.teamSlug === b.team.teamSlug], [
    false,
    false,
  ]);
  const alice = await seedCast(a.team, "alice");
  const bob = await seedCast(b.team, "bob");
  for (let n = 0; n < projects.a; n += 1) await seedProject(a, "A");
  await seedProject(b, "B");

  premise(
    "no team names a primary PM provider",
    await countOf("teams primary readback", `select count(*)::int as n from teams where primary_pm_provider is not null`),
    0,
  );
  premise(
    "no integration row exists, enabled or not",
    await countOf("integrations readback", `select count(*)::int as n from integrations`),
    0,
  );
  premise(
    "no task link exists",
    await countOf("task_pm_links readback", `select count(*)::int as n from task_pm_links`),
    0,
  );
  premise("ingest_runs starts empty", await runsHeld(), []);
  premise("no project-board audit row exists", await boardAudits(), []);
  return { a, b, alice, bob };
}

/** Every identifier one team's fixture rows carry, by a label that names it. */
function identifiersOf(name: string, board: Board, cast: Cast): Record<string, string> {
  const named: Record<string, string> = {
    [`team ${name} id`]: board.team.teamId,
    [`team ${name} slug`]: board.team.teamSlug,
    [`team ${name} seeded member`]: board.team.memberId,
    [`${cast.label}'s member row`]: cast.memberId,
    [`${cast.label}'s auth user`]: cast.user.id,
  };
  board.projectIds.forEach((id, at) => {
    named[`team ${name} project ${at + 1}`] = id;
  });
  board.taskIds.forEach((id, at) => {
    named[`team ${name} task ${at + 1}`] = id;
  });
  return named;
}

/** The board of `who`'s team, and every identifier of the OTHER team. */
const sides = (world: World, who: Cast): { own: Board; other: Record<string, string> } =>
  who.team.teamId === world.a.team.teamId
    ? { own: world.a, other: identifiersOf("B", world.b, world.bob) }
    : { own: world.b, other: identifiersOf("A", world.a, world.alice) };

// ── the recording transport ──────────────────────────────────────────────────────────────────────

const EQUALITY = /([a-z_][a-z0-9_.]*) = \$(\d+)/g;

/** The `column = $n` terms of a compiled clause, with the value bound to each placeholder. */
function equalities(clause: string, params: unknown[]): Row {
  const bound: Row = {};
  for (const match of clause.matchAll(EQUALITY)) bound[match[1]] = params[Number(match[2]) - 1];
  return bound;
}

/**
 * What the real builder compiled, read off its statement heads, as the association file reads them:
 * the last uppercase FROM of a SELECT is its own table and the first uppercase WHERE its own clause.
 * A write is identified by its head alone. Anything else carries no table here.
 */
function compiled(text: string, params: unknown[]): { op: string; table: string; where: Row } {
  const insert = /^\s*INSERT INTO "?([a-z_]+)"?[\s(]/i.exec(text);
  if (insert) return { op: /\sON CONFLICT\s/i.test(text) ? "upsert" : "insert", table: insert[1], where: {} };
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

/** A statement's text and parameters as one searchable string; never throws on its own account. */
function searchable(text: string, params: unknown[]): string {
  try {
    return `${text} ${JSON.stringify(params)}`;
  } catch {
    return `${text} ${params.map((param) => String(param)).join(" ")}`;
  }
}

/**
 * A real `PgClient` whose executor records each compiled statement in the request's trace, forwards
 * it to the real pool and records the row count Postgres answered. The recorder never throws on its
 * own account.
 */
function recordingClient(via: Via, flight: Flight): DbClient {
  const record =
    (inner: SqlExecutor): SqlExecutor =>
    async <T = Row>(text: string, params: unknown[] = []) => {
      const step: Step = { step: "statement", via, ...compiled(text, params), rows: null };
      flight.trace.push(step);
      flight.bound.push(searchable(text, params));
      try {
        const answered = await inner<T>(text, params);
        step.rows = answered.rowCount;
        return answered;
      } catch (error) {
        flight.refused.push(`${NATIVE_ERROR} ${error instanceof Error ? error.message : String(error)}: ${text}`);
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

/** How often each seam was called since the request began, read off its own call log. */
const seamCalls = (): Record<string, number> =>
  Object.fromEntries(
    Object.entries(SEAMS)
      .map(([name, seam]): [string, number] => [name, seam.mock.calls.length])
      .filter(([, calls]) => calls > 0),
  );

/**
 * A NEW invocation with its own cookie jar and trace: snapshot, run the actual export, snapshot
 * again. `session` is the session cookie, or null for none. Nothing is carried over from an earlier
 * request but the rows in Postgres.
 */
async function request(session: string | null, action: () => Promise<unknown>): Promise<Seen> {
  const jar = new Map<string, string>();
  if (session !== null) jar.set(SESSION_COOKIE, session);
  const flight: Flight = { jar, trace: [], refused: [], bound: [] };
  let acquired = { server: 0, admin: 0 };
  let seams: Record<string, number> = {};
  let earliest = 0;
  let latest = 0;

  const before = await durable();
  for (const seam of Object.values(SEAMS)) seam.mockClear();
  let outcome: Settled;
  try {
    inFlight = flight;
    h.trace = flight.trace;
    h.adminDb = recordingClient("admin", flight);
    h.serverDb = recordingClient("server", flight);
    h.acquired.server = 0;
    h.acquired.admin = 0;
    earliest = Date.now();
    outcome = await settle(action);
    latest = Date.now();
  } finally {
    acquired = { server: h.acquired.server, admin: h.acquired.admin };
    seams = seamCalls();
    inFlight = null;
    h.trace = null;
    h.adminDb = null;
    h.serverDb = null;
  }
  const after = await durable();

  // The run and audit writers swallow a failed insert: a refused statement would otherwise be silent.
  premise("no statement the request issued was refused by Postgres", flight.refused, []);

  const returned = "returned" in outcome ? outcome.returned : null;
  return {
    outcome,
    shape: returned !== null && typeof returned === "object" ? Object.keys(returned).sort() : null,
    before,
    after,
    trace: flight.trace,
    acquired,
    seams,
    bound: flight.bound,
    window: { earliest, latest },
  };
}

/** One request as every case compares it. */
const observed = (seen: Seen) => ({
  outcome: seen.outcome,
  shape: seen.shape,
  acquired: seen.acquired,
  seams: seen.seams,
  changed: changes(seen.before, seen.after),
});

/** The labels of the given identifiers that any statement of the request carried, sorted. */
const boundOf = (seen: Seen, identifiers: Record<string, string>): string[] =>
  Object.entries(identifiers)
    .filter(([, value]) => seen.bound.some((statement) => statement.includes(value)))
    .map(([label]) => label)
    .sort();

// ── what a request puts in its trace ─────────────────────────────────────────────────────────────

const statement = (via: Via, table: string, where: Row, rows: number): Step => ({
  step: "statement",
  via,
  op: "select",
  table,
  where,
  rows,
});

const SESSION_READ: Step = { step: "cookie", name: SESSION_COOKIE };
const SERVER_CLIENT: Step = { step: "client", via: "server" };
const SERVICE_CLIENT: Step = { step: "client", via: "admin" };

/**
 * The permission prerequisite of an ADMITTED or posture-refused caller, in the order the owners issue
 * it, as the association file establishes it: the session cookie, the server client, the slug's team,
 * the session's active member in it, and that member's group rows.
 */
const guardChain = (who: Cast, postureRows: number): Step[] => [
  SESSION_READ,
  SERVER_CLIENT,
  statement("server", "teams", { slug: who.team.teamSlug }, 1),
  statement("server", "members", { team_id: who.team.teamId, auth_user_id: who.user.id, status: "active" }, 1),
  statement("server", "group_members", { team_id: who.team.teamId, member_id: who.memberId }, postureRows),
];

/**
 * The first four of those reads for a session whose member lookup in `team` is what refuses: `rows`
 * is how many member rows that lookup is answered with, or any number where this file does not know
 * whether role is filtered in the statement.
 */
const memberLookup = (who: Cast, team: Seed, rows: unknown): Step[] => [
  SESSION_READ,
  SERVER_CLIENT,
  statement("server", "teams", { slug: team.teamSlug }, 1),
  { ...statement("server", "members", { team_id: team.teamId, auth_user_id: who.user.id, status: "active" }, 0), rows },
];

/** A read the gate may issue on a path whose source this file did not read: never a write, never the service client. */
const isGuardRead = (step: Step): boolean =>
  step.step === "cookie" || (step.step === "statement" && step.via === "server" && step.op === "select");

// Service-client reads of these tables are asserted in order; of any other table, set aside.
const ASSERTED_READS = new Set<string>(DURABLE_TABLES.filter((table) => table !== "integrations"));

const isSetAside = (step: Step): boolean =>
  step.step === "statement" && step.via === "admin" && step.op === "select" && !ASSERTED_READS.has(String(step.table));

/**
 * The trace beyond the guard as it is asserted: everything in order but the set-aside reads, with
 * each write reduced to which client issued it, its operation and its table (the row it left is the
 * durable difference's to state).
 */
const ledger = (seen: Seen, guardSteps: number): Step[] =>
  seen.trace
    .slice(guardSteps)
    .filter((step) => !isSetAside(step))
    .map((step) =>
      step.step === "statement" && step.op !== "select"
        ? { step: "write", via: step.via, op: step.op, table: step.table }
        : step,
    );

const lower = (owner: string, args: Row, answered: unknown): Step => ({
  step: "lower",
  owner,
  client: REQUEST_SERVICE_CLIENT,
  args,
  answered,
});

const wrote = (table: string): Step => ({ step: "write", via: "admin", op: "insert", table });

/** What the action hands the run owner: its server-resolved team, trigger `manual`, and no report. */
const composed = (team: Seed, reason: string | null): Row => ({
  teamId: team.teamId,
  provider: null,
  trigger: "manual",
  reports: [],
  reason,
  startedAt: expect.any(Number),
  finishedAt: null,
});

/** The project ids the real `projectAllTasks` was handed, sorted as strings. */
const selected = (seen: Seen): string[] =>
  seen.trace
    .filter((step) => step.step === "lower" && step.owner === "projectAllTasks")
    .map((step) => String((step.args as Row).projectId))
    .sort();

// ── what a request leaves behind ─────────────────────────────────────────────────────────────────

/** The whole `ingest_runs` row the action's one handoff stores: every column the table has. */
const runRow = (team: Seed, verdict: { ok: boolean; errors: string[] }): Row => ({
  id: expect.any(Number),
  team_id: team.teamId,
  source: "pm_sync",
  trigger: "manual",
  ok: verdict.ok,
  created: 0,
  updated: 0,
  // No report reaches the roll-up on either branch, whatever tasks the projects hold.
  unchanged: 0,
  error_count: verdict.errors.length,
  errors: verdict.errors,
  meta: { provider: null },
  started_at: expect.any(Number),
  finished_at: expect.any(Number),
  duration_ms: expect.any(Number),
});

/** A reasoned run: not-ok, with the resolution's reason as its one line (no row key precedes it). */
const UNRESOLVED_RUN = { ok: false, errors: [NO_PROVIDER_REASON] };
/** A run in which the loop never ran: ok, with no line. */
const IDLE_RUN = { ok: true, errors: [] };

/** The whole `audit_log` row the action writes: every column the table has. */
const auditRow = (who: Cast): Row => ({
  id: expect.any(Number),
  team_id: who.team.teamId,
  actor_kind: "member",
  member_id: who.memberId,
  api_key_id: null,
  action: "team.project_board",
  target_type: "team",
  target_id: who.team.teamId,
  meta: { provider: null, counts: {} },
  ip: null,
  created_at: expect.any(String),
});

/** The one run a request added, as the pool read it back. Asked for only after that has been asserted. */
function runOf(seen: Seen): Row {
  const added = changes(seen.before, seen.after).ingest_runs?.added ?? [];
  if (added.length !== 1) throw new Error(`expected exactly one added ingest_runs row, got ${added.length}`);
  return added[0];
}

const idOf = (seen: Seen): string => String(runOf(seen).id);

/**
 * The stored run starts at the instant the action itself handed the run owner, within the call; it
 * finishes no earlier and within the call; and its duration is their difference.
 */
function stamped(seen: Seen): void {
  const run = runOf(seen);
  const handed = seen.trace.find((step) => step.step === "lower" && step.owner === "recordProjectionRun");
  const startedAt = Number(run.started_at);
  const finishedAt = Number(run.finished_at);
  expect(startedAt).toBe((handed?.args as Row | undefined)?.startedAt);
  expect(startedAt).toBeGreaterThanOrEqual(seen.window.earliest);
  expect(finishedAt).toBeGreaterThanOrEqual(startedAt);
  expect(finishedAt).toBeLessThanOrEqual(seen.window.latest);
  expect(run.duration_ms).toBe(finishedAt - startedAt);
}

/**
 * A new invocation under `who`'s session, for `who`'s own team, WHICH HOLDS PROJECTS: admitted by the
 * guard's real reads; the service client; the `projects` read bound to the server-resolved team; one
 * real `projectAllTasks` per owned project, each answering the unresolved primary; one real
 * `recordProjectionRun` carrying the reason; exactly one stored run; then the action's own
 * `{ ok: false, error: <reason> }` — with no audit row, no revalidation, no transport, and no
 * identifier of the other team bound by any statement.
 */
async function admitUnresolved(world: World, who: Cast, label: string): Promise<Seen> {
  const { own, other } = sides(world, who);
  const owned = await ownedProjects(who.team);
  premise(`${label}: the acting team holds exactly its seeded projects, and at least one`, [owned, owned.length > 0], [
    [...own.projectIds].sort(),
    true,
  ]);
  const guard = guardChain(who, await groupRows(who));

  const seen = await request(who.session, () => projectBoardAction(who.team.teamSlug));

  expect(
    {
      ...observed(seen),
      guard: seen.trace.slice(0, guard.length),
      ledger: ledger(seen, guard.length),
      selected: selected(seen),
      foreign: boundOf(seen, other),
    },
    label,
  ).toEqual({
    outcome: { returned: { ok: false, error: NO_PROVIDER_REASON } },
    shape: REFUSED_KEYS,
    acquired: { server: 1, admin: 1 },
    // No `revalidatePath`, no `headers`, no `fetch`.
    seams: { projectAllTasks: owned.length, recordProjectionRun: 1 },
    // No `audit_log` key: the action returned before its audit write.
    changed: { ingest_runs: { added: [runRow(who.team, UNRESOLVED_RUN)], removed: [] } },
    guard,
    ledger: [
      SERVICE_CLIENT,
      statement("admin", "projects", { team_id: who.team.teamId }, owned.length),
      // The order the unordered `projects` read answered in is not asserted: `selected` holds the set.
      ...owned.flatMap(() => [
        lower("projectAllTasks", { teamId: who.team.teamId, projectId: expect.any(String) }, UNRESOLVED),
        // The real resolution's own read of the team's primary, after its (set-aside) integrations read.
        statement("admin", "teams", { id: who.team.teamId }, 1),
      ]),
      lower("recordProjectionRun", composed(who.team, NO_PROVIDER_REASON), null),
      wrote("ingest_runs"),
    ],
    selected: owned,
    foreign: [],
  });
  stamped(seen);
  return seen;
}

/**
 * A new invocation under `who`'s session, for `who`'s own team, WHICH HOLDS NO PROJECT: admitted; the
 * `projects` read answers nothing; no `projectAllTasks`; one real `recordProjectionRun` with no
 * reason; one stored ok run; one stored `team.project_board` audit row naming the server-resolved
 * member; one revalidation asked of the seam; and `{ ok: true, provider: null, counts: {}, reports: [] }`.
 */
async function admitIdle(world: World, who: Cast, label: string): Promise<Seen> {
  const { other } = sides(world, who);
  premise(`${label}: the acting team holds no project`, await ownedProjects(who.team), []);
  const guard = guardChain(who, await groupRows(who));

  const seen = await request(who.session, () => projectBoardAction(who.team.teamSlug));

  expect(
    {
      ...observed(seen),
      guard: seen.trace.slice(0, guard.length),
      ledger: ledger(seen, guard.length),
      foreign: boundOf(seen, other),
    },
    label,
  ).toEqual({
    outcome: { returned: { ok: true, provider: null, counts: {}, reports: [] } },
    shape: ["counts", "ok", "provider", "reports"],
    acquired: { server: 1, admin: 1 },
    seams: { recordProjectionRun: 1, revalidatePath: 1 },
    changed: {
      ingest_runs: { added: [runRow(who.team, IDLE_RUN)], removed: [] },
      audit_log: { added: [auditRow(who)], removed: [] },
    },
    guard,
    ledger: [
      SERVICE_CLIENT,
      statement("admin", "projects", { team_id: who.team.teamId }, 0),
      lower("recordProjectionRun", composed(who.team, null), null),
      wrote("ingest_runs"),
      wrote("audit_log"),
      // SEAM revalidate: the path the action asked for, built from the slug it was handed.
      { step: "revalidate", path: `/t/${who.team.teamSlug}/admin/pm-sync` },
    ],
    foreign: [],
  });
  stamped(seen);
  return seen;
}

interface Refusal {
  /** The session cookie of the invocation, or null for none. */
  session: string | null;
  /** The slug the action is handed. */
  slug: string;
  /** The steps the trace must begin with, exactly. */
  guard: Step[];
  /** How often the server client is acquired. */
  server: number;
  /** `none`: nothing may follow `guard`. `guard reads`: only cookie reads and server-client SELECTs may. */
  rest: "none" | "guard reads";
}

/**
 * A new invocation the gate must REFUSE, with a valid slug and every lower owner live: the action's
 * own `admins only`; the guard's reads and nothing after them; no service client, so no `projects`
 * read and nothing handed down; no pass-through call; no revalidation; no tripwire; and an empty
 * durable difference over every table of both teams.
 */
async function refuse(label: string, refusal: Refusal): Promise<Seen> {
  const seen = await request(refusal.session, () => projectBoardAction(refusal.slug));
  const beyond = seen.trace.slice(refusal.guard.length);
  expect(
    {
      ...observed(seen),
      guard: seen.trace.slice(0, refusal.guard.length),
      beyond: refusal.rest === "none" ? beyond : beyond.filter((step) => !isGuardRead(step)),
    },
    label,
  ).toEqual({
    outcome: { returned: ADMINS_ONLY },
    shape: REFUSED_KEYS,
    acquired: { server: refusal.server, admin: 0 },
    seams: {},
    changed: {},
    guard: refusal.guard,
    beyond: [],
  });
  return seen;
}

describe("AIO-1217 real PM admin action — app/t/[team]/admin/pm-sync/actions.ts#projectBoardAction over real Postgres, real guard and real lower PM path, no PM provider configured (direct calls; cookies, revalidatePath, transport recording, pass-through observation and tripwires are the only seams)", () => {
  it(
    "1 — an admitted admin of team A, which holds two projects of keyed tasks while no team holds an integration or names a primary provider: `projectBoardAction(<team A's slug>)` is admitted by the guard's real cookie, team, member and group reads; reads `projects` on the service client bound to the server-resolved team; hands the real `projectAllTasks` exactly team A's two project ids, each answering `{ provider: null, reports: [], reason: \"no enabled PM integration\" }`; hands the real `recordProjectionRun` one run of team A, provider null, trigger `manual`, no report and that reason; and returns exactly `{ ok: false, error: \"no enabled PM integration\" }` with no other key — leaving exactly one ingest_runs row (team A, `pm_sync`, `manual`, `ok: false`, `created`/`updated`/`unchanged` 0, `error_count: 1`, the reason as its one line, `meta` of the null provider, started at the instant the action handed on) and NO `team.project_board` audit row and NO revalidation, because the action returns before both; no row of team B or of any task, link, project, integration, member or group is added, removed or changed, no statement binds a team B identifier, and global fetch is never called",
    async () => {
      const world = await seedWorld({ a: 2 });

      const seen = await admitUnresolved(world, world.alice, "Alice on team A");

      // Read back raw, over whole tables: the one run is team A's, and no team has a board audit row.
      expect(await runsHeld()).toEqual([{ id: idOf(seen), team_id: world.a.team.teamId, ok: false }]);
      expect(await boardAudits()).toEqual([]);
    },
    ROOMY,
  );

  it(
    "2 — refusals by real session and row state, none by a mocked guard, each a new invocation with team A's valid slug that returns exactly `{ ok: false, error: \"admins only\" }`, never acquires the service client (so reads no project and hands nothing down), reaches neither pass-through owner, asks no revalidation, trips no tripwire and changes no durable row of either team: no session cookie (the server client is never acquired either); an active role-member holding the builtin Everyone row; an active role-admin holding only the builtin External row (the guard's cookie, team, member and group reads exactly, and nothing after them, as the association file establishes) — first while team A holds NO project, after a control in which the admitted admin's same call stores a run AND an audit row and asks a revalidation, then while team A holds two projects, after a control in which the admitted admin's same call projects and stores a run; read back raw, the only runs and the only board audit row are the two controls'",
    async () => {
      const world = await seedWorld({ a: 0 });
      const slug = world.a.team.teamSlug;
      const member = await seedCast(world.a.team, "member", { role: "member" });
      const outsider = await seedCast(world.a.team, "outsider", { posture: "external" });

      const refusals = async (state: string): Promise<void> => {
        await refuse(`${state}: no session cookie`, {
          session: null,
          slug,
          guard: [SESSION_READ],
          // lib/auth/guard.ts returns on a null session user before it asks for the server client.
          server: 0,
          rest: "guard reads",
        });
        await refuse(`${state}: an active role-member holding the builtin Everyone row`, {
          session: member.session,
          slug,
          guard: memberLookup(member, world.a.team, expect.any(Number)),
          server: 1,
          rest: "guard reads",
        });
        await refuse(`${state}: an active role-admin holding only the builtin External row`, {
          session: outsider.session,
          slug,
          guard: guardChain(outsider, await groupRows(outsider)),
          server: 1,
          rest: "none",
        });
      };

      // An admitted call audits and revalidates in this state: the refusals' zero of both is not vacuous.
      const idle = await admitIdle(world, world.alice, `${CONTROL} team A holds no project`);
      await refusals("team A holds no project");

      // SETUP WRITES, outside every snapshot.
      await seedProject(world.a, "A");
      await seedProject(world.a, "A");

      // An admitted call reads the projects and runs the lower path in this state.
      const unresolved = await admitUnresolved(world, world.alice, `${CONTROL} team A holds two projects`);
      await refusals("team A holds two projects");

      expect(await runsHeld()).toEqual([
        { id: idOf(idle), team_id: world.a.team.teamId, ok: true },
        { id: idOf(unresolved), team_id: world.a.team.teamId, ok: false },
      ]);
      expect(await boardAudits()).toEqual([
        { team_id: world.a.team.teamId, member_id: world.alice.memberId, action: "team.project_board" },
      ]);
    },
    ROOMIER,
  );

  it(
    "3 — the foreign-slug direction, both ways: team A's admitted admin, under their own valid session, handed team B's slug is refused `admins only` after the guard resolves team B by that slug and finds no active member of it for the session's user — the only team B identifiers any statement binds are that slug and the team id it resolved to, never a team B project, task or member — with no service client, no project read, no lower call, no revalidation and no durable change to either team; team B's admin handed team A's slug likewise; no run and no board audit row exists after both; then each identity is admitted for its OWN slug and stores exactly one run under its own team, binding nothing of the other's and rewriting nothing of the other's (effects and bindings only: no task is read on this branch, so this is not evidence of any task-level content boundary)",
    async () => {
      const world = await seedWorld({ a: 2 });
      const everything = {
        ...identifiersOf("A", world.a, world.alice),
        ...identifiersOf("B", world.b, world.bob),
      };

      const aliceAtB = await refuse("Alice, an admin of team A, handed team B's slug", {
        session: world.alice.session,
        slug: world.b.team.teamSlug,
        guard: memberLookup(world.alice, world.b.team, 0),
        server: 1,
        rest: "guard reads",
      });
      expect(boundOf(aliceAtB, everything), "what Alice's refused request bound").toEqual([
        "alice's auth user",
        "team B id",
        "team B slug",
      ]);

      const bobAtA = await refuse("Bob, an admin of team B, handed team A's slug", {
        session: world.bob.session,
        slug: world.a.team.teamSlug,
        guard: memberLookup(world.bob, world.a.team, 0),
        server: 1,
        rest: "guard reads",
      });
      expect(boundOf(bobAtA, everything), "what Bob's refused request bound").toEqual([
        "bob's auth user",
        "team A id",
        "team A slug",
      ]);

      expect(await runsHeld(), "after both foreign-slug invocations").toEqual([]);
      expect(await boardAudits(), "after both foreign-slug invocations").toEqual([]);

      // The same two identities are admitted for their own teams: the refusals were the slug's.
      const forA = await admitUnresolved(world, world.alice, `${CONTROL} Alice on team A`);
      // `removed: []` inside: team A's run stands as it was written.
      const forB = await admitUnresolved(world, world.bob, `${CONTROL} Bob on team B`);

      expect(await runsHeld()).toEqual([
        { id: idOf(forA), team_id: world.a.team.teamId, ok: false },
        { id: idOf(forB), team_id: world.b.team.teamId, ok: false },
      ]);
      expect(await boardAudits()).toEqual([]);
    },
    ROOMY,
  );

  it(
    "4 — OBSERVED, as the source orders it and not a ruling: the action's audit write and revalidation sit AFTER its unresolved-primary return. The same admitted admin, the same session and the same slug, with no PM provider configured throughout: while team A holds no project the call returns `{ ok: true, provider: null, counts: {}, reports: [] }`, stores one ok run with no line, stores exactly one `team.project_board` audit row (team A, actor the server-resolved member, target the team, `meta` of the null provider and empty counts) and asks one revalidation of `/t/<slug>/admin/pm-sync` (the seam records the request; nothing of Next's cache runs); once team A holds two projects (a setup write) the same call returns `{ ok: false, error: \"no enabled PM integration\" }`, stores one more run, not-ok, and adds NO audit row and asks NO revalidation — the first run and the audit row standing as written; team B, which holds a project throughout, gains nothing in either call",
    async () => {
      const world = await seedWorld({ a: 0 });

      const idle = await admitIdle(world, world.alice, "Alice while team A holds no project");

      // SETUP WRITES, outside every snapshot.
      await seedProject(world.a, "A");
      await seedProject(world.a, "A");

      // `removed: []` and no `audit_log` key inside: nothing earlier is rewritten and no audit row is added.
      const unresolved = await admitUnresolved(world, world.alice, "Alice once team A holds two projects");

      expect(await runsHeld()).toEqual([
        { id: idOf(idle), team_id: world.a.team.teamId, ok: true },
        { id: idOf(unresolved), team_id: world.a.team.teamId, ok: false },
      ]);
      expect(await boardAudits()).toEqual([
        { team_id: world.a.team.teamId, member_id: world.alice.memberId, action: "team.project_board" },
      ]);
    },
    ROOMY,
  );
});

// Each TODO names the owner of evidence this slice was told not to supply.
describe("Z — evidence this file does NOT supply (executable TODOs: none is run, none is passed)", () => {
  it.todo(
    "COORDINATOR · HANDOFF EXPECTATION NOT MET BY SOURCE: the slice asked for one real `team.project_board` audit row from an admitted invocation on a team holding projects and no PM provider; actions.ts:54 returns `{ ok: false, error: reason }` before the audit write at :59-67 and revalidatePath at :69, so that invocation stores a `pm_sync` run and no audit row naming who pressed the button — asserted as absence in cases 1-3 and located in case 4; whether an admin invocation that writes `ingest_runs` should also be audited is not specified by any source this file reads and is not ruled on here",
  );
  it.todo(
    "PROVIDER-CONFIGURED PATHS · a team holding an enabled, secret-bearing Plane or Linear integration — the sole enabled one, or the one `teams.primary_pm_provider` names — where projectAllTasks goes on to the keyed-task read, projectRows, the adapter's prepare and upsertWorkItem, ensureLink, persistSuccess and persistError, and this action returns `ok: true` with per-status counts and reports and audits a non-null provider, is not exercised; no integration row is written by this file",
  );
  it.todo(
    "MISSING INTEGRATION AND AMBIGUOUS PRIMARY · `teams.primary_pm_provider` set while its integration is absent, disabled or secret-less — where projectAllTasks answers a non-null provider WITH a reason and no report, so by source reading this action records a run without that reason, passes its :54 return and audits `ok: true` — is not exercised; nor is the other unresolved answer, `multiple PM integrations enabled but teams.primary_pm_provider is unset`; this file reaches the none-enabled reason only",
  );
  it.todo(
    "PROVIDER NETWORK · no adapter is invoked and no provider exchange, stubbed or live, takes place; the zero here is a count of global `fetch` during the request, which says nothing of a transport that is not global `fetch`; the action hands projectAllTasks no `fetchImpl`, `sleep` or `throttleMs`, and the ~1 req/s throttle is not reached",
  );
  it.todo(
    "TEAM-BOUND RESOLUTION WITH A CONFIGURED BYSTANDER · no team here holds an integration row, so that team A's primary resolution reads team A's rows alone — and is not answered by team B's enabled integration — is not evidenced by content; the integrations read's source (lib/integrations/manage) is outside this slice's read list, its statements are set aside from the asserted trace, and only the absence of any team B identifier among their bindings is asserted",
  );
  it.todo(
    "REVALIDATION RUNTIME · `revalidatePath` is a recording seam: case 4 shows the action asked for `/t/<slug>/admin/pm-sync`, built from the slug it was handed, and cases 1-3 that it did not ask; that Next invalidates anything, for which route, or what a caller with a differently-cased or foreign slug string would invalidate is not evidenced",
  );
  it.todo(
    "ACTION WIRE · the export is called directly: the Next Server Action transport, POST dispatch, action id encryption, origin and CSRF checks, argument deserialization and what a non-string `teamSlug` would do are not exercised",
  );
  it.todo(
    "OTHER REFUSAL FAMILIES · a session cookie the real verifier rejects (expired, malformed, signed under another secret), a session whose auth user has no member row anywhere, a role-`lead` member, a suspended or invited member of the right team, a slug that names no team, and a guard read that Postgres refuses are not exercised; what lib/auth/session, lib/integrations/read and lib/access/posture read on the no-session, role-member and foreign-slug paths beyond the asserted prefix is tolerated as guard reads and not asserted, their sources being outside this slice's read list",
  );
  it.todo(
    "READ AND WRITE FAULTS · the action's `projErr` return at actions.ts:31 (a refused `projects` read: no run, no audit), a refused `ingest_runs` insert (recordIngestRun swallows it: the action would return the same result with no run stored) and a refused `audit_log` insert (audit swallows it) are not reached; every request here holds as a premise that Postgres refused no statement",
  );
  it.todo(
    "EXCLUDED ACTIONS AND GUARDS · reconcileDivergenceAction of the same file, every export of app/t/[team]/admin/actions.ts (getProvisioningAvailabilityAction, issueApiKey, revokeApiKey, inviteMember), the other callers of projectAllTasks (app/actions/meeting-todos.ts, scripts/brain-tasks.ts), the reactive callers of lib/pm-sync/after-write.ts, `currentMember` and every non-admin guard are not executed here; nothing about API keys, and AIO-1226 is neither asserted nor implemented",
  );
  it.todo(
    "LAST-WRITER COMPOSITION · the action keeps the LAST project's `provider` and the last set `reason` across its loop; with every project of one team resolving identically here that ordering is unobservable, and a state in which projects of one invocation answer differently (an integration enabled or disabled between two iterations) is not constructed",
  );
  it.todo(
    "COORDINATOR · MUTANTS (isolated-copy actual-import run; every expectation below is read from source and NO mutant has been run): against this fixture, ignore the null requireAdmin verdict (case 2 and case 3, on the service client, the trace and the durable difference); read `projects` without the `team_id` equality, or bind it to a client-supplied value (cases 1 and 3, the `projects` statement, `selected` and the foreign bindings); hand projectAllTasks or recordProjectionRun a team other than `ctx.teamId` (cases 1 and 3, the pass-through arguments and the stored `team_id`); drop the recordProjectionRun call, change its trigger from `manual`, or drop its `reason` (case 1, the missing run, `trigger`, and `ok`/`errors`); remove the :54 return (cases 1 and 3, the outcome, the audit row and the revalidation); move the audit write above :54 (case 1, the audit row); drop the audit write or the revalidatePath call, or swap their order (case 4 and case 2's first control, the durable difference and the ledger) — each must then fail on the outcome, the trace, the stored row or the durable difference, not on a compile or fixture error; NOT killed by this fixture, and named so none is counted: dropping the `team_id` or status equality from the integrations read (no integration row exists); keeping the FIRST project's provider or reason instead of the last (every project resolves identically); taking `startedAt` before the guard (still within the call's window, and equal to what was handed on); no mutation evidence is supplied here",
  );
  it.todo(
    "INVENTORY AND ACCEPTANCE · the complete AIO-1217 Server Action inventory, its acceptance criteria, connection inventory, documentation, full-suite checks and final review are not supplied by this file, which evidences one admin action's guard, no-provider composition and refusals by direct invocation only",
  );
});
