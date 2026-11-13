import { describe, expect, it } from "vitest";
import { getPool } from "@/lib/db/pg/pool";
import type { IngestTrigger } from "@/lib/ingest/runs";
import type { ProjectionReport } from "@/lib/pm-sync/project";
import type { PmProvider } from "@/lib/pm-sync/provider";
import {
  getProjectionHealth,
  listRecentProjectionRuns,
  recordProjectionRun,
  type RecordProjectionRunInput,
} from "@/lib/pm-sync/runs";
import { db, seedTeam, type Seed } from "./helpers";

/**
 * AIO-1217 — NATIVE PM PROJECTION-RUN OWNER against real Postgres: what
 * `lib/pm-sync/runs.ts#recordProjectionRun` itself writes, called directly over synthetic teams and
 * synthetic projection reports in the task's data-mechanics Postgres, with the real
 * `summarizeProjectionReports` roll-up and the real `lib/ingest/runs.ts#recordIngestRun` single writer
 * of `ingest_runs` beneath it. This is the native complement of
 * `aio1217-admin-guard-association.datamechanics.test.ts`, where the same owner is a recording seam:
 * that file shows the wrapper is bound to the gate and executes nothing beneath it; this one executes
 * what is beneath it and nothing above. Of that file's "BATCH 4 OWNER WORK" TODO it supplies the
 * `recordProjectionRun` → `ingest_runs` part alone.
 *
 *   1 — a successful, nonempty report set: the whole stored row; then a call that hands no finish.
 *   2 — a report set containing failing rows: after an ok control, the stored failure and its lines.
 *   3 — OBSERVED: a failed row with no error text; an error text on a row that is not a failure.
 *   4 — OBSERVED: the delegated writer's caps on the stored error lines.
 *   5 — no reports: with a provider, without one, and without one WITH a reason.
 *   6 — two teams and one team-less run: each row holds the team id it was handed; readers per team.
 *   7 — OBSERVED: a SUPPLIED `no_primary_provider` report, in the shape `projectTask` returns one.
 *   8 — three runs stored in an order that is not their finish order: what the readers then answer.
 *   Z — what this file does not supply, as executable TODOs naming the owner.
 *
 * What is real, and never mocked: the owner, the roll-up, the `ingest_runs` writer, the two readers
 * `listRecentProjectionRuns` and `getProjectionHealth`, the query builder, the pg pool and Postgres.
 * There is no seam in this file. Every observation is a whole-rowset difference of `ingest_runs`,
 * `audit_log`, `teams`, `integrations`, `tasks` and `task_pm_links`, read from the pool by raw SQL
 * before and after the one call, so "exactly one row" is a statement about the whole table and not
 * about a filtered read. A stored run is compared whole: every column `ingest_runs` has.
 *
 * THE REPORTS ARE SYNTHETIC INPUTS. No projection produced them: each is a complete
 * `ProjectionReport` — row key, provider, status, provider resource id, error — written out by this
 * file and handed to the owner as its callers hand theirs. The two instants of a run are the test's
 * own too, so `started_at`, `finished_at` and `duration_ms` are compared exactly; case 1 also hands a
 * start and no finish, as the owner's callers in app/, lib/ and scripts/ do today. Case 7's one report
 * differs in shape only: it is written as `lib/pm-sync/project.ts#projectTask` returns a report for an
 * unresolved primary — no provider, no provider resource id key, the resolution's reason as its error —
 * and is as much this file's own input as every other.
 *
 * NOTHING HERE IS A CREDENTIAL. No integration row, secret, token or provider account is created or
 * read; `provider` is a label on the input. Row keys, resource ids and error texts are fixed synthetic
 * strings of this file, and nothing of any real team, member or board is captured.
 *
 * Bounds of what is claimed.
 *   - NATIVE OWNER BEHAVIOR ONLY. Direct calls of the lib function: not Next action-wire, not POST
 *     dispatch, not `requireTeamAdmin` admission or denial, not session or posture, not the
 *     `team.project_board` audit row and not revalidation. The action-to-guard association of
 *     `app/t/[team]/admin/pm-sync/actions.ts#projectBoardAction` is the association file's evidence
 *     and is neither repeated nor extended here.
 *   - THE TEAM ID IS SUPPLIED, NOT AUTHORIZED. The owner takes `teamId` as given and writes it into
 *     the row; it performs no check of who asks. Case 6's confinement is a statement about which
 *     team id a row holds and which rows each reader answers, not about who may record or read.
 *   - NO PROJECTION, NO RECONCILE, NO PROVIDER. `projectAllTasks`, `projectTask`, `projectRows`,
 *     `resolvePrimaryProvider`, `reconcileProviderState`, the Plane and Linear adapters, their network
 *     and every `task_pm_links` write are other owners and are not exercised. The empty difference of
 *     `tasks` and `task_pm_links` is this call's: it says the run log writes neither, and nothing
 *     about the owners that do. Case 7 SUPPLIES a `no_primary_provider` report; it is not a run of
 *     `projectTask` or of provider resolution, and says nothing of whether, when or through which
 *     caller such a report reaches the owner.
 *   - CASES 3, 4, 7 AND PART OF 5 ARE OBSERVATIONS. A not-ok run with no error line, a run turned
 *     not-ok by a line on a row that did not fail, the caps of 25 lines and 500 characters, an empty
 *     report set recorded `ok`, and a `no_primary_provider` row counted `unchanged` yet stored not-ok
 *     by its line are recorded as the source has them. None is declared correct.
 *   - THE READERS ARE EVIDENCED ONLY AS ASSERTED. `listRecentProjectionRuns` and `getProjectionHealth`
 *     are called as the owner's consumers and reduced to run ids and the health status. Evidenced of
 *     them is what a case explicitly asserts and no more: which run ids each answers for the team id
 *     it is handed and in what order (the other team's and the team-less run absent where cases 1, 2,
 *     5, 6 and 7 assert it; newest `finished_at` first where case 8 does), and the statuses
 *     `never_run`, `ok` and `failed` where one is asserted. Every run here is a `pm_sync` row, so the
 *     `source` filter is not evidenced; nor are `stale`, the 24-hour rule, the backstop probe,
 *     `ageMs`, the list limit, the Admin panels and `GET /api/v1/pm-sync/health`.
 *   - ONLY THE WRITE'S SUCCESS IS OBSERVED. The writer is best-effort and never throws; an insert
 *     Postgres refuses would show here as a missing row. No write failure is exercised.
 *   - `ingest_runs` is not in the tier's truncate list; it is emptied before each test by the
 *     cascade from `teams`. Case 6 reads that back as a premise before it counts rows.
 *   - Nothing about API keys. AIO-1226 and the zero-row revoke residual are other files' and are
 *     neither touched nor supplied here.
 *
 * Run status. RECORDED FOR THE STAGE AT `f8c81fbf`, before cases 7 and 8 existed: 13 PASS / 18 TODO
 * combined for that stage, of which this file 6 PASS / 10 TODO; lint PASS. Those figures are that
 * commit's, carried here as recorded and not re-observed. THIS REVISION IS NOT RUN: cases 7 and 8 and
 * the prose revised with them were written without executing vitest, tsc, lint or any other command,
 * and their expectations come from reading the sources above, not from an observed run. The recorded
 * figures cover neither new case; replace this paragraph with the observed result once this revision
 * has been executed.
 */

