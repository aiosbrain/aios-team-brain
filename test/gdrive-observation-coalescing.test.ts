import { describe, expect, it } from "vitest";

import { googleDriveContributionEvidence } from "@/lib/dashboard/gdrive-contributions";
import type { IdentityMap } from "@/lib/identity/resolve";
import { normalizeGdriveContributions, supersededEvidenceKeys } from "@/lib/ingest/gdrive-contribution-store";
import { coalesceGdriveObservations, mergeGdriveContributions } from "@/lib/ingest/gdrive-ledger";

/**
 * AIO-1167 R44 S4 — one observation, reported first by email and later by permission id, is ONE
 * activity.
 *
 * Spec. An email-only observation and a stable-id observation that names the same email at the same
 * role and instant are the same observation — the stable-id row is the explicit evidence — and they
 * coalesce in the frontmatter ledger, the evidence store and the Timeline read, in either order, with
 * the stable row's provenance kept. Only an UNAMBIGUOUS match coalesces: two different stable ids
 * carrying that email there leave the email-only row as it is. A different role, instant or email is
 * a different observation. Sharing an AIOS member is never evidence.
 */

const AT = "2026-10-20T10:00:00Z";
const EMAIL_ONLY = { email: "Person@Example.com", role: "editor", at: AT };
const STABLE = { external_id: "permission:P", email: "person@example.com", role: "editor", at: "2026-10-20T10:00:00.000Z" };

describe("coalesceGdriveObservations", () => {
  it.each([[[EMAIL_ONLY, STABLE]], [[STABLE, EMAIL_ONLY]]])("folds the email-only form into the stable one, in either order", (rows) => {
    expect(coalesceGdriveObservations(rows)).toEqual([STABLE]);
  });

  it("is not evidence when two stable ids carry the email at that instant", () => {
    const other = { ...STABLE, external_id: "permission:Q" };
    expect(coalesceGdriveObservations([EMAIL_ONLY, STABLE, other])).toEqual([EMAIL_ONLY, STABLE, other]);
  });

  it.each([
    ["another role", { ...EMAIL_ONLY, role: "commenter" }],
    ["another instant", { ...EMAIL_ONLY, at: "2026-10-20T10:00:01Z" }],
    ["another email", { ...EMAIL_ONLY, email: "else@example.com" }],
  ])("%s is a different observation", (_case, row) => {
    expect(coalesceGdriveObservations([row, STABLE])).toEqual([row, STABLE]);
  });

  it("a stable row without an email proves nothing about an email-only row", () => {
    const noEmail = { external_id: "permission:P", role: "editor", at: AT };
    expect(coalesceGdriveObservations([EMAIL_ONLY, noEmail])).toEqual([EMAIL_ONLY, noEmail]);
  });
});

describe("the ledger, the evidence store and the Timeline read agree", () => {
  it("the frontmatter ledger keeps one row, in both replay orders", () => {
    expect(mergeGdriveContributions([EMAIL_ONLY], [STABLE])).toEqual([STABLE]);
    expect(mergeGdriveContributions([STABLE], [EMAIL_ONLY])).toEqual([STABLE]);
  });

  it("the evidence store normalizes one observation and retires the stored email-only row", () => {
    const current = normalizeGdriveContributions({ source: "gdrive", contributions: [EMAIL_ONLY, STABLE] });
    expect(current.map((row) => row.externalId)).toEqual(["permission:P"]);
    const [legacy] = normalizeGdriveContributions({ source: "gdrive", contributions: [EMAIL_ONLY] });
    const stored = [{
      evidence_key: legacy.evidenceKey, external_id: null, email: "person@example.com", role: "editor",
      source_at: "2026-10-20 10:00:00+00", source_at_raw: AT,
    }];
    expect(supersededEvidenceKeys(stored, current)).toEqual([legacy.evidenceKey]);
    // Ambiguous: two stable ids carry the email — the email-only row is not retired.
    const ambiguous = normalizeGdriveContributions({
      source: "gdrive", contributions: [STABLE, { ...STABLE, external_id: "permission:Q" }],
    });
    expect(supersededEvidenceKeys(stored, ambiguous)).toEqual([]);
  });

  it("a ledger stored before coalescing renders one Timeline activity, with the stable provenance", () => {
    const identities: IdentityMap = {
      byEmail: new Map([["person@example.com", "member-a"]]), byHandle: new Map(), emailDomains: new Set(),
      byProviderId: new Map([["gdrive:permission:P", "member-a"]]),
      providerIdentityStates: new Map([["gdrive:permission:P", "linked"]]),
    } as unknown as IdentityMap;
    const rows = googleDriveContributionEvidence(
      { source: "gdrive", title: "Plan", contributions: [EMAIL_ONLY, STABLE] }, "item-1", identities,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ memberId: "member-a", role: "editor" });
    expect(rows[0].id).toContain("permission:P");
  });
});
