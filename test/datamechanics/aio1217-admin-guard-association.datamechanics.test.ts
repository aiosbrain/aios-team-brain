import { randomBytes, randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PgClient } from "@/lib/db/pg/client";
import { getPool, runSql } from "@/lib/db/pg/pool";
import type { DbClient, SqlExecutor } from "@/lib/db/types";
import { placeMemberByTier, seedTeam, type Seed } from "./helpers";

/**
 * AIO-1217 — FIVE ADMIN OPERATIONS, GUARD ASSOCIATION against real Postgres: that each of five
 * selected exports is bound to the team-admin gate, executed as the actual exported function through
 * the actual `requireTeamAdmin` chain over synthetic session, team, member and group rows in the
 * task's data-mechanics Postgres. This is the PG complement of group A of the unit-tier
 * `test/actions/aio1217-admin-operations-auth.test.ts`: that file answers the guard's three
 * statements from an in-memory substrate; this one sends them to Postgres and lets the real rows
 * decide. It establishes ACTION-TO-GUARD ASSOCIATION and nothing beneath the wrappers.
 *
 *   G — each export, four cases: an admitted control on each of two teams; the two stale directions
 *       of the legacy `members.tier` column; and removal then restoration of the builtin Everyone row,
 *       each step a new invocation.
 *   Z — what this fixture does not supply, as executable TODOs naming the later owner.
 *
 * Exports exercised, as `<repository path>#<export>`, with the shape each returns to a refused caller:
 *   app/t/[team]/admin/pm-sync/actions.ts#projectBoardAction          { ok: false, error: "admins only" }
 *   app/t/[team]/admin/pm-sync/actions.ts#reconcileDivergenceAction   { ok: false, error: "admins only" }
 *   app/t/[team]/admin/actions.ts#getProvisioningAvailabilityAction   [] — an empty list, not an object
 *   app/t/[team]/admin/actions.ts#issueApiKey                         { ok: false, error: "admins only" }
 *   app/t/[team]/admin/actions.ts#revokeApiKey                        { ok: false, error: "admins only" }
 * `inviteMember`, the fourth export of app/t/[team]/admin/actions.ts, is NOT exercised.
 *
 * What is real, and never mocked or handed a verdict: the five exports; `requireTeamAdmin` →
 * `getSessionUser` → `verifySession` (jose HS256 against AUTH_SECRET) → `resolveIntegrationsAdmin`
 * → `resolveViewerPosture` → `canAccessAdmin`; the board action's own `projects` read by resolved
 * team; the query builder, the pg pool and Postgres. A caller is admitted only by a cookie the real
 * verifier accepts and by team, member, role and builtin-group rows the real owners read themselves.
 *
 * The synthetic seams, all of them:
 *   SEAM cookies     `next/headers` `cookies` — resolves the jar of the one request in flight. The
 *                    session in it is a real `signSession` token for a real auth_users row that a
 *                    real member row is bound to. AUTH_SECRET is synthetic per test.
 *   SEAM revalidate  `next/cache` `revalidatePath` — records the path.
 *   SEAM transport   `adminClient()` and `serverClient()` record their acquisitions and hand out, for
 *                    the duration of one request, a real `PgClient` whose SQL executor RECORDS and
 *                    then forwards to the real pool `runSql`. Nothing above the executor is replaced.
 *   SEAM lower       six lower owners, each the ORIGINAL module with only the named exports replaced
 *                    by a recording double that writes nothing and reaches nothing: `@/lib/pm-sync`
 *                    `projectAllTasks`, `recordProjectionRun`; `@/lib/pm-sync/reconcile`
 *                    `reconcileProviderState`; `@/lib/provisioning/run` `getProvisioningAvailability`;
 *                    `@/lib/admin/keys` `issueApiKey`, `revokeApiKey`. Each records the client and the
 *                    arguments it was handed and answers a fixed, non-empty, healthy result computed
 *                    from those arguments, so an admitted control cannot be an early return.
 *   SEAM audit       `@/lib/api/audit` `audit` — the original module with `audit` replaced. During a
 *                    request it records the entry and writes NOTHING; between requests it forwards to
 *                    the real writer, so the fixture helpers behave as in every other file.
 *   SEAM tripwires   `next/headers` `headers` and global `fetch`. Each records and throws. None of the
 *                    five exports reaches one today, so their zero is a tripwire, not behavior.
 *
 * Every request is one grouped assertion over: how the call settled; ONE ORDERED TRACE of everything
 * observable — the session cookie read, each client acquisition, each statement either client issued
 * with the equalities bound into it and the row count Postgres answered, each lower and audit seam
 * call with its arguments, each revalidation; the client acquisition counts; the seams' own call
 * logs (kept by vitest, independently of the trace); and the durable difference, computed from whole
 * rowsets read from the pool before and after. The caller's authority rows — role, status, the
 * legacy tier column and the builtin rows held — are then read back from the pool by raw SQL, so
 * which conjunct a case removed is a readback and not a fixture's say-so.
 *
 * A denial owes the guard's own prerequisite reads and nothing else: no service-client acquisition,
 * no statement on it, no lower seam, no audit seam, no revalidation, no tripwire and an empty durable
 * difference — with valid input and every seam armed to succeed, after an admitted control on the
 * same fixture, so an admitted call would have shown. Fixture premises fail with the `FIXTURE` prefix
 * and are never a security observation; a failed admitted control says `CONTROL`.
 *
 * THE LEGACY TIER COLUMN IS OBSERVED, NOT JUDGED. The action gate reads membership-derived posture
 * (the builtin Everyone row) and never `members.tier`; other legacy SQL reads that column. Where the
 * two disagree, this file records what the five ACTIONS do today in both directions — a `team` column
 * without the Everyone row is denied, an `external` column with it is admitted. Neither is a
 * SQL-policy pass, neither corrects the disagreement, and neither declares it compliant.
 *
 * Bounds of what is claimed.
 *   - Guard association for five selected exports only. Not a census, not final acceptance of any
 *     AIO-1217 criterion, and nothing about AIO-1225, AIO-1227 or AIO-1228.
 *   - NO NATIVE OWNER EVIDENCE. Provider resolution, task selection, the provider transport,
 *     `ingest_runs`, `task_pm_links`, the `api_keys` insert and update, the integration and secret
 *     reads and the `audit_log` insert all live beneath the seams and are not executed here. The
 *     durable difference is therefore empty for an ADMITTED call too: it shows the seams wrote
 *     nothing, and for a denial it is a second line beside the trace, not the discriminating one.
 *   - `issueApiKey`'s `memberId` and `revokeApiKey`'s `apiKeyId` are forwarded as given and are not
 *     examined here. The same-team member-target refusal is DEFERRED AIO-1226: neither asserted nor
 *     implemented.
 *   - Only the posture conjunct is varied. Role stays admin and status stays active in every case;
 *     the session, team, membership and role refusals and the read faults are the unit tier's.
 *   - Direct calls of the exported functions: not Next action-wire, POST dispatch, origin,
 *     encryption or real cache-invalidation proof.
 *   - Membership is read per request: no revocation or linearizability claim is made.
 *
 * Run status at authoring: NOT RUN. This file was written without executing vitest, tsc or any other
 * command. Its expectations come from reading the sources above, not from an observed run; replace
 * this paragraph with the observed result once it has been executed.
 */

