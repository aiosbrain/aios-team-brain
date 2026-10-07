import { randomBytes, randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PgClient } from "@/lib/db/pg/client";
import { getPool, runSql } from "@/lib/db/pg/pool";
import type { DbClient, SqlExecutor } from "@/lib/db/types";
import { placeMemberByTier, seedTeam, type Seed } from "./helpers";

/**
 * AIO-1217 — REAL PM ADMIN ACTION, CONFIGURED PRIMARY WHOSE INTEGRATION DOES NOT RESOLVE, against real
 * Postgres: what `app/t/[team]/admin/pm-sync/actions.ts#projectBoardAction` itself returns and writes,
 * executed as the actual exported function through the actual `requireTeamAdmin` chain and the actual
 * lower PM path, for a team whose `teams.primary_pm_provider` names a provider while no enabled,
 * secret-bearing integration of that type exists IN THAT TEAM — and one does exist in another team.
 *
 * This is the connection `aio1217-pm-project-board-no-primary` left unproved. There no team held an
 * integration row or named a primary, the integrations read was set aside from the asserted trace
 * (its source was outside that slice's read list), and team-bound resolution was evidenced only by
 * the absence of foreign bindings. Here the integrations read is ASSERTED: its table, the two
 * equalities bound into it, and the row count Postgres answered, with a bystander row that a read
 * missing either equality would have been answered with.
 *
 *   1 — team A holds an ENABLED, SECRET-LESS integration of its primary's type: the read is answered
 *       with that one row; nothing is decrypted.
 *   2 — team A holds a DISABLED integration of that type carrying a synthetic non-null ciphertext: the
 *       read is answered with no row.
 *   3 — team A holds NO integration: the read is answered with no row.
 *   4 — four refusals by real session and row state, after an admitted control in case 1's state.
 *   Z — what this file does not supply, as executable TODOs naming the owner.
 * In every world team B names the same primary and holds an ENABLED integration of the same type
 * carrying a synthetic non-null ciphertext, a project and keyed tasks.
 *
 * SOURCE FACTS the expectations are read from:
 *   app/t/[team]/admin/pm-sync/actions.ts
 *     :25-26  `requireAdmin(teamSlug)`; a null verdict returns `{ ok: false, error: "admins only" }`.
 *     :28-30  only then `adminClient()`, `startedAt`, and the `projects` read by `ctx.teamId`.
 *     :36-41  one `projectAllTasks(db, ctx.teamId, id)` per owned project; `provider` is the LAST
 *             project's answer and `reason` the last set one.
 *     :45-52  ONE `recordProjectionRun`, handed `reason: provider ? undefined : reason`.
 *     :54     `if (!provider && reason) return …` — not taken when a provider is named.
 *     :59-70  the `team.project_board` audit write, `revalidatePath`, and the `ok: true` return.
 *   lib/pm-sync/project.ts
 *     :120-136 `resolvePrimaryProvider`: `getEnabledIntegrationsWithSecrets(db, teamId)`, then the
 *             team's `primary_pm_provider` by id; a configured provider with no same-type row holding
 *             a secret answers `{ provider, integration: null, reason: "<provider> integration is not
 *             enabled or has no secret" }`.
 *     :518-521 `projectAllTasks` answers `{ provider, reports: [], reason }` for that resolution,
 *             BEFORE it reads any task, selects an adapter, or calls `projectRows`.
 *   lib/integrations/manage.ts:254-271  the read is `integrations` by `team_id` and `status =
 *             "enabled"`; `decryptSecret` is applied to a non-null `secret_ciphertext` only.
 *   lib/pm-sync/runs.ts:77-91, lib/ingest/runs.ts:59-82  a run with no reason and no report is stored
 *             `ok: true` with no line and `meta: { provider }`; the writer swallows its own failure.
 *   lib/api/audit.ts:19-45  the audit writer; best-effort.
 *   lib/auth/guard.ts:46-53, lib/auth/session.ts:11-15, lib/integrations/read.ts:67-91,
 *   lib/access/posture.ts:26-44, lib/auth/admin-access.ts:12-17  the gate: no server client without a
 *             session user; team by slug; the session's active member (role is not filtered in the
 *             statement); that member's group rows; then role admin AND team posture.
 *
 * OBSERVED CURRENT COMPOSITION, NOT A RULING. On this branch the lower path names a provider AND
 * gives a reason, and projects nothing. The action drops that reason before the run owner (:50), so
 * the stored `pm_sync` run reads `ok: true` with no line; it passes its no-provider return (:54);
 * writes its normal audit row with `meta: { provider, counts: {} }`; asks its revalidation; and
 * returns `{ ok: true, provider, counts: {}, reports: [] }`. The reason reaches no durable row and no
 * caller. This file pins that as what the source does today. Whether an invocation that projected
 * nothing should be stored and returned as `ok: true` is not decided here.
 *
 * What is real, and never mocked or handed a verdict: the export; `requireTeamAdmin` →
 * `getSessionUser` → `verifySession` (jose HS256 against AUTH_SECRET) → `resolveIntegrationsAdmin` →
 * `resolveViewerPosture` → `canAccessAdmin`; the action's own `projects` read; `projectAllTasks` →
 * `resolvePrimaryProvider` → `getEnabledIntegrationsWithSecrets` and the two reads beneath it;
 * `recordProjectionRun` with its roll-up; `recordIngestRun`; `audit`; the query builder, the pg pool
 * and Postgres.
 *
 * The synthetic seams, all of them:
 *   SEAM cookies     `next/headers` `cookies` — resolves the jar of the one request in flight. The
 *                    session in it is a real `signSession` token for a real auth_users row that a
 *                    real member row is bound to. AUTH_SECRET is synthetic per test.
 *   SEAM revalidate  `next/cache` `revalidatePath` — records the path and does nothing else. What it
 *                    records is that the action ASKED; it is not evidence of Next cache behavior.
 *   SEAM transport   `adminClient()` and `serverClient()` record their acquisitions and hand out, for
 *                    the duration of one request, a real `PgClient` whose SQL executor RECORDS and
 *                    then forwards to the real pool `runSql`. Nothing above the executor is replaced.
 *   SEAM observe     `@/lib/pm-sync` is the ORIGINAL module with `projectAllTasks` and
 *                    `recordProjectionRun` wrapped by PASS-THROUGH recorders: each records the client
 *                    and arguments it was handed, CALLS THE ORIGINAL with exactly those arguments,
 *                    records what it settled with and returns that. `resolvePrimaryProvider` is
 *                    called inside the original module and `getEnabledIntegrationsWithSecrets` is
 *                    imported by it directly: neither is wrapped, and both are observed only through
 *                    the statements they issue and the answer `projectAllTasks` gives.
 *   SEAM decrypt     `@/lib/secrets/crypto` is the ORIGINAL module with `decryptSecret` wrapped by a
 *                    PASS-THROUGH recorder that notes THAT it was called — never its argument or its
 *                    result — and calls the original. That module's source was not read: that it
 *                    exports `decryptSecret` is lib/integrations/manage.ts's own import. No request
 *                    in this file is expected to reach it.
 *   SEAM tripwires   `next/headers` `headers` and global `fetch`. Each records and throws. The zero of
 *                    `fetch` is a narrow observation beside an answer `projectAllTasks` gives before
 *                    it selects an adapter; it is not provider-runtime proof, and a transport other
 *                    than global `fetch` would not be counted.
 *
 * Every request is: whole-rowset snapshots of ten tables read from the pool by raw SQL immediately
 * before and after; how the call settled and the key list of what it returned; ONE ORDERED TRACE of
 * the session cookie read, each client acquisition, each statement either client issued with the
 * equalities bound into it and the row count Postgres answered, each pass-through call with its
 * arguments and answer, and each revalidation; the acquisition counts; the seams' own call logs; and
 * every identifier the request's statements bound, searched for the other team's. The trace of an
 * admitted request is asserted WHOLE: nothing in it is set aside.
 *
 * Bounds of what is claimed.
 *   - ONE EXPORT, ONE BRANCH. Only `projectBoardAction`, and of it only the refusal and the
 *     configured-primary-with-`integration: null` composition. `reconcileDivergenceAction` is not
 *     called. This is not an AC-04 pass, not full action authorization, not provider success and not
 *     a statement of what a complete audit policy for this action would be.
 *   - ONE PROVIDER TYPE. Every primary and every integration row here is `plane`.
 *   - TEAM-BOUND RESOLUTION IS EVIDENCED BY THE READ, ITS ROW COUNT AND THE ANSWER. The statement
 *     binds team A's id and `enabled`; Postgres answers it with the count only team A's own enabled
 *     rows give, one fewer than a read without the team equality would get (a premise read back per
 *     world); `decryptSecret` is never reached although team B's row holds a ciphertext; and the
 *     answer is team A's unresolved one. What team B's row would do IF it were read — whether the
 *     real `decryptSecret` throws on the synthetic value or returns — was not read and is not claimed.
 *   - CONFINEMENT IS OF EFFECTS AND BINDINGS. Every row team B holds in the ten tables is unchanged
 *     and no team B identifier is bound by an admitted team-A request. No task is read on this
 *     branch, so nothing here is evidence of a task-level content boundary.
 *   - NO ADMITTED TEAM-B INVOCATION. Team B's admin is seeded and never calls the action: with the
 *     synthetic ciphertext in place that call would reach `decryptSecret`, which is a named TODO.
 *   - Direct calls of the exported function: not Next action-wire, POST dispatch, origin, encryption
 *     or cache-invalidation proof. Membership is read per request: no revocation claim is made.
 *   - Nothing about API keys, AIO-1226 or PR714; not an action inventory and not acceptance of any
 *     AIO-1217 criterion.
 *   - `ingest_runs` and `integrations` are assumed emptied between tests by the tier's truncation.
 *     Every world reads both back as a premise before it seeds or counts anything.
 *
 * NOTHING HERE IS A CREDENTIAL. The integration rows are synthetic, with an empty config. The two
 * non-null `secret_ciphertext` values are random marker strings written by raw SQL: they are not the
 * output of `encryptSecret`, encode no secret, and belong to no provider account. No provider
 * identity, token, workspace or URL is created or read by this file.
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
  /** SEAM decrypt: the pass-through recorder. */
  decryptSecret: vi.fn(),
  /** The originals the recorders forward to, captured when each module is first loaded. */
  real: {
    projectAllTasks: null as (typeof import("@/lib/pm-sync"))["projectAllTasks"] | null,
    recordProjectionRun: null as (typeof import("@/lib/pm-sync"))["recordProjectionRun"] | null,
    decryptSecret: null as (typeof import("@/lib/secrets/crypto"))["decryptSecret"] | null,
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
// The original module; the one function the integrations read applies to a ciphertext is wrapped.
vi.mock("@/lib/secrets/crypto", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/secrets/crypto")>();
  h.real.decryptSecret = original.decryptSecret;
  return { ...original, decryptSecret: h.decryptSecret };
});

