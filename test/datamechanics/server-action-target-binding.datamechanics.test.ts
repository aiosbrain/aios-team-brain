import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getPool } from "@/lib/db/pg/pool";
import { placeMemberByTier, seedTeam, type Seed } from "./helpers";

/**
 * AIO-1217 — Server Action target binding against real Postgres (AC-07, AC-09, AC-10).
 *
 * Every assertion is derived from the accepted specification, not from the implementation: a
 * resource id supplied by the browser must not be accepted independently of the authenticated
 * context. Three families, each with spec-desired refusals and admitted controls that share one
 * mock configuration and one writer path:
 *
 *   A  — `decideApproval`: a team-A administrator supplies team B's legacy approval id.
 *   B1 — the People context actions: a team-A administrator supplies team B's member id.
 *   B2 — the People child-resource actions: a member authorizes their OWN member id and supplies
 *        a same-team peer's time-off / goal id or imported dedup key.
 *
 * What is real here: `requireTeamAdmin`, `currentMember`, `canEditMemberContext`, the posture
 * resolver, `resolveApproval`, the built-in `code.run` handler, the profile single writer, the
 * audit writer and the pg adapter. What is stubbed: ONLY "who is signed in" (a synthetic auth-user
 * identity — the member/role/posture lookup behind it is real rows), `revalidatePath`, and the
 * sandbox factory, whose `run` is a recording fixture that allocates nothing.
 *
 * A refusal case compares the durable rowsets before and after the call (not counts — an upsert
 * re-homes a row without changing a count) together with the dispatch and cache spies in ONE
 * grouped assertion, so a wrong return value cannot hide a durable mutation or a dispatch.
 * Fixture premises fail with the `FIXTURE` prefix below and are never a security observation.
 */

const FIXTURE = "FIXTURE PREMISE FAILED (setup, not a security observation):";

const h = vi.hoisted(() => ({
  sessionUser: null as { id: string; email: string } | null,
  revalidatePath: vi.fn(),
  sandboxRun: vi.fn(),
  createE2BSandbox: vi.fn(),
}));

// Request identity only: the membership, role and posture behind this auth-user id are real rows.
vi.mock("@/lib/auth/session", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth/session")>()),
  getSessionUser: async () => h.sessionUser,
}));
vi.mock("next/cache", () => ({ revalidatePath: h.revalidatePath }));
// The factory is pure; `run` is the recording boundary. No E2B transport, loader or allocation.
vi.mock("@/lib/actions/sandbox/e2b", () => ({ createE2BSandbox: h.createE2BSandbox }));

import { decideApproval } from "@/app/t/[team]/admin/approvals/actions";
import {
  addMemberTimeOff,
  deleteMemberGoal,
  deleteMemberTimeOff,
  saveAvatar,
  saveMemberGoal,
  saveProfile,
} from "@/app/t/[team]/people/[handle]/actions";

type Row = Record<string, unknown>;
type Role = "admin" | "lead" | "member";
type Posture = "team" | "external";
type MemberStatus = "active" | "invited" | "disabled";
type Decision = "approved" | "denied";

const SANDBOX_STDOUT = "aio1217-synthetic-sandbox-stdout";
const CODE_PARAMS = { language: "python", code: "print('aio1217 synthetic fixture')" };
const DECISION_NOTE = "aio1217 synthetic decision note";
const DECISIONS: Decision[] = ["approved", "denied"];

const APPROVAL_NOT_FOUND = { ok: false, error: "approval not found" };
const ADMINS_ONLY = { ok: false, error: "admins only" };
const NOT_ALLOWED = { ok: false, error: "not allowed" };

const SEEDED_AVATAR = "data:image/png;base64,QkI=";
const VALID_AVATAR = "data:image/png;base64,AA==";
const TIME_OFF = {
  startsOn: "2026-11-02",
  endsOn: "2026-11-06",
  kind: "pto" as const,
  note: "aio1217 synthetic time off",
};
const PEER_IMPORT_KEY = "AIO1217-PEER-OKR-1";
const OWN_IMPORT_KEY = "AIO1217-OWN-OKR-1";

beforeEach(() => {
  h.sessionUser = null;
  h.revalidatePath.mockReset();
  h.sandboxRun.mockReset();
  h.sandboxRun.mockImplementation(async () => ({ exitCode: 0, stdout: SANDBOX_STDOUT, stderr: "" }));
  h.createE2BSandbox.mockReset();
  h.createE2BSandbox.mockImplementation(() => ({ configured: true, run: h.sandboxRun }));
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

const revalidatedPaths = (): unknown[] => h.revalidatePath.mock.calls.map((call) => call[0]);
const ofTeam = (rows: Row[], teamId: string): Row[] => rows.filter((row) => row.team_id === teamId);

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

/** A distinct same-team member holding the real builtin posture row for `posture`. */
async function addMember(
  teamId: string,
  opts: { posture?: Posture; status?: MemberStatus } = {},
): Promise<string> {
  const posture = opts.posture ?? "team";
  const { id } = await fxOne<{ id: string }>(
    "member insert",
    `insert into members(team_id, email, display_name, actor_handle, role, tier, status)
     values($1, $2, $3, $4, 'member', $5, 'active') returning id`,
    [teamId, `${randomUUID()}@test.local`, `Member ${randomUUID().slice(0, 6)}`, `m-${randomUUID().slice(0, 10)}`, posture],
  );
  await placeMemberByTier(teamId, id, posture);
  if (opts.status && opts.status !== "active") {
    await fxOne("member status", `update members set status = $1 where id = $2 and team_id = $3 returning id`, [
      opts.status,
      id,
      teamId,
    ]);
  }
  return id;
}

/**
 * Bind `memberId` to a fresh auth user, give it `role`, read the authority state back, then make
 * that auth user the signed-in identity. Nothing about the guard is stubbed to success.
 */
async function signIn(teamId: string, memberId: string, role: Role, posture: Posture = "team"): Promise<void> {
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
    everyone_rows: posture === "team" ? 1 : 0,
    external_rows: posture === "external" ? 1 : 0,
  });
  h.sessionUser = user;
}

