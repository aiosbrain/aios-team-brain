import "server-only";

import { isDeepStrictEqual } from "node:util";
import type { ItemPayload } from "@/lib/api/schemas";
import type { TransactionSession } from "@/lib/db/types";
import { lockReadySlackNamespaceGate } from "./slack-namespace-gate";
import { lockSlackSelection, type SlackBindingRef } from "./slack-source-binding";
import { bumpSlackPresentationIfChanged, reconcileCompleteSlackThreadEvidence, type PriorSlackPresentation } from "./slack-message-ledger";
import type { SlackThreadClaim } from "./slack-thread-state";
import { normalizeThread } from "./sources/slack-normalize";
import { projectSlackMessageEvidence, parseSlackTimestamp, type SlackEvidenceUser, type SlackEvidenceProjection } from "./sources/slack-message-evidence";
import { scopedSlackItemPath } from "./sources/slack-namespace";
import type { SlackMessage } from "./sources/slack";

/** Inactive internal seam. A claim is only a locator; every authority is checked again in SQL. */
const publicationBrand: unique symbol = Symbol("slack-publication");
const issuedPublicationOptions = new WeakSet<object>();
export interface SlackPublicationOption {
  readonly [publicationBrand]: true;
  readonly claim: SlackThreadClaim;
  readonly binding: SlackBindingRef;
  readonly namespaceRevision: number;
  readonly channelName: string;
  /** A missing or partial directory record NEVER classifies an author as human. */
  readonly users: Readonly<Record<string, SlackEvidenceUser>>;
}

/** For a future source worker only. No runner, route, scheduler or action calls this factory. */
export function slackPublicationOption(input: Omit<SlackPublicationOption, typeof publicationBrand>): SlackPublicationOption {
  if (!input?.claim?.scope || !input.binding ||
      !Number.isSafeInteger(input.namespaceRevision) || input.namespaceRevision < 0 ||
      typeof input.channelName !== "string" || !input.channelName.trim() ||
      !input.users || typeof input.users !== "object" || Array.isArray(input.users)) {
    throw new TypeError("slack publication: invalid internal option");
  }
  // Capture one immutable request. The caller may continue its next provider read while ingestItem
  // awaits SQL; changing a claim or directory object then must not retarget this transaction.
  const option = Object.freeze({
    ...input,
    claim: Object.freeze({ ...input.claim, scope: Object.freeze({ ...input.claim.scope }) }),
    binding: Object.freeze({ ...input.binding }),
    users: Object.freeze(Object.fromEntries(Object.entries(input.users).map(([id, user]) =>
      [id, Object.freeze({ ...user })]))),
    [publicationBrand]: true as const,
  });
  issuedPublicationOptions.add(option);
  return option;
}

/** Only options issued by this factory can enter the publication transaction. */
export function isSlackPublicationOption(value: unknown): value is SlackPublicationOption {
  return typeof value === "object" && value !== null && issuedPublicationOptions.has(value);
}

export interface PreparedSlackPublication {
  readonly option: SlackPublicationOption;
  readonly projection: SlackEvidenceProjection;
}

function refuse(): never { throw new Error("slack publication: authority or complete snapshot refused"); }

