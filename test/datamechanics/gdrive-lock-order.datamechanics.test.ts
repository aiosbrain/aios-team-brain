import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { ApiAuth } from "@/lib/api/auth";
import type { ItemPayload } from "@/lib/api/schemas";
import { createGroup, grantProjectToGroup } from "@/lib/access/groups";
import { getPool } from "@/lib/db/pg/pool";
import { ingestApiItem, type IngestConcurrencyHooks } from "@/lib/ingest";
import { driveCollisionSafePath, GdriveIngestStateChangedError } from "@/lib/ingest/gdrive-commit-locks";
import { reconcileGdriveItems, stageGdriveReconciliation } from "@/lib/ingest/source-reconcile";
import {
  acquireGdriveExecution,
  provisionGdriveConnectorPrincipal,
  withGdriveExecutionCommit,
  type GdriveExecutionRef,
} from "@/lib/integrations/gdrive-authority";
import { upsertIntegration } from "@/lib/integrations/manage";
import { db, ingest, seedTeam, sha, type Seed } from "./helpers";

/**
 * The Google Drive commit LOCK ORDER against real PostgreSQL (AIO-1167, blocker 4).
 *
 * Spec — the observable half of `test/gdrive-lock-order.test.ts`:
 *
 *   1. ORDER. A Drive ingest that cannot get its connection authority holds no provider, path or
 *      item lock while it waits; neither does a reconciliation queued behind a running ingest.
 *      Ingest and reconciliation of one connection, and of two connections contending for the same
 *      path, always both finish.
 *   2. PROJECT ROWS. Two commits whose storage project is each other's audience project do not
 *      deadlock: the second waits at the project rows, before any provider or path identity.
 *   3. BOUNDED. A wait on a held provider identity fails with 55P03 after the 10-second bound,
 *      writes nothing, and is not retried.
 *   4. DELETE WINS. A candidate removed between discovery and its row lock is never reused: the
 *      whole attempt is retried once from the top, and a second removal aborts by name.
 *   5. CREATE RACE. Two connections ingesting one new document produce one item, one mapping and
 *      two claims. A non-Drive push that passed its ownership pre-check before a Drive commit
 *      landed at its path is refused on the row it then locks.
 *
 * Lock state is read from `pg_stat_activity` / `pg_locks` on a pool connection of its own, so the
 * assertions are about what the backends hold — not about what the code under test reports.
 */

interface Connection {
  integrationId: string;
  auth: ApiAuth;
  execution: GdriveExecutionRef;
}

async function adminSeed(): Promise<Seed> {
  const seed = await seedTeam();
  await db().from("members").update({ role: "admin" }).eq("id", seed.memberId).eq("team_id", seed.teamId);
  return seed;
}

/** A granted initiative: a valid Drive audience destination, and a project an ingest can store in. */
async function audienceProject(seed: Seed): Promise<{ id: string; slug: string }> {
  const slug = `drive-${randomUUID().slice(0, 8)}`;
  const { data: project, error } = await db().from("projects")
    .insert({ team_id: seed.teamId, slug, name: "Drive audience", kind: "initiative" })
    .select("id").single();
  expect(error).toBeNull();
  const id = (project as { id: string }).id;
  const group = await createGroup(db(), seed.teamId, `aud-${randomUUID().slice(0, 8)}`, "Audience", seed.memberId);
  expect(group.ok, group.error).toBe(true);
  expect((await grantProjectToGroup(db(), seed.teamId, id, group.groupId!, seed.memberId)).ok).toBe(true);
  return { id, slug };
}

