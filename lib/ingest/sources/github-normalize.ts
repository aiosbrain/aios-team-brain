import { createHash } from "node:crypto";
import type { ItemPayload } from "@/lib/api/schemas";
import { normalizeTaskStatus } from "@/lib/api/schemas";

/**
 * Pure: a GitHub repo's fetched issues → ONE brain `kind="task"` ItemPayload whose `rows[]`
 * diff-sync by `row_key` (`GH-<number>`).
 *
 * Mirrors lib/ingest/sources/plane-normalize.ts. GitHub is NOT a pm-sync provider, so there is no
 * round-tripper loop to de-dupe — idempotency comes from the stable row_key + the sha256 writer.
 *   • Dedicated brain project per repo (`github-<owner>-<repo>`): the task diff-delete is
 *     project-wide, so issues that vanish from the repo diff-delete within that project only.
 *   • Pull requests are excluded (the REST issues endpoint returns PRs too; a `pull_request` key
 *     marks them).
 *   • Mapping: open → backlog (or a workflow label like "in progress"/"blocked" if present),
 *     closed → done; labels carried through; milestone → sprint; assignees → assignee. GitHub
 *     classic issues have no parent, so no hierarchy. Team tier; deterministic output (sha no-op).
 */

export interface GithubIssueRaw {
  number: number;
  title?: string;
  body?: string | null;
  state?: string; // "open" | "closed"
  labels?: ({ name?: string } | string)[] | null;
  assignee?: { login?: string } | null;
  assignees?: { login?: string }[] | null;
  milestone?: { title?: string } | null;
  html_url?: string;
  pull_request?: unknown; // presence ⇒ this is a PR, not an issue
}

export interface NormalizeGithubInput {
  owner: string;
  repo: string;
  issues: GithubIssueRaw[];
}

export interface GithubTaskRow {
  row_key: string;
  title: string;
  status: string;
  labels: string[];
  assignee: string;
  sprint: string;
}

function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

function safeSegment(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
}

function labelNames(labels: GithubIssueRaw["labels"]): string[] {
  return (labels ?? [])
    .map((l) => (typeof l === "string" ? l : l?.name))
    .filter((n): n is string => Boolean(n));
}

/** closed → done; an open issue with a workflow label (in progress / blocked / ready) honors it; else backlog. */
function githubStatus(state: string | undefined, labels: string[]): string {
  if (state === "closed") return "done";
  for (const l of labels) {
    const byLabel = normalizeTaskStatus(l);
    if (byLabel.raw_status === null && byLabel.status !== "backlog") return byLabel.status;
  }
  return "backlog";
}

export function normalizeGithubRepo(input: NormalizeGithubInput): ItemPayload {
  const ownerSeg = safeSegment(input.owner) || "owner";
  const repoSeg = safeSegment(input.repo) || "repo";
  const project = `github-${ownerSeg}-${repoSeg}`;

  // Exclude PRs; stable sort so a re-import is byte-identical → a true no-op at the sha256 writer.
  const included = input.issues
    .filter((it) => !it.pull_request && typeof it.number === "number")
    .sort((a, b) => a.number - b.number);

  const rows: GithubTaskRow[] = included.map((it) => {
    const labels = labelNames(it.labels);
    const assignees = (it.assignees && it.assignees.length ? it.assignees : it.assignee ? [it.assignee] : [])
      .map((a) => a?.login)
      .filter((n): n is string => Boolean(n));
    return {
      row_key: `GH-${it.number}`,
      title: it.title?.trim() || "(untitled)",
      status: githubStatus(it.state, labels),
      labels,
      assignee: assignees.join(", "),
      sprint: it.milestone?.title ?? "",
    };
  });

  const lines = rows.map(
    (r) =>
      `| ${r.row_key} | ${r.title} | ${r.status} | ${r.sprint} | ${r.assignee} | ${JSON.stringify(r.labels)} |`
  );
  const body = `# GitHub issues — ${ownerSeg}/${repoSeg}\n\n${lines.join("\n")}\n`;

  return {
    project,
    path: `github/${ownerSeg}-${repoSeg}/issues.md`,
    kind: "task",
    content_sha256: sha256(body),
    actor: "",
    access: "team",
    frontmatter: {
      source: "github",
      repo: `${input.owner}/${input.repo}`,
      issue_count: rows.length,
    },
    body,
    rows,
  };
}
