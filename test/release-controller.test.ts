import { describe, expect, it, vi } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  publishCandidateCheck, emergencyVerdict, measureCandidate, observeProductionDeployment,
  runReleaseController, updateMainNonForce,
} from "../scripts/staging-ops/release-controller.mjs";

describe("trusted release controller", () => {
  it.each(["validate", "promote", "emergency"] as const)(
    "the actual --run CLI reaches the %s controller action from a staging dispatch without starting the candidate CLI",
    (action) => {
      const directory = mkdtempSync(path.join(tmpdir(), "release-controller-entry-"));
      try {
        const auditPath = path.join(directory, "audit.json");
        const eventsPath = path.join(directory, "events.jsonl");
        writeFileSync(eventsPath, "");
        const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
        const producerIds = Object.fromEntries([
          "Docs drift guard", "Static checks (lint + typecheck)", "Secret scan (gitleaks)",
          "Brain unit tests (vitest)", "Data-mechanics tests (real Postgres)", "Integration tests (HTTP)",
          "Graph Neo4j tier (real Neo4j)", "Ingestion tests (pytest)", "NDA confidentiality gate",
          "Staging paired refresh integration", "Release candidate gate",
        ].map((name) => [name, 15368]));
        execFileSync(process.execPath, ["--import", fileURLToPath(new URL("./fixtures/release-controller-provider-preload.mjs", import.meta.url)), "scripts/staging-ops/release-controller.mjs", "--run"], {
          cwd: path.resolve(import.meta.dirname, ".."),
          env: {
            ...process.env,
            GITHUB_REF: "refs/heads/staging", GITHUB_REPOSITORY: "owner/repo", GITHUB_SHA: "d".repeat(40),
            GITHUB_TOKEN: "read-token", GITHUB_ACTOR: "operator", RELEASE_ACTION: action,
            RELEASE_AUDIT_PATH: auditPath, RELEASE_FIXTURE_EVENTS: eventsPath,
            RELEASE_TAG: "v1.2.3", RELEASE_DEPLOYMENT_ID: "staging-dep", RELEASE_MODE: "copy-ready",
            RELEASE_NOTES: "Validated representative access paths", RELEASE_INCIDENT_URL: "https://linear.app/acme/issue/AIO-997",
            RELEASE_EMERGENCY_SHA: "b".repeat(40), RELEASE_PRODUCER_IDS_JSON: JSON.stringify(producerIds),
            STAGING_COPY_MODE_ACTIVATED: "true", STAGING_ORIGIN: "https://staging.example.test",
            STAGING_HEALTH_TOKEN: "h".repeat(32), RAILWAY_STAGING_READ_TOKEN: "staging-read",
            RAILWAY_STAGING_ENVIRONMENT_ID: "staging-env", RAILWAY_STAGING_APP_SERVICE_ID: "staging-app",
            RAILWAY_PRODUCTION_READ_TOKEN: "production-read", RAILWAY_PRODUCTION_ENVIRONMENT_ID: "production-env",
            RAILWAY_PRODUCTION_APP_SERVICE_ID: "production-app", PRODUCTION_DEPLOY_TIMEOUT_MS: "0",
            RELEASE_APP_ID: "1", RELEASE_APP_INSTALLATION_ID: "2",
            RELEASE_APP_PRIVATE_KEY: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
            EMERGENCY_APP_ID: "3", EMERGENCY_APP_INSTALLATION_ID: "4",
            EMERGENCY_APP_PRIVATE_KEY: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
          },
          stdio: "pipe",
        });
        const audit = JSON.parse(readFileSync(auditPath, "utf8"));
        expect(audit).toMatchObject({ action, verdict: "completed", result: { sha: "b".repeat(40) } });
        const events = readFileSync(eventsPath, "utf8");
        expect(events).not.toContain("candidate-cli-subprocess");
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    },
    30_000,
  );

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

  describe("M7 — terminal release audit", () => {
    const sha = "b".repeat(40);
    const main = "a".repeat(40);
    const baseEnv = {
      RELEASE_ACTION: "promote", GITHUB_REPOSITORY: "owner/repo", GITHUB_SHA: "d".repeat(40),
      RELEASE_AUDIT_PATH: "/unused/audit.json", GITHUB_TOKEN: "read-token", GITHUB_ACTOR: "release-operator",
      RELEASE_APP_ID: "1", RELEASE_APP_INSTALLATION_ID: "2", RELEASE_APP_PRIVATE_KEY: "unused",
    } as NodeJS.ProcessEnv;
    const measured = {
      facts: {
        tagName: "v1.2.3", resolvedTagObjectSha: "t".repeat(40), commitSha: sha,
        deploymentId: "staging-dep", healthOrigin: "https://staging.example.test",
        requestedMode: "copy-ready", healthRunId: "refresh-1", notes: "Validated representative paths",
        expectedMain: main,
      },
      verdict: { ok: true, errors: [], mode: "copy-ready" },
    };
    const common = (over: Record<string, unknown> = {}) => {
      const audits: Record<string, unknown>[] = [];
      return {
        audits,
        operations: {
          githubRead: vi.fn(), measureCandidate: vi.fn().mockResolvedValue(measured),
          writeAudit: vi.fn((_path: string, body: Record<string, unknown>) => audits.push(body)),
          createInstallationToken: vi.fn().mockResolvedValue("app-token"), appRequest: vi.fn(),
          publishCandidateCheck: vi.fn().mockResolvedValue({ id: 1 }),
          ...over,
        },
      };
    };

    it("retains the incident URL in both emergency success and authorization refusal", async () => {
      const incidentUrl = "https://linear.app/acme/issue/AIO-997";
      const emergencyEnv = { ...baseEnv, RELEASE_ACTION: "emergency", RELEASE_EMERGENCY_SHA: sha,
        RELEASE_INCIDENT_URL: incidentUrl, RELEASE_NOTES: "Restore production login immediately",
        EMERGENCY_APP_ID: "3", EMERGENCY_APP_INSTALLATION_ID: "4", EMERGENCY_APP_PRIVATE_KEY: "unused" } as NodeJS.ProcessEnv;
      const success = common({
        githubRead: vi.fn(async (_method: string, path: string) => path.includes("compare/") ? { status: "ahead" } : { object: { sha: main } }),
        updateMainNonForce: vi.fn().mockResolvedValue({ status: "promoted", sha }),
        observeProductionDeployment: vi.fn().mockResolvedValue({ status: "verified" }),
      });
      await expect(runReleaseController(emergencyEnv, success.operations)).resolves.toMatchObject({ status: "promoted", sha });
      expect(success.audits.at(-1)?.facts).toMatchObject({ incidentUrl });
      expect(success.audits.at(-1)).toMatchObject({ verdict: "completed", result: { sha } });

      const refused = common({ githubRead: vi.fn(async (_method: string, path: string) => path.includes("compare/") ? { status: "ahead" } : { object: { sha: main } }) });
      await expect(runReleaseController({ ...emergencyEnv, RELEASE_NOTES: "short" } as NodeJS.ProcessEnv, refused.operations)).rejects.toThrow(/concrete emergency reason/);
      expect(refused.audits.at(-1)).toMatchObject({ verdict: "refused", facts: { incidentUrl } });
    });

    it("records token failure as a finalized refusal with no update attempt", async () => {
      const run = common({ createInstallationToken: vi.fn().mockRejectedValue(new Error("token exchange unavailable")) });
      await expect(runReleaseController(baseEnv, run.operations)).rejects.toThrow(/token exchange unavailable/);
      expect(run.operations.appRequest).not.toHaveBeenCalled();
      expect(run.audits.at(-1)).toMatchObject({
        verdict: "refused", result: { status: "refused", phase: "installation-token", updateAttempted: false },
      });
    });

    it("reconciles an ambiguous PATCH by read-back and never retries the update", async () => {
      const request = vi.fn()
        .mockResolvedValueOnce({ object: { sha: main } })
        .mockResolvedValueOnce({ status: "ahead" })
        .mockRejectedValueOnce(new Error("socket closed after request body"))
        .mockResolvedValueOnce({ object: { sha: main } });
      await expect(updateMainNonForce({ request, repository: "owner/repo", expectedMain: main, candidateSha: sha }))
        .resolves.toMatchObject({ status: "promotion-outcome-ambiguous", expectedSha: sha, observedMain: main });
      expect(request.mock.calls.filter(([method]) => method === "PATCH")).toHaveLength(1);
    });

    it("finalizes the controller audit as ambiguous instead of relabeling the update a refusal", async () => {
      const ambiguous = { status: "promotion-outcome-ambiguous", sha: null, expectedSha: sha, observedMain: null };
      const run = common({ updateMainNonForce: vi.fn().mockResolvedValue(ambiguous) });
      await expect(runReleaseController(baseEnv, run.operations)).rejects.toThrow(/promotion-outcome-ambiguous/);
      expect(run.audits.at(-1)).toMatchObject({ verdict: "promotion-outcome-ambiguous", result: ambiguous });
    });

    it("retains the promoted SHA when production observation fails", async () => {
      const run = common({
        updateMainNonForce: vi.fn().mockResolvedValue({ status: "promoted", sha }),
        observeProductionDeployment: vi.fn().mockResolvedValue({ status: "promoted-but-deployment-unverified", observationError: "Railway unavailable" }),
      });
      await expect(runReleaseController(baseEnv, run.operations)).rejects.toThrow(/promoted-but-deployment-unverified/);
      expect(run.audits.at(-1)).toMatchObject({
        verdict: "promoted-but-deployment-unverified",
        result: { status: "promoted", sha, production: { status: "promoted-but-deployment-unverified" } },
      });
    });

    it.each([
      ["verified", { status: "verified" }, "completed"],
      ["failed", { status: "promoted-but-deployment-failed" }, "promoted-but-deployment-failed"],
      ["wrong SHA until deadline", { status: "promoted-but-deployment-unverified", deployment: { commitSha: main } }, "promoted-but-deployment-unverified"],
    ] as const)("observes an emergency deployment that is %s without repeating the main update", async (_label, observation, verdict) => {
      const emergencyEnv = { ...baseEnv, RELEASE_ACTION: "emergency", RELEASE_EMERGENCY_SHA: sha,
        RELEASE_INCIDENT_URL: "https://linear.app/acme/issue/AIO-997", RELEASE_NOTES: "Restore production login immediately",
        EMERGENCY_APP_ID: "3", EMERGENCY_APP_INSTALLATION_ID: "4", EMERGENCY_APP_PRIVATE_KEY: "unused" } as NodeJS.ProcessEnv;
      const update = vi.fn().mockResolvedValue({ status: "promoted", sha });
      const observe = vi.fn().mockResolvedValue(observation);
      const run = common({
        githubRead: vi.fn(async (_method: string, requestPath: string) => requestPath.includes("compare/") ? { status: "ahead" } : { object: { sha: main } }),
        updateMainNonForce: update,
        observeProductionDeployment: observe,
      });
      const outcome = runReleaseController(emergencyEnv, run.operations);
      if (verdict === "completed") await expect(outcome).resolves.toMatchObject({ status: "promoted", sha, production: { status: "verified" } });
      else await expect(outcome).rejects.toThrow(new RegExp(verdict));
      expect(update).toHaveBeenCalledTimes(1);
      expect(observe).toHaveBeenCalledTimes(1);
      expect(run.audits.at(-1)).toMatchObject({ verdict, result: { status: "promoted", sha, production: observation } });
    });

    it("records an emergency observer exception as promoted-but-unverified and never repeats the update", async () => {
      const emergencyEnv = { ...baseEnv, RELEASE_ACTION: "emergency", RELEASE_EMERGENCY_SHA: sha,
        RELEASE_INCIDENT_URL: "https://linear.app/acme/issue/AIO-997", RELEASE_NOTES: "Restore production login immediately",
        EMERGENCY_APP_ID: "3", EMERGENCY_APP_INSTALLATION_ID: "4", EMERGENCY_APP_PRIVATE_KEY: "unused" } as NodeJS.ProcessEnv;
      const update = vi.fn().mockResolvedValue({ status: "promoted", sha });
      const run = common({
        githubRead: vi.fn(async (_method: string, requestPath: string) => requestPath.includes("compare/") ? { status: "ahead" } : { object: { sha: main } }),
        updateMainNonForce: update,
        observeProductionDeployment: vi.fn().mockRejectedValue(new Error("observer transport failed")),
      });
      await expect(runReleaseController(emergencyEnv, run.operations)).rejects.toThrow(/observer transport failed/);
      expect(update).toHaveBeenCalledTimes(1);
      expect(run.audits.at(-1)).toMatchObject({
        verdict: "promoted-but-deployment-unverified",
        result: { status: "promoted", sha, production: { status: "promoted-but-deployment-unverified" } },
      });
    });
  });
});