const FIXTURE = "FIXTURE PREMISE FAILED (setup, not an owner observation):";
const CONTROL = "OK CONTROL FAILED (the paired observation would be vacuous):";

type Row = Record<string, unknown>;

/** Two teams, several recorded runs, and whole-rowset snapshots around each call. */
const ROOMY = 30_000;

/** The prefix of every synthetic provider resource id a report carries; no stored row may hold it. */
const RESOURCE = "aio1217-synthetic-issue";

/**
 * The one resolution reason this file uses, as case 5's `reason` and as case 7's report error:
 * `resolvePrimaryProvider`'s own text, used as a label.
 */
const NO_PROVIDER_REASON = "no enabled PM integration";

interface World {
  a: Seed;
  b: Seed;
}

/** A run's two instants as the owner is handed them, in epoch ms. */
interface Clock {
  startedAt: number;
  finishedAt: number;
}

/** How a call ended: what it returned, or how its rejection classifies. */
type Settled = { returned: unknown } | { rejected: { error: boolean; message: string } };

interface Seen {
  outcome: Settled;
  changed: Changed;
  /** This process's clock immediately around the call. */
  window: { earliest: number; latest: number };
}

/** What the two projection-run readers answer for one team, reduced to run ids and the status. */
interface Read {
  /** `listRecentProjectionRuns`, newest first. */
  listed: string[];
  /** `getProjectionHealth`'s status and the run it names. */
  health: string;
  lastRun: string | null;
}

const NEVER_RUN: Read = { listed: [], health: "never_run", lastRun: null };

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

// The table the owner writes, and the ones a projection, a reconcile or an action would touch.
const DURABLE_TABLES = ["ingest_runs", "audit_log", "teams", "integrations", "tasks", "task_pm_links"] as const;
type DurableTable = (typeof DURABLE_TABLES)[number];
type Durable = Record<DurableTable, Row[]>;
type Changed = Partial<Record<DurableTable, { added: Row[]; removed: Row[] }>>;

/** A stored run with its two instants as epoch ms, so they compare with the instants handed in. */
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

/** Two teams, each with its seeded member. Whichever is not recorded for is the bystander. */
async function seedWorld(): Promise<World> {
  const a = await seedTeam();
  const b = await seedTeam();
  premise("the two teams are distinct", a.teamId === b.teamId, false);
  return { a, b };
}

/** Finished `agoMs` before now, having lasted `lastedMs`: instants of the test's choosing. */
function ranAt(agoMs: number, lastedMs: number): Clock {
  const finishedAt = Date.now() - agoMs;
  return { startedAt: finishedAt - lastedMs, finishedAt };
}

/** Every stored run's id and team id, in the order they were written. */
const runsByTeam = (): Promise<Row[]> =>
  // Ordered by the qualified column: a bare `id` would name the text output column and sort "10" before "9".
  fx("ingest_runs team readback", `select id::text as id, team_id from ingest_runs order by ingest_runs.id`);

