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
    // COUNT, not "contains": there are two project resolutions in this query, and a `contains` check
    // stays green when only one of them loses the filter — which is the realistic mistake.
    const hits = (sql.match(/kind = 'system'/g) ?? []).length;
    expect(hits, "both the general and external-shared resolutions must filter kind='system'").toBe(2);
  });

  it("has all THREE needs-work arms", () => {
    const arms = sql.split(/\bor\b/);
    expect(arms.length, "three arms means two `or`s at minimum").toBeGreaterThanOrEqual(3);
    // Arm 1: no ITEM-GRAIN unit at all, matching reconcileItemUnit's own lookup. It does not filter
    // `state` because a retracted unit is handled by its own EXCLUSION below — reconcile cannot
    // revive one, so treating it as missing would make it a perpetual candidate.
    expect(sql).toMatch(/not exists \(\s*select 1 from project_context_units u\s*where u\.team_id = \$1 and u\.source_item_id = s\.id and u\.unit_kind = 'item'\s*\)/);
    // Every unit reference must be item-grain, matching reconcileItemUnit's own lookup — otherwise a
    // non-item unit on the same source_item_id would satisfy "has a unit" and the item is skipped.
    // EXACT, not >=: at >= N, dropping exactly one reference (e.g. arm 2's, which the arm-1 regex does
    // not cover) still passes — the same one-of-N weakness the kind='system' count already fixed once.
    expect((sql.match(/u\.unit_kind = 'item'/g) ?? []).length, "every unit reference must be item-grain").toBe(5);
    // Arm 2: no current INCLUDE in the TARGET project.
    // `valid_to is null` is part of the term, not decoration: without it a CLOSED include counts as
    // done, the item is invisible under enforce (which requires it) and never selected — the silent
    // skip this slice exists to prevent. Nothing killed this before; a mutation proved it.
    expect(sql).toMatch(/m\.valid_to is null and m\.decision = 'include' and m\.project_id = s\.target_id/);
    // Arm 3: still a current membership in the OPPOSITE project, of ANY decision — closeMembershipInto
    // closes regardless, so narrowing this to include would strand a stale exclude.
    expect(sql).toMatch(/m\.valid_to is null and m\.project_id = s\.opposite_id/);
  });

  it("EXCLUDES both UNREPAIRABLE states, so the sweep cannot burn a tick on either", () => {
    // reconcile can fix neither: ensureIncludeMembership no-ops on any current row, and
    // reconcileItemUnit never writes `state`. Selecting either would hold `scanned` off zero forever.
    // Same currency term, same reason: a CLOSED exclude must not shadow an item forever. EXCLSHADOW-1's
    // repair is precisely what will start minting closed excludes in the target project.
    // EXCLSHADOW-1 narrowed this carve-out to EXPLICIT excludes: an auto exclude is now
    // repairable (the writer's shadow branch), so only force/manual shadows stay unselectable.
    // The mode term is load-bearing — dropping it would re-hide repairable shadows forever.
    // CLOSEMODE-1: the carve-out text lives in the shared PROTECTED_EXCLUDE_SQL constant (also used
    // by ARM 3's exception and the unrepairable counter — one definition, three sites).
    expect(sql).toMatch(/and not exists \([\s\S]*m\.valid_to is null and \$\{PROTECTED_EXCLUDE_SQL\} and m\.project_id = s\.target_id/);
    expect(src).toContain(`export const PROTECTED_EXCLUDE_SQL = "m.decision = 'exclude' and m.mode <> 'auto'";`);
    expect(sql, "ARM 3 must not fire on a row the close SPARES (CLOSEMODE-1)").toMatch(/m\.project_id = s\.opposite_id[\s\S]{0,80}and not \(\$\{PROTECTED_EXCLUDE_SQL\}\)/);
    expect(sql, "a retracted unit is unrepairable too").toMatch(/u\.state <> 'active'/);
  });

  it("maps target and opposite to the RIGHT projects — a swap must not pass", () => {
    // The gap a reviewer found: asserting both derivations mention i.access still passes when
    // general_id and external_id are swapped, which would invert every partition decision.
    expect(sql).toMatch(/case when i\.access = 'external' then sys\.external_id else sys\.general_id end as target_id/);
    expect(sql).toMatch(/case when i\.access = 'external' then sys\.general_id else sys\.external_id end as opposite_id/);
  });

  it("parameterises team, cutoff and paging — no interpolation", () => {
    for (const p of ["$1", "$2", "$3", "$4", "$5", "$6"]) expect(sql).toContain(p);
    expect(sql).toMatch(/i\.created_at < \$5/); // the cutoff still bounds the pass
    expect(sql).toMatch(/i\.id > \$4/); // keyset paging preserved
    expect(sql).toMatch(/order by s\.id/);
    expect(sql).toMatch(/limit \$6/);
    // Any `${` inside the SQL would mean a value was interpolated rather than bound — with ONE
    // allowed static fragment (CLOSEMODE-1): PROTECTED_EXCLUDE_SQL, the shared spare-rule text,
    // whose exact definition is pinned above. Everything else stays banned.
    expect(sql.replaceAll("${PROTECTED_EXCLUDE_SQL}", ""), "SQL must be fully parameterised (no interpolation beyond the shared static fragment)").not.toContain("${");
  });
});
