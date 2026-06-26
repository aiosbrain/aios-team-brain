import { describe, it, expect } from "vitest";
import { normalizePlaneProject, normalizePlaneDocs, type NormalizePlaneInput } from "@/lib/ingest/sources/plane-normalize";
import { itemPayloadSchema, taskRowSchema } from "@/lib/api/schemas";

// Spec (Plane inbound import): a Plane project's work-items normalize to ONE kind="task"
// ItemPayload whose rows diff-sync by a stable row_key. The import is one-directional
// (Plane → brain): items the brain itself projected OUT to Plane (external_source="aios")
// are de-duped (skipped) because the brain already owns that row_key in its real project.
// Organizational structure is preserved: sub-issue parent → parent_row_key, module → sprint,
// labels/priority/state/assignee carried through. Verified against the brain contract schema.

const base: NormalizePlaneInput = {
  projectId: "11111111-1111-1111-1111-111111111111",
  projectIdentifier: "ENG",
  workspaceSlug: "acme",
  baseUrl: "https://api.plane.so",
  states: [
    { id: "s-backlog", name: "Backlog", group: "backlog" },
    { id: "s-todo", name: "Todo", group: "unstarted" },
    { id: "s-doing", name: "In Progress", group: "started" },
    { id: "s-blocked", name: "Blocked", group: "started" },
    { id: "s-done", name: "Done", group: "completed" },
  ],
  labels: [
    { id: "l-bug", name: "bug" },
    { id: "l-api", name: "api" },
  ],
  members: { u1: "Alex", u2: "Riley" },
  moduleByItem: {},
  items: [],
};

