import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";

import { setIntegrationSecret, setIntegrationStatus, upsertIntegration } from "@/lib/integrations/manage";
import { provisionGdriveConnectorPrincipal } from "@/lib/integrations/gdrive-authority";
import { approvedAudienceProject, sha } from "../datamechanics/helpers";
import { BASE_URL, db, issueKeyFor, keyHeaders, seedTeam, type Seed } from "./http-helpers";

async function connector(seed: Seed, integrationId: string) {
  await db().from("members").update({ role: "admin" }).eq("id", seed.memberId).eq("team_id", seed.teamId);
  return provisionGdriveConnectorPrincipal({
    teamId: seed.teamId, integrationId, actorMemberId: seed.memberId,
  });
}

async function integration(seed: Seed, name = "docs", files = ["A"]) {
  const audienceProjectId = await approvedAudienceProject(seed);
  const row = await upsertIntegration(db(), { teamId: seed.teamId, memberId: seed.memberId }, {
    type: "gdrive", name, status: "enabled",
    config: {
      fileIds: files, folderIds: [], sharedDriveIds: [], recursive: false,
      selectionState: "selected", projectSlug: "docs", access: "team", authMode: "oauth",
      authenticatedAccount: "docs@example.com", authenticatedAccountId: "subject:acct",
      scopeSet: ["https://www.googleapis.com/auth/drive.file"],
      audienceProjectIds: [audienceProjectId],
    },
  });
  await setIntegrationSecret(db(), { teamId: seed.teamId, memberId: seed.memberId }, row.id, JSON.stringify({
    client_id: "client", client_secret: "secret", refresh_token: "refresh",
    scopes: ["https://www.googleapis.com/auth/drive.file"], account_subject: "subject:acct",
  }));
  return row.id;
}

async function acquire(key: string, seed: Seed, integrationId: string, owner = randomUUID()) {
  const response = await fetch(`${BASE_URL}/api/v1/integrations/gdrive/execution`, {
    method: "POST", headers: keyHeaders(key, seed.teamSlug),
    body: JSON.stringify({ action: "acquire", integration_id: integrationId, owner }),
  });
  return { response, body: await response.json(), owner };
}

function driveItem(integrationId: string) {
  const body = "Google document body";
  return {
    project: "docs", path: "gdrive/A.md", kind: "deliverable", access: "team",
    actor: "gdrive-sync", body, content_sha256: sha(body),
    frontmatter: { source: "gdrive", source_id: "A", connection_id: integrationId },
  };
}

