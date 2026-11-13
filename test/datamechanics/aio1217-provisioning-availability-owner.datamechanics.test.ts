import { randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PgClient } from "@/lib/db/pg/client";
import { getPool, runSql } from "@/lib/db/pg/pool";
import type { DbClient, SqlExecutor } from "@/lib/db/types";
import { setIntegrationSecret, setIntegrationStatus, upsertIntegration } from "@/lib/integrations/manage";
import { getProvisioningAvailability } from "@/lib/provisioning/run";
import { db, seedTeam, sha, type Seed } from "./helpers";

/**
 * AIO-1217 — NATIVE PROVISIONING-AVAILABILITY OWNER against real Postgres: what
 * `lib/provisioning/run.ts#getProvisioningAvailability` itself answers and reads, called directly over
 * synthetic team and integration rows in the task's data-mechanics Postgres, with the real Linear,
 * Slack and GitHub adapters' `isConfigured`, the real `enabledIntegration` →
 * `getEnabledIntegrationsWithSecrets` read and the real `decryptSecret` beneath it. This is the native
 * complement of `aio1217-admin-guard-association.datamechanics.test.ts`, where the same owner is a
 * recording seam: that file shows the wrapper is bound to the gate and executes nothing beneath it;
 * this one executes what is beneath it and nothing above.
 *
 *   1  — no integration rows: the three tools, in order, each unconfigured with its adapter's reason.
 *   2  — one enabled, complete row per tool: all three configured; nothing of the fixture is returned.
 *   3a — disabled rows are not read as configured, whatever they still hold; re-enabling restores.
 *   3b — enabled but incomplete rows: each adapter's own missing-conjunct reason, then each completed.
 *   4  — two teams: each call binds and answers its own team's rows; the other team's change no answer.
 *   5  — a test-only read fault: caught per tool into an unconfigured entry; the call still resolves.
 *   6  — OBSERVED: the GitHub adapter's process-wide `GITHUB_TOKEN` fallback.
 *   Z  — what this file does not supply, as executable TODOs naming the owner.
 *
 * What is real, and never mocked: the owner, the three adapters, the integrations read, the secret
 * decryption, the query builder, the pg pool and Postgres. Fixture rows are written only by the real
 * single writer of `integrations` — `upsertIntegration`, `setIntegrationSecret`, `setIntegrationStatus`
 * — so each secret is stored as that writer stores it: AES-256-GCM under the tier's fixed test
 * `SECRETS_KEY`.
 *
 * The synthetic seams, all of them:
 *   SEAM transport   the client the owner is handed is a real `PgClient` whose SQL executor RECORDS
 *                    each compiled statement, forwards it to the real pool `runSql` and records the
 *                    row count Postgres answered. Nothing above the executor is replaced. Case 2 also
 *                    calls the owner over the unrecorded helper client and compares the answer.
 *   SEAM read fault  case 5 only: the same executor throws a labelled test-only error for chosen
 *                    `integrations` reads BEFORE they reach Postgres. No production path is changed.
 *   SEAM process     `GITHUB_TOKEN` is pinned EMPTY for every test, because the GitHub adapter falls
 *                    back to it and a shell exporting one would otherwise answer for the fixture. Case
 *                    6 alone sets it, to a synthetic value generated in that test.
 *
 * Every call is one grouped assertion over: how the call settled; the key list of each returned entry;
 * the ORDERED TRACE of every statement the handed client issued — its operation, table, the equalities
 * bound into it and the row count answered; the durable difference, computed from whole rowsets of
 * `teams`, `members`, `integrations`, `member_provisioning` and `audit_log` read from the pool before
 * and after; whether a synthetic fixture value occurs in the answer or the adapter's log; and the
 * adapter's own `[pg]` log lines. Which conjunct a case holds or lacks is read back from the pool by
 * raw SQL as booleans, so it is a readback and not a fixture's say-so.
 *
 * SECRET HYGIENE. Every secret is generated per test from `randomBytes`, is synthetic and is usable
 * nowhere. Its plaintext is handed only to the real writer (or, in case 6, to the process environment)
 * and is never placed in an assertion, a test name, a SQL parameter of this file or a log line. A
 * stored ciphertext enters a snapshot only as its sha256. A settled outcome or log line in which a
 * synthetic value occurs is replaced whole by a fixed marker before it can reach an assertion, so a
 * failing escape check prints the marker and a boolean. The Slack invite link and the GitHub org are
 * NON-secret config by the source's own definition; they are synthetic too, and are held to the same
 * escape check.
 *
 * Bounds of what is claimed.
 *   - NATIVE OWNER BEHAVIOR ONLY. Direct calls of the lib function: not Next action-wire, not POST
 *     dispatch, not `requireTeamAdmin` admission or denial, not session or posture, not the invite UI.
 *     The action-to-guard association of `app/t/[team]/admin/actions.ts#getProvisioningAvailabilityAction`
 *     is the association file's evidence and is neither repeated nor extended here.
 *   - AVAILABILITY IS NOT AUTHORIZATION. The owner takes a team id as given and performs no check of
 *     who asks. `configured: true` says the adapter found what it reads; it says nothing about whether
 *     the stored secret is valid at the provider, and no provider is contacted by this file.
 *   - READ ONLY, AND ONLY THIS OWNER. `runProvisioning`, the adapters' `invite`, `member_provisioning`
 *     writes, `member.provisioned` audit rows and provider delivery are a different owner and are not
 *     exercised. The empty durable difference is the availability call's; the fixture's own rows are
 *     the integration writer's and are not this file's evidence about that writer.
 *   - THE UNAUDITED DECRYPTING READ IS A CURRENT SOURCE OBSERVATION. Each adapter's read is
 *     `getEnabledIntegrationsWithSecrets`: by source reading it selects EVERY enabled row of the
 *     team, whatever its type, and decrypts every stored secret in process — once per adapter, three
 *     times a call — and no `audit_log` row is appended for it. What this file observes of that is
 *     each trace's row count and the empty durable difference; the decryption itself is read from
 *     the source. Neither is a compliance finding that such a read needs no audit record, and
 *     neither is a no-write policy this owner is held to: a source that began auditing the read
 *     would fail these cases on the difference, and that would be a behavior to re-observe, not a
 *     regression this file rules on.
 *   - THE REASONS ARE THE SOURCE'S, NOT A POLICY. The GitHub adapter has no "no enabled integration"
 *     reason: an absent, a disabled and an org-less enabled row all answer `no GitHub org set`. That
 *     is recorded as it is and not declared correct.
 *   - TEAM CONFINEMENT IS A STATEMENT ABOUT INTEGRATION ROWS. Case 6's process `GITHUB_TOKEN` is not
 *     team state: it answers the token conjunct for every team that holds an org.
 *   - ONE ENABLED ROW PER TYPE AND TEAM. `enabledIntegration` documents the earliest-created row, but
 *     its read carries no ordering; which of several enabled rows of one type answers is not
 *     exercised here.
 *   - CASE 5 IS ONE FAULT. A thrown executor error for the `integrations` read. A native Postgres
 *     failure, an undecryptable stored ciphertext and the non-Error `check failed` fallback are not
 *     reached. The reason carries the read's error text verbatim; whether it should is not specified
 *     by any source this file reads, and is observed only.
 *   - ONE UNREADABLE ROW IS NOT EXERCISED. Because that read decrypts every enabled row, by source
 *     reading a single enabled row whose ciphertext cannot be decrypted — another tool's, or of a
 *     type no adapter here reads — would reject all three adapters' reads at once. No case holds
 *     such a row, or an enabled row of a fourth type: the coupling is a TODO below, not an
 *     observation.
 *   - Nothing about API keys. AIO-1226 and the zero-row revoke residual are other files' and are
 *     neither touched nor supplied here.
 *
 * Run status. The seven cases were authored without executing anything. Per the coordinator's
 * registered evidence, the file as committed at 9b150bde was then run on its own: stage
 * `batch5-provisioning-availability-pg` exited 0 with 7 passed and 7 todo, and the scoped lint stage
 * exited 0. That is one file's run — not the data-mechanics tier, not a mutation run and not a review
 * verdict, and no review outcome is recorded in this file. The later edit of this header and the
 * added eighth TODO changed no case, assertion or fixture and was itself written without executing
 * vitest, tsc or any other command: the file as it now stands is NOT RUN until its next registered
 * stage, and this paragraph is to be replaced with that result.
 */

