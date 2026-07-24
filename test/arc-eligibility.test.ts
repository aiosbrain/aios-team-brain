import { describe, expect, it } from "vitest";
import { isArcActiveLinearState, isArcEligible, isGithubIssueBacklog } from "@/lib/graph/arc-eligibility";

/**
 * Spec: only ACTIVE Linear work (In Progress / In Review) informs narrative arcs; other states are
 * context, not narrative. Non-Linear content is never status-gated. Pure, no DB.
 */

describe("isArcActiveLinearState", () => {
  it("treats In Progress / In Review (+ Reviewing) as active", () => {
    expect(isArcActiveLinearState("In Progress")).toBe(true);
    expect(isArcActiveLinearState("In Review")).toBe(true);
    expect(isArcActiveLinearState("Reviewing")).toBe(true);
  });
  it("treats Backlog / Todo / Done / Canceled as NOT active", () => {
    for (const s of ["Backlog", "Todo", "Done", "Canceled", "Duplicate"]) {
      expect(isArcActiveLinearState(s)).toBe(false);
    }
  });
});

describe("isArcEligible", () => {
  it("gates ONLY Linear items by status; everything else is always eligible", () => {
    expect(isArcEligible("git", "whatever")).toBe(true);
    expect(isArcEligible("notion", null)).toBe(true);
    expect(isArcEligible(null, null)).toBe(true); // unknown source → eligible
  });
  it("prefers the canonical state_type ('started' = active) over the display name", () => {
    // A completed-type state NAMED "Reviewed" (name regex would keep it) is correctly dropped by type.
    expect(isArcEligible("linear", "Reviewed", "completed")).toBe(false);
    // A started-type state with an unusual name ("Doing"/"Blocked") the name regex would miss → kept.
    expect(isArcEligible("linear", "Blocked", "started")).toBe(true);
    expect(isArcEligible("linear", "In Progress", "started")).toBe(true);
    expect(isArcEligible("linear", "Backlog", "backlog")).toBe(false);
  });
  it("falls back to the state-name regex when no state_type is present (pre-migration rows)", () => {
    expect(isArcEligible("linear", "In Progress")).toBe(true);
    expect(isArcEligible("linear", "In Review", "")).toBe(true);
    expect(isArcEligible("linear", "Backlog")).toBe(false);
    expect(isArcEligible("linear", null)).toBe(false); // Linear + no type + no state → not active
    expect(isArcEligible("LINEAR", "Backlog")).toBe(false); // source case-insensitive
  });
});

/**
 * Spec: the GitHub issues-backlog aggregate (`github/<repo>/issues.md`, one connector-owned kind=task
 * doc) is author-less machine context, not narrative — excluded from arcs (the "no person assigned" arc).
 */
describe("isGithubIssueBacklog", () => {
  it("matches the connector issues.md aggregate (github + task + issues.md path)", () => {
    expect(isGithubIssueBacklog("github", "task", "github/aiosbrain-aios-team-brain/issues.md")).toBe(true);
    expect(isGithubIssueBacklog("GitHub", "task", "github/acme-repo/ISSUES.MD")).toBe(true); // case-insensitive
  });
  it("leaves other GitHub content alone (repo-file deliverables, commit artifacts, other tasks)", () => {
    expect(isGithubIssueBacklog("github", "deliverable", "github/acme/readme.md")).toBe(false); // repo file
    expect(isGithubIssueBacklog("git", "artifact", "commits/abc.md")).toBe(false); // commit
    expect(isGithubIssueBacklog("github", "task", "github/acme/roadmap.md")).toBe(false); // not the issues digest
    expect(isGithubIssueBacklog("linear", "task", "issues.md")).toBe(false); // not github
    expect(isGithubIssueBacklog(null, null, null)).toBe(false);
  });
});
