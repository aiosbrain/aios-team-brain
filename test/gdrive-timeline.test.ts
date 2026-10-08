import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { googleDriveContributionEvidence } from "@/lib/dashboard/gdrive-contributions";
import type { IdentityMap } from "@/lib/identity/resolve";
import { mergeGdriveContributions } from "@/lib/ingest/gdrive-ledger";
import { normalizeGdriveContributions, supersededEvidenceKeys } from "@/lib/ingest/gdrive-contribution-store";

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

/**
 * Spec. A source observation is a person in a role at an instant. When the provider gives a stable
 * id for the person, that id — not the e-mail shown beside it — is who they are, and the instant is
 * the same instant however it is spelled. The frontmatter ledger and the evidence ledger must agree
 * on that: an observation replayed with a new e-mail or a re-spelled timestamp is ONE row in both,
 * never a second evidence row beside a stale one.
 */
describe("Google Drive contribution evidence identity", () => {
  const evidenceKey = (contribution: Record<string, unknown>) =>
    normalizeGdriveContributions({ source: "gdrive", contributions: [contribution] })[0].evidenceKey;
  const legacyKey = (externalId: string, email: string, role: string, raw: string) =>
    createHash("md5").update(`${externalId}\u001f${email}\u001f${role}\u001f${raw}`).digest("hex");
  const observed = { external_id: "permission:a", email: "old@example.com", role: "Editor", at: "2026-01-01T00:00:00Z" };
  const replayed = { external_id: "permission:a", email: "new@example.com", role: "editor", at: "2025-12-31T19:00:00.000-05:00" };

  it("keys a stable provider identity by id, role and instant, whatever the e-mail or timestamp spelling", () => {
    expect(evidenceKey(replayed)).toBe(evidenceKey(observed));
    expect(evidenceKey({ ...observed, email: undefined, display_name: "Renamed" })).toBe(evidenceKey(observed));

    // One frontmatter that still carries both spellings is one row holding the latest metadata.
    const rows = normalizeGdriveContributions({ source: "gdrive", contributions: [observed, replayed] });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      externalId: "permission:a", email: "new@example.com", role: "editor",
      sourceAt: "2026-01-01T00:00:00.000Z", sourceAtRaw: replayed.at,
    });
  });

  it("keeps distinct people, roles and instants distinct", () => {
    const keys = [
      observed,
      { ...observed, external_id: "permission:b" },
      { ...observed, role: "owner" },
      { ...observed, at: "2026-01-01T00:00:00.001Z" },
      { ...observed, at: "not-a-date" },
      { ...observed, at: "also-not-a-date" },
    ].map(evidenceKey);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("agrees with the frontmatter ledger on which observations are the same", () => {
    const variants = [
      observed,
      replayed,
      { ...observed, role: "owner" },
      { ...replayed, at: "2026-01-01T00:00:01Z" },
      { ...observed, external_id: "permission:b" },
      { ...observed, at: "not-a-date" },
      { ...replayed, at: " not-a-date " },
    ];
    for (const a of variants) {
      for (const b of variants) {
        const oneLedgerRow = mergeGdriveContributions([a], [b]).length === 1;
        expect(evidenceKey(a) === evidenceKey(b), `${JSON.stringify(a)} / ${JSON.stringify(b)}`).toBe(oneLedgerRow);
      }
    }
    expect(mergeGdriveContributions([observed], [replayed])).toEqual([replayed]);
  });

  it("leaves an observation without a stable id on the key the SQL backfill writes", () => {
    expect(evidenceKey({ email: "A@Example.com", role: "Editor", at: "2026-01-01T00:00:00Z" }))
      .toBe(legacyKey("", "a@example.com", "editor", "2026-01-01T00:00:00Z"));
  });

  it("supersedes exactly the stored rows that are the observation being written", () => {
    const current = normalizeGdriveContributions({ source: "gdrive", contributions: [replayed] });
    // Rows as PostgreSQL returns them: `source_at` in its own text form, `source_at_raw` as sent.
    const row = (evidence_key: string, over: Partial<{ external_id: string | null; role: string; source_at: string | null; source_at_raw: string }> = {}) => ({
      evidence_key, external_id: "permission:a", role: "editor",
      source_at: "2026-01-01 00:00:00+00", source_at_raw: "2026-01-01T00:00:00Z", ...over,
    });
    const firstWrite = row(legacyKey("permission:a", "old@example.com", "editor", "2026-01-01T00:00:00Z"));
    const respelled = row(legacyKey("permission:a", "new@example.com", "editor", replayed.at), {
      source_at_raw: replayed.at,
    });
    const stored = [
      firstWrite,
      respelled,
      row(current[0].evidenceKey), // already this observation's row: updated in place, not retired
      row("another-instant", { source_at: "2026-01-02 00:00:00+00", source_at_raw: "2026-01-02T00:00:00Z" }),
      row("another-role", { role: "owner" }),
      row("another-person", { external_id: "permission:b" }),
      row("no-stable-id", { external_id: null }),
    ];
    expect(supersededEvidenceKeys(stored, current)).toEqual([firstWrite.evidence_key, respelled.evidence_key]);
    // Nothing is retired on behalf of an observation that is not being written.
    expect(supersededEvidenceKeys(stored, [])).toEqual([]);
    expect(supersededEvidenceKeys(stored, normalizeGdriveContributions({
      source: "gdrive", contributions: [{ email: "old@example.com", role: "editor", at: "2026-01-01T00:00:00Z" }],
    }))).toEqual([]);
  });
});
