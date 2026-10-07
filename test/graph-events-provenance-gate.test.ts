import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  recentEventsWithStatus: vi.fn(),
  authorizedFacts: vi.fn(),
  projects: new Set<string>(),
  groups: ["g-visible"],
  visibleItems: new Set<string>(),
  epoch: 1,
  resolveHumanActorsByItem: vi.fn(),
}));

vi.mock("@/lib/auth/session", () => ({ getSessionUser: vi.fn(async () => ({ id: "user-1" })) }));
vi.mock("@/lib/db/server", () => ({
  serverClient: vi.fn(async () => ({
    from: (table: string) => {
      const chain: Record<string, unknown> = {};
      chain.select = () => chain;
      chain.eq = () => chain;
      chain.maybeSingle = async () => ({
        data: table === "teams" ? { id: "team-1" } : { id: "member-1" },
      });
      return chain;
    },
  })),
}));
vi.mock("@/lib/db/admin", () => ({
  adminClient: vi.fn(() => ({
    from: () => {
      const chain: Record<string, unknown> = {};
      chain.select = () => chain;
      chain.eq = () => chain;
      chain.in = () => chain;
      chain.limit = async () => ({ data: [{ id: "system" }], error: null });
      return chain;
    },
  })),
}));
vi.mock("@/lib/access/oracle", () => ({
  visibleProjectsWithError: vi.fn(async () => ({
    set: { projectIds: mocks.projects }, error: false,
  })),
}));
vi.mock("@/lib/graph/partition-read", () => ({
  selectEnforcedGraphPartitions: vi.fn(async () => ({
    groups: mocks.groups, generalSuppressed: false,
  })),
}));
vi.mock("@/lib/graph/learning", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/graph/learning")>()),
  recentEventsWithStatus: mocks.recentEventsWithStatus,
}));
vi.mock("@/lib/graph/provenance-read", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/graph/provenance-read")>()),
  readAuthorizedGraphFacts: mocks.authorizedFacts,
}));
vi.mock("@/lib/access/enforce", () => ({
  visibleItemIdsForProjects: vi.fn(async () => ({ ids: mocks.visibleItems, error: false })),
}));
vi.mock("@/lib/access/authorization-epoch", () => ({
  authorizationEpoch: vi.fn(async () => mocks.epoch),
}));
vi.mock("@/lib/graph/human-actors", () => ({
  resolveHumanActorsByItem: mocks.resolveHumanActorsByItem,
}));

