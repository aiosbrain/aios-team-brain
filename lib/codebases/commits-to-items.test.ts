import { describe, expect, it } from "vitest";
import { normalizeCommit, parseAuthorIdentity } from "@/lib/codebases/commits-to-items";

describe("normalizeCommit", () => {
  it("maps a scan commit to a searchable artifact item with git provenance", () => {
    const p = normalizeCommit("aios-team-brain", {
      sha: "abc1234567deadbeef",
      author: "Alice <alice@corp.com>",
      message: "Fix the login redirect bug",
      committed_at: "2026-06-20T10:00:00Z",
      ai: true,
      additions: 12,
      deletions: 3,
    });
    expect(p).not.toBeNull();
    expect(p!.kind).toBe("artifact");
    expect(p!.project).toBe("commits");
    expect(p!.path).toBe("commits/aios-team-brain/abc1234567deadbeef.md");
    expect(p!.access).toBe("team");
    expect(p!.actor).toBe("Alice <alice@corp.com>");
    expect(p!.body).toContain("Fix the login redirect bug"); // message is searchable
    expect(p!.body).toContain("AI-assisted");
    expect(p!.frontmatter).toMatchObject({ source: "git", type: "commit", sha: "abc1234567deadbeef" });
  });

  it("returns null for a commit with no sha (no stable identity)", () => {
    expect(normalizeCommit("repo", { author: "x", message: "y" })).toBeNull();
  });
});

describe("parseAuthorIdentity", () => {
  it("splits 'Name <email>'", () => {
    expect(parseAuthorIdentity("Alice <alice@corp.com>")).toMatchObject({ name: "Alice", email: "alice@corp.com" });
  });
  it("treats a bare email as the email", () => {
    expect(parseAuthorIdentity("bob@x.com")).toMatchObject({ email: "bob@x.com" });
  });
  it("leaves a bare name without an email", () => {
    expect(parseAuthorIdentity("Carol")).toMatchObject({ name: "Carol", email: undefined });
  });
});
