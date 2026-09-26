import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";

const { cached, pure } = vi.hoisted(() => ({ cached: vi.fn(), pure: vi.fn() }));
vi.mock("@/lib/db/server", () => ({ serverClient: async () => ({
  from: (table: string) => ({
    select() { return this; }, eq() { return this; },
    maybeSingle: async () => ({ data: table === "teams" ? { id: "team-1" } : { id: "member-1" } }),
  }),
}) }));
vi.mock("@/lib/db/admin", () => ({ adminClient: () => ({}) }));
vi.mock("@/lib/auth/session", () => ({ getSessionUser: async () => ({ id: "user-1" }) }));
vi.mock("@/lib/access/posture", () => ({ resolveViewerPosture: async () => "team" }));
vi.mock("@/lib/access/enforce", () => ({ memberEnforcement: async () => ({ visibleItemIds: new Set(), visibleProjectIds: new Set() }) }));
vi.mock("@/lib/dashboard/timeline-cache", () => ({ getCachedWorkTimeline: cached }));
vi.mock("@/lib/dashboard/work-timeline", () => ({
  WINDOW_DAYS: 7, MAX_WINDOW_DAYS: 30, getWorkTimeline: pure,
}));

import { GET } from "@/app/api/dashboard/timeline/route";

const req = (days?: number) => new Request(
  `http://test/api/dashboard/timeline?team=example${days ? `&days=${days}` : ""}`
) as NextRequest;

describe("dashboard timeline route Slack read failures", () => {
  beforeEach(() => { cached.mockReset(); pure.mockReset(); });

  it("propagates a strict Slack read failure from the default cached window", async () => {
    cached.mockRejectedValue(new Error("work-timeline slack items: unavailable"));
    await expect(GET(req())).rejects.toThrow("work-timeline slack items: unavailable");
    expect(pure).not.toHaveBeenCalled();
  });

  it("requires Slack reads on the expanded 8–30 day window", async () => {
    pure.mockImplementation(async (_db, _team, _tier, _days, _enforcement, requireSlackReads) => {
      if (requireSlackReads) throw new Error("work-timeline slack identities: unavailable");
      return [];
    });
    for (const days of [8, 30]) {
      await expect(GET(req(days))).rejects.toThrow("work-timeline slack identities: unavailable");
      expect(pure).toHaveBeenLastCalledWith(expect.anything(), "team-1", "team", days,
        expect.anything(), true);
    }
    expect(cached).not.toHaveBeenCalled();
  });
});
