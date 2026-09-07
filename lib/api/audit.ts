import "server-only";
import type { DbClient } from "@/lib/db/types";
import { transactionSessionFor } from "@/lib/db/pg/tx";

export type AuditEntry = {
  team_id: string | null;
  actor_kind: "member" | "api_key" | "system";
  member_id?: string | null;
  api_key_id?: string | null;
  action: string;
  target_type?: string | null;
  target_id?: string | null;
  meta?: Record<string, unknown>;
  ip?: string | null;
};

/** Append-only audit write via the service role. Best-effort: never throws. */
export async function audit(db: DbClient, entry: AuditEntry) {
  const write = async (): Promise<void> => {
    const { error } = await db.from("audit_log").insert({
      team_id: entry.team_id,
      actor_kind: entry.actor_kind,
      member_id: entry.member_id ?? null,
      api_key_id: entry.api_key_id ?? null,
      action: entry.action,
      target_type: entry.target_type ?? null,
      target_id: entry.target_id ?? null,
      meta: entry.meta ?? {},
      ip: entry.ip ?? null,
    });
    if (error) throw new Error(`audit insert failed: ${error.message}`);
  };
  const session = transactionSessionFor(db);
  if (session) {
    // A transaction-aborting audit error is recoverable only after SAVEPOINT rollback + release.
    await session.optionalAudit(write, undefined);
    return;
  }
  try {
    await write();
  } catch {
    // auditing must never take the request down
  }
}
