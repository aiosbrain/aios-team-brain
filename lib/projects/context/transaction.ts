import "server-only";
import type {
  DbClient,
  TransactionCapableDbClient,
  TransactionSession,
} from "@/lib/db/types";
import { isTransactionCapableDbClient } from "@/lib/db/types";
import { TransactionExecutionError } from "@/lib/db/pg/tx";

/** Distinct from the graph projection advisory-lock namespace (7341002). */
export const ITEM_INGEST_LOCK_NS = 7_341_013;
const LOCK_TIMEOUT = "10s";

const lockedContextBrand: unique symbol = Symbol("auditfix13-locked-item-context");

export interface LockedItemAuthority {
  id: string;
  access: "team" | "external";
  content_sha256: string;
  work_at: string;
  member_id: string | null;
  member_id_locked: boolean | null;
  frontmatter: Record<string, unknown> | null;
  created_at: string;
  work_at_from_source: boolean | null;
  [key: string]: unknown;
}

/** Constructed only after the transaction session has acquired and validated the item row lock. */
export interface LockedItemContext {
  readonly [lockedContextBrand]: true;
  readonly session: TransactionSession;
  readonly teamId: string;
  readonly itemId: string;
  readonly item: LockedItemAuthority;
}

export class MembershipStateChangedError extends Error {
  readonly code = "membership-state-changed";
  constructor(message = "membership-state-changed") {
    super(message);
    this.name = "MembershipStateChangedError";
  }
}

function sqlState(error: unknown): string | undefined {
  return error && typeof error === "object" && typeof (error as { code?: unknown }).code === "string"
    ? (error as { code: string }).code
    : undefined;
}

export function transactionCapability(db: DbClient): TransactionCapableDbClient {
  if (!isTransactionCapableDbClient(db)) throw new Error("transaction-capability-required");
  return db;
}

async function withAcquisitionTimeout<T>(
  session: TransactionSession,
  acquire: () => Promise<T>
): Promise<T> {
  const prior = await session.executeSql<{ lock_timeout: string }>("SHOW lock_timeout");
  const priorValue = prior.rows[0]?.lock_timeout ?? "0";
  await session.executeSql("SELECT set_config('lock_timeout', $1, true)", [LOCK_TIMEOUT]);
  let acquired = false;
  try {
    const result = await acquire();
    acquired = true;
    return result;
  } finally {
    // A failed lock statement aborts the transaction, so only a successful acquisition can safely
    // restore the caller's transaction-local setting. Rollback restores it on the failure path.
    if (acquired) {
      await session.executeSql("SELECT set_config('lock_timeout', $1, true)", [priorValue]);
    }
  }
}

/** Serialize both existence and authorization for one source identity. */
export async function lockIngestIdentity(
  session: TransactionSession,
  teamId: string,
  projectId: string,
  path: string
): Promise<void> {
  const identity = JSON.stringify([teamId, projectId, path]);
  await withAcquisitionTimeout(session, async () => {
    await session.executeSql(
      "SELECT pg_advisory_xact_lock($1::int, hashtext($2::text))",
      [ITEM_INGEST_LOCK_NS, identity]
    );
  });
}

/** Fresh authority read after the item row lock; no pre-lock snapshot is accepted. */
export async function lockItemContext(
  session: TransactionSession,
  teamId: string,
  itemId: string
): Promise<LockedItemContext | null> {
  const result = await withAcquisitionTimeout(session, () =>
    session.executeSql<LockedItemAuthority>(
      `select id, access, content_sha256, work_at, project_id, path, kind, member_id,
              member_id_locked, frontmatter, created_at, work_at_from_source
         from items
        where team_id = $1 and id = $2
        for update`,
      [teamId, itemId]
    )
  );
  const item = result.rows[0];
  if (!item) return null;
  return {
    [lockedContextBrand]: true,
    session,
    teamId,
    itemId,
    item,
  };
}

/** Identity-locked lookup for ingest. The row, when present, is locked in the same statement. */
export async function lockIngestItemByPath(
  session: TransactionSession,
  teamId: string,
  projectId: string,
  path: string
): Promise<LockedItemContext | null> {
  const result = await withAcquisitionTimeout(session, () =>
    session.executeSql<LockedItemAuthority>(
      `select id, access, content_sha256, work_at, project_id, path, kind, member_id,
              member_id_locked, frontmatter, created_at, work_at_from_source
         from items
        where team_id = $1 and project_id = $2 and path = $3
        for update`,
      [teamId, projectId, path]
    )
  );
  const item = result.rows[0];
  if (!item) return null;
  return {
    [lockedContextBrand]: true,
    session,
    teamId,
    itemId: item.id,
    item,
  };
}

/** Re-read authority after the owning ingest has changed the already-locked item row. */
export async function refreshLockedItemContext(
  context: LockedItemContext
): Promise<LockedItemContext | null> {
  const result = await context.session.executeSql<LockedItemAuthority>(
    `select id, access, content_sha256, work_at, project_id, path, kind, member_id,
            member_id_locked, frontmatter, created_at, work_at_from_source
       from items
      where team_id = $1 and id = $2`,
    [context.teamId, context.itemId]
  );
  const item = result.rows[0];
  if (!item) return null;
  return {
    [lockedContextBrand]: true,
    session: context.session,
    teamId: context.teamId,
    itemId: context.itemId,
    item,
  };
}

function retryable(error: unknown): boolean {
  if (error instanceof TransactionExecutionError && error.unknownCommit) return false;
  const code = sqlState(error);
  if (code === "55P03") return false;
  if (code === "40001" || code === "40P01") return true;
  if (code === "membership-state-changed") return true;
  if (code === "23505") {
    const sql = error instanceof TransactionExecutionError ? error.sql?.toLowerCase() : "";
    return Boolean(sql?.includes("items") || sql?.includes("project_context_memberships"));
  }
  return false;
}

/** At most two whole attempts, sharing one budget across every supported retry cause. */
export async function runContextTransaction<T>(
  db: DbClient,
  operation: (session: TransactionSession, attempt: 1 | 2) => Promise<T>
): Promise<T> {
  const capable = transactionCapability(db);
  let last: unknown;
  for (let index = 0; index < 2; index++) {
    try {
      return await capable.transaction((session) => operation(session, (index + 1) as 1 | 2));
    } catch (error) {
      last = error;
      if (index === 1 || !retryable(error)) throw error;
    }
  }
  throw last;
}

export function contextFailureMessage(error: unknown): string {
  const code = sqlState(error);
  const message = error instanceof Error ? error.message : String(error);
  if (code === "55P03") return `context lock-timeout: ${message}`;
  return message || "context transaction failed";
}
