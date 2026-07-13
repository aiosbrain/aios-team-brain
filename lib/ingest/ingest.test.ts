import { describe, expect, it } from "vitest";
import type { DbClient } from "@/lib/db/types";
import { ingestItem } from "@/lib/ingest";
import { FakeSupabase } from "@/lib/ingest/fake-supabase";
import { IngestValidationError } from "@/lib/api/schemas";
import type { ItemPayload } from "@/lib/api/schemas";

/**
 * lib/ingest is the SOLE service-role writer (bypasses RLS entirely — CLAUDE.md §5). There is
 * no DB-level tier backstop, so every claim this file makes about tier tagging, diff-sync, and
 * validation is a security-load-bearing spec, not incidental behavior. These tests extend the
 * dedup + basic diff-sync coverage above with: tier tagging through materialization, malformed
 * payload rejection, idempotent re-push, and more diff-sync edge cases (update-in-place, dangling
 * parent nulling, partial-write preserve/clear semantics).
 */

const AUTH = { teamId: "team-1", memberId: "mem-1", apiKeyId: "key-1" };

function payload(over: Partial<ItemPayload> = {}): ItemPayload {
  return {
    project: "acme",
    path: "github/o/r/x.md",
    kind: "deliverable",
    content_sha256: "a".repeat(64),
    access: "team",
    actor: "github-sync",
    frontmatter: {},
    body: "hello",
    ...over,
  } as ItemPayload;
}

describe("ingestItem dedup", () => {
  it("returns 'unchanged' on identical sha and writes no new version", async () => {
    const fake = new FakeSupabase();
    const supa = fake as unknown as DbClient;

    const first = await ingestItem(supa, AUTH, payload(), "team");
    expect(first.status).toBe("created");
    expect(fake.tables.item_versions).toHaveLength(1);

    const second = await ingestItem(supa, AUTH, payload(), "team");
    expect(second.status).toBe("unchanged");
    expect(second.id).toBe(first.id);
    expect(fake.tables.item_versions).toHaveLength(1); // no new version on no-op
  });

  it("returns 'updated' and versions when the body (sha) changes", async () => {
    const fake = new FakeSupabase();
    const supa = fake as unknown as DbClient;
    await ingestItem(supa, AUTH, payload(), "team");
    const res = await ingestItem(
      supa,
      AUTH,
      payload({ body: "changed", content_sha256: "b".repeat(64) }),
      "team"
    );
    expect(res.status).toBe("updated");
    expect(fake.tables.item_versions).toHaveLength(2);
    expect(fake.tables.items).toHaveLength(1);
  });
});

