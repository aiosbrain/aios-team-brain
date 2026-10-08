import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import pg from "pg";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ApiAuth } from "@/lib/api/auth";
import type { ItemPayload } from "@/lib/api/schemas";
import { canSeeItem, visibleItemIds } from "@/lib/access/enforce";
import { addMemberToGroup, createGroup, grantProjectToGroup } from "@/lib/access/groups";
import { ingestApiItem } from "@/lib/ingest";
import { stageGdriveReconciliation } from "@/lib/ingest/source-reconcile";
import { acquireGdriveExecution, provisionGdriveConnectorPrincipal } from "@/lib/integrations/gdrive-authority";
import { upsertIntegration } from "@/lib/integrations/manage";
import { loadSchema } from "../../scripts/pg-load-schema.mjs";
import { REPLAY_STEP_SUPERSESSIONS } from "../../scripts/migration-replay-plan.mjs";
import {
  acquireDataUseLock, hasExclusiveDataUseLock, installStagingOps, releaseDataUseLock, transitionJournal,
} from "../../scripts/staging-ops/journal.mjs";
import { capturePairedPostgres, restorePairedPostgres } from "../../scripts/staging-ops/pg-paired.mjs";
import { EXCLUDED_PAIRED_TABLE_DATA } from "../../scripts/staging-ops/pg-sanitize.mjs";
import { db, seedTeam, sha, type Seed } from "./helpers";

/**
 * PAIRED STAGING RESTORE of Google Drive content (AIO-1167), against real PostgreSQL with the real
 * `pg_dump` / `pg_restore` / `psql` and the real capture, restore and schema-replay code.
 *
 * Spec. The paired export does not copy a connection's credentials or operational state — the five
 * Drive tables hang off `integrations` and `api_keys`, whose rows never leave production — but it
 * DOES copy the documents and the authorization substrate the application reads through: items,
 * context units and `gdrive_claim` memberships. After the restore the importer replays the whole
 * schema over that database. Therefore, on the restored copy:
 *
 *   1. none of the five Drive connection tables, and no integration or API key, holds a row — and
 *      the restore's own foreign-key constraints were created, which they cannot be otherwise;
 *   2. an ACTIVE Drive document keeps its unit and its claim-authorized membership, and is visible
 *      to exactly the member who could see it in production;
 *   3. a document whose final claim was retired (cleanup still pending in production) keeps its
 *      RETRACTED unit and is visible to nobody — suppressed, not deleted and not re-published;
 *   4. the next deploy's schema replay changes none of that. A deploy is its own loader session:
 *      the restore owner hands over as the importer does (journal `booting` for the selected
 *      run/commit, exclusive data-use fence released) and the replay runs through a fresh loader
 *      session under the shared fence — not as a second pass on the owner's still-fenced session.
 *
 * (2) is the regression: the claims migration used to delete "every Drive unit whose item has no
 * active claim", and with the claim tables excluded that is every copied Drive unit. The last test
 * step runs that migration RAW on the restored copy, inside a rolled-back transaction, and requires
 * it to destroy the substrate — so the survival above is the replay plan's doing, not a fixture the
 * statement never matched.
 */

const SOURCE_URL = process.env.DATABASE_URL!;
const DRIVE_TABLES = [
  "gdrive_cleanup_obligations", "gdrive_connection_authority", "gdrive_item_claim_projects",
  "gdrive_item_claims", "gdrive_run_requests",
] as const;
const quiet = { log: () => {} };

/**
 * The client tools this file spawns, with the major version each reports (null when absent).
 * `pg_dump` refuses a server newer than itself, so "present" is not enough. Under
 * `scripts/dm-isolated.sh` these resolve to the tools in the dm server container's own image
 * whenever the host's are missing or a different major (`scripts/dm-pg-client.sh`).
 */
