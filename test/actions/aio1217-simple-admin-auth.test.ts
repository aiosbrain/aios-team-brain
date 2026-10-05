import { afterAll, beforeAll, beforeEach, describe, expect, it, vi, type Mock } from "vitest";

/**
 * AIO-1217 — SEVEN SIMPLE ADMIN ACTIONS, unit tier: the team-admin gate of seven selected exports,
 * executed as the actual exported functions through the actual authority owner chain.
 *
 * Every expectation is read off the current sources named below. This file pins what those sources
 * do today — including the fail-closed nulls and the propagated posture fault — and specifies no new
 * behavior, mapping or policy.
 *
 *   X — the fixture's own contract: identities, tokens and inputs are what the cases call them; the
 *       guard substrate answers the owners' three statements and nothing else; the privileged client
 *       is a trap.
 *   A — each export: an admitted control, the binding of the lower owner's team and actor to what
 *       the server resolved, every refusal, and the posture read fault.
 *   B — the backfill one-batch control: one drained batch, a terminated loop and no revalidation.
 *
 * Exports exercised, as `(repository path, export name)`:
 *   app/t/[team]/admin/brand/actions.ts     saveBrand
 *   app/t/[team]/admin/brand/actions.ts     addAsset
 *   app/t/[team]/admin/brand/actions.ts     removeAsset
 *   app/t/[team]/admin/policies/actions.ts  savePolicy   (create and owned-id update: two controls, one export)
 *   app/t/[team]/admin/policies/actions.ts  togglePolicy
 *   app/t/[team]/admin/policies/actions.ts  removePolicy
 *   app/t/[team]/admin/access/actions.ts    runContextBackfillAction
 *
 * What is real, and never mocked or handed a verdict: the seven exports; `lib/auth/guard`
 * `requireTeamAdmin`; `lib/auth/session` `getSessionUser`; `lib/auth/pg-session`
 * `signSession`/`verifySession` (jose HS256 against AUTH_SECRET); `lib/integrations/read`
 * `resolveIntegrationsAdmin`; `lib/access/posture` `resolveViewerPosture`; `lib/auth/admin-access`
 * `canAccessAdmin` over `lib/auth/visibility` `isRestrictedTier`; and, in X only, the
 * `lib/brand/schema` validators. A caller is admitted only by a cookie the real verifier accepts and
 * rows the real owners read and judge themselves.
 *
 * The synthetic seams, all of them:
 *   SEAM cookies     `next/headers` `cookies` — async, resolves a recording store over a per-request Map.
 *   SEAM server db   `@/lib/db/server` `serverClient` — records, then hands the owners the guard
 *                    substrate described below. It is the only thing the authority chain reads.
 *   SEAM admin db    `@/lib/db/admin` `adminClient` — records, then returns a trap whose `from` and
 *                    `rpc` record and throw. A refused call must not even acquire it.
 *   SEAM lower       the eight lower owners, each module replaced whole by exactly the exports the
 *                    action files import from it: `@/lib/brand/manage` `saveBrandProfile`;
 *                    `@/lib/brand/assets` `addBrandAsset`, `removeBrandAsset`; `@/lib/policy/manage`
 *                    `createPolicy`, `updatePolicy`, `setPolicyEnabled`, `deletePolicy`;
 *                    `@/lib/projects/context/backfill` `backfillTeamContext`. Each records its
 *                    arguments and returns a fixed healthy result.
 *   SEAM revalidate  `next/cache` `revalidatePath` — records the path.
 *   SEAM after       `next/server` `after` — a recording tripwire. None of the seven exports and none
 *                    of the real owners imports it today, so its zero is a tripwire, not behavior.
 * AUTH_SECRET is a synthetic value stubbed for this file and restored afterwards.
 *
 * THE GUARD SUBSTRATE holds synthetic `teams`, `members`, `groups` and `group_members` rows and
 * admits exactly the three statements the owners issue: `teams` by slug (maybeSingle), `members` by
 * team, auth user and active status (maybeSingle), and `group_members` by team and member with the
 * `groups(slug, is_builtin)` embed (list). Equality filters are really applied to the rows, so a
 * refusal is the owner's own predicate missing, not a canned answer. The embed is a key lookup from
 * `group_id` to the fixture's `groups` rows, returned as one object or null — the to-one shape
 * `lib/db/pg/relationships.ts` registers for `group_members.groups`. Any other table, select list,
 * filter set, terminal or write fails a fixture premise.
 *
 * One ordered ledger takes everything observable. `read:` entries are the permission prerequisites
 * (the session cookie, the server client, the three statements with their bound values); `effect:`
 * entries are everything else (admin client, privileged statements, lower owners, revalidation,
 * `after`, cookie mutations, a write through the server client). They are asserted separately and,
 * for admitted calls, as one sequence — so "nothing else happened" is an equality, not missing spies.
 *
 * Each refusal first runs the admitted control in the same test, then clears the ledger and every
 * recording and restores the healthy rows, so an earlier admission cannot satisfy a later proof.
 * A refusal then removes ONE conjunct — from the request's session or from the healthy rows — and
 * keeps every lower owner armed to succeed: had the gate admitted the call, the ledger would show
 * it. After the refusal the real posture resolver is asked what it makes of the standing rows, to
 * show which conjunct failed.
 *
 * Bounds of what is claimed.
 *   - Seven selected exports only. This is not a census of admin actions, not a general admin policy
 *     framework, not a production policy change, and not final acceptance of any AIO-1217 criterion.
 *     It does not address AIO-1225, AIO-1226, AIO-1227 or AIO-1228.
 *   - The substrate is not PostgreSQL and not the pg adapter: no SQL, no relational join, no
 *     constraint, no concurrency. It proves how the owners compose over the envelopes they are
 *     handed. Rows are not schema-checked; a rearranged world may be one the schema would refuse.
 *     No case seeds a `group_members` row whose team differs from its group's team, and nothing is
 *     claimed about what the owners do with one.
 *   - The lower owners are wiring evidence. Validation, team scoping of an id, the gateway-policy
 *     refusal, the business write and the success audit all live inside them and are not executed.
 *     "No business mutation and no success audit" on a refusal therefore means: the owner that
 *     performs both was never reached and the privileged client was never acquired. The asset and
 *     policy ids are synthetic UUIDs the fixture merely designates as owned and non-gateway.
 *   - None of these exports has a provider or model path. Every lower path they have begins with
 *     `adminClient()`, which is the evidence offered for "no provider, model or backfill dispatch".
 *   - `runContextBackfillAction` hands its worker the team and no actor. That is pinned as current.
 *   - Calling an exported function against doubles proves nothing about the Next action wire, POST
 *     dispatch, serialization of a thrown error, or real cache invalidation.
 *   - The rejected-read form of the posture fault is synthetic: `DbResult` documents an envelope
 *     that never rejects. The returned-error form is the adapter-shaped one.
 *
 * Run status at authoring: NOT RUN. This file was written without executing vitest, tsc or any other
 * command. Its expectations come from reading the sources above, not from an observed run; replace
 * this paragraph with the observed result once it has been executed.
 */

