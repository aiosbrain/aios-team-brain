import { describe, it, expect } from "vitest";
import { parseChannel, groupChannels, freshness, previewLine } from "@/lib/library/channels";

// Spec (Data page channel inspector): a "channel" is the source stream derived from an item's path
// prefix; channels carry counts + most-recent arrival (the freshness signal) and sort newest-first.

describe("parseChannel", () => {
  it("derives source + channel from the first two path segments", () => {
    expect(parseChannel("slack/eng/1718900000.000100.md")).toEqual({ key: "slack/eng", source: "slack", name: "eng" });
    expect(parseChannel("linear/aio/AIO-73.md")).toEqual({ key: "linear/aio", source: "linear", name: "aio" });
    // nested github file path still collapses to the repo channel
    expect(parseChannel("github/acme-app/docs/guide.md")).toEqual({ key: "github/acme-app", source: "github", name: "acme-app" });
  });

  it("falls back to a single segment when the path has no channel part", () => {
    expect(parseChannel("orphan.md")).toEqual({ key: "orphan.md", source: "orphan.md", name: "orphan.md" });
  });
});

describe("groupChannels", () => {
  it("counts items per channel, keeps the most-recent arrival, and sorts newest-first", () => {
    const channels = groupChannels([
      { path: "slack/eng/3.md", synced_at: "2026-06-25T10:00:00Z" },
      { path: "slack/eng/1.md", synced_at: "2026-06-25T09:00:00Z" },
      { path: "linear/aio/A-1.md", synced_at: "2026-06-25T11:00:00Z" },
      { path: "slack/eng/2.md", synced_at: "2026-06-25T08:00:00Z" },
    ]);
    expect(channels.map((c) => c.key)).toEqual(["linear/aio", "slack/eng"]); // linear is more recent → first
    const eng = channels.find((c) => c.key === "slack/eng")!;
    expect(eng.count).toBe(3);
    expect(eng.lastSyncedAt).toBe("2026-06-25T10:00:00Z"); // max, not first-seen
  });

  // Regression for the prod crash "b.lastSyncedAt.localeCompare is not a function": the pg adapter
  // returns `synced_at` as a Date, not an ISO string (the #134 gotcha) — the whole Data page 500'd
  // whenever ≥2 channels existed. groupChannels must accept both and normalize.
  it("accepts Date-typed synced_at (the pg adapter's real shape) without crashing", () => {
    const channels = groupChannels([
      { path: "slack/eng/3.md", synced_at: new Date("2026-06-25T10:00:00Z") },
      { path: "slack/eng/1.md", synced_at: new Date("2026-06-25T09:00:00Z") },
      { path: "linear/aio/A-1.md", synced_at: new Date("2026-06-25T11:00:00Z") },
    ]);
    expect(channels.map((c) => c.key)).toEqual(["linear/aio", "slack/eng"]);
    const eng = channels.find((c) => c.key === "slack/eng")!;
    expect(eng.lastSyncedAt).toBe("2026-06-25T10:00:00.000Z"); // normalized to ISO string for the UI
  });
});

describe("freshness", () => {
  const now = new Date("2026-06-25T12:00:00Z").getTime();
  it("classifies by age: <24h fresh, <7d recent, else stale", () => {
    expect(freshness("2026-06-25T11:00:00Z", now)).toBe("fresh");
    expect(freshness("2026-06-22T12:00:00Z", now)).toBe("recent"); // 3 days
    expect(freshness("2026-06-10T12:00:00Z", now)).toBe("stale"); // 15 days
  });
});

describe("previewLine", () => {
  it("returns the first meaningful line with the markdown heading stripped", () => {
    expect(previewLine("# ENG-42: Ship it\n\nthe body")).toBe("ENG-42: Ship it");
    expect(previewLine("\n\n   \nhello there")).toBe("hello there");
    expect(previewLine("")).toBe("");
  });

  it("truncates long lines with an ellipsis", () => {
    const long = "x".repeat(200);
    const out = previewLine(long, 50);
    expect(out.endsWith("…")).toBe(true);
    expect(out.length).toBeLessThanOrEqual(51);
  });
});
