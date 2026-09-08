import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import YAML from "yaml";
import { assertBootstrapServingHealth } from "../scripts/staging-ops/staging-pair-fixture.mjs";

const runId = "bootstrap-2026-09-08T16-15-45-002Z";
const healthy = (mode: "legacy-pg-only" | "copy-ready" = "legacy-pg-only") => ({
  responseOk: true,
  responseStatus: 200,
  health: { ok: true, mode, refreshRunId: runId, postgres: "ready", graph: mode === "copy-ready" ? "readable" : "disabled" },
  expectedMode: mode,
  expectedRunId: runId,
});

describe("paired harness bootstrap serving oracle", () => {
  it("binds both runtime sides and both assertions to one explicit baseline mode and exact journal runs", () => {
    const compose = YAML.parse(readFileSync("compose.test.staging-pair.yml", "utf8"), { merge: true });
    const harness = readFileSync("scripts/staging-pair-isolated.sh", "utf8");
    const configuredMode = "${STAGING_PAIR_BASELINE_MODE:-legacy-pg-only}";

    expect(compose.services.importer.environment.STAGING_BOOTSTRAP_MODE).toBe(configuredMode);
    expect(compose.services.maintenance.environment.LOCAL_INITIAL_DATA_MODE).toBe(configuredMode);
    expect(compose.services["fixture-controller"].environment.STAGING_HEALTH_TOKEN)
      .toBe(compose.services.maintenance.environment.STAGING_HEALTH_TOKEN);
    expect(harness).toContain('fixture-controller assert-bootstrap "$baseline_mode" "$interrupted_run"');
    expect(harness).toContain('fixture-controller assert-bootstrap "$baseline_mode" "$bootstrap_run"');
    expect(harness).toContain('require_journal last_ready_mode "$baseline_mode"');
  });

  it.each(["legacy-pg-only", "copy-ready"] as const)("accepts the exact healthy %s baseline binding", (mode) => {
    expect(assertBootstrapServingHealth(healthy(mode))).toEqual({ mode, refreshRunId: runId });
  });

  it("refuses a healthy response in the wrong mode", () => {
    expect(() => assertBootstrapServingHealth({
      ...healthy(), health: { ...healthy().health, mode: "copy-ready" },
    })).toThrow(/expected recorded baseline mode legacy-pg-only/);
  });

  it("refuses a healthy response from a different bootstrap run", () => {
    expect(() => assertBootstrapServingHealth({
      ...healthy(), health: { ...healthy().health, refreshRunId: "bootstrap-different" },
    })).toThrow(/expected recorded bootstrap run/);
  });

  it("refuses a booted-but-not-ready response", () => {
    expect(() => assertBootstrapServingHealth({
      ...healthy(), responseStatus: 202, health: { ...healthy().health, ok: false, booted: true },
    })).toThrow(/actual healthy serving response/);
  });
});
