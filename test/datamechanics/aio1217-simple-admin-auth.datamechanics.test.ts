import { randomBytes, randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PgClient } from "@/lib/db/pg/client";
import { getPool, runSql } from "@/lib/db/pg/pool";
import type { DbClient, SqlExecutor } from "@/lib/db/types";
import { ingest, placeMemberByTier, seedTeam, type Seed } from "./helpers";

/**
 * AIO-1217 — SEVEN SIMPLE ADMIN ACTIONS against real Postgres (AC-04, the admin-boundary half):
 * the team-admin gate of seven selected exports, executed as the actual exported functions through
 * the actual guard, the actual lower owners and the task's data-mechanics Postgres. This is the PG
 * complement of the unit-tier `test/actions/aio1217-simple-admin-auth.test.ts`: that file mocks the
 * eight lower owners and proves wiring; this one mocks none of them and proves what they cannot —
 * the rows, the ledger and the predicates Postgres was actually sent.
 *
 *   A — each export: an admitted control for two principals on two teams, then every refusal, each
 *       paired in the same test with a preceding admitted control on the same fixture.
 *   T — the target binding the lower owners own: an id held by the other team and an id nobody
 *       holds (brand asset, policy), and the policy owner's own gateway-rule refusal.
 *
 * Exports exercised, as `(repository path, export name)`:
 *   app/t/[team]/admin/brand/actions.ts     saveBrand
 *   app/t/[team]/admin/brand/actions.ts     addAsset
 *   app/t/[team]/admin/brand/actions.ts     removeAsset
 *   app/t/[team]/admin/policies/actions.ts  savePolicy   (create and owned-id update: two surfaces, one export)
 *   app/t/[team]/admin/policies/actions.ts  togglePolicy
 *   app/t/[team]/admin/policies/actions.ts  removePolicy
 *   app/t/[team]/admin/access/actions.ts    runContextBackfillAction
 *
 * What is real, and never mocked or handed a verdict: the seven exports; `requireTeamAdmin` →
 * `getSessionUser` → `verifySession` (jose HS256 against AUTH_SECRET) → `resolveIntegrationsAdmin`
 * → `resolveViewerPosture` → `canAccessAdmin`; the lower owners `saveBrandProfile`, `addBrandAsset`,
 * `removeBrandAsset`, `createPolicy`, `updatePolicy`, `setPolicyEnabled`, `deletePolicy` and
 * `backfillTeamContext` (with `ensureAccessBootstrap` and the per-item reconcile); the `audit`
 * writer; the query builder, the pg pool and Postgres. A caller is admitted only by a cookie the real
 * verifier accepts and by team, member, role and builtin-group rows the real owners read themselves.
 *
 * The synthetic seams, all of them:
 *   SEAM cookies     `next/headers` `cookies` — resolves the jar of the one request in flight. The
 *                    session in it is a real `signSession` token for a real auth_users row that a
 *                    real member row is bound to. AUTH_SECRET is synthetic per test.
 *   SEAM revalidate  `next/cache` `revalidatePath` — records the path.
 *   SEAM transport   `adminClient()` and `serverClient()` count their acquisitions and hand out, for
 *                    the duration of one request, a real `PgClient` whose SQL executor RECORDS and
 *                    then forwards to the real pool `runSql`. A recorded statement is the text the
 *                    real builder compiled, the parameters it bound and the row count Postgres really
 *                    answered. Nothing above the executor is replaced. This seam exists because an
 *                    UPDATE or DELETE that matched nothing returns the same envelope as one that
 *                    matched a row: the team and id predicates are visible only on the wire.
 *
 * THE FAULT IS SYNTHETIC. At most one fault is armed per request, for the first SELECT the server
 * client issues against a named guard table. That statement is NOT sent: the executor rejects, and
 * the real adapter turns the rejection into its own returned `{ error }` envelope (it never
 * rejects). It is not a native driver failure. Each fault case asserts the fault fired exactly once
 * and that the adapter surfaced it.
 *
 * Every request is one grouped assertion over: how the call settled; the session cookie read; the
 * guard's statements on the server client with the values bound into them and the rows answered;
 * the client acquisitions; the lower owner's statements on the service client, likewise; the fixture
 * teams bound into any service statement; the durable difference, computed from whole rowsets read
 * from the pool before and after (rows, not counts); and the revalidation trace. An admitted call
 * owes exactly its own rows, so the other team's profile, asset, policy and ledger are bystanders by
 * construction. A refusal owes no service-client acquisition, no service statement, an empty
 * difference and no revalidation — after a fresh valid target was seeded for it, so an admitted
 * call would have shown.
 *
 * Each refusal removes ONE conjunct after the control — from the request's session, from the real
 * rows, or by one armed read fault — and then reads Alice's authority rows back from the pool to
 * show which. Fixture premises fail with the `FIXTURE` prefix and are never a security observation;
 * a failed admitted control says `CONTROL`.
 *
 * Bounds of what is claimed.
 *   - Seven selected exports only: focused evidence for their registry rows, not completion of
 *     AC-04, not a census of admin actions and not the held `visibleItemIds` work. It does not
 *     address AIO-1225, AIO-1226, AIO-1227 or AIO-1228.
 *   - Direct calls of the exported functions: not Next action-wire, POST dispatch, origin,
 *     encryption or real cache-invalidation proof.
 *   - The trace sees the statements issued through the two client factories. The backfill's
 *     candidate query runs on the module-level pool executor and is not on it; its effects are read
 *     back from the pool instead. For the backfill only the bootstrap statements the source names
 *     are asserted on the wire; the reconcile transaction's statements are not enumerated.
 *   - The posture and membership reads are faulted; the `teams` read is not. A faulted membership
 *     read is pinned as the fail-closed `admins only` the owner returns today, because it discards
 *     that read's error; no error-surfacing contract is claimed for it.
 *   - T pins CURRENT BEHAVIOR for an id the acting team does not hold: the owners issue a team-bound
 *     statement that matches nothing, then report success, write the removal/update audit row under
 *     the ACTING team and revalidate. What is evidenced is isolation (the foreign row stands, the
 *     statement is bound to the acting team) and that a foreign id is indistinguishable from an
 *     absent one. The success answer and the audit row for a no-op are not a specified contract.
 *   - `runContextBackfillAction` hands its worker the team and no actor, revalidates nothing and
 *     writes no audit row of its own. The only ledger rows an admitted run adds are the bootstrap's
 *     system-attributed `access.project_granted` rows for edges it created; none is invented here.
 *   - No provider, model, graph or network path exists below these exports and none is exercised.
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

import { runContextBackfillAction } from "@/app/t/[team]/admin/access/actions";
import { addAsset, removeAsset, saveBrand } from "@/app/t/[team]/admin/brand/actions";
import { removePolicy, savePolicy, togglePolicy, type PolicyForm } from "@/app/t/[team]/admin/policies/actions";
import { SESSION_COOKIE, signSession, verifySession, type SessionUser } from "@/lib/auth/pg-session";
import type { BrandAssetInput, BrandProfileInput } from "@/lib/brand/schema";

type Row = Record<string, unknown>;
type Role = "admin" | "lead" | "member";
type Via = "admin" | "server";

/** Two teams, two sessions, a control and a refusal, and whole-rowset snapshots around each. */
const ROOMY = 30_000;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const OK = { ok: true };
const ADMINS_ONLY = { ok: false, error: "admins only" };
const GATEWAY_REFUSAL = "gateway policies must be managed from Managed gateway administration";

