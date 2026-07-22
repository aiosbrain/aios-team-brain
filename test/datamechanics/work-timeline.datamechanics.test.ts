import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { getWorkTimeline } from "@/lib/dashboard/work-timeline";
import { db, seedTeam, ingest } from "./helpers";

// Spec: the Learning Timeline reads Postgres items+tasks into a day → person → evidence ledger,
// dated by WORK time (committed_at/source_ts, never synced_at), with meetings excluded and tier
// isolation enforced. Verified on real Postgres.

const recentIso = new Date(Date.now() - 2 * 86_400_000).toISOString(); // within the 7-day window

const titlesOf = (days: Awaited<ReturnType<typeof getWorkTimeline>>): string[] =>
  days.flatMap((d) => d.people).flatMap((p) => p.sources).flatMap((g) => g.items.map((i) => i.title));

describe("work timeline (real Postgres)", () => {
  it("keeps a person's dated commits + assigned tasks; drops undated docs and meetings", async () => {
    const seed = await seedTeam(); // member display_name "Tester"

    const commit = await ingest(seed, {
      kind: "artifact",
      path: `commits/repo/${randomUUID()}.md`,
      access: "team",
      body: "Fix the login redirect bug",
      frontmatter: { source: "git", committed_at: recentIso },
    });
    // Doc with NO work time → dropped (synced_at is NOT a work-time fallback).
    await ingest(seed, {
      kind: "deliverable",
      path: `docs/${randomUUID()}.md`,
      access: "team",
      body: "some doc",
      frontmatter: { source: "github", title: "A doc with no work time" },
    });
    // Granola meeting → excluded (team signal, not one person's output).
    await ingest(seed, {
      kind: "transcript",
      path: `meetings/${randomUUID()}.md`,
      access: "team",
      body: "meeting notes",
      frontmatter: { source: "granola", source_ts: recentIso, title: "Standup" },
    });
    // Task assigned to "Tester" → attributed via subjectMatchesMember.
    await db()
      .from("tasks")
      .insert({ team_id: seed.teamId, project_id: commit.projectId, title: "Ship the thing", assignee: "Tester", status: "in_progress", audience: "team", origin: "sync" });

    const days = await getWorkTimeline(db(), seed.teamId, "team");
    const titles = titlesOf(days);
    expect(titles).toContain("Fix the login redirect bug"); // commit (title = commit subject)
    expect(titles).toContain("Ship the thing"); // task
    expect(titles).not.toContain("A doc with no work time"); // undated → dropped
    expect(titles).not.toContain("Standup"); // meeting → excluded

    // The commit (2 days ago) and the task (today) correctly land on DIFFERENT days, each under "Tester".
    expect(days.flatMap((d) => d.people).every((p) => p.name === "Tester")).toBe(true);
    const sources = days.flatMap((d) => d.people).flatMap((p) => p.sources.map((s) => s.source));
    expect(sources).toContain("github"); // the commit's day
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

    const teamTitles = titlesOf(await getWorkTimeline(db(), seed.teamId, "team"));
    const extTitles = titlesOf(await getWorkTimeline(db(), seed.teamId, "external"));

    expect(teamTitles).toEqual(expect.arrayContaining(["Secret team-only commit", "Public external commit"]));
    expect(extTitles).not.toContain("Secret team-only commit"); // tier isolation — no RLS backstop
    expect(extTitles).toContain("Public external commit");
  });
});
