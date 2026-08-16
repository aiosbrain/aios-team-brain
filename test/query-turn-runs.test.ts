import { describe, it, expect } from "vitest";
import {
  isRunStale,
  effectiveRunStatus,
  RUN_STALE_AFTER_MS,
  STALE_RUN_MESSAGE,
} from "@/lib/query/turn-runs";

// Spec: docs/design/query-background-stream.md — acceptance criterion 3 (R4: a turn killed by a deploy
// must read as FAILED on return, never an eternal spinner).

const at = (iso: string) => ({ updated_at: iso });
const NOW = new Date("2026-08-16T12:00:00.000Z");
const ago = (ms: number) => new Date(NOW.getTime() - ms).toISOString();

describe("isRunStale — the eternal-spinner guard", () => {
  it("is FALSE for a streaming run that heartbeat recently", () => {
    expect(isRunStale({ status: "streaming", ...at(ago(5_000)) }, NOW)).toBe(false);
    expect(isRunStale({ status: "streaming", ...at(ago(RUN_STALE_AFTER_MS - 1_000)) }, NOW)).toBe(false);
  });

  it("is TRUE for a streaming run whose heartbeat stopped (process died / deploy restart)", () => {
    expect(isRunStale({ status: "streaming", ...at(ago(RUN_STALE_AFTER_MS + 1_000)) }, NOW)).toBe(true);
    expect(isRunStale({ status: "streaming", ...at(ago(6 * 60_000)) }, NOW)).toBe(true);
  });

  it("is FALSE for any SETTLED run no matter how old — a finished answer must not rot into a failure", () => {
    expect(isRunStale({ status: "done", ...at(ago(10 * 365 * 24 * 3600_000)) }, NOW)).toBe(false);
    expect(isRunStale({ status: "error", ...at(ago(10 * 365 * 24 * 3600_000)) }, NOW)).toBe(false);
  });

  it("treats an UNPARSEABLE timestamp as stale, not as fresh", () => {
    // NaN comparisons are always false, so a naive implementation would call this fresh forever —
    // which is precisely the stuck-spinner state this function exists to end.
    expect(isRunStale({ status: "streaming", updated_at: "not-a-date" }, NOW)).toBe(true);
  });

  it("honours an injected threshold", () => {
    expect(isRunStale({ status: "streaming", ...at(ago(2_000)) }, NOW, 1_000)).toBe(true);
    expect(isRunStale({ status: "streaming", ...at(ago(2_000)) }, NOW, 10_000)).toBe(false);
  });
});

describe("effectiveRunStatus — one rule every surface reads", () => {
  it("reports a stale streaming run as error, and a live one as streaming", () => {
    expect(effectiveRunStatus({ status: "streaming", ...at(ago(1_000)) }, NOW)).toBe("streaming");
    expect(effectiveRunStatus({ status: "streaming", ...at(ago(RUN_STALE_AFTER_MS + 1)) }, NOW)).toBe("error");
  });

  it("passes settled statuses through unchanged", () => {
    expect(effectiveRunStatus({ status: "done", ...at(ago(9e8)) }, NOW)).toBe("done");
    expect(effectiveRunStatus({ status: "error", ...at(ago(9e8)) }, NOW)).toBe("error");
  });

  it("has a message for the interrupted case that does not leak internals", () => {
    expect(STALE_RUN_MESSAGE).toMatch(/interrupted|restart/i);
    expect(STALE_RUN_MESSAGE).not.toMatch(/http|api|model|url|token/i);
  });
});
