import { describe, expect, it, vi } from "vitest";
import { healthResponse } from "@/lib/staging/health";

describe("deployment health", () => {
  it("public readiness requires a bounded Postgres success and exposes no data", async () => {
    const response = await healthResponse(new Request("http://brain/api/health"), {
      probePostgres: vi.fn().mockResolvedValue(true),
      readRuntimeState: vi.fn().mockResolvedValue({ mode: "production", ready: true, runId: null }),
      probeNeo4j: vi.fn(),
      env: { RAILWAY_GIT_COMMIT_SHA: "abc123" },
    });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true, commit: "abc123" });
  });

  it("fails readiness when Postgres fails or times out", async () => {
    const response = await healthResponse(new Request("http://brain/api/health"), {
      probePostgres: vi.fn().mockResolvedValue(false),
      readRuntimeState: vi.fn(),
      probeNeo4j: vi.fn(),
      env: {},
    });
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({ ok: false });
  });

  it("requires the stable staging token for internal refresh evidence", async () => {
    const response = await healthResponse(new Request("http://brain/api/health", {
      headers: { "x-aios-staging-health-token": "wrong" },
    }), {
      probePostgres: vi.fn().mockResolvedValue(true),
      readRuntimeState: vi.fn(),
      probeNeo4j: vi.fn(),
      env: { STAGING_HEALTH_TOKEN: "x".repeat(32) },
    });
    expect(response.status).toBe(401);
  });

  it("copy-ready reports the exact ready run and proves Neo4j is readable", async () => {
    const token = "t".repeat(32);
    const response = await healthResponse(new Request("http://brain/api/health", {
      headers: { "x-aios-staging-health-token": token },
    }), {
      probePostgres: vi.fn().mockResolvedValue(true),
      readRuntimeState: vi.fn().mockResolvedValue({ mode: "copy-ready", ready: true, runId: "run-42" }),
      probeNeo4j: vi.fn().mockResolvedValue(true),
      env: { STAGING_HEALTH_TOKEN: token, RAILWAY_GIT_COMMIT_SHA: "candidate-sha" },
    });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      ok: true,
      commit: "candidate-sha",
      mode: "copy-ready",
      refreshRunId: "run-42",
      postgres: "ready",
      graph: "readable",
      // "the graph is readable" is not "queries work here", and the two sat one line apart with
      // only the first of them reported.
      answering: "disabled",
    });
  });

  it("distinguishes an unimplemented budgeted opt-in from a plain disabled default", async () => {
    // An operator who set the flag and a positive amount must not read `disabled` and conclude
    // their configuration took effect: nothing in this build enforces the amount.
    const token = "t".repeat(32);
    const response = await healthResponse(new Request("http://brain/api/health", {
      headers: { "x-aios-staging-health-token": token },
    }), {
      probePostgres: vi.fn().mockResolvedValue(true),
      readRuntimeState: vi.fn().mockResolvedValue({ mode: "copy-ready", ready: true, runId: "run-42" }),
      probeNeo4j: vi.fn().mockResolvedValue(true),
      env: {
        STAGING_HEALTH_TOKEN: token, RAILWAY_GIT_COMMIT_SHA: "candidate-sha",
        STAGING_DATA_MODE: "copy-ready", STAGING_QUERY_LLM_ENABLED: "true", STAGING_QUERY_LLM_BUDGET_USD: "25",
      },
    });
    expect(await response.json()).toMatchObject({ answering: "unsupported-budgeted-mode" });
  });

  it("never calls Neo4j or claims ready while the copy journal is not ready", async () => {
    const token = "t".repeat(32);
    const graph = vi.fn();
    const response = await healthResponse(new Request("http://brain/api/health", {
      headers: { "x-aios-staging-health-token": token },
    }), {
      probePostgres: vi.fn().mockResolvedValue(true),
      readRuntimeState: vi.fn().mockResolvedValue({ mode: "copy-ready", ready: false, runId: "run-42" }),
      probeNeo4j: graph,
      env: { STAGING_HEALTH_TOKEN: token },
    });
    expect(response.status).toBe(503);
    expect(graph).not.toHaveBeenCalled();
  });

  it("supports an authenticated boot probe without making candidate readiness true", async () => {
    const token = "t".repeat(32);
    const response = await healthResponse(new Request("http://brain/api/health", { headers: { "x-aios-staging-health-token": token, "x-aios-staging-boot-probe": "true" } }), {
      probePostgres: vi.fn().mockResolvedValue(true), probeNeo4j: vi.fn().mockResolvedValue(true),
      readRuntimeState: vi.fn().mockResolvedValue({ mode: "copy-ready", ready: false, runId: "run-boot" }),
      env: { STAGING_HEALTH_TOKEN: token, RAILWAY_GIT_COMMIT_SHA: "a".repeat(40) },
    });
    expect(response.status).toBe(202);
    expect(await response.json()).toMatchObject({ ok: false, booted: true, refreshRunId: "run-boot", graph: "readable" });
  });

  it("answers production with the ORDINARY contract, and only that", async () => {
    // The production contract is the unauthenticated 200 `{ ok, commit }` after a bounded Postgres
    // probe. It is a different contract from the privileged staging one, and it must stay usable
    // WITHOUT a staging token — which production does not have, because that token is a staging
    // environment secret.
    const response = await healthResponse(new Request("http://brain/api/health"), {
      probePostgres: vi.fn().mockResolvedValue(true),
      readRuntimeState: vi.fn(),
      probeNeo4j: vi.fn(),
      env: { RAILWAY_GIT_COMMIT_SHA: "prod-sha" },
    });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual({ ok: true, commit: "prod-sha" });
    // No mode, no run identity, no graph state on the public contract.
    expect(Object.keys(body).sort()).toEqual(["commit", "ok"]);
  });

  it("rejects a token-shaped header that production could never satisfy", async () => {
    // A production probe that sent a staging-shaped header would be READ as presenting a token and
    // answered 401 — turning a healthy release into promoted-but-deployment-failed.
    const response = await healthResponse(new Request("http://brain/api/health", {
      headers: { "x-aios-staging-health-token": "undefined" },
    }), {
      probePostgres: vi.fn().mockResolvedValue(true),
      readRuntimeState: vi.fn(),
      probeNeo4j: vi.fn(),
      env: { RAILWAY_GIT_COMMIT_SHA: "prod-sha" },
    });
    expect(response.status).toBe(401);
  });
});

