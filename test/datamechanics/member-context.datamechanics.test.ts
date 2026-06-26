import { describe, expect, it } from "vitest";
import { setMemberProfile, addTimeOff, setMemberGoal } from "@/lib/identity/profile";
import { getMemberContext } from "@/lib/identity/context";
import { db, seedTeam } from "./helpers";

/**
 * Spec for the identity-context READ fold on real Postgres: getMemberContext returns the
 * member's profile + time-off + goals + derived project participation, and an external-tier
 * viewer sees nothing (the sole tier gate — no RLS backstop). Derived projects come from
 * tasks whose free-text assignee names the member.
 */

async function seedProject(teamId: string, slug: string, name: string): Promise<string> {
  const { data } = await db()
    .from("projects")
    .insert({ team_id: teamId, slug, name })
    .select("id")
    .single();
  return (data as { id: string }).id;
}

async function seedTask(
  teamId: string,
  projectId: string,
  assignee: string,
  status: string
): Promise<void> {
  await db()
    .from("tasks")
    .insert({ team_id: teamId, project_id: projectId, title: "t", assignee, status, origin: "sync" });
}

describe("getMemberContext fold (real Postgres)", () => {
  it("folds profile + time-off + goals for the member", async () => {
    const seed = await seedTeam();
    await setMemberProfile(db(), seed.teamId, seed.memberId, {
      timezone: "America/New_York",
      preferredChannels: ["slack", "email"],
      bio: "hi",
    });
    await addTimeOff(db(), seed.teamId, seed.memberId, { startsOn: "2026-08-01", endsOn: "2026-08-07" });
    await setMemberGoal(db(), seed.teamId, seed.memberId, { title: "ship phase 2", kind: "okr" });

    const ctx = await getMemberContext(db(), seed.teamId, seed.memberId, "team");
    expect(ctx).not.toBeNull();
    expect(ctx!.profile?.timezone).toBe("America/New_York");
    expect(ctx!.profile?.preferredChannels).toEqual(["slack", "email"]);
    expect(ctx!.timeOff).toHaveLength(1);
    expect(ctx!.timeOff[0]).toMatchObject({ startsOn: "2026-08-01", endsOn: "2026-08-07" });
    expect(ctx!.goals.map((g) => g.title)).toEqual(["ship phase 2"]);
  });

  it("derives projects from tasks assigned to the member (open vs total), most active first", async () => {
    const seed = await seedTeam();
    // seedTeam's member has display_name 'Tester' — assign tasks to that name.
    const apollo = await seedProject(seed.teamId, "apollo", "Apollo");
    const zephyr = await seedProject(seed.teamId, "zephyr", "Zephyr");
    await seedTask(seed.teamId, apollo, "Tester", "in_progress");
    await seedTask(seed.teamId, apollo, "Tester, Someone Else", "done");
    await seedTask(seed.teamId, zephyr, "Tester", "backlog");
    await seedTask(seed.teamId, apollo, "Unrelated Person", "backlog"); // not theirs

    const ctx = await getMemberContext(db(), seed.teamId, seed.memberId, "team");
    const projects = ctx!.projects;
    expect(projects.map((p) => p.slug)).toEqual(["apollo", "zephyr"]); // apollo (2) before zephyr (1)
    const apolloView = projects.find((p) => p.slug === "apollo")!;
    expect(apolloView).toMatchObject({ name: "Apollo", total: 2, open: 1 }); // 1 done → open=1
    expect(projects.find((p) => p.slug === "zephyr")).toMatchObject({ total: 1, open: 1 });
  });

  it("returns null for an external-tier viewer (the sole tier gate)", async () => {
    const seed = await seedTeam();
    await setMemberGoal(db(), seed.teamId, seed.memberId, { title: "secret OKR", kind: "okr" });
    const ctx = await getMemberContext(db(), seed.teamId, seed.memberId, "external");
    expect(ctx).toBeNull();
  });

  it("returns empty collections (not null) for a member with no context yet", async () => {
    const seed = await seedTeam();
    const ctx = await getMemberContext(db(), seed.teamId, seed.memberId, "team");
    expect(ctx).not.toBeNull();
    expect(ctx!.profile).toBeNull();
    expect(ctx!.timeOff).toEqual([]);
    expect(ctx!.goals).toEqual([]);
    expect(ctx!.projects).toEqual([]);
  });
});
