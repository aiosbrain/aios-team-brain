import { describe, expect, it, vi } from "vitest";
import {
  assertResolvedCorrectionScopes,
  resolveCorrectionScopes,
  snapshotExportFacts,
  validateLedgerAgainstSanitizedGraph,
} from "../scripts/staging-ops/exporter.mjs";

const TEAM_GROUP = "acme_team";

/**
 * A client double that answers the three reads `snapshotExportFacts` performs, keyed on a
 * distinguishing fragment of each statement.
 */
function fakeClient({ ledger = [], corrections = [] }: { ledger?: Record<string, unknown>[]; corrections?: Record<string, unknown>[] }) {
  return {
    query: vi.fn(async (sql: string) => {
      const text = String(sql);
      if (text.includes("FROM graph_episodes ge")) return { rows: ledger };
      if (text.includes("FROM arc_corrections a")) return { rows: corrections };
      return { rows: [] }; // the catalog fingerprint sections
    }),
  };
}

const correctionLedgerRow = (over: Record<string, unknown> = {}) => ({
  source_table: "arc_corrections",
  source_id: "corr-1",
  group_id: TEAM_GROUP,
  pending_delete_group_id: null,
  content_sha256: "c".repeat(64),
  chunk_shas: [],
  deferred: false,
  source_eligible: false,
  ...over,
});

describe("correction synthesis scope is resolved by proof, never by resemblance", () => {
  it("maps a g: key to the group a project in the same team actually owns", async () => {
    const scopes = await resolveCorrectionScopes(fakeClient({
      corrections: [{ id: "corr-1", arc_id: "arc-1", group_key: `g:${TEAM_GROUP}`, proven_group: TEAM_GROUP }],
    }));
    expect(scopes.get("corr-1")).toEqual({ arcId: "arc-1", resolvedGroup: TEAM_GROUP, reason: null });
  });

  it.each([
    ["a legacy tier scope", "", /legacy tier-scope correction has no exact graph group/],
    ["a retired partition namespace", "p:22222222-2222-4222-8222-222222222221", /unsupported correction scope key namespace p:/],
    ["a tier namespace", "tier:team", /unsupported correction scope key namespace tier:/],
  ])("refuses to resolve %s", async (_label, groupKey, reason) => {
    const scopes = await resolveCorrectionScopes(fakeClient({
      corrections: [{ id: "corr-1", arc_id: "arc-1", group_key: groupKey, proven_group: null }],
    }));
    expect(scopes.get("corr-1")?.resolvedGroup).toBeNull();
    expect(scopes.get("corr-1")?.reason).toMatch(reason as RegExp);
  });

  it("refuses a g: key naming a group no project owns", async () => {
    const scopes = await resolveCorrectionScopes(fakeClient({
      corrections: [{ id: "corr-1", arc_id: "arc-1", group_key: "g:looks_like_a_group", proven_group: null }],
    }));
    expect(scopes.get("corr-1")?.reason).toMatch(/names a group no project in this team owns/);
  });
});

describe("an unresolved CURRENT correction is a named refusal", () => {
  it("names the arc and the reason rather than silently dropping the episode", async () => {
    const facts = await snapshotExportFacts(fakeClient({
      ledger: [correctionLedgerRow()],
      corrections: [{ id: "corr-1", arc_id: "arc-1", group_key: "", proven_group: null }],
    }));
    expect(facts.unresolvedCorrections).toEqual(["arc-1: legacy tier-scope correction has no exact graph group"]);
    expect(() => assertResolvedCorrectionScopes(facts)).toThrow(/arc-1: legacy tier-scope correction/);
  });

  it("does not refuse over a deferred or blank row, which is not a current projection", async () => {
    const facts = await snapshotExportFacts(fakeClient({
      ledger: [correctionLedgerRow({ deferred: true }), correctionLedgerRow({ source_id: "corr-2", content_sha256: "" })],
      corrections: [
        { id: "corr-1", arc_id: "arc-1", group_key: "", proven_group: null },
        { id: "corr-2", arc_id: "arc-2", group_key: "", proven_group: null },
      ],
    }));
    expect(facts.unresolvedCorrections).toEqual([]);
    expect(assertResolvedCorrectionScopes(facts)).toBe(true);
  });

  it("refuses when the stored scope disagrees with the ledger row's own group", async () => {
    const facts = await snapshotExportFacts(fakeClient({
      ledger: [correctionLedgerRow({ group_id: "some_other_group" })],
      corrections: [{ id: "corr-1", arc_id: "arc-1", group_key: `g:${TEAM_GROUP}`, proven_group: TEAM_GROUP }],
    }));
    expect(facts.unresolvedCorrections[0]).toMatch(/stored scope acme_team disagrees with ledger group some_other_group/);
  });
});

describe("the correction ledger key names the EPISODE, not the row", () => {
  it("allows a proven correction under its arc-named episode key", async () => {
    const facts = await snapshotExportFacts(fakeClient({
      ledger: [correctionLedgerRow()],
      corrections: [{ id: "corr-1", arc_id: "arc-1", group_key: `g:${TEAM_GROUP}`, proven_group: TEAM_GROUP }],
    }));
    // The recovered code keyed this `correction:<arc_corrections.id>`, which no episode name can
    // ever equal — so the allow was dead and, worse, so was the pending-delete EXCLUDE below.
    expect([...facts.allowed]).toEqual([`correction:arc-1\0${TEAM_GROUP}`]);
  });

  it("excludes the OLD pending-delete group under the same arc-named key", async () => {
    const facts = await snapshotExportFacts(fakeClient({
      ledger: [correctionLedgerRow({ pending_delete_group_id: "acme_old" })],
      corrections: [{ id: "corr-1", arc_id: "arc-1", group_key: `g:${TEAM_GROUP}`, proven_group: TEAM_GROUP }],
    }));
    expect(facts.excluded.has(`correction:arc-1\0acme_old`)).toBe(true);
  });

  it("holds the sanitized graph to that same episode name", async () => {
    const facts = await snapshotExportFacts(fakeClient({
      ledger: [correctionLedgerRow()],
      corrections: [{ id: "corr-1", arc_id: "arc-1", group_key: `g:${TEAM_GROUP}`, proven_group: TEAM_GROUP }],
    }));
    const withEpisode = { nodes: [{ labels: ["Episodic"], properties: { name: "correction:arc-1", group_id: TEAM_GROUP } }] };
    expect(() => validateLedgerAgainstSanitizedGraph(withEpisode, facts)).not.toThrow();
    expect(() => validateLedgerAgainstSanitizedGraph({ nodes: [] }, facts)).toThrow(/does not satisfy current projection ledger/);
  });
});
