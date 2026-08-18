import { describe, expect, it } from "vitest";
import { retrieve } from "@/lib/query/retrieve";
import { db, ingest, seedTeam, memberRetrieveEnforce } from "./helpers";

// CLAUDE.md §5 invariant: an external-posture principal never reads team-only content.
// In DB_BACKEND=postgres there is NO RLS — the oracle-derived vis-set in retrieve.ts is the
// SOLE enforcement (PRET-6: the tier lens is gone; posture = builtin membership, and the
// external member's oracle admits exactly the external-shared corpus).
//
// Non-vacuity is built in: the same data IS visible to a team-posture member, so the team
// item's ABSENCE for the external member proves the filter discriminates.

describe("posture isolation in retrieve() (real Postgres, no RLS backstop)", () => {
  it("an external member's view excludes team content; a team member sees both", async () => {
    const seed = await seedTeam();
    const term = "advisory"; // present in both bodies so FTS matches both
    await ingest(seed, { path: "internal/strategy.md", body: `team-only ${term} plan`, access: "team" });
    await ingest(seed, { path: "client/brief.md", body: `client ${term} brief`, access: "external" });

    const asExternal = await retrieve(db(), seed.teamId, "external", term, null, await memberRetrieveEnforce(seed, "external"));
    const externalPaths = asExternal.sources.map((s) => s.path);
    // The crown jewel: the team item must NOT leak to an external principal.
    expect(externalPaths).toContain("client/brief.md");
    expect(externalPaths).not.toContain("internal/strategy.md");

    const asTeam = await retrieve(db(), seed.teamId, "team", term, null, await memberRetrieveEnforce(seed));
    const teamPaths = asTeam.sources.map((s) => s.path);
    // Non-vacuity: the team item really is present and retrievable for a team member.
    expect(teamPaths).toContain("internal/strategy.md");
    expect(teamPaths).toContain("client/brief.md");
  });

  it("an external member sees no team rows even via the recency path (FTS miss)", async () => {
    const seed = await seedTeam();
    // No shared search term → FTS won't match; retrieve falls back to recent items,
    // which must ALSO be membership-filtered.
    await ingest(seed, { path: "internal/secret.md", body: "quarterly board figures", access: "team" });
    await ingest(seed, { path: "client/note.md", body: "kickoff scheduling", access: "external" });

    const asExternal = await retrieve(db(), seed.teamId, "external", "zzzz-no-match", null, await memberRetrieveEnforce(seed, "external"));
    const paths = asExternal.sources.map((s) => s.path);
    expect(paths).not.toContain("internal/secret.md");
  });
});
