import "server-only";

import { createHash } from "node:crypto";
import { acquireWithLockTimeout, withBoundedLockWaits } from "@/lib/db/pg/bounded-lock";
import { runSql } from "@/lib/db/pg/pool";
import { lockItemAttribution } from "@/lib/ingest/item-attribution-lock";
import { lockGdriveProvider } from "@/lib/projects/context/gdrive-claims";
import { ITEM_INGEST_LOCK_NS } from "@/lib/projects/context/transaction";

/**
 * The Google Drive ingest half of the shared ingest lock order (AIO-1167):
 *
 *   identity authority/revision → connection authority → the COMPLETE project set, sorted
 *     → provider identity and its mapping row → path identities (by project id, sorted)
 *     → item-attribution advisories (sorted) → item rows (sorted) → dependent rows
 *
 * Every ingest is project-before-item. An ordinary ingest writes one project and knows it from its
 * payload. A Drive ingest does not: the document may already live in another project, and the rows
 * it can collide with are found by looking. So it PLANS first — unlocked reads of the provider's
 * mapping and of every item it could adopt or collide with (`planGdriveIngest`) — hands the planned
 * projects to `withGdriveExecutionCommit`, which takes them all in one pass, and only then takes
 * the identity and item locks here, proving under each that the plan still describes the database.
 * A plan that no longer does is never patched up with a late lock: the whole attempt is abandoned
 * and planned again (`GdriveIngestStateChangedError`).
 *
 * Source reconciliation takes the same head — connection authority, project rows, then all of its
 * provider identities, item-attribution advisories and item rows (`lockGdriveReconciliationSet`) —
 * before its first write.
 */

/** Whole attempts a Drive ingest gets: the first, and one more after a `GdriveIngestStateChangedError`. */
export const GDRIVE_INGEST_ATTEMPTS = 2;

/**
 * What this attempt planned no longer holds under its locks: the provider's mapping changed, a
 * candidate item was removed (a purge won the race), moved or appeared, or a planned project is
 * gone. Nothing read before the locks may be reused and no lock may be added out of order, so the
 * whole attempt is abandoned — its transaction rolls back and releases every lock — and
 * `runGdriveIngestAttempts` starts again from the top, once.
 */
export class GdriveIngestStateChangedError extends Error {
  readonly code = "gdrive-ingest-state-changed";
  constructor(detail: string) {
    super(`Google Drive ingest raced a concurrent change (${detail}); the attempt was abandoned`);
    this.name = "GdriveIngestStateChangedError";
  }
}

/**
 * Run a Drive ingest as at most `GDRIVE_INGEST_ATTEMPTS` WHOLE attempts. `attempt` must own its
 * transaction, so a retry starts with no lock held and no stale read. Only a state change is
 * retried: a lock timeout (55P03), an unconfirmed commit, an authority refusal and every other
 * failure propagate from the attempt that raised them.
 */
export async function runGdriveIngestAttempts<T>(attempt: (number: number) => Promise<T>): Promise<T> {
  for (let number = 1; ; number++) {
    try {
      return await attempt(number);
    } catch (error) {
      if (number >= GDRIVE_INGEST_ATTEMPTS || !(error instanceof GdriveIngestStateChangedError)) throw error;
    }
  }
}

export interface DrivePathIdentity {
  projectId: string;
  path: string;
}

/**
 * Where a Drive document is stored when its requested path already belongs to an unrelated row.
 * Deterministic in the request alone, which is what lets the path be locked before anything is read.
 */
export function driveCollisionSafePath(path: string, providerId: string): string {
  const dot = path.lastIndexOf(".");
  const suffix = createHash("sha256").update(providerId).digest("hex").slice(0, 10);
  return dot > path.lastIndexOf("/")
    ? `${path.slice(0, dot)}--drive-${suffix}${path.slice(dot)}`
    : `${path}--drive-${suffix}`;
}

/**
 * THE key for one item path identity — byte-for-byte the one `lockIngestIdentity` takes inside the
 * ingest session (`lib/projects/context/transaction`), so the two acquisitions are one re-entrant
 * lock rather than two keys for the same identity. It is keyed by project ID, so it can only be
 * taken after the project row.
 */
export function drivePathIdentityKey(teamId: string, identity: DrivePathIdentity): string {
  return JSON.stringify([teamId, identity.projectId, identity.path]);
}

/** Distinct identities in the one order every Drive writer takes them. */
export function orderDrivePathIdentities(
  teamId: string,
  identities: readonly DrivePathIdentity[],
): DrivePathIdentity[] {
  const byKey = new Map(identities.map((identity) => [drivePathIdentityKey(teamId, identity), identity]));
  return [...byKey.keys()].sort().map((key) => byKey.get(key)!);
}

/**
 * The path identities a Drive ingest may create at in its storage project: the requested path and
 * its collision-safe alternative. Both are known from the request, so both are held from before
 * the existence check to after the insert.
 */
