import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";

/**
 * AIO-1167 (r30, M-d): two attributed routes whose authority reads used to sit OUTSIDE their
 * retryable error mapping.
 *
 *   · `GET /api/dashboard/timeline?days>7` — the fresh-build arm credits work by `items.member_id`
 *     and bypassed the cache layer's barrier entirely: it was served while an attribution repair was
 *     pending and across an epoch change during the build. It must refuse with the retryable 503
 *     before or after the build, rebuild once on one epoch change, and 503 on a second.
 *   · `POST /api/brain/arcs/recompute` — its gated epoch reads ran outside every `try`, so a pending
 *     repair or an unreadable authority escaped as a raw 500 (or, through `readArcCache`'s miss, a
 *     misleading 403).
 *
 * Every authority, builder and synthesis dependency is controlled here; the real-PG remap/unlink
 * fixtures live in `test/datamechanics/attribution-repair-route-gate.datamechanics.test.ts`.
 */

const h = vi.hoisted(() => {
  class AttributionRepairPendingError extends Error {
    constructor() {
      super("identity attribution repair is not complete; retry after the current mapping repair");
      this.name = "AttributionRepairPendingError";
    }
  }
  class TimelineAuthorizationChangedError extends Error {
    readonly retryable = true;
    constructor() {
      super("Timeline authorization changed while the view was being built; retry the request");
      this.name = "TimelineAuthorizationChangedError";
    }
  }
  class ArcSynthesisAuthorizationChangedError extends Error {}
  class ArcInputAuthorizationUnavailableError extends Error {}
  return {
    AttributionRepairPendingError,
    TimelineAuthorizationChangedError,
    ArcSynthesisAuthorizationChangedError,
    ArcInputAuthorizationUnavailableError,
    user: { id: "auth-1" } as { id: string } | null,
    team: { id: "team-1" } as { id: string } | null,
    member: { id: "member-1" } as { id: string } | null,
    tier: "team" as "team" | "external",
    authority: { epoch: 5, pending: false, readFailure: null as Error | null },
    /** Called with the 1-based build number while the fresh timeline is being built. */
    duringBuild: null as null | ((build: number) => void),
    builds: 0,
    enforcements: 0,
    cachedReads: 0,
    cachedError: null as unknown,
    arcCache: null as null | { arcs: unknown[] },
    duringArcCacheRead: null as null | (() => void),
    recompute: null as null | (() => Promise<unknown>),
    recomputes: 0,
    enforcementFailure: false,
  };
});

vi.mock("server-only", () => ({}));
vi.mock("@/lib/auth/session", () => ({ getSessionUser: async () => h.user }));
vi.mock("@/lib/db/server", () => ({
  serverClient: async () => ({
    from(table: string) {
      const row = table === "teams" ? h.team : h.member;
      const chain = { select: () => chain, eq: () => chain, maybeSingle: async () => ({ data: row, error: null }) };
      return chain;
    },
  }),
}));
vi.mock("@/lib/db/admin", () => ({ adminClient: () => ({}) }));
vi.mock("@/lib/api/auth", () => ({
  authenticateApiKey: async () => ({ teamId: "team-1", memberId: "member-1", apiKeyId: "key-1", memberTier: "team" }),
}));
vi.mock("@/lib/api/rate-limit", () => ({ rateLimit: async () => true }));
vi.mock("@/lib/access/posture", () => ({ resolveViewerPosture: async () => h.tier }));
vi.mock("@/lib/access/authorization-epoch", () => {
  const gate = () => {
    if (h.authority.readFailure) throw h.authority.readFailure;
    if (h.authority.pending) throw new h.AttributionRepairPendingError();
    return h.authority.epoch;
  };
  return {
    AttributionRepairPendingError: h.AttributionRepairPendingError,
    authorizationEpoch: async () => gate(),
    withLockedAuthorizationEpoch: async (_teamId: string, fn: (epoch: number) => unknown) => fn(gate()),
  };
});
vi.mock("@/lib/access/admission", () => ({
  contentTimelineEnforcement: async () => {
    h.enforcements += 1;
    return { visibleItemIds: new Set(["item-1"]) };
  },
}));
vi.mock("@/lib/dashboard/work-timeline", () => ({
  WINDOW_DAYS: 7,
  MAX_WINDOW_DAYS: 90,
  getWorkTimeline: async () => {
    h.builds += 1;
    h.duringBuild?.(h.builds);
    // `items.member_id`-derived credit, tagged by build so a response shows which build it served.
    return [{ date: "2026-10-01", people: [{ member_id: "mapped-member", name: `MAPPED-CREDIT-${h.builds}` }] }];
  },
}));
vi.mock("@/lib/dashboard/timeline-cache", () => ({
  TimelineAuthorizationChangedError: h.TimelineAuthorizationChangedError,
  getCachedWorkTimeline: async () => {
    h.cachedReads += 1;
    if (h.cachedError) throw h.cachedError;
    return { days: [{ date: "2026-10-20", people: [] }], freshness: {} };
  },
}));
// Arcs recompute dependencies.
vi.mock("@/lib/query/answering", () => ({ resolveAnsweringKeys: async () => ({}) }));
vi.mock("@/lib/staging/model-features", () => ({ modelFeatureVerdict: () => ({ enabled: true, posture: "enabled" }) }));
vi.mock("@/lib/graph/arcs", () => ({
  recomputeArcs: async () => {
    h.recomputes += 1;
    return h.recompute!();
  },
}));
vi.mock("@/lib/graph/partition-read", () => ({ resolveArcScope: async () => ({ groups: ["acme_team"] }) }));
vi.mock("@/lib/access/enforce", () => ({
  memberEnforcement: async () => {
    if (h.enforcementFailure) throw new Error("membership read failed: relation \"group_members\"");
    return { visibleItemIds: new Set(["item-1"]) };
  },
}));
vi.mock("@/lib/graph/arc-cache", () => ({
  readArcCache: async () => {
    h.duringArcCacheRead?.();
    return h.arcCache;
  },
}));
vi.mock("@/lib/graph/arc-input-authorization", () => ({
  ArcSynthesisAuthorizationChangedError: h.ArcSynthesisAuthorizationChangedError,
  ArcInputAuthorizationUnavailableError: h.ArcInputAuthorizationUnavailableError,
}));

