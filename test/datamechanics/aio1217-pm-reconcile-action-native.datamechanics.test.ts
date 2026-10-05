import { randomBytes, randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PgClient } from "@/lib/db/pg/client";
import { getPool, runSql } from "@/lib/db/pg/pool";
import type { DbClient, SqlExecutor } from "@/lib/db/types";
import { db, placeMemberByTier, seedTeam, type Seed } from "./helpers";

/**
 * AIO-1217 — REAL PM ADMIN ACTION, NATIVE RECONCILIATION, against real Postgres: what
 * `app/t/[team]/admin/pm-sync/actions.ts#reconcileDivergenceAction` itself returns and writes,
 * executed as the actual exported function through the actual `requireTeamAdmin` chain and the actual
 * `reconcileProviderState`, for a team whose primary PM provider is `linear` and whose enabled Linear
 * integration holds a decryptable SYNTHETIC secret — while another team holds the same, with its own
 * secret, its own Linear team id and its own linked task.
 *
 * This is the owner evidence `aio1217-admin-guard-association` left beneath its seam (there
 * `reconcileProviderState` and `audit` are recording doubles) and the secret-bearing branch
 * `aio1217-pm-project-board-integration-resolution` named as a TODO (there no ciphertext is
 * decryptable and no adapter is selected).
 *
 *   1 — an admitted pass: the acting team's integration alone is resolved and decrypted, only its
 *       linked rows are read, the provider's states are read through three read-only queries, two
 *       `provider_seen_status` values are recorded, one divergence is returned, one audit row is
 *       written and one revalidation is asked — after the owner has returned.
 *   2 — the idempotent rerun: the same call again over an UNCHANGED synthetic board, which is read
 *       again, records nothing (`seenUpdated: 0`, no link statement but the read) and still surfaces
 *       the divergence.
 *   3 — four refusals by real session and row state, after an admitted control.
 *   4 — F4, six cells (`linear` and `plane` named; the named integration missing, disabled or
 *       secret-less): the real owner answers the named provider marked `notRunReason:
 *       "integration_unavailable"` and the action returns exactly `{ ok: false, error: "primary PM
 *       integration is unavailable" }` — no link read, no provider request, no audit row, no
 *       revalidation, no durable difference — and the same again on a repeat, while a usable
 *       same-provider integration of the OTHER team and a usable other-provider integration of the
 *       ACTING team rescue nothing; a non-admin of that team is still refused as `admins only` first.
 *   5 — a resolved `linear` pass with no link holding a resource id: an unmarked success.
 *   6 — a usable `plane` integration, with and without links: the owner's unsupported-adapter answer,
 *       unmarked, reported, audited and revalidated as before (pinned as current, not endorsed).
 *   7 — no resolvable provider (none enabled; two enabled with no primary named): the action's
 *       existing refusal carrying the owner's reason, unmarked.
 *   8 — no primary named and ONE PM integration enabled (the sole-enabled fallback): `linear` passes
 *       as case 1 does, `plane` as case 6 does.
 *   Z — what this file does not supply, as executable TODOs naming the owner.
 *
 * SOURCE FACTS the expectations are read from:
 *   app/t/[team]/admin/pm-sync/actions.ts
 *     :88-89  `requireAdmin(teamSlug)`; a null verdict returns `{ ok: false, error: "admins only" }`.
 *     :91-92  only then `adminClient()` and `reconcileProviderState(db, ctx.teamId)` — two arguments,
 *             so no `fetchImpl` is handed down.
 *     :93     a null provider returns `result.reason`, before the audit write.
 *     :94-98  F4: `notRunReason === "integration_unavailable"` returns the two-key failure, before
 *             the audit write.
 *     :100-108 the `team.reconcile_divergence` audit write, `meta` of the provider, `seenUpdated`
 *             and the NUMBER of divergences.
 *     :110-111 `revalidatePath` of `/t/<slug>/admin/pm-sync`, then the `ok: true` return.
 *   lib/pm-sync/reconcile.ts
 *     :79-97  `resolvePrimaryProvider`; a null provider returns its reason, unmarked; a named
 *             provider with a null integration returns its reason MARKED `integration_unavailable`;
 *             an adapter with no `fetchSeenStates` (plane) returns its own reason, unmarked — all
 *             three before the link read.
 *     :99-106 the link read: `task_pm_links` by `team_id` and `provider`, resource id not null; no
 *             link returns before any provider read.
 *     :109    ONE `fetchSeenStates`, handed the resolved integration.
 *     :113-135 per link: no state for its resource id leaves it as it is; the state NAME is written
 *             to `provider_seen_status`, by link `id`, only when it differs from the stored one; a
 *             divergence is pushed when that name differs from a non-empty `last_projected_status`.
 *   lib/pm-sync/project.ts:114-144  `resolvePrimaryProvider`: `getEnabledIntegrationsWithSecrets(db,
 *             teamId)`, then the team's `primary_pm_provider` by id; the configured provider's
 *             same-type row holding a secret is the integration, and with none the provider is
 *             still NAMED, its integration null; with no primary named, exactly one provider with
 *             such a row resolves, none or two do not.
 *   lib/pm-sync/plane.ts:188-294  `planeAdapter` defines `prepare`, `upsertWorkItem` and
 *             `moveToDone`, and no `fetchSeenStates`.
 *   lib/integrations/manage.ts:254-271  the read is `integrations` by `team_id` and `status =
 *             "enabled"`; `decryptSecret` is applied to each answered non-null `secret_ciphertext`.
 *   lib/pm-sync/linear.ts
 *     :99-104 `linearCtx`: the key is `integration.secret`, the Linear team is `config.teamId`, and
 *             the transport is `input.fetchImpl ?? fetch` — global `fetch` when none is handed down.
 *     :116-193 `buildBootstrap`: `ProjectionBootstrap` with `{ teamId }`, then `ProjectionMembers`
 *             and `ProjectionIssues` with `{ teamId, after }`, `after` starting null; each stops on a
 *             page with no next page.
 *     :269-278 `fetchSeenStates`: resource id → `{ name, type }` for every issue carrying a state.
 *   lib/api/audit.ts:19-45  the audit writer; best-effort.
 *   lib/auth/guard.ts:46-53, lib/auth/session.ts:11-15, lib/integrations/read.ts:67-91,
 *   lib/access/posture.ts:26-44, lib/auth/admin-access.ts:12-17  the gate: no server client without a
 *             session user; team by slug; the session's active member (role is not filtered in the
 *             statement); that member's group rows; then role admin AND team posture.
 *
 * What is real, and never mocked or handed a verdict: the export; `requireTeamAdmin` →
 * `getSessionUser` → `verifySession` (jose HS256 against AUTH_SECRET) → `resolveIntegrationsAdmin` →
 * `resolveViewerPosture` → `canAccessAdmin`; `reconcileProviderState` → `resolvePrimaryProvider` →
 * `getEnabledIntegrationsWithSecrets` → `decryptSecret` (AES-256-GCM under SECRETS_KEY); the link
 * read; `linearAdapter.fetchSeenStates` → `buildBootstrap` and whatever `lib/pm-sync/linear-client`
 * does between the adapter and `fetch`; the link update; `audit`; the query builder, the pg pool and
 * Postgres.
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
 *   SEAM observe     `@/lib/pm-sync/reconcile` is the ORIGINAL module with `reconcileProviderState`
 *                    wrapped by a PASS-THROUGH recorder: it records the client and arguments it was
 *                    handed, CALLS THE ORIGINAL with exactly those arguments, records what it settled
 *                    with, marks in the trace that it returned, and returns that.
 *   SEAM decrypt     `@/lib/secrets/crypto` is the ORIGINAL module with `decryptSecret` wrapped by a
 *                    PASS-THROUGH recorder. It calls the original and notes WHICH of this file's
 *                    synthetic secrets came back, by label — never its argument and never the value.
 *   SEAM provider    global `fetch` is a recording SYNTHETIC responder. It opens no socket and calls
 *                    no real `fetch`. It answers exactly three read-only Linear GraphQL queries —
 *                    `ProjectionBootstrap`, `ProjectionMembers`, `ProjectionIssues` — for the ONE
 *                    synthetic Linear team the acting integration is configured with, from a board
 *                    this file holds as a plain value. Anything else is a TRANSPORT VIOLATION, which
 *                    is recorded, thrown into the caller, and asserted empty for every request: a
 *                    body that is not JSON; any text containing `mutation`; any other operation; a
 *                    read for another Linear team; a request carrying, anywhere in its URL, headers
 *                    or body, the other team's synthetic secret or its Linear team id.
 *   SEAM tripwire    `next/headers` `headers`. Records and throws.
 *
 * ASSUMED, NOT READ. `lib/pm-sync/linear-client.ts` — `linearGraphql` — is outside this slice's read
 * list. Two things about it are taken from elsewhere and would fail loudly here if wrong: that the
 * request body is the GraphQL envelope `{ query, variables }` as a string (the existing
 * `reconcile-divergence` file parses `query` out of `init.body`; `variables` is the argument
 * linear.ts hands it), and that it accepts a `Response.json({ data })` answer (the shape that file
 * answers with). The endpoint URL, the HTTP method, the header the key travels in, and its error,
 * retry and rate-limit handling were not read and are NOT asserted. Likewise outside the read list,
 * and read back from the pool as fixture premises wherever cases 4 to 8 lean on them: that
 * `integrations.status` takes the value `disabled`, that `secret_ciphertext` may be set null on an
 * enabled row, and that `upsertIntegration` takes a `plane` row with an invented workspace and
 * project id.
 *
 * Every request is: whole-rowset snapshots of ten tables read from the pool by raw SQL immediately
 * before and after; how the call settled and the key list of what it returned; ONE ORDERED TRACE of
 * the session cookie read, each client acquisition, each statement either client issued with the
 * equalities bound into it and the row count Postgres answered, the pass-through call with its
 * arguments and answer, each decrypt, each provider read with its operation and variables, the
 * owner's return, and each revalidation; the acquisition counts; the seams' own call logs; and every
 * identifier the request's statements bound, searched for the other team's. The trace of an admitted
 * request is asserted WHOLE.
 *
 * Bounds of what is claimed.
 *   - ONE EXPORT. Only `reconcileDivergenceAction`: its refusal, the resolved `linear` pass with and
 *     without linked rows, the F4 unavailable-integration refusal, the unsupported `plane` outcome
 *     and the null-provider refusal. `projectBoardAction` is not called. This is not an AC-04 pass,
 *     not full action authorization, not an action inventory and not acceptance of any AIO-1217
 *     criterion.
 *   - PLANE IS NEVER RECONCILED. Cases 6 and 8 pin what the action does today with a usable `plane`
 *     integration — success, an audit row and a revalidation over a board nobody read. That is
 *     preserved, not endorsed, and is not evidence of Plane inbound reconciliation.
 *   - THE PROVIDER IS A VALUE IN THIS FILE. The responder is evidence of what the owner and the action
 *     ASK and what they do with a given answer. It is not evidence of Linear's service behavior, its
 *     schema, its authorization of any key, or any provider-side effect.
 *   - "NO PROVIDER MUTATION" IS A COUNT OF WHAT REACHED GLOBAL `fetch`: three reads, no violation.
 *     A transport that is not global `fetch` would not be counted.
 *   - TEAM-BOUND RESOLUTION IS EVIDENCED BY THE READS, THEIR ROW COUNTS, THE ONE DECRYPT AND THE
 *     ANSWER. The integrations read binds the acting team and `enabled` and is answered with one row
 *     where the same read without its team equality would get two; one secret is decrypted and it is
 *     the acting team's; the link read binds the acting team and `linear` and is answered with three
 *     rows where four would answer without the team equality; every provider read names the acting
 *     integration's configured Linear team. The synthetic board deliberately lists the OTHER team's
 *     resource id as `Done`: a link read that lost its team equality would record it.
 *   - CONFINEMENT IS OF EFFECTS AND BINDINGS. Every row the other team holds in the ten tables is
 *     unchanged and none of its identifiers is bound by an admitted request.
 *   - NO TASK CONTENT. The link read names six bookkeeping columns; no `tasks` statement is issued.
 *     Nothing here is evidence of a task-level content boundary.
 *   - NO ADMITTED OTHER-TEAM INVOCATION. Team B's admin is seeded and calls the action only to be
 *     refused at team A's slug.
 *   - Direct calls of the exported function: not Next action-wire, POST dispatch, origin, encryption
 *     or cache-invalidation proof. Membership is read per request: no revocation claim is made.
 *   - Nothing about reconcile error policy, AIO-1226 or PR714.
 *
 * NOTHING HERE IS A CREDENTIAL. The two integration secrets are random marker strings that are not
 * in any provider's key format and belong to no account; they are encrypted and decrypted under a
 * SECRETS_KEY generated per test. The Linear team ids, issue ids and workflow state ids are invented
 * strings. No provider URL is written and no provider is contacted.
 *
 * Run status. NOT RUN. This file was written without executing vitest, tsc, lint or any other
 * command; every expectation comes from reading the sources named above, not from an observed run.
 * Replace this paragraph with the observed result once the file has been executed. Cases 4 to 8 and
 * the owner key-list assertion of cases 1 to 3 were added with the F4 marker by a later writer under
 * the same condition: NOT RUN — against the F4 sources, and against the sources before them, so no
 * RED was observed either.
 */

