import { describe, expect, it } from "vitest";
import { ingestWorkEvent } from "@/lib/work-events/ingest";
import { db, ingest, seedTeam } from "./helpers";

async function taskStatus(rowKey: string): Promise<string | null> {
  const { data } = await db()
    .from("tasks")
    .select("status")
    .eq("row_key", rowKey)
    .maybeSingle();
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
      rows: [
        { row_key: "W1.2.1", title: "build metric", status: "in_progress" },
      ],
    } as never);

    const payload = {
      project: "acme",
      event_kind: "merged" as const,
      repo: "aiosbrain/aios-team-brain",
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
      { syncPm: false },
    );
    expect(res.applied).toEqual([
      { row_key: "W1.2.1", task_id: res.applied[0].task_id },
    ]);
    expect(await taskStatus("W1.2.1")).toBe("done");

    res = await ingestWorkEvent(
      db(),
      { teamId: seed.teamId, memberId: seed.memberId, apiKeyId: "api-key" },
      payload,
      { syncPm: false },
    );
    const { data: events } = await db()
      .from("work_events")
      .select("id")
      .eq("team_id", seed.teamId);
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
        repo: "aiosbrain/aios-workspace",
        merged_sha: "def123456789",
        pr_url: "",
        pr_title: "P9 Missing key",
        pr_body: "",
        branch: "",
        work_keys: ["P9"],
        actor: "alex",
      },
      { syncPm: false },
    );

    expect(res.applied).toEqual([]);
    expect(res.unresolved).toEqual([{ row_key: "P9" }]);
    const { data } = await db()
      .from("work_events")
      .select("status, error")
      .eq("team_id", seed.teamId)
      .eq("row_key", "P9")
      .single();
    expect(data).toMatchObject({
      status: "unresolved",
      error: "no matching task row",
    });
  });

  it("records provider sync errors on the PM link without losing task completion", async () => {
    const seed = await seedTeam();
    // v1.2: projection targets the team's primary PM tool. Declare it so the work-events done path
    // knows the intended provider even though no integration is enabled (→ missing_integration).
    await db()
      .from("teams")
      .update({ primary_pm_provider: "plane" })
      .eq("id", seed.teamId);
    await ingest(seed, {
      kind: "task",
      path: "3-log/tasks.md",
      body: "| ID | Task | Assignee | Status | Sprint | Due | PM |\n| P0 | plane seed | alex | ready | | | plane:P0 |",
      access: "team",
      rows: [
        {
          row_key: "P0",
          title: "plane seed",
          status: "ready",
          pm_provider: "plane",
          pm_external_id: "P0",
        },
      ],
    } as never);

    const res = await ingestWorkEvent(
      db(),
      { teamId: seed.teamId, memberId: seed.memberId, apiKeyId: "api-key" },
      {
        project: "acme",
        event_kind: "merged",
        repo: "aiosbrain/aios-team-brain",
        merged_sha: "feed12345678",
        pr_url: "",
        pr_title: "P0 Finish Plane seed",
        pr_body: "",
        branch: "",
        work_keys: ["P0"],
        actor: "alex",
      },
    );

    expect(await taskStatus("P0")).toBe("done");
    expect(res.pm_sync).toEqual([
      expect.objectContaining({
        row_key: "P0",
        provider: "plane",
        status: "missing_integration",
      }),
    ]);
    const { data: link } = await db()
      .from("task_pm_links")
      .select("last_error")
      .eq("team_id", seed.teamId)
      .eq("row_key", "P0")
      .single();
    expect((link as { last_error: string }).last_error).toMatch(
      /plane integration/i,
    );
  });

  it("creates a PM link row when none exists yet (insert-returning path against real PG)", async () => {
    const seed = await seedTeam();
    // primary provider set, integration absent, and NO markdown PM column ⇒ no pre-existing link.
    // The work-events done path must INSERT a task_pm_links row to record the error — this exercises
    // ensureLink's insert-returning, which the prod pg adapter rejects with a bare "*" select.
    await db()
      .from("teams")
      .update({ primary_pm_provider: "plane" })
      .eq("id", seed.teamId);
    await ingest(seed, {
      kind: "task",
      path: "3-log/tasks.md",
      body: "| ID | Task | Assignee | Status | Sprint | Due |\n| P7 | no pm column | alex | ready | | |",
      access: "team",
      rows: [{ row_key: "P7", title: "no pm column", status: "ready" }],
    } as never);

    const res = await ingestWorkEvent(
      db(),
      { teamId: seed.teamId, memberId: seed.memberId, apiKeyId: "api-key" },
      {
        project: "acme",
        event_kind: "merged",
        repo: "aiosbrain/aios-team-brain",
        merged_sha: "abcdef987654",
        pr_url: "",
        pr_title: "P7 done",
        pr_body: "",
        branch: "",
        work_keys: ["P7"],
        actor: "alex",
      },
    );

    expect(await taskStatus("P7")).toBe("done");
    expect(res.pm_sync).toEqual([
      expect.objectContaining({
        row_key: "P7",
        provider: "plane",
        status: "missing_integration",
      }),
    ]);
    // The link was created (not pre-existing) and carries the error.
    const { data: link } = await db()
      .from("task_pm_links")
      .select("provider, provider_external_id, last_error")
      .eq("team_id", seed.teamId)
      .eq("row_key", "P7")
      .single();
    expect(
      link as {
        provider: string;
        provider_external_id: string;
        last_error: string;
      },
    ).toMatchObject({
      provider: "plane",
      provider_external_id: "P7",
    });
    expect((link as { last_error: string }).last_error).toMatch(
      /plane integration/i,
    );
  });
});

