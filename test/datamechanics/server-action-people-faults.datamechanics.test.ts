import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PgClient } from "@/lib/db/pg/client";
import { getPool } from "@/lib/db/pg/pool";
import type { DbClient } from "@/lib/db/types";
import { isUniqueViolation } from "@/lib/ids";
import type { GoalInput } from "@/lib/identity/profile";
import { placeMemberByTier, seedTeam } from "./helpers";

/**
 * AIO-1217 — People FAULT CLASSIFICATION and the trusted-import race control, against real Postgres
 * (AC-09, AC-10; AC-03/04 argument half).
 *
 * Every assertion is derived from the accepted specification's "Targeted runtime correction B", not
 * from the implementation: an infrastructure failure at any writer phase stays an infrastructure
 * failure — it is never reinterpreted as an absent row, a lost race or the fixed scope refusal — and
 * only a refused SCOPE answers the fixed "not allowed". Only a confirmed write audits and
 * revalidates. An unreadable or absent target fails closed at the gate, before any writer. The
 * trusted `system_import` arm keeps its deliberate team-wide convergence and reassignment, stays
 * team-bound, and is selected by an explicit mode only. The ownership races themselves live in
 * `server-action-people-races.datamechanics.test.ts` and are neither repeated nor counted here.
 *
 *   E    — one failing statement per case, at each writer phase: profile/avatar initial scoped
 *          update, insert (nonunique), scoped reread after a REAL primary-key conflict, scoped retry
 *          update; time-off insert; goal dedup lookup, insert (nonunique), update (nonunique); each
 *          child DELETE. Every phase runs once against the direct writer (the rejection is an Error
 *          that is not ProfileScopeRefusal) and once through the real action (the result is not the
 *          fixed "not allowed"; no success audit, no revalidation). saveProfile and saveAvatar share
 *          one persistence path, so the two callers alternate across its four phases instead of
 *          repeating every combination; both have an admitted control here.
 *   gate — the target-member lookup of the real `gate`, for all six exports: an injected returned
 *          error, and a valid id no member holds (a native zero-row read). Both refuse not allowed
 *          with no statement issued through the writer client.
 *   T    — direct `setMemberGoal` under an explicit `system_import` scope: a competing native insert
 *          wins the imported key and the importer converges on / reassigns that row within its team;
 *          a row re-homed to another team is refused; another team's identical key is not converged
 *          on; an omitted or invalid mode refuses before any statement.
 *
 * What is real: the six People exports, their `gate`, `currentMember`, `canEditMemberContext`, the
 * posture resolver, the profile single writer, the audit writer and a real `PgClient` over the test
 * pool. What is stubbed: ONLY "who is signed in" (a synthetic auth-user id — the member, role and
 * posture behind it are real rows), `revalidatePath`, and the two client factories: `adminClient()`
 * hands the action's writer a tapped real adapter and `serverClient()` hands its gate (and
 * `currentMember`) another, for the duration of one call. The second factory seam exists because
 * the gate reads through `serverClient()`: the target lookup cannot be reached from `adminClient()`.
 * No writer and no persistence is mocked; the direct cases pass the same tapped real adapter to the
 * real writer exports.
 *
 * THE INJECTION SEAM IS SYNTHETIC. `tappedDb` wraps the builders a real `PgClient` returns and
 * identifies a statement by what the caller built (table, operation, the row/key it names, and
 * which occurrence it is). At most one fault is armed per client, for exactly one statement:
 *
 *   returned error      the statement is NOT sent: the caller receives `{ data: null, error }` in its
 *                       place. This is the shape the adapter gives a failed statement (it never
 *                       rejects), with a message that is not a unique violation.
 *   thrown rejection    the statement is NOT sent: awaiting the builder rejects. The real adapter
 *                       never does this; it is included, labelled, for the action's catch path only.
 *   lost response       the statement REALLY executes and commits; its real envelope is then
 *                       replaced by a returned error. The write stands despite the failure answer.
 *
 * None of these is a native driver failure, and none fakes a constraint: the unique conflicts the
 * reread and retry phases follow are real primary-key violations, and the one native failure in
 * this file (a foreign-key violation after the target member is deleted) is labelled as such. Every
 * case asserts its fault fired exactly once, on the recorded statement, and reads the standing rows
 * and the audit ledger back from the pool — never from an adapter envelope.
 *
 * Barriers are used only where a phase cannot otherwise be reached (the retry update, the trusted
 * race, the foreign-key race). As in the races file: `before` holds a statement Postgres has not
 * seen, `after` holds a real envelope before the caller receives it (a captured stale read); a gate
 * holds no connection, nothing is ordered by time, every gate is released in `finally`, and the
 * competitor's raw SQL is fixture setup — never an alternate production writer. A barrier that was
 * not reached, a call that settled early, an injection that did not fire or a competitor statement
 * that did not land fails with the `FIXTURE` prefix and is never a security observation.
 *
 * Bounds of what is claimed. The infrastructure answer is asserted as the People actions' current
 * fail path (the writer's own phase label and the adapter message): no sanitized driver-error
 * contract is asserted for this family, and none exists. Target admission is not re-derived after
 * the gate. Audit is best effort in production; the healthy local ledger is asserted for admitted
 * writes, and a failure must add nothing to it. There is no production `system_import` caller: the
 * T cases call the primitive directly and expose no mode selection to a browser. No replay,
 * idempotency or automatic repair is exercised or promised. Direct action execution is not Next
 * action-wire proof.
 */

const FIXTURE = "FIXTURE PREMISE FAILED (setup, not a security observation):";

const h = vi.hoisted(() => ({
  sessionUser: null as { id: string; email: string } | null,
  /** When set, the client `adminClient()` hands the action's writer: a tapped real adapter. */
  actionDb: null as import("@/lib/db/types").DbClient | null,
  /** When set, the client `serverClient()` hands the action's gate and `currentMember`. */
  gateDb: null as import("@/lib/db/types").DbClient | null,
  revalidatePath: vi.fn(),
}));

// Request identity only: the membership, role and posture behind this auth-user id are real rows.
vi.mock("@/lib/auth/session", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth/session")>()),
  getSessionUser: async () => h.sessionUser,
}));
vi.mock("next/cache", () => ({ revalidatePath: h.revalidatePath }));
// The real service client unless a test hands the action's writer a tapped adapter.
vi.mock("@/lib/db/admin", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/db/admin")>();
  return { ...original, adminClient: () => h.actionDb ?? original.adminClient() };
});
// The real server client unless a test hands the action's gate a tapped adapter.
vi.mock("@/lib/db/server", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/db/server")>();
  return { ...original, serverClient: async () => h.gateDb ?? original.serverClient() };
});

import {
  addMemberTimeOff,
  deleteMemberGoal,
  deleteMemberTimeOff,
  saveAvatar,
  saveMemberGoal,
  saveProfile,
} from "@/app/t/[team]/people/[handle]/actions";
import {
  ProfileScopeRefusal,
  addTimeOff,
  removeMemberGoal,
  removeTimeOff,
  setMemberAvatar,
  setMemberGoal,
  setMemberProfile,
} from "@/lib/identity/profile";

type Row = Record<string, unknown>;
type Role = "admin" | "lead" | "member";
type ActionResult = { ok: boolean; error?: string; id?: string };
type ActorCase = "self" | "admin-other";