const FIXTURE = "FIXTURE PREMISE FAILED (setup, not a security observation):";
const CONTROL = "PRECEDING ADMITTED CONTROL FAILED (the refusal below would be vacuous):";

const h = vi.hoisted(() => ({
  /** SEAM cookies: the async `cookies()` of this request. */
  cookies: vi.fn(),
  /** SEAM server db: hands the owners the guard substrate. */
  serverClient: vi.fn(),
  /** SEAM admin db: hands out the privileged trap. */
  adminClient: vi.fn(),
  /** SEAM revalidate. */
  revalidatePath: vi.fn(),
  /** SEAM after: a tripwire. */
  after: vi.fn(),
  /** SEAM lower: the eight recording owners. */
  saveBrandProfile: vi.fn(),
  addBrandAsset: vi.fn(),
  removeBrandAsset: vi.fn(),
  createPolicy: vi.fn(),
  updatePolicy: vi.fn(),
  setPolicyEnabled: vi.fn(),
  deletePolicy: vi.fn(),
  backfillTeamContext: vi.fn(),
}));

vi.mock("next/headers", () => ({ cookies: h.cookies }));
vi.mock("next/cache", () => ({ revalidatePath: h.revalidatePath }));
vi.mock("next/server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/server")>()),
  after: h.after,
}));
vi.mock("@/lib/db/server", () => ({ serverClient: h.serverClient }));
vi.mock("@/lib/db/admin", () => ({ adminClient: h.adminClient }));
vi.mock("@/lib/brand/manage", () => ({ saveBrandProfile: h.saveBrandProfile }));
vi.mock("@/lib/brand/assets", () => ({ addBrandAsset: h.addBrandAsset, removeBrandAsset: h.removeBrandAsset }));
vi.mock("@/lib/policy/manage", () => ({
  createPolicy: h.createPolicy,
  updatePolicy: h.updatePolicy,
  setPolicyEnabled: h.setPolicyEnabled,
  deletePolicy: h.deletePolicy,
}));
vi.mock("@/lib/projects/context/backfill", () => ({ backfillTeamContext: h.backfillTeamContext }));

import { runContextBackfillAction } from "@/app/t/[team]/admin/access/actions";
import { addAsset, removeAsset, saveBrand } from "@/app/t/[team]/admin/brand/actions";
import { removePolicy, savePolicy, togglePolicy, type PolicyForm } from "@/app/t/[team]/admin/policies/actions";
import { resolveViewerPosture, type ViewerPosture } from "@/lib/access/posture";
import { EVERYONE_SLUG, EXTERNAL_SLUG } from "@/lib/access/system-projects";
import { canAccessAdmin } from "@/lib/auth/admin-access";
import { signSession, verifySession, type SessionUser } from "@/lib/auth/pg-session";
import {
  validateBrandAsset,
  validateBrandProfile,
  type BrandAssetInput,
  type BrandProfileInput,
} from "@/lib/brand/schema";
import type { DbClient } from "@/lib/db/types";

type Row = Record<string, unknown>;
type Envelope = { data: unknown; error: { message: string } | null; count: number | null };

const AUTH_SECRET = "aio1217-simple-admin-auth-secret-not-for-production";
const SESSION_COOKIE = "aios_session";
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

interface Team {
  id: string;
  slug: string;
}

const TEAM: Team = { id: "12170000-0000-4000-8000-0000000000a1", slug: "aio1217-simple-admin" };
const OTHER_TEAM: Team = { id: "12170000-0000-4000-8000-0000000000b1", slug: "aio1217-simple-admin-other" };

const ALICE: SessionUser = { id: "12170000-0000-4000-8000-0000000000a2", email: "alice.aio1217.admin@fixture.test" };
const BOB: SessionUser = { id: "12170000-0000-4000-8000-0000000000b2", email: "bob.aio1217.admin@fixture.test" };
const ALICE_MEMBER = "12170000-0000-4000-8000-0000000000a3";
const BOB_MEMBER = "12170000-0000-4000-8000-0000000000b3";

const TEAM_EVERYONE = "12170000-0000-4000-8000-0000000000a4";
const TEAM_EXTERNAL = "12170000-0000-4000-8000-0000000000a5";
const OTHER_EVERYONE = "12170000-0000-4000-8000-0000000000b4";

/** Synthetic ids the fixture designates as owned by TEAM and, for the policy, non-gateway. */
const ASSET_ID = "12170000-0000-4000-8000-0000000000c1";
const POLICY_ID = "12170000-0000-4000-8000-0000000000c2";
const CREATED_POLICY_ID = "12170000-0000-4000-8000-0000000000c3";

const BRAND_INPUT: BrandProfileInput = { voice: { formality: "neutral" } };
const ASSET_INPUT: BrandAssetInput = { kind: "reference", label: "Fixture reference", notes: "synthetic" };
const POLICY_INPUT: PolicyForm = { action: "code.run", resource: "*", effect: "allow", priority: 1 };
const POLICY_UPDATE: PolicyForm = { ...POLICY_INPUT, id: POLICY_ID };
const TOGGLE_ENABLED = false;

