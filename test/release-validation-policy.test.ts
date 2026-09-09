import { describe, expect, it } from "vitest";
import {
  candidateValidationVerdict,
  type CandidateValidationFacts,
} from "../scripts/staging-ops/release-policy.mjs";

const GOOD: CandidateValidationFacts = {
  tagName: "v1.2.3",
  tagObjectType: "tag",
  eventTagObjectSha: "tag-object",
  resolvedTagObjectSha: "tag-object",
  commitSha: "candidate",
  tagCommitSha: "candidate",
  requiredChecks: ["Static checks", "Docs drift guard"],
  successfulChecks: ["Static checks", "Docs drift guard"],
  deploymentId: "deployment-1",
  deploymentCommitSha: "candidate",
  deploymentStatus: "SUCCESS",
  healthOrigin: "https://staging.example.com",
  healthFinalOrigin: "https://staging.example.com",
  healthCommitSha: "candidate",
  healthMode: "copy-ready",
  healthRunId: "refresh-7",
  healthOk: true,
  requestedMode: "copy-ready",
  copyModeActivated: true,
  notes: "Validated the release workflow and representative tier reads.",
};

describe("exact candidate validation policy", () => {
  it("accepts evidence bound to one immutable annotated tag, SHA, deployment and ready copy", () => {
    expect(candidateValidationVerdict(GOOD)).toEqual({ ok: true, errors: [], verdict: "copy-ready" });
  });

  it.each([
    ["moved tag", { resolvedTagObjectSha: "moved" }],
    ["wrong tag commit", { tagCommitSha: "other" }],
    ["pending CI", { successfulChecks: ["Static checks"] }],
    ["wrong deployment", { deploymentCommitSha: "dispatch-sha" }],
    ["failed deployment", { deploymentStatus: "FAILED" }],
    ["off-origin redirect", { healthFinalOrigin: "https://login.example.com" }],
    ["wrong health SHA", { healthCommitSha: "current-staging" }],
    ["empty notes", { notes: "  " }],
    ["journal not ready", { healthOk: false }],
  ])("refuses %s", (_name, changed) => {
    const result = candidateValidationVerdict({ ...GOOD, ...changed });
    expect(result.ok).toBe(false);
    expect(result.errors).not.toEqual([]);
  });

  /**
   * ONE CHANGE FROM GOOD, and the errors are asserted EXACTLY.
   *
   * `expect(result.errors).not.toEqual([])` above is satisfied by any refusal, including one caused
   * by a fixture that was already invalid for an unrelated reason. Each row here changes a single
   * fact, names the predicate it is aiming at, and asserts that predicate is the ONLY one that
   * fired — so removing that predicate reddens this row instead of being absorbed by a sibling.
   */
  it.each([
    ["absent deployment identity", { deploymentId: null }, "staging deployment identity is missing"],
    // Distinct from the row above on purpose: "we do not know which deployment" and "that
    // deployment did not succeed" send an operator to different places.
    ["a deployment status that is neither success nor failure", { deploymentStatus: "BUILDING" }, "staging deployment is not successful"],
    // An EMPTY required set makes "every required check succeeded" vacuously true — the classic
    // shape of a gate that passes because it is measuring nothing.
    ["an empty required check set", { requiredChecks: [] }, "required check set is empty"],
    ["a lightweight tag", { tagObjectType: "commit" }, "release tag must be annotated"],
    ["a malformed tag name", { tagName: "v1.2" }, "tag must be exactly vX.Y.Z"],
    // Requested copy-ready, health reports legacy. The run ID stays VALID here so the only thing
    // this row can be refusing is the mode disagreement itself.
    ["requested copy-ready against a legacy health mode", { healthMode: "legacy-pg-only" }, "health mode does not equal the explicitly requested mode"],
  ])("refuses %s, and for exactly that reason", (_name, changed, reason) => {
    const result = candidateValidationVerdict({ ...GOOD, ...changed } as CandidateValidationFacts);
    expect(result.errors).toEqual([reason]);
    expect(result.ok).toBe(false);
    expect(result.verdict).toBe("refused");
  });

  it("allows explicitly selected legacy validation only before copy activation and never calls it copy-ready", () => {
    const result = candidateValidationVerdict({
      ...GOOD,
      requestedMode: "legacy-pg-only",
      healthMode: "legacy-pg-only",
      healthRunId: null,
      copyModeActivated: false,
    });
    expect(result).toEqual({ ok: true, errors: [], verdict: "legacy-pg-only" });
    expect(candidateValidationVerdict({
      ...GOOD,
      requestedMode: "legacy-pg-only",
      healthMode: "legacy-pg-only",
      healthRunId: null,
      copyModeActivated: true,
    }).ok).toBe(false);
  });
});
