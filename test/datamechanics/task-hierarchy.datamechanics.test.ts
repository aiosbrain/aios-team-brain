import { describe, expect, it } from "vitest";
import { db, ingest, seedTeam } from "./helpers";
import { IngestValidationError } from "@/lib/api/schemas";

// Spec (brain-api v1.2): materializeTasks persists the hierarchy fields, preserves the
// dashboard-only `body` across a sync push, and enforces parent integrity (exists + acyclic).
// Verified to the observable outcome: the row read back from real Postgres.

const pushTasks = (seed: Awaited<ReturnType<typeof seedTeam>>, rows: Record<string, unknown>[]) =>
  ingest(seed, {
    kind: "task",
    path: "3-log/tasks.md",
    // Serialize every field into the body so any change (incl. labels/priority/parent) shifts the
    // content_sha256 — otherwise ingest short-circuits as "unchanged" and never re-materializes,
    // exactly as a real tasks.md (whose columns carry these values) would.
    body: rows
      .map(
        (r) =>
          `| ${r.row_key} | ${r.title} | ${r.parent ?? ""} | ${JSON.stringify(r.labels ?? "")} | ${r.priority ?? ""} |`
      )
      .join("\n"),
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

  it("a six-column re-push preserves hierarchy fields (no clobber)", async () => {
    const seed = await seedTeam();
    // First push carries the v1.2 columns.
    await pushTasks(seed, [
      { row_key: "P0", title: "Epic", labels: ["integration", "wave-1"], priority: "high" },
      { row_key: "P0.1", title: "Chunk", parent: "P0", labels: ["integration"], priority: "medium" },
    ]);
    // Second push is a plain SIX-COLUMN table (no parent/labels/priority keys at all) — still valid
    // per brain-api v1.2. It must NOT reset the hierarchy to null/[]/none.
    await pushTasks(seed, [
      { row_key: "P0", title: "Epic renamed" },
      { row_key: "P0.1", title: "Chunk renamed" },
    ]);

    const epic = await readTask(seed.teamId, "P0");
    const sub = await readTask(seed.teamId, "P0.1");
    expect(epic?.labels).toEqual(["integration", "wave-1"]); // preserved
    expect(epic?.priority).toBe("high"); // preserved
    expect(sub?.parent_row_key).toBe("P0"); // preserved
    expect(sub?.priority).toBe("medium"); // preserved
  });

  it("a present-but-empty hierarchy cell IS authoritative (clears it)", async () => {
    const seed = await seedTeam();
    await pushTasks(seed, [{ row_key: "T-1", title: "x", labels: ["a"], priority: "high" }]);
    // A push that includes the keys with empty values (the column exists, the cell is blank).
    await pushTasks(seed, [{ row_key: "T-1", title: "x", parent: null, labels: [], priority: "" }]);
    const t = await readTask(seed.teamId, "T-1");
    expect(t?.labels).toEqual([]);
    expect(t?.priority).toBe("none");
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

  it("rejects a self-parent and a parent cycle (typed IngestValidationError → 422)", async () => {
    const seed = await seedTeam();
    await expect(pushTasks(seed, [{ row_key: "A", title: "a", parent: "A" }])).rejects.toThrow(
      IngestValidationError
    );
    const seed2 = await seedTeam();
    await expect(
      pushTasks(seed2, [
        { row_key: "A", title: "a", parent: "B" },
        { row_key: "B", title: "b", parent: "A" },
      ])
    ).rejects.toThrow(/cycle/);
  });

  it("rejects a cycle formed across two syncs (combined existing + incoming graph)", async () => {
    const seed = await seedTeam();
    // Sync 1: A is the epic, B is its child (B.parent = A).
    await pushTasks(seed, [
      { row_key: "A", title: "a" },
      { row_key: "B", title: "b", parent: "A" },
    ]);
    // Sync 2: now point A at B → A→B→A cycle through the existing DB edge.
    await expect(pushTasks(seed, [{ row_key: "A", title: "a", parent: "B" }])).rejects.toThrow(
      /cycle/
    );
  });

  it("fails the whole push on a malformed row (no partial apply)", async () => {
    const seed = await seedTeam();
    await expect(
      pushTasks(seed, [
        { row_key: "GOOD", title: "ok" },
        { row_key: "BAD", title: "bad", labels: [1, 2] }, // non-string labels
      ])
    ).rejects.toThrow(IngestValidationError);
    // The good row must NOT have landed — the push is all-or-nothing.
    expect(await readTask(seed.teamId, "GOOD")).toBeNull();
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
