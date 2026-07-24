import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { getWorkTimeline } from "@/lib/dashboard/work-timeline";
import type { TimelineDay } from "@/lib/dashboard/timeline-group";
import { db, seedTeam, ingest, type Seed } from "./helpers";

// Spec: the Learning Timeline reads Postgres items+tasks into a day → person → (tasks + Other) ledger.
// A task appears ONLY when it is ACTIVE (in_progress/blocked) AND has ≥1 of the person's evidence
// referencing it (evidence-gated) — backlog/done tasks and empty headers never show; evidence linked to
// no active task falls to "Other". Dated by WORK time (git committed_at / Slack source_ts / a doc's own
// edit-create time — WORK_TIME_KEYS, never synced_at); meetings excluded; tier isolated. Real Postgres.

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

  // Spec: `windowDays` widens the lookback ("Show earlier days"). A commit dated 10 days ago is OUT of the
  // default 7-day window but appears once the window expands to cover it — proving the param drives both
  // the fetch bound and the in-window filter (not just a display slice).
  it("windowDays expands the lookback: a 10-day-old commit is excluded at 7 days, included at 14", async () => {
    const seed = await seedTeam();
    const tenDaysAgo = new Date(Date.now() - 10 * 86_400_000).toISOString();
    await ingest(seed, {
      kind: "artifact", path: `commits/repo/${randomUUID()}.md`, access: "team",
      body: "Ten-day-old commit", frontmatter: { source: "git", committed_at: tenDaysAgo },
    });

    expect(evidenceTitles(await getWorkTimeline(db(), seed.teamId, "team"))).not.toContain("Ten-day-old commit");
    expect(evidenceTitles(await getWorkTimeline(db(), seed.teamId, "team", 14))).toContain("Ten-day-old commit");
  });
});

describe("work timeline — attributed docs (Notion / Google Docs / deliverables) by edit time (real Postgres)", () => {
  it("includes a doc dated by its own edit/create time; drops ones with no work-time or out of window", async () => {
    const seed = await seedTeam();
    const days2ago = new Date(Date.now() - 2 * 86_400_000).toISOString();
    const day1ago = new Date(Date.now() - 86_400_000).toISOString();
    const days30ago = new Date(Date.now() - 30 * 86_400_000).toISOString();

    // Notion doc edited 2d ago (last_edited_time) → appears (in "Other", no issue key).
    await ingest(seed, { kind: "deliverable", path: `notion/spec-${randomUUID()}.md`, access: "team", body: "spec",
      frontmatter: { source: "notion", title: "Auth rollout spec", last_edited_time: days2ago } });
    // Hand-authored deliverable with only `updated` 1d ago → appears.
    await ingest(seed, { kind: "deliverable", path: `docs/plan-${randomUUID()}.md`, access: "team", body: "plan",
      frontmatter: { title: "Q3 plan", updated: day1ago } });
    // Doc edited 30d ago → outside the 7d work window → excluded (even though synced_at is now).
    await ingest(seed, { kind: "deliverable", path: `notion/old-${randomUUID()}.md`, access: "team", body: "old",
      frontmatter: { source: "notion", title: "Ancient doc", last_edited_time: days30ago } });
    // Doc with NO source work-time (only synced_at) → dropped (synced_at must never resurface it).
    await ingest(seed, { kind: "deliverable", path: `notion/undated-${randomUUID()}.md`, access: "team", body: "u",
      frontmatter: { source: "notion", title: "Undated doc" } });
    // Hand-authored doc dated in the FUTURE (a plan for next month) → dropped (no future day bucket).
    await ingest(seed, { kind: "deliverable", path: `docs/future-${randomUUID()}.md`, access: "team", body: "f",
      frontmatter: { title: "Next-month plan", date: new Date(Date.now() + 30 * 86_400_000).toISOString() } });

    const titles = evidenceTitles(await getWorkTimeline(db(), seed.teamId, "team"));
    expect(titles).toContain("Auth rollout spec");
    expect(titles).toContain("Q3 plan");
    expect(titles).not.toContain("Ancient doc");
    expect(titles).not.toContain("Undated doc");
    expect(titles).not.toContain("Next-month plan"); // future-dated → not in a future bucket
  });

  it("tier isolation: an external viewer never sees a team-tier doc", async () => {
    const seed = await seedTeam();
    await ingest(seed, { kind: "deliverable", path: `notion/int-${randomUUID()}.md`, access: "team", body: "x",
      frontmatter: { source: "notion", title: "Internal notion doc", last_edited_time: new Date(Date.now() - 86_400_000).toISOString() } });
    const ext = evidenceTitles(await getWorkTimeline(db(), seed.teamId, "external"));
    expect(ext).not.toContain("Internal notion doc");
  });
});

describe("work timeline — attribution oracle (credits the worker, not the reassigned owner)", () => {
  it("a commit worked by A but reassigned to B shows under A (the actual worker), never B", async () => {
    const seed = await seedTeam(); // A = "Tester"
    const { data: bRow, error } = await db().from("members").insert({
      team_id: seed.teamId, email: `${randomUUID()}@test.local`, display_name: "Person B",
      actor_handle: `b-${randomUUID().slice(0, 8)}`, role: "member", tier: "team", status: "active", is_connector: false,
    }).select("id").single();
    if (error || !bRow) throw new Error(`seed B failed: ${error?.message}`);

    const c = await commit(seed, "feat: did the actual work"); // A authors the commit (+ its version)
    await db().from("items").update({ member_id: (bRow as { id: string }).id }).eq("id", c.id); // pure reassign → B, no B version

    const days = await getWorkTimeline(db(), seed.teamId, "team");
    const names = days.flatMap((d) => d.people.map((p) => p.name));
    expect(names).toContain("Tester"); // A, the worker
    expect(names).not.toContain("Person B"); // B never worked → not credited
    expect(evidenceTitles(days)).toContain("feat: did the actual work");
  });
});