describe("ingestItem task diff-sync", () => {
  it("deletes sync rows absent from the push but preserves UI-created rows", async () => {
    const fake = new FakeSupabase();
    const supa = fake as unknown as DbClient;

    // First push establishes T-1 and T-2 as sync-origin tasks.
    await ingestItem(
      supa,
      AUTH,
      payload({
        kind: "task",
        path: "github/o/r/tasks.md",
        content_sha256: "c".repeat(64),
        rows: [
          { row_key: "T-1", title: "first" },
          { row_key: "T-2", title: "second" },
        ],
      }),
      "team"
    );
    // Simulate a UI-created task (origin 'ui') that must survive pushes.
    fake.tables.tasks.push({
      id: "ui-task",
      team_id: AUTH.teamId,
      project_id: fake.tables.projects[0].id,
      row_key: "U-1",
      title: "ui task",
      origin: "ui",
    });

    // Second push drops T-2.
    await ingestItem(
      supa,
      AUTH,
      payload({
        kind: "task",
        path: "github/o/r/tasks.md",
        content_sha256: "d".repeat(64),
        rows: [{ row_key: "T-1", title: "first (edited)" }],
      }),
      "team"
    );

    const keys = fake.tables.tasks.map((t) => t.row_key).sort();
    expect(keys).toEqual(["T-1", "U-1"]); // T-2 removed, U-1 preserved
    expect(fake.tables.tasks.find((t) => t.row_key === "T-1")?.title).toBe("first (edited)");
  });

  it("updates an existing row's fields in place rather than duplicating it", async () => {
    const fake = new FakeSupabase();
    const supa = fake as unknown as DbClient;
    await ingestItem(
      supa,
      AUTH,
      payload({
        kind: "task",
        path: "b.md",
        content_sha256: "e".repeat(64),
        rows: [{ row_key: "T-1", title: "v1", status: "backlog" }],
      }),
      "team"
    );
    const firstId = fake.tables.tasks[0].id;

    await ingestItem(
      supa,
      AUTH,
      payload({
        kind: "task",
        path: "b.md",
        content_sha256: "f".repeat(64),
        rows: [{ row_key: "T-1", title: "v2", status: "in_progress" }],
      }),
      "team"
    );

    expect(fake.tables.tasks).toHaveLength(1); // no duplicate row
    expect(fake.tables.tasks[0].id).toBe(firstId); // same row, updated
    expect(fake.tables.tasks[0].title).toBe("v2");
    expect(fake.tables.tasks[0].status).toBe("in_progress");
  });

  it("nulls a dangling parent_row_key when the parent row is dropped from a later push", async () => {
    const fake = new FakeSupabase();
    const supa = fake as unknown as DbClient;
    await ingestItem(
      supa,
      AUTH,
      payload({
        kind: "task",
        path: "b.md",
        content_sha256: "1".repeat(64),
        rows: [
          { row_key: "EPIC-1", title: "epic" },
          { row_key: "T-1", title: "child", parent: "EPIC-1" },
        ],
      }),
      "team"
    );
    expect(fake.tables.tasks.find((t) => t.row_key === "T-1")?.parent_row_key).toBe("EPIC-1");

    // Next push drops the epic; the child survives (still referenced by row_key) but its parent
    // is gone, so the dangling reference must be nulled rather than left pointing at nothing.
    await ingestItem(
      supa,
      AUTH,
      payload({
        kind: "task",
        path: "b.md",
        content_sha256: "2".repeat(64),
        rows: [{ row_key: "T-1", title: "child", parent: "EPIC-1" }],
      }),
      "team"
    );

    const keys = fake.tables.tasks.map((t) => t.row_key).sort();
    expect(keys).toEqual(["T-1"]); // EPIC-1 removed (sync-origin, absent from push)
    expect(fake.tables.tasks.find((t) => t.row_key === "T-1")?.parent_row_key).toBeNull();
  });

  it("preserves assignee/parent/labels/priority when the key is OMITTED, but clears it when present-and-empty", async () => {
    const fake = new FakeSupabase();
    const supa = fake as unknown as DbClient;
    await ingestItem(
      supa,
      AUTH,
      payload({
        kind: "task",
        path: "b.md",
        content_sha256: "3".repeat(64),
        rows: [
          { row_key: "T-1", title: "t", assignee: "alice", labels: ["urgent"], priority: "high" },
        ],
      }),
      "team"
    );
    expect(fake.tables.tasks[0].assignee).toBe("alice");

    // Re-push omitting assignee/labels/priority entirely: preserved, not reset to defaults.
    await ingestItem(
      supa,
      AUTH,
      payload({
        kind: "task",
        path: "b.md",
        content_sha256: "4".repeat(64),
        rows: [{ row_key: "T-1", title: "t (renamed)" }],
      }),
      "team"
    );
    expect(fake.tables.tasks[0].assignee).toBe("alice");
    expect(fake.tables.tasks[0].labels).toEqual(["urgent"]);
    expect(fake.tables.tasks[0].priority).toBe("high");
    expect(fake.tables.tasks[0].title).toBe("t (renamed)");

    // Re-push with assignee explicitly present-but-empty: authoritative clear, not preserved.
    await ingestItem(
      supa,
      AUTH,
      payload({
        kind: "task",
        path: "b.md",
        content_sha256: "5".repeat(64),
        rows: [{ row_key: "T-1", title: "t (renamed)", assignee: "" }],
      }),
      "team"
    );
    expect(fake.tables.tasks[0].assignee).toBe("");
  });
});

