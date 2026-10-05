import { randomBytes, randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PgClient } from "@/lib/db/pg/client";
import { getPool, runSql } from "@/lib/db/pg/pool";
import type { DbClient, SqlExecutor } from "@/lib/db/types";
import { db, placeMemberByTier, seedTeam, sha, type Seed } from "./helpers";

/**
 * AIO-1217 — NATIVE PROVISIONING-AVAILABILITY ACTION COMPOSITION against real Postgres: the actual
 * export `app/t/[team]/admin/actions.ts#getProvisioningAvailabilityAction`, called directly, through
 * the actual `requireTeamAdmin` chain AND the actual `lib/provisioning/run.ts#getProvisioningAvailability`
 * owner beneath it, over synthetic session, team, member, group and integration rows in the task's
 * data-mechanics Postgres. The two earlier files each hold one half and a seam for the other:
 * `aio1217-admin-guard-association.datamechanics.test.ts` runs the real gate over a recording double
 * of the owner; `aio1217-provisioning-availability-owner.datamechanics.test.ts` runs the real owner
 * with no gate above it. This file runs both in one call and replaces neither.
 *
 *   1 — admitted on each of two teams holding complementary rows: each answer is its own team's.
 *   2 — the answer follows the called team's rows and only those: the other team's changes move nothing.
 *   3 — no session cookie: the empty list, after the cookie read and nothing else.
 *   4 — an active `member` and an active `lead` of the team: the empty list after the guard's reads.
 *   5 — an active role-admin of external posture: the empty list after the guard's reads.
 *   6 — team B's admin given team A's slug: the empty list after the membership read answers no row.
 *   Z — what this file does not supply, as executable TODOs naming the owner.
 *
 * What is real, and never mocked or handed a verdict: the export; `requireTeamAdmin` →
 * `getSessionUser` → `verifySession` (jose HS256 against AUTH_SECRET) → `resolveIntegrationsAdmin` →
 * `resolveViewerPosture` → `canAccessAdmin`; the owner; the Linear, Slack and GitHub adapters'
 * `isConfigured`; `enabledIntegration` → `getEnabledIntegrationsWithSecrets`; `decryptSecret`; the
 * query builder, the pg pool and Postgres. Integration rows are written only by the real single writer
 * of `integrations` — `upsertIntegration`, `setIntegrationSecret`, `setIntegrationStatus` — so each
 * secret is stored as that writer stores it: AES-256-GCM under this test's own `SECRETS_KEY`.
 *
 * The synthetic seams, all of them:
 *   SEAM cookies       `next/headers` `cookies` — resolves the jar of the one request in flight. The
 *                      session in it is a real `signSession` token for a real auth_users row that a
 *                      real member row is bound to.
 *   SEAM transport     `adminClient()` and `serverClient()` record their acquisitions and hand out, for
 *                      the duration of one request, a real `PgClient` whose SQL executor RECORDS each
 *                      compiled statement, forwards it to the real pool `runSql` and records the row
 *                      count Postgres answered. Nothing above the executor is replaced.
 *   SEAM pass-through  three recorders, each the ORIGINAL module with one export wrapped so that it
 *                      calls the captured original with the same arguments and records how it settled:
 *                      `@/lib/provisioning/run` `getProvisioningAvailability` (the client and team id
 *                      it was handed, then resolved-with-N or rejected); `@/lib/secrets/crypto`
 *                      `decryptSecret` (a tally of returned and threw — never an argument, never a
 *                      result); `@/lib/api/audit` `audit` (the action name). None answers anything of
 *                      its own, and between requests each is the original and records nothing.
 *   SEAM tripwires     `next/cache` `revalidatePath` records the path. `next/headers` `headers`, global
 *                      `fetch` and the three adapters' `invite` each record and throw. The export
 *                      reaches none of them today, so their zero is a tripwire, not behavior.
 *   SEAM process       `AUTH_SECRET` and `SECRETS_KEY` are random per test; `GITHUB_TOKEN` is pinned
 *                      EMPTY, because the GitHub adapter falls back to it and a shell exporting one
 *                      would otherwise answer for the fixture.
 *
 * Every request is one grouped assertion over: how the call settled; the key list of each returned
 * entry; ONE ORDERED TRACE of everything observable — the session cookie read, each client
 * acquisition, each statement either client issued with the equalities bound into it and the row
 * count Postgres answered, the owner's entry with the client and team id it was handed and its
 * settlement, and any audit, revalidation or tripwire; the client acquisition counts; the seams' own
 * call logs (kept by vitest, independently of the trace); the decryption tally; the durable
 * difference, computed from whole rowsets read from the pool before and after; whether a synthetic
 * secret or config value occurs in the answer, the trace or the adapter's log; whether an identifier
 * of the bystander team or of any integration row occurs there; and the adapter's own `[pg]` lines.
 * Which conjunct a caller or a row holds is read back from the pool by raw SQL as booleans and
 * counts, so it is a readback and not a fixture's say-so.
 *
 * A refusal owes the guard's own prerequisite reads and nothing else: no service-client acquisition,
 * no owner entry, no `integrations` statement, no decryption, no audit, no revalidation, no tripwire
 * and an empty durable difference — with a valid slug and the team's rows armed to answer, after an
 * admitted control on the same fixture whose answer is three entries, so an admitted call would have
 * shown. Fixture premises fail with the `FIXTURE` prefix and are never a security observation; a
 * failed admitted control says `CONTROL`.
 *
 * SECRET HYGIENE. Every secret — each integration secret, AUTH_SECRET, SECRETS_KEY and each signed
 * session — is generated per test, is synthetic and is usable nowhere. An integration secret's
 * plaintext is handed only to the real writer; a session only to the cookie jar of its request.
 * None is placed in an assertion, a test name, a SQL parameter of this file or a log line. A stored
 * ciphertext enters a snapshot only as its sha256. The decryption recorder keeps a count and nothing
 * else. A settled outcome, trace or log line in which a synthetic value occurs is replaced whole by a
 * fixed marker before it can reach an assertion, so a failing escape check prints the marker and a
 * boolean. The Slack invite link and the GitHub org are NON-secret config by the source's own
 * definition; they are synthetic too, and are held to the same escape check.
 *
 * Bounds of what is claimed.
 *   - ONE EXPORT AND ITS OWNER COMPOSITION. Nothing about `inviteMember`, `issueApiKey`,
 *     `revokeApiKey`, `runProvisioning`, the adapters' `invite`, the F4 missing-integration run and
 *     audit policy, AIO-1226 or any other Server Action. Not an action inventory, not acceptance of
 *     any AIO-1217 criterion.
 *   - DIRECT CALLS of the exported function: not Next action-wire, POST dispatch, origin, action-id
 *     encryption, serialization of the returned list or real cache-invalidation proof.
 *   - AVAILABILITY IS A READ. `configured: true` says the adapter found what it reads; it says
 *     nothing about whether the stored secret is valid at the provider, and no provider is contacted.
 *   - THE DURABLE DIFFERENCE IS OVER NAMED TABLES — `teams`, `members`, `auth_users`, `groups`,
 *     `group_members`, `integrations`, `member_provisioning`, `api_keys`, `audit_log` — not the whole
 *     schema, and not anything outside Postgres.
 *   - THE UNAUDITED DECRYPTING READ IS OBSERVED, NOT JUDGED. An admitted call decrypts every stored
 *     secret of the team's enabled rows once per adapter and appends no `audit_log` row. That is
 *     recorded as the tally and the empty difference; it is neither a finding that such a read needs
 *     no audit record nor a no-audit policy the action is held to.
 *   - THE REFUSALS ARE FOUR. No session cookie; an active non-admin role; an active role-admin of
 *     external posture; another team's admin given this team's slug. An unverifiable or expired
 *     cookie, an inactive member, an unknown slug, and a guard or owner read fault are not exercised.
 *   - THE LEGACY `members.tier` COLUMN IS NOT VARIED. Every caster's column agrees with the builtin
 *     row held; the disagreement cases are the association file's observation and are not repeated.
 *   - ONE ENABLED ROW PER TYPE AND TEAM, and no row of a fourth type. Process `GITHUB_TOKEN` is
 *     empty throughout: its fallback is the owner file's case 6 and is not reached through the action.
 *   - Membership and rows are read per request: no revocation or linearizability claim is made.
 *
 * Run status at authoring: NOT RUN. This file was written without executing vitest, tsc, eslint or
 * any other command. Its expectations come from reading the sources above — and, for the fixture SQL
 * and the guard's trace, from the association file, itself unrun at its authoring — not from an
 * observed run; replace this paragraph with the observed result once it has been executed.
 */