/** The one healthy batch the worker reports: a drained cursor, so the action's loop stops. */
const ONE_BATCH = { ok: true, unitsCreated: 2, membershipsCreated: 1, cursor: null };
const BACKFILL_AGGREGATE = { ok: true, unitsCreated: 2, membershipsCreated: 1, batches: 1 };

const SAVED = { ok: true };
const ADMINS_ONLY = { ok: false, error: "admins only" };

const POSTURE_FAULT = "AIO1217 synthetic posture read fault";

/** A signed-in admin as the healthy world holds them: one user, one membership, one team. */
interface Principal {
  user: SessionUser;
  memberId: string;
  team: Team;
}
const ALICE_ADMIN: Principal = { user: ALICE, memberId: ALICE_MEMBER, team: TEAM };
const BOB_ADMIN: Principal = { user: BOB, memberId: BOB_MEMBER, team: OTHER_TEAM };

// ── the ledger ───────────────────────────────────────────────────────────────────────────────────

/** Everything observable, in order: `read:` permission prerequisites and `effect:` everything else. */
const ledger: string[] = [];
const reads = () => ledger.filter((entry) => entry.startsWith("read:"));
const effects = () => ledger.filter((entry) => entry.startsWith("effect:"));

const SESSION_READ = `read:cookie ${SESSION_COOKIE}`;
const SERVER_CLIENT = "read:serverClient";
const readTeam = (slug: string) => `read:teams slug=${slug}`;
const readMember = (teamId: string, userId: string) =>
  `read:members team_id=${teamId} auth_user_id=${userId} status=active`;
const readPosture = (teamId: string, memberId: string) => `read:group_members team_id=${teamId} member_id=${memberId}`;

const ADMIN_CLIENT = "effect:adminClient";
const lowerEffect = (name: LowerName) => `effect:lower ${name}`;
const revalidated = (path: string) => `effect:revalidatePath ${path}`;

// ── the guard substrate ──────────────────────────────────────────────────────────────────────────

interface World {
  teams: Row[];
  members: Row[];
  groups: Row[];
  group_members: Row[];
}

/** Alice is an active admin of TEAM holding its builtin everyone row; Bob is the same in OTHER_TEAM. */
function healthyWorld(): World {
  return {
    teams: [{ ...TEAM }, { ...OTHER_TEAM }],
    members: [
      { id: ALICE_MEMBER, team_id: TEAM.id, auth_user_id: ALICE.id, role: "admin", status: "active" },
      { id: BOB_MEMBER, team_id: OTHER_TEAM.id, auth_user_id: BOB.id, role: "admin", status: "active" },
    ],
    groups: [
      { id: TEAM_EVERYONE, team_id: TEAM.id, slug: EVERYONE_SLUG, is_builtin: true },
      { id: TEAM_EXTERNAL, team_id: TEAM.id, slug: EXTERNAL_SLUG, is_builtin: true },
      { id: OTHER_EVERYONE, team_id: OTHER_TEAM.id, slug: EVERYONE_SLUG, is_builtin: true },
    ],
    group_members: [
      { team_id: TEAM.id, group_id: TEAM_EVERYONE, member_id: ALICE_MEMBER },
      { team_id: OTHER_TEAM.id, group_id: OTHER_EVERYONE, member_id: BOB_MEMBER },
    ],
  };
}

let world: World = healthyWorld();
/** When set, the posture statement is issued and recorded, then faults in this form. */
let postureFault: "returned error" | "rejected read" | null = null;
let postureRejection = new Error("AIO1217 synthetic posture read rejection");

type Terminal = "maybeSingle" | "list";
type GuardTable = "teams" | "members" | "group_members";

interface GuardRead {
  select: string;
  filters: string[];
  terminal: Terminal;
  /** Only the selected columns leave the substrate. */
  project(row: Row): Row;
}

/** The to-one `groups(slug, is_builtin)` embed: one object, or null when no group row carries the id. */
function embeddedGroup(membership: Row): Row | null {
  const group = world.groups.find((candidate) => candidate.id === membership.group_id);
  return group ? { slug: group.slug, is_builtin: group.is_builtin } : null;
}

/** The three statements the owners issue, as read from lib/integrations/read and lib/access/posture. */
const GUARD_READS: Record<GuardTable, GuardRead> = {
  teams: { select: "id", filters: ["slug"], terminal: "maybeSingle", project: (row) => ({ id: row.id }) },
  members: {
    select: "id, role",
    filters: ["team_id", "auth_user_id", "status"],
    terminal: "maybeSingle",
    project: (row) => ({ id: row.id, role: row.role }),
  },
  group_members: {
    select: "group_id, groups(slug, is_builtin)",
    filters: ["team_id", "member_id"],
    terminal: "list",
    project: (row) => ({ group_id: row.group_id, groups: embeddedGroup(row) }),
  },
};
const isGuardTable = (table: string): table is GuardTable => Object.keys(GUARD_READS).includes(table);

interface GuardChain extends PromiseLike<Envelope> {
  select(spec?: string): GuardChain;
  eq(column: string, value: unknown): GuardChain;
  maybeSingle(): Promise<Envelope>;
  insert(values: unknown): never;
  update(values: unknown): never;
  upsert(values: unknown): never;
  delete(): never;
}

