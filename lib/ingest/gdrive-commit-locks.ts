import "server-only";

import { createHash } from "node:crypto";
import { acquireWithLockTimeout, withBoundedLockWaits } from "@/lib/db/pg/bounded-lock";
import { runSql } from "@/lib/db/pg/pool";
import { lockItemAttribution } from "@/lib/ingest/item-attribution-lock";
import { lockGdriveProvider } from "@/lib/projects/context/gdrive-claims";
import { ITEM_INGEST_LOCK_NS } from "@/lib/projects/context/transaction";

/**
 * The Google Drive ingest half of the Drive commit lock order (AIO-1167):
 *
 *   identity authority/revision → connection authority → project rows
 *     → provider identity and its mapping row → path identities (sorted)
 *     → item-attribution advisories (sorted) → item rows → dependent version/evidence/context rows
 *
 * The first three levels are taken by the caller (`ingestApiItem`, through
 * `withGdriveExecutionCommit`). This module takes the rest on the same ambient transaction, every
 * wait bounded, and hands the held set to `ingestItem`, which re-derives the document's identity
 * under these locks and refuses to act on anything that is not in it.
 *
 * Source reconciliation takes the same head — connection authority, project rows, then all of its
 * provider identities (`lockGdriveProviders`) — before its first item row.
 */

/** Whole attempts a Drive ingest gets: the first, and one more after a `GdriveIngestStateChangedError`. */
export const GDRIVE_INGEST_ATTEMPTS = 2;

/**
 * What this attempt discovered before its locks no longer holds under them: a candidate item was
 * removed (a purge won the race), one appeared, or the storage project changed. Nothing discovered
 * before the locks may be reused, so the whole attempt is abandoned — its transaction rolls back
 * and releases every lock — and `runGdriveIngestAttempts` starts again from the top, once.
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
 * lock rather than two keys for the same identity.
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

export interface GdriveIngestLocks {
  providerId: string;
  /** Items whose attribution advisory — and row, where one exists — this transaction holds. */
  itemIds: ReadonlySet<string>;
  /** `drivePathIdentityKey`s held: every identity this ingest may check for or create an item at. */
  pathKeys: ReadonlySet<string>;
}

export interface GdriveIngestLockHooks {
  beforeAttributionLock?: (itemId: string) => Promise<void>;
  afterAttributionLock?: (itemId: string) => Promise<void>;
}

interface MappingRow {
  item_id: string;
  project_id: string | null;
  canonical_path: string | null;
}

const sameIds = (left: readonly string[], right: readonly string[]) =>
  left.length === right.length && left.every((id, index) => id === right[index]);

/**
 * Take every lock below the project rows for one Drive document, in order, and prove that what was
 * discovered before the item locks is still what exists under them.
 *
 * Must run inside the Drive execution commit (`withGdriveExecutionCommit`), which already holds the
 * connection authority and the storage project row.
 */
export async function lockGdriveIngestIdentities(input: {
  teamId: string;
  storageProjectId: string;
  requestedPath: string;
  providerId: string;
  hooks?: GdriveIngestLockHooks;
}): Promise<GdriveIngestLocks> {
  const { teamId, storageProjectId, requestedPath, providerId, hooks = {} } = input;

  // Provider identity, then the one mapping row it owns. Another provider's mapping row is never
  // locked from here: reconciliation holds that provider's key before its row, and this ingest
  // does not.
  await lockGdriveProvider(teamId, providerId);
  const { rows: mappings } = await acquireWithLockTimeout<MappingRow>(
    `select item_id, project_id, canonical_path from source_item_mappings
      where team_id=$1 and source='gdrive' and provider_id=$2 for update`,
    [teamId, providerId],
  );
  const mapping = mappings[0] ?? null;

  // Every path this ingest can check for or create an item at: the request's two, plus where a
  // retained mapping says the document lives (a tombstone is restored there, not at the request).
  const paths = orderDrivePathIdentities(teamId, [
    ...driveRequestPathIdentities(teamId, storageProjectId, requestedPath, providerId),
    ...(mapping
      ? [{ projectId: mapping.project_id ?? storageProjectId, path: mapping.canonical_path ?? requestedPath }]
      : []),
  ]);
  const pathKeys = paths.map((identity) => drivePathIdentityKey(teamId, identity));
  await withBoundedLockWaits(async () => {
    for (const key of pathKeys) await runSql(PATH_IDENTITY_LOCK, [ITEM_INGEST_LOCK_NS, key]);
  });

  // The rows the ingest can adopt or collide with — the same lookups it performs itself.
  const discover = async (): Promise<string[]> => {
    const found = new Set<string>();
    const { rows: occupants } = await runSql<{ id: string }>(
      `select i.id from items i
         join jsonb_to_recordset($2::jsonb) as p(project_id uuid, path text)
           on p.project_id=i.project_id and p.path=i.path
        where i.team_id=$1`,
      [teamId, JSON.stringify(paths.map((identity) => ({ project_id: identity.projectId, path: identity.path })))],
    );
    for (const row of occupants) found.add(row.id);
    if (mapping) {
      const { rows } = await runSql<{ id: string }>(
        `select id from items where team_id=$1 and id=$2`,
        [teamId, mapping.item_id],
      );
      for (const row of rows) found.add(row.id);
    } else {
      // No mapping yet: an item ingested before mappings existed is recovered by its provenance.
      const { rows } = await runSql<{ id: string }>(
        `select id from items
          where team_id=$1 and frontmatter->>'source'='gdrive' and frontmatter->>'source_id'=$2`,
        [teamId, providerId],
      );
      for (const row of rows) found.add(row.id);
    }
    return [...found].sort();
  };

  const discovered = await discover();
  // A tombstoned mapping still names the id a restore reuses, so its advisory is taken too.
  const advisoryIds = [...new Set([...discovered, ...(mapping ? [mapping.item_id] : [])])].sort();
  await withBoundedLockWaits(async () => {
    for (const itemId of advisoryIds) {
      await hooks.beforeAttributionLock?.(itemId);
      await lockItemAttribution(teamId, itemId);
      await hooks.afterAttributionLock?.(itemId);
    }
  });

  // Item rows, after every advisory. A row removed since discovery is simply not returned.
  const locked = discovered.length === 0
    ? []
    : (await acquireWithLockTimeout<{ id: string }>(
        `select id from items where team_id=$1 and id=any($2::uuid[]) order by id for update`,
        [teamId, discovered],
      )).rows.map((row) => row.id).sort();
  if (!sameIds(discovered, locked)) {
    throw new GdriveIngestStateChangedError("a candidate item was removed before its row lock");
  }
  // And nothing new: the same lookups, now under every lock, must name the same rows.
  if (!sameIds(discovered, await discover())) {
    throw new GdriveIngestStateChangedError("the candidate items changed before their row locks");
  }

  return { providerId, itemIds: new Set(advisoryIds), pathKeys: new Set(pathKeys) };
}