const ACTOR_CASES: ActorCase[] = ["self", "admin-other"];
const NOT_ALLOWED = { ok: false, error: "not allowed" };

const SEEDED_AVATAR = "data:image/png;base64,QkI=";
const VALID_AVATAR = "data:image/png;base64,AA==";
const ACTION_BIO = "aio1217 action-authored bio";
const IMPORT_KEY = "AIO1217-FAULT-OKR-1";
const TIME_OFF = {
  startsOn: "2026-11-02",
  endsOn: "2026-11-06",
  kind: "pto" as const,
  note: "aio1217 synthetic time off",
};
/** Every content field a goal write sets, so an admitted update is compared field by field. */
const GOAL_REVISION = {
  kind: "okr",
  title: "aio1217 revised goal title",
  detail: "aio1217 revised goal detail",
  status: "done",
} as const;
const IMPORTED_REVISION: GoalInput = { ...GOAL_REVISION, source: "jira", externalId: IMPORT_KEY };

const BROWSER_MEMBER = { mode: "browser_member" } as const;
const SYSTEM_IMPORT = { mode: "system_import" } as const;
/** The trusted importer authenticates nobody: its writes are attributed to the system. */
const SYSTEM_ACTOR = { actor: { kind: "system" as const } };

// What Postgres really answered a recorded statement.
const NOT_EXECUTED = "not yet executed";
const ZERO_ROWS = "0 rows";
const ONE_ROW = "1 row";
const PROFILE_PK = "unique violation: member_profiles_pkey";
const GOAL_IMPORT_KEY = "unique violation: member_goals_source_ext_unq";

// The three synthetic fault modes. None is a native driver failure.
const RETURNED = "returned error";
const THROWN = "thrown rejection";
const LOST = "lost response";
type FaultMode = typeof RETURNED | typeof THROWN | typeof LOST;

/** One distinct marker per mode, so a result names the injection that produced it. */
const FAULT_MESSAGE: Record<FaultMode, string> = {
  [RETURNED]: "aio1217 synthetic returned persistence fault",
  [THROWN]: "aio1217 synthetic thrown builder rejection",
  [LOST]: "aio1217 synthetic lost acknowledgement",
};
/** What the tap records for the faulted statement in place of a real answer. */
const FAULT_OUTCOME: Record<FaultMode, string> = {
  [RETURNED]: "injected returned error: statement not executed",
  [THROWN]: "injected thrown rejection: statement not executed",
  [LOST]: "really executed; envelope then replaced by an injected returned error",
};

beforeEach(() => {
  h.sessionUser = null;
  h.actionDb = null;
  h.gateDb = null;
  h.revalidatePath.mockReset();
});

