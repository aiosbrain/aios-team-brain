import { describe, expect, it } from "vitest";
import { db, ingest, seedTeam, type Seed } from "./helpers";
import { normalizeGithubRepo, type GithubIssueRaw } from "@/lib/ingest/sources/github-normalize";

// Spec (GitHub inbound import) verified to the observable outcome — rows read back from real Postgres.
// Mirrors the Plane/Linear import data-mechanics: dedicated project, no-op re-import, cross-project
// diff-delete isolation, team tier.

function importGithub(seed: Seed, issues: GithubIssueRaw[]) {
  const payload = normalizeGithubRepo({ owner: "acme", repo: "app", issues });
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
    .select("id, row_key, title, status")
    .eq("team_id", teamId)
    .eq("row_key", rowKey);
  return (data ?? []) as { id: string; row_key: string; title: string; status: string }[];
};

describe("GitHub import (data-mechanics)", () => {
  it("materializes issues as tasks in a dedicated repo project", async () => {
    const seed = await seedTeam();
    await importGithub(seed, [
      { number: 1, title: "Open one", state: "open" },
      { number: 2, title: "Done one", state: "closed" },
    ]);
    expect((await tasksByKey(seed.teamId, "GH-1"))[0]?.status).toBe("backlog");
    expect((await tasksByKey(seed.teamId, "GH-2"))[0]?.status).toBe("done");
  });

  it("re-importing an unchanged repo is a no-op and never duplicates a row", async () => {
    const seed = await seedTeam();
    const issues: GithubIssueRaw[] = [{ number: 1, title: "Stable", state: "open" }];
    const first = await importGithub(seed, issues);
    const second = await importGithub(seed, issues);
    expect(first.status).toBe("created");
    expect(second.status).toBe("unchanged");
    expect(await tasksByKey(seed.teamId, "GH-1")).toHaveLength(1);
  });

  it("a removed issue diff-deletes within the repo project but never touches another project's tasks", async () => {
    const seed = await seedTeam();
    await ingest(seed, {
      project: "acme-docs",
      kind: "task",
      path: "3-log/tasks.md",
      body: "| C-1 | CLI task |",
      access: "team",
      rows: [{ row_key: "C-1", title: "CLI task" }],
    } as never);

    await importGithub(seed, [
      { number: 1, title: "Keep", state: "open" },
      { number: 2, title: "Drop", state: "open" },
    ]);
    expect(await tasksByKey(seed.teamId, "GH-2")).toHaveLength(1);

    await importGithub(seed, [{ number: 1, title: "Keep", state: "open" }]);
    expect(await tasksByKey(seed.teamId, "GH-2")).toHaveLength(0); // diff-deleted
    expect(await tasksByKey(seed.teamId, "GH-1")).toHaveLength(1); // survivor
    expect(await tasksByKey(seed.teamId, "C-1")).toHaveLength(1); // bystander untouched
  });

  it("writes imported GitHub data at team tier (never external)", async () => {
    const seed = await seedTeam();
    await importGithub(seed, [{ number: 1, title: "T", state: "open" }]);
    const { data } = await db()
      .from("items")
      .select("access")
      .eq("team_id", seed.teamId)
      .eq("path", "github/acme-app/issues.md")
      .maybeSingle();
    expect((data as { access: string } | null)?.access).toBe("team");
  });
});
