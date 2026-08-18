import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * TICKSTALL-2 criterion 8 — pin the SHAPE of the candidate predicate.
 *
 * Why a shape guard and not only behaviour: this predicate's failure mode is an item that is never
 * selected, so it never gets a unit or a current `include`, so it is visible to NOBODY under an
 * enforced read. That is silent. A narrowed term (dropping an arm, keying the audience off the stale
 * `units.audience` mirror, forgetting `kind='system'`) still leaves every behavioural test green for
 * the states those tests happen to construct, while quietly stranding the ones they don't.
 *
 * Both spec cold reads landed on terms in this list, which is why each is asserted individually
 * rather than as one blob.
 */
const ROOT = join(import.meta.dirname, "..", "..");
const src = readFileSync(join(ROOT, "lib/projects/context/backfill-candidates.ts"), "utf8");

/** SQL only, comments stripped — a term satisfied by a comment ABOUT the term proves nothing. */
const sql = (() => {
  const a = src.indexOf("const CANDIDATE_SQL = `");
  const b = src.indexOf("`;", a);
  expect(a, "CANDIDATE_SQL must exist").toBeGreaterThan(-1);
  return src
    .slice(a, b)
    .split("\n")
    .filter((l) => !l.trim().startsWith("--"))
    .join("\n");
})();

describe("guard: the candidate predicate's SQL shape", () => {
  it("is non-vacuous — the extracted SQL is really the query, not an empty slice", () => {
    // Without this, a renamed constant makes every assertion below pass against an empty string.
    expect(sql.length).toBeGreaterThan(400);
    expect(sql).toContain("from items i");
    expect(sql).toContain("project_context_units");
    expect(sql).toContain("project_context_memberships");
  });

  it("keys the audience off items.access, NEVER the stale units.audience mirror", () => {
    // The permanent-tier-leak term. `units.audience` lags until reconcile re-mirrors it, so a tier
    // flip whose best-effort fan-out failed reads "already correct" through the mirror and is never
    // selected — team content served through external-shared forever.
    // BOTH derivations, not merely "i.access appears somewhere": a mutation that corrupts only the
    // target expression leaves the opposite one referencing i.access and passes a looser check. That
    // exact mutation SURVIVED an earlier version of this guard, which is how it got tightened.
    const target = sql.match(/case when ([^\n]*?) then [^\n]*? end as target_id/);
    const opposite = sql.match(/case when ([^\n]*?) then [^\n]*? end as opposite_id/);
    expect(target?.[1], "target_id must be derived from items.access").toContain("i.access");
    expect(opposite?.[1], "opposite_id must be derived from items.access").toContain("i.access");
    // …and nothing anywhere may key off the units.audience MIRROR, whatever alias it is given.
    expect(sql, "the stale mirror must not drive selection").not.toMatch(/\baudience\b/);
  });

  it("resolves BOTH system projects with kind='system'", () => {
    // A dashboard-created initiative can squat the slug 'general'. Without this the sweep partitions
    // into the squatter while the ingest hook (which has always filtered) refuses — the two paths
    // diverging in exactly the case the shared core exists to prevent.
    expect(sql).toMatch(/kind = 'system'/);
  });

  it("has all THREE needs-work arms", () => {
    const arms = sql.split(/\bor\b/);
    expect(arms.length, "three arms means two `or`s at minimum").toBeGreaterThanOrEqual(3);
    // Arm 1: no unit at all — and it must NOT filter on `state`, matching reconcileItemUnit's own
    // lookup, so a retracted unit counts as missing rather than as done.
    expect(sql).toMatch(/not exists \(\s*select 1 from project_context_units u\s*where u\.team_id = \$1 and u\.source_item_id = s\.id\s*\)/);
    expect(sql, "arm 1 must not narrow on unit state").not.toMatch(/u\.state/);
    // Arm 2: no current INCLUDE in the TARGET project.
    expect(sql).toMatch(/m\.decision = 'include' and m\.project_id = s\.target_id/);
    // Arm 3: still a current membership in the OPPOSITE project, of ANY decision — closeMembershipInto
    // closes regardless, so narrowing this to include would strand a stale exclude.
    expect(sql).toMatch(/m\.valid_to is null and m\.project_id = s\.opposite_id/);
  });

  it("EXCLUDES the exclude-shadow, so the sweep cannot burn a tick on a state it cannot repair", () => {
    expect(sql).toMatch(/and not exists \([\s\S]*m\.decision = 'exclude' and m\.project_id = s\.target_id/);
  });

  it("parameterises team, cutoff and paging — no interpolation", () => {
    for (const p of ["$1", "$2", "$3", "$4", "$5", "$6"]) expect(sql).toContain(p);
    expect(sql).toMatch(/i\.created_at < \$5/); // the cutoff still bounds the pass
    expect(sql).toMatch(/i\.id > \$4/); // keyset paging preserved
    expect(sql).toMatch(/order by s\.id/);
    expect(sql).toMatch(/limit \$6/);
    // Any `${` inside the SQL would mean a value was interpolated rather than bound.
    expect(sql, "SQL must be fully parameterised").not.toContain("${");
  });
});
