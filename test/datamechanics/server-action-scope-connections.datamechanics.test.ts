import { randomBytes, randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PgClient } from "@/lib/db/pg/client";
import { getPool, runSql } from "@/lib/db/pg/pool";
import type { DbClient, SqlExecutor } from "@/lib/db/types";
import { db, ingest, placeMemberByTier, seedTeam, type Seed } from "./helpers";

/**
 * AIO-1217 — Server Action SCOPE CONNECTIONS against real Postgres (AC-04, the scope-connection
 * half): the first TWO of the fifteen finite connections, and for scope confinement only those two.
 * Section C adds one lookup-error case at the chain gate the Social exports share; it is not that
 * gate's connection evidence.
 *
 *   S — app/actions/meeting-todos.ts scanMeetingTodosAction
 *         visibleItemIds(team.id, auth.memberId) → scanMeetingTodosForTeam options.visibleItemIds
 *   D — app/t/[team]/social/actions.ts discoverNow
 *         visibleItemIds(ctx.teamId, ctx.memberId) → discoverOpportunities options.visibleItemIds
 *         plus actor.memberId
 *
 * Every assertion is derived from the accepted specification's "Finite scope connections and
 * refusal boundaries", not from the implementation: a registered resolver call and its error branch
 * do not prove that the returned scope constrains downstream work, so each case executes the actual
 * export with its preceding authority admitted and observes what the REAL consumer was bounded to —
 * which rows it loaded, what it returned and what it durably wrote. For each connection:
 *
 *   1  partial scope   the signed-in principal's own set is the consumer's only source: the shared
 *                      item is served, the restricted and the foreign-team item are never loaded;
 *                      the grantee's session on the same fixture reaches the restricted item too.
 *   2  empty scope     an admitted principal who keeps a project grant but holds no item membership
 *                      gets a successful empty answer while the same team holds content its grantee
 *                      can reach.
 *   3  resolver error  a failed read on EACH of the resolver's four legs (`members`,
 *                      `group_members`, `project_groups`, `project_context_memberships`) refuses with
 *                      the exact visibility refusal: the fault lands on the resolver's own read after
 *                      the guard admitted the principal, it is the LAST statement the action issues,
 *                      and the consumer is never entered. Eight cases: two exports × four legs.
 *   4  no project      an admitted principal the oracle resolves to NO project, with no read error,
 *                      gets a successful empty answer: the resolver ends before its grant and
 *                      item-membership reads and the consumer still runs. Emptiness is not refusal.
 *   5  wrong principal another team's principal, this team's principal against the other team, a
 *                      same-team non-admin (D) and no session at all are refused before the
 *                      resolver; the foreign team's own principal reaches only its own item.
 *
 * What is real: the two exports; `currentMember` / `requireTeamAdmin` → `resolveIntegrationsAdmin`
 * → `canAccessAdmin`; `getSessionUser` and `verifySession` (jose HS256 against AUTH_SECRET); the
 * posture resolver; the PRODUCER `visibleItemIds` → `visibleProjectsWithError` →
 * `visibleItemIdsForProjects` over real group, grant, context-unit and membership rows; the
 * CONSUMERS `scanMeetingTodosForTeam` (with its real todo extraction) and `discoverOpportunities` →
 * `createOpportunity` → the evidence-tier check; the query builder, the pg pool and the task's
 * data-mechanics Postgres. No resolver, consumer, guard, predicate or verdict is stubbed, and no
 * boolean stands in for a scope. Discovery is deterministic scoring: there is no model call on this
 * path and none is claimed.
 *
 * The synthetic seams, all of them:
 *   SEAM cookies     `next/headers` `cookies` — resolves the jar of the one request in flight. The
 *                    session in it is a real `signSession` token for a real auth_users row that a
 *                    real active member row is bound to. AUTH_SECRET is synthetic per test.
 *   SEAM revalidate  `next/cache` `revalidatePath` — records the path.
 *   SEAM transport   `adminClient()` and `serverClient()` hand out, for the duration of one
 *                    request, a real `PgClient` whose SQL executor RECORDS and then forwards to the
 *                    real pool `runSql`. Both clients share one trace. A recorded statement is the
 *                    text the real builder compiled, the parameters it bound and the rows Postgres
 *                    really answered. Nothing above the executor is replaced: the boundary that
 *                    stays real is everything from the exported action down to the compiled
 *                    statement, and Postgres itself. This seam exists because the bodies a consumer
 *                    LOADS are not visible in an action's return value — a scan that read a
 *                    restricted transcript and then dropped it would return the same candidates.
 *   SEAM consumer    `scanMeetingTodosForTeam` and `discoverOpportunities` are entered through a
 *                    recorder that notes the call — its team, the scope option it was handed and
 *                    its actor — and then runs the REAL function with the same arguments. It is a
 *                    call boundary, not a stub: without it "the consumer was never entered" is only
 *                    inferred from the statements a consumer happens to issue.
 *
 * THE FAULT IS SYNTHETIC. At most one fault is armed per request, for the first SELECT a named
 * client issues against a named table. That statement is NOT sent: the executor rejects, and the
 * real adapter turns the rejection into its own returned `{ error }` envelope (it never rejects).
 * It is not a native driver failure. Each fault case asserts the fault fired exactly once and that
 * the adapter surfaced it. Every fault is armed on the SERVICE client. The guards read through the
 * server client only, so a fault there cannot land on an authentication read, and each case shows
 * where it did land: the guard issued the statements it issues in the paired admitted request and
 * its own `members` read answered with the actor's row; the service client's statements are the
 * resolver's earlier legs, answered in order, and then the one that was not sent.
 *
 * Expected truth is the fixture's, not the producer's. Each world states who holds a current
 * membership path to each item, and that statement is checked once, as a premise, against one raw
 * SQL join over the substrate tables — never against `visibleItemIds`. Ids are compared as fixture
 * labels (`shared`, `restricted`, `foreign`; `actor`, `grantee`, `teammate`, `grantless`,
 * `foreigner`; `A`, `B`) and content as sentinel tokens, one per item, that appear in its path and
 * body (and title, D).
 *
 * Every request is one grouped assertion over: the result; the two call boundaries (the resolver's
 * reads in order with what became of each, and every entry into the consumer with the scope option
 * and actor it was handed); the wire observations (the consumer's body-bearing `items` statements
 * with the team, the exact item-id set bound into them and the items whose bodies came back; every
 * fixture item, member and team id bound into ANY statement; every sentinel in ANY returned row;
 * every non-SELECT statement); the durable rowsets, read from the pool before and after; and the
 * revalidation trace. A wrong return value cannot hide a private
 * load or a write, and a right one cannot excuse it. Fixture premises fail with the `FIXTURE`
 * prefix and are never a security observation; a failed admitted control says `CONTROL`.
 *
 * Which observation each applicable source mutant is built to break (stated by construction — this
 * file executes no mutant):
 *   S option omitted / widened ids      case 1 `consumers`, `loaded` and candidates; case 2 `loaded`
 *   S empty set treated as absent       case 2 `loaded` (the team's content the grantee reaches)
 *   D option omitted (fail-closed)      case 1 admitted control: nothing is scanned or minted
 *   D widened ids                       case 1 `consumers`, `loaded`, the minted rows and sentinels
 *   wrong-principal resolution, S or D  case 1 `principals`, and the actor/grantee difference in
 *                                       both directions on one fixture
 *   D actor substituted at the writer   case 1 `createdBy`
 *   error branch dropped, S or D        case 3 result, `consumers` and `afterFault`, all four legs
 *   oracle error discarded before the   case 3 on the three oracle legs: result, `consumers`,
 *   materializer's result               `afterFault` and, for D, the revalidation trace
 *   empty project set made an error     case 4 result and `consumers`; case 2 likewise
 *
 * Bounds of what is claimed.
 *   - Two connections of fifteen. The other thirteen, the remaining action rows, their independent
 *     role/posture/content denial conjuncts and the registry's evidence rows are not touched here.
 *   - Direct calls of the exported functions: not Next action-wire, origin or encryption proof.
 *   - The trace sees the statements issued through the two client factories. At the authoring
 *     commit the guard, posture, oracle, resolver, scanner, discovery and store modules on these
 *     two paths issue no statement any other way; that is a source reading, not a tested property.
 *     Durable effects do not depend on it: they are read back from the pool.
 *   - "The resolver's reads" are the service-client statements issued before the consumer was
 *     entered. That the guards use the server client only, and that nothing but the resolver uses
 *     the service client before the consumer on these paths, is likewise a source reading.
 *   - Case 3 is the specification's lookup-error refusal row for these two exports, on all four
 *     legs. The three oracle legs (`members`, `group_members`, `project_groups`) refuse only because
 *     `visibleItemIds` now carries the error-aware oracle's flag; while the materializer read the
 *     flag-discarding `visibleProjects` wrapper they collapsed into case 4's empty set and the
 *     consumer ran. The `project_context_memberships` leg was flagged, and refused, before that too.
 *   - Case 4's principal is an active agent holding only a planted builtin Everyone row: posture for
 *     the guards, grant-inert at the oracle, which therefore ends at "no accepted group". That is
 *     one no-error zero-project path; a principal whose groups hold no grant at all is not run.
 *   - Section C runs ONE oracle leg through ONE chain-gated export (`planNow`): the gate's refusal
 *     text and zero effects on a resolver error. The gate's six other exports, its scope
 *     confinement and the second draft scope of `generateDrafts` are not exercised.
 *   - Membership is read per request: no revocation or linearizability claim is made.
 *   - `createMeetingTodosAction` and the deferred AIO-1225 boundary are not exercised.
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
  /** SEAM consumer: when set, told each time the action enters one of the two real consumers. */
  enterConsumer: null as
    | ((consumer: "scan" | "discover", teamId: string, scope: Iterable<string> | undefined, actorId: string | null) => void)
    | null,
}));

