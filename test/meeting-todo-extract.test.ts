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
    expect(rows[0].rowKey).toMatch(/^meet-[a-f0-9]{10}-001$/);
    expect(MEETING_TODO_LABEL).toBe("Extracted from Meetings");
  });
});
