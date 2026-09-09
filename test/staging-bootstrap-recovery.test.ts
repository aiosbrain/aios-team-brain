import { describe, expect, it } from "vitest";
import { bootstrapResumeVerdict, sourceAttemptAdmission } from "../scripts/staging-ops/journal.mjs";

/**
 * H2 (interrupted first bootstrap) and Fable HIGH-1 (repeated destructive install attempts) both
 * turn on one durable predicate each. These are those predicates, exercised directly — the paired
 * harness proves the same properties end-to-end against real stores with real SIGKILLs, and this
 * file is what says WHY each refusal happens rather than only that one did.
 */

const RUN = "bootstrap-2026-09-08T04-00-00-000Z";
const COMMIT = "a".repeat(40);

const env = { RAILWAY_ENVIRONMENT_ID: "env-staging", STAGING_APP_SERVICE_ID: "service-app" } as NodeJS.ProcessEnv;

const record = (over: Record<string, unknown> = {}) => ({
  run_id: RUN,
  state: "draining",
  bootstrap_run_id: RUN,
  bootstrap_phase: "stopping",
  bootstrap_deployment_id: "dep-baseline",
  bootstrap_commit: COMMIT,
  bootstrap_mode: "legacy-pg-only",
  bootstrap_environment_id: "env-staging",
  bootstrap_app_service_id: "service-app",
  bootstrap_object_id: null,
  bootstrap_digest: null,
  ...over,
});

describe("H2 — an interrupted first bootstrap is resumable from its durable record", () => {
  it("resumes the recorded baseline WITHOUT a currently serving deployment", () => {
    // The whole point: after `stopAndVerifyAll()` the platform reports nothing active, so a
    // replacement cannot re-measure. Nothing in this verdict consults a deployment listing.
    const verdict = bootstrapResumeVerdict(record(), env);
    expect(verdict).toMatchObject({ resume: true, phase: "stopping", commit: COMMIT, mode: "legacy-pg-only", deploymentId: "dep-baseline", runId: RUN });
  });

  it("carries the published checkpoint identity forward from the second interruption window", () => {
    const verdict = bootstrapResumeVerdict(record({
      bootstrap_phase: "captured", bootstrap_object_id: `${RUN}--${"f".repeat(64)}`, bootstrap_digest: "f".repeat(64),
    }), env);
    expect(verdict).toMatchObject({ resume: true, phase: "captured", digest: "f".repeat(64) });
  });

  it("covers BOTH supported modes, since a legacy-pg-only baseline is a supported bootstrap", () => {
    for (const mode of ["legacy-pg-only", "copy-ready"]) {
      expect(bootstrapResumeVerdict(record({ bootstrap_mode: mode }), env).resume).toBe(true);
    }
  });

  it("does nothing at all when no interruption is recorded", () => {
    // Distinct from a refusal: an ordinary first bootstrap must take the normal measured path, and
    // the caller distinguishes these two by `bootstrap_run_id` being absent.
    expect(bootstrapResumeVerdict(record({ bootstrap_run_id: null }), env)).toMatchObject({ resume: false });
    expect(bootstrapResumeVerdict({}, env)).toMatchObject({ resume: false });
  });

  it.each([
    ["a record about another environment", { bootstrap_environment_id: "env-somewhere-else" }, /different pinned environment or application service/],
    ["a record about another app service", { bootstrap_app_service_id: "service-other" }, /different pinned environment or application service/],
    ["a run that is not the journal's current run", { run_id: "some-other-run" }, /not the journal's current run/],
    ["an inexact baseline commit", { bootstrap_commit: "abc" }, /no exact commit identity/],
    ["an unsupported recorded mode", { bootstrap_mode: "guessed" }, /not a supported staging mode/],
    ["an unresumable phase", { bootstrap_phase: "somewhere-else" }, /not resumable/],
    ["a claimed publication with no object identity", { bootstrap_phase: "captured" }, /no canonical object identity/],
    ["a claimed publication with a malformed digest", { bootstrap_phase: "captured", bootstrap_object_id: "obj", bootstrap_digest: "short" }, /no canonical object identity/],
  ] as const)("refuses %s rather than acting on it", (_label, over, reason) => {
    const verdict = bootstrapResumeVerdict(record(over), env);
    expect(verdict.resume).toBe(false);
    expect(verdict.reason).toMatch(reason);
    // A refusal is not "no record": the caller must be able to tell an ambiguous record from an
    // absent one, because only the first has to leave staging fenced and untouched.
    expect(verdict.ok).toBe(false);
  });

  it("refuses when this worker has no pinned identity to validate the record against", () => {
    // Fail closed on the ABSENCE of an expectation too — comparing against "" would make every
    // record match a worker that forgot its own pins.
    for (const missing of [{ RAILWAY_ENVIRONMENT_ID: "" }, { STAGING_APP_SERVICE_ID: "" }]) {
      const verdict = bootstrapResumeVerdict(record(), { ...env, ...missing } as NodeJS.ProcessEnv);
      expect(verdict.resume).toBe(false);
      expect(verdict.reason).toMatch(/no pinned environment\/app-service identity/);
    }
  });
});

describe("Fable HIGH-1 — a failed destructive attempt is not retried unattended", () => {
  const attempt = (over: Record<string, unknown> = {}) => ({ object_id: "run-4--abc", attempts: 1, status: "failed", ...over });

  it("admits an explicit operator invocation, which is the authorised retry", () => {
    // The ONLY thing that authorises another attempt of a failed source. Deliberately not a
    // variable, a daemon flag or a bounded automatic count.
    expect(sourceAttemptAdmission(attempt(), { automatic: false })).toMatchObject({ ok: true });
    expect(sourceAttemptAdmission(attempt({ attempts: 12 }), { automatic: false })).toMatchObject({ ok: true });
  });

  it("admits a source with no recorded attempt, and one whose attempt completed", () => {
    expect(sourceAttemptAdmission(null, { automatic: true })).toMatchObject({ ok: true });
    expect(sourceAttemptAdmission(attempt({ status: "installed" }), { automatic: true })).toMatchObject({ ok: true });
  });

  it("refuses automatically after a failed attempt, and names the explicit retry", () => {
    const verdict = sourceAttemptAdmission(attempt(), { automatic: true });
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toMatch(/importer install run-4--abc/);
  });

  it("treats an INTERRUPTED attempt exactly like a failed one", () => {
    // A record left at `attempted` means a worker entered the destructive path and never came back
    // to say how it ended. That is the killed-in-flight case, and it is not a reason to stop and
    // drain staging again unattended.
    expect(sourceAttemptAdmission(attempt({ status: "attempted" }), { automatic: true })).toMatchObject({ ok: false });
  });
});
