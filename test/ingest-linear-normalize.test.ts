import { describe, it, expect } from "vitest";
import { normalizeLinearTeam, normalizeLinearDocs, type NormalizeLinearInput } from "@/lib/ingest/sources/linear-normalize";
import { itemPayloadSchema, taskRowSchema } from "@/lib/api/schemas";
import { withFooter } from "@/lib/pm-sync/linear-client";

// Spec (Linear inbound import): a team's issues → ONE kind="task" ItemPayload, rows keyed by the
// Linear identifier. One-directional (Linear → brain); issues the brain projected OUT (carrying the
// aios-ext footer) are de-duped (skipped). Org structure preserved. Verified against the contract.

const base: NormalizeLinearInput = { teamKey: "ENG", issues: [] };

describe("normalizeLinearTeam", () => {
  it("maps a team's issues to one valid kind=task ItemPayload in a dedicated brain project", () => {
    const p = normalizeLinearTeam({
      teamKey: "ENG",
      issues: [
        {
          id: "uuid-1",
          identifier: "ENG-42",
          title: "Ship importer",
          description: "do it",
          priority: 2, // high
          state: { name: "In Progress", type: "started" },
          assignee: { displayName: "Alex" },
          labels: { nodes: [{ name: "api" }] },
        },
      ],
    });
    expect(() => itemPayloadSchema.parse(p)).not.toThrow();
    expect(p.kind).toBe("task");
    expect(p.project).toBe("linear-eng");
    expect(p.path).toBe("linear/eng/issues.md");
    expect(p.rows).toHaveLength(1);

    const row = p.rows![0] as Record<string, unknown>;
    expect(() => taskRowSchema.parse(row)).not.toThrow();
    expect(row.row_key).toBe("ENG-42");
    expect(row.title).toBe("Ship importer");
    expect(row.status).toBe("in_progress"); // state.type started
    expect(row.priority).toBe("high"); // priority int 2
    expect(row.labels).toEqual(["api"]);
    expect(row.assignee).toBe("Alex");
  });

  it("de-dupes brain round-trippers: issues carrying the aios-ext footer are skipped", () => {
    const p = normalizeLinearTeam({
      ...base,
      issues: [
        { id: "u1", identifier: "ENG-1", title: "Native", state: { type: "backlog" } },
        {
          id: "u2",
          identifier: "ENG-2",
          title: "Round-tripper",
          description: withFooter("body", "T-5", "aios-backlog"),
          state: { type: "started" },
        },
      ],
    });
    const keys = (p.rows as Record<string, unknown>[]).map((r) => r.row_key);
    expect(keys).toEqual(["ENG-1"]);
  });

  it("maps priority ints and terminal/canceled states correctly", () => {
    const p = normalizeLinearTeam({
      ...base,
      issues: [
        { id: "u1", identifier: "ENG-1", title: "A", priority: 1, state: { type: "completed" } },
        { id: "u2", identifier: "ENG-2", title: "B", priority: 4, state: { type: "canceled" } },
        { id: "u3", identifier: "ENG-3", title: "C", priority: 0, state: { type: "unstarted" } },
      ],
    });
    const byKey = Object.fromEntries(
      (p.rows as Record<string, unknown>[]).map((r) => [r.row_key, r])
    );
    expect(byKey["ENG-1"].priority).toBe("urgent");
    expect(byKey["ENG-1"].status).toBe("done"); // completed
    expect(byKey["ENG-2"].priority).toBe("low");
    expect(byKey["ENG-2"].status).toBe("done"); // canceled → done
    expect(byKey["ENG-3"].status).toBe("ready"); // unstarted
  });

  it("preserves sub-issue hierarchy and nulls a parent skipped/absent from the set", () => {
    const p = normalizeLinearTeam({
      ...base,
      issues: [
        { id: "e", identifier: "ENG-1", title: "Epic", state: { type: "backlog" } },
        { id: "c", identifier: "ENG-2", title: "Child", state: { type: "backlog" }, parent: { identifier: "ENG-1" } },
        { id: "o", identifier: "ENG-3", title: "Orphan", state: { type: "backlog" }, parent: { identifier: "ENG-99" } },
      ],
    });
    const byKey = Object.fromEntries((p.rows as Record<string, unknown>[]).map((r) => [r.row_key, r]));
    expect(byKey["ENG-2"].parent).toBe("ENG-1");
    expect(byKey["ENG-3"].parent ?? null).toBeNull(); // ENG-99 not in set → nulled
  });

  it("maps project → sprint and cycle → cycle:<name> label", () => {
    const p = normalizeLinearTeam({
      ...base,
      issues: [
        {
          id: "u1",
          identifier: "ENG-1",
          title: "T",
          state: { type: "backlog" },
          project: { name: "Auth initiative" },
          cycle: { number: 7 },
        },
      ],
    });
    const row = (p.rows as Record<string, unknown>[])[0];
    expect(row.sprint).toBe("Auth initiative");
    expect(row.labels).toEqual(["cycle:Cycle 7"]);
  });

  it("serializes projectable fields so a changed field shifts content_sha256", () => {
    const mk = (type: string) =>
      normalizeLinearTeam({ ...base, issues: [{ id: "u1", identifier: "ENG-1", title: "T", state: { type } }] });
    expect(mk("backlog").content_sha256).not.toBe(mk("started").content_sha256);
  });
});

describe("normalizeLinearDocs (searchable issue text)", () => {
  it("emits one deliverable item per issue with title + description in the body", () => {
    const docs = normalizeLinearDocs({
      teamKey: "ENG",
      issues: [
        { id: "u1", identifier: "ENG-1", title: "Ship it", description: "the full prose here", url: "https://l/ENG-1", state: { name: "Todo" } },
      ],
    });
    expect(docs).toHaveLength(1);
    const d = docs[0];
    expect(() => itemPayloadSchema.parse(d)).not.toThrow();
    expect(d.kind).toBe("deliverable");
    expect(d.project).toBe("linear-eng");
    expect(d.path).toBe("linear/eng/ENG-1.md");
    expect(d.body).toContain("Ship it");
    expect(d.body).toContain("the full prose here"); // description is searchable
    expect(d.frontmatter.identifier).toBe("ENG-1");
  });

  it("skips brain round-trippers (aios-ext footer), same as the task import", () => {
    const docs = normalizeLinearDocs({
      teamKey: "ENG",
      issues: [
        { id: "u1", identifier: "ENG-1", title: "Native", description: "real" },
        { id: "u2", identifier: "ENG-2", title: "RT", description: withFooter("x", "T-5", "aios-backlog") },
      ],
    });
    expect(docs.map((d) => d.frontmatter.identifier)).toEqual(["ENG-1"]);
  });
});
