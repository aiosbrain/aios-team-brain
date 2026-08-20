import { describe, expect, it } from "vitest";
import { TASK_STATUSES, itemPayloadSchema, taskRowSchema } from "@/lib/api/schemas";
import { OPEN_STATUSES } from "@/lib/tasks/activity-policy";
import type { TaskStatusValue } from "@/lib/pm-sync/provider";
import { MAX_PAYLOAD_ROWS as MAX_ROWS, wireItemPayloadSchema } from "@/lib/api/item-payload-schema";
import { parseAuthorRefs, primaryAuthorRef } from "@/lib/attribution/resolve-authors";
import type { ClickUpDoc, ClickUpDocPage, ClickUpTask, ClickUpTaskRecord } from "@/lib/ingest/sources/clickup";
import {
  clickUpDocIdentity,
  clickUpStatus,
  clickUpStatusOrNull,
  clickUpTaskIdentity,
  clickUpWorkedAt,
  normalizeClickUpDoc,
  normalizeClickUpTaskDocs,
  normalizeClickUpTasks,
} from "@/lib/ingest/sources/clickup-normalize";
import { sourceRules } from "@/lib/ingest/source-rules";
import { classifyWork } from "@/lib/dashboard/work-classification";
import tasks101Page0 from "@/test/fixtures/clickup/synthetic-tasks-list-101-page-0.json";
import tasks101Page1 from "@/test/fixtures/clickup/synthetic-tasks-list-101-page-1.json";
import tasks202Page0 from "@/test/fixtures/clickup/synthetic-tasks-list-202-page-0.json";
import docAlpha from "@/test/fixtures/clickup/synthetic-doc-alpha.json";
import docAlphaPages from "@/test/fixtures/clickup/synthetic-doc-alpha-pages.json";

const records: ClickUpTaskRecord[] = [
  ...(tasks101Page0.tasks as ClickUpTask[]).map((task) => ({ task, observedListIds: ["101"] })),
  ...(tasks101Page1.tasks as ClickUpTask[]).map((task) => ({ task, observedListIds: ["101"] })),
  ...(tasks202Page0.tasks as ClickUpTask[]).map((task) => ({ task, observedListIds: ["202"] })),
];