/** SEAM server db: PostgREST-shaped reads over `world`, honouring every `.eq` the owners apply. */
const serverDb = {
  from(table: string): GuardChain {
    let select: string | null = null;
    const filters: Array<[string, unknown]> = [];

    const refuseWrite = (operation: string) => (): never => {
      ledger.push(`effect:serverClient.${operation} ${table}`);
      throw new Error(`${FIXTURE} the server client was asked to ${operation} ${table}`);
    };

    const run = async (terminal: Terminal): Promise<Envelope> => {
      const columns = filters.map(([column]) => column);
      const issued = `select(${String(select)}) eq(${columns.join(", ")}) ${terminal}`;
      if (!isGuardTable(table)) throw new Error(`${FIXTURE} unmodelled statement on ${table}: ${issued}`);
      const read = GUARD_READS[table];
      const sameFilters = [...columns].sort().join() === [...read.filters].sort().join();
      if (select !== read.select || terminal !== read.terminal || !sameFilters) {
        throw new Error(`${FIXTURE} unmodelled statement on ${table}: ${issued}`);
      }

      const bound = new Map(filters);
      ledger.push(`read:${table} ${read.filters.map((column) => `${column}=${String(bound.get(column))}`).join(" ")}`);

      if (table === "group_members" && postureFault !== null) {
        if (postureFault === "rejected read") throw postureRejection;
        return { data: null, error: { message: POSTURE_FAULT }, count: null };
      }

      const matched = world[table].filter((row) => filters.every(([column, value]) => row[column] === value));
      if (terminal === "list") return { data: matched.map(read.project), error: null, count: null };
      if (matched.length > 1) throw new Error(`${FIXTURE} ${matched.length} ${table} rows match a single-row read`);
      return { data: matched[0] ? read.project(matched[0]) : null, error: null, count: null };
    };

    const chain: GuardChain = {
      select: (spec) => {
        select = spec ?? "*";
        return chain;
      },
      eq: (column, value) => {
        filters.push([column, value]);
        return chain;
      },
      maybeSingle: () => run("maybeSingle"),
      insert: refuseWrite("insert"),
      update: refuseWrite("update"),
      upsert: refuseWrite("upsert"),
      delete: refuseWrite("delete"),
      then: (onfulfilled, onrejected) => run("list").then(onfulfilled, onrejected),
    };
    return chain;
  },
  rpc(fn: string): never {
    ledger.push(`effect:serverClient.rpc ${fn}`);
    throw new Error(`${FIXTURE} the server client was asked to call ${fn}`);
  },
};
/** The substrate as the real owners take it, for the cases that call an owner directly. */
const guardDb = serverDb as unknown as DbClient;

/** SEAM admin db: what `adminClient()` returns. The lower owners are mocked, so nothing may use it. */
const privileged = {
  from(table: string): never {
    ledger.push(`effect:privileged.from ${table}`);
    throw new Error(`${FIXTURE} the privileged client was used below a mocked lower owner (from ${table})`);
  },
  rpc(fn: string): never {
    ledger.push(`effect:privileged.rpc ${fn}`);
    throw new Error(`${FIXTURE} the privileged client was used below a mocked lower owner (rpc ${fn})`);
  },
};

/** The one standing row a case rearranges. Throws when the healthy world is not as the case assumes. */
function standing(table: keyof World, where: (row: Row) => boolean): Row {
  const found = world[table].filter(where);
  if (found.length !== 1) throw new Error(`${FIXTURE} expected exactly one ${table} row to rearrange, found ${found.length}`);
  return found[0];
}
const aliceMembership = () => standing("members", (row) => row.id === ALICE_MEMBER);
const aliceEveryoneRow = () => standing("group_members", (row) => row.member_id === ALICE_MEMBER);

// ── the request ──────────────────────────────────────────────────────────────────────────────────

let tokens: { alice: string; bob: string };

/** The cookies of the request in flight; null until a case admits one. */
let jar: Map<string, string> | null = null;

function cookieStoreOver(requestJar: Map<string, string>) {
  return {
    get: (name: string) => {
      ledger.push(`read:cookie ${name}`);
      const value = requestJar.get(name);
      return value === undefined ? undefined : { name, value };
    },
    has: (name: string) => {
      ledger.push(`read:cookie ${name}`);
      return requestJar.has(name);
    },
    getAll: () => {
      ledger.push("read:cookie *");
      return [...requestJar].map(([name, value]) => ({ name, value }));
    },
    set: (name: string, value: string) => {
      ledger.push(`effect:cookie.set ${name}`);
      requestJar.set(name, value);
    },
    delete: (name: string) => {
      ledger.push(`effect:cookie.delete ${name}`);
      requestJar.delete(name);
    },
  };
}

/** A new request, with or without a session cookie. */
function beginRequest(sessionCookie: string | null): void {
  jar = new Map(sessionCookie === null ? [] : [[SESSION_COOKIE, sessionCookie]]);
}

type Session = "alice" | "bob" | "none";
const sessionCookie = (session: Session): string | null => (session === "none" ? null : tokens[session]);

// ── the lower owners and the seven exports ───────────────────────────────────────────────────────

type LowerName =
  | "saveBrandProfile"
  | "addBrandAsset"
  | "removeBrandAsset"
  | "createPolicy"
  | "updatePolicy"
  | "setPolicyEnabled"
  | "deletePolicy"
  | "backfillTeamContext";

const LOWER: Record<LowerName, Mock> = {
  saveBrandProfile: h.saveBrandProfile,
  addBrandAsset: h.addBrandAsset,
  removeBrandAsset: h.removeBrandAsset,
  createPolicy: h.createPolicy,
  updatePolicy: h.updatePolicy,
  setPolicyEnabled: h.setPolicyEnabled,
  deletePolicy: h.deletePolicy,
  backfillTeamContext: h.backfillTeamContext,
};
const LOWER_NAMES = Object.keys(LOWER) as LowerName[];

/** What each recording owner resolves to: the healthy result of the function it stands in for. */
const LOWER_RESULT: Record<LowerName, () => unknown> = {
  saveBrandProfile: () => undefined,
  addBrandAsset: () => ({ id: ASSET_ID, ...ASSET_INPUT, url: null, created_at: "2026-01-01T00:00:00.000Z" }),
  removeBrandAsset: () => undefined,
  createPolicy: () => CREATED_POLICY_ID,
  updatePolicy: () => undefined,
  setPolicyEnabled: () => undefined,
  deletePolicy: () => undefined,
  backfillTeamContext: () => ({ ...ONE_BATCH }),
};

interface Surface {
  /** The `(repository path, export name)` this group exercises. */
  key: string;
  /** The actual export, called with the valid input for this surface. */
  invoke(teamSlug: string): Promise<unknown>;
  /** SEAM lower: the one owner this surface must reach. */
  lower: LowerName;
  /** What the owner must receive after the privileged client. */
  ownerArgs(teamId: string, memberId: string): unknown[];
  admitted: Record<string, unknown>;
  /** The path an admitted call revalidates; null when it revalidates nothing. */
  revalidates: ((teamSlug: string) => string) | null;
}