describe("work events — the project-scope fix (LINK-ONLY, no Linear write-back)", () => {
  /** Create a task in an EXPLICIT project (mirrors how Linear issues land in `linear-<teamKey>`). */
  async function taskInProject(seed: { teamId: string }, projectSlug: string, rowKey: string, title = "mirrored issue") {
    const { data: proj } = await db()
      .from("projects")
      .upsert({ team_id: seed.teamId, slug: projectSlug }, { onConflict: "team_id,slug" })
      .select("id")
      .single();
    const projectId = (proj as { id: string }).id;
    const { data: task, error } = await db()
      .from("tasks")
      .insert({ team_id: seed.teamId, project_id: projectId, row_key: rowKey, title, status: "in_progress", origin: "sync", audience: "team" })
      .select("id")
      .single();
    if (error) throw new Error(`task insert failed: ${error.message}`);
    return (task as { id: string }).id;
  }

  const prPayload = (over: Record<string, unknown> = {}) => ({
    project: "the-repo", // the REPO's project — deliberately NOT where the mirrored task lives
    event_kind: "merged" as const,
    repo: "aiosbrain/aios-team-brain",
    merged_sha: "deadbeef00112233445566778899aabbccddeeff",
    pr_url: "https://example.test/pr/9",
    pr_title: "fix: something (AIO-494)",
    pr_body: "",
    branch: "",
    work_keys: ["AIO-494"],
    actor: "alex",
    ...over,
  });

  it("THE FIX: resolves a task in a DIFFERENT project — status `linked`, task NOT completed", async () => {
    const seed = await seedTeam();
    const taskId = await taskInProject(seed, "linear-aio", "AIO-494");
    // The repo's project must exist so the pushed-project lookup is a real (missing) match, not a null.
    await db().from("projects").upsert({ team_id: seed.teamId, slug: "the-repo" }, { onConflict: "team_id,slug" });

    const res = await ingestWorkEvent(
      db(),
      { teamId: seed.teamId, memberId: seed.memberId, apiKeyId: "api-key" },
      prPayload(),
      { syncPm: false }
    );

    // Linked (the bug fix), NOT applied.
    expect(res.linked).toEqual([{ row_key: "AIO-494", task_id: taskId }]);
    expect(res.applied).toEqual([]);
    const { data: ev } = await db().from("work_events").select("status, task_id").eq("team_id", seed.teamId).maybeSingle();
    expect(ev).toMatchObject({ status: "linked", task_id: taskId });

    // THE BLAST-RADIUS GUARANTEE: the task must NOT be completed (a completion here would also trigger the
    // Linear write-back that can duplicate issues). This assertion is what stops a refactor re-arming it.
    expect(await taskStatus("AIO-494")).toBe("in_progress");
  });

  it("does NOT team-wide-match a junk key (V1) — project scope keeps precision", async () => {
    const seed = await seedTeam();
    await taskInProject(seed, "linear-aio", "V1", "a slug-keyed row");
    await db().from("projects").upsert({ team_id: seed.teamId, slug: "the-repo" }, { onConflict: "team_id,slug" });

    const res = await ingestWorkEvent(
      db(),
      { teamId: seed.teamId, memberId: seed.memberId, apiKeyId: "api-key" },
      prPayload({ work_keys: ["V1"], merged_sha: "1111111111222222222233333333334444444444" }),
      { syncPm: false }
    );
    expect(res.linked).toEqual([]);
    expect(res.unresolved).toEqual([{ row_key: "V1" }]);
  });
});