vi.mock("next/headers", () => ({ cookies: h.cookies }));
vi.mock("next/cache", () => ({ revalidatePath: h.revalidatePath }));
// The real service client unless a request is in flight.
vi.mock("@/lib/db/admin", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/db/admin")>();
  return { ...original, adminClient: () => h.adminDb ?? original.adminClient() };
});
// The real server client unless a request is in flight.
vi.mock("@/lib/db/server", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/db/server")>();
  return { ...original, serverClient: async () => h.serverDb ?? original.serverClient() };
});
// The real scanner, entered through a recorder.
vi.mock("@/lib/meetings/extract-todos", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/meetings/extract-todos")>();
  const scanMeetingTodosForTeam: typeof original.scanMeetingTodosForTeam = (client, teamId, opts) => {
    h.enterConsumer?.("scan", teamId, opts?.visibleItemIds, null);
    return original.scanMeetingTodosForTeam(client, teamId, opts);
  };
  return { ...original, scanMeetingTodosForTeam };
});
// The real discovery, entered through a recorder.
vi.mock("@/lib/social/discover", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/social/discover")>();
  const discoverOpportunities: typeof original.discoverOpportunities = (client, teamId, opts) => {
    h.enterConsumer?.("discover", teamId, opts?.visibleItemIds, opts?.actor?.memberId ?? null);
    return original.discoverOpportunities(client, teamId, opts);
  };
  return { ...original, discoverOpportunities };
});

import { scanMeetingTodosAction } from "@/app/actions/meeting-todos";
import { discoverNow, planNow } from "@/app/t/[team]/social/actions";
import { addMemberToGroup, createGroup, grantProjectToGroup } from "@/lib/access/groups";
import { SESSION_COOKIE, signSession } from "@/lib/auth/pg-session";
import { backfillTeamContext } from "@/lib/projects/context/backfill";

type Row = Record<string, unknown>;
type Family = "scan" | "discover";
type Role = "admin" | "member";
type Kind = "human" | "agent";
type ItemLabel = "shared" | "restricted" | "foreign";
type TeamLabel = "A" | "B";
type Via = "admin" | "server";
type ScanResult = Awaited<ReturnType<typeof scanMeetingTodosAction>>;
type DiscoverResult = Awaited<ReturnType<typeof discoverNow>>;

/** Two teams, four sessions, three ingests and whole-rowset snapshots around every request. */
const ROOMY = 30_000;

/** One sentinel per item: lowercase alphanumerics only, so no path or title derivation rewrites it. */
const TOKENS = {
  scan: { shared: "aio1217scanshared", restricted: "aio1217scanrestricted", foreign: "aio1217scanforeign" },
  discover: { shared: "aio1217discshared", restricted: "aio1217discrestricted", foreign: "aio1217discforeign" },
} as const;
const ALL_TOKENS: string[] = [...Object.values(TOKENS.scan), ...Object.values(TOKENS.discover)];

/** Long enough that discovery does not skip the item as trivial; one line, single-spaced. */
const DISCOVERABLE_FILLER =
  "This synthetic deliverable exists only so the deterministic discovery scorer has enough substance to mint an opportunity from it.";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const VISIBILITY_FAILED = { ok: false, error: "visibility resolution failed" };
const NOT_A_MEMBER = { ok: false, error: "not a member of this team" };
const ADMINS_ONLY = { ok: false, error: "admins only" };

/** The resolver's four reads in the order it issues them: the oracle's three, then the materializer's. */
const RESOLVER_LEGS = ["members", "group_members", "project_groups", "project_context_memberships"] as const;

const FAULT_MESSAGE = "aio1217 synthetic resolver read fault";

// What became of a recorded statement.
const SENT = "sent";
const ANSWERED = "answered";
const FAULTED = "injected rejection: statement not sent";
const NATIVE_ERROR = "native error:";
const UNCLASSIFIED = "unclassified";

// What became of the resolver's reads, as `boundaries` reports them.
const answered = (tables: readonly string[]): string[] => tables.map((table) => `select ${table}: ${ANSWERED}`);
/** A resolution that ran to its end: all four reads answered. */
const RESOLVED = answered(RESOLVER_LEGS);
/** A resolution the oracle ended at "no accepted group": no grant read and no item-membership read. */
const NO_ACCEPTED_GROUP = answered(RESOLVER_LEGS.slice(0, 2));
/** A resolution stopped at `leg`: the reads before it answered, and it was not sent. */
const stoppedAt = (leg: string): string[] => [
  ...answered(RESOLVER_LEGS.slice(0, (RESOLVER_LEGS as readonly string[]).indexOf(leg))),
  `select ${leg}: ${FAULTED}`,
];

/** What `boundaries` reports as the scope of a consumer entered without its scope option. */
const OMITTED = "option omitted";

