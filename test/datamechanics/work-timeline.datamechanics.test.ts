import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { getWorkTimeline } from "@/lib/dashboard/work-timeline";
import type { TimelineDay } from "@/lib/dashboard/timeline-group";
import { db, seedTeam, ingest, type Seed } from "./helpers";

// Spec: the Learning Timeline reads Postgres items+tasks into a day → person → (tasks + Other) ledger.
// A task appears ONLY when it is ACTIVE (in_progress/blocked) AND has ≥1 of the person's evidence
// referencing it (evidence-gated) — backlog/done tasks and empty headers never show; evidence linked to
// no active task falls to "Other". Dated by WORK time (committed_at/source_ts, never synced_at);
// meetings excluded; tier isolated. Verified on real Postgres.

const recentIso = new Date(Date.now() - 2 * 86_400_000).toISOString(); // within the 7-day window

const evidenceTitles = (days: TimelineDay[]): string[] =>
  days.flatMap((d) => d.people).flatMap((p) => [
    ...p.tasks.flatMap((t) => t.sources.flatMap((g) => g.items.map((i) => i.title))),
    ...p.other.flatMap((g) => g.items.map((i) => i.title)),
  ]);
const taskTitles = (days: TimelineDay[]): string[] =>
  days.flatMap((d) => d.people).flatMap((p) => p.tasks.map((t) => t.title));
const nestedUnder = (days: TimelineDay[], taskTitle: string): string[] =>
  days.flatMap((d) => d.people).flatMap((p) => p.tasks).filter((t) => t.title === taskTitle)
    .flatMap((t) => t.sources.flatMap((g) => g.items.map((i) => i.title)));
const otherTitles = (days: TimelineDay[]): string[] =>
  days.flatMap((d) => d.people).flatMap((p) => p.other.flatMap((g) => g.items.map((i) => i.title)));

async function insertTask(seed: Seed, projectId: string, over: Record<string, unknown>) {
  await db()
    .from("tasks")
    .insert({ team_id: seed.teamId, project_id: projectId, title: "task", assignee: "Tester", status: "in_progress", audience: "team", origin: "sync", ...over });
}
async function commit(seed: Seed, body: string) {
  return ingest(seed, {
    kind: "artifact", path: `commits/repo/${randomUUID()}.md`, access: "team",
    body, frontmatter: { source: "git", committed_at: recentIso },
  });
}

