import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { describe, expect, it } from "vitest";
import type { ApiAuth } from "@/lib/api/auth";
import type { ItemPayload } from "@/lib/api/schemas";
import { createGroup, grantProjectToGroup } from "@/lib/access/groups";
import { correctionPlanSchema } from "@/lib/attribution/correction";
import { PgClient } from "@/lib/db/pg/client";
import { getPool } from "@/lib/db/pg/pool";
import { ingestApiItem, ingestItem, type IngestConcurrencyHooks } from "@/lib/ingest";
import { applyAttributionCorrection } from "@/lib/ingest/attribution-correction";
import { driveCollisionSafePath, GdriveIngestStateChangedError } from "@/lib/ingest/gdrive-commit-locks";
import { ProjectPlanChangedError } from "@/lib/projects/project-row-locks";
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
 *   6. PROJECT BEFORE ITEM, for every ingest (the shared order; second `describe`). For each pair
 *      of writers that can meet on one item — public ingest and a Drive commit colliding on its
 *      path; a direct internal ingest and a Drive commit on a canonical Drive item; public and
 *      direct internal ingest of one item — and in BOTH scheduling orders: whichever arrives second
 *      waits at the PROJECT row holding no path, attribution or item lock, and both finish.
 *   7. COMPLETE PLAN. A Drive commit takes the project its canonical item lives in before any
 *      identity lock, not when it later writes there; a mapping that changes between the plan and
 *      the provider lock replans the whole attempt; a held project row times out, bounded, with
 *      nothing below it taken. Reconciliation takes every provider, then every item-attribution
 *      advisory, before any item row.
 *   8. PROJECT WORK IS THE PUBLICATION'S. An ingest plans its projects with unlocked reads, creates
 *      an absent source project inside its own transaction (a concurrent creator of the slug is
 *      waited for and then read), and locks the whole set once. So: crossed project sets finish in
 *      both orders; a create race yields one project; a project deleted between the plan and its
 *      lock abandons the ingest by name; and a refused, failed or unconfirmed ingest leaves no
 *      project it created, no advanced sync timestamp and no graph pointer.
 *   9. OWNERSHIP IS DECIDED UNDER THE ITEM LOCK. A public push is refused when the row it has
 *      locked has a Drive provider mapping — whatever that mapping's (nullable) connection id, and
 *      whatever the row's stored provenance says, including a mapping that appeared after the
 *      push's unlocked pre-check.
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
    // ROLLBACK: the storage project did not exist, so this commit created it — in its own
    // transaction, before the provider wait. The timed-out commit took it back.
    const { rows: storage } = await getPool().query(
      "select 1 from projects where team_id=$1 and slug='drive-locks'", [seed.teamId]);
    expect(storage, "a failed Drive commit left the project it created behind").toEqual([]);
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

