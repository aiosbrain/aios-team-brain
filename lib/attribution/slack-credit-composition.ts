import "server-only";

import { selectSlackCreditIds, type SlackCreditSelection } from "@/lib/attribution/contributor-credit";
import {
  lookupSlackAccount,
  type SlackAccountMapping,
  type SlackLegacyEvidenceReview,
} from "@/lib/identity/resolve";
import type { SlackCutoverDiscovery } from "@/lib/identity/slack-cutover-provenance";
import type { SlackItemCreditLedger } from "@/lib/ingest/slack-item-credit-ledger-read";
import { slackParticipations } from "@/lib/ingest/slack-participants";

/** Inputs are already read for one authorized Slack item. In particular, `ledger` is a completed
 * reader result, never a fallback value made from a caught read failure. The roster set must contain
 * only current, team-scoped human member IDs (no connectors or other nonhuman members). */
export interface SlackCreditCompositionInput {
  teamId: string;
  itemId: string;
  ledger: SlackItemCreditLedger;
  frontmatter?: Record<string, unknown> | null;
  locked: boolean;
  currentMemberId: string | null;
  legacyVersionMemberIds: readonly string[];
  legacyLatestWorkerId: string | null;
  /** Verified separately from the item's source; frontmatter.workspace_id is never proof. */
  verifiedItemWorkspaceId?: string;
  mappings: readonly SlackAccountMapping[];
  discovery?: SlackCutoverDiscovery;
  legacyEvidenceReview?: SlackLegacyEvidenceReview;
  humanMemberIds: ReadonlySet<string>;
}

/** Pure composition of source evidence, current exact identity mappings and the shared credit rule.
 * Message order comes from the completed reader; participant order comes from the shared parser.
 * Unresolved or nonhuman authors retain their place as null evidence. No lookup status, raw account,
 * frontmatter value, email or token is returned. */
export function composeSlackCreditSelection(input: SlackCreditCompositionInput): SlackCreditSelection {
  if (input.ledger.itemId !== input.itemId) {
    throw new Error("slack credit composition: ledger item ID mismatch");
  }
  if (input.ledger.status !== "present" && input.ledger.status !== "absent") {
    throw new TypeError("slack credit composition: incomplete ledger result");
  }
  // A completed ledger can prove presence without eligible authors. When authors exist, their
  // source workspace must agree with separately verified item provenance before any lookup or lock.
  if (input.ledger.status === "present" && input.verifiedItemWorkspaceId !== undefined &&
      input.ledger.authors.some((author) => author.workspaceId !== input.verifiedItemWorkspaceId)) {
    throw new Error("slack credit composition: item provenance conflict");
  }

  const hasParticipants = input.frontmatter != null &&
    Object.prototype.hasOwnProperty.call(input.frontmatter, "participants");
  // Legacy frontmatter does not establish provenance, but a contradictory workspace invalidates
  // its participant evidence when the item's workspace was independently verified.
  if (input.ledger.status === "absent" && hasParticipants &&
      input.verifiedItemWorkspaceId !== undefined &&
      typeof input.frontmatter?.workspace_id === "string" &&
      input.frontmatter.workspace_id !== input.verifiedItemWorkspaceId) {
    throw new Error("slack credit composition: item provenance conflict");
  }

  const human = (memberId: string | null): string | null =>
    memberId !== null && input.humanMemberIds.has(memberId) ? memberId : null;
  const resolveAuthor = (externalId: string, verifiedItemWorkspaceId?: string): string | null => {
    const result = lookupSlackAccount({
      teamId: input.teamId,
      externalId,
      verifiedItemWorkspaceId,
      mappings: input.mappings,
      discovery: input.discovery,
      legacyEvidenceReview: input.legacyEvidenceReview,
    });
    return human(result.memberId);
  };

  const messageLedger = input.ledger.status === "present"
    ? {
      status: "present" as const,
      resolvedHumanMemberIds: input.ledger.authors.map((author) =>
        resolveAuthor(author.rawUserId, author.workspaceId)),
    }
    : { status: "absent" as const };

  const participants = input.ledger.status === "absent" && hasParticipants
    ? {
      status: "present" as const,
      // This adapter is for an already identified Slack item. The parser still validates the
      // participants array and orders valid entries; source is not workspace verification.
      resolvedHumanMemberIds: slackParticipations({ ...input.frontmatter, source: "slack" })
        .map((participant) => {
          // A qualifier inside legacy frontmatter is itself unverified provenance. Without a
          // separately verified item workspace, only plain IDs can use the historical proof path.
          if (!input.verifiedItemWorkspaceId && participant.authorId.includes(":")) return null;
          return resolveAuthor(participant.authorId, input.verifiedItemWorkspaceId);
        }),
    }
    : { status: "absent" as const };

  return selectSlackCreditIds({
    locked: input.locked,
    currentMemberId: human(input.currentMemberId),
    messageLedger,
    participants,
    legacyVersionMemberIds: input.legacyVersionMemberIds
      .map((memberId) => human(memberId))
      .filter((memberId): memberId is string => memberId !== null),
    legacyLatestWorkerId: human(input.legacyLatestWorkerId),
  });
}
