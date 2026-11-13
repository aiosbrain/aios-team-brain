import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getPool } from "@/lib/db/pg/pool";
import { projectTaskByIdAfterWrite } from "@/lib/pm-sync/after-write";
import type { ProjectionReport } from "@/lib/pm-sync/project";
import { db, seedTeam, type Seed } from "./helpers";

/**
 * AIO-1217 — REAL REACTIVE PM CALLER COMPOSITION against real Postgres: what
 * `lib/pm-sync/after-write.ts#projectTaskByIdAfterWrite` itself returns and writes for a task whose
 * team has NO primary PM provider, called directly as `projectTaskByIdAfterWrite(db(), taskId)` over
 * synthetic teams, projects and tasks in the task's data-mechanics Postgres. Beneath the one call run
 * the real task load, the real `lib/pm-sync/project.ts#projectTask`, the real
 * `resolvePrimaryProvider`, the real `lib/pm-sync/runs.ts#recordProjectionRun` with its
 * `summarizeProjectionReports` roll-up, and the real `lib/ingest/runs.ts#recordIngestRun` single
 * writer of `ingest_runs`.
 *
 * This is the caller-side complement of `aio1217-pm-projection-run-owner.datamechanics.test.ts`. That
 * file's case 7 SUPPLIES a `no_primary_provider` report written out by hand and records what the
 * owner stores for it; its "CALLER COMPOSITION" TODO names this caller as not executed. Here no report
 * is written by the file: the report is the one `projectTask` returns and the run is the one this
 * caller hands on. Of that TODO this file supplies `projectTaskByIdAfterWrite`'s no-primary branch
 * alone.
 *
 *   1 — team A's task, no enabled PM integration anywhere: the returned report and the one stored run.
 *   2 — absence: a task id never issued, then (after a control) the id of a task deleted since.
 *   3 — OBSERVED: the team a run is recorded under is the loaded task row's own, in either direction.
 *   Z — what this file does not supply, as executable TODOs naming the owner.
 *
 * What is real, and never mocked: the caller, its task load, `projectTask`, `resolvePrimaryProvider`
 * and the integrations read it makes, the roll-up, the run owner, the `ingest_runs` writer, the query
 * builder, the pg pool and Postgres. The client handed in is the helper's `db()` and nothing else. No
 * report, reason, provider, trigger or instant is supplied by this file: the caller takes a client
 * and a task id, and every other fact of the stored run is its own composition.
 *
 * The synthetic seam, the only one:
 *   SEAM process   for the duration of the one call, and no longer, the process's global `fetch` is
 *                  replaced by a counter that refuses. The call is made with no `fetchImpl`, so an
 *                  adapter reached by mistake would fall to whatever transport it defaults to. "No
 *                  provider-network call" is therefore a count of zero of global `fetch` during the
 *                  call, together with a returned report that `projectTask` produces before it selects
 *                  an adapter. A transport other than global `fetch` would not be counted.
 *
 * SETUP WRITES ARE NOT CALLER EFFECTS. Each team, its member and its builtin rows are `seedTeam`'s;
 * each project and task is inserted by this file through the helper client, as `seedTeam` inserts its
 * own rows; case 2 deletes one task by raw SQL between two calls. All of these happen outside the
 * snapshots. Every observation is a whole-rowset difference of `ingest_runs`, `audit_log`, `teams`,
 * `integrations`, `projects`, `tasks` and `task_pm_links`, read from the pool by raw SQL immediately
 * before and after the one call, so "exactly one run" and "no task, link or audit row changed" are
 * statements about whole tables and not about a filtered read. A stored run is compared whole: every
 * column `ingest_runs` has. Its two instants are the caller's and the writer's own clocks, not the
 * test's, so they are bounded by this process's clock around the call and `duration_ms` is held to
 * their difference.
 *
 * NOTHING HERE IS A CREDENTIAL. No integration row, secret, token or provider account is created or
 * read by this file; no team names a primary provider. Row keys and titles are fixed synthetic
 * strings, and nothing of any real team, member or board is captured.
 *
 * Bounds of what is claimed.
 *   - DIRECT CALLER INVOCATION ONLY. Not Next action-wire, not POST dispatch, not `next/server`
 *     `after()`, not a guard's admission or denial, not session or posture, not an audit row and not
 *     revalidation. The Server Actions this caller's own comments name as its users —
 *     `createTaskAction`, `moveTaskAction`, `updateTaskAction` — are outside this slice's read list and
 *     are not executed. Of the three caller files that were read to state this,
 *     `app/t/[team]/admin/pm-sync/actions.ts`, `app/actions/meeting-todos.ts` and
 *     `scripts/brain-tasks.ts`, NONE references `projectTaskByIdAfterWrite`: each composes
 *     `projectAllTasks` with `recordProjectionRun` itself, under trigger `manual` or `cli`.
 *   - THE TASK ID IS SUPPLIED, NOT AUTHORIZED. The caller takes a bare task id and no team; it loads
 *     the row and records under that row's `team_id`. It performs no check of who asks. Case 3 records
 *     that derivation; it is not evidence that any holder of a task id may or may not trigger it.
 *   - ONE BRANCH OF `projectTask`. Only the unresolved-primary return is reached, and of
 *     `resolvePrimaryProvider` only its none-enabled answer for a team with no `primary_pm_provider`.
 *     `ensureLink`, the fingerprint skip, the Plane and Linear adapters, `persistSuccess`,
 *     `persistError`, parent resolution and every `task_pm_links` write are not reached. The empty
 *     difference of `tasks` and `task_pm_links` is this branch's and says nothing of the others.
 *   - NO TEAM HOLDS AN INTEGRATION. So that team A's resolution reads team A's rows only is NOT
 *     evidenced here: with no row in either team, a resolution bound to the wrong team would answer
 *     the same. The integrations read's own source is outside this slice's read list.
 *   - THE STORED RUN IS AN OBSERVATION. For a team that has simply configured no PM tool, this caller
 *     stores a `pm_sync` run with `ok: false` and one error line: the roll-up counts the row
 *     `unchanged` and no failure, and the writer derives not-ok from the line. By source reading the
 *     push-path sibling `projectChangedTasksAfterWrite` returns before recording anything in the same
 *     situation. Neither behavior is declared correct, and the difference is not ruled on.
 *   - ABSENCE IS A WELL-FORMED ID THAT MATCHES NO ROW. A malformed id, a read Postgres refuses and a
 *     failing client are not reached; nor is the caller's swallowing `catch`.
 *   - THE READERS ARE NOT CALLED. `listRecentProjectionRuns` and `getProjectionHealth` are the owner
 *     file's evidence; which team holds a run is read back raw here.
 *   - `ingest_runs` is not in the tier's truncate list; it is emptied before each test by the cascade
 *     from `teams`. Every case reads that back as a premise before it counts rows.
 *   - Nothing about API keys. AIO-1226 and the zero-row revoke residual are other files' and are
 *     neither touched nor supplied here.
 *
 * Run status. NOT RUN. This file was written without executing vitest, tsc, lint or any other
 * command; every expectation comes from reading the sources named above, not from an observed run.
 * Replace this paragraph with the observed result once the file has been executed.
 */

