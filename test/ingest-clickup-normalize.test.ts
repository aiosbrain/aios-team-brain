import { describe, expect, it } from "vitest";
import { itemPayloadSchema, taskRowSchema } from "@/lib/api/schemas";
import type { ClickUpDoc, ClickUpDocPage, ClickUpTask, ClickUpTaskRecord } from "@/lib/ingest/sources/clickup";
import {
  ClickUpNormalizationError,
  clickUpDocIdentity,
  clickUpTaskIdentity,
  clickUpWorkedAt,
  normalizeClickUpDoc,
  normalizeClickUpTaskDocs,
  normalizeClickUpTasks,
  type ClickUpStatusMap,
} from "@/lib/ingest/sources/clickup-normalize";
import tasks101Page0 from "@/test/fixtures/clickup/synthetic-tasks-list-101-page-0.json";
import tasks101Page1 from "@/test/fixtures/clickup/synthetic-tasks-list-101-page-1.json";
import tasks202Page0 from "@/test/fixtures/clickup/synthetic-tasks-list-202-page-0.json";
import docAlpha from "@/test/fixtures/clickup/synthetic-doc-alpha.json";
import docAlphaPages from "@/test/fixtures/clickup/synthetic-doc-alpha-pages.json";

const list101Map: ClickUpStatusMap = {
  backlog: "backlog",
  ready: "to do",
  in_progress: "in progress",
  blocked: "blocked",
  done: "complete",
};

const list202Map: ClickUpStatusMap = {
  backlog: "intake",
  ready: "queued",
  in_progress: "doing",
  blocked: "waiting",
  done: "complete",
};

const records: ClickUpTaskRecord[] = [
  ...(tasks101Page0.tasks as ClickUpTask[]).map((task) => ({ task, observedListIds: ["101"] })),
  ...(tasks101Page1.tasks as ClickUpTask[]).map((task) => ({ task, observedListIds: ["101"] })),
  ...(tasks202Page0.tasks as ClickUpTask[]).map((task) => ({ task, observedListIds: ["202"] })),
];

const input = {
  workspaceId: 9001,
  records,
  statusMaps: { "101": list101Map, "202": list202Map },
};

