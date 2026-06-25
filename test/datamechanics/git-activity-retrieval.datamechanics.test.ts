import { describe, expect, it } from "vitest";
import { retrieve } from "@/lib/query/retrieve";
import { db, seedTeam } from "./helpers";

// Spec: a teammate asking "what is each person doing in git" must get a real, per-contributor
// answer. Git commit data lives in code_contributions (resolved to member_id at scan time) but the
// query pipeline never read it — so this was RED before the fix. Verified on real Postgres.

const today = new Date().toISOString().slice(0, 10);
const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);

async function insertCodebase(teamId: string, slug: string): Promise<string> {
  const { data, error } = await db().from("codebases").insert({ team_id: teamId, slug }).select("id").single();
  if (error || !data) throw new Error(`codebase insert failed: ${error?.message}`);
  return (data as { id: string }).id;
}

describe("git activity in NL retrieval (real Postgres)", () => {
  it("surfaces a per-contributor git digest on the team tier (aggregated across days)", async () => {
    const seed = await seedTeam(); // member display_name = "Tester"
    const cbId = await insertCodebase(seed.teamId, "aios-team-brain");
    await db().from("code_contributions").insert([
      // resolved member, two days → must aggregate to 8 commits
      { team_id: seed.teamId, codebase_id: cbId, author_key: "tester@x", author_name: "Tester", author_email: "tester@x", member_id: seed.memberId, day: today, commits: 5, ai_commits: 2, additions: 300, deletions: 100 },
      { team_id: seed.teamId, codebase_id: cbId, author_key: "tester@x", author_name: "Tester", author_email: "tester@x", member_id: seed.memberId, day: yesterday, commits: 3, ai_commits: 0, additions: 50, deletions: 10 },
      // unresolved external author → still attributed, by name
      { team_id: seed.teamId, codebase_id: cbId, author_key: "jane@ext", author_name: "Jane Ext", author_email: "jane@ext", member_id: null, day: today, commits: 2, ai_commits: 0, additions: 20, deletions: 5 },
    ]);

    const ctx = await retrieve(db(), seed.teamId, "team", "what is everyone doing in git?");
    expect(ctx.structured).toContain("## Git activity");
    expect(ctx.structured).toContain("Tester");
    expect(ctx.structured).toContain("8 commits"); // 5 + 3 aggregated for the member
    expect(ctx.structured).toContain("aios-team-brain"); // codebase attributed
    expect(ctx.structured).toContain("Jane Ext"); // unresolved author still surfaced by name
  });

  it("hides git activity from an external-tier viewer (internal code activity)", async () => {
    const seed = await seedTeam();
    const cbId = await insertCodebase(seed.teamId, "secret-repo");
    await db().from("code_contributions").insert({ team_id: seed.teamId, codebase_id: cbId, author_key: "tester@x", author_name: "Tester", author_email: "tester@x", member_id: seed.memberId, day: today, commits: 9, ai_commits: 0, additions: 1, deletions: 1 });

    const ext = await retrieve(db(), seed.teamId, "external", "what is everyone doing in git?");
    expect(ext.structured).not.toContain("Git activity");
    expect(ext.structured).not.toContain("secret-repo");
  });
});