describe("ingestItem idempotent re-push", () => {
  it("re-pushing an identical task board twice is a no-op on the second push (same sha)", async () => {
    const fake = new FakeSupabase();
    const supa = fake as unknown as DbClient;
    const rows = [{ row_key: "T-1", title: "first" }];

    const first = await ingestItem(
      supa,
      AUTH,
      payload({ kind: "task", path: "b.md", content_sha256: "a".repeat(64), rows }),
      "team"
    );
    expect(first.status).toBe("created");
    expect(fake.tables.tasks).toHaveLength(1);
    const taskId = fake.tables.tasks[0].id;

    // Same content_sha256 as the first push ⇒ the item-level dedup fast-path fires; the rows
    // materialization is not even re-run (see index.ts step 2's early return).
    const second = await ingestItem(
      supa,
      AUTH,
      payload({ kind: "task", path: "b.md", content_sha256: "a".repeat(64), rows }),
      "team"
    );
    expect(second.status).toBe("unchanged");
    expect(fake.tables.tasks).toHaveLength(1);
    expect(fake.tables.tasks[0].id).toBe(taskId);
  });

  it("re-pushing the SAME rows under a new sha (e.g. a touched comment/whitespace) is stable — no duplication", async () => {
    const fake = new FakeSupabase();
    const supa = fake as unknown as DbClient;
    const rows = [
      { row_key: "T-1", title: "first" },
      { row_key: "T-2", title: "second" },
    ];
    await ingestItem(
      supa,
      AUTH,
      payload({ kind: "task", path: "b.md", content_sha256: "a".repeat(64), rows }),
      "team"
    );
    // A different sha (body changed elsewhere) but identical row set re-materializes; row_key is
    // the diff-sync identity, so re-processing the same rows must not create duplicates.
    await ingestItem(
      supa,
      AUTH,
      payload({ kind: "task", path: "b.md", content_sha256: "b".repeat(64), rows }),
      "team"
    );
    expect(fake.tables.tasks).toHaveLength(2);
    expect(fake.tables.tasks.map((t) => t.row_key).sort()).toEqual(["T-1", "T-2"]);
  });
});

describe("ingestItem tier tagging preserved through materialization", () => {
  it("task rows inherit the item's access tier into tasks.audience", async () => {
    const fake = new FakeSupabase();
    const supa = fake as unknown as DbClient;

    await ingestItem(
      supa,
      AUTH,
      payload({
        kind: "task",
        path: "external-board.md",
        content_sha256: "a".repeat(64),
        access: "external",
        rows: [{ row_key: "T-1", title: "client-visible task" }],
      }),
      "external"
    );
    expect(fake.tables.tasks[0].audience).toBe("external");

    await ingestItem(
      supa,
      AUTH,
      payload({
        kind: "task",
        path: "internal-board.md",
        content_sha256: "b".repeat(64),
        access: "team",
        rows: [{ row_key: "T-2", title: "internal task" }],
      }),
      "team"
    );
    const internal = fake.tables.tasks.find((t) => t.row_key === "T-2");
    expect(internal?.audience).toBe("team");
  });

  // SURPRISING (report, don't fix): unlike tasks, decisions do NOT inherit the item's access tier.
  // materializeDecisions() never receives the item's `access` — each decision row's audience comes
  // solely from decisionRowSchema's own `audience` field (default "team"), regardless of what
  // access tier the parent item was pushed at. Pushing an item at access=external with a decision
  // table that omits an explicit `audience` column silently produces a team-only decision — the
  // opposite direction of a leak (under-sharing), but a real inconsistency with the task path.
  it("decision rows default to audience=team regardless of the item's access, unless the row sets its own audience", async () => {
    const fake = new FakeSupabase();
    const supa = fake as unknown as DbClient;

    await ingestItem(
      supa,
      AUTH,
      payload({
        kind: "decision",
        path: "external-decisions.md",
        content_sha256: "c".repeat(64),
        access: "external",
        rows: [{ row_key: "D-1", title: "no audience column set" }],
      }),
      "external"
    );
    expect(fake.tables.decisions[0].audience).toBe("team"); // NOT "external" — see note above

    await ingestItem(
      supa,
      AUTH,
      payload({
        kind: "decision",
        path: "team-decisions.md",
        content_sha256: "d".repeat(64),
        access: "team",
        rows: [{ row_key: "D-2", title: "row opts into external", audience: "external" }],
      }),
      "team"
    );
    const d2 = fake.tables.decisions.find((d) => d.row_key === "D-2");
    // A row can set audience=external even though the parent item is team-access — a per-row
    // override with no cross-check against the item's own access tier.
    expect(d2?.audience).toBe("external");
  });
});

