import { describe, expect, it } from "vitest";
import { db, ingest, seedTeam } from "./helpers";

// Spec (brain-api v1.2): materializeTasks persists the hierarchy fields, preserves the
// dashboard-only `body` across a sync push, and enforces parent integrity (exists + acyclic).
// Verified to the observable outcome: the row read back from real Postgres.

const pushTasks = (seed: Awaited<ReturnType<typeof seedTeam>>, rows: Record<string, unknown>[]) =>
  ingest(seed, {
    kind: "task",
    path: "3-log/tasks.md",
    body: rows.map((r) => `| ${r.row_key} | ${r.title} |`).join("\n"),
    access: "team",
    rows,
  } as never);

const readTask = async (teamId: string, rowKey: string) => {
  const { data } = await db()
    .from("tasks")
    .select("parent_row_key, labels, priority, body, status")
    .eq("team_id", teamId)
    .eq("row_key", rowKey)
    .maybeSingle();
  return data as {
    parent_row_key: string | null;
    labels: string[];
    priority: string;
    body: string;
    status: string;
  } | null;
};

describe("task hierarchy materialization (real Postgres)", () => {
  it("persists parent_row_key, labels, and normalized priority", async () => {
    const seed = await seedTeam();
    await pushTasks(seed, [
      { row_key: "P0", title: "Epic", labels: ["integration", "wave-1"], priority: "critical" },
      { row_key: "P0.1", title: "Chunk", parent: "P0", labels: ["integration"], priority: "high" },
    ]);

    const epic = await readTask(seed.teamId, "P0");
    const sub = await readTask(seed.teamId, "P0.1");
    expect(epic?.labels).toEqual(["integration", "wave-1"]);
    expect(epic?.priority).toBe("urgent"); // "critical" → urgent
    expect(sub?.parent_row_key).toBe("P0");
    expect(sub?.priority).toBe("high");
  });

  it("preserves dashboard-authored `body` across a sync re-push", async () => {
    const seed = await seedTeam();
    await pushTasks(seed, [{ row_key: "T-1", title: "x" }]);
    // Simulate a dashboard body edit.
    await db().from("tasks").update({ body: "long dashboard description" }).eq("team_id", seed.teamId).eq("row_key", "T-1");

    // Re-push the same row from markdown (no body in the contract).
    await pushTasks(seed, [{ row_key: "T-1", title: "x updated" }]);

    const t = await readTask(seed.teamId, "T-1");
    expect(t?.body).toBe("long dashboard description"); // survived the sync push
  });

  it("rejects a push whose parent does not resolve", async () => {
    const seed = await seedTeam();
    await expect(
      pushTasks(seed, [{ row_key: "C", title: "child", parent: "GHOST" }])
    ).rejects.toThrow(/parent "GHOST" not found/);
  });

  it("rejects a self-parent and a parent cycle", async () => {
    const seed = await seedTeam();
    await expect(pushTasks(seed, [{ row_key: "A", title: "a", parent: "A" }])).rejects.toThrow(
      /cannot reference itself/
    );
    const seed2 = await seedTeam();
    await expect(
      pushTasks(seed2, [
        { row_key: "A", title: "a", parent: "B" },
        { row_key: "B", title: "b", parent: "A" },
      ])
    ).rejects.toThrow(/cycle/);
  });

  it("nulls a dangling parent when the epic is diff-deleted", async () => {
    const seed = await seedTeam();
    await pushTasks(seed, [
      { row_key: "E", title: "epic" },
      { row_key: "C", title: "child", parent: "E" },
    ]);
    expect((await readTask(seed.teamId, "C"))?.parent_row_key).toBe("E");

    // Second push: the epic E vanishes from tasks.md; the child C still references it.
    await pushTasks(seed, [{ row_key: "C", title: "child", parent: "E" }]);

    expect(await readTask(seed.teamId, "E")).toBeNull(); // epic diff-deleted
    expect((await readTask(seed.teamId, "C"))?.parent_row_key).toBeNull(); // dangling parent cleared
  });
});