const FIXTURE = "FIXTURE PREMISE FAILED (setup, not a security observation):";
const CONTROL = "ADMITTED CONTROL FAILED (the paired refusal would be vacuous):";
const TRANSPORT = "TRANSPORT VIOLATION (the synthetic provider answers three state reads and nothing else):";

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
  /** SEAM observe: the pass-through recorder. */
  reconcileProviderState: vi.fn(),
  /** SEAM decrypt: the pass-through recorder. */
  decryptSecret: vi.fn(),
  /** The originals the recorders forward to, captured when each module is first loaded. */
  real: {
    reconcileProviderState: null as
      | (typeof import("@/lib/pm-sync/reconcile"))["reconcileProviderState"]
      | null,
    decryptSecret: null as (typeof import("@/lib/secrets/crypto"))["decryptSecret"] | null,
  },
  /** SEAM provider: the recording synthetic responder installed as global `fetch`. */
  fetch: vi.fn(),
  /** SEAM tripwire. */
  headers: vi.fn(),
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
// The original module; the one lower owner the action calls is wrapped, not replaced.
vi.mock("@/lib/pm-sync/reconcile", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/pm-sync/reconcile")>();
  h.real.reconcileProviderState = original.reconcileProviderState;
  return { ...original, reconcileProviderState: h.reconcileProviderState };
});
// The original module; the one function the integrations read applies to a ciphertext is wrapped.
vi.mock("@/lib/secrets/crypto", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/secrets/crypto")>();
  h.real.decryptSecret = original.decryptSecret;
  return { ...original, decryptSecret: h.decryptSecret };
});

import { reconcileDivergenceAction } from "@/app/t/[team]/admin/pm-sync/actions";
import { SESSION_COOKIE, signSession, verifySession, type SessionUser } from "@/lib/auth/pg-session";
import { setIntegrationSecret, upsertIntegration } from "@/lib/integrations/manage";

type Reconcile = typeof import("@/lib/pm-sync/reconcile");
type Crypto = typeof import("@/lib/secrets/crypto");
type Row = Record<string, unknown>;
type Role = "admin" | "member";
type Tier = "team" | "external";
type Via = "admin" | "server";
/** One entry of a request's ordered trace: `step` names its kind, the rest is what it carried. */
type Step = Row;

/** Two teams, their sessions, one request, and whole-rowset snapshots around it. */
const ROOMY = 30_000;
/** Cases 2 and 3 make up to five requests. */
const ROOMIER = 60_000;

/** The provider cases 1 to 3 configure throughout: every primary, integration row and link. */
const PROVIDER = "linear";
/** The two PM providers a team can name as its primary; cases 4 to 8 configure either. */
type PmKind = "linear" | "plane";
/** The other provider: what a non-rescue control enables in the acting team. */
const ALTERNATE: Record<PmKind, PmKind> = { linear: "plane", plane: "linear" };

const OWNER = "reconcileProviderState";
const AUDIT_ACTION = "team.reconcile_divergence";

const ADMINS_ONLY = { ok: false, error: "admins only" };
/** F4: the action's refusal of a named primary whose integration is missing, disabled or secret-less. */
const UNAVAILABLE = { ok: false, error: "primary PM integration is unavailable" };
/** The owner's internal marker for that state: never a key of anything the action returns. */
const NOT_RUN = "integration_unavailable";

/** The key list of a refusal: no provider, seenUpdated or divergences key. */
const REFUSED_KEYS = ["error", "ok"];
/** The key list of the action's `ok: true` return: no error key. */
const RECONCILED_KEYS = ["divergences", "ok", "provider", "seenUpdated"];
/** The key list of what the real owner answers for a pass that ran: no reason and no marker key. */
const RESOLVED_KEYS = ["divergences", "provider", "seenUpdated"];

/** What the pass-through recorder notes when it was handed the service client of the request in flight. */
const REQUEST_SERVICE_CLIENT = "the service client of this request";
const SOME_OTHER_CLIENT = "NOT the service client of this request";

/** What the pass-through step holds until its original settles. */
const UNSETTLED = "the original never settled";

const NATIVE_ERROR = "native error:";

/** The labels the decrypt recorder answers with: which synthetic secret came back, never the value. */
const A_SECRET = "team A's synthetic secret";
const A_ALT_SECRET = "team A's other-provider synthetic secret";
const B_SECRET = "team B's synthetic secret";
const UNKNOWN_SECRET = "a value this file did not write";

/** The three read-only queries the real `buildBootstrap` issues, in the order it issues them. */
const READS: readonly string[] = ["ProjectionBootstrap", "ProjectionMembers", "ProjectionIssues"];

/** Invented workflow states: names and types as the real adapter reads them, ids that name nothing. */
const SYNTHETIC_STATES = [
  { id: "aio1217-syn-state-backlog", name: "Backlog", type: "backlog" },
  { id: "aio1217-syn-state-todo", name: "Todo", type: "unstarted" },
  { id: "aio1217-syn-state-started", name: "In Progress", type: "started" },
  { id: "aio1217-syn-state-done", name: "Done", type: "completed" },
];
type SyntheticState = (typeof SYNTHETIC_STATES)[number];

function stateNamed(name: string): SyntheticState {
  const state = SYNTHETIC_STATES.find((candidate) => candidate.name === name);
  if (!state) throw new Error(`${FIXTURE} no synthetic workflow state is named ${name}`);
  return state;
}

/**
 * The synthetic provider: the one Linear team the responder answers for, the issue states it reads
 * back, and the strings no request may carry. This value IS the explicit provider read control —
 * what the owner is told is exactly what a case put here.
 */
interface Provider {
  linearTeam: string;
  issues: Array<{ id: string; state: SyntheticState }>;
  forbidden: Record<string, string>;
}

interface Flight {
  jar: Map<string, string>;
  trace: Step[];
  /** The statements Postgres itself refused; a fixture premise holds this empty. */
  refused: string[];
  /** Every statement either client issued, as its text and its bound parameters. */
  bound: string[];
  /** Every request the synthetic provider refused to answer; asserted empty for every request. */
  violations: string[];
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
  /** The argument lists `revalidatePath` was called with, in order, read off its own call log. */
  revalidated: unknown[][];
  bound: string[];
}

interface Cast {
  label: string;
  team: Seed;
  memberId: string;
  user: SessionUser;
  /** `signSession(user)` under this test's AUTH_SECRET. */
  session: string;
}

/** One task and the `task_pm_links` row that ties it to a provider resource. */
interface Linked {
  rowKey: string;
  taskId: string;
  linkId: string;
  /** Null for a link that was never projected. */
  resourceId: string | null;
}

/** One team with the project, tasks, links and integration row this file gave it. */
interface Board {
  team: Seed;
  projectIds: string[];
  integrationIds: string[];
  links: Linked[];
  /** The invented Linear team id in the team's integration config. */
  linearTeam: string;
}

interface World {
  a: Board;
  b: Board;
  /** Team A's active admin holding its builtin Everyone row. */
  alice: Cast;
  /** The same in team B. Never admitted by an invocation in this file. */
  bob: Cast;
  /** Team A's link whose brain projection reads `Backlog` while the board reads `Done`. */
  diverged: Linked;
  /** Team A's link whose brain projection and board both read `In Progress`. */
  inSync: Linked;
  /** Team A's link whose resource id the board does not list. */
  unanswered: Linked;
  /** Team A's link with no resource id: never projected. */
  unprojected: Linked;
  /** Team B's one link, whose resource id the board lists as `Done`. */
  foreign: Linked;
  /** Every synthetic secret this world encrypted, by the label the decrypt recorder answers with. */
  markers: Record<string, string>;
  provider: Provider;
}

/**
 * The two teams, their admins and the secret labels alone: no primary named, no integration and no
 * link. What cases 4 to 8 start from and arrange for themselves.
 */
type Stage = Pick<World, "a" | "b" | "alice" | "bob" | "markers">;

/** What one pass of the real owner is expected to do with the board as it stands. */
interface Pass {
  /** The links whose `provider_seen_status` this pass rewrites, with the state name each is given. */
  rewritten: Array<{ link: Linked; state: string }>;
  /** The divergences the pass surfaces. */
  divergences: Row[];
}

/** What an admitted invocation whose pass never reaches the provider is expected to do. */
interface Late {
  /** What the real owner answers: these keys and no other. */
  answered: Row;
  /** The statements the owner issues beneath the pass-through call, in order. */
  statements: Step[];
  /** Which synthetic secrets the resolution decrypts, by label, sorted. */
  decrypted: string[];
  /** What the action returns: these keys and no other. */
  returned: Row;
  /** The `meta` of the audit row the action writes after the owner returns; null when it refuses first. */
  audited: Row | null;
}

let authSecret = "";
/** The one request in flight; null between requests. */
let inFlight: Flight | null = null;
/** The synthetic provider the responder answers from; null until a world seeds one. */
let synthetic: Provider | null = null;
/** The synthetic secrets of the world in play, by label. */
let markers: Record<string, string> = {};

/** Every seam whose own call log is read back per request. */
const SEAMS = {
  revalidatePath: h.revalidatePath,
  reconcileProviderState: h.reconcileProviderState,
  decryptSecret: h.decryptSecret,
  fetch: h.fetch,
  headers: h.headers,
};

/** The request a seam was reached in. None of them has a caller between requests. */
function flightOf(seam: string): Flight {
  const flight = inFlight;
  if (!flight) throw new Error(`${FIXTURE} ${seam} was reached with no request in flight`);
  return flight;
}

const clientOf = (client: unknown): string =>
  h.adminDb !== null && client === h.adminDb ? REQUEST_SERVICE_CLIENT : SOME_OTHER_CLIENT;

function realOf<K extends keyof typeof h.real>(owner: K): NonNullable<(typeof h.real)[K]> {
  const original = h.real[owner];
  if (!original) throw new Error(`${FIXTURE} the original ${owner} was never captured`);
  return original as NonNullable<(typeof h.real)[K]>;
}