// ── Family A fixtures: legacy approval + linked action ───────────────────────────────────────────

/** A ready legacy tuple exactly as `runAction` leaves it once its producer link has landed. */
async function seedLegacyTuple(owner: Seed): Promise<{ approvalId: string; actionId: string }> {
  const approvalId = randomUUID();
  const actionId = randomUUID();
  const actor = `fixture-${randomUUID().slice(0, 8)}`;
  await fxOne(
    "approval insert",
    `insert into approval_requests(id, team_id, requested_by_member, requested_by_actor, action, resource, context, status)
     values($1, $2, $3, $4, 'code.run', 'code:fixture', $5::jsonb, 'pending') returning id`,
    [approvalId, owner.teamId, owner.memberId, actor, JSON.stringify({ params: CODE_PARAMS, action_id: actionId })],
  );
  await fxOne(
    "action insert",
    `insert into actions(id, team_id, member_id, actor, action_type, resource, params, status, decision, approval_request_id)
     values($1, $2, $3, $4, 'code.run', 'code:fixture', $5::jsonb, 'pending_approval', 'require_approval', $6) returning id`,
    [actionId, owner.teamId, owner.memberId, actor, JSON.stringify(CODE_PARAMS), approvalId],
  );
  premise(
    "legacy tuple readback",
    await fx(
      "legacy tuple readback",
      `select p.team_id as approval_team, p.status::text as approval_status,
              p.context->>'action_id' as forward_action_id, p.context ? 'governed_action_id' as governed_marker,
              a.id as action_id, a.team_id as action_team, a.status::text as action_status, a.approval_request_id,
              (select count(*)::int from governed_actions g where g.approval_request_id = p.id) as governed_rows
         from approval_requests p join actions a on a.approval_request_id = p.id
        where p.id = $1`,
      [approvalId],
    ),
    [
      {
        approval_team: owner.teamId,
        approval_status: "pending",
        forward_action_id: actionId,
        governed_marker: false,
        action_id: actionId,
        action_team: owner.teamId,
        action_status: "pending_approval",
        approval_request_id: approvalId,
        governed_rows: 0,
      },
    ],
  );
  return { approvalId, actionId };
}

/** A genuine standalone approval: no forward link, no reverse-linked action, no governed marker. */
async function seedStandaloneApproval(owner: Seed): Promise<string> {
  const approvalId = randomUUID();
  await fxOne(
    "standalone approval insert",
    `insert into approval_requests(id, team_id, requested_by_member, requested_by_actor, action, resource, context, status)
     values($1, $2, $3, $4, 'code.run', 'code:fixture', $5::jsonb, 'pending') returning id`,
    [approvalId, owner.teamId, owner.memberId, `fixture-${randomUUID().slice(0, 8)}`, JSON.stringify({ params: CODE_PARAMS })],
  );
  premise(
    "standalone approval readback",
    await fx(
      "standalone approval readback",
      `select p.team_id, p.status::text as status, p.context ? 'action_id' as forward_marker,
              p.context ? 'governed_action_id' as governed_marker,
              (select count(*)::int from actions a where a.approval_request_id = p.id) as linked_actions,
              (select count(*)::int from governed_actions g where g.approval_request_id = p.id) as governed_rows
         from approval_requests p where p.id = $1`,
      [approvalId],
    ),
    [{ team_id: owner.teamId, status: "pending", forward_marker: false, governed_marker: false, linked_actions: 0, governed_rows: 0 }],
  );
  return approvalId;
}

async function legacyState() {
  return {
    approvals: await fx("approval readback", `select * from approval_requests order by id`),
    actions: await fx("action readback", `select * from actions order by id`),
    audit: await auditRows(),
  };
}

// ── Family B fixtures: member context rows ───────────────────────────────────────────────────────

