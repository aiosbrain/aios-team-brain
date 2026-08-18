import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * QMIR-1 (design docs/design/query-mirror-legs-classification.md §5 criterion 4): the reopened
 * org-structural legs are gated by an ALLOWLIST in every dimension — the principal discriminant,
 * the entity type, and the relationship set. Source-shape pins, because each is a single
 * expression whose silent widening the dm tier cannot fully distinguish from fixture drift:
 *
 * - The serve condition must be the POSITIVE test `principal === "member"` — a negated form
 *   (`!== "token"`) fails OPEN for a future constructor that omits or miscasts the field
 *   (design §3.1's default-deny rule, cold-read M1).
 * - The enforcing relationship filter must be exactly ["REPORTS_TO"] (no OWNS/BLOCKS — those
 *   types have no production writer, and a future writer's rows are item-derived).
 * - The actor leg must filter entity_type to 'actor'.
 */
const SRC = readFileSync(join(import.meta.dirname, "..", "..", "lib", "query", "retrieve.ts"), "utf8");

describe("guard: the QMIR-1 org-structural leg allowlists", () => {
  it("the serve condition is the positive member test — never a token negation", () => {
    expect(SRC).toContain('enforce.principal === "member"');
    expect(SRC, "a !== token gate fails open on an absent/foreign principal").not.toContain('principal !== "token"');
  });

  it("the enforcing relationship allowlist is exactly REPORTS_TO", () => {
    expect(SRC).toContain('["REPORTS_TO"]');
  });

  it("the permissive relationship triple survives unchanged (today's behavior)", () => {
    expect(SRC).toContain('["REPORTS_TO", "OWNS", "BLOCKS"]');
  });

  it("the actor leg filters entity_type to actor", () => {
    expect(SRC).toContain('.eq("entity_type", "actor")');
  });

  // PRET-4 §1d — the inversion's own pins (docs/design/pret4-tier-wall-teardown.md): without
  // these, a revert of the tier-disjunct removal goes unnoticed with every positive pin green.
  it("PRET-4: the org-structural legs carry NO posture disjunct (the inversion holds)", () => {
    expect(SRC, "the rels leg opens on serveOrgStructural alone").not.toMatch(
      /isRestrictedTier\(tier\)\s*\|\|\s*!serveOrgStructural/
    );
    // The rels/actors gates are the bare positive form:
    expect(SRC).toContain("const relsB = !serveOrgStructural");
    expect(SRC).toContain("const actorsB = !serveOrgStructural");
  });

  it("PRET-4: the commitments leg keeps its exact surviving predicate (posture wall + enforcing omit)", () => {
    expect(SRC).toMatch(/isRestrictedTier\(tier\)\s*\|\|\s*omitGraph/);
  });

  it("PRET-4: the restricted-posture permissive rels arm narrows to REPORTS_TO (no triple for the opened audience)", () => {
    expect(SRC).toContain('enforce == null && !isRestrictedTier(tier) ? ["REPORTS_TO", "OWNS", "BLOCKS"] : ["REPORTS_TO"]');
  });

  it("PRET-4: both query routes pass graphProjectIds for EVERY member principal (ruling 2's graph unlock — no tier condition)", () => {
    const V1 = readFileSync(join(import.meta.dirname, "..", "..", "app", "api", "v1", "query", "route.ts"), "utf8");
    const DASH = readFileSync(join(import.meta.dirname, "..", "..", "app", "api", "dashboard", "query", "route.ts"), "utf8");
    for (const [name, src] of [["v1", V1], ["dashboard", DASH]] as const) {
      expect(src, `${name}: graphProjectIds is unconditional on the member arm`).toContain(
        'principal: "member", graphProjectIds: projectIds'
      );
      expect(src, `${name}: no tier condition may gate the graph scope`).not.toMatch(
        /=== "team"\s*\?\s*\{\s*graphProjectIds/
      );
    }
    // And retrieve's enforced graph arm keys on scope presence alone:
    expect(SRC).toContain("if (!enforce.graphProjectIds) return [];");
    expect(SRC).not.toContain('tier !== "team" || !enforce.graphProjectIds');
  });
});
