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

    // Discovery budget exhausted with nothing authorized: everything read was consumed, so the
    // continuation resumes after the last candidate checked.
    mocks.recent.mockReset().mockResolvedValue({ ok: true, facts: hidden });
    mocks.authorize.mockImplementation(async () => []);
    const bounded = await readAuthorizedGraphFactsResult({} as never, {
      teamId: "team", groupIds: ["g"], query: "launch", limit: 1, discoveryLimit: 25,
    });
    expect(bounded).toMatchObject({ facts: [], incomplete: true, nextOffset: 25, checked: 25 });
  });

  describe("continuation over authorized overflow", () => {
    // 60 candidates in the graph's own order (newest first). Every third one is unauthorized, and
    // candidates from the eleventh on match the query better, so a ranking across a whole page
    // would prefer facts read LATER over the earliest authorized ones.
    const corpus = Array.from({ length: 60 }, (_, index) => ({
      id: `fact-${String(index).padStart(2, "0")}`,
      fact: `launch ${index >= 10 ? "rollout" : "note"} ${index}`,
      at: new Date(Date.UTC(2026, 8, 22) - index * 60_000).toISOString(),
      subjectType: "project", subject: "project", object: "launch",
      episodeUuids: [`episode-${index}`], groupId: index % 2 === 0 ? "g" : "h",
    }));
    const authorizedIds = corpus.filter((_, index) => index % 3 !== 0).map((fact) => fact.id);

    beforeEach(() => {
      mocks.recent.mockReset().mockImplementation(async (
        _groups: string[], _since: string | null, take: number, offset: number,
      ) => ({ ok: true, facts: corpus.slice(offset, offset + take) }));
      mocks.resolve.mockImplementation(async (_groups, ids: string[]) => ({
        ok: true, items: new Map(ids.map((id) => [id, { itemId: id }])),
      }));
      mocks.authorize.mockImplementation(async (_db, input) => input.facts
        .filter((fact: { id: string }) => authorizedIds.includes(fact.id)));
    });

    it("resumes at the first authorized fact it read but did not return", async () => {
      const { readAuthorizedGraphFactsResult } = await import("@/lib/graph/provenance-read");
      // One 25-candidate page holds 16 authorized facts; only the first two are published.
      const first = await readAuthorizedGraphFactsResult({} as never, {
        teamId: "team", groupIds: ["g", "h"], query: "launch rollout", limit: 2,
      });
      expect(first.facts.map((fact) => fact.id).sort()).toEqual(["fact-01", "fact-02"]);
      expect(first).toMatchObject({ incomplete: true, nextOffset: 3, checked: 25 });
    });

    it("pages every authorized fact exactly once, in order, and then reports complete", async () => {
      const { readAuthorizedGraphFactsResult } = await import("@/lib/graph/provenance-read");
      const seen: string[] = [];
      let continuation: number | undefined;
      let last: { incomplete: boolean; nextOffset: number | null } | null = null;
      for (let page = 0; page < corpus.length; page += 1) {
        const result = await readAuthorizedGraphFactsResult({} as never, {
          teamId: "team", groupIds: ["g", "h"], query: "launch rollout", limit: 7, offset: continuation,
        });
        // A page is a contiguous run of the authorized stream, whatever order it is presented in.
        seen.push(...result.facts.map((fact) => fact.id).sort());
        last = result;
        if (result.nextOffset === null) break;
        expect(result.incomplete).toBe(true);
        expect(result.nextOffset).toBeGreaterThan(continuation ?? 0);
        continuation = result.nextOffset;
      }
      expect(seen).toEqual(authorizedIds);
      expect(last).toMatchObject({ incomplete: false, nextOffset: null });
      for (const id of corpus.filter((_, index) => index % 3 === 0).map((fact) => fact.id)) {
        expect(seen).not.toContain(id);
      }
    });

    it("discloses overflow on a short final page instead of reporting it complete", async () => {
      const { readAuthorizedGraphFactsResult } = await import("@/lib/graph/provenance-read");
      // Offset 50 leaves ten candidates — a short page, so the corpus is exhausted — yet seven of
      // them are authorized and only two fit.
      const tail = await readAuthorizedGraphFactsResult({} as never, {
        teamId: "team", groupIds: ["g", "h"], query: "launch", limit: 2, offset: 50,
      });
      expect(tail.facts.map((fact) => fact.id).sort()).toEqual(["fact-50", "fact-52"]);
      expect(tail).toMatchObject({ incomplete: true, nextOffset: 53, checked: 10 });
    });
  });
});
