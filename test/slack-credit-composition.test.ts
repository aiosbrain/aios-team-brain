import { describe, expect, it } from "vitest";
import { composeSlackCreditSelection, type SlackCreditCompositionInput } from "@/lib/attribution/slack-credit-composition";
import type { SlackAccountMapping } from "@/lib/identity/resolve";
import type { SlackItemCreditAuthor, SlackItemCreditLedger } from "@/lib/ingest/slack-item-credit-ledger-read";

const TEAM = "team-1";
const ITEM = "item-1";
const A = "member-a";
const B = "member-b";
const C = "member-c";
const BOT = "member-connector";

function author(rawUserId: string, workspaceId = "T1", messageTs = "1735689600.000001"): SlackItemCreditAuthor {
  const [seconds, fraction] = messageTs.split(".");
  return {
    workspaceId, channelId: "C1", messageTs, rootTs: "1735689600.000001",
    rawUserId, occurredAt: new Date(Number(seconds) * 1000).toISOString()
      .replace(".000Z", `.${fraction.padEnd(6, "0")}Z`),
    isRoot: messageTs === "1735689600.000001",
  };
}

function present(...authors: SlackItemCreditAuthor[]): SlackItemCreditLedger {
  return { itemId: ITEM, status: "present", authors };
}

function mapping(externalId: string, memberId: string, overrides: Partial<SlackAccountMapping> = {}): SlackAccountMapping {
  return { teamId: TEAM, provider: "slack", externalId, memberId, state: "live", ...overrides };
}

function base(overrides: Partial<SlackCreditCompositionInput> = {}): SlackCreditCompositionInput {
  return {
    teamId: TEAM, itemId: ITEM, ledger: { itemId: ITEM, status: "absent" },
    frontmatter: null, locked: false, currentMemberId: C,
    legacyVersionMemberIds: [C], legacyLatestWorkerId: C,
    mappings: [mapping("T1:U1", A), mapping("T1:U2", B), mapping("T1:UBOT", BOT)],
    humanMemberIds: new Set([A, B, C]),
    ...overrides,
  };
}

function historicalDiscovery(secondWorkspaceHasUser = false): Pick<SlackCreditCompositionInput, "discovery" | "legacyEvidenceReview"> {
  return {
    discovery: {
      historicalSourceCensus: {
        teamId: TEAM, evidenceId: "census-1",
        sources: [
          { sourceId: "source-1", workspaceId: "T1", evidenceId: "source-proof-1" },
          { sourceId: "source-2", workspaceId: "T2", evidenceId: "source-proof-2" },
        ],
      },
      workspaceAccountInventories: [
        { teamId: TEAM, workspaceId: "T1", evidenceId: "inventory-1",
          accounts: [{ userId: "U1", memberId: A, evidenceId: "account-1" }] },
        { teamId: TEAM, workspaceId: "T2", evidenceId: "inventory-2",
          accounts: secondWorkspaceHasUser
            ? [{ userId: "U1", memberId: A, evidenceId: "account-2" }]
            : [{ userId: "U9", memberId: null, evidenceId: "account-9" }] },
      ],
    },
    legacyEvidenceReview: { teamId: TEAM, evidenceId: "review-1", unresolvedOrQuarantined: [] },
  };
}