const TOOLS = ["pg_dump", "pg_restore", "psql"] as const;
const clientMajor = (tool: string): number | null => {
  const probe = spawnSync(tool, ["--version"], { encoding: "utf8" });
  const major = probe.status === 0 ? /\(PostgreSQL\) (\d+)/.exec(probe.stdout ?? "")?.[1] : undefined;
  return major ? Number(major) : null;
};
const clientMajors: Record<string, number | null> = Object.fromEntries(TOOLS.map((tool) => [tool, clientMajor(tool)]));
const toolchain = TOOLS.filter((tool) => clientMajors[tool] === null);
/** CI and the isolated harness both guarantee a matching toolchain: there, its absence is a failure. */
const toolchainRequired = Boolean(process.env.CI || process.env.AIOS_DM_PG_CONTAINER);

async function serverMajor(): Promise<number> {
  const client = new pg.Client({ connectionString: SOURCE_URL });
  await client.connect();
  try {
    const { rows } = await client.query<{ n: number }>("select current_setting('server_version_num')::int as n");
    return Math.floor(rows[0].n / 10_000);
  } finally {
    await client.end();
  }
}
/** Tools that cannot serve this server: absent, or older than it. */
const unusableFor = (server: number) =>
  TOOLS.filter((tool) => clientMajors[tool] === null || clientMajors[tool]! < server)
    .map((tool) => `${tool} ${clientMajors[tool] ?? "missing"} (server ${server})`);

const roots: string[] = [];
const closers: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const close of closers.splice(0).reverse()) await close().catch(() => undefined);
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function connect(url: string): Promise<pg.Client> {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  closers.push(() => client.end());
  return client;
}