const FIXTURE = "FIXTURE PREMISE FAILED (setup, not a security observation):";
const CONTROL = "ADMITTED CONTROL FAILED (the paired refusal would be vacuous):";

const h = vi.hoisted(() => ({
  /** SEAM cookies: the async `cookies()` of the request in flight. */
  cookies: vi.fn(),
  /** When set, the client `adminClient()` hands out: a real adapter over a recording executor. */
  adminDb: null as import("@/lib/db/types").DbClient | null,
  /** When set, the client `serverClient()` hands out: another, sharing the same trace. */
  serverDb: null as import("@/lib/db/types").DbClient | null,
  /** How often each factory was asked for a client; reset at the start of every request. */
  acquired: { server: 0, admin: 0 },
  /** The ordered trace of the request in flight; null between requests. */
  trace: null as Array<Record<string, unknown>> | null,
  /** SEAM pass-through: the recorder the action is handed for the owner, and the owner it calls. */
  owner: vi.fn(),
  originalOwner: null as typeof import("@/lib/provisioning/run").getProvisioningAvailability | null,
  /** SEAM pass-through: the decryption tally of the request in flight; null between requests. */
  decrypts: null as { returned: number; threw: number } | null,
  /** SEAM pass-through: the audit recorder, and the writer it calls. */
  audit: vi.fn(),
  originalAudit: null as typeof import("@/lib/api/audit").audit | null,
  /** SEAM tripwires. */
  revalidatePath: vi.fn(),
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
// The original module; the owner is captured and reached only through its recorder.
vi.mock("@/lib/provisioning/run", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/provisioning/run")>();
  h.originalOwner = original.getProvisioningAvailability;
  return { ...original, getProvisioningAvailability: h.owner };
});
// The original module; each decryption of a request in flight is tallied, and nothing of it is kept.
vi.mock("@/lib/secrets/crypto", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/secrets/crypto")>();
  return {
    ...original,
    decryptSecret: (...args: Parameters<typeof original.decryptSecret>) => {
      const tally = h.decrypts;
      if (!tally) return original.decryptSecret(...args);
      try {
        const plaintext = original.decryptSecret(...args);
        tally.returned += 1;
        return plaintext;
      } catch (error) {
        tally.threw += 1;
        throw error;
      }
    },
  };
});
// The original module; the writer is captured and reached only through its recorder.
vi.mock("@/lib/api/audit", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/api/audit")>();
  h.originalAudit = original.audit;
  return { ...original, audit: h.audit };
});

