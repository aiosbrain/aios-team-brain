import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  epoch: vi.fn(),
  recent: vi.fn(),
  resolve: vi.fn(),
  authorize: vi.fn(),
}));

vi.mock("@/lib/access/authorization-epoch", () => ({ authorizationEpoch: mocks.epoch }));
vi.mock("@/lib/graph/neo4j", () => ({ neo4jConfigured: () => true }));
vi.mock("@/lib/graph/learning", () => ({
  recentFacts: mocks.recent,
  resolveEpisodeItems: mocks.resolve,
}));
vi.mock("@/lib/graph/arc-input-authorization", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/graph/arc-input-authorization")>()),
  authorizedArcFacts: mocks.authorize,
}));

describe("authoritative graph provenance reader", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.epoch.mockResolvedValue(7);
    mocks.recent.mockResolvedValue({
      ok: true,
      facts: [
        { id: "visible", fact: "Project visible launched", at: "2026-09-22T00:00:00Z", subjectType: "project", subject: "Project", object: "Launch", episodeUuids: ["a"], groupId: "g" },
        { id: "mixed", fact: "restricted marker", at: "2026-09-21T00:00:00Z", subjectType: "project", subject: "Secret", object: "Launch", episodeUuids: ["a", "b"], groupId: "g" },
      ],
    });
    mocks.resolve.mockResolvedValue({ items: new Map([
      ["a", { itemId: "item-visible" }], ["b", { itemId: "item-revoked" }],
    ]), ok: true });
    mocks.authorize.mockImplementation(async (_db, input) => input.facts.filter((fact: { id: string }) => fact.id === "visible"));
  });

  it("returns ordinary proven facts and excludes mixed/revoked prose", async () => {
    const { readAuthorizedGraphFacts } = await import("@/lib/graph/provenance-read");
    const facts = await readAuthorizedGraphFacts({} as never, {
      teamId: "team", groupIds: ["g"], query: "project launch", limit: 20,
    });
    expect(facts.map((fact) => fact.id)).toEqual(["visible"]);
    expect(JSON.stringify(facts)).not.toContain("restricted marker");
    expect(mocks.authorize).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      partitionGroup: "g", expectedAuthorizationEpoch: 7,
    }));
  });

  it("fails retryably when relationship or episode provenance cannot be read", async () => {
    const { GraphProvenanceUnavailableError, readAuthorizedGraphFacts } = await import("@/lib/graph/provenance-read");
    mocks.resolve.mockResolvedValueOnce({ items: new Map(), ok: false });
    await expect(readAuthorizedGraphFacts({} as never, { teamId: "team", groupIds: ["g"] }))
      .rejects.toBeInstanceOf(GraphProvenanceUnavailableError);
  });

  it("rebuilds once on an epoch change and never publishes the old fact set", async () => {
    const { readAuthorizedGraphFacts } = await import("@/lib/graph/provenance-read");
    mocks.epoch
      .mockResolvedValueOnce(7).mockResolvedValueOnce(8)
      .mockResolvedValueOnce(8).mockResolvedValueOnce(8);
    mocks.recent
      .mockResolvedValueOnce({ ok: true, facts: [{ id: "old", fact: "old revoked marker", at: "2026-09-22T00:00:00Z", subjectType: "x", subject: "x", object: "x", episodeUuids: ["a"], groupId: "g" }] })
      .mockResolvedValueOnce({ ok: true, facts: [{ id: "new", fact: "current fact", at: "2026-09-22T00:00:00Z", subjectType: "x", subject: "x", object: "x", episodeUuids: ["a"], groupId: "g" }] });
    mocks.authorize.mockImplementation(async (_db, input) => input.facts);
    const facts = await readAuthorizedGraphFacts({} as never, { teamId: "team", groupIds: ["g"] });
    expect(facts.map((fact) => fact.id)).toEqual(["new"]);
  });

  it("refills past an unauthorized top page and discloses a bounded continuation", async () => {
    const { readAuthorizedGraphFactsResult } = await import("@/lib/graph/provenance-read");
    const hidden = Array.from({ length: 25 }, (_, index) => ({
      id: `hidden-${index}`, fact: `launch hidden ${index}`, at: `2026-09-22T00:00:${String(index).padStart(2, "0")}Z`,
      subjectType: "project", subject: "hidden", object: "launch", episodeUuids: [`h-${index}`], groupId: "g",
    }));
    const visible = { id: "old-visible", fact: "launch authorized old evidence", at: "2025-01-01T00:00:00Z",
      subjectType: "project", subject: "visible", object: "launch", episodeUuids: ["v"], groupId: "g" };
    mocks.recent
      .mockResolvedValueOnce({ ok: true, facts: hidden })
      .mockResolvedValueOnce({ ok: true, facts: [visible] });
    mocks.resolve.mockImplementation(async (_groups, ids: string[]) => ({
      ok: true, items: new Map(ids.map((id) => [id, { itemId: id }])),
    }));
    mocks.authorize.mockImplementation(async (_db, input) => input.facts.filter((fact: { id: string }) => fact.id === "old-visible"));
    const result = await readAuthorizedGraphFactsResult({} as never, {
      teamId: "team", groupIds: ["g"], query: "launch", limit: 1,
    });
    expect(result.facts.map((fact) => fact.id)).toEqual(["old-visible"]);
    expect(result.checked).toBe(26);
    expect(result.incomplete).toBe(false);

    mocks.recent.mockReset().mockResolvedValue({ ok: true, facts: hidden });
    mocks.authorize.mockImplementation(async (_db, input) => input.facts);
    const bounded = await readAuthorizedGraphFactsResult({} as never, {
      teamId: "team", groupIds: ["g"], query: "launch", limit: 1, discoveryLimit: 25,
    });
    expect(bounded).toMatchObject({ incomplete: true, nextOffset: 25, checked: 25 });
  });
});