/** Gate first; all subsequent locks and checks remain in ingestItem's one TransactionSession. */
export async function prepareSlackPublication(
  session: TransactionSession,
  teamId: string,
  payload: ItemPayload,
  option: SlackPublicationOption,
): Promise<PreparedSlackPublication> {
  if (!isSlackPublicationOption(option)) refuse();
  const { claim, binding } = option;
  const { scope } = claim;
  if (!scope || scope.teamId !== teamId || binding.teamId !== teamId ||
      !binding.integrationId || !binding.configRevision || !binding.tokenFingerprint) refuse();
  const path = scopedSlackItemPath(scope.workspaceId, scope.channelId, scope.rootTs);
  if (payload.path !== path || payload.kind !== "transcript" || payload.access !== "team" ||
      payload.frontmatter?.source !== "slack" ||
      payload.frontmatter?.workspace_id !== scope.workspaceId ||
      payload.frontmatter?.channel_id !== scope.channelId ||
      payload.frontmatter?.ts !== scope.rootTs ||
      payload.frontmatter?.thread_ts !== scope.rootTs) refuse();

  const gate = await lockReadySlackNamespaceGate(session, {
    teamId, rawChannelId: scope.channelId, workspaceId: scope.workspaceId,
    expectedRevision: option.namespaceRevision,
  });
  if (gate.outcome !== "locked") refuse();

  const current = await lockSlackSelection(session, { teamId, integrationId: binding.integrationId });
  if (current.outcome !== "current" || current.selection.configRevision !== binding.configRevision ||
      current.selection.tokenFingerprint !== binding.tokenFingerprint ||
      !current.selection.channelIds.includes(scope.channelId)) refuse();

  // Lock the binding and channel proof, so revocation cannot commit behind this check.
  const bound = await session.executeSql<{
    state: string; config_revision: string; token_fingerprint: string;
    workspace_id: string | null; app_id: string | null; selected_channel_ids: string[];
  }>(`select state,config_revision,token_fingerprint,workspace_id,app_id,selected_channel_ids
        from slack_integration_bindings where team_id=$1 and integration_id=$2 for update`,
    [teamId, binding.integrationId]);
  const b = bound.rows[0];
  if (bound.rows.length !== 1 || b.state !== "verified" || !b.app_id ||
      b.workspace_id !== scope.workspaceId || b.config_revision !== binding.configRevision ||
      b.token_fingerprint !== binding.tokenFingerprint ||
      !b.selected_channel_ids.includes(scope.channelId)) refuse();
  const channel = await session.executeSql<{
    binding_integration_id: string | null; binding_config_revision: string | null;
    public_state: string; public_checked_at: Date | null;
  }>(`select binding_integration_id,binding_config_revision,public_state,public_checked_at
        from slack_sync_channels where team_id=$1 and workspace_id=$2 and channel_id=$3 for update`,
    [teamId, scope.workspaceId, scope.channelId]);
  const c = channel.rows[0];
  if (channel.rows.length !== 1 || c.binding_integration_id !== binding.integrationId ||
      c.binding_config_revision !== binding.configRevision || c.public_state !== "public" ||
      !c.public_checked_at) refuse();

  // This row lock prevents reclaim/checkpoint while the item is being written. The clock checks
  // also refuse a lease which expired without any replacement worker.
  const owner = await session.executeSql<{ page_cursor: string | null }>(
    `select page_cursor from slack_sync_threads
      where team_id=$1 and workspace_id=$2 and channel_id=$3 and root_ts=$4
        and status='running' and lease_owner=$5 and lease_generation=$6::bigint
        and snapshot_generation=$7::bigint and lease_expires_at>clock_timestamp()
      for update`,
    [teamId, scope.workspaceId, scope.channelId, scope.rootTs, claim.leaseOwner,
      String(claim.leaseGeneration), String(claim.snapshotGeneration)]);
  if (owner.rows.length !== 1 || owner.rows[0].page_cursor !== null) refuse();
  const staged = await session.executeSql<{ messages: unknown; complete: boolean }>(
    `select messages,complete from slack_thread_snapshots
      where team_id=$1 and workspace_id=$2 and channel_id=$3 and root_ts=$4
        and snapshot_generation=$5::bigint and expires_at>clock_timestamp()
      for update`,
    [teamId, scope.workspaceId, scope.channelId, scope.rootTs, String(claim.snapshotGeneration)]);
  if (staged.rows.length !== 1 || staged.rows[0].complete !== true ||
      !Array.isArray(staged.rows[0].messages) || !staged.rows[0].messages.length) refuse();
  const raw = staged.rows[0].messages as unknown[];
  if (!raw.every((m): m is SlackMessage => !!m && typeof m === "object" &&
      typeof (m as SlackMessage).ts === "string" && !!parseSlackTimestamp((m as SlackMessage).ts) &&
      ((m as SlackMessage).thread_ts === undefined || (m as SlackMessage).thread_ts === scope.rootTs)) ||
      (raw[0] as SlackMessage).ts !== scope.rootTs ||
      raw.slice(1).some((m) => (m as SlackMessage).ts === scope.rootTs ||
        (m as SlackMessage).thread_ts !== scope.rootTs)) refuse();
  const messages = raw as SlackMessage[];
  if (new Set(messages.map((m) => m.ts)).size !== messages.length) refuse();
  const clock = await session.executeSql<{ now: Date | string }>("select clock_timestamp() as now");
  if (clock.rows.length !== 1) refuse();
  const now = new Date(clock.rows[0].now);
  if (Number.isNaN(now.getTime())) refuse();
  const projection = projectSlackMessageEvidence(messages, {
    scope: { workspaceId: scope.workspaceId, channelId: scope.channelId },
    now, users: option.users,
  });
  if (projection.unidentifiableCount !== 0 || projection.messages.length < 1) refuse();
  const displayUsers = Object.fromEntries(Object.entries(option.users).map(([id, user]) =>
    [id, user.displayName ?? id]));
  const rendered = normalizeThread({ root: messages[0], replies: messages.slice(1) }, {
    channelId: scope.channelId, channelName: option.channelName, users: displayUsers,
    project: payload.project,
  });
  const expectedFrontmatter = {
    ...rendered.frontmatter, workspace_id: scope.workspaceId,
    source_ts: parseSlackTimestamp(scope.rootTs)!.iso,
  };
  if (payload.body !== rendered.body || payload.actor !== rendered.actor ||
      !isDeepStrictEqual(payload.frontmatter, expectedFrontmatter)) refuse();
  return { option, projection };
}

/** Called after item and ledger succeed, still inside their transaction. FK cascade removes staging. */
export async function finishSlackPublication(
  session: TransactionSession, prepared: PreparedSlackPublication, itemId: string,
  priorPresentation: PriorSlackPresentation | null,
): Promise<void> {
  const { option, projection } = prepared;
  const { claim } = option;
  const { scope } = claim;
  await reconcileCompleteSlackThreadEvidence(session, {
    teamId: scope.teamId, workspaceId: scope.workspaceId, channelId: scope.channelId,
    rootTs: scope.rootTs, itemId, complete: true, projection,
  });
  await bumpSlackPresentationIfChanged(session, scope.teamId, itemId, priorPresentation);
  const ack = await session.executeSql(
    `delete from slack_sync_threads t where t.team_id=$1 and t.workspace_id=$2
       and t.channel_id=$3 and t.root_ts=$4 and t.status='running'
       and t.lease_owner=$5 and t.lease_generation=$6::bigint
       and t.snapshot_generation=$7::bigint and t.page_cursor is null
       and t.lease_expires_at>clock_timestamp()
       and exists (select 1 from slack_thread_snapshots s
          where s.team_id=t.team_id and s.workspace_id=t.workspace_id
            and s.channel_id=t.channel_id and s.root_ts=t.root_ts
            and s.snapshot_generation=t.snapshot_generation and s.complete
            and s.expires_at>clock_timestamp())
       returning t.team_id`,
    [scope.teamId, scope.workspaceId, scope.channelId, scope.rootTs, claim.leaseOwner,
      String(claim.leaseGeneration), String(claim.snapshotGeneration)]);
  if (ack.rows.length !== 1) refuse();
}