const FAULT_MESSAGE = "aio1217 synthetic guard read fault";

// What became of a recorded statement.
const SENT = "sent";
const ANSWERED = "answered";
const FAULTED = "injected rejection: statement not sent";
const NATIVE_ERROR = "native error:";

/** The §11 topology the bootstrap owes a team, as `(system project, builtin group)` edges. */
const SANCTIONED_EDGES = [
  { project: "external-shared", group: "everyone" },
  { project: "external-shared", group: "external" },
  { project: "general", group: "everyone" },
];

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

/** One statement as the cases compare it: what it was bound to and how many rows answered. */
interface Wire {
  op: string;
  table: string;
  where: Row;
  values: Row;
  rows: number | null;
}

interface Flight {
  jar: Map<string, string>;
  cookieReads: string[];
  statements: Statement[];
  fault: { via: Via; table: string; fired: number } | null;
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
  /** Team A's active admin holding its builtin Everyone row. */
  alice: Cast;
  /** The same in team B. */
  bob: Cast;
  teams: Map<string, string>;
}

/** A standing row a surface acts on, as the pool reads it back. */
interface Target {
  id: string;
  row: Row;
}

interface Prepared {
  /** The actual export, called with valid input for this surface. */
  invoke(teamSlug: string): Promise<unknown>;
  /** What an admitted call owes, as one grouped observation. */
  admitted(seen: Seen): unknown;
  /** Further readbacks an admitted call owes, where the grouped observation cannot carry them. */
  further?(seen: Seen): Promise<void>;
}

interface Surface {
  /** The `(repository path, export name)` this group exercises. */
  key: string;
  /** Seeds whatever valid input the call needs for `who`'s team, fresh each time it is called. */
  prepare(world: World, who: Cast): Promise<Prepared>;
}

/** A surface whose input names a row by id. */
interface Targeted extends Surface {
  table: string;
  /** A fresh standing row of this surface's kind in `team`. */
  seed(team: Seed): Promise<Target>;
  /** The call aimed at `id`; `row` is the row `who`'s team holds under that id, or null for none. */
  aim(world: World, who: Cast, id: string, row: Row | null): Prepared;
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
  "brand_profiles",
  "brand_assets",
  "policies",
  "audit_log",
  "projects",
  "project_groups",
  "items",
  "project_context_units",
  "project_context_memberships",
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
    `select m.team_id, m.role::text as role, m.status::text as status, m.auth_user_id,
            ${builtinRows("everyone")} as everyone_rows, ${builtinRows("external")} as external_rows
       from members m where m.id = $1`,
    [memberId],
  );
}

/** The four conjuncts the gate reads off a member's rows. */
const HEALTHY = { role: "admin", status: "active", everyone_rows: 1, external_rows: 0 };

async function standingOf(cast: Cast) {
  const { role, status, everyone_rows, external_rows } = await authority(cast.memberId);
  return { role, status, everyone_rows, external_rows };
}

/**
 * A distinct active member with the real builtin Everyone row, bound to a fresh auth user, and a
 * real session signed for that auth user. Nothing about the guard is stubbed to success.
 */
async function seedCast(team: Seed, label: string, role: Role): Promise<Cast> {
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
    ...HEALTHY,
    role,
  });
  const session = await signSession(user);
  premise(`${label}'s session verifies under the real verifier`, await verifySession(session), user);
  return { label, team, memberId: id, user, session };
}

async function seedAsset(team: Seed): Promise<Target> {
  const { id } = await fxOne<{ id: string }>(
    "brand asset insert",
    `insert into brand_assets(team_id, kind, label, url, notes, created_by)
     values($1, 'url', $2, 'https://example.test/aio1217', 'aio1217 seeded asset', $3) returning id`,
    [team.teamId, `AIO1217 seeded asset ${next()}`, team.memberId],
  );
  return { id, row: await rowOf("brand_assets", id) };
}

/** An enabled rule with every nullable subject column but one populated, authored by the team's owner. */
async function seedPolicy(team: Seed, action = "item.read"): Promise<Target> {
  const { id } = await fxOne<{ id: string }>(
    "policy insert",
    `insert into policies(team_id, priority, description, subject_role, subject_actor, action, resource, effect, enabled, created_by)
     values($1, 3, $2, 'member', 'aio1217-seeded-actor', $3, 'aio1217/seeded/*', 'allow', true, $4) returning id`,
    [team.teamId, `AIO1217 seeded rule ${next()}`, action, team.memberId],
  );
  return { id, row: await rowOf("policies", id) };
}

