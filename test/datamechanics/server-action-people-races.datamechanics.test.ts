import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PgClient } from "@/lib/db/pg/client";
import { getPool } from "@/lib/db/pg/pool";
import type { DbClient } from "@/lib/db/types";
import type { GoalInput } from "@/lib/identity/profile";
import { placeMemberByTier, seedTeam } from "./helpers";

/**
 * AIO-1217 — People ownership RACES against real Postgres (AC-09, AC-10; AC-03/04 argument half).
 *
 * Every assertion is derived from the accepted specification's "Targeted runtime correction B", not
 * from the implementation: the People actions write only inside the (team, member) tuple the gate
 * authenticated, a lost unique-insert race is re-read IN SCOPE at most two more times, a row whose
 * owner changed between a read and the final statement is refused rather than repaired, re-homed or
 * reassigned, and only a confirmed write audits and revalidates. The unraced foreign-target and
 * peer-id cases live in `server-action-target-binding.datamechanics.test.ts` and the direct owner
 * cases in `member-profile.datamechanics.test.ts`; neither is repeated or counted here.
 *
 *   P — saveProfile / saveAvatar: unique-insert races and bounded scoped retry.
 *   D — deleteMemberTimeOff / deleteMemberGoal: the owner (or team, or the row) changes immediately
 *       before the final DELETE.
 *   G — saveMemberGoal: explicit-id and imported-dedup owner races, bounded exhaustion, and extra
 *       browser input fields that must select neither the target nor the trusted mode.
 *
 * What is real: the six People exports, their `gate`, `currentMember`, `canEditMemberContext`, the
 * posture resolver, the profile single writer, the audit writer and a real `PgClient` over the test
 * pool. What is stubbed: ONLY "who is signed in" (a synthetic auth-user id — the member, role and
 * posture behind it are real rows), `revalidatePath`, and `adminClient()`, which hands the action a
 * GATED real adapter for the duration of one call. No writer and no persistence is mocked.
 *
 * THE TWO BARRIER SEAMS. `gatedDb` wraps the builders a real `PgClient` returns and identifies a
 * statement by what the caller built (table, operation, and the row/key it names — never the
 * predicate under test, so a statement that lost a predicate still reaches its barrier and fails on
 * the durable readback, not on the fixture). A script of gates fires in order, one statement each:
 *
 *   before   the gate holds BEFORE the underlying builder is awaited: Postgres has not seen the
 *            statement. The competitor commits through the pool, is read back, and only then does
 *            the real production SQL run. What it matches is a GENUINE SQL result.
 *   after    the statement really executed; its real envelope is HELD before the caller receives it.
 *            The competitor commits after that read and before the writer's next statement. This is
 *            a CAPTURED STALE READ, not an unexecuted query and not a shared transaction.
 *
 * A gate holds no connection (its statement has either not started or already returned), nothing is
 * ordered by time, and the competitor's raw SQL is fixture setup — never an alternate production
 * writer. Every statement issued through the gated client is recorded with the tuple it is bound to
 * and what Postgres really answered (rows, or the violated unique constraint), so a bounded retry is
 * asserted as a statement count rather than awaited as an eventual refusal. No envelope is ever
 * replaced: nothing in this file is a synthetic error, a suppressed row or a thrown builder.
 *
 * A refusal compares the full context rowsets and the audit ledger against the snapshot taken once
 * the competitor committed — the competitor's own change is part of that standing snapshot, not
 * evidence that the action mutated a peer. A barrier that was not reached, an action that settled
 * early, or a competitor statement that did not land fails with the `FIXTURE` prefix and is never a
 * security observation.
 *
 * Bounds of what is claimed. Target admission is not re-derived after the gate: nothing here asserts
 * linearizable actor revocation. Audit is best effort in production; the healthy local ledger is
 * asserted for admitted writes only, and a refusal must add nothing to it. Direct action execution
 * is not Next action-wire proof. NOT covered here, and still owed: the infrastructure-error family
 * (returned errors and throws at each writer phase, and the gate's target-lookup error), the paired
 * direct-writer classification cases, a trusted `system_import` race control, the member-deletion
 * foreign-key race and the lost-acknowledgement supplement.
 */

const FIXTURE = "FIXTURE PREMISE FAILED (setup, not a security observation):";

const h = vi.hoisted(() => ({
  sessionUser: null as { id: string; email: string } | null,
  /** When set, the client `adminClient()` hands the action under test: a gated real adapter. */
  actionDb: null as import("@/lib/db/types").DbClient | null,
  revalidatePath: vi.fn(),
}));

// Request identity only: the membership, role and posture behind this auth-user id are real rows.
vi.mock("@/lib/auth/session", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth/session")>()),
  getSessionUser: async () => h.sessionUser,
}));
vi.mock("next/cache", () => ({ revalidatePath: h.revalidatePath }));
// The real service client unless a test hands the action a gated adapter.
vi.mock("@/lib/db/admin", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/db/admin")>();
  return { ...original, adminClient: () => h.actionDb ?? original.adminClient() };
});

import {
  deleteMemberGoal,
  deleteMemberTimeOff,
  saveAvatar,
  saveMemberGoal,
  saveProfile,
} from "@/app/t/[team]/people/[handle]/actions";

type Row = Record<string, unknown>;
type Role = "admin" | "lead" | "member";
type ActionResult = { ok: boolean; error?: string; id?: string };
type ActorCase = "self" | "admin-other";

const ACTOR_CASES: ActorCase[] = ["self", "admin-other"];
const NOT_ALLOWED = { ok: false, error: "not allowed" };

const SEEDED_AVATAR = "data:image/png;base64,QkI=";
const VALID_AVATAR = "data:image/png;base64,AA==";
const ACTION_BIO = "aio1217 action-authored bio";
const IMPORT_KEY = "AIO1217-RACE-OKR-1";
const PEER_IMPORT_KEY = "AIO1217-RACE-PEER-OKR-1";
/** Every content field a goal write sets, so an admitted update is compared field by field. */
const GOAL_REVISION = {
  kind: "okr",
  title: "aio1217 revised goal title",
  detail: "aio1217 revised goal detail",
  status: "done",
} as const;

// What Postgres really answered a recorded statement.
const NOT_EXECUTED = "not yet executed";
const ZERO_ROWS = "0 rows";
const ONE_ROW = "1 row";
const PROFILE_PK = "unique violation: member_profiles_pkey";
const GOAL_IMPORT_KEY = "unique violation: member_goals_source_ext_unq";

beforeEach(() => {
  h.sessionUser = null;
  h.actionDb = null;
  h.revalidatePath.mockReset();
});

