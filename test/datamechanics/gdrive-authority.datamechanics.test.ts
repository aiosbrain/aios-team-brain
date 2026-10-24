import { randomUUID } from "node:crypto";
import { NextRequest } from "next/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import { POST as executionPOST } from "@/app/api/v1/integrations/gdrive/execution/route";
import { POST as tokenPOST } from "@/app/api/v1/integrations/gdrive/token/route";
import { POST as itemsPOST } from "@/app/api/v1/items/route";
import { GET as runsGET, POST as runsPOST } from "@/app/api/v1/integrations/gdrive/runs/route";
import { GET as oauthCallbackGET } from "@/app/api/auth/gdrive/callback/route";
import { issueApiKey, revokeApiKey } from "@/lib/admin/keys";
import { createGoogleDriveOAuthState, GDRIVE_OAUTH_BINDING_COOKIE } from "@/lib/auth/gdrive-oauth-state";
import { getIntegrationWithSecret, upsertIntegration, setIntegrationSecret, setIntegrationStatus } from "@/lib/integrations/manage";
import {
  acquireGdriveAdminTestAuthority,
  authorizeGdriveAdminTestCall,
  provisionGdriveConnectorPrincipal,
} from "@/lib/integrations/gdrive-authority";
import { getPipelineHealth } from "@/lib/ingest/pipeline-health";
import { approvedAudienceProject, db, placeMemberByTier, seedTeam, sha, type Seed } from "./helpers";

const GOOGLE_SECRET = JSON.stringify({
  client_id: "oauth-client", client_secret: "never-return-this",
  refresh_token: "never-return-refresh", token_uri: "https://oauth2.googleapis.com/token",
  scopes: ["https://www.googleapis.com/auth/drive.file"], account_subject: "subject:acct-1",
});

// The OAuth callback is redeemed only by the browser and Admin session that started the grant. The
// session resolver is the one seam faked here; the binding cookie is a real request header.
const adminSession = vi.hoisted(() => ({ teamId: "", memberId: "" }));
vi.mock("@/lib/auth/guard", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth/guard")>()),
  requireTeamAdmin: async () => adminSession.teamId
    ? { teamId: adminSession.teamId, memberId: adminSession.memberId }
    : null,
}));

const BROWSER = "aio-1167-initiating-browser-binding";
const INITIATING_BROWSER = { headers: { cookie: `${GDRIVE_OAUTH_BINDING_COOKIE}=${BROWSER}` } };

/** Start a grant as `seed`'s Admin: signs that Admin in and returns the browser's binding. */
function startedBy(seed: Seed): string {
  adminSession.teamId = seed.teamId;
  adminSession.memberId = seed.memberId;
  return BROWSER;
}

afterEach(() => {
  vi.restoreAllMocks();
  adminSession.teamId = "";
  adminSession.memberId = "";
});

async function connector(seed: Seed, posture: "team" | "external" = "team") {
  const { data, error } = await db().from("members").insert({
    team_id: seed.teamId, email: `${randomUUID()}@connector.local`, display_name: "Drive Sync",
    actor_handle: "gdrive-sync", role: "member", tier: posture, status: "active", is_connector: true,
  }).select("id").single();
  if (error || !data) throw new Error(error?.message);
  const memberId = (data as { id: string }).id;
  await placeMemberByTier(seed.teamId, memberId, posture);
  const issued = await issueApiKey(db(), seed.teamId, memberId, "gdrive connector");
  const { data: keyRow } = await db().from("api_keys").select("id").eq("key_id", issued.keyId).single();
  return { key: issued.key, apiKeyId: (keyRow as { id: string }).id, memberId };
}

async function integration(seed: Seed, name = "company-docs", fileIds = ["DocA"]) {
  const audienceProjectId = await approvedAudienceProject(seed);
  const row = await upsertIntegration(db(), { teamId: seed.teamId, memberId: seed.memberId }, {
    type: "gdrive", name, status: "enabled",
    config: {
      fileIds, folderIds: [], sharedDriveIds: [], recursive: false,
      selectionState: "selected", projectSlug: "docs", access: "team", authMode: "oauth",
      authenticatedAccount: "docs@example.com", authenticatedAccountId: "subject:acct-1",
      scopeSet: ["https://www.googleapis.com/auth/drive.file"],
      audienceProjectIds: [audienceProjectId],
    },
  });
  await setIntegrationSecret(db(), { teamId: seed.teamId, memberId: seed.memberId }, row.id, GOOGLE_SECRET);
  return row.id;
}

async function provision(seed: Seed, integrationId: string) {
  await db().from("members").update({ role: "admin" }).eq("id", seed.memberId).eq("team_id", seed.teamId);
  const issued = await provisionGdriveConnectorPrincipal({
    teamId: seed.teamId, integrationId, actorMemberId: seed.memberId,
  });
  const { data: keyRow } = await db().from("api_keys").select("id").eq("key_id", issued.keyId).single();
  return { key: issued.key, apiKeyId: (keyRow as { id: string }).id, memberId: issued.memberId };
}

function request(url: string, key: string, team: string, body: unknown, extra: Record<string, string> = {}) {
  return new Request(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "X-AIOS-Team": team, "Content-Type": "application/json", ...extra },
    body: JSON.stringify(body),
  }) as NextRequest;
}

function getRequest(url: string, key: string, team: string) {
  return new Request(url, {
    headers: { Authorization: `Bearer ${key}`, "X-AIOS-Team": team },
  }) as NextRequest;
}

async function acquire(key: string, seed: Seed, integrationId: string, owner = randomUUID()) {
  const response = await executionPOST(request("http://test/api/v1/integrations/gdrive/execution", key, seed.teamSlug, {
    action: "acquire", integration_id: integrationId, owner,
  }));
  return { response, body: await response.json(), owner };
}

