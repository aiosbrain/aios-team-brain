import { randomUUID } from "node:crypto";
import { NextRequest } from "next/server";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * A revocation racing the token broker's issuance record (AIO-1167, real Postgres).
 *
 * Spec. The broker releases an OAuth access token only while the execution is still current, and
 * records the release (`gdrive.token_issued`). The record is a write the broker waits for. A pause,
 * disconnect, rebind/key rotation or key revocation that COMMITS while that write is in flight must
 * not be followed by a token: either the revocation is seen and the token withheld, or the
 * revocation cannot commit until the broker has.
 *
 * The record is suspended here, at the audit seam, on exactly that action. Each revocation is then
 * started for real against the same connection and either commits or is observed waiting on a row
 * lock — a fact read from `pg_stat_activity`, not inferred from a delay.
 */
const record = vi.hoisted(() => ({
  hold: null as null | { entered: () => void; released: Promise<void> },
}));

vi.mock("@/lib/api/audit", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api/audit")>();
  return {
    ...actual,
    audit: async (...args: Parameters<typeof actual.audit>) => {
      const hold = record.hold;
      if (hold && args[1].action === "gdrive.token_issued") {
        hold.entered();
        await hold.released;
      }
      return actual.audit(...args);
    },
  };
});

import { POST as executionPOST } from "@/app/api/v1/integrations/gdrive/execution/route";
import { POST as tokenPOST } from "@/app/api/v1/integrations/gdrive/token/route";
import { revokeApiKey } from "@/lib/admin/keys";
import { getPool } from "@/lib/db/pg/pool";
import { provisionGdriveConnectorPrincipal } from "@/lib/integrations/gdrive-authority";
import {
  disconnectGdriveIntegration,
  setIntegrationSecret,
  setIntegrationStatus,
  upsertIntegration,
} from "@/lib/integrations/manage";
import { approvedAudienceProject, db, seedTeam, type Seed } from "./helpers";

const GOOGLE_SECRET = JSON.stringify({
  client_id: "oauth-client", client_secret: "never-return-this",
  refresh_token: "never-return-refresh", token_uri: "https://oauth2.googleapis.com/token",
  scopes: ["https://www.googleapis.com/auth/drive.file"], account_subject: "subject:acct-1",
});
const ISSUED_TOKEN = "issued-before-the-revocation";

afterEach(() => {
  record.hold = null;
  vi.restoreAllMocks();
});

async function integration(seed: Seed): Promise<string> {
  const audienceProjectId = await approvedAudienceProject(seed);
  const row = await upsertIntegration(db(), { teamId: seed.teamId, memberId: seed.memberId }, {
    type: "gdrive", name: "company-docs", status: "enabled",
    config: {
      fileIds: ["DocA"], folderIds: [], sharedDriveIds: [], recursive: false,
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
  return { key: issued.key, apiKeyId: (keyRow as { id: string }).id };
}

function request(url: string, key: string, team: string, body: unknown) {
  return new Request(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "X-AIOS-Team": team, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }) as NextRequest;
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

/** True once a backend is waiting on a lock; false if `settled()` turns true first. */
async function waitsOnLockBefore(settled: () => boolean): Promise<boolean> {
  for (let tries = 0; tries < 400; tries++) {
    if (settled()) return false;
    const { rows } = await getPool().query<{ n: number }>(
      `select count(*)::int as n from pg_stat_activity
        where datname = current_database() and wait_event_type = 'Lock'`);
    if (rows[0].n > 0) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("the revocation neither committed nor waited on a lock");
}

type Revocation = (c: { seed: Seed; integrationId: string; apiKeyId: string }) => Promise<unknown>;

const REVOCATIONS: ReadonlyArray<readonly [string, Revocation]> = [
  ["pause", ({ seed, integrationId }) =>
    setIntegrationStatus(db(), { teamId: seed.teamId, memberId: seed.memberId }, integrationId, "disabled")],
  ["disconnect", ({ seed, integrationId }) =>
    disconnectGdriveIntegration(db(), { teamId: seed.teamId, memberId: seed.memberId }, integrationId)],
  ["rebind / key rotation", ({ seed, integrationId }) =>
    provisionGdriveConnectorPrincipal({ teamId: seed.teamId, integrationId, actorMemberId: seed.memberId })],
  ["key revocation", ({ seed, apiKeyId }) => revokeApiKey(db(), seed.teamId, apiKeyId)],
];

describe("AIO-1167 token broker: a revocation racing the issuance record (real Postgres)", () => {
  it.each(REVOCATIONS)("%s cannot commit between the last validation and the token's release", async (_name, revoke) => {
    const seed = await seedTeam();
    const integrationId = await integration(seed);
    const trusted = await provision(seed, integrationId);
    const owner = randomUUID();
    const acquired = await executionPOST(request("http://test/api/v1/integrations/gdrive/execution", trusted.key, seed.teamSlug, {
      action: "acquire", integration_id: integrationId, owner,
    }));
    expect(acquired.status).toBe(200);
    const lease = await acquired.json() as { generation: number; fence: number };
    const tokenRequest = () => tokenPOST(request("http://test/api/v1/integrations/gdrive/token", trusted.key, seed.teamSlug, {
      integration_id: integrationId, generation: lease.generation, fence: lease.fence, owner,
    }));
    const provider = vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response(
      JSON.stringify({ access_token: ISSUED_TOKEN, expires_in: 600 }),
      { status: 200, headers: { "content-type": "application/json" } },
    ));

    // The provider refresh has succeeded and the broker is now writing its issuance record.
    const entered = deferred();
    const released = deferred();
    record.hold = { entered: entered.resolve, released: released.promise };
    const issuing = tokenRequest();
    await entered.promise;

    let settled = false;
    let failure: unknown = null;
    const revoking = revoke({ seed, integrationId, apiKeyId: trusted.apiKeyId })
      .catch((error) => { failure = error; })
      .finally(() => { settled = true; });
    // Whatever is observed, the suspended record is let go: a held transaction must not outlive a failure.
    const queued = await waitsOnLockBefore(() => settled).finally(() => released.resolve());
    const committedDuringRecord = settled && failure === null;

    const response = await issuing;
    const body = JSON.stringify(await response.json());
    await revoking;
    expect(failure).toBeNull();

    // The invariant: no token is released after a revocation that committed during the record.
    expect(committedDuringRecord && body.includes(ISSUED_TOKEN)).toBe(false);
    // How it holds: the revocation queued behind the broker's row locks, so the token it did not
    // stop was released while the execution was still current …
    expect(queued).toBe(true);
    expect(response.status).toBe(200);
    expect(body).toContain(ISSUED_TOKEN);
    // … and the revocation, committed now, stops everything after it.
    record.hold = null;
    const after = await tokenRequest();
    expect([401, 403, 409]).toContain(after.status);
    expect(JSON.stringify(await after.json())).not.toContain(ISSUED_TOKEN);
    expect(provider).toHaveBeenCalledTimes(1);
  });
});
