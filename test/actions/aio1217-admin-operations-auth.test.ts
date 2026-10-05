import { createHash } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * AIO-1217 — FIVE ADMIN OPERATIONS, unit tier: the team-admin gate of five selected exports in two
 * modules, executed as the actual exported functions through the actual authority owner chain.
 *
 * Every expectation is read off the current sources named below. This file pins what those sources
 * do today — including the two refusal shapes, the fail-closed nulls, the propagated posture fault
 * and two recorded client-id limits — and specifies no new behavior, mapping or policy.
 *
 *   X — the fixture's own contract: identities, tokens and inputs are what the cases call them; the
 *       guard substrate answers the owners' three statements and nothing else; the privileged vault
 *       answers the four statements the admitted paths issue and nothing else.
 *   A — each export: an admitted control, the binding of the lower effect's team and actor to what
 *       the server resolved, every refusal, and the posture read fault.
 *   S — the two refusal shapes side by side.
 *   L — two client-supplied ids, recorded as current limits (pinned, not endorsed, not a pass).
 *   M — app/actions/projects.ts#createProjectAction (continuation; see TWO MEMBER-TIER EXPORTS).
 *   F — app/t/[team]/codebases/[slug]/actions.ts#recordFindingDecision (continuation; likewise).
 *   Z — the follow-up evidence this file does not supply, as executable TODOs, each naming the
 *       later batch that owns it.
 *
 * PER-EXPORT EVIDENCE RECORD. Key is `<repository path>#<export>`. Each of the five rows that
 * follow (the two member-tier rows have their own section further down) has the same guard —
 * ADM: a session the real verifier accepts, an active same-team membership, role admin, and
 * unrestricted membership-derived posture (the team's builtin everyone row) — through
 * `requireTeamAdmin` → `resolveIntegrationsAdmin` → `resolveViewerPosture` / `canAccessAdmin`. The
 * permitted prerequisite is the same for every row too: the session cookie read, the server client
 * and the owners' `teams`, `members` and `group_members` statements, as far as the chain gets. The
 * case names are the same for every row, under `A — <key> (team-admin gated)`:
 *     "admitted control: …"   "binding: …"   "<removed conjunct> → refused in this export's own
 *     shape: …" (13)   "<fault form> after the session, team and active admin membership are
 *     admitted: …" (2)
 *
 *   app/t/[team]/admin/pm-sync/actions.ts#projectBoardAction
 *     refusal            { ok: false, error: "admins only" }
 *     forbidden after    privileged client; the action's own `projects` read; projectAllTasks;
 *                        recordProjectionRun; `team.project_board` audit row; revalidation
 *     admitted control   two owned projects (a third belongs to another team), a configured provider
 *                        and three non-empty reports → projection per owned project, one recorded
 *                        run, one audit row, `/t/<slug>/admin/pm-sync` revalidated, exact result
 *     client ids         none beyond the slug
 *
 *   app/t/[team]/admin/pm-sync/actions.ts#reconcileDivergenceAction
 *     refusal            { ok: false, error: "admins only" }
 *     forbidden after    privileged client; reconcileProviderState; `team.reconcile_divergence`
 *                        audit row; revalidation
 *     admitted control   a configured provider, a non-zero seen count and one divergence → one
 *                        reconcile, one audit row, `/t/<slug>/admin/pm-sync` revalidated, exact result
 *     client ids         none beyond the slug
 *
 *   app/t/[team]/admin/actions.ts#getProvisioningAvailabilityAction
 *     refusal            [] — an empty list, not an object (the source's documented non-admin return)
 *     forbidden after    privileged client; getProvisioningAvailability (and the per-tool
 *                        integration and secret reads beneath it)
 *     admitted control   a non-empty per-tool list with configured entries, returned as given. The
 *                        wrapper has no audit and no revalidation; that is pinned as current.
 *     client ids         none beyond the slug
 *
 *   app/t/[team]/admin/actions.ts#issueApiKey
 *     refusal            { ok: false, error: "admins only" }
 *     forbidden after    privileged client; the real key primitive's `api_keys` insert;
 *                        `api_key.issued` audit row; revalidation; any raw key in the result
 *     admitted control   a same-team member id and a name → one `api_keys` row for the resolved team
 *                        holding only the hash, one audit row naming the resolved actor,
 *                        `/t/<slug>/admin/keys` revalidated, the raw key returned once
 *     client ids         `memberId` — NOT bound: forwarded as given, no lookup of that member. The
 *                        desired same-team target refusal is DEFERRED AIO-1226 and is neither
 *                        asserted nor implemented here. See L and Z.
 *
 *   app/t/[team]/admin/actions.ts#revokeApiKey
 *     refusal            { ok: false, error: "admins only" }
 *     forbidden after    privileged client; the real key primitive's `api_keys` update;
 *                        `api_key.revoked` audit row; revalidation
 *     admitted control   an owned key id → that row's `revoked_at` set under an (id, team) predicate,
 *                        the other team's key untouched, one audit row, `/t/<slug>/admin/keys`
 *                        revalidated
 *     client ids         `apiKeyId` — team-bound at the statement only; a zero-row revoke still
 *                        reports success and audits. Not certified beyond the registered
 *                        conjunction. See L.
 *
 * `inviteMember`, the fourth export of app/t/[team]/admin/actions.ts, is deliberately NOT exercised:
 * it is a later compensating-flow family. Its lower owners are tripwires here.
 *
 * TWO MEMBER-TIER EXPORTS (bounded continuation; groups M and F). Neither is ADM: both go through
 * `lib/auth/guard` `currentMember` — a session the real verifier accepts and an active membership
 * of the team, with posture resolved by `resolveViewerPosture` — and neither policy is changed,
 * tightened or reinterpreted here. Their real-Postgres complement is
 * test/datamechanics/aio1217-project-finding-auth.datamechanics.test.ts; everything in THIS file is
 * unit and recording evidence.
 *
 *   app/actions/projects.ts#createProjectAction
 *     guard              MEM: session + active same-team membership. NO role and NO posture
 *                        conjunct — an ordinary member creates, and so does an external-posture one.
 *     admitted before    name/slug validation (before any identity read); then the cookie read, the
 *                        server client and the `members` and `group_members` statements
 *     refusal            { ok: false, error: "not a member of this team" }
 *     forbidden after    the second server-client acquisition; the action's own `projects` insert;
 *                        the creator grant (`ensurePersonSingleton`, `grantProjectToGroup`);
 *                        `ensureProjectGraphPointer`
 *     admitted control   an ordinary member (role member, builtin everyone row) and a valid name →
 *                        one `projects` row for the requested team with the server-derived slug and
 *                        kind `initiative`, then the creator singleton and grant for the
 *                        server-resolved member, then the graph pointer — in that order — and the
 *                        exact `{ ok, project }` result. No privileged client, audit row or
 *                        revalidation is this action's own.
 *     client ids         `teamId` — the team is the client's, admitted only by the caller's own
 *                        active membership read under that id; nothing else is supplied.
 *     cases (group M)    "admitted control: …"   "<role or posture> → admitted identically: …" (4)
 *                        "binding: …"   "<removed conjunct> → refused as `not a member of this
 *                        team`: …" (6)   "<fault form> after the session and active membership are
 *                        admitted: …" (2)   "an empty or unsluggable name …"
 *
 *   app/t/[team]/codebases/[slug]/actions.ts#recordFindingDecision
 *     guard              LEAD (tier=team): session + active same-team membership + role admin OR
 *                        lead + team posture (the builtin everyone row), all three inline after
 *                        `currentMember`
 *     admitted before    schema validation; the server client and the `teams` read by slug — issued
 *                        BEFORE the caller is identified, so `team not found` is reachable with no
 *                        session (pinned as current); then the cookie read, a second server client
 *                        and the `members` and `group_members` statements
 *     refusal            { ok: false, error: "team leads or admins only" }
 *     forbidden after    `getCodebaseIdentity` (its `codebases` read); the privileged client; the
 *                        `decide_codebase_finding` rpc; the `codebase_finding.decision` audit row;
 *                        revalidation
 *     admitted control   an admin, and a lead, each holding the builtin everyone row, an owned
 *                        codebase and finding → the identity read bound to the resolved team, one
 *                        rpc carrying the resolved team, codebase and actor, one audit row,
 *                        `/t/<slug>/codebases/<codebase>` revalidated, `{ ok: true }`
 *     client ids         `codebaseSlug` — team-bound at the identity read (another team's slug is
 *                        `codebase not found`). `findingId`, `ownerMemberId` — forwarded as given;
 *                        their binding is the SQL function's own and is NOT exercised here (the rpc
 *                        double implements none of its predicates). See the Postgres fixture.
 *     cases (group F)    "admitted control: …" (2)   "binding: …"   "<removed membership conjunct>
 *                        → refused as `team leads or admins only`: …" (6)   "<removed role or
 *                        posture conjunct> → refused …" (6)   "<fault form> after the session and
 *                        active membership are admitted: …" (2)   "after admission, a codebase slug
 *                        only the other team holds …"   "before any identity read: …"
 *
 * What is real, and never mocked or handed a verdict: the five exports; `lib/auth/guard`
 * `requireTeamAdmin`; `lib/auth/session` `getSessionUser`; `lib/auth/pg-session`
 * `signSession`/`verifySession` (jose HS256 against AUTH_SECRET); `lib/integrations/read`
 * `resolveIntegrationsAdmin`; `lib/access/posture` `resolveViewerPosture`; `lib/auth/admin-access`
 * `canAccessAdmin`; `lib/admin/keys` `issueApiKey`/`revokeApiKey` (node:crypto included); and
 * `lib/api/audit` `audit`. A caller is admitted only by a cookie the real verifier accepts and rows
 * the real owners read and judge themselves. For M and F, additionally real: the two exports;
 * `lib/auth/guard` `currentMember`; `lib/ids` `slugify`; `lib/metrics/codebases`
 * `getCodebaseIdentity` with `lib/codebases/visibility` `canSeeCodebases`; and
 * `lib/codebases/finding-ledger` `findingDecisionSchema` and `decideCodebaseFinding`.
 *
 * The synthetic seams, all of them:
 *   SEAM cookies     `next/headers` `cookies` — async, resolves a recording store over a per-request Map.
 *   SEAM server db   `@/lib/db/server` `serverClient` — records, then hands the owners the guard
 *                    substrate described below. It is the only thing the authority chain reads.
 *   SEAM admin db    `@/lib/db/admin` `adminClient` — records, then returns the privileged vault
 *                    described below. A refused call must not even acquire it.
 *   SEAM lower       three modules replaced whole by exactly the exports the action files import
 *                    from them: `@/lib/pm-sync` `projectAllTasks`, `recordProjectionRun`;
 *                    `@/lib/pm-sync/reconcile` `reconcileProviderState`; `@/lib/provisioning/run`
 *                    `getProvisioningAvailability`. Each records its arguments and returns a fixed
 *                    healthy result keyed by the team or project it was handed.
 *   SEAM revalidate  `next/cache` `revalidatePath` — records the path.
 *   SEAM tripwires   `next/server` `after`; `next/headers` `headers`; global `fetch`; and the invite
 *                    family's owners (`@/lib/admin/members`, `@/lib/admin/invite`,
 *                    `@/lib/auth/mailer`, `@/lib/graph/company-actors`). Each records and throws.
 *                    None of the five exports reaches one today, so their zero is a tripwire, not
 *                    behavior.
 *   SEAM member lower  (M only) `@/lib/access/groups` is the ORIGINAL module with two exports
 *                    replaced by recording doubles — `ensurePersonSingleton`, `grantProjectToGroup`
 *                    — so the slug constants the real posture resolver imports from it are
 *                    untouched; `@/lib/graph/project-pointer` is replaced whole by its one export,
 *                    `ensureProjectGraphPointer`. Each records its arguments and returns a healthy
 *                    result. The groups single writer and the pointer writer are therefore NOT
 *                    executed here: that is the Postgres fixture's evidence.
 * AUTH_SECRET is a synthetic value stubbed for this file and restored afterwards.
 *
 * THE DESK (M and F) holds the synthetic rows of three further statements, each recorded as an
 * `effect:` — never a `read:` — so the five ADM families' ledger equalities would still show one:
 * through the server client, the project action's own `projects` insert (returning id, slug, name)
 * and `getCodebaseIdentity`'s `codebases` id read by team and slug; through the privileged client,
 * the `decide_codebase_finding` rpc. The insert double mints an id and has no unique constraint;
 * the rpc double binds the finding by (id, team, codebase) and implements none of the SQL
 * function's own predicates. Every other write through the server client, and every other rpc,
 * still fails a fixture premise.
 *
 * THE GUARD SUBSTRATE holds synthetic `teams`, `members`, `groups` and `group_members` rows and
 * admits exactly the three statements the owners issue: `teams` by slug (maybeSingle), `members` by
 * team, auth user and active status (maybeSingle), and `group_members` by team and member with the
 * `groups(slug, is_builtin)` embed (list). Equality filters are really applied to the rows, so a
 * refusal is the owner's own predicate missing, not a canned answer. Any other table, select list,
 * filter set, terminal or write fails a fixture premise.
 *
 * THE PRIVILEGED VAULT holds synthetic `projects`, `api_keys` and `audit_log` rows and admits
 * exactly four statements: `projects` id by team (list — the board action's own read), `api_keys`
 * insert, `api_keys` update by id and team, and `audit_log` insert. Filters are really applied and
 * writes really land in the rows, so "the other team's key is untouched" is a row comparison.
 *
 * One ordered ledger takes everything observable. `read:` entries are the permission prerequisites;
 * `effect:` entries are everything else (admin client, vault statements, lower owners, revalidation,
 * tripwires, cookie mutations, a write through the server client). Admitted calls are asserted as
 * one sequence, so "nothing else happened" is an equality, not missing spies.
 *
 * Each refusal first runs the admitted control in the same test, then clears the ledger and every
 * recording and restores the healthy rows and vault. A refusal then removes ONE conjunct — from the
 * request's session or from the healthy rows — and keeps every lower owner armed to succeed: had the
 * gate admitted the call, the ledger and the vault would show it.
 *
 * Bounds of what is claimed.
 *   - Seven selected exports only (five ADM, two member-tier). Not a census, not final acceptance of
 *     any AIO-1217 criterion, not the 95-action or 15-connection evidence, and nothing about
 *     AIO-1225, AIO-1227 or AIO-1228. For AIO-1226 it records the existing limit only.
 *   - M and F: the creator grant, the graph pointer, the `projects` unique constraint and the
 *     decision function are doubles here. This file proves which call each export makes, for which
 *     team and member, and that a refused caller reaches none of them — not that Postgres accepts
 *     or constrains any of it.
 *   - UNIT AND RECORDING ONLY. Neither double is PostgreSQL or the pg adapter: no SQL, no join, no
 *     foreign key, no constraint, no concurrency. Rows are not schema-checked.
 *   - The PM, reconcile and availability doubles are wiring evidence. Provider resolution, task
 *     selection, the provider transport, `ingest_runs`, `task_pm_links` and the integration and
 *     secret reads all live beneath them and are not executed. "Configured provider" and "non-empty
 *     report" are what the double returns, chosen so the admitted control cannot be an early return.
 *   - The key primitives and the audit writer are real down to the vault. That proves which
 *     statements they issue for which team, member and actor — not that Postgres accepts them.
 *     The raw key is a throwaway random value generated inside the test process.
 *   - Calling an exported function against doubles proves nothing about the Next action wire.
 *   - The rejected-read form of the posture fault is synthetic: `DbResult` documents an envelope
 *     that never rejects. The returned-error form is the adapter-shaped one.
 *
 * Run status at authoring: NOT RUN. This file was written without executing vitest, tsc or any other
 * command. Its expectations come from reading the sources above, not from an observed run; replace
 * this paragraph with the observed result once it has been executed. The M and F groups, the desk
 * and the member-lower seam were added by a later writer under the same condition: NOT RUN.
 */

const FIXTURE = "FIXTURE PREMISE FAILED (setup, not a security observation):";
const CONTROL = "PRECEDING ADMITTED CONTROL FAILED (the refusal below would be vacuous):";

const h = vi.hoisted(() => {
  const inviteFamily = vi.fn();
  return {
    /** SEAM cookies: the async `cookies()` of this request. */
    cookies: vi.fn(),
    /** SEAM server db: hands the owners the guard substrate. */
    serverClient: vi.fn(),
    /** SEAM admin db: hands out the privileged vault. */
    adminClient: vi.fn(),
    /** SEAM revalidate. */
    revalidatePath: vi.fn(),
    /** SEAM lower: the four recording owners. */
    projectAllTasks: vi.fn(),
    recordProjectionRun: vi.fn(),
    reconcileProviderState: vi.fn(),
    getProvisioningAvailability: vi.fn(),
    /** SEAM member lower: the creator grant's two owners and the graph pointer writer. */
    ensurePersonSingleton: vi.fn(),
    grantProjectToGroup: vi.fn(),
    ensureProjectGraphPointer: vi.fn(),
    /** SEAM tripwires. */
    after: vi.fn(),
    headers: vi.fn(),
    fetch: vi.fn(),
    inviteFamily,
    /** One named entry into the invite family's tripwire. */
    inviteOwner:
      (name: string) =>
      (...args: unknown[]): unknown =>
        inviteFamily(name, ...args),
  };
});

vi.mock("next/headers", () => ({ cookies: h.cookies, headers: h.headers }));
vi.mock("next/cache", () => ({ revalidatePath: h.revalidatePath }));
vi.mock("next/server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/server")>()),
  after: h.after,
}));
vi.mock("@/lib/db/server", () => ({ serverClient: h.serverClient }));
vi.mock("@/lib/db/admin", () => ({ adminClient: h.adminClient }));
vi.mock("@/lib/pm-sync", () => ({
  projectAllTasks: h.projectAllTasks,
  recordProjectionRun: h.recordProjectionRun,
}));
vi.mock("@/lib/pm-sync/reconcile", () => ({ reconcileProviderState: h.reconcileProviderState }));
vi.mock("@/lib/provisioning/run", () => ({ getProvisioningAvailability: h.getProvisioningAvailability }));
vi.mock("@/lib/admin/members", () => ({
  createMember: h.inviteOwner("createMember"),
  rollbackMemberCreation: h.inviteOwner("rollbackMemberCreation"),
  isValidInviteEmail: h.inviteOwner("isValidInviteEmail"),
  MemberExistsError: class MemberExistsError extends Error {},
}));
vi.mock("@/lib/admin/invite", () => ({ issueMemberInvite: h.inviteOwner("issueMemberInvite") }));
vi.mock("@/lib/auth/mailer", () => ({ magicLinkAvailable: h.inviteOwner("magicLinkAvailable") }));
vi.mock("@/lib/graph/company-actors", () => ({ syncMemberActor: h.inviteOwner("syncMemberActor") }));
// The original module, with only the creator grant's two owners replaced.
vi.mock("@/lib/access/groups", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/access/groups")>()),
  ensurePersonSingleton: h.ensurePersonSingleton,
  grantProjectToGroup: h.grantProjectToGroup,
}));
vi.mock("@/lib/graph/project-pointer", () => ({ ensureProjectGraphPointer: h.ensureProjectGraphPointer }));

import { createProjectAction } from "@/app/actions/projects";
import {
  getProvisioningAvailabilityAction,
  issueApiKey,
  revokeApiKey,
  type ProvisioningAvailability,
} from "@/app/t/[team]/admin/actions";
import { projectBoardAction, reconcileDivergenceAction } from "@/app/t/[team]/admin/pm-sync/actions";
import { recordFindingDecision } from "@/app/t/[team]/codebases/[slug]/actions";
import { resolveViewerPosture, type ViewerPosture } from "@/lib/access/posture";
import { EVERYONE_SLUG, EXTERNAL_SLUG } from "@/lib/access/system-projects";
import { canAccessAdmin } from "@/lib/auth/admin-access";
import { signSession, verifySession, type SessionUser } from "@/lib/auth/pg-session";
import { findingDecisionSchema, type FindingDecision } from "@/lib/codebases/finding-ledger";
import type { DbClient } from "@/lib/db/types";
import { slugify } from "@/lib/ids";
import type { ProjectionReport } from "@/lib/pm-sync";
import type { ReconcileResult } from "@/lib/pm-sync/reconcile";

type Row = Record<string, unknown>;
type Envelope = { data: unknown; error: { message: string } | null; count: number | null };

const AUTH_SECRET = "aio1217-admin-operations-auth-secret-not-for-production";
const SESSION_COOKIE = "aios_session";
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

interface Team {
  id: string;
  slug: string;
}

const TEAM: Team = { id: "12170000-0000-4000-8000-0000000002a1", slug: "aio1217-admin-ops" };
const OTHER_TEAM: Team = { id: "12170000-0000-4000-8000-0000000002b1", slug: "aio1217-admin-ops-other" };

const ALICE: SessionUser = { id: "12170000-0000-4000-8000-0000000002a2", email: "alice.aio1217.ops@fixture.test" };
const BOB: SessionUser = { id: "12170000-0000-4000-8000-0000000002b2", email: "bob.aio1217.ops@fixture.test" };
const ALICE_MEMBER = "12170000-0000-4000-8000-0000000002a3";
const BOB_MEMBER = "12170000-0000-4000-8000-0000000002b3";
/** An ordinary active member of TEAM: the same-team target Alice issues a key for. Never signs in. */
const CAROL_USER = "12170000-0000-4000-8000-0000000002a6";
const CAROL_MEMBER = "12170000-0000-4000-8000-0000000002a7";

const TEAM_EVERYONE = "12170000-0000-4000-8000-0000000002a4";
const TEAM_EXTERNAL = "12170000-0000-4000-8000-0000000002a5";
const OTHER_EVERYONE = "12170000-0000-4000-8000-0000000002b4";

/** Synthetic rows the vault designates as owned by TEAM, and by OTHER_TEAM. */
const PROJECT_ONE = "12170000-0000-4000-8000-0000000002c1";
const PROJECT_TWO = "12170000-0000-4000-8000-0000000002c2";
const OWNED_KEY = "12170000-0000-4000-8000-0000000002c3";
const OTHER_PROJECT = "12170000-0000-4000-8000-0000000002d1";
const OTHER_KEY = "12170000-0000-4000-8000-0000000002d2";

const KEY_NAME = "Fixture key";
/** `aios_<12 hex key id>_<43 base64url secret>` — the shape lib/admin/keys documents and returns once. */
const RAW_KEY = /^aios_([0-9a-f]{12})_([A-Za-z0-9_-]{43})$/;

const PROVIDER = "linear";

/** What the projection double reports per project: a configured provider and non-empty reports. */
const REPORTS: Record<string, ProjectionReport[]> = {
  [PROJECT_ONE]: [
    { row_key: "AIO1217-FIX-1", provider: PROVIDER, status: "synced", providerResourceId: "fixture-issue-1" },
    { row_key: "AIO1217-FIX-2", provider: PROVIDER, status: "skipped", providerResourceId: "fixture-issue-2" },
  ],
  [PROJECT_TWO]: [
    { row_key: "AIO1217-FIX-3", provider: PROVIDER, status: "synced", providerResourceId: "fixture-issue-3" },
  ],
  [OTHER_PROJECT]: [
    { row_key: "AIO1217-OTHER-1", provider: PROVIDER, status: "synced", providerResourceId: "fixture-issue-9" },
  ],
};

/** What the reconcile double reports per team: a provider, a non-zero seen count and a divergence. */
const RECONCILED: Record<string, ReconcileResult> = {
  [TEAM.id]: {
    provider: PROVIDER,
    seenUpdated: 2,
    divergences: [
      {
        row_key: "AIO1217-FIX-1",
        provider: PROVIDER,
        last_projected_status: "in_progress",
        provider_seen_status: "done",
      },
    ],
  },
  [OTHER_TEAM.id]: {
    provider: PROVIDER,
    seenUpdated: 1,
    divergences: [
      {
        row_key: "AIO1217-OTHER-1",
        provider: PROVIDER,
        last_projected_status: "todo",
        provider_seen_status: "in_progress",
      },
    ],
  },
};

/** What the availability double reports per team: one entry per tool, some configured. */
const AVAILABILITY: Record<string, ProvisioningAvailability> = {
  [TEAM.id]: [
    { tool: "linear", configured: true },
    { tool: "slack", configured: false, reason: "no Slack invite link set" },
    { tool: "github", configured: true },
  ],
  [OTHER_TEAM.id]: [
    { tool: "linear", configured: false, reason: "no enabled Linear integration" },
    { tool: "slack", configured: true },
    { tool: "github", configured: false, reason: "no GitHub org set" },
  ],
};

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

/** An admin together with what their team owns in the vault and the ids they would supply. */
interface Realm {
  who: Principal;
  /** The projects the vault holds for this team, in vault order. */
  projects: string[];
  /** The per-status tally of this team's reports, written out by hand. */
  boardCounts: Record<string, number>;
  /** A member of this team to issue a key for. */
  keyTarget: string;
  /** A key row the vault holds for this team. */
  ownedKey: string;
}
const ALICE_REALM: Realm = {
  who: ALICE_ADMIN,
  projects: [PROJECT_ONE, PROJECT_TWO],
  boardCounts: { synced: 2, skipped: 1 },
  keyTarget: CAROL_MEMBER,
  ownedKey: OWNED_KEY,
};
const BOB_REALM: Realm = {
  who: BOB_ADMIN,
  projects: [OTHER_PROJECT],
  boardCounts: { synced: 1 },
  keyTarget: BOB_MEMBER,
  ownedKey: OTHER_KEY,
};
/** Every id a realm's admitted calls may carry: the other realm's trace must hold none of them. */
const realmIds = (realm: Realm) => [
  realm.who.team.id,
  realm.who.memberId,
  ...realm.projects,
  realm.keyTarget,
  realm.ownedKey,
];
const boardReports = (realm: Realm) => realm.projects.flatMap((projectId) => REPORTS[projectId]);

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
const ownedProjectsRead = (teamId: string) => `effect:privileged projects.select team_id=${teamId}`;
const keyInserted = (teamId: string, memberId: string) =>
  `effect:privileged api_keys.insert team_id=${teamId} member_id=${memberId}`;
const keyRevoked = (teamId: string, apiKeyId: string) =>
  `effect:privileged api_keys.update id=${apiKeyId} team_id=${teamId}`;
const audited = (action: string) => `effect:privileged audit_log.insert action=${action}`;
const projected = (teamId: string, projectId: string) =>
  `effect:lower projectAllTasks team_id=${teamId} project_id=${projectId}`;
const projectionRecorded = (teamId: string) => `effect:lower recordProjectionRun team_id=${teamId}`;
const reconciled = (teamId: string) => `effect:lower reconcileProviderState team_id=${teamId}`;
const availabilityRead = (teamId: string) => `effect:lower getProvisioningAvailability team_id=${teamId}`;
const revalidated = (path: string) => `effect:revalidatePath ${path}`;

const pmSyncPath = (teamSlug: string) => `/t/${teamSlug}/admin/pm-sync`;
const keysPath = (teamSlug: string) => `/t/${teamSlug}/admin/keys`;

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
      { id: CAROL_MEMBER, team_id: TEAM.id, auth_user_id: CAROL_USER, role: "member", status: "active" },
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

/** The one write the server client admits: the project action's own insert, returning the new row. */
interface ProjectInsert {
  select(spec?: string): ProjectInsert;
  single(): Promise<Envelope>;
}

interface GuardChain extends PromiseLike<Envelope> {
  select(spec?: string): GuardChain;
  eq(column: string, value: unknown): GuardChain;
  maybeSingle(): Promise<Envelope>;
  /** Refused for every table but `projects` (the desk, below). */
  insert(values: unknown): ProjectInsert;
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
      // The desk's one read: recorded as an effect, since it follows admission.
      if (table === "codebases") {
        if (select !== "id" || terminal !== "maybeSingle" || [...columns].sort().join() !== "slug,team_id") {
          throw new Error(`${FIXTURE} unmodelled statement on ${table}: ${issued}`);
        }
        return codebaseIdentity(new Map(filters));
      }
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
      insert: (values) => (table === "projects" ? projectInsert(values) : refuseWrite("insert")()),
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

/** The one standing row a case rearranges. Throws when the healthy world is not as the case assumes. */
function standing(table: keyof World, where: (row: Row) => boolean): Row {
  const found = world[table].filter(where);
  if (found.length !== 1) throw new Error(`${FIXTURE} expected exactly one ${table} row to rearrange, found ${found.length}`);
  return found[0];
}
const aliceMembership = () => standing("members", (row) => row.id === ALICE_MEMBER);
const aliceEveryoneRow = () => standing("group_members", (row) => row.member_id === ALICE_MEMBER);

// ── the privileged vault ─────────────────────────────────────────────────────────────────────────

interface Vault {
  projects: Row[];
  api_keys: Row[];
  audit_log: Row[];
}

/** TEAM owns two projects and one live key; OTHER_TEAM owns one of each; nothing is audited yet. */
function standingVault(): Vault {
  return {
    projects: [
      { id: PROJECT_ONE, team_id: TEAM.id },
      { id: PROJECT_TWO, team_id: TEAM.id },
      { id: OTHER_PROJECT, team_id: OTHER_TEAM.id },
    ],
    api_keys: [
      { id: OWNED_KEY, team_id: TEAM.id, member_id: CAROL_MEMBER, name: "Fixture standing key", revoked_at: null },
      { id: OTHER_KEY, team_id: OTHER_TEAM.id, member_id: BOB_MEMBER, name: "Fixture other key", revoked_at: null },
    ],
    audit_log: [],
  };
}

let vault: Vault = standingVault();
/** The key rows an admitted issue added to the standing ones. */
const issuedKeyRows = () => vault.api_keys.slice(standingVault().api_keys.length);

interface VaultStatement {
  select: string | null;
  filters: string[];
  /** Records the statement, applies it to the vault and returns its data. */
  apply(issued: { bound: Map<string, unknown>; matches(row: Row): boolean; written: Row }): unknown;
}

/**
 * The four statements the admitted paths issue against the privileged client, as read from the
 * pm-sync action (its own `projects` read), lib/admin/keys and lib/api/audit.
 */
const VAULT_STATEMENTS: Record<string, VaultStatement> = {
  "projects.select": {
    select: "id",
    filters: ["team_id"],
    apply: ({ bound, matches }) => {
      ledger.push(ownedProjectsRead(String(bound.get("team_id"))));
      return vault.projects.filter(matches).map((row) => ({ id: row.id }));
    },
  },
  "api_keys.insert": {
    select: null,
    filters: [],
    apply: ({ written }) => {
      ledger.push(keyInserted(String(written.team_id), String(written.member_id)));
      vault.api_keys.push({ id: `fixture-issued-key-row-${vault.api_keys.length + 1}`, ...written, revoked_at: null });
      return null;
    },
  },
  "api_keys.update": {
    select: null,
    filters: ["id", "team_id"],
    apply: ({ bound, matches, written }) => {
      ledger.push(keyRevoked(String(bound.get("team_id")), String(bound.get("id"))));
      for (const row of vault.api_keys.filter(matches)) Object.assign(row, written);
      return null;
    },
  },
  "audit_log.insert": {
    select: null,
    filters: [],
    apply: ({ written }) => {
      ledger.push(audited(String(written.action)));
      vault.audit_log.push({ ...written });
      return null;
    },
  },
};

interface VaultChain extends PromiseLike<Envelope> {
  select(spec?: string): VaultChain;
  insert(values: unknown): VaultChain;
  update(values: unknown): VaultChain;
  eq(column: string, value: unknown): VaultChain;
  upsert(values: unknown): never;
  delete(): never;
  single(): never;
  maybeSingle(): never;
}

/**
 * SEAM admin db: what `adminClient()` returns. Every statement is recorded as an effect. `audit` is
 * best-effort and swallows a throw, so an unmodelled statement is recorded before it throws: the
 * ledger equality of every admitted case would still show it.
 */
const privileged = {
  from(table: string): VaultChain {
    let operation: "select" | "insert" | "update" = "select";
    let select: string | null = null;
    let written: Row = {};
    const filters: Array<[string, unknown]> = [];

    const refuse = (method: string) => (): never => {
      ledger.push(`effect:privileged.${method} ${table}`);
      throw new Error(`${FIXTURE} the privileged client was asked to ${method} ${table}`);
    };

    const run = async (): Promise<Envelope> => {
      const columns = filters.map(([column]) => column);
      const issued = `${table}.${operation}(${select ?? ""}) eq(${columns.join(", ")})`;
      const statement: VaultStatement | undefined = VAULT_STATEMENTS[`${table}.${operation}`];
      const sameFilters =
        statement !== undefined && [...columns].sort().join() === [...statement.filters].sort().join();
      if (!statement || select !== statement.select || !sameFilters) {
        ledger.push(`effect:privileged unmodelled ${issued}`);
        throw new Error(`${FIXTURE} unmodelled privileged statement: ${issued}`);
      }
      const data = statement.apply({
        bound: new Map(filters),
        matches: (row) => filters.every(([column, value]) => row[column] === value),
        written,
      });
      return { data, error: null, count: null };
    };

    const chain: VaultChain = {
      select: (spec) => {
        select = spec ?? "*";
        return chain;
      },
      insert: (values) => {
        operation = "insert";
        written = values as Row;
        return chain;
      },
      update: (values) => {
        operation = "update";
        written = values as Row;
        return chain;
      },
      eq: (column, value) => {
        filters.push([column, value]);
        return chain;
      },
      upsert: refuse("upsert"),
      delete: refuse("delete"),
      single: refuse("single"),
      maybeSingle: refuse("maybeSingle"),
      then: (onfulfilled, onrejected) => run().then(onfulfilled, onrejected),
    };
    return chain;
  },
  rpc(fn: string): never {
    ledger.push(`effect:privileged.rpc ${fn}`);
    throw new Error(`${FIXTURE} the privileged client was asked to call ${fn}`);
  },
};
/** The vault as the real lower owners take it, for the fixture-contract case that issues statements. */
const vaultDb = privileged as unknown as DbClient;

/** The `audit_log` row the real audit writer builds for an action taken by `who`. */
const auditRow = (
  who: Principal,
  entry: { action: string; target_type: string; target_id: string; meta: Row },
): Row => ({
  team_id: who.team.id,
  actor_kind: "member",
  member_id: who.memberId,
  api_key_id: null,
  ip: null,
  ...entry,
});

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

// ── the five exports ─────────────────────────────────────────────────────────────────────────────

const LOWER = [h.projectAllTasks, h.recordProjectionRun, h.reconcileProviderState, h.getProvisioningAvailability];
const TRIPWIRES = [h.after, h.headers, h.fetch, h.inviteFamily];

interface Surface {
  /** The canonical `<repository path>#<export>` this group exercises. */
  key: string;
  /** What this export returns to a caller the gate refuses. */
  refusal: unknown;
  /** The actual export, called with the valid input a realm's admin would supply. */
  invoke(realm: Realm): Promise<unknown>;
  /** What an admitted call resolves to. */
  admitted(realm: Realm): unknown;
  /** The effects of an admitted call, in order, starting with the privileged client. */
  effects(realm: Realm): string[];
  /** What the lower owners received and what the vault holds after an admitted call. */
  observe(realm: Realm, result: unknown): void;
}

const AVAILABILITY_KEY = "app/t/[team]/admin/actions.ts#getProvisioningAvailabilityAction";

const SURFACES: Surface[] = [
  {
    key: "app/t/[team]/admin/pm-sync/actions.ts#projectBoardAction",
    refusal: ADMINS_ONLY,
    invoke: ({ who }) => projectBoardAction(who.team.slug),
    admitted: (realm) => ({ ok: true, provider: PROVIDER, counts: realm.boardCounts, reports: boardReports(realm) }),
    effects: ({ who, projects }) => [
      ADMIN_CLIENT,
      ownedProjectsRead(who.team.id),
      ...projects.map((projectId) => projected(who.team.id, projectId)),
      projectionRecorded(who.team.id),
      audited("team.project_board"),
      revalidated(pmSyncPath(who.team.slug)),
    ],
    observe: (realm) => {
      const { who, projects, boardCounts } = realm;
      // Projection ran once per project the team owns, and only for those.
      expect(h.projectAllTasks.mock.calls).toEqual(projects.map((projectId) => [privileged, who.team.id, projectId]));
      expect(h.recordProjectionRun.mock.calls).toEqual([
        [
          privileged,
          {
            teamId: who.team.id,
            provider: PROVIDER,
            trigger: "manual",
            reports: boardReports(realm),
            reason: undefined,
            startedAt: expect.any(Number),
          },
        ],
      ]);
      expect(vault.audit_log).toEqual([
        auditRow(who, {
          action: "team.project_board",
          target_type: "team",
          target_id: who.team.id,
          meta: { provider: PROVIDER, counts: boardCounts },
        }),
      ]);
    },
  },
  {
    key: "app/t/[team]/admin/pm-sync/actions.ts#reconcileDivergenceAction",
    refusal: ADMINS_ONLY,
    invoke: ({ who }) => reconcileDivergenceAction(who.team.slug),
    admitted: ({ who }) => ({ ok: true, ...RECONCILED[who.team.id] }),
    effects: ({ who }) => [
      ADMIN_CLIENT,
      reconciled(who.team.id),
      audited("team.reconcile_divergence"),
      revalidated(pmSyncPath(who.team.slug)),
    ],
    observe: ({ who }) => {
      const { seenUpdated, divergences } = RECONCILED[who.team.id];
      expect(h.reconcileProviderState.mock.calls).toEqual([[privileged, who.team.id]]);
      expect(vault.audit_log).toEqual([
        auditRow(who, {
          action: "team.reconcile_divergence",
          target_type: "team",
          target_id: who.team.id,
          meta: { provider: PROVIDER, seenUpdated, divergences: divergences.length },
        }),
      ]);
    },
  },
  {
    key: AVAILABILITY_KEY,
    refusal: [],
    invoke: ({ who }) => getProvisioningAvailabilityAction(who.team.slug),
    admitted: ({ who }) => AVAILABILITY[who.team.id],
    // The wrapper neither audits nor revalidates.
    effects: ({ who }) => [ADMIN_CLIENT, availabilityRead(who.team.id)],
    observe: ({ who }) => {
      expect(h.getProvisioningAvailability.mock.calls).toEqual([[privileged, who.team.id]]);
      expect(vault.audit_log).toEqual([]);
    },
  },
  {
    key: "app/t/[team]/admin/actions.ts#issueApiKey",
    refusal: ADMINS_ONLY,
    invoke: ({ who, keyTarget }) => issueApiKey(who.team.slug, keyTarget, KEY_NAME),
    admitted: () => ({ ok: true, key: expect.stringMatching(RAW_KEY) }),
    effects: ({ who, keyTarget }) => [
      ADMIN_CLIENT,
      keyInserted(who.team.id, keyTarget),
      audited("api_key.issued"),
      revalidated(keysPath(who.team.slug)),
    ],
    observe: ({ who, keyTarget }, result) => {
      const parsed = RAW_KEY.exec((result as { key: string }).key);
      if (!parsed) throw new Error("the admitted result carried no raw key in the documented shape");
      const keyId = String(parsed[1]);
      const secret = String(parsed[2]);
      // One row, for the resolved team and the supplied member, holding the hash of the secret.
      expect(issuedKeyRows()).toEqual([
        {
          id: expect.any(String),
          team_id: who.team.id,
          member_id: keyTarget,
          key_id: keyId,
          key_hash: createHash("sha256").update(secret).digest("hex"),
          name: KEY_NAME,
          revoked_at: null,
        },
      ]);
      // The raw secret left only in the returned value: neither the vault nor the ledger holds it.
      expect(JSON.stringify([vault, ledger])).not.toContain(secret);
      expect(vault.audit_log).toEqual([
        auditRow(who, {
          action: "api_key.issued",
          target_type: "api_key",
          target_id: keyId,
          meta: { for_member: keyTarget },
        }),
      ]);
    },
  },
  {
    key: "app/t/[team]/admin/actions.ts#revokeApiKey",
    refusal: ADMINS_ONLY,
    invoke: ({ who, ownedKey }) => revokeApiKey(who.team.slug, ownedKey),
    admitted: () => ({ ok: true }),
    effects: ({ who, ownedKey }) => [
      ADMIN_CLIENT,
      keyRevoked(who.team.id, ownedKey),
      audited("api_key.revoked"),
      revalidated(keysPath(who.team.slug)),
    ],
    observe: ({ who, ownedKey }) => {
      // Exactly the owned row was revoked; every other key row is as it stood.
      const before = standingVault().api_keys;
      expect(vault.api_keys).toEqual(
        before.map((row) => (row.id === ownedKey ? { ...row, revoked_at: expect.any(String) } : row)),
      );
      const revokedAt = String(vault.api_keys.find((row) => row.id === ownedKey)?.revoked_at);
      expect(new Date(revokedAt).toISOString()).toBe(revokedAt);
      expect(vault.audit_log).toEqual([
        auditRow(who, { action: "api_key.revoked", target_type: "api_key", target_id: ownedKey, meta: {} }),
      ]);
    },
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

/** Everything an admitted call carried downstream: its effects, audit rows, issued rows and owner arguments. */
const downstreamTrace = () =>
  JSON.stringify([effects(), vault.audit_log, issuedKeyRows(), LOWER.map((owner) => owner.mock.calls)]);

/** Signed Alice against the healthy world: the export must succeed and reach its lower effect for her team. */
async function admittedAliceControl(surface: Surface): Promise<void> {
  beginRequest(tokens.alice);
  const result = await surface.invoke(ALICE_REALM);
  expect(result, CONTROL).toStrictEqual(surface.admitted(ALICE_REALM));
  expect(ledger, CONTROL).toEqual([...admittedReads(ALICE_ADMIN), ...surface.effects(ALICE_REALM)]);
}

const RECORDERS = [h.cookies, h.serverClient, h.adminClient, h.revalidatePath, ...LOWER, ...TRIPWIRES];

/** Clears the ledger and every recording and restores the healthy rows and vault; implementations stay armed. */
function resetBetween(): void {
  ledger.length = 0;
  for (const recorder of RECORDERS) recorder.mockClear();
  world = healthyWorld();
  vault = standingVault();
  postureFault = null;
  jar = null;
}

/** No privileged client, vault statement or row change, lower owner, revalidation, tripwire or cookie mutation. */
function expectNoProtectedEffect(): void {
  expect(effects()).toEqual([]);
  expect(h.adminClient).not.toHaveBeenCalled();
  for (const owner of LOWER) expect(owner).not.toHaveBeenCalled();
  expect(h.revalidatePath).not.toHaveBeenCalled();
  for (const tripwire of TRIPWIRES) expect(tripwire).not.toHaveBeenCalled();
  expect(vault).toEqual(standingVault());
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
  vi.stubGlobal("fetch", h.fetch);
  tokens = { alice: await signSession(ALICE), bob: await signSession(BOB) };
});
afterAll(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

beforeEach(() => {
  jar = null;
  world = healthyWorld();
  vault = standingVault();
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

  h.projectAllTasks.mockReset();
  h.projectAllTasks.mockImplementation(async (_db: unknown, teamId: string, projectId: string) => {
    ledger.push(projected(teamId, projectId));
    const reports = REPORTS[projectId];
    if (!reports) throw new Error(`${FIXTURE} projectAllTasks reached for unmodelled project ${projectId}`);
    return { provider: PROVIDER, reports: reports.map((report) => ({ ...report })) };
  });
  h.recordProjectionRun.mockReset();
  h.recordProjectionRun.mockImplementation(async (_db: unknown, input: { teamId: string | null }) => {
    ledger.push(projectionRecorded(String(input.teamId)));
  });
  h.reconcileProviderState.mockReset();
  h.reconcileProviderState.mockImplementation(async (_db: unknown, teamId: string) => {
    ledger.push(reconciled(teamId));
    const result = RECONCILED[teamId];
    if (!result) throw new Error(`${FIXTURE} reconcileProviderState reached for unmodelled team ${teamId}`);
    return { ...result, divergences: result.divergences.map((divergence) => ({ ...divergence })) };
  });
  h.getProvisioningAvailability.mockReset();
  h.getProvisioningAvailability.mockImplementation(async (_db: unknown, teamId: string) => {
    ledger.push(availabilityRead(teamId));
    const availability = AVAILABILITY[teamId];
    if (!availability) throw new Error(`${FIXTURE} getProvisioningAvailability reached for unmodelled team ${teamId}`);
    return availability.map((entry) => ({ ...entry }));
  });

  h.after.mockReset();
  h.after.mockImplementation(() => {
    ledger.push("effect:after");
    throw new Error(`${FIXTURE} after() was scheduled`);
  });
  h.headers.mockReset();
  h.headers.mockImplementation(() => {
    ledger.push("effect:headers");
    throw new Error(`${FIXTURE} headers() was read`);
  });
  h.fetch.mockReset();
  h.fetch.mockImplementation(() => {
    ledger.push("effect:fetch");
    throw new Error(`${FIXTURE} fetch was called: no transport may be reached from this file`);
  });
  h.inviteFamily.mockReset();
  h.inviteFamily.mockImplementation((name: string) => {
    ledger.push(`effect:invite-family ${name}`);
    throw new Error(`${FIXTURE} the invite family's ${name} was reached`);
  });
});

describe("X — fixture contract", () => {
  it("identities, tokens, realms and inputs are what the cases call them", async () => {
    const ids = [
      TEAM.id,
      OTHER_TEAM.id,
      ALICE.id,
      BOB.id,
      CAROL_USER,
      ALICE_MEMBER,
      BOB_MEMBER,
      CAROL_MEMBER,
      TEAM_EVERYONE,
      TEAM_EXTERNAL,
      OTHER_EVERYONE,
      PROJECT_ONE,
      PROJECT_TWO,
      OWNED_KEY,
      OTHER_PROJECT,
      OTHER_KEY,
    ];
    expect(new Set(ids).size, FIXTURE).toBe(ids.length);
    for (const id of ids) expect(id, FIXTURE).toMatch(UUID_V4);
    expect(TEAM.slug, FIXTURE).not.toBe(OTHER_TEAM.slug);

    await expect(verifySession(tokens.alice), FIXTURE).resolves.toStrictEqual(ALICE);
    await expect(verifySession(tokens.bob), FIXTURE).resolves.toStrictEqual(BOB);

    // Each realm names exactly what the standing rows hold for its team, and its key target is a
    // member of that team.
    for (const realm of [ALICE_REALM, BOB_REALM]) {
      const ownedBy = (rows: Row[]) => rows.filter((row) => row.team_id === realm.who.team.id).map((row) => row.id);
      expect(ownedBy(standingVault().projects), FIXTURE).toEqual(realm.projects);
      expect(ownedBy(standingVault().api_keys), FIXTURE).toEqual([realm.ownedKey]);
      expect(ownedBy(healthyWorld().members), FIXTURE).toContain(realm.keyTarget);

      // No admitted control below can be an early return: every double result is configured and non-empty.
      const reports = boardReports(realm);
      expect(reports.length, FIXTURE).toBeGreaterThan(0);
      expect(
        Object.values(realm.boardCounts).reduce((total, count) => total + count, 0),
        FIXTURE,
      ).toBe(reports.length);
      expect(RECONCILED[realm.who.team.id].provider, FIXTURE).not.toBeNull();
      expect(RECONCILED[realm.who.team.id].divergences.length, FIXTURE).toBeGreaterThan(0);
      expect(
        AVAILABILITY[realm.who.team.id].some((entry) => entry.configured),
        FIXTURE,
      ).toBe(true);
    }
    expect(KEY_NAME.trim(), FIXTURE).toBe(KEY_NAME);
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
      () => guardDb.from("api_keys").select("id").eq("team_id", TEAM.id),
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

  it("the privileged vault answers the four modelled statements, really applies their filters, records them, and refuses anything else", async () => {
    const owned = await vaultDb.from("projects").select("id").eq("team_id", TEAM.id);
    expect(owned, FIXTURE).toEqual({ data: [{ id: PROJECT_ONE }, { id: PROJECT_TWO }], error: null, count: null });

    // An update under the wrong team matches no row; under the right team it lands on that row only.
    await vaultDb.from("api_keys").update({ revoked_at: "fixture" }).eq("id", OTHER_KEY).eq("team_id", TEAM.id);
    expect(vault.api_keys, FIXTURE).toEqual(standingVault().api_keys);
    await vaultDb.from("api_keys").update({ revoked_at: "fixture" }).eq("id", OWNED_KEY).eq("team_id", TEAM.id);
    expect(
      vault.api_keys.map((row) => row.revoked_at),
      FIXTURE,
    ).toEqual(["fixture", null]);

    await vaultDb.from("api_keys").insert({ team_id: TEAM.id, member_id: CAROL_MEMBER, name: "fixture" });
    await vaultDb.from("audit_log").insert({ action: "fixture.contract" });
    expect(issuedKeyRows(), FIXTURE).toEqual([
      { id: expect.any(String), team_id: TEAM.id, member_id: CAROL_MEMBER, name: "fixture", revoked_at: null },
    ]);
    expect(vault.audit_log, FIXTURE).toEqual([{ action: "fixture.contract" }]);

    expect(ledger, FIXTURE).toEqual([
      ownedProjectsRead(TEAM.id),
      keyRevoked(TEAM.id, OTHER_KEY),
      keyRevoked(TEAM.id, OWNED_KEY),
      keyInserted(TEAM.id, CAROL_MEMBER),
      audited("fixture.contract"),
    ]);
    ledger.length = 0;

    // A different select list, a missing filter and an unmodelled table are recorded, then refused.
    const unmodelled = [
      () => vaultDb.from("projects").select("*").eq("team_id", TEAM.id),
      () => vaultDb.from("api_keys").update({ revoked_at: "fixture" }).eq("id", OWNED_KEY),
      () => vaultDb.from("members").select("id").eq("team_id", TEAM.id),
    ];
    for (const issue of unmodelled) {
      await expect(Promise.resolve().then(issue), FIXTURE).rejects.toThrow(/unmodelled privileged statement/);
    }
    expect(() => vaultDb.rpc("anything"), FIXTURE).toThrow(/asked to call anything/);
    expect(() => vaultDb.from("api_keys").delete(), FIXTURE).toThrow(/asked to delete api_keys/);
    expect(ledger, FIXTURE).toEqual([
      "effect:privileged unmodelled projects.select(*) eq(team_id)",
      "effect:privileged unmodelled api_keys.update() eq(id)",
      "effect:privileged unmodelled members.select(id) eq(team_id)",
      "effect:privileged.rpc anything",
      "effect:privileged.delete api_keys",
    ]);
  });
});

describe.each(SURFACES)("A — $key (team-admin gated)", (surface) => {
  it("admitted control: a signed active admin holding the team's builtin everyone row reaches this export's lower effect for the server-resolved team and actor", async () => {
    beginRequest(tokens.alice);

    const result = await surface.invoke(ALICE_REALM);
    expect(result).toStrictEqual(surface.admitted(ALICE_REALM));

    // The identity came from this request's cookie; team, membership and posture were each read once.
    expect(reads()).toEqual(admittedReads(ALICE_ADMIN));
    expect(effects()).toEqual(surface.effects(ALICE_REALM));
    // Every prerequisite read precedes the first effect.
    expect(ledger).toEqual([...admittedReads(ALICE_ADMIN), ...surface.effects(ALICE_REALM)]);

    surface.observe(ALICE_REALM, result);
    expect(h.adminClient).toHaveBeenCalledTimes(1);
    for (const tripwire of TRIPWIRES) expect(tripwire).not.toHaveBeenCalled();
  });

  it("binding: Alice's session reaches her team, Bob's reaches his, and neither downstream trace carries the other's ids", async () => {
    beginRequest(tokens.alice);
    const aliceResult = await surface.invoke(ALICE_REALM);
    expect(aliceResult).toStrictEqual(surface.admitted(ALICE_REALM));
    surface.observe(ALICE_REALM, aliceResult);
    const aliceTrace = downstreamTrace();
    for (const foreign of realmIds(BOB_REALM)) expect(aliceTrace).not.toContain(foreign);

    resetBetween();

    beginRequest(tokens.bob);
    const bobResult = await surface.invoke(BOB_REALM);
    expect(bobResult).toStrictEqual(surface.admitted(BOB_REALM));
    expect(ledger).toEqual([...admittedReads(BOB_ADMIN), ...surface.effects(BOB_REALM)]);
    surface.observe(BOB_REALM, bobResult);
    const bobTrace = downstreamTrace();
    for (const foreign of realmIds(ALICE_REALM)) expect(bobTrace).not.toContain(foreign);
  });

  it.each(REFUSALS)(
    "$name → refused in this export's own shape: only the prerequisite reads ran, and no privileged client, vault statement, lower owner, audit row or revalidation followed",
    async ({ session, arrange, reads: prerequisites, postures }) => {
      await admittedAliceControl(surface);
      resetBetween();

      arrange();
      beginRequest(sessionCookie(session));

      await expect(surface.invoke(ALICE_REALM)).resolves.toStrictEqual(surface.refusal);

      expect(reads()).toEqual(prerequisites);
      expect(ledger).toEqual(prerequisites);
      expectNoProtectedEffect();

      // Which conjunct the case removed, in the real resolver's own words.
      for (const { teamId, memberId, is } of postures) {
        await expect(resolveViewerPosture(guardDb, teamId, memberId), FIXTURE).resolves.toBe(is);
      }
    },
  );

  it.each(POSTURE_FAULTS)(
    "$name after the session, team and active admin membership are admitted: the export rejects with the owner's fault — never a refusal, never a result — and nothing protected followed",
    async ({ form }) => {
      await admittedAliceControl(surface);
      resetBetween();

      postureFault = form;
      beginRequest(tokens.alice);

      const settled = await settle(surface.invoke(ALICE_REALM));

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
      expectNoProtectedEffect();
    },
  );
});

describe("S — the two refusal shapes, side by side", () => {
  it("with no session, availability refuses as an empty list and the other four refuse as `admins only`; an admitted availability call is a non-empty list", async () => {
    for (const surface of SURFACES) {
      resetBetween();
      beginRequest(null);

      const refused = await surface.invoke(ALICE_REALM);

      if (surface.key === AVAILABILITY_KEY) {
        expect(refused).toStrictEqual([]);
        expect(refused).not.toHaveProperty("ok");
        expect(refused).not.toHaveProperty("error");
      } else {
        expect(refused).toStrictEqual(ADMINS_ONLY);
        expect(Array.isArray(refused)).toBe(false);
      }
      expect(ledger).toEqual([SESSION_READ]);
      expectNoProtectedEffect();
    }

    resetBetween();
    beginRequest(tokens.alice);

    const admitted = await getProvisioningAvailabilityAction(TEAM.slug);

    // The denied shape is the empty list; the admitted one carries an entry per tool.
    expect(admitted).toStrictEqual(AVAILABILITY[TEAM.id]);
    expect(admitted.length).toBeGreaterThan(0);
    expect(admitted.some((entry) => entry.configured)).toBe(true);
  });
});

describe("L — client-supplied ids: CURRENT LIMITS, pinned not endorsed, not a pass of any target boundary", () => {
  it("app/t/[team]/admin/actions.ts#issueApiKey — `memberId` is not bound (desired refusal DEFERRED AIO-1226): an admin supplying another team's member id gets a key row carrying it, and nothing looks that member up", async () => {
    beginRequest(tokens.alice);

    const result = await issueApiKey(TEAM.slug, BOB_MEMBER, KEY_NAME);

    expect(result).toStrictEqual({ ok: true, key: expect.stringMatching(RAW_KEY) });
    // The only reads are the admin's own admission: no statement resolves the target member.
    expect(reads()).toEqual(admittedReads(ALICE_ADMIN));
    expect(effects()).toEqual([
      ADMIN_CLIENT,
      keyInserted(TEAM.id, BOB_MEMBER),
      audited("api_key.issued"),
      revalidated(keysPath(TEAM.slug)),
    ]);
    // The row pairs the resolved team with the supplied id. Whether Postgres accepts that pair, and
    // what such a key can reach, is not exercised here: no foreign key or key authentication runs.
    expect(issuedKeyRows()).toEqual([expect.objectContaining({ team_id: TEAM.id, member_id: BOB_MEMBER })]);
    expect(healthyWorld().members.find((row) => row.id === BOB_MEMBER)?.team_id).toBe(OTHER_TEAM.id);
  });

  it("app/t/[team]/admin/actions.ts#revokeApiKey — `apiKeyId` is team-bound at the statement only: another team's key id matches no row and that key stays live, yet the call reports success and audits", async () => {
    beginRequest(tokens.alice);

    const result = await revokeApiKey(TEAM.slug, OTHER_KEY);

    // The update carried the resolved team, so the other team's row is exactly as it stood.
    expect(effects()).toEqual([
      ADMIN_CLIENT,
      keyRevoked(TEAM.id, OTHER_KEY),
      audited("api_key.revoked"),
      revalidated(keysPath(TEAM.slug)),
    ]);
    expect(vault.api_keys).toEqual(standingVault().api_keys);
    // No matched-row check follows: the zero-row revoke is reported and audited as a success.
    expect(result).toStrictEqual({ ok: true });
    expect(vault.audit_log).toEqual([
      auditRow(ALICE_ADMIN, { action: "api_key.revoked", target_type: "api_key", target_id: OTHER_KEY, meta: {} }),
    ]);
  });
});

describe("Z — follow-up evidence this file does NOT supply (executable TODOs: none is run, none is passed)", () => {
  it.todo(
    "REAL-PG (test/datamechanics): the five exports over real session, member and group rows through the pg adapter, with both stale legacy-tier directions — role admin with tier=team and no builtin everyone denies; role admin with tier=external and builtin everyone admits",
  );
  it.todo(
    "REAL-PG: a prior admitted fixture, then removal of the builtin everyone row, denies on a NEW invocation of each export; re-adding it admits again",
  );
  it.todo(
    "REAL-PG native owner: lib/admin/keys issueApiKey and revokeApiKey over real api_keys and audit_log rows — hash-only storage, the (id, team) revoke predicate and the table's foreign keys",
  );
  it.todo(
    "REAL-PG native owner: projectAllTasks, recordProjectionRun and reconcileProviderState over real projects, tasks, task_pm_links and ingest_runs rows with a recording provider transport (no live board)",
  );
  it.todo(
    "REAL-PG native owner: getProvisioningAvailability over real integrations rows, including the secret resolution beneath this file's seam",
  );
  it.todo(
    "DEFERRED AIO-1226: the desired same-team member-target refusal for admin issueApiKey — owned by that ticket; not specified, asserted or implemented by this file",
  );
  it.todo(
    "MUTANT (isolated copy, actual import): remove the requireAdmin call from each of the five exports — the 13 refusal cases must fail on the result and on the ledger",
  );
  it.todo(
    "MUTANT: keep the requireAdmin call but ignore its null verdict in each export — the refusal cases must fail, not a compile or fixture error",
  );
  it.todo(
    "MUTANT: replace requireTeamAdmin with a session-only or currentMember check — the lead, member and three external-posture cases must fail",
  );
  it.todo(
    "MUTANT (test-time substitution of lib/integrations/read, no on-disk edit): drop the role conjunct, then the posture conjunct, of canAccessAdmin — the matching role and posture cases must fail",
  );
  it.todo(
    "MUTANT: move each export's lower effect above its admission — the refusal ledgers and the standing-vault comparison must fail",
  );
  it.todo(
    "MUTANT: swap the refusal shapes (availability returns the admins-only object; another export returns []) — S and the per-export refusal cases must fail",
  );
  it.todo(
    "MUTANT: drop the team filter from projectBoardAction's own projects read — the admitted control must fail on the third, foreign projection",
  );
});