interface Statement {
  via: Via;
  op: string;
  table: string;
  /** The text the real builder compiled. */
  text: string;
  /** The parameters it bound. */
  params: unknown[];
  /** The rows Postgres really answered; empty until it does. */
  rows: Row[];
  outcome: string;
}

/** One entry into a consumer, as its recorder saw it. */
interface ConsumerCall {
  consumer: Family;
  /** How many statements the action had issued when the consumer was entered. */
  at: number;
  teamId: string;
  /** The scope option it was handed; null when the option was absent. */
  scope: string[] | null;
  actorId: string | null;
}

interface Flight {
  jar: Map<string, string>;
  statements: Statement[];
  consumers: ConsumerCall[];
  fault: { via: Via; table: string; fired: number; at: number } | null;
}

interface Seen<T> {
  result: T;
  before: Durable;
  after: Durable;
  statements: Statement[];
  consumers: ConsumerCall[];
  /** What the action issued after the faulted statement; empty when no fault was armed. */
  afterFault: string[];
  revalidated: unknown[];
}

interface Cast {
  label: string;
  memberId: string;
  /** `signSession` for the auth user this member row is bound to, under this test's AUTH_SECRET. */
  session: string;
}

interface Item {
  id: string;
  label: ItemLabel;
}

interface World {
  a: Seed;
  b: Seed;
  /** Team A, Everyone only: the principal whose scope the cases confine. */
  actor: Cast;
  /** Team A, Everyone plus the restricted group. */
  grantee: Cast;
  /** Team A, Everyone only, always an ordinary member. */
  teammate: Cast;
  /** Team A, an active agent holding only a planted Everyone row: admitted, and granted nothing. */
  grantless: Cast;
  /** Team B, Everyone only. */
  foreigner: Cast;
  shared: Item;
  restricted: Item;
  foreign: Item;
  items: Map<string, string>;
  members: Map<string, string>;
  teams: Map<string, string>;
  known: Set<string>;
}

let authSecret = "";
/** The one request in flight; null between requests. */
let inFlight: Flight | null = null;

beforeEach(() => {
  authSecret = randomBytes(32).toString("hex");
  vi.stubEnv("AUTH_SECRET", authSecret);
  inFlight = null;
  h.adminDb = null;
  h.serverDb = null;
  h.enterConsumer = null;
  h.revalidatePath.mockReset();
  h.cookies.mockReset();
  h.cookies.mockImplementation(async () => {
    // Bound to the request in flight when `cookies()` was called.
    const flight = inFlight;
    if (!flight) throw new Error(`${FIXTURE} cookies() called with no request in flight`);
    return {
      get: (name: string) => {
        const value = flight.jar.get(name);
        return value === undefined ? undefined : { name, value };
      },
    };
  });
});