async function seedBrandProfile(team: Seed): Promise<void> {
  await fxOne(
    "brand profile insert",
    `insert into brand_profiles(team_id, voice, created_by) values($1, $2::jsonb, $3) returning team_id`,
    [team.teamId, JSON.stringify({ formality: "formal" }), team.memberId],
  );
}

/**
 * Two teams, each with one healthy admin and a signed session. Each team already holds a bystander
 * asset and policy, and team B a brand profile, so a write that lost its team or id predicate has a
 * standing row to hit.
 */
async function seedWorld(): Promise<World> {
  const a = await seedTeam();
  const b = await seedTeam();
  const alice = await seedCast(a, "alice", "admin");
  const bob = await seedCast(b, "bob", "admin");
  for (const team of [a, b]) {
    await seedAsset(team);
    await seedPolicy(team);
  }
  await seedBrandProfile(b);
  premise("the two teams are distinct", [a.teamId === b.teamId, a.teamSlug === b.teamSlug], [false, false]);
  return {
    a,
    b,
    alice,
    bob,
    teams: new Map([
      [a.teamId, "A"],
      [b.teamId, "B"],
    ]),
  };
}

const otherTeam = (world: World, team: Seed): Seed => (team.teamId === world.a.teamId ? world.b : world.a);

// ── the recording transport ──────────────────────────────────────────────────────────────────────

const EQUALITY = /([a-z_][a-z0-9_.]*) = \$(\d+)/g;

/** The `column = $n` terms of a compiled clause, with the value bound to each placeholder. */
function equalities(clause: string, params: unknown[]): Row {
  const bound: Row = {};
  for (const match of clause.matchAll(EQUALITY)) bound[match[1]] = params[Number(match[2]) - 1];
  return bound;
}

/**
 * What the real builder compiled, read off its four statement heads. Embedded resources compile to
 * lowercase subselects, so the last uppercase FROM of a SELECT is its own table and the first
 * uppercase WHERE its own clause. Raw SQL the owners issue themselves carries no table here.
 */
