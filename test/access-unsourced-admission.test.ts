import { describe, expect, it } from "vitest";
import {
  unsourcedAdmission,
  provenanceRowSqlFromIds,
  newSqlParams,
  type UnsourcedAdmission,
} from "@/lib/access/provenance-sql";
import { rowVisibleByProvenance } from "@/lib/access/provenance";

/**
 * AUDITFIX-7 AC8 — the THREE OWNERS agree, executably.
 *
 * ⚠️ A spec round killed the first version of this criterion: it said "every combination yields the
 * same admit/deny from all three", which is not a mechanism — the owners return different TYPES (a
 * boolean vs SQL fragments), so "compare their outputs" cannot be written. The parity is pinned in
 * three separable parts instead:
 *   (i)  the policy function's EXACT union result, here;
 *   (ii) exhaustive `switch` + `never` in all three consumers, so a missed branch is a COMPILE error
 *        (that one is enforced by tsc, not by a test);
 *   (iii) both SQL forms executed against the same fixture truth table as the TS owner, in the
 *        data-mechanics tier where real rows exist.
 * This file is (i), plus the TS owner's half of (iii).
 */

const P = ["p1", "p2"] as const;

describe("AC8(i) — the policy function's exact union result", () => {
  const cases: { name: string; ctx: Parameters<typeof unsourcedAdmission>[0]; want: UnsourcedAdmission }[] = [
    { name: "member @ team posture → all", ctx: { principal: "member", teamPosture: true }, want: { kind: "all" } },
    { name: "member @ external posture → closed", ctx: { principal: "member", teamPosture: false }, want: { kind: "closed" } },
    { name: "token with a non-empty set → projects", ctx: { principal: "token", teamPosture: true, tokenProjectIds: P }, want: { kind: "projects", projectIds: P } },
    // The empty and absent cases are DISTINCT inputs with the same correct outcome, and both are
    // decided explicitly rather than left to `= any('{}')` being false.
    { name: "token with an EMPTY set → closed", ctx: { principal: "token", teamPosture: true, tokenProjectIds: [] }, want: { kind: "closed" } },
    { name: "token with NO set → closed", ctx: { principal: "token", teamPosture: true }, want: { kind: "closed" } },
    { name: "token @ external posture with a set → projects (posture is not the token's wall)", ctx: { principal: "token", teamPosture: false, tokenProjectIds: P }, want: { kind: "projects", projectIds: P } },
    // AUDITFIX-1's positive-policy property: everything that is not an explicit principal closes.
    { name: "undefined principal → closed", ctx: { teamPosture: true }, want: { kind: "closed" } },
    { name: "null principal → closed", ctx: { principal: null as never, teamPosture: true }, want: { kind: "closed" } },
    { name: "foreign principal → closed", ctx: { principal: "admin" as never, teamPosture: true }, want: { kind: "closed" } },
  ];
  it.each(cases)("$name", ({ ctx, want }) => {
    expect(unsourcedAdmission(ctx)).toEqual(want);
  });
});

describe("AC8(iii, TS half) + AC12 — rowVisibleByProvenance consumes the union", () => {
  const authored = { source_item_id: null, created_by: "u1", project_id: "p1" };

  it("a member at team posture sees an authored row in ANY project — including an ungranted one", () => {
    expect(rowVisibleByProvenance({ ...authored, project_id: "not-granted" }, new Set(), "team", "member")).toBe(true);
  });

  it("a token sees an authored row IN its project set", () => {
    expect(rowVisibleByProvenance(authored, new Set(), "team", "token", ["p1", "p2"])).toBe(true);
  });

  it("a token does NOT see an authored row OUTSIDE its project set", () => {
    expect(rowVisibleByProvenance({ ...authored, project_id: "p9" }, new Set(), "team", "token", ["p1"])).toBe(false);
  });

  it("a token with an EMPTY project set sees nothing authored", () => {
    expect(rowVisibleByProvenance(authored, new Set(), "team", "token", [])).toBe(false);
  });

  it("an unauthored row (created_by null) closes even inside the project set", () => {
    // The 66 legacy `origin='ui'` rows on prod have exactly this shape. Project scope alone must not
    // rehabilitate them — this slice neither repairs nor worsens their invisibility.
    expect(rowVisibleByProvenance({ ...authored, created_by: null }, new Set(), "team", "token", ["p1"])).toBe(false);
  });

  it("AC12 — a token admission with NO project_id on the row DENIES, and says so", () => {
    // `project_id` is NOT NULL in the schema, so its absence means the CALLER did not select it.
    // Denying is right; denying SILENTLY would turn a one-line wiring defect into a legitimate-
    // looking empty result. The overload makes it a compile error; this is the runtime backstop.
    const errors: unknown[] = [];
    const spy = console.error;
    console.error = (...a: unknown[]) => void errors.push(a);
    try {
      const row = { source_item_id: null, created_by: "u1" } as { source_item_id: null; created_by: string; project_id: string };
      expect(rowVisibleByProvenance(row, new Set(), "team", "token", ["p1"])).toBe(false);
    } finally {
      console.error = spy;
    }
    expect(errors.length, "the denial must be LOUD, not silent").toBe(1);
    expect(String(errors[0])).toMatch(/did not select it/);
  });

  it("the SOURCED arm is untouched by any of this", () => {
    const sourced = { source_item_id: "i1", created_by: null, project_id: "p9" };
    expect(rowVisibleByProvenance(sourced, new Set(["i1"]), "team", "token", ["p1"])).toBe(true);
    expect(rowVisibleByProvenance({ ...sourced, source_item_id: "i2" }, new Set(["i1"]), "team", "token", ["p1"])).toBe(false);
  });
});

describe("AC8(iii, SQL half) — the id-array owner emits the project conjunct only for a token", () => {
  const ids = new Set(["i1"]);
  it("member → the bare authored arm, with NO project filter", () => {
    const p = newSqlParams();
    const sql = provenanceRowSqlFromIds("t", p, { visibleItemIds: ids, teamPosture: true, principal: "member" });
    expect(sql).toContain("created_by is not null");
    expect(sql, "a member's arm must not be project-gated — that would silently narrow members").not.toContain("project_id");
  });
  it("token with a set → the authored arm AND a project filter", () => {
    const p = newSqlParams();
    const sql = provenanceRowSqlFromIds("t", p, { visibleItemIds: ids, teamPosture: true, principal: "token", tokenProjectIds: ["p1"] });
    expect(sql).toContain("t.project_id = any(");
    expect(p.values.at(-1), "the scope binds as ONE parameter").toEqual(["p1"]);
  });
  it("token with no set → NO authored arm at all", () => {
    const p = newSqlParams();
    const sql = provenanceRowSqlFromIds("t", p, { visibleItemIds: ids, teamPosture: true, principal: "token" });
    expect(sql, "the arm is OMITTED, not parameterised false").not.toContain("created_by");
  });
});
