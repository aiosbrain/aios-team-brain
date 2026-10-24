import { randomUUID } from "node:crypto";
import { NextRequest } from "next/server";
import { describe, expect, it } from "vitest";

import { POST as runsPOST } from "@/app/api/v1/integrations/gdrive/runs/route";
import { getPipelineHealth } from "@/lib/ingest/pipeline-health";
import { describeGdriveCoordinator } from "@/lib/integrations/gdrive-run-status";
import { listGdriveRunStatus } from "@/lib/integrations/gdrive-runs";
import { provisionGdriveConnectorPrincipal } from "@/lib/integrations/gdrive-authority";
import { setIntegrationStatus, upsertIntegration } from "@/lib/integrations/manage";
import { approvedAudienceProject, db, seedTeam, type Seed } from "./helpers";

/**
 * AIO-1167 r37 — what Admin says about a Drive connection (real Postgres).
 *
 * Spec.
 *   · PROVEN SUCCESS is read per connection, independently of how many newer attempts exist: one
 *     authoritative completion followed by more than a page of busy deferrals, or buried under another
 *     connection's chattier history, is still the connection's last proven success.
 *   · An ATTEMPT is not PROGRESS. The latest attempt (a busy deferral included) is shown as such;
 *     counts, backlog and cursor age come from the latest run that did work, and an unknown busy
 *     backlog never reads as zero.
 *   · PAUSED comes first. A paused connection says so ahead of its history, and once no enabled
 *     Drive connection remains, a failure recorded before the pause stops lighting the banner — while
 *     any Drive connection is still enabled, it stays loud.
 */