const FIXTURE = "FIXTURE PREMISE FAILED (setup, not a caller observation):";
const CONTROL = "RECORDING CONTROL FAILED (the paired absence would be vacuous):";

type Row = Record<string, unknown>;

/** Two teams, their boards, and whole-rowset snapshots around each call. */
const ROOMY = 30_000;

/** `resolvePrimaryProvider`'s own reason for a team with no enabled PM integration and no primary. */
const NO_PROVIDER_REASON = "no enabled PM integration";

/** The keys of the report `projectTask` returns for an unresolved primary: no provider resource id. */
const REPORT_KEYS = ["error", "provider", "row_key", "status"];

/** One team with the one project and the one task this file gave it. */
interface Board {
  team: Seed;
  projectId: string;
  taskId: string;
  rowKey: string;
}

interface World {
  a: Board;
  b: Board;
}

/** How a call ended: what it returned, or how its rejection classifies. */
type Settled = { returned: unknown } | { rejected: { error: boolean; message: string } };

interface Seen {
  outcome: Settled;
  /** The sorted key list of the returned report; null when the call returned no object. */
  shape: string[] | null;
  changed: Changed;
  /** How many times global `fetch` was called while the call was in flight. */
  fetched: number;
  /** This process's clock immediately around the call. */
  window: { earliest: number; latest: number };
}

afterEach(() => {
  // SEAM process: `observe` restores `fetch` itself; this is the backstop if a call never settles.
  vi.unstubAllGlobals();
});

// ── fixture plumbing ─────────────────────────────────────────────────────────────────────────────

