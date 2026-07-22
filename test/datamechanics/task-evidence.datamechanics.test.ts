import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { linkTaskEvidence } from "@/lib/dashboard/timeline-evidence";
import { db, seedTeam, ingest, type Seed } from "./helpers";

// Spec (PR-D): the persisted task_evidence layer records which items are the work behind a task, via
// deterministic issue-key references. linkTaskEvidence is the sole writer; it REPLACES the team's
// issue_ref edges each run (idempotent + prunes). Real-DB outcomes read back from Postgres.

const recentIso = new Date(Date.now() - 86_400_000).toISOString();

async function seedTask(seed: Seed, projectId: string, rowKey: string) {
  const { data } = await db()
    .from("tasks")
    .insert({ team_id: seed.teamId, project_id: projectId, row_key: rowKey, title: rowKey, assignee: "Tester", status: "in_progress", audience: "team", origin: "sync" })
    .select("id")
    .single();
  return (data as { id: string }).id;
}

async function commit(seed: Seed, body: string, path = `commits/repo/${randomUUID()}.md`) {
  return ingest(seed, {
    kind: "artifact", path, access: "team",
    body, frontmatter: { source: "git", committed_at: recentIso },
  });
}

async function edges(teamId: string) {
  const { data } = await db().from("task_evidence").select("task_id, item_id, method").eq("team_id", teamId);
  return (data ?? []) as { task_id: string; item_id: string; method: string }[];
}

describe("task_evidence writer (real Postgres)", () => {
  it("links a commit citing an issue key to its task, idempotently, and prunes when the reference is gone", async () => {
    const seed = await seedTeam();
    const anchor = await commit(seed, "seed"); // just to create the project
    const taskId = await seedTask(seed, anchor.projectId!, "AIO-7");
    const path = `commits/repo/${randomUUID()}.md`;
    const c = await commit(seed, "feat: wire the adapter (AIO-7)", path);

    await linkTaskEvidence(db(), seed.teamId);
    const e = await edges(seed.teamId);
    expect(e).toHaveLength(1);
    expect(e[0]).toMatchObject({ task_id: taskId, item_id: c.id, method: "issue_ref" });

    // Idempotent — a second run yields the same single edge.
    await linkTaskEvidence(db(), seed.teamId);
    expect(await edges(seed.teamId)).toHaveLength(1);

    // Re-push the SAME path with the reference REMOVED → the edge is pruned on the next run.
    await commit(seed, "feat: wire the adapter (no key now)", path);
    await linkTaskEvidence(db(), seed.teamId);
    expect(await edges(seed.teamId)).toHaveLength(0);
  });

  it("never links a non-issue-shaped row_key", async () => {
    const seed = await seedTeam();
    const anchor = await commit(seed, "seed");
    await seedTask(seed, anchor.projectId!, "ui-abc123"); // not issue-shaped
    await commit(seed, "mentions ui-abc123 in passing");
    await linkTaskEvidence(db(), seed.teamId);
    expect(await edges(seed.teamId)).toHaveLength(0);
  });
});