afterEach(() => {
  h.actionDb = null;
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
const revalidatedPaths = (): unknown[] => h.revalidatePath.mock.calls.map((call) => call[0]);
const peoplePath = (teamSlug: string, memberId: string) => `/t/${teamSlug}/people/${memberId}`;

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

/** Fresh readbacks straight from the pool: the standing rows, whatever any adapter reported. */
async function contextState() {
  return {
    profiles: await fx("profile readback", `select * from member_profiles order by member_id`),
    timeOff: await fx("time-off readback", `select * from member_time_off order by id`),
    goals: await fx("goal readback", `select * from member_goals order by id`),
    audit: await auditRows(),
  };
}

type Context = Awaited<ReturnType<typeof contextState>>;

/** The standing state once a competitor has committed. Its raw SQL writes no audit row. */
async function standingAfterCompetitor(before: Context): Promise<Context> {
  const committed = await contextState();
  premise("the competitor wrote no audit row", committed.audit, before.audit);
  return committed;
}

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
async function signIn(teamId: string, memberId: string, role: Role): Promise<void> {
  const user = { id: randomUUID(), email: `${randomUUID()}@test.local` };
  await fxOne("auth user insert", `insert into auth_users(id, email) values($1, $2) returning id`, [user.id, user.email]);
  await fxOne(
    "member session binding",
    `update members set auth_user_id = $1, role = $2 where id = $3 and team_id = $4 returning id`,
    [user.id, role, memberId, teamId],
  );
  premise("signed-in authority", await authority(memberId), {
    team_id: teamId,
    role,
    status: "active",
    auth_user_id: user.id,
    everyone_rows: 1,
    external_rows: 0,
  });
  h.sessionUser = user;
}

/**
 * One team with three distinct members. `self`: an ordinary member is both actor and target.
 * `admin-other`: an admin actor edits a different member as the target. `peer` is never the actor
 * or the target — it is who a competitor moves a row to.
 */
async function people(actorCase: ActorCase) {
  const team = await seedTeam();
  const second = await addMember(team.teamId);
  const third = await addMember(team.teamId);
  await signIn(team.teamId, team.memberId, actorCase === "self" ? "member" : "admin");
  return { team, actor: team.memberId, target: actorCase === "self" ? team.memberId : second, peer: third };
}

/** A profile with every field populated, so a partial write that wiped one would be visible. */
async function insertProfile(teamId: string, memberId: string): Promise<Row> {
  return fxOne(
    "profile insert",
    `insert into member_profiles(member_id, team_id, timezone, working_hours, preferred_channels, location, bio, avatar_data_url, updated_by)
     values($1, $2, 'Europe/Lisbon', $3::jsonb, $4::text[], 'Competitor City', 'competitor bio', $5, $1) returning *`,
    [memberId, teamId, JSON.stringify({ mon: ["09:00", "17:00"] }), ["slack"], SEEDED_AVATAR],
  );
}

async function seedTimeOff(teamId: string, memberId: string): Promise<string> {
  const { id } = await fxOne<{ id: string }>(
    "time-off insert",
    `insert into member_time_off(team_id, member_id, starts_on, ends_on, kind, note)
     values($1, $2, '2026-12-01', '2026-12-05', 'pto', $3) returning id`,
    [teamId, memberId, `time off of ${memberId}`],
  );
  return id;
}

async function seedGoal(
  teamId: string,
  memberId: string,
  fields: { title: string; source?: string; externalId?: string },
): Promise<string> {
  const { id } = await fxOne<{ id: string }>(
    "goal insert",
    `insert into member_goals(team_id, member_id, kind, title, detail, status, source, external_id)
     values($1, $2, 'okr', $3, 'original detail', 'at_risk', $4, $5) returning id`,
    [teamId, memberId, fields.title, fields.source ?? "manual", fields.externalId ?? ""],
  );
  return id;
}

/** Competitor: reassign one goal, guarded to exactly the row and owner the case expects. */
const moveGoal = (id: string, teamId: string, from: string, to: string) =>
  fxOne(
    "competitor moves the goal to another member",
    `update member_goals set member_id = $1 where id = $2 and team_id = $3 and member_id = $4 returning *`,
    [to, id, teamId, from],
  );

/** The goal row an admitted `GOAL_REVISION` write leaves: content replaced, owner and key untouched. */
const revised = (row: Row): Row => ({
  ...row,
  title: GOAL_REVISION.title,
  detail: GOAL_REVISION.detail,
  status: GOAL_REVISION.status,
  updated_at: expect.any(String),
});

const successAudit = (teamId: string, actor: string, action: string, target?: string) =>
  expect.objectContaining({
    team_id: teamId,
    actor_kind: "member",
    member_id: actor,
    action,
    ...(target ? { target_type: "member", target_id: target } : {}),
  });

// ── gated adapter ────────────────────────────────────────────────────────────────────────────────

type Operation = "select" | "insert" | "update" | "upsert" | "delete";
type Envelope = { data: unknown; error: { message: string } | null; count: number | null };
/** What the caller built, read off the builder calls — never off the SQL text. */
type Built = { table: string; operation: Operation; payload: unknown; filters: Array<[string, unknown]> };
type Matcher = (statement: Built) => boolean;
/** One statement issued through the gated client: the tuple it is bound to and Postgres's real answer. */
type Statement = { table: string; operation: Operation; bound: Row; outcome: string };
type Gate = {
  label: string;
  phase: "before" | "after";
  at: Matcher;
  reached: Promise<Statement>;
  arrive: (held: Statement) => void;
  released: Promise<void>;
  release: () => void;
};
type GatedDb = { db: DbClient; script: Gate[]; statements: Statement[]; unreached: () => string[] };

/** The identifiers a statement can be bound to: its tenant, its owner, its row and its import key. */
const SCOPE_COLUMNS = ["team_id", "member_id", "id", "source", "external_id"];

/** An insert is bound by the tuple it writes; every other statement by its equality predicates. */
function boundOf(built: Built): Row {
  const named = built.operation === "insert" && isRow(built.payload) ? Object.entries(built.payload) : built.filters;
  return Object.fromEntries(named.filter(([column]) => SCOPE_COLUMNS.includes(column)));
}

function outcomeOf(result: Envelope): string {
  if (result.error) {
    const constraint = /unique constraint "([^"]+)"/.exec(result.error.message);
    return constraint ? `unique violation: ${constraint[1]}` : `error: ${result.error.message}`;
  }
  const rows = Array.isArray(result.data) ? result.data.length : result.data == null ? 0 : 1;
  return rows === 1 ? ONE_ROW : `${rows} rows`;
}

function deferred<T>() {
  let settle: (value: T) => void = () => undefined;
  const promise = new Promise<T>((resolve) => {
    settle = resolve;
  });
  return { promise, settle: (value: T) => settle(value) };
}