// ── the synthetic reports ────────────────────────────────────────────────────────────────────────

const key = (n: number): string => `AIO1217-P${n}`;

/** A complete synthetic projection report: every field the engine's report carries. */
const report = (
  rowKey: string,
  provider: PmProvider | null,
  status: ProjectionReport["status"],
  extra: { providerResourceId: string | null; error?: string },
): ProjectionReport => ({ row_key: rowKey, provider, status, ...extra });

/** A row the provider wrote: it carries the synthetic id of the issue written. */
const wrote = (n: number, provider: PmProvider, status: "synced" | "adopted" = "synced"): ProjectionReport =>
  report(key(n), provider, status, { providerResourceId: `${RESOURCE}-${n}` });

/** A row with nothing to do. */
const idle = (n: number, provider: PmProvider, status: "skipped" | "no_row_key" = "skipped"): ProjectionReport =>
  report(key(n), provider, status, { providerResourceId: null });

/** A row counted as a failure; `error` is left off entirely when not given. */
const failing = (
  n: number,
  provider: PmProvider,
  status: "failed" | "missing_integration" | "missing_parent" | "cycle",
  error?: string,
): ProjectionReport =>
  report(key(n), provider, status, { providerResourceId: null, ...(error === undefined ? {} : { error }) });

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

/** Snapshot, make the one direct call of the owner over the helper client, snapshot again. */
async function observe(input: RecordProjectionRunInput): Promise<Seen> {
  const before = await durable();
  const earliest = Date.now();
  const outcome = await settle(() => recordProjectionRun(db(), input));
  const latest = Date.now();
  const after = await durable();
  return { outcome, changed: changes(before, after), window: { earliest, latest } };
}

/** The one run a call added, as the pool read it back. Asked for only after that has been asserted. */
function runOf(seen: Seen): Row {
  const added = seen.changed.ingest_runs?.added ?? [];
  if (added.length !== 1) throw new Error(`expected exactly one added ingest_runs row, got ${added.length}`);
  return added[0];
}

const idOf = (seen: Seen): string => String(runOf(seen).id);

/** The owner's two readers for one team, each over the helper client. */
async function read(team: Seed): Promise<Read> {
  const runs = await listRecentProjectionRuns(db(), team.teamId);
  const health = await getProjectionHealth(db(), team.teamId);
  return {
    listed: runs.map((run) => String(run.id)),
    health: health.status,
    lastRun: health.lastRun ? String(health.lastRun.id) : null,
  };
}

// ── what a call leaves behind ────────────────────────────────────────────────────────────────────

/** What one run is expected to hold, beyond the team it was handed. */
interface Facts {
  trigger: IngestTrigger;
  ok: boolean;
  created: number;
  unchanged: number;
  errors: string[];
  meta: Row;
  at: Clock;
}

/** The whole `ingest_runs` row of one projection run: every column the table has. */
const runRow = (teamId: string | null, facts: Facts): Row => ({
  id: expect.any(Number),
  team_id: teamId,
  source: "pm_sync",
  trigger: facts.trigger,
  ok: facts.ok,
  created: facts.created,
  // The owner hands the writer no `updated`: the column holds the writer's zero.
  updated: 0,
  unchanged: facts.unchanged,
  error_count: facts.errors.length,
  errors: facts.errors,
  meta: facts.meta,
  started_at: facts.at.startedAt,
  finished_at: facts.at.finishedAt,
  duration_ms: facts.at.finishedAt - facts.at.startedAt,
});

/**
 * A recorded run: the call resolves with nothing, `ingest_runs` gains exactly `row` and loses none,
 * and no row of any other durable table is added, removed or changed.
 */
const recorded = (row: Row) => ({
  outcome: { returned: undefined },
  changed: { ingest_runs: { added: [row], removed: [] } },
});

const seenOf = (seen: Seen) => ({ outcome: seen.outcome, changed: seen.changed });

