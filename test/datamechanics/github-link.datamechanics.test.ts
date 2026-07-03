import { describe, expect, it } from "vitest";
import { linkGithubRepo, unlinkGithubRepo } from "@/lib/integrations/github-link";
import { RepoFormatError } from "@/lib/integrations/github-repos";
import { db, seedTeam } from "./helpers";

/**
 * Spec (real Postgres): the GitHub-repos panel links multiple repos into ONE canonical github
 * integration row (`config.repos`). First link creates the row; subsequent links append + de-dup;
 * unlink removes; malformed input is rejected. Verified to the stored outcome, not a proxy.
 */

async function githubRow(teamId: string) {
  const { data } = await db()
    .from("integrations")
    .select("id, name, config, status")
    .eq("team_id", teamId)
    .eq("type", "github");
  return data ?? [];
}

describe("GitHub repo linking (real Postgres)", () => {
  it("first link creates a single github row; more links append + de-dup case-insensitively", async () => {
    const seed = await seedTeam();
    const auth = { teamId: seed.teamId, memberId: seed.memberId };

    await linkGithubRepo(db(), auth, "acme/api");
    await linkGithubRepo(db(), auth, "https://github.com/acme/web.git"); // URL form
    await linkGithubRepo(db(), auth, "ACME/API"); // dup (case-insensitive) → ignored

    const rows = await githubRow(seed.teamId);
    expect(rows).toHaveLength(1); // exactly one canonical github integration
    expect(rows[0].config.repos).toEqual(["acme/api", "acme/web"]);
    expect(rows[0].status).toBe("enabled");
  });

  it("unlink removes a repo (case-insensitive) and preserves the row", async () => {
    const seed = await seedTeam();
    const auth = { teamId: seed.teamId, memberId: seed.memberId };
    await linkGithubRepo(db(), auth, "acme/api");
    await linkGithubRepo(db(), auth, "acme/web");

    await unlinkGithubRepo(db(), auth, "ACME/API");

    const rows = await githubRow(seed.teamId);
    expect(rows[0].config.repos).toEqual(["acme/web"]);
  });

  it("rejects malformed input without writing", async () => {
    const seed = await seedTeam();
    const auth = { teamId: seed.teamId, memberId: seed.memberId };
    await expect(linkGithubRepo(db(), auth, "not-a-repo")).rejects.toBeInstanceOf(RepoFormatError);
    expect(await githubRow(seed.teamId)).toHaveLength(0); // nothing persisted
  });
});
