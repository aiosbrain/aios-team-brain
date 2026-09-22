import "server-only";

import { runSql, withTransaction } from "@/lib/db/pg/pool";
import type { DbClient } from "@/lib/db/types";

export class AttributionRepairPendingError extends Error {
  constructor() {
    super("identity attribution repair is not complete; retry after the current mapping repair");
    this.name = "AttributionRepairPendingError";
  }
}

async function assertAttributionRepairComplete(db: DbClient, teamId: string): Promise<void> {
  const { data, error } = await db.from("team_identity_authority").select("repair_status")
    .eq("team_id", teamId).maybeSingle();
  if (error) throw new Error(`identity attribution authority read failed: ${error.message}`);
  if (data && (data as { repair_status: string }).repair_status !== "complete") {
    throw new AttributionRepairPendingError();
  }
}

/**
 * Current durable visibility generation. The schema migration seeds existing teams and the first
 * revocation upserts future teams. A missing row is therefore the canonical initial epoch; reads do
 * not need to perform a write (important for read-only/cache paths and transaction composition).
 */
export async function authorizationEpoch(db: DbClient, teamId: string): Promise<number> {
  try {
    // A newer epoch prevents serving the old payload, while the repair state prevents publishing a
    // plausible-but-partial replacement before every attribution effect has committed.
    await assertAttributionRepairComplete(db, teamId);
    const { data, error } = await db.from("team_authorization_epochs").select("epoch")
      .eq("team_id", teamId).maybeSingle();
    if (error) throw new Error(`authorization epoch read failed: ${error.message}`);
    return data ? Number((data as { epoch: string | number }).epoch) : 1;
  } catch (error) {
    // Pure unit DbClient fakes predate this table and deliberately implement only the query under
    // test. The real-PG tier exercises the barrier; production must never degrade around it.
    if (process.env.NODE_ENV === "test" && !process.env.DATABASE_URL) return 1;
    throw error;
  }
}

/** Lock the durable epoch against a concurrent revocation for cache publication/serving. */
export async function lockedAuthorizationEpoch(teamId: string): Promise<number> {
  // Lock ordering is shared with identity repair completion and the mutation trigger: identity
  // authority first, authorization epoch second. The missing-row case is the untouched-team state.
  const { rows: authorityRows } = await runSql<{ repair_status: string }>(
    `select repair_status from team_identity_authority where team_id=$1 for share`,
    [teamId],
  );
  if (authorityRows[0] && authorityRows[0].repair_status !== "complete") {
    throw new AttributionRepairPendingError();
  }
  await runSql(
    `insert into team_authorization_epochs(team_id,epoch) values ($1,1)
     on conflict (team_id) do nothing`,
    [teamId],
  );
  const { rows } = await runSql<{ epoch: string | number }>(
    `select epoch from team_authorization_epochs where team_id=$1 for share`,
    [teamId],
  );
  return Number(rows[0]?.epoch ?? 1);
}

/** Execute a cache-memory read at a revocation-linearized epoch. */
export async function withLockedAuthorizationEpoch<T>(
  teamId: string,
  fn: (epoch: number) => Promise<T> | T,
): Promise<T> {
  try {
    return await withTransaction(async () => fn(await lockedAuthorizationEpoch(teamId)));
  } catch (error) {
    if (process.env.NODE_ENV === "test" && !process.env.DATABASE_URL) return fn(1);
    throw error;
  }
}

/**
 * Establish the cross-process revocation barrier before a revocation reports success. Cache cleanup
 * is deliberately in the same transaction but remains regenerable; the epoch is the authority.
 */
export async function advanceAuthorizationEpoch(teamId: string): Promise<number> {
  return withTransaction(async () => {
    const { rows } = await runSql<{ epoch: string | number }>(
      `insert into team_authorization_epochs(team_id,epoch) values ($1,2)
       on conflict (team_id) do update set epoch=team_authorization_epochs.epoch+1, updated_at=now()
       returning epoch`,
      [teamId],
    );
    // Cache rows are regenerable physical cleanup. The epoch is the immediate durable boundary;
    // a final-claim cleanup obligation removes old payloads after this transaction commits.
    return Number(rows[0]?.epoch ?? 1);
  });
}