const timelineRoute = await import("@/app/api/dashboard/timeline/route");
const recomputeRoute = await import("@/app/api/brain/arcs/recompute/route");
const v1TimelineRoute = await import("@/app/api/v1/timeline/route");
const teamWorkRoute = await import("@/app/api/dashboard/team-work/route");
const { computedNow } = await import("@/lib/freshness");

const PENDING = { code: "temporarily_unavailable", message: "attribution repair is in progress; retry shortly" };
const TIMELINE_CHANGED = { code: "temporarily_unavailable", message: "timeline authorization changed; retry the request" };
const ARC_UNAVAILABLE = { code: "temporarily_unavailable", message: "arc authorization unavailable; retry the request" };
const ARC = { id: "arc-1", title: "Payments", evidence: [{ itemId: "item-1", fact: "f" }], participants: ["MAPPED-PARTICIPANT"] };

async function read(res: Response) {
  const text = await res.text();
  return { status: res.status, text, json: JSON.parse(text) as Record<string, unknown> };
}

function timeline(days?: number) {
  const q = days === undefined ? "team=acme" : `team=acme&days=${days}`;
  return timelineRoute.GET(new Request(`http://test/api/dashboard/timeline?${q}`) as unknown as NextRequest);
}

function recompute(body: Record<string, unknown> = {}) {
  return recomputeRoute.POST(new Request("http://test/api/brain/arcs/recompute", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      team: "acme",
      sourceGroup: "acme_team",
      corrections: [{ arc_id: "arc-1", corrected_text: "the payments work moved" }],
      ...body,
    }),
  }) as unknown as NextRequest);
}

beforeEach(() => {
  h.user = { id: "auth-1" };
  h.team = { id: "team-1" };
  h.member = { id: "member-1" };
  h.tier = "team";
  h.authority = { epoch: 5, pending: false, readFailure: null };
  h.duringBuild = null;
  h.builds = 0;
  h.enforcements = 0;
  h.cachedReads = 0;
  h.cachedError = null;
  h.arcCache = { arcs: [ARC] };
  h.duringArcCacheRead = null;
  h.recompute = async () => ({ arcs: [ARC], freshness: computedNow() });
  h.recomputes = 0;
  h.enforcementFailure = false;
});