import { projectBoardAction } from "@/app/t/[team]/admin/pm-sync/actions";
import { SESSION_COOKIE, signSession, verifySession, type SessionUser } from "@/lib/auth/pg-session";

type PmSync = typeof import("@/lib/pm-sync");
type Crypto = typeof import("@/lib/secrets/crypto");
type Row = Record<string, unknown>;
type Role = "admin" | "member";
type Tier = "team" | "external";
type Via = "admin" | "server";
/** One entry of a request's ordered trace: `step` names its kind, the rest is what it carried. */
type Step = Row;

/** Two teams, their sessions, one request, and whole-rowset snapshots around it. */
const ROOMY = 30_000;
/** Case 4 makes five requests. */
const ROOMIER = 60_000;

/** The one provider type this file configures: every primary and every integration row. */
const PROVIDER = "plane";

const ADMINS_ONLY = { ok: false, error: "admins only" };

/** `resolvePrimaryProvider`'s own reason for a configured primary with no secret-bearing enabled row. */
const UNSATISFIED_REASON = `${PROVIDER} integration is not enabled or has no secret`;

/** What the real `projectAllTasks` answers for such a team, whatever the project holds. */
const UNSATISFIED = { provider: PROVIDER, reports: [], reason: UNSATISFIED_REASON };