/** A connection with its bound connector principal and a live execution — what the worker holds. */
async function driveConnection(seed: Seed, audienceProjectIds: string[]): Promise<Connection> {
  const row = await upsertIntegration(db(), { teamId: seed.teamId, memberId: seed.memberId }, {
    type: "gdrive", name: `drive-${randomUUID().slice(0, 8)}`, status: "enabled",
    config: {
      fileIds: ["doc"], folderIds: [], sharedDriveIds: [], recursive: false,
      selectionState: "selected", authMode: "service_account", audienceProjectIds,
    },
  });
  const issued = await provisionGdriveConnectorPrincipal({
    teamId: seed.teamId, integrationId: row.id, actorMemberId: seed.memberId,
  });
  const { data: keyRow } = await db().from("api_keys").select("id").eq("key_id", issued.keyId).single();
  const auth: ApiAuth = {
    teamId: seed.teamId, memberId: issued.memberId, memberTier: "team", memberRole: "member",
    apiKeyId: (keyRow as { id: string }).id, actorHandle: "gdrive-sync",
    displayName: "Google Drive Sync", email: null, isConnector: true,
  };
  const acquired = await acquireGdriveExecution(auth, row.id, randomUUID());
  return {
    integrationId: row.id,
    auth,
    execution: { integrationId: row.id, generation: acquired.generation, fence: acquired.fence, owner: acquired.owner },
  };
}

function drivePayload(
  c: Connection,
  providerId: string,
  body: string,
  over: { project?: string; path?: string } = {},
): ItemPayload {
  return {
    project: over.project ?? "drive-locks", path: over.path ?? `gdrive/${providerId}.md`,
    kind: "deliverable", access: "team", actor: "gdrive-sync", body, content_sha256: sha(body),
    frontmatter: { source: "gdrive", source_id: providerId, connection_id: c.integrationId },
  } as ItemPayload;
}

const push = (c: Connection, payload: ItemPayload, hooks?: IngestConcurrencyHooks) =>
  ingestApiItem(db(), c.auth, payload, "team", undefined, "team", c.execution, hooks);

/** Reconciliation exactly as the route runs it: inside the connection's execution commit. */
const reconcile = (c: Connection, removedProviderIds: string[]) =>
  withGdriveExecutionCommit(c.auth, c.execution, () => stageGdriveReconciliation(
    db(), c.auth.teamId,
    { connectionId: c.integrationId, removedProviderIds, reason: "removed upstream" },
    { memberId: c.auth.memberId, apiKeyId: c.auth.apiKeyId },
  ));

async function lockWaiters(): Promise<number> {
  const { rows } = await getPool().query<{ n: number }>(
    `select count(*)::int as n from pg_stat_activity
      where datname = current_database() and wait_event_type = 'Lock'`);
  return rows[0].n;
}

async function untilLockWaiters(expected: number): Promise<void> {
  for (let tries = 0; tries < 320; tries++) {
    if (await lockWaiters() === expected) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`expected ${expected} backend(s) waiting on a lock, saw ${await lockWaiters()}`);
}

/** Backends holding at least one advisory lock — provider, path and item-attribution identities. */
async function advisoryHolders(): Promise<number> {
  const { rows } = await getPool().query<{ n: number }>(
    `select count(distinct l.pid)::int as n from pg_locks l
       join pg_database d on d.oid = l.database
      where d.datname = current_database() and l.locktype = 'advisory' and l.granted`);
  return rows[0].n;
}

function gate() {
  let release!: () => void;
  let reached!: () => void;
  const open = new Promise<void>((resolve) => { release = resolve; });
  const at = new Promise<void>((resolve) => { reached = resolve; });
  return { open, at, release, reached };
}

/** Pause an ingest once it holds every lock it will take (the item row is locked and reread). */
function pausedHoldingEverything() {
  const g = gate();
  const hooks: IngestConcurrencyHooks = { afterAttributionRead: async () => { g.reached(); await g.open; } };
  return { ...g, hooks };
}

async function driveItemCount(seed: Seed, providerId: string): Promise<number> {
  const { rows } = await getPool().query<{ n: number }>(
    `select count(*)::int as n from items
      where team_id=$1 and frontmatter->>'source'='gdrive' and frontmatter->>'source_id'=$2`,
    [seed.teamId, providerId]);
  return rows[0].n;
}

