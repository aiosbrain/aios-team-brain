import { describe, expect, it } from "vitest";
import { visibleItems, visibleDecisions, canSeeAccess } from "@/lib/auth/visibility";
import { db, ingest, seedTeam } from "./helpers";

// The dashboard tier choke-point (lib/auth/visibility), verified to the observable outcome
// against real Postgres (DB_BACKEND=postgres → no RLS). This is the SOLE enforcement on the
// dashboard reads in postgres mode; the dashboard-tier-filter guard ensures pages use it.

describe("visibleItems() / canSeeAccess() on real Postgres", () => {
  it("external viewer's items read excludes team content; team viewer sees both", async () => {
    const seed = await seedTeam();
    await ingest(seed, { path: "internal/strategy.md", body: "team plan", access: "team" });
    await ingest(seed, { path: "client/brief.md", body: "client brief", access: "external" });

    const base = () =>
      db().from("items").select("path, access").eq("team_id", seed.teamId);

    const { data: ext } = await visibleItems(base(), "external");
    const extPaths = (ext ?? []).map((r: { path: string }) => r.path);
    expect(extPaths).toContain("client/brief.md");
    expect(extPaths).not.toContain("internal/strategy.md"); // no leak, no RLS backstop

    const { data: team } = await visibleItems(base(), "team");
    const teamPaths = (team ?? []).map((r: { path: string }) => r.path);
    expect(teamPaths).toContain("internal/strategy.md"); // non-vacuity: data is present
    expect(teamPaths).toContain("client/brief.md");
  });

  it("canSeeAccess gates single-item (by-id) reads", () => {
    expect(canSeeAccess("external", "team")).toBe(false);
    expect(canSeeAccess("external", "external")).toBe(true);
    expect(canSeeAccess("team", "team")).toBe(true);
  });
});

describe("dashboard decision visibility on real Postgres", () => {
  it("external dashboard reads do not expose team-audience decisions", async () => {
    const seed = await seedTeam();
    const { data: project } = await db()
      .from("projects")
      .insert({ team_id: seed.teamId, slug: "acme", name: "Acme" })
      .select("id")
      .single();

    await db().from("decisions").insert([
      {
        team_id: seed.teamId,
        project_id: (project as { id: string }).id,
        row_key: "D-team",
        title: "Internal pricing posture",
        audience: "team",
      },
      {
        team_id: seed.teamId,
        project_id: (project as { id: string }).id,
        row_key: "D-external",
        title: "Client-facing launch date",
        audience: "external",
      },
    ]);

    const base = () =>
      db().from("decisions").select("row_key, title, audience").eq("team_id", seed.teamId).order("row_key");

    // External viewer through the choke-point: only audience='external'.
    const { data: ext } = await visibleDecisions(base(), "external");
    const extKeys = ((ext ?? []) as { row_key: string }[]).map((r) => r.row_key);
    expect(extKeys).toContain("D-external"); // non-vacuity
    expect(extKeys).not.toContain("D-team"); // no leak, no RLS backstop

    // Team viewer sees both.
    const { data: team } = await visibleDecisions(base(), "team");
    const teamKeys = ((team ?? []) as { row_key: string }[]).map((r) => r.row_key);
    expect(teamKeys).toEqual(["D-external", "D-team"]);
  });
});
