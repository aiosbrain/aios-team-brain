import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Pin the access-chain CALL SITES, not just the functions (the repo's recurring failure
 * mode: a helper with green tests whose wiring can be deleted with everything staying green).
 *
 * PRET-4 re-pinned this file to the EXPLICIT-STATE model (docs/design/pret4-tier-wall-teardown.md
 * §1c): builtin membership is written at member creation from the invite default and
 * one-time-materialized at boot/tick — the tier-derived recompute is RETIRED, so this guard now
 * pins both the new call sites AND the ABSENCE of the old ones (a re-introduced recompute would
 * silently revert deliberate membership edits on every tick — the clobber class).
 */

const ROOT = join(import.meta.dirname, "..", "..");
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");

describe("PRET-4 explicit builtin-state call sites", () => {
  it("member creation writes the invite-default membership (the one choke point)", () => {
    const source = read("lib/admin/members.ts");
    expect(source).toMatch(/writeInviteDefaultMembership\s*\(/);
  });

  it("the retired recompute has NO call site anywhere — pg-login, members.ts, groups.ts tail-call", () => {
    for (const rel of ["lib/auth/pg-login.ts", "lib/admin/members.ts", "lib/access/groups.ts", "lib/ingest/scheduler.ts"]) {
      expect(read(rel), `${rel} must not reference the retired recompute`).not.toMatch(/syncBuiltinMembership/);
    }
  });

  it("the one-time materialization runs at BOOT (before the scheduler) and in the tick retry slot", () => {
    expect(read("instrumentation.ts")).toMatch(/materializeBuiltinMembershipOnce/);
    const scheduler = read("lib/ingest/scheduler.ts");
    expect(scheduler).toMatch(/materializeBuiltinMembershipOnce/);
    // Ordering (PRET-6 re-anchored — the auto-flip slot retired with its subsystem): the
    // materialize slot still sits EARLY in the tick, before the downstream consumers that
    // assess posture-derived state (meeting-notes backfill is the first of them).
    const matIdx = scheduler.indexOf("materializeBuiltinMembershipOnce");
    const downstreamIdx = scheduler.indexOf("runMeetingNotesBackfill(db)");
    expect(matIdx).toBeGreaterThan(-1);
    expect(downstreamIdx).toBeGreaterThan(matIdx);
  });

  it("team creation bootstraps the access topology", () => {
    expect(read("lib/admin/teams.ts")).toMatch(/ensureAccessBootstrap\s*\(/);
  });

  it("dashboard-created projects mint kind='initiative' — what makes source-only adoption safe", () => {
    // Spec ruling: new dashboard-created projects default to 'initiative'. If this ever
    // reverts to the column default ('source'), a human-created "General" becomes adoptable
    // and inherits Everyone-visibility (the slice-3 Codex High).
    expect(read("app/actions/projects.ts")).toMatch(/kind:\s*"initiative"/);
  });

  it("the scheduler tick runs the convergence leg — through the extracted ledger module", () => {
    // AUDITFIX-22 moved the leg's body out of the scheduler closure into
    // lib/ingest/access-bootstrap-leg so the ledger contract is testable against real Postgres
    // (the closure was unreachable from any test). The INVARIANT is unchanged and still pinned
    // end to end: the tick calls the leg, and the leg calls the convergence wrapper. Asserting
    // only the scheduler would let the extraction become a no-op that converges nothing.
    const scheduler = read("lib/ingest/scheduler.ts");
    expect(scheduler).toMatch(/await runAccessBootstrap\(db\);/);
    expect(scheduler).toMatch(/runAccessBootstrapLeg/);
    const leg = read("lib/ingest/access-bootstrap-leg.ts");
    expect(leg).toMatch(/ensureAccessBootstrapAllTeams/);
  });

  it("AUDITFIX-23: both census surfaces call the ONE exported census, and neither reimplements it", () => {
    // The spec says "the same census function" — which was PROSE, and a duplicated predicate inside
    // assessAccessHealth reddened no criterion (spec round 3 MEDIUM 1). A second implementation is the
    // divergence AUDITFIX-15A exists to prevent, and single-sourcing is also what lets ONE mutation
    // cover both surfaces.
    const health = read("lib/admin/access-health.ts");
    expect(health, "the operator path calls the census").toMatch(/censusTeamSystemEdges\s*\(/);
    const wrapper = read("lib/access/bootstrap.ts");
    expect(wrapper, "the scheduled path calls the same one").toMatch(/censusTeamSystemEdges\s*\(/);
    // Neither may carry its own copy of the sanctioned-pair decision.
    for (const [label, src] of [["access-health", health], ["bootstrap", wrapper]] as const) {
      expect(src, `${label} must not reimplement the predicate`).not.toMatch(/isSanctionedSystemEdge\s*\(/);
    }
  });

  it("the ledger leg writes a per-team row and reserves the instance-wide row for fleet failure", () => {
    // AUDITFIX-22's whole point: a global ok:true heartbeat every tick is what masked a wedged
    // team's failure under `newest`. If the unconditional instance-wide write ever comes back,
    // the leg silently returns to hiding per-team failures.
    const leg = read("lib/ingest/access-bootstrap-leg.ts");
    expect(leg, "the per-team row is written from the wrapper's callback").toMatch(/onOutcome/);
    expect(leg, "and the instance-wide row is conditional").toMatch(/if \(globalFailure \|\| r\.teams === 0\)/);
  });
});
