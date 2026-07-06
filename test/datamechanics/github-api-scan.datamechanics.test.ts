import { afterEach, describe, expect, it, vi } from "vitest";
import { db, seedTeam } from "./helpers";
import { ingestGithubApiScan } from "@/lib/codebases/github-api-scan";

// Spec (GitHub-API contribution sync) verified to the observable outcome — rows read back from
// real Postgres. Proves: (1) per-(author, day) contributions land in code_contributions and are
// attributed to the roster member via their git-author email alias ("against my name"); (2) an
// external author stays unattributed; (3) a repo the CLI scanner already owns is left untouched.

const REPO_META = {
  full_name: "acme/app",
  default_branch: "main",
  description: "the app",
  language: "TypeScript",
  stargazers_count: 3,
  forks_count: 1,
  open_issues_count: 4,
  archived: false,
};

// 2 commits by the member (one AI-assisted) on Jul 1; 1 by an external author on Jul 2.
const COMMITS = [
  { sha: "a1", commit: { author: { name: "Chetan", email: "chetan@acme.com", date: "2026-07-01T09:00:00Z" }, message: "feat: a" } },
  { sha: "a2", commit: { author: { name: "Chetan", email: "chetan@acme.com", date: "2026-07-01T20:00:00Z" }, message: "fix: b\n\nCo-Authored-By: Claude Opus" } },
  { sha: "a3", commit: { author: { name: "Outsider", email: "outsider@gmail.com", date: "2026-07-02T10:00:00Z" }, message: "docs" } },
];

function stubGithub(commits: unknown[] = COMMITS): ReturnType<typeof vi.fn> {
  const impl = vi.fn(async (url: string) => {
    const u = String(url);
    if (u.includes("/languages")) return Response.json({ TypeScript: 5000 });
    if (u.includes("/commits")) return Response.json(commits);
    if (u.includes("/repos/acme/app")) return Response.json(REPO_META);
    return Response.json({}, { status: 404 });
  });
  vi.stubGlobal("fetch", impl);
  return impl;
}

/** Give the seeded member a known git-author alias so email attribution can match. */
async function aliasMember(teamId: string, memberId: string, email: string): Promise<void> {
  const { error } = await db().from("member_emails").insert({ team_id: teamId, email, member_id: memberId });
  if (error) throw new Error(`alias insert failed: ${error.message}`);
}

const contributions = async (teamId: string) => {
  const { data } = await db()
    .from("code_contributions")
    .select("author_key, author_email, member_id, day, commits, ai_commits")
    .eq("team_id", teamId);
  return (data ?? []) as {
    author_key: string;
    author_email: string;
    member_id: string | null;
    day: string | Date;
    commits: number;
    ai_commits: number;
  }[];
};

// pg returns a `date` column as a Date at LOCAL midnight — use local components (not toISOString,
// which would shift the day in a non-UTC tz). Mirrors lib/metrics/codebases.ts dayStr.
const dayStr = (v: string | Date) =>
  typeof v === "string"
    ? v.slice(0, 10)
    : `${v.getFullYear()}-${String(v.getMonth() + 1).padStart(2, "0")}-${String(v.getDate()).padStart(2, "0")}`;

afterEach(() => vi.unstubAllGlobals());

describe("GitHub-API contribution sync (data-mechanics)", () => {
  it("attributes per-day contributions to the member via their email alias", async () => {
    const seed = await seedTeam();
    await aliasMember(seed.teamId, seed.memberId, "chetan@acme.com");
    stubGithub();

    const res = await ingestGithubApiScan(
      db(),
      { teamId: seed.teamId, memberId: seed.memberId },
      { owner: "acme", repo: "app", slug: "app", token: "t" }
    );
    expect(res.skipped).toBeUndefined();
    expect(res.contributions).toBe(2); // (chetan, Jul-1) + (outsider, Jul-2)

    const rows = await contributions(seed.teamId);
    const mine = rows.find((r) => r.author_key === "chetan@acme.com" && dayStr(r.day) === "2026-07-01");
    expect(mine).toMatchObject({ commits: 2, ai_commits: 1, member_id: seed.memberId });

    const theirs = rows.find((r) => r.author_key === "outsider@gmail.com");
    expect(theirs).toMatchObject({ commits: 1, member_id: null }); // external → unattributed
  });

  it("creates the codebase row without claiming a scan (last_scan_at stays null)", async () => {
    const seed = await seedTeam();
    stubGithub();
    await ingestGithubApiScan(db(), { teamId: seed.teamId, memberId: seed.memberId }, { owner: "acme", repo: "app", slug: "app", token: "t" });

    const { data } = await db().from("codebases").select("slug, full_name, stars, last_scan_at").eq("team_id", seed.teamId).maybeSingle();
    expect(data).toMatchObject({ slug: "app", full_name: "acme/app", stars: 3 });
    expect((data as { last_scan_at: string | null }).last_scan_at).toBeNull();
  });

  it("leaves a repo the CLI scanner already owns untouched (no clobber)", async () => {
    const seed = await seedTeam();
    await aliasMember(seed.teamId, seed.memberId, "chetan@acme.com");
    stubGithub();

    // First sync creates the codebase + contributions.
    const first = await ingestGithubApiScan(db(), { teamId: seed.teamId, memberId: seed.memberId }, { owner: "acme", repo: "app", slug: "app", token: "t" });
    const codebaseId = first.codebase_id!;

    // Simulate a real scan landing (a code_metrics row makes the repo "scanner-owned").
    await db().from("code_metrics").insert({ team_id: seed.teamId, codebase_id: codebaseId, head_sha: "deadbeef" });

    // A subsequent sync must no-op and not rewrite contributions.
    const before = await contributions(seed.teamId);
    const second = await ingestGithubApiScan(db(), { teamId: seed.teamId, memberId: seed.memberId }, { owner: "acme", repo: "app", slug: "app", token: "t" });
    expect(second.skipped).toBe("scanner-owned");
    expect(second.contributions).toBe(0);

    const after = await contributions(seed.teamId);
    expect(after).toHaveLength(before.length); // untouched
  });
});
