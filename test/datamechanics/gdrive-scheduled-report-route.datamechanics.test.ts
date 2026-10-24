import { randomUUID } from "node:crypto";
import { NextRequest } from "next/server";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * AIO-1167 r37 — what the scheduled Drive report route answers when recording fails (real Postgres).
 *
 * Spec.
 *   · TYPED refusals are final and keep a fixed 409: the reporting connector no longer holds the
 *     connection's authority (`stale_execution`), or the report id already names a DIFFERENT report
 *     (`conflicting_report`). Neither writes a report or a ledger row.
 *   · INFRASTRUCTURE failures (a lock timeout, a deadlock, any other database error) are a fixed,
 *     retryable 503 with `Retry-After` — never a 409 that tells the connector to give up, and never
 *     the database's own text.
 *   · CONCURRENT FIRST DELIVERY of one report is safe: the delivery that loses the insert race waits
 *     for the winner, re-reads the winner's row under CURRENT authority, and is a success only as an
 *     exact replay of it. A unique violation by itself is never a success.
 *
 * The race is real: a held transaction inserts the report first, and the route's own insert is
 * observed waiting on it in `pg_stat_activity` before the holder commits — a fact, not a delay.
 * Infrastructure failures are injected at the one `runSql` seam, on the report insert only.
 */
const failing = vi.hoisted(() => ({ next: null as null | { match: RegExp; error: Error } }));

vi.mock("@/lib/db/pg/pool", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/db/pg/pool")>();
  const runSql = (async (...args: Parameters<typeof actual.runSql>) => {
    const injected = failing.next;
    if (injected && injected.match.test(String(args[0]))) {
      failing.next = null;
      throw injected.error;
    }
    return actual.runSql(...args);
  }) as typeof actual.runSql;
  return { ...actual, runSql };
});

import { POST as runsPOST } from "@/app/api/v1/integrations/gdrive/runs/route";
import { getPool } from "@/lib/db/pg/pool";
import { provisionGdriveConnectorPrincipal } from "@/lib/integrations/gdrive-authority";
import { upsertIntegration } from "@/lib/integrations/manage";
import { approvedAudienceProject, db, seedTeam, type Seed } from "./helpers";

afterEach(() => {
  failing.next = null;
});

async function integration(seed: Seed, name: string): Promise<string> {
  const audienceProjectId = await approvedAudienceProject(seed);
  const row = await upsertIntegration(db(), { teamId: seed.teamId, memberId: seed.memberId }, {
    type: "gdrive", name, status: "enabled",
    config: {
      fileIds: ["Doc"], folderIds: [], sharedDriveIds: [], recursive: false,
      selectionState: "selected", authMode: "service_account", audienceProjectIds: [audienceProjectId],
    },
  });
  return row.id;
}

async function scheduled() {
  const seed = await seedTeam();
  await db().from("members").update({ role: "admin" }).eq("id", seed.memberId).eq("team_id", seed.teamId);
  const integrationId = await integration(seed, `scheduled-${randomUUID().slice(0, 8)}`);
  const issued = await provisionGdriveConnectorPrincipal({
    teamId: seed.teamId, integrationId, actorMemberId: seed.memberId,
  });
  return { seed, integrationId, key: issued.key, connectorMemberId: issued.memberId };
}

type S = Awaited<ReturnType<typeof scheduled>>;

/** One scheduled report body; the route stores exactly SUMMARY for it. */
function body(s: S, reportId: string, over: Record<string, unknown> = {}) {
  return {
    reportId, integrationId: s.integrationId, trigger: "scheduler", startedAt: new Date().toISOString(),
    status: "complete", created: 2, backlog: 0, cursorAgeSeconds: 5, authoritativeComplete: true, ...over,
  };
}
const SUMMARY = {
  created: 2, updated: 0, unchanged: 0, removed: 0, failed: 0, skipped: 0,
  backlog: 0, cursorAgeSeconds: 5, authoritativeComplete: true,
};

