import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { db, ingest, seedTeam, visOf, externalMember, type Seed } from "./helpers";
import {
  getCachedWorkTimeline,
  settleTimelineRefreshes,
  readTimelineCache,
  bustTeamTimeline,
  PAYLOAD_VERSION,
} from "@/lib/dashboard/timeline-cache";

// Spec (PR-B — the persisted work-timeline LAYER): getCachedWorkTimeline builds from items+tasks on a
// cold miss, persists the TimelineDay[] to work_timeline_cache (serve-stale-while-revalidate), and keys
// by viewer TIER so an external viewer never receives team-tier work. Real-DB outcomes: the cache row
// read back from Postgres. bustTeamTimeline marks it stale for the next view.

// A git-commit item attributed to the seed member (a real human), dated in-window → one timeline row.
/** A team carrying the task `seedCommit` cites, so its evidence is RENDERED (unlinked work is omitted).
 *  The task is EXTERNAL audience deliberately: the tier test must fail on the ITEM's access, not on the
 *  task being invisible — otherwise it passes even with `visibleItems` deleted. Verified by mutation. */
async function seedLinkedTeam(): Promise<Seed> {
  const seed = await seedTeam();
  const { data: proj } = await db()
    .from("projects")
    .insert({ team_id: seed.teamId, slug: `p-${randomUUID().slice(0, 6)}`, name: "P" })
    .select("id")
    .single();
  // PRET-6: the task carries an EXTERNAL-access source doc (external-shared is visible to both
  // viewer classes), preserving this fixture's design: the tier test fails on the ITEM's access,
  // never on the task header being invisible.
  const src = await ingest(seed, {
    path: `task-docs/${randomUUID()}.md`, access: "external", body: "task source CACHE-1",
    frontmatter: { source: "linear" },
  });
  await db().from("tasks").insert({
    team_id: seed.teamId, project_id: (proj as { id: string }).id, row_key: "CACHE-1",
    title: "Cached work", status: "in_progress", assignee: "Tester", origin: "sync", audience: "external",
    source_item_id: src.id,
  });
  return seed;
}

async function seedCommit(seed: Seed, title: string, whenIso: string) {
  const r = await ingest(seed, {
    path: `commits/x/${title}.md`,
    project: "commits",
    kind: "artifact",
    frontmatter: { source: "git", title, committed_at: whenIso, source_url: "https://example.com/c" },
    body: `# ${title} (CACHE-1)`,
    access: "team",
  });
  // PRET-6: the enforced build reads item MEMBERSHIPS — converge after every ingest so a commit
  // seeded mid-test (the SWR rebuild case) is visible to the rebuild that follows.
  const { backfillTeamContext } = await import("@/lib/projects/context/backfill");
  const b = await backfillTeamContext(db(), seed.teamId);
  if (!b.ok) throw new Error(`seedCommit backfill failed: ${b.error}`);
  return r;
}

const recentIso = () => new Date(Date.now() - 3_600_000).toISOString(); // 1h ago (in the 7-day window)

/** PRET-6: every row is a vis-variant — read the VIEWER's row (`vis:<tier>:<hash>`). */
async function readRow(seed: Seed, tier: "team" | "external", memberId: string = seed.memberId) {
  const vis = await visOf(seed, memberId);
  const { data } = await db()
    .from("work_timeline_cache")
    .select("group_key, payload, computed_at")
    .eq("team_id", seed.teamId)
    .eq("group_key", `vis:${tier}:${vis!.visibilityHash}`)
    .maybeSingle();
  return data as { group_key: string; payload: unknown; computed_at: string | Date } | null;
}