const FIXTURE = "FIXTURE PREMISE FAILED (setup, not an owner observation):";
const CONTROL = "CONFIGURED CONTROL FAILED (the paired observation would be vacuous):";

const NATIVE_ERROR = "native error:";

type Row = Record<string, unknown>;
type Tool = "linear" | "slack" | "github";
type Status = "enabled" | "disabled";

/** Two teams, several integration writes, and whole-rowset snapshots around each call. */
const ROOMY = 30_000;

/** What replaces a settled outcome or a log line in which a synthetic fixture value occurs. */
const WITHHELD = "WITHHELD: a synthetic fixture value occurred here";

/** The message of the one test-only read fault, and what the adapter and the owner make of it. */
const READ_FAULT = "aio1217 test-only integrations read fault";
const READ_FAULT_LOG = `[pg] select integrations: ${READ_FAULT}`;
const READ_FAULT_REASON = `load integrations failed: ${READ_FAULT}`;

// The entries the three adapters answer, verbatim from lib/provisioning/{linear,slack,github}.ts.
const LINEAR: Row = { tool: "linear", configured: true };
const SLACK: Row = { tool: "slack", configured: true };
const GITHUB: Row = { tool: "github", configured: true };
const NO_LINEAR: Row = { tool: "linear", configured: false, reason: "no enabled Linear integration" };
const NO_LINEAR_KEY: Row = { tool: "linear", configured: false, reason: "Linear API key not set" };
const NO_SLACK: Row = { tool: "slack", configured: false, reason: "no enabled Slack integration" };
const NO_SLACK_LINK: Row = { tool: "slack", configured: false, reason: "no Slack invite link set" };
// The GitHub adapter's answer to an absent, a disabled and an org-less enabled row alike.
const NO_GITHUB_ORG: Row = { tool: "github", configured: false, reason: "no GitHub org set" };
const NO_GITHUB_TOKEN: Row = {
  tool: "github",
  configured: false,
  reason: "no GitHub token (connect one, or set GITHUB_TOKEN)",
};