const input = { workspaceId: 9001, records };

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
    });
    const row = (payload.rows as Array<Record<string, unknown>>)[0];
    expect(() => taskRowSchema.parse(row)).not.toThrow();
    expect(row.labels).toEqual(Array.from({ length: 50 }, (_, index) => `tag-${String(index).padStart(2, "0")}`));
  });

  it("resolves a status by NAME before consulting ClickUp's type", () => {
    // The precedence `linearStatus`/`planeStatus` already use: a List author who literally names a
    // column "Blocked" or "Backlog" means it, even though ClickUp types both as `custom`/`open`.
    // Asserting the CONFLICT case specifically — a name and a type that disagree — because a
    // type-first mapper passes any test where the two happen to agree.
    expect(clickUpStatus("Blocked", "custom")).toBe("blocked");
    expect(clickUpStatus("Backlog", "open")).toBe("backlog"); // type alone would say `ready`
    expect(clickUpStatus("Done", "custom")).toBe("done"); // type alone would say `in_progress`
    // Case and separators are normalized by `normalizeTaskStatus`, so these are the same status.
    expect(clickUpStatus("IN PROGRESS", "open")).toBe("in_progress");
    expect(clickUpStatus("in-progress", "open")).toBe("in_progress");
  });

  it("falls back to ClickUp's type, mapping `open` to ready rather than backlog", () => {
    expect(clickUpStatus("to do", "open")).toBe("ready");
    expect(clickUpStatus("doing", "custom")).toBe("in_progress");
    expect(clickUpStatus("complete", "done")).toBe("done");
    expect(clickUpStatus("archived", "closed")).toBe("done");
    // `open → ready`, NOT `backlog`, is the load-bearing choice: ClickUp has ONE not-started type,
    // so `backlog` would drop every ClickUp workspace's whole not-started column out of
    // OPEN_STATUSES and therefore off Home, Pulse in-flight and the timeline.
    expect(OPEN_STATUSES.has(clickUpStatus("to do", "open") as TaskStatusValue)).toBe(true);
  });

  it("never throws on an unknown status, and fails OPEN to backlog", () => {
    // The predecessor threw from inside `rows.map`, so ONE unrecognised status aborted the entire
    // workspace payload and every per-task document with it. A status the brain can't place is one
    // row in intake, not an unimportable workspace.
    expect(() => clickUpStatus("Marinating", "totally-invented-type")).not.toThrow();
    expect(clickUpStatus("Marinating", "totally-invented-type")).toBe("backlog");
    expect(clickUpStatus(undefined, undefined)).toBe("backlog");
    expect(clickUpStatus("", "")).toBe("backlog");
    // The strict variant a future inbound-apply needs says "unresolvable" instead of guessing.
    expect(clickUpStatusOrNull("Marinating", "totally-invented-type")).toBeNull();
    expect(clickUpStatusOrNull("to do", "open")).toBe("ready");

    const unknown: ClickUpTaskRecord = {
      task: { ...records[0].task, status: { status: "Marinating", type: "nope" } },
      observedListIds: ["101"],
    };
    const payload = normalizeClickUpTasks({ workspaceId: 9001, records: [unknown] });
    expect((payload.rows as Array<Record<string, unknown>>)[0].status).toBe("backlog");
    // …and the per-task documents survive too — the old fail-closed threw from BOTH entry points.
    expect(() => normalizeClickUpTaskDocs({ workspaceId: 9001, records: [unknown] })).not.toThrow();
  });

  it("imports a 3-status List and a 9-status List, neither of which a 5-to-5 map could describe", () => {
    // The bijective `Record<brainStatus, string>` this replaced needed EXACTLY five distinct
    // ClickUp status names per List. A List with three could not satisfy it and a List with nine
    // could not either — so the failure was never "large workspace", it was every workspace whose
    // pipeline is not exactly five columns wide.
    const lean = [
      { name: "To Do", type: "open", expect: "ready" },
      { name: "Doing", type: "custom", expect: "in_progress" },
      { name: "Done", type: "done", expect: "done" },
    ];
    // A nine-status delivery pipeline with a client-approval loop.
    const wide = [
      { name: "to do", type: "open", expect: "ready" },
      { name: "in progress", type: "custom", expect: "in_progress" },
      { name: "blocked", type: "custom", expect: "blocked" },
      { name: "team approval", type: "custom", expect: "in_review" },
      { name: "client approval", type: "custom", expect: "in_review" },
      { name: "corrections", type: "custom", expect: "in_progress" },
      { name: "client approved", type: "custom", expect: "in_progress" },
      { name: "done", type: "done", expect: "done" },
      { name: "Closed", type: "closed", expect: "done" },
    ];

    for (const list of [lean, wide]) {
      const payload = normalizeClickUpTasks({
        workspaceId: 9001,
        records: list.map((s, index) => ({
          task: { ...records[0].task, id: `s-${index}`, custom_id: null, parent: null, status: { status: s.name, type: s.type } },
          observedListIds: ["101"],
        })),
      });
      expect(() => itemPayloadSchema.parse(payload)).not.toThrow();
      const rows = payload.rows as Array<Record<string, unknown>>;
      expect(rows).toHaveLength(list.length);
      expect(rows.map((row) => row.status)).toEqual(list.map((s) => s.expect));
      // Every row is a legal `task_status` — the mapper cannot invent a value the enum rejects.
      for (const row of rows) expect(TASK_STATUSES).toContain(row.status);
    }
  });

  it("routes a named review/approval stage to in_review, but not its past tense", () => {
    // ClickUp collapses everything between start and finish into the single `custom` type, so the
    // display name is the ONLY review signal available — unlike Linear, whose "In Review" state is
    // caught by the name rule anyway. This is why the heuristic exists and why it is ClickUp-local.
    expect(clickUpStatus("In Review", "custom")).toBe("in_review"); // exact name, no heuristic needed
    expect(clickUpStatus("team approval", "custom")).toBe("in_review");
    expect(clickUpStatus("client approval", "custom")).toBe("in_review");
    expect(clickUpStatus("Ready for review", "custom")).toBe("in_review");
    expect(clickUpStatus("Code Review", "custom")).toBe("in_review");
    // Past tense means the work came BACK from review and is active again — the `\b` anchors
    // matter, and a substring match would get every one of these wrong.
    expect(clickUpStatus("client approved", "custom")).toBe("in_progress");
    expect(clickUpStatus("reviewed", "custom")).toBe("in_progress");
    // Plural column names are ordinary and must match; the past tense still must not.
    expect(clickUpStatus("Approvals", "custom")).toBe("in_review");
    expect(clickUpStatus("Reviews", "custom")).toBe("in_review");
  });

  it("lets a TERMINAL ClickUp type outrank the review-name guess", () => {
    // The precedence that matters most, because getting it wrong is unrecoverable rather than
    // merely imprecise. `in_review` is in ACTIVE_STATUSES, so a FINISHED column whose name happens
    // to contain "review"/"approval" — ordinary in a client-approval pipeline — would otherwise
    // read as in-flight on Home, Pulse and the work timeline permanently, with nothing downstream
    // able to correct it. `done`/`closed` are the only unambiguous signals ClickUp gives; the name
    // is inference. Asserting the CONFLICT case: both rules are live and they disagree.
    expect(clickUpStatus("Review Complete", "closed")).toBe("done");
    expect(clickUpStatus("Approval Done", "done")).toBe("done");
    expect(clickUpStatus("Client Review Complete", "done")).toBe("done");
    // Past tense never matched the heuristic anyway — kept so the type fallback stays pinned too.
    expect(clickUpStatus("approved", "done")).toBe("done");
    // A NON-terminal type does NOT outrank it: this is a narrow carve-out for `done`/`closed`, not
    // a return to type-first.
    expect(clickUpStatus("Ready for review", "custom")).toBe("in_review");
    expect(clickUpStatus("Ready for review", "open")).toBe("in_review");
    // An exact NAME still beats everything, terminal type included — naming the column is the
    // author stating intent outright, which is the whole basis of the name-first rule.
    expect(clickUpStatus("In Review", "closed")).toBe("in_review");
  });

  it("never resolves a status through Object.prototype", () => {
    // `statusType` is untrusted JSON. On a normal object literal a type of "constructor" resolves
    // through the PROTOTYPE and returns a Function as the task's status — which `?? null` cannot
    // screen, because a Function is not nullish. It would reach the postgres `task_status` enum as
    // a non-status and take the whole payload down.
    for (const hostile of ["constructor", "__proto__", "toString", "hasOwnProperty", "valueOf"]) {
      expect(clickUpStatus("Marinating", hostile)).toBe("backlog");
      expect(clickUpStatusOrNull("Marinating", hostile)).toBeNull();
    }
  });

  it("keeps the native status AND its type verbatim beside the canonical one", () => {
    // The fidelity story: `in_review` collapses "team approval" and "client approval" together in
    // `tasks`, so the native pair has to survive on the document or the distinction is destroyed
    // rather than merely coarsened. `native_status_type` is stamped so a downstream consumer never
    // has to re-derive terminality by regexing a display name.
    const record: ClickUpTaskRecord = {
      task: { ...records[0].task, status: { status: "Client Approval", type: "custom" } },
      observedListIds: ["101"],
    };
    const [doc] = normalizeClickUpTaskDocs({ workspaceId: 9001, records: [record] });
    expect(doc.frontmatter).toMatchObject({
      status: "in_review",
      native_status: "Client Approval",
      native_status_type: "custom",
    });
    expect(normalizeClickUpTasks({ workspaceId: 9001, records: [record] }).body).toContain(
      '"native_status":"Client Approval"'
    );
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
    const payload = normalizeClickUpTasks({ workspaceId: 9001, records: [record] });
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
    const payload = normalizeClickUpTasks({ workspaceId: 9001, records: [record] });
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
    const payload = normalizeClickUpTasks({ workspaceId: 9001, records: many });

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
    const base = normalizeClickUpTasks({ workspaceId: 9001, records: many("") });
    const replay = normalizeClickUpTasks({ workspaceId: 9001, records: many("") });
    const edited = normalizeClickUpTasks({ workspaceId: 9001, records: many(" edited") });

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
    const payload = normalizeClickUpTasks({ workspaceId: 9001, records: [record] });
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
    const payload = normalizeClickUpTasks({ workspaceId: 9001, records: [record] });
    const title = (payload.rows as Array<Record<string, unknown>>)[0].title as string;
    expect(title.length).toBeLessThanOrEqual(2000);
    expect(Buffer.from(title, "utf8").toString("utf8")).toBe(title);
    expect(/[\ud800-\udbff]$/.test(title)).toBe(false);
  });

  it("resolves a typeless status by name alone instead of failing the workspace", () => {
    // This case used to be the whole bug: a status ClickUp sent without a `type` threw
    // `ClickUpNormalizationError` from inside `rows.map`, so ONE task took down the entire
    // workspace payload. Now the name resolves it — and "In Review" resolves to the canonical
    // status added for exactly this, rather than being flattened into `in_progress`.
    const record: ClickUpTaskRecord = {
      task: { ...records[0].task, status: { status: "In Review" } },
      observedListIds: ["101"],
    };
    const payload = normalizeClickUpTasks({ workspaceId: 9001, records: [record] });
    expect((payload.rows as Array<Record<string, unknown>>)[0].status).toBe("in_review");
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
