import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";

describe("gateway approved writers", () => {
  it("node scripts/check-gateway-writers.mjs accepts only the domain owner", () => {
    const result = spawnSync(process.execPath, ["scripts/check-gateway-writers.mjs"], {
      cwd: process.cwd(), encoding: "utf8",
    });
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("gateway writer guard: OK");
  });

  it("fails non-vacuously for quoted and schema-qualified SQL mutations", () => {
    const result = spawnSync(process.execPath, ["scripts/check-gateway-writers.mjs"], {
      cwd: process.cwd(), encoding: "utf8",
      env: { ...process.env, GATEWAY_WRITER_SCAN_DIRS: "test/fixtures" },
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("gateway-writer-bypass.ts: writes gateway_connections");
    expect(result.stderr).toContain("gateway-writer-bypass.ts: writes gateway_resolution_leases");
    expect(result.stderr).toContain("gateway-writer-bypass.ts: writes gateway_audit_log");
  });
});