const brandPath = (teamSlug: string) => `/t/${teamSlug}/admin/brand`;
const policiesPath = (teamSlug: string) => `/t/${teamSlug}/admin/policies`;

const SURFACES: Surface[] = [
  {
    key: "app/t/[team]/admin/brand/actions.ts saveBrand",
    invoke: (teamSlug) => saveBrand(teamSlug, BRAND_INPUT),
    lower: "saveBrandProfile",
    ownerArgs: (teamId, memberId) => [teamId, BRAND_INPUT, { memberId }],
    admitted: SAVED,
    revalidates: brandPath,
  },
  {
    key: "app/t/[team]/admin/brand/actions.ts addAsset",
    invoke: (teamSlug) => addAsset(teamSlug, ASSET_INPUT),
    lower: "addBrandAsset",
    ownerArgs: (teamId, memberId) => [teamId, ASSET_INPUT, { memberId }],
    admitted: SAVED,
    revalidates: brandPath,
  },
  {
    key: "app/t/[team]/admin/brand/actions.ts removeAsset",
    invoke: (teamSlug) => removeAsset(teamSlug, ASSET_ID),
    lower: "removeBrandAsset",
    ownerArgs: (teamId, memberId) => [teamId, ASSET_ID, { memberId }],
    admitted: SAVED,
    revalidates: brandPath,
  },
  {
    key: "app/t/[team]/admin/policies/actions.ts savePolicy (create: no id)",
    invoke: (teamSlug) => savePolicy(teamSlug, POLICY_INPUT),
    lower: "createPolicy",
    ownerArgs: (teamId, memberId) => [teamId, POLICY_INPUT, { memberId }],
    admitted: SAVED,
    revalidates: policiesPath,
  },
  {
    key: "app/t/[team]/admin/policies/actions.ts savePolicy (update: owned id)",
    invoke: (teamSlug) => savePolicy(teamSlug, POLICY_UPDATE),
    lower: "updatePolicy",
    ownerArgs: (teamId, memberId) => [teamId, POLICY_ID, POLICY_UPDATE, { memberId }],
    admitted: SAVED,
    revalidates: policiesPath,
  },
  {
    key: "app/t/[team]/admin/policies/actions.ts togglePolicy",
    invoke: (teamSlug) => togglePolicy(teamSlug, POLICY_ID, TOGGLE_ENABLED),
    lower: "setPolicyEnabled",
    ownerArgs: (teamId, memberId) => [teamId, POLICY_ID, TOGGLE_ENABLED, { memberId }],
    admitted: SAVED,
    revalidates: policiesPath,
  },
  {
    key: "app/t/[team]/admin/policies/actions.ts removePolicy",
    invoke: (teamSlug) => removePolicy(teamSlug, POLICY_ID),
    lower: "deletePolicy",
    ownerArgs: (teamId, memberId) => [teamId, POLICY_ID, { memberId }],
    admitted: SAVED,
    revalidates: policiesPath,
  },
  {
    key: "app/t/[team]/admin/access/actions.ts runContextBackfillAction",
    invoke: (teamSlug) => runContextBackfillAction(teamSlug),
    lower: "backfillTeamContext",
    // The worker takes the team and a cursor window; no actor reaches it. B inspects the cutoff.
    ownerArgs: (teamId) => [teamId, { afterId: null, createdBefore: expect.any(String) }],
    admitted: BACKFILL_AGGREGATE,
    revalidates: null,
  },
];

/** The prerequisite reads of an admitted call, in the order the owners issue them. */
const admittedReads = (who: Principal) => [
  SESSION_READ,
  SERVER_CLIENT,
  readTeam(who.team.slug),
  readMember(who.team.id, who.user.id),
  readPosture(who.team.id, who.memberId),
];
/** The effects of an admitted call, in order: the privileged client, the owner, then any revalidation. */
const admittedEffects = (surface: Surface, team: Team) => [
  ADMIN_CLIENT,
  lowerEffect(surface.lower),
  ...(surface.revalidates ? [revalidated(surface.revalidates(team.slug))] : []),
];

/** Signed Alice against the healthy world: the export must succeed and reach its owner for her team. */
async function admittedAliceControl(surface: Surface): Promise<void> {
  beginRequest(tokens.alice);
  await expect(surface.invoke(TEAM.slug), CONTROL).resolves.toStrictEqual(surface.admitted);
  expect(ledger, CONTROL).toEqual([...admittedReads(ALICE_ADMIN), ...admittedEffects(surface, TEAM)]);
  expect(LOWER[surface.lower].mock.calls, CONTROL).toEqual([[privileged, ...surface.ownerArgs(TEAM.id, ALICE_MEMBER)]]);
}

const RECORDERS = [h.cookies, h.serverClient, h.adminClient, h.revalidatePath, h.after, ...Object.values(LOWER)];

/** Clears the ledger and every recording and restores the healthy rows; implementations stay armed. */
function resetBetween(): void {
  ledger.length = 0;
  for (const recorder of RECORDERS) recorder.mockClear();
  world = healthyWorld();
  postureFault = null;
  jar = null;
}

/** No privileged client, lower owner, revalidation, `after`, cookie mutation or server-client write. */
function expectNoLowerEffect(): void {
  expect(effects()).toEqual([]);
  expect(h.adminClient).not.toHaveBeenCalled();
  for (const name of LOWER_NAMES) expect(LOWER[name], name).not.toHaveBeenCalled();
  expect(h.revalidatePath).not.toHaveBeenCalled();
  expect(h.after).not.toHaveBeenCalled();
}

type Settled<T> = { value?: T; thrown?: unknown };

async function settle<T>(call: Promise<T>): Promise<Settled<T>> {
  try {
    return { value: await call };
  } catch (thrown) {
    return { thrown };
  }
}

// ── refusals ─────────────────────────────────────────────────────────────────────────────────────

