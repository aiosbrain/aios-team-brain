import { describe, expect, it } from "vitest";

import {
  GDRIVE_OAUTH_CREDENTIAL_KEYS,
  gdriveRootKeys,
  mergeLockedGdriveCredentialFields,
  unverifiedOauthRoots,
} from "@/lib/integrations/gdrive-credential-fields";

/**
 * AIO-1167 R42 F6 — the credential-owned Drive config fields are re-derived from the LOCKED row on
 * every Admin save; the caller's values for them never survive. Real-Postgres interleavings live in
 * `test/datamechanics/gdrive-admin-credential-race.datamechanics.test.ts`; this pins the rules.
 */

const LOCKED_OAUTH = {
  fileIds: ["a", "b"], folderIds: ["f"], sharedDriveIds: [], authMode: "oauth",
  authenticatedAccount: "new@example.com", authenticatedAccountEmailVerified: false,
  authenticatedAccountId: "subject:new", scopeSet: ["scope-new"], audienceProjectIds: ["p1"],
};

describe("mergeLockedGdriveCredentialFields — OAuth", () => {
  it("takes every OAuth credential field from the locked row, discarding the caller's", () => {
    const stale = {
      fileIds: ["a"], authMode: "oauth", audienceProjectIds: ["p2"],
      authenticatedAccount: "old@example.com", authenticatedAccountEmailVerified: true,
      authenticatedAccountId: "subject:old", scopeSet: ["scope-old"],
    };
    expect(mergeLockedGdriveCredentialFields(stale, LOCKED_OAUTH)).toEqual({
      fileIds: ["a"], authMode: "oauth", audienceProjectIds: ["p2"],
      authenticatedAccount: "new@example.com", authenticatedAccountEmailVerified: false,
      authenticatedAccountId: "subject:new", scopeSet: ["scope-new"],
    });
  });

  it("a field the locked row lacks is absent, even when the caller supplies one", () => {
    const locked = { authMode: "oauth", authenticatedAccountId: "subject:new" };
    const merged = mergeLockedGdriveCredentialFields(
      { authMode: "oauth", authenticatedAccount: "injected@example.com", scopeSet: ["x"] }, locked,
    );
    expect(merged).toEqual({ authMode: "oauth", authenticatedAccountId: "subject:new" });
  });

  it("absent authMode means OAuth on both sides", () => {
    expect(mergeLockedGdriveCredentialFields({ fileIds: [] }, { authenticatedAccountId: "subject:x" }))
      .toEqual({ fileIds: [], authenticatedAccountId: "subject:x" });
  });

  it("copies nothing from a locked service-account row and drops service-account fields", () => {
    const locked = { authMode: "service_account", serviceAccountStatus: "verified", serviceAccountIdentity: "bot@x" };
    expect(mergeLockedGdriveCredentialFields(
      { authMode: "oauth", serviceAccountStatus: "verified", serviceAccountIdentity: "bot@x" }, locked,
    )).toEqual({ authMode: "oauth" });
  });

  it("a brand-new connection (no locked row) carries no credential fields", () => {
    const merged = mergeLockedGdriveCredentialFields({ authMode: "oauth", authenticatedAccountId: "subject:x" }, {});
    for (const key of GDRIVE_OAUTH_CREDENTIAL_KEYS) expect(merged).not.toHaveProperty(key);
  });

  it("returns a new object and leaves both inputs untouched", () => {
    const next = { authMode: "oauth", authenticatedAccountId: "subject:old" };
    const nextCopy = structuredClone(next);
    const lockedCopy = structuredClone(LOCKED_OAUTH);
    const merged = mergeLockedGdriveCredentialFields(next, LOCKED_OAUTH);
    expect(merged).not.toBe(next);
    expect(next).toEqual(nextCopy);
    expect(LOCKED_OAUTH).toEqual(lockedCopy);
  });
});

describe("mergeLockedGdriveCredentialFields — service account", () => {
  const locked = {
    fileIds: ["a"], folderIds: [], sharedDriveIds: [], authMode: "service_account",
    serviceAccountStatus: "failed", serviceAccountIdentity: "bot@x",
  };

  it("same roots over a locked service-account row: the LOCKED verification survives, not the caller's", () => {
    expect(mergeLockedGdriveCredentialFields(
      { fileIds: ["a"], authMode: "service_account", serviceAccountStatus: "verified" }, locked,
    )).toEqual({ fileIds: ["a"], authMode: "service_account", serviceAccountStatus: "failed", serviceAccountIdentity: "bot@x" });
  });

  it("changed roots reset to pending with no identity", () => {
    expect(mergeLockedGdriveCredentialFields({ fileIds: ["a", "b"], authMode: "service_account" }, locked))
      .toEqual({ fileIds: ["a", "b"], authMode: "service_account", serviceAccountStatus: "pending" });
  });

  it("switching from OAuth resets to pending and drops every OAuth field", () => {
    expect(mergeLockedGdriveCredentialFields(
      { fileIds: ["a", "b"], authMode: "service_account", authenticatedAccountId: "subject:old" }, LOCKED_OAUTH,
    )).toEqual({ fileIds: ["a", "b"], authMode: "service_account", serviceAccountStatus: "pending" });
  });

  it("a locked row with no recorded status reads as pending", () => {
    expect(mergeLockedGdriveCredentialFields(
      { fileIds: ["a"], authMode: "service_account" }, { fileIds: ["a"], authMode: "service_account" },
    )).toEqual({ fileIds: ["a"], authMode: "service_account", serviceAccountStatus: "pending" });
  });
});

describe("unverifiedOauthRoots", () => {
  it("lists roots of every kind the locked row lacks; keeping and removing are fine", () => {
    expect(unverifiedOauthRoots({ fileIds: ["a"], folderIds: ["f"] }, LOCKED_OAUTH)).toEqual([]);
    expect(unverifiedOauthRoots(
      { fileIds: ["a", "c"], folderIds: ["g"], sharedDriveIds: ["d"] }, LOCKED_OAUTH,
    )).toEqual(["file:c", "folder:g", "drive:d"]);
  });

  it("kinds are distinct: a file id is not covered by a folder of the same id", () => {
    expect(unverifiedOauthRoots({ fileIds: ["f"] }, LOCKED_OAUTH)).toEqual(["file:f"]);
  });

  it("every root is unverified against a connection that does not exist yet", () => {
    expect(unverifiedOauthRoots({ fileIds: ["a"] }, {})).toEqual(["file:a"]);
  });

  it("service-account saves are never refused here (their roots are verified by the fenced read)", () => {
    expect(unverifiedOauthRoots({ fileIds: ["new"], authMode: "service_account" }, LOCKED_OAUTH)).toEqual([]);
  });
});

describe("gdriveRootKeys", () => {
  it("ignores non-array and non-string entries", () => {
    expect([...gdriveRootKeys({ fileIds: ["a", 3, null], folderIds: "x" })]).toEqual(["file:a"]);
  });
});
