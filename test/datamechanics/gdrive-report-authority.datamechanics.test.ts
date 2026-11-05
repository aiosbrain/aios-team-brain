import { randomUUID } from "node:crypto";
import { NextRequest } from "next/server";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * AIO-1167 R83 F1 — a terminal Drive run report stays bound to the execution authority that produced it
 * (real Postgres, the real `runs` route and Drive authority owner).
 *
 * Spec (Astra R83 adjudication F1).
 *   · A report names the execution that produced it — `{generation, fence, owner}`, frozen at its
 *     acquisition — and is accepted only while that execution is still the connection's: the same
 *     generation and fence, the lease still its owner's or released normally. A healthy completion
 *     reported right after its own release is accepted.
 *   · A delayed report from a SUPERSEDED execution — a scope change, a reconnect, a scope A→B→A, a
 *     same-generation lease replacement, a pause→resume — is refused (409 `stale_execution`) for
 *     scheduled and manual runs alike: after newer failures it never becomes the latest report or
 *     success, never appends a ledger row and never clears the failure streak.
 *   · Validation and the ledger publication share one authority-locked transaction: a transition can
 *     land neither between them nor under them.
 *   · An exact lost-response replay writes nothing twice — even after the authority moved; a replay
 *     naming a different execution is a conflict; a stale attempt token stays refused.
 *   · A busy deferral and a failure before acquisition name no execution and are kept as truthful
 *     diagnostics; a `complete`/`partial` report naming none (legacy) certifies nothing.
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
import { GET as runsGET, POST as runsPOST } from "@/app/api/v1/integrations/gdrive/runs/route";
import { getPool } from "@/lib/db/pg/pool";
import { getPipelineHealth } from "@/lib/ingest/pipeline-health";
import { provisionGdriveConnectorPrincipal } from "@/lib/integrations/gdrive-authority";
import { listGdriveRunStatus } from "@/lib/integrations/gdrive-runs";
import { setIntegrationSecret, setIntegrationStatus, upsertIntegration } from "@/lib/integrations/manage";
import { approvedAudienceProject, db, seedTeam } from "./helpers";

afterEach(() => {
  ledgerGate.hold = null;
});

const RUNS = "http://test/api/v1/integrations/gdrive/runs";
const EXECUTION = "http://test/api/v1/integrations/gdrive/execution";
type Execution = { generation: number; fence: number; owner: string };

async function connection() {
  const seed = await seedTeam();
  await db().from("members").update({ role: "admin" }).eq("id", seed.memberId).eq("team_id", seed.teamId);
  const audienceProjectId = await approvedAudienceProject(seed);
  const row = await upsertIntegration(db(), { teamId: seed.teamId, memberId: seed.memberId }, {
    type: "gdrive", name: `report-${randomUUID().slice(0, 8)}`, status: "enabled",
    config: {
      fileIds: ["DocA"], folderIds: [], sharedDriveIds: [], recursive: false,
      selectionState: "selected", authMode: "service_account", audienceProjectIds: [audienceProjectId],
    },
  });
  const issued = await provisionGdriveConnectorPrincipal({
    teamId: seed.teamId, integrationId: row.id, actorMemberId: seed.memberId,
  });
  return { seed, integrationId: row.id, key: issued.key };
}
type C = Awaited<ReturnType<typeof connection>>;