const FIXTURE = "FIXTURE PREMISE FAILED (setup, not a security observation):";
const CONTROL = "ADMITTED CONTROL FAILED (the paired denial would be vacuous):";

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
  /** The ordered trace of the request in flight; null between requests. */
  trace: null as Array<Record<string, unknown>> | null,
  /** SEAM lower: the six recording owners. */
  projectAllTasks: vi.fn(),
  recordProjectionRun: vi.fn(),
  reconcileProviderState: vi.fn(),
  getProvisioningAvailability: vi.fn(),
  issueApiKeyPrimitive: vi.fn(),
  revokeApiKeyPrimitive: vi.fn(),
  /** SEAM audit. */
  audit: vi.fn(),
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
// The original modules, with only the lower owners the five exports call replaced.
vi.mock("@/lib/pm-sync", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/pm-sync")>()),
  projectAllTasks: h.projectAllTasks,
  recordProjectionRun: h.recordProjectionRun,
}));
vi.mock("@/lib/pm-sync/reconcile", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/pm-sync/reconcile")>()),
  reconcileProviderState: h.reconcileProviderState,
}));
vi.mock("@/lib/provisioning/run", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/provisioning/run")>()),
  getProvisioningAvailability: h.getProvisioningAvailability,
}));
vi.mock("@/lib/admin/keys", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/admin/keys")>()),
  issueApiKey: h.issueApiKeyPrimitive,
  revokeApiKey: h.revokeApiKeyPrimitive,
}));
vi.mock("@/lib/api/audit", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api/audit")>()),
  audit: h.audit,
}));

import { getProvisioningAvailabilityAction, issueApiKey, revokeApiKey } from "@/app/t/[team]/admin/actions";
import { projectBoardAction, reconcileDivergenceAction } from "@/app/t/[team]/admin/pm-sync/actions";
import type { AuditEntry } from "@/lib/api/audit";
import { SESSION_COOKIE, signSession, verifySession, type SessionUser } from "@/lib/auth/pg-session";

