import { randomUUID } from "node:crypto";
import { NextRequest } from "next/server";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * AIO-1167 R86 F3 — a terminal Drive run report is published only by the connection's LIVE connector
 * (real Postgres, the real report owners and route).
 *
 * Spec (Astra R86 adjudication F3). A report request authenticated BEFORE its API key was revoked, its
 * connector member deactivated, its connector identity or Everyone-derived posture lost, or its binding
 * removed, may not publish afterwards. Scheduled and manual reports share ONE live predicate
 * (`LIVE_GDRIVE_CONNECTOR_SQL` via `lockGdriveReportAuthority`), checked under the report's own locks
 * (identity authority → connection rows → key/member rows → request/report → ledger) so a revocation
 * either commits first and is seen, or waits until the report and its ledger row have committed. A refusal
 * writes no request, report, ledger or status change. Valid current reports, attempt tokens, frozen
 * execution identities, exact and conflicting replays are unchanged.
 */

const ledgerGate = vi.hoisted(() => ({ hold: null as null | { entered: () => void; release: Promise<void> } }));
vi.mock("@/lib/ingest/runs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/ingest/runs")>();
  return {
    ...actual,
    recordIngestRun: async (...args: Parameters<typeof actual.recordIngestRun>) => {
      const hold = ledgerGate.hold;
      if (hold) {
        ledgerGate.hold = null;
        hold.entered();
        await hold.release;
      }
      return actual.recordIngestRun(...args);
    },
  };
});

import { POST as executionPOST } from "@/app/api/v1/integrations/gdrive/execution/route";
import { GET as runsGET } from "@/app/api/v1/integrations/gdrive/runs/route";
import { revokeApiKey } from "@/lib/admin/keys";
import { deleteMember } from "@/lib/admin/members";
import { writeInviteDefaultMembership } from "@/lib/access/groups";
import { getPool, withTransaction } from "@/lib/db/pg/pool";
import { recordIngestRun } from "@/lib/ingest/runs";
import { provisionGdriveConnectorPrincipal } from "@/lib/integrations/gdrive-authority";
import { completeGdriveRun, GdriveScheduledReportRefused, recordScheduledGdriveRun } from "@/lib/integrations/gdrive-runs";
import { upsertIntegration } from "@/lib/integrations/manage";
import { adminClient } from "@/lib/db/admin";
import { approvedAudienceProject, db, seedTeam } from "./helpers";

afterEach(() => {
  ledgerGate.hold = null;
});

type Execution = { generation: number; fence: number; owner: string };

async function connection() {
  const seed = await seedTeam();
  await db().from("members").update({ role: "admin" }).eq("id", seed.memberId).eq("team_id", seed.teamId);
  const row = await upsertIntegration(db(), { teamId: seed.teamId, memberId: seed.memberId }, {
    type: "gdrive", name: `live-${randomUUID().slice(0, 8)}`, status: "enabled",
    config: {
      fileIds: ["DocA"], folderIds: [], sharedDriveIds: [], recursive: false, selectionState: "selected",
      authMode: "service_account", audienceProjectIds: [await approvedAudienceProject(seed)],
    },
  });
  const issued = await provisionGdriveConnectorPrincipal({
    teamId: seed.teamId, integrationId: row.id, actorMemberId: seed.memberId,
  });
  const { rows } = await getPool().query<{ id: string }>(`select id from api_keys where key_id=$1`, [issued.keyId]);
  const principal = { teamId: seed.teamId, apiKeyId: rows[0].id, memberId: issued.memberId };
  return { seed, integrationId: row.id, key: issued.key, principal };
}
type C = Awaited<ReturnType<typeof connection>>;

