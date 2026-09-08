import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  assertCopiedItems,
  compareSubstrateSnapshots,
} from "../scripts/staging-ops/staging-pair-fixture.mjs";
import { compareIdSets } from "../scripts/staging-ops/source-read-oracle";

/**
 * The measured gap (`runtime-oracle-adjudication.md`): the fixture seeded four items and their
 * project grants and **zero context units or memberships**, while `GET /api/v1/items` intersects
 * every result with the caller's CURRENT include memberships whose units are active and item-grain.
 * So the seed predicted `internal=0, external=0` BEFORE anything was copied — a successful
 * authentication returning an empty page, which restore and ready receipts cannot tell apart from a
 * broken copy. Graph survival was compatible with it too: exporter eligibility independently accepts
 * `target.id = i.project_id`.
 *
 * Two things follow, and both are pinned here: the seed must build that substrate, and the oracle
 * that reads it must be able to REFUSE. The runtime proof is the harness — a real handler, real
 * authentication and a real database — and these tests are what make its assertions non-vacuous.
 */

const ITEMS = {
  external: "33333333-3333-4333-8333-333333333330",
  team: "33333333-3333-4333-8333-333333333331",
  private: "33333333-3333-4333-8333-333333333332",
  deferred: "33333333-3333-4333-8333-333333333333",
};
const PROJECTS_FOR_TEST = {
  external: "22222222-2222-4222-8222-222222222220",
  team: "22222222-2222-4222-8222-222222222221",
  private: "22222222-2222-4222-8222-222222222222",
  deferred: "22222222-2222-4222-8222-222222222223",
};
const ALL = Object.values(ITEMS);

describe("the visible-set comparison is exact, not a count", () => {
  it("accepts exactly the expected set, in any order", () => {
    expect(compareIdSets([...ALL].reverse(), ALL).ok).toBe(true);
  });

  it("REFUSES a narrowed set — a removed or closed membership", () => {
    // The harness's own negative control, as a property: closing one include membership drops one
    // item, and the oracle must say which.
    const verdict = compareIdSets(ALL.filter((id) => id !== ITEMS.private), ALL);
    expect(verdict.ok).toBe(false);
    expect(verdict.missing.named).toEqual([ITEMS.private]);
    expect(verdict.extra.named).toEqual([]);
  });

  it("REFUSES a wrong id even when the COUNT matches", () => {
    // Counting is precisely what let an empty-but-successful read look like a passing one, and a
    // swapped id is the same failure with the numbers hidden.
    const swapped = [...ALL.slice(0, 3), "44444444-4444-4444-8444-444444444440"];
    const verdict = compareIdSets(swapped, ALL);
    expect(swapped.length).toBe(ALL.length);
    expect(verdict.ok).toBe(false);
    expect(verdict.missing.named).toEqual([ITEMS.deferred]);
    // An id outside the fixture's allowlist is reported as a COUNT, never printed.
    expect(verdict.extra.named).toEqual([]);
    expect(verdict.extra.unknown).toBe(1);
  });

  it("REFUSES duplicates, which a length check cannot see", () => {
    const verdict = compareIdSets([ITEMS.external, ITEMS.external, ITEMS.team, ITEMS.private], ALL);
    expect(verdict.ok).toBe(false);
    expect(verdict.duplicates).toBe(1);
  });

  it("REFUSES the empty page the old seed actually produced", () => {
    const verdict = compareIdSets([], ALL);
    expect(verdict.ok).toBe(false);
    expect(verdict.missing.named).toEqual([...ALL].sort());
  });

  it("names only allowlisted synthetic identities", () => {
    const verdict = compareIdSets(["not-a-fixture-id", "another-unknown"], ALL);
    expect(verdict.extra.named).toEqual([]);
    expect(verdict.extra.unknown).toBe(2);
    expect(JSON.stringify(verdict)).not.toContain("not-a-fixture-id");
  });
});

