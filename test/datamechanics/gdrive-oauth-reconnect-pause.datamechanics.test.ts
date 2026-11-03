import { randomUUID } from "node:crypto";
import { NextRequest } from "next/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import { POST as executionPOST } from "@/app/api/v1/integrations/gdrive/execution/route";
import { POST as tokenPOST } from "@/app/api/v1/integrations/gdrive/token/route";
import { getPool } from "@/lib/db/pg/pool";
import { provisionGdriveConnectorPrincipal } from "@/lib/integrations/gdrive-authority";
import { publishGoogleDriveOAuthCredential } from "@/lib/integrations/gdrive-oauth";
import { setIntegrationSecret, setIntegrationStatus, upsertIntegration } from "@/lib/integrations/manage";
import { decryptSecret } from "@/lib/secrets/crypto";
import { approvedAudienceProject, db, seedTeam, type Seed } from "./helpers";

/**
 * AIO-1167 R43 F2 — reconnecting repairs a credential; it is not Resume.
 *
 * Spec (AC-07: pause stops reads; Resume is its own action).
 *   · Publication matrix: a connection the publication CREATES starts enabled; an existing enabled
 *     connection stays enabled; an existing PAUSED (disabled, with a credential) or DISCONNECTED
 *     (disabled, without one) connection stays disabled.
 *   · After a paused connection is reconnected, no execution can be acquired — so no token can be
 *     brokered — until an explicit Resume; then the NEW credential is what the broker refreshes.
 *     An execution acquired before the pause is never revived by the reconnect.
 *   · The status is the one held under the connection lock at publication: a pause that commits
 *     while the publication waits survives it; a pause or Resume queued behind a publication wins
 *     when it commits.
 *   · Selection, audience and (for the same account) the credential namespace are unchanged.
 */

const DRIVE_FILE = "https://www.googleapis.com/auth/drive.file";
const STORED = {
  client_id: "oauth-client", client_secret: "client-secret", refresh_token: "old-refresh",
  token_uri: "https://oauth2.googleapis.com/token", scopes: [DRIVE_FILE], grant_mode: "files",
  account_subject: "subject:acct-1",
};

afterEach(() => vi.restoreAllMocks());

async function admin(seed: Seed) {
  await db().from("members").update({ role: "admin" }).eq("id", seed.memberId).eq("team_id", seed.teamId);
}

async function connection(seed: Seed, name: string, opts: { status: "enabled" | "disabled"; secret: boolean }) {
  await admin(seed);
  const audience = await approvedAudienceProject(seed);
  const auth = { teamId: seed.teamId, memberId: seed.memberId };
  const row = await upsertIntegration(db(), auth, {
    type: "gdrive", name, status: "enabled",
    config: {
      fileIds: ["Kept"], folderIds: [], sharedDriveIds: [], recursive: false, selectionState: "selected",
      access: "team", authMode: "oauth", authenticatedAccountId: "subject:acct-1", scopeSet: [DRIVE_FILE],
      audienceProjectIds: [audience],
    },
  });
  if (opts.secret) await setIntegrationSecret(db(), auth, row.id, JSON.stringify(STORED));
  if (opts.status === "disabled") await setIntegrationStatus(db(), auth, row.id, "disabled");
  return { id: row.id, audience };
}

function reconnect(seed: Seed, name: string, hooks: Parameters<typeof publishGoogleDriveOAuthCredential>[1] = {}) {
  return publishGoogleDriveOAuthCredential({
    teamId: seed.teamId, memberId: seed.memberId, integrationName: name,
    clientId: "oauth-client", clientSecret: "client-secret", subject: "acct-1",
    email: null, emailVerified: false, refreshToken: "new-refresh", grantMode: "files", scopes: [DRIVE_FILE],
  }, hooks);
}