async function fx<T extends Row = Row>(label: string, text: string, params: unknown[] = []): Promise<T[]> {
  try {
    return (await getPool().query(text, params)).rows as T[];
  } catch (error) {
    throw new Error(`${FIXTURE} ${label}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function premise(label: string, actual: unknown, expected: unknown): void {
  expect(actual, `${FIXTURE} ${label}`).toEqual(expected);
}

// The table the caller's handoff writes, and the ones a projection, a link or an action would touch.
const DURABLE_TABLES = [
  "ingest_runs",
  "audit_log",
  "teams",
  "integrations",
  "projects",
  "tasks",
  "task_pm_links",
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

/** The rows a call added and removed, per table; a changed row is one of each. Empty when none. */
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

/** SETUP WRITE: a team, one project of it and one keyed task in that project, origin `ui`. */
async function seedBoard(rowKey: string): Promise<Board> {
  const team = await seedTeam();
  const admin = db();

  const { data: project, error: pErr } = await admin
    .from("projects")
    .insert({
      team_id: team.teamId,
      slug: `aio1217-${randomUUID().slice(0, 8)}`,
      name: "AIO-1217 synthetic board",
    })
    .select("id")
    .single();
  if (pErr || !project) throw new Error(`${FIXTURE} seed project failed: ${pErr?.message}`);
  const projectId = (project as { id: string }).id;

  // Every other column is left to its default: status `backlog`, no parent, no labels, no body.
  const { data: task, error: tErr } = await admin
    .from("tasks")
    .insert({
      team_id: team.teamId,
      project_id: projectId,
      row_key: rowKey,
      title: `aio1217 synthetic task ${rowKey}`,
      origin: "ui",
    })
    .select("id")
    .single();
  if (tErr || !task) throw new Error(`${FIXTURE} seed task failed: ${tErr?.message}`);

  return { team, projectId, taskId: (task as { id: string }).id, rowKey };
}

/** A seeded task as the pool reads it back. */
const heldTask = (board: Board): Row => ({
  id: board.taskId,
  team_id: board.team.teamId,
  project_id: board.projectId,
  row_key: board.rowKey,
});

/** Every task row, by row key. */
const tasksHeld = (): Promise<Row[]> =>
  fx("tasks readback", `select id, team_id, project_id, row_key from tasks order by row_key`);

/** Every stored run's id and team id, in the order they were written. */
const runsByTeam = (): Promise<Row[]> =>
  // Ordered by the qualified column: a bare `id` would name the text output column and sort "10" before "9".
  fx("ingest_runs team readback", `select id::text as id, team_id from ingest_runs order by ingest_runs.id`);

const countOf = async (label: string, text: string, params: unknown[] = []): Promise<number> =>
  Number((await fx<{ n: number }>(label, text, params))[0]?.n);

/**
 * Two teams, each with its own board. Team B's project and task are a bystander's: they make "team
 * B's rows are unchanged" a statement about rows that exist. Read back: both tasks stand, no team
 * names a primary provider, and there is no integration, link or run anywhere.
 */
async function seedWorld(): Promise<World> {
  const a = await seedBoard("AIO1217-AW-A1");
  const b = await seedBoard("AIO1217-AW-B1");
  premise("the two teams are distinct", a.team.teamId === b.team.teamId, false);
  premise("the two seeded tasks, and no other", await tasksHeld(), [heldTask(a), heldTask(b)]);
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
  premise("ingest_runs starts empty", await runsByTeam(), []);
  return { a, b };
}

// ── the call ─────────────────────────────────────────────────────────────────────────────────────

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
 * Snapshot, make the one direct call of the caller over the helper client with a task id and nothing
 * else, snapshot again. Global `fetch` counts and refuses for exactly as long as the call is in flight.
 */
async function observe(taskId: string): Promise<Seen> {
  const before = await durable();

  let fetched = 0;
  vi.stubGlobal("fetch", async () => {
    fetched += 1;
    throw new Error("aio1217 test-only network refusal");
  });
  const earliest = Date.now();
  const outcome = await settle(() => projectTaskByIdAfterWrite(db(), taskId));
  const latest = Date.now();
  vi.unstubAllGlobals();

  const after = await durable();

  const returned = "returned" in outcome ? outcome.returned : null;
  return {
    outcome,
    shape: returned !== null && typeof returned === "object" ? Object.keys(returned).sort() : null,
    changed: changes(before, after),
    fetched,
    window: { earliest, latest },
  };
}

const seenOf = (seen: Seen) => ({
  outcome: seen.outcome,
  shape: seen.shape,
  changed: seen.changed,
  fetched: seen.fetched,
});

/** The one run a call added, as the pool read it back. Asked for only after that has been asserted. */
function runOf(seen: Seen): Row {
  const added = seen.changed.ingest_runs?.added ?? [];
  if (added.length !== 1) throw new Error(`expected exactly one added ingest_runs row, got ${added.length}`);
  return added[0];
}

const idOf = (seen: Seen): string => String(runOf(seen).id);

// ── what a call leaves behind ────────────────────────────────────────────────────────────────────

/** The report `projectTask` returns for a keyed task of a team with no primary provider. */
const unresolved = (board: Board): ProjectionReport => ({
  row_key: board.rowKey,
  provider: null,
  status: "no_primary_provider",
  error: NO_PROVIDER_REASON,
});

/**
 * The whole `ingest_runs` row this caller's handoff stores for that report: every column the table
 * has. None of it is handed in by this file; the instants are bounded by `stampedWithin`.
 */
const runRow = (board: Board): Row => ({
  id: expect.any(Number),
  // The loaded task row's team: the caller is handed no team.
  team_id: board.team.teamId,
  source: "pm_sync",
  // The caller's own trigger for the single-task path.
  trigger: "api",
  // The roll-up counts no failure; the writer derives not-ok from the one line.
  ok: false,
  created: 0,
  updated: 0,
  unchanged: 1,
  error_count: 1,
  errors: [`${board.rowKey}: ${NO_PROVIDER_REASON}`],
  // The report's own provider, and the roll-up's per-status counts.
  meta: { provider: null, no_primary_provider: 1 },
  started_at: expect.any(Number),
  finished_at: expect.any(Number),
  duration_ms: expect.any(Number),
});

/**
 * A projected-and-recorded call for `board`'s task: the call resolves with the unresolved-primary
 * report and no other key; `ingest_runs` gains exactly that team's run and loses none; no row of any
 * other durable table is added, removed or changed; and global `fetch` is never called.
 */
const projected = (board: Board) => ({
  outcome: { returned: unresolved(board) },
  shape: REPORT_KEYS,
  changed: { ingest_runs: { added: [runRow(board)], removed: [] } },
  fetched: 0,
});

/** A call that found no task: it resolves with null, changes no durable row and calls no `fetch`. */
const ABSENT = { outcome: { returned: null }, shape: null, changed: {}, fetched: 0 };

/** The run's instants are the call's own clock, in order, and its duration is their difference. */
function stampedWithin(seen: Seen): void {
  const run = runOf(seen);
  const startedAt = Number(run.started_at);
  const finishedAt = Number(run.finished_at);
  expect(startedAt).toBeGreaterThanOrEqual(seen.window.earliest);
  expect(finishedAt).toBeGreaterThanOrEqual(startedAt);
  expect(finishedAt).toBeLessThanOrEqual(seen.window.latest);
  expect(run.duration_ms).toBe(finishedAt - startedAt);
}

describe("AIO-1217 real reactive PM caller composition — lib/pm-sync/after-write projectTaskByIdAfterWrite over real Postgres, no primary provider (direct calls: no action, no guard, no after(), no provider)", () => {
  it(
    "1 — team A's keyed task, with no enabled PM integration and no primary provider in either team: `projectTaskByIdAfterWrite(db(), taskId)` resolves with the report `projectTask` returns for an unresolved primary — the task's row key, `provider: null`, `no_primary_provider`, the resolution's own reason `no enabled PM integration`, and no provider resource id key — and adds exactly one ingest_runs row holding team A (the task row's team; none is handed in), source `pm_sync`, trigger `api`, `ok: false`, `created: 0`, `updated: 0`, `unchanged: 1`, `error_count: 1` with the one line `<row key>: <reason>`, `meta` of the null provider and `no_primary_provider: 1`, and two instants within the call whose difference is `duration_ms`; no task, task link, audit, team, project or integration row is added, removed or changed; global fetch is never called; read back raw, the one run is team A's and team B has none",
    async () => {
      const world = await seedWorld();

      const seen = await observe(world.a.taskId);

      expect(seenOf(seen)).toEqual(projected(world.a));
      stampedWithin(seen);
      expect(await runsByTeam()).toEqual([{ id: idOf(seen), team_id: world.a.team.teamId }]);
    },
    ROOMY,
  );

  it(
    "2 — absence: a well-formed task id that was never issued resolves with null, records no run and changes no durable row of either team, though both seeded tasks stand; after a control in which team A's real task records its one run in the same world, that task is deleted (a setup write) and the same id — real a moment ago, as a task deleted between a write and its callback would be — resolves with null, records no second run and leaves the control's run as it was written; global fetch is never called",
    async () => {
      const world = await seedWorld();

      const never = randomUUID();
      premise(
        "the never-issued id names no task",
        await countOf("never-issued id readback", `select count(*)::int as n from tasks where id = $1`, [never]),
        0,
      );
      expect(seenOf(await observe(never)), "a task id that was never issued").toEqual(ABSENT);
      expect(await runsByTeam(), "after the never-issued id").toEqual([]);

      const control = await observe(world.a.taskId);
      expect(seenOf(control), CONTROL).toEqual(projected(world.a));

      // SETUP WRITE, outside every snapshot: the task goes, as if deleted before its callback ran.
      await fx("delete team A's task", `delete from tasks where id = $1`, [world.a.taskId]);
      premise("team A's task is gone and team B's stands", await tasksHeld(), [heldTask(world.b)]);

      // `changed: {}` inside: the control's run is neither rewritten nor removed.
      expect(seenOf(await observe(world.a.taskId)), "the id of a task deleted since").toEqual(ABSENT);
      expect(await runsByTeam(), "after the deleted task's id").toEqual([
        { id: idOf(control), team_id: world.a.team.teamId },
      ]);
    },
    ROOMY,
  );

  it(
    "3 — OBSERVED, as the source derives it and not an authorization: the team a run is recorded under is the loaded task row's own, whichever task id the call is handed — team B's task id records exactly one run under team B, carrying team B's row key in its line, while team A has none; team A's task id then records exactly one run under team A and rewrites nothing of team B's; read back raw, the two rows hold B and A in that order (the caller checks nothing about who hands it the id)",
    async () => {
      const world = await seedWorld();

      const forB = await observe(world.b.taskId);
      expect(seenOf(forB), "team B's task id").toEqual(projected(world.b));
      stampedWithin(forB);
      expect(await runsByTeam(), "after team B's task id").toEqual([{ id: idOf(forB), team_id: world.b.team.teamId }]);

      // `removed: []` inside: team B's run stands as it was written.
      const forA = await observe(world.a.taskId);
      expect(seenOf(forA), "team A's task id").toEqual(projected(world.a));
      stampedWithin(forA);

      expect(await runsByTeam()).toEqual([
        { id: idOf(forB), team_id: world.b.team.teamId },
        { id: idOf(forA), team_id: world.a.team.teamId },
      ]);
    },
    ROOMY,
  );
});

// Each TODO names the owner of evidence this slice was told not to supply.
describe("Z — evidence this file does NOT supply (executable TODOs: none is run, none is passed)", () => {
  it.todo(
    "PROVIDER-CONFIGURED BRANCHES · a team holding an enabled, secret-bearing Plane or Linear integration — the sole enabled one, or the one `teams.primary_pm_provider` names — where projectTask goes on to ensureLink, parent resolution, the fingerprint skip, the adapter's upsertWorkItem, persistSuccess and persistError, and returns `synced`, `adopted`, `skipped`, `failed`, `missing_parent` or `cycle`, is not exercised through this caller; no integration row is written by this file and only the unresolved-primary return of projectTask is reached",
  );
  it.todo(
    "MISSING INTEGRATION AND AMBIGUOUS PRIMARY · `teams.primary_pm_provider` set while its integration is absent, disabled or secret-less — where projectTask creates or finds the task_pm_links row, records `last_error` on it and returns `missing_integration`, and this caller records a run naming that provider — is not exercised; nor is the other unresolved answer, `multiple PM integrations enabled but teams.primary_pm_provider is unset`; this file reaches the none-enabled reason only",
  );
  it.todo(
    "PROVIDER NETWORK · no adapter is invoked and no provider exchange, stubbed or live, takes place; the zero here is a count of global `fetch` during the call, which says nothing of a transport that is not global `fetch`; the caller's `fetchImpl` option is not handed and its threading into projectTask is not evidenced",
  );
  it.todo(
    "TEAM-BOUND RESOLUTION WITH A CONFIGURED BYSTANDER · no team here holds an integration row, so that team A's primary resolution reads team A's rows alone — and is not answered by another team's enabled integration — is not evidenced by this file; the integrations read's source is outside this slice's read list",
  );
  it.todo(
    "PUSH-PATH COMPOSITION · lib/pm-sync/after-write.ts#projectChangedTasksAfterWrite — the changed-rows tail, its early empty returns, its projectRows batch, its missing-integration loop and the catch that records a reasoned run — is not called; by source reading it returns before recording any run when the team has no primary provider, where the single-task caller evidenced here records a not-ok one, and that difference is neither observed for the push path nor ruled on",
  );
  it.todo(
    "ACTION, GUARD, SESSION, AUDIT, REVALIDATION · the Server Actions this caller's comments name as its users (createTaskAction, moveTaskAction, updateTaskAction) are outside this slice's read list and are not executed: no action wire, no guard admission or denial, no session or posture, no audit row and no revalidation is evidenced; the three caller files that were read — app/t/[team]/admin/pm-sync/actions.ts#projectBoardAction (requireTeamAdmin, audit, revalidatePath; projectAllTasks, trigger `manual`), app/actions/meeting-todos.ts (projectAllTasks, trigger `manual`) and scripts/brain-tasks.ts (projectAllTasks, trigger `cli`) — do not reference projectTaskByIdAfterWrite at all; the caller takes a bare task id, records under the loaded row's team and checks nothing about who asks, so this file proves neither the action wire nor any user's authorization",
  );
  it.todo(
    "CALLER after() SCHEDULING · that an action schedules this caller inside a next/server after() callback, that it runs after the response is sent, which client the callback hands it, and what a throw inside that callback would do are not exercised; this file awaits the function directly",
  );
  it.todo(
    "WRITE FAILURE AND THE SWALLOWING CATCH · a refused ingest_runs insert, a failing client, and a throw from primary resolution or ensureLink — which by source reading the caller's catch turns into a null return with NO run recorded, unlike the push path's catch — are not reached; recordIngestRun is best-effort and never throws, so a run that could not be stored would show here only as a missing row, and whether a swallowed single-task failure should leave no trace is not specified by any source this file reads",
  );
  it.todo(
    "READ FAILURE AND MALFORMED IDS · case 2's absence is a well-formed id that matches no row; a malformed task id or a tasks read that Postgres refuses reads, by source reading, exactly as an absent task does — null, no run — and is not exercised, so an absent task and an unreadable one are not told apart by anything observed here",
  );
  it.todo(
    "ROW-KEY-LESS TASK · a task whose `row_key` is null, for which projectTask returns `no_row_key` with an empty row key BEFORE any primary resolution and this caller still records a run, is not exercised; both seeded tasks are keyed",
  );
  it.todo(
    "OBSERVED DERIVATION · that a team with no PM tool configured gets a `pm_sync` run stored `ok: false` with one error line from every single-task projection — counted `unchanged`, not failed, and not-ok by its line alone — is recorded as observed; no contract for it is declared here, and what listRecentProjectionRuns and getProjectionHealth then answer for such a row is aio1217-pm-projection-run-owner.datamechanics.test.ts's evidence (its case 7), not this file's: neither reader is called here",
  );
  it.todo(
    "COORDINATOR · MUTANTS (isolated-copy actual-import run; every expectation below is read from source and NO mutant has been run): against this fixture, drop the recordProjectionRun call from projectTaskByIdAfterWrite (cases 1 and 3, the missing run); return null instead of the report (cases 1 and 3, the outcome); hand the owner `reports: []`, a trigger other than `api`, a fixed provider in place of the report's own, or a `reason` (case 1, the stored row's `unchanged`, `trigger`, `meta` and error line respectively); hand the owner a team other than the loaded row's (cases 1 and 3, `team_id`); drop the `id` equality from loadTaskById (case 1 or case 2, by whichever of the two seeded rows the read then answers); remove projectTask's unresolved-primary return (case 1, the outcome) — each must then fail on the outcome, the stored row or the durable difference, not on a compile or fixture error; NOT killed by this fixture, and named so none is counted: removing the `if (!row) return null` guard (projectTask then throws on the null row and the caller's catch returns the same null with no run); removing the caller's try/catch (nothing here throws); dropping the `team_id` or `status` equality from the integrations read (no integration row exists in either team); taking `startedAt` after the task load instead of before it (still within the call's window); no mutation evidence is supplied here",
  );
  it.todo(
    "INVENTORY AND ACCEPTANCE · the complete AIO-1217 Server Action inventory, its acceptance criteria, connection inventory, documentation, full-suite checks and final review are not supplied by this file, which evidences one reactive caller's no-primary composition by direct invocation only",
  );
});