/**
 * The keys every returned entry carries, in the order the owner writes them. `reason` is present on a
 * configured entry too, holding `undefined`: `toEqual` reads that as absent, so the outcome
 * comparison fails on a configured entry that carries any reason at all.
 */
const ENTRY_KEYS = ["tool", "configured", "reason"];

interface World {
  a: Seed;
  b: Seed;
}

/** How a call ended: what it returned, how its rejection classifies, or that it may not be printed. */
type Settled =
  | { returned: unknown }
  | { rejected: { error: boolean; message: string } }
  | { withheld: string };

/** One statement the handed client issued: what the real builder compiled and what Postgres answered. */
interface Step {
  op: string;
  table: string;
  where: Row;
  /** The row count answered; null when the statement was never answered. */
  rows: number | null;
}

interface Flight {
  trace: Step[];
  /** The statements Postgres itself refused; every call holds this empty. */
  refused: string[];
}

interface Seen {
  outcome: Settled;
  /** The key list of each returned entry; null when the call returned no list. */
  shape: string[][] | null;
  trace: Step[];
  changed: Changed;
  /** Whether a synthetic fixture value occurs in the settled outcome or in any adapter log line. */
  escaped: boolean;
  /** The real adapter's `[pg]` lines: one per failure it converted into a returned error. */
  logged: string[];
}

/** Which `integrations` reads of one call the test-only fault refuses, by the order they are issued. */
type Failing = (nthRead: number) => boolean;
const NEVER: Failing = () => false;

/** Synthetic secret plaintexts of the test in flight: never stored in the clear, never returned. */
let secrets: string[] = [];
/** Synthetic NON-secret config values of the test in flight: stored as config, never returned. */
let settings: string[] = [];

beforeEach(() => {
  secrets = [];
  settings = [];
  // SEAM process: no shell's token may answer the GitHub adapter's fallback for a fixture.
  vi.stubEnv("GITHUB_TOKEN", "");
});