describe("AIO-1167 shared ingest order: project before item (real Postgres)", () => {
  const ordinaryAuth = (seed: Seed): ApiAuth => ({
    teamId: seed.teamId, memberId: seed.memberId, memberTier: "team", memberRole: "admin",
    apiKeyId: randomUUID(), actorHandle: "api-test", displayName: "Tester", email: null, isConnector: false,
  });
  const plainPayload = (at: { project: string; path: string }, body: string): ItemPayload => ({
    ...at, kind: "deliverable", access: "team", actor: "member",
    body, content_sha256: sha(body), frontmatter: { source: "notion" },
  } as ItemPayload);
  /** The public owner, as `POST /api/v1/items` calls it for an ordinary key. */
  const publicPush = (auth: ApiAuth, payload: ItemPayload, hooks?: IngestConcurrencyHooks) =>
    ingestApiItem(db(), auth, payload, "team", undefined, "team", undefined, hooks);
  /** A direct internal caller of the sole writer (connectors, scanner, meetings). */
  const directPush = (seed: Seed, payload: ItemPayload, access: "team" | "external", hooks?: IngestConcurrencyHooks) =>
    ingestItem(
      db(), { teamId: seed.teamId, memberId: seed.memberId, apiKeyId: randomUUID() }, payload, access,
      undefined, "team", undefined, hooks ? { concurrencyHooks: hooks } : {},
    );

  /**
   * Run `first` until it holds every lock it will take, then start `second`.
   *
   * `second` must end up WAITING, and waiting at the project row: path, provider and attribution
   * identities are all advisory locks, and an item row is only ever taken after its attribution
   * advisory, so "still exactly one backend holding an advisory lock" means the waiter holds
   * nothing path- or item-shaped. Then both must finish.
   */
  async function secondWaitsAtTheProject<A, B>(
    first: (hooks: IngestConcurrencyHooks) => Promise<A>,
    second: () => Promise<B>,
  ): Promise<[A, B]> {
    const held = pausedHoldingEverything();
    const a = first(held.hooks);
    let b: Promise<B> | undefined;
    // Both outcomes are reported by the `Promise.all` below; neither may surface as an unhandled
    // rejection while this schedule is still being set up or torn down.
    a.catch(() => undefined);
    try {
      const firstWriter = await Promise.race([
        held.at.then(() => "paused" as const),
        a.then(() => "finished" as const, () => "finished" as const),
      ]);
      expect(firstWriter, "the first writer finished without reaching its item lock").toBe("paused");
      expect(await advisoryHolders(), "the first writer should hold its identity locks").toBe(1);
      b = second();
      b.catch(() => undefined);
      await untilLockWaiters(1);
      expect(await advisoryHolders(), "the second writer took an identity or item lock before its project row").toBe(1);
    } finally {
      // Always: a paused writer left behind would hold its locks into every later test.
      held.release();
      await Promise.allSettled([a, ...(b ? [b] : [])]);
    }
    return Promise.all([a, b!]);
  }

  it("PUBLIC existing-item ingest × DRIVE requested-path collision: both orders wait at the project and finish", async () => {
    const seed = await adminSeed();
    const c = await driveConnection(seed, [(await audienceProject(seed)).id]);
    const ordinary = ordinaryAuth(seed);
    const at = { project: "contended", path: "gdrive/same-name.md" };
    const existing = await publicPush(ordinary, plainPayload(at, "public v1"));
    expect(existing.status).toBe("created");

    // Order 1 — the public ingest holds project → path → attribution → item; the Drive commit,
    // which must lock that same item as its path collision, arrives second.
    const [public1, drive1] = await secondWaitsAtTheProject(
      (hooks) => publicPush(ordinary, plainPayload(at, "public v2"), hooks),
      () => push(c, drivePayload(c, "collider-1", "drive 1", at)),
    );
    expect(public1).toMatchObject({ status: "updated", id: existing.id });
    expect(drive1.status).toBe("created");

    // Order 2 — the Drive commit holds the project AND the colliding item; the public ingest
    // arrives second. It used to take that item before its project: the confirmed inversion.
    const [drive2, public2] = await secondWaitsAtTheProject(
      (hooks) => push(c, drivePayload(c, "collider-2", "drive 2", at), hooks),
      () => publicPush(ordinary, plainPayload(at, "public v3")),
    );
    expect(drive2.status).toBe("created");
    expect(public2).toMatchObject({ status: "updated", id: existing.id });

    const { data: stored } = await db().from("items").select("path, body").eq("id", existing.id).single();
    expect(stored).toMatchObject({ path: at.path, body: "public v3" });
    for (const [id, provider] of [[drive1.id, "collider-1"], [drive2.id, "collider-2"]]) {
      expect(id).not.toBe(existing.id);
      const { data: drive } = await db().from("items").select("path").eq("id", id).single();
      expect((drive as { path: string }).path).toBe(driveCollisionSafePath(at.path, provider));
    }
  }, 60_000);

  it("DIRECT internal ingest × DRIVE canonical-item update: both orders wait at the project and finish", async () => {
    const seed = await adminSeed();
    const c = await driveConnection(seed, [(await audienceProject(seed)).id]);
    const created = await push(c, drivePayload(c, "canon", "drive v1"));
    expect(created.status).toBe("created");
    // The same document through the sole writer directly: no connection, no claim, same item.
    const direct = (body: string, hooks?: IngestConcurrencyHooks) =>
      directPush(seed, drivePayload(c, "canon", body), "external", hooks);

    const [direct1, drive1] = await secondWaitsAtTheProject(
      (hooks) => direct("direct v2", hooks),
      () => push(c, drivePayload(c, "canon", "drive v3")),
    );
    expect(direct1).toMatchObject({ status: "updated", id: created.id });
    expect(drive1).toMatchObject({ status: "updated", id: created.id });

    const [drive2, direct2] = await secondWaitsAtTheProject(
      (hooks) => push(c, drivePayload(c, "canon", "drive v4"), hooks),
      () => direct("direct v5"),
    );
    expect(drive2).toMatchObject({ status: "updated", id: created.id });
    expect(direct2).toMatchObject({ status: "updated", id: created.id });

    expect(await driveItemCount(seed, "canon")).toBe(1);
    const { data: stored } = await db().from("items").select("body").eq("id", created.id).single();
    expect(stored).toMatchObject({ body: "direct v5" });
    // The connection's claim on the document is untouched by the direct writes.
    const { rows: claims } = await getPool().query(
      "select 1 from gdrive_item_claims where team_id=$1 and provider_id='canon' and item_id=$2 and active",
      [seed.teamId, created.id]);
    expect(claims).toHaveLength(1);
  }, 60_000);

  it("PUBLIC × DIRECT internal ingest of one item: both orders wait at the project and finish", async () => {
    const seed = await adminSeed();
    const ordinary = ordinaryAuth(seed);
    const at = { project: "plain", path: "notes/shared.md" };
    const existing = await publicPush(ordinary, plainPayload(at, "v1"));
    expect(existing.status).toBe("created");

    const [public1, direct1] = await secondWaitsAtTheProject(
      (hooks) => publicPush(ordinary, plainPayload(at, "public v2"), hooks),
      () => directPush(seed, plainPayload(at, "direct v3"), "team"),
    );
    expect(public1).toMatchObject({ status: "updated", id: existing.id });
    expect(direct1).toMatchObject({ status: "updated", id: existing.id });

    const [direct2, public2] = await secondWaitsAtTheProject(
      (hooks) => directPush(seed, plainPayload(at, "direct v4"), "team", hooks),
      () => publicPush(ordinary, plainPayload(at, "public v5")),
    );
    expect(direct2).toMatchObject({ status: "updated", id: existing.id });
    expect(public2).toMatchObject({ status: "updated", id: existing.id });

    const { data: stored } = await db().from("items").select("body").eq("id", existing.id).single();
    expect(stored).toMatchObject({ body: "public v5" });
    const { data: versions } = await db().from("item_versions").select("id").eq("item_id", existing.id);
    expect(versions).toHaveLength(5);
  }, 60_000);

  it("COMPLETE PLAN: the canonical item's project is taken with the project set, before any identity lock", async () => {
    const seed = await adminSeed();
    const c = await driveConnection(seed, [(await audienceProject(seed)).id]);
    const home = await push(c, drivePayload(c, "moved", "v1", { project: "drive-home" }));
    const { data: homeProject } = await db().from("projects").select("id")
      .eq("team_id", seed.teamId).eq("slug", "drive-home").single();
    const homeProjectId = (homeProject as { id: string }).id;
    expect(home).toMatchObject({ status: "created", projectId: homeProjectId });

    const holder = await getPool().connect();
    try {
      await holder.query("begin");
      // FOR UPDATE is the one row lock a key reference conflicts with.
      await holder.query("select 1 from projects where id=$1 for update", [homeProjectId]);
      // Requested from ANOTHER project: that one is written, the canonical one only referenced. A
      // commit that discovered the canonical project late would be past its identity locks by now
      // (and, for an update that does not move the item, would never have waited at all).
      const worker = push(c, drivePayload(c, "moved", "v2", { project: "drive-elsewhere", path: "gdrive/renamed.md" }));
      await untilLockWaiters(1);
      expect(await advisoryHolders(), "an identity lock was taken before the complete project set").toBe(0);
      await holder.query("rollback");
      await expect(worker).resolves.toMatchObject({ status: "updated", id: home.id, projectId: homeProjectId });
    } finally {
      await holder.query("rollback").catch(() => undefined);
      holder.release();
    }
  }, 30_000);

  it("COMPLETE PLAN: documents requested from each other's canonical project always both finish", async () => {
    const seed = await adminSeed();
    const a = await driveConnection(seed, [(await audienceProject(seed)).id]);
    const b = await driveConnection(seed, [(await audienceProject(seed)).id]);
    const docA = await push(a, drivePayload(a, "cross-a-doc", "a0", { project: "cross-a" }));
    const docB = await push(b, drivePayload(b, "cross-b-doc", "b0", { project: "cross-b" }));
    for (let round = 1; round <= 4; round++) {
      // Each writes the project the other's document lives in, and references its own by key.
      const settled = await Promise.allSettled([
        push(a, drivePayload(a, "cross-a-doc", `a${round}`, { project: "cross-b", path: "gdrive/a-from-b.md" })),
        push(b, drivePayload(b, "cross-b-doc", `b${round}`, { project: "cross-a", path: "gdrive/b-from-a.md" })),
      ]);
      expect(settled.map((outcome) => outcome.status), JSON.stringify(settled)).toEqual(["fulfilled", "fulfilled"]);
      expect(settled.map((outcome) => (outcome as PromiseFulfilledResult<{ id: string; status: string }>).value))
        .toEqual([expect.objectContaining({ id: docA.id, status: "updated" }), expect.objectContaining({ id: docB.id, status: "updated" })]);
    }
  }, 60_000);

  it("REPLAN: a mapping that changes between the plan and the provider lock abandons the attempt and plans again", async () => {
    const seed = await adminSeed();
    const c = await driveConnection(seed, [(await audienceProject(seed)).id]);
    const first = await push(c, drivePayload(c, "replanned", "v1"));
    const attempts: number[] = [];
    const holder = await getPool().connect();
    try {
      await holder.query("begin");
      await holder.query(
        "select pg_advisory_xact_lock(hashtextextended($1, 0))", [`${seed.teamId}:gdrive:replanned`]);
      const worker = push(c, drivePayload(c, "replanned", "v2"), {
        beforeDriveAttempt: async (attempt) => { attempts.push(attempt); },
      });
      // Planned, project set held, waiting at the provider identity.
      await untilLockWaiters(1);
      await holder.query(
        `update source_item_mappings set canonical_path='gdrive/replanned-elsewhere.md'
          where team_id=$1 and source='gdrive' and provider_id='replanned'`, [seed.teamId]);
      await holder.query("commit");
      await expect(worker).resolves.toMatchObject({ status: "updated", id: first.id });
    } finally {
      await holder.query("rollback").catch(() => undefined);
      holder.release();
    }
    // The stale plan was not patched up under the lock: the whole attempt ran again.
    expect(attempts).toEqual([1, 2]);
    const { data: stored } = await db().from("items").select("path, body").eq("id", first.id).single();
    expect(stored).toMatchObject({ path: "gdrive/replanned.md", body: "v2" });
    const { rows: mapping } = await getPool().query<{ canonical_path: string }>(
      "select canonical_path from source_item_mappings where team_id=$1 and provider_id='replanned'", [seed.teamId]);
    expect(mapping).toEqual([{ canonical_path: "gdrive/replanned.md" }]);
  }, 30_000);

  it("BOUNDED: a held project row times out after the 10s bound with nothing below it taken, and is not retried", async () => {
    const seed = await adminSeed();
    const c = await driveConnection(seed, [(await audienceProject(seed)).id]);
    const first = await push(c, drivePayload(c, "blocked", "v1"));
    const { data: storage } = await db().from("projects").select("id")
      .eq("team_id", seed.teamId).eq("slug", "drive-locks").single();
    const attempts: number[] = [];
    const holder = await getPool().connect();
    try {
      await holder.query("begin");
      await holder.query("select 1 from projects where id=$1 for update", [(storage as { id: string }).id]);
      const started = Date.now();
      const outcome = push(c, drivePayload(c, "blocked", "v2"), {
        beforeDriveAttempt: async (attempt) => { attempts.push(attempt); },
      }).catch((error) => error);
      await untilLockWaiters(1);
      expect(await advisoryHolders()).toBe(0);
      expect(await outcome).toMatchObject({ code: "55P03" });
      const waited = Date.now() - started;
      expect(waited).toBeGreaterThanOrEqual(9_000);
      expect(waited).toBeLessThan(25_000);
    } finally {
      await holder.query("rollback").catch(() => undefined);
      holder.release();
    }
    expect(attempts).toEqual([1]);
    const { data: stored } = await db().from("items").select("body").eq("id", first.id).single();
    expect(stored).toMatchObject({ body: "v1" });
  }, 45_000);

  it("CROSSED PROJECT SETS: an ordinary ingest into a Drive audience project × a Drive commit — both orders wait at the project and finish", async () => {
    const seed = await adminSeed();
    const audience = await audienceProject(seed);
    const c = await driveConnection(seed, [audience.id]);
    const ordinary = ordinaryAuth(seed);
    const at = { project: audience.slug, path: "notes/in-the-audience.md" };

    // Order 1 — the ordinary ingest holds the audience project for WRITE; the commit, which stores
    // elsewhere and only needs that row shared, still cannot get past it.
    const [ordinary1, drive1] = await secondWaitsAtTheProject(
      (hooks) => publicPush(ordinary, plainPayload(at, "ordinary v1"), hooks),
      () => push(c, drivePayload(c, "crossed-doc", "drive v1")),
    );
    expect(ordinary1.status).toBe("created");
    expect(drive1.status).toBe("created");

    // Order 2 — the commit holds its storage project for write and the audience project shared.
    const [drive2, ordinary2] = await secondWaitsAtTheProject(
      (hooks) => push(c, drivePayload(c, "crossed-doc", "drive v2"), hooks),
      () => publicPush(ordinary, plainPayload(at, "ordinary v2")),
    );
    expect(drive2).toMatchObject({ status: "updated", id: drive1.id });
    expect(ordinary2).toMatchObject({ status: "updated", id: ordinary1.id });
  }, 60_000);

  it("NO UPGRADE: commits whose storage project is also their shared audience project never deadlock", async () => {
    const seed = await adminSeed();
    const both = await audienceProject(seed);
    const a = await driveConnection(seed, [both.id]);
    const b = await driveConnection(seed, [both.id]);
    // One row, two roles, for both writers. Taken shared and strengthened afterwards, two commits
    // would each hold the share and wait for the other's write: it is taken once, for write.
    const [inA, inB] = await secondWaitsAtTheProject(
      (hooks) => push(a, drivePayload(a, "upgrade-a", "a", { project: both.slug }), hooks),
      () => push(b, drivePayload(b, "upgrade-b", "b", { project: both.slug })),
    );
    expect(inA.status).toBe("created");
    expect(inB.status).toBe("created");
    for (let round = 1; round <= 4; round++) {
      const settled = await Promise.allSettled([
        push(a, drivePayload(a, "upgrade-a", `a${round}`, { project: both.slug })),
        push(b, drivePayload(b, "upgrade-b", `b${round}`, { project: both.slug })),
      ]);
      expect(settled.map((outcome) => outcome.status), JSON.stringify(settled)).toEqual(["fulfilled", "fulfilled"]);
    }
  }, 60_000);

  it("CREATE RACE: two ordinary ingests naming one NEW project create it once; the second waits for the first", async () => {
    const seed = await adminSeed();
    const ordinary = ordinaryAuth(seed);
    const slug = `raced-${randomUUID().slice(0, 8)}`;
    const [one, two] = await secondWaitsAtTheProject(
      (hooks) => publicPush(ordinary, plainPayload({ project: slug, path: "notes/one.md" }, "one"), hooks),
      () => publicPush(ordinary, plainPayload({ project: slug, path: "notes/two.md" }, "two")),
    );
    expect(one.status).toBe("created");
    expect(two.status).toBe("created");
    const { rows: projects } = await getPool().query<{ id: string }>(
      "select id from projects where team_id=$1 and slug=$2", [seed.teamId, slug]);
    expect(projects).toHaveLength(1);
    expect([one.projectId, two.projectId]).toEqual([projects[0].id, projects[0].id]);
  }, 30_000);

  it("CREATE RACE: an ordinary ingest and a Drive commit naming one NEW project create it once, in both orders", async () => {
    const seed = await adminSeed();
    const c = await driveConnection(seed, [(await audienceProject(seed)).id]);
    const ordinary = ordinaryAuth(seed);
    const projectCount = async (slug: string) => (await getPool().query(
      "select 1 from projects where team_id=$1 and slug=$2", [seed.teamId, slug])).rows.length;

    const first = `raced-${randomUUID().slice(0, 8)}`;
    const [ordinary1, drive1] = await secondWaitsAtTheProject(
      (hooks) => publicPush(ordinary, plainPayload({ project: first, path: "notes/plain.md" }, "plain"), hooks),
      () => push(c, drivePayload(c, "raced-1", "drive", { project: first })),
    );
    expect(ordinary1.status).toBe("created");
    expect(drive1).toMatchObject({ status: "created", projectId: ordinary1.projectId });
    expect(await projectCount(first)).toBe(1);

    const second = `raced-${randomUUID().slice(0, 8)}`;
    const [drive2, ordinary2] = await secondWaitsAtTheProject(
      (hooks) => push(c, drivePayload(c, "raced-2", "drive", { project: second }), hooks),
      () => publicPush(ordinary, plainPayload({ project: second, path: "notes/plain.md" }, "plain")),
    );
    expect(drive2.status).toBe("created");
    expect(ordinary2).toMatchObject({ status: "created", projectId: drive2.projectId });
    expect(await projectCount(second)).toBe(1);
  }, 60_000);

  it("ABSENT PROJECT: a source project deleted between the plan and its row lock abandons the ingest — it is not re-created late", async () => {
    const seed = await adminSeed();
    const slug = `vanishing-${randomUUID().slice(0, 8)}`;
    const { data: planted, error } = await db().from("projects")
      .insert({ team_id: seed.teamId, slug, name: "Vanishing" }).select("id").single();
    expect(error).toBeNull();
    const beforeLock = gate();
    let paused = false;
    // Stopped after the unlocked plan (the project exists) and before the row lock that must
    // confirm it.
    const client = new PgClient({
      decorateSessionExecutor: (execute) => async <T>(text: string, params: unknown[] = []) => {
        if (!paused && /from projects\b[\s\S]*\bfor no key update\b/i.test(text)) {
          paused = true;
          beforeLock.reached();
          await beforeLock.open;
        }
        return execute<T>(text, params);
      },
    });
    const outcome = ingestItem(
      client, { teamId: seed.teamId, memberId: seed.memberId, apiKeyId: randomUUID() },
      plainPayload({ project: slug, path: "notes/never.md" }, "never stored"), "team",
    ).then(() => null, (caught: unknown) => caught);
    try {
      await beforeLock.at;
      await getPool().query("delete from projects where id=$1", [(planted as { id: string }).id]);
    } finally {
      beforeLock.release();
    }
    const abandoned = await outcome;
    expect(abandoned).toBeInstanceOf(ProjectPlanChangedError);
    expect(abandoned).toMatchObject({ code: "ingest-project-plan-changed" });
    const { rows: projects } = await getPool().query(
      "select 1 from projects where team_id=$1 and slug=$2", [seed.teamId, slug]);
    expect(projects, "the deleted project was re-created by the abandoned ingest").toEqual([]);
    const { rows: items } = await getPool().query(
      "select 1 from items where team_id=$1 and path='notes/never.md'", [seed.teamId]);
    expect(items).toEqual([]);
  }, 30_000);

  it("NULLABLE MAPPING OWNERSHIP: a Drive item with stripped or altered provenance is still refused — by its mapping, whose connection id is null", async () => {
    const seed = await adminSeed();
    const c = await driveConnection(seed, [(await audienceProject(seed)).id]);
    const ordinary = ordinaryAuth(seed);
    const home = { project: "owned-docs", path: "gdrive/owned.md" };
    const owned = await push(c, drivePayload(c, "owned", "drive v1", home));
    expect(owned.status).toBe("created");
    const { rows: mapping } = await getPool().query<{ item_id: string; connection_id: string | null }>(
      "select item_id, connection_id from source_item_mappings where team_id=$1 and provider_id='owned'", [seed.teamId]);
    // The premise: ownership cannot be read off a connection id, because there is none.
    expect(mapping).toEqual([{ item_id: owned.id, connection_id: null }]);

    for (const provenance of [{}, { source: "notion" }, { source: "gdrive-legacy", source_id: "owned" }]) {
      await getPool().query("update items set frontmatter=$2::jsonb where id=$1", [owned.id, JSON.stringify(provenance)]);
      await expect(publicPush(ordinary, plainPayload(home, "an ordinary overwrite")))
        .rejects.toMatchObject({ code: "connector_principal_required", status: 403 });
      // …and a caller holding SOME Drive execution is told it is the wrong one, not let through.
      await expect(ingestApiItem(db(), ordinary, plainPayload(home, "an ordinary overwrite"), "team", undefined, "team", c.execution))
        .rejects.toMatchObject({ code: "wrong_connection", status: 403 });
    }
    const { data: stored } = await db().from("items").select("body").eq("id", owned.id).single();
    expect(stored).toMatchObject({ body: "drive v1" });
    const { data: versions } = await db().from("item_versions").select("id").eq("item_id", owned.id);
    expect(versions).toHaveLength(1);
  }, 30_000);

  it("NULLABLE MAPPING OWNERSHIP: a mapping that appears AFTER the unlocked pre-check refuses the push on the row it locked, and rolls its project write back", async () => {
    const seed = await adminSeed();
    const ordinary = ordinaryAuth(seed);
    const at = { project: "adopted-docs", path: "notes/adopted.md" };
    const existing = await publicPush(ordinary, plainPayload(at, "v1"));
    expect(existing.status).toBe("created");
    const projectState = async () => (await getPool().query<{ last_synced_at: string }>(
      "select last_synced_at from projects where id=$1", [existing.projectId])).rows[0].last_synced_at;
    const syncedBefore = await projectState();

    let planted = 0;
    const refused = await publicPush(ordinary, plainPayload(at, "v2"), {
      // The pre-check has passed (ordinary provenance, no mapping) and the push holds its project
      // and path. A provider mapping for THIS item is committed on a connection of its own: no
      // connection id, and the row's own provenance untouched. Only the locked check can see it.
      beforeAttributionLock: async (itemId) => {
        planted++;
        await getPool().query(
          `insert into source_item_mappings (team_id, source, provider_id, item_id, connection_id, project_id, canonical_path)
           values ($1, 'gdrive', 'adopted-doc', $2, null, $3, $4)`,
          [seed.teamId, itemId, existing.projectId, at.path]);
      },
    }).then(() => null, (caught: unknown) => caught);
    expect(planted).toBe(1);
    expect(refused).toMatchObject({ code: "connector_principal_required", status: 403 });

    const { data: stored } = await db().from("items").select("body, frontmatter").eq("id", existing.id).single();
    expect(stored).toMatchObject({ body: "v1", frontmatter: { source: "notion" } });
    const { data: versions } = await db().from("item_versions").select("id").eq("item_id", existing.id);
    expect(versions).toHaveLength(1);
    // The refusal came after the project's sync timestamp was advanced, in the same transaction.
    expect(await projectState(), "a refused ingest advanced its project's sync timestamp").toBe(syncedBefore);
  }, 30_000);

  it("ATTRIBUTION CORRECTION × DRIVE commit: each waits at the item-attribution advisory in either order, and the correction survives", async () => {
    const seed = await adminSeed();
    const c = await driveConnection(seed, [(await audienceProject(seed)).id]);
    const created = await push(c, drivePayload(c, "credited", "v1"));
    const creditNobody = () => applyAttributionCorrection(
      db(), seed.teamId,
      correctionPlanSchema.parse({ kind: "reassign", match: { itemId: created.id }, toMember: "nobody" }),
      { memberId: seed.memberId }, 1,
    );
    const attribution = async () => (await getPool().query<{ member_id: string | null; member_id_locked: boolean | null }>(
      "select member_id, member_id_locked from items where id=$1", [created.id])).rows[0];
    const unlock = () => getPool().query("update items set member_id=$2, member_id_locked=false where id=$1", [created.id, seed.memberId]);

    // Order 1 — the commit holds the advisory and the row; the correction waits at the advisory.
    const committing = pausedHoldingEverything();
    const commit1 = push(c, drivePayload(c, "credited", "v2"), committing.hooks);
    commit1.catch(() => undefined);
    let correction1: ReturnType<typeof creditNobody> | undefined;
    try {
      await committing.at;
      correction1 = creditNobody();
      correction1.catch(() => undefined);
      await untilLockWaiters(1);
      expect((await attribution()).member_id_locked, "the correction landed under the commit's item lock").not.toBe(true);
    } finally {
      committing.release();
      await Promise.allSettled([commit1, ...(correction1 ? [correction1] : [])]);
    }
    await expect(commit1).resolves.toMatchObject({ status: "updated", id: created.id });
    await expect(correction1).resolves.toMatchObject({ ok: true, updated: 1 });
    expect(await attribution()).toEqual({ member_id: null, member_id_locked: true });

    // Order 2 — the correction holds the advisory (and not yet the row); the commit, already past
    // its project, provider and path locks, waits there without having locked the item row.
    await unlock();
    const correcting = gate();
    const probe = await getPool().connect();
    const correction2 = applyAttributionCorrection(
      db(), seed.teamId,
      correctionPlanSchema.parse({ kind: "reassign", match: { itemId: created.id }, toMember: "nobody" }),
      { memberId: seed.memberId }, 1,
      { afterItemLock: async () => { correcting.reached(); await correcting.open; } },
    );
    correction2.catch(() => undefined);
    let commit2: ReturnType<typeof push> | undefined;
    try {
      await correcting.at;
      commit2 = push(c, drivePayload(c, "credited", "v3"));
      commit2.catch(() => undefined);
      await untilLockWaiters(1);
      await probe.query("begin");
      const { rows } = await probe.query("select id from items where id=$1 for update nowait", [created.id]);
      expect(rows, "the commit locked the item row before its attribution advisory").toHaveLength(1);
      await probe.query("rollback");
    } finally {
      await probe.query("rollback").catch(() => undefined);
      probe.release();
      correcting.release();
      await Promise.allSettled([correction2, ...(commit2 ? [commit2] : [])]);
    }
    await expect(correction2).resolves.toMatchObject({ ok: true, updated: 1 });
    await expect(commit2).resolves.toMatchObject({ status: "updated", id: created.id });
    // The commit read the corrected, locked attribution under its row lock and kept it.
    expect(await attribution()).toEqual({ member_id: null, member_id_locked: true });
    const { data: stored } = await db().from("items").select("body").eq("id", created.id).single();
    expect(stored).toMatchObject({ body: "v3" });
  }, 60_000);

  it("BOUNDED: an ordinary ingest behind a held project row times out after the 10s bound, once, having taken and written nothing", async () => {
    const seed = await adminSeed();
    const ordinary = ordinaryAuth(seed);
    const at = { project: "bounded-plain", path: "notes/bounded.md" };
    const existing = await publicPush(ordinary, plainPayload(at, "v1"));
    let sessions = 0;
    const counted = new PgClient({ decorateSessionExecutor: (execute) => { sessions++; return execute; } });
    const holder = await getPool().connect();
    try {
      await holder.query("begin");
      await holder.query("select 1 from projects where id=$1 for update", [existing.projectId]);
      const started = Date.now();
      const outcome = ingestApiItem(counted, ordinary, plainPayload(at, "v2"), "team", undefined, "team")
        .then(() => null, (caught: unknown) => caught);
      await untilLockWaiters(1);
      expect(await advisoryHolders(), "a path or item identity was taken before the project row").toBe(0);
      expect(await outcome).toMatchObject({ code: "55P03" });
      const waited = Date.now() - started;
      expect(waited).toBeGreaterThanOrEqual(9_000);
      expect(waited).toBeLessThan(25_000); // one bounded wait: a lock timeout is not retried
    } finally {
      await holder.query("rollback").catch(() => undefined);
      holder.release();
    }
    expect(sessions, "a lock timeout spent the context engine's retry").toBe(1);
    const { data: stored } = await db().from("items").select("body").eq("id", existing.id).single();
    expect(stored).toMatchObject({ body: "v1" });
  }, 45_000);

  it("ROLLBACK: an ingest that fails after its project setup leaves no created project behind", async () => {
    const seed = await adminSeed();
    const ordinary = ordinaryAuth(seed);
    const slug = `rolled-back-${randomUUID().slice(0, 8)}`;
    let reached = 0;
    await expect(publicPush(ordinary, plainPayload({ project: slug, path: "notes/rolled.md" }, "never stored"), {
      // Past the project creation, its timestamp, its graph pointer and the path identity.
      beforeAttributionLock: async () => { reached++; throw new Error("injected failure after project setup"); },
    })).rejects.toThrow("injected failure after project setup");
    expect(reached).toBe(1);
    const { rows: projects } = await getPool().query(
      "select 1 from projects where team_id=$1 and slug=$2", [seed.teamId, slug]);
    expect(projects, "a failed ingest left the project it created behind").toEqual([]);
    const { rows: items } = await getPool().query(
      "select 1 from items where team_id=$1 and path='notes/rolled.md'", [seed.teamId]);
    expect(items).toEqual([]);
  }, 30_000);

  it("ROLLBACK: a tier refusal on an existing project takes back its advanced sync timestamp and graph pointer", async () => {
    const seed = await adminSeed();
    const ordinary = ordinaryAuth(seed);
    const at = { project: "rollback-existing", path: "notes/team-only.md" };
    const created = await publicPush(ordinary, plainPayload(at, "team v1"));
    expect(created.status).toBe("created");
    // A project that synced long ago and has no pointer: both writes the next ingest makes are then
    // real row changes, so their absence afterwards is a rollback and not a no-op.
    await getPool().query(
      "update projects set last_synced_at='2020-01-02T03:04:05Z', graph_group_id=null where id=$1", [created.projectId]);
    const projectState = async () => (await getPool().query<{ synced: string; graph_group_id: string | null }>(
      "select to_char(last_synced_at at time zone 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS') as synced, graph_group_id from projects where id=$1",
      [created.projectId])).rows[0];
    expect(await projectState()).toEqual({ synced: "2020-01-02T03:04:05", graph_group_id: null });

    // An untrusted pusher changing a team item's body: refused under the item lock, after the
    // project row was locked, timestamped and pointed.
    await expect(ingestApiItem(db(), ordinary, plainPayload(at, "an external edit"), "external", undefined, "external"))
      .rejects.toThrow(/external-tier key may not modify/);
    expect(await projectState()).toEqual({ synced: "2020-01-02T03:04:05", graph_group_id: null });
    const { data: stored } = await db().from("items").select("body, access").eq("id", created.id).single();
    expect(stored).toMatchObject({ body: "team v1", access: "team" });

    // Positive control: the same project IS timestamped and pointed by an ingest that commits.
    await expect(publicPush(ordinary, plainPayload(at, "team v2"))).resolves.toMatchObject({ status: "updated" });
    const after = await projectState();
    expect(after.synced).not.toBe("2020-01-02T03:04:05");
    expect(after.graph_group_id).not.toBeNull();
  }, 30_000);

  /**
   * Make COMMIT itself fail for one item path: a deferred constraint trigger raises 40001 — a
   * SQLSTATE the context engine would retry if it were a statement failure — only when the
   * transaction commits. Scoped to one team and path, and always dropped.
   */
  async function withFailingCommit<T>(teamId: string, path: string, fn: () => Promise<T>): Promise<T> {
    if (!/^[0-9a-f-]{36}$/i.test(teamId) || /'/.test(path)) throw new Error("unsafe commit-failure fixture value");
    const suffix = randomUUID().replaceAll("-", "");
    const trigger = `aio1167_commit_trg_${suffix}`;
    const fnName = `aio1167_commit_fn_${suffix}`;
    const control = new Client({ connectionString: process.env.DATABASE_URL });
    await control.connect();
    try {
      await control.query("set lock_timeout = '5s'");
      await control.query(`
        create function ${fnName}() returns trigger language plpgsql as $body$
        begin
          if new.team_id = '${teamId}'::uuid and new.path = '${path}' then
            raise exception 'AIO-1167 injected failure at COMMIT' using errcode = '40001';
          end if;
          return null;
        end
        $body$`);
      await control.query(`
        create constraint trigger ${trigger} after insert on items
        deferrable initially deferred for each row execute function ${fnName}()`);
      return await fn();
    } finally {
      try {
        await control.query(`drop trigger if exists ${trigger} on items`);
        await control.query(`drop function if exists ${fnName}()`);
      } finally {
        await control.end();
      }
    }
  }

  it("UNKNOWN COMMIT: an ordinary ingest whose COMMIT fails is reported as unknown, never replayed, and leaves nothing", async () => {
    const seed = await adminSeed();
    const ordinary = ordinaryAuth(seed);
    const slug = `unknown-${randomUUID().slice(0, 8)}`;
    const path = `notes/unknown-${randomUUID().slice(0, 8)}.md`;
    let sessions = 0;
    const counted = new PgClient({ decorateSessionExecutor: (execute) => { sessions++; return execute; } });
    const outcome = await withFailingCommit(seed.teamId, path, () =>
      ingestApiItem(counted, ordinary, plainPayload({ project: slug, path }, "never durable"), "team", undefined, "team")
        .then(() => null, (caught: unknown) => caught));
    expect(outcome).toMatchObject({ unknownCommit: true, code: "40001" });
    expect((outcome as Error).message).toMatch(/COMMIT failed; outcome unknown and will not be replayed/);
    // 40001 is retryable as a statement failure. At COMMIT it is not: one session, one attempt.
    expect(sessions).toBe(1);
    const { rows: items } = await getPool().query("select 1 from items where team_id=$1 and path=$2", [seed.teamId, path]);
    expect(items).toEqual([]);
    const { rows: projects } = await getPool().query("select 1 from projects where team_id=$1 and slug=$2", [seed.teamId, slug]);
    expect(projects).toEqual([]);
  }, 30_000);

  it("UNKNOWN COMMIT: a Drive commit whose COMMIT fails is not one of its retryable state changes — one attempt, nothing left", async () => {
    const seed = await adminSeed();
    const c = await driveConnection(seed, [(await audienceProject(seed)).id]);
    const slug = `unknown-${randomUUID().slice(0, 8)}`;
    const path = `gdrive/unknown-${randomUUID().slice(0, 8)}.md`;
    const attempts: number[] = [];
    const outcome = await withFailingCommit(seed.teamId, path, () =>
      push(c, drivePayload(c, "unknown-doc", "never durable", { project: slug, path }), {
        beforeDriveAttempt: async (attempt) => { attempts.push(attempt); },
      }).then(() => null, (caught: unknown) => caught));
    expect(outcome).toMatchObject({ unknownCommit: true, code: "40001" });
    expect(attempts).toEqual([1]);
    expect(await driveItemCount(seed, "unknown-doc")).toBe(0);
    const { rows: mappings } = await getPool().query(
      "select 1 from source_item_mappings where team_id=$1 and provider_id='unknown-doc'", [seed.teamId]);
    expect(mappings).toEqual([]);
    const { rows: claims } = await getPool().query(
      "select 1 from gdrive_item_claims where team_id=$1 and provider_id='unknown-doc'", [seed.teamId]);
    expect(claims).toEqual([]);
    const { rows: projects } = await getPool().query("select 1 from projects where team_id=$1 and slug=$2", [seed.teamId, slug]);
    expect(projects).toEqual([]);
  }, 30_000);

  it("RECONCILIATION: every item-attribution advisory is taken before any item row", async () => {
    const seed = await adminSeed();
    const c = await driveConnection(seed, [(await audienceProject(seed)).id]);
    const one = await push(c, drivePayload(c, "adv-one", "1"));
    const two = await push(c, drivePayload(c, "adv-two", "2"));
    const holder = await getPool().connect();
    const probe = await getPool().connect();
    let worker: ReturnType<typeof reconcile> | undefined;
    try {
      // What a correction or an ingest of that document holds first.
      await holder.query("begin");
      await holder.query(
        "select pg_advisory_xact_lock(hashtextextended($1, 0))", [`${seed.teamId}:item:${one.id}`]);
      worker = reconcile(c, ["adv-one", "adv-two"]);
      worker.catch(() => undefined);
      // Both providers and both mapping rows are held; it waits for the advisory …
      await untilLockWaiters(1);
      // … with NEITHER item row locked — not the contended one, and not the other one either.
      await probe.query("begin");
      const { rows } = await probe.query(
        "select id from items where id = any($1::uuid[]) for update nowait", [[one.id, two.id]]);
      expect(rows, "reconciliation locked an item row before its attribution advisories").toHaveLength(2);
      await probe.query("rollback");
      await holder.query("rollback");
      await expect(worker).resolves.toMatchObject({ candidates: 2 });
    } finally {
      await probe.query("rollback").catch(() => undefined);
      probe.release();
      await holder.query("rollback").catch(() => undefined);
      holder.release();
      if (worker) await worker.catch(() => undefined);
    }
  }, 30_000);

  it("RECONCILIATION: every provider identity is taken before any item row", async () => {
    const seed = await adminSeed();
    const c = await driveConnection(seed, [(await audienceProject(seed)).id]);
    const early = await push(c, drivePayload(c, "aa-doc", "a"));
    const late = await push(c, drivePayload(c, "zz-doc", "z"));
    const holder = await getPool().connect();
    const probe = await getPool().connect();
    try {
      await holder.query("begin");
      await holder.query(
        "select pg_advisory_xact_lock(hashtextextended($1, 0))", [`${seed.teamId}:gdrive:zz-doc`]);
      const worker = reconcile(c, ["aa-doc", "zz-doc"]);
      // It holds the first provider and waits for the second …
      await untilLockWaiters(1);
      // … and has not locked the first provider's item meanwhile (NOWAIT would refuse with 55P03).
      await probe.query("begin");
      const { rows } = await probe.query(
        "select id from items where id = any($1::uuid[]) for update nowait", [[early.id, late.id]]);
      expect(rows).toHaveLength(2);
      await probe.query("rollback");
      await holder.query("rollback");
      await expect(worker).resolves.toMatchObject({ candidates: 2 });
    } finally {
      await probe.query("rollback").catch(() => undefined);
      probe.release();
      await holder.query("rollback").catch(() => undefined);
      holder.release();
    }
  }, 30_000);
});
