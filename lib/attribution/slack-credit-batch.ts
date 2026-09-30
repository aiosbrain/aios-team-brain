import "server-only";

import { composeSlackCreditSelection, type SlackCreditCompositionInput } from "./slack-credit-composition";
import type { SlackCreditSelection } from "./contributor-credit";
import type { SlackCreditInputSnapshot } from "@/lib/ingest/slack-credit-input-snapshot";
import type { SlackItemCreditLedger } from "@/lib/ingest/slack-item-credit-ledger-read";

/** Each row is one already-authorized Slack item with provenance verified outside this adapter.
 * The caller must pass the completed snapshot for exactly these items, propagate read failures,
 * and recheck item visibility and generations before publishing or caching the selections.
 * A present ledger with authors requires a separately verified item workspace. An omitted
 * workspace is allowed only when there are no source authors to compare.
 */
export interface AuthorizedSlackCreditItem extends Pick<SlackCreditCompositionInput,
  "teamId" | "itemId" | "locked" | "currentMemberId" |
  "legacyVersionMemberIds" | "legacyLatestWorkerId" | "verifiedItemWorkspaceId" |
  "discovery" | "legacyEvidenceReview"> {
  source: "slack";
  /** Explicit null means the verified item has no structured legacy metadata. */
  frontmatter: Record<string, unknown> | null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const nonempty = (value: unknown): value is string => typeof value === "string" && value.length > 0;
const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const nullableId = (value: unknown): boolean => value === null || nonempty(value);
const generation = (value: unknown): boolean => typeof value === "string" && /^(0|[1-9][0-9]*)$/.test(value);

function validLedger(value: unknown): value is SlackItemCreditLedger {
  if (!record(value) || !nonempty(value.itemId) || !UUID.test(value.itemId)) return false;
  if (value.status === "absent") return !Object.prototype.hasOwnProperty.call(value, "authors");
  if (value.status !== "present" || !Array.isArray(value.authors)) return false;
  let binding: { workspaceId: string; channelId: string; rootTs: string } | null = null;
  for (const author of value.authors) {
    if (!record(author) || !nonempty(author.workspaceId) || !nonempty(author.channelId) ||
        !nonempty(author.rootTs) || !nonempty(author.messageTs) || !nonempty(author.rawUserId) ||
        !nonempty(author.occurredAt) || typeof author.isRoot !== "boolean") return false;
    if (binding !== null && (binding.workspaceId !== author.workspaceId ||
        binding.channelId !== author.channelId || binding.rootTs !== author.rootTs)) return false;
    binding = { workspaceId: author.workspaceId, channelId: author.channelId, rootTs: author.rootTs };
  }
  return true;
}

/** Pure bridge from one completed team snapshot to shared per-item credit composition.
 * Every ledger and metadata ID must match exactly once; absence is never inferred from a gap.
 */
export function composeSlackCreditBatch(
  snapshot: SlackCreditInputSnapshot,
  items: readonly AuthorizedSlackCreditItem[]
): Map<string, SlackCreditSelection> {
  if (!record(snapshot) || !nonempty(snapshot.teamId) || !UUID.test(snapshot.teamId) ||
      !Array.isArray(snapshot.ledgers) || !Array.isArray(snapshot.mappings) ||
      !(snapshot.humanMemberIds instanceof Set) || !record(snapshot.generations) ||
      !generation(snapshot.generations.dataGeneration) ||
      !generation(snapshot.generations.identityGeneration) ||
      !generation(snapshot.generations.presentationGeneration) || !Array.isArray(items)) {
    throw new TypeError("slack credit batch: incomplete snapshot or item list");
  }
  if ([...snapshot.humanMemberIds].some((id) => !nonempty(id)) ||
      snapshot.mappings.some((mapping) => !record(mapping) || mapping.teamId !== snapshot.teamId ||
        !nonempty(mapping.provider) || !nonempty(mapping.externalId) ||
        !nonempty(mapping.memberId) || mapping.state !== "live")) {
    throw new Error("slack credit batch: invalid team roster or mapping");
  }

  const ledgers = new Map<string, SlackItemCreditLedger>();
  for (const ledger of snapshot.ledgers) {
    if (!validLedger(ledger)) throw new TypeError("slack credit batch: incomplete ledger result");
    if (ledgers.has(ledger.itemId)) throw new Error("slack credit batch: duplicate ledger item ID");
    ledgers.set(ledger.itemId, ledger);
  }
  const metadata = new Map<string, AuthorizedSlackCreditItem>();
  for (const item of items) {
    if (!record(item as unknown) || item.teamId !== snapshot.teamId || item.source !== "slack" ||
        !nonempty(item.itemId) || !UUID.test(item.itemId) || typeof item.locked !== "boolean" ||
        !nullableId(item.currentMemberId) || !nullableId(item.legacyLatestWorkerId) ||
        !Array.isArray(item.legacyVersionMemberIds) ||
        item.legacyVersionMemberIds.some((id: unknown) => !nonempty(id)) ||
        (item.frontmatter !== null && !record(item.frontmatter)) ||
        (item.verifiedItemWorkspaceId !== undefined && !nonempty(item.verifiedItemWorkspaceId))) {
      throw new TypeError("slack credit batch: invalid item metadata or team");
    }
    if (item.discovery && (item.discovery.historicalSourceCensus?.teamId !== snapshot.teamId ||
        item.discovery.workspaceAccountInventories?.some((row: { teamId: string }) => row.teamId !== snapshot.teamId))) {
      throw new Error("slack credit batch: historical provenance team mismatch");
    }
    if (item.legacyEvidenceReview && item.legacyEvidenceReview.teamId !== snapshot.teamId) {
      throw new Error("slack credit batch: historical provenance team mismatch");
    }
    if (metadata.has(item.itemId)) throw new Error("slack credit batch: duplicate metadata item ID");
    metadata.set(item.itemId, item);
  }
  if (ledgers.size !== metadata.size || [...ledgers.keys()].some((id) => !metadata.has(id))) {
    throw new Error("slack credit batch: ledger and metadata item IDs differ");
  }

  for (const [itemId, ledger] of ledgers) {
    if (ledger.status === "present" && ledger.authors.length > 0 &&
        !metadata.get(itemId)?.verifiedItemWorkspaceId) {
      throw new Error("slack credit batch: missing verified item workspace");
    }
  }

  const selections = new Map<string, SlackCreditSelection>();
  for (const [itemId, item] of metadata) {
    selections.set(itemId, composeSlackCreditSelection({
      ...item, ledger: ledgers.get(itemId)!, mappings: snapshot.mappings,
      humanMemberIds: snapshot.humanMemberIds,
    }));
  }
  return selections;
}
