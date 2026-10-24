import { describe, expect, it } from "vitest";
import {
  classifySlackIdentityCutover,
  type SlackCutoverInput,
} from "@/lib/identity/slack-cutover-provenance";

const TEAM = "team-1";
const MEMBER = "member-1";

function row(id: string, externalId: string, memberId = MEMBER) {
  return { id, teamId: TEAM, provider: "slack", memberId, externalId };
}

function input(rows: SlackCutoverInput["rows"], inventories: SlackCutoverInput["discovery"]["workspaceAccountInventories"]): SlackCutoverInput {
  return {
    teamId: TEAM,
    rows,
    discovery: {
      historicalSourceCensus: {
        teamId: TEAM,
        evidenceId: "census-1",
        sources: inventories.map((inventory, index) => ({
          sourceId: `source-${index + 1}`, workspaceId: inventory.workspaceId, evidenceId: `source-proof-${index + 1}`,
        })),
      },
      workspaceAccountInventories: inventories,
    },
  };
}

function inventory(workspaceId: string, accounts: { userId: string; memberId: string | null }[]) {
  return {
    teamId: TEAM, workspaceId, evidenceId: `inventory-${workspaceId}`,
    accounts: accounts.map((account) => ({ ...account, evidenceId: `account-${workspaceId}-${account.userId}` })),
  };
}