describe("composeSlackCreditSelection (inactive)", () => {
  it("uses matching message and item workspace with ledger order ahead of participants and root-stamped versions", () => {
    expect(composeSlackCreditSelection(base({
      ledger: present(author("U1"), author("U2", "T1", "1735689601.000001")),
      frontmatter: { participants: [{ author_id: "U2", last_ts: "2025-01-02" }] },
      verifiedItemWorkspaceId: "T1",
    }))).toEqual({ kind: "verified_message_ledger_present",
      creditIds: { contributorIds: [A, B], primaryId: B } });
  });

  it("rejects a present ledger conflicting with verified item provenance even for a locked item", () => {
    for (const locked of [false, true]) {
      expect(() => composeSlackCreditSelection(base({
        ledger: present(author("U1", "T1")), verifiedItemWorkspaceId: "T2", locked,
      }))).toThrowError("slack credit composition: item provenance conflict");
    }
  });

  it("treats a present empty or deleted-only reader result as authoritative", () => {
    // The reader represents both an empty eligible ledger and a deleted-only item this way.
    expect(composeSlackCreditSelection(base({ ledger: present(),
      frontmatter: { participants: [{ author_id: "U1", last_ts: "2025-01-02" }] },
      verifiedItemWorkspaceId: "T1",
    }))).toEqual({ kind: "verified_message_ledger_present", creditIds: null });
    expect(composeSlackCreditSelection(base({ ledger: present(), verifiedItemWorkspaceId: "T2" })))
      .toEqual({ kind: "verified_message_ledger_present", creditIds: null });
  });

  it("does not restore owner or versions when ledger accounts have no live mapping", () => {
    expect(composeSlackCreditSelection(base({ ledger: present(author("U1")), mappings: [] })))
      .toEqual({ kind: "verified_message_ledger_present", creditIds: null });
  });

  it("uses the message's verified workspace exactly, including with the same raw user in two workspaces", () => {
    expect(composeSlackCreditSelection(base({
      ledger: present(author("U1", "T2")),
      mappings: [mapping("T1:U1", A), mapping("T2:U1", B)],
    }))).toEqual({ kind: "verified_message_ledger_present",
      creditIds: { contributorIds: [B], primaryId: B } });
    expect(composeSlackCreditSelection(base({ ledger: present(author("U1", "T2")) })))
      .toEqual({ kind: "verified_message_ledger_present", creditIds: null });
  });

  it("treats a structured participants field as present even if empty or malformed", () => {
    for (const participants of [[], "bad", null, [{ author_id: 2 }]]) {
      expect(composeSlackCreditSelection(base({ frontmatter: { participants } })))
        .toEqual({ kind: "structured_participants_present", creditIds: null });
    }
  });

  it("does not trust frontmatter.workspace_id as item workspace verification", () => {
    expect(composeSlackCreditSelection(base({
      frontmatter: { workspace_id: "T1", participants: [{ author_id: "U1", last_ts: "2025-01-02" }] },
    }))).toEqual({ kind: "structured_participants_present", creditIds: null });
    expect(composeSlackCreditSelection(base({
      frontmatter: { participants: [{ author_id: "T1:U1", last_ts: "2025-01-02" }] },
    }))).toEqual({ kind: "structured_participants_present", creditIds: null });
  });

  it("uses separately verified item workspace for participants and rejects conflicting frontmatter", () => {
    const frontmatter = { workspace_id: "T1", participants: [{ author_id: "U1", last_ts: "2025-01-02" }] };
    expect(composeSlackCreditSelection(base({ frontmatter, verifiedItemWorkspaceId: "T1" })))
      .toEqual({ kind: "structured_participants_present",
        creditIds: { contributorIds: [A], primaryId: A } });
    for (const locked of [false, true]) {
      expect(() => composeSlackCreditSelection(base({ frontmatter,
        verifiedItemWorkspaceId: "T2", locked,
        mappings: [mapping("T1:U1", A), mapping("T2:U1", B)],
      }))).toThrowError("slack credit composition: item provenance conflict");
    }
  });

  it("requires complete historical evidence for workspace-free legacy participants", () => {
    const frontmatter = { participants: [{ author_id: "U1", last_ts: "2025-01-02" }] };
    expect(composeSlackCreditSelection(base({
      frontmatter, ...historicalDiscovery(), mappings: [mapping("T1:U1", A)],
    })))
      .toEqual({ kind: "structured_participants_present",
        creditIds: { contributorIds: [A], primaryId: A } });
    expect(composeSlackCreditSelection(base({
      frontmatter, ...historicalDiscovery(true), mappings: [mapping("T1:U1", A), mapping("T2:U1", A)],
    }))).toEqual({ kind: "structured_participants_present", creditIds: null });
  });

  it("excludes connector and nonhuman IDs from authors, owner and legacy workers", () => {
    expect(composeSlackCreditSelection(base({
      ledger: present(author("UBOT"), author("U1", "T1", "1735689601.000001")),
      currentMemberId: BOT, legacyVersionMemberIds: [BOT], legacyLatestWorkerId: BOT,
    }))).toEqual({ kind: "verified_message_ledger_present",
      creditIds: { contributorIds: [A], primaryId: null } });
    expect(composeSlackCreditSelection(base({
      currentMemberId: BOT, legacyVersionMemberIds: [BOT], legacyLatestWorkerId: BOT,
    }))).toEqual({ kind: "legacy_partial", creditIds: null });
    expect(composeSlackCreditSelection(base({
      frontmatter: { participants: [{ author_id: "UBOT", last_ts: "2025-01-02" }] },
      verifiedItemWorkspaceId: "T1",
    }))).toEqual({ kind: "structured_participants_present", creditIds: null });
  });

  it("keeps correction locks authoritative and honors a cleared or nonhuman owner", () => {
    const ledger = present(author("U1"));
    expect(composeSlackCreditSelection(base({ ledger, locked: true, currentMemberId: C })))
      .toEqual({ kind: "verified_message_ledger_present",
        creditIds: { contributorIds: [C], primaryId: C } });
    for (const currentMemberId of [null, BOT]) {
      expect(composeSlackCreditSelection(base({ ledger, locked: true, currentMemberId })))
        .toEqual({ kind: "verified_message_ledger_present", creditIds: null });
    }
  });

  it("reports explicit partial legacy credit when neither ledger nor participants exists", () => {
    expect(composeSlackCreditSelection(base()))
      .toEqual({ kind: "legacy_partial", creditIds: { contributorIds: [C], primaryId: C } });
    expect(composeSlackCreditSelection(base({ legacyVersionMemberIds: [], legacyLatestWorkerId: null })))
      .toEqual({ kind: "legacy_partial", creditIds: { contributorIds: [C], primaryId: C } });
  });

  it("rejects a ledger result for another item before even a locked credit decision", () => {
    expect(() => composeSlackCreditSelection(base({
      ledger: { itemId: "other-item", status: "absent" }, locked: true,
    }))).toThrow("ledger item ID mismatch");
  });

  it("cannot turn an unexpected failed reader state into absent evidence", () => {
    const failed = { itemId: ITEM, status: "failed", error: new Error("read failed") };
    expect(() => composeSlackCreditSelection(base({
      ledger: failed as unknown as SlackItemCreditLedger,
    }))).toThrow("incomplete ledger result");
  });

  it("preserves reader order and parser order independently of mapping row order", () => {
    const ledger = present(author("U1"), author("U2", "T1", "1735689601.000001"),
      author("U1", "T1", "1735689602.000001"));
    const forward = base({ ledger });
    expect(composeSlackCreditSelection(forward))
      .toEqual({ kind: "verified_message_ledger_present",
        creditIds: { contributorIds: [A, B], primaryId: A } });
    expect(composeSlackCreditSelection({ ...forward, mappings: [...forward.mappings].reverse() }))
      .toEqual(composeSlackCreditSelection(forward));

    const frontmatter = { participants: [
      { author_id: "U2", last_ts: "2025-01-03" },
      { author_id: "U1", last_ts: "2025-01-01" },
      { author_id: "U1", last_ts: "2025-01-02" },
    ] };
    expect(composeSlackCreditSelection(base({ frontmatter, verifiedItemWorkspaceId: "T1" })))
      .toEqual({ kind: "structured_participants_present",
        creditIds: { contributorIds: [A, B], primaryId: B } });
  });
});
