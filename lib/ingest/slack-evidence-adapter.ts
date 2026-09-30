import "server-only";

import { composeSlackCreditBatch, type AuthorizedSlackCreditItem } from "@/lib/attribution/slack-credit-batch";
import type { SlackCreditSelection } from "@/lib/attribution/contributor-credit";
import type { SlackItemCreditAuthor, SlackItemCreditLedger } from "./slack-item-credit-ledger-read";
import type { VisibleSlackMessage } from "./slack-message-read";
import { projectScopedSlackPersonDays, type SlackPersonDay } from "./slack-person-day";
import type { SlackEvidenceSnapshot } from "./slack-evidence-snapshot";
import { parseSlackTimestamp } from "./sources/slack-message-evidence";

const RAW_ID = /^[A-Z0-9]+$/;
const SOURCE_ID = /^[^\s:]+$/;

export interface ComposedSlackEvidence {
  creditByItem: Map<string, SlackCreditSelection>;
  personDays: SlackPersonDay[];
}

function sourceKey(workspaceId: string, channelId: string, messageTs: string): string {
  return JSON.stringify([workspaceId, channelId, messageTs]);
}

function matchingAuthor(message: VisibleSlackMessage, author: SlackItemCreditAuthor): boolean {
  return message.workspaceId === author.workspaceId && message.channelId === author.channelId &&
    message.messageTs === author.messageTs && message.rootTs === author.rootTs &&
    message.authorExternalId === author.rawUserId && message.occurredAt === author.occurredAt &&
    message.isRoot === author.isRoot;
}

/**
 * Pure bridge for one completed atomic evidence snapshot and exactly matching, already-authorized
 * item metadata. The caller owns authorization and must recheck visibility and generations before
 * publishing. An eligible visible row must also exist in the same snapshot's full item ledger;
 * ledger authors outside the requested visible time window need not appear in `messages`.
 */
export function composeSlackEvidence(
  snapshot: SlackEvidenceSnapshot,
  items: readonly AuthorizedSlackCreditItem[]
): ComposedSlackEvidence {
  if (!snapshot || !Array.isArray(snapshot.messages)) {
    throw new TypeError("slack evidence adapter: incomplete message snapshot");
  }

  // This also validates team binding, complete ledger states, mapping/roster shape and exact
  // ledger-to-metadata coverage before a visible row can be omitted by the projection.
  const creditByItem = composeSlackCreditBatch(snapshot, items);
  const metadata = new Map(items.map((item) => [item.itemId, item]));
  const ledgers = new Map<string, SlackItemCreditLedger>(snapshot.ledgers.map((ledger) =>
    [ledger.itemId, ledger]));
  const authors = new Map<string, { itemId: string; author: SlackItemCreditAuthor }>();
  for (const ledger of snapshot.ledgers) {
    if (ledger.status !== "present") continue;
    for (const author of ledger.authors) {
      if (!SOURCE_ID.test(author.workspaceId) || !SOURCE_ID.test(author.channelId) ||
          !RAW_ID.test(author.rawUserId) || !parseSlackTimestamp(author.rootTs) ||
          parseSlackTimestamp(author.messageTs)?.iso !== author.occurredAt ||
          author.isRoot !== (author.messageTs === author.rootTs)) {
        throw new Error("slack evidence adapter: invalid ledger author");
      }
      const key = sourceKey(author.workspaceId, author.channelId, author.messageTs);
      if (authors.has(key)) {
        throw new Error("slack evidence adapter: duplicate ledger message");
      }
      authors.set(key, { itemId: ledger.itemId, author });
    }
  }

  const seen = new Set<string>();
  for (const message of snapshot.messages) {
    if (!message || typeof message.itemId !== "string" ||
        typeof message.workspaceId !== "string" || typeof message.channelId !== "string" ||
        typeof message.messageTs !== "string") {
      throw new TypeError("slack evidence adapter: invalid visible message");
    }
    const item = metadata.get(message.itemId);
    const ledger = ledgers.get(message.itemId);
    if (!item || !ledger) {
      throw new Error("slack evidence adapter: visible message outside authorized items");
    }
    if (ledger.status !== "present") {
      throw new Error("slack evidence adapter: visible message without present ledger");
    }
    if (!item.verifiedItemWorkspaceId) {
      throw new Error("slack evidence adapter: missing verified item workspace");
    }
    if (message.workspaceId !== item.verifiedItemWorkspaceId) {
      throw new Error("slack evidence adapter: visible message workspace conflict");
    }
    const key = sourceKey(message.workspaceId, message.channelId, message.messageTs);
    if (seen.has(key)) {
      throw new Error("slack evidence adapter: duplicate visible message");
    }
    seen.add(key);
    const source = authors.get(key);
    if (!source || source.itemId !== message.itemId || !matchingAuthor(message, source.author)) {
      throw new Error("slack evidence adapter: visible message and ledger conflict");
    }
  }

  return { creditByItem, personDays: projectScopedSlackPersonDays({
    teamId: snapshot.teamId, visibleMessages: snapshot.messages, mappings: snapshot.mappings,
    humanMemberIds: snapshot.humanMemberIds, creditByItem,
  }) };
}