/** What the real posture resolver must say of the rearranged rows: which conjunct the case removed. */
interface PosturePremise {
  teamId: string;
  memberId: string;
  is: ViewerPosture;
}
const aliceHere = (is: ViewerPosture): PosturePremise => ({ teamId: TEAM.id, memberId: ALICE_MEMBER, is });

interface Refusal {
  name: string;
  session: Session;
  /** Removes one conjunct from the healthy world. */
  arrange(): void;
  /** The prerequisite reads the owners issue before refusing, in order. */
  reads: string[];
  postures: PosturePremise[];
}

const UP_TO_TEAM = [SESSION_READ, SERVER_CLIENT, readTeam(TEAM.slug)];
const upToMember = (user: SessionUser) => [...UP_TO_TEAM, readMember(TEAM.id, user.id)];
const UP_TO_POSTURE = [...upToMember(ALICE), readPosture(TEAM.id, ALICE_MEMBER)];

const REFUSALS: Refusal[] = [
  {
    name: "no session cookie, with the team, membership, role and everyone row all standing",
    session: "none",
    arrange: () => undefined,
    reads: [SESSION_READ],
    postures: [aliceHere("team")],
  },
  {
    name: "a signed-in admin when no team row carries the slug (the team read is null)",
    session: "alice",
    arrange: () => {
      world.teams = world.teams.filter((row) => row.id !== TEAM.id);
    },
    reads: UP_TO_TEAM,
    postures: [aliceHere("team")],
  },
  {
    name: "a signed-in user with no membership row, the everyone row still standing",
    session: "alice",
    arrange: () => {
      world.members = world.members.filter((row) => row.id !== ALICE_MEMBER);
    },
    reads: upToMember(ALICE),
    postures: [aliceHere("team")],
  },
  {
    name: "an active admin membership that belongs to another team, the everyone row still standing",
    session: "alice",
    arrange: () => {
      aliceMembership().team_id = OTHER_TEAM.id;
    },
    reads: upToMember(ALICE),
    postures: [aliceHere("team")],
  },
  {
    name: "a healthy admin of another team (Bob) calling this team's slug",
    session: "bob",
    arrange: () => undefined,
    reads: upToMember(BOB),
    postures: [{ teamId: OTHER_TEAM.id, memberId: BOB_MEMBER, is: "team" }],
  },
  {
    name: "a disabled same-team admin membership, the everyone row still standing",
    session: "alice",
    arrange: () => {
      aliceMembership().status = "disabled";
    },
    reads: upToMember(ALICE),
    postures: [aliceHere("team")],
  },
  {
    name: "an invited same-team admin membership, the everyone row still standing",
    session: "alice",
    arrange: () => {
      aliceMembership().status = "invited";
    },
    reads: upToMember(ALICE),
    postures: [aliceHere("team")],
  },
  {
    name: "an active lead holding the team's builtin everyone row",
    session: "alice",
    arrange: () => {
      aliceMembership().role = "lead";
    },
    reads: UP_TO_POSTURE,
    postures: [aliceHere("team")],
  },
  {
    name: "an active member holding the team's builtin everyone row",
    session: "alice",
    arrange: () => {
      aliceMembership().role = "member";
    },
    reads: UP_TO_POSTURE,
    postures: [aliceHere("team")],
  },
  {
    name: "an active admin with no group membership at all",
    session: "alice",
    arrange: () => {
      world.group_members = world.group_members.filter((row) => row.member_id !== ALICE_MEMBER);
    },
    reads: UP_TO_POSTURE,
    postures: [aliceHere("external")],
  },
  {
    name: "an active admin holding only the team's builtin external group",
    session: "alice",
    arrange: () => {
      aliceEveryoneRow().group_id = TEAM_EXTERNAL;
    },
    reads: UP_TO_POSTURE,
    postures: [aliceHere("external")],
  },
  {
    name: "an active admin whose team's everyone-slug group is not builtin",
    session: "alice",
    arrange: () => {
      standing("groups", (row) => row.id === TEAM_EVERYONE).is_builtin = false;
    },
    reads: UP_TO_POSTURE,
    postures: [aliceHere("external")],
  },
  {
    name: "an active admin whose only builtin everyone row is bound to another team",
    session: "alice",
    arrange: () => {
      Object.assign(aliceEveryoneRow(), { team_id: OTHER_TEAM.id, group_id: OTHER_EVERYONE });
    },
    reads: UP_TO_POSTURE,
    // The row is a real builtin everyone row — for the other team only.
    postures: [aliceHere("external"), { teamId: OTHER_TEAM.id, memberId: ALICE_MEMBER, is: "team" }],
  },
];

const POSTURE_FAULTS = [
  { form: "returned error" as const, name: "the posture read returns an error envelope" },
  { form: "rejected read" as const, name: "the posture read itself rejects (synthetic form)" },
];

beforeAll(async () => {
  vi.stubEnv("AUTH_SECRET", AUTH_SECRET);
  tokens = { alice: await signSession(ALICE), bob: await signSession(BOB) };
});
afterAll(() => {
  vi.unstubAllEnvs();
});

beforeEach(() => {
  jar = null;
  world = healthyWorld();
  postureFault = null;
  postureRejection = new Error("AIO1217 synthetic posture read rejection");
  ledger.length = 0;

  h.cookies.mockReset();
  h.cookies.mockImplementation(async () => {
    // Bound to the request in flight when `cookies()` was called, not when it resolves.
    const requestJar = jar;
    if (!requestJar) throw new Error(`${FIXTURE} cookies() called with no request admitted`);
    return cookieStoreOver(requestJar);
  });
  h.serverClient.mockReset();
  h.serverClient.mockImplementation(async () => {
    ledger.push(SERVER_CLIENT);
    return serverDb;
  });
  h.adminClient.mockReset();
  h.adminClient.mockImplementation(() => {
    ledger.push(ADMIN_CLIENT);
    return privileged;
  });
  h.revalidatePath.mockReset();
  h.revalidatePath.mockImplementation((path: string) => {
    ledger.push(revalidated(path));
  });
  h.after.mockReset();
  h.after.mockImplementation(() => {
    ledger.push("effect:after");
  });
  for (const name of LOWER_NAMES) {
    LOWER[name].mockReset();
    LOWER[name].mockImplementation(async () => {
      ledger.push(lowerEffect(name));
      // Every surface reaches its owner once. A second call would mean an undrained backfill loop.
      if (ledger.filter((entry) => entry === lowerEffect(name)).length > 1) {
        throw new Error(`${FIXTURE} ${name} reached a second time in one request`);
      }
      return LOWER_RESULT[name]();
    });
  }
});

