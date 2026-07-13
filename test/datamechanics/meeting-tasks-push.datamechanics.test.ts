import { afterEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";

import { upsertIntegration, setIntegrationSecret } from "@/lib/integrations/manage";
import { createMeetingNoteFromItem, getMeetingNote, MEETING_NOTES_PROJECT_SLUG } from "@/lib/meetings/notes";
import { MEETING_TODO_PROJECT_SLUG } from "@/lib/meetings/extract-todos";
import { db, ingest, seedTeam, type Seed } from "./helpers";

// Spec: the Meetings-page "extract action items" + "push to Linear" flow, verified to the observable
// outcome on real Postgres. extractMeetingActionItemsAction materializes tasks in the
// "Extracted from Meetings" project; pushMeetingTasksAction projects the SELECTED ones into the
// team's primary PM tool (Linear), records task_pm_links, and leaves unselected tasks unpushed.
//
// The action depends on request-context modules (serverClient/auth) + the LLM transport + a live
// Linear API — all stubbed: serverClient/auth → the service-role test DB, callMeetingsLLM → canned
// action items, and a mutation-counting Linear stub via global fetch (no live PM calls in CI).

const h = vi.hoisted(() => ({ memberId: "" }));

vi.mock("@/lib/db/server", () => ({
  serverClient: async () => (await import("@/lib/db/admin")).adminClient(),
}));
vi.mock("@/lib/auth/guard", () => ({
  currentMember: async () =>
    h.memberId ? { id: h.memberId, role: "admin", tier: "team", userId: "u" } : null,
}));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("@/lib/meetings/llm-extract", async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return {
    ...actual,
    callMeetingsLLM: async () =>
      JSON.stringify({
        actionItems: [
          { title: "Send the launch deck", assignee: "", due: "2026-08-01" },
          { title: "Book the venue", assignee: "", due: null },
        ],
      }),
  };
});

const { extractMeetingActionItemsAction, pushMeetingTasksAction } = await import(
  "@/app/t/[team]/meetings/actions"
);

// ── Linear stub: routes GraphQL by operation, mints distinct issue ids ──────────────────────────
function linearMock() {
  let n = 0;
  const states = [
    { id: "ls-backlog", name: "Backlog", type: "backlog" },
    { id: "ls-todo", name: "Todo", type: "unstarted" },
    { id: "ls-done", name: "Done", type: "completed" },
  ];
  const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
    const { query, variables } = JSON.parse(String(init?.body));
    if (query.includes("ProjectionBootstrap"))
      return Response.json({ data: { team: { states: { nodes: states }, labels: { nodes: [] } } } });
    if (query.includes("ProjectionMembers"))
      return Response.json({ data: { team: { members: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] } } } });
    if (query.includes("ProjectionIssues"))
      return Response.json({ data: { team: { issues: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] } } } });
    if (query.includes("issueCreate")) {
      const id = `li-${++n}`;
      return Response.json({ data: { issueCreate: { success: true, issue: { id, identifier: `AIO-${n}`, url: `https://linear.app/${id}` } } } });
    }
    if (query.includes("issueLabelCreate"))
      return Response.json({ data: { issueLabelCreate: { issueLabel: { id: `label-${++n}` } } } });
    if (query.includes("issueUpdate"))
      return Response.json({ data: { issueUpdate: { success: true, issue: { id: variables.id, url: "https://linear.app/x" } } } });
    return Response.json({ data: {} });
  }) as unknown as typeof fetch;
  return { fetchImpl };
}

async function seedLinearPrimary(seed: Seed) {
  await db().from("teams").update({ primary_pm_provider: "linear" }).eq("id", seed.teamId);
  const auth = { teamId: seed.teamId, memberId: seed.memberId };
  const { id } = await upsertIntegration(db(), auth, { type: "linear", name: "linear", config: { teamId: "team-uuid" } });
  await setIntegrationSecret(db(), auth, id, "lin_api_x");
}