describe("AIO-1217 native PM projection-run owner — lib/pm-sync/runs recordProjectionRun over real Postgres (direct calls: no action, no guard, no provider, no seam)", () => {
  it(
    "1 — a successful, nonempty report set (two synced, one adopted, one skipped, one no_row_key) for team A: the call resolves with nothing and adds exactly one ingest_runs row holding team A, source `pm_sync`, the trigger handed in, `ok: true`, `created: 3` (synced plus adopted), `updated: 0`, `unchanged: 2`, no error line, `meta` of the provider and the per-status counts, and the two instants handed in with their difference as `duration_ms`; no report's provider resource id is stored; no other table changes; a second call handing a start and NO finish is stamped within the call; team A's readers answer both runs newest first and `ok`, team B's answer none",
    async () => {
      const world = await seedWorld();
      premise("neither team has a recorded run", [await read(world.a), await read(world.b)], [NEVER_RUN, NEVER_RUN]);

      const at = ranAt(60_000, 1_500);
      const first = await observe({
        teamId: world.a.teamId,
        provider: "linear",
        trigger: "manual",
        reports: [
          wrote(0, "linear"),
          wrote(1, "linear"),
          wrote(2, "linear", "adopted"),
          idle(3, "linear"),
          idle(4, "linear", "no_row_key"),
        ],
        ...at,
      });

      expect({ ...seenOf(first), resourceIdStored: JSON.stringify(first.changed).includes(RESOURCE) }).toEqual({
        ...recorded(
          runRow(world.a.teamId, {
            trigger: "manual",
            ok: true,
            created: 3,
            unchanged: 2,
            errors: [],
            meta: { provider: "linear", synced: 2, adopted: 1, skipped: 1, no_row_key: 1 },
            at,
          }),
        ),
        resourceIdStored: false,
      });

      // As the owner's callers hand it today: a start instant and no finish. The writer stamps its own.
      const startedAt = Date.now() - 250;
      const second = await observe({
        teamId: world.a.teamId,
        provider: "linear",
        trigger: "cli",
        reports: [wrote(5, "linear")],
        startedAt,
      });

      expect(seenOf(second), "a start and no finish").toEqual(
        recorded({
          ...runRow(world.a.teamId, {
            trigger: "cli",
            ok: true,
            created: 1,
            unchanged: 0,
            errors: [],
            meta: { provider: "linear", synced: 1 },
            at: { startedAt, finishedAt: startedAt },
          }),
          // Not the test's to choose here: bounded by the call's window just below.
          finished_at: expect.any(Number),
          duration_ms: expect.any(Number),
        }),
      );
      // The finish is this call's own clock, and the duration is measured from the start handed in.
      const stamped = runOf(second);
      expect(stamped.finished_at).toBeGreaterThanOrEqual(second.window.earliest);
      expect(stamped.finished_at).toBeLessThanOrEqual(second.window.latest);
      expect(stamped.duration_ms).toBe(Number(stamped.finished_at) - startedAt);

      expect({ a: await read(world.a), b: await read(world.b) }).toEqual({
        a: { listed: [idOf(second), idOf(first)], health: "ok", lastRun: idOf(second) },
        b: NEVER_RUN,
      });
    },
    ROOMY,
  );

  it(
    "2 — a report set containing failing rows: after an ok control of the same set without them, one synced, one skipped and one each of failed, missing_integration, missing_parent and cycle — each failing row carrying an error text — is stored as exactly one row with `ok: false`, `created: 1`, `unchanged: 1`, `error_count: 4`, the four lines `<row key>: <error>` in report order, and `meta` counting each of the six statuses SUPPLIED (supplied-status coverage: six of the nine a report can carry, not every status, and no projection chose them); the control row is not rewritten; team A's readers then answer `failed` naming that run, with the control listed beneath it",
    async () => {
      const world = await seedWorld();

      const controlAt = ranAt(120_000, 800);
      const control = await observe({
        teamId: world.a.teamId,
        provider: "plane",
        trigger: "api",
        reports: [wrote(0, "plane"), idle(1, "plane")],
        ...controlAt,
      });
      expect(seenOf(control), CONTROL).toEqual(
        recorded(
          runRow(world.a.teamId, {
            trigger: "api",
            ok: true,
            created: 1,
            unchanged: 1,
            errors: [],
            meta: { provider: "plane", synced: 1, skipped: 1 },
            at: controlAt,
          }),
        ),
      );
      expect(await read(world.a), CONTROL).toEqual({
        listed: [idOf(control)],
        health: "ok",
        lastRun: idOf(control),
      });

      const at = ranAt(60_000, 2_000);
      const seen = await observe({
        teamId: world.a.teamId,
        provider: "plane",
        trigger: "api",
        reports: [
          wrote(0, "plane"),
          idle(1, "plane"),
          failing(2, "plane", "failed", "aio1217 synthetic provider refusal"),
          failing(3, "plane", "missing_integration", "aio1217 synthetic missing integration"),
          failing(4, "plane", "missing_parent", "aio1217 synthetic missing parent"),
          failing(5, "plane", "cycle", "aio1217 synthetic parent cycle"),
        ],
        ...at,
      });

      // `removed: []` inside: the control's row stands as it was written.
      expect(seenOf(seen)).toEqual(
        recorded(
          runRow(world.a.teamId, {
            trigger: "api",
            ok: false,
            created: 1,
            // Six reports, one written and four failing: the skipped row alone.
            unchanged: 1,
            errors: [
              "AIO1217-P2: aio1217 synthetic provider refusal",
              "AIO1217-P3: aio1217 synthetic missing integration",
              "AIO1217-P4: aio1217 synthetic missing parent",
              "AIO1217-P5: aio1217 synthetic parent cycle",
            ],
            meta: {
              provider: "plane",
              synced: 1,
              skipped: 1,
              failed: 1,
              missing_integration: 1,
              missing_parent: 1,
              cycle: 1,
            },
            at,
          }),
        ),
      );

      expect({ a: await read(world.a), b: await read(world.b) }).toEqual({
        a: { listed: [idOf(seen), idOf(control)], health: "failed", lastRun: idOf(seen) },
        b: NEVER_RUN,
      });
    },
    ROOMY,
  );

  it(
    "3 — OBSERVED, as the source derives it and not declared correct: a failed row carrying NO error text is stored `ok: false` with `error_count: 0` and no line — a failure with nothing saying why; and, after an ok control of the same two rows, an error text on a row whose status is `skipped` is stored as one line and turns the run `ok: false` though no row failed, its counts unchanged (whether projection ever emits such a report is not claimed)",
    async () => {
      const world = await seedWorld();

      const silentAt = ranAt(180_000, 400);
      const silent = await observe({
        teamId: world.a.teamId,
        provider: "linear",
        trigger: "api",
        reports: [failing(0, "linear", "failed")],
        ...silentAt,
      });
      expect(seenOf(silent), "a failed row with no error text").toEqual(
        recorded(
          runRow(world.a.teamId, {
            trigger: "api",
            ok: false,
            created: 0,
            unchanged: 0,
            errors: [],
            meta: { provider: "linear", failed: 1 },
            at: silentAt,
          }),
        ),
      );

      const counts = { created: 1, unchanged: 1, meta: { provider: "linear", synced: 1, skipped: 1 } };

      const controlAt = ranAt(120_000, 400);
      const control = await observe({
        teamId: world.a.teamId,
        provider: "linear",
        trigger: "api",
        reports: [wrote(1, "linear"), idle(2, "linear")],
        ...controlAt,
      });
      expect(seenOf(control), CONTROL).toEqual(
        recorded(runRow(world.a.teamId, { trigger: "api", ok: true, ...counts, errors: [], at: controlAt })),
      );

      const notedAt = ranAt(60_000, 400);
      const noted = await observe({
        teamId: world.a.teamId,
        provider: "linear",
        trigger: "api",
        reports: [
          wrote(1, "linear"),
          report(key(2), "linear", "skipped", { providerResourceId: null, error: "aio1217 synthetic note" }),
        ],
        ...notedAt,
      });
      // The roll-up counts no failure; the writer derives `ok` to false from the line alone.
      expect(seenOf(noted), "an error text on a skipped row").toEqual(
        recorded(
          runRow(world.a.teamId, {
            trigger: "api",
            ok: false,
            ...counts,
            errors: ["AIO1217-P2: aio1217 synthetic note"],
            at: notedAt,
          }),
        ),
      );

      expect(await read(world.a)).toEqual({
        listed: [idOf(noted), idOf(control), idOf(silent)],
        health: "failed",
        lastRun: idOf(noted),
      });
    },
    ROOMY,
  );

  it(
    "4 — OBSERVED, the delegated writer's caps as the source has them: twenty-seven failed rows, each with an error text and the first's 600 characters long, are stored as one row with `meta.failed: 27` but `error_count: 25` — the first twenty-five lines in report order, the first cut to 500 characters — so the stored error count is not the number of rows that failed",
    async () => {
      const world = await seedWorld();
      const rowKey = (n: number): string => `AIO1217-L${String(n).padStart(2, "0")}`;

      const at = ranAt(60_000, 3_000);
      const seen = await observe({
        teamId: world.a.teamId,
        provider: "linear",
        trigger: "manual",
        reports: Array.from({ length: 27 }, (_, n) =>
          report(rowKey(n), "linear", "failed", {
            providerResourceId: null,
            error: n === 0 ? "x".repeat(600) : `aio1217 synthetic failure ${n}`,
          }),
        ),
        ...at,
      });

      expect(seenOf(seen)).toEqual(
        recorded(
          runRow(world.a.teamId, {
            trigger: "manual",
            ok: false,
            created: 0,
            unchanged: 0,
            errors: [
              // `AIO1217-L00: ` is 13 characters: 487 of the 600 remain.
              `AIO1217-L00: ${"x".repeat(487)}`,
              ...Array.from({ length: 24 }, (_, i) => `${rowKey(i + 1)}: aio1217 synthetic failure ${i + 1}`),
            ],
            meta: { provider: "linear", failed: 27 },
            at,
          }),
        ),
      );
      expect((runOf(seen).errors as string[]).map((line) => line.length <= 500)).toEqual(Array(25).fill(true));
    },
    ROOMY,
  );

  it(
    "5 — no reports: with a provider and no reason the owner stores one row `ok: true` with zero counts and `meta` of the provider alone, and with NO provider and no reason the same with `meta.provider: null` (OBSERVED: an empty run reads `ok`; which caller composes such an input is not claimed); with no provider and the reason `no enabled PM integration` it stores `ok: false`, `error_count: 1` and that reason as the one line — the reason, not the absent provider, is what records the failure; the team's readers answer `ok` and then `failed`",
    async () => {
      const world = await seedWorld();
      const empty = { ok: true, created: 0, unchanged: 0, errors: [] };

      const withProviderAt = ranAt(180_000, 100);
      const withProvider = await observe({
        teamId: world.a.teamId,
        provider: "linear",
        trigger: "manual",
        reports: [],
        ...withProviderAt,
      });
      expect(seenOf(withProvider), "a provider, no reports, no reason").toEqual(
        recorded(
          runRow(world.a.teamId, { trigger: "manual", ...empty, meta: { provider: "linear" }, at: withProviderAt }),
        ),
      );

      const bareAt = ranAt(120_000, 100);
      const bare = await observe({
        teamId: world.a.teamId,
        provider: null,
        trigger: "manual",
        reports: [],
        ...bareAt,
      });
      expect(seenOf(bare), "no provider, no reports, no reason").toEqual(
        recorded(runRow(world.a.teamId, { trigger: "manual", ...empty, meta: { provider: null }, at: bareAt })),
      );
      expect(await read(world.a), "after two empty runs").toEqual({
        listed: [idOf(bare), idOf(withProvider)],
        health: "ok",
        lastRun: idOf(bare),
      });

      const reasonedAt = ranAt(60_000, 100);
      const reasoned = await observe({
        teamId: world.a.teamId,
        provider: null,
        trigger: "cli",
        reports: [],
        reason: NO_PROVIDER_REASON,
        ...reasonedAt,
      });
      expect(seenOf(reasoned), "no provider, no reports, a reason").toEqual(
        recorded(
          runRow(world.a.teamId, {
            trigger: "cli",
            ok: false,
            created: 0,
            unchanged: 0,
            errors: [NO_PROVIDER_REASON],
            meta: { provider: null },
            at: reasonedAt,
          }),
        ),
      );

      expect({ a: await read(world.a), b: await read(world.b) }).toEqual({
        a: { listed: [idOf(reasoned), idOf(bare), idOf(withProvider)], health: "failed", lastRun: idOf(reasoned) },
        b: NEVER_RUN,
      });
    },
    ROOMY,
  );

  it(
    "6 — two teams and one team-less run, each row holding the team id the call was handed: an ok run for team A leaves team B's readers at never-run; a failed run for team B is stored under team B and leaves team A's readers `ok` on team A's own run; a second run for team A and a run handed `teamId: null` each add one row and rewrite none; read back raw, the four rows hold A, B, A and null in that order; team A's readers answer its two runs, team B's its one, and the team-less run is in neither",
    async () => {
      const world = await seedWorld();
      premise("ingest_runs starts empty", await runsByTeam(), []);

      const firstAt = ranAt(180_000, 500);
      const first = await observe({
        teamId: world.a.teamId,
        provider: "linear",
        trigger: "manual",
        reports: [wrote(0, "linear")],
        ...firstAt,
      });
      // What a run of one synced row holds, whichever team it is recorded for.
      const oneSynced = { ok: true, created: 1, unchanged: 0, errors: [], meta: { provider: "linear", synced: 1 } };
      expect(seenOf(first), "team A's first run").toEqual(
        recorded(runRow(world.a.teamId, { trigger: "manual", ...oneSynced, at: firstAt })),
      );
      expect({ a: await read(world.a), b: await read(world.b) }, "after team A's first run").toEqual({
        a: { listed: [idOf(first)], health: "ok", lastRun: idOf(first) },
        b: NEVER_RUN,
      });

      const otherAt = ranAt(120_000, 500);
      const other = await observe({
        teamId: world.b.teamId,
        provider: "plane",
        trigger: "api",
        reports: [wrote(0, "plane"), failing(1, "plane", "failed", "aio1217 synthetic provider refusal")],
        ...otherAt,
      });
      expect(seenOf(other), "team B's failed run").toEqual(
        recorded(
          runRow(world.b.teamId, {
            trigger: "api",
            ok: false,
            created: 1,
            unchanged: 0,
            errors: ["AIO1217-P1: aio1217 synthetic provider refusal"],
            meta: { provider: "plane", synced: 1, failed: 1 },
            at: otherAt,
          }),
        ),
      );
      // Team B's later, failed run is not team A's last run.
      expect({ a: await read(world.a), b: await read(world.b) }, "after team B's failed run").toEqual({
        a: { listed: [idOf(first)], health: "ok", lastRun: idOf(first) },
        b: { listed: [idOf(other)], health: "failed", lastRun: idOf(other) },
      });

      const secondAt = ranAt(60_000, 500);
      const second = await observe({
        teamId: world.a.teamId,
        provider: "linear",
        trigger: "cli",
        reports: [wrote(2, "linear")],
        ...secondAt,
      });
      expect(seenOf(second), "team A's second run").toEqual(
        recorded(runRow(world.a.teamId, { trigger: "cli", ...oneSynced, at: secondAt })),
      );

      // `teamId: null` is the input's own instance-wide form; the source names no caller that uses it.
      const teamlessAt = ranAt(30_000, 500);
      const teamless = await observe({
        teamId: null,
        provider: "linear",
        trigger: "scheduler",
        reports: [wrote(3, "linear")],
        ...teamlessAt,
      });
      expect(seenOf(teamless), "a team-less run").toEqual(
        recorded(runRow(null, { trigger: "scheduler", ...oneSynced, at: teamlessAt })),
      );

      expect({ stored: await runsByTeam(), a: await read(world.a), b: await read(world.b) }).toEqual({
        stored: [
          { id: idOf(first), team_id: world.a.teamId },
          { id: idOf(other), team_id: world.b.teamId },
          { id: idOf(second), team_id: world.a.teamId },
          { id: idOf(teamless), team_id: null },
        ],
        a: { listed: [idOf(second), idOf(first)], health: "ok", lastRun: idOf(second) },
        b: { listed: [idOf(other)], health: "failed", lastRun: idOf(other) },
      });
    },
    ROOMY,
  );

  it(
    "7 — OBSERVED, a SUPPLIED report and not a projection: one synthetic `no_primary_provider` report written in the shape `projectTask` returns for an unresolved primary (`provider: null`, no provider resource id key, the reason `no enabled PM integration` as its error), handed with `provider: null` and NO reason, is stored as exactly one row `ok: false`, `created: 0`, `unchanged: 1`, `error_count: 1` with the one line `<row key>: <error>`, and `meta` of the null provider and `no_primary_provider: 1` — counted `unchanged`, not failed, and not-ok by its line alone; team A's readers answer `failed` naming it, team B's none (no `projectTask`, provider resolution, action wire, session, audit or caller composition is executed)",
    async () => {
      const world = await seedWorld();

      // Written out here in the shape `projectTask` returns it: no `providerResourceId` key at all.
      const unresolved: ProjectionReport = {
        row_key: key(0),
        provider: null,
        status: "no_primary_provider",
        error: NO_PROVIDER_REASON,
      };

      const at = ranAt(60_000, 300);
      const seen = await observe({
        teamId: world.a.teamId,
        provider: null,
        trigger: "api",
        reports: [unresolved],
        ...at,
      });

      // The roll-up counts no failure and one unchanged row; the writer derives `ok` to false from the line.
      expect(seenOf(seen)).toEqual(
        recorded(
          runRow(world.a.teamId, {
            trigger: "api",
            ok: false,
            created: 0,
            unchanged: 1,
            errors: [`AIO1217-P0: ${NO_PROVIDER_REASON}`],
            meta: { provider: null, no_primary_provider: 1 },
            at,
          }),
        ),
      );

      expect({ a: await read(world.a), b: await read(world.b) }).toEqual({
        a: { listed: [idOf(seen)], health: "failed", lastRun: idOf(seen) },
        b: NEVER_RUN,
      });
    },
    ROOMY,
  );

  it(
    "8 — three runs for team A stored in an order that is NOT their finish order — first the oldest finish, then the newest finish (a failed run, and the earliest START of the three), last the middle finish (an ok run): read back raw, the three ids stand in insertion order; team A's readers answer newest `finished_at` first — the run stored second, the run stored last, the run stored first — and `failed` naming the newest-finished run, not the ok run stored last (the instants are the test's own, a minute apart: no sleep, no staleness, no backstop, no route)",
    async () => {
      const world = await seedWorld();
      premise("ingest_runs starts empty", await runsByTeam(), []);
      const oneSynced = { ok: true, created: 1, unchanged: 0, errors: [], meta: { provider: "linear", synced: 1 } };

      const oldestAt = ranAt(180_000, 2_000);
      const oldest = await observe({
        teamId: world.a.teamId,
        provider: "linear",
        trigger: "manual",
        reports: [wrote(0, "linear")],
        ...oldestAt,
      });
      expect(seenOf(oldest), "stored first: the oldest finish").toEqual(
        recorded(runRow(world.a.teamId, { trigger: "manual", ...oneSynced, at: oldestAt })),
      );

      // Ten minutes long: the newest finish and the earliest start, so start order is not finish order either.
      const newestAt = ranAt(60_000, 600_000);
      const newest = await observe({
        teamId: world.a.teamId,
        provider: "linear",
        trigger: "api",
        reports: [failing(1, "linear", "failed", "aio1217 synthetic provider refusal")],
        ...newestAt,
      });
      expect(seenOf(newest), "stored second: the newest finish, a failed run").toEqual(
        recorded(
          runRow(world.a.teamId, {
            trigger: "api",
            ok: false,
            created: 0,
            unchanged: 0,
            errors: ["AIO1217-P1: aio1217 synthetic provider refusal"],
            meta: { provider: "linear", failed: 1 },
            at: newestAt,
          }),
        ),
      );

      const middleAt = ranAt(120_000, 1_000);
      const middle = await observe({
        teamId: world.a.teamId,
        provider: "linear",
        trigger: "cli",
        reports: [wrote(2, "linear")],
        ...middleAt,
      });
      expect(seenOf(middle), "stored last: the middle finish").toEqual(
        recorded(runRow(world.a.teamId, { trigger: "cli", ...oneSynced, at: middleAt })),
      );

      premise(
        "the runs stand in insertion order: oldest finish, newest finish, middle finish",
        await runsByTeam(),
        [oldest, newest, middle].map((seen) => ({ id: idOf(seen), team_id: world.a.teamId })),
      );

      // By id or by start the ok run stored last would lead; by `finished_at` the failed run does.
      expect(await read(world.a)).toEqual({
        listed: [idOf(newest), idOf(middle), idOf(oldest)],
        health: "failed",
        lastRun: idOf(newest),
      });
    },
    ROOMY,
  );
});

