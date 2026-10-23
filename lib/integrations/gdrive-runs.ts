import "server-only";

import { runSql, withTransaction } from "@/lib/db/pg/pool";

function canonicalJson(value: Record<string, unknown>): string {
  return JSON.stringify(Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))));
}

export interface GdriveRunClaim {
  id: string;
  integration_id: string;
  name: string;
  trigger: "manual" | "retry";
  created_at: string;
  /** Opaque, fresh per claim. Only the attempt holding it may complete or defer this request. */
  attempt_token: string;
}

/** A request left `running` this long by an attempt whose Drive execution is no longer live is
 *  recovered. Age alone is never enough: a live execution lease is the attempt still working. */
const INTERRUPTED_AFTER = "15 minutes";

export async function recordScheduledGdriveRun(input: {
  reportId: string; integrationId: string; teamId: string; apiKeyId: string; memberId: string;
  status: "complete" | "partial" | "failed" | "deferred";
  summary: Record<string, unknown>; error?: string; startedAt: string;
}): Promise<{ newly_completed: boolean; started_at: string }> {
  return withTransaction(async () => {
    const { rows: authority } = await runSql<{ ok: boolean }>(
      `select true as ok from integrations i
       join gdrive_connection_authority a on a.integration_id=i.id and a.team_id=i.team_id
       join api_keys k on k.id=a.connector_api_key_id and k.member_id=a.connector_member_id
       join members m on m.id=a.connector_member_id and m.team_id=a.team_id
       where i.id=$1 and i.team_id=$2 and i.type='gdrive'
         and a.connector_api_key_id=$3 and a.connector_member_id=$4
         and k.revoked_at is null and m.status='active' and m.is_connector=true`,
      [input.integrationId, input.teamId, input.apiKeyId, input.memberId],
    );
    if (!authority[0]) {
      throw new Error("Google Drive scheduled report authority is stale");
    }
    const { rows: existing } = await runSql<{
      status: string; summary: Record<string, unknown>; error: string | null; started_at: string;
    }>(`select status,summary,error,started_at from gdrive_run_requests where id=$1 for update`, [input.reportId]);
    if (existing[0]) {
      const same = existing[0].status === input.status
        && canonicalJson(existing[0].summary ?? {}) === canonicalJson(input.summary)
        && (existing[0].error ?? undefined) === input.error;
      if (!same) throw new Error("conflicting Google Drive scheduled report replay");
      return { newly_completed: false, started_at: existing[0].started_at };
    }
    await runSql(
      `insert into gdrive_run_requests
       (id,team_id,integration_id,trigger,status,created_at,started_at,finished_at,summary,error)
       values($1,$2,$3,'scheduler',$4,$5::timestamptz,$5::timestamptz,now(),$6::jsonb,$7)`,
      [input.reportId, input.teamId, input.integrationId, input.status, input.startedAt,
       JSON.stringify(input.summary), input.error ?? null],
    );
    return { newly_completed: true, started_at: input.startedAt };
  });
}