/** Ingest a transcript item + attach a meeting note; returns the note id + source item id. */
async function seedMeetingNote(seed: Seed): Promise<{ noteId: string; itemId: string }> {
  const res = await ingest(seed, {
    project: MEETING_NOTES_PROJECT_SLUG,
    kind: "transcript",
    path: `meetings/${randomUUID()}.md`,
    body: "# Launch sync\nWe discussed the launch.",
    access: "team",
  } as never);
  const note = await createMeetingNoteFromItem(db(), seed.teamId, {
    sourceItemId: res.id,
    title: "Launch sync",
  });
  return { noteId: note.id, itemId: res.id };
}

async function meetingTaskIds(teamId: string, itemId: string): Promise<{ id: string; title: string }[]> {
  const { data: project } = await db()
    .from("projects")
    .select("id")
    .eq("team_id", teamId)
    .eq("slug", MEETING_TODO_PROJECT_SLUG)
    .single();
  const { data } = await db()
    .from("tasks")
    .select("id, title")
    .eq("team_id", teamId)
    .eq("project_id", (project as { id: string }).id)
    .eq("source_item_id", itemId)
    .order("created_at", { ascending: true });
  return (data ?? []) as { id: string; title: string }[];
}

afterEach(() => {
  vi.unstubAllGlobals();
  h.memberId = "";
});

describe("meeting action items → push to Linear", () => {
  it("extracts action items into tasks and pushes only the selected ones to Linear", async () => {
    const seed = await seedTeam();
    h.memberId = seed.memberId;
    await seedLinearPrimary(seed);
    const { fetchImpl } = linearMock();
    vi.stubGlobal("fetch", fetchImpl);

    const { noteId, itemId } = await seedMeetingNote(seed);

    // 1. Extract — materializes both action items as tasks.
    const extracted = await extractMeetingActionItemsAction(seed.teamSlug, noteId);
    expect(extracted).toMatchObject({ ok: true, extracted: 2 });

    const tasks = await meetingTaskIds(seed.teamId, itemId);
    expect(tasks.map((t) => t.title).sort()).toEqual(["Book the venue", "Send the launch deck"]);

    // 2. Push only the first task.
    const target = tasks.find((t) => t.title === "Send the launch deck")!;
    const other = tasks.find((t) => t.title === "Book the venue")!;
    const pushed = await pushMeetingTasksAction(seed.teamSlug, noteId, [target.id]);
    expect(pushed.ok).toBe(true);
    expect(pushed.provider).toBe("linear");
    expect(pushed.results).toHaveLength(1);
    expect(pushed.results![0]).toMatchObject({ taskId: target.id, status: "synced" });
    expect(pushed.results![0].url).toContain("linear.app");

    // 3. Observable outcome: a task_pm_link exists for the pushed task, none for the other.
    const { data: links } = await db()
      .from("task_pm_links")
      .select("task_id, provider, provider_url")
      .eq("team_id", seed.teamId);
    const linkTasks = (links ?? []) as { task_id: string; provider: string; provider_url: string }[];
    expect(linkTasks.some((l) => l.task_id === target.id && l.provider === "linear" && l.provider_url)).toBe(true);
    expect(linkTasks.some((l) => l.task_id === other.id)).toBe(false);

    // 4. getMeetingNote reflects the pushed state for the UI.
    const note = await getMeetingNote(db(), seed.teamId, noteId, "team");
    const pushedTodo = note!.extractedTodos.find((t) => t.taskId === target.id);
    const unpushedTodo = note!.extractedTodos.find((t) => t.taskId === other.id);
    expect(pushedTodo?.pushed).toMatchObject({ provider: "linear" });
    expect(unpushedTodo?.pushed).toBeNull();
  });

  it("refuses to push when no PM provider is configured", async () => {
    const seed = await seedTeam();
    h.memberId = seed.memberId;
    const { noteId, itemId } = await seedMeetingNote(seed);
    await extractMeetingActionItemsAction(seed.teamSlug, noteId);
    const tasks = await meetingTaskIds(seed.teamId, itemId);

    const res = await pushMeetingTasksAction(seed.teamSlug, noteId, [tasks[0].id]);
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/no enabled PM integration/i);
  });
});