/** The key list of a refusal: no provider, counts or reports key. */
const REFUSED_KEYS = ["error", "ok"];
/** The key list of the action's `ok: true` return: no error key. */
const PROJECTED_KEYS = ["counts", "ok", "provider", "reports"];

/** What a pass-through recorder notes when it was handed the service client of the request in flight. */
const REQUEST_SERVICE_CLIENT = "the service client of this request";
const SOME_OTHER_CLIENT = "NOT the service client of this request";

/** What a pass-through step holds until its original settles. */
const UNSETTLED = "the original never settled";

const NATIVE_ERROR = "native error:";

/**
 * How team A's own integration of its primary's type stands. Each leaves `resolvePrimaryProvider`
 * with a configured provider and `integration: null`.
 */
type IntegrationState = "secret-less" | "disabled" | "absent";

/** How many rows team A's `team_id` + `status = enabled` read is answered with in each state. */
const ENABLED_ROWS: Record<IntegrationState, number> = { "secret-less": 1, disabled: 0, absent: 0 };

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

/** One team with the projects, keyed tasks and integration rows this file gave it. */
interface Board {
  team: Seed;
  projectIds: string[];
  taskIds: string[];
  integrationIds: string[];
}

interface World {
  state: IntegrationState;
  a: Board;
  b: Board;
  /** Team A's active admin holding its builtin Everyone row. */
  alice: Cast;
  /** The same in team B. Seeded, and never the caller of an invocation in this file. */
  bob: Cast;
  /** Every synthetic non-null `secret_ciphertext` value this world wrote, by a label that names it. */
  markers: Record<string, string>;
}

let authSecret = "";
/** The one request in flight; null between requests. */
let inFlight: Flight | null = null;