// Each TODO names the owner of evidence this slice was told not to supply.
describe("Z — evidence this file does NOT supply (executable TODOs: none is run, none is passed)", () => {
  it.todo(
    "NATIVE PROJECT OWNER · projectAllTasks, projectTask, projectRows and resolvePrimaryProvider — primary-provider resolution, the decrypting integrations read, the Plane and Linear adapters, their network, the task_pm_links writes and the reports they produce — are a different owner; every report here is a synthetic input written by this file — case 7's `no_primary_provider` report included, which copies the shape projectTask returns for an unresolved primary and is not returned by it — and no projection, provider resolution, provider or link is executed",
  );
  it.todo(
    "NATIVE RECONCILE OWNER · reconcileProviderState — the provider's current state, `provider_seen_status`, the divergence rows and their provider reads — is a different owner and is not called by this file",
  );
  it.todo(
    "ACTION AND GUARD WIRE · requireTeamAdmin admission and denial, the `team.project_board` and `team.reconcile_divergence` audit rows, revalidation and the action wire of app/t/[team]/admin/pm-sync/actions.ts#projectBoardAction and #reconcileDivergenceAction are aio1217-admin-guard-association.datamechanics.test.ts's evidence; this file calls the lib owner directly and proves nothing about the wrappers, the session, posture or the admin page that renders the runs",
  );
  it.todo(
    "CALLER COMPOSITION · how projectBoardAction, lib/pm-sync/after-write.ts, app/actions/meeting-todos.ts and scripts/brain-tasks.ts compose the provider, reports, reason and trigger they hand the owner — including a reason withheld when a provider is known — is not exercised; cases 3, 5 and 7 record what the owner stores for an input, not that any caller produces it — case 7's input is written in the form lib/pm-sync/after-write.ts#projectTaskByIdAfterWrite is read to hand a lone report (the report's own provider, trigger `api`, no reason), with a finish instant of the test's own, and neither that caller nor any other is executed",
  );
  it.todo(
    "WRITE FAILURE · recordIngestRun is best-effort and never throws; a team id that does not exist, a refused insert and a failing client are not reached by this file, and whether a run that could not be recorded should stay silent is not specified by any source it reads",
  );
  it.todo(
    "OBSERVED DERIVATIONS · a not-ok run with no error line, a run turned not-ok by a line on a row that did not fail, the 25-line and 500-character caps that let `error_count` fall below the failed rows, an empty report set stored `ok: true`, and a `no_primary_provider` row counted `unchanged` yet stored `ok: false` by its line (cases 3, 4, 5 and 7) are recorded as observed; no contract for any of them is declared here",
  );
  it.todo(
    "REASON, REMAINDER · a reason handed together with a nonempty report set, and an empty-string reason, are not exercised; case 5 hands a reason with no reports and no provider only",
  );
  it.todo(
    "READERS, REMAINDER · listRecentProjectionRuns and getProjectionHealth are reduced here to run ids and the health status, and are evidenced only as a case explicitly asserts them: the run ids answered for the team id handed in, their `finished_at`-descending order and the run health names in case 8 alone, and the statuses `never_run`, `ok` and `failed`; `stale` and the 24-hour staleness rule, `ageMs`, the backstop probe, the list limit, the `source` filter, listRecentIngestRuns and pipeline health, the Admin panels and the authentication of GET /api/v1/pm-sync/health are not evidenced",
  );
  it.todo(
    "COORDINATOR · MUTANTS (isolated-copy actual-import run; every expectation below is read from source and NO mutant has been run): against this fixture, drop `adopted` from the synced sum (case 1, `created` and `unchanged`); drop one status from the failed sum — `missing_integration`, `missing_parent` or `cycle` is caught by case 2 through `unchanged` ALONE (2 for 1), its `ok` staying false through the remaining failing rows and the writer's error lines, and only `failed` is also caught through `ok` (case 3's failed row with no line); add `no_primary_provider` to the failed sum (case 7, through `unchanged` alone, 0 for 1 — its `ok` is already false by the line); drop the `reason` override of `errors` (case 5); hand the writer a fixed team id (case 6); drop the `team_id` equality from listRecentProjectionRuns (cases 1, 2, 5, 6 and 7, the other team's answer); order listRecentProjectionRuns by `id` or by `started_at` instead of `finished_at` (case 8 alone — every other case stores its runs in finish order with their starts in the same order) — each must then fail on the stored row or the readers' answer, not on a compile or fixture error; NOT killed by this fixture, and named so none is counted: dropping the `reason` override of `ok` alone (the writer re-derives `ok: false` from the reason line); dropping the `source` equality from listRecentProjectionRuns (every run this file writes is `pm_sync`); making a `no_primary_provider` row turn the roll-up's `ok` false without entering the failed sum (case 7's line already stores `ok: false`); removing the `Math.max(0, …)` clamp on `duration_ms` (no run here is handed a finish before its start) or on `unchanged` (no report set here sums past its length); raising either reader's limit (no team here holds more than three runs); and dropping the order altogether, whose result Postgres does not specify and which is counted neither way; no mutation evidence is supplied here",
  );
  it.todo(
    "INVENTORY AND ACCEPTANCE · the complete AIO-1217 Server Action inventory, its acceptance criteria, documentation and full-suite checks are not supplied by this file, which evidences one lib owner's write to ingest_runs only",
  );
});
