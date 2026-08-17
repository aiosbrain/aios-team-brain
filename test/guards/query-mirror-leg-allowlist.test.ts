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
});