type Row = Record<string, unknown>;
type Tier = "team" | "external";
type Via = "admin" | "server";
/** One entry of a request's ordered trace: `step` names its kind, the rest is what it carried. */
type Step = Row;

/** Two teams, several sessions, up to three requests, and whole-rowset snapshots around each. */
const ROOMY = 30_000;

const ADMINS_ONLY = { ok: false, error: "admins only" };

/** The provider every PM seam answers with: configured, so no admitted control is an early return. */
const PROVIDER = "linear";

/** What a lower or audit seam records when it was handed the service client of the request in flight. */
const REQUEST_SERVICE_CLIENT = "the service client of this request";
const SOME_OTHER_CLIENT = "NOT the service client of this request";

const NATIVE_ERROR = "native error:";

interface Flight {
  jar: Map<string, string>;
  trace: Step[];
  /** The statements Postgres itself refused; a fixture premise holds this empty. */
  refused: string[];
}

/** How a call ended: what it returned, or how its rejection classifies. */
type Settled = { returned: unknown } | { rejected: { error: boolean; message: string } };

interface Seen {
  outcome: Settled;
  before: Durable;
  after: Durable;
  trace: Step[];
  acquired: { server: number; admin: number };
  /** How often each seam was called, by name, read off its own call log; absent when never. */
  seams: Record<string, number>;
}

interface Cast {
  label: string;
  team: Seed;
  memberId: string;
  user: SessionUser;
  /** `signSession(user)` under this test's AUTH_SECRET. */
  session: string;
}

/** The conjuncts the gate reads off a member's rows, and the legacy column it does not read. */
interface Standing {
  role: string;
  status: string;
  tier: string;
  everyone_rows: number;
  external_rows: number;
}

interface World {
  a: Seed;
  b: Seed;
  /** Team A's active admin holding its builtin Everyone row, legacy tier `team`. */
  alice: Cast;
  /** The same in team B. */
  bob: Cast;
  /** The one project each team holds, by team id. */
  projects: Map<string, string>;
  /** The one live key row each team holds, by team id. */
  keys: Map<string, string>;
}

interface Prepared {
  /** The actual export, called with valid input for this surface. */
  invoke(teamSlug: string): Promise<unknown>;
  /** What an admitted call returns. */
  result: unknown;
  /** The steps an admitted call owes after it acquires the service client, in order. */
  effects: Step[];
  /** The seams an admitted call reaches, with how often. */
  seams: Record<string, number>;
}

interface Surface {
  /** The `<repository path>#<export>` this group exercises. */
  key: string;
  /** What this export returns to a caller the gate refuses. */
  denial: unknown;
  /** Valid input for `who`'s team, fresh each time it is called, and what an admitted call owes. */
  prepare(world: World, who: Cast): Promise<Prepared>;
}

let authSecret = "";
/** The one request in flight; null between requests. */
let inFlight: Flight | null = null;
/** Makes every prepared input distinct. */
let serial = 0;
const next = (): number => ++serial;

/** Every seam whose own call log is read back per request. */
const SEAMS = {
  revalidatePath: h.revalidatePath,
  projectAllTasks: h.projectAllTasks,
  recordProjectionRun: h.recordProjectionRun,
  reconcileProviderState: h.reconcileProviderState,
  getProvisioningAvailability: h.getProvisioningAvailability,
  issueApiKey: h.issueApiKeyPrimitive,
  revokeApiKey: h.revokeApiKeyPrimitive,
  audit: h.audit,
  headers: h.headers,
  fetch: h.fetch,
};

/** The request a lower seam or tripwire was reached in. None of them has a caller between requests. */
function flightOf(seam: string): Flight {
  const flight = inFlight;
  if (!flight) throw new Error(`${FIXTURE} ${seam} was reached with no request in flight`);
  return flight;
}

const clientOf = (db: unknown): string =>
  h.adminDb !== null && db === h.adminDb ? REQUEST_SERVICE_CLIENT : SOME_OTHER_CLIENT;

/** Records one lower-owner call: which client it was handed, and its remaining arguments. */
function recordLower(owner: string, db: unknown, args: Row): void {
  flightOf(owner).trace.push({ step: "lower", owner, client: clientOf(db), args });
}