async function seedProfile(teamId: string, memberId: string): Promise<void> {
  await fxOne(
    "profile insert",
    `insert into member_profiles(member_id, team_id, timezone, location, bio, avatar_data_url, updated_by)
     values($1, $2, 'Europe/Lisbon', 'Fixture City', $3, $4, $1) returning member_id`,
    [memberId, teamId, `original bio of ${memberId}`, SEEDED_AVATAR],
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

async function contextState() {
  return {
    profiles: await fx("profile readback", `select * from member_profiles order by member_id`),
    timeOff: await fx("time-off readback", `select * from member_time_off order by id`),
    goals: await fx("goal readback", `select * from member_goals order by id`),
    audit: await auditRows(),
  };
}

const peoplePath = (teamSlug: string, memberId: string) => `/t/${teamSlug}/people/${memberId}`;

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// Family A — decideApproval binds the supplied approval id to the administrator's team (AC-07)
// ─────────────────────────────────────────────────────────────────────────────────────────────────

describe("AIO-1217 A · decideApproval binds the approval to the administrator's team (AC-07)", () => {
  it.each(DECISIONS)(
    "foreign legacy approval · %s: team-A admin supplying team B's approval id is refused exactly like an absent id — B approval/action rows, audit ledger, sandbox dispatch and cache untouched",
    async (decision) => {
      const a = await seedTeam();
      const b = await seedTeam();
      await signIn(a.teamId, a.memberId, "admin");
      const foreign = await seedLegacyTuple(b);
      const before = await legacyState();
      premise("the only approval and action belong to team B", {
        approvalTeams: before.approvals.map((row) => row.team_id),
        actionTeams: before.actions.map((row) => row.team_id),
      }, { approvalTeams: [b.teamId], actionTeams: [b.teamId] });

      const result = await decideApproval(a.teamSlug, foreign.approvalId, decision, DECISION_NOTE);

      // Collect every observation before asserting, then the absent-id comparison.
      const after = await legacyState();
      const sandboxRuns = h.sandboxRun.mock.calls.length;
      const revalidated = revalidatedPaths();
      const absentResult = await decideApproval(a.teamSlug, randomUUID(), decision, DECISION_NOTE);

      expect({
        result,
        absentResult,
        approvals: after.approvals,
        actions: after.actions,
        audit: after.audit,
        sandboxRuns,
        revalidated,
      }).toEqual({
        result: APPROVAL_NOT_FOUND,
        absentResult: APPROVAL_NOT_FOUND,
        approvals: before.approvals,
        actions: before.actions,
        audit: before.audit,
        sandboxRuns: 0,
        revalidated: [],
      });
    },
  );

  it("[control] same-team ready tuple · approved: approval approved by the decider, action succeeded, sandbox dispatched exactly once, approvals path revalidated, team B bystander untouched", async () => {
    const a = await seedTeam();
    const b = await seedTeam();
    await signIn(a.teamId, a.memberId, "admin");
    const own = await seedLegacyTuple(a);
    await seedLegacyTuple(b);
    const before = await legacyState();

    const result = await decideApproval(a.teamSlug, own.approvalId, "approved", DECISION_NOTE);

    const after = await legacyState();
    expect(result.ok).toBe(true);
    expect(result.error).toBeUndefined();
    expect(result.message).toMatch(/Approved/);
    expect(result.message).toMatch(/succeeded/);
    expect(after.approvals.find((row) => row.id === own.approvalId)).toMatchObject({
      team_id: a.teamId,
      status: "approved",
      decided_by: a.memberId,
      decision_note: DECISION_NOTE,
    });
    expect(after.approvals.find((row) => row.id === own.approvalId)?.decided_at).not.toBeNull();
    expect(after.actions.find((row) => row.id === own.actionId)).toMatchObject({
      team_id: a.teamId,
      status: "succeeded",
      approval_request_id: own.approvalId,
      result: { output: { exitCode: 0, stdout: SANDBOX_STDOUT, stderr: "" } },
    });
    expect(h.sandboxRun).toHaveBeenCalledTimes(1);
    expect(h.sandboxRun).toHaveBeenCalledWith(expect.objectContaining(CODE_PARAMS));
    expect(revalidatedPaths()).toEqual([`/t/${a.teamSlug}/admin/approvals`]);
    expect(ofTeam(after.approvals, b.teamId)).toEqual(ofTeam(before.approvals, b.teamId));
    expect(ofTeam(after.actions, b.teamId)).toEqual(ofTeam(before.actions, b.teamId));
    // Audit is best effort; durable rows above are the settled-state oracle. With no fault injected
    // the decision and terminal events land, and only under the deciding team.
    const written = auditSince(before.audit, after.audit);
    expect(written.every((row) => row.team_id === a.teamId)).toBe(true);
    expect(written).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ action: "approval.approved", member_id: a.memberId, target_id: own.actionId }),
        expect.objectContaining({ action: "action.succeeded", target_id: own.actionId }),
      ]),
    );
  });

  it("[control] same-team ready tuple · denied: approval and action denied, zero sandbox dispatch, approvals path revalidated, team B bystander untouched", async () => {
    const a = await seedTeam();
    const b = await seedTeam();
    await signIn(a.teamId, a.memberId, "admin");
    const own = await seedLegacyTuple(a);
    await seedLegacyTuple(b);
    const before = await legacyState();

    const result = await decideApproval(a.teamSlug, own.approvalId, "denied", DECISION_NOTE);

    const after = await legacyState();
    expect(result.ok).toBe(true);
    expect(result.error).toBeUndefined();
    expect(result.message).toMatch(/Denied/);
    expect(after.approvals.find((row) => row.id === own.approvalId)).toMatchObject({
      team_id: a.teamId,
      status: "denied",
      decided_by: a.memberId,
      decision_note: DECISION_NOTE,
    });
    expect(after.actions.find((row) => row.id === own.actionId)).toMatchObject({
      team_id: a.teamId,
      status: "denied",
      result: {},
    });
    expect(h.sandboxRun).not.toHaveBeenCalled();
    expect(revalidatedPaths()).toEqual([`/t/${a.teamSlug}/admin/approvals`]);
    expect(ofTeam(after.approvals, b.teamId)).toEqual(ofTeam(before.approvals, b.teamId));
    expect(ofTeam(after.actions, b.teamId)).toEqual(ofTeam(before.actions, b.teamId));
    const written = auditSince(before.audit, after.audit);
    expect(written.every((row) => row.team_id === a.teamId)).toBe(true);
    expect(written).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ action: "approval.denied", member_id: a.memberId, target_id: own.actionId }),
      ]),
    );
  });

  it.each(DECISIONS)(
    "[control] absent approval id · %s: refused as approval not found with no row change, no audit and no sandbox dispatch",
    async (decision) => {
      const a = await seedTeam();
      const b = await seedTeam();
      await signIn(a.teamId, a.memberId, "admin");
      await seedLegacyTuple(a);
      await seedLegacyTuple(b);
      const before = await legacyState();

      const result = await decideApproval(a.teamSlug, randomUUID(), decision, DECISION_NOTE);

      const after = await legacyState();
      expect({
        result,
        approvals: after.approvals,
        actions: after.actions,
        audit: after.audit,
        sandboxRuns: h.sandboxRun.mock.calls.length,
      }).toEqual({
        result: APPROVAL_NOT_FOUND,
        approvals: before.approvals,
        actions: before.actions,
        audit: before.audit,
        sandboxRuns: 0,
      });
    },
  );

  // Kept apart from the control above so a cache-only difference cannot mask its durable verdict.
  it.each(DECISIONS)(
    "[supplementary] absent approval id · %s: a refused decision does not revalidate the approvals path",
    async (decision) => {
      const a = await seedTeam();
      await signIn(a.teamId, a.memberId, "admin");

      const result = await decideApproval(a.teamSlug, randomUUID(), decision, DECISION_NOTE);

      expect({ result, revalidated: revalidatedPaths() }).toEqual({ result: APPROVAL_NOT_FOUND, revalidated: [] });
    },
  );

  it("[control] no session: a valid owned approval id is refused admins only before any row change, dispatch or revalidation", async () => {
    const a = await seedTeam();
    await signIn(a.teamId, a.memberId, "admin");
    const own = await seedLegacyTuple(a);
    h.sessionUser = null;
    const before = await legacyState();

    const result = await decideApproval(a.teamSlug, own.approvalId, "approved", DECISION_NOTE);

    const after = await legacyState();
    expect({
      result,
      approvals: after.approvals,
      actions: after.actions,
      audit: after.audit,
      sandboxRuns: h.sandboxRun.mock.calls.length,
      revalidated: revalidatedPaths(),
    }).toEqual({
      result: ADMINS_ONLY,
      approvals: before.approvals,
      actions: before.actions,
      audit: before.audit,
      sandboxRuns: 0,
      revalidated: [],
    });
  });

  it("[control] signed-in ordinary member (role member, Everyone posture): a valid owned approval id is refused admins only with no row change, dispatch or revalidation", async () => {
    const a = await seedTeam();
    await signIn(a.teamId, a.memberId, "member");
    const own = await seedLegacyTuple(a);
    const before = await legacyState();

    const result = await decideApproval(a.teamSlug, own.approvalId, "approved", DECISION_NOTE);

    const after = await legacyState();
    expect({
      result,
      approvals: after.approvals,
      actions: after.actions,
      audit: after.audit,
      sandboxRuns: h.sandboxRun.mock.calls.length,
      revalidated: revalidatedPaths(),
    }).toEqual({
      result: ADMINS_ONLY,
      approvals: before.approvals,
      actions: before.actions,
      audit: before.audit,
      sandboxRuns: 0,
      revalidated: [],
    });
  });

  it.each(DECISIONS)(
    "[control] same-team genuine standalone approval · %s: the decision is recorded with no action row and no sandbox dispatch, and the approvals path is revalidated",
    async (decision) => {
      const a = await seedTeam();
      await signIn(a.teamId, a.memberId, "admin");
      const approvalId = await seedStandaloneApproval(a);
      const before = await legacyState();

      const result = await decideApproval(a.teamSlug, approvalId, decision, DECISION_NOTE);

      const after = await legacyState();
      expect(result.ok).toBe(true);
      expect(result.error).toBeUndefined();
      expect(after.approvals).toEqual([
        expect.objectContaining({
          id: approvalId,
          team_id: a.teamId,
          status: decision,
          decided_by: a.memberId,
          decision_note: DECISION_NOTE,
        }),
      ]);
      expect(after.actions).toEqual(before.actions);
      expect(after.actions).toEqual([]);
      expect(h.sandboxRun).not.toHaveBeenCalled();
      expect(revalidatedPaths()).toEqual([`/t/${a.teamSlug}/admin/approvals`]);
    },
  );
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// Family B1 — People actions bind the supplied member id to the resolved team (AC-09)
// ─────────────────────────────────────────────────────────────────────────────────────────────────