async function row(seed: Seed, name: string) {
  const { rows } = await getPool().query<{ status: string; config: Record<string, unknown>; secret_ciphertext: string | null }>(
    `select status, config, secret_ciphertext from integrations where team_id=$1 and type='gdrive' and name=$2`,
    [seed.teamId, name],
  );
  const r = rows[0];
  return r ? { ...r, secret: r.secret_ciphertext ? JSON.parse(decryptSecret(r.secret_ciphertext)) as Record<string, unknown> : null } : null;
}

function post(url: string, key: string, team: string, body: unknown) {
  return new Request(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "X-AIOS-Team": team, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }) as NextRequest;
}

async function connector(seed: Seed, integrationId: string) {
  const issued = await provisionGdriveConnectorPrincipal({ teamId: seed.teamId, integrationId, actorMemberId: seed.memberId });
  return issued.key;
}

async function acquire(key: string, seed: Seed, integrationId: string) {
  const owner = randomUUID();
  const response = await executionPOST(post("http://test/api/v1/integrations/gdrive/execution", key, seed.teamSlug, {
    action: "acquire", integration_id: integrationId, owner,
  }));
  return { response, body: await response.json(), owner };
}

/** Wait until exactly one backend is parked on a lock. */
async function oneWaiterOnALock(): Promise<void> {
  let waiting = -1;
  for (let tries = 0; tries < 320; tries++) {
    const { rows } = await getPool().query<{ n: number }>(
      `select count(*)::int as n from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock'`);
    waiting = rows[0].n;
    if (waiting === 1) break;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  expect(waiting, "expected exactly one backend parked on a lock").toBe(1);
}

function gate() {
  let release!: () => void;
  let reached!: () => void;
  const open = new Promise<void>((resolve) => { release = resolve; });
  const at = new Promise<void>((resolve) => { reached = resolve; });
  return { open, at, release, reached };
}

describe("publication status matrix (R43 F2, real Postgres)", () => {
  it("a connection the publication creates starts enabled", async () => {
    const seed = await seedTeam();
    await admin(seed);
    await expect(reconnect(seed, "brand-new")).resolves.toEqual({ status: "enabled" });
    expect((await row(seed, "brand-new"))?.status).toBe("enabled");
  });

  it.each([
    ["enabled", { status: "enabled", secret: true }, "enabled"],
    ["paused (disabled with a credential)", { status: "disabled", secret: true }, "disabled"],
    ["disconnected (disabled without a credential)", { status: "disabled", secret: false }, "disabled"],
  ] as const)("an existing %s connection keeps its status, selection and audience", async (_case, opts, expected) => {
    const seed = await seedTeam();
    const conn = await connection(seed, "matrix", opts);
    const before = await row(seed, "matrix");

    await expect(reconnect(seed, "matrix")).resolves.toEqual({ status: expected });

    const after = await row(seed, "matrix");
    expect(after?.status).toBe(expected);
    expect(after?.config).toMatchObject({ fileIds: ["Kept"], audienceProjectIds: [conn.audience] });
    expect(after?.config.authenticatedAccountId).toBe(before?.config.authenticatedAccountId);
    expect(after?.secret).toMatchObject({ refresh_token: "new-refresh", account_subject: "subject:acct-1", grant_mode: "files" });
  });
});

describe("a reconnected paused connection reads nothing until Resume (R43 F2)", () => {
  it("no execution, no token; Resume then brokers the NEW credential; a pre-pause execution stays dead", async () => {
    const seed = await seedTeam();
    const conn = await connection(seed, "paused-reconnect", { status: "enabled", secret: true });
    const key = await connector(seed, conn.id);
    const early = await acquire(key, seed, conn.id);
    expect(early.response.status).toBe(200);
    await setIntegrationStatus(db(), { teamId: seed.teamId, memberId: seed.memberId }, conn.id, "disabled");
    const provider = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({
      access_token: "broker-access", expires_in: 600, scope: DRIVE_FILE,
    }), { status: 200, headers: { "content-type": "application/json" } }));

    await expect(reconnect(seed, "paused-reconnect")).resolves.toEqual({ status: "disabled" });

    const refused = await acquire(key, seed, conn.id);
    expect(refused.response.status).toBe(409);
    expect(refused.body.error.code).toBe("connection_unavailable");
    // The execution acquired before the pause is not revived by the credential change.
    const stale = await tokenPOST(post("http://test/api/v1/integrations/gdrive/token", key, seed.teamSlug, {
      integration_id: conn.id, generation: early.body.generation, fence: early.body.fence, owner: early.owner,
    }));
    expect(stale.status).toBe(409);
    expect(provider).not.toHaveBeenCalled();

    await setIntegrationStatus(db(), { teamId: seed.teamId, memberId: seed.memberId }, conn.id, "enabled");
    const resumed = await acquire(key, seed, conn.id);
    expect(resumed.response.status).toBe(200);
    const token = await tokenPOST(post("http://test/api/v1/integrations/gdrive/token", key, seed.teamSlug, {
      integration_id: conn.id, generation: resumed.body.generation, fence: resumed.body.fence, owner: resumed.owner,
    }));
    expect(token.status).toBe(200);
    expect(provider).toHaveBeenCalledTimes(1);
    const refreshBody = String((provider.mock.calls[0]![1] as RequestInit).body);
    expect(refreshBody).toContain("refresh_token=new-refresh");
  });
});