/** Every seam whose own call log is read back per request. */
const SEAMS = {
  revalidatePath: h.revalidatePath,
  projectAllTasks: h.projectAllTasks,
  recordProjectionRun: h.recordProjectionRun,
  decryptSecret: h.decryptSecret,
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

  h.decryptSecret.mockReset();
  h.decryptSecret.mockImplementation((...args: Parameters<Crypto["decryptSecret"]>) => {
    // Only that it was reached: what it was handed and what it answers are never recorded.
    inFlight?.trace.push({ step: "decrypt" });
    return realOf("decryptSecret")(...args);
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

/** Rows in an order that depends on their content only. */
const byContent = (rows: Row[]): Row[] =>
  [...rows].sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));

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

/** Every row of a snapshot that one team holds: the team's own row, and each row carrying its id. */
function heldBy(snapshot: Durable, team: Seed): Durable {
  const held = {} as Durable;
  for (const table of DURABLE_TABLES) {
    held[table] = snapshot[table].filter((row) => (table === "teams" ? row.id : row.team_id) === team.teamId);
  }
  return held;
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
 * are what a resolved provider would be handed; on the branch this file reaches none is read.
 */
async function seedProject(board: Board, tag: string): Promise<void> {
  const ordinal = board.projectIds.length + 1;
  const { id } = await fxOne<{ id: string }>(
    "project insert",
    `insert into projects(team_id, slug, name) values($1, $2, $3) returning id`,
    [board.team.teamId, `aio1217-pbir-${randomUUID().slice(0, 8)}`, "AIO1217 integration resolution synthetic project"],
  );
  board.projectIds.push(id);
  for (const n of [1, 2]) {
    const key = `AIO1217-PBIR-${tag}${ordinal}-${n}`;
    const task = await fxOne<{ id: string }>(
      "task insert",
      `insert into tasks(team_id, project_id, row_key, title, origin) values($1, $2, $3, $4, 'ui') returning id`,
      [board.team.teamId, id, key, `aio1217 synthetic task ${key}`],
    );
    board.taskIds.push(task.id);
  }
}

/** SETUP WRITE: the team names `PROVIDER` as its primary PM provider, read back from the pool. */
async function namePrimary(team: Seed): Promise<void> {
  const named = await fxOne<{ provider: string | null }>(
    "primary provider update",
    `update teams set primary_pm_provider = $2 where id = $1 returning primary_pm_provider::text as provider`,
    [team.teamId, PROVIDER],
  );
  premise("the team names the primary PM provider it was given", named.provider, PROVIDER);
}

/** A random marker for a non-null `secret_ciphertext`: not `encryptSecret` output, and no secret. */
const syntheticCiphertext = (): string => `aio1217-synthetic-not-a-ciphertext-${randomUUID()}`;

/**
 * SETUP WRITE, raw SQL: one synthetic `PROVIDER` integration row of the board's team, with an empty
 * config. `ciphertext` is null or a marker from `syntheticCiphertext`. Written outside the single
 * writer on purpose: `upsertIntegration` validates and audits, and `setIntegrationSecret` would
 * produce a real ciphertext, which this file must not hold.
 */
async function seedIntegration(
  board: Board,
  creator: Cast,
  placed: { status: "enabled" | "disabled"; ciphertext: string | null },
): Promise<void> {
  const { id } = await fxOne<{ id: string }>(
    "integration insert",
    `insert into integrations(team_id, type, name, config, status, secret_ciphertext, created_by, updated_at)
     values($1, $2, $3, '{}'::jsonb, $4, $5, $6, now()) returning id`,
    [
      board.team.teamId,
      PROVIDER,
      `aio1217-pbir-${randomUUID().slice(0, 8)}`,
      placed.status,
      placed.ciphertext,
      creator.memberId,
    ],
  );
  board.integrationIds.push(id);
}

/** Every integration row of any team as the resolution's inputs see it; never a ciphertext value. */
const integrationsHeld = async (): Promise<Row[]> =>
  byContent(
    await fx(
      "integrations readback",
      `select team_id, type::text as type, status::text as status, (secret_ciphertext is not null) as has_ciphertext
         from integrations`,
    ),
  );

/** The integration rows a world in `state` holds: team A's one or none, and team B's bystander. */
function integrationsOf(world: Pick<World, "state" | "a" | "b">): Row[] {
  const rows: Row[] = [
    { team_id: world.b.team.teamId, type: PROVIDER, status: "enabled", has_ciphertext: true },
  ];
  if (world.state === "secret-less") {
    rows.push({ team_id: world.a.team.teamId, type: PROVIDER, status: "enabled", has_ciphertext: false });
  }
  if (world.state === "disabled") {
    rows.push({ team_id: world.a.team.teamId, type: PROVIDER, status: "disabled", has_ciphertext: true });
  }
  return byContent(rows);
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

const linksHeld = (): Promise<number> =>
  countOf("task_pm_links readback", `select count(*)::int as n from task_pm_links`);

/**
 * Two teams, each with one admitted admin and a signed session, each naming `PROVIDER` as its primary.
 * Team A holds two projects of keyed tasks and, by `state`, an enabled secret-less integration, a
 * disabled ciphertext-bearing one, or none. Team B holds one project with its tasks and an ENABLED,
 * ciphertext-bearing integration of the same type: a bystander's rows, so "team B is unchanged" and
 * "team B's row did not answer" are statements about rows that exist.
 *
 * Read back, before any request: exactly those integration rows; what the asserted read would be
 * answered with, and what the same read WITHOUT its team equality or WITHOUT its status equality
 * would be — so the asserted row count is known to discriminate; and no task link, run or
 * project-board audit row anywhere.
 */
async function seedWorld(state: IntegrationState): Promise<World> {
  premise(
    "integrations starts empty",
    await countOf("integrations readback", `select count(*)::int as n from integrations`),
    0,
  );
  premise("ingest_runs starts empty", await runsHeld(), []);

  const a: Board = { team: await seedTeam(), projectIds: [], taskIds: [], integrationIds: [] };
  const b: Board = { team: await seedTeam(), projectIds: [], taskIds: [], integrationIds: [] };
  premise("the two teams are distinct", [a.team.teamId === b.team.teamId, a.team.teamSlug === b.team.teamSlug], [
    false,
    false,
  ]);
  const alice = await seedCast(a.team, "alice");
  const bob = await seedCast(b.team, "bob");
  await seedProject(a, "A");
  await seedProject(a, "A");
  await seedProject(b, "B");
  await namePrimary(a.team);
  await namePrimary(b.team);

  const markers: Record<string, string> = { "team B's synthetic ciphertext": syntheticCiphertext() };
  await seedIntegration(b, bob, { status: "enabled", ciphertext: markers["team B's synthetic ciphertext"] });
  if (state === "secret-less") await seedIntegration(a, alice, { status: "enabled", ciphertext: null });
  if (state === "disabled") {
    markers["team A's disabled synthetic ciphertext"] = syntheticCiphertext();
    await seedIntegration(a, alice, {
      status: "disabled",
      ciphertext: markers["team A's disabled synthetic ciphertext"],
    });
  }

  const world: World = { state, a, b, alice, bob, markers };
  premise("exactly the seeded integration rows exist", await integrationsHeld(), integrationsOf(world));
  premise(
    "what the read is answered with as written, without its team equality, and without its status equality",
    {
      asWritten: await countOf(
        "scoped read",
        `select count(*)::int as n from integrations where team_id = $1 and status = 'enabled'`,
        [a.team.teamId],
      ),
      withoutTeam: await countOf(
        "status-only read",
        `select count(*)::int as n from integrations where status = 'enabled'`,
      ),
      withoutStatus: await countOf(
        "team-only read",
        `select count(*)::int as n from integrations where team_id = $1`,
        [a.team.teamId],
      ),
    },
    {
      asWritten: ENABLED_ROWS[state],
      // Team B's enabled row is always one more.
      withoutTeam: ENABLED_ROWS[state] + 1,
      // Only the disabled state tells the status equality apart by count.
      withoutStatus: state === "absent" ? 0 : 1,
    },
  );
  premise("no task link exists", await linksHeld(), 0);
  premise("ingest_runs is still empty", await runsHeld(), []);
  premise("no project-board audit row exists", await boardAudits(), []);
  return world;
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
  board.integrationIds.forEach((id, at) => {
    named[`team ${name} integration ${at + 1}`] = id;
  });
  return named;
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

/** Values as one searchable string; never throws on its own account. */
function searchable(text: string, values: unknown[]): string {
  try {
    return `${text} ${JSON.stringify(values)}`;
  } catch {
    return `${text} ${values.map((value) => String(value)).join(" ")}`;
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

/** The labels of the world's synthetic ciphertexts found in what the call settled with or its trace, sorted. */
function surfaced(seen: Seen, world: World): string[] {
  const said = searchable("", [seen.outcome, seen.trace, seen.bound]);
  return Object.entries(world.markers)
    .filter(([, value]) => said.includes(value))
    .map(([label]) => label)
    .sort();
}

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
 * The gate's whole prerequisite for a session whose user is an active member of the slug's team, in
 * the order the owners issue it (lib/auth/guard.ts:49-52, lib/integrations/read.ts:72-89): the
 * session cookie, the server client, the slug's team, the session's active member in it (role is
 * read, not filtered), and that member's group rows. Admission or refusal is then decided in memory.
 */
const guardChain = (who: Cast, postureRows: number): Step[] => [
  SESSION_READ,
  SERVER_CLIENT,
  statement("server", "teams", { slug: who.team.teamSlug }, 1),
  statement("server", "members", { team_id: who.team.teamId, auth_user_id: who.user.id, status: "active" }, 1),
  statement("server", "group_members", { team_id: who.team.teamId, member_id: who.memberId }, postureRows),
];

/** The gate's whole trace for a session whose user holds no active member row in `team` (read.ts:86). */
const strangerChain = (who: Cast, team: Seed): Step[] => [
  SESSION_READ,
  SERVER_CLIENT,
  statement("server", "teams", { slug: team.teamSlug }, 1),
  statement("server", "members", { team_id: team.teamId, auth_user_id: who.user.id, status: "active" }, 0),
];

/**
 * The trace beyond the guard as it is asserted: every step, in order, with each write reduced to
 * which client issued it, its operation and its table (the row it left is the durable difference's
 * to state). No read is set aside.
 */
const ledger = (seen: Seen, guardSteps: number): Step[] =>
  seen.trace
    .slice(guardSteps)
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

/**
 * What the action hands the run owner on this branch: its server-resolved team, the named provider,
 * trigger `manual`, no report — and NO reason, the lower path's reason having been dropped at
 * actions.ts:50 because a provider is named.
 */
const composed = (team: Seed): Row => ({
  teamId: team.teamId,
  provider: PROVIDER,
  trigger: "manual",
  reports: [],
  reason: null,
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

/**
 * The whole `ingest_runs` row the action's one handoff stores on this branch, every column the table
 * has: `ok: true` with no line, although the lower path gave a reason and projected nothing.
 */
const runRow = (team: Seed): Row => ({
  id: expect.any(Number),
  team_id: team.teamId,
  source: "pm_sync",
  trigger: "manual",
  ok: true,
  created: 0,
  updated: 0,
  unchanged: 0,
  error_count: 0,
  errors: [],
  meta: { provider: PROVIDER },
  started_at: expect.any(Number),
  finished_at: expect.any(Number),
  duration_ms: expect.any(Number),
});

/** The whole `audit_log` row the action writes on this branch: every column the table has. */
const auditRow = (who: Cast): Row => ({
  id: expect.any(Number),
  team_id: who.team.teamId,
  actor_kind: "member",
  member_id: who.memberId,
  api_key_id: null,
  action: "team.project_board",
  target_type: "team",
  target_id: who.team.teamId,
  meta: { provider: PROVIDER, counts: {} },
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
 * A new invocation under Alice's session for team A, in whatever state the world's integration is:
 * admitted by the guard's real reads; the service client; the `projects` read bound to the
 * server-resolved team; one real `projectAllTasks` per owned project, beneath each of which the real
 * resolution reads `integrations` by team A and `enabled` and then team A's primary, and which
 * answers the named provider WITH the reason and no report; one real `recordProjectionRun` handed the
 * provider and NO reason; one stored ok run; one stored audit row; one revalidation asked of the
 * seam; and the action's `ok: true` return — with no decrypt, no transport, no task read, no link,
 * no identifier of team B bound by any statement, and every row team B holds as it was.
 */
async function admitUnsatisfied(world: World, label: string): Promise<Seen> {
  const who = world.alice;
  const team = world.a.team;
  const owned = await ownedProjects(team);
  premise(`${label}: team A holds exactly its seeded projects, and at least one`, [owned, owned.length > 0], [
    [...world.a.projectIds].sort(),
    true,
  ]);
  const guard = guardChain(who, await groupRows(who));

  const seen = await request(who.session, () => projectBoardAction(team.teamSlug));

  const bystander = heldBy(seen.before, world.b.team);
  premise(
    `${label}: team B held its team row, its project, its tasks and its enabled integration before the request`,
    [bystander.teams.length, bystander.projects.length, bystander.tasks.length, bystander.integrations.length],
    [1, 1, 2, 1],
  );

  expect(
    {
      ...observed(seen),
      guard: seen.trace.slice(0, guard.length),
      ledger: ledger(seen, guard.length),
      selected: selected(seen),
      foreign: boundOf(seen, identifiersOf("B", world.b, world.bob)),
      surfaced: surfaced(seen, world),
      bystander: heldBy(seen.after, world.b.team),
    },
    label,
  ).toEqual({
    // The lower path's reason is in neither the return nor any row below.
    outcome: { returned: { ok: true, provider: PROVIDER, counts: {}, reports: [] } },
    shape: PROJECTED_KEYS,
    acquired: { server: 1, admin: 1 },
    // No `decryptSecret`, no `headers`, no `fetch`.
    seams: { projectAllTasks: owned.length, recordProjectionRun: 1, revalidatePath: 1 },
    // No `task_pm_links`, `tasks`, `integrations` or `teams` key: nothing else was added, removed or changed.
    changed: {
      ingest_runs: { added: [runRow(team)], removed: [] },
      audit_log: { added: [auditRow(who)], removed: [] },
    },
    guard,
    ledger: [
      SERVICE_CLIENT,
      statement("admin", "projects", { team_id: team.teamId }, owned.length),
      // The order the unordered `projects` read answered in is not asserted: `selected` holds the set.
      ...owned.flatMap(() => [
        lower("projectAllTasks", { teamId: team.teamId, projectId: expect.any(String) }, UNSATISFIED),
        // lib/integrations/manage.ts:258-262, by team A and `enabled`, answered with team A's own rows only.
        statement("admin", "integrations", { team_id: team.teamId, status: "enabled" }, ENABLED_ROWS[world.state]),
        // lib/pm-sync/project.ts:125, the team's primary. No `tasks` read follows.
        statement("admin", "teams", { id: team.teamId }, 1),
      ]),
      lower("recordProjectionRun", composed(team), null),
      wrote("ingest_runs"),
      wrote("audit_log"),
      // SEAM revalidate: the path the action asked for, built from the slug it was handed.
      { step: "revalidate", path: `/t/${team.teamSlug}/admin/pm-sync` },
    ],
    selected: owned,
    foreign: [],
    surfaced: [],
    bystander,
  });
  stamped(seen);
  return seen;
}

/** What every admitted case leaves, read back raw over whole tables. */
async function leftBehind(world: World, seen: Seen): Promise<void> {
  expect(await runsHeld()).toEqual([{ id: idOf(seen), team_id: world.a.team.teamId, ok: true }]);
  expect(await boardAudits()).toEqual([
    { team_id: world.a.team.teamId, member_id: world.alice.memberId, action: "team.project_board" },
  ]);
  expect(await linksHeld()).toBe(0);
  expect(await integrationsHeld()).toEqual(integrationsOf(world));
}

interface Refusal {
  /** The session cookie of the invocation, or null for none. */
  session: string | null;
  /** The slug the action is handed. */
  slug: string;
  /** The whole trace, exactly. */
  guard: Step[];
  /** How often the server client is acquired. */
  server: number;
}

/**
 * A new invocation the gate must REFUSE, with a valid slug and every lower owner live: the action's
 * own `admins only`; the guard's reads and nothing after them; no service client, so no `projects`
 * or `integrations` read and nothing handed down; no pass-through call; no decrypt; no revalidation;
 * no tripwire; and an empty durable difference over every table of both teams.
 */
async function refuse(label: string, refusal: Refusal): Promise<Seen> {
  const seen = await request(refusal.session, () => projectBoardAction(refusal.slug));
  expect({ ...observed(seen), trace: seen.trace }, label).toEqual({
    outcome: { returned: ADMINS_ONLY },
    shape: REFUSED_KEYS,
    acquired: { server: refusal.server, admin: 0 },
    seams: {},
    changed: {},
    trace: refusal.guard,
  });
  return seen;
}

describe("AIO-1217 real PM admin action — app/t/[team]/admin/pm-sync/actions.ts#projectBoardAction over real Postgres, real guard and real lower PM path, primary PM provider configured while its integration does not resolve in the acting team (direct calls; cookies, revalidatePath, transport recording, pass-through observation, the decrypt recorder and tripwires are the only seams)", () => {
  it(
    "1 — OBSERVED, not a ruling — team A names `plane` and holds one ENABLED, SECRET-LESS `plane` integration; team B names `plane` and holds an ENABLED `plane` integration carrying a synthetic non-null ciphertext: `projectBoardAction(<team A's slug>)` by team A's admitted admin is admitted by the guard's real reads; reads `projects` by the server-resolved team; and for each of team A's two projects the real resolution reads `integrations` bound to team A's id and `status = enabled` — answered with exactly ONE row, where the same read without its team equality would be answered with two — then team A's primary, and the real `projectAllTasks` answers `{ provider: \"plane\", reports: [], reason: \"plane integration is not enabled or has no secret\" }`; `decryptSecret` is never reached; the real `recordProjectionRun` is handed provider `plane`, trigger `manual`, no report and NO reason; the action passes its no-provider return, and returns exactly `{ ok: true, provider: \"plane\", counts: {}, reports: [] }` — leaving one ingest_runs row (team A, `pm_sync`, `manual`, `ok: true`, no line, `meta` of the provider), one `team.project_board` audit row (team A, the server-resolved member, `meta` of the provider and empty counts) and one revalidation asked of `/t/<slug>/admin/pm-sync`; no task is read, no task link or integration row is written, no statement binds a team B identifier, every row team B holds is unchanged, and global fetch is never called",
    async () => {
      const world = await seedWorld("secret-less");

      const seen = await admitUnsatisfied(world, "Alice on team A, whose plane integration is enabled and secret-less");

      await leftBehind(world, seen);
    },
    ROOMY,
  );

  it(
    "2 — OBSERVED, not a ruling — team A names `plane` and holds one DISABLED `plane` integration carrying a synthetic non-null ciphertext; team B as in case 1: the same call's `integrations` read, bound to team A's id and `status = enabled`, is answered with NO row — where the same read without its status equality would be answered with team A's disabled row, and without its team equality with team B's enabled one — so `decryptSecret` is never reached although both rows hold a ciphertext; `projectAllTasks` answers the same named provider with the same reason and no report, and the action composes exactly as in case 1: a run stored `ok: true` with no reason, the audit row, the revalidation and `{ ok: true, provider: \"plane\", counts: {}, reports: [] }`, with team B's rows unchanged and none of its identifiers bound",
    async () => {
      const world = await seedWorld("disabled");

      const seen = await admitUnsatisfied(world, "Alice on team A, whose plane integration is disabled");

      await leftBehind(world, seen);
    },
    ROOMY,
  );

  it(
    "3 — OBSERVED, not a ruling — team A names `plane` and holds NO integration at all; team B as in case 1, so the only integration row in the database is team B's enabled, ciphertext-bearing one: the same call's `integrations` read, bound to team A's id and `status = enabled`, is answered with NO row, `decryptSecret` is never reached, team B's row does not satisfy team A's resolution — `projectAllTasks` answers the named provider with the reason and no report — and the action composes exactly as in case 1, with team B's rows unchanged and none of its identifiers bound",
    async () => {
      const world = await seedWorld("absent");

      const seen = await admitUnsatisfied(world, "Alice on team A, which holds no integration");

      await leftBehind(world, seen);
    },
    ROOMY,
  );

  it(
    "4 — refusals by real session and row state, none by a mocked guard, in case 1's state and after a control in which the admitted admin's same call reads `integrations`, stores a run and an audit row and asks a revalidation: each a new invocation that returns exactly `{ ok: false, error: \"admins only\" }`, issues the gate's own reads and nothing after them, never acquires the service client (so reads no project and no integration and hands nothing down), reaches neither pass-through owner nor `decryptSecret`, asks no revalidation, trips no tripwire and changes no durable row of either team — no session cookie, handed team A's slug (the cookie read alone; the server client is never acquired); an active role-member of team A holding the builtin Everyone row; an active role-admin of team A holding only the builtin External row; and team A's admitted admin, under their own valid session, handed team B's slug, where the only team B identifiers any statement binds are that slug and the team id it resolved to, never team B's integration, project, task or member; read back raw, the only run and the only board audit row are the control's",
    async () => {
      const world = await seedWorld("secret-less");
      const slug = world.a.team.teamSlug;
      const member = await seedCast(world.a.team, "member", { role: "member" });
      const outsider = await seedCast(world.a.team, "outsider", { posture: "external" });

      // An admitted call reads, writes and revalidates in this state: the refusals' zeros are not vacuous.
      const control = await admitUnsatisfied(world, `${CONTROL} Alice on team A`);

      await refuse("no session cookie", {
        session: null,
        slug,
        // lib/auth/guard.ts:50 returns on a null session user before it asks for the server client.
        guard: [SESSION_READ],
        server: 0,
      });
      await refuse("an active role-member holding the builtin Everyone row", {
        session: member.session,
        slug,
        // lib/integrations/read.ts:74-89: the member row is found, posture is read, then role refuses.
        guard: guardChain(member, await groupRows(member)),
        server: 1,
      });
      await refuse("an active role-admin holding only the builtin External row", {
        session: outsider.session,
        slug,
        guard: guardChain(outsider, await groupRows(outsider)),
        server: 1,
      });
      const aliceAtB = await refuse("Alice, an admin of team A, handed team B's slug", {
        session: world.alice.session,
        slug: world.b.team.teamSlug,
        guard: strangerChain(world.alice, world.b.team),
        server: 1,
      });
      expect(
        boundOf(aliceAtB, {
          ...identifiersOf("A", world.a, world.alice),
          ...identifiersOf("B", world.b, world.bob),
        }),
        "what Alice's refused request bound",
      ).toEqual(["alice's auth user", "team B id", "team B slug"]);

      await leftBehind(world, control);
    },
    ROOMIER,
  );
});

// Each TODO names evidence this slice was told not to supply, or could not.
describe("Z — evidence this file does NOT supply (executable TODOs: none is run, none is passed)", () => {
  it.todo(
    "CONFIGURED AND SECRET-BEARING · PROVIDER-ADAPTER EXECUTION: a team whose primary's integration is enabled and holds a real ciphertext — where `getEnabledIntegrationsWithSecrets` decrypts, `resolvePrimaryProvider` answers a `ResolvedPrimary`, and projectAllTasks goes on to the keyed-task read, projectRows, the adapter's prepare and upsertWorkItem, ensureLink, persistSuccess and persistError, and this action returns per-status counts and reports — is not exercised; no decryptable ciphertext is written by this file and no adapter is selected",
  );
  it.todo(
    "NETWORK TRANSPORTS · no provider exchange, stubbed or live, takes place; the zero here is a count of global `fetch` during the request, beside an answer given before an adapter is selected, and says nothing of a transport that is not global `fetch`; the action hands projectAllTasks no `fetchImpl`, `sleep` or `throttleMs`, and the ~1 req/s throttle is not reached",
  );
  it.todo(
    "ACTION WIRE AND NEXT CACHE · the export is called directly: the Next Server Action transport, POST dispatch, action id encryption, origin and CSRF checks, argument deserialization and what a non-string `teamSlug` would do are not exercised; `revalidatePath` is a recording seam showing only that the action ASKED for `/t/<slug>/admin/pm-sync` built from the slug it was handed — that Next invalidates anything, or what a differently-cased slug string would invalidate, is not evidenced",
  );
  it.todo(
    "AMBIGUOUS AND UNCONFIGURED FALLBACK · `teams.primary_pm_provider` unset with exactly one enabled secret-bearing PM integration (the sole-enabled fallback, project.ts:138-141), with several (`multiple PM integrations enabled but teams.primary_pm_provider is unset`), and with a primary naming one provider while only the OTHER provider's integration is enabled are not exercised; the none-enabled reason is the no-primary file's; every primary and every integration row here is `plane`, so `linear` and any mixed-type state are not exercised",
  );
  it.todo(
    "INTEGRATION READ AND DECRYPT ERRORS · a refused `integrations` read (`load integrations failed: …`, thrown out of projectAllTasks and so out of this action, with no run and no audit row by source reading), a `decryptSecret` that throws on a stored value, and a refused `teams` read beneath the resolution (whose error project.ts:125 does not inspect) are not reached; what the real `decryptSecret` does with this file's synthetic values was not read and is not claimed, and every request here holds as a premise that Postgres refused no statement",
  );
  it.todo(
    "ADMITTED TEAM-B INVOCATION · team B's admin is seeded and never calls the action: with a synthetic non-null ciphertext on team B's enabled row that call would reach `decryptSecret`; so the reverse direction — that team B's resolution is answered by team B's row alone, and Bob handed team A's slug is refused after his own admitted control — is not evidenced here",
  );
  it.todo(
    "COORDINATOR · AUDIT AND RUN POLICY DECISIONS (observed, not ruled on): on this branch the lower path's reason is dropped at actions.ts:50, so an invocation that projected nothing stores a `pm_sync` run reading `ok: true` with no line, writes a `team.project_board` audit row whose meta is `{ provider, counts: {} }`, and returns `ok: true` — while the no-primary branch stores a not-ok run and writes NO audit row; whether the reason should reach the run, the audit row or the caller, whether both branches should audit, and what Admin → PM sync health should read from such a run are not specified by any source this file reads",
  );
  it.todo(
    "MISSING-INTEGRATION LINK BOOKKEEPING · `projectTask`'s own `integration === null` branch (project.ts:286-292: ensureLink, persistError, a `missing_integration` report) is reached by the reactive single-task callers and never by `projectAllTasks`, which returns first; this file asserts only that no `task_pm_links` row is written by the board action in this state",
  );
  it.todo(
    "LAST-WRITER COMPOSITION · the action keeps the LAST project's `provider` and the last set `reason` across its loop; with every project of one team resolving identically here that ordering is unobservable, and a state in which projects of one invocation answer differently (an integration enabled, disabled or given a secret between two iterations) is not constructed",
  );
  it.todo(
    "OTHER REFUSAL FAMILIES · a session cookie the real verifier rejects (expired, malformed, signed under another secret), a session whose auth user has no member row anywhere, a role-`lead` member, a suspended or invited member of the right team, a slug that names no team, a guard read that Postgres refuses, and the refusals in the disabled and absent states are not exercised; the legacy `members.tier` column's two stale directions are the association file's",
  );
  it.todo(
    "READ AND WRITE FAULTS · the action's `projErr` return at actions.ts:31 (a refused `projects` read: no run, no audit), a refused `ingest_runs` insert (recordIngestRun swallows it: the action would return the same result with no run stored) and a refused `audit_log` insert (audit swallows it: the same `ok: true` with no audit row) are not reached",
  );
  it.todo(
    "COORDINATOR · MUTANTS (isolated-copy actual-import run; every expectation below is read from source and NO mutant has been run): against this fixture, drop the `team_id` equality from the integrations read in lib/integrations/manage.ts (cases 1-3: the bound equalities and the row count, and by source reading `decryptSecret` is then reached on team B's row); drop its `status` equality (all cases on the bound equalities; case 2 also on the row count and the decrypt recorder); bind it to a team other than the one projectAllTasks was handed (the foreign bindings); drop `&& i.secret` from chooseIntegration (case 1: a resolved primary, a `tasks` read and an adapter); pass `reason` to recordProjectionRun regardless of provider (the handed arguments and the stored `ok`/`errors`); change the :54 return to fire on any reason (the outcome, the audit row and the revalidation); drop the audit write or the revalidatePath call, or swap their order (the durable difference and the ledger); ignore the null requireAdmin verdict (case 4) — each must then fail on the outcome, the trace, the stored row or the durable difference, not on a compile or fixture error; NOT killed by this fixture, and named so none is counted: keeping the FIRST project's provider or reason instead of the last (every project resolves identically); taking `startedAt` before the guard (still within the call's window, and equal to what was handed on); dropping `&& i.secret` in cases 2 and 3 (no enabled row is read); no mutation evidence is supplied here",
  );
  it.todo(
    "EXCLUDED ACTIONS, TASK CONTENT AND ACCEPTANCE · reconcileDivergenceAction of the same file, every other admin export, the other callers of projectAllTasks and the reactive callers of lib/pm-sync/after-write.ts are not executed here; no task is read on this branch, so no task-content authorization is evidenced; nothing about API keys, AIO-1226 or PR714; this file is not an AC-04 pass, not the AIO-1217 Server Action inventory, and not acceptance, full-suite checks or final review of any criterion",
  );
});
