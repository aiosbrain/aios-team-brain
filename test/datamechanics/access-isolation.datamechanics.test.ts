import { describe, expect, it } from "vitest";
import { retrieve } from "@/lib/query/retrieve";
import { db, ingest, seedTeam } from "./helpers";

// CLAUDE.md §5 invariant: an `external`-tier principal never reads `team` content.
// In DB_BACKEND=postgres there is NO RLS — this app-code filter in retrieve.ts is the
// SOLE enforcement. Spec-first + verified to the observable outcome (the rows returned).
//
// Non-vacuity is built in: the same data IS visible at `team` tier, so the team item's
// ABSENCE at `external` tier proves the filter discriminates (not that data is missing).

describe("tier isolation in retrieve() (real Postgres, no RLS backstop)", () => {
  it("external tier excludes team content; team tier sees both", async () => {
    const seed = await seedTeam();
    const term = "advisory"; // present in both bodies so FTS matches both
    await ingest(seed, { path: "internal/strategy.md", body: `team-only ${term} plan`, access: "team" });
    await ingest(seed, { path: "client/brief.md", body: `client ${term} brief`, access: "external" });

    const asExternal = await retrieve(db(), seed.teamId, "external", term);
    const externalPaths = asExternal.sources.map((s) => s.path);
    // The crown jewel: the team item must NOT leak to an external principal.
    expect(externalPaths).toContain("client/brief.md");
    expect(externalPaths).not.toContain("internal/strategy.md");

    const asTeam = await retrieve(db(), seed.teamId, "team", term);
    const teamPaths = asTeam.sources.map((s) => s.path);
    // Non-vacuity: the team item really is present and retrievable at team tier.
    expect(teamPaths).toContain("internal/strategy.md");
    expect(teamPaths).toContain("client/brief.md");
  });

  it("external tier sees no team rows even via the recency path (FTS miss)", async () => {
    const seed = await seedTeam();
    // No shared search term → FTS won't match; retrieve falls back to recent items,
    // which must ALSO be tier-filtered.
    await ingest(seed, { path: "internal/secret.md", body: "quarterly board figures", access: "team" });
    await ingest(seed, { path: "client/note.md", body: "kickoff scheduling", access: "external" });

    const asExternal = await retrieve(db(), seed.teamId, "external", "zzzz-no-match");
    const paths = asExternal.sources.map((s) => s.path);
    expect(paths).not.toContain("internal/secret.md");
  });
});
