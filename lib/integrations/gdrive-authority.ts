import "server-only";

import { createHash, randomBytes } from "node:crypto";
import { ensureBuiltins, writeInviteDefaultMembership } from "@/lib/access/groups";
import { audit } from "@/lib/api/audit";
import type { ApiAuth } from "@/lib/api/auth";
import { adminClient } from "@/lib/db/admin";
import type { DbClient } from "@/lib/db/types";
import { withBoundedLockWaits } from "@/lib/db/pg/bounded-lock";
import { runSql, withTransaction } from "@/lib/db/pg/pool";
import { lockIdentityAuthority, lockIdentityMutationAuthorities } from "@/lib/identity/authority";
import { lockProjectRows } from "@/lib/projects/project-row-locks";
import { decryptSecret } from "@/lib/secrets/crypto";
import { validateIntegrationConfig } from "@/lib/api/schemas";

const LEASE_SECONDS = 10 * 60;
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";

export class GdriveAuthorityError extends Error {
  constructor(
    readonly code: "connector_principal_required" | "connection_unavailable" | "wrong_connection" | "execution_busy" | "stale_execution" | "stale_progress" | "reconnect_required" | "provider_unavailable" | "admin_authority_changed",
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export interface GdriveExecution {
  integrationId: string;
  teamId: string;
  generation: number;
  fence: number;
  owner: string;
  leaseExpiresAt: string;
  scopeHash: string;
  config: Record<string, unknown>;
  progress: Record<string, unknown>;
  progressRevision: number;
}

export interface GdriveExecutionRef {
  integrationId: string;
  generation: number;
  fence: number;
  owner: string;
}

export interface GdriveApprovedAudience {
  projectIds: string[];
  /**
   * Every project row this commit now holds — the audience and the caller's plan — by lower-case
   * id, with the slug read under the lock.
   */
  lockedProjects: ReadonlyMap<string, string>;
}

/** The project rows a commit needs beyond its audience, each named with what it will do to it. */
export interface GdriveCommitProjectPlan {
  /** Rows the commit UPDATES (an ingest's storage project). */
  writeProjectIds: readonly string[];
  /** Rows the commit only references by key (where a canonical item already lives). */
  referenceProjectIds: readonly string[];
}

export interface GdriveCommitScope {
  /**
   * Plans the project rows the commit will touch besides its audience. Called after the connection
   * authority is held and before any project row is locked, so the COMPLETE set is taken in the one
   * ordered pass below and nothing is acquired or strengthened later. A plan row that is gone by the
   * time it is locked is simply absent from `lockedProjects`; the caller decides what that means.
   * Reconciliation plans nothing: it writes no project.
   */
  projects?: () => Promise<GdriveCommitProjectPlan>;
}

/** Admin-save validation lives in the integration domain, not the app route. */
export async function validateGdriveAudienceProjects(
  teamId: string,
  rawProjectIds: readonly string[],
): Promise<boolean> {
  const projectIds = [...new Set(rawProjectIds)];
  if (projectIds.length === 0
      || projectIds.some((id) => !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(id))) {
    return false;
  }
  const { rows } = await runSql<{ id: string; granted: boolean }>(
    `select p.id, exists(select 1 from project_groups pg
                         where pg.team_id=p.team_id and pg.project_id=p.id) as granted
       from projects p where p.team_id=$1 and p.id=any($2::uuid[])`,
    [teamId, projectIds],
  );
  return rows.length === projectIds.length && rows.every((project) => project.granted);
}

const NO_PROJECT_PLAN: GdriveCommitProjectPlan = { writeProjectIds: [], referenceProjectIds: [] };

/**
 * The audience of one Drive commit, with the commit's COMPLETE project set locked in the one
 * ascending pass every ingest uses (`lockProjectRows`): a project the commit updates `for no key
 * update` (an ingest's storage project), an audience project `for share`, a project it only
 * references by key `for key share` (where a canonical item already lives). A storage project that
 * is also an audience project is write-locked once and never share-locked at all.
 */
async function approvedAudience(
  row: AuthorityRow,
  plan: GdriveCommitProjectPlan = NO_PROJECT_PLAN,
): Promise<GdriveApprovedAudience> {
  const raw = row.config.audienceProjectIds;
  const projectIds = Array.isArray(raw)
    ? [...new Set(raw.filter((id): id is string => typeof id === "string" && /^[0-9a-f-]{36}$/i.test(id)))]
    : [];
  if (projectIds.length === 0) {
    throw new GdriveAuthorityError("connection_unavailable", "Google Drive audience is not resolved", 409);
  }
  const locked = await lockProjectRows(runSql, row.team_id, {
    write: plan.writeProjectIds,
    share: projectIds,
    reference: plan.referenceProjectIds,
  });
  // Read the grants only after every audience row is held, so the answer is about locked rows.
  const { rows } = await runSql<{ id: string; granted: boolean }>(
    `select p.id, exists(select 1 from project_groups pg
                         where pg.team_id=p.team_id and pg.project_id=p.id) as granted
       from projects p where p.team_id=$1 and p.id=any($2::uuid[])`,
    [row.team_id, projectIds],
  );
  if (rows.length !== projectIds.length || rows.some((project) => !project.granted)
      || projectIds.some((id) => !locked.has(id.toLowerCase()))) {
    throw new GdriveAuthorityError("connection_unavailable", "Google Drive audience grant is missing or no longer valid", 409);
  }
  return { projectIds, lockedProjects: locked };
}

interface AuthorityRow {
  integration_id: string;
  team_id: string;
  status: string;
  config: Record<string, unknown>;
  secret_ciphertext: string | null;
  generation: string | number;
  scope_hash: string;
  connector_member_id: string | null;
  connector_api_key_id: string | null;
  lease_owner: string | null;
  fence: string | number;
  lease_until: string | null;
  progress: Record<string, unknown>;
  progress_revision: string | number;
  credential_revision: string | number;
}

function requireConnectorPrincipal(auth: ApiAuth): void {
  // `is_connector` alone is not authority: this dedicated actor handle plus the persisted API-key
  // binding below prevents Slack/GitHub connectors, ordinary members, and external clients from
  // claiming a Drive execution.
  if (!auth.isConnector || auth.actorHandle !== "gdrive-sync" || auth.memberTier !== "team") {
    throw new GdriveAuthorityError("connector_principal_required", "trusted Google Drive connector principal required", 403);
  }
}

/**
 * THE Drive connection acquisition boundary. Every path that locks a connection takes its locks in
 * one order:
 *
 *   team identity authority → [named integration advisory: OAuth publication only]
 *     → integration + connection-authority rows → member / API-key rows
 *
 * The identity authority comes first even for a path that changes no identity. Each of these paths
 * is a connection → member compound: it holds the connection rows and then locks a member row (the
 * acting Admin, or the bound connector principal). A roster writer runs the other way round — a
 * hard member deletion holds the identity authority and the member row, and its foreign-key actions
 * then update `integrations.created_by` and `gdrive_connection_authority.connector_member_id`. The
 * identity authority is the one lock both sides can take before either row, so it is the head of
 * the order here: the two then queue instead of each holding the row the other needs next.
 *
 * Transaction-scoped and re-entrant: a caller that already holds it (a validated identity revision,
 * provisioning, an OAuth publication) simply passes through.
 */
async function lockedAuthority(integrationId: string, teamId: string): Promise<AuthorityRow> {
  await lockIdentityAuthority(teamId);
  const { rows } = await runSql<AuthorityRow>(
    `select i.id as integration_id, i.team_id, i.status, i.config, i.secret_ciphertext,
            a.generation, a.scope_hash, a.credential_revision,
            a.connector_member_id, a.connector_api_key_id,
            a.lease_owner, a.fence, a.lease_until, a.progress, a.progress_revision
       from integrations i
       join gdrive_connection_authority a on a.integration_id = i.id and a.team_id = i.team_id
      where i.id = $1 and i.team_id = $2 and i.type = 'gdrive'
      for update of i, a`,
    [integrationId, teamId],
  );
  if (!rows[0]) throw new GdriveAuthorityError("wrong_connection", "Google Drive connection is not available to this principal", 403);
  return rows[0];
}

export interface GdriveAdminTestAuthority {
  integrationId: string;
  teamId: string;
  memberId: string;
  generation: number;
  credentialRevision: number;
  config: Record<string, unknown>;
  credential: { clientId: string; clientSecret: string; refreshToken: string };
}

/** A connection as an OAuth publication reads it: under its row locks, credential still encrypted. */
export interface LockedGdriveConnection {
  integrationId: string;
  status: string;
  config: Record<string, unknown>;
  secretCiphertext: string | null;
}

/**
 * The acquisition boundary above, for the one owner outside this module that publishes a connection
 * (`publishGoogleDriveOAuthCredential`). Must run inside that owner's transaction.
 */
export async function lockGdriveConnection(teamId: string, integrationId: string): Promise<LockedGdriveConnection> {
  const row = await lockedAuthority(integrationId, teamId);
  return {
    integrationId: row.integration_id,
    status: row.status,
    config: row.config ?? {},
    secretCiphertext: row.secret_ciphertext,
  };
}

/**
 * Lock the acting member's row and say whether they are, right now, an active Admin of this team.
 * Always AFTER the connection rows (and so after the identity authority): see `lockedAuthority`.
 */
export async function lockActiveTeamAdmin(teamId: string, memberId: string): Promise<boolean> {
  const { rows } = await runSql<{ role: string; status: string }>(
    `select role,status from members where id=$1 and team_id=$2 for update`,
    [memberId, teamId],
  );
  return rows[0]?.role === "admin" && rows[0]?.status === "active";
}

async function assertLiveAdminConnection(
  row: AuthorityRow,
  input: { teamId: string; memberId: string; generation?: number; credentialRevision?: number },
): Promise<void> {
  const current = await lockActiveTeamAdmin(input.teamId, input.memberId)
    && row.status === "enabled"
    && (input.generation === undefined || Number(row.generation) === input.generation)
    && (input.credentialRevision === undefined
      || Number(row.credential_revision) === input.credentialRevision);
  if (!current) {
    throw new GdriveAuthorityError(
      "admin_authority_changed",
      "Google Drive Admin test authority changed",
      409,
    );
  }
}

/** Bind one Admin test/preview to the current connection generation and credential revision. */
export async function acquireGdriveAdminTestAuthority(input: {
  teamId: string;
  memberId: string;
  integrationName: string;
}): Promise<GdriveAdminTestAuthority> {
  return withTransaction(async () => {
    const { rows: ids } = await runSql<{ id: string }>(
      `select id from integrations where team_id=$1 and type='gdrive' and name=$2`,
      [input.teamId, input.integrationName],
    );
    if (!ids[0]) {
      throw new GdriveAuthorityError("wrong_connection", "Google Drive connection was not found", 404);
    }
    const row = await lockedAuthority(ids[0].id, input.teamId);
    await assertLiveAdminConnection(row, input);
    if (!row.secret_ciphertext || String(row.config.authMode ?? "oauth") !== "oauth") {
      throw new GdriveAuthorityError("reconnect_required", "Google Drive OAuth reconnection is required", 409);
    }
    let secret: StoredOAuthSecret;
    try {
      secret = JSON.parse(decryptSecret(row.secret_ciphertext)) as StoredOAuthSecret;
    } catch {
      throw new GdriveAuthorityError("reconnect_required", "Google Drive OAuth reconnection is required", 409);
    }
    if (!secret.client_id || !secret.client_secret || !secret.refresh_token) {
      throw new GdriveAuthorityError("reconnect_required", "Google Drive OAuth reconnection is required", 409);
    }
    return {
      integrationId: row.integration_id,
      teamId: input.teamId,
      memberId: input.memberId,
      generation: Number(row.generation),
      credentialRevision: Number(row.credential_revision),
      config: row.config,
      credential: {
        clientId: secret.client_id,
        clientSecret: secret.client_secret,
        refreshToken: secret.refresh_token,
      },
    };
  });
}

/** Revalidate the exact Admin/connection snapshot immediately around every provider operation. */
export async function authorizeGdriveAdminTestCall(
  authority: Pick<GdriveAdminTestAuthority, "integrationId" | "teamId" | "memberId" | "generation" | "credentialRevision">,
): Promise<void> {
  await withTransaction(async () => {
    const row = await lockedAuthority(authority.integrationId, authority.teamId);
    await assertLiveAdminConnection(row, authority);
  });
}

/** Atomically publish a Picker-verified selection against the exact Admin/config credential
 * snapshot used for provider verification. The integration trigger advances generation/fence when
 * the effective selection changes, so an older connector cannot race the newly approved scope. */
export async function publishGdriveVerifiedSelection(
  authority: GdriveAdminTestAuthority,
  fileIds: readonly string[],
): Promise<void> {
  await publishGdriveVerifiedConfig(authority, {
    ...authority.config,
    fileIds: [...new Set(fileIds)],
    selectionState: "selected",
    authMode: "oauth",
  }, "gdrive.selection_picker_verified");
}

/** Publish any provider-verified Admin selection under the same credential snapshot. */
export async function publishGdriveVerifiedConfig(
  authority: GdriveAdminTestAuthority,
  nextConfig: Record<string, unknown>,
  action = "gdrive.selection_verified",
): Promise<void> {
  await withTransaction(async () => {
    const row = await lockedAuthority(authority.integrationId, authority.teamId);
    await assertLiveAdminConnection(row, authority);
    const config = validateIntegrationConfig("gdrive", nextConfig);
    const { rows } = await runSql<{ id: string }>(
      `update integrations set config=$1::jsonb,updated_at=now()
        where id=$2 and team_id=$3 and status='enabled'
        returning id`,
      [JSON.stringify(config), authority.integrationId, authority.teamId],
    );
    if (!rows[0]) {
      throw new GdriveAuthorityError("admin_authority_changed", "Google Drive connection changed", 409);
    }
    await audit(adminClient(), {
      team_id: authority.teamId,
      actor_kind: "member",
      member_id: authority.memberId,
      action,
      target_type: "integration",
      target_id: authority.integrationId,
      meta: { configKeys: Object.keys(config), credentialRevision: authority.credentialRevision },
    });
  });
}

async function assertLiveBoundPrincipal(row: AuthorityRow, auth: ApiAuth): Promise<void> {
  if (!row.connector_api_key_id || !row.connector_member_id
      || row.connector_api_key_id !== auth.apiKeyId || row.connector_member_id !== auth.memberId) {
    throw new GdriveAuthorityError("wrong_connection", "Google Drive connection is not bound to this connector principal", 403);
  }
  const { rows } = await runSql<{ valid: boolean }>(
    `select (k.revoked_at is null and m.status = 'active' and m.is_connector is true
             and m.actor_handle = 'gdrive-sync'
             and exists (
               select 1 from group_members gm
               join groups g on g.id = gm.group_id and g.team_id = gm.team_id
               where gm.team_id = $1 and gm.member_id = m.id
                 and g.slug = 'everyone' and g.is_builtin is true
             )) as valid
       from api_keys k
       join members m on m.id = k.member_id and m.team_id = k.team_id
      where k.id = $2 and k.team_id = $1 and k.member_id = $3
      for update of k, m`,
    [auth.teamId, auth.apiKeyId, auth.memberId],
  );
  if (!rows[0]?.valid) {
    throw new GdriveAuthorityError("connector_principal_required", "trusted Google Drive connector principal is no longer active", 403);
  }
}

/** Admin-only owner for first binding and key rotation. The caller must have passed requireTeamAdmin. */
export async function provisionGdriveConnectorPrincipal(input: {
  teamId: string;
  integrationId: string;
  actorMemberId: string;
}): Promise<{ key: string; keyId: string; memberId: string; rotated: boolean }> {
  const keyId = randomBytes(6).toString("hex");
  const secret = randomBytes(32).toString("base64url");
  const keyHash = createHash("sha256").update(secret).digest("hex");
  return withTransaction(async () => {
    // Identity authority precedes the connection row and connector member mutation. The
    // bookkeeping trigger is re-entrant under this application-owned boundary.
    await lockIdentityMutationAuthorities([input.teamId]);
    const row = await lockedAuthority(input.integrationId, input.teamId);
    if (!await lockActiveTeamAdmin(input.teamId, input.actorMemberId)) {
      throw new GdriveAuthorityError("connector_principal_required", "active team Admin authorization is required", 403);
    }
    const db = adminClient();
    const builtins = await ensureBuiltins(db, input.teamId);
    if (!builtins.ok) throw new Error(`connector posture bootstrap failed: ${builtins.error}`);

    const { rows: memberRows } = await runSql<{
      id: string; is_connector: boolean; status: string; actor_handle: string;
    }>(
      `insert into members(team_id,email,display_name,actor_handle,role,tier,status,is_connector)
       values ($1,$2,'Google Drive Sync','gdrive-sync','member','team','active',true)
       on conflict (team_id,actor_handle) do update set display_name = members.display_name
       returning id,is_connector,status,actor_handle`,
      [input.teamId, `gdrive-sync+${input.teamId}@connector.invalid`],
    );
    const member = memberRows[0];
    if (!member || !member.is_connector || member.status !== "active" || member.actor_handle !== "gdrive-sync") {
      throw new GdriveAuthorityError("connector_principal_required", "the reserved gdrive-sync identity is invalid", 409);
    }
    const posture = await writeInviteDefaultMembership(db, input.teamId, member.id, "team");
    if (!posture.ok) throw new Error(`connector posture write failed: ${posture.error}`);

    const { rows: keyRows } = await runSql<{ id: string }>(
      `insert into api_keys(team_id,member_id,key_id,key_hash,name)
       values ($1,$2,$3,$4,'Google Drive connector') returning id`,
      [input.teamId, member.id, keyId, keyHash],
    );
    const newKeyUuid = keyRows[0].id;
    const rotated = Boolean(row.connector_api_key_id);
    if (row.connector_api_key_id) {
      await runSql(
        `update api_keys set revoked_at = coalesce(revoked_at,now()) where id=$1 and team_id=$2`,
        [row.connector_api_key_id, input.teamId],
      );
    }
    await runSql(
      `update gdrive_connection_authority
          set connector_member_id=$2, connector_api_key_id=$3,
              generation=generation+1, fence=fence+1,
              lease_owner=null, lease_until=null, updated_at=now()
        where integration_id=$1 and team_id=$4`,
      [input.integrationId, member.id, newKeyUuid, input.teamId],
    );
    await audit(db, {
      team_id: input.teamId, actor_kind: "member", member_id: input.actorMemberId,
      action: rotated ? "gdrive.connector_rebound" : "gdrive.connector_bound",
      target_type: "integration", target_id: input.integrationId,
      meta: { connector_member_id: member.id, connector_api_key_id: newKeyUuid },
    });
    return { key: `aios_${keyId}_${secret}`, keyId, memberId: member.id, rotated };
  });
}

export interface GdriveConnectorUnbinding {
  integrationId: string;
  priorConnectorMemberId: string | null;
  priorConnectorApiKeyId: string | null;
  generation: number;
  fence: number;
}

/**
 * Unbind a member from every Drive connection it is the connector principal of, BEFORE that member
 * row is deleted — the binding half of a hard member deletion (`deleteMember({ hard: true })`,
 * `rollbackMemberCreation`).
 *
 * WHY HERE. A binding is a PAIR: `connector_member_id` and `connector_api_key_id` are both set or
 * both null (a table CHECK). Left to the foreign keys, deleting the member nulls them one at a
 * time — the member reference directly, the key reference through the cascading key delete — and
 * the first of those violates the pair: the deletion fails closed and a bound connector member can
 * never be removed. So the pair is cleared TOGETHER, by the authority owner, and the foreign-key
 * actions that follow find nothing left to do.
 *
 * It is a binding transition like any other (`provisionGdriveConnectorPrincipal`): in the one
 * statement that clears the pair, the generation and the fence advance exactly once and the lease
 * is dropped, so an execution acquired under the old binding is refused wherever it next presents
 * itself. Nothing else is touched — not the credential, the progress or recovery state, the
 * claims, the content, its attribution or any repair obligation.
 *
 * ONE TRANSACTION, the caller's. This joins the deletion's identity-mutation transaction; it opens
 * none. The unbinding, the invalidation and their audit rows commit with the member deletion or
 * roll back with it — a deletion that fails afterwards leaves the binding exactly as it was.
 *
 * LOCK ORDER. The caller already holds the team identity authority (asserted, never acquired here:
 * it could only be acquired late). Under it, the affected connections are discovered, their
 * integration and authority rows locked in ascending integration-id order, and the binding re-read
 * from the locked rows. Every other Drive connection path takes the identity authority first
 * (`lockedAuthority`), so provisioning, rotation and execution queue behind this deletion or ahead
 * of it — never interleaved with it.
 */
export async function unbindGdriveConnectorMember(
  db: DbClient,
  input: {
    teamId: string;
    memberId: string;
    reason: "member-deleted" | "member-creation-rolled-back";
    actor?: { kind?: "member" | "system"; memberId?: string | null };
  },
): Promise<GdriveConnectorUnbinding[]> {
  const { teamId, memberId } = input;
  const { rows: authority } = await runSql<{ held: boolean }>(
    `select exists(
       select 1 from pg_locks
        where locktype = 'advisory' and pid = pg_backend_pid() and granted and objsubid = 1
          and ((classid::bigint << 32) | objid::bigint) = hashtextextended($1, 0)) as held`,
    [`${teamId}:identity-authority`],
  );
  if (authority[0]?.held !== true) {
    throw new Error("Drive connector unbinding requires the caller's identity-mutation transaction");
  }

  // A binding names the member, and a key of the member's. Either reference makes it this member's.
  const BOUND_TO_MEMBER = `(a.connector_member_id = $2
    or a.connector_api_key_id in (select k.id from api_keys k where k.team_id = $1 and k.member_id = $2))`;
  const { rows: discovered } = await runSql<{ integration_id: string }>(
    `select a.integration_id from gdrive_connection_authority a
      where a.team_id = $1 and ${BOUND_TO_MEMBER}
      order by a.integration_id`,
    [teamId, memberId],
  );
  if (discovered.length === 0) return [];

  const { rows: locked } = await runSql<{
    integration_id: string;
    connector_member_id: string | null;
    connector_api_key_id: string | null;
    bound: boolean;
  }>(
    `select i.id as integration_id, a.connector_member_id, a.connector_api_key_id,
            ${BOUND_TO_MEMBER} as bound
       from integrations i
       join gdrive_connection_authority a on a.integration_id = i.id and a.team_id = i.team_id
      where i.team_id = $1 and i.type = 'gdrive' and i.id = any($3::uuid[])
      order by i.id
      for update of i, a`,
    [teamId, memberId, discovered.map((row) => row.integration_id)],
  );
  // Revalidated on the locked rows: only a binding that is still this member's is cleared.
  const bound = locked.filter((row) => row.bound === true);
  if (bound.length === 0) return [];

  const { rows: cleared } = await runSql<{ integration_id: string; generation: string | number; fence: string | number }>(
    `update gdrive_connection_authority
        set connector_member_id = null, connector_api_key_id = null,
            generation = generation + 1, fence = fence + 1,
            lease_owner = null, lease_until = null, updated_at = now()
      where team_id = $1 and integration_id = any($2::uuid[])
      returning integration_id, generation, fence`,
    [teamId, bound.map((row) => row.integration_id)],
  );
  if (cleared.length !== bound.length) {
    throw new Error("Drive connector unbinding did not clear every locked binding");
  }
  const after = new Map(cleared.map((row) => [row.integration_id, row]));
  const unbound: GdriveConnectorUnbinding[] = [];
  for (const row of bound) {
    const advanced = after.get(row.integration_id)!;
    const unbinding: GdriveConnectorUnbinding = {
      integrationId: row.integration_id,
      priorConnectorMemberId: row.connector_member_id,
      priorConnectorApiKeyId: row.connector_api_key_id,
      generation: Number(advanced.generation),
      fence: Number(advanced.fence),
    };
    // Row ids only: the key's id in `api_keys`, never its public id, hash or secret.
    await audit(db, {
      team_id: teamId,
      actor_kind: input.actor?.kind ?? "system",
      member_id: input.actor?.memberId ?? null,
      action: "gdrive.connector_unbound",
      target_type: "integration",
      target_id: row.integration_id,
      meta: {
        reason: input.reason,
        connector_member_id: unbinding.priorConnectorMemberId,
        connector_api_key_id: unbinding.priorConnectorApiKeyId,
        generation: unbinding.generation,
        fence: unbinding.fence,
      },
    });
    unbound.push(unbinding);
  }
  return unbound;
}

export async function acquireGdriveExecution(
  auth: ApiAuth,
  integrationId: string,
  owner: string,
): Promise<GdriveExecution> {
  requireConnectorPrincipal(auth);
  return withTransaction(async () => {
    const row = await lockedAuthority(integrationId, auth.teamId);
    if (row.status !== "enabled") {
      throw new GdriveAuthorityError("connection_unavailable", "Google Drive connection is paused or disconnected", 409);
    }
    const authMode = String(row.config.authMode ?? "oauth");
    if (authMode === "oauth" && !row.secret_ciphertext) {
      throw new GdriveAuthorityError("reconnect_required", "Google Drive connection requires reconnection", 409);
    }
    await assertLiveBoundPrincipal(row, auth);
    await approvedAudience(row);

    const activeOther = row.lease_owner && row.lease_owner !== owner
      && row.lease_until && new Date(row.lease_until).getTime() > Date.now();
    if (activeOther) {
      throw new GdriveAuthorityError("execution_busy", "Google Drive connection already has an active coordinator", 409);
    }
    const replace = row.lease_owner !== owner || !row.lease_until
      || new Date(row.lease_until).getTime() <= Date.now();
    const nextFence = Number(row.fence) + (replace ? 1 : 0);
    const { rows } = await runSql<{ lease_until: string }>(
      `update gdrive_connection_authority
          set lease_owner = $2, fence = $3, lease_until = now() + ($4 * interval '1 second'), updated_at = now()
        where integration_id = $1 returning lease_until`,
      [integrationId, owner, nextFence, LEASE_SECONDS],
    );
    return {
      integrationId,
      teamId: auth.teamId,
      generation: Number(row.generation),
      fence: nextFence,
      owner,
      leaseExpiresAt: rows[0].lease_until,
      scopeHash: row.scope_hash,
      config: row.config,
      progress: row.progress ?? {},
      progressRevision: Number(row.progress_revision),
    };
  });
}

async function assertLockedExecution(auth: ApiAuth, ref: GdriveExecutionRef): Promise<AuthorityRow> {
  requireConnectorPrincipal(auth);
  const row = await lockedAuthority(ref.integrationId, auth.teamId);
  await assertLiveBoundPrincipal(row, auth);
  const current = row.status === "enabled"
    && Number(row.generation) === ref.generation
    && Number(row.fence) === ref.fence
    && row.lease_owner === ref.owner
    && Boolean(row.lease_until)
    && new Date(row.lease_until!).getTime() > Date.now();
  if (!current) throw new GdriveAuthorityError("stale_execution", "Google Drive execution is stale or no longer enabled", 409);
  return row;
}

/**
 * Hold integration + authority row locks through an ingest-owner mutation.
 *
 * This is the head of the Drive commit lock order, shared by ingest and source reconciliation:
 * identity authority and connection authority (`lockedAuthority`), then the bound principal, then
 * the COMPLETE project set (audience plus `scope.projects`), then whatever `fn` takes (provider and
 * path identities, item-attribution advisories, item rows, dependent rows). No project row is
 * acquired or strengthened inside `fn`. A caller that validates an identity revision does so before
 * entering, and already holds the identity authority when it does. Every wait here is bounded; past
 * the bound PostgreSQL raises 55P03 and the commit fails without retry.
 */
export async function withGdriveExecutionCommit<T>(
  auth: ApiAuth,
  ref: GdriveExecutionRef,
  fn: (audience: GdriveApprovedAudience) => Promise<T>,
  scope: GdriveCommitScope = {},
): Promise<T> {
  return withTransaction(async () => {
    const audience = await withBoundedLockWaits(async () => {
      const row = await assertLockedExecution(auth, ref);
      return approvedAudience(row, await scope.projects?.());
    });
    return fn(audience);
  });
}

export async function checkpointGdriveExecution(
  auth: ApiAuth,
  ref: GdriveExecutionRef,
  progress: Record<string, unknown>,
  expectedRevision: number,
): Promise<{ leaseExpiresAt: string; progressRevision: number; progress: Record<string, unknown> }> {
  return withTransaction(async () => {
    const current = await assertLockedExecution(auth, ref);
    const currentRevision = Number(current.progress_revision);
    if (expectedRevision !== currentRevision) {
      const { rows: comparisons } = await runSql<{ same: boolean }>(
        `select ($1::jsonb = $2::jsonb) as same`,
        [JSON.stringify(progress), JSON.stringify(current.progress ?? {})],
      );
      if (expectedRevision < currentRevision && comparisons[0]?.same) {
        return {
          leaseExpiresAt: current.lease_until!,
          progressRevision: currentRevision,
          progress: current.progress ?? {},
        };
      }
      throw new GdriveAuthorityError("stale_progress", "Google Drive progress revision is stale", 409);
    }
    const { rows } = await runSql<{
      lease_until: string; progress_revision: string | number; progress: Record<string, unknown>;
    }>(
      `update gdrive_connection_authority
          set progress = $2::jsonb, progress_updated_at = now(),
              progress_revision = progress_revision + 1,
              lease_until = now() + ($3 * interval '1 second'), updated_at = now()
        where integration_id = $1 and progress_revision = $4
        returning lease_until, progress_revision, progress`,
      [ref.integrationId, JSON.stringify(progress), LEASE_SECONDS, expectedRevision],
    );
    if (!rows[0]) throw new GdriveAuthorityError("stale_progress", "Google Drive progress revision is stale", 409);
    return {
      leaseExpiresAt: rows[0].lease_until,
      progressRevision: Number(rows[0].progress_revision),
      progress: rows[0].progress,
    };
  });
}

/** Live, non-mutating provider-call gate. Renews only the lease; progress remains untouched. */
export async function authorizeGdriveProviderCall(
  auth: ApiAuth,
  ref: GdriveExecutionRef,
): Promise<{ leaseExpiresAt: string }> {
  return withTransaction(async () => {
    await assertLockedExecution(auth, ref);
    const { rows } = await runSql<{ lease_until: string }>(
      `update gdrive_connection_authority
          set lease_until = now() + ($2 * interval '1 second'), updated_at = now()
        where integration_id = $1 returning lease_until`,
      [ref.integrationId, LEASE_SECONDS],
    );
    return { leaseExpiresAt: rows[0].lease_until };
  });
}

/** Publish only a non-secret service-account identity after a real provider request succeeded. */
export async function verifyGdriveServiceAccount(
  auth: ApiAuth,
  ref: GdriveExecutionRef,
  identity: string,
): Promise<void> {
  if (!identity || identity.length > 320) {
    throw new GdriveAuthorityError("connection_unavailable", "invalid service-account identity", 422);
  }
  await withTransaction(async () => {
    const row = await assertLockedExecution(auth, ref);
    if (String(row.config.authMode ?? "oauth") !== "service_account") {
      throw new GdriveAuthorityError("wrong_connection", "Google Drive connection is not in service-account mode", 409);
    }
    const config = validateIntegrationConfig("gdrive", {
      ...row.config,
      serviceAccountStatus: "verified",
      serviceAccountIdentity: identity,
    });
    await runSql(
      `update integrations set config=$2::jsonb,updated_at=now() where id=$1`,
      [ref.integrationId, JSON.stringify(config)],
    );
    await audit(adminClient(), {
      team_id: auth.teamId, actor_kind: "api_key", member_id: auth.memberId,
      action: "gdrive.service_account_verified", target_type: "integration",
      target_id: ref.integrationId, meta: { identity },
    });
  });
}

export async function releaseGdriveExecution(auth: ApiAuth, ref: GdriveExecutionRef): Promise<void> {
  await withTransaction(async () => {
    await assertLockedExecution(auth, ref);
    await runSql(
      `update gdrive_connection_authority set lease_owner = null, lease_until = null, updated_at = now()
        where integration_id = $1`,
      [ref.integrationId],
    );
  });
}

interface StoredOAuthSecret {
  client_id?: string;
  client_secret?: string;
  refresh_token?: string;
  token_uri?: string;
  scopes?: unknown;
  account_subject?: string;
}

export interface GoogleAccessGrant {
  accessToken: string;
  expiresAt: string;
  scopes: string[];
  account: { subject: string; email: string };
}

/** Refresh on the brain and re-check the fence after the network call before releasing a token. */
export async function brokerGoogleAccessToken(auth: ApiAuth, ref: GdriveExecutionRef): Promise<GoogleAccessGrant> {
  const credential = await withTransaction(async () => {
    const row = await assertLockedExecution(auth, ref);
    if (!row.secret_ciphertext) throw new GdriveAuthorityError("reconnect_required", "Google Drive connection requires reconnection", 409);
    let parsed: StoredOAuthSecret;
    try {
      parsed = JSON.parse(decryptSecret(row.secret_ciphertext)) as StoredOAuthSecret;
    } catch {
      throw new GdriveAuthorityError("reconnect_required", "Google Drive connection requires reconnection", 409);
    }
    if (!parsed.client_id || !parsed.client_secret || !parsed.refresh_token) {
      throw new GdriveAuthorityError("reconnect_required", "Google Drive connection requires reconnection", 409);
    }
    return {
      ...parsed,
      email: String(row.config.authenticatedAccount ?? ""),
      subject: String(row.config.authenticatedAccountId ?? parsed.account_subject ?? ""),
      configuredScopes: Array.isArray(row.config.scopeSet) ? row.config.scopeSet.map(String) : [],
    };
  });

  let response: Response;
  try {
    response = await fetch(GOOGLE_TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: credential.client_id!, client_secret: credential.client_secret!,
        refresh_token: credential.refresh_token!, grant_type: "refresh_token",
      }),
      cache: "no-store",
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    throw new GdriveAuthorityError("provider_unavailable", "Google credential refresh is temporarily unavailable", 503);
  }
  const payload = await response.json().catch(() => ({})) as Record<string, unknown>;
  if (!response.ok || typeof payload.access_token !== "string") {
    const revoked = response.status === 400 || response.status === 401;
    await audit((await import("@/lib/db/admin")).adminClient(), {
      team_id: auth.teamId, actor_kind: "api_key", member_id: auth.memberId, api_key_id: auth.apiKeyId,
      action: "gdrive.token_denied", target_type: "integration", target_id: ref.integrationId,
      meta: { generation: ref.generation, fence: ref.fence, revoked },
    });
    throw new GdriveAuthorityError(revoked ? "reconnect_required" : "provider_unavailable", revoked ? "Google Drive connection requires reconnection" : "Google credential refresh is temporarily unavailable", revoked ? 409 : 503);
  }
  // A pause, disconnect, scope change, lease replacement, or key revocation during refresh wins.
  await withTransaction(async () => { await assertLockedExecution(auth, ref); });
  const granted = typeof payload.scope === "string"
    ? payload.scope.split(/\s+/).filter(Boolean)
    : (Array.isArray(credential.scopes) ? credential.scopes.map(String) : credential.configuredScopes);
  const expiresIn = Math.max(1, Math.min(Number(payload.expires_in) || 3600, 3600));
  await audit((await import("@/lib/db/admin")).adminClient(), {
    team_id: auth.teamId, actor_kind: "api_key", member_id: auth.memberId, api_key_id: auth.apiKeyId,
    action: "gdrive.token_issued", target_type: "integration", target_id: ref.integrationId,
    meta: { generation: ref.generation, fence: ref.fence, scopeCount: granted.length, expiresIn },
  });
  return {
    accessToken: payload.access_token,
    expiresAt: new Date(Date.now() + expiresIn * 1000).toISOString(),
    scopes: granted,
    account: { subject: credential.subject, email: credential.email },
  };
}
