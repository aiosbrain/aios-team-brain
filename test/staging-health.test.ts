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
    });
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
});
