import { describe, expect, it } from "vitest";

import { composeSlackEvidence } from "@/lib/ingest/slack-evidence-adapter";
import type { AuthorizedSlackCreditItem } from "@/lib/attribution/slack-credit-batch";
import type { SlackEvidenceSnapshot } from "@/lib/ingest/slack-evidence-snapshot";
import type { SlackItemCreditAuthor, SlackItemCreditLedger } from "@/lib/ingest/slack-item-credit-ledger-read";
import type { VisibleSlackMessage } from "@/lib/ingest/slack-message-read";

const TEAM = "11111111-1111-1111-1111-111111111111";
const FOREIGN_TEAM = "22222222-2222-2222-2222-222222222222";
const ITEM = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const OTHER_ITEM = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const A = "member-a";
const B = "member-b";
const CONNECTOR = "member-connector";
const rootTs = "1718841599.999999";
const rootAt = "2024-06-19T23:59:59.999999Z";

function item(changes: Partial<AuthorizedSlackCreditItem> = {}): AuthorizedSlackCreditItem {
  return { teamId: TEAM, itemId: ITEM, source: "slack", frontmatter: null,
    locked: false, currentMemberId: A, legacyVersionMemberIds: [A],
    legacyLatestWorkerId: A, verifiedItemWorkspaceId: "T1", ...changes };
}

function author(ts: string, at: string, rawUserId: string,
  changes: Partial<SlackItemCreditAuthor> = {}): SlackItemCreditAuthor {
  return { workspaceId: "T1", channelId: "C1", rootTs, messageTs: ts,
    occurredAt: at, rawUserId, isRoot: ts === rootTs, ...changes };
}

function visible(input: SlackItemCreditAuthor, changes: Partial<VisibleSlackMessage> = {}): VisibleSlackMessage {
  return { itemId: ITEM, workspaceId: input.workspaceId, channelId: input.channelId,
    rootTs: input.rootTs, messageTs: input.messageTs, occurredAt: input.occurredAt,
    authorExternalId: input.rawUserId, isRoot: input.isRoot, ...changes };
}

const root = author(rootTs, rootAt, "U1");
const replyA = author("1718841600.000001", "2024-06-20T00:00:00.000001Z", "U2");
const replyB = author("1718841600.000002", "2024-06-20T00:00:00.000002Z", "U3");
const laterB = author("1719014400.000001", "2024-06-22T00:00:00.000001Z", "U3");

function snapshot(
  ledgers: SlackItemCreditLedger[] = [{ itemId: ITEM, status: "present",
    authors: [root, replyA, replyB, laterB] }],
  messages: VisibleSlackMessage[] = [root, replyA, replyB, laterB].map((row) => visible(row)),
  changes: Partial<SlackEvidenceSnapshot> = {}
): SlackEvidenceSnapshot {
  return { teamId: TEAM, ledgers, messages,
    mappings: [
      { teamId: TEAM, provider: "slack", externalId: "T1:U1", memberId: A, state: "live" },
      { teamId: TEAM, provider: "slack", externalId: "T1:U2", memberId: A, state: "live" },
      { teamId: TEAM, provider: "slack", externalId: "T1:U3", memberId: B, state: "live" },
    ],
    humanMemberIds: new Set([A, B]),
    generations: { dataGeneration: "1", identityGeneration: "2", presentationGeneration: "3" },
    ...changes };
}

