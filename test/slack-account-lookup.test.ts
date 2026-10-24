import { describe, expect, it } from "vitest";
import {
  lookupSlackAccount,
  type SlackAccountLookupInput,
  type SlackAccountMapping,
} from "@/lib/identity/resolve";

const TEAM = "team-1";
const MEMBER = "member-1";

function mapping(externalId: string, memberId = MEMBER, overrides: Partial<SlackAccountMapping> = {}): SlackAccountMapping {
  return { teamId: TEAM, provider: "slack", externalId, memberId, state: "live", ...overrides };
}

function inventory(workspaceId: string, accounts: { userId: string; memberId: string | null }[]) {
  return {
    teamId: TEAM, workspaceId, evidenceId: `inventory-${workspaceId}`,
    accounts: accounts.map((account) => ({ ...account, evidenceId: `account-${workspaceId}-${account.userId}` })),
  };
}

function legacyInput(): SlackAccountLookupInput {
  return {
    teamId: TEAM,
    externalId: "U123",
    mappings: [mapping("T1:U123")],
    discovery: {
      historicalSourceCensus: {
        teamId: TEAM, evidenceId: "census-1",
        sources: [
          { sourceId: "source-1", workspaceId: "T1", evidenceId: "source-proof-1" },
          { sourceId: "source-2", workspaceId: "T2", evidenceId: "source-proof-2" },
        ],
      },
      workspaceAccountInventories: [
        inventory("T1", [{ userId: "U123", memberId: MEMBER }]),
        inventory("T2", [{ userId: "U999", memberId: "member-2" }]),
      ],
    },
    legacyEvidenceReview: { teamId: TEAM, evidenceId: "legacy-review-1", unresolvedOrQuarantined: [] },
  };
}

const blocked = (status: string) => ({ status, memberId: null, accountId: null });
const resolved = (accountId = "T1:U123") => ({ status: "resolved", memberId: MEMBER, accountId });