describe("X — fixture contract", () => {
  it("identities, tokens and inputs are what the cases call them", async () => {
    const ids = [
      TEAM.id,
      OTHER_TEAM.id,
      ALICE.id,
      BOB.id,
      ALICE_MEMBER,
      BOB_MEMBER,
      TEAM_EVERYONE,
      TEAM_EXTERNAL,
      OTHER_EVERYONE,
      ASSET_ID,
      POLICY_ID,
      CREATED_POLICY_ID,
    ];
    expect(new Set(ids).size, FIXTURE).toBe(ids.length);
    for (const id of ids) expect(id, FIXTURE).toMatch(UUID_V4);
    expect(TEAM.slug, FIXTURE).not.toBe(OTHER_TEAM.slug);

    await expect(verifySession(tokens.alice), FIXTURE).resolves.toStrictEqual(ALICE);
    await expect(verifySession(tokens.bob), FIXTURE).resolves.toStrictEqual(BOB);

    // The brand inputs pass the validators the mocked brand writers would have applied.
    expect(validateBrandProfile(BRAND_INPUT), FIXTURE).toEqual(BRAND_INPUT);
    expect(validateBrandAsset(ASSET_INPUT), FIXTURE).toEqual(ASSET_INPUT);
    // The policy writer's validator is not exported: these are the fixture's own shape checks only.
    expect(POLICY_INPUT.action.trim(), FIXTURE).not.toBe("");
    expect(POLICY_INPUT.action.startsWith("gateway."), FIXTURE).toBe(false);
    expect(["allow", "deny", "require_approval"], FIXTURE).toContain(POLICY_INPUT.effect);
    expect(Number.isInteger(POLICY_INPUT.priority), FIXTURE).toBe(true);
    expect(POLICY_INPUT.id, FIXTURE).toBeUndefined();
    expect(POLICY_UPDATE, FIXTURE).toStrictEqual({ ...POLICY_INPUT, id: POLICY_ID });
  });

  it("the guard substrate answers the owners' three statements over the healthy rows, records them, and refuses anything else", async () => {
    const team = await guardDb.from("teams").select("id").eq("slug", TEAM.slug).maybeSingle();
    const member = await guardDb
      .from("members")
      .select("id, role")
      .eq("team_id", TEAM.id)
      .eq("auth_user_id", ALICE.id)
      .eq("status", "active")
      .maybeSingle();
    const memberships = await guardDb
      .from("group_members")
      .select("group_id, groups(slug, is_builtin)")
      .eq("team_id", TEAM.id)
      .eq("member_id", ALICE_MEMBER);
    const stranger = await guardDb
      .from("members")
      .select("id, role")
      .eq("team_id", TEAM.id)
      .eq("auth_user_id", BOB.id)
      .eq("status", "active")
      .maybeSingle();

    expect({ team, member, memberships, stranger }, FIXTURE).toEqual({
      team: { data: { id: TEAM.id }, error: null, count: null },
      member: { data: { id: ALICE_MEMBER, role: "admin" }, error: null, count: null },
      memberships: {
        data: [{ group_id: TEAM_EVERYONE, groups: { slug: EVERYONE_SLUG, is_builtin: true } }],
        error: null,
        count: null,
      },
      stranger: { data: null, error: null, count: null },
    });
    expect(ledger, FIXTURE).toEqual([
      readTeam(TEAM.slug),
      readMember(TEAM.id, ALICE.id),
      readPosture(TEAM.id, ALICE_MEMBER),
      readMember(TEAM.id, BOB.id),
    ]);

    // A different select list, a missing filter, an unmodelled table and a write are all refused.
    const unmodelled = [
      () => guardDb.from("teams").select("*").eq("slug", TEAM.slug).maybeSingle(),
      () => guardDb.from("members").select("id, role").eq("team_id", TEAM.id).eq("auth_user_id", ALICE.id).maybeSingle(),
      () => guardDb.from("policies").select("id").eq("team_id", TEAM.id),
    ];
    for (const issue of unmodelled) {
      await expect(Promise.resolve().then(issue), FIXTURE).rejects.toThrow(/unmodelled statement/);
    }
    expect(() => guardDb.from("members").update({ role: "admin" }), FIXTURE).toThrow(/asked to update members/);
    expect(effects(), FIXTURE).toEqual(["effect:serverClient.update members"]);
  });

  it("the real posture resolver and admin predicate read the healthy rows the way the cases assume", async () => {
    await expect(resolveViewerPosture(guardDb, TEAM.id, ALICE_MEMBER), FIXTURE).resolves.toBe("team");
    await expect(resolveViewerPosture(guardDb, OTHER_TEAM.id, BOB_MEMBER), FIXTURE).resolves.toBe("team");
    // Bob holds no row in TEAM: the structurally absent row is external.
    await expect(resolveViewerPosture(guardDb, TEAM.id, BOB_MEMBER), FIXTURE).resolves.toBe("external");

    expect(
      {
        adminTeam: canAccessAdmin({ role: "admin", tier: "team" }),
        leadTeam: canAccessAdmin({ role: "lead", tier: "team" }),
        memberTeam: canAccessAdmin({ role: "member", tier: "team" }),
        adminExternal: canAccessAdmin({ role: "admin", tier: "external" }),
      },
      FIXTURE,
    ).toEqual({ adminTeam: true, leadTeam: false, memberTeam: false, adminExternal: false });
  });

  it("the privileged client is a trap: using it records the statement and throws", () => {
    expect(() => privileged.from("policies"), FIXTURE).toThrow(/privileged client was used/);
    expect(() => privileged.rpc("anything"), FIXTURE).toThrow(/privileged client was used/);
    expect(ledger, FIXTURE).toEqual(["effect:privileged.from policies", "effect:privileged.rpc anything"]);
  });
});

