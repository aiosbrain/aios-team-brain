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

  it("STAGINGMARK-1: the admin CLI reaches the materialization ONLY through the tested handler", () => {
    const admin = read("scripts/admin.ts");
    // (a) the dispatch exists, pinned by CALL SHAPE rather than a bare name — a comment naming
    //     the handler must not satisfy this.
    expect(admin).toMatch(/runMaterializeCommand\s*\(/);
    expect(admin).toMatch(/makeMaterializeDeps\s*\(/);
    // (b) the command is discoverable.
    expect(admin).toMatch(/materialize-builtins/);
    // (c) THE LOAD-BEARING HALF. Without it the CLI could call the handler *and* invoke the
    //     materializer directly, leaving every behavioural test in
    //     test/access-materialize-command.test.ts green while the real command still wrote —
    //     the second-writer shape this file exists to prevent.
    expect(
      admin,
      "scripts/admin.ts must not call materializeBuiltinMembershipOnce directly — go through runMaterializeCommand"
    ).not.toMatch(/materializeBuiltinMembershipOnce/);
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

  it("AUDITFIX-21: the repair verb routes to the NEW writer, and the CLI arm actually calls it", () => {
    // The single-writer guard cannot do this job: it is FILE-scoped, so a second deleting function
    // inside lib/access/groups.ts is invisible to it — it holds unchanged and proves nothing about
    // WHICH writer the repair verb uses. And AC14/AC15 together still allow the shipped command to be
    // absent: one pins the pure verb against an injected writer, the other pins a factory's queries,
    // and neither proves scripts/admin.ts has the arm at all (spec round 2 HIGH 4).
    const verb = read("lib/access/repair-verb.ts");
    expect(verb, "the repair path uses the narrow writer").toMatch(/revokeUnsanctionedSystemEdge/);
    expect(verb, "and never the general one, which would delete an initiative's edge under a repair name")
      .not.toMatch(/revokeProjectFromGroup/);

    const cli = read("scripts/admin.ts");
    expect(cli, "the command exists").toMatch(/case "repair-system-edge"/);
    // The CALL SHAPE, not just the names: checking that `repairVerbDeps` appears SOMEWHERE lets an
    // implementation import it and then pass hand-rolled or broken deps to the verb, which passes
    // AC14, AC15 and a name-only guard together (diff review).
    expect(cli, "the verb is called WITH the factory's result, not with hand-rolled deps")
      .toMatch(/runRepairSystemEdgeVerb\(\s*\n?\s*repairVerbDeps\(/);
  });

  it("AUDITFIX-21: both revoke layers share ONE protection predicate", () => {
    // While the writer used isProtectedProject and the verb's preflight used kind === 'system', a
    // reserved-slug SOURCE project passed both and its SANCTIONED edge was deletable. The two must
    // move together or that hole reopens.
    //
    // Strip comments first: the prose in these files EXPLAINS the old test by quoting it, and a guard
    // that reads prose is not checking anything. (Caught by this guard firing on its own commit.)
    const code = (f: string) =>
      read(f).replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

    // ⚠️ The obvious form of this guard is VACUOUS, and both diff reviews said so from opposite
    // sides: `isProtectedProject(` already appears in groups.ts for the GRANT side, so matching it
    // anywhere proves nothing about the revoke side — deleting the revoke gate entirely would still
    // pass. And a blunt negative match on `kind === "system"` fires on the CONDITIONAL MESSAGE the
    // preflight legitimately uses to name the right kind. So pin the GATE's shape, scoped to the
    // function that must have it.
    const revokeWriter = code("lib/access/groups.ts").split("export async function revokeProjectFromGroup")[1] ?? "";
    expect(revokeWriter, "the revoke writer must exist").not.toBe("");
    expect(revokeWriter.slice(0, 2000), "and gate on isProtectedProject, not on kind alone")
      .toMatch(/isProtectedProject\s*\(/);
    expect(code("lib/access/revoke-verb.ts"), "the preflight gates on the same predicate")
      .toMatch(/if\s*\(\s*isProtectedProject\s*\(\s*project\s*\)\s*\)/);
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
