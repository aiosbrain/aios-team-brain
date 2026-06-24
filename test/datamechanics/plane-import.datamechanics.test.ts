import { describe, expect, it } from "vitest";
import { db, ingest, seedTeam, type Seed } from "./helpers";
import { normalizePlaneProject, type PlaneWorkItemRaw } from "@/lib/ingest/sources/plane-normalize";

// Spec (Plane inbound import) verified to the observable outcome — rows read back from real Postgres:
//   1. import materializes work-items as tasks in a DEDICATED brain project;
//   2. re-importing an unchanged board is a no-op (sha dedup) and never duplicates a row;
//   3. a work-item removed from Plane diff-deletes ONLY within the plane project — a CLI/UI task
//      in another project is never touched (the diff-delete is project-wide, hence the isolation);
//   4. aios round-trippers (external_source=aios) are de-duped (never materialized);
//   5. imported Plane data is written at TEAM tier (never external).

const STATES = [
  { id: "s-todo", name: "Todo", group: "unstarted" },
  { id: "s-doing", name: "In Progress", group: "started" },
];

function importPlane(
  seed: Seed,
  items: PlaneWorkItemRaw[],
  extra: { moduleByItem?: Record<string, string>; cycleByItem?: Record<string, string> } = {}
) {
  const payload = normalizePlaneProject({
    projectId: "p-1",
    projectIdentifier: "ENG",
    workspaceSlug: "acme",
    baseUrl: "https://api.plane.so",
    states: STATES,
    items,
    ...extra,
  });
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
    .select("id, row_key, title, status, project_id, origin")
    .eq("team_id", teamId)
    .eq("row_key", rowKey);
  return (data ?? []) as { id: string; row_key: string; title: string; status: string; project_id: string; origin: string }[];
};

describe("Plane import (data-mechanics)", () => {
  it("materializes work-items as tasks in a dedicated plane project", async () => {
    const seed = await seedTeam();
    await importPlane(seed, [
      { id: "wi-1", sequence_id: 1, name: "Build importer", state: "s-doing" },
      { id: "wi-2", sequence_id: 2, name: "Write tests", state: "s-todo" },
    ]);

    const [t1] = await tasksByKey(seed.teamId, "ENG-1");
    const [t2] = await tasksByKey(seed.teamId, "ENG-2");
    expect(t1?.title).toBe("Build importer");
    expect(t1?.status).toBe("in_progress");
    expect(t2?.status).toBe("ready"); // "Todo" state, group "unstarted" → ready
  });

  it("re-importing an unchanged board is a no-op and never duplicates a row", async () => {
    const seed = await seedTeam();
    const items: PlaneWorkItemRaw[] = [{ id: "wi-1", sequence_id: 1, name: "Stable", state: "s-todo" }];
    const first = await importPlane(seed, items);
    const second = await importPlane(seed, items);
    expect(first.status).toBe("created");
    expect(second.status).toBe("unchanged");
    expect(await tasksByKey(seed.teamId, "ENG-1")).toHaveLength(1);
  });

  it("a removed work-item diff-deletes within the plane project but never touches another project's tasks", async () => {
    const seed = await seedTeam();
    // A CLI-style task lives in its own project "acme" (origin=sync) — the at-risk bystander.
    await ingest(seed, {
      project: "acme",
      kind: "task",
      path: "3-log/tasks.md",
      body: "| C-1 | CLI task |",
      access: "team",
      rows: [{ row_key: "C-1", title: "CLI task" }],
    } as never);

    await importPlane(seed, [
      { id: "wi-1", sequence_id: 1, name: "Keep", state: "s-todo" },
      { id: "wi-2", sequence_id: 2, name: "Drop", state: "s-todo" },
    ]);
    expect(await tasksByKey(seed.teamId, "ENG-2")).toHaveLength(1);

    // ENG-2 removed from Plane → next import drops it from the plane project only.
    await importPlane(seed, [{ id: "wi-1", sequence_id: 1, name: "Keep", state: "s-todo" }]);
    expect(await tasksByKey(seed.teamId, "ENG-2")).toHaveLength(0); // diff-deleted
    expect(await tasksByKey(seed.teamId, "ENG-1")).toHaveLength(1); // survivor
    expect(await tasksByKey(seed.teamId, "C-1")).toHaveLength(1); // bystander UNTOUCHED
  });

  it("de-dupes aios round-trippers: external_source=aios items are never materialized", async () => {
    const seed = await seedTeam();
    await importPlane(seed, [
      { id: "wi-native", sequence_id: 1, name: "Native", state: "s-todo" },
      { id: "wi-rt", sequence_id: 2, name: "Round-tripper", state: "s-todo", external_source: "aios", external_id: "T-5" },
    ]);
    expect(await tasksByKey(seed.teamId, "ENG-1")).toHaveLength(1);
    expect(await tasksByKey(seed.teamId, "ENG-2")).toHaveLength(0); // skipped
  });

  it("persists module → sprint and cycle → cycle:<name> label on the task row", async () => {
    const seed = await seedTeam();
    await importPlane(
      seed,
      [{ id: "wi-1", sequence_id: 1, name: "Task", state: "s-todo" }],
      { moduleByItem: { "wi-1": "Auth epic" }, cycleByItem: { "wi-1": "Sprint 7" } }
    );
    const { data } = await db()
      .from("tasks")
      .select("sprint, labels")
      .eq("team_id", seed.teamId)
      .eq("row_key", "ENG-1")
      .maybeSingle();
    const row = data as { sprint: string; labels: string[] } | null;
    expect(row?.sprint).toBe("Auth epic");
    expect(row?.labels).toContain("cycle:Sprint 7");
  });

  it("writes imported Plane data at team tier (never external)", async () => {
    const seed = await seedTeam();
    await importPlane(seed, [{ id: "wi-1", sequence_id: 1, name: "Task", state: "s-todo" }]);
    const { data } = await db()
      .from("items")
      .select("access, path")
      .eq("team_id", seed.teamId)
      .eq("path", "plane/eng/work-items.md")
      .maybeSingle();
    expect((data as { access: string } | null)?.access).toBe("team");
  });
});