describe("GET /api/dashboard/timeline — the days>7 fresh-build arm is attribution-gated", () => {
  it("a repair already pending refuses before any build: retryable 503, no mapped credit", async () => {
    h.authority.pending = true;
    const { status, json, text } = await read(await timeline(30));
    expect(status).toBe(503);
    expect(json).toEqual({ error: { ...PENDING, request_id: expect.any(String) } });
    expect(text).not.toContain("MAPPED-CREDIT");
    expect(h.builds).toBe(0);
  });

  it("a remap/unlink that marks the repair pending DURING the build is refused at publication", async () => {
    h.duringBuild = () => {
      h.authority.pending = true;
    };
    const { status, json, text } = await read(await timeline(30));
    expect(status).toBe(503);
    expect(json).toEqual({ error: { ...PENDING, request_id: expect.any(String) } });
    // The build ran and produced stale mapped credit; none of it reached the response.
    expect(h.builds).toBe(1);
    expect(text).not.toContain("MAPPED-CREDIT");
  });

  it("one epoch change during the build rebuilds from a fresh admission and serves only the second build", async () => {
    h.duringBuild = (build) => {
      if (build === 1) h.authority.epoch += 1;
    };
    const { status, json, text } = await read(await timeline(30));
    expect(status).toBe(200);
    expect(h.builds).toBe(2);
    expect(h.enforcements).toBe(2);
    expect(text).not.toContain("MAPPED-CREDIT-1");
    expect(json).toMatchObject({ window_days: 30, days: [{ people: [{ name: "MAPPED-CREDIT-2" }] }] });
  });

  it("publication churn on both builds is the retryable timeline-changed 503, never a 500 or a payload", async () => {
    h.duringBuild = () => {
      h.authority.epoch += 1;
    };
    const { status, json, text } = await read(await timeline(30));
    expect(status).toBe(503);
    expect(json).toEqual({ error: { ...TIMELINE_CHANGED, request_id: expect.any(String) } });
    expect(h.builds).toBe(2);
    expect(text).not.toContain("MAPPED-CREDIT");
  });

  it("a stable authority serves the single build unchanged", async () => {
    const { status, json } = await read(await timeline(30));
    expect(status).toBe(200);
    expect(h.builds).toBe(1);
    expect(json).toMatchObject({ window_days: 30, days: [{ people: [{ name: "MAPPED-CREDIT-1" }] }] });
  });

  it("the cached 7-day arm maps the cache's authorization churn to the same 503", async () => {
    h.cachedError = new h.TimelineAuthorizationChangedError();
    const { status, json } = await read(await timeline());
    expect(status).toBe(503);
    expect(json).toEqual({ error: { ...TIMELINE_CHANGED, request_id: expect.any(String) } });
    expect(h.builds).toBe(0);
    h.cachedError = new h.AttributionRepairPendingError();
    expect((await read(await timeline(7))).json).toEqual({ error: { ...PENDING, request_id: expect.any(String) } });
  });

  it("the other cached-Timeline routes map the same churn and pending errors to the same 503s", async () => {
    const v1 = () => v1TimelineRoute.GET(new Request("http://test/api/v1/timeline", {
      headers: { authorization: "Bearer aios_key1_secret" },
    }) as unknown as NextRequest);
    const teamWork = () => teamWorkRoute.GET(new Request("http://test/api/dashboard/team-work?team=acme") as unknown as NextRequest);
    for (const route of [v1, teamWork]) {
      h.cachedError = new h.TimelineAuthorizationChangedError();
      expect((await read(await route())).json).toEqual({ error: { ...TIMELINE_CHANGED, request_id: expect.any(String) } });
      h.cachedError = new h.AttributionRepairPendingError();
      expect((await read(await route())).json).toEqual({ error: { ...PENDING, request_id: expect.any(String) } });
    }
  });

  it("/api/v1/timeline answers any other failure with a fixed 500 that never echoes the exception (F2)", async () => {
    const marker = "PRIVATE-MARKER-relation-work_timeline_cache-zq";
    h.cachedError = new Error(`admission read failed: ${marker}`);
    const res = await v1TimelineRoute.GET(new Request("http://test/api/v1/timeline", {
      headers: { authorization: "Bearer aios_key1_secret" },
    }) as unknown as NextRequest);
    const { status, json, text } = await read(res);
    expect(status).toBe(500);
    expect(json).toEqual({ error: { code: "internal", message: "timeline read failed", request_id: expect.any(String) } });
    expect(text).not.toContain(marker);
  });

  it("authentication and membership statuses are unchanged, and are decided before any authority read", async () => {
    h.authority.pending = true;
    h.user = null;
    expect((await timeline(30)).status).toBe(401);
    h.user = { id: "auth-1" };
    h.member = null;
    expect((await timeline(30)).status).toBe(403);
    h.member = { id: "member-1" };
    h.team = null;
    expect((await timeline(30)).status).toBe(403);
    const missingTeam = await timelineRoute.GET(new Request("http://test/api/dashboard/timeline?days=30") as unknown as NextRequest);
    expect(missingTeam.status).toBe(422);
    expect(h.builds).toBe(0);
  });
});

