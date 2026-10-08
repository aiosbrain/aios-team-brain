import { describe, expect, it } from "vitest";

import { composeSlackCreditBatch, type AuthorizedSlackCreditItem } from "@/lib/attribution/slack-credit-batch";
import type { SlackCreditInputSnapshot } from "@/lib/ingest/slack-credit-input-snapshot";
import type { SlackItemCreditLedger } from "@/lib/ingest/slack-item-credit-ledger-read";

const TEAM = "11111111-1111-1111-1111-111111111111";
const OTHER_TEAM = "22222222-2222-2222-2222-222222222222";
const ITEM = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const OTHER_ITEM = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const A = "member-a";
const B = "member-b";
const C = "member-c";
const BOT = "member-bot";

function item(overrides: Partial<AuthorizedSlackCreditItem> = {}): AuthorizedSlackCreditItem {
  return {
    teamId: TEAM, itemId: ITEM, source: "slack", frontmatter: null, locked: false,
    currentMemberId: C, legacyVersionMemberIds: [C], legacyLatestWorkerId: C,
    verifiedItemWorkspaceId: "T1", ...overrides,
  };
}

function snapshot(ledgers: SlackItemCreditLedger[], overrides: Partial<SlackCreditInputSnapshot> = {}): SlackCreditInputSnapshot {
  return {
    teamId: TEAM, ledgers,
    mappings: [
      { teamId: TEAM, provider: "slack", externalId: "T1:U1", memberId: A, state: "live" },
      { teamId: TEAM, provider: "slack", externalId: "T1:U2", memberId: B, state: "live" },
      { teamId: TEAM, provider: "slack", externalId: "T1:UBOT", memberId: BOT, state: "live" },
    ],
    humanMemberIds: new Set([A, B, C]),
    generations: { dataGeneration: "1", identityGeneration: "2", presentationGeneration: "3" },
    ...overrides,
  };
}

function author(rawUserId: string, workspaceId = "T1") {
  return {
    workspaceId, channelId: "C1", messageTs: "1735689600.000001",
    rootTs: "1735689600.000001", rawUserId,
    occurredAt: "2025-01-01T00:00:00.000001Z", isRoot: true,
  };
}

const absent = (itemId = ITEM): SlackItemCreditLedger => ({ itemId, status: "absent" });
const present = (...authors: ReturnType<typeof author>[]): SlackItemCreditLedger =>
  ({ itemId: ITEM, status: "present", authors });