function post(s: S, payload: unknown) {
  return runsPOST(new Request("http://test/api/v1/integrations/gdrive/runs", {
    method: "POST",
    headers: { Authorization: `Bearer ${s.key}`, "X-AIOS-Team": s.seed.teamSlug, "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  }) as NextRequest);
}

async function reportRows(reportId: string) {
  const { rows } = await getPool().query<{ status: string; integration_id: string }>(
    `select status, integration_id from gdrive_run_requests where id=$1`, [reportId]);
  return rows;
}

async function ledger(s: S) {
  const { rows } = await getPool().query<{ ok: boolean }>(
    `select ok from ingest_runs where team_id=$1 and source='gdrive' order by id`, [s.seed.teamId]);
  return rows.map((r) => r.ok);
}

/**
 * Insert report `reportId` in a transaction that stays OPEN, run `alsoInHolder` inside it, start the
 * route's delivery, wait until that delivery's own insert is blocked on the held row, then commit.
 */
async function loseTheInsertRace(
  s: S, reportId: string, payload: unknown,
  held: { status: string; summary: Record<string, unknown>; integrationId?: string },
  alsoInHolder: (q: (sql: string, params: unknown[]) => Promise<unknown>) => Promise<void> = async () => {},
) {
  const holder = await getPool().connect();
  try {
    await holder.query("begin");
    await holder.query(
      `insert into gdrive_run_requests
       (id,team_id,integration_id,trigger,status,created_at,started_at,finished_at,summary,error)
       values($1,$2,$3,'scheduler',$4,now(),now(),now(),$5::jsonb,null)`,
      [reportId, s.seed.teamId, held.integrationId ?? s.integrationId, held.status, JSON.stringify(held.summary)],
    );
    await alsoInHolder((sql, params) => holder.query(sql, params));
    let settled = false;
    const delivery = post(s, payload).finally(() => { settled = true; });
    // The delivery must reach ITS insert and wait there; otherwise this is not the race.
    let waited = false;
    for (let tries = 0; tries < 400 && !settled && !waited; tries++) {
      const { rows } = await getPool().query<{ n: number }>(
        `select count(*)::int as n from pg_stat_activity
          where datname=current_database() and wait_event_type='Lock'
            and query ilike '%insert into gdrive_run_requests%on conflict%'`);
      waited = rows[0].n > 0;
      if (!waited) await new Promise((resolve) => setTimeout(resolve, 25));
    }
    expect(settled, "the delivery finished before reaching the contested insert").toBe(false);
    expect(waited, "the delivery's insert never waited on the held report").toBe(true);
    await holder.query("commit");
    return await delivery;
  } catch (error) {
    await holder.query("rollback").catch(() => {});
    throw error;
  } finally {
    holder.release();
  }
}

describe("AIO-1167 r37 concurrent first delivery of one scheduled report (real Postgres)", () => {
  it("the delivery that loses the race to an identical report is an idempotent success", async () => {
    const s = await scheduled();
    const reportId = randomUUID();
    const response = await loseTheInsertRace(s, reportId, body(s, reportId), { status: "complete", summary: SUMMARY });
    expect(response.status).toBe(200);
    expect(await reportRows(reportId)).toEqual([{ status: "complete", integration_id: s.integrationId }]);
    // The loser is a replay: it appends nothing (the winner, here the holder, owns any ledger row).
    expect(await ledger(s)).toEqual([]);
  });

  it("losing the race to a DIFFERENT report under the same id is a conflict, not a success", async () => {
    const s = await scheduled();
    const reportId = randomUUID();
    const response = await loseTheInsertRace(
      s, reportId, body(s, reportId), { status: "failed", summary: { ...SUMMARY, failed: 1 } },
    );
    expect(response.status).toBe(409);
    expect((await response.json()).error.code).toBe("conflicting_report");
    expect(await reportRows(reportId)).toEqual([{ status: "failed", integration_id: s.integrationId }]);
    expect(await ledger(s)).toEqual([]);
  });

  it("the same id held by ANOTHER connection is a conflict even with identical content", async () => {
    const s = await scheduled();
    const other = await integration(s.seed, `other-${randomUUID().slice(0, 8)}`);
    const reportId = randomUUID();
    const response = await loseTheInsertRace(
      s, reportId, body(s, reportId), { status: "complete", summary: SUMMARY, integrationId: other },
    );
    expect(response.status).toBe(409);
    expect((await response.json()).error.code).toBe("conflicting_report");
    expect(await ledger(s)).toEqual([]);
  });

  it("the race's winner is accepted only under CURRENT authority: a connector deactivated meanwhile is stale", async () => {
    const s = await scheduled();
    const reportId = randomUUID();
    const response = await loseTheInsertRace(
      s, reportId, body(s, reportId), { status: "complete", summary: SUMMARY },
      // Committed together with the winning row, after the delivery passed its first authority check.
      (q) => q(`update members set status='disabled' where id=$1`, [s.connectorMemberId]).then(() => {}),
    );
    expect(response.status).toBe(409);
    expect((await response.json()).error.code).toBe("stale_execution");
    expect(await ledger(s)).toEqual([]);
  });
});

describe("AIO-1167 r37 typed refusals versus infrastructure failure (real Postgres)", () => {
  it("an exact sequential replay is still an idempotent success", async () => {
    const s = await scheduled();
    const reportId = randomUUID();
    expect((await post(s, body(s, reportId))).status).toBe(200);
    expect((await post(s, body(s, reportId))).status).toBe(200);
    expect(await reportRows(reportId)).toHaveLength(1);
    expect(await ledger(s)).toEqual([true]);
  });

  it("a conflicting sequential replay is a fixed 409 that rewrites nothing", async () => {
    const s = await scheduled();
    const reportId = randomUUID();
    expect((await post(s, body(s, reportId))).status).toBe(200);
    const conflict = await post(s, body(s, reportId, { status: "failed", failed: 1, authoritativeComplete: false }));
    expect(conflict.status).toBe(409);
    expect((await conflict.json()).error).toMatchObject({
      code: "conflicting_report", message: "Google Drive scheduled report conflicts with the recorded report",
    });
    expect(await reportRows(reportId)).toEqual([{ status: "complete", integration_id: s.integrationId }]);
    expect(await ledger(s)).toEqual([true]);
  });

  it("a report for a connection this connector holds no authority over is a fixed stale 409", async () => {
    const s = await scheduled();
    const unbound = await integration(s.seed, `unbound-${randomUUID().slice(0, 8)}`);
    const reportId = randomUUID();
    const stale = await post(s, { ...body(s, reportId), integrationId: unbound });
    expect(stale.status).toBe(409);
    expect((await stale.json()).error).toMatchObject({
      code: "stale_execution", message: "Google Drive scheduled report authority is stale",
    });
    expect(await reportRows(reportId)).toEqual([]);
    expect(await ledger(s)).toEqual([]);
  });

  it.each([
    ["a lock timeout", "55P03", "canceling statement due to lock timeout"],
    ["a deadlock", "40P01", "deadlock detected"],
    // Not the primary key: an arbitrary unique violation is NOT an absorbed replay.
    ["a unique violation", "23505", 'duplicate key value violates unique constraint "gdrive_run_requests_one_active_idx"'],
  ])("%s while recording is a fixed retryable 503 that leaks no database text", async (_name, code, text) => {
    const s = await scheduled();
    const reportId = randomUUID();
    const secret = `${text} DETAIL: Key (integration_id)=(${s.integrationId}) relation-internal-marker`;
    failing.next = {
      match: /insert into gdrive_run_requests/i,
      error: Object.assign(new Error(secret), { code }),
    };
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const response = await post(s, body(s, reportId));
    expect(failing.next, "the injected failure was never reached").toBeNull();
    expect(response.status).toBe(503);
    expect(response.headers.get("Retry-After")).toBe("30");
    const raw = await response.text();
    expect(JSON.parse(raw).error).toMatchObject({
      code: "report_unavailable", message: "Google Drive scheduled report could not be recorded; retry later",
    });
    // A non-hex marker: the body carries a random request_id, so a bare SQLSTATE could collide.
    expect(raw).not.toContain("relation-internal-marker");
    // Logged server-side for the operator…
    expect(error.mock.calls.flat().join(" ")).toContain("relation-internal-marker");
    // …and nothing recorded, so the connector's retry is the first delivery.
    expect(await reportRows(reportId)).toEqual([]);
    expect(await ledger(s)).toEqual([]);
    expect((await post(s, body(s, reportId))).status).toBe(200);
    expect(await ledger(s)).toEqual([true]);
  });

  it("accepts the sidecar's own start-time shape (Python isoformat, microseconds and +00:00)", async () => {
    const s = await scheduled();
    const reportId = randomUUID();
    const response = await post(s, body(s, reportId, { startedAt: "2026-10-23T10:00:00.123456+00:00" }));
    expect(response.status).toBe(200);
    const { rows } = await getPool().query<{ started_at: Date }>(
      `select started_at from gdrive_run_requests where id=$1`, [reportId]);
    expect(new Date(rows[0].started_at).toISOString()).toBe("2026-10-23T10:00:00.123Z");
  });
});