function call(c: C, url: string, body?: Record<string, unknown>) {
  const handler = url === RUNS ? (body ? runsPOST : runsGET) : executionPOST;
  return handler(new Request(url, {
    method: body ? "POST" : "GET",
    headers: { Authorization: `Bearer ${c.key}`, "X-AIOS-Team": c.seed.teamSlug, "Content-Type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}),
  }) as NextRequest);
}

/** Acquire an execution for a run; `release` ends it normally, as a finished coordinator does. */
async function acquire(c: C): Promise<Execution> {
  const owner = randomUUID();
  const response = await call(c, EXECUTION, { action: "acquire", integration_id: c.integrationId, owner });
  expect(response.status).toBe(200);
  const body = await response.json();
  return { generation: body.generation, fence: body.fence, owner };
}
async function release(c: C, run: Execution) {
  const response = await call(c, EXECUTION, { action: "release", integration_id: c.integrationId, ...run });
  expect(response.status).toBe(200);
}
async function ran(c: C): Promise<Execution> {
  const run = await acquire(c);
  await release(c, run);
  return run;
}

const COMPLETE = { status: "complete", created: 3, backlog: 0, authoritativeComplete: true };
const FAILURE = { status: "failed", failed: 1, error: "provider_unavailable", backlog: null, authoritativeComplete: false };
const BUSY = {
  status: "deferred", error: "execution_busy", skipped: 1, backlog: null, authoritativeComplete: false,
};

async function scheduled(c: C, fields: Record<string, unknown>, execution?: Execution | null, reportId = randomUUID()) {
  const response = await call(c, RUNS, {
    reportId, integrationId: c.integrationId, trigger: "scheduler", startedAt: new Date().toISOString(),
    ...(execution ? { execution } : {}), ...fields,
  });
  return { status: response.status, code: response.status === 200 ? null : (await response.json()).error.code as string, reportId };
}

async function claimManual(c: C): Promise<{ requestId: string; attemptToken: string }> {
  const { data } = await db().from("gdrive_run_requests").insert({
    team_id: c.seed.teamId, integration_id: c.integrationId, requested_by: c.seed.memberId,
    trigger: "manual", status: "pending",
  }).select("id").single();
  const claimed = await (await call(c, RUNS)).json();
  expect(claimed.request.id).toBe((data as { id: string }).id);
  return { requestId: claimed.request.id, attemptToken: claimed.request.attempt_token };
}
async function manual(c: C, claim: { requestId: string; attemptToken: string }, fields: Record<string, unknown>, execution?: Execution | null) {
  const response = await call(c, RUNS, { ...claim, ...(execution ? { execution } : {}), ...fields });
  return { status: response.status, code: response.status === 200 ? null : (await response.json()).error.code as string };
}

async function ledger(c: C): Promise<boolean[]> {
  const { rows } = await getPool().query<{ ok: boolean }>(
    `select ok from ingest_runs where team_id=$1 and source='gdrive' order by id`, [c.seed.teamId]);
  return rows.map((row) => row.ok);
}
async function status(c: C) {
  return (await listGdriveRunStatus(c.seed.teamId))[c.integrationId];
}
async function gdriveHealthy(c: C): Promise<boolean> {
  const leg = (await getPipelineHealth(c.seed.teamId)).legs.find((l) => l.source === "gdrive");
  return leg?.ok === true;
}
async function authority(c: C) {
  const { rows } = await getPool().query<{ generation: string; fence: string; lease_owner: string | null }>(
    `select generation, fence, lease_owner from gdrive_connection_authority where integration_id=$1`, [c.integrationId]);
  return { generation: Number(rows[0].generation), fence: Number(rows[0].fence), leaseOwner: rows[0].lease_owner };
}

/** The scope / credential transitions a delayed report must not survive. */
const TRANSITIONS: Record<string, (c: C) => Promise<void>> = {
  "scope change": async (c) => {
    await getPool().query(`update integrations set config = jsonb_set(config, '{fileIds}', '["DocB"]') where id=$1`, [c.integrationId]);
  },
  reconnect: async (c) => {
    await setIntegrationSecret(db(), { teamId: c.seed.teamId, memberId: c.seed.memberId }, c.integrationId,
      JSON.stringify({ type: "service_account", rotated: randomUUID() }));
  },
  "scope A→B→A": async (c) => {
    await getPool().query(`update integrations set config = jsonb_set(config, '{fileIds}', '["DocB"]') where id=$1`, [c.integrationId]);
    await getPool().query(`update integrations set config = jsonb_set(config, '{fileIds}', '["DocA"]') where id=$1`, [c.integrationId]);
  },
};

describe("a delayed success from a superseded generation never becomes current (scheduled and manual)", () => {
  it.each(Object.keys(TRANSITIONS))("scheduled, across a %s, after newer failures", async (name) => {
    const c = await connection();
    const old = await ran(c); // its success is delayed in delivery
    await TRANSITIONS[name](c);
    expect((await authority(c)).generation).toBeGreaterThan(old.generation);
    for (let n = 0; n < 2; n++) expect((await scheduled(c, FAILURE, await ran(c))).status).toBe(200);
    expect(await ledger(c)).toEqual([false, false]);

    const delayed = await scheduled(c, COMPLETE, old);
    expect(delayed).toMatchObject({ status: 409, code: "stale_execution" });
    expect(await ledger(c)).toEqual([false, false]);
    const after = await status(c);
    expect(after.latestSuccess).toBeNull();
    expect(after.latestReport).toMatchObject({ status: "failed" });
    expect(await gdriveHealthy(c)).toBe(false);
    const { rows } = await getPool().query(`select 1 from gdrive_run_requests where id=$1`, [delayed.reportId]);
    expect(rows).toEqual([]);
  });

  it.each(Object.keys(TRANSITIONS))("manual, across a %s, after newer failures", async (name) => {
    const c = await connection();
    const claim = await claimManual(c);
    const old = await ran(c);
    await TRANSITIONS[name](c);
    for (let n = 0; n < 2; n++) expect((await scheduled(c, FAILURE, await ran(c))).status).toBe(200);

    expect(await manual(c, claim, COMPLETE, old)).toMatchObject({ status: 409, code: "stale_execution" });
    const { rows } = await getPool().query<{ status: string; finished_at: Date | null }>(
      `select status, finished_at from gdrive_run_requests where id=$1`, [claim.requestId]);
    expect(rows[0]).toMatchObject({ status: "running", finished_at: null });
    expect(await ledger(c)).toEqual([false, false]);
    expect((await status(c)).latestSuccess).toBeNull();
    expect(await gdriveHealthy(c)).toBe(false);
  });
});

describe("the same generation, a different fence: lease replacement and pause→resume", () => {
  it("a replacement lease supersedes the older execution's report", async () => {
    const c = await connection();
    const old = await acquire(c); // still holds its lease…
    await getPool().query(
      `update gdrive_connection_authority set lease_until = now() - interval '1 second' where integration_id=$1`,
      [c.integrationId]);
    const replacement = await ran(c); // …until it expires and another coordinator takes over
    expect(replacement.generation).toBe(old.generation);
    expect(replacement.fence).toBeGreaterThan(old.fence);
    expect((await scheduled(c, FAILURE, replacement)).status).toBe(200);

    expect(await scheduled(c, COMPLETE, old)).toMatchObject({ status: 409, code: "stale_execution" });
    const claim = await claimManual(c);
    expect(await manual(c, claim, COMPLETE, old)).toMatchObject({ status: 409, code: "stale_execution" });
    expect(await ledger(c)).toEqual([false]);
    expect((await status(c)).latestSuccess).toBeNull();
  });

  it("a pause→resume fences off a run that finished before it", async () => {
    const c = await connection();
    const old = await ran(c);
    const admin = { teamId: c.seed.teamId, memberId: c.seed.memberId };
    await setIntegrationStatus(db(), admin, c.integrationId, "disabled");
    await setIntegrationStatus(db(), admin, c.integrationId, "enabled");
    expect(await authority(c)).toMatchObject({ generation: old.generation, leaseOwner: null });
    expect((await authority(c)).fence).toBeGreaterThan(old.fence);

    expect(await scheduled(c, COMPLETE, old)).toMatchObject({ status: 409, code: "stale_execution" });
    expect(await ledger(c)).toEqual([]);
  });
});

describe("a healthy completion is accepted while its execution is current", () => {
  it("reported right after its normal lease release, and while still holding it", async () => {
    const c = await connection();
    expect((await scheduled(c, FAILURE, await ran(c))).status).toBe(200);
    const released = await ran(c);
    expect(await authority(c)).toMatchObject({ generation: released.generation, fence: released.fence, leaseOwner: null });
    expect((await scheduled(c, COMPLETE, released)).status).toBe(200);
    expect(await ledger(c)).toEqual([false, true]);
    expect((await status(c)).latestSuccess).toMatchObject({ status: "complete" });
    expect(await gdriveHealthy(c)).toBe(true);

    const holding = await acquire(c);
    const claim = await claimManual(c);
    expect((await manual(c, claim, COMPLETE, holding)).status).toBe(200);
    expect(await ledger(c)).toEqual([false, true, true]);
  });
});

describe("validation and ledger publication cannot race an authority transition", () => {
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

  it("a scope change issued while the success is being published waits for it, and lands after", async () => {
    const c = await connection();
    expect((await scheduled(c, FAILURE, await ran(c))).status).toBe(200);
    const run = await ran(c);
    let entered!: () => void;
    const inLedger = new Promise<void>((resolve) => { entered = resolve; });
    let open!: () => void;
    ledgerGate.hold = { entered: () => entered(), release: new Promise<void>((resolve) => { open = resolve; }) };

    const delivery = scheduled(c, COMPLETE, run);
    await inLedger; // validated, report written, ledger publication in progress — locks held
    const transition = getPool().query(
      `update integrations set config = jsonb_set(config, '{fileIds}', '["DocB"]') where id=$1 /* r83-transition */`,
      [c.integrationId]);
    expect(await waitsOnLock("%r83-transition%"), "the transition never waited on the report").toBe(true);
    expect((await authority(c)).generation).toBe(run.generation);
    open();
    expect((await delivery).status).toBe(200);
    await transition;
    expect(await ledger(c)).toEqual([false, true]);
    expect((await authority(c)).generation).toBe(run.generation + 1); // landed AFTER the publication
  });

  it("a report delivered while a transition is in flight waits for it, and is then refused", async () => {
    const c = await connection();
    const run = await ran(c);
    const holder = await getPool().connect();
    try {
      await holder.query("begin");
      await holder.query(`update integrations set config = jsonb_set(config, '{fileIds}', '["DocB"]') where id=$1`, [c.integrationId]);
      const delivery = scheduled(c, COMPLETE, run);
      expect(await waitsOnLock("%join gdrive_connection_authority a%for update of i, a%"),
        "the report never waited on the transition").toBe(true);
      await holder.query("commit");
      expect(await delivery).toMatchObject({ status: 409, code: "stale_execution" });
    } finally {
      await holder.query("rollback").catch(() => {});
      holder.release();
    }
    expect(await ledger(c)).toEqual([]);
  });
});

describe("replays and attempt ownership keep their contracts with an execution identity", () => {
  it("an exact lost-response replay writes nothing twice — even after the authority moved", async () => {
    const c = await connection();
    const run = await ran(c);
    const first = await scheduled(c, COMPLETE, run);
    expect(first.status).toBe(200);
    expect((await scheduled(c, COMPLETE, run, first.reportId)).status).toBe(200);
    await TRANSITIONS["scope change"](c);
    expect((await scheduled(c, COMPLETE, run, first.reportId)).status).toBe(200);
    expect(await ledger(c)).toEqual([true]);
    const { rows } = await getPool().query<{ summary: { execution: Execution } }>(
      `select summary from gdrive_run_requests where id=$1`, [first.reportId]);
    expect(rows[0].summary.execution).toEqual(run);
  });

  it("a replay naming a different execution is a conflict; a stale attempt token stays refused", async () => {
    const c = await connection();
    const run = await ran(c);
    const first = await scheduled(c, COMPLETE, run);
    expect(await scheduled(c, COMPLETE, { ...run, owner: randomUUID() }, first.reportId))
      .toMatchObject({ status: 409, code: "conflicting_report" });
    expect(await scheduled(c, COMPLETE, null, first.reportId))
      .toMatchObject({ status: 409, code: "conflicting_report" });

    const claim = await claimManual(c);
    const manualRun = await ran(c);
    expect((await manual(c, claim, COMPLETE, manualRun)).status).toBe(200);
    expect((await manual(c, claim, COMPLETE, manualRun)).status).toBe(200); // exact replay
    expect(await manual(c, claim, COMPLETE, { ...manualRun, fence: manualRun.fence + 1 }))
      .toMatchObject({ status: 409, code: "stale_execution" });
    expect(await manual(c, { ...claim, attemptToken: randomUUID() }, COMPLETE, manualRun))
      .toMatchObject({ status: 409, code: "stale_execution" });
    expect(await ledger(c)).toEqual([true, true]);
  });
});

describe("no execution identity: truthful diagnostics, never success or progress", () => {
  it("busy and pre-acquisition failure are kept as diagnostics; complete/partial without identity are refused", async () => {
    const c = await connection();
    expect((await scheduled(c, BUSY, null)).status).toBe(200); // neutral: durable report, no ledger row
    expect(await ledger(c)).toEqual([]);
    expect((await scheduled(c, { ...FAILURE, error: "connection_unavailable" }, null)).status).toBe(200);
    expect(await ledger(c)).toEqual([false]);

    expect(await scheduled(c, COMPLETE, null)).toMatchObject({ status: 409, code: "stale_execution" });
    expect(await scheduled(c, { status: "partial", created: 2, backlog: 3 }, null))
      .toMatchObject({ status: 409, code: "stale_execution" });
    const claim = await claimManual(c);
    expect(await manual(c, claim, COMPLETE, null)).toMatchObject({ status: 409, code: "stale_execution" });
    expect((await manual(c, claim, BUSY, null)).status).toBe(200); // a busy manual attempt defers truthfully

    expect(await ledger(c)).toEqual([false]);
    const after = await status(c);
    expect(after.latestSuccess).toBeNull();
    expect(after.latestReport).toMatchObject({ status: "failed" });
    expect(await gdriveHealthy(c)).toBe(false);
  });
});
