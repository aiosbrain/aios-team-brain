import { randomUUID } from "node:crypto";
import { NextRequest } from "next/server";
import { describe, expect, it } from "vitest";

import { POST as executionPOST } from "@/app/api/v1/integrations/gdrive/execution/route";
import { POST as itemsPOST } from "@/app/api/v1/items/route";
import { POST as reconcilePOST } from "@/app/api/v1/items/source-reconcile/route";
import { getPool } from "@/lib/db/pg/pool";
import {
  GDRIVE_SNAPSHOT_PAGE_LIMIT,
  GdriveSnapshotError,
  stageGdriveReconciliation,
} from "@/lib/ingest/source-reconcile";
import { provisionGdriveConnectorPrincipal } from "@/lib/integrations/gdrive-authority";
import { setIntegrationSecret, upsertIntegration } from "@/lib/integrations/manage";
import { approvedAudienceProject, db, seedTeam, sha, type Seed } from "./helpers";

/**
 * Source reconciliation of a selection larger than one request (AIO-1167, real Postgres).
 *
 * Spec. A connection may select more than 10,000 documents. Its complete snapshot must still
 * reconcile: no request carries more than the per-request bound, the membership is held on the
 * brain page by page, and it is applied by ONE finalizing transaction. The rules a single-request
 * snapshot obeys are unchanged:
 *   · ABSENCE — a claim is retired only when its document is absent from the COMPLETE set; a page,
 *     or any number of pages short of the whole, retires nothing by omission.
 *   · COMPLETION — the set is complete only if every page arrived: a finalization whose staged
 *     membership does not add up to its declared total establishes no absence.
 * Everything here goes through the real route, as the connector's execution.
 */
const SELECTED = 2 * GDRIVE_SNAPSHOT_PAGE_LIMIT + 5_001; // 25,001 documents: three pages

interface Connector {
  seed: Seed;
  integrationId: string;
  key: string;
  execution: { generation: number; fence: number; owner: string };
}