describe("lookupSlackAccount (inactive)", () => {
  it("resolves only the exact canonical live qualified account in a verified item workspace", () => {
    const input = legacyInput();
    delete input.discovery;
    delete input.legacyEvidenceReview;
    input.verifiedItemWorkspaceId = "T1";
    expect(lookupSlackAccount(input)).toEqual(resolved());
    input.externalId = "T1:U123";
    expect(lookupSlackAccount(input)).toEqual(resolved());
    input.verifiedItemWorkspaceId = "T2";
    expect(lookupSlackAccount(input)).toEqual(blocked("invalid_input"));
    input.externalId = "U123";
    expect(lookupSlackAccount(input)).toEqual(blocked("no_mapping"));
    input.mappings = [mapping("T2:U123")];
    expect(lookupSlackAccount(input)).toEqual({ status: "resolved", memberId: MEMBER, accountId: "T2:U123" });
  });

  it("requires a completed, evidence-referenced closed world and a reviewed legacy disposition", () => {
    const input = legacyInput();
    expect(lookupSlackAccount(input)).toEqual(resolved());
    delete input.discovery;
    expect(lookupSlackAccount(input)).toEqual(blocked("incomplete_provenance"));
    input.discovery = legacyInput().discovery;
    delete input.discovery!.historicalSourceCensus;
    expect(lookupSlackAccount(input)).toEqual(blocked("incomplete_provenance"));
    input.discovery = legacyInput().discovery;
    input.discovery!.workspaceAccountInventories = input.discovery!.workspaceAccountInventories.slice(0, 1);
    expect(lookupSlackAccount(input)).toEqual(blocked("incomplete_provenance"));
    input.discovery = legacyInput().discovery;
    delete input.legacyEvidenceReview;
    expect(lookupSlackAccount(input)).toEqual(blocked("incomplete_provenance"));
    input.legacyEvidenceReview = { teamId: TEAM, evidenceId: "", unresolvedOrQuarantined: [] };
    expect(lookupSlackAccount(input)).toEqual(blocked("incomplete_provenance"));
    input.legacyEvidenceReview = legacyInput().legacyEvidenceReview;
    input.discovery!.workspaceAccountInventories[0].accounts[0].evidenceId = "";
    expect(lookupSlackAccount(input)).toEqual(blocked("conflicting_provenance"));
  });

  it("blocks a second observed workspace even when it maps to the same member or nobody", () => {
    for (const secondMember of [MEMBER, null]) {
      const input = legacyInput();
      input.discovery!.workspaceAccountInventories[1].accounts.push({
        userId: "U123", memberId: secondMember, evidenceId: "account-T2-U123",
      });
      expect(lookupSlackAccount(input)).toEqual(blocked("ambiguous_workspaces"));
    }
  });

  it("requires the observed account and sole canonical mapping to agree on member", () => {
    const input = legacyInput();
    input.mappings = [];
    expect(lookupSlackAccount(input)).toEqual(blocked("no_mapping"));
    input.mappings = [mapping("T1:U123", "member-other")];
    expect(lookupSlackAccount(input)).toEqual(blocked("mismatched_member"));
    input.mappings = [mapping("T1:U123")];
    input.discovery!.workspaceAccountInventories[0].accounts[0].memberId = null;
    expect(lookupSlackAccount(input)).toEqual(blocked("unmapped_account"));
    input.discovery!.workspaceAccountInventories[0].accounts = [];
    expect(lookupSlackAccount(input)).toEqual(blocked("unknown_account"));
  });

  it("never uses raw rows, archived or quarantined rows, or unrelated IDs", () => {
    const input = legacyInput();
    input.mappings = [mapping("U123")];
    expect(lookupSlackAccount(input)).toEqual(blocked("unresolved_legacy_evidence"));
    input.mappings = [mapping("T1:U123", MEMBER, { state: "archived" })];
    expect(lookupSlackAccount(input)).toEqual(blocked("no_mapping"));
    input.mappings = [mapping("T1:U123", MEMBER, { state: "quarantined" })];
    expect(lookupSlackAccount(input)).toEqual(blocked("no_mapping"));
    input.mappings = [mapping("T1:U123"), mapping("T1:U999", MEMBER, { teamId: "other-team" })];
    input.externalId = "U404";
    expect(lookupSlackAccount(input)).toEqual(blocked("unknown_account"));
    input.externalId = "T1:U404";
    expect(lookupSlackAccount(input)).toEqual(blocked("no_mapping"));
  });

  it("blocks unresolved or quarantined legacy evidence for that user", () => {
    const input = legacyInput();
    input.legacyEvidenceReview!.unresolvedOrQuarantined = [{ userId: "U123", evidenceId: "quarantine-1" }];
    expect(lookupSlackAccount(input)).toEqual(blocked("unresolved_legacy_evidence"));
    input.legacyEvidenceReview!.unresolvedOrQuarantined = [{ userId: "U999", evidenceId: "quarantine-2" }];
    expect(lookupSlackAccount(input)).toEqual(resolved());
  });

  it("blocks noncanonical provider/ID spelling and duplicate case variants", () => {
    const input = legacyInput();
    input.mappings = [mapping("T1:U123", MEMBER, { provider: "Slack" })];
    expect(lookupSlackAccount(input)).toEqual(blocked("conflicting_mapping"));
    input.mappings = [mapping("t1:u123")];
    expect(lookupSlackAccount(input)).toEqual(blocked("conflicting_mapping"));
    input.mappings = [mapping("T1:U123"), mapping("t1:u123")];
    expect(lookupSlackAccount(input)).toEqual(blocked("conflicting_mapping"));
    input.mappings = [mapping("T1:U123"), mapping(" T1:U123 ")];
    expect(lookupSlackAccount(input)).toEqual(blocked("conflicting_mapping"));
    input.mappings = [mapping("T1:U123"), mapping("T1:U123", "member-other")];
    expect(lookupSlackAccount(input)).toEqual(blocked("conflicting_mapping"));
    input.externalId = "t1:U123";
    expect(lookupSlackAccount(input)).toEqual(blocked("invalid_input"));
    input.externalId = "U123";
    input.verifiedItemWorkspaceId = "t1";
    expect(lookupSlackAccount(input)).toEqual(blocked("invalid_input"));
  });

  it("rejects live qualified rows that disprove the claimed complete workspace/account inventory", () => {
    const input = legacyInput();
    for (const contradictory of [
      mapping("T3:U999"), // historical workspace omitted from the census
      mapping("T2:U888"), // account omitted from the completed T2 inventory
      mapping("T2:U999", MEMBER), // observed T2 account belongs to member-2
      mapping("t2:u999", "member-2"), // noncanonical unrelated account
    ]) {
      input.mappings = [mapping("T1:U123"), contradictory];
      expect(lookupSlackAccount(input)).toEqual(blocked("conflicting_provenance"));
      input.mappings = [...input.mappings].reverse();
      expect(lookupSlackAccount(input)).toEqual(blocked("conflicting_provenance"));
    }
  });

  it("rejects contradictory census and inventory evidence independent of input order", () => {
    const input = legacyInput();
    input.discovery!.workspaceAccountInventories.push(inventory("T1", [{ userId: "U123", memberId: MEMBER }]));
    expect(lookupSlackAccount(input)).toEqual(blocked("conflicting_provenance"));
    input.discovery = legacyInput().discovery;
    input.discovery!.historicalSourceCensus!.sources.push({
      sourceId: "source-1", workspaceId: "T3", evidenceId: "source-proof-3",
    });
    expect(lookupSlackAccount(input)).toEqual(blocked("conflicting_provenance"));
    const valid = legacyInput();
    const baseline = lookupSlackAccount(valid);
    valid.mappings = [...valid.mappings].reverse();
    valid.discovery!.historicalSourceCensus!.sources.reverse();
    valid.discovery!.workspaceAccountInventories.reverse();
    valid.legacyEvidenceReview!.unresolvedOrQuarantined = [
      { userId: "U999", evidenceId: "review-2" }, { userId: "U888", evidenceId: "review-3" },
    ];
    const forward = lookupSlackAccount(valid);
    valid.legacyEvidenceReview!.unresolvedOrQuarantined = [...valid.legacyEvidenceReview!.unresolvedOrQuarantined].reverse();
    expect(lookupSlackAccount(valid)).toEqual(forward);
    expect(forward).toEqual(baseline);
    expect(Object.keys(forward).sort()).toEqual(["accountId", "memberId", "status"]);
  });
});
