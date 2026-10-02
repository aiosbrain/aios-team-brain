import { describe, expect, it } from "vitest";
import {
  unsourcedAdmission,
  provenanceRowSqlFromIds,
  provenanceRowSql,
  newSqlParams,
  labelCeilingApplies,
  type UnsourcedAdmission,
} from "@/lib/access/provenance-sql";
import { rowVisibleByProvenanceCtx } from "@/lib/access/provenance";
import { admissionTimelineKey, timelineAdmissionClass } from "@/lib/dashboard/timeline-cache";

/**
 * TIERRET-1 unit tier — the pure policy pieces of the membership-only member read rule
 * (docs/design/tierret1-membership-only.md). Derived from the accepted spec's AC-03/AC-04/AC-12:
 *   · a positively admitted MEMBER's hand-entered authority is `all` ONLY when the admission
 *     resolver says oracle-accepted Everyone (carried as `teamPosture` on the member arm), otherwise
 *     the oracle's GRANTED projects (`memberProjectIds`), otherwise closed;
 *   · the explicit LEGACY arm keeps the pre-TIERRET posture rule exactly (no gain, no loss);
 *   · tokens are unchanged; anything else closes;
 *   · the LABEL ceiling is lifted for the member arm only;
 *   · timeline cache keys live in a NEW namespace that encodes the admission class.
 */

const G = ["g1", "g2"] as const;

describe("unsourcedAdmission — the three-armed member/legacy/token policy", () => {
  const cases: { name: string; ctx: Parameters<typeof unsourcedAdmission>[0]; want: UnsourcedAdmission }[] = [
    { name: "member, oracle-accepted Everyone → all", ctx: { principal: "member", teamPosture: true }, want: { kind: "all" } },
    { name: "member, granted projects → projects", ctx: { principal: "member", teamPosture: false, memberProjectIds: G }, want: { kind: "projects", projectIds: G } },
    { name: "member, EMPTY grants → closed", ctx: { principal: "member", teamPosture: false, memberProjectIds: [] }, want: { kind: "closed" } },
    { name: "member, ABSENT grants → closed (a missing forward never opens)", ctx: { principal: "member", teamPosture: false }, want: { kind: "closed" } },
    { name: "member never reads tokenProjectIds", ctx: { principal: "member", teamPosture: false, tokenProjectIds: G }, want: { kind: "closed" } },
    { name: "legacy @ team posture → all (baseline preserved)", ctx: { principal: "legacy", teamPosture: true }, want: { kind: "all" } },
    { name: "legacy @ external posture → closed", ctx: { principal: "legacy", teamPosture: false }, want: { kind: "closed" } },
    { name: "legacy never acquires the member projects arm", ctx: { principal: "legacy", teamPosture: false, memberProjectIds: G }, want: { kind: "closed" } },
    { name: "token unchanged", ctx: { principal: "token", teamPosture: false, tokenProjectIds: G }, want: { kind: "projects", projectIds: G } },
    { name: "token never reads memberProjectIds", ctx: { principal: "token", teamPosture: true, memberProjectIds: G }, want: { kind: "closed" } },
    { name: "unknown discriminator → closed", ctx: { principal: "bogus" as never, teamPosture: true, memberProjectIds: G }, want: { kind: "closed" } },
    { name: "absent discriminator → closed", ctx: { teamPosture: true, memberProjectIds: G }, want: { kind: "closed" } },
  ];
  it.each(cases)("$name", ({ ctx, want }) => {
    expect(unsourcedAdmission(ctx)).toEqual(want);
  });
});

describe("both SQL forms carry the member granted-projects arm", () => {
  it("id-array form: member with grants scopes the hand-entered arm to project_id", () => {
    const p = newSqlParams();
    const sql = provenanceRowSqlFromIds("t", p, { visibleItemIds: new Set(["i1"]), teamPosture: false, principal: "member", memberProjectIds: G });
    expect(sql).toMatch(/t\.created_by is not null and t\.project_id = any\(\$\d+::uuid\[\]\)/);
    expect(p.values).toContainEqual([...G]);
  });
  it("semijoin form: same arm", () => {
    const p = newSqlParams();
    const sql = provenanceRowSql("d", p, { teamId: "t1", grantedProjectIds: G, teamPosture: false, principal: "member", memberProjectIds: G });
    expect(sql).toMatch(/d\.created_by is not null and d\.project_id = any\(\$\d+::uuid\[\]\)/);
  });
  it("legacy external posture omits the hand-entered arm entirely", () => {
    const sql = provenanceRowSqlFromIds("t", newSqlParams(), { visibleItemIds: new Set(), teamPosture: false, principal: "legacy" });
    expect(sql).not.toMatch(/created_by/);
  });
});

describe("rowVisibleByProvenanceCtx — the TS twin over the same ctx", () => {
  const authored = (project_id: string) => ({ source_item_id: null, created_by: "u1", project_id });
  it("member with grants: granted project yes, other project no", () => {
    const ctx = { visibleItemIds: new Set<string>(), teamPosture: false, principal: "member" as const, memberProjectIds: G };
    expect(rowVisibleByProvenanceCtx(authored("g1"), ctx)).toBe(true);
    expect(rowVisibleByProvenanceCtx(authored("elsewhere"), ctx)).toBe(false);
  });
  it("sourced rows follow the visible item set only", () => {
    const ctx = { visibleItemIds: new Set(["i1"]), teamPosture: false, principal: "member" as const, memberProjectIds: [] };
    expect(rowVisibleByProvenanceCtx({ source_item_id: "i1", created_by: null, project_id: "x" }, ctx)).toBe(true);
    expect(rowVisibleByProvenanceCtx({ source_item_id: "i2", created_by: null, project_id: "x" }, ctx)).toBe(false);
  });
  it("no provenance (no source, no creator) is hidden for every principal", () => {
    for (const principal of ["member", "legacy", "token"] as const) {
      expect(rowVisibleByProvenanceCtx({ source_item_id: null, created_by: null, project_id: "g1" }, { visibleItemIds: new Set(), teamPosture: true, principal, memberProjectIds: G, tokenProjectIds: G })).toBe(false);
    }
  });
});

describe("labelCeilingApplies — the label wall is lifted for admitted members only", () => {
  it.each([
    ["member", "external", false],
    ["member", "team", false],
    ["legacy", "external", true],
    ["legacy", "team", false],
    ["token", "external", true],
    [undefined, "external", true],
    ["bogus", "team", false],
    ["bogus", "weird-tier", true],
    ["legacy", "weird-tier", true],
  ] as const)("principal=%s tier=%s → %s", (principal, tier, want) => {
    expect(labelCeilingApplies(principal as never, tier)).toBe(want);
  });
});

describe("timeline cache keys — a NEW namespace that encodes admission (AC-12)", () => {
  it("member-everyone, member-granted and legacy are distinct key classes", () => {
    expect(timelineAdmissionClass({ kind: "member", everyone: true })).toBe("me");
    expect(timelineAdmissionClass({ kind: "member", everyone: false })).toBe("mg");
    expect(timelineAdmissionClass({ kind: "legacy" })).toBe("lg");
  });
  it("the key carries namespace, class, tier and the visibility hash — never the old vis: shape", () => {
    const k = admissionTimelineKey("mg", "external", "abc123");
    expect(k).toBe("adm:mg:external:abc123");
    expect(k.startsWith("vis:")).toBe(false);
    expect(admissionTimelineKey("lg", "external", "abc123")).not.toBe(k);
  });
});