describe("AIO-1167 Drive commit lock order (real Postgres)", () => {
  it("ORDER: an ingest waiting for its connection authority holds no provider, path or item lock", async () => {
    const seed = await adminSeed();
    const c = await driveConnection(seed, [(await audienceProject(seed)).id]);
    const holder = await getPool().connect();
    try {
      await holder.query("begin");
      await holder.query(
        "select 1 from gdrive_connection_authority where integration_id=$1 for update", [c.integrationId]);
      const worker = push(c, drivePayload(c, "ordered", "ordered body"));
      await untilLockWaiters(1);
      expect(await advisoryHolders(), "an identity lock was taken before the connection authority").toBe(0);
      await holder.query("rollback");
      await expect(worker).resolves.toMatchObject({ status: "created" });
    } finally {
      await holder.query("rollback").catch(() => undefined);
      holder.release();
    }
  }, 30_000);

  it("ORDER: a reconciliation queued behind a running ingest waits at the connection authority; both finish", async () => {
    const seed = await adminSeed();
    const c = await driveConnection(seed, [(await audienceProject(seed)).id]);
    await expect(push(c, drivePayload(c, "doc-b", "b"))).resolves.toMatchObject({ status: "created" });

    const paused = pausedHoldingEverything();
    const worker = push(c, drivePayload(c, "doc-a", "a"), paused.hooks);
    await paused.at;
    expect(await advisoryHolders()).toBe(1);

    const queued = reconcile(c, ["doc-b"]);
    await untilLockWaiters(1);
    // Still only the ingest: the reconciliation has not reached its provider identities.
    expect(await advisoryHolders()).toBe(1);

    paused.release();
    await expect(worker).resolves.toMatchObject({ status: "created" });
    await expect(queued).resolves.toMatchObject({ candidates: 1 });
  }, 30_000);

  it("ORDER: concurrent ingest and reconciliation of one connection always both finish", async () => {
    const seed = await adminSeed();
    const c = await driveConnection(seed, [(await audienceProject(seed)).id]);
    await push(c, drivePayload(c, "doc-a", "a0"));
    for (let round = 1; round <= 4; round++) {
      await push(c, drivePayload(c, "doc-b", `b${round}`));
      const settled = await Promise.allSettled([
        push(c, drivePayload(c, "doc-a", `a${round}`)),
        reconcile(c, ["doc-b"]),
      ]);
      expect(settled.map((outcome) => outcome.status), JSON.stringify(settled)).toEqual(["fulfilled", "fulfilled"]);
    }
  }, 60_000);

  it("ORDER: two connections contending for one path — ingest of one, reconciliation of the other — both finish", async () => {
    const seed = await adminSeed();
    const a = await driveConnection(seed, [(await audienceProject(seed)).id]);
    const b = await driveConnection(seed, [(await audienceProject(seed)).id]);
    const shared = { project: "contended", path: "gdrive/same-name.md" };
    for (let round = 1; round <= 4; round++) {
      // A's document owns the requested path; B's collides with it and lives at its safe path.
      await push(a, drivePayload(a, "owner-doc", `owner ${round}`, shared));
      const settled = await Promise.allSettled([
        reconcile(a, ["owner-doc"]),
        push(b, drivePayload(b, "collider-doc", `collider ${round}`, shared)),
      ]);
      expect(settled.map((outcome) => outcome.status), JSON.stringify(settled)).toEqual(["fulfilled", "fulfilled"]);
    }
    expect(await driveItemCount(seed, "collider-doc")).toBe(1);
  }, 60_000);

  it("PROJECT ROWS: storage projects that are each other's audience do not deadlock; the second commit waits before any identity lock", async () => {
    const seed = await adminSeed();
    const pa = await audienceProject(seed);
    const pb = await audienceProject(seed);
    const a = await driveConnection(seed, [pa.id, pb.id]);
    const b = await driveConnection(seed, [pa.id, pb.id]);

    // A stores in pa (write) and names pb (share); B stores in pb (write) and names pa (share).
    const held = pausedHoldingEverything();
    const inA = push(a, drivePayload(a, "in-a", "a", { project: pa.slug }), held.hooks);
    await held.at;
    const inB = push(b, drivePayload(b, "in-b", "b", { project: pb.slug }));
    await untilLockWaiters(1);
    // B is waiting on a PROJECT row: it has taken no provider, path or item identity yet.
    expect(await advisoryHolders()).toBe(1);
    held.release();
    await expect(inA).resolves.toMatchObject({ status: "created" });
    await expect(inB).resolves.toMatchObject({ status: "created" });

    for (let round = 1; round <= 3; round++) {
      const settled = await Promise.allSettled([
        push(a, drivePayload(a, "in-a", `a${round}`, { project: pa.slug })),
        push(b, drivePayload(b, "in-b", `b${round}`, { project: pb.slug })),
      ]);
      expect(settled.map((outcome) => outcome.status), JSON.stringify(settled)).toEqual(["fulfilled", "fulfilled"]);
    }
  }, 60_000);

  it("BOUNDED: a held provider identity fails the ingest with 55P03 after the 10s bound, writing nothing", async () => {
    const seed = await adminSeed();
    const c = await driveConnection(seed, [(await audienceProject(seed)).id]);
    const holder = await getPool().connect();
    try {
      await holder.query("begin");
      await holder.query(
        "select pg_advisory_xact_lock(hashtextextended($1, 0))", [`${seed.teamId}:gdrive:timeout-doc`]);
      const started = Date.now();
      await expect(push(c, drivePayload(c, "timeout-doc", "never stored")))
        .rejects.toMatchObject({ code: "55P03" });
      const waited = Date.now() - started;
      expect(waited).toBeGreaterThanOrEqual(9_000);
      expect(waited).toBeLessThan(25_000); // one bounded wait, not two: a timeout is not retried
    } finally {
      await holder.query("rollback").catch(() => undefined);
      holder.release();
    }
    expect(await driveItemCount(seed, "timeout-doc")).toBe(0);
    const { rows } = await getPool().query(
      "select 1 from source_item_mappings where team_id=$1 and provider_id='timeout-doc'", [seed.teamId]);
    expect(rows).toEqual([]);
  }, 45_000);

  it("DELETE WINS: a candidate purged before its row lock is not reused — the whole attempt is retried once", async () => {
    const seed = await adminSeed();
    const c = await driveConnection(seed, [(await audienceProject(seed)).id]);
    const path = "gdrive/contested.md";
    // An unrelated row occupies the requested path, so the Drive ingest discovers it as a candidate.
    const local = await ingest(seed, {
      project: "drive-locks", path, body: "local content", access: "team", frontmatter: { source: "local" },
    });
    let hookCalls = 0;
    const result = await push(c, drivePayload(c, "contested", "drive content", { path }), {
      beforeAttributionLock: async (itemId) => {
        hookCalls++;
        // A purge on a connection of its own, committed between discovery and the row lock.
        if (itemId === local.id) await getPool().query("delete from items where id=$1", [itemId]);
      },
    });
    expect(result.status).toBe("created");
    // The retried attempt found the path free: no candidate, no second hook call, no safe path.
    expect(hookCalls).toBe(1);
    const { data: stored } = await db().from("items").select("path, body").eq("id", result.id).single();
    expect(stored).toMatchObject({ path, body: "drive content" });
    expect((await db().from("items").select("id").eq("id", local.id).maybeSingle()).data).toBeNull();
    expect(await driveItemCount(seed, "contested")).toBe(1);
  }, 30_000);

  it("DELETE WINS: a candidate that vanishes on both attempts aborts by name and leaves nothing behind", async () => {
    const seed = await adminSeed();
    const c = await driveConnection(seed, [(await audienceProject(seed)).id]);
    const path = "gdrive/twice.md";
    const provider = "contested-twice";
    await ingest(seed, { project: "drive-locks", path, body: "at the path", access: "team", frontmatter: { source: "local" } });
    await ingest(seed, {
      project: "drive-locks", path: driveCollisionSafePath(path, provider), body: "at the safe path",
      access: "team", frontmatter: { source: "local" },
    });
    // Attempt 1 discovers both rows and loses the first; attempt 2 discovers the survivor and loses it.
    let calls = 0;
    await expect(push(c, drivePayload(c, provider, "never stored", { path }), {
      beforeAttributionLock: async (itemId) => {
        calls++;
        if (calls % 2 === 1) await getPool().query("delete from items where id=$1", [itemId]);
      },
    })).rejects.toBeInstanceOf(GdriveIngestStateChangedError);
    expect(calls).toBe(3);
    expect(await driveItemCount(seed, provider)).toBe(0);
    const { rows } = await getPool().query(
      "select 1 from source_item_mappings where team_id=$1 and provider_id=$2", [seed.teamId, provider]);
    expect(rows).toEqual([]);
  }, 30_000);

  it("CREATE RACE: two connections ingesting one new document yield one item, one mapping, two claims", async () => {
    const seed = await adminSeed();
    const a = await driveConnection(seed, [(await audienceProject(seed)).id]);
    const b = await driveConnection(seed, [(await audienceProject(seed)).id]);
    const at = { project: "drive-race", path: "gdrive/shared.md" };
    const [fromA, fromB] = await Promise.all([
      push(a, drivePayload(a, "shared-doc", "one body", at)),
      push(b, drivePayload(b, "shared-doc", "one body", at)),
    ]);
    expect(fromA.id).toBe(fromB.id);
    expect([fromA.status, fromB.status].sort()).toEqual(["created", "unchanged"]);
    expect(await driveItemCount(seed, "shared-doc")).toBe(1);
    const { rows: mappings } = await getPool().query(
      "select item_id from source_item_mappings where team_id=$1 and provider_id='shared-doc'", [seed.teamId]);
    expect(mappings).toEqual([{ item_id: fromA.id }]);
    const { rows: claims } = await getPool().query<{ integration_id: string }>(
      "select integration_id from gdrive_item_claims where team_id=$1 and provider_id='shared-doc' and active",
      [seed.teamId]);
    expect(claims.map((row) => row.integration_id).sort()).toEqual([a.integrationId, b.integrationId].sort());
  }, 30_000);

  it("CREATE RACE: a non-Drive push that passed its pre-check before a Drive commit landed is refused on the locked row", async () => {
    const seed = await adminSeed();
    const c = await driveConnection(seed, [(await audienceProject(seed)).id]);
    const home = { project: "shared-docs", path: "gdrive/restored.md" };
    const original = await push(c, drivePayload(c, "restored", "v1", home));
    expect(original.status).toBe("created");
    // Remove it: the item is purged, its mapping stays as the tombstone a restore reuses.
    const removed = await reconcileGdriveItems(db(), seed.teamId, {
      connectionId: c.integrationId, removedProviderIds: ["restored"], reason: "removed upstream",
    });
    expect(removed.items).toBe(1);
    const { data: homeProject } = await db().from("projects").select("id")
      .eq("team_id", seed.teamId).eq("slug", home.project).single();

    const ordinary: ApiAuth = {
      teamId: seed.teamId, memberId: seed.memberId, memberTier: "team", memberRole: "admin",
      apiKeyId: randomUUID(), actorHandle: "api-test", displayName: "Tester", email: null, isConnector: false,
    };
    const overwrite = "an ordinary overwrite";
    const holder = await getPool().connect();
    try {
      // Hold the home project's row against writers (a restore only needs its key).
      await holder.query("begin");
      await holder.query("select 1 from projects where id=$1 for no key update", [(homeProject as { id: string }).id]);
      // The path is empty, so the public pre-check passes; the push then waits to write its project.
      const ordinaryPush = ingestApiItem(db(), ordinary, {
        ...home, kind: "deliverable", access: "team", actor: "member",
        body: overwrite, content_sha256: sha(overwrite), frontmatter: {},
      } as ItemPayload, "team", undefined, "team");
      const refused = ordinaryPush.catch((error) => error);
      await untilLockWaiters(1);

      // Meanwhile the document is restored — at its tombstoned home, requested from another project.
      const restored = await push(c, drivePayload(c, "restored", "v2", { project: "other-docs", path: "gdrive/renamed.md" }));
      expect(restored).toMatchObject({ status: "created", id: original.id });

      await holder.query("rollback");
      expect(await refused).toMatchObject({ code: "connector_principal_required", status: 403 });
    } finally {
      await holder.query("rollback").catch(() => undefined);
      holder.release();
    }
    const { data: stored } = await db().from("items").select("path, body").eq("id", original.id).single();
    expect(stored).toMatchObject({ path: home.path, body: "v2" });
  }, 45_000);
});
