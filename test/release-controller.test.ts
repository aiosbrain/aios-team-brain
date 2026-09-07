import { describe, expect, it, vi } from "vitest";
import { publishCandidateCheck, emergencyVerdict, measureCandidate, observeProductionDeployment } from "../scripts/staging-ops/release-controller.mjs";

describe("trusted release controller", () => {
  it("publishes validation on the candidate SHA, never the dispatch SHA", async () => {
    const request = vi.fn().mockResolvedValue({ id: 9, html_url: "https://github.test/check/9" });
    await publishCandidateCheck({
      request,
      repository: "owner/repo",
      candidateSha: "candidate-sha",
      dispatchSha: "dispatch-sha",
      conclusion: "success",
      summary: "validated",
    });
    expect(request).toHaveBeenCalledWith("POST", "/repos/owner/repo/check-runs", expect.objectContaining({ head_sha: "candidate-sha" }));
    expect(JSON.stringify(request.mock.calls)).not.toContain('"head_sha":"dispatch-sha"');
  });

  it("requires incident URL, concrete reason, authorization and non-force ancestry for emergency", () => {
    expect(emergencyVerdict({ incidentUrl: "https://linear.app/acme/issue/AIO-1", reason: "Restore login after auth regression", authorizedBy: "operator", mainIsAncestor: true })).toEqual({ ok: true, errors: [] });
    for (const changed of [
      { incidentUrl: "" },
      { reason: "fix" },
      { authorizedBy: "" },
      { mainIsAncestor: false },
    ]) expect(emergencyVerdict({ incidentUrl: "https://linear.app/acme/issue/AIO-1", reason: "Restore login after auth regression", authorizedBy: "operator", mainIsAncestor: true, ...changed }).ok).toBe(false);
  });

  it("measures checks, deployment, health, ancestry and tag immutability without candidate execution", async () => {
    const tagSha = "a".repeat(40);
    const candidate = "b".repeat(40);
    const producerIds = Object.fromEntries([
      "Docs drift guard", "Static checks (lint + typecheck)", "Secret scan (gitleaks)",
      "Brain unit tests (vitest)", "Data-mechanics tests (real Postgres)", "Integration tests (HTTP)",
      "Graph Neo4j tier (real Neo4j)", "Ingestion tests (pytest)", "NDA confidentiality gate",
      "Staging paired refresh integration", "Release candidate gate",
    ].map((name) => [name, 15368]));
    const request = vi.fn(async (_method: string, path: string) => {
      if (path.includes("/git/ref/tags/")) return { object: { type: "tag", sha: tagSha } };
      if (path.includes("/git/tags/")) return { object: { type: "commit", sha: candidate } };
      if (path.includes("/contents/package.json")) return { encoding: "base64", content: Buffer.from(JSON.stringify({ version: "1.2.3" })).toString("base64") };
      if (path.includes("/compare/main...")) return { status: "ahead", base_commit: { sha: "c".repeat(40) } };
      if (path.includes("/compare/")) return { status: "ahead" };
      if (path.includes("/check-runs")) return { check_runs: Object.keys(producerIds).map((name) => ({ name, status: "completed", conclusion: "success", app: { id: 15368 } })) };
      throw new Error(`unexpected ${path}`);
    });
    const result = await measureCandidate({
      githubRequest: request,
      railwayRead: vi.fn().mockResolvedValue({ id: "dep", status: "SUCCESS", url: "https://staging.example.com", commitSha: candidate }),
      healthProbe: vi.fn().mockResolvedValue({ status: 200, ok: true, origin: "https://staging.example.com", finalOrigin: "https://staging.example.com", commit: candidate, mode: "copy-ready", refreshRunId: "run-1" }),
      repository: "owner/repo", tagName: "v1.2.3", deploymentId: "dep", requestedMode: "copy-ready",
      notes: "Validated representative access paths", copyModeActivated: true, producerIds,
    });
    expect(result.verdict).toMatchObject({ ok: true, mode: "copy-ready" });
    expect(result.facts.commitSha).toBe(candidate);
    expect(result.facts.expectedMain).toBe("c".repeat(40));
    expect(request.mock.calls.every(([, path]) => !String(path).includes("archive") && !String(path).includes("actions/artifacts"))).toBe(true);
  });

  it("refuses when Railway reports no deployment domain, and accepts no configured value for it", async () => {
    // Substituting the probed origin for a missing deployment domain makes the probe prove the very
    // value it was handed — self-attestation, not evidence. A repository variable named
    // `STAGING_VERIFIED_DOMAIN` was the same substitution wearing the word "verified": it recorded
    // an operator's belief about the domain, on the one path whose whole purpose is to not trust an
    // unmeasured origin. Unmeasured now refuses, full stop.
    const tagSha = "a".repeat(40);
    const candidate = "b".repeat(40);
    const request = vi.fn(async (_method: string, path: string) => {
      if (path.includes("/git/ref/tags/")) return { object: { type: "tag", sha: tagSha } };
      if (path.includes("/git/tags/")) return { object: { type: "commit", sha: candidate } };
      if (path.includes("/contents/package.json")) return { encoding: "base64", content: Buffer.from(JSON.stringify({ version: "1.2.3" })).toString("base64") };
      if (path.includes("/compare/main...")) return { status: "ahead", base_commit: { sha: "c".repeat(40) } };
      if (path.includes("/compare/")) return { status: "ahead" };
      if (path.includes("/check-runs")) return { check_runs: [] };
      throw new Error(`unexpected ${path}`);
    });
    const args = {
      githubRequest: request,
      railwayRead: vi.fn().mockResolvedValue({ id: "dep", status: "SUCCESS", url: null, commitSha: candidate }),
      healthProbe: vi.fn().mockResolvedValue({ status: 200, ok: true, origin: "https://staging.example.com", finalOrigin: "https://staging.example.com", commit: candidate, mode: "copy-ready", refreshRunId: "run-1" }),
      repository: "owner/repo", tagName: "v1.2.3", deploymentId: "dep", requestedMode: "copy-ready",
      notes: "Validated representative access paths", copyModeActivated: true, producerIds: {},
    };
    await expect(measureCandidate(args)).rejects.toThrow(/UNMEASURED and cannot be substituted/);
    // The configured value has no effect: passing it still refuses.
    await expect(measureCandidate({ ...args, verifiedDeploymentDomain: "staging.example.com" }))
      .rejects.toThrow(/UNMEASURED and cannot be substituted/);
    // Positive control — a MEASURED domain from the provider read is accepted, so the refusal above
    // is about the domain's absence and not about the fixture failing somewhere else.
    await expect(measureCandidate({
      ...args,
      railwayRead: vi.fn().mockResolvedValue({ id: "dep", status: "SUCCESS", url: "https://staging.example.com", commitSha: candidate }),
    })).resolves.toBeTruthy();
  });

  it("sends the staging health token ONLY to the measured deployment domain, and never before measuring it", async () => {
    // The accepted HIGH: the probe used to run in the same `Promise.all` as the deployment read and
    // to target a CONFIGURED origin, so the privileged token was presented to whatever host the
    // environment named and the binding was compared afterwards — a check that cannot prevent what
    // it is checking. Three properties, each stated as its own observable:
    //   (a) with no measurable domain, the probe is never CALLED at all;
    //   (b) when it is called, it is called WITH the measured origin;
    //   (c) a probe that answers about a different origin refuses instead of grading it unhealthy.
    const tagSha = "a".repeat(40);
    const candidate = "b".repeat(40);
    const request = vi.fn(async (_method: string, path: string) => {
      if (path.includes("/git/ref/tags/")) return { object: { type: "tag", sha: tagSha } };
      if (path.includes("/git/tags/")) return { object: { type: "commit", sha: candidate } };
      if (path.includes("/contents/package.json")) return { encoding: "base64", content: Buffer.from(JSON.stringify({ version: "1.2.3" })).toString("base64") };
      if (path.includes("/compare/main...")) return { status: "ahead", base_commit: { sha: "c".repeat(40) } };
      if (path.includes("/compare/")) return { status: "ahead" };
      if (path.includes("/check-runs")) return { check_runs: [] };
      throw new Error(`unexpected ${path}`);
    });
    const base = {
      githubRequest: request,
      repository: "owner/repo", tagName: "v1.2.3", deploymentId: "dep", requestedMode: "copy-ready",
      notes: "Validated representative access paths", copyModeActivated: true, producerIds: {},
    };
    const measured = (url: string | null) =>
      vi.fn().mockResolvedValue({ id: "dep", status: "SUCCESS", url, commitSha: candidate });

    // (a) no measurable domain ⇒ ZERO health requests. Not "one that fails validation afterwards".
    const neverProbe = vi.fn();
    await expect(measureCandidate({ ...base, railwayRead: measured(null), healthProbe: neverProbe }))
      .rejects.toThrow(/UNMEASURED/);
    expect(neverProbe, "no token may be presented when the domain is unmeasured").not.toHaveBeenCalled();

    // (b) called with the measured origin — the probe cannot choose its own target.
    const boundProbe = vi.fn(async (origin: string) => ({
      status: 200, ok: true, origin, finalOrigin: origin, commit: candidate, mode: "copy-ready", refreshRunId: "run-1",
    }));
    await measureCandidate({ ...base, railwayRead: measured("https://staging.example.com"), healthProbe: boundProbe });
    expect(boundProbe).toHaveBeenCalledTimes(1);
    expect(boundProbe).toHaveBeenCalledWith("https://staging.example.com");

    // (c) an answer about another host is a refusal, not a health verdict.
    const wanderingProbe = vi.fn().mockResolvedValue({
      status: 200, ok: true, origin: "https://unrelated.example.com", finalOrigin: "https://unrelated.example.com",
      commit: candidate, mode: "copy-ready", refreshRunId: "run-1",
    });
    await expect(measureCandidate({ ...base, railwayRead: measured("https://staging.example.com"), healthProbe: wanderingProbe }))
      .rejects.toThrow(/not the measured deployment domain/);
  });

  it("distinguishes verified, failed and finite unverified production rollout after promotion", async () => {
    const expected = "a".repeat(40);
    await expect(observeProductionDeployment({ expectedSha: expected, readLatest: vi.fn().mockResolvedValue({ id: "p", commitSha: expected, status: "SUCCESS" }), probeHealth: vi.fn().mockResolvedValue({ status: 200, ok: true, commit: expected }), timeoutMs: 0 })).resolves.toMatchObject({ status: "verified" });
    await expect(observeProductionDeployment({ expectedSha: expected, readLatest: vi.fn().mockResolvedValue({ id: "p", commitSha: expected, status: "FAILED" }), probeHealth: vi.fn(), timeoutMs: 0 })).resolves.toMatchObject({ status: "promoted-but-deployment-failed" });
    let tick = 0;
    await expect(observeProductionDeployment({ expectedSha: expected, readLatest: vi.fn().mockResolvedValue(null), probeHealth: vi.fn(), timeoutMs: 1, now: () => tick++, sleep: vi.fn() })).resolves.toMatchObject({ status: "promoted-but-deployment-unverified" });
  });
});