describe("ingestItem malformed payload handling", () => {
  it("rejects a task row missing the required title with IngestValidationError (422 upstream)", async () => {
    const fake = new FakeSupabase();
    const supa = fake as unknown as DbClient;
    await expect(
      ingestItem(
        supa,
        AUTH,
        payload({
          kind: "task",
          path: "b.md",
          content_sha256: "a".repeat(64),
          rows: [{ row_key: "T-1" }], // missing required `title`
        }),
        "team"
      )
    ).rejects.toThrow(IngestValidationError);
  });

  it("rejects a task row whose parent references itself", async () => {
    const fake = new FakeSupabase();
    const supa = fake as unknown as DbClient;
    await expect(
      ingestItem(
        supa,
        AUTH,
        payload({
          kind: "task",
          path: "b.md",
          content_sha256: "a".repeat(64),
          rows: [{ row_key: "T-1", title: "t", parent: "T-1" }],
        }),
        "team"
      )
    ).rejects.toThrow(/parent cannot reference itself/);
  });

  it("rejects a task row whose parent is not found in the project (neither incoming nor existing)", async () => {
    const fake = new FakeSupabase();
    const supa = fake as unknown as DbClient;
    await expect(
      ingestItem(
        supa,
        AUTH,
        payload({
          kind: "task",
          path: "b.md",
          content_sha256: "a".repeat(64),
          rows: [{ row_key: "T-1", title: "t", parent: "GHOST-1" }],
        }),
        "team"
      )
    ).rejects.toThrow(/not found in project/);
  });

  it("rejects a parent cycle across two rows in the same push", async () => {
    const fake = new FakeSupabase();
    const supa = fake as unknown as DbClient;
    await expect(
      ingestItem(
        supa,
        AUTH,
        payload({
          kind: "task",
          path: "b.md",
          content_sha256: "a".repeat(64),
          rows: [
            { row_key: "A", title: "a", parent: "B" },
            { row_key: "B", title: "b", parent: "A" },
          ],
        }),
        "team"
      )
    ).rejects.toThrow(/parent cycle detected/);
  });

  it("a 422-worthy row rejection leaves NO partial write behind (validated before any item/row mutation)", async () => {
    const fake = new FakeSupabase();
    const supa = fake as unknown as DbClient;
    await expect(
      ingestItem(
        supa,
        AUTH,
        payload({
          kind: "task",
          path: "b.md",
          content_sha256: "a".repeat(64),
          rows: [
            { row_key: "T-1", title: "good" },
            { row_key: "T-2", title: "bad", parent: "T-2" }, // self-reference, invalid
          ],
        }),
        "team"
      )
    ).rejects.toThrow(IngestValidationError);

    // Neither the item nor any task row was written — validation runs before any mutation.
    expect(fake.tables.items).toHaveLength(0);
    expect(fake.tables.tasks).toHaveLength(0);
  });
});
