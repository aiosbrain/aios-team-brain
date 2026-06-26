import { beforeEach, describe, expect, it } from "vitest";
import { retrieve } from "@/lib/query/retrieve";
import { db, ingest, seedTeam, type Seed } from "./helpers";

// Spec: context shaping — the git + per-person activity digests appear ONLY for activity questions,
// trimming the two heaviest always-on blocks (and their scans) when irrelevant. Verified on real PG.

let seed: Seed;

describe("context shaping — activity digests gated by query (real Postgres)", () => {
  beforeEach(async () => {
    seed = await seedTeam();
    // people-digest source: an item attributed to the seed member (a non-connector member).
    await ingest(seed, { kind: "transcript", path: "slack/eng/1.md", body: "discussion about the release", access: "team", frontmatter: { source: "slack" } });
    // git-digest source: a codebase + a contribution row for the member.
    const { data: cb } = await db().from("codebases").insert({ team_id: seed.teamId, slug: "aios" }).select("id").single();
    await db().from("code_contributions").insert({ team_id: seed.teamId, codebase_id: (cb as { id: string }).id, author_key: "t@x", author_name: "Tester", author_email: "t@x", member_id: seed.memberId, day: new Date().toISOString().slice(0, 10), commits: 4, ai_commits: 0, additions: 10, deletions: 2 });
  });

  it("includes the activity digests for a 'who is doing what' question", async () => {
    const ctx = await retrieve(db(), seed.teamId, "team", "what is everyone working on this week?");
    expect(ctx.structured).toContain("Activity by person");
    expect(ctx.structured).toContain("Git activity");
  });

  it("omits them for an unrelated question (token + scan savings)", async () => {
    const ctx = await retrieve(db(), seed.teamId, "team", "what did we decide about the database schema?");
    expect(ctx.structured).not.toContain("Activity by person");
    expect(ctx.structured).not.toContain("Git activity");
  });
});
