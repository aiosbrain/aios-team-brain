import { describe, expect, it } from "vitest";
import {
  lowAttribution,
  isSignalSource,
  type SourceAttribution,
} from "@/lib/attribution/health";

/**
 * Spec for the attribution-alert logic: which sources should raise the "this stream isn't landing on a
 * person" banner. Derived from the intent — flag real-volume OUTPUT sources under threshold; never flag
 * SIGNAL sources (meetings/calendar aren't meant to be one person's output). Pure, no DB.
 */

const src = (over: Partial<SourceAttribution>): SourceAttribution => ({
  source: "x",
  isSignal: false,
  items: 100,
  human: 100,
  connector: 0,
  unattributed: 0,
  pctHuman: 100,
  ...over,
});

describe("isSignalSource", () => {
  it("classifies meeting/calendar streams as signal (not a person's output)", () => {
    expect(isSignalSource("granola")).toBe(true);
    expect(isSignalSource("Calendar")).toBe(true); // case-insensitive
    expect(isSignalSource("gmeet")).toBe(true);
    expect(isSignalSource("notion")).toBe(false);
    expect(isSignalSource("git")).toBe(false);
  });
});

describe("lowAttribution — the banner's alert list", () => {
  it("flags a real-volume output source below the human-attribution threshold", () => {
    const plane = src({ source: "plane", items: 44, human: 0, unattributed: 44, pctHuman: 0 });
    const notion = src({ source: "notion", items: 300, human: 66, unattributed: 234, pctHuman: 22 });
    const git = src({ source: "git", items: 385, human: 374, pctHuman: 97 });
    expect(lowAttribution([plane, notion, git]).map((s) => s.source)).toEqual(["plane", "notion"]);
  });

  it("never flags a SIGNAL source, even at 0% human (meetings aren't one person's output)", () => {
    const granola = src({ source: "granola", isSignal: true, items: 22, human: 0, pctHuman: 0 });
    expect(lowAttribution([granola])).toEqual([]);
  });

  it("ignores empty sources and respects a custom threshold", () => {
    const empty = src({ source: "empty", items: 0, human: 0, pctHuman: 0 });
    const mid = src({ source: "mid", items: 10, human: 6, pctHuman: 60 });
    expect(lowAttribution([empty, mid])).toEqual([]); // 60 ≥ default 50, empty skipped
    expect(lowAttribution([mid], 70).map((s) => s.source)).toEqual(["mid"]); // 60 < 70
  });
});
