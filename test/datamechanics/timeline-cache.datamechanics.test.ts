import { describe, expect, it, vi } from "vitest";
import { db, ingest, seedTeam, type Seed } from "./helpers";
import {
  getCachedWorkTimeline,
  readTimelineCache,
  bustTeamTimeline,
} from "@/lib/dashboard/timeline-cache";

// Spec (PR-B — the persisted work-timeline LAYER): getCachedWorkTimeline builds from items+tasks on a
// cold miss, persists the TimelineDay[] to work_timeline_cache (serve-stale-while-revalidate), and keys
// by viewer TIER so an external viewer never receives team-tier work. Real-DB outcomes: the cache row
// read back from Postgres. bustTeamTimeline marks it stale for the next view.

// A git-commit item attributed to the seed member (a real human), dated in-window → one timeline row.
async function seedCommit(seed: Seed, title: string, whenIso: string) {
  return ingest(seed, {
    path: `commits/x/${title}.md`,
    project: "commits",
    kind: "artifact",
    frontmatter: { source: "git", title, committed_at: whenIso, source_url: "https://example.com/c" },
    body: `# ${title}`,
    access: "team",
  });
}

const recentIso = () => new Date(Date.now() - 3_600_000).toISOString(); // 1h ago (in the 7-day window)

async function readRow(teamId: string, tier: "team" | "external") {
  const { data } = await db()
    .from("work_timeline_cache")
    .select("group_key, payload, computed_at")
    .eq("team_id", teamId)
    .eq("group_key", tier)
    .maybeSingle();
  return data as { group_key: string; payload: unknown; computed_at: string | Date } | null;
}

describe("work-timeline cache layer (real Postgres)", () => {
  it("cold miss builds, persists a row, and the cache matches the returned ledger", async () => {
    const seed = await seedTeam();
    await seedCommit(seed, "shipped-the-thing", recentIso());

    const days = await getCachedWorkTimeline(db(), seed.teamId, "team");
    // The build found the commit → a day with the seed member and a github group.
    expect(days.length).toBeGreaterThan(0);
    const people = days.flatMap((d) => d.people);
    expect(people.some((p) => p.sources.some((s) => s.source === "github"))).toBe(true);

    // It persisted the payload to the 'team' row (jsonb array), matching what was returned.
    const row = await readRow(seed.teamId, "team");
    expect(row?.group_key).toBe("team");
    expect(Array.isArray(row?.payload)).toBe(true);
    expect((row?.payload as unknown[]).length).toBe(days.length);

    // readTimelineCache round-trips it.
    const cached = await readTimelineCache(db(), seed.teamId, "team");
    expect(cached?.days.length).toBe(days.length);
  });

  it("tier isolation: an external viewer gets no team-tier work and writes a SEPARATE row", async () => {
    const seed = await seedTeam();
    await seedCommit(seed, "internal-work", recentIso()); // team-tier item

    const teamDays = await getCachedWorkTimeline(db(), seed.teamId, "team");
    const extDays = await getCachedWorkTimeline(db(), seed.teamId, "external");

    expect(teamDays.length).toBeGreaterThan(0); // team viewer sees it
    expect(extDays).toEqual([]); // external viewer does NOT see team-tier work

    // Two distinct rows, one per tier — the external payload is empty, the team payload is not.
    const teamRow = await readRow(seed.teamId, "team");
    const extRow = await readRow(seed.teamId, "external");
    expect((teamRow?.payload as unknown[]).length).toBeGreaterThan(0);
    expect((extRow?.payload as unknown[]).length).toBe(0);
  });

  it("SWR: a stale row is served immediately, and the background rebuild picks up new work", async () => {
    const seed = await seedTeam();
    await seedCommit(seed, "commit-a", recentIso());
    const first = await getCachedWorkTimeline(db(), seed.teamId, "team"); // cold miss → builds [A], persists
    const firstCount = first.flatMap((d) => d.people).flatMap((p) => p.sources).reduce((n, s) => n + s.count, 0);
    expect(firstCount).toBe(1);

    // New work lands, then the row is marked stale (+ in-memory evicted) — the re-attribution path.
    await seedCommit(seed, "commit-b", recentIso());
    await bustTeamTimeline(db(), seed.teamId);

    // Next read returns the STALE payload immediately (still 1 item) and fires the background rebuild.
    const staleServe = await getCachedWorkTimeline(db(), seed.teamId, "team");
    const staleCount = staleServe.flatMap((d) => d.people).flatMap((p) => p.sources).reduce((n, s) => n + s.count, 0);
    expect(staleCount).toBe(1); // served stale, not yet rebuilt

    // The deduped background rebuild lands the new payload (2 items) into the persisted row.
    await vi.waitFor(
      async () => {
        const row = await readRow(seed.teamId, "team");
        const count = ((row?.payload as { people: { sources: { count: number }[] }[] }[]) ?? [])
          .flatMap((d) => d.people)
          .flatMap((p) => p.sources)
          .reduce((n, s) => n + s.count, 0);
        expect(count).toBe(2);
      },
      { timeout: 3_000, interval: 50 }
    );
  });

  it("bustTeamTimeline marks the row stale (computed_at older than the TTL)", async () => {
    const seed = await seedTeam();
    await seedCommit(seed, "x", recentIso());
    await getCachedWorkTimeline(db(), seed.teamId, "team"); // populate

    const before = await readRow(seed.teamId, "team");
    await bustTeamTimeline(db(), seed.teamId);
    const after = await readRow(seed.teamId, "team");

    const ms = (v: string | Date) => (v instanceof Date ? v.getTime() : Date.parse(v));
    // Stale-marked to > the 5-min TTL in the past, so the next view rebuilds behind the request.
    expect(ms(after!.computed_at)).toBeLessThan(ms(before!.computed_at));
    expect(Date.now() - ms(after!.computed_at)).toBeGreaterThan(5 * 60_000);
  });
});
