import { describe, expect, it } from "vitest";
import { retrieve } from "@/lib/query/retrieve";
import { db, seedTeam } from "./helpers";

/**
 * Spec for the structured tasks digest on real Postgres: retrieval must include tasks of ALL
 * statuses (so "what got completed?" can ground on `done` tasks), most-recently-updated first.
 * This is the fix for the digest having been active-only (`in_progress/blocked/ready`), which
 * structurally hid every completion from the brain. Derived from the product gap, not the impl.
 */

async function seedProject(teamId: string, slug: string): Promise<string> {
  const { data } = await db()
    .from("projects")
    .insert({ team_id: teamId, slug, name: slug })
    .select("id")
    .single();
  return (data as { id: string }).id;
}

async function seedTask(
  teamId: string,
  projectId: string,
  rowKey: string,
  title: string,
  status: string,
  updatedAt: string
): Promise<void> {
  await db().from("tasks").insert({
    team_id: teamId,
    project_id: projectId,
    row_key: rowKey,
    title,
    status,
    origin: "sync",
    updated_at: updatedAt,
  });
}

describe("retrieve() tasks digest (real Postgres)", () => {
  it("includes done tasks and orders all statuses by updated_at (newest first)", async () => {
    const seed = await seedTeam();
    const proj = await seedProject(seed.teamId, "apollo");
    // Distinct updated_at so ordering is deterministic; the done task is the most recent.
    await seedTask(seed.teamId, proj, "T-DONE", "Ship the login flow", "done", "2026-06-26T10:00:00Z");
    await seedTask(seed.teamId, proj, "T-WIP", "Wire the dashboard", "in_progress", "2026-06-25T10:00:00Z");
    await seedTask(seed.teamId, proj, "T-BACK", "Draft the RFC", "backlog", "2026-06-20T10:00:00Z");

    const ctx = await retrieve(db(), seed.teamId, "team", "what got completed today");
    const s = ctx.structured;

    // The done task is present (was structurally excluded before) and tagged + dated.
    expect(s).toContain("Tasks (all statuses");
    expect(s).toMatch(/T-DONE \[done\] Ship the login flow.*updated 2026-06-26/);
    // All three statuses appear — full board, not just active.
    expect(s).toContain("T-WIP [in_progress]");
    expect(s).toContain("T-BACK [backlog]");
    // Ordering: most-recently-updated first → done (26th) before wip (25th) before backlog (20th).
    expect(s.indexOf("T-DONE")).toBeLessThan(s.indexOf("T-WIP"));
    expect(s.indexOf("T-WIP")).toBeLessThan(s.indexOf("T-BACK"));
  });
});