describe("composeSlackEvidence (inactive)", () => {
  it("returns shared selections and factual UTC days for multiple authors and items", () => {
    const secondRoot = author(rootTs, rootAt, "U1", { workspaceId: "T2", channelId: "C2" });
    const input = snapshot([
      { itemId: ITEM, status: "present", authors: [root, replyA, replyB, laterB] },
      { itemId: OTHER_ITEM, status: "present", authors: [secondRoot] },
    ], [root, replyA, replyB, laterB].map((row) => visible(row)).concat(
      visible(secondRoot, { itemId: OTHER_ITEM })
    ), { mappings: [...snapshot().mappings,
      { teamId: TEAM, provider: "slack", externalId: "T2:U1", memberId: B, state: "live" }] });
    const result = composeSlackEvidence(input, [item(), item({ itemId: OTHER_ITEM,
      verifiedItemWorkspaceId: "T2" })]);
    expect(result.creditByItem.get(ITEM)).toEqual({ kind: "verified_message_ledger_present",
      creditIds: { contributorIds: [A, B], primaryId: A } });
    expect(result.creditByItem.get(OTHER_ITEM)).toEqual({ kind: "verified_message_ledger_present",
      creditIds: { contributorIds: [B], primaryId: B } });
    expect(result.personDays.map((day) => [day.sourceItemId, day.day, day.memberId,
      day.messageCount, day.rootAuthored])).toEqual([
      [ITEM, "2024-06-22", B, 1, false],
      [ITEM, "2024-06-20", B, 1, false],
      [ITEM, "2024-06-20", A, 1, false],
      [ITEM, "2024-06-19", A, 1, true],
      [OTHER_ITEM, "2024-06-19", B, 1, true],
    ]);
  });

  it("keeps only a locked owner's own authored days and none for a cleared lock", () => {
    const input = snapshot();
    const selected = composeSlackEvidence(input, [item({ locked: true, currentMemberId: B })]);
    expect(selected.creditByItem.get(ITEM)).toEqual({ kind: "verified_message_ledger_present",
      creditIds: { contributorIds: [B], primaryId: B } });
    expect(selected.personDays.map((day) => [day.day, day.memberId]))
      .toEqual([["2024-06-22", B], ["2024-06-20", B]]);
    expect(composeSlackEvidence(input, [item({ locked: true, currentMemberId: null })]).personDays)
      .toEqual([]);
  });

  it("uses present-empty and absent legacy credit without inventing authored days", () => {
    const participants = { participants: [{ author_id: "U1", last_ts: "2024-06-19" }] };
    expect(composeSlackEvidence(snapshot([{ itemId: ITEM, status: "present", authors: [] }], []),
      [item({ frontmatter: participants, verifiedItemWorkspaceId: undefined })]))
      .toEqual({ creditByItem: new Map([[ITEM,
        { kind: "verified_message_ledger_present", creditIds: null }]]), personDays: [] });
    expect(composeSlackEvidence(snapshot([{ itemId: ITEM, status: "absent" }], []),
      [item({ frontmatter: participants })]).creditByItem.get(ITEM)?.kind)
      .toBe("structured_participants_present");
    const legacy = composeSlackEvidence(snapshot([{ itemId: ITEM, status: "absent" }], []),
      [item()]);
    expect(legacy.creditByItem.get(ITEM)?.kind).toBe("legacy_partial");
    expect(legacy.personDays).toEqual([]);
  });

  it("rejects incomplete snapshots and nonmatching metadata or visible item coverage", () => {
    expect(() => composeSlackEvidence({ ...snapshot(), messages: undefined as unknown as VisibleSlackMessage[] },
      [item()])).toThrow("incomplete message snapshot");
    expect(() => composeSlackEvidence(snapshot(), [])).toThrow("item IDs differ");
    expect(() => composeSlackEvidence(snapshot(), [item(), item({ itemId: OTHER_ITEM })]))
      .toThrow("item IDs differ");
    expect(() => composeSlackEvidence(snapshot(), [item({ teamId: FOREIGN_TEAM })]))
      .toThrow("invalid item metadata or team");
    expect(() => composeSlackEvidence(snapshot(undefined, [visible(root, { itemId: OTHER_ITEM })]),
      [item()])).toThrow("outside authorized items");
  });

  it("rejects missing, duplicated or conflicting authored ledger evidence before projection", () => {
    expect(() => composeSlackEvidence(snapshot([{ itemId: ITEM, status: "absent" }],
      [visible(root)]), [item()])).toThrow("without present ledger");
    expect(() => composeSlackEvidence(snapshot([{ itemId: ITEM, status: "present", authors: [] }],
      [visible(root)]), [item()])).toThrow("ledger conflict");
    expect(() => composeSlackEvidence(snapshot([
      { itemId: ITEM, status: "present", authors: [replyA] }], [visible(root)]), [item()]))
      .toThrow("ledger conflict");
    expect(() => composeSlackEvidence(snapshot([
      { itemId: ITEM, status: "present", authors: [root, root] }], [visible(root)]), [item()]))
      .toThrow("duplicate ledger message");
    expect(() => composeSlackEvidence(snapshot([
      { itemId: ITEM, status: "present", authors: [root] },
      { itemId: OTHER_ITEM, status: "present", authors: [root] },
    ], [visible(root)]), [item(), item({ itemId: OTHER_ITEM })]))
      .toThrow("duplicate ledger message");
    expect(() => composeSlackEvidence(snapshot(undefined, [visible(root), visible(root)]), [item()]))
      .toThrow("duplicate visible message");
    expect(() => composeSlackEvidence(snapshot([{ itemId: ITEM, status: "present",
      authors: [root, { ...replyA, occurredAt: rootAt }] }], [visible(root)]), [item()]))
      .toThrow("invalid ledger author");
    expect(() => composeSlackEvidence(snapshot([{ itemId: ITEM, status: "present",
      authors: [{ ...replyA, rootTs: "bad" }] }], []), [item()]))
      .toThrow("invalid ledger author");
    for (const change of [
      { authorExternalId: "U2" }, { rootTs: "1718841600.000001" },
      { occurredAt: "2024-06-20T00:00:00.000000Z" }, { isRoot: false },
    ]) expect(() => composeSlackEvidence(snapshot(undefined, [visible(root, change)]), [item()]))
      .toThrow("ledger conflict");
  });

  it("rejects source-thread and verified-workspace conflicts even under a correction lock", () => {
    expect(() => composeSlackEvidence(snapshot(undefined, [visible(root, { workspaceId: "T2" })]),
      [item({ locked: true })])).toThrow("workspace conflict");
    expect(() => composeSlackEvidence(snapshot(), [item({ locked: true,
      verifiedItemWorkspaceId: undefined })])).toThrow("missing verified item workspace");
    expect(() => composeSlackEvidence(snapshot([{ itemId: ITEM, status: "present",
      authors: [root, { ...replyA, channelId: "C2" }] }], [visible(root)]),
      [item()])).toThrow("incomplete ledger result");
  });

  it("keeps unresolved, nonhuman and foreign-team accounts from earning factual days", () => {
    const unresolved = author("1718841600.000003", "2024-06-20T00:00:00.000003Z", "U4");
    const nonhuman = author("1718841600.000004", "2024-06-20T00:00:00.000004Z", "U5");
    const foreign = author("1718841600.000005", "2024-06-20T00:00:00.000005Z", "U6");
    const authors = [root, unresolved, nonhuman, foreign];
    const input = snapshot([{ itemId: ITEM, status: "present", authors }], authors.map((row) => visible(row)), {
      mappings: [
        { teamId: TEAM, provider: "slack", externalId: "T1:U1", memberId: A, state: "live" },
        { teamId: TEAM, provider: "slack", externalId: "T1:U5", memberId: CONNECTOR, state: "live" },
        { teamId: TEAM, provider: "slack", externalId: "T2:U4", memberId: B, state: "live" },
      ],
    });
    const result = composeSlackEvidence(input, [item()]);
    expect(result.personDays.map((day) => [day.memberId, day.messageCount])).toEqual([[A, 1]]);
    expect(result.creditByItem.get(ITEM)?.creditIds?.contributorIds).toEqual([A]);
    expect(() => composeSlackEvidence({ ...input, mappings: [...input.mappings,
      { teamId: FOREIGN_TEAM, provider: "slack", externalId: "T1:U6", memberId: B, state: "live" }] },
    [item()])).toThrow("invalid team roster or mapping");
  });
});