describe("normalizePlaneProject", () => {
  it("maps a project to one valid kind=task ItemPayload in a dedicated brain project", () => {
    const p = normalizePlaneProject({
      ...base,
      items: [
        {
          id: "wi-1",
          sequence_id: 42,
          name: "Ship dual-backend",
          state: "s-doing",
          priority: "high",
          labels: ["l-api"],
          assignees: ["u1"],
        },
      ],
    });

    expect(() => itemPayloadSchema.parse(p)).not.toThrow();
    expect(p.kind).toBe("task");
    // dedicated brain project, isolated from CLI/UI tasks (project-wide diff-delete safety)
    expect(p.project).toBe("plane-eng");
    expect(p.path).toBe("plane/eng/work-items.md");
    expect(p.access).toBe("team");
    expect(p.content_sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(p.rows).toHaveLength(1);

    const row = p.rows![0] as Record<string, unknown>;
    expect(() => taskRowSchema.parse(row)).not.toThrow();
    expect(row.row_key).toBe("ENG-42");
    expect(row.title).toBe("Ship dual-backend");
    expect(row.status).toBe("in_progress"); // state group "started"
    expect(row.priority).toBe("high");
    expect(row.labels).toEqual(["api"]); // label id → name
    expect(row.assignee).toBe("Alex"); // assignee id → display name
  });

  it("de-dupes aios round-trippers: items stamped external_source=aios are skipped", () => {
    const p = normalizePlaneProject({
      ...base,
      items: [
        { id: "wi-native", sequence_id: 7, name: "Plane-native task", state: "s-todo" },
        {
          id: "wi-roundtrip",
          sequence_id: 8,
          name: "Brain task pushed to Plane",
          state: "s-doing",
          external_source: "aios",
          external_id: "3-log/T-5",
        },
        {
          id: "wi-roundtrip2",
          sequence_id: 9,
          name: "Legacy seed",
          state: "s-doing",
          external_source: "aios-backlog",
          external_id: "T-9",
        },
      ],
    });
    const keys = (p.rows as Record<string, unknown>[]).map((r) => r.row_key);
    expect(keys).toEqual(["ENG-7"]); // only the Plane-native item; aios-origin de-duped out
  });

  it("preserves sub-issue hierarchy: parent work-item → parent_row_key", () => {
    const p = normalizePlaneProject({
      ...base,
      items: [
        { id: "epic", sequence_id: 1, name: "Epic", state: "s-todo" },
        { id: "child", sequence_id: 2, name: "Child", state: "s-todo", parent: "epic" },
      ],
    });
    const child = (p.rows as Record<string, unknown>[]).find((r) => r.row_key === "ENG-2")!;
    expect(child.parent).toBe("ENG-1");
  });

  it("nulls a parent that points at a skipped/absent item (no dangling reference → no 422)", () => {
    const p = normalizePlaneProject({
      ...base,
      items: [
        // parent was projected by the brain → skipped; the child must NOT keep a dangling parent
        {
          id: "epic",
          sequence_id: 1,
          name: "Epic",
          state: "s-todo",
          external_source: "aios",
          external_id: "E-1",
        },
        { id: "child", sequence_id: 2, name: "Child", state: "s-todo", parent: "epic" },
      ],
    });
    const child = (p.rows as Record<string, unknown>[]).find((r) => r.row_key === "ENG-2")!;
    expect(child.parent ?? null).toBeNull();
  });

  it("maps Plane module → sprint (epic grouping, round-trip-consistent with pm-sync)", () => {
    const p = normalizePlaneProject({
      ...base,
      moduleByItem: { "wi-1": "Wave 1" },
      items: [{ id: "wi-1", sequence_id: 3, name: "Task", state: "s-todo" }],
    });
    const row = (p.rows as Record<string, unknown>[])[0];
    expect(row.sprint).toBe("Wave 1");
  });

  it("maps Plane cycle → a namespaced label (cycle:<name>) alongside real labels", () => {
    const p = normalizePlaneProject({
      ...base,
      cycleByItem: { "wi-1": "Sprint 7" },
      items: [{ id: "wi-1", sequence_id: 6, name: "Task", state: "s-todo", labels: ["l-bug"] }],
    });
    const row = (p.rows as Record<string, unknown>[])[0];
    expect(row.labels).toEqual(["bug", "cycle:Sprint 7"]);
  });

  it("keeps module → sprint and cycle → label independent (both preserved)", () => {
    const p = normalizePlaneProject({
      ...base,
      moduleByItem: { "wi-1": "Auth epic" },
      cycleByItem: { "wi-1": "Sprint 7" },
      items: [{ id: "wi-1", sequence_id: 6, name: "Task", state: "s-todo" }],
    });
    const row = (p.rows as Record<string, unknown>[])[0];
    expect(row.sprint).toBe("Auth epic"); // module → sprint (round-trip-consistent with pm-sync)
    expect(row.labels).toEqual(["cycle:Sprint 7"]); // cycle → label
  });

  it("honors a state NAMED like a brain status over its group (Blocked → blocked)", () => {
    const p = normalizePlaneProject({
      ...base,
      items: [{ id: "wi-1", sequence_id: 4, name: "Stuck", state: "s-blocked" }],
    });
    expect((p.rows as Record<string, unknown>[])[0].status).toBe("blocked");
  });

  it("serializes projectable fields into the body so a changed field shifts content_sha256", () => {
    const mk = (status: string) =>
      normalizePlaneProject({
        ...base,
        items: [{ id: "wi-1", sequence_id: 5, name: "Task", state: status }],
      });
    const a = mk("s-todo");
    const b = mk("s-doing");
    expect(a.content_sha256).not.toBe(b.content_sha256); // status change is NOT a no-op at the writer
  });
});

describe("normalizePlaneDocs (searchable work-item text)", () => {
  it("emits one deliverable per work-item with title + HTML→text description in the body", () => {
    const docs = normalizePlaneDocs({
      ...base,
      items: [
        {
          id: "wi-1",
          sequence_id: 42,
          name: "Ship it",
          description_html: "<p>the <b>full</b> prose</p>",
          state: "s-todo",
        },
      ],
    });
    expect(docs).toHaveLength(1);
    const d = docs[0];
    expect(() => itemPayloadSchema.parse(d)).not.toThrow();
    expect(d.kind).toBe("deliverable");
    expect(d.project).toBe("plane-eng");
    expect(d.path).toBe("plane/eng/ENG-42.md");
    expect(d.body).toContain("Ship it");
    expect(d.body).toContain("the full prose"); // HTML stripped, text is searchable
  });

  it("carries the first assignee's Plane member id for per-person attribution at ingest", () => {
    const docs = normalizePlaneDocs({
      ...base,
      items: [
        { id: "wi-1", sequence_id: 1, name: "Assigned", state: "s-todo", assignees: ["mid-7", "mid-8"] },
        { id: "wi-2", sequence_id: 2, name: "Unassigned", state: "s-todo" },
      ],
    });
    expect(docs[0].frontmatter.assignee_id).toBe("mid-7"); // first assignee
    expect(docs[1].frontmatter.assignee_id).toBe(""); // none → empty
  });

  it("skips aios round-trippers, same as the task import", () => {
    const docs = normalizePlaneDocs({
      ...base,
      items: [
        { id: "wi-1", sequence_id: 1, name: "Native", state: "s-todo" },
        { id: "wi-2", sequence_id: 2, name: "RT", state: "s-todo", external_source: "aios", external_id: "T-5" },
      ],
    });
    expect(docs.map((d) => d.frontmatter.identifier)).toEqual(["ENG-1"]);
  });
});
