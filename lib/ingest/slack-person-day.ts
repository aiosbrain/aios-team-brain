import type { SlackCreditSelection } from "@/lib/attribution/contributor-credit";
import { lookupSlackAccount, type SlackAccountMapping } from "@/lib/identity/resolve";
import type { VisibleSlackMessage } from "./slack-message-read";
import { parseSlackTimestamp } from "./sources/slack-message-evidence";

/** One eligible source message, retained so a later authorized view can build a source link. */
export interface SlackPersonDayMessage {
  messageTs: string;
  occurredAt: string;
}

/** Factual message evidence only; the caller still applies the shared credit/lock oracle. */
export interface SlackPersonDay {
  /** Stable across identity display changes and later replies. */
  id: string;
  sourceItemId: string;
  workspaceId: string;
  channelId: string;
  rootTs: string;
  memberId: string;
  day: string;
  /** Latest actual message instant, including microseconds. */
  at: string;
  messageCount: number;
  /** True only when this member authored a surviving root on this day. */
  rootAuthored: boolean;
  messages: SlackPersonDayMessage[];
}

/** Return null for unmapped or ambiguous accounts. Errors propagate; no other identity is tried. */
export type ResolveSlackAuthor = (qualifiedAuthorId: string, verifiedWorkspaceId: string) => string | null;

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

const UTC_MICROSECOND = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;

/**
 * Project the complete visible ledger read into (canonical item/thread, member, UTC day).
 * The resolver must use the current canonical workspace-qualified mapping. This inactive helper
 * does not consult raw Slack IDs, item owners, versions, access, or the active timeline.
 */
export function projectSlackPersonDays(
  messages: readonly VisibleSlackMessage[],
  resolveAuthor: ResolveSlackAuthor
): SlackPersonDay[] {
  const threads = new Map<string, string>();
  const groups = new Map<string, SlackPersonDay>();
  const seen = new Map<string, string>();

  for (const message of messages) {
    if (!UTC_MICROSECOND.test(message.occurredAt) ||
        parseSlackTimestamp(message.messageTs)?.iso !== message.occurredAt ||
        !message.itemId || !message.workspaceId || !message.channelId ||
        !message.rootTs || !message.messageTs || !message.authorExternalId) {
      throw new Error("slack person-day: invalid source message");
    }
    const thread = JSON.stringify([message.workspaceId, message.channelId, message.rootTs]);
    const priorThread = threads.get(message.itemId);
    if (priorThread && priorThread !== thread) {
      throw new Error("slack person-day: canonical item has conflicting thread identity");
    }
    threads.set(message.itemId, thread);

    // A read returns each ledger key once. Identical repeated inputs remain one message;
    // conflicting repetitions fail instead of making order determine authorship or counts.
    const sourceKey = JSON.stringify([message.workspaceId, message.channelId, message.messageTs]);
    const fingerprint = JSON.stringify([message.itemId, message.workspaceId, message.channelId,
      message.messageTs, message.rootTs, message.authorExternalId, message.occurredAt, message.isRoot]);
    const prior = seen.get(sourceKey);
    if (prior !== undefined) {
      if (prior !== fingerprint) throw new Error("slack person-day: conflicting source message");
      continue;
    }
    seen.set(sourceKey, fingerprint);

    const memberId = resolveAuthor(`${message.workspaceId}:${message.authorExternalId}`, message.workspaceId);
    if (!memberId) continue;
    const day = message.occurredAt.slice(0, 10);
    const id = JSON.stringify([message.itemId, memberId, day]);
    let group = groups.get(id);
    if (!group) {
      group = { id, sourceItemId: message.itemId, workspaceId: message.workspaceId,
        channelId: message.channelId, rootTs: message.rootTs, memberId, day,
        at: message.occurredAt, messageCount: 0, rootAuthored: false, messages: [] };
      groups.set(id, group);
    }
    group.messageCount++;
    if (message.occurredAt > group.at) group.at = message.occurredAt;
    if (message.isRoot && message.messageTs === message.rootTs) group.rootAuthored = true;
    group.messages.push({ messageTs: message.messageTs, occurredAt: message.occurredAt });
  }

  return [...groups.values()].map((group) => ({
    ...group,
    messages: group.messages.sort((a, b) =>
      compare(a.occurredAt, b.occurredAt) || compare(a.messageTs, b.messageTs)),
  })).sort((a, b) =>
    compare(b.day, a.day) || compare(b.at, a.at) ||
    compare(a.sourceItemId, b.sourceItemId) || compare(a.memberId, b.memberId));
}

export interface SlackScopedPersonDayInput {
  teamId: string;
  /** A completed readVisibleSlackMessages result for item IDs authorized by the current
   * visibility oracle. This pure adapter does not authorize items or recover failed pages. */
  visibleMessages: readonly VisibleSlackMessage[];
  /** Current team-scoped live identity snapshot, read with the current human roster. */
  mappings: readonly SlackAccountMapping[];
  humanMemberIds: ReadonlySet<string>;
  /** Completed shared selector/composition result per item. An absent entry excludes that item. */
  creditByItem: ReadonlyMap<string, SlackCreditSelection>;
}

function validSelection(value: unknown): value is SlackCreditSelection {
  if (typeof value !== "object" || value === null) return false;
  const selection = value as Partial<SlackCreditSelection>;
  if (selection.kind !== "verified_message_ledger_present" &&
      selection.kind !== "structured_participants_present" &&
      selection.kind !== "legacy_partial") return false;
  if (!Object.prototype.hasOwnProperty.call(selection, "creditIds")) return false;
  if (selection.creditIds === null) return true;
  const credit = selection.creditIds;
  return typeof credit === "object" && credit !== null &&
    Array.isArray(credit.contributorIds) &&
    credit.contributorIds.every((id: unknown) => typeof id === "string" && id.length > 0) &&
    (credit.primaryId === null || typeof credit.primaryId === "string" && credit.primaryId.length > 0);
}

/** Factual source-message days limited by the shared item credit decision. A correction lock
 * therefore suppresses other authors; it never assigns their source messages to the owner.
 * The future caller must authorize source items and revalidate visibility/generations at publish. */
export function projectScopedSlackPersonDays(input: SlackScopedPersonDayInput): SlackPersonDay[] {
  if (!input || typeof input.teamId !== "string" || !input.teamId ||
      !Array.isArray(input.visibleMessages) || !Array.isArray(input.mappings) ||
      !(input.humanMemberIds instanceof Set) || !(input.creditByItem instanceof Map)) {
    throw new TypeError("slack person-day: incomplete projection input");
  }
  for (const [itemId, selection] of input.creditByItem) {
    if (typeof itemId !== "string" || !itemId || !validSelection(selection)) {
      throw new TypeError("slack person-day: invalid credit selection");
    }
  }

  const days = projectSlackPersonDays(input.visibleMessages, (qualifiedAuthorId, verifiedWorkspaceId) => {
    const result = lookupSlackAccount({ teamId: input.teamId, externalId: qualifiedAuthorId,
      verifiedItemWorkspaceId: verifiedWorkspaceId, mappings: input.mappings });
    return result.memberId && input.humanMemberIds.has(result.memberId) ? result.memberId : null;
  });
  return days.filter((day) => {
    const selection = input.creditByItem.get(day.sourceItemId);
    return selection?.kind === "verified_message_ledger_present" &&
      (selection.creditIds?.contributorIds.includes(day.memberId) ?? false);
  });
}
