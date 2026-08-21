import { describe, expect, it } from "vitest";
import { admitsUnsourced, newSqlParams, provenanceRowSql, provenanceRowSqlFromIds } from "@/lib/access/provenance-sql";
import { rowVisibleByProvenance } from "@/lib/access/provenance";

/**
 * Spec (AUDITFIX-1 §2): the hand-typed (unsourced) arm is admitted for a MEMBER at team posture and
 * for nobody else — and that is asserted POSITIVELY, because `!== "token"` would admit `undefined`,
 * `null` and any foreign value. Those are real runtime states: `tsconfig.json` excludes `test/`, so an
 * omitted discriminator never fails typecheck.
 *
 * The reproduced defect this pins: an empty-scoped delegated token received every hand-typed task and
 * decision in the team, because the arm never consulted `visibleItemIds` at all.
 */

/** The five inputs §2 names. `null`/foreign are cast because they are runtime states, not typed ones. */
const PRINCIPALS = [
  ["member", true],
  ["token", false],
  [undefined, false],
  [null as unknown as undefined, false],
  ["administrator" as unknown as undefined, false],
] as const;

describe("admitsUnsourced — the one policy, positively expressed", () => {
  for (const [principal, admitted] of PRINCIPALS) {
    it(`principal=${String(principal)} at team posture → ${admitted ? "admits" : "closes"}`, () => {
      expect(admitsUnsourced({ principal, teamPosture: true })).toBe(admitted);
    });
  }

  it("a member at EXTERNAL posture still closes — posture is the other conjunct", () => {
    // The audience wall predates this slice and must survive it: this is not a token rule only.
    expect(admitsUnsourced({ principal: "member", teamPosture: false })).toBe(false);
  });
});

describe("the SQL owners emit the arm only when the policy admits it", () => {
  const idsSql = (principal: unknown) =>
    provenanceRowSqlFromIds("t", newSqlParams(), {
      visibleItemIds: new Set(["11111111-1111-1111-1111-111111111111"]),
      teamPosture: true,
      principal: principal as undefined,
    });
  const semiSql = (principal: unknown) =>
    provenanceRowSql("t", newSqlParams(), {
      teamId: "t1",
      grantedProjectIds: ["p1"],
      teamPosture: true,
      principal: principal as undefined,
    });

  for (const [principal, admitted] of PRINCIPALS) {
    it(`id-array form, principal=${String(principal)} → unsourced disjunct ${admitted ? "present" : "ABSENT"}`, () => {
      const sql = idsSql(principal);
      expect(sql.includes("created_by is not null"), sql).toBe(admitted);
      // The sourced half must survive in EVERY case — closing the arm must not blank the predicate.
      expect(sql).toContain("source_item_id is not null");
    });

    it(`semijoin form, principal=${String(principal)} → unsourced disjunct ${admitted ? "present" : "ABSENT"}`, () => {
      const sql = semiSql(principal);
      expect(sql.includes("created_by is not null"), sql).toBe(admitted);
      expect(sql).toContain("source_item_id is not null");
    });
  }
});

describe("all three owners agree — against expected truth, not against each other", () => {
  const VISIBLE = "22222222-2222-2222-2222-222222222222";
  const INVISIBLE = "33333333-3333-3333-3333-333333333333";
  const ids = new Set([VISIBLE]);

  // The truth table §4 AC7 requires. "agreement" alone is satisfied by three identically WRONG
  // implementations, so each row states the expected ANSWER.
  const ROWS = [
    { name: "sourced + visible", row: { source_item_id: VISIBLE, created_by: null }, member: true, token: true },
    { name: "sourced + invisible", row: { source_item_id: INVISIBLE, created_by: null }, member: false, token: false },
    { name: "unsourced + authored", row: { source_item_id: null, created_by: "u1" }, member: true, token: false },
    { name: "unsourced + unauthored", row: { source_item_id: null, created_by: null }, member: false, token: false },
  ] as const;

  for (const r of ROWS) {
    it(`${r.name}: member=${r.member} token=${r.token}`, () => {
      expect(rowVisibleByProvenance(r.row, ids, "team", "member")).toBe(r.member);
      expect(rowVisibleByProvenance(r.row, ids, "team", "token")).toBe(r.token);
      // The closed cases behave as a token does.
      expect(rowVisibleByProvenance(r.row, ids, "team", undefined)).toBe(r.token);
    });
  }

  it("the TS twin and the id-array SQL agree on whether the unsourced arm exists at all", () => {
    for (const [principal, admitted] of PRINCIPALS) {
      const tsAdmits = rowVisibleByProvenance({ source_item_id: null, created_by: "u1" }, ids, "team", principal as undefined);
      const sqlAdmits = provenanceRowSqlFromIds("t", newSqlParams(), {
        visibleItemIds: ids,
        teamPosture: true,
        principal: principal as undefined,
      }).includes("created_by is not null");
      expect(tsAdmits, `TS twin, principal=${String(principal)}`).toBe(admitted);
      expect(sqlAdmits, `SQL form, principal=${String(principal)}`).toBe(admitted);
    }
  });
});