import { getProvisioningAvailabilityAction } from "@/app/t/[team]/admin/actions";
import { SESSION_COOKIE, signSession, verifySession, type SessionUser } from "@/lib/auth/pg-session";
import { setIntegrationSecret, setIntegrationStatus, upsertIntegration } from "@/lib/integrations/manage";
import { githubAdapter } from "@/lib/provisioning/github";
import { linearAdapter } from "@/lib/provisioning/linear";
import { slackAdapter } from "@/lib/provisioning/slack";
import type { ProvisioningAdapter } from "@/lib/provisioning/types";

type Row = Record<string, unknown>;
type Tool = "linear" | "slack" | "github";
type Status = "enabled" | "disabled";
type Role = "admin" | "lead" | "member";
type Tier = "team" | "external";
type Via = "admin" | "server";
/** One entry of a request's ordered trace: `step` names its kind, the rest is what it carried. */
type Step = Row;

type OwnerArgs = Parameters<typeof import("@/lib/provisioning/run").getProvisioningAvailability>;
type AuditArgs = Parameters<typeof import("@/lib/api/audit").audit>;

/** Two teams, several sessions and integration writes, and whole-rowset snapshots around each call. */
const ROOMY = 30_000;

const OWNER = "getProvisioningAvailability";

/** What the owner recorder notes when it was handed the service client of the request in flight. */
const REQUEST_SERVICE_CLIENT = "the service client of this request";
const SOME_OTHER_CLIENT = "NOT the service client of this request";

const NATIVE_ERROR = "native error:";

/** What replaces an outcome, a trace or a log line in which a synthetic fixture value occurs. */
const WITHHELD = "WITHHELD: a synthetic fixture value occurred here";

// The entries the three adapters answer, verbatim from lib/provisioning/{linear,slack,github}.ts.
const LINEAR: Row = { tool: "linear", configured: true };
const SLACK: Row = { tool: "slack", configured: true };
const GITHUB: Row = { tool: "github", configured: true };
const NO_LINEAR: Row = { tool: "linear", configured: false, reason: "no enabled Linear integration" };
const NO_LINEAR_KEY: Row = { tool: "linear", configured: false, reason: "Linear API key not set" };
const NO_SLACK_LINK: Row = { tool: "slack", configured: false, reason: "no Slack invite link set" };
// The GitHub adapter's answer to an absent, a disabled and an org-less enabled row alike.
const NO_GITHUB_ORG: Row = { tool: "github", configured: false, reason: "no GitHub org set" };

/**
 * The keys every returned entry carries, in the order the owner writes them. `reason` is present on a
 * configured entry too, holding `undefined`: `toEqual` reads that as absent, so the outcome
 * comparison fails on a configured entry that carries any reason at all.
 */
const ENTRY_KEYS = ["tool", "configured", "reason"];

const ADAPTER_OF: Record<Tool, ProvisioningAdapter> = {
  linear: linearAdapter,
  slack: slackAdapter,
  github: githubAdapter,
};

interface Flight {
  jar: Map<string, string>;
  trace: Step[];
  /** The statements Postgres itself refused; a fixture premise holds this empty. */
  refused: string[];
}

/** How a call ended: what it returned, how its rejection classifies, or that it may not be printed. */
type Settled =
  | { returned: unknown }
  | { rejected: { error: boolean; message: string } }
  | { withheld: string };

interface Seen {
  outcome: Settled;
  /** The key list of each returned entry; null when the call returned no list. */
  shape: string[][] | null;
  trace: Step[];
  acquired: { server: number; admin: number };
  /** How often each seam was called, by name, read off its own call log; absent when never. */
  seams: Record<string, number>;
  /** How the real `decryptSecret` settled, per call made during the request. Counts only. */
  decrypts: { returned: number; threw: number };
  changed: Changed;
  /** Whether a synthetic secret or config value occurs in the outcome, the trace or a log line. */
  escaped: boolean;
  /** Whether an identifier the request must not carry occurs in the outcome, the trace or a log line. */
  foreign: boolean;
  /** The real adapter's `[pg]` lines: one per failure it converted into a returned error. */
  logged: string[];
}

interface Cast {
  label: string;
  team: Seed;
  memberId: string;
  user: SessionUser;
  /** `signSession(user)` under this test's AUTH_SECRET. Never asserted, logged or returned. */
  session: string;
}

/** The three rows a team holds, by tool. */
interface Connected {
  linear: string;
  slack: string;
  github: string;
}

/** What an admitted call for a team owes, given the rows the pool reads back for it. */
interface Answer {
  entries: Row[];
  /** The team's enabled rows: what each adapter's read is answered with. */
  enabledRows: number;
  /** How many of those hold a stored secret: what each adapter's read decrypts. */
  enabledSecrets: number;
}

interface World {
  a: Seed;
  b: Seed;
  /** Team A's active admin holding its builtin Everyone row. */
  alice: Cast;
  /** The same in team B. */
  bob: Cast;
  rowsA: Connected;
  rowsB: Connected;
}

/** Any seam whose own call log is read back per request. */
interface Counted {
  mock: { calls: unknown[][] };
  mockClear(): unknown;
}

