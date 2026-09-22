import { describe, expect, it } from "vitest";
import { googleDriveContributionEvidence } from "@/lib/dashboard/gdrive-contributions";
import type { IdentityMap } from "@/lib/identity/resolve";
import { mergeGdriveContributions } from "@/lib/ingest/gdrive-ledger";
import { normalizeGdriveContributions } from "@/lib/ingest/gdrive-contribution-store";

function map(): IdentityMap {
  return {
    byEmail: new Map([
      ["a@example.com", "member-a"],
      ["b@example.com", "member-b"],
    ]),
    byHandle: new Map([["same", "wrong-by-name"]]),
    emailDomains: new Set(["example.com"]),
    byProviderId: new Map([
      ["gdrive:permission:a", "member-a"],
      ["gdrive:permission:b", "member-b"],
    ]),
  };
}

describe("Google Drive source-time Timeline evidence", () => {
  it("AC-09/10: retains prior contributor observations while deduplicating unchanged replay", () => {
    const first = { external_id: "permission:a", role: "editor", at: "2026-01-01T00:00:00Z" };
    const later = { external_id: "permission:b", role: "editor", at: "2026-01-02T00:00:00-05:00" };
    expect(mergeGdriveContributions([first], [first, later])).toEqual([first, later]);
  });
  it("AC-10: preserves distinct contributors/days/roles and normalizes offsets to UTC", () => {
    const rows = googleDriveContributionEvidence(
      {
        source: "gdrive",
        source_id: "Doc1",
        source_url: "https://docs.google.com/document/d/Doc1/edit",
        title: "Plan",
        contributions: [
          { external_id: "permission:a", email: "a@example.com", display_name: "Same", role: "editor", at: "2026-11-01T01:30:00-04:00" },
          { external_id: "permission:b", email: "b@example.com", display_name: "Same", role: "editor", at: "2026-11-01T01:30:00-05:00" },
          { external_id: "permission:a", email: "a@example.com", role: "owner", at: "2026-11-01T01:30:00-04:00" },
        ],
      },
      "item-1",
      map(),
    );

    expect(rows).toEqual([
      expect.objectContaining({ id: "item-1:permission:a:editor:2026-11-01T05:30:00.000Z", memberId: "member-a", role: "editor", at: "2026-11-01T05:30:00.000Z" }),
      expect.objectContaining({ id: "item-1:permission:b:editor:2026-11-01T06:30:00.000Z", memberId: "member-b", role: "editor", at: "2026-11-01T06:30:00.000Z" }),
      expect.objectContaining({ id: "item-1:permission:a:owner:2026-11-01T05:30:00.000Z", memberId: "member-a", role: "owner", at: "2026-11-01T05:30:00.000Z" }),
    ]);
  });

  it("does not resolve a display-name-only guest and deduplicates replayed observations", () => {
    const fm = {
      source: "gdrive",
      title: "Plan",
      contributions: [
        { display_name: "Same", role: "editor", at: "2026-01-01T00:00:00Z" },
        { external_id: "permission:a", role: "editor", at: "2026-01-01T00:00:00Z" },
        { external_id: "permission:a", role: "editor", at: "2026-01-01T00:00:00Z" },
      ],
    };
    expect(googleDriveContributionEvidence(fm, "item-1", map())).toHaveLength(1);
  });

  it("honors both manual member locks and an explicit credit-nobody lock while retaining roles", () => {
    const fm = {
      source: "gdrive",
      title: "Plan",
      contributions: [
        { external_id: "permission:a", role: "editor", at: "2026-01-01T00:00:00Z" },
        { external_id: "permission:b", role: "owner", at: "2026-01-02T00:00:00Z" },
      ],
    };
    expect(googleDriveContributionEvidence(fm, "item-1", map(), {
      memberIdLocked: true, memberId: null,
    })).toEqual([]);
    expect(googleDriveContributionEvidence(fm, "item-1", map(), {
      memberIdLocked: true, memberId: "manual-member",
    })).toEqual([
      expect.objectContaining({ memberId: "manual-member", role: "editor" }),
      expect.objectContaining({ memberId: "manual-member", role: "owner" }),
    ]);
  });

  it("never uses display-name, local-part, or ambiguous email heuristics for Drive credit", () => {
    const identities = map();
    identities.ambiguousEmails = new Set(["a@example.com"]);
    expect(googleDriveContributionEvidence({
      source: "gdrive",
      contributions: [
        { email: "a@example.com", display_name: "same", role: "editor", at: "2026-01-01T00:00:00Z" },
        { email: "same@example.com", display_name: "same", role: "owner", at: "2026-01-01T00:00:00Z" },
      ],
    }, "item-1", identities)).toEqual([]);
  });

  it("does not let exact-email fallback undo an explicit stable-id unlink", () => {
    const identities = map();
    identities.byProviderId.delete("gdrive:permission:a");
    identities.providerIdentityStates = new Map([["gdrive:permission:a", "unlinked"]]);
    expect(googleDriveContributionEvidence({
      source: "gdrive",
      contributions: [{
        external_id: "permission:a", email: "a@example.com",
        role: "editor", at: "2026-01-01T00:00:00Z",
      }],
    }, "item-1", identities)).toEqual([]);
  });

  it("retains unresolved and malformed provider observations with explicit diagnostics", () => {
    const rows = normalizeGdriveContributions({
      source: "gdrive",
      contributions: [
        { display_name: "Unknown", role: "editor", at: "2026-01-01T00:00:00Z" },
        { external_id: "permission:a", role: "owner", at: "not-a-date" },
      ],
    });
    expect(rows.map((row) => row.diagnostic)).toEqual(["missing_identity", "missing_source_time"]);
    expect(normalizeGdriveContributions({
      source: "gdrive", contributions: [
        { external_id: "permission:a", role: "editor", at: "2026-01-01T00:00:00Z" },
        { external_id: "permission:a", role: "editor", at: "2026-01-01T00:00:00Z" },
      ],
    })).toHaveLength(1);
  });
});