describe.each(SURFACES)("A — $key (team-admin gated)", (surface) => {
  const owner = LOWER[surface.lower];

  it("admitted control: a signed active admin holding the team's builtin everyone row succeeds, and the lower owner receives the privileged client with the server-resolved team and actor", async () => {
    beginRequest(tokens.alice);

    await expect(surface.invoke(TEAM.slug)).resolves.toStrictEqual(surface.admitted);

    // The identity came from this request's cookie; team, membership and posture were each read once.
    expect(reads()).toEqual(admittedReads(ALICE_ADMIN));
    expect(effects()).toEqual(admittedEffects(surface, TEAM));
    // Every prerequisite read precedes the first effect.
    expect(ledger).toEqual([...admittedReads(ALICE_ADMIN), ...admittedEffects(surface, TEAM)]);

    expect(owner.mock.calls).toEqual([[privileged, ...surface.ownerArgs(TEAM.id, ALICE_MEMBER)]]);
    expect(owner.mock.calls[0][0]).toBe(privileged);
    for (const name of LOWER_NAMES) {
      if (name !== surface.lower) expect(LOWER[name], name).not.toHaveBeenCalled();
    }
    expect(h.revalidatePath.mock.calls).toEqual(surface.revalidates ? [[surface.revalidates(TEAM.slug)]] : []);
    expect(h.after).not.toHaveBeenCalled();
  });

  it("the lower owner's team and actor are the ones the server resolved: Alice's session reaches her team, Bob's reaches his", async () => {
    beginRequest(tokens.alice);
    await expect(surface.invoke(TEAM.slug)).resolves.toStrictEqual(surface.admitted);
    expect(owner.mock.calls).toEqual([[privileged, ...surface.ownerArgs(TEAM.id, ALICE_MEMBER)]]);
    const aliceCall = JSON.stringify(owner.mock.calls);
    expect(aliceCall).not.toContain(OTHER_TEAM.id);
    expect(aliceCall).not.toContain(BOB_MEMBER);

    resetBetween();

    beginRequest(tokens.bob);
    await expect(surface.invoke(OTHER_TEAM.slug)).resolves.toStrictEqual(surface.admitted);
    expect(ledger).toEqual([...admittedReads(BOB_ADMIN), ...admittedEffects(surface, OTHER_TEAM)]);
    expect(owner.mock.calls).toEqual([[privileged, ...surface.ownerArgs(OTHER_TEAM.id, BOB_MEMBER)]]);
    const bobCall = JSON.stringify(owner.mock.calls);
    expect(bobCall).not.toContain(TEAM.id);
    expect(bobCall).not.toContain(ALICE_MEMBER);
  });

  it.each(REFUSALS)(
    "$name → admins only: only the prerequisite reads ran, and no privileged client, lower owner, revalidation or after",
    async ({ session, arrange, reads: prerequisites, postures }) => {
      await admittedAliceControl(surface);
      resetBetween();

      arrange();
      beginRequest(sessionCookie(session));

      await expect(surface.invoke(TEAM.slug)).resolves.toStrictEqual(ADMINS_ONLY);

      expect(reads()).toEqual(prerequisites);
      expect(ledger).toEqual(prerequisites);
      expectNoLowerEffect();

      // Which conjunct the case removed, in the real resolver's own words.
      for (const { teamId, memberId, is } of postures) {
        await expect(resolveViewerPosture(guardDb, teamId, memberId), FIXTURE).resolves.toBe(is);
      }
    },
  );

  it.each(POSTURE_FAULTS)(
    "$name after the session, team and active admin membership are admitted: the export rejects with the owner's fault — never `admins only`, never a result — and reaches no lower effect",
    async ({ form }) => {
      await admittedAliceControl(surface);
      resetBetween();

      postureFault = form;
      beginRequest(tokens.alice);

      const settled = await settle(surface.invoke(TEAM.slug));

      expect(settled).not.toHaveProperty("value");
      if (form === "rejected read") {
        expect(settled.thrown).toBe(postureRejection);
      } else {
        expect(settled.thrown).toBeInstanceOf(Error);
        expect((settled.thrown as Error).message).toBe(`posture read failed: ${POSTURE_FAULT}`);
      }

      // The fault came from the posture statement itself, issued for the resolved team and member.
      expect(reads()).toEqual(UP_TO_POSTURE);
      expect(ledger).toEqual(UP_TO_POSTURE);
      expectNoLowerEffect();
    },
  );
});

describe("B — app/t/[team]/admin/access/actions.ts runContextBackfillAction (one-batch control)", () => {
  it("drains from a null cursor with an ISO cutoff taken during the call, stops after exactly one batch, reports its aggregate and never revalidates", async () => {
    beginRequest(tokens.alice);

    const startedAt = Date.now();
    const result = await runContextBackfillAction(TEAM.slug);
    const finishedAt = Date.now();

    expect(result).toStrictEqual(BACKFILL_AGGREGATE);
    expect(h.backfillTeamContext).toHaveBeenCalledTimes(1);

    const [db, teamId, window] = h.backfillTeamContext.mock.calls[0] as [
      unknown,
      string,
      { afterId: string | null; createdBefore: string },
    ];
    expect(db).toBe(privileged);
    expect(teamId).toBe(TEAM.id);
    expect(Object.keys(window).sort()).toEqual(["afterId", "createdBefore"]);
    expect(window.afterId).toBeNull();
    expect(new Date(window.createdBefore).toISOString()).toBe(window.createdBefore);
    expect(Date.parse(window.createdBefore)).toBeGreaterThanOrEqual(startedAt);
    expect(Date.parse(window.createdBefore)).toBeLessThanOrEqual(finishedAt);

    expect(effects()).toEqual([ADMIN_CLIENT, lowerEffect("backfillTeamContext")]);
    expect(h.revalidatePath).not.toHaveBeenCalled();
    expect(h.after).not.toHaveBeenCalled();
  });
});