afterEach(() => {
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

function premise(label: string, actual: unknown, expected: unknown): void {
  expect(actual, `${FIXTURE} ${label}`).toEqual(expected);
}

/** A synthetic secret: random, usable nowhere, and remembered only so its escape can be detected. */
function syntheticSecret(label: string): string {
  const value = `aio1217-synthetic-${label}-${randomBytes(18).toString("hex")}`;
  secrets.push(value);
  return value;
}

/** A synthetic standing join link on a reserved, unresolvable host. */
function syntheticLink(): string {
  const value = `https://aio1217-fixture.invalid/join/${randomBytes(12).toString("hex")}`;
  settings.push(value);
  return value;
}

/** A synthetic GitHub org login. */
function syntheticOrg(): string {
  const value = `aio1217-org-${randomBytes(6).toString("hex")}`;
  settings.push(value);
  return value;
}

const escapes = (text: string): boolean => [...secrets, ...settings].some((value) => text.includes(value));

// The table the owner reads, the one its sibling writer owns, and the ones either would touch.
const DURABLE_TABLES = ["teams", "members", "integrations", "member_provisioning", "audit_log"] as const;
type DurableTable = (typeof DURABLE_TABLES)[number];
type Durable = Record<DurableTable, Row[]>;
type Changed = Partial<Record<DurableTable, { added: Row[]; removed: Row[] }>>;

/** A row as it may be compared and printed: a stored ciphertext only as its sha256. */
const sealed = (row: Row): Row =>
  typeof row.secret_ciphertext === "string"
    ? { ...row, secret_ciphertext: `sha256:${sha(row.secret_ciphertext)}` }
    : row;

/** Every row of every durable table, every column, in an order that depends on content only. */
async function durable(): Promise<Durable> {
  const snapshot = {} as Durable;
  for (const table of DURABLE_TABLES) {
    const rows = await fx<{ row: Row }>(
      `${table} snapshot`,
      `select to_jsonb(t) as row from ${table} t order by to_jsonb(t)::text`,
    );
    snapshot[table] = rows.map((entry) => sealed(entry.row));
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

/** Whether any synthetic secret occurs, in the clear, in any column of any durable table. */
async function storedInTheClear(): Promise<boolean> {
  for (const table of DURABLE_TABLES) {
    const rows = await fx<{ text: string }>(
      `${table} clear-text scan`,
      `select to_jsonb(t)::text as text from ${table} t`,
    );
    // Compared in this process only: no secret is bound into a statement.
    if (rows.some((row) => secrets.some((secret) => row.text.includes(secret)))) return true;
  }
  return false;
}

/** Two teams, each with its seeded member. Whichever is not called is the bystander. */
async function seedWorld(): Promise<World> {
  const a = await seedTeam();
  const b = await seedTeam();
  premise("the two teams are distinct", a.teamId === b.teamId, false);
  return { a, b };
}

const authOf = (team: Seed) => ({ teamId: team.teamId, memberId: team.memberId });

/**
 * One integration row of the team, named after its type, through the real single writer. Calling it
 * again for the same team and type rewrites that row's config and status and leaves its secret.
 */
async function connect(team: Seed, type: Tool, config: Row, status?: Status): Promise<string> {
  const { id } = await upsertIntegration(db(), authOf(team), {
    type,
    name: type,
    config,
    // Left out when not given, so the writer's own default of `enabled` applies.
    ...(status ? { status } : {}),
  });
  return id;
}

/** A fresh synthetic secret for one row, encrypted and stored by the real writer. */
async function storeSecret(team: Seed, integrationId: string, label: string): Promise<void> {
  await setIntegrationSecret(db(), authOf(team), integrationId, syntheticSecret(label));
  premise("no synthetic secret is stored in the clear", await storedInTheClear(), false);
}

const setStatus = (team: Seed, integrationId: string, status: Status): Promise<void> =>
  setIntegrationStatus(db(), authOf(team), integrationId, status);

/** The three rows a fully configured team holds, by tool. */
interface Connected {
  linear: string;
  slack: string;
  github: string;
}

/**
 * One enabled row per tool holding exactly what its adapter reads: Linear a stored secret and no
 * config; Slack an invite link and NO secret; GitHub an org and a stored secret.
 */
async function connectAll(team: Seed): Promise<Connected> {
  const linear = await connect(team, "linear", {});
  await storeSecret(team, linear, "linear-key");
  const slack = await connect(team, "slack", { inviteLink: syntheticLink() });
  const github = await connect(team, "github", { org: syntheticOrg() });
  await storeSecret(team, github, "github-token");
  return { linear, slack, github };
}

/** One integration row reduced to the conjuncts the adapters read, none of them a value. */
const heldRow = (
  type: Tool,
  status: Status,
  has: { secret?: boolean; inviteLink?: boolean; org?: boolean } = {},
): Row => ({
  type,
  status,
  secret_stored: has.secret ?? false,
  invite_link_set: has.inviteLink ?? false,
  org_set: has.org ?? false,
});

/** What `connectAll` leaves, in the order `held` reads it back. */
const ALL_HELD = [
  heldRow("github", "enabled", { secret: true, org: true }),
  heldRow("linear", "enabled", { secret: true }),
  heldRow("slack", "enabled", { inviteLink: true }),
];

/** The team's integration rows as the pool reads them back: booleans, never a ciphertext or a value. */
const held = (team: Seed): Promise<Row[]> =>
  fx(
    "held integrations readback",
    `select type, status,
            secret_ciphertext is not null as secret_stored,
            coalesce(config->>'inviteLink', '') <> '' as invite_link_set,
            coalesce(config->>'org', '') <> '' as org_set
       from integrations where team_id = $1 order by type, name`,
    [team.teamId],
  );

// ── the recording transport ──────────────────────────────────────────────────────────────────────

const EQUALITY = /([a-z_][a-z0-9_.]*) = \$(\d+)/g;

/** The `column = $n` terms of a compiled clause, with the value bound to each placeholder. */
function equalities(clause: string, params: unknown[]): Row {
  const bound: Row = {};
  for (const match of clause.matchAll(EQUALITY)) bound[match[1]] = params[Number(match[2]) - 1];
  return bound;
}

/** What the real builder compiled, read off its statement head. A write would carry its own op. */
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
 * A real `PgClient` whose executor records each compiled statement in the call's trace, forwards it
 * to the real pool and records the row count Postgres answered. `failing` picks the `integrations`
 * reads the test-only fault refuses: those are recorded and thrown, and never reach Postgres.
 */
function recordingClient(flight: Flight, failing: Failing): DbClient {
  let reads = 0;
  const executor: SqlExecutor = async <T = Row>(text: string, params: unknown[] = []) => {
    const step: Step = { ...compiled(text, params), rows: null };
    flight.trace.push(step);
    if (step.op === "select" && step.table === "integrations") {
      reads += 1;
      if (failing(reads)) throw new Error(READ_FAULT);
    }
    try {
      const answered = await runSql<T>(text, params);
      step.rows = answered.rowCount;
      return answered;
    } catch (error) {
      flight.refused.push(`${NATIVE_ERROR} ${error instanceof Error ? error.message : String(error)}: ${text}`);
      throw error;
    }
  };
  return new PgClient({ executor }) as unknown as DbClient;
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

/** A settled outcome as it may be compared and printed. */
const printable = (outcome: Settled): Settled =>
  escapes(JSON.stringify(outcome)) ? { withheld: WITHHELD } : outcome;

/**
 * One direct call of the owner for `team` over a new recording client: snapshot, call, snapshot
 * again. Nothing is carried over from an earlier call but the rows in Postgres.
 */
async function observe(team: Seed, failing: Failing = NEVER): Promise<Seen> {
  const flight: Flight = { trace: [], refused: [] };
  const client = recordingClient(flight, failing);
  let logged: string[] = [];

  const before = await durable();
  // The real adapter logs each failure it converts; captured so every such line is accounted for.
  const adapterLog = vi.spyOn(console, "error").mockImplementation(() => {});
  let outcome: Settled;
  try {
    outcome = await settle(() => getProvisioningAvailability(client, team.teamId));
  } finally {
    logged = adapterLog.mock.calls.map((call) => String(call[0]));
    adapterLog.mockRestore();
  }
  const after = await durable();

  premise("no statement the call issued was refused by Postgres", flight.refused, []);

  const returned = "returned" in outcome ? outcome.returned : null;
  return {
    outcome: printable(outcome),
    shape: Array.isArray(returned) ? returned.map((entry) => Object.keys(entry as Row)) : null,
    trace: flight.trace,
    changed: changes(before, after),
    escaped: escapes(JSON.stringify(outcome)) || logged.some(escapes),
    logged: logged.filter((line) => line.startsWith("[pg]")).map((line) => (escapes(line) ? WITHHELD : line)),
  };
}

/** The entries a call returned; none when it rejected or its outcome was withheld. */
function entriesOf(seen: Seen): Row[] {
  return "returned" in seen.outcome && Array.isArray(seen.outcome.returned) ? (seen.outcome.returned as Row[]) : [];
}

// ── what a call owes ─────────────────────────────────────────────────────────────────────────────

/**
 * One adapter's read as the real builder compiles it — as read from `getEnabledIntegrationsWithSecrets`:
 * bound to the called team and to `enabled`, answered with that team's enabled rows.
 */
const read = (team: Seed, rows: number | null): Step => ({
  op: "select",
  table: "integrations",
  where: { team_id: team.teamId, status: "enabled" },
  rows,
});

/**
 * A healthy call: the three entries in the owner's order, each carrying the owner's three keys; one
 * read per adapter and no other statement; no durable difference in either team; nothing of the
 * fixture in the answer; and no failure converted by the adapter.
 */
const answered = (team: Seed, entries: Row[], enabledRows: number) => ({
  outcome: { returned: entries },
  shape: [ENTRY_KEYS, ENTRY_KEYS, ENTRY_KEYS],
  trace: [read(team, enabledRows), read(team, enabledRows), read(team, enabledRows)],
  changed: {},
  escaped: false,
  logged: [],
});

describe("AIO-1217 native provisioning-availability owner — lib/provisioning/run getProvisioningAvailability over real Postgres (direct calls: no action, no guard, no provider)", () => {
  it(
    "1 — no integration rows: the call returns linear, slack, github in that order, each `configured: false` with its adapter's own reason (`no enabled Linear integration`, `no enabled Slack integration`, and for GitHub `no GitHub org set`); it issues one team-bound read of enabled integrations per adapter and nothing else, and leaves every durable row as it was",
    async () => {
      const world = await seedWorld();
      premise("neither team holds an integration row", [await held(world.a), await held(world.b)], [[], []]);

      expect(await observe(world.a)).toEqual(answered(world.a, [NO_LINEAR, NO_SLACK, NO_GITHUB_ORG], 0));
    },
    ROOMY,
  );

  it(
    "2 — one enabled, complete row per tool, written by the real integration writer: Linear with a stored secret and empty config, Slack with an invite link and NO stored secret, GitHub with an org and a stored secret — all three return `configured: true` with no reason; the three reads are answered with that team's three rows; no row is changed; no synthetic secret, link or org occurs in the answer; the unrecorded helper client answers the same",
    async () => {
      const world = await seedWorld();
      await connectAll(world.a);
      premise("team A holds one enabled row per tool, each with its adapter's conjuncts", await held(world.a), ALL_HELD);

      expect(await observe(world.a)).toEqual(answered(world.a, [LINEAR, SLACK, GITHUB], 3));

      // The recorder is not what produced the answer.
      const unrecorded = await settle(() => getProvisioningAvailability(db(), world.a.teamId));
      expect(printable(unrecorded), "over the unrecorded helper client").toEqual({
        returned: [LINEAR, SLACK, GITHUB],
      });
    },
    ROOMY,
  );

  it(
    "3a — disabled rows are not read as configured: after a configured control, the same three rows set to `disabled` — each still holding its secret, link and org — answer exactly as no rows do, their reads answered with zero rows; re-enabling Slack alone restores Slack alone; re-enabling the rest restores all three, each step a new call",
    async () => {
      const world = await seedWorld();
      const rows = await connectAll(world.a);
      expect(await observe(world.a), CONTROL).toEqual(answered(world.a, [LINEAR, SLACK, GITHUB], 3));

      for (const id of [rows.linear, rows.slack, rows.github]) await setStatus(world.a, id, "disabled");
      premise(
        "every row is disabled and holds what it held",
        await held(world.a),
        ALL_HELD.map((row) => ({ ...row, status: "disabled" })),
      );
      // GitHub's disabled row still holds an org: the adapter's reason does not tell the two apart.
      expect(await observe(world.a), "all three disabled").toEqual(
        answered(world.a, [NO_LINEAR, NO_SLACK, NO_GITHUB_ORG], 0),
      );

      await setStatus(world.a, rows.slack, "enabled");
      expect(await observe(world.a), "Slack alone re-enabled").toEqual(
        answered(world.a, [NO_LINEAR, SLACK, NO_GITHUB_ORG], 1),
      );

      await setStatus(world.a, rows.linear, "enabled");
      await setStatus(world.a, rows.github, "enabled");
      expect(await observe(world.a), "all three re-enabled").toEqual(answered(world.a, [LINEAR, SLACK, GITHUB], 3));
    },
    ROOMY,
  );

  it(
    "3b — enabled but incomplete rows, each read and each answered with its adapter's own reason (process GITHUB_TOKEN pinned empty): Linear without a stored secret is `Linear API key not set`; Slack WITH a stored secret but without an invite link is `no Slack invite link set`; GitHub with a stored secret but no org is `no GitHub org set`; GitHub with an org but no stored secret is `no GitHub token (connect one, or set GITHUB_TOKEN)` — and supplying exactly the missing conjunct, one new call at a time, turns exactly that tool configured",
    async () => {
      const world = await seedWorld();

      // Team A: every row enabled, each lacking the one thing its adapter reads.
      const linear = await connect(world.a, "linear", {});
      const slack = await connect(world.a, "slack", {});
      await storeSecret(world.a, slack, "slack-secret");
      const github = await connect(world.a, "github", {});
      await storeSecret(world.a, github, "github-token");
      // Team B: the other GitHub half — an org, and no token anywhere.
      const orgOnly = await connect(world.b, "github", { org: syntheticOrg() });
      premise(
        "each row is enabled and lacks exactly one conjunct",
        { a: await held(world.a), b: await held(world.b) },
        {
          a: [
            heldRow("github", "enabled", { secret: true }),
            heldRow("linear", "enabled"),
            heldRow("slack", "enabled", { secret: true }),
          ],
          b: [heldRow("github", "enabled", { org: true })],
        },
      );

      // Three enabled rows are answered to each read: these are not the `no enabled …` reasons.
      expect(await observe(world.a), "team A, each row incomplete").toEqual(
        answered(world.a, [NO_LINEAR_KEY, NO_SLACK_LINK, NO_GITHUB_ORG], 3),
      );
      expect(await observe(world.b), "team B, an org and no token").toEqual(
        answered(world.b, [NO_LINEAR, NO_SLACK, NO_GITHUB_TOKEN], 1),
      );

      await storeSecret(world.a, linear, "linear-key");
      expect(await observe(world.a), "Linear given its secret").toEqual(
        answered(world.a, [LINEAR, NO_SLACK_LINK, NO_GITHUB_ORG], 3),
      );

      // The Slack row already held a secret: the link is what it lacked.
      await connect(world.a, "slack", { inviteLink: syntheticLink() });
      expect(await observe(world.a), "Slack given its invite link").toEqual(
        answered(world.a, [LINEAR, SLACK, NO_GITHUB_ORG], 3),
      );

      await connect(world.a, "github", { org: syntheticOrg() });
      expect(await observe(world.a), "GitHub given its org").toEqual(answered(world.a, [LINEAR, SLACK, GITHUB], 3));

      await storeSecret(world.b, orgOnly, "github-token");
      expect(await observe(world.b), "team B's GitHub given its token").toEqual(
        answered(world.b, [NO_LINEAR, NO_SLACK, GITHUB], 1),
      );

      premise(
        "each row ends complete, the writes having left each stored secret in place",
        { a: await held(world.a), b: await held(world.b) },
        {
          a: [
            heldRow("github", "enabled", { secret: true, org: true }),
            heldRow("linear", "enabled", { secret: true }),
            heldRow("slack", "enabled", { secret: true, inviteLink: true }),
          ],
          b: [heldRow("github", "enabled", { secret: true, org: true })],
        },
      );
    },
    ROOMY,
  );

  it(
    "4 — two teams, each call confined to the rows of the team id it is handed: team A fully configured does not make team B's disabled Linear or token-less GitHub available; every read is bound to the called team's id and answered with that team's enabled rows only; enabling team B's Linear changes team B's answer and not team A's; disabling team A's Slack changes team A's answer and not team B's; no call changes a row of either team",
    async () => {
      const world = await seedWorld();
      const a = await connectAll(world.a);

      // Team B: a complete Linear row that is disabled, a complete Slack row, and GitHub without a token.
      const linearB = await connect(world.b, "linear", {}, "disabled");
      await storeSecret(world.b, linearB, "linear-key");
      await connect(world.b, "slack", { inviteLink: syntheticLink() });
      await connect(world.b, "github", { org: syntheticOrg() });
      premise(
        "the two teams hold different rows",
        { a: await held(world.a), b: await held(world.b) },
        {
          a: ALL_HELD,
          b: [
            heldRow("github", "enabled", { org: true }),
            heldRow("linear", "disabled", { secret: true }),
            heldRow("slack", "enabled", { inviteLink: true }),
          ],
        },
      );

      expect(await observe(world.a), "team A").toEqual(answered(world.a, [LINEAR, SLACK, GITHUB], 3));
      // Two enabled rows answered, not team A's three and not all five.
      expect(await observe(world.b), "team B beside a fully configured team A").toEqual(
        answered(world.b, [NO_LINEAR, SLACK, NO_GITHUB_TOKEN], 2),
      );

      await setStatus(world.b, linearB, "enabled");
      expect(await observe(world.b), "team B with its Linear enabled").toEqual(
        answered(world.b, [LINEAR, SLACK, NO_GITHUB_TOKEN], 3),
      );
      expect(await observe(world.a), "team A after team B's change").toEqual(
        answered(world.a, [LINEAR, SLACK, GITHUB], 3),
      );

      await setStatus(world.a, a.slack, "disabled");
      expect(await observe(world.a), "team A with its Slack disabled").toEqual(
        answered(world.a, [LINEAR, NO_SLACK, GITHUB], 2),
      );
      expect(await observe(world.b), "team B after team A's change").toEqual(
        answered(world.b, [LINEAR, SLACK, NO_GITHUB_TOKEN], 3),
      );
    },
    ROOMY,
  );

  it(
    "5 — a TEST-ONLY read fault (the handed client's executor throws for the integrations read before Postgres; no production change, no provider): after a configured control on the same rows, the call still RESOLVES, every faulted tool is `configured: false` with the read's own `load integrations failed` reason and never `configured: true`, and no row changes; with one read of the three faulted, exactly one tool is unconfigured and the other two still answer configured; a following unfaulted call is configured again",
    async () => {
      const world = await seedWorld();
      await connectAll(world.a);
      expect(await observe(world.a), CONTROL).toEqual(answered(world.a, [LINEAR, SLACK, GITHUB], 3));

      const faulted = (tool: Tool): Row => ({ tool, configured: false, reason: READ_FAULT_REASON });

      expect(await observe(world.a, () => true), "every read faulted").toEqual({
        // Returned, not rejected: the owner catches each adapter's failure into its own entry.
        outcome: { returned: [faulted("linear"), faulted("slack"), faulted("github")] },
        shape: [ENTRY_KEYS, ENTRY_KEYS, ENTRY_KEYS],
        // Each read was issued, bound to the called team, and never answered.
        trace: [read(world.a, null), read(world.a, null), read(world.a, null)],
        changed: {},
        escaped: false,
        logged: [READ_FAULT_LOG, READ_FAULT_LOG, READ_FAULT_LOG],
      });

      // Which adapter's read is issued first is not claimed: only that one failure costs one tool.
      const partial = await observe(world.a, (nthRead) => nthRead === 1);
      const entries = entriesOf(partial);
      expect(
        {
          tools: entries.map((entry) => entry.tool),
          answers: entries.map((entry) => (entry.configured === true ? "configured" : String(entry.reason))).sort(),
          shape: partial.shape,
          trace: partial.trace,
          changed: partial.changed,
          escaped: partial.escaped,
          logged: partial.logged,
        },
        "the first read faulted, the other two answered",
      ).toEqual({
        tools: ["linear", "slack", "github"],
        answers: ["configured", "configured", READ_FAULT_REASON],
        shape: [ENTRY_KEYS, ENTRY_KEYS, ENTRY_KEYS],
        trace: [read(world.a, null), read(world.a, 3), read(world.a, 3)],
        changed: {},
        escaped: false,
        logged: [READ_FAULT_LOG],
      });

      // The fault was that one client's: nothing of it outlives the call.
      expect(await observe(world.a), "a following unfaulted call").toEqual(
        answered(world.a, [LINEAR, SLACK, GITHUB], 3),
      );
    },
    ROOMY,
  );

  it(
    "6 — OBSERVED, the GitHub adapter's process fallback as the source has it, not a team-scoped credential and not declared correct: an enabled GitHub row with an org and NO stored secret is `no GitHub token …` while process GITHUB_TOKEN is empty, and `configured: true` once the process holds a synthetic one; the same process value does not make a team WITHOUT an org available (`no GitHub org set`); emptied again, the first team is unconfigured again; the process value is written to no row and occurs in no answer",
    async () => {
      const world = await seedWorld();
      await connect(world.a, "github", { org: syntheticOrg() });
      premise(
        "team A holds an org and no stored secret; team B holds no row",
        { a: await held(world.a), b: await held(world.b) },
        { a: [heldRow("github", "enabled", { org: true })], b: [] },
      );

      expect(await observe(world.a), "process GITHUB_TOKEN empty").toEqual(
        answered(world.a, [NO_LINEAR, NO_SLACK, NO_GITHUB_TOKEN], 1),
      );

      vi.stubEnv("GITHUB_TOKEN", syntheticSecret("process-token"));
      expect(await observe(world.a), "process GITHUB_TOKEN set, team A holds an org").toEqual(
        answered(world.a, [NO_LINEAR, NO_SLACK, GITHUB], 1),
      );
      // The org is read from the team's own row: a process token alone answers nothing.
      expect(await observe(world.b), "process GITHUB_TOKEN set, team B holds no org").toEqual(
        answered(world.b, [NO_LINEAR, NO_SLACK, NO_GITHUB_ORG], 0),
      );

      vi.stubEnv("GITHUB_TOKEN", "");
      expect(await observe(world.a), "process GITHUB_TOKEN emptied again").toEqual(
        answered(world.a, [NO_LINEAR, NO_SLACK, NO_GITHUB_TOKEN], 1),
      );

      expect(await storedInTheClear(), "the process value in any durable row").toBe(false);
    },
    ROOMY,
  );
});

// Each TODO names the owner of evidence this slice was told not to supply.
describe("Z — evidence this file does NOT supply (executable TODOs: none is run, none is passed)", () => {
  it.todo(
    "GUARD ASSOCIATION · requireTeamAdmin admission, the empty-list denial and the admin action wiring of app/t/[team]/admin/actions.ts#getProvisioningAvailabilityAction are aio1217-admin-guard-association.datamechanics.test.ts's evidence; this file calls the lib owner directly and proves nothing about the wrapper, the session, posture, the action wire or the invite UI that renders the answer",
  );
  it.todo(
    "INVITE AND PROVISIONING WRITES · runProvisioning, the three adapters' invite, the member_provisioning upserts, their member.provisioned audit rows and provider delivery are a different owner; availability is a read, and no invitation is written and no provider is contacted by this file",
  );
  it.todo(
    "INVENTORY AND ACCEPTANCE · the complete AIO-1217 Server Action inventory, its acceptance criteria, documentation and full-suite checks are not supplied by this file, which evidences one lib owner's read behavior only",
  );
  it.todo(
    "COORDINATOR · MUTANTS (isolated-copy actual-import run): against this fixture, drop the `status = enabled` equality or the `team_id` equality from getEnabledIntegrationsWithSecrets, drop each adapter's secret, invite-link and org conjunct in turn, and remove the per-tool catch in getProvisioningAvailability — cases 3a, 4, 3b and 5 must then fail on the answer and the trace, not on a compile or fixture error; no mutation evidence is supplied here",
  );
  it.todo(
    "READ FAILURE, REMAINDER · case 5 is a thrown executor error for the integrations read only; a native Postgres failure, a stored ciphertext that cannot be decrypted (for example after a SECRETS_KEY change) and the non-Error `check failed` fallback are not reached by this file, and whether the reason should carry the read's error text verbatim is not specified by any source it reads",
  );
  it.todo(
    "CROSS-TYPE AND UNDECRYPTABLE-ROW COUPLING · each adapter's read decrypts EVERY enabled row of the team whatever its type, so by source reading one enabled row whose stored ciphertext cannot be decrypted — another tool's, or of a type no provisioning adapter reads — would reject all three adapters' reads and answer all three tools `configured: false` with the decryption error's text; no case here holds an undecryptable ciphertext or an enabled row of a fourth type, so neither the coupling nor what its reason discloses is observed, and whether one unreadable row should cost every tool is not specified by any source this file reads",
  );
  it.todo(
    "SEVERAL ENABLED ROWS OF ONE TYPE · enabledIntegration documents the earliest-created enabled row, but its read carries no ordering; which row answers when a team holds several enabled rows of one type is not exercised and no contract for it is declared here",
  );
  it.todo(
    "PROCESS GITHUB_TOKEN · case 6 records that the fallback is process-wide and answers the token conjunct for every team holding an org; whether availability should depend on a value that is not team state is not specified by any source this file reads, and nothing is declared about it here",
  );
});
