import { describe, it, expect } from "vitest";
import { normalizeGithubRepo, type NormalizeGithubInput } from "@/lib/ingest/sources/github-normalize";
import { itemPayloadSchema, taskRowSchema } from "@/lib/api/schemas";

// Spec (GitHub inbound import): a repo's issues → ONE kind="task" ItemPayload, rows keyed GH-<number>.
// PRs excluded; open→backlog (or a workflow label), closed→done; milestone→sprint; assignees→assignee.

const base: NormalizeGithubInput = { owner: "AIOS-alpha", repo: "aios-team-brain", issues: [] };

describe("normalizeGithubRepo", () => {
  it("maps issues to one valid kind=task ItemPayload in a dedicated repo project", () => {
    const p = normalizeGithubRepo({
      ...base,
      issues: [
        {
          number: 42,
          title: "Fix the bug",
          state: "open",
          labels: [{ name: "bug" }, "api"],
          assignees: [{ login: "alex" }, { login: "riley" }],
          milestone: { title: "v1.0" },
        },
      ],
    });
    expect(() => itemPayloadSchema.parse(p)).not.toThrow();
    expect(p.kind).toBe("task");
    expect(p.project).toBe("github-aios-alpha-aios-team-brain");
    expect(p.path).toBe("github/aios-alpha-aios-team-brain/issues.md");
    expect(p.rows).toHaveLength(1);

    const row = p.rows![0] as Record<string, unknown>;
    expect(() => taskRowSchema.parse(row)).not.toThrow();
    expect(row.row_key).toBe("GH-42");
    expect(row.title).toBe("Fix the bug");
    expect(row.status).toBe("backlog"); // open, no workflow label
    expect(row.labels).toEqual(["bug", "api"]);
    expect(row.assignee).toBe("alex, riley");
    expect(row.sprint).toBe("v1.0"); // milestone → sprint
  });

  it("excludes pull requests (items carrying a pull_request field)", () => {
    const p = normalizeGithubRepo({
      ...base,
      issues: [
        { number: 1, title: "Real issue", state: "open" },
        { number: 2, title: "A PR", state: "open", pull_request: { url: "https://..." } },
      ],
    });
    const keys = (p.rows as Record<string, unknown>[]).map((r) => r.row_key);
    expect(keys).toEqual(["GH-1"]);
  });

  it("maps state and workflow labels: closed→done, open+in-progress label→in_progress", () => {
    const p = normalizeGithubRepo({
      ...base,
      issues: [
        { number: 1, title: "Closed", state: "closed" },
        { number: 2, title: "Working", state: "open", labels: [{ name: "In Progress" }] },
        { number: 3, title: "Stuck", state: "open", labels: ["blocked"] },
      ],
    });
    const byKey = Object.fromEntries((p.rows as Record<string, unknown>[]).map((r) => [r.row_key, r]));
    expect(byKey["GH-1"].status).toBe("done");
    expect(byKey["GH-2"].status).toBe("in_progress");
    expect(byKey["GH-3"].status).toBe("blocked");
  });

  it("serializes projectable fields so a changed field shifts content_sha256", () => {
    const mk = (state: string) =>
      normalizeGithubRepo({ ...base, issues: [{ number: 1, title: "T", state }] });
    expect(mk("open").content_sha256).not.toBe(mk("closed").content_sha256);
  });
});