function request(url: string, c: Pick<Connector, "seed" | "key">, body: unknown, extra: Record<string, string> = {}) {
  return new Request(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${c.key}`, "X-AIOS-Team": c.seed.teamSlug,
      "Content-Type": "application/json", ...extra,
    },
    body: JSON.stringify(body),
  }) as NextRequest;
}

/** A Drive connection, its bound connector key, and a live execution — what the worker holds. */
async function connector(): Promise<Connector> {
  const seed = await seedTeam();
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
  await setIntegrationSecret(db(), { teamId: seed.teamId, memberId: seed.memberId }, row.id, JSON.stringify({
    client_id: "oauth-client", client_secret: "client-secret", refresh_token: "refresh",
    scopes: ["https://www.googleapis.com/auth/drive.file"], account_subject: "subject:acct-1",
  }));
  await db().from("members").update({ role: "admin" }).eq("id", seed.memberId).eq("team_id", seed.teamId);
  const issued = await provisionGdriveConnectorPrincipal({
    teamId: seed.teamId, integrationId: row.id, actorMemberId: seed.memberId,
  });
  const owner = randomUUID();
  const acquired = await executionPOST(request("http://test/api/v1/integrations/gdrive/execution", { seed, key: issued.key }, {
    action: "acquire", integration_id: row.id, owner,
  }));
  expect(acquired.status).toBe(200);
  const lease = await acquired.json() as { generation: number; fence: number };
  return { seed, integrationId: row.id, key: issued.key, execution: { generation: lease.generation, fence: lease.fence, owner } };
}

/** Ingest one Drive document under the execution, which records the connection's claim on it. */
async function claimDocument(c: Connector, providerId: string): Promise<void> {
  const body = `document ${providerId}`;
  const created = await itemsPOST(request("http://test/api/v1/items", c, {
    project: "docs", path: `gdrive/${providerId}.md`, kind: "deliverable", access: "team",
    actor: "gdrive-sync", body, content_sha256: sha(body),
    frontmatter: { source: "gdrive", source_id: providerId, connection_id: c.integrationId },
  }, {
    "X-AIOS-Integration-Id": c.integrationId,
    "X-AIOS-Execution-Generation": String(c.execution.generation),
    "X-AIOS-Execution-Fence": String(c.execution.fence),
    "X-AIOS-Execution-Owner": c.execution.owner,
  }));
  expect(created.status).toBe(201);
}

async function reconcile(c: Connector, snapshot: Record<string, unknown>) {
  const response = await reconcilePOST(request("http://test/api/v1/items/source-reconcile", c, {
    source: "gdrive", integration_id: c.integrationId, ...c.execution,
    removed_provider_ids: [], snapshot, reason: "complete gdrive scope",
  }));
  return { status: response.status, body: await response.json() as Record<string, unknown> & { error?: { code: string } } };
}

async function activeClaims(c: Connector): Promise<string[]> {
  const { rows } = await getPool().query<{ provider_id: string }>(
    `select provider_id from gdrive_item_claims
      where team_id=$1 and integration_id=$2 and active order by provider_id`,
    [c.seed.teamId, c.integrationId]);
  return rows.map((row) => row.provider_id);
}

async function stagedMembers(c: Connector): Promise<number> {
  const { rows } = await getPool().query<{ n: number }>(
    `select count(*)::int as n from gdrive_snapshot_members where team_id=$1 and integration_id=$2`,
    [c.seed.teamId, c.integrationId]);
  return rows[0].n;
}

/**
 * The selection: 25,001 ids in three pages. `kept-first` is on the first page and `kept-last` on
 * the last, so each is missing from every other page; `gone` is on none.
 */
function selection(): string[][] {
  const filler = Array.from({ length: SELECTED - 2 }, (_, n) => `filler-${String(n).padStart(5, "0")}`);
  const ids = ["kept-first", ...filler, "kept-last"];
  expect(ids).toHaveLength(SELECTED);
  return [
    ids.slice(0, GDRIVE_SNAPSHOT_PAGE_LIMIT),
    ids.slice(GDRIVE_SNAPSHOT_PAGE_LIMIT, 2 * GDRIVE_SNAPSHOT_PAGE_LIMIT),
    ids.slice(2 * GDRIVE_SNAPSHOT_PAGE_LIMIT),
  ];
}

describe("AIO-1167 source reconciliation above 10,000 selected documents (real Postgres)", () => {
  it("stages the membership in bounded pages and retires exactly the absent claim on finalization", async () => {
    const c = await connector();
    for (const providerId of ["kept-first", "kept-last", "gone"]) await claimDocument(c, providerId);
    expect(await activeClaims(c)).toEqual(["gone", "kept-first", "kept-last"]);
    const [first, second, last] = selection();
    const snapshotId = randomUUID();

    // One request is still bounded: the whole selection cannot be sent at once.
    const whole = await reconcile(c, { complete: true, provider_ids: [...first, ...second, ...last] });
    expect(whole.status).toBe(422);
    expect(await activeClaims(c)).toEqual(["gone", "kept-first", "kept-last"]);

    // Pages are held and establish nothing: `kept-last` and `gone` are on neither of these.
    const staged1 = await reconcile(c, { complete: false, provider_ids: first, snapshot_id: snapshotId });
    expect(staged1).toMatchObject({ status: 200, body: { snapshotApplied: false, candidates: 0, snapshotStaged: GDRIVE_SNAPSHOT_PAGE_LIMIT } });
    const staged2 = await reconcile(c, { complete: false, provider_ids: second, snapshot_id: snapshotId });
    expect(staged2).toMatchObject({ status: 200, body: { snapshotApplied: false, candidates: 0, snapshotStaged: 2 * GDRIVE_SNAPSHOT_PAGE_LIMIT } });
    // A replayed page is the same members again.
    const replayed = await reconcile(c, { complete: false, provider_ids: second, snapshot_id: snapshotId });
    expect(replayed.body.snapshotStaged).toBe(2 * GDRIVE_SNAPSHOT_PAGE_LIMIT);
    expect(await activeClaims(c)).toEqual(["gone", "kept-first", "kept-last"]);

    // Finalization applies the WHOLE set: only the document on no page is absent.
    const finalized = await reconcile(c, { complete: true, provider_ids: last, snapshot_id: snapshotId, total: SELECTED });
    expect(finalized).toMatchObject({ status: 200, body: { snapshotApplied: true, candidates: 1, cleanupQueued: 1 } });
    expect(await activeClaims(c)).toEqual(["kept-first", "kept-last"]);
    // The staged membership left with the transaction that applied it.
    expect(await stagedMembers(c)).toBe(0);

    // A finalization replayed after its pages were consumed is not a complete set.
    const again = await reconcile(c, { complete: true, provider_ids: last, snapshot_id: snapshotId, total: SELECTED });
    expect(again.status).toBe(409);
    expect(again.body.error?.code).toBe("snapshot_incomplete");
    expect(await activeClaims(c)).toEqual(["kept-first", "kept-last"]);
  }, 120_000);

  it("a finalization that does not add up to its total establishes no absence, and a new snapshot replaces it", async () => {
    const c = await connector();
    for (const providerId of ["kept-first", "kept-last", "gone"]) await claimDocument(c, providerId);
    const [first, second, last] = selection();
    const lostPage = randomUUID();

    // The second page never arrives.
    expect((await reconcile(c, { complete: false, provider_ids: first, snapshot_id: lostPage })).status).toBe(200);
    const short = await reconcile(c, { complete: true, provider_ids: last, snapshot_id: lostPage, total: SELECTED });
    expect(short.status).toBe(409);
    expect(short.body.error?.code).toBe("snapshot_incomplete");
    // Nothing was retired — not `gone`, and not the documents on the page that was lost — and the
    // refused page was not kept.
    expect(await activeClaims(c)).toEqual(["gone", "kept-first", "kept-last"]);
    expect(await stagedMembers(c)).toBe(first.length);

    // A page of a staged snapshot must say which snapshot's total it is closing, and only then.
    expect((await reconcile(c, { complete: true, provider_ids: last, snapshot_id: lostPage })).status).toBe(422);
    expect((await reconcile(c, { complete: false, provider_ids: last, snapshot_id: lostPage, total: SELECTED })).status).toBe(422);

    // The next attempt names a new snapshot; the abandoned pages do not count towards it.
    const retry = randomUUID();
    const restarted = await reconcile(c, { complete: false, provider_ids: second, snapshot_id: retry });
    expect(restarted.body.snapshotStaged).toBe(second.length);
    expect(await stagedMembers(c)).toBe(second.length);
    expect((await reconcile(c, { complete: false, provider_ids: first, snapshot_id: retry })).status).toBe(200);
    const finalized = await reconcile(c, { complete: true, provider_ids: last, snapshot_id: retry, total: SELECTED });
    expect(finalized).toMatchObject({ status: 200, body: { snapshotApplied: true, candidates: 1 } });
    expect(await activeClaims(c)).toEqual(["kept-first", "kept-last"]);
    expect(await stagedMembers(c)).toBe(0);
  }, 120_000);

  it("pages staged by an execution that no longer holds the connection are never finalized", async () => {
    const c = await connector();
    for (const providerId of ["kept-first", "gone"]) await claimDocument(c, providerId);
    const snapshotId = randomUUID();
    const stage = (fence: number, providerIds: string[], complete: boolean, total?: number) =>
      stageGdriveReconciliation(db(), c.seed.teamId, {
        connectionId: c.integrationId, reason: "complete gdrive scope",
        snapshot: {
          complete, providerIds,
          staged: { snapshotId, generation: c.execution.generation, fence, total },
        },
      });

    expect(await stage(c.execution.fence, ["kept-first"], false)).toMatchObject({ snapshotStaged: 1 });
    // The connection changes hands. The successor's page replaces the old page, even under the same
    // snapshot name — so two members were sent, but only one is held, and that is not the total.
    await expect(stage(c.execution.fence + 1, ["other"], true, 2)).rejects.toBeInstanceOf(GdriveSnapshotError);
    expect(await activeClaims(c)).toEqual(["gone", "kept-first"]);
    expect(await stage(c.execution.fence + 1, ["other"], false)).toMatchObject({ snapshotStaged: 1 });
    expect(await stagedMembers(c)).toBe(1);
  });
});