export function driveRequestPathIdentities(
  teamId: string,
  projectId: string,
  requestedPath: string,
  providerId: string,
): DrivePathIdentity[] {
  return orderDrivePathIdentities(teamId, [
    { projectId, path: requestedPath },
    { projectId, path: driveCollisionSafePath(requestedPath, providerId) },
  ]);
}

const PATH_IDENTITY_LOCK = "select pg_advisory_xact_lock($1::int, hashtext($2::text))";

interface MappingRow {
  item_id: string;
  project_id: string | null;
  canonical_path: string | null;
}

/** An item the ingest can adopt or collide with, and the project it lives in. */
export interface DriveCandidateItem {
  id: string;
  projectId: string;
}

/** Everything a Drive ingest will lock, decided before it locks anything below the connection. */
export interface GdriveIngestPlan {
  teamId: string;
  providerId: string;
  /** The project the request names: the one row this ingest writes. */
  storageProjectId: string;
  /** The provider's mapping as planned; it must be exactly this again under the provider lock. */
  mapping: MappingRow | null;
  /** Every path this ingest can check for or create an item at, in lock order. */
  paths: DrivePathIdentity[];
  /** Every item this ingest can adopt or collide with, by ascending id. */
  candidates: DriveCandidateItem[];
  /** Projects referenced but not written: where the mapping points and where candidates live. */
  referenceProjectIds: string[];
}

export interface GdriveIngestLocks {
  providerId: string;
  /** Items whose attribution advisory — and row, where one exists — this transaction holds. */
  itemIds: ReadonlySet<string>;
  /** `drivePathIdentityKey`s held: every identity this ingest may check for or create an item at. */
  pathKeys: ReadonlySet<string>;
  /** Project rows held (lower-case ids): every project this ingest may write or place an item in. */
  projectIds: ReadonlySet<string>;
}

export interface GdriveIngestLockHooks {
  beforeAttributionLock?: (itemId: string) => Promise<void>;
  afterAttributionLock?: (itemId: string) => Promise<void>;
}

const MAPPING_READ = `select item_id, project_id, canonical_path from source_item_mappings
      where team_id=$1 and source='gdrive' and provider_id=$2`;

const sameMapping = (planned: MappingRow | null, locked: MappingRow | null) =>
  planned === null || locked === null
    ? planned === locked
    : planned.item_id === locked.item_id
      && planned.project_id === locked.project_id
      && planned.canonical_path === locked.canonical_path;

const sameCandidates = (planned: readonly DriveCandidateItem[], found: readonly DriveCandidateItem[]) =>
  planned.length === found.length
  && planned.every((item, index) => item.id === found[index].id && item.projectId === found[index].projectId);

/** Every path this ingest can check for or create an item at: the request's two, plus where a
 * retained mapping says the document lives (a tombstone is restored there, not at the request). */
function plannedPaths(
  teamId: string,
  storageProjectId: string,
  requestedPath: string,
  providerId: string,
  mapping: MappingRow | null,
): DrivePathIdentity[] {
  return orderDrivePathIdentities(teamId, [
    ...driveRequestPathIdentities(teamId, storageProjectId, requestedPath, providerId),
    ...(mapping
      ? [{ projectId: mapping.project_id ?? storageProjectId, path: mapping.canonical_path ?? requestedPath }]
      : []),
  ]);
}

/** The rows the ingest can adopt or collide with — the same lookups `ingestItem` performs itself. */
async function discoverCandidates(
  teamId: string,
  providerId: string,
  mapping: MappingRow | null,
  paths: readonly DrivePathIdentity[],
): Promise<DriveCandidateItem[]> {
  const found = new Map<string, string>();
  const { rows: occupants } = await runSql<{ id: string; project_id: string }>(
    `select i.id, i.project_id from items i
       join jsonb_to_recordset($2::jsonb) as p(project_id uuid, path text)
         on p.project_id=i.project_id and p.path=i.path
      where i.team_id=$1`,
    [teamId, JSON.stringify(paths.map((identity) => ({ project_id: identity.projectId, path: identity.path })))],
  );
  for (const row of occupants) found.set(row.id, row.project_id);
  if (mapping) {
    const { rows } = await runSql<{ id: string; project_id: string }>(
      `select id, project_id from items where team_id=$1 and id=$2`,
      [teamId, mapping.item_id],
    );
    for (const row of rows) found.set(row.id, row.project_id);
  } else {
    // No mapping yet: an item ingested before mappings existed is recovered by its provenance.
    const { rows } = await runSql<{ id: string; project_id: string }>(
      `select id, project_id from items
        where team_id=$1 and frontmatter->>'source'='gdrive' and frontmatter->>'source_id'=$2`,
      [teamId, providerId],
    );
    for (const row of rows) found.set(row.id, row.project_id);
  }
  return [...found.keys()].sort().map((id) => ({ id, projectId: found.get(id)! }));
}