describe("classifySlackIdentityCutover", () => {
  it("proposes only an in-place row-ID-preserving qualification with complete verified provenance", () => {
    const result = classifySlackIdentityCutover(input(
      [row("raw-1", "U123"), row("qualified-1", "T2:U999")],
      [inventory("T1", [{ userId: "U123", memberId: MEMBER }]),
        inventory("T2", [{ userId: "U999", memberId: MEMBER }])],
    ));
    expect(result).toEqual([
      { status: "qualified_noop", rowId: "qualified-1", externalId: "T2:U999" },
      { status: "qualify_in_place", rowId: "raw-1", memberId: MEMBER,
        fromExternalId: "U123", toExternalId: "T1:U123" },
    ]);
    expect(result).not.toBeInstanceOf(Promise); // pure, synchronous; no DB handle or call
  });

  it("holds an observed match pending without a completed historical census or every workspace inventory", () => {
    const partial = input([row("raw", "U123")], [inventory("T1", [{ userId: "U123", memberId: MEMBER }])]);
    delete partial.discovery.historicalSourceCensus;
    expect(classifySlackIdentityCutover(partial)).toEqual([{ status: "pending_incomplete_provenance", rowId: "raw" }]);
    partial.discovery.historicalSourceCensus = {
      teamId: TEAM,
      evidenceId: "census-1",
      sources: [
        { sourceId: "source-1", workspaceId: "T1", evidenceId: "proof-1" },
        { sourceId: "source-2", workspaceId: "T2", evidenceId: "proof-2" },
      ],
    };
    expect(classifySlackIdentityCutover(partial)).toEqual([{ status: "pending_incomplete_provenance", rowId: "raw" }]);
  });

  it("distinguishes unknown and mismatched member from a verified unique match", () => {
    const result = classifySlackIdentityCutover(input(
      [row("unknown", "U404"), row("mismatch", "U123", "member-other")],
      [inventory("T1", [{ userId: "U123", memberId: MEMBER }])],
    ));
    expect(result).toEqual([
      { status: "mismatched_member", rowId: "mismatch", workspaceId: "T1" },
      { status: "unknown_account", rowId: "unknown" },
    ]);
  });

  it("keeps two workspaces ambiguous even when both observations map to the same member", () => {
    const result = classifySlackIdentityCutover(input(
      [row("raw", "U123")],
      [inventory("T2", [{ userId: "U123", memberId: MEMBER }]),
        inventory("T1", [{ userId: "U123", memberId: MEMBER }])],
    ));
    expect(result).toEqual([{ status: "ambiguous_workspaces", rowId: "raw", workspaceIds: ["T1", "T2"] }]);
    const partial = input([row("raw", "U123")], [
      inventory("T1", [{ userId: "U123", memberId: MEMBER }]),
      inventory("T2", [{ userId: "U123", memberId: MEMBER }]),
    ]);
    delete partial.discovery.historicalSourceCensus;
    expect(classifySlackIdentityCutover(partial)).toEqual(result);
  });

  it("counts an observed unmapped account in another workspace as ambiguity", () => {
    const result = classifySlackIdentityCutover(input(
      [row("raw", "U123")],
      [inventory("T2", [{ userId: "U123", memberId: null }]),
        inventory("T1", [{ userId: "U123", memberId: MEMBER }])],
    ));
    expect(result).toEqual([{ status: "ambiguous_workspaces", rowId: "raw", workspaceIds: ["T1", "T2"] }]);
  });

  it("does not qualify a raw user when that user has a qualified row outside the claimed census", () => {
    const disputed = input(
      [row("raw", "U123"), row("qualified", "T2:U123")],
      [inventory("T1", [{ userId: "U123", memberId: MEMBER }])],
    );
    const expected = [
      { status: "qualified_workspace_outside_census", rowId: "qualified", workspaceId: "T2" },
      { status: "pending_conflicting_provenance", rowId: "raw" },
    ];
    expect(classifySlackIdentityCutover(disputed)).toEqual(expected);
    expect(classifySlackIdentityCutover({ ...disputed, rows: [
      row("qualified", "T2:U123"), row("raw", "U123"), row("qualified", "T2:U123"),
    ] })).toEqual(expected);

    const knownInBoth = input(
      [row("raw", "U123"), row("qualified", "T2:U123")],
      [inventory("T1", [{ userId: "U123", memberId: MEMBER }]),
        inventory("T2", [{ userId: "U123", memberId: MEMBER }])],
    );
    expect(classifySlackIdentityCutover(knownInBoth)).toContainEqual({
      status: "ambiguous_workspaces", rowId: "raw", workspaceIds: ["T1", "T2"],
    });
  });

  it("blocks every raw qualification when a different qualified user is outside the census", () => {
    const result = classifySlackIdentityCutover(input(
      [row("raw", "U123"), row("qualified", "T2:U999")],
      [inventory("T1", [{ userId: "U123", memberId: MEMBER }])],
    ));
    expect(result).toEqual([
      { status: "qualified_workspace_outside_census", rowId: "qualified", workspaceId: "T2" },
      { status: "pending_conflicting_provenance", rowId: "raw" },
    ]);
  });

  it("blocks every raw qualification when a complete inventory omits a qualified account", () => {
    const disputed = input(
      [row("raw", "U123"), row("qualified", "T2:U999"), row("verified", "T1:U555")],
      [inventory("T1", [{ userId: "U123", memberId: MEMBER }, { userId: "U555", memberId: MEMBER }]),
        inventory("T2", [{ userId: "U888", memberId: MEMBER }])],
    );
    const expected = [
      { status: "qualified_unknown_account", rowId: "qualified", workspaceId: "T2" },
      { status: "pending_conflicting_provenance", rowId: "raw" },
      { status: "qualified_pending_conflicting_provenance", rowId: "verified" },
    ];
    expect(classifySlackIdentityCutover(disputed)).toEqual(expected);
    expect(classifySlackIdentityCutover({
      ...disputed,
      rows: [...disputed.rows].reverse().concat(disputed.rows[1]),
      discovery: {
        historicalSourceCensus: {
          ...disputed.discovery.historicalSourceCensus!,
          sources: [...disputed.discovery.historicalSourceCensus!.sources].reverse(),
        },
        workspaceAccountInventories: [...disputed.discovery.workspaceAccountInventories].reverse()
          .map((entry) => ({ ...entry, accounts: [...entry.accounts].reverse() })),
      },
    })).toEqual(expected);
  });

  it("also holds unrelated raw rows for qualified member, duplicate and spelling conflicts", () => {
    const raw = row("raw", "U123");
    const t1 = inventory("T1", [
      { userId: "U123", memberId: MEMBER }, { userId: "U999", memberId: MEMBER },
    ]);
    const variants = [
      [row("qualified", "T1:U999", "member-other")],
      [row("qualified", "T1:U999"), row("duplicate", "T1:U999")],
      [{ ...row("qualified", "T1:U999"), provider: " Slack " }],
      [row("qualified", "t1:u999")],
    ];
    for (const qualifiedRows of variants) {
      const result = classifySlackIdentityCutover(input([raw, ...qualifiedRows], [t1]));
      expect(result).toContainEqual({ status: "pending_conflicting_provenance", rowId: "raw" });
      expect(result).not.toContainEqual(expect.objectContaining({ status: "qualify_in_place" }));
    }
  });

  it("holds a sole observed account without a verified member mapping", () => {
    expect(classifySlackIdentityCutover(input(
      [row("raw", "U123")], [inventory("T1", [{ userId: "U123", memberId: null }])],
    ))).toEqual([{ status: "unmapped_account", rowId: "raw", workspaceId: "T1" }]);
  });

  it("separates same-member and conflicting qualified collisions for manual review", () => {
    const result = classifySlackIdentityCutover(input(
      [row("raw-a", "UA"), row("same", "T1:UA"), row("raw-b", "UB"),
        row("conflict", "T1:UB", "member-other")],
      [inventory("T1", [{ userId: "UA", memberId: MEMBER }, { userId: "UB", memberId: MEMBER }])],
    ));
    expect(result).toContainEqual({ status: "qualified_collision_same_member", rowId: "raw-a", qualifiedRowIds: ["same"] });
    expect(result).toContainEqual({ status: "qualified_collision_conflicting_member", rowId: "raw-b", qualifiedRowIds: ["conflict"] });
    expect(result).not.toContainEqual(expect.objectContaining({ status: "qualify_in_place" }));
  });

  it("holds duplicate qualified account rows for review instead of silently accepting either", () => {
    const result = classifySlackIdentityCutover(input(
      [row("q1", "T1:U123"), row("q2", "t1:u123", "member-other")],
      [inventory("T1", [{ userId: "U123", memberId: MEMBER }])],
    ));
    expect(result).toEqual([
      { status: "duplicate_qualified_account", rowId: "q1", qualifiedRowIds: ["q1", "q2"] },
      { status: "duplicate_qualified_account", rowId: "q2", qualifiedRowIds: ["q1", "q2"] },
    ]);
  });

  it("does not label a noncanonical qualified row as a marker-safe no-op", () => {
    const result = classifySlackIdentityCutover(input(
      [{ ...row("q", "t1:u123"), provider: " Slack " }],
      [inventory("T1", [{ userId: "U123", memberId: MEMBER }])],
    ));
    expect(result).toEqual([{ status: "noncanonical_qualified_account", rowId: "q" }]);
    expect(classifySlackIdentityCutover(input(
      [{ ...row("raw", "U123"), provider: "Slack" }],
      [inventory("T1", [{ userId: "U123", memberId: MEMBER }])],
    ))).toEqual([{ status: "noncanonical_slack_provider", rowId: "raw" }]);
  });

  it("requires a complete census and inventory before a canonical qualified no-op", () => {
    const incomplete = input([row("q", "T1:U123")],
      [inventory("T1", [{ userId: "U123", memberId: MEMBER }])]);
    delete incomplete.discovery.historicalSourceCensus;
    expect(classifySlackIdentityCutover(incomplete)).toEqual([
      { status: "qualified_pending_incomplete_provenance", rowId: "q" },
    ]);
    incomplete.discovery.historicalSourceCensus = {
      teamId: TEAM, evidenceId: "census-1",
      sources: [
        { sourceId: "source-1", workspaceId: "T1", evidenceId: "proof-1" },
        { sourceId: "source-2", workspaceId: "T2", evidenceId: "proof-2" },
      ],
    };
    expect(classifySlackIdentityCutover(incomplete)).toEqual([
      { status: "qualified_pending_incomplete_provenance", rowId: "q" },
    ]);
  });

  it("flags a canonical qualified row outside the census or without a verified account", () => {
    const outside = input([row("q", "T2:U123")], [inventory("T1", [])]);
    expect(classifySlackIdentityCutover(outside)).toEqual([
      { status: "qualified_workspace_outside_census", rowId: "q", workspaceId: "T2" },
    ]);
    expect(classifySlackIdentityCutover(input(
      [row("q", "T1:U123")], [inventory("T1", [])],
    ))).toEqual([{ status: "qualified_unknown_account", rowId: "q", workspaceId: "T1" }]);
  });

  it("flags a canonical qualified row with no mapping or a conflicting member for manual review", () => {
    expect(classifySlackIdentityCutover(input(
      [row("q", "T1:U123")], [inventory("T1", [{ userId: "U123", memberId: null }])],
    ))).toEqual([{ status: "qualified_unmapped_account", rowId: "q", workspaceId: "T1" }]);
    expect(classifySlackIdentityCutover(input(
      [row("q", "T1:U123")], [inventory("T1", [{ userId: "U123", memberId: "member-other" }])],
    ))).toEqual([{ status: "qualified_mismatched_member", rowId: "q", workspaceId: "T1" }]);
    const missingCensus = input([row("q", "T1:U123")],
      [inventory("T1", [{ userId: "U123", memberId: "member-other" }])]);
    delete missingCensus.discovery.historicalSourceCensus;
    expect(classifySlackIdentityCutover(missingCensus)).toEqual([
      { status: "qualified_mismatched_member", rowId: "q", workspaceId: "T1" },
    ]);
  });

  it("is deterministic across row, source, inventory and account order", () => {
    const original = input(
      [row("b", "UB"), row("a", "UA"), row("q", "T2:UQ")],
      [inventory("T1", [{ userId: "UA", memberId: MEMBER }, { userId: "UB", memberId: MEMBER }]),
        inventory("T2", [{ userId: "UQ", memberId: MEMBER }])],
    );
    const reversed: SlackCutoverInput = {
      ...original,
      rows: [...original.rows].reverse(),
      discovery: {
        historicalSourceCensus: {
          ...original.discovery.historicalSourceCensus!,
          sources: [...original.discovery.historicalSourceCensus!.sources].reverse(),
        },
        workspaceAccountInventories: [...original.discovery.workspaceAccountInventories].reverse()
          .map((entry) => ({ ...entry, accounts: [...entry.accounts].reverse() })),
      },
    };
    expect(classifySlackIdentityCutover(reversed)).toEqual(classifySlackIdentityCutover(original));
  });

  it("fails closed on invalid IDs, mixed teams, conflicting duplicate evidence and duplicate raw rows", () => {
    const base = input([row("raw", "U123")], [inventory("T1", [{ userId: "U123", memberId: MEMBER }])]);
    expect(() => classifySlackIdentityCutover({ ...base, rows: [row("raw", "U:12:3")] })).toThrow("invalid Slack cutover input");
    expect(() => classifySlackIdentityCutover({ ...base, rows: [{ ...row("raw", "U123"), teamId: "team-2" }] })).toThrow("invalid Slack cutover input");
    expect(() => classifySlackIdentityCutover({ ...base, discovery: {
      ...base.discovery, historicalSourceCensus: { ...base.discovery.historicalSourceCensus!, teamId: "team-2" },
    } })).toThrow("invalid Slack cutover input");
    expect(() => classifySlackIdentityCutover({ ...base, discovery: {
      ...base.discovery, workspaceAccountInventories: [{ ...base.discovery.workspaceAccountInventories[0], teamId: "team-2" }],
    } })).toThrow("invalid Slack cutover input");
    expect(() => classifySlackIdentityCutover({ ...base, rows: [{ ...row("raw", "U123"), provider: "linear" }] })).toThrow("invalid Slack cutover input");
    expect(() => classifySlackIdentityCutover({ ...base, rows: [row("raw", "U123"), row("raw", "U123", "member-other")] })).toThrow("conflicting Slack cutover rows");
    const conflicting = input([row("raw", "U123")], [inventory("T1", [
      { userId: "U123", memberId: MEMBER }, { userId: "U123", memberId: "member-other" },
    ])]);
    expect(() => classifySlackIdentityCutover(conflicting)).toThrow("conflicting Slack discovery evidence");
    const mappedAndUnmapped = input([row("raw", "U123")], [inventory("T1", [
      { userId: "U123", memberId: MEMBER }, { userId: "U123", memberId: null },
    ])]);
    expect(() => classifySlackIdentityCutover(mappedAndUnmapped)).toThrow("conflicting Slack discovery evidence");
    const unmappedAndMapped = input([row("raw", "U123")], [inventory("T1", [
      { userId: "U123", memberId: null }, { userId: "U123", memberId: MEMBER },
    ])]);
    expect(() => classifySlackIdentityCutover(unmappedAndMapped)).toThrow("conflicting Slack discovery evidence");
    const conflictingSources = input([row("raw", "U123")], [inventory("T1", [])]);
    conflictingSources.discovery.historicalSourceCensus!.sources = [
      { sourceId: "same", workspaceId: "T1", evidenceId: "proof-1" },
      { sourceId: "same", workspaceId: "T2", evidenceId: "proof-2" },
    ];
    expect(() => classifySlackIdentityCutover(conflictingSources)).toThrow("conflicting Slack discovery evidence");
    expect(classifySlackIdentityCutover({ ...base, rows: [row("raw-a", "U123"), row("raw-b", "U123")] }))
      .toEqual([
        { status: "duplicate_raw_account", rowId: "raw-a", rawRowIds: ["raw-a", "raw-b"] },
        { status: "duplicate_raw_account", rowId: "raw-b", rawRowIds: ["raw-a", "raw-b"] },
      ]);
  });

  it("emits only allowlisted fields, even if input carries unrelated private data", () => {
    const privateInput = input([{ ...row("raw", "U123"), email: "private@example.test", token: "secret" }],
      [inventory("T1", [{ userId: "U123", memberId: MEMBER }])]);
    const serialized = JSON.stringify(classifySlackIdentityCutover(privateInput));
    expect(serialized).not.toContain("private@example.test");
    expect(serialized).not.toContain("secret");
  });
});