describe("composeSlackCreditBatch (inactive)", () => {
  it("keeps a present empty ledger authoritative and composes every requested item", () => {
    const result = composeSlackCreditBatch(snapshot([present(), absent(OTHER_ITEM)]), [
      item({ frontmatter: { participants: [{ author_id: "U1", last_ts: "2025-01-01" }] } }),
      item({ itemId: OTHER_ITEM, legacyVersionMemberIds: [] }),
    ]);
    expect([...result.keys()]).toEqual([ITEM, OTHER_ITEM]);
    expect(result.get(ITEM)).toEqual({ kind: "verified_message_ledger_present", creditIds: null });
    expect(result.get(OTHER_ITEM)?.kind).toBe("legacy_partial");
    expect(composeSlackCreditBatch(snapshot([present()]),
      [item({ verifiedItemWorkspaceId: undefined })]).get(ITEM))
      .toEqual({ kind: "verified_message_ledger_present", creditIds: null });
  });

  it("composes present authors, excluding unresolved and nonhuman accounts", () => {
    expect(composeSlackCreditBatch(snapshot([present(author("U1"), author("UBOT"), author("UUNKNOWN"))]),
      [item()]).get(ITEM)).toEqual({ kind: "verified_message_ledger_present",
      creditIds: { contributorIds: [A], primaryId: A } });
  });

  it("uses participants only for an absent ledger and retains explicit partial legacy credit", () => {
    const participants = { participants: [{ author_id: "U2", last_ts: "2025-01-02" }] };
    expect(composeSlackCreditBatch(snapshot([absent()]), [item({ frontmatter: participants })]).get(ITEM))
      .toEqual({ kind: "structured_participants_present",
        creditIds: { contributorIds: [B], primaryId: B } });
    expect(composeSlackCreditBatch(snapshot([absent()]), [item()]).get(ITEM))
      .toEqual({ kind: "legacy_partial", creditIds: { contributorIds: [C], primaryId: C } });
  });

  it("honors correction locks even with present authors, including a cleared lock", () => {
    const input = snapshot([present(author("U1"))]);
    expect(composeSlackCreditBatch(input, [item({ locked: true })]).get(ITEM))
      .toEqual({ kind: "verified_message_ledger_present",
        creditIds: { contributorIds: [C], primaryId: C } });
    expect(composeSlackCreditBatch(input, [item({ locked: true, currentMemberId: null })]).get(ITEM))
      .toEqual({ kind: "verified_message_ledger_present", creditIds: null });
  });

  it("binds an empty snapshot to its team and rejects foreign metadata or mappings", () => {
    expect(composeSlackCreditBatch(snapshot([], { mappings: [], humanMemberIds: new Set() }), []))
      .toEqual(new Map());
    expect(() => composeSlackCreditBatch(snapshot([], { teamId: OTHER_TEAM, mappings: [] }),
      [item({ teamId: TEAM })])).toThrow("invalid item metadata or team");
    expect(() => composeSlackCreditBatch(snapshot([absent()], { mappings: [
      { teamId: OTHER_TEAM, provider: "slack", externalId: "T1:U1", memberId: A, state: "live" },
    ] }), [item()])).toThrow("invalid team roster or mapping");
    expect(() => composeSlackCreditBatch(snapshot([absent()]), [item({ source: "github" as "slack" })]))
      .toThrow("invalid item metadata or team");
    expect(() => composeSlackCreditBatch(snapshot([],
      { teamId: undefined as unknown as string, mappings: [], humanMemberIds: new Set() }), []))
      .toThrow("incomplete snapshot");
  });

  it("rejects missing, extra and duplicate ledger or metadata IDs", () => {
    expect(() => composeSlackCreditBatch(snapshot([]), [item()])).toThrow("item IDs differ");
    expect(() => composeSlackCreditBatch(snapshot([absent()]), [item(), item({ itemId: OTHER_ITEM })]))
      .toThrow("item IDs differ");
    expect(() => composeSlackCreditBatch(snapshot([absent(), absent(OTHER_ITEM)]), [item()]))
      .toThrow("item IDs differ");
    expect(() => composeSlackCreditBatch(snapshot([absent(), absent()]), [item()]))
      .toThrow("duplicate ledger item ID");
    expect(() => composeSlackCreditBatch(snapshot([absent()]), [item(), item()]))
      .toThrow("duplicate metadata item ID");
  });

  it("rejects failed and malformed ledger states rather than inventing absence", () => {
    for (const ledger of [
      { itemId: ITEM, status: "failed" },
      { itemId: ITEM, status: "present" },
      { itemId: ITEM, status: "absent", authors: [] },
      { itemId: ITEM, status: "present", authors: null },
      { itemId: ITEM, status: "present", authors: [{ workspaceId: "T1" }] },
    ]) {
      expect(() => composeSlackCreditBatch(snapshot([ledger as SlackItemCreditLedger]), [item()]))
        .toThrow("incomplete ledger result");
    }
    expect(() => composeSlackCreditBatch(snapshot([absent()], { generations: {
      dataGeneration: "1", identityGeneration: "2", presentationGeneration: undefined as unknown as string,
    } }), [item()])).toThrow("incomplete snapshot");
    expect(() => composeSlackCreditBatch(snapshot([absent()],
      { humanMemberIds: [] as unknown as ReadonlySet<string> }), [item()])).toThrow("incomplete snapshot");
    expect(() => composeSlackCreditBatch(snapshot([{ itemId: "bad", status: "absent" }]), [item()]))
      .toThrow("incomplete ledger result");
    expect(() => composeSlackCreditBatch(snapshot([absent()]), [item({ itemId: "bad" })]))
      .toThrow("invalid item metadata or team");
  });

  it("rejects source provenance conflicts before lock decisions", () => {
    for (const locked of [false, true]) {
      expect(() => composeSlackCreditBatch(snapshot([present(author("U1"))]),
        [item({ verifiedItemWorkspaceId: undefined, locked })]))
        .toThrow("missing verified item workspace");
    }
    expect(() => composeSlackCreditBatch(snapshot([present(author("U1", "T2"))]), [item({ locked: true })]))
      .toThrow("item provenance conflict");
    expect(() => composeSlackCreditBatch(snapshot([absent()]), [item({ locked: true,
      frontmatter: { workspace_id: "T2", participants: [] },
    })])).toThrow("item provenance conflict");
    expect(() => composeSlackCreditBatch(snapshot([present(author("U1"), author("U2", "T2"))]),
      [item({ verifiedItemWorkspaceId: undefined })])).toThrow("incomplete ledger result");
    expect(() => composeSlackCreditBatch(snapshot([absent()]), [item({
      legacyEvidenceReview: { teamId: OTHER_TEAM, evidenceId: "review", unresolvedOrQuarantined: [] },
    })])).toThrow("historical provenance team mismatch");
  });
});