describe("pause × reconnect, both orders, under the connection lock (R43 F2)", () => {
  it("a pause that commits while the publication waits for the row survives the publication", async () => {
    const seed = await seedTeam();
    const conn = await connection(seed, "pause-first", { status: "enabled", secret: true });
    const holder = await getPool().connect();
    let publishing: Promise<unknown> | undefined;
    try {
      await holder.query("begin");
      await holder.query("update integrations set status='disabled' where id=$1 and team_id=$2", [conn.id, seed.teamId]);
      publishing = reconnect(seed, "pause-first");
      await oneWaiterOnALock();
      await holder.query("commit");
    } finally {
      await holder.query("rollback").catch(() => undefined);
      holder.release();
    }
    await expect(publishing).resolves.toEqual({ status: "disabled" });
    expect((await row(seed, "pause-first"))?.status).toBe("disabled");
  }, 30_000);

  it("a pause queued behind a publication of an enabled connection wins when it commits", async () => {
    const seed = await seedTeam();
    const conn = await connection(seed, "publish-first", { status: "enabled", secret: true });
    const held = gate();
    const publishing = reconnect(seed, "publish-first", { afterLocks: async () => { held.reached(); await held.open; } });
    let pausing: Promise<void> | undefined;
    try {
      await held.at;
      pausing = setIntegrationStatus(db(), { teamId: seed.teamId, memberId: seed.memberId }, conn.id, "disabled");
      await oneWaiterOnALock();
    } finally {
      held.release();
    }
    await expect(publishing).resolves.toEqual({ status: "enabled" });
    await pausing;
    expect((await row(seed, "publish-first"))?.status).toBe("disabled");
  }, 30_000);

  it("an explicit Resume queued behind a publication of a paused connection wins when it commits", async () => {
    const seed = await seedTeam();
    const conn = await connection(seed, "resume-after", { status: "disabled", secret: true });
    const held = gate();
    const publishing = reconnect(seed, "resume-after", { afterLocks: async () => { held.reached(); await held.open; } });
    let resuming: Promise<void> | undefined;
    try {
      await held.at;
      resuming = setIntegrationStatus(db(), { teamId: seed.teamId, memberId: seed.memberId }, conn.id, "enabled");
      await oneWaiterOnALock();
    } finally {
      held.release();
    }
    await expect(publishing).resolves.toEqual({ status: "disabled" });
    await resuming;
    expect((await row(seed, "resume-after"))?.status).toBe("enabled");
  }, 30_000);
});
