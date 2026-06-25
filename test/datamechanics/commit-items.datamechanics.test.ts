import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { buildIdentityMap } from "@/lib/identity/resolve";
import { projectCommitsToItems, type ScanCommit } from "@/lib/codebases/commits-to-items";
import { retrieve } from "@/lib/query/retrieve";
import { db, seedTeam } from "./helpers";

// Spec: commits become searchable, person-attributed items — so "John's git history" returns real
// commit messages, attributed to the AUTHOR (not the scanner connector). Verified on real Postgres.

async function addMember(teamId: string, email: string): Promise<string> {
  const { data, error } = await db()
    .from("members")
    .insert({ team_id: teamId, email, display_name: "Scanner Bot", actor_handle: `bot-${randomUUID().slice(0, 8)}`, role: "member", tier: "team", status: "active" })
    .select("id")
    .single();
  if (error || !data) throw new Error(`addMember failed: ${error?.message}`);
  return (data as { id: string }).id;
}

describe("commits → searchable, attributed items (real Postgres)", () => {
  it("attributes a commit to the resolved author (not the ingesting actor) and makes it searchable", async () => {
    const seed = await seedTeam(); // member A — the author
    const scannerId = await addMember(seed.teamId, `scanner-${randomUUID()}@test.local`); // member B — the connector actor
    // Map a git-author email to member A via the alias table.
    await db().from("member_emails").insert({ team_id: seed.teamId, member_id: seed.memberId, email: "alice@corp.com" });

    const commits: ScanCommit[] = [
      { sha: "a".repeat(40), author: "Alice <alice@corp.com>", message: "Fix the login redirect bug", committed_at: "2026-06-20T10:00:00Z", ai: false, additions: 12, deletions: 3 },
      { sha: "b".repeat(40), author: "Nobody Known", message: "tweak readme", committed_at: "2026-06-21T10:00:00Z", ai: false, additions: 1, deletions: 1 },
    ];

    const map = await buildIdentityMap(db(), seed.teamId);
    const n = await projectCommitsToItems(
      db(),
      { teamId: seed.teamId, memberId: scannerId, apiKeyId: randomUUID() }, // ingesting actor = scanner B
      "aios-team-brain",
      commits,
      map
    );
    expect(n).toBe(2);

    // The resolved commit is attributed to the AUTHOR (member A), not the scanner (member B).
    const { data: resolved } = await db().from("items").select("member_id, kind, frontmatter").eq("team_id", seed.teamId).eq("path", `commits/aios-team-brain/${"a".repeat(40)}.md`).single();
    expect((resolved as { member_id: string }).member_id).toBe(seed.memberId);
    expect((resolved as { kind: string }).kind).toBe("artifact");
    expect((resolved as { frontmatter: Record<string, unknown> }).frontmatter.source).toBe("git");

    // The unresolved commit falls back to the ingesting actor (member B).
    const { data: unresolved } = await db().from("items").select("member_id").eq("team_id", seed.teamId).eq("path", `commits/aios-team-brain/${"b".repeat(40)}.md`).single();
    expect((unresolved as { member_id: string }).member_id).toBe(scannerId);

    // Searchable: an NL query for the commit message surfaces it via FTS.
    const ctx = await retrieve(db(), seed.teamId, "team", "login redirect bug");
    expect(ctx.sources.some((s) => s.text.includes("Fix the login redirect bug"))).toBe(true);
  });

  it("is idempotent: re-projecting the same commits adds no new items", async () => {
    const seed = await seedTeam();
    const commits: ScanCommit[] = [{ sha: "c".repeat(40), author: "Dev", message: "initial", committed_at: "2026-06-22T10:00:00Z", additions: 5, deletions: 0 }];
    const map = await buildIdentityMap(db(), seed.teamId);
    const auth = { teamId: seed.teamId, memberId: seed.memberId, apiKeyId: randomUUID() };

    await projectCommitsToItems(db(), auth, "repo", commits, map);
    await projectCommitsToItems(db(), auth, "repo", commits, map); // second run

    const { data } = await db().from("items").select("id").eq("team_id", seed.teamId).eq("path", `commits/repo/${"c".repeat(40)}.md`);
    expect((data ?? []).length).toBe(1); // exactly one item, not duplicated
  });
});
