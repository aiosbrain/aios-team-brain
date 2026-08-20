import { describe, expect, it } from "vitest";
import { itemPayloadSchema, taskRowSchema } from "@/lib/api/schemas";
import { MAX_PAYLOAD_ROWS as MAX_ROWS, wireItemPayloadSchema } from "@/lib/api/item-payload-schema";
import { parseAuthorRefs, primaryAuthorRef } from "@/lib/attribution/resolve-authors";
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
import { classifyWork } from "@/lib/dashboard/work-classification";
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

  it("emits authors[] that the source-agnostic attribution resolver actually reads", () => {
    // AIO-924. `taskMetadata` stamps `assignee_ids`/`assignee_emails` (PLURAL), but nothing consumes
    // them: `parseAuthorRefs` handles `assignee_id` (SINGULAR) for linear/plane only, and there is no
    // `clickup` branch at all — so every ClickUp task document resolved to ZERO author refs and the
    // work landed unattributed, with every existing test still green because none of them crossed the
    // normalizer→resolver seam. Asserting through `parseAuthorRefs` is the point: an assertion on the
    // normalizer's own output shape is exactly what let this ship.
    const docs = normalizeClickUpTaskDocs(input);
    const assigned = docs.find((doc) => doc.frontmatter.native_id === "1001")!;

    const refs = parseAuthorRefs(assigned.frontmatter);
    expect(refs).not.toHaveLength(0);
    expect(refs).toContainEqual({
      role: "assignee",
      provider: "clickup",
      externalId: "7",
      email: "alex@example.invalid",
      displayName: "Alex",
      handle: undefined,
    });
    // The plural provenance keys stay — `authors[]` is additive, not a replacement.
    expect(assigned.frontmatter.assignee_ids).toEqual(["7"]);

    // Multi-assignee is carried in full: the singular `assignee_id` the other connectors use could
    // only ever have named one of them.
    const multi = normalizeClickUpTaskDocs({
      ...input,
      records: [
        {
          task: {
            ...records[0].task,
            assignees: [
              { id: 7, username: "Alex", email: "alex@example.invalid" },
              { id: 9, username: "Robin", email: "robin@example.invalid" },
            ],
          },
          observedListIds: ["101"],
        },
      ],
    });
    expect(parseAuthorRefs(multi[0].frontmatter).map((ref) => ref.externalId)).toEqual(["7", "9"]);

    // An unassigned task claims nobody — an empty `authors[]` must not invent an author.
    const unassigned = docs.find((doc) => doc.frontmatter.native_id === "1002")!;
    expect(parseAuthorRefs(unassigned.frontmatter)).toHaveLength(0);
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

  it("keeps a large workspace under the body bound with every row still present", () => {
    // The workspace is ONE item and `body` is capped at 1,000,000 chars, so ~1,400 tasks used to 422
    // the payload and import NOTHING. Chunking isn't available (lib/ingest/tasks.ts deletes every
    // synced row in the project that the incoming item omits, so chunk 2 would delete chunk 1), so
    // `rows` stays complete and only the body detail is bounded.
    const many: ClickUpTaskRecord[] = Array.from({ length: 4000 }, (_, index) => ({
      task: { ...records[0].task, id: `big-${index}`, custom_id: null, parent: null, name: `Task ${index}` },
      observedListIds: ["101"],
    }));
    const payload = normalizeClickUpTasks({ workspaceId: 9001, records: many, statusMaps: { "101": list101Map } });

    expect(() => itemPayloadSchema.parse(payload)).not.toThrow();
    expect(payload.body.length).toBeLessThanOrEqual(1_000_000);
    expect(payload.rows).toHaveLength(4000);
    expect(payload.frontmatter.task_count).toBe(4000);
    expect(payload.frontmatter.detail_truncated).toBe(true);
    // Truncation must be declared, not silent.
    expect(payload.frontmatter.detail_count).toBeLessThan(4000);
  });

  it("names the row limit instead of failing a 5,001-task workspace as an opaque transport error", () => {
    // AIO-923. `rows` used to be unbounded, so the ONLY thing that stopped an over-large workspace was
    // the transport gate on `content-length` — a bare `413 payload_too_large / "max 1 MB"` that names
    // no field and no limit, firing at ~1,100 tasks. Client-side chunking is not the escape hatch (the
    // row sweep in lib/ingest/tasks.ts deletes every synced row the incoming item omits, so chunk 2
    // deletes chunk 1), so the bound has to be a SERVER-side one that says what it is.
    const workspaceOf = (count: number) =>
      normalizeClickUpTasks({
        workspaceId: 9001,
        statusMaps: { "101": list101Map },
        records: Array.from({ length: count }, (_, index) => ({
          task: { ...records[0].task, id: `big-${index}`, custom_id: null, parent: null, name: `Task ${index}` },
          observedListIds: ["101"],
        })),
      });

    // The documented ceiling itself still parses — the cap must not shrink the supported workspace.
    expect(() => wireItemPayloadSchema.parse(workspaceOf(MAX_ROWS))).not.toThrow();

    const parsed = wireItemPayloadSchema.safeParse(workspaceOf(MAX_ROWS + 1));
    expect(parsed.success).toBe(false);
    // The bound is on the WIRE schema only: `itemPayloadSchema` (what `ingestItem` re-parses) stays
    // uncapped so the in-process Linear/GitHub/Plane mirrors keep working — see
    // test/guards/wire-vs-storage-payload-schema.test.ts. route.ts surfaces `issues[0].message`
    // verbatim as a 422 `invalid_payload`, so the limit has to be IN that message.
    expect(parsed.error!.issues[0].message).toContain(String(MAX_ROWS));
  });

  it("advances the item sha when a task the body omitted changes", () => {
    // The digest covers EVERY line including the dropped tail, so idempotency survives truncation: a
    // change beyond the body cut still moves content_sha256, and an identical replay still doesn't.
    const many = (suffix: string): ClickUpTaskRecord[] =>
      Array.from({ length: 4000 }, (_, index) => ({
        task: {
          ...records[0].task,
          id: `big-${index}`,
          custom_id: null,
          parent: null,
          name: index === 3999 ? `Task ${index}${suffix}` : `Task ${index}`,
        },
        observedListIds: ["101"],
      }));
    const base = normalizeClickUpTasks({ workspaceId: 9001, records: many(""), statusMaps: { "101": list101Map } });
    const replay = normalizeClickUpTasks({ workspaceId: 9001, records: many(""), statusMaps: { "101": list101Map } });
    const edited = normalizeClickUpTasks({ workspaceId: 9001, records: many(" edited"), statusMaps: { "101": list101Map } });

    expect(replay.content_sha256).toBe(base.content_sha256);
    expect(edited.content_sha256).not.toBe(base.content_sha256);
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
  it("emits one deliverable in API hierarchy/order with source-provided edit time", () => {
    const payload = normalizeClickUpDoc(9001, {
      doc: docAlpha as ClickUpDoc,
      pages: docAlphaPages as ClickUpDocPage[],
    });

    expect(() => itemPayloadSchema.parse(payload)).not.toThrow();
    // DELIVERABLE, not transcript: work-timeline drops every transcript before the ticket-document
    // gate and classifyWork calls a non-Slack transcript `signal`, so a Doc shipped as a transcript
    // earned no rollup or timeline credit at all. Documents are deliverables (see the sidecar's
    // DEFAULT_KIND_BY_SOURCE: gdrive, notion and confluence all are).
    expect(payload.kind).toBe("deliverable");
    expect(classifyWork(payload.kind, "clickup")).toBe("work");
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

  it("emits authors[] the resolver reads, creator ranked above editors", () => {
    // AIO-924, Doc half: `creator_id`/`editor_ids` were provenance nothing consumed, so a team writing
    // its specs in ClickUp Docs got zero attribution for them. Asserting through `parseAuthorRefs` and
    // `primaryAuthorRef` — the resolver's OWN ordering — rather than the raw frontmatter, which is the
    // assertion that stayed green while the behaviour was broken.
    const payload = normalizeClickUpDoc(9001, {
      doc: docAlpha as ClickUpDoc,
      pages: docAlphaPages as ClickUpDocPage[],
    });
    const refs = parseAuthorRefs(payload.frontmatter);

    // creator 7 once (not repeated as an editor) + editor 8.
    expect(refs.map((ref) => `${ref.role}:${ref.externalId}`)).toEqual(["creator:7", "editor:8"]);
    for (const ref of refs) expect(ref.provider).toBe("clickup");
    // The Doc's author is whoever wrote it, not whoever last touched a page.
    expect(primaryAuthorRef(refs)).toMatchObject({ role: "creator", externalId: "7" });
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

// ── brain-api v1.21 (AIO-950): `in_review` in the reversible List status map ──────────────────────
//
// `in_review` is the ONE optional member of `ClickUpStatusMap`. That asymmetry is deliberate and it
// needs proving in BOTH directions, because each direction has its own way to break:
//   • OMITTED — every status map saved before 1.21 lacks the key. `invertStatusMap` is fail-closed and
//     throws on a missing mapping, and `resolveStatus` runs inside `rows.map`, so a required key would
//     not degrade gracefully: it would take down the ENTIRE ClickUp workspace import on upgrade.
//   • PRESENT — if the optionality were implemented by skipping the member outright rather than by
//     skipping it only when absent, a List that DOES define an In Review state would silently never
//     resolve onto `in_review`, and the fail-closed branch would reject those tasks instead.
describe("ClickUp status map — the optional in_review member (brain-api v1.21)", () => {
  const listId = "101";
  const taskWithStatus = (status: string): ClickUpTaskRecord => ({
    task: { ...records[0].task, id: "5150", status: { status } } as ClickUpTask,
    observedListIds: [listId],
  });
  const run = (map: ClickUpStatusMap, status: string) =>
    normalizeClickUpTasks({ workspaceId: 9001, records: [taskWithStatus(status)], statusMaps: { [listId]: map } });

  it("a map that OMITS in_review still imports — the pre-1.21 saved config keeps working", () => {
    const payload = run(list101Map, "in progress");
    expect((payload.rows as Array<Record<string, unknown>>)[0].status).toBe("in_progress");
  });

  it("a map that DEFINES in_review resolves its native status onto in_review", () => {
    const withReview: ClickUpStatusMap = { ...list101Map, in_review: "in review" };
    const payload = run(withReview, "In Review");
    expect((payload.rows as Array<Record<string, unknown>>)[0].status).toBe("in_review");
  });

  it("stays FAIL-CLOSED: with in_review unmapped, an In Review task is rejected, never guessed", () => {
    // The important half of the omitted case — "degrades gracefully" must not mean "guesses".
    expect(() => run(list101Map, "in review")).toThrow(ClickUpNormalizationError);
  });

  it("a required member is still required — omitting `blocked` still throws", () => {
    const noBlocked = { ...list101Map } as Partial<ClickUpStatusMap>;
    delete noBlocked.blocked;
    expect(() => run(noBlocked as ClickUpStatusMap, "in progress")).toThrow(/missing its blocked status mapping/);
  });
});
