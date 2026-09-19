import type { TransactionSession } from "@/lib/db/types";
import {
  parseSlackTimestamp,
  type SlackEvidenceProjection,
  type SlackMessageEvidence,
} from "./sources/slack-message-evidence";

/** Inactive source-owned ledger operations. The later publication gate supplies the verified scope. */
export interface CompleteSlackThreadEvidence {
  teamId: string;
  workspaceId: string;
  channelId: string;
  rootTs: string;
  itemId: string;
  complete: true;
  projection: SlackEvidenceProjection;
}

export interface SlackTeamGenerations {
  dataGeneration: string;
  identityGeneration: string;
}

type StoredMessage = {
  message_ts: string;
  root_ts: string;
  item_id: string;
  author_external_id: string | null;
  occurred_at_exact: string | null;
  is_root: boolean;
  eligible: boolean;
  exclusion_reason: string | null;
  source_hash: string;
  deleted: boolean;
};

function requireId(value: string, field: string): void {
  if (typeof value !== "string" || !value || /\s|:/.test(value)) {
    throw new TypeError(`slack ledger: invalid ${field}`);
  }
}

function requireUuid(value: string, field: string): void {
  if (typeof value !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) {
    throw new TypeError(`slack ledger: invalid ${field}`);
  }
}

function validate(input: CompleteSlackThreadEvidence): readonly SlackMessageEvidence[] {
  if (input?.complete !== true) throw new Error("slack ledger: incomplete thread snapshot");
  requireUuid(input.teamId, "teamId");
  requireUuid(input.itemId, "itemId");
  requireId(input.workspaceId, "workspaceId");
  requireId(input.channelId, "channelId");
  if (typeof input.rootTs !== "string" || !input.rootTs.trim()) {
    throw new TypeError("slack ledger: invalid rootTs");
  }
  const projection = input.projection;
  if (!projection || !Array.isArray(projection.messages) || projection.unidentifiableCount !== 0 ||
      !Number.isSafeInteger(projection.duplicateCount) || projection.duplicateCount < 0) {
    throw new Error("slack ledger: incomplete or inconsistent projection");
  }
  const ids = new Set<string>();
  let roots = 0;
  for (const row of projection.messages) {
    if (!row || row.workspaceId !== input.workspaceId || row.channelId !== input.channelId ||
        row.rootTs !== input.rootTs || row.messageId !== `${input.workspaceId}:${input.channelId}:${row.messageTs}` ||
        typeof row.messageTs !== "string" || !row.messageTs.trim() || ids.has(row.messageTs) ||
        row.isRoot !== (row.messageTs === input.rootTs) ||
        row.qualifiedAuthorId !== (row.authorExternalId ? `${input.workspaceId}:${row.authorExternalId}` : null) ||
        !/^[0-9a-f]{64}$/.test(row.sourceHash)) {
      throw new Error("slack ledger: projection scope, root or identity mismatch");
    }
    const instant = parseSlackTimestamp(row.messageTs);
    if (row.occurredAt !== (instant?.iso ?? null) || row.contributionDay !== (instant?.day ?? null) ||
        (row.status === "eligible") !== (row.reason === null) ||
        (instant === null) !== (row.reason === "invalid_timestamp") ||
        !["eligible", "excluded", "unresolved"].includes(row.status) ||
        (row.status === "unresolved") !== (["author_unclassified", "future_timestamp"].includes(row.reason ?? ""))) {
      throw new Error("slack ledger: inconsistent evidence verdict or instant");
    }
    ids.add(row.messageTs);
    if (row.isRoot) roots++;
  }
  if (roots !== 1) throw new Error("slack ledger: complete thread must contain its root exactly once");
  return projection.messages;
}

/** Indexed PK read. A missing pre-activation row is zero; a SQL failure propagates. */
export async function readSlackTeamGenerations(
  session: TransactionSession,
  teamId: string
): Promise<SlackTeamGenerations> {
  requireUuid(teamId, "teamId");
  const { rows } = await session.executeSql<{ data_generation: string; identity_generation: string }>(
    `select data_generation::text, identity_generation::text
       from slack_team_state where team_id = $1`,
    [teamId]
  );
  return rows[0]
    ? { dataGeneration: rows[0].data_generation, identityGeneration: rows[0].identity_generation }
    : { dataGeneration: "0", identityGeneration: "0" };
}

async function bumpGeneration(
  session: TransactionSession,
  teamId: string,
  column: "data_generation" | "identity_generation"
): Promise<string> {
  requireUuid(teamId, "teamId");
  // `column` is a closed internal union, never caller SQL. The upsert serializes competing bumps.
  const { rows } = await session.executeSql<{ generation: string }>(
    `insert into slack_team_state (team_id, ${column}) values ($1, 1)
       on conflict (team_id) do update set
         ${column} = slack_team_state.${column} + 1,
         updated_at = clock_timestamp()
       returning ${column}::text as generation`,
    [teamId]
  );
  if (rows.length !== 1) throw new Error("slack ledger: generation bump returned no row");
  return rows[0].generation;
}

/** Future canonical identity writers call this in their own transaction after a real mapping change. */
export async function bumpSlackIdentityGeneration(
  session: TransactionSession,
  teamId: string
): Promise<string> {
  return bumpGeneration(session, teamId, "identity_generation");
}