describe("the fixture seeds the substrate the handler actually reads through", () => {
  const fixture = readFileSync("scripts/staging-ops/staging-pair-fixture.mjs", "utf8");

  const context = readFileSync("scripts/staging-ops/staging-pair-context.ts", "utf8");
  /** Negative assertions are about CODE; the comments name the alternatives they rule out. */
  const contextCode = context.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

  it("writes the substrate through its CANONICAL OWNERS, not hand-rolled SQL", () => {
    // Those two tables have single-writer owner modules and a build-failing guard. Parameterised SQL
    // in the fixture was permitted, but it would have seeded rows that no longer had to obey the
    // no-widening gate or the locked revalidation protocol — in a harness whose whole purpose is
    // checking an access boundary.
    expect(context).toContain("reconcileItemUnit");
    expect(context).toContain("ensureIncludeMembership");
    expect(fixture).not.toMatch(/INSERT INTO project_context_(units|memberships)/i);
    // `reconcileItemContext` is NOT the model: it needs system projects this fixture never creates
    // and can return `skipped`, which would seed nothing and still look successful.
    expect(contextCode).not.toContain("reconcileItemContext");
    // Every result is REQUIRED, so a skip or a refusal cannot pass for a seed.
    expect(context).toContain("was not reconciled");
    expect(context).toContain("was refused");
  });

  it("targets each item's OWN project, never General", () => {
    // A General membership would widen exactly the private boundary this harness measures.
    expect(context).toContain("projectId: PROJECTS[kind]");
    expect(context).toMatch(/Never General/);
  });

  it("requires four current memberships and retains the closed membership after reopen", () => {
    // Counted in the DATABASE, not taken from the helper's return: "it reported success" and "four
    // rows exist" are different claims.
    expect(fixture).toContain("counts.units !== 4 || counts.memberships !== 4");
    expect(fixture).toContain("counts.memberships !== 5 || counts.current_memberships !== 4 || counts.closed_memberships !== 1");
    expect(fixture).toContain("await assertSubstrateSeeded(prod)");
    expect(fixture).toContain('action === "assert-reopened-substrate"');
  });

  it("mirrors the unit when the item is mutated, through the same owner", () => {
    expect(fixture).toContain('contextAction("mirror", "team")');
    expect(context).toContain("was not mirrored");
  });

  it("keeps grants and group memberships untouched", () => {
    // The correction is additive: the access boundary it is measuring must not move with it.
    expect(fixture).toContain("INSERT INTO project_groups");
    expect(fixture).toContain("INSERT INTO group_members");
    expect(fixture).not.toMatch(/INSERT INTO project_groups[\s\S]{0,200}GENERAL/i);
  });
});

describe("the harness asks the SOURCE before it trusts the copy", () => {
  const harness = readFileSync("scripts/staging-pair-isolated.sh", "utf8");

  it("runs the source oracle BEFORE the first export", () => {
    const oracle = harness.indexOf("fixture-controller assert-source");
    const firstExport = harness.indexOf("STAGING_BUNDLE_RUN_ID=run-1 exporter");
    expect(oracle).toBeGreaterThan(-1);
    expect(oracle, "a source read after the export proves nothing about what was copied").toBeLessThan(firstExport);
  });

  it("proves the source oracle can REFUSE, then restores the membership", () => {
    expect(harness).toContain("fixture-controller close-membership private");
    expect(harness).toContain("expect_failure source-oracle-refuses-narrowed");
    expect(harness).toContain("fixture-controller open-membership private");
    // …and the refusal must be about the narrowed set, not about anything else that exits non-zero.
    expect(harness).toContain('grep -q "missing" "$harness_root/source-oracle-refuses-narrowed.log"');
    // Reopened BEFORE the export, so the exported capture is the full one.
    const reopen = harness.indexOf("fixture-controller open-membership private");
    expect(reopen).toBeLessThan(harness.indexOf("STAGING_BUNDLE_RUN_ID=run-1 exporter"));
  });

  it("compares source and restored substrate BEFORE anything could repair staging", () => {
    const compare = harness.indexOf("fixture-controller compare-substrate");
    expect(compare).toBeGreaterThan(-1);
    // After the first install tick (there is something to compare), but before assert v1 can exit on
    // a copied-read failure and before the second run can overwrite what the comparison is about.
    expect(compare).toBeGreaterThan(harness.indexOf("importer scripts/staging-ops/importer.mjs tick"));
    expect(compare).toBeLessThan(harness.indexOf("fixture-controller assert v1"));
    expect(compare).toBeLessThan(harness.indexOf("fixture-controller mutate v2"));
  });

  it("keeps the graph, credential-sanitation and outbound-spy assertions", () => {
    // The correction is additive; none of the existing oracles may be traded for it.
    expect(harness).toContain("assert-graph-version");
    expect(harness).toContain("corrupt-graph-version v99");
    expect(harness).toContain("object-store-acl-probe.mjs expect-access-denied-get");
    const fixture = readFileSync("scripts/staging-ops/staging-pair-fixture.mjs", "utf8");
    expect(fixture).toContain("credentials or outbound queues survived sanitation");
    expect(fixture).toContain("forbidden extraction/provider request(s)");
  });
});