/**
 * Plan one Drive ingest WITHOUT taking a lock: read the provider's mapping, derive every path the
 * document can occupy, and find every item it can adopt or collide with. The result names the
 * complete project set, so the caller can take all of it — in id order, each row in its final
 * mode — before any identity or item lock.
 *
 * Nothing here authorizes anything. Every part of the plan is re-read under its lock by
 * `lockGdriveIngestIdentities`.
 */
export async function planGdriveIngest(input: {
  teamId: string;
  storageProjectId: string;
  requestedPath: string;
  providerId: string;
}): Promise<GdriveIngestPlan> {
  const { teamId, storageProjectId, requestedPath, providerId } = input;
  const { rows: mappings } = await runSql<MappingRow>(MAPPING_READ, [teamId, providerId]);
  const mapping = mappings[0] ?? null;
  const paths = plannedPaths(teamId, storageProjectId, requestedPath, providerId, mapping);
  const candidates = await discoverCandidates(teamId, providerId, mapping, paths);
  const referenced = new Set<string>(candidates.map((item) => item.projectId));
  if (mapping?.project_id) referenced.add(mapping.project_id);
  referenced.delete(storageProjectId);
  return {
    teamId,
    providerId,
    storageProjectId,
    mapping,
    paths,
    candidates,
    referenceProjectIds: [...referenced].sort(),
  };
}

/**
 * Take every lock below the project rows for one planned Drive document, in order, and prove under
 * each that the plan still describes the database.
 *
 * Must run inside the Drive execution commit (`withGdriveExecutionCommit`), which already holds the
 * connection authority and `lockedProjectIds` — the audience plus the plan's projects.
 */
export async function lockGdriveIngestIdentities(input: {
  plan: GdriveIngestPlan;
  lockedProjectIds: ReadonlySet<string>;
  hooks?: GdriveIngestLockHooks;
}): Promise<GdriveIngestLocks> {
  const { plan, lockedProjectIds, hooks = {} } = input;
  const { teamId, providerId } = plan;

  // A planned project that was gone by the time its row was locked is not replaced by a later one.
  for (const projectId of [plan.storageProjectId, ...plan.referenceProjectIds]) {
    if (!lockedProjectIds.has(projectId.toLowerCase())) {
      throw new GdriveIngestStateChangedError("a planned project was removed before its row lock");
    }
  }

  // Provider identity, then the one mapping row it owns. Another provider's mapping row is never
  // locked from here: reconciliation holds that provider's key before its row, and this ingest
  // does not.
  await lockGdriveProvider(teamId, providerId);
  const { rows: mappings } = await acquireWithLockTimeout<MappingRow>(`${MAPPING_READ} for update`, [teamId, providerId]);
  if (!sameMapping(plan.mapping, mappings[0] ?? null)) {
    // The mapping decides the document's project and path: with it, the planned projects, paths and
    // candidates are all stale.
    throw new GdriveIngestStateChangedError("the provider mapping changed after it was planned");
  }

  const pathKeys = plan.paths.map((identity) => drivePathIdentityKey(teamId, identity));
  await withBoundedLockWaits(async () => {
    for (const key of pathKeys) await runSql(PATH_IDENTITY_LOCK, [ITEM_INGEST_LOCK_NS, key]);
  });

  // A tombstoned mapping still names the id a restore reuses, so its advisory is taken too.
  const advisoryIds = [...new Set([
    ...plan.candidates.map((item) => item.id),
    ...(plan.mapping ? [plan.mapping.item_id] : []),
  ])].sort();
  await withBoundedLockWaits(async () => {
    for (const itemId of advisoryIds) {
      await hooks.beforeAttributionLock?.(itemId);
      await lockItemAttribution(teamId, itemId);
      await hooks.afterAttributionLock?.(itemId);
    }
  });

  // Item rows, after every advisory, in ascending id order. A row removed since the plan is simply
  // not returned; one that moved comes back in another project. Either is a stale plan.
  const locked = plan.candidates.length === 0
    ? []
    : (await acquireWithLockTimeout<{ id: string; project_id: string }>(
        `select id, project_id from items where team_id=$1 and id=any($2::uuid[]) order by id for update`,
        [teamId, plan.candidates.map((item) => item.id)],
      )).rows.map((row) => ({ id: row.id, projectId: row.project_id })).sort((a, b) => (a.id < b.id ? -1 : 1));
  if (!sameCandidates(plan.candidates, locked)) {
    throw new GdriveIngestStateChangedError("a candidate item was removed or moved before its row lock");
  }
  // And nothing new: the same lookups, now under every lock, must name the same rows.
  if (!sameCandidates(plan.candidates, await discoverCandidates(teamId, providerId, plan.mapping, plan.paths))) {
    throw new GdriveIngestStateChangedError("the candidate items changed before their row locks");
  }

  return {
    providerId,
    itemIds: new Set(advisoryIds),
    pathKeys: new Set(pathKeys),
    projectIds: lockedProjectIds,
  };
}