describe("M1 — an undeclared staging mode fails CLOSED", () => {
  const token = "t".repeat(32);

  it("refuses readiness on a pinned staging deployment with no declared mode", async () => {
    // The rollout prerequisite this states: `STAGING_DATA_MODE` must be DECLARED (and read back)
    // before the fence-capable baseline lands on staging. Undeclared is not "carry on as before" —
    // it is a refusal, deliberately, because a missing mode check must never enable writes.
    const response = await healthResponse(new Request("http://brain/api/health", {
      headers: { "x-aios-staging-health-token": token },
    }), {
      probePostgres: vi.fn().mockResolvedValue(true),
      readRuntimeState: vi.fn().mockResolvedValue({ mode: "copy-safe-refusal", ready: false, runId: null }),
      probeNeo4j: vi.fn(),
      env: { STAGING_HEALTH_TOKEN: token },
    });
    expect(response.status).toBe(503);
  });

  it("serves the declared legacy baseline", async () => {
    const response = await healthResponse(new Request("http://brain/api/health", {
      headers: { "x-aios-staging-health-token": token },
    }), {
      probePostgres: vi.fn().mockResolvedValue(true),
      readRuntimeState: vi.fn().mockResolvedValue({ mode: "legacy-pg-only", ready: true, runId: null }),
      probeNeo4j: vi.fn(),
      env: { STAGING_HEALTH_TOKEN: token, RAILWAY_GIT_COMMIT_SHA: "baseline-sha" },
    });
    expect(response.status).toBe(200);
    // Legacy declares no graph readability — that is the mode's whole point.
    expect(await response.json()).toMatchObject({ ok: true, mode: "legacy-pg-only", graph: "disabled" });
  });
});