export async function claimGdriveRun(input: {
  teamId: string; apiKeyId: string; memberId: string;
}): Promise<GdriveRunClaim | null> {
  return withTransaction(async () => {
    // An interrupted attempt is recovered only when its connection's Drive execution lease is not
    // live (none, released, or expired). The token goes with it: whatever that attempt reports later
    // names a token the request no longer holds.
    await runSql(
      `update gdrive_run_requests r
          set status='pending',started_at=null,attempt_token=null,error='recovered after interrupted worker'
         from gdrive_connection_authority a
        where r.integration_id=a.integration_id and r.team_id=a.team_id and r.team_id=$1
          and r.status='running' and r.started_at < now()-$4::interval
          and (a.lease_until is null or a.lease_until <= now())
          and a.connector_api_key_id=$2 and a.connector_member_id=$3`,
      [input.teamId, input.apiKeyId, input.memberId, INTERRUPTED_AFTER],
    );
    const { rows } = await runSql<Omit<GdriveRunClaim, "attempt_token">>(
      `select r.id,r.integration_id,i.name,r.trigger,r.created_at
         from gdrive_run_requests r
         join integrations i on i.id=r.integration_id and i.team_id=r.team_id
         join gdrive_connection_authority a on a.integration_id=i.id and a.team_id=i.team_id
        where r.team_id=$1 and r.status='pending' and i.status='enabled'
          and a.connector_api_key_id=$2 and a.connector_member_id=$3
        order by r.created_at,r.id
        for update of r skip locked limit 1`,
      [input.teamId, input.apiKeyId, input.memberId],
    );
    if (!rows[0]) return null;
    const { rows: claimed } = await runSql<{ attempt_token: string }>(
      `update gdrive_run_requests set status='running',started_at=now(),error=null,attempt_token=gen_random_uuid()
        where id=$1 and status='pending' returning attempt_token`,
      [rows[0].id],
    );
    if (!claimed[0]) return null;
    return { ...rows[0], attempt_token: claimed[0].attempt_token };
  });
}

export async function completeGdriveRun(input: {
  requestId: string; attemptToken: string; teamId: string; apiKeyId: string; memberId: string;
  status: "complete" | "partial" | "failed" | "deferred";
  summary: Record<string, unknown>; error?: string;
}): Promise<{ integration_id: string; trigger: "manual" | "retry"; started_at: string; newly_completed: boolean } | null> {
  return withTransaction(async () => {
    const { rows } = await runSql<{
      integration_id: string; trigger: "manual" | "retry"; started_at: string;
      status: string; summary: Record<string, unknown>; error: string | null;
      attempt_token: string | null;
    }>(
      `select r.integration_id,r.trigger,r.started_at,r.status,r.summary,r.error,r.attempt_token
         from gdrive_run_requests r
         join gdrive_connection_authority a on a.integration_id=r.integration_id and a.team_id=r.team_id
        where r.id=$1 and r.team_id=$2
          and a.connector_api_key_id=$3 and a.connector_member_id=$4
        for update of r`,
      [input.requestId, input.teamId, input.apiKeyId, input.memberId],
    );
    if (!rows[0]) return null;
    const { attempt_token: currentToken, ...row } = rows[0];
    // Only the attempt that holds the request's current token speaks for it. An attempt that was
    // recovered (token cleared) or succeeded by a later claim (token replaced) changes nothing.
    if (!currentToken || currentToken !== input.attemptToken) return null;
    // Delivery is at-least-once: a lost HTTP response may replay the exact report of this attempt.
    // Accept it idempotently, but never let a conflicting replay rewrite history.
    const replayOf = (status: string, error: string | undefined) => row.status === status
      && canonicalJson(row.summary ?? {}) === canonicalJson(input.summary)
      && (row.error ?? undefined) === error;
    if (input.status === "deferred") {
      // The attempt keeps its token while the request waits: the next claim replaces it.
      const error = input.error ?? "coordinator busy; deferred";
      if (row.status !== "running") return replayOf("pending", error) ? { ...row, newly_completed: false } : null;
      const { rows: deferred } = await runSql<{ id: string }>(
        `update gdrive_run_requests set status='pending',started_at=null,error=$1,summary=$2::jsonb
          where id=$3 and status='running' and attempt_token=$4 returning id`,
        [error, JSON.stringify(input.summary), input.requestId, input.attemptToken],
      );
      return deferred[0] ? { ...row, newly_completed: false } : null;
    }
    if (row.status !== "running") return replayOf(input.status, input.error) ? { ...row, newly_completed: false } : null;
    const { rows: finished } = await runSql<{ id: string }>(
      `update gdrive_run_requests set status=$1,finished_at=now(),summary=$2::jsonb,error=$3
        where id=$4 and status='running' and attempt_token=$5 returning id`,
      [input.status, JSON.stringify(input.summary), input.error ?? null, input.requestId, input.attemptToken],
    );
    return finished[0] ? { ...row, newly_completed: true } : null;
  });
}