/** Values as one searchable string; never throws on its own account. */
function searchable(text: string, values: unknown[]): string {
  try {
    return `${text} ${JSON.stringify(values)}`;
  } catch {
    return `${text} ${values.map((value) => String(value)).join(" ")}`;
  }
}

// ── the synthetic provider ───────────────────────────────────────────────────────────────────────

/** Records the refusal for the request's own assertion, and throws it into whoever called `fetch`. */
function violation(flight: Flight, what: string): never {
  flight.violations.push(what);
  flight.trace.push({ step: "transport-violation", what });
  throw new Error(`${TRANSPORT} ${what}`);
}

/** Everything a request carries — URL, headers and body — as one string to search. Never recorded. */
function carried(input: unknown, init: RequestInit | undefined): string {
  const url =
    typeof input === "string" ? input : input instanceof URL ? input.href : input instanceof Request ? input.url : "";
  const headers = [...new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined)).entries()];
  return searchable(url, [headers, init?.body == null ? null : String(init.body)]);
}

/** The deterministic answer to each of the three reads, in the shape linear.ts:116-193 reads. */
function answer(board: Provider, operation: string): Row {
  if (operation === "ProjectionBootstrap") {
    return { team: { key: "SYN", states: { nodes: SYNTHETIC_STATES }, labels: { nodes: [] } } };
  }
  if (operation === "ProjectionMembers") {
    return { team: { members: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] } } };
  }
  return { team: { issues: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: board.issues } } };
}

/**
 * SEAM provider. Answers one of the three state reads for the board's own Linear team and records
 * its operation and variables; refuses everything else. It never calls a real `fetch`.
 */