// What the lower seams answer, computed from the arguments they were handed.
const seamReport = (teamId: string, projectId: string): Row => ({
  row_key: `AIO1217-GA-${projectId}`,
  provider: PROVIDER,
  status: "synced",
  providerResourceId: `aio1217-seam-issue-${teamId}`,
});
const seamDivergence = (teamId: string): Row => ({
  row_key: `AIO1217-GA-${teamId}`,
  provider: PROVIDER,
  last_projected_status: "in_progress",
  provider_seen_status: "done",
});
const seamAvailability = (teamId: string): Row[] => [
  { tool: "linear", configured: true },
  { tool: "slack", configured: false, reason: `aio1217 seam answer for team ${teamId}` },
  { tool: "github", configured: true },
];
/** A label, not a credential: no key material is generated anywhere in this file. */
const seamKey = (teamId: string, memberId: string, name: string): string =>
  `aio1217-seam-key-label.${teamId}.${memberId}.${name}`;

beforeEach(() => {
  authSecret = randomBytes(32).toString("hex");
  vi.stubEnv("AUTH_SECRET", authSecret);
  vi.stubGlobal("fetch", h.fetch);
  inFlight = null;
  serial = 0;
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
  h.projectAllTasks.mockImplementation(async (db: unknown, teamId: string, projectId: string) => {
    recordLower("projectAllTasks", db, { teamId, projectId });
    return { provider: PROVIDER, reports: [seamReport(teamId, projectId)] };
  });
  h.recordProjectionRun.mockReset();
  h.recordProjectionRun.mockImplementation(async (db: unknown, input: Row) => {
    recordLower("recordProjectionRun", db, { input: { ...input } });
  });
  h.reconcileProviderState.mockReset();
  h.reconcileProviderState.mockImplementation(async (db: unknown, teamId: string) => {
    recordLower("reconcileProviderState", db, { teamId });
    return { provider: PROVIDER, seenUpdated: 2, divergences: [seamDivergence(teamId)] };
  });
  h.getProvisioningAvailability.mockReset();
  h.getProvisioningAvailability.mockImplementation(async (db: unknown, teamId: string) => {
    recordLower("getProvisioningAvailability", db, { teamId });
    return seamAvailability(teamId);
  });
  h.issueApiKeyPrimitive.mockReset();
  h.issueApiKeyPrimitive.mockImplementation(
    async (db: unknown, teamId: string, memberId: string, name: string, opts: unknown) => {
      recordLower("issueApiKey", db, { teamId, memberId, name, opts });
      return { key: seamKey(teamId, memberId, name), keyId: "aio1217seam" };
    },
  );
  h.revokeApiKeyPrimitive.mockReset();
  h.revokeApiKeyPrimitive.mockImplementation(async (db: unknown, teamId: string, apiKeyId: string, opts: unknown) => {
    recordLower("revokeApiKey", db, { teamId, apiKeyId, opts });
  });

  h.audit.mockReset();
  h.audit.mockImplementation(async (db: unknown, entry: AuditEntry) => {
    const flight = inFlight;
    if (!flight) {
      // Between requests the fixture helpers get the real writer.
      const original = await vi.importActual<typeof import("@/lib/api/audit")>("@/lib/api/audit");
      await original.audit(db as DbClient, entry);
      return;
    }
    flight.trace.push({ step: "audit", client: clientOf(db), entry: { ...entry } });
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

// The guard's tables, and every table a lower owner beneath the seams would write.
const DURABLE_TABLES = [
  "teams",
  "members",
  "groups",
  "group_members",
  "projects",
  "tasks",
  "task_pm_links",
  "ingest_runs",
  "integrations",
  "api_keys",
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

/** An active admin holding the builtin Everyone row, with the legacy tier column agreeing. */
const HEALTHY: Standing = { role: "admin", status: "active", tier: "team", everyone_rows: 1, external_rows: 0 };

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
 * A distinct ACTIVE ADMIN bound to a fresh auth user, and a real session signed for that auth user.
 * `posture` is the builtin row they hold (null for none); `legacyTier` is the `members.tier` column,
 * which the gate does not read and which need not agree with it. Nothing about the guard is stubbed.
 */
async function seedAdmin(
  team: Seed,
  label: string,
  placed: { posture?: Tier | null; legacyTier?: Tier } = {},
): Promise<Cast> {
  const posture = placed.posture === undefined ? "team" : placed.posture;
  const legacyTier = placed.legacyTier ?? "team";
  const user = { id: randomUUID(), email: `${label}-${randomUUID().slice(0, 8)}@aio1217.fixture.test` };
  await fxOne("auth user insert", `insert into auth_users(id, email) values($1, $2) returning id`, [user.id, user.email]);
  const { id } = await fxOne<{ id: string }>(
    "member insert",
    `insert into members(team_id, email, display_name, actor_handle, role, tier, status, auth_user_id)
     values($1, $2, $3, $4, 'admin', $5, 'active', $6) returning id`,
    [team.teamId, user.email, `AIO1217 ${label}`, `${label}-${randomUUID().slice(0, 8)}`, legacyTier, user.id],
  );
  if (posture) await placeMemberByTier(team.teamId, id, posture);
  premise(`${label}'s authority`, await authority(id), {
    team_id: team.teamId,
    auth_user_id: user.id,
    role: "admin",
    status: "active",
    tier: legacyTier,
    everyone_rows: posture === "team" ? 1 : 0,
    external_rows: posture === "external" ? 1 : 0,
  });
  const session = await signSession(user);
  premise(`${label}'s session verifies under the real verifier`, await verifySession(session), user);
  return { label, team, memberId: id, user, session };
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

/** The one project the board action's own read must find for the team. */
async function seedProject(team: Seed): Promise<string> {
  const { id } = await fxOne<{ id: string }>(
    "project insert",
    `insert into projects(team_id, slug, name) values($1, $2, $3) returning id`,
    [team.teamId, `aio1217-ga-${randomUUID().slice(0, 8)}`, "AIO1217 guard association project"],
  );
  return id;
}

/** A live key row of the team's seeded member: what a revoke that was not a seam would have changed. */
async function seedKey(team: Seed): Promise<string> {
  const { id } = await fxOne<{ id: string }>(
    "api key insert",
    `insert into api_keys(team_id, member_id, key_id, key_hash, name) values($1, $2, $3, $4, $5) returning id`,
    [
      team.teamId,
      team.memberId,
      randomBytes(6).toString("hex"),
      randomBytes(32).toString("hex"),
      "AIO1217 guard association standing key",
    ],
  );
  return id;
}

/**
 * Two teams, each with one healthy admin and a signed session, one project and one live key row.
 * The other team's rows are bystanders: a resolved team that drifted would bind or reach them.
 */
async function seedWorld(): Promise<World> {
  const a = await seedTeam();
  const b = await seedTeam();
  premise("the two teams are distinct", [a.teamId === b.teamId, a.teamSlug === b.teamSlug], [false, false]);
  const alice = await seedAdmin(a, "alice");
  const bob = await seedAdmin(b, "bob");
  const projects = new Map<string, string>();
  const keys = new Map<string, string>();
  for (const team of [a, b]) {
    projects.set(team.teamId, await seedProject(team));
    keys.set(team.teamId, await seedKey(team));
  }
  return { a, b, alice, bob, projects, keys };
}

function held(owned: Map<string, string>, team: Seed, what: string): string {
  const id = owned.get(team.teamId);
  if (id === undefined) throw new Error(`${FIXTURE} team ${team.teamSlug} holds no seeded ${what}`);
  return id;
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
 * What the real builder compiled, read off its statement heads. Embedded resources compile to
 * lowercase subselects, so the last uppercase FROM of a SELECT is its own table and the first
 * uppercase WHERE its own clause. Anything that is not a plain statement carries no table here.
 */
function compiled(text: string, params: unknown[]): { op: string; table: string; where: Row } {
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
  const flight: Flight = { jar, trace: [], refused: [] };
  let logged: string[] = [];
  let acquired = { server: 0, admin: 0 };
  let seams: Record<string, number> = {};

  const before = await durable();
  for (const seam of Object.values(SEAMS)) seam.mockClear();
  // The real adapter logs each failure it converts; captured so every such line is accounted for.
  const adapterLog = vi.spyOn(console, "error").mockImplementation(() => {});
  let outcome: Settled;
  try {
    inFlight = flight;
    h.trace = flight.trace;
    h.adminDb = recordingClient("admin", flight);
    h.serverDb = recordingClient("server", flight);
    h.acquired.server = 0;
    h.acquired.admin = 0;
    outcome = await settle(action);
  } finally {
    acquired = { server: h.acquired.server, admin: h.acquired.admin };
    seams = seamCalls();
    inFlight = null;
    h.trace = null;
    h.adminDb = null;
    h.serverDb = null;
    logged = adapterLog.mock.calls.map((call) => String(call[0]));
    adapterLog.mockRestore();
  }
  const after = await durable();

  premise("no statement the request issued was refused by Postgres", flight.refused, []);
  premise(
    "the real adapter converted no failure into a returned error",
    logged.filter((line) => line.startsWith("[pg]")),
    [],
  );

  return { outcome, before, after, trace: flight.trace, acquired, seams };
}

/** One request as the cases compare it. */
const observe = (seen: Seen) => ({
  outcome: seen.outcome,
  trace: seen.trace,
  acquired: seen.acquired,
  seams: seen.seams,
  changed: changes(seen.before, seen.after),
});

// ── what a request puts in its trace ─────────────────────────────────────────────────────────────

const statement = (via: Via, table: string, where: Row, rows: number): Step => ({
  step: "statement",
  via,
  op: "select",
  table,
  where,
  rows,
});

/**
 * The permission prerequisite, in the order the owners issue it — as read from lib/auth/guard,
 * lib/auth/session, lib/integrations/read and lib/access/posture: the session cookie, the server
 * client, the slug's team, the session's active member in it, and that member's group rows.
 */
const guardChain = (who: Cast, postureRows: number): Step[] => [
  { step: "cookie", name: SESSION_COOKIE },
  { step: "client", via: "server" },
  statement("server", "teams", { slug: who.team.teamSlug }, 1),
  statement("server", "members", { team_id: who.team.teamId, auth_user_id: who.user.id, status: "active" }, 1),
  statement("server", "group_members", { team_id: who.team.teamId, member_id: who.memberId }, postureRows),
];

const SERVICE_CLIENT: Step = { step: "client", via: "admin" };

const lower = (owner: string, args: Row): Step => ({ step: "lower", owner, client: REQUEST_SERVICE_CLIENT, args });

/** The entry a PM wrapper hands the audit seam: the server-resolved team as target, the member as actor. */
const audited = (who: Cast, action: string, meta: Row): Step => ({
  step: "audit",
  client: REQUEST_SERVICE_CLIENT,
  entry: {
    team_id: who.team.teamId,
    actor_kind: "member",
    member_id: who.memberId,
    action,
    target_type: "team",
    target_id: who.team.teamId,
    meta,
  },
});

const revalidated = (path: string): Step => ({ step: "revalidate", path });
const pmSyncPath = (team: Seed) => `/t/${team.teamSlug}/admin/pm-sync`;
const keysPath = (team: Seed) => `/t/${team.teamSlug}/admin/keys`;

/** The actor every key wrapper hands its primitive: the server-resolved member. */
const actorOf = (who: Cast) => ({ actor: { kind: "member", memberId: who.memberId } });

// ── the five exports ─────────────────────────────────────────────────────────────────────────────

const PROJECT_BOARD: Surface = {
  key: "app/t/[team]/admin/pm-sync/actions.ts#projectBoardAction",
  denial: ADMINS_ONLY,
  prepare: async (world, who) => {
    const teamId = who.team.teamId;
    const projectId = held(world.projects, who.team, "project");
    premise(
      "the acting team holds exactly its one seeded project",
      (await fx<{ id: string }>("owned project readback", `select id from projects where team_id = $1`, [teamId])).map(
        (row) => row.id,
      ),
      [projectId],
    );
    const reports = [
      {
        row_key: `AIO1217-GA-${projectId}`,
        provider: PROVIDER,
        status: "synced",
        providerResourceId: `aio1217-seam-issue-${teamId}`,
      },
    ];
    return {
      invoke: (teamSlug) => projectBoardAction(teamSlug),
      result: { ok: true, provider: PROVIDER, counts: { synced: 1 }, reports },
      effects: [
        // The wrapper's own read, bound to the resolved team: the other team's project is not answered.
        statement("admin", "projects", { team_id: teamId }, 1),
        lower("projectAllTasks", { teamId, projectId }),
        lower("recordProjectionRun", {
          input: { teamId, provider: PROVIDER, trigger: "manual", reports, startedAt: expect.any(Number) },
        }),
        audited(who, "team.project_board", { provider: PROVIDER, counts: { synced: 1 } }),
        revalidated(pmSyncPath(who.team)),
      ],
      seams: { projectAllTasks: 1, recordProjectionRun: 1, audit: 1, revalidatePath: 1 },
    };
  },
};

const RECONCILE_DIVERGENCE: Surface = {
  key: "app/t/[team]/admin/pm-sync/actions.ts#reconcileDivergenceAction",
  denial: ADMINS_ONLY,
  prepare: async (_world, who) => {
    const teamId = who.team.teamId;
    const divergences = [
      {
        row_key: `AIO1217-GA-${teamId}`,
        provider: PROVIDER,
        last_projected_status: "in_progress",
        provider_seen_status: "done",
      },
    ];
    return {
      invoke: (teamSlug) => reconcileDivergenceAction(teamSlug),
      result: { ok: true, provider: PROVIDER, seenUpdated: 2, divergences },
      effects: [
        lower("reconcileProviderState", { teamId }),
        audited(who, "team.reconcile_divergence", { provider: PROVIDER, seenUpdated: 2, divergences: 1 }),
        revalidated(pmSyncPath(who.team)),
      ],
      seams: { reconcileProviderState: 1, audit: 1, revalidatePath: 1 },
    };
  },
};

const PROVISIONING_AVAILABILITY: Surface = {
  key: "app/t/[team]/admin/actions.ts#getProvisioningAvailabilityAction",
  // The source's documented non-admin return: an empty list, not an `admins only` object.
  denial: [],
  prepare: async (_world, who) => {
    const teamId = who.team.teamId;
    return {
      invoke: (teamSlug) => getProvisioningAvailabilityAction(teamSlug),
      // Returned as the seam gave it: non-empty, so it cannot be mistaken for the denial.
      result: [
        { tool: "linear", configured: true },
        { tool: "slack", configured: false, reason: `aio1217 seam answer for team ${teamId}` },
        { tool: "github", configured: true },
      ],
      // The wrapper neither audits nor revalidates.
      effects: [lower("getProvisioningAvailability", { teamId })],
      seams: { getProvisioningAvailability: 1 },
    };
  },
};

const ISSUE_API_KEY: Surface = {
  key: "app/t/[team]/admin/actions.ts#issueApiKey",
  denial: ADMINS_ONLY,
  prepare: async (_world, who) => {
    const teamId = who.team.teamId;
    // A member of the acting team. Forwarded as given: its binding is not this file's (AIO-1226).
    const target = who.team.memberId;
    const name = `AIO1217 guard association key ${next()}`;
    return {
      invoke: (teamSlug) => issueApiKey(teamSlug, target, name),
      result: { ok: true, key: `aio1217-seam-key-label.${teamId}.${target}.${name}` },
      // The audit row is the primitive's, beneath the seam: the wrapper itself audits nothing.
      effects: [
        lower("issueApiKey", { teamId, memberId: target, name, opts: actorOf(who) }),
        revalidated(keysPath(who.team)),
      ],
      seams: { issueApiKey: 1, revalidatePath: 1 },
    };
  },
};

const REVOKE_API_KEY: Surface = {
  key: "app/t/[team]/admin/actions.ts#revokeApiKey",
  denial: ADMINS_ONLY,
  prepare: async (world, who) => {
    const teamId = who.team.teamId;
    const apiKeyId = held(world.keys, who.team, "key row");
    return {
      invoke: (teamSlug) => revokeApiKey(teamSlug, apiKeyId),
      result: { ok: true },
      effects: [lower("revokeApiKey", { teamId, apiKeyId, opts: actorOf(who) }), revalidated(keysPath(who.team))],
      seams: { revokeApiKey: 1, revalidatePath: 1 },
    };
  },
};

const SURFACES: Surface[] = [
  PROJECT_BOARD,
  RECONCILE_DIVERGENCE,
  PROVISIONING_AVAILABILITY,
  ISSUE_API_KEY,
  REVOKE_API_KEY,
];

/**
 * A new invocation under `who`'s session that the gate must ADMIT: the guard's reads, the service
 * client, then exactly what the wrapper owes — for the server-resolved team and member — and
 * `who`'s rows as the pool reads them back afterwards.
 */
async function admit(surface: Surface, world: World, who: Cast, label: string, standing: Standing): Promise<void> {
  const prepared = await surface.prepare(world, who);
  const postureRows = await groupRows(who);
  const seen = await request(who.session, () => prepared.invoke(who.team.teamSlug));
  expect({ ...observe(seen), standing: await standingOf(who) }, label).toEqual({
    outcome: { returned: prepared.result },
    trace: [...guardChain(who, postureRows), SERVICE_CLIENT, ...prepared.effects],
    acquired: { server: 1, admin: 1 },
    seams: prepared.seams,
    // Every lower owner is a seam: an admitted call leaves no row either.
    changed: {},
    standing,
  });
}

/**
 * A new invocation under `who`'s session that the gate must DENY, with valid input and every seam
 * armed to succeed: this export's own denial shape, the guard's prerequisite reads and nothing after
 * them, and `who`'s rows as the pool reads them back afterwards.
 */
async function deny(surface: Surface, world: World, who: Cast, label: string, standing: Standing): Promise<void> {
  const prepared = await surface.prepare(world, who);
  const postureRows = await groupRows(who);
  const seen = await request(who.session, () => prepared.invoke(who.team.teamSlug));
  expect({ ...observe(seen), standing: await standingOf(who) }, label).toEqual({
    outcome: { returned: surface.denial },
    // The session, the team and the active admin membership are all admitted; posture is what refuses.
    trace: guardChain(who, postureRows),
    // The service client is never acquired, so nothing below the wrapper can have been handed it.
    acquired: { server: 1, admin: 0 },
    // No lower owner, no audit entry, no revalidation, no tripwire.
    seams: {},
    changed: {},
    standing,
  });
}

describe.each(SURFACES)(
  "G — $key (ADM guard association over real Postgres; every lower owner is a recording seam)",
  (surface) => {
    it(
      "admitted control: an active role-admin holding the builtin Everyone row, legacy tier team, is admitted on each of two teams — the guard's three reads answered by real rows, then the service client and the wrapper's seams carrying only that call's server-resolved team and member",
      async () => {
        const world = await seedWorld();

        await admit(surface, world, world.alice, "Alice on team A", HEALTHY);
        // Only the session and the slug differ: nothing of team A's is bound, handed down or returned.
        await admit(surface, world, world.bob, "Bob on team B", HEALTHY);
      },
      ROOMY,
    );

    it(
      "stale legacy tier, `team` without the row: an active role-admin whose members.tier says team but who holds only the builtin External row — no builtin Everyone row — is DENIED on a new invocation in this export's own shape, before the service client, any lower seam, the audit seam and revalidation (observed action behavior; the legacy SQL/action tier disagreement is neither corrected nor declared compliant)",
      async () => {
        const world = await seedWorld();
        await admit(surface, world, world.alice, CONTROL, HEALTHY);

        // Same team, same role, same status as the control: only the builtin row held differs.
        const stale = await seedAdmin(world.a, "tier-team-no-everyone", { legacyTier: "team", posture: "external" });

        await deny(surface, world, stale, "an admin whose legacy tier says team, without the Everyone row", {
          ...HEALTHY,
          everyone_rows: 0,
          external_rows: 1,
        });
      },
      ROOMY,
    );

    it(
      "stale legacy tier, `external` with the row: an active role-admin whose members.tier says external but who holds the builtin Everyone row is ADMITTED, and the wrapper's seams carry that member as the actor (observation only: the action gate reads membership, never the legacy column — not a SQL-policy pass, and the legacy SQL/action tier disagreement is neither corrected nor declared compliant)",
      async () => {
        const world = await seedWorld();

        const stale = await seedAdmin(world.a, "tier-external-with-everyone", {
          legacyTier: "external",
          posture: "team",
        });

        await admit(surface, world, stale, "an admin whose legacy tier says external, holding the Everyone row", {
          ...HEALTHY,
          tier: "external",
        });
      },
      ROOMY,
    );

    it(
      "builtin Everyone removed, then restored: an admitted invocation; with the row removed a NEW invocation under the same session is denied in this export's own shape with no wrapper effect; with the row restored a further new invocation is admitted — role admin, status active and legacy tier team throughout",
      async () => {
        const world = await seedWorld();
        await admit(surface, world, world.alice, CONTROL, HEALTHY);

        await removeEveryone(world.alice);
        await deny(surface, world, world.alice, "Alice with the Everyone row removed", {
          ...HEALTHY,
          everyone_rows: 0,
        });

        await placeMemberByTier(world.a.teamId, world.alice.memberId, "team");
        await admit(surface, world, world.alice, "Alice with the Everyone row restored", HEALTHY);
      },
      ROOMY,
    );
  },
);

// Each TODO names the later owner of evidence this slice was told not to supply.
describe("Z — follow-up evidence this fixture does NOT supply (executable TODOs: none is run, none is passed)", () => {
  it.todo(
    "BATCH 4 OWNER WORK · native PM and API-key owners: projectAllTasks, recordProjectionRun, reconcileProviderState and the lib/admin/keys primitives are recording seams here — provider resolution, `ingest_runs`, `task_pm_links`, the `api_keys` insert and update and their `audit_log` rows are not executed against Postgres by this file",
  );
  it.todo(
    "BATCH 5 · getProvisioningAvailability: the per-tool integration and secret reads beneath the availability wrapper are a recording seam here and are not executed by this file",
  );
  it.todo(
    "DEFERRED AIO-1226 · issueApiKey forwards a client-supplied memberId with no same-team lookup of that member; the target refusal is neither asserted nor implemented by this file",
  );
  it.todo(
    "LEGACY TIER · the disagreement between legacy SQL that reads members.tier and the action gate that reads the builtin Everyone row is recorded by the two stale-tier cases of each export as observation only; no policy for it is specified, corrected or declared compliant here",
  );
  it.todo(
    "COORDINATOR · MUTANTS (isolated-copy actual-import run): against this fixture, ignore the null requireTeamAdmin verdict in each of the five exports, and separately make the gate read members.tier in place of posture — the denial cases must then fail on the trace and the seam call logs, and the `external`-with-the-row case on its admission, not on a compile or fixture error",
  );
});