describe("ClickUp task normalization", () => {
  it("de-duplicates native ids and emits stable task identities, hierarchy, dates, and provenance", () => {
    const payload = normalizeClickUpTasks(input);
    expect(() => itemPayloadSchema.parse(payload)).not.toThrow();
    expect(payload.kind).toBe("task");
    expect(payload.project).toBe("clickup-9001");
    expect(payload.path).toBe("clickup/9001/tasks.md");
    expect(payload.rows).toHaveLength(4);

    const rows = payload.rows as Array<Record<string, unknown>>;
    for (const row of rows) expect(() => taskRowSchema.parse(row)).not.toThrow();
    const byKey = Object.fromEntries(rows.map((row) => [row.row_key, row]));
    const parentKey = clickUpTaskIdentity(9001, "1001");
    const childKey = clickUpTaskIdentity(9001, 1002);
    expect(byKey[parentKey]).toMatchObject({
      title: "Plan the pilot",
      status: "ready",
      priority: "high",
      assignee: "Alex",
      sprint: "Pilot",
      due: new Date(1786600000000).toISOString(),
    });
    expect(byKey[childKey].parent).toBe(parentKey);
    expect(byKey[clickUpTaskIdentity(9001, "1003")]).toMatchObject({ status: "done", assignee: "" });
    expect(byKey[clickUpTaskIdentity(9001, "1004")]).toMatchObject({ status: "ready", priority: "none" });
    expect(payload.body).toContain('"custom_id":"PILOT-1"');
    expect(payload.body).toContain('"list_ids":["101","202"]');
  });

  it("is byte-idempotent across a repeated import and input ordering", () => {
    const first = normalizeClickUpTasks(input);
    const second = normalizeClickUpTasks({ ...input, records: [...records].reverse() });
    expect(second.body).toBe(first.body);
    expect(second.content_sha256).toBe(first.content_sha256);
  });

  it("uses native id, never custom id, for identity", () => {
    expect(clickUpTaskIdentity(9001, "1001")).toBe("clickup:9001:task:1001");
    expect(clickUpTaskIdentity(9001, "1001")).not.toContain("PILOT-1");
  });

  it("requires a reversible mapping and refuses ambiguous TIML status resolution", () => {
    const duplicateNativeNames = { ...list101Map, done: "to do" };
    expect(() =>
      normalizeClickUpTasks({
        workspaceId: 9001,
        records: [records[0]],
        statusMaps: { "101": duplicateNativeNames },
      })
    ).toThrow(ClickUpNormalizationError);

    const ambiguous: ClickUpTaskRecord = {
      task: { ...records[0].task, list: undefined, status: { status: "to do" } },
      observedListIds: ["101", "202"],
    };
    expect(() =>
      normalizeClickUpTasks({
        workspaceId: 9001,
        records: [ambiguous],
        statusMaps: { "101": list101Map, "202": { ...list202Map, blocked: "to do", ready: "queued" } },
      })
    ).toThrow(/ambiguously/);
  });

  it("uses the selected home List mapping before additional TIML List mappings", () => {
    const record: ClickUpTaskRecord = {
      task: { ...records[0].task, status: { status: "to do" } },
      observedListIds: ["101", "202"],
    };
    const payload = normalizeClickUpTasks({
      workspaceId: 9001,
      records: [record],
      statusMaps: {
        "101": list101Map,
        "202": { ...list202Map, blocked: "to do", ready: "queued" },
      },
    });
    expect((payload.rows as Array<Record<string, unknown>>)[0].status).toBe("ready");
  });

  it("uses only completion/closure transitions as worked_at", () => {
    expect(clickUpWorkedAt(records[0].task)).toBe("");
    expect(clickUpWorkedAt({ id: "empty", date_done: "", date_closed: "" })).toBe("");
    expect(clickUpWorkedAt(records[2].task)).toBe(new Date(1786000600000).toISOString());
  });

  it("emits searchable task documents with native metadata", () => {
    const docs = normalizeClickUpTaskDocs(input);
    expect(docs).toHaveLength(4);
    for (const doc of docs) expect(() => itemPayloadSchema.parse(doc)).not.toThrow();
    const first = docs.find((doc) => doc.frontmatter.native_id === "1001")!;
    expect(first.path).toBe("clickup/9001/tasks/1001.md");
    expect(first.body).toContain("Define the read-only pilot scope.");
    expect(first.frontmatter).toMatchObject({
      identity: "clickup:9001:task:1001",
      custom_id: "PILOT-1",
      list_id: "101",
      status: "ready",
    });
  });
});

describe("ClickUp Doc normalization", () => {
  it("emits one transcript in API hierarchy/order with source-provided edit time", () => {
    const payload = normalizeClickUpDoc(9001, {
      doc: docAlpha as ClickUpDoc,
      pages: docAlphaPages as ClickUpDocPage[],
    });

    expect(() => itemPayloadSchema.parse(payload)).not.toThrow();
    expect(payload.kind).toBe("transcript");
    expect(payload.project).toBe("clickup-9001");
    expect(payload.path).toBe("clickup/9001/docs/doc-alpha.md");
    expect(payload.frontmatter).toMatchObject({
      source: "clickup",
      identity: clickUpDocIdentity(9001, "doc-alpha"),
      doc_id: "doc-alpha",
      page_ids: ["page-agenda", "page-decisions", "page-actions"],
      source_ts: new Date(1786000300000).toISOString(),
      creator_id: "7",
      editor_ids: ["7", "8"],
      content_format: "text/md",
    });
    expect(payload.body.indexOf("## Agenda")).toBeLessThan(payload.body.indexOf("### Decisions"));
    expect(payload.body.indexOf("### Decisions")).toBeLessThan(payload.body.indexOf("## Action items"));
    expect(payload.body).toContain("Proceed with the read-only pilot.");
  });

  it("updates the same stable item when a page body changes", () => {
    const before = normalizeClickUpDoc(9001, {
      doc: docAlpha as ClickUpDoc,
      pages: docAlphaPages as ClickUpDocPage[],
    });
    const changedPages = structuredClone(docAlphaPages) as ClickUpDocPage[];
    changedPages[0].pages![0].content = "A changed decision.";
    const after = normalizeClickUpDoc(9001, { doc: docAlpha as ClickUpDoc, pages: changedPages });
    expect(after.path).toBe(before.path);
    expect(after.frontmatter.identity).toBe(before.frontmatter.identity);
    expect(after.content_sha256).not.toBe(before.content_sha256);
  });
});
