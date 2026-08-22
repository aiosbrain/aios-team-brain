import { describe, expect, it } from "vitest";
import { unsourcedAdmission, newSqlParams, provenanceRowSql, provenanceRowSqlFromIds } from "@/lib/access/provenance-sql";
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

/**
 * ⚠️ AUDITFIX-7 made the policy THREE-VALUED. It returns `{kind:"closed"|"all"|"projects"}` instead
 * of a boolean, because a token is no longer always-closed — it is closed UNLESS the row's project is
 * in the token's effective set. These assertions are converted, not deleted: every principal that
 * closed here still closes, and the token rows now say WHY (no project set supplied → closed), which
 * is the same fail-closed default expressed in the richer type.
 */
describe("unsourcedAdmission — the one policy, positively expressed", () => {
  for (const [principal, admitted] of PRINCIPALS) {
    it(`principal=${String(principal)} at team posture → ${admitted ? "admits" : "closes"}`, () => {
      expect(unsourcedAdmission({ principal, teamPosture: true }).kind).toBe(admitted ? "all" : "closed");
    });
  }

  it("a member at EXTERNAL posture still closes — posture is the other conjunct", () => {
    // The audience wall predates this slice and must survive it: this is not a token rule only.
    expect(unsourcedAdmission({ principal: "member", teamPosture: false })).toEqual({ kind: "closed" });
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

  // Only the TS twin can be asked about a ROW at unit level — the SQL owners return text, and the
  // row is applied by Postgres. So the row x principal cross belongs to the twin, and the SQL owners
  // are asserted on the two things they CAN be asserted on here (below): the arm's presence per
  // principal, and the arm's structure.
  //
  // A previous version of this loop built both SQL strings INSIDE the row loop and asserted them
  // there. Codex's diff review caught it: neither string referenced `r`, so 15 of those 20
  // assertions were the same 5 assertions repeated — and the trailing
  // `if (unsourced && created_by === null) expect(expected).toBe(false)` re-asserted a constant
  // written twenty lines above in ROWS. A tautology reads exactly like coverage.
  for (const r of ROWS) {
    for (const [principal, admitted] of PRINCIPALS) {
      const expected = admitted ? r.member : r.token;
      it(`TS twin — ${r.name}, principal=${String(principal)} → ${expected}`, () => {
        expect(rowVisibleByProvenance(r.row, ids, "team", principal as undefined)).toBe(expected);
      });
    }
  }

  it("the SQL owners' hand-typed arm carries the SAME two conditions the twin applies", () => {
    // The structural half of "one contract, three owners": the twin admits an unsourced row only
    // when `created_by` is non-null, so the SQL the owners emit must test exactly that, on exactly
    // the null-source branch. Asserted ONCE — it does not vary by row, and pretending otherwise is
    // what made the previous version look like 20 cases of coverage.
    for (const [label, sql] of [
      ["id-array", provenanceRowSqlFromIds("t", newSqlParams(), { visibleItemIds: ids, teamPosture: true, principal: "member" })],
      ["semijoin", provenanceRowSql("t", newSqlParams(), { teamId: "t1", grantedProjectIds: ["p1"], teamPosture: true, principal: "member" })],
    ] as const) {
      expect(sql, `${label}: the arm must require BOTH null source and an author`).toMatch(
        /source_item_id is null and t\.created_by is not null/
      );
    }
    // Row-level truth for the SQL owners lives where a database can apply it: the agreement suite
    // in test/datamechanics/enfb2-inquery-provenance.datamechanics.test.ts, which runs both forms
    // against fixtures and compares them to the twin.
  });

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