function changed(stored: StoredMessage | undefined, row: SlackMessageEvidence, itemId: string): boolean {
  return !stored || stored.deleted || stored.root_ts !== row.rootTs || stored.item_id !== itemId ||
    stored.author_external_id !== row.authorExternalId || stored.occurred_at_exact !== row.occurredAt ||
    stored.is_root !== row.isRoot || stored.eligible !== (row.status === "eligible") ||
    stored.exclusion_reason !== row.reason || stored.source_hash !== row.sourceHash;
}

/**
 * Reconcile one verified complete thread, in the caller's transaction. This is deliberately
 * unreachable from active ingestion until the publication gate and item transaction are wired.
 */
export async function reconcileCompleteSlackThreadEvidence(
  session: TransactionSession,
  input: CompleteSlackThreadEvidence
): Promise<{ changed: boolean; dataGeneration: string }> {
  const evidence = validate(input);
  // An item can belong to only one team and one Slack thread. Lock it before the team writer lock
  // so two workers racing with the same item cannot bind it to different roots.
  const item = await session.executeSql<{ team_id: string }>(
    `select team_id from items where id = $1 for update`, [input.itemId]
  );
  if (item.rows.length !== 1 || item.rows[0].team_id !== input.teamId) {
    throw new Error("slack ledger: item is not in the requested team");
  }
  // Serializes snapshots for a team, including first publication with no existing ledger rows.
  // A hash collision only causes additional serialization; it cannot merge identities.
  await session.executeSql(
    `select pg_advisory_xact_lock(hashtextextended($1, 0))`,
    [`slack-message-ledger:${input.teamId}`]
  );
  const { rows: itemBindings } = await session.executeSql<{
    workspace_id: string; channel_id: string; root_ts: string;
  }>(`select workspace_id, channel_id, root_ts from slack_messages
       where team_id = $1 and item_id = $2 for update`, [input.teamId, input.itemId]);
  if (itemBindings.some((row) => row.workspace_id !== input.workspaceId ||
      row.channel_id !== input.channelId || row.root_ts !== input.rootTs)) {
    throw new Error("slack ledger: item is already bound to another thread");
  }
  const { rows: existing } = await session.executeSql<StoredMessage>(
    `select message_ts, root_ts, item_id, author_external_id,
            to_char(occurred_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as occurred_at_exact,
            is_root, eligible, exclusion_reason, source_hash, (deleted_at is not null) as deleted
       from slack_messages
      where team_id = $1 and workspace_id = $2 and channel_id = $3 and root_ts = $4
      for update`,
    [input.teamId, input.workspaceId, input.channelId, input.rootTs]
  );
  if (existing.some((row) => row.item_id !== input.itemId)) {
    throw new Error("slack ledger: thread is already bound to another item");
  }
  const { rows: conflictingIds } = await session.executeSql<{ message_ts: string }>(
    `select message_ts from slack_messages
      where team_id = $1 and workspace_id = $2 and channel_id = $3
        and message_ts = any($4::text[]) and (root_ts <> $5 or item_id <> $6)
      for update`,
    [input.teamId, input.workspaceId, input.channelId, evidence.map((row) => row.messageTs),
      input.rootTs, input.itemId]
  );
  if (conflictingIds.length) throw new Error("slack ledger: message is bound to another thread");
  const byId = new Map(existing.map((row) => [row.message_ts, row]));
  const seen = new Set(evidence.map((row) => row.messageTs));
  const semanticChange = evidence.some((row) => changed(byId.get(row.messageTs), row, input.itemId)) ||
    existing.some((row) => !seen.has(row.message_ts) && !row.deleted);
  const generation = semanticChange
    ? await bumpGeneration(session, input.teamId, "data_generation")
    : (await readSlackTeamGenerations(session, input.teamId)).dataGeneration;

  for (const row of evidence) {
    await session.executeSql(
      `insert into slack_messages
         (team_id, workspace_id, channel_id, message_ts, root_ts, item_id,
          author_external_id, occurred_at, is_root, eligible, exclusion_reason,
          source_hash, last_seen_generation, observed_at)
       values ($1,$2,$3,$4,$5,$6,$7,$8::timestamptz,$9,$10,$11,$12,$13::bigint,clock_timestamp())
       on conflict (team_id,workspace_id,channel_id,message_ts) do update set
         root_ts = excluded.root_ts, item_id = excluded.item_id,
         author_external_id = excluded.author_external_id, occurred_at = excluded.occurred_at,
         is_root = excluded.is_root, eligible = excluded.eligible,
         exclusion_reason = excluded.exclusion_reason, source_hash = excluded.source_hash,
         deleted_at = null, last_seen_generation = excluded.last_seen_generation,
         observed_at = excluded.observed_at`,
      [input.teamId, input.workspaceId, input.channelId, row.messageTs, row.rootTs, input.itemId,
        row.authorExternalId, row.occurredAt, row.isRoot, row.status === "eligible", row.reason,
        row.sourceHash, generation]
    );
  }
  await session.executeSql(
    `update slack_messages set deleted_at = clock_timestamp()
      where team_id = $1 and workspace_id = $2 and channel_id = $3 and root_ts = $4
        and not (message_ts = any($5::text[])) and deleted_at is null`,
    [input.teamId, input.workspaceId, input.channelId, input.rootTs, [...seen]]
  );
  return { changed: semanticChange, dataGeneration: generation };
}