/** A one-shot barrier at the statement `at` identifies. */
function gate(label: string, phase: Gate["phase"], at: Matcher): Gate {
  const reached = deferred<Statement>();
  const released = deferred<void>();
  return {
    label,
    phase,
    at,
    reached: reached.promise,
    arrive: reached.settle,
    released: released.promise,
    release: () => released.settle(undefined),
  };
}

/** `identity` names the row or key the statement is about — never the predicate under test. */
const at = (table: string, operation: Operation, identity: Row = {}): Matcher => (built) => {
  if (built.table !== table || built.operation !== operation) return false;
  const bound = boundOf(built);
  return Object.entries(identity).every(([column, value]) => bound[column] === value);
};

/**
 * A real pg adapter whose builders are observed and held, never altered. `script` is ordered: only
 * its head is armed, it fires on the first statement it matches, and the next gate arms after it.
 * With no script it is a plain recording tap.
 */
function gatedDb(script: Gate[] = []): GatedDb {
  const real = new PgClient();
  const statements: Statement[] = [];
  const pending = [...script];

  const from = (table: string) => {
    const target = real.from(table);
    const built: Built = { table, operation: "select", payload: undefined, filters: [] };

    const run = async (): Promise<Envelope> => {
      const hit = pending.length > 0 && pending[0].at(built) ? pending.shift() : undefined;
      const shape = { table, operation: built.operation, bound: boundOf(built) };
      if (hit?.phase === "before") {
        hit.arrive({ ...shape, outcome: NOT_EXECUTED });
        await hit.released;
      }
      const result = (await target) as Envelope;
      const seen: Statement = { ...shape, outcome: outcomeOf(result) };
      statements.push(seen);
      if (hit?.phase === "after") {
        hit.arrive(seen);
        await hit.released;
      }
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
    script,
    statements,
    unreached: () => pending.map((barrier) => barrier.label),
  };
}

/** The statements the writer issued on `table`, in order. */
const traceOf = (client: GatedDb, table: string) =>
  client.statements
    .filter((statement) => statement.table === table)
    .map(({ operation, bound, outcome }) => ({ operation, bound, outcome }));

/**
 * Start the action against `client` and drive its barriers. `schedule` calls `reach(gate)` for each
 * gate in script order: it resolves with the held statement once the action is parked there (the
 * previous gate is released first), and fails as a fixture premise if the action settled instead.
 * Every gate is released and the call awaited before this returns or throws.
 */
async function through<T, S>(
  client: GatedDb,
  start: () => Promise<T>,
  schedule: (reach: (barrier: Gate) => Promise<Statement>) => Promise<S>,
): Promise<{ result: T; scheduled: S }> {
  h.actionDb = client.db;
  const call = start();
  const settled = call.then(
    (value) => ({ settled: String(JSON.stringify(value)) }),
    (thrown) => ({ settled: String(thrown) }),
  );
  let holding: Gate | null = null;
  let reachedCount = 0;
  const reach = async (barrier: Gate): Promise<Statement> => {
    if (client.script[reachedCount] !== barrier) {
      throw new Error(`${FIXTURE} the barrier "${barrier.label}" was awaited out of script order`);
    }
    holding?.release();
    const winner = await Promise.race([barrier.reached, settled]);
    if ("settled" in winner) {
      throw new Error(`${FIXTURE} the action settled (${winner.settled}) before reaching the barrier "${barrier.label}"`);
    }
    holding = barrier;
    reachedCount += 1;
    return winner;
  };

  let scheduled: S;
  try {
    scheduled = await schedule(reach);
  } finally {
    for (const barrier of client.script) barrier.release();
    await Promise.allSettled([call]);
    h.actionDb = null;
  }
  premise("every barrier in the script was reached", client.unreached(), []);
  return { result: await call, scheduled };
}

/** Run the action through a recording client with no barrier. */
const unbarriered = async <T>(client: GatedDb, start: () => Promise<T>): Promise<T> =>
  (await through(client, start, async () => null)).result;

/** A refusal: the result, the writer's statements, the full standing rowsets and ledger, the cache. */
const standingObservation = (result: unknown, client: GatedDb, table: string, after: Context) => ({
  result,
  trace: traceOf(client, table),
  ...after,
  revalidated: revalidatedPaths(),
});

/** An admitted write: as above, with only the audit rows this invocation added. */
const admittedObservation = (result: unknown, client: GatedDb, table: string, before: Context, after: Context) => ({
  result,
  trace: traceOf(client, table),
  profiles: after.profiles,
  timeOff: after.timeOff,
  goals: after.goals,
  audit: auditSince(before.audit, after.audit),
  revalidated: revalidatedPaths(),
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// P — profile / avatar: unique-insert races and bounded scoped retry (AC-09)
// ─────────────────────────────────────────────────────────────────────────────────────────────────

describe("AIO-1217 P · profile and avatar writes converge only inside the authenticated (team, member) tuple (AC-09)", () => {
  const PROFILE_CALLERS: Array<{
    caller: string;
    run: (teamSlug: string, memberId: string) => Promise<ActionResult>;
    /** The only columns this input supplies. */
    written: Row;
    event: string;
  }> = [
    {
      caller: "saveProfile",
      run: (teamSlug, memberId) => saveProfile(teamSlug, memberId, { bio: ACTION_BIO }),
      written: { bio: ACTION_BIO },
      event: "profile.set",
    },
    {
      caller: "saveAvatar",
      run: (teamSlug, memberId) => saveAvatar(teamSlug, memberId, VALID_AVATAR),
      written: { avatar_data_url: VALID_AVATAR },
      event: "profile.avatar_set",
    },
  ];

  const profileUpdateOf = (memberId: string) => at("member_profiles", "update", { member_id: memberId });
  const profileRereadOf = (memberId: string) => at("member_profiles", "select", { member_id: memberId });

  /** A row this action inserted itself: the authorized tuple, the supplied field, defaults elsewhere. */
  const createdProfile = (teamId: string, memberId: string, actor: string, written: Row): Row => ({
    member_id: memberId,
    team_id: teamId,
    timezone: "",
    working_hours: {},
    preferred_channels: [],
    location: "",
    bio: "",
    avatar_data_url: null,
    updated_at: expect.any(String),
    updated_by: actor,
    ...written,
  });

  it.each(PROFILE_CALLERS.flatMap((caller) => ACTOR_CASES.map((actorCase) => ({ ...caller, actorCase }))))(
    "P1 · $caller · $actorCase: a same-tuple profile committed after the action's zero-row scoped update makes its insert lose the primary key; the scoped reread and scoped update converge on that one row, changing only the supplied field — audited to the actor, revalidated once",
    async ({ run, written, event, actorCase }) => {
      const { team, actor, target } = await people(actorCase);
      const before = await contextState();
      premise("no profile exists yet", before.profiles, []);
      const scope = { team_id: team.teamId, member_id: target };
      const zeroUpdate = gate("the initial scoped update's zero-row envelope (captured stale read)", "after", profileUpdateOf(target));
      const client = gatedDb([zeroUpdate]);

      const { result, scheduled: competitor } = await through(client, () => run(team.teamSlug, target), async (reach) => {
        premise("the held scoped update really matched no row", (await reach(zeroUpdate)).outcome, ZERO_ROWS);
        const row = await insertProfile(team.teamId, target);
        premise("the competitor's same-tuple profile is committed", (await standingAfterCompetitor(before)).profiles, [row]);
        return row;
      });

      const after = await contextState();
      expect(admittedObservation(result, client, "member_profiles", before, after)).toEqual({
        result: { ok: true },
        trace: [
          { operation: "update", bound: scope, outcome: ZERO_ROWS },
          { operation: "insert", bound: scope, outcome: PROFILE_PK },
          { operation: "select", bound: scope, outcome: ONE_ROW },
          { operation: "update", bound: scope, outcome: ONE_ROW },
        ],
        // One row, still the original tuple; the competitor's other fields survive the partial write.
        profiles: [{ ...competitor, ...written, updated_by: actor, updated_at: expect.any(String) }],
        timeOff: before.timeOff,
        goals: before.goals,
        audit: [successAudit(team.teamId, actor, event, target)],
        revalidated: [peoplePath(team.teamSlug, target)],
      });
    },
  );

  it.each(
    PROFILE_CALLERS.flatMap((caller) =>
      [
        { when: "already standing before the action", raced: false },
        { when: "committed after the action's zero-row scoped update", raced: true },
      ].map((timing) => ({ ...caller, ...timing })),
    ),
  )(
    "P2 · $caller · the member's profile held under ANOTHER team, $when: the initial attempt and exactly two retries each lose the primary key and re-read no row in scope, then the action refuses not allowed — the contradictory row is neither repaired, re-homed nor overwritten, no audit, no revalidation",
    async ({ run, raced }) => {
      const { team, target } = await people("self");
      const foreign = await seedTeam();
      if (!raced) await insertProfile(foreign.teamId, target);
      const before = await contextState();
      const scope = { team_id: team.teamId, member_id: target };
      const zeroUpdate = gate("the initial scoped update's zero-row envelope (captured stale read)", "after", profileUpdateOf(target));
      const client = gatedDb(raced ? [zeroUpdate] : []);

      const { result, scheduled: standing } = await through(client, () => run(team.teamSlug, target), async (reach) => {
        if (!raced) return before;
        premise("the held scoped update really matched no row", (await reach(zeroUpdate)).outcome, ZERO_ROWS);
        await insertProfile(foreign.teamId, target);
        return standingAfterCompetitor(before);
      });
      premise(
        "the member's only profile is held under the other team",
        standing.profiles.map((row) => [row.member_id, row.team_id]),
        [[target, foreign.teamId]],
      );

      const after = await contextState();
      expect(standingObservation(result, client, "member_profiles", after)).toEqual({
        result: NOT_ALLOWED,
        trace: [
          { operation: "update", bound: scope, outcome: ZERO_ROWS },
          // initial attempt
          { operation: "insert", bound: scope, outcome: PROFILE_PK },
          { operation: "select", bound: scope, outcome: ZERO_ROWS },
          // retry 1 of 2
          { operation: "insert", bound: scope, outcome: PROFILE_PK },
          { operation: "select", bound: scope, outcome: ZERO_ROWS },
          // retry 2 of 2
          { operation: "insert", bound: scope, outcome: PROFILE_PK },
          { operation: "select", bound: scope, outcome: ZERO_ROWS },
        ],
        ...standing,
        revalidated: [],
      });
    },
  );

  it.each(PROFILE_CALLERS)(
    "P3 · $caller · admin-other: the same-tuple row the scoped reread returned is re-homed to another team before the scoped update — that update matches nothing, both remaining retries stay bound to the originally authenticated (team, target), and the action refuses not allowed with the re-homed row untouched",
    async ({ run }) => {
      const { team, target } = await people("admin-other");
      const foreign = await seedTeam();
      const before = await contextState();
      premise("no profile exists yet", before.profiles, []);
      const scope = { team_id: team.teamId, member_id: target };
      const zeroUpdate = gate("the initial scoped update's zero-row envelope (captured stale read)", "after", profileUpdateOf(target));
      const ownedReread = gate("the scoped reread's owned-row envelope (captured stale read)", "after", profileRereadOf(target));
      const client = gatedDb([zeroUpdate, ownedReread]);

      const { result, scheduled: standing } = await through(client, () => run(team.teamSlug, target), async (reach) => {
        premise("the held scoped update really matched no row", (await reach(zeroUpdate)).outcome, ZERO_ROWS);
        await insertProfile(team.teamId, target);
        premise("the held scoped reread really returned the same-tuple row", (await reach(ownedReread)).outcome, ONE_ROW);
        await fxOne(
          "competitor re-homes the profile",
          `update member_profiles set team_id = $1 where member_id = $2 and team_id = $3 returning *`,
          [foreign.teamId, target, team.teamId],
        );
        return standingAfterCompetitor(before);
      });
      premise(
        "the member's only profile now stands under the other team",
        standing.profiles.map((row) => [row.member_id, row.team_id]),
        [[target, foreign.teamId]],
      );

      const after = await contextState();
      expect(standingObservation(result, client, "member_profiles", after)).toEqual({
        result: NOT_ALLOWED,
        trace: [
          { operation: "update", bound: scope, outcome: ZERO_ROWS },
          // initial attempt: the reread saw the row, the scoped update no longer matches it
          { operation: "insert", bound: scope, outcome: PROFILE_PK },
          { operation: "select", bound: scope, outcome: ONE_ROW },
          { operation: "update", bound: scope, outcome: ZERO_ROWS },
          // retry 1 of 2
          { operation: "insert", bound: scope, outcome: PROFILE_PK },
          { operation: "select", bound: scope, outcome: ZERO_ROWS },
          // retry 2 of 2
          { operation: "insert", bound: scope, outcome: PROFILE_PK },
          { operation: "select", bound: scope, outcome: ZERO_ROWS },
        ],
        ...standing,
        revalidated: [],
      });
    },
  );

  it.each(PROFILE_CALLERS)(
    "P4 · $caller · self: a competing profile makes the initial insert lose the primary key and is removed before the scoped reread executes — the first of the two allowed retries inserts the authorized tuple with only the supplied field",
    async ({ run, written, event }) => {
      const { team, actor, target } = await people("self");
      const before = await contextState();
      premise("no profile exists yet", before.profiles, []);
      const scope = { team_id: team.teamId, member_id: target };
      const zeroUpdate = gate("the initial scoped update's zero-row envelope (captured stale read)", "after", profileUpdateOf(target));
      const reread = gate("immediately before the scoped reread", "before", profileRereadOf(target));
      const client = gatedDb([zeroUpdate, reread]);

      const { result } = await through(client, () => run(team.teamSlug, target), async (reach) => {
        premise("the held scoped update really matched no row", (await reach(zeroUpdate)).outcome, ZERO_ROWS);
        await insertProfile(team.teamId, target);
        premise("the scoped reread has not executed", (await reach(reread)).outcome, NOT_EXECUTED);
        await fxOne(
          "competitor removes its profile",
          `delete from member_profiles where member_id = $1 and team_id = $2 returning member_id`,
          [target, team.teamId],
        );
        premise("the conflict has cleared", (await standingAfterCompetitor(before)).profiles, []);
        return null;
      });

      const after = await contextState();
      expect(admittedObservation(result, client, "member_profiles", before, after)).toEqual({
        result: { ok: true },
        trace: [
          { operation: "update", bound: scope, outcome: ZERO_ROWS },
          // initial attempt
          { operation: "insert", bound: scope, outcome: PROFILE_PK },
          { operation: "select", bound: scope, outcome: ZERO_ROWS },
          // retry 1 of 2 clears
          { operation: "insert", bound: scope, outcome: ONE_ROW },
        ],
        // The removed competitor's content is not resurrected.
        profiles: [createdProfile(team.teamId, target, actor, written)],
        timeOff: before.timeOff,
        goals: before.goals,
        audit: [successAudit(team.teamId, actor, event, target)],
        revalidated: [peoplePath(team.teamSlug, target)],
      });
    },
  );

  it.each(PROFILE_CALLERS)(
    "[control] P · $caller · self, no profile yet: the scoped update matches nothing and one insert creates the authorized tuple with only the supplied field — audited and revalidated",
    async ({ run, written, event }) => {
      const { team, actor, target } = await people("self");
      const before = await contextState();
      premise("no profile exists yet", before.profiles, []);
      const scope = { team_id: team.teamId, member_id: target };
      const client = gatedDb();

      const result = await unbarriered(client, () => run(team.teamSlug, target));

      const after = await contextState();
      expect(admittedObservation(result, client, "member_profiles", before, after)).toEqual({
        result: { ok: true },
        trace: [
          { operation: "update", bound: scope, outcome: ZERO_ROWS },
          { operation: "insert", bound: scope, outcome: ONE_ROW },
        ],
        profiles: [createdProfile(team.teamId, target, actor, written)],
        timeOff: before.timeOff,
        goals: before.goals,
        audit: [successAudit(team.teamId, actor, event, target)],
        revalidated: [peoplePath(team.teamSlug, target)],
      });
    },
  );

  it.each(PROFILE_CALLERS)(
    "[control] P · $caller · admin-other, existing same-tuple profile: one scoped update changes only the supplied field, keeps the tuple and attributes the write to the admin actor",
    async ({ run, written, event }) => {
      const { team, actor, target } = await people("admin-other");
      const existing = await insertProfile(team.teamId, target);
      const before = await contextState();
      const client = gatedDb();

      const result = await unbarriered(client, () => run(team.teamSlug, target));

      const after = await contextState();
      expect(admittedObservation(result, client, "member_profiles", before, after)).toEqual({
        result: { ok: true },
        trace: [{ operation: "update", bound: { team_id: team.teamId, member_id: target }, outcome: ONE_ROW }],
        profiles: [{ ...existing, ...written, updated_by: actor, updated_at: expect.any(String) }],
        timeOff: before.timeOff,
        goals: before.goals,
        audit: [successAudit(team.teamId, actor, event, target)],
        revalidated: [peoplePath(team.teamSlug, target)],
      });
    },
  );
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// D — child deletes: the final DELETE is atomic on (team, member, id) (AC-10)
// ─────────────────────────────────────────────────────────────────────────────────────────────────

describe("AIO-1217 D · a child delete matches (team, member, id) in its final statement (AC-10)", () => {
  type ChildTable = "member_time_off" | "member_goals";
  type ChildRows = "timeOff" | "goals";

  const CHILD_DELETES: Array<{
    action: string;
    table: ChildTable;
    rows: ChildRows;
    event: string;
    seed: (teamId: string, memberId: string) => Promise<string>;
    run: (teamSlug: string, memberId: string, id: string) => Promise<ActionResult>;
  }> = [
    {
      action: "deleteMemberTimeOff",
      table: "member_time_off",
      rows: "timeOff",
      event: "timeoff.remove",
      seed: seedTimeOff,
      run: deleteMemberTimeOff,
    },
    {
      action: "deleteMemberGoal",
      table: "member_goals",
      rows: "goals",
      event: "goal.remove",
      seed: (teamId, memberId) => seedGoal(teamId, memberId, { title: `goal of ${memberId}` }),
      run: deleteMemberGoal,
    },
  ];

  type Displaced = { table: ChildTable; id: string; teamId: string; owner: string; peer: string; foreignTeamId: string };

  /** What a competitor commits to the chosen row, each guarded to exactly that row and its owner. */
  const DISPLACEMENTS: Array<{ displacement: string; commit: (row: Displaced) => Promise<Row> }> = [
    {
      displacement: "moved to a same-team peer",
      commit: ({ table, id, teamId, owner, peer }) =>
        fxOne(
          "competitor moves the row to a peer",
          `update ${table} set member_id = $1 where id = $2 and team_id = $3 and member_id = $4 returning *`,
          [peer, id, teamId, owner],
        ),
    },
    {
      displacement: "re-homed to another team",
      commit: ({ table, id, teamId, owner, foreignTeamId }) =>
        fxOne(
          "competitor re-homes the row",
          `update ${table} set team_id = $1 where id = $2 and team_id = $3 and member_id = $4 returning *`,
          [foreignTeamId, id, teamId, owner],
        ),
    },
    {
      // No ownership change is invented: the row is simply gone when the DELETE runs.
      displacement: "already deleted by a competitor",
      commit: ({ table, id, teamId, owner }) =>
        fxOne(
          "competitor deletes the row",
          `delete from ${table} where id = $1 and team_id = $2 and member_id = $3 returning *`,
          [id, teamId, owner],
        ),
    },
  ];

  it.each(CHILD_DELETES.flatMap((kind) => DISPLACEMENTS.map((displaced) => ({ ...kind, ...displaced }))))(
    "D · $action · the admitted target's own row is $displacement immediately before the final DELETE: the statement really matches zero rows and the action refuses not allowed — the standing rows equal the competitor's committed state, no removal audit, no revalidation",
    async ({ table, rows, seed, run, commit }) => {
      const { team, target, peer } = await people("self");
      const foreign = await seedTeam();
      const chosen = await seed(team.teamId, target);
      await seed(team.teamId, target);
      await seed(team.teamId, peer);
      const before = await contextState();
      const finalDelete = gate("immediately before the final DELETE", "before", at(table, "delete", { id: chosen }));
      const client = gatedDb([finalDelete]);

      const { result, scheduled: standing } = await through(client, () => run(team.teamSlug, target, chosen), async (reach) => {
        premise("the final DELETE has not executed", (await reach(finalDelete)).outcome, NOT_EXECUTED);
        await commit({ table, id: chosen, teamId: team.teamId, owner: target, peer, foreignTeamId: foreign.teamId });
        const committed = await standingAfterCompetitor(before);
        expect(committed[rows], `${FIXTURE} the competitor's change is committed`).not.toEqual(before[rows]);
        return committed;
      });

      const after = await contextState();
      expect(standingObservation(result, client, table, after)).toEqual({
        result: NOT_ALLOWED,
        trace: [
          { operation: "delete", bound: { team_id: team.teamId, member_id: target, id: chosen }, outcome: ZERO_ROWS },
        ],
        ...standing,
        revalidated: [],
      });
    },
  );

  it.each(CHILD_DELETES.flatMap((kind) => ACTOR_CASES.map((actorCase) => ({ ...kind, actorCase }))))(
    "[control] D · $action · $actorCase: the final DELETE matches exactly the chosen row of the admitted target — its sibling and the peer's row stay, the removal is audited to the actor and revalidated",
    async ({ table, rows, event, seed, run, actorCase }) => {
      const { team, actor, target, peer } = await people(actorCase);
      const chosen = await seed(team.teamId, target);
      await seed(team.teamId, target);
      await seed(team.teamId, peer);
      const before = await contextState();
      const remaining = (name: ChildRows) =>
        name === rows ? before[name].filter((row) => row.id !== chosen) : before[name];
      premise("three child rows are seeded and exactly one is chosen", [before[rows].length, remaining(rows).length], [3, 2]);
      const client = gatedDb();

      const result = await unbarriered(client, () => run(team.teamSlug, target, chosen));

      const after = await contextState();
      expect(admittedObservation(result, client, table, before, after)).toEqual({
        result: { ok: true },
        trace: [
          { operation: "delete", bound: { team_id: team.teamId, member_id: target, id: chosen }, outcome: ONE_ROW },
        ],
        profiles: before.profiles,
        timeOff: remaining("timeOff"),
        goals: remaining("goals"),
        audit: [successAudit(team.teamId, actor, event)],
        revalidated: [peoplePath(team.teamSlug, target)],
      });
    },
  );
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// G — goals: explicit-id and imported-dedup ownership races (AC-10; AC-03/04 argument half)
// ─────────────────────────────────────────────────────────────────────────────────────────────────

describe("AIO-1217 G · a goal write stays bound to the server-resolved target through every owner change (AC-10)", () => {
  const dedupReadOf = (externalId: string) => at("member_goals", "select", { source: "jira", external_id: externalId });
  const goalUpdateOf = (id: string) => at("member_goals", "update", { id });

  /** Untyped fields a browser can add to the serialized input: another member and the trusted mode. */
  const smuggled = (memberId: string) => ({
    memberId,
    member_id: memberId,
    mode: "system_import",
    scope: { mode: "system_import" },
  });

  it("G1 · explicit id: the target's own goal is moved to a same-team peer immediately before the scoped UPDATE — the statement really matches zero rows and the action refuses not allowed; the peer's owner, title and status stand as the competitor left them, no audit, no revalidation", async () => {
    const { team, target, peer } = await people("self");
    const goalId = await seedGoal(team.teamId, target, { title: "target manual goal" });
    await seedGoal(team.teamId, peer, { title: "peer manual goal" });
    const before = await contextState();
    const finalUpdate = gate("immediately before the scoped goal UPDATE", "before", goalUpdateOf(goalId));
    const client = gatedDb([finalUpdate]);

    const { result, scheduled: standing } = await through(
      client,
      () => saveMemberGoal(team.teamSlug, target, { id: goalId, ...GOAL_REVISION }),
      async (reach) => {
        premise("the scoped goal UPDATE has not executed", (await reach(finalUpdate)).outcome, NOT_EXECUTED);
        await moveGoal(goalId, team.teamId, target, peer);
        return standingAfterCompetitor(before);
      },
    );
    premise("the goal now stands under the peer", standing.goals.find((row) => row.id === goalId)?.member_id, peer);

    const after = await contextState();
    expect(standingObservation(result, client, "member_goals", after)).toEqual({
      result: NOT_ALLOWED,
      trace: [
        { operation: "update", bound: { team_id: team.teamId, id: goalId, member_id: target }, outcome: ZERO_ROWS },
      ],
      ...standing,
      revalidated: [],
    });
  });

  it.each(ACTOR_CASES)(
    "[control] G1 · explicit id · %s, no barrier: one scoped UPDATE rewrites the target's goal in place — same id and owner, the supplied title, detail and status, bystander goals untouched, audited to the actor and revalidated",
    async (actorCase) => {
      const { team, actor, target, peer } = await people(actorCase);
      const goalId = await seedGoal(team.teamId, target, { title: "target manual goal" });
      await seedGoal(team.teamId, target, { title: "target bystander goal" });
      await seedGoal(team.teamId, peer, { title: "peer manual goal" });
      const before = await contextState();
      const client = gatedDb();

      const result = await unbarriered(client, () => saveMemberGoal(team.teamSlug, target, { id: goalId, ...GOAL_REVISION }));

      const after = await contextState();
      expect(admittedObservation(result, client, "member_goals", before, after)).toEqual({
        result: { ok: true, id: goalId },
        trace: [
          { operation: "update", bound: { team_id: team.teamId, id: goalId, member_id: target }, outcome: ONE_ROW },
        ],
        profiles: before.profiles,
        timeOff: before.timeOff,
        goals: before.goals.map((row) => (row.id === goalId ? revised(row) : row)),
        audit: [successAudit(team.teamId, actor, "goal.set", target)],
        revalidated: [peoplePath(team.teamSlug, target)],
      });
    },
  );

  it("G2 · imported dedup: the dedup read names the target, the row is moved to a same-team peer, and the scoped UPDATE — still bound to the ORIGINAL target — matches zero; the next dedup read sees the peer and the action refuses not allowed with no reassignment, content change or duplicate row", async () => {
    const { team, target, peer } = await people("self");
    const goalId = await seedGoal(team.teamId, target, { title: "target imported goal", source: "jira", externalId: IMPORT_KEY });
    await seedGoal(team.teamId, peer, { title: "peer manual goal" });
    const before = await contextState();
    const key = { team_id: team.teamId, source: "jira", external_id: IMPORT_KEY };
    const staleOwner = gate("the dedup owner read's envelope naming the target (captured stale read)", "after", dedupReadOf(IMPORT_KEY));
    const client = gatedDb([staleOwner]);

    const { result, scheduled: standing } = await through(
      client,
      () => saveMemberGoal(team.teamSlug, target, { ...GOAL_REVISION, source: "jira", externalId: IMPORT_KEY }),
      async (reach) => {
        premise("the held dedup read really returned the target's row", (await reach(staleOwner)).outcome, ONE_ROW);
        await moveGoal(goalId, team.teamId, target, peer);
        return standingAfterCompetitor(before);
      },
    );
    premise("the imported goal now stands under the peer", standing.goals.find((row) => row.id === goalId)?.member_id, peer);

    const after = await contextState();
    expect(standingObservation(result, client, "member_goals", after)).toEqual({
      result: NOT_ALLOWED,
      trace: [
        { operation: "select", bound: key, outcome: ONE_ROW },
        { operation: "update", bound: { team_id: team.teamId, id: goalId, member_id: target }, outcome: ZERO_ROWS },
        { operation: "select", bound: key, outcome: ONE_ROW },
      ],
      ...standing,
      revalidated: [],
    });
  });

  /** G3 schedule: hold the action's absent dedup read, then a competitor inserts the same key for `owner`. */
  async function raceTheAbsentKey(owner: "target" | "peer") {
    const { team, actor, target, peer } = await people("self");
    await seedGoal(team.teamId, peer, { title: "peer manual goal" });
    const before = await contextState();
    const absentRead = gate("the initial dedup read's absent envelope (captured stale read)", "after", dedupReadOf(IMPORT_KEY));
    const client = gatedDb([absentRead]);

    const { result, scheduled } = await through(
      client,
      () => saveMemberGoal(team.teamSlug, target, { ...GOAL_REVISION, source: "jira", externalId: IMPORT_KEY }),
      async (reach) => {
        premise("the held dedup read really found no row", (await reach(absentRead)).outcome, ZERO_ROWS);
        const competitorId = await seedGoal(team.teamId, owner === "target" ? target : peer, {
          title: "competitor imported goal",
          source: "jira",
          externalId: IMPORT_KEY,
        });
        return { competitorId, standing: await standingAfterCompetitor(before) };
      },
    );
    const key = { team_id: team.teamId, source: "jira", external_id: IMPORT_KEY };
    return { team, actor, target, before, client, result, key, ...scheduled, after: await contextState() };
  }

  it("G3 · imported dedup · the absent key is inserted for the TARGET after the action's absent read: the action's insert really loses the team-wide import index, the re-read finds the target's own row and the scoped UPDATE converges on it — the competitor's id is returned, one row holds the key, audited and revalidated", async () => {
    const { team, actor, target, before, client, result, key, competitorId, standing, after } = await raceTheAbsentKey("target");

    expect(admittedObservation(result, client, "member_goals", before, after)).toEqual({
      result: { ok: true, id: competitorId },
      trace: [
        { operation: "select", bound: key, outcome: ZERO_ROWS },
        { operation: "insert", bound: { ...key, member_id: target }, outcome: GOAL_IMPORT_KEY },
        { operation: "select", bound: key, outcome: ONE_ROW },
        { operation: "update", bound: { team_id: team.teamId, id: competitorId, member_id: target }, outcome: ONE_ROW },
      ],
      profiles: standing.profiles,
      timeOff: standing.timeOff,
      goals: standing.goals.map((row) => (row.id === competitorId ? revised(row) : row)),
      audit: [successAudit(team.teamId, actor, "goal.set", target)],
      revalidated: [peoplePath(team.teamSlug, target)],
    });
  });

  it("G3 · imported dedup · the absent key is inserted for a same-team PEER after the action's absent read: the action's insert really loses the team-wide import index, the re-read finds the peer's row and the action refuses not allowed — the peer's owner and content unchanged, no second row, no audit, no revalidation", async () => {
    const { target, client, result, key, standing, after } = await raceTheAbsentKey("peer");

    expect(standingObservation(result, client, "member_goals", after)).toEqual({
      result: NOT_ALLOWED,
      trace: [
        { operation: "select", bound: key, outcome: ZERO_ROWS },
        { operation: "insert", bound: { ...key, member_id: target }, outcome: GOAL_IMPORT_KEY },
        { operation: "select", bound: key, outcome: ONE_ROW },
      ],
      ...standing,
      revalidated: [],
    });
  });

  it("[control] G3 · imported dedup · no competitor: the dedup read finds nothing and one insert creates the target's imported goal under the supplied key — audited and revalidated", async () => {
    const { team, actor, target, peer } = await people("self");
    await seedGoal(team.teamId, peer, { title: "peer manual goal" });
    const before = await contextState();
    const key = { team_id: team.teamId, source: "jira", external_id: IMPORT_KEY };
    const client = gatedDb();

    const result = await unbarriered(client, () =>
      saveMemberGoal(team.teamSlug, target, { ...GOAL_REVISION, source: "jira", externalId: IMPORT_KEY }),
    );

    const after = await contextState();
    expect({
      ...admittedObservation(result, client, "member_goals", before, after),
      goals: after.goals.filter((row) => row.id !== result.id),
      created: after.goals.filter((row) => row.id === result.id),
    }).toEqual({
      result: { ok: true, id: expect.any(String) },
      trace: [
        { operation: "select", bound: key, outcome: ZERO_ROWS },
        { operation: "insert", bound: { ...key, member_id: target }, outcome: ONE_ROW },
      ],
      profiles: before.profiles,
      timeOff: before.timeOff,
      goals: before.goals,
      created: [
        {
          id: result.id,
          team_id: team.teamId,
          member_id: target,
          kind: GOAL_REVISION.kind,
          title: GOAL_REVISION.title,
          detail: GOAL_REVISION.detail,
          status: GOAL_REVISION.status,
          target_date: null,
          source: "jira",
          external_id: IMPORT_KEY,
          created_at: expect.any(String),
          updated_at: expect.any(String),
        },
      ],
      audit: [successAudit(team.teamId, actor, "goal.set", target)],
      revalidated: [peoplePath(team.teamSlug, target)],
    });
  });

  it("G4 · explicit id onto a peer's imported key: the scoped UPDATE of the target's OWN goal really violates the team-wide import index and the action refuses not allowed — both rows unchanged, no audit, no revalidation", async () => {
    const { team, target, peer } = await people("self");
    const ownGoalId = await seedGoal(team.teamId, target, { title: "target manual goal" });
    await seedGoal(team.teamId, peer, { title: "peer imported goal", source: "jira", externalId: PEER_IMPORT_KEY });
    const before = await contextState();
    const client = gatedDb();

    const result = await unbarriered(client, () =>
      saveMemberGoal(team.teamSlug, target, { id: ownGoalId, ...GOAL_REVISION, source: "jira", externalId: PEER_IMPORT_KEY }),
    );

    const after = await contextState();
    expect(standingObservation(result, client, "member_goals", after)).toEqual({
      result: NOT_ALLOWED,
      trace: [
        { operation: "update", bound: { team_id: team.teamId, id: ownGoalId, member_id: target }, outcome: GOAL_IMPORT_KEY },
      ],
      ...before,
      revalidated: [],
    });
  });

  it("G5 · imported dedup · bounded exhaustion on GENUINE zero rows: the target's row is moved to a peer immediately before each scoped UPDATE and restored before each next dedup read — the initial attempt and exactly two retries each read the target and match nothing, then the action refuses not allowed with no fourth read, no blind write and the content untouched", async () => {
    const { team, target, peer } = await people("self");
    const goalId = await seedGoal(team.teamId, target, { title: "target imported goal", source: "jira", externalId: IMPORT_KEY });
    const before = await contextState();
    const key = { team_id: team.teamId, source: "jira", external_id: IMPORT_KEY };
    const beforeUpdate = () => gate("immediately before the scoped goal UPDATE", "before", goalUpdateOf(goalId));
    const beforeNextRead = () => gate("immediately before the next dedup owner read", "before", dedupReadOf(IMPORT_KEY));
    // The first dedup read is not gated: the script's head is an UPDATE gate, so that read passes through.
    const displacements = [
      { barrier: beforeUpdate(), from: target, to: peer },
      { barrier: beforeNextRead(), from: peer, to: target },
      { barrier: beforeUpdate(), from: target, to: peer },
      { barrier: beforeNextRead(), from: peer, to: target },
      { barrier: beforeUpdate(), from: target, to: peer },
    ];
    const client = gatedDb(displacements.map(({ barrier }) => barrier));

    const { result, scheduled: standing } = await through(
      client,
      () => saveMemberGoal(team.teamSlug, target, { ...GOAL_REVISION, source: "jira", externalId: IMPORT_KEY }),
      async (reach) => {
        for (const { barrier, from, to } of displacements) {
          premise(`the statement held ${barrier.label} has not executed`, (await reach(barrier)).outcome, NOT_EXECUTED);
          await moveGoal(goalId, team.teamId, from, to);
        }
        return standingAfterCompetitor(before);
      },
    );
    premise(
      "the competitor's last committed state: the same row, under the peer, content as seeded",
      standing.goals,
      before.goals.map((row) => ({ ...row, member_id: peer })),
    );

    const after = await contextState();
    const scopedUpdate = { team_id: team.teamId, id: goalId, member_id: target };
    expect(standingObservation(result, client, "member_goals", after)).toEqual({
      result: NOT_ALLOWED,
      trace: [
        // initial attempt
        { operation: "select", bound: key, outcome: ONE_ROW },
        { operation: "update", bound: scopedUpdate, outcome: ZERO_ROWS },
        // retry 1 of 2
        { operation: "select", bound: key, outcome: ONE_ROW },
        { operation: "update", bound: scopedUpdate, outcome: ZERO_ROWS },
        // retry 2 of 2
        { operation: "select", bound: key, outcome: ONE_ROW },
        { operation: "update", bound: scopedUpdate, outcome: ZERO_ROWS },
      ],
      ...standing,
      revalidated: [],
    });
  });

  it.each(ACTOR_CASES)(
    "G6 · extra input fields · %s: an explicit-id update carrying an untyped memberId/member_id naming a peer and mode/scope system_import still writes the server-resolved target's goal in place — the owner never follows the extra fields, title, detail and status are exactly the supplied ones",
    async (actorCase) => {
      const { team, actor, target, peer } = await people(actorCase);
      const goalId = await seedGoal(team.teamId, target, { title: "target manual goal" });
      await seedGoal(team.teamId, peer, { title: "peer manual goal" });
      const before = await contextState();
      const input = { id: goalId, ...GOAL_REVISION, ...smuggled(peer) } as unknown as GoalInput;
      const client = gatedDb();

      const result = await unbarriered(client, () => saveMemberGoal(team.teamSlug, target, input));

      const after = await contextState();
      expect(admittedObservation(result, client, "member_goals", before, after)).toEqual({
        result: { ok: true, id: goalId },
        trace: [
          { operation: "update", bound: { team_id: team.teamId, id: goalId, member_id: target }, outcome: ONE_ROW },
        ],
        profiles: before.profiles,
        timeOff: before.timeOff,
        goals: before.goals.map((row) => (row.id === goalId ? revised(row) : row)),
        audit: [successAudit(team.teamId, actor, "goal.set", target)],
        revalidated: [peoplePath(team.teamSlug, target)],
      });
    },
  );

  it("G6 · extra input fields · self: mode/scope system_import and a memberId naming the peer unlock neither the peer's explicit goal id nor the peer's imported key — each call refuses not allowed on its own, with the peer's rows, the ledger and the cache unchanged", async () => {
    const { team, target, peer } = await people("self");
    const peerGoalId = await seedGoal(team.teamId, peer, { title: "peer manual goal" });
    await seedGoal(team.teamId, peer, { title: "peer imported goal", source: "jira", externalId: PEER_IMPORT_KEY });
    const before = await contextState();

    const byId = gatedDb();
    const byIdResult = await unbarriered(byId, () =>
      saveMemberGoal(team.teamSlug, target, { id: peerGoalId, ...GOAL_REVISION, ...smuggled(peer) } as unknown as GoalInput),
    );
    // Each refusal is observed on its own, against the state captured before that invocation.
    const afterById = await contextState();
    const revalidatedAfterById = revalidatedPaths();

    const byKey = gatedDb();
    const byKeyResult = await unbarriered(byKey, () =>
      saveMemberGoal(team.teamSlug, target, {
        ...GOAL_REVISION,
        source: "jira",
        externalId: PEER_IMPORT_KEY,
        ...smuggled(peer),
      } as unknown as GoalInput),
    );
    const afterByKey = await contextState();

    expect({
      byId: { result: byIdResult, trace: traceOf(byId, "member_goals"), ...afterById, revalidated: revalidatedAfterById },
      byKey: standingObservation(byKeyResult, byKey, "member_goals", afterByKey),
    }).toEqual({
      byId: {
        result: NOT_ALLOWED,
        trace: [
          { operation: "update", bound: { team_id: team.teamId, id: peerGoalId, member_id: target }, outcome: ZERO_ROWS },
        ],
        ...before,
        revalidated: [],
      },
      byKey: {
        result: NOT_ALLOWED,
        // The peer's match is a refusal at the read: never "no match", so nothing is inserted or updated.
        trace: [
          { operation: "select", bound: { team_id: team.teamId, source: "jira", external_id: PEER_IMPORT_KEY }, outcome: ONE_ROW },
        ],
        ...afterById,
        revalidated: [],
      },
    });
  });
});
