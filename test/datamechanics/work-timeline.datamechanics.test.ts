import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { getWorkTimeline } from "@/lib/dashboard/work-timeline";
import type { TimelineDay } from "@/lib/dashboard/timeline-group";
import { db, seedTeam, ingest, type Seed } from "./helpers";

// Spec: the Learning Timeline reads Postgres items+tasks into a day → person → (tasks + Other) ledger,
// dated by WORK time (committed_at/source_ts, never synced_at), with a person's evidence nested under
// the task it references (by issue key) and unlinked evidence in "Other"; meetings excluded, tier
// isolated. Verified on real Postgres.

const recentIso = new Date(Date.now() - 2 * 86_400_000).toISOString(); // within the 7-day window

// All evidence-item titles across tasks' nested sources + the Other bucket.
const evidenceTitles = (days: TimelineDay[]): string[] =>
  days.flatMap((d) => d.people).flatMap((p) => [
    ...p.tasks.flatMap((t) => t.sources.flatMap((g) => g.items.map((i) => i.title))),
    ...p.other.flatMap((g) => g.items.map((i) => i.title)),
  ]);
const taskTitles = (days: TimelineDay[]): string[] =>
  days.flatMap((d) => d.people).flatMap((p) => p.tasks.map((t) => t.title));

async function insertTask(seed: Seed, projectId: string, over: Record<string, unknown>) {
  await db()
    .from("tasks")
    .insert({ team_id: seed.teamId, project_id: projectId, title: "task", assignee: "Tester", status: "in_progress", audience: "team", origin: "sync", ...over });
}

describe("work timeline (real Postgres)", () => {
  it("shows assigned tasks as headers, commits/docs as evidence; drops undated docs + meetings", async () => {
    const seed = await seedTeam(); // member display_name "Tester"

    const commit = await ingest(seed, {
      kind: "artifact",
      path: `commits/repo/${randomUUID()}.md`,
      access: "team",
      body: "Fix the login redirect bug",
      frontmatter: { source: "git", committed_at: recentIso },
    });
    await ingest(seed, {
      kind: "deliverable",
      path: `docs/${randomUUID()}.md`,
      access: "team",
      body: "some doc",
      frontmatter: { source: "github", title: "A doc with no work time" }, // no work time → dropped
    });
    await ingest(seed, {
      kind: "transcript",
      path: `meetings/${randomUUID()}.md`,
      access: "team",
      body: "meeting notes",
      frontmatter: { source: "granola", source_ts: recentIso, title: "Standup" }, // meeting → excluded
    });
    await insertTask(seed, commit.projectId!, { title: "Ship the thing" }); // updated_at=now → in-window header

    const days = await getWorkTimeline(db(), seed.teamId, "team");
    expect(taskTitles(days)).toContain("Ship the thing"); // task header
    expect(evidenceTitles(days)).toContain("Fix the login redirect bug"); // commit (unlinked → Other)
    expect(evidenceTitles(days)).not.toContain("A doc with no work time"); // undated → dropped
    expect(evidenceTitles(days)).not.toContain("Standup"); // meeting → excluded
    expect(days.flatMap((d) => d.people).every((p) => p.name === "Tester")).toBe(true);
  });

  it("nests a commit UNDER the task whose issue key it cites; unrelated evidence goes to Other", async () => {
    const seed = await seedTeam();
    const anchor = await ingest(seed, {
      kind: "artifact", path: `commits/repo/${randomUUID()}.md`, access: "team",
      body: "seed", frontmatter: { source: "git", committed_at: recentIso },
    });
    await insertTask(seed, anchor.projectId!, { row_key: "AIO-42", title: "Provider adapter" });
    await ingest(seed, {
      kind: "artifact", path: `commits/repo/${randomUUID()}.md`, access: "team",
      body: "feat(ingest): provider adapter (AIO-42)", frontmatter: { source: "git", committed_at: recentIso },
    });
    await ingest(seed, {
      kind: "artifact", path: `commits/repo/${randomUUID()}.md`, access: "team",
      body: "chore: unrelated cleanup", frontmatter: { source: "git", committed_at: recentIso },
    });

    const days = await getWorkTimeline(db(), seed.teamId, "team");
    // The task's evidence and its signal can fall on different days (the ledger is day-bucketed), so
    // search across all of Tester's person-days.
    const persons = days.flatMap((d) => d.people).filter((p) => p.name === "Tester");
    const nested = persons
      .flatMap((p) => p.tasks)
      .filter((t) => t.title === "Provider adapter")
      .flatMap((t) => t.sources.flatMap((g) => g.items.map((i) => i.title)));
    const other = persons.flatMap((p) => p.other.flatMap((g) => g.items.map((i) => i.title)));
    expect(nested).toContain("feat(ingest): provider adapter (AIO-42)"); // nested under its task
    expect(other).toContain("chore: unrelated cleanup"); // unlinked → Other
  });

  it("tier isolation: an external viewer never receives team-tier work", async () => {
    const seed = await seedTeam();
    await ingest(seed, {
      kind: "artifact", path: `commits/repo/${randomUUID()}.md`, access: "team",
      body: "Secret team-only commit", frontmatter: { source: "git", committed_at: recentIso },
    });
    await ingest(seed, {
      kind: "artifact", path: `commits/repo/${randomUUID()}.md`, access: "external",
      body: "Public external commit", frontmatter: { source: "git", committed_at: recentIso },
    });

    const teamTitles = evidenceTitles(await getWorkTimeline(db(), seed.teamId, "team"));
    const extTitles = evidenceTitles(await getWorkTimeline(db(), seed.teamId, "external"));

    expect(teamTitles).toEqual(expect.arrayContaining(["Secret team-only commit", "Public external commit"]));
    expect(extTitles).not.toContain("Secret team-only commit"); // tier isolation — no RLS backstop
    expect(extTitles).toContain("Public external commit");
  });
});
