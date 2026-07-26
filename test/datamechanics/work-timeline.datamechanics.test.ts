import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { getWorkTimeline } from "@/lib/dashboard/work-timeline";
import type { TimelineDay } from "@/lib/dashboard/timeline-group";
import { db, seedTeam, ingest, type Seed } from "./helpers";

// Spec: the Learning Timeline reads Postgres items+tasks into a day → person → (tasks + Other) ledger.
// A task appears iff ≥1 of the person's in-window evidence references it (EVIDENCE-GATED) — empty headers
// never show. Status does NOT gate it: a ticket that shipped today still heads its group, carrying its
// status. Only evidence referencing NO task falls to "Other". Dated by WORK time (git committed_at /
// Slack source_ts / a doc's own edit-create time — WORK_TIME_KEYS, never synced_at); meetings excluded;
// tier isolated. Real Postgres.

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
/** taskTitle → the status carried on its header (so a `done` ticket can be labelled as such, not implied open). */
const taskStatuses = (days: TimelineDay[]): Map<string, string> =>
  new Map(days.flatMap((d) => d.people).flatMap((p) => p.tasks).map((t) => [t.title, t.status]));

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
  it("a REFERENCED task appears (nested) whatever its status; unreferenced → hidden; unlinked → Other; meetings/undated dropped", async () => {
    const seed = await seedTeam();
    const anchor = await commit(seed, "seed");

    // Active task with a citing commit → shows, nested.
    await insertTask(seed, anchor.projectId!, { row_key: "AIO-1", title: "Active adapter", status: "in_progress" });
    await commit(seed, "feat: adapter (AIO-1)");
    // BACKLOG task with a citing commit → NOW heads its own group (evidence-gating, not status, is the gate).
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
    expect(taskTitles(days)).toContain("Backlog thing"); // referenced → heads its group, status irrelevant
    expect(nestedUnder(days, "Backlog thing")).toContain("chore: poke AIO-2");
    expect(taskTitles(days)).not.toContain("Active but idle"); // active but no evidence → hidden
    // "Other" now means exactly what it says: evidence referencing NO task.
    expect(otherTitles(days)).toContain("chore: unrelated cleanup");
    expect(otherTitles(days)).not.toContain("chore: poke AIO-2");
    expect(evidenceTitles(days)).not.toContain("No work time"); // undated → dropped
    expect(evidenceTitles(days)).not.toContain("Standup"); // meeting → excluded
  });

  it("a task that shipped TODAY still heads its group, carrying its `done` status", async () => {
    const seed = await seedTeam();
    const anchor = await commit(seed, "seed");
    await insertTask(seed, anchor.projectId!, { row_key: "AIO-10", title: "Blocked work", status: "blocked" });
    await commit(seed, "wip: unblock (AIO-10)");
    await insertTask(seed, anchor.projectId!, { row_key: "AIO-11", title: "Shipped work", status: "done" });
    await commit(seed, "feat: finish it (AIO-11)");

    const days = await getWorkTimeline(db(), seed.teamId, "team");
    expect(taskTitles(days)).toContain("Blocked work");
    expect(nestedUnder(days, "Blocked work")).toContain("wip: unblock (AIO-10)");
    // A ticket that shipped TODAY is still work someone did today — it heads its own group, and its
    // status travels with it so the UI can label it "done" rather than implying it's still open.
    expect(taskTitles(days)).toContain("Shipped work");
    expect(nestedUnder(days, "Shipped work")).toContain("feat: finish it (AIO-11)");
    expect(taskStatuses(days).get("Shipped work")).toBe("done");
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

  it("dates a doc whose source spells its edit time differently (previously dropped)", async () => {
    const seed = await seedTeam();
    const day1ago = new Date(Date.now() - 86_400_000).toISOString();

    // Each reader spells its timestamp its own way. Work-time matched EXACT key names, so a spelling
    // the list didn't enumerate resolved to null and the doc was silently DROPPED — ingested,
    // attributed, and invisible. Keys are now matched on a normalized form.
    await ingest(seed, { kind: "deliverable", path: `drive/spaced-${randomUUID()}.md`, access: "team", body: "d",
      frontmatter: { source: "gdrive", title: "Drive doc spaced key", "modified at": day1ago } });
    await ingest(seed, { kind: "deliverable", path: `conf/updatedat-${randomUUID()}.md`, access: "team", body: "c",
      frontmatter: { source: "confluence", title: "Confluence doc updatedAt", updated_at: day1ago } });
    // A repo file's work-time is its last commit — github-files fetched that commit for the author
    // but threw the DATE away, so every repo doc was undated and dropped from the timeline.
    await ingest(seed, { kind: "deliverable", path: `github/o-r/readme-${randomUUID()}.md`, access: "team", body: "r",
      frontmatter: { source: "github", title: "Repo readme", committed_at: day1ago } });

    const titles = evidenceTitles(await getWorkTimeline(db(), seed.teamId, "team"));
    expect(titles).toContain("Drive doc spaced key");
    expect(titles).toContain("Confluence doc updatedAt");
    expect(titles).toContain("Repo readme");
  });

  it("a PM issue's own description doc is NOT evidence (the evidence gate stays honest)", async () => {
    const seed = await seedTeam();
    const day1ago = new Date(Date.now() - 86_400_000).toISOString();
    // These docs are now DATED (so the graph stops stamping them at sync time), which without an
    // explicit exclusion would make each ticket its own evidence — its path/title carry its own issue
    // key — so every assigned ticket would self-satisfy the gate and the timeline would become a
    // backlog dump. The ticket belongs in the timeline as a TASK, not as work done on itself.
    await ingest(seed, { kind: "deliverable", path: `linear/aio/AIO-901-${randomUUID()}.md`, access: "team", body: "ticket prose",
      frontmatter: { source: "linear", identifier: "AIO-901", title: "Ticket description doc", source_ts: day1ago } });

    const titles = evidenceTitles(await getWorkTimeline(db(), seed.teamId, "team"));
    expect(titles).not.toContain("Ticket description doc");
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

  it("a DONE task referenced by in-window evidence HEADS its own group (it is not dumped into Other)", async () => {
    // The old rule made only ACTIVE tasks nesting headers, so a commit for a just-shipped ticket landed
    // under "Other · not linked to a task" while carrying a chip naming that very task — the header
    // contradicted the row beneath it. A referenced task now heads its group whatever its status.
    const seed = await seedTeam();
    const anchor = await commit(seed, "seed");
    await insertTask(seed, anchor.projectId!, { row_key: "AIO-777", title: "Ship the widget", status: "done" });
    await commit(seed, "fix: polish the widget (AIO-777)");

    const days = await getWorkTimeline(db(), seed.teamId, "team");
    expect(taskTitles(days)).toContain("Ship the widget");
    expect(nestedUnder(days, "Ship the widget")).toContain("fix: polish the widget (AIO-777)");
    // …and it is NOT also sitting in the "Other" bucket (no double-representation).
    const otherTitles = days
      .flatMap((d) => d.people)
      .flatMap((p) => p.other.flatMap((g) => g.items))
      .map((i) => i.title);
    expect(otherTitles).not.toContain("fix: polish the widget (AIO-777)");
  });

  it("EVIDENCE-GATING, not status, is what keeps the backlog out: an untouched task never appears", async () => {
    // Non-vacuous counterpart to the test above — dropping the active-only filter must not let the whole
    // backlog onto the timeline. A task with no in-window evidence stays invisible whatever its status.
    const seed = await seedTeam();
    const anchor = await commit(seed, "seed");
    await insertTask(seed, anchor.projectId!, { row_key: "AIO-888", title: "Untouched backlog item", status: "backlog" });
    await insertTask(seed, anchor.projectId!, { row_key: "AIO-889", title: "Touched backlog item", status: "backlog" });
    await commit(seed, "chore: start on it (AIO-889)");

    const days = await getWorkTimeline(db(), seed.teamId, "team");
    expect(taskTitles(days)).not.toContain("Untouched backlog item"); // no evidence → absent
    expect(taskTitles(days)).toContain("Touched backlog item"); // evidence → present
  });

  it("TIER: a referenced task never leaks to an external viewer (but an external-audience one DOES show)", async () => {
    const seed = await seedTeam();
    const anchor = await commit(seed, "seed");
    // A TEAM-audience done task and a PUBLIC (external-audience) done task, both referenced by
    // external-ACCESS commits (so the commit itself is visible to an external viewer).
    await insertTask(seed, anchor.projectId!, { row_key: "SEC-99", title: "Team secret ticket", status: "done", audience: "team" });
    await insertTask(seed, anchor.projectId!, { row_key: "PUB-1", title: "Public ticket", status: "done", audience: "external" });
    const extCommit = (body: string) =>
      ingest(seed, { kind: "artifact", path: `commits/repo/${randomUUID()}.md`, access: "external", body, frontmatter: { source: "git", committed_at: recentIso } });
    await extCommit("fix: touch the secret (SEC-99)");
    await extCommit("fix: touch the public thing (PUB-1)");

    // Referenced tasks now surface as HEADERS, so the leak surface is the header set (plus any residual
    // chip). Assert over both so the tier guarantee can't be sidestepped by whichever one renders.
    const exposed = (days: TimelineDay[]): (string | undefined)[] => [
      ...taskTitles(days),
      ...days.flatMap((d) => d.people).flatMap((p) => p.other.flatMap((g) => g.items)).map((i) => i.linkedTask?.title),
    ];

    const asExternal = await getWorkTimeline(db(), seed.teamId, "external");
    expect(exposed(asExternal)).toContain("Public ticket"); // non-vacuous: an external task DOES surface
    expect(exposed(asExternal)).not.toContain("Team secret ticket"); // NEVER leaked to an external viewer
    // The commit itself is external-visible — so the task really was filtered, not the whole row.
    expect(evidenceTitles(asExternal)).toContain("fix: touch the secret (SEC-99)");

    const asTeam = await getWorkTimeline(db(), seed.teamId, "team");
    expect(exposed(asTeam)).toEqual(expect.arrayContaining(["Team secret ticket", "Public ticket"]));
  });

  it("SIGNAL: a decision appears in the Context lane (attributed via decided_by), never counted as work; unmatched dropped", async () => {
    const seed = await seedTeam(); // seed member display_name = "Tester"
    const anchor = await commit(seed, "seed");
    const insertDecision = (over: Record<string, unknown>) =>
      db().from("decisions").insert({
        team_id: seed.teamId, project_id: anchor.projectId!, row_key: `D-${randomUUID().slice(0, 8)}`,
        title: "decision", decided_at: recentIso.slice(0, 10), decided_by: "Tester", audience: "team", ...over,
      });
    await insertDecision({ title: "chose Postgres over the graph", decided_by: "Tester" });
    await insertDecision({ title: "a call nobody here made", decided_by: "Someone Else" }); // no roster match → dropped
    await insertDecision({ title: "an anonymous call", decided_by: "" }); // empty → dropped

    const days = await getWorkTimeline(db(), seed.teamId, "team");
    const signalTitles = days.flatMap((d) => d.people).flatMap((p) => p.signals.flatMap((g) => g.items.map((i) => i.title)));
    expect(signalTitles).toContain("chose Postgres over the graph");
    expect(signalTitles).not.toContain("a call nobody here made"); // unmatched decided_by → dropped
    expect(signalTitles).not.toContain("an anonymous call"); // empty decided_by → dropped
    // …and it's SIGNAL, not work: the decision is not in tasks/other/total for the person.
    const tester = days.flatMap((d) => d.people).find((p) => p.name === "Tester")!;
    expect(evidenceTitles(days)).not.toContain("chose Postgres over the graph");
    expect(tester.total).toBe(tester.tasks.reduce((n, t) => n + t.evidenceCount, 0) + tester.other.reduce((n, g) => n + g.count, 0)); // work only

    // TIER: an external viewer never gets a team-audience decision (public one DOES show — non-vacuous).
    await insertDecision({ title: "public decision", decided_by: "Tester", audience: "external" });
    const ext = await getWorkTimeline(db(), seed.teamId, "external");
    const extSignals = ext.flatMap((d) => d.people).flatMap((p) => p.signals.flatMap((g) => g.items.map((i) => i.title)));
    expect(extSignals).toContain("public decision");
    expect(extSignals).not.toContain("chose Postgres over the graph"); // team-audience → not leaked
  });

  it("SIGNAL: drops an AMBIGUOUS or MULTI-person decided_by (never credits the wrong person)", async () => {
    const seed = await seedTeam(); // member "Tester"
    const addMember = (name: string) =>
      db().from("members").insert({
        team_id: seed.teamId, email: `${randomUUID()}@test.local`, display_name: name,
        actor_handle: `h-${randomUUID().slice(0, 8)}`, role: "member", tier: "team", status: "active",
      });
    await addMember("Tester Two"); // shares the first name "Tester" → makes bare "Tester" ambiguous
    await addMember("Dana Rivers"); // a distinct name → the unambiguous positive control
    const anchor = await commit(seed, "seed");
    const dec = (over: Record<string, unknown>) =>
      db().from("decisions").insert({
        team_id: seed.teamId, project_id: anchor.projectId!, row_key: `D-${randomUUID().slice(0, 8)}`,
        title: "decision", decided_at: recentIso.slice(0, 10), decided_by: "Tester", audience: "team", ...over,
      });
    await dec({ title: "ambiguous first name", decided_by: "Tester" }); // matches Tester + Tester Two → dropped
    await dec({ title: "a joint call", decided_by: "Tester + Dana Rivers" }); // multi-person → dropped
    await dec({ title: "unambiguous", decided_by: "Dana Rivers" }); // one distinct match → attributed

    const days = await getWorkTimeline(db(), seed.teamId, "team");
    const signalTitles = days.flatMap((d) => d.people).flatMap((p) => p.signals.flatMap((g) => g.items.map((i) => i.title)));
    expect(signalTitles).not.toContain("ambiguous first name"); // ≥2 roster matches → dropped
    expect(signalTitles).not.toContain("a joint call"); // multi-person separator → dropped
    expect(signalTitles).toContain("unambiguous"); // one distinct match → kept (non-vacuous)
  });
});

describe("PR-inherited task links (the commit's key lives on the PULL REQUEST)", () => {
  /** A work_event as the PR-merge ingest would have written it: merged_sha is FULL 40 chars. */
  async function workEvent(seed: Seed, fullSha: string, taskId: string) {
    const { error } = await db().from("work_events").insert({
      team_id: seed.teamId, row_key: "AIO-900", event_kind: "merged", repo: "aiosbrain/aios-team-brain",
      merged_sha: fullSha, task_id: taskId, status: "linked", pr_title: "feat: thing (AIO-900)", actor: "Tester",
    });
    if (error) throw new Error(`work_event insert failed: ${error.message}`);
  }
  /** A commit item whose OWN text cites no key; frontmatter.sha is the 10-char prefix (as prod stores it). */
  async function commitWithSha(seed: Seed, fullSha: string, message: string) {
    return ingest(seed, {
      kind: "artifact", path: `commits/repo/${randomUUID()}.md`, access: "team",
      body: message, frontmatter: { source: "git", committed_at: recentIso, sha: fullSha.slice(0, 10) },
    });
  }

  it("a commit with NO key in its message nests under the task its PR resolved to", async () => {
    const seed = await seedTeam();
    const anchor = await commit(seed, "seed");
    const { data: task } = await db().from("tasks").insert({
      team_id: seed.teamId, project_id: anchor.projectId!, row_key: "AIO-900", title: "Inherited task",
      status: "in_progress", origin: "sync", audience: "team", assignee: "Tester",
    }).select("id").single();
    const taskId = (task as { id: string }).id;
    const fullSha = "abcdef0123456789abcdef0123456789abcdef01";
    await workEvent(seed, fullSha, taskId);
    await commitWithSha(seed, fullSha, "chore: no ticket key anywhere in this message");

    const days = await getWorkTimeline(db(), seed.teamId, "team");
    // The task appears as a nesting header, with the key-less commit nested under it.
    expect(taskTitles(days)).toContain("Inherited task");
    expect(nestedUnder(days, "Inherited task")).toContain("chore: no ticket key anywhere in this message");
  });

  it("TIER: an inherited link never surfaces a task the viewer can't see", async () => {
    const seed = await seedTeam();
    const anchor = await commit(seed, "seed");
    const { data: task } = await db().from("tasks").insert({
      team_id: seed.teamId, project_id: anchor.projectId!, row_key: "AIO-901", title: "Team-only inherited",
      status: "in_progress", origin: "sync", audience: "team", assignee: "Tester", // TEAM audience
    }).select("id").single();
    const fullSha = "bbbbbb0123456789abcdef0123456789abcdef01";
    await workEvent(seed, fullSha, (task as { id: string }).id);
    // The commit itself is external-visible; only the TASK is team-only.
    await ingest(seed, {
      kind: "artifact", path: `commits/repo/${randomUUID()}.md`, access: "external",
      body: "chore: external-visible commit, no key", frontmatter: { source: "git", committed_at: recentIso, sha: fullSha.slice(0, 10) },
    });

    const ext = await getWorkTimeline(db(), seed.teamId, "external");
    expect(taskTitles(ext)).not.toContain("Team-only inherited"); // never leaked via the inherited link
    const team = await getWorkTimeline(db(), seed.teamId, "team");
    expect(taskTitles(team)).toContain("Team-only inherited"); // non-vacuous: the team viewer does see it
  });
});

describe("INFERRED task links (the LLM doc→task pass — the first reader of task_evidence)", () => {
  /** A `task_evidence` row exactly as `lib/dashboard/doc-task-infer-run` persists one. */
  async function inferredLink(seed: Seed, taskId: string, itemId: string, confidence = 0.9) {
    const { error } = await db().from("task_evidence").insert({
      team_id: seed.teamId, task_id: taskId, item_id: itemId,
      method: "llm", confidence, detail: "describes the same subject",
    });
    if (error) throw new Error(`task_evidence insert failed: ${error.message}`);
  }
  /** A doc that cites NO issue key — exactly what the pass exists to rescue from "Other". */
  async function keylessDoc(seed: Seed, title: string, access: "team" | "external" = "team") {
    return ingest(seed, {
      kind: "deliverable", path: `2-work/${randomUUID()}.md`, access,
      body: "prose about the work", frontmatter: { source: "", title, updated: recentIso },
    });
  }
  async function taskId(rowKey: string): Promise<string> {
    const { data } = await db().from("tasks").select("id").eq("row_key", rowKey).maybeSingle();
    return (data as { id: string }).id;
  }

  it("nests a keyless doc under its inferred task, tagged linkVia:'inferred'", async () => {
    const seed = await seedTeam();
    const anchor = await commit(seed, "seed");
    await insertTask(seed, anchor.projectId!, { row_key: "AIO-500", title: "Ownership timeline" });
    const doc = await keylessDoc(seed, "Attribution ownership design");
    await inferredLink(seed, await taskId("AIO-500"), doc.id);

    const days = await getWorkTimeline(db(), seed.teamId, "team");
    expect(nestedUnder(days, "Ownership timeline")).toContain("Attribution ownership design");
    const via = days.flatMap((d) => d.people).flatMap((p) => p.tasks).flatMap((t) => t.sources.flatMap((g) => g.items))
      .filter((i) => i.title === "Attribution ownership design").map((i) => i.linkVia);
    expect(via).toEqual(["inferred"]);
  });

  it("a BELOW-THRESHOLD row never becomes a link — the gate is enforced on READ too", async () => {
    // Defence in depth: the pass already drops sub-threshold answers before writing, so this row stands in
    // for every OTHER way one can appear (a backfill, a manual insert, a row written when the threshold was
    // lower). None of them may promote a guess just by existing.
    const seed = await seedTeam();
    const anchor = await commit(seed, "seed");
    await insertTask(seed, anchor.projectId!, { row_key: "AIO-501", title: "Low confidence task" });
    const doc = await keylessDoc(seed, "Vaguely related doc");
    await inferredLink(seed, await taskId("AIO-501"), doc.id, 0.4);

    const days = await getWorkTimeline(db(), seed.teamId, "team");
    expect(taskTitles(days)).not.toContain("Low confidence task");
    expect(otherTitles(days)).toContain("Vaguely related doc"); // stays in "Other"
  });

  it("DETERMINISTIC WINS: an own-key doc ignores a contradicting inferred row", async () => {
    const seed = await seedTeam();
    const anchor = await commit(seed, "seed");
    await insertTask(seed, anchor.projectId!, { row_key: "AIO-502", title: "The cited task" });
    await insertTask(seed, anchor.projectId!, { row_key: "AIO-503", title: "The inferred task" });
    // The doc's title cites AIO-502; a stale inferred row points at AIO-503.
    const doc = await keylessDoc(seed, "Design for AIO-502");
    await inferredLink(seed, await taskId("AIO-503"), doc.id);

    const days = await getWorkTimeline(db(), seed.teamId, "team");
    expect(nestedUnder(days, "The cited task")).toContain("Design for AIO-502");
    expect(taskTitles(days)).not.toContain("The inferred task");
  });

  it("TIER: an inferred link never surfaces a team task to an external viewer", async () => {
    const seed = await seedTeam();
    const anchor = await commit(seed, "seed");
    await insertTask(seed, anchor.projectId!, { row_key: "SEC-1", title: "Team-only task", audience: "team" });
    await insertTask(seed, anchor.projectId!, { row_key: "PUB-2", title: "Public task", audience: "external" });
    const secret = await keylessDoc(seed, "Doc pointing at the team task", "external");
    const pub = await keylessDoc(seed, "Doc pointing at the public task", "external");
    await inferredLink(seed, await taskId("SEC-1"), secret.id);
    await inferredLink(seed, await taskId("PUB-2"), pub.id);

    const ext = await getWorkTimeline(db(), seed.teamId, "external");
    expect(taskTitles(ext)).not.toContain("Team-only task"); // never leaked
    expect(taskTitles(ext)).toContain("Public task"); // non-vacuous: the read path DOES work for external
    const team = await getWorkTimeline(db(), seed.teamId, "team");
    expect(taskTitles(team)).toEqual(expect.arrayContaining(["Team-only task", "Public task"]));
  });
});