describe("AIO-1217 B1 · People context actions bind the target member to the resolved team (AC-09)", () => {
  const FOREIGN_TARGET_CASES: Array<{
    action: string;
    run: (teamSlug: string, memberId: string) => Promise<{ ok: boolean; error?: string; id?: string }>;
  }> = [
    { action: "saveProfile", run: (teamSlug, memberId) => saveProfile(teamSlug, memberId, { bio: "synthetic replacement" }) },
    { action: "saveAvatar", run: (teamSlug, memberId) => saveAvatar(teamSlug, memberId, VALID_AVATAR) },
    { action: "addMemberTimeOff", run: (teamSlug, memberId) => addMemberTimeOff(teamSlug, memberId, TIME_OFF) },
    { action: "saveMemberGoal", run: (teamSlug, memberId) => saveMemberGoal(teamSlug, memberId, { title: "synthetic foreign-target goal" }) },
  ];

  it.each(FOREIGN_TARGET_CASES)(
    "foreign member target · $action: team-A admin supplying team B's member id is refused not allowed exactly like an absent member — B's profile tuple unchanged, no cross-team row, no audit, no revalidation",
    async ({ run }) => {
      const a = await seedTeam();
      const b = await seedTeam();
      await signIn(a.teamId, a.memberId, "admin");
      await seedProfile(b.teamId, b.memberId);
      premise(
        "the target member exists only in team B",
        await fx("target member readback", `select team_id, status::text as status from members where id = $1`, [b.memberId]),
        [{ team_id: b.teamId, status: "active" }],
      );
      const before = await contextState();
      premise("the only profile is B's own, under team B", before.profiles.map((row) => [row.member_id, row.team_id]), [
        [b.memberId, b.teamId],
      ]);

      const result = await run(a.teamSlug, b.memberId);

      const after = await contextState();
      const revalidated = revalidatedPaths();
      const absentTargetResult = await run(a.teamSlug, randomUUID());

      expect({
        result,
        absentTargetResult,
        profiles: after.profiles,
        timeOff: after.timeOff,
        goals: after.goals,
        audit: after.audit,
        revalidated,
      }).toEqual({
        result: NOT_ALLOWED,
        absentTargetResult: NOT_ALLOWED,
        profiles: before.profiles,
        timeOff: before.timeOff,
        goals: before.goals,
        audit: before.audit,
        revalidated: [],
      });
    },
  );

  it("[control] admin edits a same-team peer's profile: a partial update preserves untouched fields and the (team, member) tuple, audits and revalidates", async () => {
    const a = await seedTeam();
    await signIn(a.teamId, a.memberId, "admin");
    const peer = await addMember(a.teamId);
    await seedProfile(a.teamId, peer);
    const before = await contextState();

    const result = await saveProfile(a.teamSlug, peer, { bio: "admin-edited bio" });

    const after = await contextState();
    expect(result).toEqual({ ok: true });
    expect(after.profiles).toEqual([
      expect.objectContaining({
        member_id: peer,
        team_id: a.teamId,
        bio: "admin-edited bio",
        timezone: "Europe/Lisbon",
        location: "Fixture City",
        avatar_data_url: SEEDED_AVATAR,
        updated_by: a.memberId,
      }),
    ]);
    expect(revalidatedPaths()).toEqual([peoplePath(a.teamSlug, peer)]);
    expect(auditSince(before.audit, after.audit)).toEqual([
      expect.objectContaining({ team_id: a.teamId, member_id: a.memberId, action: "profile.set", target_id: peer }),
    ]);
  });

  it("[control] admin sets a same-team peer's avatar; an invalid avatar is still refused by writer validation with no change", async () => {
    const a = await seedTeam();
    await signIn(a.teamId, a.memberId, "admin");
    const peer = await addMember(a.teamId);

    const set = await saveAvatar(a.teamSlug, peer, VALID_AVATAR);

    const afterSet = await contextState();
    expect(set).toEqual({ ok: true });
    expect(afterSet.profiles).toEqual([
      expect.objectContaining({ member_id: peer, team_id: a.teamId, avatar_data_url: VALID_AVATAR, updated_by: a.memberId }),
    ]);
    expect(revalidatedPaths()).toEqual([peoplePath(a.teamSlug, peer)]);

    const invalid = await saveAvatar(a.teamSlug, peer, "not-a-data-url");

    const afterInvalid = await contextState();
    expect(invalid.ok).toBe(false);
    expect(invalid.error).toMatch(/avatar/i);
    expect(afterInvalid.profiles).toEqual(afterSet.profiles);
    expect(afterInvalid.audit).toEqual(afterSet.audit);
    expect(revalidatedPaths()).toEqual([peoplePath(a.teamSlug, peer)]);
  });

  it("[control] admin adds time-off and a goal for a same-team peer: each row carries the (team, peer) tuple and the returned id", async () => {
    const a = await seedTeam();
    await signIn(a.teamId, a.memberId, "admin");
    const peer = await addMember(a.teamId);

    const timeOff = await addMemberTimeOff(a.teamSlug, peer, TIME_OFF);
    const goal = await saveMemberGoal(a.teamSlug, peer, { title: "admin-authored peer goal" });

    const after = await contextState();
    expect(timeOff.ok).toBe(true);
    expect(goal.ok).toBe(true);
    expect(after.timeOff).toEqual([
      expect.objectContaining({
        id: timeOff.id,
        team_id: a.teamId,
        member_id: peer,
        starts_on: TIME_OFF.startsOn,
        ends_on: TIME_OFF.endsOn,
        kind: TIME_OFF.kind,
        note: TIME_OFF.note,
      }),
    ]);
    expect(after.goals).toEqual([
      expect.objectContaining({ id: goal.id, team_id: a.teamId, member_id: peer, title: "admin-authored peer goal", source: "manual" }),
    ]);
    expect(revalidatedPaths()).toEqual([peoplePath(a.teamSlug, peer), peoplePath(a.teamSlug, peer)]);
  });

  it("[control] ordinary member edits their own profile, avatar, time-off and goal", async () => {
    const team = await seedTeam();
    const self = team.memberId;
    await signIn(team.teamId, self, "member");

    const profile = await saveProfile(team.teamSlug, self, { timezone: "America/New_York", bio: "self-authored bio" });
    const avatar = await saveAvatar(team.teamSlug, self, VALID_AVATAR);
    const timeOff = await addMemberTimeOff(team.teamSlug, self, TIME_OFF);
    const goal = await saveMemberGoal(team.teamSlug, self, { title: "self-authored goal" });

    const after = await contextState();
    expect(profile).toEqual({ ok: true });
    expect(avatar).toEqual({ ok: true });
    expect(timeOff.ok).toBe(true);
    expect(goal.ok).toBe(true);
    // The avatar write is a second partial update: it must not wipe the profile fields before it.
    expect(after.profiles).toEqual([
      expect.objectContaining({
        member_id: self,
        team_id: team.teamId,
        timezone: "America/New_York",
        bio: "self-authored bio",
        avatar_data_url: VALID_AVATAR,
        updated_by: self,
      }),
    ]);
    expect(after.timeOff).toEqual([expect.objectContaining({ id: timeOff.id, team_id: team.teamId, member_id: self })]);
    expect(after.goals).toEqual([
      expect.objectContaining({ id: goal.id, team_id: team.teamId, member_id: self, title: "self-authored goal" }),
    ]);
    expect(revalidatedPaths()).toEqual(Array(4).fill(peoplePath(team.teamSlug, self)));
  });

  it("[control] lead edits their own context; a lead supplying a teammate's member id is refused not allowed without mutation", async () => {
    const team = await seedTeam();
    const lead = team.memberId;
    await signIn(team.teamId, lead, "lead");
    const teammate = await addMember(team.teamId);
    await seedProfile(team.teamId, teammate);

    const own = await saveProfile(team.teamSlug, lead, { bio: "lead self bio" });

    const afterOwn = await contextState();
    expect(own).toEqual({ ok: true });
    expect(afterOwn.profiles.find((row) => row.member_id === lead)).toMatchObject({
      team_id: team.teamId,
      bio: "lead self bio",
      updated_by: lead,
    });
    expect(revalidatedPaths()).toEqual([peoplePath(team.teamSlug, lead)]);

    const refused = {
      saveProfile: await saveProfile(team.teamSlug, teammate, { bio: "lead overwrite" }),
      addMemberTimeOff: await addMemberTimeOff(team.teamSlug, teammate, TIME_OFF),
      saveMemberGoal: await saveMemberGoal(team.teamSlug, teammate, { title: "lead-authored teammate goal" }),
    };

    const afterRefused = await contextState();
    expect({ refused, ...afterRefused, revalidated: revalidatedPaths() }).toEqual({
      refused: { saveProfile: NOT_ALLOWED, addMemberTimeOff: NOT_ALLOWED, saveMemberGoal: NOT_ALLOWED },
      ...afterOwn,
      revalidated: [peoplePath(team.teamSlug, lead)],
    });
  });

  it("[control] active External-posture admin still edits a same-team peer: the editor rule is self-or-role-admin, with no Everyone prerequisite", async () => {
    const team = await seedTeam();
    const externalAdmin = await addMember(team.teamId, { posture: "external" });
    await signIn(team.teamId, externalAdmin, "admin", "external");
    const peer = team.memberId;

    const profile = await saveProfile(team.teamSlug, peer, { bio: "external-posture admin edit" });
    const timeOff = await addMemberTimeOff(team.teamSlug, peer, TIME_OFF);

    const after = await contextState();
    expect(profile).toEqual({ ok: true });
    expect(timeOff.ok).toBe(true);
    expect(after.profiles).toEqual([
      expect.objectContaining({ member_id: peer, team_id: team.teamId, bio: "external-posture admin edit", updated_by: externalAdmin }),
    ]);
    expect(after.timeOff).toEqual([expect.objectContaining({ id: timeOff.id, team_id: team.teamId, member_id: peer })]);
    expect(revalidatedPaths()).toEqual([peoplePath(team.teamSlug, peer), peoplePath(team.teamSlug, peer)]);
  });

  it.each(["invited", "disabled"] as const)(
    "[control] target status is not an eligibility predicate: admin edits a same-team %s member",
    async (status) => {
      const a = await seedTeam();
      await signIn(a.teamId, a.memberId, "admin");
      const target = await addMember(a.teamId, { status });
      premise("target status", (await authority(target)).status, status);

      const profile = await saveProfile(a.teamSlug, target, { bio: `bio for a ${status} member` });
      const goal = await saveMemberGoal(a.teamSlug, target, { title: `goal for a ${status} member` });

      const after = await contextState();
      expect(profile).toEqual({ ok: true });
      expect(goal.ok).toBe(true);
      expect(after.profiles).toEqual([
        expect.objectContaining({ member_id: target, team_id: a.teamId, bio: `bio for a ${status} member` }),
      ]);
      expect(after.goals).toEqual([expect.objectContaining({ id: goal.id, team_id: a.teamId, member_id: target })]);
    },
  );

  it("[control] no session: all six People context actions refuse not allowed for a valid same-team target and mutate nothing", async () => {
    const team = await seedTeam();
    const target = team.memberId;
    await seedProfile(team.teamId, target);
    const timeOffId = await seedTimeOff(team.teamId, target);
    const goalId = await seedGoal(team.teamId, target, { title: "existing goal" });
    premise("nobody is signed in", h.sessionUser, null);
    const before = await contextState();

    const results = {
      saveProfile: await saveProfile(team.teamSlug, target, { bio: "anonymous overwrite" }),
      saveAvatar: await saveAvatar(team.teamSlug, target, VALID_AVATAR),
      addMemberTimeOff: await addMemberTimeOff(team.teamSlug, target, TIME_OFF),
      saveMemberGoal: await saveMemberGoal(team.teamSlug, target, { id: goalId, title: "anonymous overwrite" }),
      deleteMemberTimeOff: await deleteMemberTimeOff(team.teamSlug, target, timeOffId),
      deleteMemberGoal: await deleteMemberGoal(team.teamSlug, target, goalId),
    };

    const after = await contextState();
    expect({ results, ...after, revalidated: revalidatedPaths() }).toEqual({
      results: {
        saveProfile: NOT_ALLOWED,
        saveAvatar: NOT_ALLOWED,
        addMemberTimeOff: NOT_ALLOWED,
        saveMemberGoal: NOT_ALLOWED,
        deleteMemberTimeOff: NOT_ALLOWED,
        deleteMemberGoal: NOT_ALLOWED,
      },
      ...before,
      revalidated: [],
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// Family B2 — an authorized self target never reaches a peer's child resource (AC-10)
// ─────────────────────────────────────────────────────────────────────────────────────────────────

describe("AIO-1217 B2 · People child resources are bound to the authorized target member (AC-10)", () => {
  /** One team: signed-in ordinary member Alice, distinct same-team Bob, and Bob's genuine rows. */
  async function peerFixture() {
    const team = await seedTeam();
    const alice = team.memberId;
    await signIn(team.teamId, alice, "member");
    const bob = await addMember(team.teamId);
    const bobTimeOffId = await seedTimeOff(team.teamId, bob);
    const bobGoalId = await seedGoal(team.teamId, bob, { title: "bob manual goal" });
    const bobImportedGoalId = await seedGoal(team.teamId, bob, {
      title: "bob imported goal",
      source: "jira",
      externalId: PEER_IMPORT_KEY,
    });
    const before = await contextState();
    premise("every seeded child row is Bob's, in this team", {
      timeOff: before.timeOff.map((row) => [row.id, row.team_id, row.member_id]),
      goals: before.goals.map((row) => [row.team_id, row.member_id]),
      importedOwner: before.goals.find((row) => row.id === bobImportedGoalId),
    }, {
      timeOff: [[bobTimeOffId, team.teamId, bob]],
      goals: [[team.teamId, bob], [team.teamId, bob]],
      importedOwner: expect.objectContaining({ member_id: bob, source: "jira", external_id: PEER_IMPORT_KEY }),
    });
    return { team, alice, bob, bobTimeOffId, bobGoalId, bobImportedGoalId, before };
  }

  it("peer time-off id · deleteMemberTimeOff: Alice authorizing her own member id with Bob's time-off id is refused not allowed exactly like an absent id — Bob's row intact, no audit, no revalidation", async () => {
    const { team, alice, bobTimeOffId, before } = await peerFixture();

    const result = await deleteMemberTimeOff(team.teamSlug, alice, bobTimeOffId);

    const after = await contextState();
    const revalidated = revalidatedPaths();
    const absentIdResult = await deleteMemberTimeOff(team.teamSlug, alice, randomUUID());

    expect({ result, absentIdResult, ...after, revalidated }).toEqual({
      result: NOT_ALLOWED,
      absentIdResult: NOT_ALLOWED,
      ...before,
      revalidated: [],
    });
  });

  it("peer goal id · deleteMemberGoal: Alice authorizing her own member id with Bob's goal id is refused not allowed exactly like an absent id — Bob's goal intact, no audit, no revalidation", async () => {
    const { team, alice, bobGoalId, before } = await peerFixture();

    const result = await deleteMemberGoal(team.teamSlug, alice, bobGoalId);

    const after = await contextState();
    const revalidated = revalidatedPaths();
    const absentIdResult = await deleteMemberGoal(team.teamSlug, alice, randomUUID());

    expect({ result, absentIdResult, ...after, revalidated }).toEqual({
      result: NOT_ALLOWED,
      absentIdResult: NOT_ALLOWED,
      ...before,
      revalidated: [],
    });
  });

  it("peer goal id · saveMemberGoal explicit id: Alice authorizing her own member id with Bob's goal id is refused not allowed exactly like an absent id — Bob's owner, title and status unchanged, no audit, no revalidation", async () => {
    const { team, alice, bobGoalId, before } = await peerFixture();

    const result = await saveMemberGoal(team.teamSlug, alice, { id: bobGoalId, title: "synthetic replacement title" });

    const after = await contextState();
    const revalidated = revalidatedPaths();
    const absentIdResult = await saveMemberGoal(team.teamSlug, alice, {
      id: randomUUID(),
      title: "synthetic replacement title",
    });

    expect({ result, absentIdResult, ...after, revalidated }).toEqual({
      result: NOT_ALLOWED,
      absentIdResult: NOT_ALLOWED,
      ...before,
      revalidated: [],
    });
  });

  it("peer imported dedup key · saveMemberGoal source/externalId: Alice supplying Bob's (source, external id) is refused not allowed — Bob's imported goal neither reassigned, altered nor duplicated, no audit, no revalidation", async () => {
    const { team, alice, before } = await peerFixture();

    const result = await saveMemberGoal(team.teamSlug, alice, {
      title: "synthetic replacement title",
      source: "jira",
      externalId: PEER_IMPORT_KEY,
    });

    const after = await contextState();
    expect({ result, ...after, revalidated: revalidatedPaths() }).toEqual({
      result: NOT_ALLOWED,
      ...before,
      revalidated: [],
    });
  });

  it("[control] member deletes their own time-off row: it is removed, audited and revalidated, and the peer's row is untouched", async () => {
    const { team, alice, before } = await peerFixture();
    const ownTimeOffId = await seedTimeOff(team.teamId, alice);

    const result = await deleteMemberTimeOff(team.teamSlug, alice, ownTimeOffId);

    const after = await contextState();
    expect(result).toEqual({ ok: true });
    expect(after.timeOff).toEqual(before.timeOff);
    expect(after.goals).toEqual(before.goals);
    expect(revalidatedPaths()).toEqual([peoplePath(team.teamSlug, alice)]);
    expect(auditSince(before.audit, after.audit)).toEqual([
      expect.objectContaining({ team_id: team.teamId, member_id: alice, action: "timeoff.remove" }),
    ]);
  });

  it("[control] member updates then deletes their own goal by explicit id: the row keeps its owner and id, then is removed; the peer's goals are untouched", async () => {
    const { team, alice, before } = await peerFixture();
    const ownGoalId = await seedGoal(team.teamId, alice, { title: "alice manual goal" });

    const updated = await saveMemberGoal(team.teamSlug, alice, { id: ownGoalId, title: "alice revised goal", status: "done" });

    const afterUpdate = await contextState();
    expect(updated).toEqual({ ok: true, id: ownGoalId });
    expect(afterUpdate.goals.find((row) => row.id === ownGoalId)).toMatchObject({
      team_id: team.teamId,
      member_id: alice,
      title: "alice revised goal",
      status: "done",
    });
    expect(afterUpdate.goals.filter((row) => row.id !== ownGoalId)).toEqual(before.goals);

    const removed = await deleteMemberGoal(team.teamSlug, alice, ownGoalId);

    const afterDelete = await contextState();
    expect(removed).toEqual({ ok: true });
    expect(afterDelete.goals).toEqual(before.goals);
    expect(afterDelete.timeOff).toEqual(before.timeOff);
    expect(revalidatedPaths()).toEqual([peoplePath(team.teamSlug, alice), peoplePath(team.teamSlug, alice)]);
  });

  it("[control] same-member import converges: re-importing Alice's own (source, external id) updates one owned row and returns the same id; the peer's imported goal is untouched", async () => {
    const { team, alice, before } = await peerFixture();

    const first = await saveMemberGoal(team.teamSlug, alice, {
      title: "alice imported goal",
      source: "jira",
      externalId: OWN_IMPORT_KEY,
    });
    const second = await saveMemberGoal(team.teamSlug, alice, {
      title: "alice imported goal (revised)",
      source: "jira",
      externalId: OWN_IMPORT_KEY,
      status: "at_risk",
    });

    const after = await contextState();
    expect(first.ok).toBe(true);
    expect(second).toEqual({ ok: true, id: first.id });
    expect(after.goals.filter((row) => row.external_id === OWN_IMPORT_KEY)).toEqual([
      expect.objectContaining({
        id: first.id,
        team_id: team.teamId,
        member_id: alice,
        source: "jira",
        title: "alice imported goal (revised)",
        status: "at_risk",
      }),
    ]);
    expect(after.goals.filter((row) => row.external_id !== OWN_IMPORT_KEY)).toEqual(before.goals);
  });

  it("[control] admin legitimately edits the peer as the supplied target: Bob's goal is updated in place and stays Bob's, then his time-off and goal are deleted", async () => {
    const { team, alice, bob, bobTimeOffId, bobGoalId, bobImportedGoalId } = await peerFixture();
    await signIn(team.teamId, alice, "admin");

    const updated = await saveMemberGoal(team.teamSlug, bob, { id: bobGoalId, title: "admin-revised bob goal" });

    const afterUpdate = await contextState();
    expect(updated).toEqual({ ok: true, id: bobGoalId });
    expect(afterUpdate.goals.find((row) => row.id === bobGoalId)).toMatchObject({
      team_id: team.teamId,
      member_id: bob,
      title: "admin-revised bob goal",
    });

    const timeOffRemoved = await deleteMemberTimeOff(team.teamSlug, bob, bobTimeOffId);
    const goalRemoved = await deleteMemberGoal(team.teamSlug, bob, bobGoalId);

    const afterDelete = await contextState();
    expect(timeOffRemoved).toEqual({ ok: true });
    expect(goalRemoved).toEqual({ ok: true });
    expect(afterDelete.timeOff).toEqual([]);
    expect(afterDelete.goals.map((row) => [row.id, row.member_id])).toEqual([[bobImportedGoalId, bob]]);
    expect(revalidatedPaths()).toEqual(Array(3).fill(peoplePath(team.teamSlug, bob)));
  });
});