/** The one request in flight; null between requests. */
let inFlight: Flight | null = null;
/** Synthetic secrets of the test in flight: never stored in the clear, never returned. */
let secrets: string[] = [];
/** Synthetic NON-secret config values of the test in flight: stored as config, never returned. */
let settings: string[] = [];
/** SEAM tripwires: the three adapters' `invite`, replaced for the duration of one test. */
let inviteTripwires: Array<{ tool: Tool; spy: Counted & { mockRestore(): unknown } }> = [];

/** The request a tripwire was reached in. None of them has a caller between requests. */
function flightOf(seam: string): Flight {
  const flight = inFlight;
  if (!flight) throw new Error(`${FIXTURE} ${seam} was reached with no request in flight`);
  return flight;
}

const clientOf = (handed: unknown): string =>
  h.adminDb !== null && handed === h.adminDb ? REQUEST_SERVICE_CLIENT : SOME_OTHER_CLIENT;

/** The captured original of a pass-through recorder. */
function captured<T>(original: T | null, name: string): T {
  if (original === null) throw new Error(`${FIXTURE} the real ${name} was not captured`);
  return original;
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

beforeEach(() => {
  secrets = [];
  settings = [];
  inFlight = null;
  h.adminDb = null;
  h.serverDb = null;
  h.trace = null;
  h.decrypts = null;

  // SEAM process: every key of this test is its own, and no shell's token answers for a fixture.
  const authSecret = randomBytes(32).toString("hex");
  const secretsKey = randomBytes(32).toString("base64");
  secrets.push(authSecret, secretsKey);
  vi.stubEnv("AUTH_SECRET", authSecret);
  vi.stubEnv("SECRETS_KEY", secretsKey);
  vi.stubEnv("GITHUB_TOKEN", "");
  vi.stubGlobal("fetch", h.fetch);

  h.cookies.mockReset();
  h.cookies.mockImplementation(async () => {
    // Bound to the request in flight when `cookies()` was called.
    const flight = flightOf("cookies()");
    return {
      get: (name: string) => {
        flight.trace.push({ step: "cookie", name });
        const value = flight.jar.get(name);
        return value === undefined ? undefined : { name, value };
      },
    };
  });

  h.owner.mockReset();
  h.owner.mockImplementation(async (...args: OwnerArgs) => {
    const original = captured(h.originalOwner, OWNER);
    const flight = inFlight;
    // Between requests the recorder is the owner and records nothing.
    if (!flight) return original(...args);
    const [handed, teamId] = args;
    flight.trace.push({ step: "owner", owner: OWNER, client: clientOf(handed), args: { teamId }, arity: args.length });
    try {
      const entries = await original(...args);
      flight.trace.push({ step: "owner settled", owner: OWNER, settled: "resolved", entries: entries.length });
      return entries;
    } catch (error) {
      flight.trace.push({ step: "owner settled", owner: OWNER, settled: "rejected" });
      throw error;
    }
  });

  h.audit.mockReset();
  h.audit.mockImplementation(async (...args: AuditArgs) => {
    const original = captured(h.originalAudit, "audit");
    const flight = inFlight;
    // Between requests the integration writer's own audit rows are written as in every other file.
    if (!flight) return original(...args);
    const step: Step = { step: "audit", action: args[1].action, settled: "pending" };
    flight.trace.push(step);
    try {
      const written = await original(...args);
      step.settled = "resolved";
      return written;
    } catch (error) {
      step.settled = "rejected";
      throw error;
    }
  });

  h.revalidatePath.mockReset();
  h.revalidatePath.mockImplementation((path: string) => {
    flightOf("revalidatePath").trace.push({ step: "revalidate", path });
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
  inviteTripwires = (Object.keys(ADAPTER_OF) as Tool[]).map((tool) => ({
    tool,
    spy: vi.spyOn(ADAPTER_OF[tool], "invite").mockImplementation(async () => {
      flightOf(`${tool} invite`).trace.push({ step: "tripwire", name: `${tool} invite` });
      throw new Error(`${FIXTURE} the ${tool} adapter's invite was called: availability is a read`);
    }),
  }));
});

afterEach(() => {
  inFlight = null;
  h.adminDb = null;
  h.serverDb = null;
  h.trace = null;
  h.decrypts = null;
  for (const { spy } of inviteTripwires) spy.mockRestore();
  inviteTripwires = [];
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

/** Every seam whose own call log is read back per request. */
const seams = (): Record<string, Counted> => ({
  [OWNER]: h.owner,
  audit: h.audit,
  revalidatePath: h.revalidatePath,
  headers: h.headers,
  fetch: h.fetch,
  ...Object.fromEntries(inviteTripwires.map(({ tool, spy }): [string, Counted] => [`${tool} invite`, spy])),
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

// The guard's tables, the table the owner reads, and the ones its sibling writers would touch.
const DURABLE_TABLES = [
  "teams",
  "members",
  "auth_users",
  "groups",
  "group_members",
  "integrations",
  "member_provisioning",
  "api_keys",
  "audit_log",
] as const;
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
 * `role` defaults to admin; `posture` is the builtin row they hold and the legacy `members.tier`
 * column alike, defaulting to team. Nothing about the guard is stubbed, and no request changes these
 * rows: `members`, `groups` and `group_members` are in every durable difference.
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
  secrets.push(session);
  premise(`${label}'s session verifies under the real verifier`, await verifySession(session), user);
  return { label, team, memberId: id, user, session };
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

// Team A as seeded: Linear and GitHub complete, Slack enabled without its invite link.
const A_HELD = [
  heldRow("github", "enabled", { secret: true, org: true }),
  heldRow("linear", "enabled", { secret: true }),
  heldRow("slack", "enabled"),
];
const A_ANSWER: Answer = { entries: [LINEAR, NO_SLACK_LINK, GITHUB], enabledRows: 3, enabledSecrets: 2 };

// Team B as seeded, the complement tool by tool: Linear without its key, Slack complete, and a
// complete GitHub row that is disabled.
const B_HELD = [
  heldRow("github", "disabled", { secret: true, org: true }),
  heldRow("linear", "enabled"),
  heldRow("slack", "enabled", { inviteLink: true }),
];
const B_ANSWER: Answer = { entries: [NO_LINEAR_KEY, SLACK, NO_GITHUB_ORG], enabledRows: 2, enabledSecrets: 0 };

/**
 * Two teams, each with one healthy admin holding a signed session, and three integration rows whose
 * answers differ for every tool. Whichever team is not called is the bystander: a resolved team that
 * drifted, or a read that was not bound, would answer with its rows.
 */
async function seedWorld(): Promise<World> {
  const a = await seedTeam();
  const b = await seedTeam();
  premise("the two teams are distinct", [a.teamId === b.teamId, a.teamSlug === b.teamSlug], [false, false]);
  const alice = await seedCast(a, "alice");
  const bob = await seedCast(b, "bob");

  const linearA = await connect(a, "linear", {});
  await storeSecret(a, linearA, "linear-key");
  const slackA = await connect(a, "slack", {});
  const githubA = await connect(a, "github", { org: syntheticOrg() });
  await storeSecret(a, githubA, "github-token");

  const linearB = await connect(b, "linear", {});
  const slackB = await connect(b, "slack", { inviteLink: syntheticLink() });
  const githubB = await connect(b, "github", { org: syntheticOrg() }, "disabled");
  await storeSecret(b, githubB, "github-token");

  premise("each team holds its three rows", { a: await held(a), b: await held(b) }, { a: A_HELD, b: B_HELD });
  return {
    a,
    b,
    alice,
    bob,
    rowsA: { linear: linearA, slack: slackA, github: githubA },
    rowsB: { linear: linearB, slack: slackB, github: githubB },
  };
}

/** Every integration row id of either team: no statement the action issues binds one. */
const rowIds = (world: World): string[] => [...Object.values(world.rowsA), ...Object.values(world.rowsB)];

/** What a request resolved for team A must not carry: team B's identifiers, and any row id. */
const besidesA = (world: World): string[] => [
  world.b.teamId,
  world.b.teamSlug,
  world.b.memberId,
  world.bob.memberId,
  world.bob.user.id,
  ...rowIds(world),
];

/** The same for a request resolved for team B. */
const besidesB = (world: World): string[] => [
  world.a.teamId,
  world.a.teamSlug,
  world.a.memberId,
  world.alice.memberId,
  world.alice.user.id,
  ...rowIds(world),
];

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
 * uppercase WHERE its own clause. A write would carry its own op.
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

// ── the request ──────────────────────────────────────────────────────────────────────────────────

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

/** How often each seam was called since the request began, read off its own call log. */
const seamCalls = (): Record<string, number> =>
  Object.fromEntries(
    Object.entries(seams())
      .map(([name, seam]): [string, number] => [name, seam.mock.calls.length])
      .filter(([, calls]) => calls > 0),
  );

/**
 * A NEW invocation of the actual export for `teamSlug`, with its own cookie jar and trace: snapshot,
 * call, snapshot again. `session` is the session cookie, or null for none. `unwanted` are the
 * identifiers this request must not carry anywhere. Nothing is carried over from an earlier request
 * but the rows in Postgres.
 */
async function request(session: string | null, teamSlug: string, unwanted: string[]): Promise<Seen> {
  const jar = new Map<string, string>();
  if (session !== null) jar.set(SESSION_COOKIE, session);
  const flight: Flight = { jar, trace: [], refused: [] };
  const decrypts = { returned: 0, threw: 0 };
  let logged: string[] = [];
  let acquired = { server: 0, admin: 0 };
  let called: Record<string, number> = {};

  const before = await durable();
  for (const seam of Object.values(seams())) seam.mockClear();
  // The real adapter logs each failure it converts; captured so every such line is accounted for.
  const adapterLog = vi.spyOn(console, "error").mockImplementation(() => {});
  let outcome: Settled;
  try {
    inFlight = flight;
    h.trace = flight.trace;
    h.adminDb = recordingClient("admin", flight);
    h.serverDb = recordingClient("server", flight);
    h.decrypts = decrypts;
    h.acquired.server = 0;
    h.acquired.admin = 0;
    outcome = await settle(() => getProvisioningAvailabilityAction(teamSlug));
  } finally {
    acquired = { server: h.acquired.server, admin: h.acquired.admin };
    called = seamCalls();
    inFlight = null;
    h.trace = null;
    h.adminDb = null;
    h.serverDb = null;
    h.decrypts = null;
    logged = adapterLog.mock.calls.map((call) => String(call[0]));
    adapterLog.mockRestore();
  }
  const after = await durable();

  premise("no statement the request issued was refused by Postgres", flight.refused, []);

  const returned = "returned" in outcome ? outcome.returned : null;
  const carried = JSON.stringify({ outcome, trace: flight.trace, logged });
  return {
    outcome: printable(outcome),
    shape: Array.isArray(returned) ? returned.map((entry) => Object.keys(entry as Row)) : null,
    trace: escapes(JSON.stringify(flight.trace)) ? [{ step: WITHHELD }] : flight.trace,
    acquired,
    seams: called,
    decrypts,
    changed: changes(before, after),
    escaped: escapes(carried),
    foreign: unwanted.some((identifier) => carried.includes(identifier)),
    logged: logged.filter((line) => line.startsWith("[pg]")).map((line) => (escapes(line) ? WITHHELD : line)),
  };
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

const COOKIE: Step = { step: "cookie", name: SESSION_COOKIE };
const SERVER_CLIENT: Step = { step: "client", via: "server" };
const SERVICE_CLIENT: Step = { step: "client", via: "admin" };

/** The slug's team, as the guard reads it. */
const teamRead = (team: Seed): Step => statement("server", "teams", { slug: team.teamSlug }, 1);

/** The session's active member in `team`, as the guard reads it: answered with one row, or none. */
const memberRead = (team: Seed, user: SessionUser, rows: number): Step =>
  statement("server", "members", { team_id: team.teamId, auth_user_id: user.id, status: "active" }, rows);

/**
 * The permission prerequisite of a member of the slug's own team, in the order the owners issue it —
 * as read from lib/auth/guard, lib/auth/session, lib/integrations/read and lib/access/posture: the
 * session cookie, the server client, the slug's team, the session's active member in it, and that
 * member's group rows. The posture read precedes the role-and-posture verdict, so a non-admin owes it.
 */
const guardChain = (who: Cast, postureRows: number): Step[] => [
  COOKIE,
  SERVER_CLIENT,
  teamRead(who.team),
  memberRead(who.team, who.user, 1),
  statement("server", "group_members", { team_id: who.team.teamId, member_id: who.memberId }, postureRows),
];

/**
 * One adapter's read as the real builder compiles it — as read from `getEnabledIntegrationsWithSecrets`:
 * issued on the service client, bound to the resolved team and to `enabled`, answered with that
 * team's enabled rows.
 */
const read = (team: Seed, rows: number): Step =>
  statement("admin", "integrations", { team_id: team.teamId, status: "enabled" }, rows);

/**
 * An admitted call: the guard's reads answered by `who`'s rows; the service client; the real owner
 * entered with that client and the server-resolved team id and nothing else; one read per adapter and
 * no other statement; the owner resolved with three entries, each carrying the owner's three keys;
 * each read's stored secrets decrypted; no audit, revalidation or tripwire; no durable difference;
 * nothing of the fixture and nothing of the bystander team anywhere.
 */
const admitted = (who: Cast, postureRows: number, answer: Answer) => ({
  outcome: { returned: answer.entries },
  shape: [ENTRY_KEYS, ENTRY_KEYS, ENTRY_KEYS],
  trace: [
    ...guardChain(who, postureRows),
    SERVICE_CLIENT,
    { step: "owner", owner: OWNER, client: REQUEST_SERVICE_CLIENT, args: { teamId: who.team.teamId }, arity: 2 },
    read(who.team, answer.enabledRows),
    read(who.team, answer.enabledRows),
    read(who.team, answer.enabledRows),
    { step: "owner settled", owner: OWNER, settled: "resolved", entries: 3 },
  ],
  acquired: { server: 1, admin: 1 },
  seams: { [OWNER]: 1 },
  decrypts: { returned: 3 * answer.enabledSecrets, threw: 0 },
  changed: {},
  escaped: false,
  foreign: false,
  logged: [],
});

/**
 * A refused call: the action's documented empty list; exactly the guard's own steps up to the one
 * that refused; the service client never acquired, so nothing below the wrapper was handed it; no
 * owner entry, no decryption, no audit, no revalidation, no tripwire and no durable difference.
 */
const refused = (trace: Step[], serverClients: number) => ({
  outcome: { returned: [] },
  shape: [],
  trace,
  acquired: { server: serverClients, admin: 0 },
  seams: {},
  decrypts: { returned: 0, threw: 0 },
  changed: {},
  escaped: false,
  foreign: false,
  logged: [],
});

/** A new invocation under `who`'s session, for `who`'s own team, that the gate must ADMIT. */
async function admit(who: Cast, unwanted: string[], answer: Answer, label: string): Promise<void> {
  const postureRows = await groupRows(who);
  expect(await request(who.session, who.team.teamSlug, unwanted), label).toEqual(
    admitted(who, postureRows, answer),
  );
}

/**
 * A new invocation under `who`'s session, for `who`'s own team, that the gate must REFUSE on the
 * role-and-posture verdict: the session, the team and the active membership are all admitted.
 */
async function refuse(who: Cast, unwanted: string[], label: string): Promise<void> {
  const postureRows = await groupRows(who);
  expect(await request(who.session, who.team.teamSlug, unwanted), label).toEqual(
    refused(guardChain(who, postureRows), 1),
  );
}

describe("AIO-1217 native provisioning-availability action — app/t/[team]/admin/actions getProvisioningAvailabilityAction through the real requireTeamAdmin chain and the real lib/provisioning/run owner over real Postgres (direct calls: no action wire, no provider)", () => {
  it(
    "1 — admitted on each of two teams holding complementary rows: team A's admin is answered linear configured, slack `no Slack invite link set`, github configured; team B's admin is answered linear `Linear API key not set`, slack configured, github `no GitHub org set` for its disabled row — each call hands the real owner the service client and the server-resolved team id, issues one read per adapter bound to that team and answered with that team's enabled rows only, changes no row, and carries nothing of the other team or of the fixture's secrets and config; the real owner called directly over the unrecorded client answers the same",
    async () => {
      const world = await seedWorld();

      await admit(world.alice, besidesA(world), A_ANSWER, "Alice on team A");
      // Only the session and the slug differ: nothing of team A's is bound, handed down or returned.
      await admit(world.bob, besidesB(world), B_ANSWER, "Bob on team B");

      // Neither the recorder nor the recording transport is what produced the answers.
      const owner = captured(h.originalOwner, OWNER);
      const direct = {
        a: printable(await settle(() => owner(db(), world.a.teamId))),
        b: printable(await settle(() => owner(db(), world.b.teamId))),
      };
      expect(direct, "the real owner, called directly over the unrecorded helper client").toEqual({
        a: { returned: A_ANSWER.entries },
        b: { returned: B_ANSWER.entries },
      });
    },
    ROOMY,
  );

  it(
    "2 — the answer follows the called team's rows and only those: enabling team B's GitHub row changes team B's answer and leaves team A's answer, reads and decryptions as they were; giving team A's Slack row its invite link turns team A's slack configured, and disabling team A's Linear row turns it `no enabled Linear integration` with one row and one decryption fewer per read — while team B's answer stays its own; every step is a new invocation and none changes a row",
    async () => {
      const world = await seedWorld();
      await admit(world.alice, besidesA(world), A_ANSWER, CONTROL);

      // Team B alone changes: its complete GitHub row is enabled.
      await setStatus(world.b, world.rowsB.github, "enabled");
      premise(
        "team B's GitHub row is enabled and team A's rows are as seeded",
        { a: await held(world.a), b: await held(world.b) },
        { a: A_HELD, b: [heldRow("github", "enabled", { secret: true, org: true }), B_HELD[1], B_HELD[2]] },
      );
      const bEnabled: Answer = { entries: [NO_LINEAR_KEY, SLACK, GITHUB], enabledRows: 3, enabledSecrets: 1 };
      // The change is real and readable through the same action: team A's sameness is not vacuous.
      await admit(world.bob, besidesB(world), bEnabled, "Bob on team B with its GitHub enabled");
      await admit(world.alice, besidesA(world), A_ANSWER, "Alice on team A after team B's change");

      // Team A alone changes: the Slack row is given the one conjunct it lacked.
      await connect(world.a, "slack", { inviteLink: syntheticLink() });
      await admit(
        world.alice,
        besidesA(world),
        { entries: [LINEAR, SLACK, GITHUB], enabledRows: 3, enabledSecrets: 2 },
        "Alice on team A with its Slack invite link set",
      );

      // The disabled row still holds its secret: it is neither read nor decrypted.
      await setStatus(world.a, world.rowsA.linear, "disabled");
      premise("team A's Linear row is disabled and holds what it held", await held(world.a), [
        A_HELD[0],
        heldRow("linear", "disabled", { secret: true }),
        heldRow("slack", "enabled", { inviteLink: true }),
      ]);
      await admit(
        world.alice,
        besidesA(world),
        { entries: [NO_LINEAR, SLACK, GITHUB], enabledRows: 2, enabledSecrets: 1 },
        "Alice on team A with its Linear disabled",
      );
      await admit(world.bob, besidesB(world), bEnabled, "Bob on team B after team A's changes");
    },
    ROOMY,
  );

  it(
    "3 — no session cookie: after an admitted control answered with three entries, a new invocation for the same valid slug with an empty cookie jar returns the empty list after the cookie read alone — no server or service client, no statement, no owner entry, no integration read, no decryption, no audit, no revalidation, no tripwire and no changed row; a further invocation under the admin's session is answered as the control was",
    async () => {
      const world = await seedWorld();
      await admit(world.alice, besidesA(world), A_ANSWER, CONTROL);

      expect(
        await request(null, world.a.teamSlug, [world.a.teamId, ...besidesA(world)]),
        "no session cookie, team A's slug",
      ).toEqual(refused([COOKIE], 0));

      // The refusal was the request's: nothing of it outlives the call.
      await admit(world.alice, besidesA(world), A_ANSWER, "Alice on team A after the refused call");
    },
    ROOMY,
  );

  it(
    "4 — an active non-admin of the team: after an admitted control, an active `member` and an active `lead` of team A, each holding the builtin Everyone row and a session the real verifier accepts, are each returned the empty list on a new invocation for team A's slug — after the guard's team, membership and posture reads answered by their own rows, and before the service client, the owner, any integration read or decryption, audit and revalidation; no row changes",
    async () => {
      const world = await seedWorld();
      await admit(world.alice, besidesA(world), A_ANSWER, CONTROL);

      for (const role of ["member", "lead"] as const) {
        // Same team, same posture, same status as the control: only the role differs.
        const who = await seedCast(world.a, `role-${role}`, { role });
        await refuse(who, besidesA(world), `an active ${role} of team A holding the Everyone row`);
      }
    },
    ROOMY,
  );

  it(
    "5 — an active role-admin of external posture: after an admitted control, an active admin of team A who holds the builtin External row and no builtin Everyone row is returned the empty list on a new invocation for team A's slug — after the guard's team, membership and posture reads, and before the service client, the owner, any integration read or decryption, audit and revalidation; no row changes",
    async () => {
      const world = await seedWorld();
      await admit(world.alice, besidesA(world), A_ANSWER, CONTROL);

      // Same team, same role, same status as the control: only the builtin row held differs.
      const who = await seedCast(world.a, "external-admin", { posture: "external" });
      await refuse(who, besidesA(world), "an active role-admin of team A of external posture");
    },
    ROOMY,
  );

  it(
    "6 — team B's admin given team A's slug: after admitted controls for each admin on their own team, team B's healthy admin calling with team A's slug is returned the empty list — the slug resolves team A, the membership read bound to team A and to that session's user answers no row, and nothing follows: no posture read, no service client, no owner entry, no read of either team's integrations, no decryption, no audit, no revalidation and no changed row; the same session with team B's slug is then answered with team B's rows",
    async () => {
      const world = await seedWorld();
      await admit(world.alice, besidesA(world), A_ANSWER, CONTROL);
      await admit(world.bob, besidesB(world), B_ANSWER, CONTROL);

      // Team A's id and the caller's own user id are what the guard binds; nothing else of either team is.
      const unwanted = [world.b.teamId, world.b.teamSlug, world.b.memberId, world.bob.memberId, ...rowIds(world)];
      expect(
        await request(world.bob.session, world.a.teamSlug, unwanted),
        "Bob, team B's admin, with team A's slug",
      ).toEqual(refused([COOKIE, SERVER_CLIENT, teamRead(world.a), memberRead(world.a, world.bob.user, 0)], 1));

      // The session is not what was refused: with its own team's slug it is answered, and with its own rows.
      await admit(world.bob, besidesB(world), B_ANSWER, "Bob on team B after the refused call");
    },
    ROOMY,
  );
});

// Each TODO names the owner of evidence this slice was told not to supply.
describe("Z — evidence this file does NOT supply (executable TODOs: none is run, none is passed)", () => {
  it.todo(
    "RUN · this file was authored without executing vitest, tsc or eslint; its six cases are unobserved until a registered stage runs them, and the fixture SQL (auth_users and members inserts, the builtin-row readback) and the guard's trace follow the association file, which was itself unrun at its authoring",
  );
  it.todo(
    "OTHER REFUSALS · a cookie the verifier rejects (malformed, expired, or signed under another AUTH_SECRET), an inactive or suspended member, an unknown team slug and a member bound to no auth user are not exercised here; cases 3–6 are the four refusals this slice names and no more",
  );
  it.todo(
    "READ FAULTS THROUGH THE ACTION · a guard read that errors (the posture read throws; the team and membership reads do not), an owner read fault caught per tool, and a stored ciphertext that cannot be decrypted are not reached through the action by this file; the owner file's case 5 is a direct call, and whether the action should return, reject or disclose the read's error text is not specified by any source this file reads",
  );
  it.todo(
    "ACTION WIRE · Next Server Action dispatch — POST, origin check, action-id encryption, argument deserialization and serialization of the returned list to the client — is not exercised: every call here is a direct call of the exported function",
  );
  it.todo(
    "INVITE AND PROVISIONING WRITES · inviteMember, issueMemberInvite, runProvisioning, the three adapters' invite, the member_provisioning upserts, their member.provisioned audit rows, provider delivery and the F4 missing-integration run and audit policy are a different owner; here the adapters' invite and fetch are throwing tripwires held at zero and nothing of that path is executed or judged",
  );
  it.todo(
    "API KEYS · issueApiKey and revokeApiKey of the same module, and the deferred AIO-1226 same-team member-target refusal, are neither called nor asserted by this file",
  );
  it.todo(
    "LEGACY TIER · every caster's members.tier column agrees with the builtin row held; the disagreement between legacy SQL that reads the column and the action gate that reads the builtin Everyone row is the association file's observation and is not repeated, corrected or declared compliant here",
  );
  it.todo(
    "PROCESS GITHUB_TOKEN · the GitHub adapter's process-wide fallback is pinned empty for every case, so it is never reached through the action; the owner file's case 6 records it for direct calls, and whether availability should depend on a value that is not team state is not specified by any source this file reads",
  );
  it.todo(
    "UNAUDITED DECRYPTING READ · an admitted availability call decrypts every stored secret of the team's enabled rows once per adapter and appends no audit_log row; that is recorded as a tally and an empty difference only — whether such a read should be audited, or should decrypt at all to answer a boolean, is not specified by any source this file reads and is not ruled on here",
  );
  it.todo(
    "DURABLE DIFFERENCE, REMAINDER · the before/after rowsets cover teams, members, auth_users, groups, group_members, integrations, member_provisioning, api_keys and audit_log; a write to any other table, to a sequence, or to anything outside Postgres would not be seen by this file",
  );
  it.todo(
    "SEVERAL ROWS AND OTHER TYPES · a team holding several enabled rows of one type, or an enabled row of a type no provisioning adapter reads, is not exercised through the action; nor is concurrency — membership and integration rows are read per request and no revocation or linearizability claim is made",
  );
  it.todo(
    "COORDINATOR · MUTANTS (isolated-copy actual-import run): against this fixture, ignore the null requireTeamAdmin verdict in getProvisioningAvailabilityAction (cases 3–6 should fail); hand the owner a team id other than ctx.teamId (cases 1–2); drop the `team_id` or the `status = enabled` equality from getEnabledIntegrationsWithSecrets (cases 1–2); drop the role conjunct of canAccessAdmin (case 4) or its posture conjunct (case 5) — each on the outcome, the trace and the seam call logs, not on a compile or fixture error; which cases actually fail is unobserved and no mutation evidence is supplied here",
  );
  it.todo(
    "INVENTORY AND ACCEPTANCE · the complete AIO-1217 Server Action inventory, its acceptance criteria, review, documentation and full-suite checks are not supplied by this file, which evidences one export's composition with one owner only",
  );
});