afterEach(() => {
  h.actionDb = null;
  h.gateDb = null;
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
async function signIn(teamId: string, memberId: string, role: Role): Promise<{ id: string; email: string }> {
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
  return user;
}

/** One team with three distinct active members and nobody signed in. */
async function roster() {
  const team = await seedTeam();
  const second = await addMember(team.teamId);
  const third = await addMember(team.teamId);
  return { team, first: team.memberId, second, third };
}

/**
 * `self`: an ordinary member is both actor and target. `admin-other`: an admin actor edits a
 * different member as the target. `peer` is never the actor or the target. `session` is the
 * synthetic auth user the real membership lookup is bound to.
 */
async function people(actorCase: ActorCase) {
  const { team, first, second, third } = await roster();
  const session = await signIn(team.teamId, first, actorCase === "self" ? "member" : "admin");
  return { team, actor: first, target: actorCase === "self" ? first : second, peer: third, session };
}

type Ids = Awaited<ReturnType<typeof people>>;

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

/** The goal row an admitted `GOAL_REVISION` write leaves: content replaced, key untouched. */
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

/** A trusted import's ledger row: attributed to the system, targeting the member it wrote for. */
const systemGoalAudit = (teamId: string, memberId: string) =>
  expect.objectContaining({
    team_id: teamId,
    actor_kind: "system",
    member_id: null,
    action: "goal.set",
    target_type: "member",
    target_id: memberId,
  });

// ── tapped adapter ───────────────────────────────────────────────────────────────────────────────

type Operation = "select" | "insert" | "update" | "upsert" | "delete";
type Envelope = { data: unknown; error: { message: string } | null; count: number | null };
/** What the caller built, read off the builder calls — never off the SQL text. */
type Built = { table: string; operation: Operation; payload: unknown; filters: Array<[string, unknown]> };
type Matcher = (statement: Built) => boolean;
/** One statement issued through a tapped client: the tuple it is bound to and what answered it. */
type Statement = { table: string; operation: Operation; bound: Row; outcome: string };
type Traced = { operation: Operation; bound: Row; outcome: unknown };
type Gate = {
  label: string;
  phase: "before" | "after";
  at: Matcher;
  reached: Promise<Statement>;
  arrive: (held: Statement) => void;
  released: Promise<void>;
  release: () => void;
};
/** One synthetic fault, armed for the `nth` statement `at` identifies and no other. */
type Fault = {
  label: string;
  at: Matcher;
  nth: number;
  mode: FaultMode;
  message: string;
  /** How many statements `at` has identified so far. */
  matched: number;
  /** The statements this fault replaced: exactly one once the call has settled. */
  fired: Statement[];
};
type Tapped = { db: DbClient; script: Gate[]; fault?: Fault; statements: Statement[]; unreached: () => string[] };

/** The identifiers a statement can be bound to: tenant, owner, row, import key and session user. */
const SCOPE_COLUMNS = ["team_id", "member_id", "id", "source", "external_id", "auth_user_id"];

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

/** A synthetic fault at the `nth` statement `at` identifies. Its marker is never a unique violation. */
function fault(label: string, at: Matcher, mode: FaultMode, nth = 1): Fault {
  const message = FAULT_MESSAGE[mode];
  premise("the synthetic marker is not a unique-violation message", isUniqueViolation(message), false);
  return { label, at, nth, mode, message, matched: 0, fired: [] };
}

/** `identity` names the row or key the statement is about. */
const at = (table: string, operation: Operation, identity: Row = {}): Matcher => (built) => {
  if (built.table !== table || built.operation !== operation) return false;
  const bound = boundOf(built);
  return Object.entries(identity).every(([column, value]) => bound[column] === value);
};

/**
 * The gate's target-member lookup and nothing else: a `members` read bound to EXACTLY (team, id).
 * `currentMember`'s own lookup is bound to the session's auth-user id and carries no `id`
 * predicate, so it can never be the statement this identifies — even when actor and target match.
 */
const targetLookupOf = (teamId: string, memberId: string): Matcher => (built) => {
  if (built.table !== "members" || built.operation !== "select") return false;
  const bound = boundOf(built);
  return Object.keys(bound).length === 2 && bound.team_id === teamId && bound.id === memberId;
};

/**
 * A real pg adapter whose builders are observed, held and — for at most one statement — faulted.
 * `script` is ordered: only its head is armed, it fires on the first statement it matches, and the
 * next gate arms after it. With neither a script nor a fault it is a plain recording tap.
 */
function tappedDb(options: { script?: Gate[]; fault?: Fault } = {}): Tapped {
  const real = new PgClient();
  const script = options.script ?? [];
  const injection = options.fault;
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
      const faulted = injection && injection.at(built) && ++injection.matched === injection.nth ? injection : undefined;
      if (faulted && faulted.mode !== LOST) {
        // Pre-statement: the underlying builder is never awaited, so Postgres never sees it.
        const replaced: Statement = { ...shape, outcome: FAULT_OUTCOME[faulted.mode] };
        statements.push(replaced);
        faulted.fired.push(replaced);
        if (faulted.mode === THROWN) throw new Error(faulted.message);
        return { data: null, error: { message: faulted.message }, count: null };
      }
      const result = (await target) as Envelope;
      const answered = outcomeOf(result);
      const seen: Statement = { ...shape, outcome: faulted ? `${answered}; ${FAULT_OUTCOME[LOST]}` : answered };
      statements.push(seen);
      if (hit?.phase === "after") {
        hit.arrive(seen);
        await hit.released;
      }
      if (faulted) {
        // Lost response: the statement committed; only its acknowledgement is replaced.
        faulted.fired.push(seen);
        return { data: null, error: { message: faulted.message }, count: null };
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
    fault: injection,
    statements,
    unreached: () => pending.map((barrier) => barrier.label),
  };
}

/** The statements issued on `table` through a tapped client, in order. */
const traceOf = (client: Tapped, table: string): Traced[] =>
  client.statements
    .filter((statement) => statement.table === table)
    .map(({ operation, bound, outcome }) => ({ operation, bound, outcome }));

/**
 * The `members` reads of an admitted gate, in order: `currentMember` resolves the session's
 * auth-user to one active member of the team, THEN the target lookup answers `targetOutcome`.
 */
const gateTrace = (teamId: string, authUserId: string, target: string, targetOutcome: string = ONE_ROW): Traced[] => [
  { operation: "select", bound: { team_id: teamId, auth_user_id: authUserId }, outcome: ONE_ROW },
  { operation: "select", bound: { team_id: teamId, id: target }, outcome: targetOutcome },
];

// ── call drivers ─────────────────────────────────────────────────────────────────────────────────

/** How a call ended: what it returned, or how its rejection classifies. */
type Settled<T> = { returned: T } | { rejected: { error: boolean; scopeRefusal: boolean; message: string } };
type Reach = (barrier: Gate) => Promise<Statement>;
/** Which factory seams the call is given: an action gets its writer client and its gate client. */
type Seams = { action?: boolean; gate?: Tapped };

async function settle<T>(start: () => Promise<T>): Promise<Settled<T>> {
  try {
    return { returned: await start() };
  } catch (thrown) {
    return {
      rejected: {
        error: thrown instanceof Error,
        scopeRefusal: thrown instanceof ProfileScopeRefusal,
        message: thrown instanceof Error ? thrown.message : String(thrown),
      },
    };
  }
}

/** A direct-writer rejection that is infrastructure: an Error, and NOT the typed scope refusal. */
const infrastructure = (message: string) => ({ rejected: { error: true, scopeRefusal: false, message } });
/** A direct-writer rejection that is the typed scope refusal. */
const SCOPE_REFUSED = { rejected: { error: true, scopeRefusal: true, message: expect.any(String) } };

/**
 * Start a call against `client` and drive its barriers. `schedule` calls `reach(gate)` for each
 * gate in script order: it resolves with the held statement once the call is parked there (the
 * previous gate is released first), and fails as a fixture premise if the call settled instead.
 * Every gate is released and the call awaited before this returns or throws; an armed fault that
 * did not fire exactly once is a fixture premise failure.
 */
async function drive<T, S>(
  client: Tapped,
  start: () => Promise<T>,
  schedule: (reach: Reach) => Promise<S>,
  seams: Seams = {},
): Promise<{ outcome: Settled<T>; scheduled: S }> {
  if (seams.action) {
    h.actionDb = client.db;
    h.gateDb = seams.gate?.db ?? null;
  }
  const call = settle(start);
  const settled = call.then((outcome) => ({ settled: String(JSON.stringify(outcome)) }));
  let holding: Gate | null = null;
  let reachedCount = 0;
  const reach: Reach = async (barrier) => {
    if (client.script[reachedCount] !== barrier) {
      throw new Error(`${FIXTURE} the barrier "${barrier.label}" was awaited out of script order`);
    }
    holding?.release();
    const winner = await Promise.race([barrier.reached, settled]);
    if ("settled" in winner) {
      throw new Error(`${FIXTURE} the call settled (${winner.settled}) before reaching the barrier "${barrier.label}"`);
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
    await call;
    h.actionDb = null;
    h.gateDb = null;
  }
  premise("every barrier in the script was reached", client.unreached(), []);
  for (const tap of [client, seams.gate]) {
    if (tap?.fault) premise(`the injection at ${tap.fault.label} fired exactly once`, tap.fault.fired.length, 1);
  }
  return { outcome: await call, scheduled };
}

const unraced = async () => null;

/** Run a real action: `writer` is what `adminClient()` hands it, `gateTap` what `serverClient()` does. */
const runAction = async <T>(writer: Tapped, gateTap: Tapped, start: () => Promise<T>): Promise<Settled<T>> =>
  (await drive(writer, start, unraced, { action: true, gate: gateTap })).outcome;

/** Run a direct writer call that was itself handed `client.db`. No factory seam is involved. */
const runDirect = async <T>(client: Tapped, start: () => Promise<T>): Promise<Settled<T>> =>
  (await drive(client, start, unraced)).outcome;

const profileUpdateOf = (memberId: string) => at("member_profiles", "update", { member_id: memberId });
const dedupReadOf = (externalId: string) => at("member_goals", "select", { source: "jira", external_id: externalId });
const goalUpdateOf = (id: string) => at("member_goals", "update", { id });

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// E — a failing statement at each writer phase stays infrastructure (AC-09, AC-10)
// ─────────────────────────────────────────────────────────────────────────────────────────────────

describe("AIO-1217 E · an infrastructure failure at a People writer phase is never an absent row or a scope refusal (AC-09, AC-10)", () => {
  const DIRECT = "direct writer";
  const ACTION = "action";
  type Entry = typeof DIRECT | typeof ACTION;
  const ENTRIES: Entry[] = [DIRECT, ACTION];

  /** One writer phase: the fixture it needs, the one statement that fails, and both ways in. */
  type Plan = {
    table: string;
    injectAt: Matcher;
    /** Which matching statement fails; the first unless stated. */
    nth?: number;
    /** The writer's own phase label for a returned adapter error. */
    failed: string;
    direct: (db: DbClient) => Promise<unknown>;
    action: () => Promise<ActionResult>;
    /** Every statement the writer may issue on `table`, ending at the faulted one. */
    trace: (faulted: string) => Traced[];
    /** A competitor schedule, only where the phase cannot be reached without one. */
    race?: { script: Gate[]; commit: (reach: Reach) => Promise<void> };
  };
  type Phase = { branch: string; thrownToo?: boolean; plan: (ids: Ids) => Promise<Plan> };

  const actorOf = (ids: Ids) => ({ actor: { kind: "member" as const, memberId: ids.actor } });
  const tupleOf = (ids: Ids) => ({ team_id: ids.team.teamId, member_id: ids.target });
  const keyOf = (ids: Ids) => ({ team_id: ids.team.teamId, source: "jira", external_id: IMPORT_KEY });

  const PHASES: Phase[] = [
    {
      branch: "profile · initial scoped UPDATE (saveProfile / setMemberProfile, a same-tuple profile stands)",
      thrownToo: true,
      plan: async (ids) => {
        await insertProfile(ids.team.teamId, ids.target);
        return {
          table: "member_profiles",
          injectAt: profileUpdateOf(ids.target),
          failed: "profile update failed",
          direct: (db) => setMemberProfile(db, ids.team.teamId, ids.target, { bio: ACTION_BIO }, actorOf(ids)),
          action: () => saveProfile(ids.team.teamSlug, ids.target, { bio: ACTION_BIO }),
          trace: (faulted) => [{ operation: "update", bound: tupleOf(ids), outcome: faulted }],
        };
      },
    },
    {
      branch: "avatar · INSERT, nonunique error (saveAvatar / setMemberAvatar, no profile yet)",
      plan: async (ids) => ({
        table: "member_profiles",
        injectAt: at("member_profiles", "insert", { member_id: ids.target }),
        failed: "avatar insert failed",
        direct: (db) => setMemberAvatar(db, ids.team.teamId, ids.target, VALID_AVATAR, actorOf(ids)),
        action: () => saveAvatar(ids.team.teamSlug, ids.target, VALID_AVATAR),
        // A nonunique insert error is not a lost race: there is no reread and no second attempt.
        trace: (faulted) => [
          { operation: "update", bound: tupleOf(ids), outcome: ZERO_ROWS },
          { operation: "insert", bound: tupleOf(ids), outcome: faulted },
        ],
      }),
    },
    {
      branch: "profile · scoped reread after a REAL primary-key conflict (saveProfile / setMemberProfile, the member's profile stands under another team)",
      plan: async (ids) => {
        const foreign = await seedTeam();
        await insertProfile(foreign.teamId, ids.target);
        return {
          table: "member_profiles",
          injectAt: at("member_profiles", "select", { member_id: ids.target }),
          failed: "profile reread failed",
          direct: (db) => setMemberProfile(db, ids.team.teamId, ids.target, { bio: ACTION_BIO }, actorOf(ids)),
          action: () => saveProfile(ids.team.teamSlug, ids.target, { bio: ACTION_BIO }),
          // The failed reread is not "no row in scope": no retry follows and no refusal is answered.
          trace: (faulted) => [
            { operation: "update", bound: tupleOf(ids), outcome: ZERO_ROWS },
            { operation: "insert", bound: tupleOf(ids), outcome: PROFILE_PK },
            { operation: "select", bound: tupleOf(ids), outcome: faulted },
          ],
        };
      },
    },
    {
      branch: "avatar · scoped retry UPDATE after a REAL primary-key conflict and a real owned reread (saveAvatar / setMemberAvatar, a same-tuple profile committed after the zero-row update)",
      plan: async (ids) => {
        const zeroUpdate = gate("the initial scoped update's zero-row envelope (captured stale read)", "after", profileUpdateOf(ids.target));
        return {
          table: "member_profiles",
          injectAt: profileUpdateOf(ids.target),
          nth: 2,
          failed: "avatar update failed",
          direct: (db) => setMemberAvatar(db, ids.team.teamId, ids.target, VALID_AVATAR, actorOf(ids)),
          action: () => saveAvatar(ids.team.teamSlug, ids.target, VALID_AVATAR),
          race: {
            script: [zeroUpdate],
            commit: async (reach) => {
              premise("the held scoped update really matched no row", (await reach(zeroUpdate)).outcome, ZERO_ROWS);
              await insertProfile(ids.team.teamId, ids.target);
            },
          },
          trace: (faulted) => [
            { operation: "update", bound: tupleOf(ids), outcome: ZERO_ROWS },
            { operation: "insert", bound: tupleOf(ids), outcome: PROFILE_PK },
            { operation: "select", bound: tupleOf(ids), outcome: ONE_ROW },
            { operation: "update", bound: tupleOf(ids), outcome: faulted },
          ],
        };
      },
    },
    {
      branch: "time-off · INSERT (addMemberTimeOff / addTimeOff)",
      plan: async (ids) => {
        await seedTimeOff(ids.team.teamId, ids.target);
        return {
          table: "member_time_off",
          injectAt: at("member_time_off", "insert", { member_id: ids.target }),
          failed: "time-off insert failed",
          direct: (db) => addTimeOff(db, ids.team.teamId, ids.target, TIME_OFF, actorOf(ids)),
          action: () => addMemberTimeOff(ids.team.teamSlug, ids.target, TIME_OFF),
          trace: (faulted) => [{ operation: "insert", bound: tupleOf(ids), outcome: faulted }],
        };
      },
    },
    {
      branch: "goal · imported dedup lookup (saveMemberGoal / setMemberGoal, the target's own row stands under the key)",
      thrownToo: true,
      plan: async (ids) => {
        await seedGoal(ids.team.teamId, ids.target, { title: "target imported goal", source: "jira", externalId: IMPORT_KEY });
        await seedGoal(ids.team.teamId, ids.peer, { title: "peer manual goal" });
        return {
          table: "member_goals",
          injectAt: dedupReadOf(IMPORT_KEY),
          failed: "goal lookup failed",
          direct: (db) => setMemberGoal(db, ids.team.teamId, ids.target, IMPORTED_REVISION, BROWSER_MEMBER, actorOf(ids)),
          action: () => saveMemberGoal(ids.team.teamSlug, ids.target, IMPORTED_REVISION),
          // The failed lookup is not "no match": nothing is inserted and nothing is updated.
          trace: (faulted) => [{ operation: "select", bound: keyOf(ids), outcome: faulted }],
        };
      },
    },
    {
      branch: "goal · INSERT, nonunique error (saveMemberGoal / setMemberGoal, the imported key is really absent)",
      plan: async (ids) => {
        await seedGoal(ids.team.teamId, ids.peer, { title: "peer manual goal" });
        return {
          table: "member_goals",
          injectAt: at("member_goals", "insert", { external_id: IMPORT_KEY }),
          failed: "goal insert failed",
          direct: (db) => setMemberGoal(db, ids.team.teamId, ids.target, IMPORTED_REVISION, BROWSER_MEMBER, actorOf(ids)),
          action: () => saveMemberGoal(ids.team.teamSlug, ids.target, IMPORTED_REVISION),
          // A nonunique insert error is not a lost key race: no owner re-read, no second insert.
          trace: (faulted) => [
            { operation: "select", bound: keyOf(ids), outcome: ZERO_ROWS },
            { operation: "insert", bound: { ...keyOf(ids), member_id: ids.target }, outcome: faulted },
          ],
        };
      },
    },
    {
      branch: "goal · scoped UPDATE by explicit id, nonunique error (saveMemberGoal / setMemberGoal, the target's own goal)",
      plan: async (ids) => {
        const goalId = await seedGoal(ids.team.teamId, ids.target, { title: "target manual goal" });
        await seedGoal(ids.team.teamId, ids.peer, { title: "peer manual goal" });
        return {
          table: "member_goals",
          injectAt: goalUpdateOf(goalId),
          failed: "goal update failed",
          direct: (db) =>
            setMemberGoal(db, ids.team.teamId, ids.target, { id: goalId, ...GOAL_REVISION }, BROWSER_MEMBER, actorOf(ids)),
          action: () => saveMemberGoal(ids.team.teamSlug, ids.target, { id: goalId, ...GOAL_REVISION }),
          trace: (faulted) => [
            { operation: "update", bound: { team_id: ids.team.teamId, id: goalId, member_id: ids.target }, outcome: faulted },
          ],
        };
      },
    },
    {
      branch: "time-off · final DELETE (deleteMemberTimeOff / removeTimeOff, the target's own row)",
      thrownToo: true,
      plan: async (ids) => {
        const chosen = await seedTimeOff(ids.team.teamId, ids.target);
        await seedTimeOff(ids.team.teamId, ids.target);
        await seedTimeOff(ids.team.teamId, ids.peer);
        return {
          table: "member_time_off",
          injectAt: at("member_time_off", "delete", { id: chosen }),
          failed: "time-off delete failed",
          direct: (db) => removeTimeOff(db, ids.team.teamId, ids.target, chosen, actorOf(ids)),
          action: () => deleteMemberTimeOff(ids.team.teamSlug, ids.target, chosen),
          // The failed delete is not "matched nothing": it is not answered as a scope refusal.
          trace: (faulted) => [{ operation: "delete", bound: { ...tupleOf(ids), id: chosen }, outcome: faulted }],
        };
      },
    },
    {
      branch: "goal · final DELETE (deleteMemberGoal / removeMemberGoal, the target's own row)",
      plan: async (ids) => {
        const chosen = await seedGoal(ids.team.teamId, ids.target, { title: "target manual goal" });
        await seedGoal(ids.team.teamId, ids.target, { title: "target bystander goal" });
        await seedGoal(ids.team.teamId, ids.peer, { title: "peer manual goal" });
        return {
          table: "member_goals",
          injectAt: at("member_goals", "delete", { id: chosen }),
          failed: "goal delete failed",
          direct: (db) => removeMemberGoal(db, ids.team.teamId, ids.target, chosen, actorOf(ids)),
          action: () => deleteMemberGoal(ids.team.teamSlug, ids.target, chosen),
          trace: (faulted) => [{ operation: "delete", bound: { ...tupleOf(ids), id: chosen }, outcome: faulted }],
        };
      },
    },
  ];

  // Every phase as a returned error; the thrown rejection — which the real adapter never produces —
  // only at one phase per writer family, to pin the action's catch path without a second matrix.
  const CASES = [
    ...PHASES.flatMap((phase) => ENTRIES.map((entry) => ({ ...phase, entry, mode: RETURNED as FaultMode }))),
    ...PHASES.filter((phase) => phase.thrownToo).flatMap((phase) =>
      ENTRIES.map((entry) => ({ ...phase, entry, mode: THROWN as FaultMode })),
    ),
  ];

  it.each(CASES)(
    "E · $branch · $entry · injected $mode: the failure stays infrastructure — the direct writer rejects with an Error that is not ProfileScopeRefusal, the action answers its fail path and never the fixed not allowed — the faulted statement is the last one issued, and the standing rows, the ledger and the cache are untouched",
    async ({ plan: planOf, entry, mode }) => {
      const ids = await people("admin-other");
      const plan = await planOf(ids);
      const before = await contextState();
      const injection = fault(`${plan.table} (${plan.failed})`, plan.injectAt, mode, plan.nth);
      const writer = tappedDb({ script: plan.race?.script, fault: injection });
      const gateTap = tappedDb();

      const { outcome, scheduled: standing } = await drive(
        writer,
        (): Promise<unknown> => (entry === DIRECT ? plan.direct(writer.db) : plan.action()),
        async (reach) => {
          if (!plan.race) return before;
          await plan.race.commit(reach);
          return standingAfterCompetitor(before);
        },
        entry === ACTION ? { action: true, gate: gateTap } : {},
      );

      const after = await contextState();
      // A returned adapter error is reported under the writer's phase label; a thrown one is not
      // the writer's own error and passes through as it was thrown.
      const message = mode === THROWN ? injection.message : `${plan.failed}: ${injection.message}`;
      expect({
        outcome,
        admitted: entry === ACTION ? traceOf(gateTap, "members") : null,
        trace: traceOf(writer, plan.table),
        ...after,
        revalidated: revalidatedPaths(),
      }).toEqual({
        outcome: entry === DIRECT ? infrastructure(message) : { returned: { ok: false, error: message } },
        // The action reached its writer through a real admission of this actor and this target.
        admitted: entry === ACTION ? gateTrace(ids.team.teamId, ids.session.id, ids.target) : null,
        trace: plan.trace(FAULT_OUTCOME[mode]),
        ...standing,
        revalidated: [],
      });
    },
  );

  it("E · NATIVE foreign-key failure · addMemberTimeOff · the admitted target member is deleted immediately before the INSERT: the statement really violates the member foreign key and the action answers its fail path, not not allowed — no row for any other identity, no audit, no revalidation", async () => {
    const { team, target, session } = await people("admin-other");
    const before = await contextState();
    const finalInsert = gate("immediately before the time-off INSERT", "before", at("member_time_off", "insert", { member_id: target }));
    const writer = tappedDb({ script: [finalInsert] });
    const gateTap = tappedDb();

    const { outcome, scheduled: standing } = await drive(
      writer,
      () => addMemberTimeOff(team.teamSlug, target, TIME_OFF),
      async (reach) => {
        premise("the time-off INSERT has not executed", (await reach(finalInsert)).outcome, NOT_EXECUTED);
        await fxOne("competitor deletes the target member", `delete from members where id = $1 and team_id = $2 returning id`, [
          target,
          team.teamId,
        ]);
        premise("the target member is gone", await fx("member readback", `select id from members where id = $1`, [target]), []);
        return standingAfterCompetitor(before);
      },
      { action: true, gate: gateTap },
    );

    const after = await contextState();
    expect({
      outcome,
      admitted: traceOf(gateTap, "members"),
      trace: traceOf(writer, "member_time_off"),
      ...after,
      revalidated: revalidatedPaths(),
    }).toEqual({
      outcome: { returned: { ok: false, error: expect.stringMatching(/^time-off insert failed: .*foreign key constraint/) } },
      admitted: gateTrace(team.teamId, session.id, target),
      trace: [
        {
          operation: "insert",
          bound: { team_id: team.teamId, member_id: target },
          outcome: expect.stringMatching(/^error: .*foreign key constraint/),
        },
      ],
      ...standing,
      revalidated: [],
    });
  });

  it("E · lost response · saveProfile · admin-other: the scoped UPDATE really commits and only its acknowledgement is replaced by a returned error — the action answers its fail path with no audit and no revalidation, while the authorized write stands in the original tuple, changing only the supplied field, with no retry", async () => {
    const { team, actor, target, session } = await people("admin-other");
    const existing = await insertProfile(team.teamId, target);
    const before = await contextState();
    const injection = fault("member_profiles (the scoped update's acknowledgement)", profileUpdateOf(target), LOST);
    const writer = tappedDb({ fault: injection });
    const gateTap = tappedDb();

    const outcome = await runAction(writer, gateTap, () => saveProfile(team.teamSlug, target, { bio: ACTION_BIO }));

    const after = await contextState();
    expect({
      outcome,
      admitted: traceOf(gateTap, "members"),
      trace: traceOf(writer, "member_profiles"),
      ...after,
      revalidated: revalidatedPaths(),
    }).toEqual({
      outcome: { returned: { ok: false, error: `profile update failed: ${injection.message}` } },
      admitted: gateTrace(team.teamId, session.id, target),
      trace: [
        { operation: "update", bound: { team_id: team.teamId, member_id: target }, outcome: `${ONE_ROW}; ${FAULT_OUTCOME[LOST]}` },
      ],
      ...before,
      // Committed, not rolled back: this is NOT the no-write outcome of a pre-statement injection.
      profiles: [{ ...existing, bio: ACTION_BIO, updated_by: actor, updated_at: expect.any(String) }],
      revalidated: [],
    });
  });

  it("E · lost response · deleteMemberGoal · admin-other: the final DELETE really removes the chosen row and only its acknowledgement is replaced by a returned error — the action answers its fail path with no removal audit and no revalidation, the chosen row is gone, its sibling and the peer's row stand", async () => {
    const { team, target, peer, session } = await people("admin-other");
    const chosen = await seedGoal(team.teamId, target, { title: "target manual goal" });
    await seedGoal(team.teamId, target, { title: "target bystander goal" });
    await seedGoal(team.teamId, peer, { title: "peer manual goal" });
    const before = await contextState();
    const injection = fault("member_goals (the final delete's acknowledgement)", at("member_goals", "delete", { id: chosen }), LOST);
    const writer = tappedDb({ fault: injection });
    const gateTap = tappedDb();

    const outcome = await runAction(writer, gateTap, () => deleteMemberGoal(team.teamSlug, target, chosen));

    const after = await contextState();
    const remaining = before.goals.filter((row) => row.id !== chosen);
    premise("three goals are seeded and exactly one is chosen", [before.goals.length, remaining.length], [3, 2]);
    expect({
      outcome,
      admitted: traceOf(gateTap, "members"),
      trace: traceOf(writer, "member_goals"),
      ...after,
      revalidated: revalidatedPaths(),
    }).toEqual({
      outcome: { returned: { ok: false, error: `goal delete failed: ${injection.message}` } },
      admitted: gateTrace(team.teamId, session.id, target),
      trace: [
        {
          operation: "delete",
          bound: { team_id: team.teamId, member_id: target, id: chosen },
          outcome: `${ONE_ROW}; ${FAULT_OUTCOME[LOST]}`,
        },
      ],
      ...before,
      goals: remaining,
      revalidated: [],
    });
  });

  // The admitted callers of the fault matrix: the same fixtures and identities, with no injection.

  it("[control] E · saveProfile · admin-other, a same-tuple profile stands: one scoped UPDATE changes only the supplied field, keeps the tuple and attributes the write to the admin actor — audited and revalidated", async () => {
    const { team, actor, target, session } = await people("admin-other");
    const existing = await insertProfile(team.teamId, target);
    const before = await contextState();
    const writer = tappedDb();
    const gateTap = tappedDb();

    const outcome = await runAction(writer, gateTap, () => saveProfile(team.teamSlug, target, { bio: ACTION_BIO }));

    const after = await contextState();
    expect({
      outcome,
      admitted: traceOf(gateTap, "members"),
      trace: traceOf(writer, "member_profiles"),
      profiles: after.profiles,
      timeOff: after.timeOff,
      goals: after.goals,
      audit: auditSince(before.audit, after.audit),
      revalidated: revalidatedPaths(),
    }).toEqual({
      outcome: { returned: { ok: true } },
      admitted: gateTrace(team.teamId, session.id, target),
      trace: [{ operation: "update", bound: { team_id: team.teamId, member_id: target }, outcome: ONE_ROW }],
      profiles: [{ ...existing, bio: ACTION_BIO, updated_by: actor, updated_at: expect.any(String) }],
      timeOff: before.timeOff,
      goals: before.goals,
      audit: [successAudit(team.teamId, actor, "profile.set", target)],
      revalidated: [peoplePath(team.teamSlug, target)],
    });
  });

  it("[control] E · saveAvatar · admin-other, no profile yet: the scoped UPDATE matches nothing and one INSERT creates the authorized tuple with only the avatar — audited to the admin actor and revalidated", async () => {
    const { team, actor, target, session } = await people("admin-other");
    const before = await contextState();
    premise("no profile exists yet", before.profiles, []);
    const scope = { team_id: team.teamId, member_id: target };
    const writer = tappedDb();
    const gateTap = tappedDb();

    const outcome = await runAction(writer, gateTap, () => saveAvatar(team.teamSlug, target, VALID_AVATAR));

    const after = await contextState();
    expect({
      outcome,
      admitted: traceOf(gateTap, "members"),
      trace: traceOf(writer, "member_profiles"),
      profiles: after.profiles,
      timeOff: after.timeOff,
      goals: after.goals,
      audit: auditSince(before.audit, after.audit),
      revalidated: revalidatedPaths(),
    }).toEqual({
      outcome: { returned: { ok: true } },
      admitted: gateTrace(team.teamId, session.id, target),
      trace: [
        { operation: "update", bound: scope, outcome: ZERO_ROWS },
        { operation: "insert", bound: scope, outcome: ONE_ROW },
      ],
      profiles: [
        {
          member_id: target,
          team_id: team.teamId,
          timezone: "",
          working_hours: {},
          preferred_channels: [],
          location: "",
          bio: "",
          avatar_data_url: VALID_AVATAR,
          updated_at: expect.any(String),
          updated_by: actor,
        },
      ],
      timeOff: before.timeOff,
      goals: before.goals,
      audit: [successAudit(team.teamId, actor, "profile.avatar_set", target)],
      revalidated: [peoplePath(team.teamSlug, target)],
    });
  });

  it.each(ACTOR_CASES)(
    "[control] E · addMemberTimeOff · %s: one INSERT creates the time-off row under the (team, target) tuple with the supplied range, kind and note — the returned id is that row, bystander rows stand, audited to the actor and revalidated",
    async (actorCase) => {
      const { team, actor, target, peer, session } = await people(actorCase);
      await seedTimeOff(team.teamId, target);
      await seedTimeOff(team.teamId, peer);
      const before = await contextState();
      const writer = tappedDb();
      const gateTap = tappedDb();

      const outcome = await runAction(writer, gateTap, () => addMemberTimeOff(team.teamSlug, target, TIME_OFF));

      const after = await contextState();
      const createdId = "returned" in outcome ? outcome.returned.id : undefined;
      expect({
        outcome,
        admitted: traceOf(gateTap, "members"),
        trace: traceOf(writer, "member_time_off"),
        profiles: after.profiles,
        timeOff: after.timeOff.filter((row) => row.id !== createdId),
        created: after.timeOff.filter((row) => row.id === createdId),
        goals: after.goals,
        audit: auditSince(before.audit, after.audit),
        revalidated: revalidatedPaths(),
      }).toEqual({
        outcome: { returned: { ok: true, id: expect.any(String) } },
        admitted: gateTrace(team.teamId, session.id, target),
        trace: [{ operation: "insert", bound: { team_id: team.teamId, member_id: target }, outcome: ONE_ROW }],
        profiles: before.profiles,
        timeOff: before.timeOff,
        created: [
          {
            id: createdId,
            team_id: team.teamId,
            member_id: target,
            starts_on: TIME_OFF.startsOn,
            ends_on: TIME_OFF.endsOn,
            kind: TIME_OFF.kind,
            note: TIME_OFF.note,
            created_at: expect.any(String),
          },
        ],
        goals: before.goals,
        audit: [successAudit(team.teamId, actor, "timeoff.add", target)],
        revalidated: [peoplePath(team.teamSlug, target)],
      });
    },
  );
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// gate — an unreadable or absent target fails closed before any writer (AC-09)
// ─────────────────────────────────────────────────────────────────────────────────────────────────

describe("AIO-1217 gate · the target-member lookup fails closed after the actor is admitted (AC-09)", () => {
  type Invoke = (teamSlug: string, memberId: string) => Promise<ActionResult>;

  /** Each export with valid input; a delete names a real child of the same-team target. */
  const PEOPLE_ACTIONS: Array<{ action: string; arrange: (ids: Ids) => Promise<Invoke> }> = [
    { action: "saveProfile", arrange: async () => (teamSlug, memberId) => saveProfile(teamSlug, memberId, { bio: ACTION_BIO }) },
    { action: "saveAvatar", arrange: async () => (teamSlug, memberId) => saveAvatar(teamSlug, memberId, VALID_AVATAR) },
    { action: "addMemberTimeOff", arrange: async () => (teamSlug, memberId) => addMemberTimeOff(teamSlug, memberId, TIME_OFF) },
    { action: "saveMemberGoal", arrange: async () => (teamSlug, memberId) => saveMemberGoal(teamSlug, memberId, { ...GOAL_REVISION }) },
    {
      action: "deleteMemberTimeOff",
      arrange: async ({ team, target }) => {
        const id = await seedTimeOff(team.teamId, target);
        return (teamSlug, memberId) => deleteMemberTimeOff(teamSlug, memberId, id);
      },
    },
    {
      action: "deleteMemberGoal",
      arrange: async ({ team, target }) => {
        const id = await seedGoal(team.teamId, target, { title: "target manual goal" });
        return (teamSlug, memberId) => deleteMemberGoal(teamSlug, memberId, id);
      },
    },
  ];

  it.each(PEOPLE_ACTIONS)(
    "gate · $action · admin-other: the admin actor is really admitted, then the lookup of a valid same-team target returns an injected error — the action refuses not allowed, never admitting the unread target: no statement reaches the writer client, no row, no audit, no revalidation",
    async ({ arrange }) => {
      const ids = await people("admin-other");
      const { team, target, session } = ids;
      const invoke = await arrange(ids);
      const before = await contextState();
      const injection = fault("the gate's target-member lookup", targetLookupOf(team.teamId, target), RETURNED);
      const gateTap = tappedDb({ fault: injection });
      const writer = tappedDb();

      const outcome = await runAction(writer, gateTap, () => invoke(team.teamSlug, target));

      const after = await contextState();
      expect({
        outcome,
        gate: traceOf(gateTap, "members"),
        writer: writer.statements,
        ...after,
        revalidated: revalidatedPaths(),
      }).toEqual({
        outcome: { returned: NOT_ALLOWED },
        // The fault is the target lookup, issued after the actor's own membership read succeeded.
        gate: gateTrace(team.teamId, session.id, target, FAULT_OUTCOME[RETURNED]),
        writer: [],
        ...before,
        revalidated: [],
      });
    },
  );

  it.each(PEOPLE_ACTIONS)(
    "gate · $action · admin-other: a valid id that no member holds makes the target lookup natively return no row — the action refuses not allowed with no statement reaching the writer client, no row, no audit, no revalidation",
    async ({ arrange }) => {
      const ids = await people("admin-other");
      const { team, session } = ids;
      const invoke = await arrange(ids);
      const absent = randomUUID();
      premise("no member holds the supplied id", await fx("member readback", `select id from members where id = $1`, [absent]), []);
      const before = await contextState();
      const gateTap = tappedDb();
      const writer = tappedDb();

      const outcome = await runAction(writer, gateTap, () => invoke(team.teamSlug, absent));

      const after = await contextState();
      expect({
        outcome,
        gate: traceOf(gateTap, "members"),
        writer: writer.statements,
        ...after,
        revalidated: revalidatedPaths(),
      }).toEqual({
        outcome: { returned: NOT_ALLOWED },
        gate: gateTrace(team.teamId, session.id, absent, ZERO_ROWS),
        writer: [],
        ...before,
        revalidated: [],
      });
    },
  );
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// T — the trusted system_import arm: explicit mode, team-bound convergence (AC-10)
// ─────────────────────────────────────────────────────────────────────────────────────────────────

describe("AIO-1217 T · a trusted system_import goal write converges within its team, by explicit mode only (AC-10)", () => {
  const untypedSetMemberGoal = setMemberGoal as unknown as (...args: unknown[]) => Promise<string>;

  it.each([
    { winner: "the importer's own member", reassigned: false },
    { winner: "a same-team peer", reassigned: true },
  ])(
    "T1 · system_import · the absent key is inserted for $winner after the importer's absent read: the importer's insert really loses the team-wide import index, the re-read finds that row and the team-bound UPDATE converges on it — the competitor's id is returned, one row holds the key under the importer's member with the supplied content, audited to the system",
    async ({ reassigned }) => {
      const { team, first: member, second: peer } = await roster();
      await seedGoal(team.teamId, peer, { title: "peer manual goal" });
      const before = await contextState();
      const key = { team_id: team.teamId, source: "jira", external_id: IMPORT_KEY };
      const absentRead = gate("the initial dedup read's absent envelope (captured stale read)", "after", dedupReadOf(IMPORT_KEY));
      const client = tappedDb({ script: [absentRead] });

      const { outcome, scheduled } = await drive(
        client,
        () => setMemberGoal(client.db, team.teamId, member, IMPORTED_REVISION, SYSTEM_IMPORT, SYSTEM_ACTOR),
        async (reach) => {
          premise("the held dedup read really found no row", (await reach(absentRead)).outcome, ZERO_ROWS);
          const competitorId = await seedGoal(team.teamId, reassigned ? peer : member, {
            title: "competitor imported goal",
            source: "jira",
            externalId: IMPORT_KEY,
          });
          return { competitorId, standing: await standingAfterCompetitor(before) };
        },
      );
      const { competitorId, standing } = scheduled;
      premise(
        "the competitor's row holds the key under its own owner",
        standing.goals.filter((row) => row.external_id === IMPORT_KEY).map((row) => [row.id, row.member_id]),
        [[competitorId, reassigned ? peer : member]],
      );

      const after = await contextState();
      expect({
        outcome,
        trace: traceOf(client, "member_goals"),
        profiles: after.profiles,
        timeOff: after.timeOff,
        goals: after.goals,
        audit: auditSince(before.audit, after.audit),
        revalidated: revalidatedPaths(),
      }).toEqual({
        outcome: { returned: competitorId },
        trace: [
          { operation: "select", bound: key, outcome: ZERO_ROWS },
          { operation: "insert", bound: { ...key, member_id: member }, outcome: GOAL_IMPORT_KEY },
          { operation: "select", bound: key, outcome: ONE_ROW },
          // Team-bound, with no owner predicate: the trusted arm may move the row to its member.
          { operation: "update", bound: { team_id: team.teamId, id: competitorId }, outcome: ONE_ROW },
        ],
        profiles: standing.profiles,
        timeOff: standing.timeOff,
        goals: standing.goals.map((row) => (row.id === competitorId ? { ...revised(row), member_id: member } : row)),
        audit: [systemGoalAudit(team.teamId, member)],
        revalidated: [],
      });
    },
  );

  it("T2 · system_import · explicit id: the same-team goal is re-homed to ANOTHER team immediately before the team-bound UPDATE — the statement really matches zero rows and the importer is refused with ProfileScopeRefusal; the re-homed row stands as the competitor left it, no audit", async () => {
    const { team, first: member, second: peer } = await roster();
    const foreign = await seedTeam();
    const goalId = await seedGoal(team.teamId, peer, { title: "peer manual goal" });
    const before = await contextState();
    const finalUpdate = gate("immediately before the team-bound goal UPDATE", "before", goalUpdateOf(goalId));
    const client = tappedDb({ script: [finalUpdate] });

    const { outcome, scheduled: standing } = await drive(
      client,
      () => setMemberGoal(client.db, team.teamId, member, { id: goalId, ...GOAL_REVISION }, SYSTEM_IMPORT, SYSTEM_ACTOR),
      async (reach) => {
        premise("the team-bound goal UPDATE has not executed", (await reach(finalUpdate)).outcome, NOT_EXECUTED);
        await fxOne(
          "competitor re-homes the goal",
          `update member_goals set team_id = $1 where id = $2 and team_id = $3 and member_id = $4 returning id`,
          [foreign.teamId, goalId, team.teamId, peer],
        );
        return standingAfterCompetitor(before);
      },
    );
    premise("the goal now stands under the other team", standing.goals.find((row) => row.id === goalId)?.team_id, foreign.teamId);

    const after = await contextState();
    expect({ outcome, trace: traceOf(client, "member_goals"), ...after, revalidated: revalidatedPaths() }).toEqual({
      outcome: SCOPE_REFUSED,
      trace: [{ operation: "update", bound: { team_id: team.teamId, id: goalId }, outcome: ZERO_ROWS }],
      ...standing,
      revalidated: [],
    });
  });

  it("[control] T2 · system_import · explicit id, no barrier: one team-bound UPDATE moves a same-team peer's goal to the importer's member with the supplied content — same id, the peer's other goal untouched, audited to the system", async () => {
    const { team, first: member, second: peer } = await roster();
    const goalId = await seedGoal(team.teamId, peer, { title: "peer manual goal" });
    await seedGoal(team.teamId, peer, { title: "peer bystander goal" });
    const before = await contextState();
    const client = tappedDb();

    const outcome = await runDirect(client, () =>
      setMemberGoal(client.db, team.teamId, member, { id: goalId, ...GOAL_REVISION }, SYSTEM_IMPORT, SYSTEM_ACTOR),
    );

    const after = await contextState();
    expect({
      outcome,
      trace: traceOf(client, "member_goals"),
      profiles: after.profiles,
      timeOff: after.timeOff,
      goals: after.goals,
      audit: auditSince(before.audit, after.audit),
      revalidated: revalidatedPaths(),
    }).toEqual({
      outcome: { returned: goalId },
      trace: [{ operation: "update", bound: { team_id: team.teamId, id: goalId }, outcome: ONE_ROW }],
      profiles: before.profiles,
      timeOff: before.timeOff,
      goals: before.goals.map((row) => (row.id === goalId ? { ...revised(row), member_id: member } : row)),
      audit: [systemGoalAudit(team.teamId, member)],
      revalidated: [],
    });
  });

  it("T3 · system_import · the identical key is inserted under ANOTHER team after the importer's absent read: the import index is team-wide, not global — the importer's insert succeeds in its own team for its own member, and the other team's row is neither converged on, moved nor rewritten", async () => {
    const { team, first: member } = await roster();
    const foreign = await seedTeam();
    const before = await contextState();
    const key = { team_id: team.teamId, source: "jira", external_id: IMPORT_KEY };
    const absentRead = gate("the initial dedup read's absent envelope (captured stale read)", "after", dedupReadOf(IMPORT_KEY));
    const client = tappedDb({ script: [absentRead] });

    const { outcome, scheduled: standing } = await drive(
      client,
      () => setMemberGoal(client.db, team.teamId, member, IMPORTED_REVISION, SYSTEM_IMPORT, SYSTEM_ACTOR),
      async (reach) => {
        premise("the held dedup read really found no row", (await reach(absentRead)).outcome, ZERO_ROWS);
        await seedGoal(foreign.teamId, foreign.memberId, { title: "foreign-team imported goal", source: "jira", externalId: IMPORT_KEY });
        return standingAfterCompetitor(before);
      },
    );
    premise(
      "the only row holding the key stands under the other team",
      standing.goals.map((row) => [row.team_id, row.member_id, row.external_id]),
      [[foreign.teamId, foreign.memberId, IMPORT_KEY]],
    );

    const after = await contextState();
    const createdId = "returned" in outcome ? outcome.returned : undefined;
    expect({
      outcome,
      trace: traceOf(client, "member_goals"),
      profiles: after.profiles,
      timeOff: after.timeOff,
      goals: after.goals.filter((row) => row.id !== createdId),
      created: after.goals.filter((row) => row.id === createdId),
      audit: auditSince(before.audit, after.audit),
      revalidated: revalidatedPaths(),
    }).toEqual({
      outcome: { returned: expect.any(String) },
      trace: [
        { operation: "select", bound: key, outcome: ZERO_ROWS },
        { operation: "insert", bound: { ...key, member_id: member }, outcome: ONE_ROW },
      ],
      profiles: standing.profiles,
      timeOff: standing.timeOff,
      goals: standing.goals,
      created: [
        {
          id: createdId,
          team_id: team.teamId,
          member_id: member,
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
      audit: [systemGoalAudit(team.teamId, member)],
      revalidated: [],
    });
  });

  it.each([
    { scope: "an omitted scope", value: undefined },
    { scope: "a null scope", value: null },
    { scope: "an empty scope object", value: {} },
    { scope: "the pre-AIO-1217 actor options in the scope position", value: { actor: { kind: "system" } } },
    { scope: "an unknown mode", value: { mode: "trusted" } },
  ])(
    "T4 · $scope selects neither arm: where system_import would converge on a peer's imported key and move a peer's explicit goal, each call rejects before issuing any statement — the peer's rows and the ledger unchanged after each",
    async ({ value }) => {
      const { team, first: member, second: peer } = await roster();
      const peerManual = await seedGoal(team.teamId, peer, { title: "peer manual goal" });
      await seedGoal(team.teamId, peer, { title: "peer imported goal", source: "jira", externalId: IMPORT_KEY });
      const before = await contextState();
      const rejected = { rejected: { error: true, scopeRefusal: expect.any(Boolean), message: expect.any(String) } };

      const byKey = tappedDb();
      const byKeyOutcome = await runDirect(byKey, () =>
        untypedSetMemberGoal(byKey.db, team.teamId, member, IMPORTED_REVISION, value, SYSTEM_ACTOR),
      );
      // Each refusal is observed on its own, against the state captured before that invocation.
      const afterByKey = await contextState();

      const byId = tappedDb();
      const byIdOutcome = await runDirect(byId, () =>
        untypedSetMemberGoal(byId.db, team.teamId, member, { id: peerManual, ...GOAL_REVISION }, value, SYSTEM_ACTOR),
      );
      const afterById = await contextState();

      expect({
        byKey: { outcome: byKeyOutcome, statements: byKey.statements, ...afterByKey },
        byId: { outcome: byIdOutcome, statements: byId.statements, ...afterById },
        revalidated: revalidatedPaths(),
      }).toEqual({
        byKey: { outcome: rejected, statements: [], ...before },
        byId: { outcome: rejected, statements: [], ...afterByKey },
        revalidated: [],
      });
    },
  );
});
