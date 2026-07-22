import { describe, expect, it } from "vitest";

import {
  extractTodosFromNotes,
  toExtractedTodoRows,
  MEETING_TODO_LABEL,
} from "@/lib/meetings/extract-todos";

describe("meeting todo extraction", () => {
  it("extracts explicit todos and action items while ignoring completed checkboxes and code fences", () => {
    const todos = extractTodosFromNotes([
      "# Weekly sync",
      "- [ ] @alex follow up with Finance by 2026-07-15",
      "- [x] already done",
      "Action item: Priya: draft rollout plan (due 2026-07-20)",
      "```",
      "TODO: do not parse code",
      "```",
      "Next step - create launch checklist",
    ].join("\n"));

    expect(todos).toEqual([
      {
        title: "follow up with Finance",
        assignee: "alex",
        due: "2026-07-15",
        line: 2,
        sourceText: "- [ ] @alex follow up with Finance by 2026-07-15",
      },
      {
        title: "draft rollout plan",
        assignee: "Priya",
        due: "2026-07-20",
        line: 4,
        sourceText: "Action item: Priya: draft rollout plan (due 2026-07-20)",
      },
      {
        title: "create launch checklist",
        assignee: "",
        due: null,
        line: 8,
        sourceText: "Next step - create launch checklist",
      },
    ]);
  });

  it("builds stable extracted task rows with source metadata and inherited audience", () => {
    const item = {
      id: "item-123",
      path: "meetings/weekly.md",
      kind: "transcript",
      access: "team" as const,
      body: "",
      updated_at: "2026-07-07T00:00:00Z",
      projects: { slug: "notes" },
    };
    const todos = extractTodosFromNotes("TODO: Morgan: send recap");
    const rows = toExtractedTodoRows(item, todos);

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      title: "send recap",
      assignee: "Morgan",
      sourceItemId: "item-123",
      sourcePath: "meetings/weekly.md",
      audience: "team",
    });
    expect(rows[0].rowKey).toMatch(/^meet-[a-f0-9]{10}-[a-f0-9]{12}$/);
    expect(MEETING_TODO_LABEL).toBe("Extracted from Meetings");
  });

  it("keys todos by content, so re-extraction in a different order maps to the SAME row_keys", () => {
    const item = { id: "item-xyz", path: "meetings/sync.md", access: "team" as const };
    const a = { title: "Send the recap", assignee: "Morgan", due: null, line: 1, sourceText: "Send the recap" };
    const b = { title: "Book the room", assignee: "Alex", due: null, line: 2, sourceText: "Book the room" };

    const first = toExtractedTodoRows(item, [a, b]);
    const reordered = toExtractedTodoRows(item, [b, a]); // LLM returns them in the opposite order

    // Same set of keys regardless of order — positional keying would have swapped -001/-002.
    expect(new Set(first.map((r) => r.rowKey))).toEqual(new Set(reordered.map((r) => r.rowKey)));
    // And each title keeps its OWN stable key across the two runs.
    const keyOf = (rows: typeof first, title: string) => rows.find((r) => r.title === title)!.rowKey;
    expect(keyOf(first, "Send the recap")).toBe(keyOf(reordered, "Send the recap"));
  });

  it("collapses identical titles within one extraction to a single row (dedup)", () => {
    const item = { id: "item-dup", path: "meetings/sync.md", access: "team" as const };
    const t = (title: string) => ({ title, assignee: "", due: null, line: 1, sourceText: title });
    const rows = toExtractedTodoRows(item, [t("Ship the fix"), t("ship the FIX"), t("Other task")]);
    expect(rows).toHaveLength(2); // the two "ship the fix" variants collapse
  });
});
