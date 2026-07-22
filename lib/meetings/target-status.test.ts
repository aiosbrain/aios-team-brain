import { describe, expect, it } from "vitest";
import {
  MEETING_TASK_STATUSES,
  MEETING_CATEGORY_LABEL,
  DEFAULT_MEETING_TASK_STATUS,
  normalizeMeetingTaskStatus,
} from "./target-status";

/**
 * Spec: the meeting-task target status is one of a fixed set (each maps to a PM "category"), every
 * option has a label, and anything unknown/legacy coerces to the default rather than persisting junk.
 */

describe("meeting task target status", () => {
  it("defaults to backlog and labels every status", () => {
    expect(DEFAULT_MEETING_TASK_STATUS).toBe("backlog");
    for (const s of MEETING_TASK_STATUSES) expect(MEETING_CATEGORY_LABEL[s]).toBeTruthy();
    expect(MEETING_CATEGORY_LABEL.in_progress).toBe("In Progress");
  });

  it("normalizes valid values through and coerces invalid/empty to the default", () => {
    expect(normalizeMeetingTaskStatus("in_progress")).toBe("in_progress");
    expect(normalizeMeetingTaskStatus("done")).toBe("done");
    for (const bad of ["blocked", "", null, undefined, "started", 42]) {
      expect(normalizeMeetingTaskStatus(bad)).toBe("backlog");
    }
  });
});