describe("AIO-1167 F1: a busy scheduled/notification deferral is neutral in the Admin run ledger (real Postgres)", () => {
  type Report = Record<string, unknown>;
  const BUSY: Report = {
    status: "deferred", error: "execution_busy", created: 0, updated: 0, unchanged: 0, removed: 0,
    failed: 0, skipped: 1, backlog: null, authoritativeComplete: false,
  };

  async function scheduled() {
    const seed = await seedTeam();
    const integrationId = await integration(seed, `scheduled-${randomUUID().slice(0, 8)}`);
    const trusted = await provision(seed, integrationId);
    const report = async (fields: Report, reportId = randomUUID()) => {
      const response = await runsPOST(request("http://test/api/v1/integrations/gdrive/runs", trusted.key, seed.teamSlug, {
        reportId, integrationId, trigger: "scheduler", startedAt: new Date().toISOString(), ...fields,
      }));
      return { status: response.status, reportId };
    };
    const ledger = async () => ((await db().from("ingest_runs").select("id,ok,errors,meta")
      .eq("team_id", seed.teamId).eq("source", "gdrive").order("id", { ascending: true })).data ?? []) as
      { ok: boolean; errors: string[]; meta: Record<string, unknown> }[];
    const reports = async () => ((await db().from("gdrive_run_requests").select("id,status,error")
      .eq("team_id", seed.teamId).eq("integration_id", integrationId).eq("trigger", "scheduler")).data ?? []) as
      { id: string; status: string; error: string | null }[];
    return { seed, report, ledger, reports };
  }

  it("two distinct busy notifications persist deferred reports and append no failure", async () => {
    const s = await scheduled();
    const first = await s.report(BUSY);
    const second = await s.report(BUSY);
    expect([first.status, second.status]).toEqual([200, 200]);
    // Both durable deferred reports are kept…
    expect((await s.reports()).map((r) => [r.id, r.status, r.error]).sort())
      .toEqual([[first.reportId, "deferred", "execution_busy"], [second.reportId, "deferred", "execution_busy"]].sort());
    // …and the ledger neither confirms a failure nor records a success.
    expect(await s.ledger()).toEqual([]);
  });

  it("a replayed busy report is idempotent and still appends nothing", async () => {
    const s = await scheduled();
    const first = await s.report(BUSY);
    expect((await s.report(BUSY, first.reportId)).status).toBe(200);
    expect(await s.reports()).toHaveLength(1);
    expect(await s.ledger()).toEqual([]);
  });

  it("genuine failures separated by busy deferrals stay consecutive failures; a busy wake never clears them", async () => {
    const s = await scheduled();
    const failed = { ...BUSY, status: "failed", error: "provider_unavailable", skipped: 0, failed: 1 };
    await s.report(failed);
    await s.report(BUSY);
    await s.report(BUSY);
    await s.report(failed);
    const rows = await s.ledger();
    expect(rows.map((row) => row.ok)).toEqual([false, false]);
    expect(rows.every((row) => row.errors.includes("provider_unavailable"))).toBe(true);
    // No complete report exists: a busy wake did not advance the last complete success.
    expect((await s.reports()).some((r) => r.status === "complete")).toBe(false);
  });

  it("an actual completion after busy wakes records a success normally", async () => {
    const s = await scheduled();
    await s.report({ ...BUSY, status: "failed", error: "provider_unavailable", skipped: 0, failed: 1 });
    await s.report(BUSY);
    await s.report({ ...BUSY, status: "complete", error: undefined, skipped: 0, created: 1, backlog: 0, authoritativeComplete: true });
    expect((await s.ledger()).map((row) => row.ok)).toEqual([false, true]);
  });

  it.each([
    ["a deferral that also reports failed work", { ...BUSY, failed: 2 }],
    ["a deferral that also wrote items", { ...BUSY, created: 1 }],
    ["a deferral with another cause", { ...BUSY, error: "rate_limited" }],
    ["a deferral with mixed causes", { ...BUSY, error: "execution_busy, rate_limited" }],
    ["a deferral with no cause", { ...BUSY, error: undefined }],
  ])("%s is not exempt: it is appended as not-ok", async (_name, fields) => {
    const s = await scheduled();
    expect((await s.report(fields)).status).toBe(200);
    expect((await s.ledger()).map((row) => row.ok)).toEqual([false]);
  });

  // r37 (Fable finding 2): healthy partial progress is neutral too — it neither extends a failure
  // streak nor counts as a success. Superseded the r36 assertion that it appended `ok:false`.
  const HEALTHY_PARTIAL: Report = { ...BUSY, status: "partial", error: undefined, skipped: 0, created: 3, backlog: 2 };
  const FAILED_PARTIAL: Report = { ...HEALTHY_PARTIAL, failed: 1, error: "malformed_document" };
  const FAILURE: Report = { ...BUSY, status: "failed", error: "provider_unavailable", skipped: 0, failed: 1 };
  const COMPLETE: Report = { ...BUSY, status: "complete", error: undefined, skipped: 0, created: 1, backlog: 0, authoritativeComplete: true };

  it("repeated healthy partial runs keep their durable reports and append nothing to the ledger", async () => {
    const s = await scheduled();
    for (let n = 0; n < 3; n++) expect((await s.report(HEALTHY_PARTIAL)).status).toBe(200);
    // A rate-limit or deadline deferral inside an otherwise healthy partial run is still healthy.
    await s.report({ ...HEALTHY_PARTIAL, error: "rate_limited" });
    expect((await s.reports()).map((r) => r.status)).toEqual(["partial", "partial", "partial", "partial"]);
    expect(await s.ledger()).toEqual([]);
  });

  it("a partial run that failed work is a failure", async () => {
    const s = await scheduled();
    await s.report(FAILED_PARTIAL);
    expect((await s.ledger()).map((row) => row.ok)).toEqual([false]);
  });

  it("genuine failures separated by healthy partial and busy wakes stay one unbroken failure streak", async () => {
    const s = await scheduled();
    await s.report(FAILURE);
    await s.report(HEALTHY_PARTIAL);
    await s.report(BUSY);
    await s.report(HEALTHY_PARTIAL);
    await s.report(FAILURE);
    expect((await s.ledger()).map((row) => row.ok)).toEqual([false, false]);
    // …which the pipeline banner reads as a CONFIRMED failure, not two lone ones.
    const health = await getPipelineHealth(s.seed.teamId);
    expect(health.legs.find((leg) => leg.source === "gdrive")).toMatchObject({ ok: false, failureClass: "confirmed" });
    // No complete report: neither partial progress nor a busy wake advanced complete-success time.
    expect((await s.reports()).some((r) => r.status === "complete")).toBe(false);
  });

  it("only an authoritative completion ends the streak", async () => {
    const s = await scheduled();
    await s.report(FAILURE);
    await s.report(HEALTHY_PARTIAL);
    await s.report(FAILURE);
    await s.report(HEALTHY_PARTIAL);
    await s.report(COMPLETE);
    expect((await s.ledger()).map((row) => row.ok)).toEqual([false, false, true]);
    expect((await getPipelineHealth(s.seed.teamId)).legs.find((leg) => leg.source === "gdrive"))
      .toMatchObject({ ok: true, failureClass: "ok" });
  });
});

describe("AIO-1167 r37: manual Drive runs follow the same ledger rule (real Postgres)", () => {
  async function manualRun(seed: Seed, integrationId: string, trusted: { key: string }) {
    const { data: queued } = await db().from("gdrive_run_requests").insert({
      team_id: seed.teamId, integration_id: integrationId, requested_by: seed.memberId,
      trigger: "manual", status: "pending",
    }).select("id").single();
    const claimed = await (await runsGET(getRequest("http://test/api/v1/integrations/gdrive/runs", trusted.key, seed.teamSlug))).json();
    return { requestId: (queued as { id: string }).id, attemptToken: claimed.request.attempt_token as string };
  }
  const ledger = async (seed: Seed) => ((await db().from("ingest_runs").select("id,ok")
    .eq("team_id", seed.teamId).eq("source", "gdrive").order("id", { ascending: true })).data ?? []) as { ok: boolean }[];

  it("a healthy partial manual run is neutral; a failed partial manual run is a failure", async () => {
    const seed = await seedTeam();
    const integrationId = await integration(seed, `manual-${randomUUID().slice(0, 8)}`);
    const trusted = await provision(seed, integrationId);
    const post = (claim: { requestId: string; attemptToken: string }, fields: Record<string, unknown>) =>
      runsPOST(request("http://test/api/v1/integrations/gdrive/runs", trusted.key, seed.teamSlug, { ...claim, ...fields }));

    const healthy = await manualRun(seed, integrationId, trusted);
    expect((await post(healthy, { status: "partial", created: 2, failed: 0, backlog: 4 })).status).toBe(200);
    const { data: kept } = await db().from("gdrive_run_requests").select("status").eq("id", healthy.requestId).single();
    expect(kept).toMatchObject({ status: "partial" });
    expect(await ledger(seed)).toEqual([]);

    const failing = await manualRun(seed, integrationId, trusted);
    expect((await post(failing, { status: "partial", created: 2, failed: 1, backlog: 4, error: "malformed_document" })).status).toBe(200);
    expect((await ledger(seed)).map((row) => row.ok)).toEqual([false]);
  });
});