describe("work-timeline cache layer (real Postgres)", () => {
  it("cold miss builds, persists a row, and the cache matches the returned ledger", async () => {
    const seed = await seedLinkedTeam();
    await seedCommit(seed, "shipped-the-thing", recentIso());

    const { days } = await getCachedWorkTimeline(db(), seed.teamId, "team", seed.memberId);
    // The build found the commit → a day with the seed member, nested under the task it cites.
    expect(days.length).toBeGreaterThan(0);
    const people = days.flatMap((d) => d.people);
    expect(people.some((p) => p.tasks.some((t) => t.sources.some((s) => s.source === "github")))).toBe(true);

    // It persisted the versioned payload { v, days } to the viewer's vis-variant row (PRET-6:
    // the plain tier row is never written), matching what was returned.
    const row = await readRow(seed, "team");
    expect(row?.group_key).toMatch(/^vis:team:/);
    // A LITERAL, deliberately: it forces a conscious edit every time the version moves, which is the
    // moment to ask "did the payload shape or meaning change?". v10 adds `TaskGroup.assignee`, so a
    // v9 row would render a teammate's ticket as if it were the viewer's own.
    // Against the CONSTANT, not a literal: what matters is that the writer stamps the version the reader
    // checks. A hard-coded number only proves the writer agrees with whatever it was on the day this was
    // written, and it broke on the v11 bump while the behaviour under test was perfectly fine.
    expect((row?.payload as { v: number; days: unknown[] }).v).toBe(PAYLOAD_VERSION);
    expect((row?.payload as { days: unknown[] }).days.length).toBe(days.length);

    // readTimelineCache round-trips it.
    const cached = await readTimelineCache(db(), seed.teamId, "team", await visOf(seed));
    expect(cached?.days.length).toBe(days.length);
  });

  it("tier isolation: an external viewer gets no team-tier work and writes a SEPARATE row", async () => {
    const seed = await seedLinkedTeam();
    await seedCommit(seed, "internal-work", recentIso()); // team-tier item

    const ext = await externalMember(seed);
    const { days: teamDays } = await getCachedWorkTimeline(db(), seed.teamId, "team", seed.memberId);
    const { days: extDays } = await getCachedWorkTimeline(db(), seed.teamId, "external", ext);

    expect(teamDays.length).toBeGreaterThan(0); // team viewer sees it
    expect(extDays).toEqual([]); // external viewer does NOT see team-tier work

    // Two distinct viewer rows — the external payload is empty, the team payload is not.
    const teamRow = await readRow(seed, "team");
    const extRow = await readRow(seed, "external", ext);
    expect((teamRow?.payload as { days: unknown[] }).days.length).toBeGreaterThan(0);
    expect((extRow?.payload as { days: unknown[] }).days.length).toBe(0);
  });

  it("SWR: a stale row is served immediately, and the background rebuild picks up new work", async () => {
    const seed = await seedLinkedTeam();
    await seedCommit(seed, "commit-a", recentIso());
    const { days: first } = await getCachedWorkTimeline(db(), seed.teamId, "team", seed.memberId); // cold miss → builds [A], persists
    // Count the RENDERED evidence — task-nested only.
    const evCount = (people: { tasks: { evidenceCount: number }[] }[]): number =>
      people.reduce((n, p) => n + p.tasks.reduce((a, t) => a + t.evidenceCount, 0), 0);
    expect(evCount(first.flatMap((d) => d.people))).toBe(1);

    // Settle the COLD-MISS path's own background pass (it adds per-person synopses) before going on.
    // Rebuilds are deduped by key, so a still-in-flight one makes the next stale read a NO-OP — the
    // payload would then never pick up commit-b and this test would fail ~1 in 5 for a reason that has
    // nothing to do with what it asserts. (That dedup is deliberate SWR behavior in production: the
    // work lands on the following read instead.)
    await settleTimelineRefreshes();

    // New work lands, then the row is marked stale (+ in-memory evicted) — the re-attribution path.
    await seedCommit(seed, "commit-b", recentIso());
    await bustTeamTimeline(db(), seed.teamId);

    // Next read returns the STALE payload immediately (still 1 item) and fires the background rebuild.
    const { days: staleServe } = await getCachedWorkTimeline(db(), seed.teamId, "team", seed.memberId);
    expect(evCount(staleServe.flatMap((d) => d.people))).toBe(1); // served stale, not yet rebuilt

    // The deduped background rebuild lands the new payload (2 items) into the persisted row. Await the
    // actual in-flight promise rather than polling a timeout — the rebuild does real DB work, so a fixed
    // budget is a race, not an assertion (this failed ~1 in 3 on a loaded runner).
    await settleTimelineRefreshes();
    const row = await readRow(seed, "team");
    const days = ((row?.payload as { days?: { people: { tasks: { evidenceCount: number }[] }[] }[] })?.days) ?? [];
    expect(evCount(days.flatMap((d) => d.people))).toBe(2);
  });

  it("bustTeamTimeline marks the row stale (computed_at older than the TTL)", async () => {
    const seed = await seedLinkedTeam();
    await seedCommit(seed, "x", recentIso());
    await getCachedWorkTimeline(db(), seed.teamId, "team", seed.memberId); // populate

    const before = await readRow(seed, "team");
    await bustTeamTimeline(db(), seed.teamId);
    const after = await readRow(seed, "team");

    const ms = (v: string | Date) => (v instanceof Date ? v.getTime() : Date.parse(v));
    // Stale-marked to > the 5-min TTL in the past, so the next view rebuilds behind the request.
    expect(ms(after!.computed_at)).toBeLessThan(ms(before!.computed_at));
    expect(Date.now() - ms(after!.computed_at)).toBeGreaterThan(5 * 60_000);
  });
});