describe("AIO-1167 authenticated HTTP connector authority", () => {
  it("completes, replays, fails, and recovers interrupted run reports over real HTTP", async () => {
    const seed = await seedTeam();
    const integrationId = await integration(seed, "run-wire");
    const issued = await connector(seed, integrationId);
    const headers = keyHeaders(issued.key, seed.teamSlug);
    const { data: first } = await db().from("gdrive_run_requests").insert({
      team_id: seed.teamId, integration_id: integrationId, requested_by: seed.memberId,
      trigger: "manual", status: "pending",
    }).select("id").single();
    const claim = await fetch(`${BASE_URL}/api/v1/integrations/gdrive/runs`, { headers });
    expect(claim.status).toBe(200);
    expect(await claim.json()).toMatchObject({ request: { id: (first as { id: string }).id } });
    const completion = {
      requestId: (first as { id: string }).id, status: "complete", unchanged: 1,
      backlog: 0, authoritativeComplete: true,
    };
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const response = await fetch(`${BASE_URL}/api/v1/integrations/gdrive/runs`, {
        method: "POST", headers, body: JSON.stringify(completion),
      });
      expect(response.status).toBe(200);
    }

    const interruptedId = randomUUID();
    await db().from("gdrive_run_requests").insert({
      id: interruptedId, team_id: seed.teamId, integration_id: integrationId,
      trigger: "retry", status: "running", started_at: new Date(Date.now() - 20 * 60_000).toISOString(),
    });
    const recovered = await fetch(`${BASE_URL}/api/v1/integrations/gdrive/runs`, { headers });
    expect(await recovered.json()).toMatchObject({ request: { id: interruptedId } });
    const failed = await fetch(`${BASE_URL}/api/v1/integrations/gdrive/runs`, {
      method: "POST", headers, body: JSON.stringify({
        requestId: interruptedId, status: "failed", failed: 1, error: "provider_timeout",
        backlog: null, authoritativeComplete: false,
      }),
    });
    expect(failed.status).toBe(200);
    const { data: rows } = await db().from("gdrive_run_requests").select("status,error").in("id", [
      (first as { id: string }).id, interruptedId,
    ]).order("status");
    expect(rows).toEqual(expect.arrayContaining([
      expect.objectContaining({ status: "complete", error: null }),
      expect.objectContaining({ status: "failed", error: "provider_timeout" }),
    ]));
  });

  it("accepts idempotent checkpoint replay without advancing progress over HTTP", async () => {
    const seed = await seedTeam();
    const integrationId = await integration(seed, "checkpoint-replay");
    const issued = await connector(seed, integrationId);
    const active = await acquire(issued.key, seed, integrationId);
    const payload = {
      action: "checkpoint", integration_id: integrationId,
      generation: active.body.generation, fence: active.body.fence, owner: active.owner,
      progress_revision: active.body.progress_revision,
      progress: { page_token: "opaque-next", phase: "catching_up" },
    };
    const send = () => fetch(`${BASE_URL}/api/v1/integrations/gdrive/execution`, {
      method: "POST", headers: keyHeaders(issued.key, seed.teamSlug), body: JSON.stringify(payload),
    });

    const first = await send();
    expect(first.status).toBe(200);
    const firstBody = await first.json();
    const replay = await send();
    expect(replay.status).toBe(200);
    const replayBody = await replay.json();
    expect(replayBody.progress_revision).toBe(firstBody.progress_revision);
    expect(replayBody.progress).toEqual(payload.progress);
  });

  it("revalidates provider-call authority over HTTP before every Google request", async () => {
    const seed = await seedTeam();
    const integrationId = await integration(seed, "provider-gate");
    const issued = await connector(seed, integrationId);
    const active = await acquire(issued.key, seed, integrationId);
    const authorize = () => fetch(`${BASE_URL}/api/v1/integrations/gdrive/execution`, {
      method: "POST",
      headers: keyHeaders(issued.key, seed.teamSlug),
      body: JSON.stringify({
        action: "authorize_provider", integration_id: integrationId,
        generation: active.body.generation, fence: active.body.fence, owner: active.owner,
      }),
    });

    const allowed = await authorize();
    expect(allowed.status).toBe(200);
    expect(allowed.headers.get("cache-control")).toContain("no-store");

    await setIntegrationStatus(db(), { teamId: seed.teamId, memberId: seed.memberId }, integrationId, "disabled");
    const paused = await authorize();
    expect(paused.status).toBe(409);
    expect((await paused.json()).error.code).toBe("stale_execution");

    await setIntegrationStatus(db(), { teamId: seed.teamId, memberId: seed.memberId }, integrationId, "enabled");
    const stale = await authorize();
    expect(stale.status).toBe(409);
    expect((await stale.json()).error.code).toBe("stale_execution");
  });

  it("rejects ordinary/external keys at both Drive content and reconcile sinks", async () => {
    const seed = await seedTeam();
    const integrationId = await integration(seed);
    for (const tier of ["team", "external"] as const) {
      const { key } = await issueKeyFor(seed, tier);
      const pushed = await fetch(`${BASE_URL}/api/v1/items`, {
        method: "POST", headers: keyHeaders(key, seed.teamSlug), body: JSON.stringify(driveItem(integrationId)),
      });
      expect(pushed.status).toBe(403);
      expect((await pushed.json()).error.code).toBe("connector_principal_required");
      const reconciled = await fetch(`${BASE_URL}/api/v1/items/source-reconcile`, {
        method: "POST", headers: keyHeaders(key, seed.teamSlug), body: JSON.stringify({
          source: "gdrive", integration_id: integrationId, generation: 1, fence: 1,
          owner: randomUUID(), removed_provider_ids: [], reason: "probe",
        }),
      });
      expect(reconciled.status).toBe(403);
    }
  });

  it("rejects a wrong integration and an A-B-A stale execution over the wire", async () => {
    const seed = await seedTeam();
    const firstId = await integration(seed, "first", ["A"]);
    const secondId = await integration(seed, "second", ["B"]);
    const { key } = await connector(seed, firstId);
    const active = await acquire(key, seed, firstId);
    expect(active.response.status).toBe(200);
    const headers = {
      ...keyHeaders(key, seed.teamSlug),
      "X-AIOS-Integration-Id": firstId,
      "X-AIOS-Execution-Generation": String(active.body.generation),
      "X-AIOS-Execution-Fence": String(active.body.fence),
      "X-AIOS-Execution-Owner": active.owner,
    };
    const wrong = await fetch(`${BASE_URL}/api/v1/items`, {
      method: "POST",
      headers: { ...headers, "X-AIOS-Integration-Id": secondId },
      body: JSON.stringify(driveItem(secondId)),
    });
    expect(wrong.status).toBe(403);
    expect((await wrong.json()).error.code).toBe("wrong_connection");

    const accepted = await fetch(`${BASE_URL}/api/v1/items`, {
      method: "POST", headers, body: JSON.stringify(driveItem(firstId)),
    });
    expect(accepted.status).toBe(201);

    for (const files of [["B"], ["A"]]) {
      await upsertIntegration(db(), { teamId: seed.teamId, memberId: seed.memberId }, {
        type: "gdrive", name: "first", status: "enabled",
        config: { ...active.body.config, fileIds: files },
      });
    }
    const stale = await fetch(`${BASE_URL}/api/v1/items`, {
      method: "POST", headers, body: JSON.stringify(driveItem(firstId)),
    });
    expect(stale.status).toBe(409);
    expect((await stale.json()).error.code).toBe("stale_execution");
  });

  it("pause-after-acquire and API-key revocation stop token issuance before provider work", async () => {
    const seed = await seedTeam();
    const integrationId = await integration(seed);
    const issued = await connector(seed, integrationId);
    const active = await acquire(issued.key, seed, integrationId);
    expect(active.response.status).toBe(200);
    const body = JSON.stringify({
      integration_id: integrationId, generation: active.body.generation,
      fence: active.body.fence, owner: active.owner,
    });
    await setIntegrationStatus(db(), { teamId: seed.teamId, memberId: seed.memberId }, integrationId, "disabled");
    const paused = await fetch(`${BASE_URL}/api/v1/integrations/gdrive/token`, {
      method: "POST", headers: keyHeaders(issued.key, seed.teamSlug), body,
    });
    expect(paused.status).toBe(409);
    expect(paused.headers.get("cache-control")).not.toContain("public");

    const { data: keyRow } = await db().from("api_keys").select("id").eq("key_id", issued.keyId).single();
    await db().from("api_keys").update({ revoked_at: new Date().toISOString() }).eq("id", (keyRow as { id: string }).id);
    const revoked = await fetch(`${BASE_URL}/api/v1/integrations/gdrive/token`, {
      method: "POST", headers: keyHeaders(issued.key, seed.teamSlug), body,
    });
    expect(revoked.status).toBe(401);
  });
});