describe("AIO-1167 Drive principal, broker, generation, and fence (real Postgres)", () => {
  it("publishes service-account verification only through its current fenced principal", async () => {
    const seed = await seedTeam();
    const audienceProjectId = await approvedAudienceProject(seed);
    const row = await upsertIntegration(db(), { teamId: seed.teamId, memberId: seed.memberId }, {
      type: "gdrive", name: "service-proof", status: "enabled",
      config: {
        fileIds: ["DocA"], folderIds: [], sharedDriveIds: [], recursive: false,
        selectionState: "selected", access: "team", authMode: "service_account",
        serviceAccountStatus: "pending", audienceProjectIds: [audienceProjectId],
      },
    });
    const trusted = await provision(seed, row.id);
    const current = await acquire(trusted.key, seed, row.id);
    expect(current.response.status).toBe(200);
    const verified = await executionPOST(request(
      "http://test/api/v1/integrations/gdrive/execution", trusted.key, seed.teamSlug,
      { action: "verify_service_account", integration_id: row.id,
        generation: current.body.generation, fence: current.body.fence,
        owner: current.owner, identity: "svc@example.com" },
    ));
    expect(verified.status).toBe(200);
    const { data: stored } = await db().from("integrations").select("config").eq("id", row.id).single();
    expect((stored as { config: Record<string, unknown> }).config).toMatchObject({
      authMode: "service_account", serviceAccountStatus: "verified",
      serviceAccountIdentity: "svc@example.com",
    });
  });

  it("claims one durable manual run only for the bound principal and records its summary", async () => {
    const seed = await seedTeam();
    const integrationId = await integration(seed, "manual-queue");
    const trusted = await provision(seed, integrationId);
    const ordinary = await issueApiKey(db(), seed.teamId, seed.memberId, "ordinary");
    const { data: queued } = await db().from("gdrive_run_requests").insert({
      team_id: seed.teamId, integration_id: integrationId, requested_by: seed.memberId,
      trigger: "manual", status: "pending",
    }).select("id").single();

    expect((await runsGET(getRequest("http://test/api/v1/integrations/gdrive/runs", ordinary.key, seed.teamSlug))).status).toBe(401);
    const claimed = await runsGET(getRequest("http://test/api/v1/integrations/gdrive/runs", trusted.key, seed.teamSlug));
    expect(claimed.status).toBe(200);
    const claimedBody = await claimed.json();
    expect(claimedBody).toMatchObject({ request: { id: (queued as { id: string }).id, integration_id: integrationId } });
    const attemptToken = claimedBody.request.attempt_token as string;
    expect(attemptToken).toMatch(/^[0-9a-f-]{36}$/);
    expect(await (await runsGET(getRequest("http://test/api/v1/integrations/gdrive/runs", trusted.key, seed.teamSlug))).json())
      .toEqual({ request: null });

    const completed = await runsPOST(request(
      "http://test/api/v1/integrations/gdrive/runs", trusted.key, seed.teamSlug,
      { requestId: (queued as { id: string }).id, attemptToken, status: "complete", created: 2, updated: 1, unchanged: 3, removed: 1, failed: 0, backlog: 0, authoritativeComplete: true },
    ));
    expect(completed.status).toBe(200);
    const replay = await runsPOST(request(
      "http://test/api/v1/integrations/gdrive/runs", trusted.key, seed.teamSlug,
      { requestId: (queued as { id: string }).id, attemptToken, status: "complete", created: 2, updated: 1,
        unchanged: 3, removed: 1, failed: 0, backlog: 0, authoritativeComplete: true },
    ));
    expect(replay.status).toBe(200);
    const { data: row } = await db().from("gdrive_run_requests").select("status,summary")
      .eq("id", (queued as { id: string }).id).single();
    expect(row).toMatchObject({ status: "complete", summary: expect.objectContaining({ created: 2, removed: 1, backlog: 0 }) });
    const { data: runs } = await db().from("ingest_runs").select("source,trigger,ok,created,updated,unchanged,meta")
      .eq("team_id", seed.teamId).eq("source", "gdrive");
    expect(runs).toHaveLength(1);
    const run = runs?.[0];
    expect(run).toMatchObject({ source: "gdrive", trigger: "manual", ok: true, created: 2, updated: 1, unchanged: 3 });
  });

  // ── Attempt ownership: only the attempt holding a request's current token speaks for it ──────────
  const RUNS = "http://test/api/v1/integrations/gdrive/runs";
  type Claim = { id: string; attempt_token: string };
  async function claimRun(seed: Seed, key: string): Promise<Claim | null> {
    const response = await runsGET(getRequest(RUNS, key, seed.teamSlug));
    expect(response.status).toBe(200);
    return (await response.json()).request as Claim | null;
  }
  async function report(seed: Seed, key: string, body: Record<string, unknown>) {
    const response = await runsPOST(request(RUNS, key, seed.teamSlug, body));
    return { status: response.status, body: await response.json() };
  }
  async function queueRun(seed: Seed, integrationId: string): Promise<string> {
    const { data, error } = await db().from("gdrive_run_requests").insert({
      team_id: seed.teamId, integration_id: integrationId, requested_by: seed.memberId,
      trigger: "manual", status: "pending",
    }).select("id").single();
    if (error || !data) throw new Error(error?.message);
    return (data as { id: string }).id;
  }
  async function runRow(id: string) {
    const { data } = await db().from("gdrive_run_requests")
      .select("status,attempt_token,started_at,finished_at,summary,error").eq("id", id).single();
    return data as {
      status: string; attempt_token: string | null; started_at: string | null; finished_at: string | null;
      summary: Record<string, unknown>; error: string | null;
    };
  }
  async function manualLedger(seed: Seed) {
    const { data } = await db().from("ingest_runs").select("trigger,created,meta")
      .eq("team_id", seed.teamId).eq("source", "gdrive");
    return (data ?? []) as Array<{ trigger: string; created: number; meta: Record<string, unknown> }>;
  }
  /** Deterministically past the interruption threshold — no sleeping. */
  async function ageRun(id: string) {
    const { error } = await db().from("gdrive_run_requests")
      .update({ started_at: new Date(Date.now() - 20 * 60_000).toISOString() }).eq("id", id);
    if (error) throw new Error(error.message);
  }
  async function endLease(
    mode: "released" | "expired", key: string, seed: Seed, integrationId: string,
    active: Awaited<ReturnType<typeof acquire>>,
  ) {
    if (mode === "released") {
      const released = await executionPOST(request("http://test/api/v1/integrations/gdrive/execution", key, seed.teamSlug, {
        action: "release", integration_id: integrationId, owner: active.owner,
        generation: active.body.generation, fence: active.body.fence,
      }));
      expect(released.status).toBe(200);
      return;
    }
    const { error } = await db().from("gdrive_connection_authority")
      .update({ lease_until: new Date(Date.now() - 1_000).toISOString() }).eq("integration_id", integrationId);
    if (error) throw new Error(error.message);
  }
  const outcome = (requestId: string, attemptToken: string, over: Record<string, unknown> = {}) => ({
    requestId, attemptToken, status: "complete", created: 1, unchanged: 2, backlog: 0,
    authoritativeComplete: true, ...over,
  });

  it.each(["released", "expired"] as const)(
    "a live Drive lease keeps an aged attempt; once %s, a successor's token alone completes the request",
    async (mode) => {
      const seed = await seedTeam();
      const integrationId = await integration(seed, `attempts-${mode}`);
      const trusted = await provision(seed, integrationId);
      const requestId = await queueRun(seed, integrationId);

      // Attempt A claims the request and holds the connection's execution lease.
      const a = await claimRun(seed, trusted.key);
      expect(a?.id).toBe(requestId);
      const active = await acquire(trusted.key, seed, integrationId);
      expect(active.response.status).toBe(200);

      // Aged past the threshold, but its execution is demonstrably live: not reclaimed.
      await ageRun(requestId);
      expect(await claimRun(seed, trusted.key)).toBeNull();
      expect(await runRow(requestId)).toMatchObject({ status: "running", attempt_token: a!.attempt_token });

      // The lease ends: the interrupted attempt is recovered, and B claims it under a new token.
      await endLease(mode, trusted.key, seed, integrationId, active);
      const b = await claimRun(seed, trusted.key);
      expect(b?.id).toBe(requestId);
      expect(b!.attempt_token).not.toBe(a!.attempt_token);
      const running = await runRow(requestId);
      expect(running).toMatchObject({ status: "running", attempt_token: b!.attempt_token, finished_at: null });

      // A's delayed completion and deferral both fail, and change nothing of B's attempt.
      const staleComplete = await report(seed, trusted.key, outcome(requestId, a!.attempt_token, { created: 9 }));
      expect(staleComplete.status).toBe(409);
      expect(staleComplete.body.error.code).toBe("stale_execution");
      const staleDefer = await report(seed, trusted.key, outcome(requestId, a!.attempt_token, {
        status: "deferred", skipped: 1, error: "coordinator busy", authoritativeComplete: false, backlog: null,
      }));
      expect(staleDefer.status).toBe(409);
      expect(await runRow(requestId)).toEqual(running);
      expect(await manualLedger(seed)).toEqual([]);

      // B completes; its exact replay is idempotent, a conflicting one is refused.
      expect((await report(seed, trusted.key, outcome(requestId, b!.attempt_token))).status).toBe(200);
      const finished = await runRow(requestId);
      expect(finished).toMatchObject({
        status: "complete", attempt_token: b!.attempt_token, started_at: running.started_at,
        error: null, summary: expect.objectContaining({ created: 1, unchanged: 2 }),
      });
      expect(finished.finished_at).not.toBeNull();
      expect((await report(seed, trusted.key, outcome(requestId, b!.attempt_token))).status).toBe(200);
      expect((await report(seed, trusted.key, outcome(requestId, b!.attempt_token, { created: 5 }))).status).toBe(409);
      // A stays stale after B finished, too.
      expect((await report(seed, trusted.key, outcome(requestId, a!.attempt_token))).status).toBe(409);
      expect(await runRow(requestId)).toEqual(finished);
      const ledger = await manualLedger(seed);
      expect(ledger).toHaveLength(1);
      expect(ledger[0]).toMatchObject({ trigger: "manual", created: 1, meta: expect.objectContaining({ requestId }) });
    },
  );

  it("an aged attempt with no execution lease at all is recovered under a new token", async () => {
    const seed = await seedTeam();
    const integrationId = await integration(seed, "attempts-interrupted");
    const trusted = await provision(seed, integrationId);
    const requestId = await queueRun(seed, integrationId);
    const a = await claimRun(seed, trusted.key);

    // Not yet aged: a running attempt is never taken from, whatever its lease.
    expect(await claimRun(seed, trusted.key)).toBeNull();
    await ageRun(requestId);
    const b = await claimRun(seed, trusted.key);
    expect(b?.id).toBe(requestId);
    expect(b!.attempt_token).not.toBe(a!.attempt_token);
    expect((await report(seed, trusted.key, outcome(requestId, a!.attempt_token))).status).toBe(409);
    expect(await runRow(requestId)).toMatchObject({ status: "running", attempt_token: b!.attempt_token });
  });

  it("a current deferral returns the request to pending idempotently, and the next claim gets a new token", async () => {
    const seed = await seedTeam();
    const integrationId = await integration(seed, "attempts-deferred");
    const trusted = await provision(seed, integrationId);
    const requestId = await queueRun(seed, integrationId);
    const a = await claimRun(seed, trusted.key);
    const deferral = outcome(requestId, a!.attempt_token, {
      status: "deferred", created: 0, unchanged: 0, skipped: 1, error: "coordinator busy",
      authoritativeComplete: false, backlog: null,
    });

    expect((await report(seed, trusted.key, deferral)).status).toBe(200);
    const pending = await runRow(requestId);
    expect(pending).toMatchObject({
      status: "pending", started_at: null, finished_at: null, error: "coordinator busy",
      summary: expect.objectContaining({ skipped: 1 }),
    });
    // Exact replay is accepted; a conflicting one, or a terminal report from the deferred attempt, is not.
    expect((await report(seed, trusted.key, deferral)).status).toBe(200);
    expect((await report(seed, trusted.key, { ...deferral, error: "something else" })).status).toBe(409);
    expect((await report(seed, trusted.key, outcome(requestId, a!.attempt_token))).status).toBe(409);
    expect(await runRow(requestId)).toEqual(pending);

    const b = await claimRun(seed, trusted.key);
    expect(b?.id).toBe(requestId);
    expect(b!.attempt_token).not.toBe(a!.attempt_token);
    // Once re-claimed, even A's exact deferral replay is stale.
    expect((await report(seed, trusted.key, deferral)).status).toBe(409);
    expect(await runRow(requestId)).toMatchObject({ status: "running", attempt_token: b!.attempt_token, error: null });
    expect(await manualLedger(seed)).toEqual([]);
  });

  it("requires a well-formed attempt token on request outcomes and none on scheduled reports", async () => {
    const seed = await seedTeam();
    const integrationId = await integration(seed, "attempts-contract");
    const trusted = await provision(seed, integrationId);
    const requestId = await queueRun(seed, integrationId);
    const a = await claimRun(seed, trusted.key);
    const before = await runRow(requestId);

    const tokenless: Record<string, unknown> = outcome(requestId, a!.attempt_token);
    delete tokenless.attemptToken;
    expect((await report(seed, trusted.key, tokenless)).status).toBe(422);
    expect((await report(seed, trusted.key, outcome(requestId, "not-a-token"))).status).toBe(422);
    // Well-formed but never issued for this request.
    expect((await report(seed, trusted.key, outcome(requestId, randomUUID()))).status).toBe(409);
    expect((await report(seed, trusted.key, {
      reportId: randomUUID(), integrationId, trigger: "scheduler", startedAt: new Date().toISOString(),
      attemptToken: a!.attempt_token, status: "complete", authoritativeComplete: true,
    })).status).toBe(422);
    expect(await runRow(requestId)).toEqual(before);
    expect(await manualLedger(seed)).toEqual([]);
  });

  it("records scheduled coordinator outcomes idempotently in the same run ledger", async () => {
    const seed = await seedTeam();
    const integrationId = await integration(seed, "scheduled-report");
    const trusted = await provision(seed, integrationId);
    const reportId = randomUUID();
    const body = {
      reportId, integrationId, trigger: "scheduler", startedAt: new Date().toISOString(),
      status: "complete", unchanged: 4, skipped: 2, backlog: 0,
      cursorAgeSeconds: 3, authoritativeComplete: true,
    };
    expect((await runsPOST(request(
      "http://test/api/v1/integrations/gdrive/runs", trusted.key, seed.teamSlug, body,
    ))).status).toBe(200);
    expect((await runsPOST(request(
      "http://test/api/v1/integrations/gdrive/runs", trusted.key, seed.teamSlug, body,
    ))).status).toBe(200);
    const { data: reports } = await db().from("gdrive_run_requests")
      .select("trigger,status,summary").eq("id", reportId);
    expect(reports).toEqual([expect.objectContaining({
      trigger: "scheduler", status: "complete",
      summary: expect.objectContaining({ skipped: 2, backlog: 0, authoritativeComplete: true }),
    })]);
    const { data: ledger } = await db().from("ingest_runs").select("meta")
      .eq("team_id", seed.teamId).eq("source", "gdrive");
    expect(ledger).toHaveLength(1);
  });

  it.each(["pause", "credential", "demotion", "deactivation"] as const)(
    "invalidates an Admin test authority snapshot after %s",
    async (change) => {
      const seed = await seedTeam();
      await db().from("members").update({ role: "admin" }).eq("id", seed.memberId).eq("team_id", seed.teamId);
      await integration(seed, `admin-test-${change}`);
      const authority = await acquireGdriveAdminTestAuthority({
        teamId: seed.teamId, memberId: seed.memberId, integrationName: `admin-test-${change}`,
      });
      await expect(authorizeGdriveAdminTestCall(authority)).resolves.toBeUndefined();

      if (change === "pause") {
        await setIntegrationStatus(db(), { teamId: seed.teamId, memberId: seed.memberId }, authority.integrationId, "disabled");
      } else if (change === "credential") {
        await setIntegrationSecret(
          db(), { teamId: seed.teamId, memberId: seed.memberId }, authority.integrationId,
          JSON.stringify({ ...JSON.parse(GOOGLE_SECRET), refresh_token: "rotated-refresh" }),
        );
      } else if (change === "demotion") {
        await db().from("members").update({ role: "member" }).eq("id", seed.memberId).eq("team_id", seed.teamId);
      } else {
        await db().from("members").update({ status: "disabled" }).eq("id", seed.memberId).eq("team_id", seed.teamId);
      }

      await expect(authorizeGdriveAdminTestCall(authority)).rejects.toMatchObject({
        code: "admin_authority_changed",
      });
    },
  );

  it("rejects ordinary and external member keys; binds only the dedicated connector key", async () => {
    const seed = await seedTeam();
    const integrationId = await integration(seed);
    const ordinary = await issueApiKey(db(), seed.teamId, seed.memberId, "ordinary member");
    const denied = await acquire(ordinary.key, seed, integrationId);
    expect(denied.response.status).toBe(403);
    expect(denied.body.error.code).toBe("connector_principal_required");

    // A distinct team avoids the one-gdrive-sync-handle-per-team invariant.
    const externalSeed = await seedTeam();
    const externalIntegration = await integration(externalSeed);
    const external = await connector(externalSeed, "external");
    const externalDenied = await acquire(external.key, externalSeed, externalIntegration);
    expect(externalDenied.response.status).toBe(403);

    const unbound = await connector(seed);
    const concurrentClaims = await Promise.all([
      acquire(unbound.key, seed, integrationId),
      acquire(unbound.key, seed, integrationId),
    ]);
    expect(concurrentClaims.map((claim) => claim.response.status)).toEqual([403, 403]);
    expect(concurrentClaims.map((claim) => claim.body.error.code)).toEqual(["wrong_connection", "wrong_connection"]);

    const trusted = await provision(seed, integrationId);
    const accepted = await acquire(trusted.key, seed, integrationId);
    expect(accepted.response.status).toBe(200);
    expect(accepted.body).toMatchObject({ integration_id: integrationId, generation: 3 });

    const otherTeam = await seedTeam();
    await expect(provisionGdriveConnectorPrincipal({
      teamId: seed.teamId, integrationId, actorMemberId: otherTeam.memberId,
    })).rejects.toMatchObject({ code: "connector_principal_required" });

    await db().from("gdrive_connection_authority").update({ progress: { page_token: "opaque" } }).eq("integration_id", integrationId);
    const rotated = await provision(seed, integrationId);
    expect(rotated.key).not.toBe(trusted.key);
    const staleAfterRotation = await executionPOST(request("http://test/api/v1/integrations/gdrive/execution", trusted.key, seed.teamSlug, {
      action: "checkpoint", integration_id: integrationId, generation: accepted.body.generation,
      fence: accepted.body.fence, owner: accepted.owner,
      progress_revision: accepted.body.progress_revision,
      progress: { phase: "current" },
    }));
    expect(staleAfterRotation.status).toBe(401);
    const authority = (await db().from("gdrive_connection_authority").select("progress").eq("integration_id", integrationId).single()).data as { progress: Record<string, unknown> };
    expect(authority.progress).toMatchObject({ page_token: "opaque" });
  });

  it("rechecks bound key revocation after provider refresh before issuing a token", async () => {
    const seed = await seedTeam();
    const integrationId = await integration(seed, "mid-refresh-revoke");
    const trusted = await provision(seed, integrationId);
    const active = await acquire(trusted.key, seed, integrationId);
    vi.spyOn(globalThis, "fetch").mockImplementationOnce(async () => {
      await db().from("api_keys").update({ revoked_at: new Date().toISOString() }).eq("id", trusted.apiKeyId);
      return new Response(JSON.stringify({ access_token: "must-not-escape", expires_in: 600 }), {
        status: 200, headers: { "content-type": "application/json" },
      });
    });
    const response = await tokenPOST(request("http://test/api/v1/integrations/gdrive/token", trusted.key, seed.teamSlug, {
      integration_id: integrationId, generation: active.body.generation,
      fence: active.body.fence, owner: active.owner,
    }));
    expect(response.status).toBe(403);
    expect(JSON.stringify(await response.json())).not.toContain("must-not-escape");
  });

  it("brokers only a short-lived grant and stops on pause, key revocation, or wrong integration", async () => {
    const seed = await seedTeam();
    const integrationId = await integration(seed);
    const otherIntegrationId = await integration(seed, "other-docs", ["Other"]);
    const trusted = await provision(seed, integrationId);
    const active = await acquire(trusted.key, seed, integrationId);
    expect(active.response.status).toBe(200);
    const tokenFetch = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(JSON.stringify({
        access_token: "short-lived", expires_in: 900,
        scope: "https://www.googleapis.com/auth/drive.file",
      }), { status: 200, headers: { "content-type": "application/json" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        error: "invalid_grant", error_description: "never-return-refresh was revoked",
      }), { status: 400, headers: { "content-type": "application/json" } }));
    const tokenBody = {
      integration_id: integrationId, generation: active.body.generation,
      fence: active.body.fence, owner: active.owner,
    };
    const token = await tokenPOST(request("http://test/api/v1/integrations/gdrive/token", trusted.key, seed.teamSlug, tokenBody));
    expect(token.status).toBe(200);
    expect(token.headers.get("cache-control")).toContain("no-store");
    const grant = await token.json();
    expect(grant).toMatchObject({ access_token: "short-lived", scopes: ["https://www.googleapis.com/auth/drive.file"] });
    expect(JSON.stringify(grant)).not.toMatch(/refresh|client_secret|never-return/);

    const wrong = await tokenPOST(request("http://test/api/v1/integrations/gdrive/token", trusted.key, seed.teamSlug, {
      ...tokenBody, integration_id: otherIntegrationId,
    }));
    expect(wrong.status).toBe(403);

    await setIntegrationStatus(db(), { teamId: seed.teamId, memberId: seed.memberId }, integrationId, "disabled");
    const paused = await tokenPOST(request("http://test/api/v1/integrations/gdrive/token", trusted.key, seed.teamSlug, tokenBody));
    expect(paused.status).toBe(409);
    expect(tokenFetch).toHaveBeenCalledTimes(1);

    await setIntegrationStatus(db(), { teamId: seed.teamId, memberId: seed.memberId }, integrationId, "enabled");
    const resumed = await acquire(trusted.key, seed, integrationId, randomUUID());
    expect(resumed.response.status).toBe(200);
    const providerRevoked = await tokenPOST(request("http://test/api/v1/integrations/gdrive/token", trusted.key, seed.teamSlug, {
      integration_id: integrationId, generation: resumed.body.generation,
      fence: resumed.body.fence, owner: resumed.owner,
    }));
    expect(providerRevoked.status).toBe(409);
    const revokedBody = await providerRevoked.json();
    expect(revokedBody.error.code).toBe("reconnect_required");
    expect(JSON.stringify(revokedBody)).not.toMatch(/refresh|client_secret|never-return/);
    expect(tokenFetch).toHaveBeenCalledTimes(2);

    await revokeApiKey(db(), seed.teamId, trusted.apiKeyId);
    const revoked = await tokenPOST(request("http://test/api/v1/integrations/gdrive/token", trusted.key, seed.teamSlug, tokenBody));
    expect(revoked.status).toBe(401);
  });

  it("runs callback -> encrypted refresh store -> broker and preserves the refresh secret on scope save", async () => {
    const seed = await seedTeam();
    const audienceProjectId = await approvedAudienceProject(seed);
    await db().from("members").update({ role: "admin" }).eq("id", seed.memberId).eq("team_id", seed.teamId);
    process.env.AUTH_SECRET = "aio-1167-data-mechanics-auth-secret";
    process.env.GOOGLE_DRIVE_CLIENT_ID = "oauth-client";
    process.env.GOOGLE_DRIVE_CLIENT_SECRET = "oauth-secret";
    process.env.GOOGLE_DRIVE_OAUTH_REDIRECT = "http://test/api/auth/gdrive/callback";
    const state = await createGoogleDriveOAuthState(db(), {
      teamId: seed.teamId, memberId: seed.memberId, integrationName: "callback-docs", teamSlug: seed.teamSlug,
      browserBinding: startedBy(seed),
    });
    const provider = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(JSON.stringify({
        access_token: "callback-access", refresh_token: "callback-refresh", expires_in: 3600,
        scope: "https://www.googleapis.com/auth/drive.file",
      }), { status: 200, headers: { "content-type": "application/json" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ sub: "google-subject", email: "admin@example.com", name: "Admin" }), {
        status: 200, headers: { "content-type": "application/json" },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        access_token: "broker-access", expires_in: 600,
        scope: "https://www.googleapis.com/auth/drive.file",
      }), { status: 200, headers: { "content-type": "application/json" } }));
    const callback = await oauthCallbackGET(new NextRequest(
      `http://test/api/auth/gdrive/callback?state=${encodeURIComponent(state)}&code=one-time-code`,
      INITIATING_BROWSER,
    ));
    expect(callback.status).toBe(200);
    const stored = await getIntegrationWithSecret(db(), seed.teamId, "gdrive", "callback-docs");
    expect(stored?.secret).toContain("callback-refresh");
    expect(stored?.config).toMatchObject({ authenticatedAccountId: "subject:google-subject" });
    // The provider email does not exactly match this team's roster. A shared/login transport account
    // stays actionable on the integration, but must not be credited to the initiating Admin.
    expect((await db().from("member_identities").select("member_id")
      .eq("team_id", seed.teamId).eq("provider", "gdrive")
      .eq("external_id", "subject:google-subject").maybeSingle()).data).toBeNull();

    await upsertIntegration(db(), { teamId: seed.teamId, memberId: seed.memberId }, {
      type: "gdrive", name: "callback-docs", status: "enabled",
      config: {
        ...stored!.config,
        fileIds: ["SelectedOnly"],
        selectionState: "selected",
        audienceProjectIds: [audienceProjectId],
      },
    });
    expect((await getIntegrationWithSecret(db(), seed.teamId, "gdrive", "callback-docs"))?.secret)
      .toContain("callback-refresh");

    const trusted = await provision(seed, stored!.id);
    const active = await acquire(trusted.key, seed, stored!.id);
    const token = await tokenPOST(request("http://test/api/v1/integrations/gdrive/token", trusted.key, seed.teamSlug, {
      integration_id: stored!.id, generation: active.body.generation,
      fence: active.body.fence, owner: active.owner,
    }));
    expect(token.status).toBe(200);
    const grant = await token.json();
    expect(grant).toMatchObject({ access_token: "broker-access", account: { subject: "subject:google-subject" } });
    expect(JSON.stringify(grant)).not.toContain("callback-refresh");
    expect(provider).toHaveBeenCalledTimes(3);
  });

  it("atomically links an exact verified OAuth account in subject and author-email namespaces", async () => {
    const seed = await seedTeam();
    await db().from("members").update({ role: "admin" }).eq("id", seed.memberId).eq("team_id", seed.teamId);
    const { data: memberRow, error: memberError } = await db().from("members")
      .select("email").eq("id", seed.memberId).eq("team_id", seed.teamId).single();
    if (memberError || !memberRow?.email) throw new Error(memberError?.message ?? "member email missing");
    process.env.AUTH_SECRET = "aio-1167-data-mechanics-auth-secret";
    process.env.GOOGLE_DRIVE_CLIENT_ID = "oauth-client";
    process.env.GOOGLE_DRIVE_CLIENT_SECRET = "oauth-secret";
    process.env.GOOGLE_DRIVE_OAUTH_REDIRECT = "http://test/api/auth/gdrive/callback";
    const state = await createGoogleDriveOAuthState(db(), {
      teamId: seed.teamId, memberId: seed.memberId,
      integrationName: "exact-member-account", teamSlug: seed.teamSlug,
      browserBinding: startedBy(seed),
    });
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(JSON.stringify({
        access_token: "callback-access", refresh_token: "callback-refresh", expires_in: 3600,
        scope: "https://www.googleapis.com/auth/drive.file",
      }), { status: 200, headers: { "content-type": "application/json" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        sub: "exact-google-subject", email: memberRow.email, name: "Exact Member",
      }), { status: 200, headers: { "content-type": "application/json" } }));

    const callback = await oauthCallbackGET(new NextRequest(
      `http://test/api/auth/gdrive/callback?state=${encodeURIComponent(state)}&code=one-time-code`,
      INITIATING_BROWSER,
    ));
    expect(callback.status).toBe(200);
    const { data: identities, error } = await db().from("member_identities")
      .select("external_id,member_id")
      .eq("team_id", seed.teamId)
      .eq("provider", "gdrive")
      .in("external_id", [
        "subject:exact-google-subject",
        `author-email:${memberRow.email.toLowerCase()}`,
      ]);
    expect(error).toBeNull();
    expect(identities?.sort((a, b) => a.external_id.localeCompare(b.external_id))).toEqual([
      { external_id: `author-email:${memberRow.email.toLowerCase()}`, member_id: seed.memberId },
      { external_id: "subject:exact-google-subject", member_id: seed.memberId },
    ]);
    const { count } = await db().from("identity_repair_obligations")
      .select("*", { count: "exact", head: true })
      .eq("team_id", seed.teamId)
      .eq("provider", "gdrive")
      .in("external_id", [
        "subject:exact-google-subject",
        `author-email:${memberRow.email.toLowerCase()}`,
      ]);
    expect(count).toBe(2);
  });

  it("leaves the prior OAuth pair unchanged when a different subject returns no refresh token", async () => {
    const seed = await seedTeam();
    await db().from("members").update({ role: "admin" }).eq("id", seed.memberId).eq("team_id", seed.teamId);
    process.env.AUTH_SECRET = "aio-1167-data-mechanics-auth-secret";
    process.env.GOOGLE_DRIVE_CLIENT_ID = "oauth-client";
    process.env.GOOGLE_DRIVE_CLIENT_SECRET = "oauth-secret";
    process.env.GOOGLE_DRIVE_OAUTH_REDIRECT = "http://test/api/auth/gdrive/callback";
    await integration(seed, "atomic-pair");
    const before = await getIntegrationWithSecret(db(), seed.teamId, "gdrive", "atomic-pair");
    const state = await createGoogleDriveOAuthState(db(), {
      teamId: seed.teamId, memberId: seed.memberId, integrationName: "atomic-pair", teamSlug: seed.teamSlug,
      browserBinding: startedBy(seed),
    });
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: "new-account-no-refresh" }), {
        status: 200, headers: { "content-type": "application/json" },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ sub: "different-subject", email: "other@example.com" }), {
        status: 200, headers: { "content-type": "application/json" },
      }));
    const callback = await oauthCallbackGET(new NextRequest(
      `http://test/api/auth/gdrive/callback?state=${encodeURIComponent(state)}&code=new-account`,
      INITIATING_BROWSER,
    ));
    expect(callback.status).toBe(422);
    const after = await getIntegrationWithSecret(db(), seed.teamId, "gdrive", "atomic-pair");
    expect(after?.config).toEqual(before?.config);
    expect(after?.secret).toBe(before?.secret);
  });

  it("publishes OAuth mode atomically over a previous service-account configuration", async () => {
    const seed = await seedTeam();
    await db().from("members").update({ role: "admin" }).eq("id", seed.memberId).eq("team_id", seed.teamId);
    process.env.AUTH_SECRET = "aio-1167-data-mechanics-auth-secret";
    process.env.GOOGLE_DRIVE_CLIENT_ID = "oauth-client";
    process.env.GOOGLE_DRIVE_CLIENT_SECRET = "oauth-secret";
    process.env.GOOGLE_DRIVE_OAUTH_REDIRECT = "http://test/api/auth/gdrive/callback";
    await upsertIntegration(db(), { teamId: seed.teamId, memberId: seed.memberId }, {
      type: "gdrive", name: "service-to-oauth", status: "enabled",
      config: {
        fileIds: ["Selected"], folderIds: [], sharedDriveIds: [], recursive: false,
        selectionState: "selected", projectSlug: "docs", access: "team",
        authMode: "service_account",
      },
    });
    const state = await createGoogleDriveOAuthState(db(), {
      teamId: seed.teamId, memberId: seed.memberId,
      integrationName: "service-to-oauth", teamSlug: seed.teamSlug,
      browserBinding: startedBy(seed),
    });
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(JSON.stringify({
        access_token: "oauth-access", refresh_token: "oauth-refresh",
      }), { status: 200, headers: { "content-type": "application/json" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        sub: "oauth-subject", email: "oauth@example.com",
      }), { status: 200, headers: { "content-type": "application/json" } }));

    const callback = await oauthCallbackGET(new NextRequest(
      `http://test/api/auth/gdrive/callback?state=${encodeURIComponent(state)}&code=one-time-code`,
      INITIATING_BROWSER,
    ));
    expect(callback.status).toBe(200);
    const stored = await getIntegrationWithSecret(db(), seed.teamId, "gdrive", "service-to-oauth");
    expect(stored?.config).toMatchObject({ authMode: "oauth", fileIds: ["Selected"] });
    expect(stored?.secret).toContain("oauth-refresh");
  });

  it("a state presented by another browser exchanges nothing, stores nothing, and stays redeemable", async () => {
    const seed = await seedTeam();
    await db().from("members").update({ role: "admin" }).eq("id", seed.memberId).eq("team_id", seed.teamId);
    process.env.AUTH_SECRET = "aio-1167-data-mechanics-auth-secret";
    process.env.GOOGLE_DRIVE_CLIENT_ID = "oauth-client";
    process.env.GOOGLE_DRIVE_CLIENT_SECRET = "oauth-secret";
    process.env.GOOGLE_DRIVE_OAUTH_REDIRECT = "http://test/api/auth/gdrive/callback";
    const state = await createGoogleDriveOAuthState(db(), {
      teamId: seed.teamId, memberId: seed.memberId, integrationName: "leaked-state", teamSlug: seed.teamSlug,
      browserBinding: startedBy(seed),
    });
    const provider = vi.spyOn(globalThis, "fetch");
    const url = `http://test/api/auth/gdrive/callback?state=${encodeURIComponent(state)}&code=one-time-code`;

    // Whoever holds the leaked state finishes consent with a Google account of their own, from a
    // browser that never started this grant: with no binding cookie, or with some other one.
    for (const browser of [undefined, { headers: { cookie: `${GDRIVE_OAUTH_BINDING_COOKIE}=another-browser` } }]) {
      expect((await oauthCallbackGET(new NextRequest(url, browser))).status).toBe(400);
    }
    expect(provider).not.toHaveBeenCalled();
    expect(await getIntegrationWithSecret(db(), seed.teamId, "gdrive", "leaked-state")).toBeFalsy();
    // The nonce was not consumed, so the attempt cost the rightful Admin nothing.
    const { data: unused } = await db().from("oauth_states").select("used_at")
      .eq("team_id", seed.teamId).eq("provider", "gdrive");
    expect(unused).toEqual([{ used_at: null }]);

    provider
      .mockResolvedValueOnce(new Response(JSON.stringify({
        access_token: "callback-access", refresh_token: "callback-refresh",
      }), { status: 200, headers: { "content-type": "application/json" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ sub: "rightful-subject", email: "rightful@example.com" }), {
        status: 200, headers: { "content-type": "application/json" },
      }));
    expect((await oauthCallbackGET(new NextRequest(url, INITIATING_BROWSER))).status).toBe(200);
    expect((await getIntegrationWithSecret(db(), seed.teamId, "gdrive", "leaked-state"))?.config)
      .toMatchObject({ authenticatedAccountId: "subject:rightful-subject" });
  });

  it("the initiating browser without the initiating Admin's session exchanges nothing and stores nothing", async () => {
    const seed = await seedTeam();
    await db().from("members").update({ role: "admin" }).eq("id", seed.memberId).eq("team_id", seed.teamId);
    process.env.AUTH_SECRET = "aio-1167-data-mechanics-auth-secret";
    process.env.GOOGLE_DRIVE_CLIENT_ID = "oauth-client";
    process.env.GOOGLE_DRIVE_CLIENT_SECRET = "oauth-secret";
    process.env.GOOGLE_DRIVE_OAUTH_REDIRECT = "http://test/api/auth/gdrive/callback";
    await integration(seed, "session-changed");
    const before = await getIntegrationWithSecret(db(), seed.teamId, "gdrive", "session-changed");
    const state = await createGoogleDriveOAuthState(db(), {
      teamId: seed.teamId, memberId: seed.memberId, integrationName: "session-changed", teamSlug: seed.teamSlug,
      browserBinding: startedBy(seed),
    });
    const provider = vi.spyOn(globalThis, "fetch");
    // Same browser, but the Admin who started the grant is no longer the one signed in.
    adminSession.memberId = "00000000-0000-4000-8000-000000000000";

    const callback = await oauthCallbackGET(new NextRequest(
      `http://test/api/auth/gdrive/callback?state=${encodeURIComponent(state)}&code=one-time-code`,
      INITIATING_BROWSER,
    ));

    expect(callback.status).toBe(403);
    expect(provider).not.toHaveBeenCalled();
    const after = await getIntegrationWithSecret(db(), seed.teamId, "gdrive", "session-changed");
    expect(after?.config).toEqual(before?.config);
    expect(after?.secret).toBe(before?.secret);
  });

  it.each([
    ["demoted", { role: "member" }],
    ["deactivated", { status: "disabled" }],
  ] as const)("keeps the prior OAuth pair when the initiating Admin is %s during exchange", async (_case, mutation) => {
    const seed = await seedTeam();
    await db().from("members").update({ role: "admin" }).eq("id", seed.memberId).eq("team_id", seed.teamId);
    process.env.AUTH_SECRET = "aio-1167-data-mechanics-auth-secret";
    process.env.GOOGLE_DRIVE_CLIENT_ID = "oauth-client";
    process.env.GOOGLE_DRIVE_CLIENT_SECRET = "oauth-secret";
    process.env.GOOGLE_DRIVE_OAUTH_REDIRECT = "http://test/api/auth/gdrive/callback";
    await integration(seed, `initiator-${_case}`);
    const before = await getIntegrationWithSecret(db(), seed.teamId, "gdrive", `initiator-${_case}`);
    const state = await createGoogleDriveOAuthState(db(), {
      teamId: seed.teamId, memberId: seed.memberId,
      integrationName: `initiator-${_case}`, teamSlug: seed.teamSlug,
      browserBinding: startedBy(seed),
    });
    vi.spyOn(globalThis, "fetch")
      .mockImplementationOnce(async () => {
        await db().from("members").update(mutation).eq("id", seed.memberId).eq("team_id", seed.teamId);
        return new Response(JSON.stringify({
          access_token: "new-access", refresh_token: "new-refresh",
        }), { status: 200, headers: { "content-type": "application/json" } });
      })
      .mockResolvedValueOnce(new Response(JSON.stringify({
        sub: "new-subject", email: "new@example.com",
      }), { status: 200, headers: { "content-type": "application/json" } }));

    const callback = await oauthCallbackGET(new NextRequest(
      `http://test/api/auth/gdrive/callback?state=${encodeURIComponent(state)}&code=one-time-code`,
      INITIATING_BROWSER,
    ));
    expect(callback.status).toBe(403);
    const after = await getIntegrationWithSecret(db(), seed.teamId, "gdrive", `initiator-${_case}`);
    expect(after?.config).toEqual(before?.config);
    expect(after?.secret).toBe(before?.secret);
  });

  it("keeps the prior OAuth pair when the initiating Admin transfers teams during exchange", async () => {
    const seed = await seedTeam();
    const destination = await seedTeam();
    await db().from("members").update({ role: "admin" }).eq("id", seed.memberId).eq("team_id", seed.teamId);
    process.env.AUTH_SECRET = "aio-1167-data-mechanics-auth-secret";
    process.env.GOOGLE_DRIVE_CLIENT_ID = "oauth-client";
    process.env.GOOGLE_DRIVE_CLIENT_SECRET = "oauth-secret";
    process.env.GOOGLE_DRIVE_OAUTH_REDIRECT = "http://test/api/auth/gdrive/callback";
    await integration(seed, "initiator-transferred");
    const before = await getIntegrationWithSecret(db(), seed.teamId, "gdrive", "initiator-transferred");
    const state = await createGoogleDriveOAuthState(db(), {
      teamId: seed.teamId, memberId: seed.memberId,
      integrationName: "initiator-transferred", teamSlug: seed.teamSlug,
      browserBinding: startedBy(seed),
    });
    vi.spyOn(globalThis, "fetch")
      .mockImplementationOnce(async () => {
        await db().from("group_members").delete().eq("member_id", seed.memberId);
        const { error } = await db().from("members").update({ team_id: destination.teamId })
          .eq("id", seed.memberId).eq("team_id", seed.teamId);
        if (error) throw new Error(error.message);
        return new Response(JSON.stringify({
          access_token: "new-access", refresh_token: "new-refresh",
        }), { status: 200, headers: { "content-type": "application/json" } });
      })
      .mockResolvedValueOnce(new Response(JSON.stringify({
        sub: "new-subject", email: "new@example.com",
      }), { status: 200, headers: { "content-type": "application/json" } }));

    const callback = await oauthCallbackGET(new NextRequest(
      `http://test/api/auth/gdrive/callback?state=${encodeURIComponent(state)}&code=one-time-code`,
      INITIATING_BROWSER,
    ));
    expect(callback.status).toBe(403);
    const after = await getIntegrationWithSecret(db(), seed.teamId, "gdrive", "initiator-transferred");
    expect(after?.config).toEqual(before?.config);
    expect(after?.secret).toBe(before?.secret);
  });

  it("enforces stored Drive ownership when incoming provenance is omitted or relabelled", async () => {
    const seed = await seedTeam();
    const integrationId = await integration(seed, "stored-owner");
    const trusted = await provision(seed, integrationId);
    const active = await acquire(trusted.key, seed, integrationId);
    const body = "owned by Drive";
    const headers = {
      "X-AIOS-Integration-Id": integrationId,
      "X-AIOS-Execution-Generation": String(active.body.generation),
      "X-AIOS-Execution-Fence": String(active.body.fence),
      "X-AIOS-Execution-Owner": active.owner,
    };
    const created = await itemsPOST(request("http://test/api/v1/items", trusted.key, seed.teamSlug, {
      project: "docs", path: "gdrive/owned.md", kind: "deliverable", access: "team",
      actor: "gdrive-sync", body, content_sha256: sha(body),
      frontmatter: { source: "gdrive", source_id: "owned", connection_id: integrationId },
    }, headers));
    expect(created.status).toBe(201);

    const ordinary = await issueApiKey(db(), seed.teamId, seed.memberId, "ordinary overwrite");
    for (const frontmatter of [{}, { source: "notion", source_id: "owned" }]) {
      const changed = `${body}-${JSON.stringify(frontmatter)}`;
      const overwrite = await itemsPOST(request("http://test/api/v1/items", ordinary.key, seed.teamSlug, {
        project: "docs", path: "gdrive/owned.md", kind: "deliverable", access: "team",
        actor: "member", body: changed, content_sha256: sha(changed), frontmatter,
      }));
      expect(overwrite.status).toBe(403);
      expect((await overwrite.json()).error.code).toBe("connector_principal_required");
    }
  });

  it("fences A-B-A, expired replacements, pause-after-start, and manual/scheduled races", async () => {
    const seed = await seedTeam();
    const integrationId = await integration(seed, "scope-cycle", ["A"]);
    const trusted = await provision(seed, integrationId);
    const first = await acquire(trusted.key, seed, integrationId);
    expect(first.response.status).toBe(200);

    const racing = await acquire(trusted.key, seed, integrationId, randomUUID());
    expect(racing.response.status).toBe(409);
    expect(racing.body.error.code).toBe("execution_busy");

    await db().from("gdrive_connection_authority").update({ lease_until: "2000-01-01T00:00:00Z" }).eq("integration_id", integrationId);
    const replacement = await acquire(trusted.key, seed, integrationId, randomUUID());
    expect(replacement.response.status).toBe(200);
    expect(replacement.body.fence).toBeGreaterThan(first.body.fence);

    await upsertIntegration(db(), { teamId: seed.teamId, memberId: seed.memberId }, {
      type: "gdrive", name: "scope-cycle", status: "enabled",
      config: { ...replacement.body.config, fileIds: ["B"] },
    });
    const afterB = (await db().from("gdrive_connection_authority").select("generation").eq("integration_id", integrationId).single()).data as { generation: number };
    await upsertIntegration(db(), { teamId: seed.teamId, memberId: seed.memberId }, {
      type: "gdrive", name: "scope-cycle", status: "enabled",
      config: { ...replacement.body.config, fileIds: ["A"] },
    });
    const afterA = (await db().from("gdrive_connection_authority").select("generation").eq("integration_id", integrationId).single()).data as { generation: number };
    expect(Number(afterA.generation)).toBe(Number(afterB.generation) + 1);

    const body = "stale content";
    const stalePush = await itemsPOST(request("http://test/api/v1/items", trusted.key, seed.teamSlug, {
      project: "docs", path: "gdrive/DocA.md", kind: "deliverable", access: "team",
      actor: "gdrive-sync", body, content_sha256: sha(body),
      frontmatter: { source: "gdrive", source_id: "DocA", connection_id: integrationId },
    }, {
      "X-AIOS-Integration-Id": integrationId,
      "X-AIOS-Execution-Generation": String(replacement.body.generation),
      "X-AIOS-Execution-Fence": String(replacement.body.fence),
      "X-AIOS-Execution-Owner": replacement.owner,
    }));
    expect(stalePush.status).toBe(409);
    expect((await stalePush.json()).error.code).toBe("stale_execution");

    const current = await acquire(trusted.key, seed, integrationId, randomUUID());
    expect(current.response.status).toBe(200);
    await setIntegrationStatus(db(), { teamId: seed.teamId, memberId: seed.memberId }, integrationId, "disabled");
    const checkpoint = await executionPOST(request("http://test/api/v1/integrations/gdrive/execution", trusted.key, seed.teamSlug, {
      action: "checkpoint", integration_id: integrationId, generation: current.body.generation,
      fence: current.body.fence, owner: current.owner,
      progress_revision: current.body.progress_revision,
      progress: { phase: "current" },
    }));
    expect(checkpoint.status).toBe(409);
  });

  it.each([
    ["current", {
      phase: "current", drive_id: "my-drive", baseline_start_token: "baseline-start",
      page_token: "current-cursor", traversal_token: null, listing_complete: true,
    }],
    ["mid-baseline", {
      phase: "baselining", drive_id: "shared-drive", baseline_start_token: "baseline-start",
      page_token: null, traversal_token: "folder-page-2", listing_complete: false,
    }],
    ["partial change page", {
      phase: "partial", drive_id: "shared-drive", baseline_start_token: "baseline-start",
      page_token: "change-page-3", traversal_token: null, listing_complete: true,
      pending_obligations: ["DocA", "DocB"], last_error: "change page pending",
    }],
  ] as const)("pause/resume fences the worker but preserves %s progress", async (_phase, progress) => {
    const seed = await seedTeam();
    const integrationId = await integration(seed, `pause-progress-${_phase}`);
    const trusted = await provision(seed, integrationId);
    const active = await acquire(trusted.key, seed, integrationId);
    const committed = await executionPOST(request(
      "http://test/api/v1/integrations/gdrive/execution", trusted.key, seed.teamSlug,
      {
        action: "checkpoint", integration_id: integrationId,
        generation: active.body.generation, fence: active.body.fence, owner: active.owner,
        progress_revision: active.body.progress_revision, progress,
      },
    ));
    expect(committed.status).toBe(200);
    const committedBody = await committed.json();

    await setIntegrationStatus(
      db(), { teamId: seed.teamId, memberId: seed.memberId }, integrationId, "disabled",
    );
    const paused = (await db().from("gdrive_connection_authority")
      .select("generation,fence,lease_owner,lease_until,progress,progress_revision")
      .eq("integration_id", integrationId).single()).data as Record<string, unknown>;
    expect(Number(paused.generation)).toBe(Number(active.body.generation));
    expect(Number(paused.fence)).toBe(Number(active.body.fence) + 1);
    expect(paused.lease_owner).toBeNull();
    expect(paused.lease_until).toBeNull();
    expect(paused.progress).toEqual(progress);
    expect(Number(paused.progress_revision)).toBe(Number(committedBody.progress_revision));
    const rejectedWhilePaused = await acquire(trusted.key, seed, integrationId, randomUUID());
    expect(rejectedWhilePaused.response.status).toBe(409);

    await setIntegrationStatus(
      db(), { teamId: seed.teamId, memberId: seed.memberId }, integrationId, "enabled",
    );
    const resumedRow = (await db().from("gdrive_connection_authority")
      .select("generation,fence,progress,progress_revision")
      .eq("integration_id", integrationId).single()).data as Record<string, unknown>;
    expect(Number(resumedRow.generation)).toBe(Number(active.body.generation));
    expect(Number(resumedRow.fence)).toBe(Number(active.body.fence) + 2);
    expect(resumedRow.progress).toEqual(progress);
    expect(Number(resumedRow.progress_revision)).toBe(Number(committedBody.progress_revision));

    const resumed = await acquire(trusted.key, seed, integrationId, randomUUID());
    expect(resumed.response.status).toBe(200);
    expect(Number(resumed.body.generation)).toBe(Number(active.body.generation));
    expect(resumed.body.progress).toEqual(progress);
    expect(Number(resumed.body.progress_revision)).toBe(Number(committedBody.progress_revision));
    const stale = await executionPOST(request(
      "http://test/api/v1/integrations/gdrive/execution", trusted.key, seed.teamSlug,
      {
        action: "authorize_provider", integration_id: integrationId,
        generation: active.body.generation, fence: active.body.fence, owner: active.owner,
      },
    ));
    expect(stale.status).toBe(409);
  });

  it("advances content generation and clears progress for selection or account changes", async () => {
    const seed = await seedTeam();
    const integrationId = await integration(seed, "scope-account-generation", ["A"]);
    const trusted = await provision(seed, integrationId);
    const active = await acquire(trusted.key, seed, integrationId);
    const checkpoint = await executionPOST(request(
      "http://test/api/v1/integrations/gdrive/execution", trusted.key, seed.teamSlug,
      {
        action: "checkpoint", integration_id: integrationId,
        generation: active.body.generation, fence: active.body.fence, owner: active.owner,
        progress_revision: active.body.progress_revision,
        progress: { phase: "current", page_token: "preserve-only-with-same-content" },
      },
    ));
    expect(checkpoint.status).toBe(200);

    await upsertIntegration(db(), { teamId: seed.teamId, memberId: seed.memberId }, {
      type: "gdrive", name: "scope-account-generation", status: "enabled",
      config: { ...active.body.config, fileIds: ["B"] },
    });
    const afterSelection = (await db().from("gdrive_connection_authority")
      .select("generation,progress").eq("integration_id", integrationId).single()).data as {
        generation: string | number; progress: Record<string, unknown>;
      };
    expect(Number(afterSelection.generation)).toBe(Number(active.body.generation) + 1);
    expect(afterSelection.progress).toEqual({});

    await upsertIntegration(db(), { teamId: seed.teamId, memberId: seed.memberId }, {
      type: "gdrive", name: "scope-account-generation", status: "enabled",
      config: { ...active.body.config, fileIds: ["B"], authenticatedAccountId: "subject:acct-2" },
    });
    const afterAccount = (await db().from("gdrive_connection_authority")
      .select("generation,progress").eq("integration_id", integrationId).single()).data as {
        generation: string | number; progress: Record<string, unknown>;
      };
    expect(Number(afterAccount.generation)).toBe(Number(afterSelection.generation) + 1);
    expect(afterAccount.progress).toEqual({});
  });

  it("allows 100/min progress, isolates release capacity, and makes checkpoint replay monotonic", async () => {
    const seed = await seedTeam();
    const integrationId = await integration(seed, "progress-quota");
    const trusted = await provision(seed, integrationId);
    const active = await acquire(trusted.key, seed, integrationId);
    let revision = Number(active.body.progress_revision);
    const checkpoint = async (expected: number, progress: Record<string, unknown>) => {
      const response = await executionPOST(request(
        "http://test/api/v1/integrations/gdrive/execution", trusted.key, seed.teamSlug,
        {
          action: "checkpoint", integration_id: integrationId,
          generation: active.body.generation, fence: active.body.fence, owner: active.owner,
          progress_revision: expected, progress,
        },
      ));
      return { response, body: await response.json() };
    };

    for (let index = 0; index < 100; index += 1) {
      const result = await checkpoint(revision, { page_token: `page-${index}` });
      expect(result.response.status).toBe(200);
      revision = Number(result.body.progress_revision);
    }
    const replayPayload = { page_token: "replay-safe" };
    const committed = await checkpoint(revision, replayPayload);
    expect(committed.response.status).toBe(200);
    const committedRevision = Number(committed.body.progress_revision);
    const replay = await checkpoint(revision, replayPayload);
    expect(replay.response.status).toBe(200);
    expect(Number(replay.body.progress_revision)).toBe(committedRevision);
    const regression = await checkpoint(revision, { page_token: "must-not-regress" });
    expect(regression.response.status).toBe(409);
    const persisted = (await db().from("gdrive_connection_authority").select("progress,progress_revision")
      .eq("integration_id", integrationId).single()).data as {
      progress: Record<string, unknown>; progress_revision: string | number;
    };
    expect(persisted.progress).toEqual(replayPayload);
    expect(Number(persisted.progress_revision)).toBe(committedRevision);

    // Saturate only the progress bucket. Release has independent cleanup capacity.
    revision = committedRevision;
    for (let index = 102; index < 239; index += 1) {
      const result = await checkpoint(revision, { page_token: `page-${index}` });
      expect(result.response.status).toBe(200);
      revision = Number(result.body.progress_revision);
    }
    const limited = await checkpoint(revision, { page_token: "over-limit" });
    expect(limited.response.status).toBe(429);
    expect(limited.response.headers.get("retry-after")).toMatch(/^\d+$/);
    const released = await executionPOST(request(
      "http://test/api/v1/integrations/gdrive/execution", trusted.key, seed.teamSlug,
      {
        action: "release", integration_id: integrationId,
        generation: active.body.generation, fence: active.body.fence, owner: active.owner,
      },
    ));
    expect(released.status).toBe(200);
  });
});
