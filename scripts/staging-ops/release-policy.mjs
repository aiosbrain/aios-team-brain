const RELEASE_TAG = /^v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/;

/** Pure exact-SHA candidate decision. Provider clients only measure these facts. */
export function candidateValidationVerdict(facts) {
  const errors = [];
  const requestedMode = facts?.requestedMode;

  if (!RELEASE_TAG.test(String(facts?.tagName ?? ""))) errors.push("tag must be exactly vX.Y.Z");
  if (facts?.tagObjectType !== "tag") errors.push("release tag must be annotated");
  if (!facts?.eventTagObjectSha || facts.eventTagObjectSha !== facts?.resolvedTagObjectSha) errors.push("tag object moved after dispatch");
  if (!facts?.commitSha || facts.commitSha !== facts?.tagCommitSha) errors.push("tag does not peel to the candidate SHA");

  const required = new Set(Array.isArray(facts?.requiredChecks) ? facts.requiredChecks : []);
  const successful = new Set(Array.isArray(facts?.successfulChecks) ? facts.successfulChecks : []);
  const missing = [...required].filter((name) => !successful.has(name));
  if (required.size === 0) errors.push("required check set is empty");
  if (missing.length) errors.push(`candidate checks are missing or non-successful: ${missing.join(", ")}`);

  if (!facts?.deploymentId) errors.push("staging deployment identity is missing");
  if (facts?.deploymentStatus !== "SUCCESS") errors.push("staging deployment is not successful");
  if (!facts?.deploymentCommitSha || facts.deploymentCommitSha !== facts?.commitSha) errors.push("staging deployment is not the candidate SHA");
  if (!facts?.healthOrigin || facts.healthOrigin !== facts?.healthFinalOrigin) errors.push("health probe redirected off the pinned staging origin");
  if (!facts?.healthOk) errors.push("candidate health is not ready");
  if (facts?.healthCommitSha !== facts?.commitSha) errors.push("health response is not the candidate SHA");
  if (!String(facts?.notes ?? "").trim()) errors.push("validation notes are required");

  if (requestedMode !== "copy-ready" && requestedMode !== "legacy-pg-only") {
    errors.push("requested mode must be copy-ready or legacy-pg-only");
  } else if (facts?.healthMode !== requestedMode) {
    errors.push("health mode does not equal the explicitly requested mode");
  }
  if (requestedMode === "copy-ready" && !facts?.healthRunId) errors.push("copy-ready health must identify a ready refresh run");
  if (requestedMode === "legacy-pg-only" && facts?.copyModeActivated) errors.push("legacy mode cannot satisfy validation after paired copying is activated");

  return {
    ok: errors.length === 0,
    errors,
    verdict: errors.length === 0 ? requestedMode : "refused",
  };
}
