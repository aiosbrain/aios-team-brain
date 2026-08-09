import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Pin the §11 bootstrap/sync CALL SITES, not just the functions (the repo's recurring failure
 * mode: a helper with green tests whose wiring can be deleted with everything staying green).
 * The fire-and-forget hooks (pg-login) can't be data-mechanics-tested deterministically — the
 * void promise races the assertion — so this source-level pin is their only non-vacuous guard;
 * the awaited hooks (members.ts) get outcome tests in the data-mechanics tier as well.
 */

const ROOT = join(import.meta.dirname, "..", "..");
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");

describe("§11 access-bootstrap call sites", () => {
  it("both pg-login activation flips fire the builtin re-sync", () => {
    const source = read("lib/auth/pg-login.ts");
    const calls = source.match(/syncBuiltinMembershipSafe\(teamId\)/g) ?? [];
    expect(calls.length, "both activation paths must re-sync built-ins").toBeGreaterThanOrEqual(2);
    // the helper really resolves to the groups writer, not a stub
    expect(source).toMatch(/syncBuiltinMembership\s*\(/);
  });

  it("member create AND disable/delete re-sync built-ins", () => {
    const source = read("lib/admin/members.ts");
    const calls = source.match(/syncBuiltinMembership\s*\(/g) ?? [];
    expect(calls.length).toBeGreaterThanOrEqual(2);
  });

  it("team creation bootstraps the access topology", () => {
    expect(read("lib/admin/teams.ts")).toMatch(/ensureAccessBootstrap\s*\(/);
  });

  it("the scheduler tick runs the convergence leg", () => {
    const source = read("lib/ingest/scheduler.ts");
    expect(source).toMatch(/await runAccessBootstrap\(db\);/);
    expect(source).toMatch(/ensureAccessBootstrapAllTeams/);
  });
});
