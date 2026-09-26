import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TimelineDay } from "@/lib/dashboard/timeline-group";

const { cached } = vi.hoisted(() => ({ cached: vi.fn() }));
vi.mock("@/lib/db/admin", () => ({ adminClient: () => ({}) }));
vi.mock("@/lib/dashboard/timeline-cache", () => ({ getCachedWorkTimeline: cached }));
vi.mock("@/lib/dashboard/work-timeline", () => ({ WINDOW_DAYS: 7, MAX_WINDOW_DAYS: 30 }));
vi.mock("@/components/dashboard/timeline-days", async () => {
  const { createElement: element } = await import("react");
  return { TimelineDays: ({ days }: { days: TimelineDay[] }) =>
    element("div", null, days.map((day) => element("span", { key: day.date }, day.label))) };
});

import { TimelinePanel } from "@/components/learning/timeline-panel";

const props = { teamId: "team-1", teamSlug: "example", tier: "team" as const, memberId: "viewer-1" };
const markup = async () => renderToStaticMarkup(await TimelinePanel(props));

describe("timeline panel server/client composition", () => {
  beforeEach(() => cached.mockReset());

  it("renders initial days once under the client owner and keeps expansion available", async () => {
    cached.mockResolvedValue({ days: [{ date: "2026-09-19", label: "Recent day", people: [] }] });
    const html = await markup();
    expect(html.match(/Recent day/g)).toHaveLength(1);
    expect(html).toContain("Show earlier days");
    expect(cached).toHaveBeenCalledWith(expect.anything(), "team-1", "team", "viewer-1");
  });

  it("offers expansion when the initial window is empty", async () => {
    cached.mockResolvedValue({ days: [] });
    const html = await markup();
    expect(html).toContain("No work in the last 7 days");
    expect(html).toContain("Show earlier days");
  });
});
