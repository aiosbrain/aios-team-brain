import { describe, it, expect } from "vitest";
import { issueShapedKeys, extractIssueRefs } from "@/lib/dashboard/issue-ref";

// Spec: deterministic, HIGH-PRECISION task↔evidence linking. A token links only when it EXACTLY
// matches a real issue-shaped task row_key — so incidental tokens (utf-8, sha-256) never false-link.

describe("issueShapedKeys", () => {
  it("keeps only Linear/Plane-shaped keys, uppercased; drops ui-/meet-/slug row_keys", () => {
    const keys = issueShapedKeys(["AIO-123", "eng-45", "ui-abc123", "meet-a1b2c3-d4e5f6", "implement-login", null, ""]);
    expect(keys).toEqual(new Set(["AIO-123", "ENG-45"]));
  });
});

describe("extractIssueRefs", () => {
  const known = issueShapedKeys(["AIO-123", "AIO-124", "ENG-45"]);

  it("finds a key in a commit subject regardless of case", () => {
    expect(extractIssueRefs("feat(x): do the thing (aio-123)", known)).toEqual(["AIO-123"]);
  });

  it("finds a key in a branch-name / free text and dedupes", () => {
    expect(extractIssueRefs("merge chetan/AIO-123-fix; also see AIO-123 and ENG-45", known)).toEqual(["AIO-123", "ENG-45"]);
  });

  it("does NOT match incidental non-issue tokens (utf-8, sha-256) or unknown keys", () => {
    expect(extractIssueRefs("encoded as utf-8 with sha-256; fixes ZZZ-999", known)).toEqual([]);
  });

  it("returns [] for empty text or an empty known set", () => {
    expect(extractIssueRefs("AIO-123", new Set())).toEqual([]);
    expect(extractIssueRefs("", known)).toEqual([]);
    expect(extractIssueRefs(null, known)).toEqual([]);
  });

  it("matches multiple distinct known keys in one body", () => {
    expect(extractIssueRefs("closes AIO-123, AIO-124", known)).toEqual(["AIO-123", "AIO-124"]);
  });
});

import { computeTaskLinks } from "@/lib/dashboard/issue-ref";

// Spec: map an item → the task ids its text references, via issue-shaped row_keys (exact allowlist).
describe("computeTaskLinks", () => {
  const tasks = [
    { id: "task-aio-1", row_key: "AIO-1" },
    { id: "task-eng-9", row_key: "ENG-9" },
    { id: "task-ui", row_key: "ui-abc" }, // not issue-shaped → never a target
  ];

  it("links items to the tasks their text cites; unlinked items are absent from the map", () => {
    const items = [
      { id: "c1", text: "feat: adapter (AIO-1)" },
      { id: "c2", text: "chore: bump deps" }, // no ref
      { id: "c3", text: "closes AIO-1 and ENG-9" },
    ];
    const links = computeTaskLinks(tasks, items);
    expect(links.get("c1")).toEqual(["task-aio-1"]);
    expect(links.has("c2")).toBe(false);
    expect(links.get("c3")).toEqual(["task-aio-1", "task-eng-9"]);
  });

  it("never targets a non-issue-shaped row_key", () => {
    expect(computeTaskLinks(tasks, [{ id: "x", text: "see ui-abc" }]).has("x")).toBe(false);
  });
});
