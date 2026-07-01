import { describe, expect, it } from "vitest";
import { relativeAge, isStale } from "@/lib/ingest/runs-format";

// Spec: the runs panel must read at a glance ("2h ago") and surface staleness (the signal that would
// have caught the silent scan-on-merge breakage). Pure + clock-injected, no DB.

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

describe("relativeAge", () => {
  const now = 1_000 * DAY; // arbitrary fixed "now"
  it("collapses sub-45s to 'just now'", () => {
    expect(relativeAge(now - 10_000, now)).toBe("just now");
    expect(relativeAge(now, now)).toBe("just now");
  });
  it("renders minutes, hours, and days (floored)", () => {
    expect(relativeAge(now - 5 * MIN, now)).toBe("5m ago");
    expect(relativeAge(now - 3 * HOUR, now)).toBe("3h ago");
    expect(relativeAge(now - 6 * DAY, now)).toBe("6d ago");
  });
  it("switches to days past 48h", () => {
    expect(relativeAge(now - 47 * HOUR, now)).toBe("47h ago");
    expect(relativeAge(now - 49 * HOUR, now)).toBe("2d ago");
  });
  it("never returns a negative age", () => {
    expect(relativeAge(now + 5 * MIN, now)).toBe("just now");
  });
});

describe("isStale", () => {
  const now = 1_000 * DAY;
  it("flags a source that never succeeded", () => {
    expect(isStale(null, now, 24)).toBe(true);
  });
  it("flags a last-success older than the window", () => {
    expect(isStale(now - 6 * DAY, now, 24)).toBe(true);
  });
  it("is fresh within the window", () => {
    expect(isStale(now - 2 * HOUR, now, 24)).toBe(false);
  });
});