function respond(flight: Flight, input: unknown, init: RequestInit | undefined): Response {
  const board = synthetic;
  if (!board) return violation(flight, "a request arrived with no synthetic provider seeded");
  const said = carried(input, init);
  for (const [label, value] of Object.entries(board.forbidden)) {
    if (said.includes(value)) return violation(flight, `a request carried ${label}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(init?.body == null ? "" : String(init.body));
  } catch {
    return violation(flight, "a request whose body is not JSON");
  }
  const envelope = parsed !== null && typeof parsed === "object" ? (parsed as Row) : {};
  const query = typeof envelope.query === "string" ? envelope.query : "";
  const named = /^\s*(query|mutation|subscription)\s+(\w+)/.exec(query);
  if (/\bmutation\b/i.test(query)) {
    return violation(flight, `a provider mutation was sent: ${named?.[2] ?? "unnamed"}`);
  }
  const operation = named?.[1] === "query" ? named[2] : "";
  if (!READS.includes(operation)) {
    return violation(flight, `a request that is not one of the three state reads: ${operation || "unnamed"}`);
  }
  const variables =
    envelope.variables !== null && typeof envelope.variables === "object" ? (envelope.variables as Row) : null;
  if (variables?.teamId !== board.linearTeam) {
    return violation(flight, `${operation} for a Linear team this file does not answer for`);
  }

  flight.trace.push({ step: "transport", operation, variables });
  return Response.json({ data: answer(board, operation) });
}

beforeEach(() => {
  authSecret = randomBytes(32).toString("hex");
  vi.stubEnv("AUTH_SECRET", authSecret);
  // The synthetic secrets are encrypted and decrypted under a key no deployment holds.
  vi.stubEnv("SECRETS_KEY", randomBytes(32).toString("base64"));
  vi.stubGlobal("fetch", h.fetch);
  inFlight = null;
  synthetic = null;
  markers = {};
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

  h.reconcileProviderState.mockReset();
  h.reconcileProviderState.mockImplementation(async (...args: Parameters<Reconcile["reconcileProviderState"]>) => {
    const [client, teamId, opts] = args;
    const flight = flightOf(OWNER);
    const step: Step = {
      step: "lower",
      owner: OWNER,
      client: clientOf(client),
      args: { teamId, opts: opts ?? null },
      answered: UNSETTLED,
    };
    flight.trace.push(step);
    const answered = await realOf("reconcileProviderState")(...args);
    step.answered = answered;
    // Whatever the action does next comes after this entry.
    flight.trace.push({ step: "returned", owner: OWNER });
    return answered;
  });

  h.decryptSecret.mockReset();
  h.decryptSecret.mockImplementation((...args: Parameters<Crypto["decryptSecret"]>) => {
    const plaintext = realOf("decryptSecret")(...args);
    // Only WHICH synthetic secret came back, by label: neither the ciphertext nor the value is recorded.
    const yielded = Object.entries(markers).find(([, value]) => value === plaintext)?.[0] ?? UNKNOWN_SECRET;
    inFlight?.trace.push({ step: "decrypt", yielded });
    return plaintext;
  });

  h.fetch.mockReset();
  h.fetch.mockImplementation(async (input: unknown, init?: RequestInit) => respond(flightOf("fetch"), input, init));

  h.headers.mockReset();
  h.headers.mockImplementation(() => {
    flightOf("headers()").trace.push({ step: "tripwire", name: "headers" });
    throw new Error(`${FIXTURE} headers() was read`);
  });
});

afterEach(() => {
  inFlight = null;
  synthetic = null;
  markers = {};
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

/** Rows in the order of their ids as strings: the one order an expectation with matchers can share. */
const byId = (rows: Row[]): Row[] => [...rows].sort((left, right) => String(left.id).localeCompare(String(right.id)));

// The guard's tables, the tables the action and its lower path read or write, and the run table it does not.
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

/** The rows a request added and removed, per table, by id; a changed row is one of each. Empty when none. */
function changes(before: Durable, after: Durable): Changed {
  const changed: Changed = {};
  for (const table of DURABLE_TABLES) {
    const was = new Set(before[table].map((row) => JSON.stringify(row)));
    const is = new Set(after[table].map((row) => JSON.stringify(row)));
    const added = after[table].filter((row) => !was.has(JSON.stringify(row)));
    const removed = before[table].filter((row) => !is.has(JSON.stringify(row)));
    if (added.length > 0 || removed.length > 0) changed[table] = { added: byId(added), removed: byId(removed) };
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

/** SETUP WRITE: the one project the board's tasks and links belong to. */
async function seedProject(board: Board): Promise<void> {
  const { id } = await fxOne<{ id: string }>(
    "project insert",
    `insert into projects(team_id, slug, name) values($1, $2, $3) returning id`,
    [board.team.teamId, `aio1217-rcn-${randomUUID().slice(0, 8)}`, "AIO1217 reconcile synthetic project"],
  );
  board.projectIds.push(id);
}

/** SETUP WRITE: the team names `provider` as its primary PM provider, read back from the pool. */
async function namePrimary(team: Seed, provider: PmKind = PROVIDER): Promise<void> {
  const named = await fxOne<{ provider: string | null }>(
    "primary provider update",
    `update teams set primary_pm_provider = $2 where id = $1 returning primary_pm_provider::text as provider`,
    [team.teamId, provider],
  );
  premise("the team names the primary PM provider it was given", named.provider, provider);
}

/** The primary PM provider a team names, read back from the pool; null when it names none. */
const primaryOf = async (team: Seed): Promise<string | null> =>
  (
    await fxOne<{ provider: string | null }>(
      "primary provider readback",
      `select primary_pm_provider::text as provider from teams where id = $1`,
      [team.teamId],
    )
  ).provider;

/** A random marker for an integration secret: in no provider's key format, and no account's key. */
const syntheticSecret = (tag: string): string => `aio1217-synthetic-not-a-provider-key-${tag}-${randomUUID()}`;

/** An invented provider resource id: it names no issue and no work item anywhere. */
const syntheticResource = (name: string): string => `aio1217-syn-issue-${name}-${randomUUID().slice(0, 8)}`;

/** The invented Plane workspace and project of a board's team: ids that name nothing, and no URL. */
const planeConfigOf = (board: Board): Row => ({
  workspaceSlug: board.linearTeam.replace("linear-team", "plane-workspace"),
  projectId: board.linearTeam.replace("linear-team", "plane-project"),
});

/**
 * SETUP WRITE, through the table's own writers as the existing native reconcile file does: one
 * ENABLED `type` integration of the board's team configured with its invented Linear team id (or
 * its invented Plane workspace and project), then its synthetic secret, encrypted by the real
 * `encryptSecret` under this test's SECRETS_KEY. Read back: the stored ciphertext decrypts, under
 * the real `decryptSecret`, to that secret. Answers the row's id.
 */
async function seedIntegration(board: Board, creator: Cast, secret: string, type: PmKind = PROVIDER): Promise<string> {
  const auth = { teamId: board.team.teamId, memberId: creator.memberId };
  const { id } = await upsertIntegration(db(), auth, {
    type,
    name: `aio1217-synthetic-${type}`,
    config: type === "linear" ? { teamId: board.linearTeam } : planeConfigOf(board),
  });
  await setIntegrationSecret(db(), auth, id, secret);
  board.integrationIds.push(id);
  const stored = await fxOne<{ secret_ciphertext: string | null }>(
    "ciphertext readback",
    `select secret_ciphertext from integrations where id = $1 and team_id = $2`,
    [id, board.team.teamId],
  );
  premise(
    `${creator.label}'s team stores a ciphertext that is not its secret and decrypts to it`,
    [
      stored.secret_ciphertext !== null && stored.secret_ciphertext !== secret,
      stored.secret_ciphertext !== null && realOf("decryptSecret")(stored.secret_ciphertext) === secret,
    ],
    [true, true],
  );
  return id;
}

/** How one integration row stands, read back from the pool by the statement that rearranged it. */
const STANDING = `returning status::text as status, (secret_ciphertext is not null) as has_ciphertext`;

/** SETUP WRITE, raw SQL: the row leaves `enabled` and keeps its ciphertext. Read back. */
async function disableIntegration(board: Board, id: string): Promise<void> {
  premise(
    "the integration is disabled and still holds its ciphertext",
    await fxOne(
      "integration disable",
      `update integrations set status = 'disabled' where id = $1 and team_id = $2 ${STANDING}`,
      [id, board.team.teamId],
    ),
    { status: "disabled", has_ciphertext: true },
  );
}

/** SETUP WRITE, raw SQL: the row stays `enabled` and loses its ciphertext. Read back. */
async function stripSecret(board: Board, id: string): Promise<void> {
  premise(
    "the integration is enabled and holds no ciphertext",
    await fxOne(
      "integration secret removal",
      `update integrations set secret_ciphertext = null where id = $1 and team_id = $2 ${STANDING}`,
      [id, board.team.teamId],
    ),
    { status: "enabled", has_ciphertext: false },
  );
}

/**
 * SETUP WRITE: an enabled `type` integration of the board's team under a fresh synthetic secret,
 * which the decrypt recorder then knows by `label`. Answers the row's id.
 */
async function hold(stage: Stage, board: Board, creator: Cast, label: string, type: PmKind): Promise<string> {
  stage.markers[label] = syntheticSecret(type);
  return seedIntegration(board, creator, stage.markers[label], type);
}

/** One integration row as `integrationsHeld` reads it back. */
const integrationRow = (board: Board, type: PmKind, status: string, hasCiphertext: boolean): Row => ({
  team_id: board.team.teamId,
  type,
  status,
  has_ciphertext: hasCiphertext,
  linear_team: type === "linear" ? board.linearTeam : null,
});

/**
 * Arms the synthetic provider for a stage: it would answer the three state reads for team A's
 * invented Linear team with the listed states, so a pass that did reach it would be served and
 * counted. It still refuses anything carrying team B's secret or Linear team id.
 */
function armBoard(stage: Stage, listed: Array<{ link: Linked; state: string }>): void {
  synthetic = {
    linearTeam: stage.a.linearTeam,
    issues: listed.map(({ link, state }) => ({ id: resourceOf(link), state: stateNamed(state) })),
    forbidden: { [B_SECRET]: stage.markers[B_SECRET], "team B's Linear team id": stage.b.linearTeam },
  };
}

/**
 * SETUP WRITE, raw SQL: one keyed task of the board's project, origin `ui`, and its link — to
 * `PROVIDER` unless `provider` says otherwise. `resourceId` null is a link that was never projected.
 * No provider URL is written, and no seen status: every link starts with `provider_seen_status` null.
 */
async function seedLinked(
  board: Board,
  tag: string,
  placed: { resourceId: string | null; lastProjected: string | null; status: string; provider?: PmKind },
): Promise<Linked> {
  const rowKey = `AIO1217-RCN-${tag}`;
  const task = await fxOne<{ id: string }>(
    "task insert",
    `insert into tasks(team_id, project_id, row_key, title, origin, status)
     values($1, $2, $3, $4, 'ui', $5) returning id`,
    [board.team.teamId, board.projectIds[0], rowKey, `aio1217 synthetic task ${rowKey}`, placed.status],
  );
  const link = await fxOne<{ id: string }>(
    "task link insert",
    `insert into task_pm_links(team_id, project_id, task_id, row_key, provider, provider_external_id,
                               provider_external_source, provider_resource_id, provider_url,
                               last_projected_status, provider_seen_status)
     values($1, $2, $3, $4, $5, $6, 'aios-backlog', $7, '', $8, null) returning id`,
    [
      board.team.teamId,
      board.projectIds[0],
      task.id,
      rowKey,
      placed.provider ?? PROVIDER,
      rowKey,
      placed.resourceId,
      placed.lastProjected,
    ],
  );
  const linked: Linked = { rowKey, taskId: task.id, linkId: link.id, resourceId: placed.resourceId };
  board.links.push(linked);
  return linked;
}

/** Every integration row of any team as the resolution's inputs see it; never a ciphertext value. */
const integrationsHeld = async (): Promise<Row[]> =>
  byContent(
    await fx(
      "integrations readback",
      `select team_id, type::text as type, status::text as status, (secret_ciphertext is not null) as has_ciphertext,
              config->>'teamId' as linear_team
         from integrations`,
    ),
  );

/** Every link of any team as the pass leaves it, by row key. */
const linksHeld = (): Promise<Row[]> =>
  fx(
    "task_pm_links readback",
    `select team_id, row_key, last_projected_status, provider_seen_status from task_pm_links order by row_key`,
  );

/** Every task's brain status, of any team, by row key. */
const tasksHeld = (): Promise<Row[]> =>
  fx("tasks readback", `select team_id, row_key, status::text as status from tasks order by row_key`);

/** Every audit row this action writes, of any team, in the order they were written. */
const reconcileAudits = (): Promise<Row[]> =>
  fx(
    "audit_log readback",
    `select team_id, member_id, action, meta from audit_log where action = $1 order by audit_log.id`,
    [AUDIT_ACTION],
  );

const resourceOf = (link: Linked): string => {
  if (link.resourceId === null) throw new Error(`${FIXTURE} link ${link.rowKey} holds no resource id`);
  return link.resourceId;
};

/**
 * Two teams, each naming `PROVIDER` as its primary, each with one admitted admin and a signed
 * session, one project, and one ENABLED `PROVIDER` integration holding its own synthetic secret and
 * its own invented Linear team id.
 *
 * Team A holds four linked tasks: one the board has moved to `Done` since the brain projected
 * `Backlog`; one the brain and the board both hold `In Progress`; one whose resource id the board
 * does not list; and one never projected (no resource id). Team B holds one linked task whose
 * resource id the SAME board lists as `Done` — a bystander's row, so "team B is unchanged" and "team
 * B's link was not read" are statements about a row a looser read would have rewritten.
 *
 * Read back, before any request: exactly those integration rows; what each asserted read would be
 * answered with as written and WITHOUT its team equality, so each asserted row count is known to
 * discriminate; every link's seen status null; every task's brain status; and no reconcile audit row.
 *
 * `primary: "unset"` leaves team A naming NO primary, so its one enabled PM integration is what the
 * sole-enabled fallback resolves (project.ts:138-141); team B names `PROVIDER` either way.
 */
async function seedWorld(placed: { primary?: "named" | "unset" } = {}): Promise<World> {
  const { a, b, alice, bob } = await seedStage();
  if (placed.primary !== "unset") await namePrimary(a.team);
  await namePrimary(b.team);
  premise(
    "team A names the primary this world was asked for",
    await primaryOf(a.team),
    placed.primary === "unset" ? null : PROVIDER,
  );

  markers = { [A_SECRET]: syntheticSecret("a"), [B_SECRET]: syntheticSecret("b") };
  await seedIntegration(a, alice, markers[A_SECRET]);
  await seedIntegration(b, bob, markers[B_SECRET]);

  const tag = randomUUID().slice(0, 8);
  const issue = (name: string) => `aio1217-syn-issue-${name}-${tag}`;
  const diverged = await seedLinked(a, "A-1", { resourceId: issue("a1"), lastProjected: "Backlog", status: "backlog" });
  const inSync = await seedLinked(a, "A-2", {
    resourceId: issue("a2"),
    lastProjected: "In Progress",
    status: "in_progress",
  });
  const unanswered = await seedLinked(a, "A-3", { resourceId: issue("a3"), lastProjected: "Todo", status: "ready" });
  const unprojected = await seedLinked(a, "A-4", { resourceId: null, lastProjected: null, status: "backlog" });
  const foreign = await seedLinked(b, "B-1", { resourceId: issue("b1"), lastProjected: "Backlog", status: "backlog" });

  const provider: Provider = {
    linearTeam: a.linearTeam,
    issues: [
      { id: resourceOf(diverged), state: stateNamed("Done") },
      { id: resourceOf(inSync), state: stateNamed("In Progress") },
      // Team B's resource id, on team A's board: answered to any link read that reaches team B's row.
      { id: resourceOf(foreign), state: stateNamed("Done") },
    ],
    forbidden: { [B_SECRET]: markers[B_SECRET], "team B's Linear team id": b.linearTeam },
  };
  synthetic = provider;

  const world: World = { a, b, alice, bob, diverged, inSync, unanswered, unprojected, foreign, markers, provider };

  premise("exactly the two seeded integration rows exist", await integrationsHeld(), integrationsOf(world));
  premise(
    "what the integrations read and the link read are answered with as written, and without their team equality",
    {
      integrations: await countOf(
        "scoped integrations read",
        `select count(*)::int as n from integrations where team_id = $1 and status = 'enabled'`,
        [a.team.teamId],
      ),
      integrationsWithoutTeam: await countOf(
        "status-only integrations read",
        `select count(*)::int as n from integrations where status = 'enabled'`,
      ),
      links: await countOf(
        "scoped link read",
        `select count(*)::int as n from task_pm_links
          where team_id = $1 and provider = $2 and provider_resource_id is not null`,
        [a.team.teamId, PROVIDER],
      ),
      linksWithoutTeam: await countOf(
        "provider-only link read",
        `select count(*)::int as n from task_pm_links where provider = $1 and provider_resource_id is not null`,
        [PROVIDER],
      ),
      linksWithoutResourceFilter: await countOf(
        "unfiltered link read",
        `select count(*)::int as n from task_pm_links where team_id = $1 and provider = $2`,
        [a.team.teamId, PROVIDER],
      ),
    },
    // Team B's enabled row and team B's link are each one more; the unprojected link is one more.
    { integrations: 1, integrationsWithoutTeam: 2, links: 3, linksWithoutTeam: 4, linksWithoutResourceFilter: 4 },
  );
  premise("every link starts with no seen status", await linksHeld(), linksAfter(world, {}));
  premise("every task holds the brain status it was given", await tasksHeld(), tasksOf(world));
  premise("no reconcile audit row exists", await reconcileAudits(), []);
  return world;
}

/**
 * Two teams, each with one admitted admin and a signed session and one project — and no primary
 * named, no integration, no link and no synthetic secret yet. The secrets a case then encrypts go
 * into `markers`, the object the decrypt recorder reads its labels from.
 */
async function seedStage(): Promise<Stage> {
  premise(
    "integrations starts empty",
    await countOf("integrations readback", `select count(*)::int as n from integrations`),
    0,
  );

  const tag = randomUUID().slice(0, 8);
  const a: Board = {
    team: await seedTeam(),
    projectIds: [],
    integrationIds: [],
    links: [],
    linearTeam: `aio1217-syn-linear-team-a-${tag}`,
  };
  const b: Board = {
    team: await seedTeam(),
    projectIds: [],
    integrationIds: [],
    links: [],
    linearTeam: `aio1217-syn-linear-team-b-${tag}`,
  };
  premise("the two teams are distinct", [a.team.teamId === b.team.teamId, a.team.teamSlug === b.team.teamSlug], [
    false,
    false,
  ]);
  const alice = await seedCast(a.team, "alice");
  const bob = await seedCast(b.team, "bob");
  await seedProject(a);
  await seedProject(b);
  markers = {};
  return { a, b, alice, bob, markers };
}

/** The integration rows a world holds: each team's one enabled, ciphertext-bearing `PROVIDER` row. */
const integrationsOf = (world: Pick<World, "a" | "b">): Row[] =>
  byContent(
    [world.a, world.b].map((board) => ({
      team_id: board.team.teamId,
      type: PROVIDER,
      status: "enabled",
      has_ciphertext: true,
      linear_team: board.linearTeam,
    })),
  );

/** Every link as the pool reads it back, given the seen status each named row key now holds. */
function linksAfter(world: World, seen: Record<string, string>): Row[] {
  const row = (board: Board, link: Linked, lastProjected: string | null): Row => ({
    team_id: board.team.teamId,
    row_key: link.rowKey,
    last_projected_status: lastProjected,
    provider_seen_status: seen[link.rowKey] ?? null,
  });
  return [
    row(world.a, world.diverged, "Backlog"),
    row(world.a, world.inSync, "In Progress"),
    row(world.a, world.unanswered, "Todo"),
    row(world.a, world.unprojected, null),
    row(world.b, world.foreign, "Backlog"),
  ];
}

/** Every task's brain status as seeded: what a pass must leave exactly as it is. */
function tasksOf(world: World): Row[] {
  const row = (board: Board, link: Linked, status: string): Row => ({
    team_id: board.team.teamId,
    row_key: link.rowKey,
    status,
  });
  return [
    row(world.a, world.diverged, "backlog"),
    row(world.a, world.inSync, "in_progress"),
    row(world.a, world.unanswered, "ready"),
    row(world.a, world.unprojected, "backlog"),
    row(world.b, world.foreign, "backlog"),
  ];
}

/** Every identifier one team's fixture rows carry, by a label that names it. */
function identifiersOf(name: string, board: Board, cast: Cast): Record<string, string> {
  const named: Record<string, string> = {
    [`team ${name} id`]: board.team.teamId,
    [`team ${name} slug`]: board.team.teamSlug,
    [`team ${name} seeded member`]: board.team.memberId,
    [`team ${name} Linear team id`]: board.linearTeam,
    [`${cast.label}'s member row`]: cast.memberId,
    [`${cast.label}'s auth user`]: cast.user.id,
  };
  board.projectIds.forEach((id, at) => {
    named[`team ${name} project ${at + 1}`] = id;
  });
  board.integrationIds.forEach((id, at) => {
    named[`team ${name} integration ${at + 1}`] = id;
  });
  board.links.forEach((link, at) => {
    named[`team ${name} task ${at + 1}`] = link.taskId;
    named[`team ${name} link ${at + 1}`] = link.linkId;
    if (link.resourceId !== null) named[`team ${name} resource ${at + 1}`] = link.resourceId;
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
 * A write is identified by its head; an UPDATE's SET terms are not its clause. Anything else carries
 * no table here.
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
 * request but the rows in Postgres and the synthetic board.
 */
async function request(session: string | null, action: () => Promise<unknown>): Promise<Seen> {
  const jar = new Map<string, string>();
  if (session !== null) jar.set(SESSION_COOKIE, session);
  const flight: Flight = { jar, trace: [], refused: [], bound: [], violations: [] };
  let acquired = { server: 0, admin: 0 };
  let seams: Record<string, number> = {};
  let revalidated: unknown[][] = [];

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
    outcome = await settle(action);
  } finally {
    acquired = { server: h.acquired.server, admin: h.acquired.admin };
    seams = seamCalls();
    revalidated = h.revalidatePath.mock.calls.map((call) => [...call]);
    inFlight = null;
    h.trace = null;
    h.adminDb = null;
    h.serverDb = null;
  }
  const after = await durable();

  // The owner reads no `error` off its link statements and the audit writer swallows a failed insert.
  premise("no statement the request issued was refused by Postgres", flight.refused, []);
  // Not a premise: an unexpected request or a mutation reaching the provider is the failure itself.
  expect(flight.violations, TRANSPORT).toEqual([]);

  const returned = "returned" in outcome ? outcome.returned : null;
  return {
    outcome,
    shape: returned !== null && typeof returned === "object" ? Object.keys(returned).sort() : null,
    before,
    after,
    trace: flight.trace,
    acquired,
    seams,
    revalidated,
    bound: flight.bound,
  };
}

/** One request as every case compares it. */
const observed = (seen: Seen) => ({
  outcome: seen.outcome,
  shape: seen.shape,
  acquired: seen.acquired,
  seams: seen.seams,
  revalidated: seen.revalidated,
  changed: changes(seen.before, seen.after),
});

/** The labels of the given identifiers that any statement of the request carried, sorted. */
const boundOf = (seen: Seen, identifiers: Record<string, string>): string[] =>
  Object.entries(identifiers)
    .filter(([, value]) => seen.bound.some((statement) => statement.includes(value)))
    .map(([label]) => label)
    .sort();

/**
 * The labels of the world's synthetic secrets found in what the call settled with, its trace, its
 * statements or any durable row it left, sorted. The stored ciphertexts are in those rows; a
 * plaintext is not.
 */
function surfaced(seen: Seen, world: Pick<World, "markers">): string[] {
  const said = searchable("", [seen.outcome, seen.trace, seen.bound, seen.after]);
  return Object.entries(world.markers)
    .filter(([, value]) => said.includes(value))
    .map(([label]) => label)
    .sort();
}

/**
 * The key list of what the real owner answered each pass-through call with. A key list, because
 * `toEqual` reads a key holding `undefined` as absent: a marker set on every return would show here.
 */
const answeredKeys = (seen: Seen): string[][] =>
  seen.trace.filter((step) => step.step === "lower").map((step) => Object.keys(step.answered as Row).sort());

/** Which synthetic secrets a request decrypted, by label, sorted. */
const decryptedBy = (seen: Seen): string[] =>
  seen.trace
    .filter((step) => step.step === "decrypt")
    .map((step) => String(step.yielded))
    .sort();

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
 * to state, and which link it named is `rewrites`'). No read is set aside.
 */
const ledger = (seen: Seen, guardSteps: number): Step[] =>
  seen.trace
    .slice(guardSteps)
    .map((step) =>
      step.step === "statement" && step.op !== "select"
        ? { step: "write", via: step.via, op: step.op, table: step.table }
        : step,
    );

const wrote = (op: string, table: string): Step => ({ step: "write", via: "admin", op, table });

/** One state read as the responder recorded it: the operation and the variables it was sent with. */
const read = (operation: string, variables: Row): Step => ({ step: "transport", operation, variables });

/** The three reads one `fetchSeenStates` owes, in order, each naming the board's own Linear team. */
const stateReads = (board: Provider): Step[] => [
  read("ProjectionBootstrap", { teamId: board.linearTeam }),
  read("ProjectionMembers", { teamId: board.linearTeam, after: null }),
  read("ProjectionIssues", { teamId: board.linearTeam, after: null }),
];

/** Every provider read of a request, in order. */
const readsOf = (seen: Seen): Step[] => seen.trace.filter((step) => step.step === "transport");

/**
 * The resolution's two statements, in the order lib/pm-sync/project.ts:124-125 issues them: the
 * team's ENABLED integrations — answered with `enabledRows` — then the team's primary.
 */
const resolution = (team: Seed, enabledRows: number): Step[] => [
  statement("admin", "integrations", { team_id: team.teamId, status: "enabled" }, enabledRows),
  statement("admin", "teams", { id: team.teamId }, 1),
];

/** The owner's link read (lib/pm-sync/reconcile.ts:99-104): by team and provider, resource id not null. */
const linkRead = (team: Seed, provider: PmKind, rows: number): Step =>
  statement("admin", "task_pm_links", { team_id: team.teamId, provider }, rows);

/** The link each `task_pm_links` update named and the row count Postgres answered, by link id. */
const rewrites = (seen: Seen): Row[] =>
  byId(
    seen.trace
      .filter((step) => step.step === "statement" && step.op === "update" && step.table === "task_pm_links")
      .map((step) => ({ ...(step.where as Row), rows: step.rows })),
  );

// ── what a request leaves behind ─────────────────────────────────────────────────────────────────

/** The whole `audit_log` row the action writes for a pass: every column the table has. */
const auditRow = (who: Cast, meta: Row): Row => ({
  id: expect.any(Number),
  team_id: who.team.teamId,
  actor_kind: "member",
  member_id: who.memberId,
  api_key_id: null,
  action: AUDIT_ACTION,
  target_type: "team",
  target_id: who.team.teamId,
  meta,
  ip: null,
  created_at: expect.any(String),
});

/** A link's whole row as the pool held it immediately before the request. */
function heldLink(seen: Seen, link: Linked): Row {
  const row = seen.before.task_pm_links.find((held) => held.id === link.linkId);
  if (!row) throw new Error(`${FIXTURE} link ${link.rowKey} was not held before the request`);
  return row;
}

/** The one divergence the seeded board holds against team A's brain. */
const divergenceOf = (world: World): Row => ({
  row_key: world.diverged.rowKey,
  provider: PROVIDER,
  last_projected_status: "Backlog",
  provider_seen_status: "Done",
});

/** The first pass over the seeded board: two seen statuses recorded, one of them a divergence. */
const firstPass = (world: World): Pass => ({
  rewritten: [
    { link: world.diverged, state: "Done" },
    { link: world.inSync, state: "In Progress" },
  ],
  divergences: [divergenceOf(world)],
});

/** Any later pass over the same board: nothing to record, the divergence still surfaced. */
const laterPass = (world: World): Pass => ({ rewritten: [], divergences: [divergenceOf(world)] });

/**
 * A new invocation under Alice's session for team A: admitted by the guard's real reads; the service
 * client; the real owner handed the server-resolved team and no options; beneath it the integrations
 * read bound to team A and `enabled`, ONE decrypt yielding team A's synthetic secret, team A's
 * primary, and the link read bound to team A and `linear`; three provider reads naming team A's
 * configured Linear team and nothing else; one update per link whose seen status differs; the
 * owner's return; then — and only then — one stored audit row and one revalidation asked of the
 * seam; and the action's `ok: true` return. No task statement, no run, no secret anywhere, no
 * identifier of team B bound by any statement, and every row team B holds as it was.
 */
async function admit(world: World, label: string, pass: Pass): Promise<Seen> {
  const who = world.alice;
  const team = world.a.team;
  const guard = guardChain(who, await groupRows(who));
  const path = `/t/${team.teamSlug}/admin/pm-sync`;
  const settled = { provider: PROVIDER, seenUpdated: pass.rewritten.length, divergences: pass.divergences };

  const seen = await request(who.session, () => reconcileDivergenceAction(team.teamSlug));

  const bystander = heldBy(seen.before, world.b.team);
  premise(
    `${label}: team B held its team row, its project, its task, its link and its enabled integration before the request`,
    [
      bystander.teams.length,
      bystander.projects.length,
      bystander.tasks.length,
      bystander.task_pm_links.length,
      bystander.integrations.length,
    ],
    [1, 1, 1, 1, 1],
  );

  expect(
    {
      ...observed(seen),
      guard: seen.trace.slice(0, guard.length),
      ledger: ledger(seen, guard.length),
      answeredKeys: answeredKeys(seen),
      rewrites: rewrites(seen),
      foreign: boundOf(seen, identifiersOf("B", world.b, world.bob)),
      surfaced: surfaced(seen, world),
      bystander: heldBy(seen.after, world.b.team),
    },
    label,
  ).toEqual({
    outcome: { returned: { ok: true, ...settled } },
    shape: RECONCILED_KEYS,
    // A pass that ran is unmarked: no `reason` and no `notRunReason` key, not even holding undefined.
    answeredKeys: [RESOLVED_KEYS],
    acquired: { server: 1, admin: 1 },
    // One decrypt although two ciphertexts are stored; three reads; no `headers`.
    seams: { reconcileProviderState: 1, decryptSecret: 1, fetch: READS.length, revalidatePath: 1 },
    // The literal path alone, with no `type` argument.
    revalidated: [[path]],
    // No `tasks`, `integrations`, `teams` or `ingest_runs` key: nothing else was added, removed or changed.
    changed: {
      ...(pass.rewritten.length > 0
        ? {
            task_pm_links: {
              added: byId(
                pass.rewritten.map(({ link, state }) => ({
                  ...heldLink(seen, link),
                  provider_seen_status: state,
                  updated_at: expect.any(String),
                })),
              ),
              removed: byId(pass.rewritten.map(({ link }) => heldLink(seen, link))),
            },
          }
        : {}),
      audit_log: {
        added: [
          auditRow(who, {
            provider: PROVIDER,
            seenUpdated: pass.rewritten.length,
            divergences: pass.divergences.length,
          }),
        ],
        removed: [],
      },
    },
    guard,
    ledger: [
      SERVICE_CLIENT,
      // actions.ts:92 — the server-resolved team, and no third argument: global `fetch` is the transport.
      {
        step: "lower",
        owner: OWNER,
        client: REQUEST_SERVICE_CLIENT,
        args: { teamId: team.teamId, opts: null },
        answered: settled,
      },
      // lib/integrations/manage.ts:258-262, by team A and `enabled`, answered with team A's own row only.
      statement("admin", "integrations", { team_id: team.teamId, status: "enabled" }, 1),
      { step: "decrypt", yielded: A_SECRET },
      // lib/pm-sync/project.ts:125, the team's primary.
      statement("admin", "teams", { id: team.teamId }, 1),
      // lib/pm-sync/reconcile.ts:99-104: team A's three links holding a resource id; never team B's.
      statement("admin", "task_pm_links", { team_id: team.teamId, provider: PROVIDER }, 3),
      ...stateReads(world.provider),
      // The order the unordered link read answered in is not asserted: `rewrites` holds the set.
      ...pass.rewritten.map(() => wrote("update", "task_pm_links")),
      { step: "returned", owner: OWNER },
      wrote("insert", "audit_log"),
      // SEAM revalidate: the path the action asked for, built from the slug it was handed.
      { step: "revalidate", path },
    ],
    rewrites: byId(pass.rewritten.map(({ link }) => ({ id: link.linkId, rows: 1 }))),
    foreign: [],
    surfaced: [],
    bystander,
  });
  return seen;
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
 * A new invocation the gate must REFUSE, with a valid slug, the synthetic board armed to answer and
 * every lower owner live: the action's own `admins only`; the guard's reads and nothing after them;
 * no service client, so no integration or link read and nothing handed down; no pass-through call;
 * no decrypt; no provider read; no revalidation; no tripwire; and an empty durable difference over
 * every table of both teams.
 */
async function refuse(label: string, refusal: Refusal): Promise<Seen> {
  const seen = await request(refusal.session, () => reconcileDivergenceAction(refusal.slug));
  expect({ ...observed(seen), trace: seen.trace }, label).toEqual({
    outcome: { returned: ADMINS_ONLY },
    shape: REFUSED_KEYS,
    acquired: { server: refusal.server, admin: 0 },
    seams: {},
    revalidated: [],
    changed: {},
    trace: refusal.guard,
  });
  return seen;
}

/**
 * A new invocation under Alice's session for team A that the gate ADMITS and whose pass never
 * reaches the provider: the guard's real reads; the service client; the real owner handed the
 * server-resolved team and no options; beneath it exactly `late.statements`, each bound to team A,
 * and the named decrypts; the owner's answer with exactly its keys; then EITHER the one audit row
 * and the one revalidation (`late.audited`) OR nothing at all — no statement, no write, no
 * revalidation — before the return. No provider request, no `tasks` statement, no run, no secret
 * anywhere, no identifier of team B bound by any statement, and no durable difference in any table
 * of either team but that audit row.
 */
async function reach(stage: Stage, label: string, late: Late): Promise<Seen> {
  const who = stage.alice;
  const team = stage.a.team;
  const guard = guardChain(who, await groupRows(who));
  const path = `/t/${team.teamSlug}/admin/pm-sync`;

  const seen = await request(who.session, () => reconcileDivergenceAction(team.teamSlug));

  expect(
    {
      ...observed(seen),
      guard: seen.trace.slice(0, guard.length),
      // The decrypts are `decrypted`'s: two enabled rows are answered in no asserted order.
      ledger: ledger(seen, guard.length).filter((step) => step.step !== "decrypt"),
      answeredKeys: answeredKeys(seen),
      decrypted: decryptedBy(seen),
      foreign: boundOf(seen, identifiersOf("B", stage.b, stage.bob)),
      surfaced: surfaced(seen, stage),
    },
    label,
  ).toEqual({
    outcome: { returned: late.returned },
    shape: Object.keys(late.returned).sort(),
    acquired: { server: 1, admin: 1 },
    // No `fetch` and no `headers`: nothing is asked of the provider, though the board is armed to answer.
    seams: {
      reconcileProviderState: 1,
      ...(late.decrypted.length > 0 ? { decryptSecret: late.decrypted.length } : {}),
      ...(late.audited ? { revalidatePath: 1 } : {}),
    },
    revalidated: late.audited ? [[path]] : [],
    // No `task_pm_links`, `tasks`, `integrations`, `teams` or `ingest_runs` key on any of these branches.
    changed: late.audited ? { audit_log: { added: [auditRow(who, late.audited)], removed: [] } } : {},
    guard,
    ledger: [
      SERVICE_CLIENT,
      {
        step: "lower",
        owner: OWNER,
        client: REQUEST_SERVICE_CLIENT,
        args: { teamId: team.teamId, opts: null },
        answered: late.answered,
      },
      ...late.statements,
      { step: "returned", owner: OWNER },
      // Only an outcome the action reports as a success is followed by anything.
      ...(late.audited ? [wrote("insert", "audit_log"), { step: "revalidate", path }] : []),
    ],
    answeredKeys: [Object.keys(late.answered).sort()],
    decrypted: late.decrypted,
    foreign: [],
    surfaced: [],
  });
  return seen;
}

/**
 * A stage on which each team holds a usable `plane` integration — team A's the only PM integration
 * it has, named as its primary or left to the sole-enabled fallback — with, if asked, two `plane`
 * links of team A holding a resource id; and what the owner and the action owe it today:
 * `planeAdapter` has no `fetchSeenStates`, so the owner answers its unsupported reason UNMARKED
 * before the link read, and the action drops that reason, audits and revalidates.
 */
async function planeUnsupported(placed: { primary: "named" | "unset"; linked: boolean }): Promise<{
  stage: Stage;
  late: Late;
}> {
  const stage = await seedStage();
  const { a, b, alice, bob } = stage;
  if (placed.primary === "named") await namePrimary(a.team, "plane");
  await namePrimary(b.team, "plane");
  await hold(stage, a, alice, A_SECRET, "plane");
  await hold(stage, b, bob, B_SECRET, "plane");
  if (placed.linked) {
    for (const tag of ["A-1", "A-2"]) {
      await seedLinked(a, tag, {
        resourceId: syntheticResource(tag.toLowerCase()),
        lastProjected: "Backlog",
        status: "backlog",
        provider: "plane",
      });
    }
  }
  armBoard(stage, []);

  premise(
    "each team holds one enabled, ciphertext-bearing `plane` row and nothing else",
    await integrationsHeld(),
    byContent([integrationRow(a, "plane", "enabled", true), integrationRow(b, "plane", "enabled", true)]),
  );
  premise(
    "team A names the primary this stage was asked for, and holds the eligible `plane` links it was asked for",
    [
      await primaryOf(a.team),
      await countOf(
        "scoped link read",
        `select count(*)::int as n from task_pm_links
          where team_id = $1 and provider = $2 and provider_resource_id is not null`,
        [a.team.teamId, "plane"],
      ),
    ],
    [placed.primary === "named" ? "plane" : null, placed.linked ? 2 : 0],
  );

  return {
    stage,
    late: {
      answered: { provider: "plane", seenUpdated: 0, divergences: [], reason: "plane has no inbound reconcile support" },
      // The resolution alone: the owner returns before the link read, links or no links.
      statements: resolution(a.team, 1),
      decrypted: [A_SECRET],
      returned: { ok: true, provider: "plane", seenUpdated: 0, divergences: [] },
      audited: { provider: "plane", seenUpdated: 0, divergences: 0 },
    },
  };
}

/** The reconcile audit rows of team A's admitted admin, as `reconcileAudits` reads them back, one per `meta`. */
const auditsOf = (stage: Stage, metas: Row[]): Row[] =>
  metas.map((meta) => ({
    team_id: stage.a.team.teamId,
    member_id: stage.alice.memberId,
    action: AUDIT_ACTION,
    meta,
  }));

describe("AIO-1217 real PM admin action — app/t/[team]/admin/pm-sync/actions.ts#reconcileDivergenceAction over real Postgres, real guard and real reconcileProviderState, primary PM provider `linear` with an enabled integration holding a decryptable synthetic secret (direct calls; cookies, revalidatePath, transport recording, pass-through observation, the decrypt recorder, the synthetic read-only provider responder and a tripwire are the only seams)", () => {
  it(
    "1 — team A and team B each name `linear` and hold an ENABLED `linear` integration with its own synthetic secret and Linear team id; the synthetic board lists two of team A's three projected resources and team B's one: `reconcileDivergenceAction(<team A's slug>)` by team A's admitted admin is admitted by the guard's real reads; hands the real `reconcileProviderState` the server-resolved team and no options; the real resolution reads `integrations` bound to team A's id and `status = enabled` — answered with ONE row where two are enabled — decrypts ONE secret, team A's, and reads team A's primary; the link read is bound to team A's id and `linear` and answered with THREE rows where four hold a resource id; exactly three read-only queries reach the provider, each naming team A's configured Linear team, and no mutation; `provider_seen_status` is recorded on the two answered links by id (`Done`, `In Progress`); the owner answers `{ provider: \"linear\", seenUpdated: 2, divergences: [<the Backlog → Done row>] }`; and only after it returns the action writes one `team.reconcile_divergence` audit row (team A, the server-resolved member, `meta` of the provider, `seenUpdated: 2`, `divergences: 1`), asks one revalidation of `/t/<slug>/admin/pm-sync` and returns `{ ok: true, … }` — every brain task status as it was, no `tasks` statement, no run, neither secret in the return, the trace, a statement or a durable row, no statement binding a team B identifier, and every row team B holds unchanged although the board reads its resource as `Done`",
    async () => {
      const world = await seedWorld();

      await admit(world, "Alice on team A, first pass", firstPass(world));

      expect(await linksHeld()).toEqual(
        linksAfter(world, { [world.diverged.rowKey]: "Done", [world.inSync.rowKey]: "In Progress" }),
      );
      expect(await tasksHeld()).toEqual(tasksOf(world));
      expect(await reconcileAudits()).toEqual([
        {
          team_id: world.a.team.teamId,
          member_id: world.alice.memberId,
          action: AUDIT_ACTION,
          meta: { provider: PROVIDER, seenUpdated: 2, divergences: 1 },
        },
      ]);
      expect(await integrationsHeld()).toEqual(integrationsOf(world));
    },
    ROOMY,
  );

  it(
    "2 — idempotent rerun, with the synthetic board as the explicit provider read control: after the first pass of case 1, the SAME call under the same session over the UNCHANGED board is admitted again, resolves and decrypts as before, reads the same three links, and is served the IDENTICAL three provider reads — so its zero is an answer to a board that was read, not a pass that did not look — and the owner answers `seenUpdated: 0` with the same one divergence: no `task_pm_links` update is issued, no link row differs (`updated_at` included), no brain task status differs, team B's rows are unchanged, and the only durable difference is the second audit row, whose `meta` reads `seenUpdated: 0`, `divergences: 1`, followed by the second revalidation",
    async () => {
      const world = await seedWorld();
      const board = JSON.stringify(world.provider);

      const first = await admit(world, `${CONTROL} Alice on team A, first pass`, firstPass(world));
      premise("the first pass recorded two seen statuses", rewrites(first).length, 2);
      premise("the synthetic board is as seeded between the two passes", JSON.stringify(world.provider), board);

      const second = await admit(world, "Alice on team A, rerun over the unchanged board", laterPass(world));

      expect(readsOf(second), "the rerun was served the reads the first pass was").toEqual(readsOf(first));
      expect(readsOf(second)).toHaveLength(READS.length);
      expect(rewrites(second)).toEqual([]);
      expect(second.after.task_pm_links, "every link row, every column, across the rerun").toEqual(
        second.before.task_pm_links,
      );
      premise("the synthetic board is as seeded after the rerun", JSON.stringify(world.provider), board);

      expect(await linksHeld()).toEqual(
        linksAfter(world, { [world.diverged.rowKey]: "Done", [world.inSync.rowKey]: "In Progress" }),
      );
      expect(await tasksHeld()).toEqual(tasksOf(world));
      expect(await reconcileAudits()).toEqual(
        [2, 0].map((seenUpdated) => ({
          team_id: world.a.team.teamId,
          member_id: world.alice.memberId,
          action: AUDIT_ACTION,
          meta: { provider: PROVIDER, seenUpdated, divergences: 1 },
        })),
      );
    },
    ROOMIER,
  );

  it(
    "3 — refusals by real session and row state, none by a mocked guard, after a control in which the admitted admin's same call resolves, decrypts, reads the provider, records two seen statuses, stores an audit row and asks a revalidation: each a new invocation with the board still armed to answer that returns exactly `{ ok: false, error: \"admins only\" }`, issues the gate's own reads and nothing after them, never acquires the service client (so reads no integration and no link and hands nothing down), reaches neither the real owner nor `decryptSecret`, sends nothing to the provider, asks no revalidation, trips no tripwire and changes no durable row of either team — no session cookie, handed team A's slug (the cookie read alone; the server client is never acquired); an active role-member of team A holding the builtin Everyone row; an active role-admin of team A holding only the builtin External row; and team B's admitted admin, under their own valid session, handed team A's slug, where the only identifiers of either team any statement binds are that slug, the team id it resolved to and their own auth user; read back raw, the only reconcile audit row is the control's",
    async () => {
      const world = await seedWorld();
      const slug = world.a.team.teamSlug;
      const member = await seedCast(world.a.team, "member", { role: "member" });
      const outsider = await seedCast(world.a.team, "outsider", { posture: "external" });

      // An admitted call reads, decrypts, asks the provider, writes and revalidates: the zeros are not vacuous.
      await admit(world, `${CONTROL} Alice on team A`, firstPass(world));

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
      const bobAtA = await refuse("Bob, an admin of team B, handed team A's slug", {
        session: world.bob.session,
        slug,
        guard: strangerChain(world.bob, world.a.team),
        server: 1,
      });
      expect(
        boundOf(bobAtA, {
          ...identifiersOf("A", world.a, world.alice),
          ...identifiersOf("B", world.b, world.bob),
        }),
        "what Bob's refused request bound",
      ).toEqual(["bob's auth user", "team A id", "team A slug"]);

      expect(await linksHeld()).toEqual(
        linksAfter(world, { [world.diverged.rowKey]: "Done", [world.inSync.rowKey]: "In Progress" }),
      );
      expect(await reconcileAudits()).toEqual([
        {
          team_id: world.a.team.teamId,
          member_id: world.alice.memberId,
          action: AUDIT_ACTION,
          meta: { provider: PROVIDER, seenUpdated: 2, divergences: 1 },
        },
      ]);
    },
    ROOMIER,
  );
});

/** F4's six cells: each provider a team can name, by each way its integration can be unusable. */
const UNAVAILABLE_CELLS = (["linear", "plane"] as const).flatMap((named) =>
  (["missing", "disabled", "secret-less"] as const).map((state) => ({ named, state })),
);

describe("AIO-1217 F4 — app/t/[team]/admin/pm-sync/actions.ts#reconcileDivergenceAction over real Postgres, real guard, real resolution and real reconcileProviderState when the pass never reaches the provider: the unavailable-integration refusal, and the branches it must leave as they were (direct calls; the same seams, the synthetic board armed to answer throughout)", () => {
  it.each(UNAVAILABLE_CELLS)(
    "4 — F4, `$named` named as team A's primary and team A's `$named` integration $state, while team A holds an ENABLED usable integration of the OTHER provider, team B an ENABLED usable `$named` integration, and team A two `$named` links holding a resource id: a role-member of team A is still refused as `admins only` before the service client; then team A's admitted admin's call resolves over team A's enabled rows alone, decrypts only team A's other-provider secret, and the real owner answers `{ provider: \"$named\", seenUpdated: 0, divergences: [], reason, notRunReason: \"integration_unavailable\" }` — those five keys — with NO link read; the action returns exactly `{ ok: false, error: \"primary PM integration is unavailable\" }` — two keys — with no provider request, no audit row, no revalidation, no run and no durable difference in any table of either team; nothing of team B's is bound or decrypted and neither usable integration rescues the named primary; and the SAME call again, nothing changed, issues the identical trace and leaves every row as it was",
    async ({ named, state }) => {
      const stage = await seedStage();
      const { a, b, alice, bob } = stage;
      await namePrimary(a.team, named);
      await namePrimary(b.team, named);

      if (state !== "missing") {
        const id = await hold(stage, a, alice, A_SECRET, named);
        if (state === "disabled") await disableIntegration(a, id);
        else await stripSecret(a, id);
      }
      // The two non-rescue controls: a fallback to another provider would resolve the first, and a
      // resolution that lost its team equality the second.
      await hold(stage, a, alice, A_ALT_SECRET, ALTERNATE[named]);
      await hold(stage, b, bob, B_SECRET, named);

      // Eligible links: what a pass that ran would have read, and for `linear` rewritten.
      const moved = await seedLinked(a, "A-1", {
        resourceId: syntheticResource("a1"),
        lastProjected: "Backlog",
        status: "backlog",
        provider: named,
      });
      const kept = await seedLinked(a, "A-2", {
        resourceId: syntheticResource("a2"),
        lastProjected: "In Progress",
        status: "in_progress",
        provider: named,
      });
      const foreign = await seedLinked(b, "B-1", {
        resourceId: syntheticResource("b1"),
        lastProjected: "Backlog",
        status: "backlog",
        provider: named,
      });
      armBoard(stage, [
        { link: moved, state: "Done" },
        { link: kept, state: "In Progress" },
        { link: foreign, state: "Done" },
      ]);

      const arranged = byContent([
        // Disabled keeps its ciphertext; secret-less stays enabled.
        ...(state === "missing"
          ? []
          : [integrationRow(a, named, state === "disabled" ? "disabled" : "enabled", state === "disabled")]),
        integrationRow(a, ALTERNATE[named], "enabled", true),
        integrationRow(b, named, "enabled", true),
      ]);
      const usable = `select count(*)::int as n from integrations
                       where type::text = $1 and status = 'enabled' and secret_ciphertext is not null`;
      premise("the integration rows of both teams are as this cell arranges them", await integrationsHeld(), arranged);
      premise(
        "what a read of usable integrations is answered with — the named provider's for team A and without its team equality, and team A's of the other provider — and team A's eligible links",
        {
          named: await countOf("scoped usable read", `${usable} and team_id = $2`, [named, a.team.teamId]),
          namedWithoutTeam: await countOf("unscoped usable read", usable, [named]),
          otherProvider: await countOf("other-provider usable read", `${usable} and team_id = $2`, [
            ALTERNATE[named],
            a.team.teamId,
          ]),
          links: await countOf(
            "scoped link read",
            `select count(*)::int as n from task_pm_links
              where team_id = $1 and provider = $2 and provider_resource_id is not null`,
            [a.team.teamId, named],
          ),
        },
        // Team B's row is the one a team-less resolution would rescue with; team A's other row, a fallback.
        { named: 0, namedWithoutTeam: 1, otherProvider: 1, links: 2 },
      );
      premise("both teams name the provider", [await primaryOf(a.team), await primaryOf(b.team)], [named, named]);

      // ADM answers first: the F4 failure is never what a caller the gate refuses is told.
      const member = await seedCast(a.team, "member", { role: "member" });
      await refuse("an active role-member of the team whose named integration is unavailable", {
        session: member.session,
        slug: a.team.teamSlug,
        guard: guardChain(member, await groupRows(member)),
        server: 1,
      });

      const unavailable: Late = {
        answered: {
          provider: named,
          seenUpdated: 0,
          divergences: [],
          reason: `${named} integration is not enabled or has no secret`,
          notRunReason: NOT_RUN,
        },
        // Missing or disabled, the enabled read answers the other-provider row alone; secret-less,
        // the named row too. Then the team's primary — and no link read.
        statements: resolution(a.team, state === "secret-less" ? 2 : 1),
        // Never team A's named-provider secret (disabled: not read; secret-less: gone), never team B's.
        decrypted: [A_ALT_SECRET],
        returned: UNAVAILABLE,
        audited: null,
      };
      const once = await reach(stage, "Alice on team A", unavailable);
      const again = await reach(stage, "Alice on team A, the same call again with nothing changed", unavailable);

      expect(again.trace, "the repeat issued exactly what the first invocation did").toEqual(once.trace);
      expect(
        [once.after, again.before, again.after],
        "every row of the ten tables, both teams, every column, across both invocations",
      ).toEqual([once.before, once.before, once.before]);
      expect(await reconcileAudits()).toEqual([]);
      // The configured decision stands: no provider switch, no integration or secret rewrite.
      expect(await integrationsHeld()).toEqual(arranged);
      expect([await primaryOf(a.team), await primaryOf(b.team)]).toEqual([named, named]);
    },
    ROOMIER,
  );

  it(
    "5 — resolved `linear`, no link of team A holding a resource id (its one link was never projected; team B's projected link is listed `Done` on the board): admitted, resolved and decrypted as case 1, the link read bound to team A and `linear` is answered with ZERO rows, and the owner answers `{ provider: \"linear\", seenUpdated: 0, divergences: [] }` — three keys, no reason, no marker — before any provider read; the action reports it as before: `{ ok: true, provider: \"linear\", seenUpdated: 0, divergences: [] }`, one audit row whose `meta` reads `seenUpdated: 0`, `divergences: 0`, then the revalidation — a zero-work success, not the F4 refusal",
    async () => {
      const stage = await seedStage();
      const { a, b, alice, bob } = stage;
      await namePrimary(a.team);
      await namePrimary(b.team);
      await hold(stage, a, alice, A_SECRET, PROVIDER);
      await hold(stage, b, bob, B_SECRET, PROVIDER);
      await seedLinked(a, "A-1", { resourceId: null, lastProjected: null, status: "backlog" });
      const foreign = await seedLinked(b, "B-1", {
        resourceId: syntheticResource("b1"),
        lastProjected: "Backlog",
        status: "backlog",
      });
      armBoard(stage, [{ link: foreign, state: "Done" }]);
      premise(
        "what the link read is answered with as written, and without its team equality",
        [
          await countOf(
            "scoped link read",
            `select count(*)::int as n from task_pm_links
              where team_id = $1 and provider = $2 and provider_resource_id is not null`,
            [a.team.teamId, PROVIDER],
          ),
          await countOf(
            "provider-only link read",
            `select count(*)::int as n from task_pm_links where provider = $1 and provider_resource_id is not null`,
            [PROVIDER],
          ),
        ],
        [0, 1],
      );

      const meta = { provider: PROVIDER, seenUpdated: 0, divergences: 0 };
      await reach(stage, "Alice on team A", {
        answered: { provider: PROVIDER, seenUpdated: 0, divergences: [] },
        statements: [...resolution(a.team, 1), linkRead(a.team, PROVIDER, 0)],
        decrypted: [A_SECRET],
        returned: { ok: true, provider: PROVIDER, seenUpdated: 0, divergences: [] },
        audited: meta,
      });

      expect(await reconcileAudits()).toEqual(auditsOf(stage, [meta]));
    },
    ROOMY,
  );

  it.each([
    { links: "two `plane` links holding a resource id", linked: true },
    { links: "no link at all", linked: false },
  ])(
    "6 — `plane` named, an ENABLED usable `plane` integration, team A holding $links (PINNED AS CURRENT, NOT ENDORSED — residual R1): the adapter has no inbound support, so the owner answers `{ provider: \"plane\", seenUpdated: 0, divergences: [], reason: \"plane has no inbound reconcile support\" }` — four keys, NO marker — after the resolution alone, with no link read and no provider request; the action drops the reason and reports `{ ok: true, provider: \"plane\", seenUpdated: 0, divergences: [] }`, one audit row and the revalidation, as it did before F4; repeated, the trace is identical, no link row differs and the only durable difference per call is its audit row — none of which is evidence that a Plane board was read",
    async ({ linked }) => {
      const { stage, late } = await planeUnsupported({ primary: "named", linked });

      const once = await reach(stage, "Alice on team A", late);
      const again = await reach(stage, "Alice on team A, the same call again", late);

      expect(again.trace, "the repeat issued exactly what the first invocation did").toEqual(once.trace);
      expect(again.after.task_pm_links, "every link row, every column, across both invocations").toEqual(
        once.before.task_pm_links,
      );
      const meta = { provider: "plane", seenUpdated: 0, divergences: 0 };
      expect(await reconcileAudits()).toEqual(auditsOf(stage, [meta, meta]));
    },
    ROOMIER,
  );

  it(
    "7 — no provider resolved, none enabled: team A names no primary and its one `linear` integration is DISABLED, while team B's is enabled and usable and both hold a projected link the board lists: the enabled read bound to team A is answered with ZERO rows, nothing is decrypted, and the owner answers `{ provider: null, seenUpdated: 0, divergences: [], reason: \"no enabled PM integration\" }` — four keys, NO marker; the action returns its existing `{ ok: false, error: \"no enabled PM integration\" }` — the owner's reason, not the F4 message — with no link read, provider request, audit row, revalidation or durable difference",
    async () => {
      const stage = await seedStage();
      const { a, b, alice, bob } = stage;
      await namePrimary(b.team);
      await disableIntegration(a, await hold(stage, a, alice, A_SECRET, PROVIDER));
      await hold(stage, b, bob, B_SECRET, PROVIDER);
      const own = await seedLinked(a, "A-1", {
        resourceId: syntheticResource("a1"),
        lastProjected: "Backlog",
        status: "backlog",
      });
      const foreign = await seedLinked(b, "B-1", {
        resourceId: syntheticResource("b1"),
        lastProjected: "Backlog",
        status: "backlog",
      });
      armBoard(stage, [
        { link: own, state: "Done" },
        { link: foreign, state: "Done" },
      ]);
      premise(
        "team A names no primary and holds only a disabled row; team B's row is enabled and usable",
        [await primaryOf(a.team), await integrationsHeld()],
        [
          null,
          byContent([integrationRow(a, PROVIDER, "disabled", true), integrationRow(b, PROVIDER, "enabled", true)]),
        ],
      );

      const reason = "no enabled PM integration";
      await reach(stage, "Alice on team A", {
        answered: { provider: null, seenUpdated: 0, divergences: [], reason },
        statements: resolution(a.team, 0),
        decrypted: [],
        returned: { ok: false, error: reason },
        audited: null,
      });

      expect(await reconcileAudits()).toEqual([]);
    },
    ROOMY,
  );

  it(
    "7 — no provider resolved, two enabled: team A names no primary and holds an ENABLED usable `linear` AND an ENABLED usable `plane` integration: the enabled read is answered with both rows, both of team A's secrets are decrypted and neither of anyone else's, and the owner answers `{ provider: null, …, reason: \"multiple PM integrations enabled but teams.primary_pm_provider is unset\" }` — four keys, NO marker; the action returns that reason as its existing refusal, with no link read, provider request, audit row, revalidation or durable difference",
    async () => {
      const stage = await seedStage();
      const { a, b, alice, bob } = stage;
      await namePrimary(b.team);
      await hold(stage, a, alice, A_SECRET, PROVIDER);
      await hold(stage, a, alice, A_ALT_SECRET, ALTERNATE[PROVIDER]);
      await hold(stage, b, bob, B_SECRET, PROVIDER);
      const own = await seedLinked(a, "A-1", {
        resourceId: syntheticResource("a1"),
        lastProjected: "Backlog",
        status: "backlog",
      });
      armBoard(stage, [{ link: own, state: "Done" }]);
      premise("team A names no primary", await primaryOf(a.team), null);

      const reason = "multiple PM integrations enabled but teams.primary_pm_provider is unset";
      await reach(stage, "Alice on team A", {
        answered: { provider: null, seenUpdated: 0, divergences: [], reason },
        statements: resolution(a.team, 2),
        decrypted: [A_ALT_SECRET, A_SECRET].sort(),
        returned: { ok: false, error: reason },
        audited: null,
      });

      expect(await reconcileAudits()).toEqual([]);
    },
    ROOMY,
  );

  it(
    "8 — sole-enabled fallback, `linear`: team A names NO primary and its one enabled PM integration is the usable `linear` one of case 1: the same call is admitted, resolves `linear`, reads the three links and the board, records two seen statuses, and is audited, revalidated and returned exactly as case 1 is — an unset primary is not a refusal, and the owner's answer is unmarked; team A still names no primary afterwards",
    async () => {
      const world = await seedWorld({ primary: "unset" });

      await admit(world, "Alice on team A, no primary named", firstPass(world));

      expect(await primaryOf(world.a.team)).toBeNull();
      expect(await reconcileAudits()).toEqual(
        auditsOf(world, [{ provider: PROVIDER, seenUpdated: 2, divergences: 1 }]),
      );
    },
    ROOMY,
  );

  it(
    "8 — sole-enabled fallback, `plane` (PINNED AS CURRENT, NOT ENDORSED — residual R1): team A names NO primary and its one enabled PM integration is a usable `plane` one, with two `plane` links holding a resource id: resolved to `plane`, the owner answers the unsupported reason UNMARKED with no link read and no provider request, and the action reports `{ ok: true, provider: \"plane\", seenUpdated: 0, divergences: [] }`, audits and revalidates exactly as case 6; team A still names no primary afterwards",
    async () => {
      const { stage, late } = await planeUnsupported({ primary: "unset", linked: true });

      await reach(stage, "Alice on team A, no primary named", late);

      expect(await primaryOf(stage.a.team)).toBeNull();
      expect(await reconcileAudits()).toEqual(auditsOf(stage, [{ provider: "plane", seenUpdated: 0, divergences: 0 }]));
    },
    ROOMY,
  );
});

// Each TODO names evidence this slice was told not to supply, or could not.
describe("Z — evidence this file does NOT supply (executable TODOs: none is run, none is passed)", () => {
  it.todo(
    "LINEAR CLIENT ENVELOPE · lib/pm-sync/linear-client.ts was outside this slice's read list: the endpoint URL, the HTTP method, the header the decrypted key travels in, and `linearGraphql`'s handling of a non-2xx answer, a GraphQL `errors` array, a retry or a rate limit are not asserted; this file assumes only the `{ query, variables }` string body and the `{ data }` answer, and shows that the acting team's key was DECRYPTED and that no request carried the other team's — not where or whether the acting key is presented",
  );
  it.todo(
    "PROVIDER SERVICE BEHAVIOR · the provider is a value in this file: nothing here is evidence of Linear's schema, of what its API answers to these three queries, of its authorization of any key, of pagination past one page (`hasNextPage: true` on issues or members is never answered), or of an issue carrying no state; no live or recorded provider exchange takes place",
  );
  it.todo(
    "TRANSPORTS OTHER THAN GLOBAL FETCH · `no provider mutation` is a count of what reached global `fetch` during a request, beside source that issues only reads on this path; a transport that is not global `fetch`, and the `fetchImpl` option the action never hands down, are not counted",
  );
  it.todo(
    "ACTION WIRE AND NEXT CACHE · the export is called directly: the Next Server Action transport, POST dispatch, action id encryption, origin and CSRF checks, argument deserialization and what a non-string `teamSlug` would do are not exercised; `revalidatePath` is a recording seam showing only that the action ASKED for `/t/<slug>/admin/pm-sync`, with no `type`, after the owner returned and the audit insert was issued — that Next invalidates anything is not evidenced",
  );
  it.todo(
    "COORDINATOR · F4 RED AND MUTANTS (isolated-copy actual-import run; cases 4 to 8 are read from source and NEITHER a RED run NOR any mutant has been observed): against the sources BEFORE the marker, each of case 4's six cells must fail on the outcome (`ok: true`), the answered key list, the ledger (an audit insert and a revalidation after the owner's return) and the durable difference, with its admitted controls passing — that RED is not recorded by this file; then, on isolated copies of the candidate: omit `notRunReason` from the owner's named-unavailable return (case 4: answered keys, outcome, ledger); ignore the marker in the action (case 4: outcome, ledger, durable difference); move the audit write, `revalidatePath`, or both above the marker check (case 4: ledger, `revalidated`, durable difference); set the marker on the no-link, unsupported or null-provider return, or on every return even as `undefined` (cases 1, 2, 5, 6, 7, 8: answered keys, and the outcome where the action then refuses); refuse on `seenUpdated === 0`, an empty divergence list or a present `reason` (cases 2, 5, 6, 8); resolve the named primary through another provider or another team's row (case 4: outcome, decrypts, foreign bindings) — each must fail on those, not on a compile or fixture error; this action records no `ingest_runs` row on any branch",
  );
  it.todo(
    "RECONCILE ERROR POLICY · a provider read that throws or answers an error (thrown out of `reconcileProviderState` and so out of this action, with no audit row by source reading, possibly after some links were rewritten), a `decryptSecret` that throws on a stored value, a refused `integrations` read, a refused link read or link update (reconcile.ts:99-104 and :119-122 read no `error`), a refused `teams` read beneath the resolution, and a refused `audit_log` insert (swallowed) are not reached; every request here holds as a premise that Postgres refused no statement and that the responder refused no request",
  );
  it.todo(
    "OTHER OWNER BRANCHES · a link whose stored seen status differs from a changed board on a LATER pass (a moved board after the first pass is not constructed: the rerun holds the board fixed) and a link with an empty `last_projected_status` are not exercised; PLANE INBOUND RECONCILIATION does not exist on this snapshot (`planeAdapter` has no `fetchSeenStates`): cases 6 and 8 pin the unsupported-adapter success, audit row and revalidation as current behavior (residual R1, pending separate intake) and are not evidence that a Plane board was read, that it holds no divergence, or of any Plane no-link, changed-state or unchanged-board pass; F4's cells are `missing`, `disabled` and `secret-less` by row state only — a `decryptSecret` that throws on a stored value is the error policy's, above, and is not an F4 state",
  );
  it.todo(
    "ADMITTED TEAM-B INVOCATION · team B's admin is seeded and is only ever refused at team A's slug: the reverse direction — that team B's own call decrypts team B's secret alone, reads team B's Linear team and rewrites team B's link alone — is not evidenced; the responder answers for team A's Linear team only and would refuse that call",
  );
  it.todo(
    "OTHER REFUSAL FAMILIES · a session cookie the real verifier rejects (expired, malformed, signed under another secret), a session whose auth user has no member row anywhere, a role-`lead` member, a suspended or invited member of the right team, a slug that names no team and a guard read that Postgres refuses are not exercised; broad guard enumeration and the legacy `members.tier` column's two stale directions are the association file's",
  );
  it.todo(
    "TASK CONTENT POLICY · the link read names six bookkeeping columns and no `tasks` statement is issued on this path; the returned divergence carries a row key and two state names; nothing here is evidence of, or a ruling on, a task-level content boundary for what an admin of the team may be shown",
  );
  it.todo(
    "CONCURRENCY AND FRESHNESS · two overlapping passes, a link rewritten between the owner's read and its update, and membership revoked mid-request are not constructed; membership is read per request and no linearizability claim is made",
  );
  it.todo(
    "COORDINATOR · MUTANTS (isolated-copy actual-import run; every expectation below is read from source and NO mutant has been run): against this fixture, drop the `team_id` equality from the link read in lib/pm-sync/reconcile.ts (the bound equalities, the row count, team B's link rewritten and a second divergence); drop it from the integrations read in lib/integrations/manage.ts (the row count and a second decrypt); bind either to a team other than the one the owner was handed (the foreign bindings); write `provider_seen_status` unconditionally (case 2: an update, a changed row and `seenUpdated`); write the seen state back to `tasks.status` or send any mutation (the durable difference; a transport violation); move the audit write or `revalidatePath` before the owner call, drop either, or swap them (the ledger and the durable difference); ignore the null `requireAdmin` verdict (case 3) — each must then fail on the outcome, the trace, the stored row or the durable difference, not on a compile or fixture error; NOT killed by this fixture, and named so none is counted: dropping the `provider` equality from the link read (every link here is `linear`), and dropping the resource-id filter (the unprojected link would be read and then skipped, changing only the row count); no mutation evidence is supplied here",
  );
  it.todo(
    "EXCLUDED ACTIONS AND ACCEPTANCE · projectBoardAction of the same file, every other admin export and every other caller of reconcileProviderState are not executed here; nothing about API keys, AIO-1226 or PR714; no provider mutation is executed; this file is not an AC-04 pass, not the AIO-1217 Server Action inventory, and not acceptance, full-suite checks or final review of any criterion",
  );
});