/** A scratch database on the same server: the staging side of the pair. Dropped after the test. */
async function scratchDatabase(): Promise<string> {
  const name = `paired_gdrive_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
  let lastError: unknown = null;
  for (let attempt = 0; attempt < 5; attempt++) {
    const admin = new pg.Client({ connectionString: SOURCE_URL });
    try {
      await admin.connect();
      await admin.query(`create database ${name}`);
      lastError = null;
      break;
    } catch (error) {
      // `create database` can transiently collide with another file's scratch database.
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 100 * (attempt + 1)));
    } finally {
      await admin.end().catch(() => undefined);
    }
  }
  if (lastError) throw new Error(`could not create scratch database ${name}: ${String(lastError)}`);
  closers.push(async () => {
    const admin = new pg.Client({ connectionString: SOURCE_URL });
    await admin.connect();
    try { await admin.query(`drop database if exists ${name} with (force)`); } finally { await admin.end(); }
  });
  const url = new URL(SOURCE_URL);
  url.pathname = `/${name}`;
  return url.toString();
}

async function adminSeed(): Promise<Seed> {
  const seed = await seedTeam();
  await db().from("members").update({ role: "admin" }).eq("id", seed.memberId).eq("team_id", seed.teamId);
  return seed;
}

/** A granted initiative whose group the seed member belongs to: the Drive audience, and who sees it. */
async function audienceVisibleTo(seed: Seed): Promise<string> {
  const { data: project, error } = await db().from("projects")
    .insert({ team_id: seed.teamId, slug: `drive-${randomUUID().slice(0, 8)}`, name: "Drive audience", kind: "initiative" })
    .select("id").single();
  expect(error).toBeNull();
  const projectId = (project as { id: string }).id;
  const group = await createGroup(db(), seed.teamId, `aud-${randomUUID().slice(0, 8)}`, "Audience", seed.memberId);
  expect(group.ok, group.error).toBe(true);
  expect((await addMemberToGroup(db(), seed.teamId, group.groupId!, seed.memberId, seed.memberId)).ok).toBe(true);
  expect((await grantProjectToGroup(db(), seed.teamId, projectId, group.groupId!, seed.memberId)).ok).toBe(true);
  return projectId;
}

async function driveConnection(seed: Seed, audienceProjectId: string) {
  const row = await upsertIntegration(db(), { teamId: seed.teamId, memberId: seed.memberId }, {
    type: "gdrive", name: `drive-${randomUUID().slice(0, 8)}`, status: "enabled",
    config: {
      fileIds: ["doc"], folderIds: [], sharedDriveIds: [], recursive: false,
      selectionState: "selected", authMode: "service_account", audienceProjectIds: [audienceProjectId],
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
  const execution = { integrationId: row.id, generation: acquired.generation, fence: acquired.fence, owner: acquired.owner };
  const push = (providerId: string, body: string) => ingestApiItem(db(), auth, {
    project: "drive-docs", path: `gdrive/${providerId}.md`, kind: "deliverable", access: "team",
    actor: "gdrive-sync", body, content_sha256: sha(body),
    frontmatter: { source: "gdrive", source_id: providerId, connection_id: row.id },
  } as ItemPayload, "team", undefined, "team", execution);
  return { integrationId: row.id, auth, push };
}

/** A document's context substrate, read with plain SQL on whichever side is asked. */
async function substrateOf(client: pg.Client, itemId: string) {
  const { rows: units } = await client.query<{ id: string; state: string }>(
    "select id, state from project_context_units where source_item_id=$1", [itemId]);
  const { rows: memberships } = await client.query<{ project_id: string; method: string; decision: string }>(
    `select m.project_id, m.method, m.decision from project_context_memberships m
       join project_context_units u on u.team_id=m.team_id and u.id=m.context_unit_id
      where u.source_item_id=$1 and m.valid_to is null order by m.project_id`, [itemId]);
  return { units, memberships };
}

async function rowCounts(client: pg.Client, tables: readonly string[]): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const table of tables) {
    counts[table] = (await client.query<{ n: number }>(`select count(*)::int as n from ${table}`)).rows[0].n;
  }
  return counts;
}

/** The application's own visibility answer, asked of ANOTHER database: a fresh module graph and pool. */
async function visibilityOn(url: string, principal: { teamId: string; memberId: string }, itemIds: string[]) {
  const previous = process.env.DATABASE_URL;
  vi.resetModules();
  process.env.DATABASE_URL = url;
  try {
    const { adminClient } = await import("@/lib/db/admin");
    const enforce = await import("@/lib/access/enforce");
    const pool = await import("@/lib/db/pg/pool");
    try {
      const client = adminClient();
      const seen: Record<string, boolean> = {};
      for (const itemId of itemIds) seen[itemId] = await enforce.canSeeItem(client, principal, itemId);
      const visible = await enforce.visibleItemIds(client, principal);
      return { seen, visible: itemIds.filter((itemId) => visible.ids.has(itemId)) };
    } finally {
      await pool.getPool().end();
    }
  } finally {
    process.env.DATABASE_URL = previous;
    vi.resetModules();
  }
}

describe("AIO-1167 paired staging restore of Drive content (real Postgres, real pg tools)", () => {
  it("has a PostgreSQL client toolchain that can serve this server wherever the tier is required to run", async () => {
    // Outside CI and the isolated harness an unusable client skips the restore below, visibly;
    // inside either it is a failure — the restore proof may not silently not run.
    const unusable = unusableFor(await serverMajor());
    if (toolchainRequired) expect(unusable, `unusable PostgreSQL client tools: ${unusable.join(", ")}`).toEqual([]);
  });

  it.skipIf(toolchain.length > 0)("keeps an active Drive document visible and a pending-cleanup one suppressed through restore and schema replay", async ({ skip }) => {
    const unusable = unusableFor(await serverMajor());
    if (unusable.length > 0) {
      // Named up front: otherwise this surfaces minutes later as pg_dump's "server version mismatch".
      if (toolchainRequired) throw new Error(`unusable PostgreSQL client tools: ${unusable.join(", ")}`);
      skip(`PostgreSQL client tools cannot serve this server (${unusable.join(", ")}); run through scripts/dm-isolated.sh`);
    }

    // ── SOURCE ("production"): written through the application's own owners ────────────────────
    const seed = await adminSeed();
    const audienceProjectId = await audienceVisibleTo(seed);
    const connection = await driveConnection(seed, audienceProjectId);
    const active = await connection.push("active-doc", "an active Drive document");
    const pending = await connection.push("pending-doc", "a document whose access was withdrawn");
    expect([active.status, pending.status]).toEqual(["created", "created"]);
    // Final-claim retirement, staged only: the unit is retracted and physical cleanup is still owed.
    const retired = await stageGdriveReconciliation(db(), seed.teamId, {
      connectionId: connection.integrationId, removedProviderIds: ["pending-doc"], reason: "access withdrawn upstream",
    }, { memberId: connection.auth.memberId, apiKeyId: connection.auth.apiKeyId });
    expect(retired).toMatchObject({ candidates: 1, cleanupQueued: 1 });
    await db().from("gdrive_run_requests").insert({
      team_id: seed.teamId, integration_id: connection.integrationId, requested_by: seed.memberId,
      trigger: "manual", status: "pending",
    });

    const viewer = { teamId: seed.teamId, memberId: seed.memberId };
    expect(await canSeeItem(db(), viewer, active.id)).toBe(true);
    expect(await canSeeItem(db(), viewer, pending.id)).toBe(false);
    expect((await visibleItemIds(db(), viewer)).ids.has(active.id)).toBe(true);

    const source = await connect(SOURCE_URL);
    const sourceActive = await substrateOf(source, active.id);
    const sourcePending = await substrateOf(source, pending.id);
    expect(sourceActive.units).toEqual([{ id: expect.any(String), state: "active" }]);
    expect(sourceActive.memberships).toEqual([{ project_id: audienceProjectId, method: "gdrive_claim", decision: "include" }]);
    expect(sourcePending.units).toEqual([{ id: expect.any(String), state: "retracted" }]);
    // Non-vacuous: production really holds rows in every table the export leaves behind.
    const sourceCounts = await rowCounts(source, [...DRIVE_TABLES, "integrations", "api_keys"]);
    for (const [table, n] of Object.entries(sourceCounts)) expect(n, `${table} is empty in the source`).toBeGreaterThan(0);
    for (const table of DRIVE_TABLES) expect(EXCLUDED_PAIRED_TABLE_DATA).toContain(table);

    // ── CAPTURE → RESTORE, with the real tools ────────────────────────────────────────────────
    const directory = mkdtempSync(path.join(tmpdir(), "paired-gdrive-"));
    roots.push(directory);
    await capturePairedPostgres({ client: source, databaseUrl: SOURCE_URL, directory });

    const targetUrl = await scratchDatabase();
    await loadSchema({ databaseUrl: targetUrl, env: {}, logger: quiet }); // staging's own baseline
    const target = await connect(targetUrl);
    await installStagingOps(target);
    await target.query("update staging_ops.refresh_journal set state='importing', candidate_mode='copy-ready' where singleton");
    expect(await acquireDataUseLock(target, "exclusive")).toBe(true);
    const stagingEnv = { ...process.env, STAGING_OPS_ENVIRONMENT_ID: "dm-paired", RAILWAY_ENVIRONMENT_ID: "dm-paired" };
    // Section-wise restore, then the copy-ready schema replay — the step that used to delete units.
    await restorePairedPostgres({ client: target, databaseUrl: targetUrl, directory, env: stagingEnv });

    // 1. Credentials, queues and their dependents did not travel (and the FKs to them were created).
    expect(await rowCounts(target, [...DRIVE_TABLES, "integrations", "api_keys"]))
      .toEqual(Object.fromEntries([...DRIVE_TABLES, "integrations", "api_keys"].map((table) => [table, 0])));
    const { rows: constraints } = await target.query<{ conname: string }>(
      `select conname from pg_constraint
        where contype='f' and conrelid = any($1::regclass[]) order by conname`, [[...DRIVE_TABLES]]);
    expect(constraints.length).toBeGreaterThanOrEqual(DRIVE_TABLES.length);

    // 2 + 3. The authorization substrate is the source's, row for row.
    expect(await substrateOf(target, active.id)).toEqual(sourceActive);
    expect(await substrateOf(target, pending.id)).toEqual(sourcePending);
    expect((await target.query("select 1 from items where id = any($1::uuid[])", [[active.id, pending.id]])).rows).toHaveLength(2);

    // …and the APPLICATION agrees: the active document is visible to the same member, the
    // pending-cleanup one to nobody.
    const restored = await visibilityOn(targetUrl, viewer, [active.id, pending.id]);
    expect(restored.seen).toEqual({ [active.id]: true, [pending.id]: false });
    expect(restored.visible).toEqual([active.id]);

    // 4. The NEXT deploy replays the schema again, and changes nothing.
    //
    // A deploy is not a second pass on the restore owner's session. The importer hands the restored
    // pair over exactly as `bootExact` does (scripts/staging-ops/importer.mjs): the journal records
    // the run and commit selected to boot, the owner RELEASES its exclusive data-use fence, and the
    // deployment's own pre-deploy step runs the loader in a session of its own, under the shared
    // fence, admitted as that selected deployment. One fresh session per pass is what a deploy is
    // (`applyPass`, scripts/migrate-from-existing.mjs) — session-scoped leftovers of the first pass
    // (migration 20260725180000's temporary view) belong to the owner's session and are not there.
    const runId = `dm-paired-${randomUUID().slice(0, 8)}`;
    const bootCommit = createHash("sha1").update(runId).digest("hex");
    const deployEnv = { ...stagingEnv, STAGING_DATA_MODE: "copy-ready", RAILWAY_GIT_COMMIT_SHA: bootCommit };

    // While the owner still holds the fence a deploy's loader is refused by name, before it runs a
    // statement: the replay below cannot have shared the owner's fenced lifetime.
    await expect(loadSchema({ databaseUrl: targetUrl, env: deployEnv, logger: quiet }))
      .rejects.toThrow("staging schema loader refused: staging maintenance holds the exclusive data-use lock");

    await transitionJournal(target, {
      runId, from: ["verifying", "importing"], to: "booting",
      patch: { candidateMode: "copy-ready", bootRunId: runId, bootCommit },
    });
    await releaseDataUseLock(target, "exclusive");
    expect(await hasExclusiveDataUseLock(target), "the restore owner still holds its exclusive fence").toBe(false);

    let deploySession: pg.Client | undefined;
    await loadSchema({
      databaseUrl: targetUrl, env: deployEnv, logger: quiet,
      createClient: (config: pg.ClientConfig) => (deploySession = new pg.Client(config)),
    });
    // A different backend from the restore owner's, opened and closed by the loader itself.
    const ownerPid = (await target.query<{ pid: number }>("select pg_backend_pid() as pid")).rows[0].pid;
    const deployPid = (deploySession as unknown as { processID: number | null } | undefined)?.processID;
    expect(deployPid, "the later replay did not open a session of its own").toEqual(expect.any(Number));
    expect(deployPid, "the later replay ran on the restore owner's session").not.toBe(ownerPid);

    // Read back on a connection that is neither the restore owner nor the loader.
    const afterDeploy = await connect(targetUrl);
    expect(await rowCounts(afterDeploy, [...DRIVE_TABLES, "integrations", "api_keys"]))
      .toEqual(Object.fromEntries([...DRIVE_TABLES, "integrations", "api_keys"].map((table) => [table, 0])));
    expect(await substrateOf(afterDeploy, active.id)).toEqual(sourceActive);
    expect(await substrateOf(afterDeploy, pending.id)).toEqual(sourcePending);
    const redeployed = await visibilityOn(targetUrl, viewer, [active.id, pending.id]);
    expect(redeployed.seen).toEqual({ [active.id]: true, [pending.id]: false });
    expect(redeployed.visible).toEqual([active.id]);

    // NEGATIVE CONTROL: the superseded statement, replayed RAW over this very copy, destroys it.
    const [step] = REPLAY_STEP_SUPERSESSIONS;
    const raw = readFileSync(path.join(process.cwd(), "postgres", "migrations", step.migration), "utf8");
    await afterDeploy.query("begin");
    try {
      await afterDeploy.query(raw);
      expect((await substrateOf(afterDeploy, active.id)).units, "the raw migration no longer deletes copied Drive units").toEqual([]);
      expect((await substrateOf(afterDeploy, active.id)).memberships).toEqual([]);
    } finally {
      await afterDeploy.query("rollback");
    }
    expect(await substrateOf(afterDeploy, active.id)).toEqual(sourceActive);
  }, 240_000);
});