afterEach(() => {
  h.adminDb = null;
  h.serverDb = null;
  h.enterConsumer = null;
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

/** The fixture labels of the ids in `values`, each once, sorted. Unknown values carry no label. */
function pick(names: ReadonlyMap<string, string>, values: readonly unknown[]): string[] {
  const labels = new Set<string>();
  for (const value of values) {
    const label = typeof value === "string" ? names.get(value) : undefined;
    if (label !== undefined) labels.add(label);
  }
  return [...labels].sort();
}

/** Which item sentinels occur anywhere in `value`, sorted. */
function tokensIn(value: unknown): string[] {
  const text = JSON.stringify(value) ?? "";
  return ALL_TOKENS.filter((token) => text.includes(token)).sort();
}

const DURABLE_TABLES = ["projects", "tasks", "social_opportunities", "content_plans", "audit_log"] as const;
type Durable = Record<(typeof DURABLE_TABLES)[number], Row[]>;

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

const withoutOpportunities = (snapshot: Durable): Omit<Durable, "social_opportunities"> => ({
  projects: snapshot.projects,
  tasks: snapshot.tasks,
  content_plans: snapshot.content_plans,
  audit_log: snapshot.audit_log,
});

async function authority(memberId: string) {
  const builtinRows = (slug: string) =>
    `(select count(*)::int from group_members gm
        join groups g on g.team_id = gm.team_id and g.id = gm.group_id
       where gm.team_id = m.team_id and gm.member_id = m.id and g.slug = '${slug}' and g.is_builtin)`;
  return fxOne(
    "authority readback",
    `select m.team_id, m.role::text as role, m.kind, m.status::text as status, m.auth_user_id,
            ${builtinRows("everyone")} as everyone_rows, ${builtinRows("external")} as external_rows,
            (select count(*)::int from group_members gm
               join groups g on g.team_id = gm.team_id and g.id = gm.group_id
              where gm.team_id = m.team_id and gm.member_id = m.id and not g.is_builtin) as other_group_rows
       from members m where m.id = $1`,
    [memberId],
  );
}

/**
 * A distinct active member with the real builtin Everyone row, bound to a fresh auth user, and a
 * real session signed for that auth user. Nothing about any guard is stubbed to success. For an
 * `agent` the Everyone row is a planted one — the groups writer never admits a non-human to a
 * builtin — and is posture only: the oracle accepts a builtin row from an active human alone.
 */
async function seedCast(team: Seed, label: string, role: Role, kind: Kind = "human"): Promise<Cast> {
  const user = { id: randomUUID(), email: `${label}-${randomUUID().slice(0, 8)}@aio1217.fixture.test` };
  await fxOne("auth user insert", `insert into auth_users(id, email) values($1, $2) returning id`, [user.id, user.email]);
  const { id } = await fxOne<{ id: string }>(
    "member insert",
    `insert into members(team_id, email, display_name, actor_handle, role, kind, tier, status, auth_user_id)
     values($1, $2, $3, $4, $5, $6, 'team', 'active', $7) returning id`,
    [team.teamId, user.email, `AIO1217 ${label}`, `${label}-${randomUUID().slice(0, 8)}`, role, kind, user.id],
  );
  await placeMemberByTier(team.teamId, id, "team");
  premise(`${label}'s authority`, await authority(id), {
    team_id: team.teamId,
    role,
    kind,
    status: "active",
    auth_user_id: user.id,
    everyone_rows: 1,
    external_rows: 0,
    other_group_rows: 0,
  });
  return { label, memberId: id, session: await signSession(user) };
}

/** What each family's consumer reads: a transcript carrying one open todo, or a titled deliverable. */
function sourceOf(family: Family, token: string) {
  return family === "scan"
    ? ({
        kind: "transcript",
        path: `meetings/${token}.md`,
        body: `AIO1217 synthetic meeting notes\n- [ ] ${token} follow up on the synthetic agenda`,
        frontmatter: {},
      } as const)
    : ({
        kind: "deliverable",
        path: `notes/${token}.md`,
        body: `${token} body. ${DISCOVERABLE_FILLER}`,
        frontmatter: { title: `${token} title` },
      } as const);
}

/** One team-access item through the real ingest path, read back as stored. */
async function ingestSource(team: Seed, family: Family, label: ItemLabel): Promise<Item> {
  const source = sourceOf(family, TOKENS[family][label]);
  const { id } = await ingest(team, { ...source, access: "team", project: `aio1217${family}` });
  premise(
    `the ${label} item is stored as supplied`,
    await fx(
      "item readback",
      `select team_id, path, kind::text as kind, access::text as access, body from items where id = $1`,
      [id],
    ),
    [{ team_id: team.teamId, path: source.path, kind: source.kind, access: "team", body: source.body }],
  );
  return { id, label };
}

/**
 * Move `items` out of their current memberships into one fresh initiative that only `grantee`'s
 * group is granted: the restriction shape the ENFB fixtures use, through the real group writers.
 */
async function restrictTo(team: Seed, grantee: Cast, items: Item[]): Promise<void> {
  const { id: projectId } = await fxOne<{ id: string }>(
    "initiative insert",
    `insert into projects(team_id, slug, name, kind) values($1, $2, 'AIO1217 restricted initiative', 'initiative') returning id`,
    [team.teamId, `r-${randomUUID().slice(0, 8)}`],
  );
  const group = await createGroup(db(), team.teamId, `rg-${randomUUID().slice(0, 8)}`, "AIO1217 restricted group", team.memberId);
  if (!group.ok || !group.groupId) throw new Error(`${FIXTURE} restricted group: ${group.error}`);
  const grant = await grantProjectToGroup(db(), team.teamId, projectId, group.groupId, team.memberId);
  if (!grant.ok) throw new Error(`${FIXTURE} restricted grant: ${grant.error}`);
  const joined = await addMemberToGroup(db(), team.teamId, group.groupId, grantee.memberId, team.memberId);
  if (!joined.ok) throw new Error(`${FIXTURE} restricted group membership: ${joined.error}`);
  for (const item of items) {
    const unit = await fxOne<{ id: string }>(
      "context unit lookup",
      `select id from project_context_units where team_id = $1 and source_item_id = $2 and unit_kind = 'item'`,
      [team.teamId, item.id],
    );
    await fx(
      "membership expiry",
      `update project_context_memberships set valid_to = now()
        where team_id = $1 and context_unit_id = $2 and valid_to is null`,
      [team.teamId, unit.id],
    );
    await fxOne(
      "restricted membership insert",
      `insert into project_context_memberships(team_id, project_id, context_unit_id, method)
       values($1, $2, $3, 'manual') returning id`,
      [team.teamId, projectId, unit.id],
    );
  }
}

/**
 * Who holds a current membership path to each item, by one raw join over the substrate tables:
 * active item-grain unit, current include membership, project grant, group membership. It reads no
 * application resolver, so the premise it backs is independent of the producer under test.
 */
async function reach(world: Pick<World, "items" | "members">, cast: Cast[]): Promise<Record<string, string[]>> {
  const rows = await fx<{ item_id: string; member_id: string }>(
    "reach readback",
    `select distinct i.id as item_id, gm.member_id
       from items i
       join project_context_units u
         on u.team_id = i.team_id and u.source_item_id = i.id and u.unit_kind = 'item' and u.state = 'active'
       join project_context_memberships m
         on m.team_id = u.team_id and m.context_unit_id = u.id and m.decision = 'include' and m.valid_to is null
       join project_groups pg on pg.team_id = m.team_id and pg.project_id = m.project_id
       join group_members gm on gm.team_id = pg.team_id and gm.group_id = pg.group_id
      where i.id = any($1::uuid[]) and gm.member_id = any($2::uuid[])`,
    [[...world.items.keys()], cast.map((member) => member.memberId)],
  );
  const byItem: Record<string, string[]> = {};
  for (const label of world.items.values()) byItem[label] = [];
  for (const row of rows) byItem[world.items.get(row.item_id) ?? row.item_id].push(world.members.get(row.member_id) ?? row.member_id);
  for (const holders of Object.values(byItem)) holders.sort();
  return byItem;
}

/**
 * Team A holds a `shared` and a `restricted` item of the family's kind; team B holds a `foreign`
 * one. `restricted` is reachable by the grantee alone. `shared` is reachable by all of team A when
 * `sharedWithEveryone`, and otherwise is restricted to the grantee as well — the world in which the
 * actor's scope is genuinely empty while the team still holds content. Team A also holds a
 * `grantless` principal the guards admit and the oracle grants no project in either world.
 */
async function seedWorld(family: Family, opts: { sharedWithEveryone: boolean }): Promise<World> {
  const a = await seedTeam();
  const b = await seedTeam();
  const privileged: Role = family === "discover" ? "admin" : "member";
  const actor = await seedCast(a, "actor", privileged);
  const grantee = await seedCast(a, "grantee", privileged);
  const teammate = await seedCast(a, "teammate", "member");
  const grantless = await seedCast(a, "grantless", privileged, "agent");
  const foreigner = await seedCast(b, "foreigner", privileged);

  const shared = await ingestSource(a, family, "shared");
  const restricted = await ingestSource(a, family, "restricted");
  const foreign = await ingestSource(b, family, "foreign");
  for (const team of [a, b]) {
    const filled = await backfillTeamContext(db(), team.teamId);
    if (!filled.ok) throw new Error(`${FIXTURE} context backfill: ${filled.error}`);
  }
  await restrictTo(a, grantee, opts.sharedWithEveryone ? [restricted] : [shared, restricted]);

  // The principals a membership path can serve. `grantless` is not one of them: its only group row
  // is the planted builtin one, which the raw join below would follow and the oracle does not.
  const cast = [actor, grantee, teammate, foreigner];
  const items = new Map<string, string>(
    [shared, restricted, foreign].map((item): [string, string] => [item.id, item.label]),
  );
  const members = new Map<string, string>([
    ...[...cast, grantless].map((member): [string, string] => [member.memberId, member.label]),
    [a.memberId, "ownerA"],
    [b.memberId, "ownerB"],
  ]);
  const teams = new Map<string, string>([
    [a.teamId, "A"],
    [b.teamId, "B"],
  ]);
  const world: World = {
    a,
    b,
    actor,
    grantee,
    teammate,
    grantless,
    foreigner,
    shared,
    restricted,
    foreign,
    items,
    members,
    teams,
    known: new Set([...items.keys(), ...members.keys(), ...teams.keys()]),
  };

  premise("the fixture ids are distinct", world.known.size, items.size + members.size + teams.size);
  premise("who holds a current membership path to each item", await reach(world, cast), {
    shared: opts.sharedWithEveryone ? ["actor", "grantee", "teammate"] : ["grantee"],
    restricted: ["grantee"],
    foreign: ["foreigner"],
  });
  const standing = await authority(grantless.memberId);
  premise(
    "the grantless principal is an active agent whose only group row is the builtin Everyone one",
    {
      kind: standing.kind,
      status: standing.status,
      everyone_rows: standing.everyone_rows,
      external_rows: standing.external_rows,
      other_group_rows: standing.other_group_rows,
    },
    { kind: "agent", status: "active", everyone_rows: 1, external_rows: 0, other_group_rows: 0 },
  );
  premise("no opportunity exists before the first request", await opportunities(world), []);
  return world;
}

// ── the recording transport ──────────────────────────────────────────────────────────────────────

// The four statement heads the real builder compiles. Embedded resources compile to lowercase
// subselects, so the last uppercase FROM of a SELECT is its own table.
const STATEMENT_HEADS: [string, RegExp][] = [
  ["insert", /^INSERT INTO ([a-z_]+) /],
  ["update", /^UPDATE ([a-z_]+) SET /],
  ["delete", /^DELETE FROM ([a-z_]+) /],
  ["select", /^SELECT [\s\S]* FROM ([a-z_]+) /],
];

function classify(text: string): { op: string; table: string } {
  for (const [op, head] of STATEMENT_HEADS) {
    const match = head.exec(text);
    if (match) return { op, table: match[1] };
  }
  return { op: UNCLASSIFIED, table: "" };
}

const describeStatement = (statement: Statement): string => `${statement.op} ${statement.table}`;

/**
 * A real `PgClient` whose executor records each compiled statement, forwards it to the real pool
 * and records the rows Postgres answered. The recorder never throws on its own account: only the
 * armed fault rejects, in place of sending its statement.
 */
function recordingClient(via: Via, flight: Flight): DbClient {
  const record =
    (inner: SqlExecutor): SqlExecutor =>
    async <T = Row>(text: string, params: unknown[] = []) => {
      const statement: Statement = { via, ...classify(text), text, params: [...params], rows: [], outcome: SENT };
      flight.statements.push(statement);
      const fault = flight.fault;
      if (fault && fault.fired === 0 && fault.via === via && fault.table === statement.table && statement.op === "select") {
        fault.fired += 1;
        fault.at = flight.statements.length - 1;
        statement.outcome = FAULTED;
        throw new Error(FAULT_MESSAGE);
      }
      try {
        const answered = await inner<T>(text, params);
        statement.rows = answered.rows as Row[];
        statement.outcome = ANSWERED;
        return answered;
      } catch (error) {
        statement.outcome = `${NATIVE_ERROR} ${error instanceof Error ? error.message : String(error)}`;
        throw error;
      }
    };
  return new PgClient({ executor: record(runSql), decorateSessionExecutor: record }) as unknown as DbClient;
}

/**
 * A new request with its own cookie jar and trace: snapshot, run the actual export, snapshot again.
 * `session` is the signed session cookie, or null for none. `fault` arms one resolver read fault.
 */
async function request<T>(
  session: string | null,
  action: () => Promise<T>,
  fault?: { via: Via; table: string },
): Promise<Seen<T>> {
  const jar = new Map<string, string>();
  if (session !== null) jar.set(SESSION_COOKIE, session);
  const flight: Flight = { jar, statements: [], consumers: [], fault: fault ? { ...fault, fired: 0, at: -1 } : null };
  h.revalidatePath.mockClear();
  // The real adapter logs the failure it converts; captured so the fault can be shown to surface there.
  const adapterLog = fault ? vi.spyOn(console, "error").mockImplementation(() => {}) : null;
  let logged: string[] = [];

  const before = await durable();
  inFlight = flight;
  h.adminDb = recordingClient("admin", flight);
  h.serverDb = recordingClient("server", flight);
  h.enterConsumer = (consumer, teamId, scope, actorId) => {
    flight.consumers.push({
      consumer,
      at: flight.statements.length,
      teamId,
      scope: scope === undefined ? null : [...scope],
      actorId,
    });
  };
  let result: T;
  try {
    result = await action();
  } finally {
    inFlight = null;
    h.adminDb = null;
    h.serverDb = null;
    h.enterConsumer = null;
    logged = adapterLog ? adapterLog.mock.calls.map((call) => String(call[0])) : [];
    adapterLog?.mockRestore();
  }
  const after = await durable();

  premise(
    "every statement the action issued was classified and answered",
    flight.statements
      .filter((statement) => statement.op === UNCLASSIFIED || statement.outcome.startsWith(NATIVE_ERROR))
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
    result,
    before,
    after,
    statements: flight.statements,
    consumers: flight.consumers,
    afterFault: flight.fault
      ? flight.statements.slice(flight.fault.at + 1).map((statement) => `${statement.via} ${describeStatement(statement)}`)
      : [],
    revalidated: h.revalidatePath.mock.calls.map((call) => call[0]),
  };
}

const readsItemBodies = (statement: Statement): boolean =>
  statement.table === "items" && statement.op === "select" && /\bbody\b|^SELECT \*/.test(statement.text);

/**
 * What the action put on the wire, in fixture labels.
 *   bodyReads     each body-bearing `items` statement: its client, the team and the item ids bound
 *                 into it, the count of other uuids bound into it, and the items whose bodies
 *                 Postgres returned to it.
 *   itemsBound    every fixture item id bound into ANY statement.
 *   principals    every fixture member id bound into ANY statement.
 *   teams         every fixture team id bound into ANY statement.
 *   tokensLoaded  every item sentinel in ANY row returned to the action.
 *   writes        every statement that is not a SELECT.
 */
function wire(world: World, seen: Seen<unknown>) {
  const params = seen.statements.flatMap((statement) => statement.params);
  return {
    bodyReads: seen.statements.filter(readsItemBodies).map((statement) => ({
      via: statement.via,
      teams: pick(world.teams, statement.params),
      scope: pick(world.items, statement.params),
      strangers: statement.params.filter(
        (value) => typeof value === "string" && UUID.test(value) && !world.known.has(value),
      ).length,
      loaded: pick(
        world.items,
        statement.rows.filter((row) => "body" in row).map((row) => row.id),
      ),
    })),
    itemsBound: pick(world.items, params),
    principals: pick(world.members, params),
    teams: pick(world.teams, params),
    tokensLoaded: tokensIn(seen.statements.map((statement) => statement.rows)),
    writes: seen.statements.filter((statement) => statement.op !== "select").map(describeStatement),
  };
}

/**
 * What crossed the two recorded call boundaries, in fixture labels.
 *   resolver   the service-client statements issued before the consumer was entered — all of them
 *              when it never was — in order, each with what became of it.
 *   consumers  each entry into a consumer: its team, the scope option it was handed (`OMITTED` when
 *              absent), how many ids in that scope are no fixture item, and its actor.
 */
function boundaries(world: World, seen: Seen<unknown>) {
  const entered = seen.consumers.length ? seen.consumers[0].at : seen.statements.length;
  return {
    resolver: seen.statements
      .slice(0, entered)
      .filter((statement) => statement.via === "admin")
      .map((statement) => `${describeStatement(statement)}: ${statement.outcome}`),
    consumers: seen.consumers.map((call) => ({
      consumer: call.consumer,
      team: world.teams.get(call.teamId) ?? call.teamId,
      scope: call.scope === null ? OMITTED : pick(world.items, call.scope),
      strangers: (call.scope ?? []).filter((id) => !world.items.has(id)).length,
      actor: call.actorId === null ? null : (world.members.get(call.actorId) ?? call.actorId),
    })),
  };
}

/** The boundaries of a request refused before the resolver: neither was reached. */
const UNREACHED = { resolver: [], consumers: [] };

/**
 * What the guard did before the resolver's first read: the statements it issued, each with what
 * became of it, and the member its own `members` read answered with.
 */
function guard(world: World, seen: Seen<unknown>) {
  const first = seen.statements.findIndex((statement) => statement.via === "admin");
  const issued = seen.statements.slice(0, first < 0 ? seen.statements.length : first);
  return {
    statements: issued.map((statement) => `${statement.via} ${describeStatement(statement)}: ${statement.outcome}`),
    member: pick(
      world.members,
      issued.filter((statement) => statement.table === "members").flatMap((statement) => statement.rows.map((row) => row.id)),
    ),
  };
}

/** The wire of a request refused before the resolver: nothing through the service client at all. */
function quiet(world: World, seen: Seen<unknown>) {
  const { bodyReads, itemsBound, tokensLoaded, writes } = wire(world, seen);
  return {
    adminStatements: seen.statements.filter((statement) => statement.via === "admin").length,
    bodyReads,
    itemsBound,
    tokensLoaded,
    writes,
  };
}

const QUIET = { adminStatements: 0, bodyReads: [], itemsBound: [], tokensLoaded: [], writes: [] };

// ── S: what a scan request owes ──────────────────────────────────────────────────────────────────

const scan = (teamSlug: string) => () => scanMeetingTodosAction({ teamSlug });

/** The scan result in fixture labels: each candidate's source item and the sentinels it carries. */
function scanResult(world: World, result: ScanResult) {
  return {
    ok: result.ok,
    error: result.error,
    scanned: result.scanned,
    candidates: result.candidates
      ?.map((candidate) => ({
        source: world.items.get(candidate.sourceItemId) ?? candidate.sourceItemId,
        tokens: tokensIn(candidate),
        audience: candidate.audience,
        existingTaskId: candidate.existingTaskId,
      }))
      .sort((left, right) => left.source.localeCompare(right.source)),
  };
}

function scanOutcome(world: World, seen: Seen<ScanResult>) {
  return {
    result: scanResult(world, seen.result),
    boundaries: boundaries(world, seen),
    wire: wire(world, seen),
    durable: seen.after,
    revalidated: seen.revalidated,
  };
}

/**
 * An admitted scan by `principal` of `team`, confined to `sources`: the resolver's reads ended as
 * `resolver` says, the scanner was entered once and handed exactly those ids, one candidate per
 * source and no other, the scanner's one `items` statement bound to exactly those ids and answered
 * with exactly those bodies, no other fixture item named anywhere, nothing written, nothing
 * revalidated.
 */
function scanAdmitted(
  seen: Seen<ScanResult>,
  by: { principal: string; team: TeamLabel },
  sources: ItemLabel[],
  resolver: string[] = RESOLVED,
) {
  const visible = [...sources].sort();
  return {
    result: {
      ok: true,
      scanned: visible.length,
      candidates: visible.map((source) => ({
        source,
        tokens: [TOKENS.scan[source]],
        audience: "team",
        existingTaskId: null,
      })),
    },
    boundaries: {
      resolver,
      consumers: [{ consumer: "scan", team: by.team, scope: visible, strangers: 0, actor: null }],
    },
    wire: {
      bodyReads: [{ via: "server", teams: [by.team], scope: visible, strangers: 0, loaded: visible }],
      itemsBound: visible,
      principals: [by.principal],
      teams: [by.team],
      tokensLoaded: visible.map((source) => TOKENS.scan[source]).sort(),
      writes: [],
    },
    durable: seen.before,
    revalidated: [],
  };
}

describe("S — scanMeetingTodosAction: visibleItemIds(team.id, auth.memberId) → scanMeetingTodosForTeam options.visibleItemIds (real Postgres)", () => {
  it(
    "S1 partial scope: the signed-in member's own visible set is the scanner's only source — the shared todo is returned and the restricted and foreign transcripts are never loaded; the grantee's session on the same fixture scans both of team A's",
    async () => {
      const world = await seedWorld("scan", { sharedWithEveryone: true });

      const asActor = await request(world.actor.session, scan(world.a.teamSlug));
      expect(scanOutcome(world, asActor)).toEqual(scanAdmitted(asActor, { principal: "actor", team: "A" }, ["shared"]));

      // Only the session differs: the same fixture, slug and input reach the restricted transcript.
      const asGrantee = await request(world.grantee.session, scan(world.a.teamSlug));
      expect(scanOutcome(world, asGrantee), CONTROL).toEqual(
        scanAdmitted(asGrantee, { principal: "grantee", team: "A" }, ["shared", "restricted"]),
      );
    },
    ROOMY,
  );

  it(
    "S2 empty scope: an admitted member who can see none of team A's transcripts gets a successful empty scan — the scanner's statement is bound to no item and loads no body — while the grantee scans both",
    async () => {
      const world = await seedWorld("scan", { sharedWithEveryone: false });

      const asActor = await request(world.actor.session, scan(world.a.teamSlug));
      expect(scanOutcome(world, asActor)).toEqual(scanAdmitted(asActor, { principal: "actor", team: "A" }, []));

      // The team does hold scannable content: the empty answer is the actor's scope, not the corpus.
      const asGrantee = await request(world.grantee.session, scan(world.a.teamSlug));
      expect(scanOutcome(world, asGrantee), CONTROL).toEqual(
        scanAdmitted(asGrantee, { principal: "grantee", team: "A" }, ["shared", "restricted"]),
      );
    },
    ROOMY,
  );

  it.each(RESOLVER_LEGS)(
    "S3 resolver error: a failed %s read inside visibleItemIds refuses with visibility resolution failed — the fault lands on the resolver's own read after the guard admitted the member, it is the last statement the action issues, the scanner is never entered and no body is loaded",
    async (leg) => {
      const world = await seedWorld("scan", { sharedWithEveryone: true });

      const refused = await request(world.actor.session, scan(world.a.teamSlug), { via: "admin", table: leg });
      // Only the fault differs: the same session, slug and input are admitted and confined.
      const admitted = await request(world.actor.session, scan(world.a.teamSlug));

      expect({ ...scanOutcome(world, refused), guard: guard(world, refused), afterFault: refused.afterFault }).toEqual({
        result: VISIBILITY_FAILED,
        boundaries: { resolver: stoppedAt(leg), consumers: [] },
        wire: { bodyReads: [], itemsBound: [], principals: ["actor"], teams: ["A"], tokensLoaded: [], writes: [] },
        durable: refused.before,
        revalidated: [],
        guard: { statements: guard(world, admitted).statements, member: ["actor"] },
        afterFault: [],
      });
      expect(scanOutcome(world, admitted), CONTROL).toEqual(
        scanAdmitted(admitted, { principal: "actor", team: "A" }, ["shared"]),
      );
    },
    ROOMY,
  );

  it(
    "S4 no project: an admitted principal the oracle resolves to no project, with no read error, gets a successful empty scan — the resolver ends before its grant and item-membership reads, the scanner is entered once with an empty scope and loads no body — while the member on the same fixture scans the shared transcript",
    async () => {
      const world = await seedWorld("scan", { sharedWithEveryone: true });

      const asGrantless = await request(world.grantless.session, scan(world.a.teamSlug));
      expect(scanOutcome(world, asGrantless)).toEqual(
        scanAdmitted(asGrantless, { principal: "grantless", team: "A" }, [], NO_ACCEPTED_GROUP),
      );

      // The team does hold scannable content: the empty answer is the principal's grants, not the corpus.
      const asActor = await request(world.actor.session, scan(world.a.teamSlug));
      expect(scanOutcome(world, asActor), CONTROL).toEqual(
        scanAdmitted(asActor, { principal: "actor", team: "A" }, ["shared"]),
      );
    },
    ROOMY,
  );

  it(
    "S5 wrong principal and foreign team: team B's member against team A, team A's member against team B and no session are refused before the resolver with nothing loaded; team B's member scans only team B's transcript",
    async () => {
      const world = await seedWorld("scan", { sharedWithEveryone: true });

      const foreignerOnA = await request(world.foreigner.session, scan(world.a.teamSlug));
      const actorOnB = await request(world.actor.session, scan(world.b.teamSlug));
      const anonymous = await request(null, scan(world.a.teamSlug));
      for (const [label, refused] of [
        ["team B's member against team A", foreignerOnA],
        ["team A's member against team B", actorOnB],
        ["no session", anonymous],
      ] as const) {
        expect(
          {
            result: scanResult(world, refused.result),
            boundaries: boundaries(world, refused),
            wire: quiet(world, refused),
            durable: refused.after,
            revalidated: refused.revalidated,
          },
          label,
        ).toEqual({ result: NOT_A_MEMBER, boundaries: UNREACHED, wire: QUIET, durable: refused.before, revalidated: [] });
      }

      // Only the slug differed: each principal is admitted in its own team and confined to it.
      const foreignerOnB = await request(world.foreigner.session, scan(world.b.teamSlug));
      expect(scanOutcome(world, foreignerOnB), CONTROL).toEqual(
        scanAdmitted(foreignerOnB, { principal: "foreigner", team: "B" }, ["foreign"]),
      );
      const actorOnA = await request(world.actor.session, scan(world.a.teamSlug));
      expect(scanOutcome(world, actorOnA), CONTROL).toEqual(
        scanAdmitted(actorOnA, { principal: "actor", team: "A" }, ["shared"]),
      );
    },
    ROOMY,
  );
});

// ── D: what a discovery request owes ─────────────────────────────────────────────────────────────

const discover = (teamSlug: string) => () => discoverNow(teamSlug);

/** Every opportunity row of every team, in fixture labels, with the sentinels each text field carries. */
async function opportunities(world: Pick<World, "items" | "members" | "teams">) {
  const rows = await fx<{
    team_id: string;
    dedup_key: string | null;
    evidence: unknown;
    created_by: string | null;
    title: string;
    summary: string;
  }>("opportunity readback", `select team_id, dedup_key, evidence, created_by, title, summary from social_opportunities`);
  return rows
    .map((row) => {
      const sourceId = row.dedup_key?.startsWith("item:") ? row.dedup_key.slice("item:".length) : "";
      const evidence = Array.isArray(row.evidence) ? (row.evidence as { itemId?: unknown }[]) : [];
      return {
        team: world.teams.get(row.team_id) ?? row.team_id,
        source: world.items.get(sourceId) ?? String(row.dedup_key),
        evidence: evidence.map((entry) => world.items.get(String(entry.itemId)) ?? String(entry.itemId)).sort(),
        createdBy: row.created_by === null ? null : (world.members.get(row.created_by) ?? row.created_by),
        title: tokensIn(row.title),
        summary: tokensIn(row.summary),
        evidenceText: tokensIn(row.evidence),
      };
    })
    .sort((left, right) => `${left.team}/${left.source}`.localeCompare(`${right.team}/${right.source}`));
}

/** The standing row discovery owes for one item: its own team, evidence, minter and sentinel only. */
function minted(team: TeamLabel, source: ItemLabel, createdBy: string) {
  const token = [TOKENS.discover[source]];
  return { team, source, evidence: [source], createdBy, title: token, summary: token, evidenceText: token };
}

/** Call immediately after its request: `opportunities` is the standing rowset at that moment. */
async function discoverOutcome(world: World, seen: Seen<DiscoverResult>) {
  return {
    result: seen.result,
    boundaries: boundaries(world, seen),
    wire: wire(world, seen),
    opportunities: await opportunities(world),
    elsewhere: withoutOpportunities(seen.after),
    revalidated: seen.revalidated,
  };
}

/**
 * An admitted discovery by `principal` of `team`, confined to `scope`: the resolver's reads ended as
 * `resolver` says, discovery was entered once and handed exactly those ids and that actor, its one
 * body-bearing `items` statement is bound to exactly those ids and answered with exactly those
 * bodies, one opportunity is inserted per item in `mints` (the rest of `scope` was already minted),
 * no other fixture item is named anywhere, no other durable table changes, and the social page
 * revalidates.
 */
function discoverAdmitted(
  seen: Seen<DiscoverResult>,
  by: { principal: string; team: TeamLabel; slug: string },
  scope: ItemLabel[],
  mints: ItemLabel[],
  resolver: string[] = RESOLVED,
) {
  const visible = [...scope].sort();
  return {
    result: { ok: true, created: mints.length, skipped: visible.length - mints.length, scanned: visible.length },
    boundaries: {
      resolver,
      consumers: [{ consumer: "discover", team: by.team, scope: visible, strangers: 0, actor: by.principal }],
    },
    wire: {
      bodyReads: [{ via: "admin", teams: [by.team], scope: visible, strangers: 0, loaded: visible }],
      itemsBound: visible,
      principals: [by.principal],
      teams: [by.team],
      tokensLoaded: visible.map((source) => TOKENS.discover[source]).sort(),
      writes: mints.map(() => "insert social_opportunities"),
    },
    elsewhere: withoutOpportunities(seen.before),
    revalidated: [`/t/${by.slug}/social`],
  };
}

describe("D — discoverNow: visibleItemIds(ctx.teamId, ctx.memberId) → discoverOpportunities options.visibleItemIds plus actor.memberId (real Postgres)", () => {
  it(
    "D1 partial scope: the signed-in admin's own visible set is discovery's only source — one opportunity is minted from the shared item, by the actor, and the restricted and foreign items are never loaded or minted; the grantee admin's session then mints the restricted item only",
    async () => {
      const world = await seedWorld("discover", { sharedWithEveryone: true });
      const asA = { team: "A", slug: world.a.teamSlug } as const;

      const asActor = await request(world.actor.session, discover(world.a.teamSlug));
      expect(await discoverOutcome(world, asActor)).toEqual({
        ...discoverAdmitted(asActor, { principal: "actor", ...asA }, ["shared"], ["shared"]),
        opportunities: [minted("A", "shared", "actor")],
      });

      // Only the session differs: the grantee's scope reaches both items, and the shared one is
      // already minted, so the restricted item is the one new row — attributed to the grantee.
      const asGrantee = await request(world.grantee.session, discover(world.a.teamSlug));
      expect(await discoverOutcome(world, asGrantee), CONTROL).toEqual({
        ...discoverAdmitted(asGrantee, { principal: "grantee", ...asA }, ["shared", "restricted"], ["restricted"]),
        opportunities: [minted("A", "restricted", "grantee"), minted("A", "shared", "actor")],
      });
    },
    ROOMY,
  );

  it(
    "D2 empty scope: an admitted admin who can see none of team A's items gets a successful empty discovery — the scan is bound to no item, loads no body and mints nothing — while the grantee admin mints both",
    async () => {
      const world = await seedWorld("discover", { sharedWithEveryone: false });
      const asA = { team: "A", slug: world.a.teamSlug } as const;

      const asActor = await request(world.actor.session, discover(world.a.teamSlug));
      expect(await discoverOutcome(world, asActor)).toEqual({
        ...discoverAdmitted(asActor, { principal: "actor", ...asA }, [], []),
        opportunities: [],
      });

      // The team does hold discoverable content: the empty answer is the actor's scope, not the corpus.
      const asGrantee = await request(world.grantee.session, discover(world.a.teamSlug));
      expect(await discoverOutcome(world, asGrantee), CONTROL).toEqual({
        ...discoverAdmitted(asGrantee, { principal: "grantee", ...asA }, ["shared", "restricted"], ["shared", "restricted"]),
        opportunities: [minted("A", "restricted", "grantee"), minted("A", "shared", "grantee")],
      });
    },
    ROOMY,
  );

  it.each(RESOLVER_LEGS)(
    "D3 resolver error: a failed %s read inside visibleItemIds refuses with visibility resolution failed — the fault lands on the resolver's own read after the guard admitted the admin, it is the last statement the action issues, discovery is never entered, no opportunity is written and nothing revalidates",
    async (leg) => {
      const world = await seedWorld("discover", { sharedWithEveryone: true });
      const asA = { team: "A", slug: world.a.teamSlug } as const;

      const refused = await request(world.actor.session, discover(world.a.teamSlug), { via: "admin", table: leg });
      const afterRefusal = await discoverOutcome(world, refused);
      // Only the fault differs: the same session and slug are admitted and confined.
      const admitted = await request(world.actor.session, discover(world.a.teamSlug));
      const afterAdmission = await discoverOutcome(world, admitted);

      expect({
        ...afterRefusal,
        durable: refused.after,
        guard: guard(world, refused),
        afterFault: refused.afterFault,
      }).toEqual({
        result: VISIBILITY_FAILED,
        boundaries: { resolver: stoppedAt(leg), consumers: [] },
        wire: { bodyReads: [], itemsBound: [], principals: ["actor"], teams: ["A"], tokensLoaded: [], writes: [] },
        opportunities: [],
        elsewhere: withoutOpportunities(refused.before),
        revalidated: [],
        durable: refused.before,
        guard: { statements: guard(world, admitted).statements, member: ["actor"] },
        afterFault: [],
      });
      expect(afterAdmission, CONTROL).toEqual({
        ...discoverAdmitted(admitted, { principal: "actor", ...asA }, ["shared"], ["shared"]),
        opportunities: [minted("A", "shared", "actor")],
      });
    },
    ROOMY,
  );

  it(
    "D4 no project: an admitted admin the oracle resolves to no project, with no read error, gets a successful empty discovery — the resolver ends before its grant and item-membership reads, discovery is entered once with an empty scope, loads no body, mints nothing and the social page still revalidates — while the admin on the same fixture mints the shared item",
    async () => {
      const world = await seedWorld("discover", { sharedWithEveryone: true });
      const asA = { team: "A", slug: world.a.teamSlug } as const;

      const asGrantless = await request(world.grantless.session, discover(world.a.teamSlug));
      expect(await discoverOutcome(world, asGrantless)).toEqual({
        ...discoverAdmitted(asGrantless, { principal: "grantless", ...asA }, [], [], NO_ACCEPTED_GROUP),
        opportunities: [],
      });

      // The team does hold discoverable content: the empty answer is the principal's grants, not the corpus.
      const asActor = await request(world.actor.session, discover(world.a.teamSlug));
      expect(await discoverOutcome(world, asActor), CONTROL).toEqual({
        ...discoverAdmitted(asActor, { principal: "actor", ...asA }, ["shared"], ["shared"]),
        opportunities: [minted("A", "shared", "actor")],
      });
    },
    ROOMY,
  );

  it(
    "D5 wrong principal and foreign team: team B's admin against team A, team A's admin against team B, a same-team non-admin and no session are refused admins only before the resolver with nothing loaded or minted; team B's admin mints only team B's item into team B",
    async () => {
      const world = await seedWorld("discover", { sharedWithEveryone: true });

      const foreignerOnA = await request(world.foreigner.session, discover(world.a.teamSlug));
      const actorOnB = await request(world.actor.session, discover(world.b.teamSlug));
      const teammateOnA = await request(world.teammate.session, discover(world.a.teamSlug));
      const anonymous = await request(null, discover(world.a.teamSlug));
      for (const [label, refused] of [
        ["team B's admin against team A", foreignerOnA],
        ["team A's admin against team B", actorOnB],
        ["a same-team non-admin", teammateOnA],
        ["no session", anonymous],
      ] as const) {
        expect(
          {
            result: refused.result,
            boundaries: boundaries(world, refused),
            wire: quiet(world, refused),
            durable: refused.after,
            revalidated: refused.revalidated,
          },
          label,
        ).toEqual({ result: ADMINS_ONLY, boundaries: UNREACHED, wire: QUIET, durable: refused.before, revalidated: [] });
      }
      expect(await opportunities(world)).toEqual([]);

      // Only the slug differed: each admin is admitted in its own team and confined to it.
      const foreignerOnB = await request(world.foreigner.session, discover(world.b.teamSlug));
      expect(await discoverOutcome(world, foreignerOnB), CONTROL).toEqual({
        ...discoverAdmitted(foreignerOnB, { principal: "foreigner", team: "B", slug: world.b.teamSlug }, ["foreign"], ["foreign"]),
        opportunities: [minted("B", "foreign", "foreigner")],
      });
      const actorOnA = await request(world.actor.session, discover(world.a.teamSlug));
      expect(await discoverOutcome(world, actorOnA), CONTROL).toEqual({
        ...discoverAdmitted(actorOnA, { principal: "actor", team: "A", slug: world.a.teamSlug }, ["shared"], ["shared"]),
        opportunities: [minted("A", "shared", "actor"), minted("B", "foreign", "foreigner")],
      });
    },
    ROOMY,
  );
});

// ── C: the chain gate's lookup-error arm ─────────────────────────────────────────────────────────

const plan = (teamSlug: string, opportunityId: string) => () => planNow(teamSlug, opportunityId);

describe("C — actorChainGate: a resolver read error at the gate the chain-gated Social exports share (real Postgres)", () => {
  it(
    "C1 lookup error at the chain gate: a failed group_members read inside visibleItemIds refuses planNow with visibility resolution failed, not the gate's not-found shape, and the faulted statement is the last one the action issues — no chain read, no plan, no revalidation; without the fault the same admin plans the same opportunity",
    async () => {
      const world = await seedWorld("discover", { sharedWithEveryone: true });
      const slug = world.a.teamSlug;
      await request(world.actor.session, discover(slug));
      premise("discovery minted the one opportunity the gate is asked about", await opportunities(world), [
        minted("A", "shared", "actor"),
      ]);
      const { id: opportunityId } = await fxOne<{ id: string }>(
        "opportunity lookup",
        `select id from social_opportunities where team_id = $1`,
        [world.a.teamId],
      );

      const refused = await request(world.actor.session, plan(slug, opportunityId), { via: "admin", table: "group_members" });
      // Only the fault differs: the same session, slug and opportunity pass the gate and are planned.
      const admitted = await request(world.actor.session, plan(slug, opportunityId));

      expect({
        result: refused.result,
        resolver: boundaries(world, refused).resolver,
        guard: guard(world, refused),
        afterFault: refused.afterFault,
        writes: wire(world, refused).writes,
        durable: refused.after,
        revalidated: refused.revalidated,
      }).toEqual({
        result: VISIBILITY_FAILED,
        resolver: stoppedAt("group_members"),
        guard: { statements: guard(world, admitted).statements, member: ["actor"] },
        afterFault: [],
        writes: [],
        durable: refused.before,
        revalidated: [],
      });
      expect(
        {
          result: admitted.result,
          plans: admitted.after.content_plans.length - admitted.before.content_plans.length,
          revalidated: admitted.revalidated,
        },
        CONTROL,
      ).toEqual({ result: { ok: true, variants: 2, created: true }, plans: 1, revalidated: [`/t/${slug}/social`] });
    },
    ROOMY,
  );
});