describe("the copied-side oracle behavior", () => {
  const expectedAccess = Object.fromEntries(ALL.map((id, index) => [id, index === 0 ? "external" : "team"]));
  const response = (items: { id: string; access: string }[], next_cursor: string | null = null) => ({ items, next_cursor });
  const allItems = ALL.map((id) => ({ id, access: expectedAccess[id] }));

  it("accepts the exact IDs and access values with no further page", () => {
    expect(assertCopiedItems("copied internal", response(allItems), expectedAccess).ids).toEqual(ALL);
  });

  it("refuses a same-count wrong ID, duplicate, wrong access, and pagination", () => {
    expect(() => assertCopiedItems("copied internal", response([...allItems.slice(0, 3), { id: "unknown-id", access: "team" }]), expectedAccess)).toThrow(/wrong exact ID set/);
    expect(() => assertCopiedItems("copied internal", response([allItems[0], allItems[0], ...allItems.slice(2)]), expectedAccess)).toThrow(/wrong exact ID set/);
    expect(() => assertCopiedItems("copied internal", response(allItems.map((item, index) => index === 2 ? { ...item, access: "external" } : item)), expectedAccess)).toThrow(/had access external, expected team/);
    expect(() => assertCopiedItems("copied internal", response(allItems, "another-page"), expectedAccess)).toThrow(/further page/);
  });
});

describe("source/restored substrate comparison behavior", () => {
  const unitIds = ALL.map((_, index) => `90000000-0000-4000-8000-00000000000${index}`);
  const membershipIds = [...ALL.map((_, index) => `91000000-0000-4000-8000-00000000000${index}`), "91000000-0000-4000-8000-000000000004"];
  const source = {
    units: ALL.map((source_item_id, index) => ({ id: unitIds[index], source_item_id, unit_kind: "item", unit_key: "item", state: "active", audience: index === 0 ? "external" : "team", content_sha256: `hash-${index}` })),
    memberships: [
      ...ALL.map((source_item_id, index) => ({ id: membershipIds[index], context_unit_id: unitIds[index], project_id: Object.values(PROJECTS_FOR_TEST)[index], source_item_id, decision: "include", mode: "auto", method: "ingestion_project", current: true })),
      { id: membershipIds[4], context_unit_id: unitIds[2], project_id: Object.values(PROJECTS_FOR_TEST)[2], source_item_id: ALL[2], decision: "include", mode: "auto", method: "ingestion_project", current: false },
    ],
    grants: Object.values(PROJECTS_FOR_TEST).map((project_id, index) => ({ project_id, group_id: `44444444-4444-4444-8444-44444444444${index % 3}` })),
    groupMembers: [],
  };

  it("accepts preserved UUIDs, links, and four-current plus one-closed history", () => {
    expect(compareSubstrateSnapshots(source, structuredClone(source))).toMatchObject({ units: 4, memberships: 5, currentMemberships: 4, closedMemberships: 1 });
  });

  it("refuses re-minted UUIDs, broken links, and dropped history without leaking unknown UUIDs", () => {
    const reminted = structuredClone(source); reminted.units[0].id = "private-reminted-unit";
    expect(() => compareSubstrateSnapshots(source, reminted)).toThrow(/"unknown":1/);
    try { compareSubstrateSnapshots(source, reminted); } catch (error) { expect(String(error)).not.toContain("private-reminted-unit"); }

    const relinked = structuredClone(source); relinked.memberships[0].context_unit_id = unitIds[1];
    expect(() => compareSubstrateSnapshots(source, relinked)).toThrow(/"field":"memberships"/);

    const withoutHistory = structuredClone(source); withoutHistory.memberships.pop();
    expect(() => compareSubstrateSnapshots(source, withoutHistory)).toThrow(/"closed":0/);
  });
});