function request(c: C, url: string, body?: Record<string, unknown>) {
  return new Request(url, {
    method: body ? "POST" : "GET",
    headers: { Authorization: `Bearer ${c.key}`, "X-AIOS-Team": c.seed.teamSlug, "Content-Type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}),
  }) as NextRequest;
}

/** A finished run: acquired, then released normally — still the connection's current execution. */
async function ran(c: C): Promise<Execution> {
  const owner = randomUUID();
  const acquired = await (await executionPOST(request(c, "http://t/api/v1/integrations/gdrive/execution",
    { action: "acquire", integration_id: c.integrationId, owner }))).json();
  const run = { generation: acquired.generation, fence: acquired.fence, owner };
  expect((await executionPOST(request(c, "http://t/api/v1/integrations/gdrive/execution",
    { action: "release", integration_id: c.integrationId, ...run }))).status).toBe(200);
  return run;
}

const SUMMARY = { created: 2, updated: 0, unchanged: 0, removed: 0, failed: 0, skipped: 0, backlog: 0, cursorAgeSeconds: 1, authoritativeComplete: true };
const ledgerRow = (c: C, trigger: "scheduler" | "manual") => async () => recordIngestRun(adminClient(), {
  teamId: c.seed.teamId, source: "gdrive", trigger, ok: true, created: 2, startedAt: Date.now(),
});

/** The scheduled publication, by the principal the request was authenticated as (possibly stale now). */
function scheduled(c: C, execution: Execution, reportId = randomUUID()) {
  return recordScheduledGdriveRun({
    reportId, integrationId: c.integrationId, teamId: c.seed.teamId, apiKeyId: c.principal.apiKeyId,
    memberId: c.principal.memberId, status: "complete", summary: SUMMARY, startedAt: new Date().toISOString(),
    execution, publish: ledgerRow(c, "scheduler"),
  });
}

async function claim(c: C) {
  await db().from("gdrive_run_requests").insert({
    team_id: c.seed.teamId, integration_id: c.integrationId, requested_by: c.seed.memberId, trigger: "manual", status: "pending",
  });
  const claimed = (await (await runsGET(request(c, "http://t/api/v1/integrations/gdrive/runs"))).json()).request;
  return { requestId: claimed.id as string, attemptToken: claimed.attempt_token as string };
}
function manual(c: C, attempt: { requestId: string; attemptToken: string }, execution: Execution) {
  return completeGdriveRun({
    ...attempt, teamId: c.seed.teamId, apiKeyId: c.principal.apiKeyId, memberId: c.principal.memberId,
    status: "complete", summary: SUMMARY, execution, publish: ledgerRow(c, "manual"),
  });
}

const ledger = async (c: C) => (await getPool().query(
  `select 1 from ingest_runs where team_id=$1 and source='gdrive'`, [c.seed.teamId])).rows.length;
const reports = async (c: C) => (await getPool().query(
  `select 1 from gdrive_run_requests where team_id=$1 and trigger='scheduler'`, [c.seed.teamId])).rows.length;
const requestRow = async (id: string) => (await getPool().query<{ status: string; finished_at: Date | null; summary: unknown }>(
  `select status, finished_at, summary from gdrive_run_requests where id=$1`, [id])).rows[0];

/** Every way the authenticated principal stops being the connection's live connector. */
const LOSSES: Record<string, (c: C) => Promise<void>> = {
  "API key revoked": async (c) => revokeApiKey(db(), c.seed.teamId, c.principal.apiKeyId),
  "connector member deactivated": async (c) => {
    await getPool().query(`update members set status='disabled' where id=$1`, [c.principal.memberId]);
  },
  "connector identity lost": async (c) => {
    await getPool().query(`update members set actor_handle='someone-else' where id=$1`, [c.principal.memberId]);
  },
  "Everyone posture lost": async (c) => {
    expect((await writeInviteDefaultMembership(db(), c.seed.teamId, c.principal.memberId, "external", { reconcile: true })).ok).toBe(true);
  },
  "connector member hard-deleted (unbound first)": async (c) => {
    const { rows } = await getPool().query<{ email: string }>(`select email from members where id=$1`, [c.principal.memberId]);
    const deleted = await deleteMember(db(), c.seed.teamId, rows[0].email, {
      hard: true, actor: { kind: "member", memberId: c.seed.memberId },
    });
    expect(deleted).toMatchObject({ deleted: true, mode: "hard" });
  },
};

describe("a report authenticated before the principal lost its authority publishes nothing", () => {
  it.each(Object.keys(LOSSES))("%s: scheduled and manual reports are refused with no mutation", async (loss) => {
    const c = await connection();
    const attempt = await claim(c);
    const execution = await ran(c);
    const before = await requestRow(attempt.requestId);

    await LOSSES[loss](c); // between authentication and publication

    await expect(scheduled(c, execution)).rejects.toMatchObject({ code: "stale_authority" });
    await expect(scheduled(c, execution)).rejects.toBeInstanceOf(GdriveScheduledReportRefused);
    expect(await manual(c, attempt, execution)).toBeNull();
    expect(await reports(c)).toBe(0);
    expect(await requestRow(attempt.requestId)).toEqual(before);
    expect(await ledger(c)).toBe(0);
  });

  it("valid current reports, exact replays and stale attempts keep their contracts; a revoked key refuses the replay too", async () => {
    const c = await connection();
    const execution = await ran(c);
    const reportId = randomUUID();
    expect((await scheduled(c, execution, reportId)).newly_completed).toBe(true);
    expect((await scheduled(c, execution, reportId)).newly_completed).toBe(false); // exact replay
    const attempt = await claim(c);
    expect((await manual(c, attempt, execution))?.newly_completed).toBe(true);
    expect((await manual(c, attempt, execution))?.newly_completed).toBe(false); // exact replay
    expect(await manual(c, { ...attempt, attemptToken: randomUUID() }, execution)).toBeNull(); // stale token
    expect(await ledger(c)).toBe(2);

    await revokeApiKey(db(), c.seed.teamId, c.principal.apiKeyId);
    await expect(scheduled(c, execution, reportId)).rejects.toMatchObject({ code: "stale_authority" });
    expect(await manual(c, attempt, execution)).toBeNull();
    expect(await ledger(c)).toBe(2);
  });
});

describe("publication and revocation serialize, both commit orders", () => {
  async function waitsOnLock(pattern: string): Promise<boolean> {
    for (let tries = 0; tries < 400; tries++) {
      const { rows } = await getPool().query<{ n: number }>(
        `select count(*)::int as n from pg_stat_activity
          where datname=current_database() and wait_event_type='Lock' and query ilike $1`, [pattern]);
      if (rows[0].n > 0) return true;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    return false;
  }

  it.each(["scheduled", "manual"] as const)("%s: a revocation committed first is seen — the waiting report is refused", async (kind) => {
    const c = await connection();
    const attempt = kind === "manual" ? await claim(c) : null;
    const execution = await ran(c);
    const holder = await getPool().connect();
    try {
      await holder.query("begin");
      await holder.query(`update api_keys set revoked_at=now() where id=$1`, [c.principal.apiKeyId]);
      const publication = kind === "scheduled"
        ? scheduled(c, execution).then(() => "published", (e: unknown) => (e as { code?: string }).code)
        : manual(c, attempt!, execution).then((r) => (r ? "published" : "refused"));
      expect(await waitsOnLock("%from api_keys k%for update of k, m%"), "the report waited on the revocation").toBe(true);
      await holder.query("commit");
      expect(await publication).toBe(kind === "scheduled" ? "stale_authority" : "refused");
    } finally {
      await holder.query("rollback").catch(() => {});
      holder.release();
    }
    expect(await ledger(c)).toBe(0);
    expect(await reports(c)).toBe(0);
  });

  it.each(["scheduled", "manual"] as const)("%s: a report publishing first completes with its ledger row; the revocation waits", async (kind) => {
    const c = await connection();
    const attempt = kind === "manual" ? await claim(c) : null;
    const execution = await ran(c);
    let entered!: () => void;
    const inLedger = new Promise<void>((resolve) => { entered = resolve; });
    let open!: () => void;
    ledgerGate.hold = { entered: () => entered(), release: new Promise<void>((resolve) => { open = resolve; }) };

    const publication = kind === "scheduled" ? scheduled(c, execution) : manual(c, attempt!, execution);
    await inLedger; // validated, report written, ledger publication in progress — locks held
    const revocation = getPool().query(`update api_keys set revoked_at=now() where id=$1 /* r86-revoke */`, [c.principal.apiKeyId]);
    expect(await waitsOnLock("%r86-revoke%"), "the revocation waited on the publication").toBe(true);
    open();
    expect(await publication).toMatchObject({ newly_completed: true });
    await revocation;
    expect(await ledger(c)).toBe(1);
    const { rows } = await getPool().query(`select revoked_at from api_keys where id=$1`, [c.principal.apiKeyId]);
    expect(rows[0].revoked_at).not.toBeNull();
  });
});

/**
 * AIO-1167 R87 — the Everyone posture is read in a FRESH snapshot after the key/member lock. A sanctioned
 * posture move (`writeInviteDefaultMembership(..., "external", { reconcile: true })`) holds the member row
 * `for no key update`, deletes Everyone and commits WITHOUT updating the member tuple; a report statement
 * that evaluated posture in its locking statement would keep its pre-wait snapshot and still see Everyone.
 */
describe("R87: posture narrowing vs report publication, both commit orders", () => {
  async function waitsOnLock(pattern: string): Promise<boolean> {
    for (let tries = 0; tries < 400; tries++) {
      const { rows } = await getPool().query<{ n: number }>(
        `select count(*)::int as n from pg_stat_activity
          where datname=current_database() and wait_event_type='Lock' and query ilike $1`, [pattern]);
      if (rows[0].n > 0) return true;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    return false;
  }
  const requestState = async (id: string) => (await getPool().query(
    `select status, attempt_token, summary, error, started_at, finished_at from gdrive_run_requests where id=$1`, [id])).rows[0];
  const memberTuple = async (c: C) => (await getPool().query(
    `select xmin::text as xmin, tier from members where id=$1`, [c.principal.memberId])).rows[0];

  it.each(["scheduled", "manual"] as const)("%s: removal first — the report waits on the member lock, then refuses", async (kind) => {
    const c = await connection();
    const attempt = kind === "manual" ? await claim(c) : null;
    const execution = await ran(c);
    const before = attempt ? await requestState(attempt.requestId) : null;
    const reportsBefore = await reports(c);
    const ledgerBefore = await ledger(c);
    const tupleBefore = await memberTuple(c);

    let narrowed!: () => void;
    const inNarrowing = new Promise<void>((resolve) => { narrowed = resolve; });
    let commit!: () => void;
    const committing = new Promise<void>((resolve) => { commit = resolve; });
    const narrowing = withTransaction(async () => {
      const result = await writeInviteDefaultMembership(db(), c.seed.teamId, c.principal.memberId, "external", { reconcile: true });
      narrowed(); // Everyone deleted, member row held — the outer transaction is still open
      await committing;
      return result;
    });
    await inNarrowing;

    const publication = kind === "scheduled"
      ? scheduled(c, execution).then(() => "published", (e: unknown) => (e as { code?: string }).code ?? String(e))
      : manual(c, attempt!, execution).then((r) => (r === null ? null : "published"));
    // R93: the posture narrowing holds the team identity boundary, so the report queues there first.
    expect(await waitsOnLock("%pg_advisory_xact_lock(hashtextextended%"), "the report waited on the narrowing at the identity boundary").toBe(true);
    commit();
    expect(await narrowing).toEqual({ ok: true });
    // The race is real: the narrowing never rewrote the member tuple — only Everyone's row changed.
    expect(await memberTuple(c)).toEqual(tupleBefore);
    expect(await publication).toBe(kind === "scheduled" ? "stale_authority" : null);

    expect(await reports(c)).toBe(reportsBefore);
    expect(await ledger(c)).toBe(ledgerBefore);
    if (attempt) expect(await requestState(attempt.requestId)).toEqual(before);
  });

  it.each(["scheduled", "manual"] as const)("%s: publication first — the posture move waits, lands after, and the next report refuses", async (kind) => {
    const c = await connection();
    const attempt = kind === "manual" ? await claim(c) : null;
    const execution = await ran(c);
    let entered!: () => void;
    const inLedger = new Promise<void>((resolve) => { entered = resolve; });
    let open!: () => void;
    ledgerGate.hold = { entered: () => entered(), release: new Promise<void>((resolve) => { open = resolve; }) };

    const publication = kind === "scheduled" ? scheduled(c, execution) : manual(c, attempt!, execution);
    await inLedger; // validated, report written, ledger publication in progress — locks held
    const narrowing = writeInviteDefaultMembership(db(), c.seed.teamId, c.principal.memberId, "external", { reconcile: true });
    // R93: the posture move queues at the team identity boundary the report already holds.
    expect(await waitsOnLock("%pg_advisory_xact_lock(hashtextextended%"), "the posture move waited on the report at the identity boundary").toBe(true);
    open();
    expect(await publication).toMatchObject({ newly_completed: true });
    expect(await narrowing).toEqual({ ok: true });
    expect(await ledger(c)).toBe(1);
    expect(await reports(c)).toBe(kind === "scheduled" ? 1 : 0);
    const { rows } = await getPool().query(
      `select 1 from group_members gm join groups g on g.id=gm.group_id
        where gm.member_id=$1 and g.slug='everyone' and g.is_builtin`, [c.principal.memberId]);
    expect(rows, "the posture removal committed").toEqual([]);

    // Any later report now refuses.
    if (kind === "scheduled") {
      await expect(scheduled(c, execution)).rejects.toMatchObject({ code: "stale_authority" });
    } else {
      // The connector can no longer even CLAIM (the runs route authenticates a connector only with team
      // posture), so the next attempt is a request already running under its own token.
      const { rows: next } = await getPool().query<{ id: string; attempt_token: string }>(
        `insert into gdrive_run_requests(team_id, integration_id, requested_by, trigger, status, started_at, attempt_token)
         values ($1,$2,$3,'manual','running',now(),gen_random_uuid()) returning id, attempt_token`,
        [c.seed.teamId, c.integrationId, c.seed.memberId]);
      expect(await manual(c, { requestId: next[0].id, attemptToken: next[0].attempt_token }, execution)).toBeNull();
    }
    expect(await ledger(c)).toBe(1);
  });
});