async function driveConnection(seed: Seed, name = `drive-${randomUUID().slice(0, 8)}`) {
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

/** One coordinator report row, written as the route writes a scheduled report. */
async function reportRow(
  seed: Seed, integrationId: string, at: Date,
  fields: { status: string; error?: string | null; summary?: Record<string, unknown> },
): Promise<string> {
  const id = randomUUID();
  const { error } = await db().from("gdrive_run_requests").insert({
    id, team_id: seed.teamId, integration_id: integrationId, trigger: "scheduler", status: fields.status,
    created_at: at.toISOString(), started_at: at.toISOString(), finished_at: at.toISOString(),
    summary: JSON.stringify({
      created: 0, updated: 0, unchanged: 0, removed: 0, failed: 0, skipped: 0,
      backlog: null, cursorAgeSeconds: null, authoritativeComplete: false, ...fields.summary,
    }),
    error: fields.error ?? null,
  });
  if (error) throw new Error(`report fixture failed: ${error.message}`);
  return id;
}

const BUSY = { status: "deferred", error: "execution_busy", summary: { skipped: 1 } };
const SUCCESS = { status: "complete", summary: { created: 4, backlog: 0, cursorAgeSeconds: 30, authoritativeComplete: true } };
const minutesAgo = (n: number) => new Date(Date.now() - n * 60_000);

describe("AIO-1167 r37 Admin Drive coordinator status (real Postgres)", () => {
  it("a success followed by more than 25 busy deferrals is still the last proven success", async () => {
    const seed = await seedTeam();
    const drive = await driveConnection(seed);
    const success = await reportRow(seed, drive, minutesAgo(120), SUCCESS);
    for (let n = 30; n > 0; n--) await reportRow(seed, drive, minutesAgo(n), BUSY);

    const status = (await listGdriveRunStatus(seed.teamId))[drive];
    expect(status.latestSuccess?.id).toBe(success);
    // The latest ATTEMPT is the busy deferral, presented as one…
    expect(status.latestAttempt).toMatchObject({ status: "deferred", error: "execution_busy" });
    // …but progress comes from the run that did work: its counts and its KNOWN backlog of 0.
    expect(status.latestReport?.id).toBe(success);

    const lines = describeGdriveCoordinator({ integrationStatus: "enabled", status });
    expect(lines[0]).toMatch(/^last attempt scheduler · deferred · .* · execution_busy$/);
    expect(lines[1]).toMatch(/^Last proven complete success /);
    expect(lines[2]).toMatch(/4 created.* · backlog 0 · cursor age 30s$/);
  });

  it("an authoritative completion with failed work is never the last proven success", async () => {
    const seed = await seedTeam();
    const drive = await driveConnection(seed);
    const clean = await reportRow(seed, drive, minutesAgo(60), SUCCESS);
    // Newer, authoritative and `complete` — but it failed work, which the ledger counts as a failure.
    const failedWork = await reportRow(seed, drive, minutesAgo(5), {
      status: "complete", error: "malformed_document",
      summary: { created: 1, failed: 2, backlog: 0, cursorAgeSeconds: 10, authoritativeComplete: true },
    });

    const status = (await listGdriveRunStatus(seed.teamId))[drive];
    expect(status.latestSuccess?.id).toBe(clean);
    // It is still shown — as the latest attempt and the latest progress — just never as a success.
    expect(status.latestAttempt?.id).toBe(failedWork);
    expect(status.latestReport?.id).toBe(failedWork);
  });

  it("a legacy or malformed failed count never proves success and never breaks the read", async () => {
    const seed = await seedTeam();
    const drive = await driveConnection(seed);
    const clean = await reportRow(seed, drive, minutesAgo(60), SUCCESS);
    // Newer authoritative completions whose failed count cannot be read as a number.
    await reportRow(seed, drive, minutesAgo(20), { ...SUCCESS, summary: { ...SUCCESS.summary, failed: "0" } });
    await reportRow(seed, drive, minutesAgo(10), { ...SUCCESS, summary: { ...SUCCESS.summary, failed: { n: 0 } } });
    await reportRow(seed, drive, minutesAgo(5), { ...SUCCESS, summary: { ...SUCCESS.summary, failed: null } });

    const status = (await listGdriveRunStatus(seed.teamId))[drive];
    expect(status.latestSuccess?.id).toBe(clean);
  });

  it("an unknown busy backlog is never presented as zero", async () => {
    const seed = await seedTeam();
    const drive = await driveConnection(seed);
    await reportRow(seed, drive, minutesAgo(5), BUSY);

    const status = (await listGdriveRunStatus(seed.teamId))[drive];
    expect(status.latestReport).toBeNull();
    const lines = describeGdriveCoordinator({ integrationStatus: "enabled", status });
    expect(lines).toContain("No proven complete success");
    expect(lines.join("\n")).toMatch(/backlog unknown/);
    expect(lines.join("\n")).not.toMatch(/backlog 0/);
  });

  it("connections sharing the team's history each keep their own proven success", async () => {
    const seed = await seedTeam();
    const quiet = await driveConnection(seed, "quiet-docs");
    const chatty = await driveConnection(seed, "chatty-docs");
    const quietSuccess = await reportRow(seed, quiet, minutesAgo(300), SUCCESS);
    for (let n = 40; n > 0; n--) {
      await reportRow(seed, chatty, minutesAgo(n), { status: "failed", error: "provider_unavailable", summary: { failed: 1 } });
    }

    const all = await listGdriveRunStatus(seed.teamId);
    expect(all[quiet].latestSuccess?.id).toBe(quietSuccess);
    expect(all[quiet].latestAttempt?.id).toBe(quietSuccess);
    expect(all[chatty].latestSuccess).toBeNull();
    expect(all[chatty].latestAttempt).toMatchObject({ status: "failed", error: "provider_unavailable" });
  });

  it("a paused connection says so ahead of its history, which is labelled as history", async () => {
    const seed = await seedTeam();
    const drive = await driveConnection(seed);
    await reportRow(seed, drive, minutesAgo(60), SUCCESS);
    await reportRow(seed, drive, minutesAgo(10), { status: "failed", error: "provider_unavailable", summary: { failed: 1 } });
    await setIntegrationStatus(db(), { teamId: seed.teamId, memberId: seed.memberId }, drive, "disabled");

    const { data: row } = await db().from("integrations").select("status").eq("id", drive).single();
    const lines = describeGdriveCoordinator({
      integrationStatus: (row as { status: string }).status,
      status: (await listGdriveRunStatus(seed.teamId))[drive],
    });
    expect(lines[0]).toBe("Paused or disconnected; no work will be claimed.");
    expect(lines[1]).toMatch(/^Before the pause: last attempt scheduler · failed · .* · provider_unavailable$/);
    expect(lines[2]).toMatch(/^Last proven complete success /);
  });
});

describe("AIO-1167 r37 a paused Drive connection's frozen failure (real Postgres)", () => {
  async function failingDrive(seed: Seed) {
    await db().from("members").update({ role: "admin" }).eq("id", seed.memberId).eq("team_id", seed.teamId);
    const drive = await driveConnection(seed);
    const issued = await provisionGdriveConnectorPrincipal({ teamId: seed.teamId, integrationId: drive, actorMemberId: seed.memberId });
    const report = (error: string) => runsPOST(new Request("http://test/api/v1/integrations/gdrive/runs", {
      method: "POST",
      headers: { Authorization: `Bearer ${issued.key}`, "X-AIOS-Team": seed.teamSlug, "Content-Type": "application/json" },
      body: JSON.stringify({
        reportId: randomUUID(), integrationId: drive, trigger: "scheduler", startedAt: new Date().toISOString(),
        status: "failed", failed: 1, error,
      }),
    }) as NextRequest);
    // Two consecutive failures: a confirmed, loud failure.
    expect((await report("provider_unavailable")).status).toBe(200);
    expect((await report("provider_unavailable")).status).toBe(200);
    const before = await getPipelineHealth(seed.teamId);
    expect(before.failing.map((leg) => leg.source)).toContain("gdrive");
    return drive;
  }

  it("is no longer loud once no Drive connection is enabled", async () => {
    const seed = await seedTeam();
    const drive = await failingDrive(seed);
    await setIntegrationStatus(db(), { teamId: seed.teamId, memberId: seed.memberId }, drive, "disabled");

    const after = await getPipelineHealth(seed.teamId);
    expect(after.failing.map((leg) => leg.source)).not.toContain("gdrive");
    // The record itself is kept: the leg is still there, still not ok — only not shouted.
    expect(after.legs.find((leg) => leg.source === "gdrive")).toMatchObject({ ok: false });
  });

  it("stays loud while any Drive connection is still enabled", async () => {
    const seed = await seedTeam();
    const drive = await failingDrive(seed);
    await driveConnection(seed, "still-enabled-docs");
    await setIntegrationStatus(db(), { teamId: seed.teamId, memberId: seed.memberId }, drive, "disabled");

    expect((await getPipelineHealth(seed.teamId)).failing.map((leg) => leg.source)).toContain("gdrive");
  });
});
