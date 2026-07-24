import { describe, expect, it } from "vitest";
import { resolveWorkEventTask, isIssueShapedKey, type TaskCandidate } from "@/lib/work-events/resolve-task";

/**
 * Spec for the work-event → task resolution rule. THE BUG: the lookup was scoped to the PUSHED project, but
 * Linear-mirrored tasks live in `linear-<teamKey>` — so a PR citing AIO-494 could never find its task.
 * The fix widens it TEAM-WIDE but the fallback is LINK-ONLY (`linked`), never `applied`, so it can't
 * complete a task or write back to Linear. Pure, no DB.
 */

const PUSHED = "proj-repo";
const t = (id: string, project_id: string, projectSlug: string | null = null): TaskCandidate => ({ id, project_id, projectSlug });

describe("isIssueShapedKey", () => {
  it("accepts issue keys and rejects the extractor's junk", () => {
    expect(isIssueShapedKey("AIO-494")).toBe(true);
    expect(isIssueShapedKey("GH-12")).toBe(true);
    expect(isIssueShapedKey("V1")).toBe(false); // junk the regex emits
    expect(isIssueShapedKey("unresolved:abc123")).toBe(false);
    expect(isIssueShapedKey("some-slug-key")).toBe(false);
  });
});

describe("resolveWorkEventTask", () => {
  it("a PUSHED-project hit stays `applied` (unchanged legacy behavior: completes + projects)", () => {
    expect(resolveWorkEventTask("AIO-1", [t("task-a", PUSHED)], PUSHED)).toEqual({ status: "applied", taskId: "task-a" });
  });

  it("THE FIX: a task in ANOTHER project resolves — but LINK-ONLY, never `applied`", () => {
    // The AIO-494 case: the task lives in `linear-aio`, the PR was pushed with the repo's project.
    const out = resolveWorkEventTask("AIO-494", [t("task-mirror", "proj-linear-aio", "linear-aio")], PUSHED);
    expect(out).toEqual({ status: "linked", taskId: "task-mirror" });
    // The blast-radius guarantee: `linked` must never be `applied` (which would complete + write back).
    expect(out.status).not.toBe("applied");
  });

  it("does NOT use the team-wide fallback for a junk key (project scope was protecting precision)", () => {
    // `V1` must not match some unrelated slug row_key in another project.
    expect(resolveWorkEventTask("V1", [t("task-x", "proj-other", "other")], PUSHED)).toMatchObject({ status: "unresolved" });
  });

  it("prefers the canonical linear-<prefix> mirror when a key is ambiguous across projects", () => {
    const out = resolveWorkEventTask(
      "AIO-7",
      [t("task-other", "proj-other", "aios-team-brain"), t("task-mirror", "proj-mirror", "linear-aio")],
      PUSHED
    );
    expect(out).toEqual({ status: "linked", taskId: "task-mirror" });
  });

  it("DROPS a still-ambiguous key (never guesses)", () => {
    const out = resolveWorkEventTask(
      "AIO-8",
      [t("a", "p1", "alpha"), t("b", "p2", "beta")], // neither is the canonical mirror
      PUSHED
    );
    expect(out).toMatchObject({ status: "unresolved", taskId: null });
    expect((out as { error: string }).error).toMatch(/ambiguous/);
  });

  it("no candidates → unresolved", () => {
    expect(resolveWorkEventTask("AIO-9", [], PUSHED)).toMatchObject({ status: "unresolved", taskId: null });
  });

  it("with no pushed project (unknown slug), an issue-shaped single match still links", () => {
    expect(resolveWorkEventTask("AIO-10", [t("task-a", "p1", "linear-aio")], null)).toEqual({
      status: "linked",
      taskId: "task-a",
    });
  });
});
