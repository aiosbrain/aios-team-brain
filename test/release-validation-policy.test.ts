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
