import { describe, expect, it } from "vitest";
import { db, ingest, seedTeam, type Seed } from "./helpers";
import { normalizeLinearTeam, type LinearImportIssue } from "@/lib/ingest/sources/linear-normalize";
import { withFooter } from "@/lib/pm-sync/linear-client";

// Spec (Linear inbound import) verified to the observable outcome — rows read back from real Postgres.
// Mirrors the Plane import data-mechanics: dedicated project, no-op re-import, cross-project diff-delete
// isolation, round-tripper de-dupe, team tier.

function importLinear(seed: Seed, issues: LinearImportIssue[]) {
  const payload = normalizeLinearTeam({ teamKey: "ENG", issues });
  return ingest(seed, {
    project: payload.project,
    kind: "task",
    path: payload.path,
    body: payload.body,
    access: "team",
    rows: payload.rows,
  } as never);
}

const tasksByKey = async (teamId: string, rowKey: string) => {
  const { data } = await db()
    .from("tasks")
    .select("id, row_key, title, status, project_id")
    .eq("team_id", teamId)
    .eq("row_key", rowKey);
  return (data ?? []) as { id: string; row_key: string; title: string; status: string; project_id: string }[];
};

describe("Linear import (data-mechanics)", () => {
  it("materializes issues as tasks in a dedicated linear project", async () => {
    const seed = await seedTeam();
    await importLinear(seed, [
      { id: "u1", identifier: "ENG-1", title: "Build", state: { type: "started" } },
      { id: "u2", identifier: "ENG-2", title: "Test", state: { type: "backlog" } },
    ]);
    expect((await tasksByKey(seed.teamId, "ENG-1"))[0]?.status).toBe("in_progress");
    expect((await tasksByKey(seed.teamId, "ENG-2"))[0]?.title).toBe("Test");
  });

  it("re-importing an unchanged team is a no-op and never duplicates a row", async () => {
    const seed = await seedTeam();
    const issues: LinearImportIssue[] = [{ id: "u1", identifier: "ENG-1", title: "Stable", state: { type: "backlog" } }];
    const first = await importLinear(seed, issues);
    const second = await importLinear(seed, issues);
    expect(first.status).toBe("created");
    expect(second.status).toBe("unchanged");
    expect(await tasksByKey(seed.teamId, "ENG-1")).toHaveLength(1);
  });

  it("a removed issue diff-deletes within the linear project but never touches another project's tasks", async () => {
    const seed = await seedTeam();
    await ingest(seed, {
      project: "acme",
      kind: "task",
      path: "3-log/tasks.md",
      body: "| C-1 | CLI task |",
      access: "team",
      rows: [{ row_key: "C-1", title: "CLI task" }],
    } as never);

    await importLinear(seed, [
      { id: "u1", identifier: "ENG-1", title: "Keep", state: { type: "backlog" } },
      { id: "u2", identifier: "ENG-2", title: "Drop", state: { type: "backlog" } },
    ]);
    expect(await tasksByKey(seed.teamId, "ENG-2")).toHaveLength(1);

    await importLinear(seed, [{ id: "u1", identifier: "ENG-1", title: "Keep", state: { type: "backlog" } }]);
    expect(await tasksByKey(seed.teamId, "ENG-2")).toHaveLength(0); // diff-deleted
    expect(await tasksByKey(seed.teamId, "ENG-1")).toHaveLength(1); // survivor
    expect(await tasksByKey(seed.teamId, "C-1")).toHaveLength(1); // bystander untouched
  });

  it("de-dupes brain round-trippers: aios-ext footer issues are never materialized", async () => {
    const seed = await seedTeam();
    await importLinear(seed, [
      { id: "u1", identifier: "ENG-1", title: "Native", state: { type: "backlog" } },
      {
        id: "u2",
        identifier: "ENG-2",
        title: "RoundTrip",
        description: withFooter("body", "T-9", "aios-backlog"),
        state: { type: "backlog" },
      },
    ]);
    expect(await tasksByKey(seed.teamId, "ENG-1")).toHaveLength(1);
    expect(await tasksByKey(seed.teamId, "ENG-2")).toHaveLength(0);
  });

  it("writes imported Linear data at team tier (never external)", async () => {
    const seed = await seedTeam();
    await importLinear(seed, [{ id: "u1", identifier: "ENG-1", title: "T", state: { type: "backlog" } }]);
    const { data } = await db()
      .from("items")
      .select("access")
      .eq("team_id", seed.teamId)
      .eq("path", "linear/eng/issues.md")
      .maybeSingle();
    expect((data as { access: string } | null)?.access).toBe("team");
  });
});