function compiled(text: string, params: unknown[]): Pick<Statement, "op" | "table" | "where" | "values"> {
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
 * `session` is the session cookie, or null for none. `fault` arms one guard read fault.
 */
async function request(
  session: string | null,
  action: () => Promise<unknown>,
  fault?: { via: Via; table: string },
): Promise<Seen> {
  const jar = new Map<string, string>();
  if (session !== null) jar.set(SESSION_COOKIE, session);
  const flight: Flight = { jar, cookieReads: [], statements: [], fault: fault ? { ...fault, fired: 0 } : null };
  h.revalidatePath.mockClear();
  // The real adapter logs the failure it converts; captured so the fault can be shown to surface there.
  const adapterLog = fault ? vi.spyOn(console, "error").mockImplementation(() => {}) : null;
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
    logged = adapterLog ? adapterLog.mock.calls.map((call) => String(call[0])) : [];
    adapterLog?.mockRestore();
  }
  const after = await durable();

  premise(
    "no statement the action issued was answered with a native error",
    flight.statements
      .filter((statement) => statement.outcome.startsWith(NATIVE_ERROR))
      .map((statement) => `${statement.outcome}: ${statement.text}`),
    [],
  );
  if (flight.fault) {
    premise("the armed fault fired exactly once", flight.fault.fired, 1);
    premise(
      "the real adapter surfaced the fault as its own returned error",
      logged.filter((line) => line.includes(FAULT_MESSAGE)),
      [`[pg] select ${flight.fault.table}: ${FAULT_MESSAGE}`],
    );
  }

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

/** The identifiers and discriminators a statement can be bound to; everything else is content. */
const SCOPE_COLUMNS = [
  "team_id",
  "id",
  "slug",
  "member_id",
  "auth_user_id",
  "status",
  "created_by",
  "kind",
  "enabled",
  "actor_kind",
  "action",
  "target_type",
  "target_id",
];

const scoped = (bound: Row): Row =>
  Object.fromEntries(Object.entries(bound).filter(([column]) => SCOPE_COLUMNS.includes(column)));

/** The statements one client issued, in order, each reduced to what it was bound to. */
const wireOf = (seen: Seen, via: Via): Wire[] =>
  seen.statements
    .filter((statement) => statement.via === via)
    .map(({ op, table, where, values, rowCount }) => ({
      op,
      table,
      where: scoped(where),
      values: scoped(values),
      rows: rowCount,
    }));

/** The fixture teams whose id is bound into ANY statement the service client issued. */
function teamsBound(world: World, seen: Seen): string[] {
  const labels = new Set<string>();
  for (const statement of seen.statements) {
    if (statement.via !== "admin") continue;
    for (const value of statement.params) {
      const label = typeof value === "string" ? world.teams.get(value) : undefined;
      if (label !== undefined) labels.add(label);
    }
  }
  return [...labels].sort();
}

/** One request as the cases compare it. */
const observe = (world: World, seen: Seen) => ({
  outcome: seen.outcome,
  identity: seen.cookieReads,
  guard: wireOf(seen, "server"),
  acquired: seen.acquired,
  writer: wireOf(seen, "admin"),
  teams: teamsBound(world, seen),
  changed: changes(seen.before, seen.after),
  revalidated: seen.revalidated,
});

// ── what the guard and the owners put on the wire ────────────────────────────────────────────────

// The three statements the owners issue, as read from lib/integrations/read and lib/access/posture.
const teamRead = (team: Seed): Wire => ({
  op: "select",
  table: "teams",
  where: { slug: team.teamSlug },
  values: {},
  rows: 1,
});
const memberRead = (team: Seed, user: SessionUser, rows: number | null): Wire => ({
  op: "select",
  table: "members",
  where: { team_id: team.teamId, auth_user_id: user.id, status: "active" },
  values: {},
  rows,
});
const postureRead = (team: Seed, memberId: string, rows: number | null): Wire => ({
  op: "select",
  table: "group_members",
  where: { team_id: team.teamId, member_id: memberId },
  values: {},
  rows,
});

/** The guard reads of an admitted call: the slug's team, the session's active member, their posture. */
const admittedGuard = (who: Cast): Wire[] => [
  teamRead(who.team),
  memberRead(who.team, who.user, 1),
  postureRead(who.team, who.memberId, 1),
];

/** The audit writer's insert, attributed to the server-resolved team and member. */
const auditInsert = (who: Cast, action: string, targetType: string, targetId: string): Wire => ({
  op: "insert",
  table: "audit_log",
  where: {},
  values: {
    team_id: who.team.teamId,
    actor_kind: "member",
    member_id: who.memberId,
    action,
    target_type: targetType,
    target_id: targetId,
  },
  rows: 1,
});

/** The ledger row that insert leaves, as the pool reads it back. */
const auditRow = (who: Cast, action: string, targetType: string, targetId: string, meta: Row) =>
  expect.objectContaining({
    team_id: who.team.teamId,
    actor_kind: "member",
    member_id: who.memberId,
    api_key_id: null,
    action,
    target_type: targetType,
    target_id: targetId,
    meta,
  });

const brandPath = (team: Seed) => `/t/${team.teamSlug}/admin/brand`;
const policiesPath = (team: Seed) => `/t/${team.teamSlug}/admin/policies`;

/** The id of the one row a request created in `table`, as the pool reads it back. */
const createdId = (seen: Seen, table: DurableTable): string =>
  String(changes(seen.before, seen.after)[table]?.added[0]?.id ?? "<no row was created>");

/** An admitted call by `who`: their cookie, their three guard reads, one client of each kind. */
function admittedBy(
  world: World,
  who: Cast,
  owed: { result: unknown; writer: unknown; changed: unknown; revalidated: string[] },
) {
  return {
    outcome: { returned: owed.result },
    identity: [SESSION_COOKIE],
    guard: admittedGuard(who),
    acquired: { server: 1, admin: 1 },
    writer: owed.writer,
    teams: [world.teams.get(who.team.teamId)],
    changed: owed.changed,
    revalidated: owed.revalidated,
  };
}

function targeted(surface: Omit<Targeted, "prepare">): Targeted {
  return {
    ...surface,
    prepare: async (world, who) => {
      const target = await surface.seed(who.team);
      return surface.aim(world, who, target.id, target.row);
    },
  };
}

// ── the seven exports ────────────────────────────────────────────────────────────────────────────

const SAVE_BRAND: Surface = {
  key: "app/t/[team]/admin/brand/actions.ts saveBrand",
  prepare: async (world, who) => {
    const n = next();
    const input: BrandProfileInput = {
      voice: { formality: "neutral", preferredPhrases: [`aio1217 phrase ${n}`] },
      governance: { requiredMentions: [`aio1217 mention ${n}`] },
    };
    // Team B starts with a profile, so Bob's control replaces a row where Alice's creates one.
    const standing = await fx<{ row: Row }>(
      "standing brand profile",
      `select to_jsonb(t) as row from brand_profiles t where t.team_id = $1`,
      [who.team.teamId],
    );
    return {
      invoke: (teamSlug) => saveBrand(teamSlug, input),
      admitted: () =>
        admittedBy(world, who, {
          result: OK,
          writer: [
            {
              op: "upsert",
              table: "brand_profiles",
              where: {},
              values: { team_id: who.team.teamId, created_by: who.memberId },
              rows: 1,
            },
            auditInsert(who, "brand.updated", "brand_profile", who.team.teamId),
          ],
          changed: {
            brand_profiles: {
              added: [
                expect.objectContaining({
                  team_id: who.team.teamId,
                  voice: input.voice,
                  knowledge: {},
                  governance: input.governance,
                  created_by: who.memberId,
                }),
              ],
              removed: standing.map((entry) => entry.row),
            },
            audit_log: {
              // Section keys only — never the brand values.
              added: [
                auditRow(who, "brand.updated", "brand_profile", who.team.teamId, {
                  voiceKeys: ["formality", "preferredPhrases"],
                  knowledgeKeys: [],
                  governanceKeys: ["requiredMentions"],
                }),
              ],
              removed: [],
            },
          },
          revalidated: [brandPath(who.team)],
        }),
    };
  },
};

const ADD_ASSET: Surface = {
  key: "app/t/[team]/admin/brand/actions.ts addAsset",
  prepare: async (world, who) => {
    const input: BrandAssetInput = {
      kind: "reference",
      label: `AIO1217 reference ${next()}`,
      notes: "aio1217 synthetic reference",
    };
    return {
      invoke: (teamSlug) => addAsset(teamSlug, input),
      admitted: (seen) => {
        const id = createdId(seen, "brand_assets");
        return admittedBy(world, who, {
          result: OK,
          writer: [
            {
              op: "insert",
              table: "brand_assets",
              where: {},
              values: { team_id: who.team.teamId, kind: "reference", created_by: who.memberId },
              rows: 1,
            },
            auditInsert(who, "brand.asset_added", "brand_asset", id),
          ],
          changed: {
            brand_assets: {
              added: [
                expect.objectContaining({
                  id: expect.stringMatching(UUID),
                  team_id: who.team.teamId,
                  kind: "reference",
                  label: input.label,
                  url: null,
                  notes: input.notes,
                  created_by: who.memberId,
                }),
              ],
              removed: [],
            },
            audit_log: {
              added: [auditRow(who, "brand.asset_added", "brand_asset", id, { kind: "reference", label: input.label })],
              removed: [],
            },
          },
          revalidated: [brandPath(who.team)],
        });
      },
    };
  },
};

const REMOVE_ASSET = targeted({
  key: "app/t/[team]/admin/brand/actions.ts removeAsset",
  table: "brand_assets",
  seed: seedAsset,
  aim: (world, who, id, row) => ({
    invoke: (teamSlug) => removeAsset(teamSlug, id),
    admitted: () =>
      admittedBy(world, who, {
        result: OK,
        writer: [
          {
            op: "delete",
            table: "brand_assets",
            where: { team_id: who.team.teamId, id },
            values: {},
            rows: row ? 1 : 0,
          },
          auditInsert(who, "brand.asset_removed", "brand_asset", id),
        ],
        changed: {
          ...(row ? { brand_assets: { added: [], removed: [row] } } : {}),
          audit_log: { added: [auditRow(who, "brand.asset_removed", "brand_asset", id, {})], removed: [] },
        },
        revalidated: [brandPath(who.team)],
      }),
  }),
});

const SAVE_POLICY_CREATE: Surface = {
  key: "app/t/[team]/admin/policies/actions.ts savePolicy (create: no id)",
  prepare: async (world, who) => {
    const n = next();
    const form: PolicyForm = {
      action: "code.run",
      resource: `aio1217/created/${n}`,
      effect: "require_approval",
      priority: 7,
      description: `AIO1217 created rule ${n}`,
      subjectRole: "lead",
    };
    return {
      invoke: (teamSlug) => savePolicy(teamSlug, form),
      admitted: (seen) => {
        const id = createdId(seen, "policies");
        return admittedBy(world, who, {
          result: OK,
          writer: [
            {
              op: "insert",
              table: "policies",
              where: {},
              values: { team_id: who.team.teamId, created_by: who.memberId, action: "code.run", enabled: true },
              rows: 1,
            },
            auditInsert(who, "policy.created", "policy", id),
          ],
          changed: {
            policies: {
              added: [
                expect.objectContaining({
                  id: expect.stringMatching(UUID),
                  team_id: who.team.teamId,
                  priority: 7,
                  description: form.description,
                  subject_role: "lead",
                  subject_tier: null,
                  subject_actor: null,
                  action: "code.run",
                  resource: form.resource,
                  effect: "require_approval",
                  enabled: true,
                  created_by: who.memberId,
                }),
              ],
              removed: [],
            },
            audit_log: {
              added: [
                auditRow(who, "policy.created", "policy", id, {
                  action: "code.run",
                  effect: "require_approval",
                  resource: form.resource,
                }),
              ],
              removed: [],
            },
          },
          revalidated: [policiesPath(who.team)],
        });
      },
    };
  },
};

/** The policy owner's gateway pre-check: a read of the rule's action, bound to the team and the id. */
const policyLookup = (who: Cast, id: string, row: Row | null): Wire => ({
  op: "select",
  table: "policies",
  where: { team_id: who.team.teamId, id },
  values: {},
  rows: row ? 1 : 0,
});

const SAVE_POLICY_UPDATE = targeted({
  key: "app/t/[team]/admin/policies/actions.ts savePolicy (update: owned id)",
  table: "policies",
  seed: seedPolicy,
  aim: (world, who, id, row) => {
    const n = next();
    const revision = {
      action: "code.run",
      resource: `aio1217/revised/${n}`,
      effect: "deny" as const,
      priority: 9,
      description: `AIO1217 revised rule ${n}`,
      enabled: false,
    };
    return {
      invoke: (teamSlug) => savePolicy(teamSlug, { ...revision, id }),
      admitted: () =>
        admittedBy(world, who, {
          result: OK,
          writer: [
            policyLookup(who, id, row),
            {
              op: "update",
              table: "policies",
              where: { team_id: who.team.teamId, id },
              values: { action: "code.run", enabled: false },
              rows: row ? 1 : 0,
            },
            auditInsert(who, "policy.updated", "policy", id),
          ],
          changed: {
            ...(row
              ? {
                  policies: {
                    // Every mutable field is replaced, an omitted subject is cleared; team, author
                    // and creation time are not the update's to change.
                    added: [
                      {
                        ...row,
                        priority: 9,
                        description: revision.description,
                        subject_role: null,
                        subject_tier: null,
                        subject_actor: null,
                        action: "code.run",
                        resource: revision.resource,
                        effect: "deny",
                        enabled: false,
                        updated_at: expect.any(String),
                      },
                    ],
                    removed: [row],
                  },
                }
              : {}),
            audit_log: {
              added: [auditRow(who, "policy.updated", "policy", id, { action: "code.run", effect: "deny" })],
              removed: [],
            },
          },
          revalidated: [policiesPath(who.team)],
        }),
    };
  },
});

const TOGGLE_POLICY = targeted({
  key: "app/t/[team]/admin/policies/actions.ts togglePolicy",
  table: "policies",
  seed: seedPolicy,
  aim: (world, who, id, row) => ({
    // Every seeded rule is enabled: disabling it is the visible direction.
    invoke: (teamSlug) => togglePolicy(teamSlug, id, false),
    admitted: () =>
      admittedBy(world, who, {
        result: OK,
        writer: [
          policyLookup(who, id, row),
          {
            op: "update",
            table: "policies",
            where: { team_id: who.team.teamId, id },
            values: { enabled: false },
            rows: row ? 1 : 0,
          },
          auditInsert(who, "policy.disabled", "policy", id),
        ],
        changed: {
          ...(row
            ? { policies: { added: [{ ...row, enabled: false, updated_at: expect.any(String) }], removed: [row] } }
            : {}),
          audit_log: { added: [auditRow(who, "policy.disabled", "policy", id, {})], removed: [] },
        },
        revalidated: [policiesPath(who.team)],
      }),
  }),
});

const REMOVE_POLICY = targeted({
  key: "app/t/[team]/admin/policies/actions.ts removePolicy",
  table: "policies",
  seed: seedPolicy,
  aim: (world, who, id, row) => ({
    invoke: (teamSlug) => removePolicy(teamSlug, id),
    admitted: () =>
      admittedBy(world, who, {
        result: OK,
        writer: [
          policyLookup(who, id, row),
          {
            op: "delete",
            table: "policies",
            where: { team_id: who.team.teamId, id },
            values: {},
            rows: row ? 1 : 0,
          },
          auditInsert(who, "policy.deleted", "policy", id),
        ],
        changed: {
          ...(row ? { policies: { added: [], removed: [row] } } : {}),
          audit_log: { added: [auditRow(who, "policy.deleted", "policy", id, {})], removed: [] },
        },
        revalidated: [policiesPath(who.team)],
      }),
  }),
});

// ── the backfill's substrate, read from the pool ─────────────────────────────────────────────────

const byId = (left: string, right: string): number => left.localeCompare(right);
const edgeKey = (edge: { project: string; group: string }): string => `${edge.project}/${edge.group}`;

/** The team's items that hold no context unit: what a backfill still has to partition. */
async function pendingItems(team: Seed): Promise<string[]> {
  const rows = await fx<{ id: string }>(
    "pending item readback",
    `select i.id from items i
      where i.team_id = $1
        and not exists (select 1 from project_context_units u where u.team_id = i.team_id and u.source_item_id = i.id)`,
    [team.teamId],
  );
  return rows.map((row) => row.id).sort(byId);
}

/** One team-access item through the real ingest path, left unpartitioned. */
async function seedPendingItem(team: Seed): Promise<string> {
  const n = next();
  const { id } = await ingest(team, {
    path: `aio1217/pending-${n}.md`,
    body: `aio1217 synthetic pending body ${n}`,
    access: "team",
    project: "aio1217src",
  });
  // Whatever the push hook partitioned for an already-bootstrapped team, this fixture needs it pending.
  await fx("context unit removal", `delete from project_context_units where team_id = $1 and source_item_id = $2`, [
    team.teamId,
    id,
  ]);
  premise("the seeded item holds no context unit", (await pendingItems(team)).includes(id), true);
  return id;
}

/** Where each item's active unit is currently included, by one raw join over the substrate tables. */
async function partitions(itemIds: string[]) {
  const rows = await fx<{ item_id: string; team_id: string; slug: string; kind: string; decision: string }>(
    "partition readback",
    `select u.source_item_id as item_id, p.team_id, p.slug, p.kind, m.decision
       from project_context_units u
       join project_context_memberships m
         on m.team_id = u.team_id and m.context_unit_id = u.id and m.valid_to is null
       join projects p on p.team_id = m.team_id and p.id = m.project_id
      where u.source_item_id = any($1::uuid[]) and u.unit_kind = 'item' and u.state = 'active'`,
    [itemIds],
  );
  return rows.sort((left, right) => byId(left.item_id, right.item_id));
}

const systemProjectSlugs = async (team: Seed): Promise<string[]> =>
  (
    await fx<{ slug: string }>("system project readback", `select slug from projects where team_id = $1 and kind = 'system'`, [
      team.teamId,
    ])
  ).map((row) => row.slug);

/** The grants on the team's system projects, as `(project slug, group slug)` edges. */
async function systemEdges(team: Seed) {
  const rows = await fx<{ project: string; group: string; added_by: string | null }>(
    "system edge readback",
    `select p.slug as project, g.slug as "group", pg.added_by
       from project_groups pg
       join projects p on p.team_id = pg.team_id and p.id = pg.project_id
       join groups g on g.team_id = pg.team_id and g.id = pg.group_id
      where pg.team_id = $1 and p.kind = 'system'`,
    [team.teamId],
  );
  return rows.sort((left, right) => edgeKey(left).localeCompare(edgeKey(right)));
}

/** The added ledger rows with their project and group ids resolved to the team's own slugs. */
async function grantAudit(team: Seed, rows: Row[]) {
  const slugs = async (table: string) =>
    new Map(
      (await fx<{ id: string; slug: string }>(`${table} slug readback`, `select id, slug from ${table} where team_id = $1`, [team.teamId])).map(
        (row): [string, string] => [row.id, row.slug],
      ),
    );
  const projects = await slugs("projects");
  const groups = await slugs("groups");
  return rows
    .map((row) => {
      const groupId = String((row.meta as Row | null)?.groupId);
      return {
        team_id: row.team_id,
        actor_kind: row.actor_kind,
        member_id: row.member_id,
        action: row.action,
        target_type: row.target_type,
        project: projects.get(String(row.target_id)) ?? String(row.target_id),
        group: groups.get(groupId) ?? groupId,
      };
    })
    .sort((left, right) => edgeKey(left).localeCompare(edgeKey(right)));
}

/** The tables in which a request added or removed a row belonging to `team`. */
function tablesTouchedFor(changed: Changed, team: Seed): string[] {
  const touched: string[] = [];
  for (const table of DURABLE_TABLES) {
    const rows = [...(changed[table]?.added ?? []), ...(changed[table]?.removed ?? [])];
    if (rows.some((row) => (table === "teams" ? row.id : row.team_id) === team.teamId)) touched.push(table);
  }
  return touched;
}

const RUN_BACKFILL: Surface = {
  key: "app/t/[team]/admin/access/actions.ts runContextBackfillAction",
  prepare: async (world, who) => {
    const other = otherTeam(world, who.team);
    // One pending item in each team: the acting team's is the work, the other team's must stay pending.
    await seedPendingItem(who.team);
    await seedPendingItem(other);
    const own = await pendingItems(who.team);
    const foreign = await pendingItems(other);
    const slugsBefore = await systemProjectSlugs(who.team);
    const edgesBefore = await systemEdges(who.team);
    const granted = SANCTIONED_EDGES.filter((edge) => !edgesBefore.some((standing) => edgeKey(standing) === edgeKey(edge)));
    return {
      invoke: (teamSlug) => runContextBackfillAction(teamSlug),
      admitted: () =>
        admittedBy(world, who, {
          // One drained batch: every pending item of the acting team gains a unit and a membership.
          result: { ok: true, unitsCreated: own.length, membershipsCreated: own.length, batches: 1 },
          // Asserted below: the bootstrap's statements by name, the rest by its durable effect.
          writer: expect.any(Array),
          changed: expect.any(Object),
          // The action revalidates nothing.
          revalidated: [],
        }),
      further: async (seen) => {
        const changed = changes(seen.before, seen.after);
        const writer = wireOf(seen, "admin");
        const written = writer.filter((statement) => statement.op !== "select").map((statement) => statement.table);
        expect({
          partitioned: await partitions(own),
          foreignPending: await pendingItems(other),
          edges: await systemEdges(who.team),
          foreignTouched: tablesTouchedFor(changed, other),
          audit: await grantAudit(who.team, changed.audit_log?.added ?? []),
          systemProjectInserts: writer
            .filter((statement) => statement.table === "projects" && statement.op === "insert")
            .map((statement) => statement.values),
          grantUpserts: writer
            .filter((statement) => statement.table === "project_groups" && statement.op === "upsert")
            .map((statement) => statement.values),
          written,
        }).toEqual({
          // §11: a team item is included in the acting team's own General, and only there.
          partitioned: own.map((id) => ({
            item_id: id,
            team_id: who.team.teamId,
            slug: "general",
            kind: "system",
            decision: "include",
          })),
          foreignPending: foreign,
          edges: SANCTIONED_EDGES.map((edge) => ({ ...edge, added_by: null })),
          foreignTouched: [],
          // The only ledger rows a run adds: the bootstrap's own, attributed to the system, for
          // the edges it created. The action passes no actor and audits nothing itself.
          audit: granted.map((edge) => ({
            team_id: who.team.teamId,
            actor_kind: "system",
            member_id: null,
            action: "access.project_granted",
            target_type: "access",
            ...edge,
          })),
          systemProjectInserts: ["general", "external-shared"]
            .filter((slug) => !slugsBefore.includes(slug))
            .map((slug) => ({ team_id: who.team.teamId, slug, kind: "system" })),
          grantUpserts: granted.map(() => ({ team_id: who.team.teamId })),
          written: expect.arrayContaining(granted.length > 0 ? ["projects", "project_groups", "audit_log"] : []),
        });
      },
    };
  },
};

const SURFACES: Surface[] = [
  SAVE_BRAND,
  ADD_ASSET,
  REMOVE_ASSET,
  SAVE_POLICY_CREATE,
  SAVE_POLICY_UPDATE,
  TOGGLE_POLICY,
  REMOVE_POLICY,
  RUN_BACKFILL,
];

/** Seed valid input for `who`, run the actual export under their session and hold it to what it owes. */
async function admit(surface: Surface, world: World, who: Cast, label: string): Promise<void> {
  const prepared = await surface.prepare(world, who);
  const seen = await request(who.session, () => prepared.invoke(who.team.teamSlug));
  expect(observe(world, seen), label).toEqual(prepared.admitted(seen));
  await prepared.further?.(seen);
}

// ── refusals ─────────────────────────────────────────────────────────────────────────────────────

interface Refusal {
  name: string;
  /** Removes one conjunct after the admitted control; returns the refused request's session cookie. */
  arrange(world: World): Promise<string | null>;
  fault?: { via: Via; table: string };
  /** The guard reads the owners issue before refusing, in order. */
  guard(world: World): Wire[];
  outcome: Settled;
  /** What Alice's rows say afterwards: which conjunct the case removed. */
  standing: typeof HEALTHY;
}

const REFUSED: Settled = { returned: ADMINS_ONLY };

async function setMembership(cast: Cast, column: "role" | "status", value: string): Promise<void> {
  await fxOne(
    `membership ${column} change`,
    `update members set ${column} = $1 where id = $2 and team_id = $3 returning id`,
    [value, cast.memberId, cast.team.teamId],
  );
}

/** Alice's claims, really signed — under a secret this request's verifier does not hold. */
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

const REFUSALS: Refusal[] = [
  {
    name: "no session cookie, with the team, membership, role and Everyone row all standing",
    arrange: async () => null,
    guard: () => [],
    outcome: REFUSED,
    standing: HEALTHY,
  },
  {
    name: "a session cookie carrying Alice's claims signed under another secret",
    arrange: (world) => sessionUnderAnotherSecret(world.alice.user),
    guard: () => [],
    outcome: REFUSED,
    standing: HEALTHY,
  },
  {
    name: "a disabled same-team admin membership, the Everyone row still standing",
    arrange: async (world) => {
      await setMembership(world.alice, "status", "disabled");
      return world.alice.session;
    },
    guard: (world) => [teamRead(world.a), memberRead(world.a, world.alice.user, 0)],
    outcome: REFUSED,
    standing: { ...HEALTHY, status: "disabled" },
  },
  {
    name: "a healthy admin of the other team (Bob) calling this team's slug",
    arrange: async (world) => world.bob.session,
    guard: (world) => [teamRead(world.a), memberRead(world.a, world.bob.user, 0)],
    outcome: REFUSED,
    standing: HEALTHY,
  },
  {
    name: "an active lead holding the team's builtin Everyone row",
    arrange: async (world) => {
      await setMembership(world.alice, "role", "lead");
      return world.alice.session;
    },
    guard: (world) => admittedGuard(world.alice),
    outcome: REFUSED,
    standing: { ...HEALTHY, role: "lead" },
  },
  {
    name: "an active member holding the team's builtin Everyone row",
    arrange: async (world) => {
      await setMembership(world.alice, "role", "member");
      return world.alice.session;
    },
    guard: (world) => admittedGuard(world.alice),
    outcome: REFUSED,
    standing: { ...HEALTHY, role: "member" },
  },
  {
    name: "an active admin holding only the team's builtin External row (posture denial)",
    arrange: async (world) => {
      await fxOne(
        "everyone row removal",
        `delete from group_members gm using groups g
          where g.team_id = gm.team_id and g.id = gm.group_id and g.slug = 'everyone' and g.is_builtin
            and gm.team_id = $1 and gm.member_id = $2
          returning gm.member_id`,
        [world.a.teamId, world.alice.memberId],
      );
      await placeMemberByTier(world.a.teamId, world.alice.memberId, "external");
      return world.alice.session;
    },
    guard: (world) => admittedGuard(world.alice),
    outcome: REFUSED,
    standing: { ...HEALTHY, everyone_rows: 0, external_rows: 1 },
  },
  {
    // The owner discards this read's error and treats the caller as no member: fail closed.
    name: "a faulted membership read (synthetic), every row standing",
    arrange: async (world) => world.alice.session,
    fault: { via: "server", table: "members" },
    guard: (world) => [teamRead(world.a), memberRead(world.a, world.alice.user, null)],
    outcome: REFUSED,
    standing: HEALTHY,
  },
  {
    // The posture owner throws on its read error and nothing catches it: the export rejects.
    name: "a faulted posture read (synthetic) after the session, team and active admin membership are admitted",
    arrange: async (world) => world.alice.session,
    fault: { via: "server", table: "group_members" },
    guard: (world) => [
      teamRead(world.a),
      memberRead(world.a, world.alice.user, 1),
      postureRead(world.a, world.alice.memberId, null),
    ],
    outcome: { rejected: { error: true, message: `posture read failed: ${FAULT_MESSAGE}` } },
    standing: HEALTHY,
  },
];

describe.each(SURFACES)("A — $key (team-admin gated, real Postgres)", (surface) => {
  it(
    "admitted: Alice's signed session reaches team A as Alice and Bob's reaches team B as Bob — each call's statements bind only its own server-resolved team and member, and its durable rows and ledger entry are the whole difference",
    async () => {
      const world = await seedWorld();

      await admit(surface, world, world.alice, "Alice on team A");
      // Only the session and the slug differ: nothing of team A's is bound, written or audited.
      await admit(surface, world, world.bob, "Bob on team B");
    },
    ROOMY,
  );

  it.each(REFUSALS)(
    "refused: $name — after an admitted control on the same fixture, only the guard's own reads run: no service client, no statement, no row, no ledger entry, no revalidation",
    async (refusal) => {
      const world = await seedWorld();
      await admit(surface, world, world.alice, CONTROL);

      // A fresh valid target of team A's: had the gate admitted the call, it would show.
      const prepared = await surface.prepare(world, world.alice);
      const session = await refusal.arrange(world);
      const guard = refusal.guard(world);

      const refused = await request(session, () => prepared.invoke(world.a.teamSlug), refusal.fault);

      expect({ ...observe(world, refused), standing: await standingOf(world.alice) }).toEqual({
        outcome: refusal.outcome,
        identity: [SESSION_COOKIE],
        guard,
        // Without an identity not even the server client is acquired; the service client never is.
        acquired: { server: guard.length > 0 ? 1 : 0, admin: 0 },
        writer: [],
        teams: [],
        changed: {},
        revalidated: [],
        standing: refusal.standing,
      });
    },
    ROOMY,
  );
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// T — the target binding the lower owners own
// ─────────────────────────────────────────────────────────────────────────────────────────────────

const TARGETED: Targeted[] = [REMOVE_ASSET, SAVE_POLICY_UPDATE, TOGGLE_POLICY, REMOVE_POLICY];
const POLICY_TARGETED: Targeted[] = [SAVE_POLICY_UPDATE, TOGGLE_POLICY, REMOVE_POLICY];

describe("T — the id an admitted admin supplies is bound to their own team by the lower owner (real Postgres)", () => {
  it.each(TARGETED)(
    "$key · an id the other team holds, and an id nobody holds, reach only a statement bound to the acting team that matches no row — the foreign row stands and the two are indistinguishable (the success answer and audit row are current behavior, not a specified contract)",
    async (surface) => {
      const world = await seedWorld();
      await admit(surface, world, world.alice, CONTROL);

      const foreign = await surface.seed(world.b);
      for (const [label, id] of [
        ["an id team B holds", foreign.id],
        ["an id nobody holds", randomUUID()],
      ] as const) {
        const aimed = surface.aim(world, world.alice, id, null);
        const seen = await request(world.alice.session, () => aimed.invoke(world.a.teamSlug));
        expect(observe(world, seen), label).toEqual(aimed.admitted(seen));
      }

      expect(await rowOf(surface.table, foreign.id)).toEqual(foreign.row);
    },
    ROOMY,
  );

  it.each(POLICY_TARGETED)(
    "$key · an owned gateway.* rule is refused by the policy owner after its team-bound lookup — no write, no ledger entry, no revalidation, the rule stands",
    async (surface) => {
      const world = await seedWorld();
      await admit(surface, world, world.alice, CONTROL);

      const gateway = await seedPolicy(world.a, "gateway.execute");
      const aimed = surface.aim(world, world.alice, gateway.id, gateway.row);
      const refused = await request(world.alice.session, () => aimed.invoke(world.a.teamSlug));

      expect(observe(world, refused)).toEqual({
        outcome: { returned: { ok: false, error: GATEWAY_REFUSAL } },
        identity: [SESSION_COOKIE],
        guard: admittedGuard(world.alice),
        acquired: { server: 1, admin: 1 },
        writer: [policyLookup(world.alice, gateway.id, gateway.row)],
        teams: ["A"],
        changed: {},
        revalidated: [],
      });
    },
    ROOMY,
  );

  it(
    "app/t/[team]/admin/policies/actions.ts savePolicy (create) · a gateway.* action is refused by the policy owner's validation before any statement — no rule, no ledger entry, no revalidation",
    async () => {
      const world = await seedWorld();
      await admit(SAVE_POLICY_CREATE, world, world.alice, CONTROL);

      const refused = await request(world.alice.session, () =>
        savePolicy(world.a.teamSlug, { action: "gateway.execute", effect: "allow" }),
      );

      expect(observe(world, refused)).toEqual({
        outcome: { returned: { ok: false, error: GATEWAY_REFUSAL } },
        identity: [SESSION_COOKIE],
        guard: admittedGuard(world.alice),
        // The service client is acquired as the owner's argument, then never used.
        acquired: { server: 1, admin: 1 },
        writer: [],
        teams: [],
        changed: {},
        revalidated: [],
      });
    },
    ROOMY,
  );
});
