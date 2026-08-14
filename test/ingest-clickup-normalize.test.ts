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
import { sourceRules } from "@/lib/ingest/source-rules";
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

  it("deterministically caps native tags at the task schema label limit", () => {
    const record: ClickUpTaskRecord = {
      task: {
        ...records[0].task,
        tags: Array.from({ length: 60 }, (_, index) => ({ name: `tag-${String(index).padStart(2, "0")}` })),
      },
      observedListIds: ["101"],
    };
    const payload = normalizeClickUpTasks({
      workspaceId: 9001,
      records: [record],
      statusMaps: { "101": list101Map },
    });
    const row = (payload.rows as Array<Record<string, unknown>>)[0];
    expect(() => taskRowSchema.parse(row)).not.toThrow();
    expect(row.labels).toEqual(Array.from({ length: 50 }, (_, index) => `tag-${String(index).padStart(2, "0")}`));
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

  it("keeps its ticket documents out of the timeline's evidence lane", () => {
    // The timeline gate is `str(fm.identifier) && sourceRules(source).emitsTicketDocuments`
    // (lib/dashboard/work-timeline.ts). BOTH halves have to hold or a workspace of N tasks pushes N
    // ticket documents into every assignee's day and the timeline becomes a backlog dump. Asserting
    // the two together, because either one alone passes while the behaviour stays broken.
    expect(sourceRules("clickup").emitsTicketDocuments).toBe(true);
    for (const doc of normalizeClickUpTaskDocs(input)) {
      expect(String(doc.frontmatter.identifier ?? "")).not.toBe("");
    }
  });

  it("prefers the custom id as the ticket key and falls back to the native id", () => {
    const docs = normalizeClickUpTaskDocs(input);
    expect(docs.find((doc) => doc.frontmatter.native_id === "1001")!.frontmatter.identifier).toBe("PILOT-1");
    // A Space without custom ids must still yield a non-empty key — an empty one silently fails the gate.
    const noCustomId = normalizeClickUpTaskDocs({
      ...input,
      records: [{ task: { ...records[0].task, custom_id: null }, observedListIds: ["101"] }],
    });
    expect(noCustomId[0].frontmatter.identifier).toBe(String(records[0].task.id));
  });

  it("truncates row fields to their strict schema bounds instead of rejecting the batch", () => {
    // One over-long ClickUp name would 422 the WHOLE workspace payload, since every task ships as one
    // item through a strict parser. ClickUp permits a 255-char List name; `sprint` stops at 200.
    const record: ClickUpTaskRecord = {
      task: {
        ...records[0].task,
        name: "n".repeat(2500),
        list: { id: "101", name: "L".repeat(255) },
        assignees: [{ id: 1, username: "u".repeat(300) }],
      },
      observedListIds: ["101"],
    };
    const payload = normalizeClickUpTasks({ workspaceId: 9001, records: [record], statusMaps: { "101": list101Map } });
    const row = (payload.rows as Array<Record<string, unknown>>)[0];
    expect(() => taskRowSchema.parse(row)).not.toThrow();
    expect(() => itemPayloadSchema.parse(payload)).not.toThrow();
    expect((row.title as string).length).toBe(2000);
    expect((row.sprint as string).length).toBe(200);
    expect((row.assignee as string).length).toBe(200);
  });

  it("degrades an out-of-range timestamp to no work-time rather than aborting the import", () => {
    // A third-party ClickUp integration writing a NANOSECOND epoch into `date_done` is finite but
    // past the ±8.64e15 ms Date range, so `toISOString()` threw RangeError — taking down every task
    // in the workspace, not the one field. (A microsecond epoch stays in range and merely dates the
    // task to year 58566; that is a different, non-fatal problem and is not what this guards.)
    const nanoseconds = "1786000600000000000";
    expect(clickUpWorkedAt({ id: "overflow", date_done: nanoseconds })).toBe("");

    const record: ClickUpTaskRecord = {
      task: { ...records[0].task, date_done: nanoseconds, date_updated: nanoseconds },
      observedListIds: ["101"],
    };
    const payload = normalizeClickUpTasks({ workspaceId: 9001, records: [record], statusMaps: { "101": list101Map } });
    expect(() => itemPayloadSchema.parse(payload)).not.toThrow();
    expect((payload.rows as Array<Record<string, unknown>>)[0].worked_at).toBe("");
  });

  it("reads ClickUp's 0 as an unset date, not as the Unix epoch", () => {
    // ClickUp writes 0 for "no date". Taken literally it dated closed tasks to 1970-01-01 — which the
    // timeline reads as a real work-time — and put `due` in 1970.
    expect(clickUpWorkedAt({ id: "unset", date_done: 0, date_closed: "0" })).toBe("");
    const record: ClickUpTaskRecord = {
      task: { ...records[0].task, date_done: 0, due_date: 0 },
      observedListIds: ["101"],
    };
    const payload = normalizeClickUpTasks({ workspaceId: 9001, records: [record], statusMaps: { "101": list101Map } });
    const row = (payload.rows as Array<Record<string, unknown>>)[0];
    expect(row.worked_at).toBe("");
    expect(row.due).toBeNull();
  });

  it("never truncates a title onto a lone surrogate half", () => {
    // `slice` cuts UTF-16 units, so an emoji straddling the bound leaves an orphan that the UTF-8
    // round-trip into Postgres replaces with U+FFFD.
    const record: ClickUpTaskRecord = {
      task: { ...records[0].task, name: `${"n".repeat(1999)}😀${"n".repeat(100)}` },
      observedListIds: ["101"],
    };
    const payload = normalizeClickUpTasks({ workspaceId: 9001, records: [record], statusMaps: { "101": list101Map } });
    const title = (payload.rows as Array<Record<string, unknown>>)[0].title as string;
    expect(title.length).toBeLessThanOrEqual(2000);
    expect(Buffer.from(title, "utf8").toString("utf8")).toBe(title);
    expect(/[\ud800-\udbff]$/.test(title)).toBe(false);
  });

  it("names the status and the Lists consulted when a native status is unmapped", () => {
    // Fail-closed is deliberate, but the blast radius is the whole workspace — so the message has to
    // carry enough to act on, or "all ClickUp tasks stopped importing" has nothing in it to fix.
    const record: ClickUpTaskRecord = {
      task: { ...records[0].task, status: { status: "In Review" } },
      observedListIds: ["101"],
    };
    expect(() =>
      normalizeClickUpTasks({ workspaceId: 9001, records: [record], statusMaps: { "101": list101Map } })
    ).toThrow(/In Review.*consulted: 101/);
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

  it("de-duplicates editors across ClickUp's mixed number/string user ids", () => {
    // ClickUp returns the same user as 7 and "7" (the doc-alpha fixture mixes both). De-duplicating
    // before coercion kept both, so a re-sync where the representation flips rewrote the frontmatter
    // with no real edit.
    const pages = structuredClone(docAlphaPages) as ClickUpDocPage[];
    pages[0].edited_by = 7;
    pages[0].pages![0].edited_by = "7";
    pages[1].edited_by = "7";
    const payload = normalizeClickUpDoc(9001, { doc: docAlpha as ClickUpDoc, pages });
    expect(payload.frontmatter.editor_ids).toEqual(["7"]);
  });

  it("re-bases surviving descendants of a deleted page instead of orphaning them", () => {
    // A deleted page emits no heading and no page_ids entry, so a live child used to render as an
    // orphan `###` under no `##`, listed under a parent absent from the document.
    const pages = structuredClone(docAlphaPages) as ClickUpDocPage[];
    pages[0].deleted = true;
    const payload = normalizeClickUpDoc(9001, { doc: docAlpha as ClickUpDoc, pages });

    expect(payload.frontmatter.page_ids).toEqual(["page-decisions", "page-actions"]);
    expect(payload.body).toContain("## Decisions");
    expect(payload.body).not.toContain("### Decisions");
    expect(payload.body).not.toContain("Agenda");
  });

  it("survives an out-of-range page timestamp instead of aborting the Doc batch", () => {
    // NOT a regression test — it passes with or without routing `docSourceTimestamp` through
    // `isoFromMilliseconds`, because `timestampMs` already rejects out-of-range values upstream. It
    // pins the OUTCOME so the guarantee survives a future caller that reaches the helper another way;
    // the routing itself restores the invariant asserted on `isoFromMilliseconds`, which was false.
    const pages = structuredClone(docAlphaPages) as ClickUpDocPage[];
    pages[0].date_edited = "1786000600000000000";
    pages[0].date_updated = "1786000600000000000";
    const payload = normalizeClickUpDoc(9001, { doc: docAlpha as ClickUpDoc, pages });
    expect(() => itemPayloadSchema.parse(payload)).not.toThrow();
    // The surviving in-range page edits still set the timestamp.
    expect(payload.frontmatter.source_ts).toBe(new Date(1786000300000).toISOString());
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