describe("work timeline (real Postgres)", () => {
  it("active task WITH evidence appears (nested); backlog excluded; empty/unlinked → Other; meetings/undated dropped", async () => {
    const seed = await seedTeam();
    const anchor = await commit(seed, "seed");

    // Active task with a citing commit → shows, nested.
    await insertTask(seed, anchor.projectId!, { row_key: "AIO-1", title: "Active adapter", status: "in_progress" });
    await commit(seed, "feat: adapter (AIO-1)");
    // BACKLOG task with a citing commit → task excluded, commit → Other.
    await insertTask(seed, anchor.projectId!, { row_key: "AIO-2", title: "Backlog thing", status: "backlog" });
    await commit(seed, "chore: poke AIO-2");
    // Active task with NO evidence → never appears (evidence-gated).
    await insertTask(seed, anchor.projectId!, { row_key: "AIO-3", title: "Active but idle", status: "in_progress" });
    // Unlinked commit → Other.
    await commit(seed, "chore: unrelated cleanup");
    // Doc with no work time → dropped; granola meeting → excluded.
    await ingest(seed, { kind: "deliverable", path: `docs/${randomUUID()}.md`, access: "team", body: "d", frontmatter: { source: "github", title: "No work time" } });
    await ingest(seed, { kind: "transcript", path: `meetings/${randomUUID()}.md`, access: "team", body: "m", frontmatter: { source: "granola", source_ts: recentIso, title: "Standup" } });

    const days = await getWorkTimeline(db(), seed.teamId, "team");
    expect(taskTitles(days)).toContain("Active adapter"); // active + evidence
    expect(nestedUnder(days, "Active adapter")).toContain("feat: adapter (AIO-1)");
    expect(taskTitles(days)).not.toContain("Backlog thing"); // backlog excluded
    expect(taskTitles(days)).not.toContain("Active but idle"); // active but no evidence → hidden
    expect(otherTitles(days)).toEqual(expect.arrayContaining(["chore: poke AIO-2", "chore: unrelated cleanup"]));
    expect(evidenceTitles(days)).not.toContain("No work time"); // undated → dropped
    expect(evidenceTitles(days)).not.toContain("Standup"); // meeting → excluded
  });

  it("the active set is {in_progress, blocked}: blocked shows, done is excluded (→ Other)", async () => {
    const seed = await seedTeam();
    const anchor = await commit(seed, "seed");
    await insertTask(seed, anchor.projectId!, { row_key: "AIO-10", title: "Blocked work", status: "blocked" });
    await commit(seed, "wip: unblock (AIO-10)");
    await insertTask(seed, anchor.projectId!, { row_key: "AIO-11", title: "Shipped work", status: "done" });
    await commit(seed, "feat: finish it (AIO-11)");

    const days = await getWorkTimeline(db(), seed.teamId, "team");
    expect(taskTitles(days)).toContain("Blocked work"); // blocked = active
    expect(nestedUnder(days, "Blocked work")).toContain("wip: unblock (AIO-10)");
    expect(taskTitles(days)).not.toContain("Shipped work"); // done excluded
    expect(otherTitles(days)).toContain("feat: finish it (AIO-11)"); // its commit → Other
  });

  it("Slack: an unmapped ROOT still surfaces the thread for a MAPPED replier; unmapped participants drop", async () => {
    const seed = await seedTeam(); // seed.memberId = "Tester"
    // Map ONE slack user id → the seeded member. The thread ROOT ("U_root") is deliberately unmapped.
    await db()
      .from("member_identities")
      .insert({ team_id: seed.teamId, member_id: seed.memberId, provider: "slack", external_id: "U_REPLIER" });

    // A slack thread: root by an unmapped user, a reply by the mapped member. participants[] carries the
    // per-contributor ledger the timeline reads (the ingest frontmatter-heal writes this in prod).
    await ingest(seed, {
      kind: "transcript", path: `slack/eng/${randomUUID()}.md`, access: "team", body: "slack thread body",
      frontmatter: {
        source: "slack", channel: "eng", title: "#eng: dual-backend rollout plan",
        participants: [
          { author_id: "U_root", display_name: "Outsider", message_count: 1, first_ts: recentIso, last_ts: recentIso },
          { author_id: "U_REPLIER", display_name: "Tester", message_count: 2, first_ts: recentIso, last_ts: recentIso },
          // A duplicate entry (stored frontmatter is pusher-shaped) must NOT yield two rows for one person.
          { author_id: "U_REPLIER", display_name: "Tester", message_count: 2, first_ts: recentIso, last_ts: recentIso },
        ],
      },
    });

    const days = await getWorkTimeline(db(), seed.teamId, "team");
    // The mapped replier gets the thread in THEIR day (no issue key → "Other"), exactly ONCE (dedup).
    expect(otherTitles(days).filter((t) => t === "#eng: dual-backend rollout plan")).toHaveLength(1);
    // Only the mapped member appears — the unmapped root ("Outsider") is dropped, never guessed.
    const names = days.flatMap((d) => d.people.map((p) => p.name));
    expect(names).toContain("Tester");
    expect(names).not.toContain("Outsider");
  });

  it("Slack: a thread whose title cites an active issue key nests under that task", async () => {
    const seed = await seedTeam();
    const anchor = await commit(seed, "seed");
    await db()
      .from("member_identities")
      .insert({ team_id: seed.teamId, member_id: seed.memberId, provider: "slack", external_id: "U_REPLIER" });
    await insertTask(seed, anchor.projectId!, { row_key: "AIO-42", title: "Rollout task", status: "in_progress" });
    await ingest(seed, {
      kind: "transcript", path: `slack/eng/${randomUUID()}.md`, access: "team", body: "b",
      frontmatter: {
        source: "slack", channel: "eng", title: "#eng: shipping AIO-42 today",
        participants: [{ author_id: "U_REPLIER", display_name: "Tester", message_count: 1, first_ts: recentIso, last_ts: recentIso }],
      },
    });

    const days = await getWorkTimeline(db(), seed.teamId, "team");
    expect(nestedUnder(days, "Rollout task")).toContain("#eng: shipping AIO-42 today");
  });

  it("Slack: tier isolation — an external viewer never receives a team-tier thread", async () => {
    const seed = await seedTeam();
    await db()
      .from("member_identities")
      .insert({ team_id: seed.teamId, member_id: seed.memberId, provider: "slack", external_id: "U_REPLIER" });
    await ingest(seed, {
      kind: "transcript", path: `slack/eng/${randomUUID()}.md`, access: "team", body: "b",
      frontmatter: {
        source: "slack", channel: "eng", title: "#eng: team-only slack thread",
        participants: [{ author_id: "U_REPLIER", display_name: "Tester", message_count: 1, first_ts: recentIso, last_ts: recentIso }],
      },
    });

    const extTitles = evidenceTitles(await getWorkTimeline(db(), seed.teamId, "external"));
    expect(extTitles).not.toContain("#eng: team-only slack thread");
  });

  it("tier isolation: an external viewer never receives team-tier work", async () => {
    const seed = await seedTeam();
    await commit(seed, "Secret team-only commit");
    await ingest(seed, {
      kind: "artifact", path: `commits/repo/${randomUUID()}.md`, access: "external",
      body: "Public external commit", frontmatter: { source: "git", committed_at: recentIso },
    });

    const teamTitles = evidenceTitles(await getWorkTimeline(db(), seed.teamId, "team"));
    const extTitles = evidenceTitles(await getWorkTimeline(db(), seed.teamId, "external"));
    expect(teamTitles).toEqual(expect.arrayContaining(["Secret team-only commit", "Public external commit"]));
    expect(extTitles).not.toContain("Secret team-only commit");
    expect(extTitles).toContain("Public external commit");
  });
});
