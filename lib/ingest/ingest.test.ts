import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { ingestItem } from "@/lib/ingest";
import { FakeSupabase } from "@/lib/ingest/fake-supabase";
import type { ItemPayload } from "@/lib/api/schemas";

const AUTH = { teamId: "team-1", memberId: "mem-1", apiKeyId: "key-1" };

function db() {
  return new FakeSupabase() as unknown as SupabaseClient;
}

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
    const supa = fake as unknown as SupabaseClient;

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
    const supa = fake as unknown as SupabaseClient;
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
    const supa = fake as unknown as SupabaseClient;

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
});
