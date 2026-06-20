import { describe, expect, it } from "vitest";
import { ingestWorkEvent } from "@/lib/work-events/ingest";
import { db, ingest, seedTeam } from "./helpers";

async function taskStatus(rowKey: string): Promise<string | null> {
  const { data } = await db().from("tasks").select("status").eq("row_key", rowKey).maybeSingle();
  return (data as { status: string } | null)?.status ?? null;
}

describe("work events (real Postgres)", () => {
  it("marks a matching task done and is idempotent by repo+sha+key", async () => {
    const seed = await seedTeam();
    await ingest(seed, {
      kind: "task",
      path: "3-log/tasks.md",
      body: "| ID | Task | Assignee | Status | Sprint | Due |\n| W1.2.1 | build metric | alex | in_progress | | |",
      access: "team",
      rows: [{ row_key: "W1.2.1", title: "build metric", status: "in_progress" }],
    } as never);

    const payload = {
      project: "acme",
      event_kind: "merged" as const,
      repo: "AIOS-alpha/aios-team-brain",
      merged_sha: "abc123456789",
      pr_url: "https://example.test/pr/1",
      pr_title: "W1.2.1 Build metric",
      pr_body: "",
      branch: "",
      work_keys: ["W1.2.1"],
      actor: "alex",
    };

    let res = await ingestWorkEvent(
      db(),
      { teamId: seed.teamId, memberId: seed.memberId, apiKeyId: "api-key" },
      payload,
      { syncPm: false }
    );
    expect(res.applied).toEqual([{ row_key: "W1.2.1", task_id: res.applied[0].task_id }]);
    expect(await taskStatus("W1.2.1")).toBe("done");

    res = await ingestWorkEvent(
      db(),
      { teamId: seed.teamId, memberId: seed.memberId, apiKeyId: "api-key" },
      payload,
      { syncPm: false }
    );
    const { data: events } = await db().from("work_events").select("id").eq("team_id", seed.teamId);
    expect(events ?? []).toHaveLength(1);
    expect(res.unresolved).toEqual([]);
  });

  it("preserves an unresolved event when the key has no task row", async () => {
    const seed = await seedTeam();
    const res = await ingestWorkEvent(
      db(),
      { teamId: seed.teamId, memberId: seed.memberId, apiKeyId: "api-key" },
      {
        project: "acme",
        event_kind: "merged",
        repo: "AIOS-alpha/aios-workspace",
        merged_sha: "def123456789",
        pr_url: "",
        pr_title: "P9 Missing key",
        pr_body: "",
        branch: "",
        work_keys: ["P9"],
        actor: "alex",
      },
      { syncPm: false }
    );

    expect(res.applied).toEqual([]);
    expect(res.unresolved).toEqual([{ row_key: "P9" }]);
    const { data } = await db()
      .from("work_events")
      .select("status, error")
      .eq("team_id", seed.teamId)
      .eq("row_key", "P9")
      .single();
    expect(data).toMatchObject({ status: "unresolved", error: "no matching task row" });
  });

  it("records provider sync errors on the PM link without losing task completion", async () => {
    const seed = await seedTeam();
    await ingest(seed, {
      kind: "task",
      path: "3-log/tasks.md",
      body: "| ID | Task | Assignee | Status | Sprint | Due | PM |\n| P0 | plane seed | alex | ready | | | plane:P0 |",
      access: "team",
      rows: [{ row_key: "P0", title: "plane seed", status: "ready", pm_provider: "plane", pm_external_id: "P0" }],
    } as never);

    const res = await ingestWorkEvent(
      db(),
      { teamId: seed.teamId, memberId: seed.memberId, apiKeyId: "api-key" },
      {
        project: "acme",
        event_kind: "merged",
        repo: "AIOS-alpha/aios-team-brain",
        merged_sha: "feed12345678",
        pr_url: "",
        pr_title: "P0 Finish Plane seed",
        pr_body: "",
        branch: "",
        work_keys: ["P0"],
        actor: "alex",
      }
    );

    expect(await taskStatus("P0")).toBe("done");
    expect(res.pm_sync).toEqual([
      expect.objectContaining({ row_key: "P0", provider: "plane", status: "missing_integration" }),
    ]);
    const { data: link } = await db()
      .from("task_pm_links")
      .select("last_error")
      .eq("team_id", seed.teamId)
      .eq("row_key", "P0")
      .single();
    expect((link as { last_error: string }).last_error).toMatch(/plane integration/i);
  });
});
