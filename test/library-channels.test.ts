import { describe, it, expect } from "vitest";
import {
  belongsToChannel,
  channelExactPath,
  channelFeedFilename,
  channelFeedPattern,
  parseChannel,
  groupChannels,
  freshness,
  previewLine,
} from "@/lib/library/channels";

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

  it("keeps canonical scoped paths separate by workspace and preserves exact legacy paths", () => {
    expect(parseChannel("slack/t1/c1/1718900000.000100.md")).toEqual({
      key: "slack/t1/c1", source: "slack", name: "c1",
    });
    expect(parseChannel("slack/t2/c1/1718900000.000100.md").key).toBe("slack/t2/c1");
    expect(parseChannel("slack/c1/1718900000.000100.md").key).toBe("slack/c1");
  });

  it("does not infer a Slack channel from malformed or extra path segments", () => {
    for (const path of [
      "slack/t1/c1/not-a-root.md",
      "slack/t1/c1/1718900000.000100.md/extra",
      "slack//c1/1718900000.000100.md",
      "slack/t1/c1/1718900000.000100.MD",
      "slack/T1/C1/1718900000.000100.md",
      "slack/t1",
      "/slack/t1/c1/1718900000.000100.md",
    ]) {
      expect(parseChannel(path)).toEqual({ key: `unrecognized-slack://${path}`, source: "unknown", name: path });
      expect(channelExactPath(parseChannel(path).key)).toBe(path);
    }
  });
});

describe("channel feed boundaries", () => {
  it("matches only the selected workspace or exact legacy shape", () => {
    const root = "1718900000.000100.md";
    expect(belongsToChannel(`slack/t1/c1/${root}`, "slack/t1/c1")).toBe(true);
    expect(belongsToChannel(`slack/t2/c1/${root}`, "slack/t1/c1")).toBe(false);
    expect(belongsToChannel(`slack/c1/${root}`, "slack/t1/c1")).toBe(false);
    expect(belongsToChannel(`slack/t1/c1/${root}`, "slack/t1")).toBe(false);
    expect(belongsToChannel(`slack/t1/${root}`, "slack/t1")).toBe(true);
    expect(channelFeedFilename(`slack/t1/c1/${root}`, "slack/t1/c1")).toBe(root);
    expect(channelFeedFilename(`slack/t1/${root}`, "slack/t1")).toBe(root);
  });

  it("escapes non-Slack LIKE metacharacters before adding the feed wildcard", () => {
    expect(channelFeedPattern("github/my_repo%\\archive")).toBe("github/my\\_repo\\%\\\\archive/%");
    expect(belongsToChannel("github/my_repo%\\archive/file.md", "github/my_repo%\\archive")).toBe(true);
    expect(belongsToChannel("github/myXrepo%\\archive/file.md", "github/my_repo%\\archive")).toBe(false);
  });
});

describe("groupChannels", () => {
  it("keeps same-named channels in two workspaces and a legacy row distinct", () => {
    const channels = groupChannels([
      { path: "slack/t1/c1/1718900000.000100.md", synced_at: "2026-07-03T00:00:00Z", label: "general" },
      { path: "slack/t2/c1/1718900000.000100.md", synced_at: "2026-07-02T00:00:00Z", label: "general" },
      { path: "slack/c1/1718900000.000100.md", synced_at: "2026-07-01T00:00:00Z", label: "general" },
    ]);
    expect(channels.map((channel) => channel.key)).toEqual(["slack/t1/c1", "slack/t2/c1", "slack/c1"]);
    expect(channels.map((channel) => channel.count)).toEqual([1, 1, 1]);
  });
  it("does not merge an unrecognized Slack path with a legacy key", () => {
    const channels = groupChannels([
      { path: "slack/t1", synced_at: "2026-07-03T00:00:00Z", label: "general" },
      { path: "slack/t1/1718900000.000100.md", synced_at: "2026-07-02T00:00:00Z" },
    ]);
    expect(channels.map((channel) => channel.key)).toEqual([
      "unrecognized-slack://slack/t1", "slack/t1",
    ]);
  });
  it("keeps malformed Slack rows separate from arbitrary non-Slack path prefixes", () => {
    const malformed = "slack/t1";
    const other = "unrecognized-slack:slack/t1/file.md";
    expect(parseChannel(malformed).key).not.toBe(parseChannel(other).key);
    expect(groupChannels([
      { path: malformed, synced_at: "2026-07-03T00:00:00Z" },
      { path: other, synced_at: "2026-07-02T00:00:00Z" },
    ])).toHaveLength(2);
  });
  it("counts items per channel, keeps the most-recent arrival, and sorts newest-first", () => {
    const channels = groupChannels([
      { path: "slack/eng/1718900003.000100.md", synced_at: "2026-06-25T10:00:00Z" },
      { path: "slack/eng/1718900001.000100.md", synced_at: "2026-06-25T09:00:00Z" },
      { path: "linear/aio/A-1.md", synced_at: "2026-06-25T11:00:00Z" },
      { path: "slack/eng/1718900002.000100.md", synced_at: "2026-06-25T08:00:00Z" },
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
      { path: "slack/eng/1718900003.000100.md", synced_at: new Date("2026-06-25T10:00:00Z") },
      { path: "slack/eng/1718900001.000100.md", synced_at: new Date("2026-06-25T09:00:00Z") },
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

/**
 * Slack keys its item paths on the immutable channel ID (a rename must not re-key every thread into
 * duplicate items), so `slack/c0b8v119g4d` has no readable segment. The real `#name` rides on the
 * item's `frontmatter.channel` and is passed through as `label` — otherwise the Data page would list
 * a raw Slack ID. Sources whose path segment is already readable pass no label and are unaffected.
 */
describe("groupChannels — display label", () => {
  it("shows the source's real name instead of an opaque path segment", () => {
    const [ch] = groupChannels([
      { path: "slack/c0b8v119g4d/1718900001.000100.md", synced_at: "2026-07-01T00:00:00Z", label: "all-vibrana" },
    ]);
    expect(ch.name).toBe("all-vibrana");
    expect(ch.key).toBe("slack/c0b8v119g4d"); // key stays the PATH prefix — it's the feed query
  });

  it("prefers the most recently synced name, so a rename surfaces", () => {
    const [ch] = groupChannels([
      { path: "slack/c1/1718900002.000100.md", synced_at: "2026-07-02T00:00:00Z", label: "marketing" }, // newer
      { path: "slack/c1/1718900001.000100.md", synced_at: "2026-07-01T00:00:00Z", label: "growth" }, // older
    ]);
    expect(ch.name).toBe("marketing");
    expect(ch.count).toBe(2); // one channel, not two — the rename did NOT split it
  });

  it("falls back to the path segment when no label is supplied", () => {
    const [ch] = groupChannels([{ path: "linear/aio/AIO-1.md", synced_at: "2026-07-01T00:00:00Z" }]);
    expect(ch.name).toBe("aio");
  });
});