describe("authenticated events provenance boundary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.projects.clear();
    mocks.projects.add("project-visible");
    mocks.groups = ["g-visible"];
    mocks.visibleItems.clear();
    mocks.visibleItems.add("item-visible");
    mocks.epoch = 1;
    mocks.resolveHumanActorsByItem.mockReset();
    mocks.resolveHumanActorsByItem.mockImplementation(async () => new Map<string, string>());
    mocks.recentEventsWithStatus.mockResolvedValue({
      ok: true,
      events: [{
        id: "event-1", itemId: "item-visible", source: "gdrive", title: "Authorized title",
        at: "2026-09-22T00:00:00Z", participants: ["Authorized participant"], facts: [], factCount: 0,
        factEvidence: [
          { id: "fact-visible", fact: "visible prose", episodeUuids: ["ep-visible"], groupId: "g-visible" },
          { id: "fact-mixed", fact: "restricted mixed prose", episodeUuids: ["ep-visible", "ep-hidden"], groupId: "g-visible" },
        ],
      }],
    });
    mocks.authorizedFacts.mockResolvedValue([{
      id: "fact-visible", fact: "visible prose", at: "2026-09-22T00:00:00Z",
      subjectType: "document", subject: "A", object: "B", episodeUuids: ["ep-visible"], groupId: "g-visible",
    }]);
  });

  it("returns an authorized event while stripping a mixed-source fact", async () => {
    const { GET } = await import("@/app/api/brain/events/route");
    const response = await GET(new Request("http://test/api/brain/events?team=acme") as never);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.events).toEqual([expect.objectContaining({
      title: "Authorized title", participants: ["Authorized participant"],
      facts: ["visible prose"], factCount: 1,
    })]);
    expect(JSON.stringify(body)).not.toContain("restricted mixed prose");
    expect(JSON.stringify(body)).not.toContain("episodeUuids");
  });

  it("excludes an event whose own episode item is restricted", async () => {
    mocks.visibleItems.clear();
    const { GET } = await import("@/app/api/brain/events/route");
    const response = await GET(new Request("http://test/api/brain/events?team=acme") as never);
    expect(response.status).toBe(200);
    expect((await response.json()).events).toEqual([]);
  });

  it("returns retryable unavailable when complete provenance cannot be read", async () => {
    const { GraphProvenanceUnavailableError } = await import("@/lib/graph/provenance-read");
    mocks.authorizedFacts.mockRejectedValueOnce(new GraphProvenanceUnavailableError());
    const { GET } = await import("@/app/api/brain/events/route");
    const response = await GET(new Request("http://test/api/brain/events?team=acme") as never);
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: { code: "temporarily_unavailable" } });
  });

  it("discards a candidate when a revocation lands during participant attribution", async () => {
    mocks.visibleItems.add("item-kept");
    mocks.recentEventsWithStatus.mockResolvedValue({
      ok: true,
      events: [
        {
          id: "event-1", itemId: "item-visible", source: "gdrive", title: "Authorized title",
          at: "2026-09-22T00:00:00Z", participants: ["Authorized participant"], facts: [], factCount: 0,
          factEvidence: [
            { id: "fact-visible", fact: "visible prose", episodeUuids: ["ep-visible"], groupId: "g-visible" },
          ],
        },
        {
          id: "event-2", itemId: "item-kept", source: "gdrive", title: "Kept title",
          at: "2026-09-21T00:00:00Z", participants: ["Claude Code"], facts: [], factCount: 0,
          factEvidence: [],
        },
      ],
    });
    // The revocation commits while the first attempt is suspended in attribution, i.e. after every
    // authorization read of that attempt has already passed.
    mocks.resolveHumanActorsByItem.mockImplementationOnce(async () => {
      mocks.visibleItems.delete("item-visible");
      mocks.authorizedFacts.mockResolvedValue([]);
      mocks.epoch = 2;
      return new Map([["item-visible", "Stale Human"], ["item-kept", "Stale Human"]]);
    });
    mocks.resolveHumanActorsByItem.mockImplementationOnce(async () => new Map([["item-kept", "Dana"]]));

    const { GET } = await import("@/app/api/brain/events/route");
    const response = await GET(new Request("http://test/api/brain/events?team=acme") as never);

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.events).toEqual([expect.objectContaining({
      id: "event-2", title: "Kept title", participants: ["Claude Code (Dana)"], facts: [], factCount: 0,
    })]);
    const wire = JSON.stringify(body);
    for (const restricted of ["Authorized title", "visible prose", "Authorized participant", "Stale Human"]) {
      expect(wire).not.toContain(restricted);
    }
    expect(mocks.resolveHumanActorsByItem).toHaveBeenCalledTimes(2);
    expect(mocks.resolveHumanActorsByItem.mock.calls[1][2]).toEqual(["item-kept"]);
  });

  it("fails closed when every bounded attempt is revoked during attribution", async () => {
    mocks.resolveHumanActorsByItem.mockImplementation(async () => {
      mocks.epoch += 1;
      return new Map<string, string>();
    });

    const { GET } = await import("@/app/api/brain/events/route");
    const response = await GET(new Request("http://test/api/brain/events?team=acme") as never);

    expect(response.status).toBe(503);
    const body = await response.json();
    expect(body).toMatchObject({ error: { code: "temporarily_unavailable" } });
    const wire = JSON.stringify(body);
    for (const restricted of ["Authorized title", "visible prose", "Authorized participant"]) {
      expect(wire).not.toContain(restricted);
    }
    expect(mocks.resolveHumanActorsByItem).toHaveBeenCalledTimes(2);
  });
});
