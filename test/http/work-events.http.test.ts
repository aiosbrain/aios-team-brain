import { describe, expect, it } from "vitest";
import { ingest } from "../datamechanics/helpers";
import {
  BASE_URL,
  db,
  issueKeyFor,
  keyHeaders,
  seedTeam,
} from "./http-helpers";

// HTTP edge of POST /api/v1/work-events: the route the merge-sync GitHub Action
// (aios-work-sync.yml) calls to close a task. We assert the HTTP contract and the
// DB outcome (task → done) — not Plane closure (the seeded task has no pm_links,
// so pm_sync is a no-op and makes no external call).

const WORK_EVENTS = `${BASE_URL}/api/v1/work-events`;

async function seedTask(
  seed: Awaited<ReturnType<typeof seedTeam>>,
  rowKey: string,
) {
  await ingest(seed, {
    kind: "task",
    path: "3-log/tasks.md",
    body: `| ID | Task | Assignee | Status |\n| ${rowKey} | build it | alex | in_progress |`,
    access: "team",
    rows: [{ row_key: rowKey, title: "build it", status: "in_progress" }],
  } as never);
}

function eventPayload(rowKey: string) {
  return {
    project: "acme",
    event_kind: "merged",
    repo: "aiosbrain/aios-team-brain",
    merged_sha: "abc123456789",
    pr_url: "https://example.test/pr/1",
    pr_title: `${rowKey} build it`,
    work_keys: [rowKey],
    actor: "alex",
  };
}

describe("POST /api/v1/work-events (HTTP)", () => {
  it("applies a merge event and marks the matching task done", async () => {
    const seed = await seedTeam();
    const { key } = await issueKeyFor(seed, "team");
    await seedTask(seed, "W1.2.1");

    const res = await fetch(WORK_EVENTS, {
      method: "POST",
      headers: keyHeaders(key, seed.teamSlug),
      body: JSON.stringify(eventPayload("W1.2.1")),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.status).toBe("ok");
    expect(body.applied).toEqual([
      { row_key: "W1.2.1", task_id: body.applied[0]?.task_id },
    ]);
    expect(body.unresolved).toEqual([]);
    // The done path runs the brain→PM projection engine (lib/pm-sync/project). The test
    // team has no enabled PM integration, so projection reports missing_integration and
    // makes no external call — the task is still completed (asserted below).
    expect(body.pm_sync).toHaveLength(1);
    expect(body.pm_sync[0]).toMatchObject({
      row_key: "W1.2.1",
      status: "missing_integration",
    });

    const { data } = await db()
      .from("tasks")
      .select("status")
      .eq("team_id", seed.teamId)
      .eq("row_key", "W1.2.1")
      .single();
    expect((data as { status: string }).status).toBe("done");
  });

  it("rejects an external-tier key with 403 (work events are team-tier only)", async () => {
    const seed = await seedTeam();
    const { key } = await issueKeyFor(seed, "external");

    const res = await fetch(WORK_EVENTS, {
      method: "POST",
      headers: keyHeaders(key, seed.teamSlug),
      body: JSON.stringify(eventPayload("W1.2.1")),
    });
    expect(res.status).toBe(403);
    expect((await res.json()).error.code).toBe("forbidden_tier");
  });
});