describe("POST /api/brain/arcs/recompute — authority reads are inside the retryable mapping", () => {
  it("a repair pending at the first locked epoch read is the pending 503, and nothing is synthesized", async () => {
    h.authority.pending = true;
    const { status, json } = await read(await recompute());
    expect(status).toBe(503);
    expect(json).toEqual({ error: { ...PENDING, request_id: expect.any(String) } });
    expect(h.recomputes).toBe(0);
  });

  it("a repair that goes pending under readArcCache (read as a miss) is the pending 503, not a false 403", async () => {
    h.duringArcCacheRead = () => {
      h.authority.pending = true;
    };
    h.arcCache = null;
    const { status, json } = await read(await recompute());
    expect(status).toBe(503);
    expect(json).toEqual({ error: { ...PENDING, request_id: expect.any(String) } });
    expect(h.recomputes).toBe(0);
  });

  it("an epoch change under readArcCache retries, rather than refusing the correction", async () => {
    let reads = 0;
    h.duringArcCacheRead = () => {
      reads += 1;
      if (reads === 1) {
        h.authority.epoch += 1;
        h.arcCache = null;
      } else {
        h.arcCache = { arcs: [ARC] };
      }
    };
    const { status } = await read(await recompute());
    expect(status).toBe(200);
    expect(reads).toBe(2);
    expect(h.recomputes).toBe(1);
  });

  it("a correction truly outside the cached view is still a 403 when authority is unchanged", async () => {
    const { status, json } = await read(await recompute({ corrections: [{ arc_id: "arc-unseen", corrected_text: "x" }] }));
    expect(status).toBe(403);
    expect(json).toMatchObject({ error: { code: "forbidden" } });
    expect(h.recomputes).toBe(0);
  });

  it("a repair pending at the serving lock after synthesis withholds the arcs: pending 503", async () => {
    h.recompute = async () => {
      h.authority.pending = true;
      return { arcs: [ARC], freshness: computedNow() };
    };
    const { status, json, text } = await read(await recompute());
    expect(status).toBe(503);
    expect(json).toEqual({ error: { ...PENDING, request_id: expect.any(String) } });
    expect(text).not.toContain("MAPPED-PARTICIPANT");
  });

  it("a pending repair raised inside synthesis is the pending 503", async () => {
    h.recompute = async () => {
      throw new h.AttributionRepairPendingError();
    };
    const { status, json } = await read(await recompute());
    expect(status).toBe(503);
    expect(json).toEqual({ error: { ...PENDING, request_id: expect.any(String) } });
  });

  it("an unreadable authority is a fixed retryable 503 that never echoes the database error", async () => {
    h.authority.readFailure = new Error('authorization epoch read failed: relation "team_authorization_epochs" does not exist');
    const { status, json, text } = await read(await recompute());
    expect(status).toBe(503);
    expect(json).toEqual({ error: { ...ARC_UNAVAILABLE, request_id: expect.any(String) } });
    expect(text).not.toContain("team_authorization_epochs");
  });

  it("an epoch that moves on both attempts keeps its existing retryable 503", async () => {
    h.recompute = async () => {
      h.authority.epoch += 1;
      return { arcs: [ARC], freshness: computedNow() };
    };
    const { status, json, text } = await read(await recompute());
    expect(status).toBe(503);
    expect(json).toMatchObject({ error: { code: "temporarily_unavailable", message: "arc authorization changed; retry the request" } });
    expect(h.recomputes).toBe(2);
    expect(text).not.toContain("MAPPED-PARTICIPANT");
  });

  it("other statuses are unchanged: 401, 422, posture 403, enforcement 500, input-unavailable 503, success", async () => {
    h.user = null;
    expect((await recompute()).status).toBe(401);
    h.user = { id: "auth-1" };

    expect((await recompute({ sourceGroup: undefined })).status).toBe(422);

    h.tier = "external";
    expect(await read(await recompute())).toMatchObject({ status: 403, json: { error: { code: "forbidden" } } });
    h.tier = "team";

    h.enforcementFailure = true;
    const enforcement = await read(await recompute());
    expect(enforcement).toMatchObject({ status: 500, json: { error: { code: "internal", message: "enforcement check failed" } } });
    expect(enforcement.text).not.toContain("group_members");
    h.enforcementFailure = false;

    h.recompute = async () => {
      throw new h.ArcInputAuthorizationUnavailableError("x");
    };
    expect((await read(await recompute())).json).toEqual({ error: { ...ARC_UNAVAILABLE, request_id: expect.any(String) } });

    h.recompute = async () => ({ arcs: [ARC], freshness: computedNow() });
    const ok = await read(await recompute());
    expect(ok.status).toBe(200);
    expect(ok.json).toMatchObject({ arcs: [{ id: "arc-1" }] });
  });
});
