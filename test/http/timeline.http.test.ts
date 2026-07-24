import { describe, expect, it } from "vitest";
import { BASE_URL, issueKeyFor, keyHeaders, seedTeam } from "./http-helpers";
import { ingest } from "../datamechanics/helpers";

// HTTP edge of GET /api/v1/timeline (the work-timeline context layer, v1.12): auth, the JSON wire
// shape ({ window_days, days }), and tier isolation over a real socket — an external-tier key must
// never receive team-tier work. Seeding uses the shared test DB the server reads.

const TIMELINE = `${BASE_URL}/api/v1/timeline`;

async function seedCommit(seed: Awaited<ReturnType<typeof seedTeam>>, title: string) {
  const at = new Date(Date.now() - 3_600_000).toISOString(); // 1h ago, in the 7-day window
  await ingest(seed, {
    path: `commits/x/${title}.md`,
    project: "commits",
    kind: "artifact",
    frontmatter: { source: "git", title, committed_at: at, source_url: "https://example.com/c" },
    body: `# ${title}`,
    access: "team",
  });
}

describe("GET /api/v1/timeline (HTTP)", () => {
  it("rejects a missing/invalid API key with 401", async () => {
    const res = await fetch(TIMELINE, { headers: { Authorization: "Bearer nope", "X-AIOS-Team": "x" } });
    expect(res.status).toBe(401);
  });

  it("returns the day→person ledger for a team-tier key ({ window_days, days })", async () => {
    const seed = await seedTeam();
    await seedCommit(seed, "shipped-it");
    const { key } = await issueKeyFor(seed, "team");

    const res = await fetch(TIMELINE, { headers: keyHeaders(key, seed.teamSlug) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.window_days).toBe(7);
    expect(Array.isArray(body.days)).toBe(true);
    const people = body.days.flatMap((d: { people: unknown[] }) => d.people) as { tasks: unknown[]; other: unknown[] }[];
    expect(people.length).toBeGreaterThan(0);
    // Pin the v1.12 nested wire shape: each person carries `tasks` + `other` (not the old `sources`).
    expect(Array.isArray(people[0].tasks)).toBe(true);
    expect(Array.isArray(people[0].other)).toBe(true);
    expect((people[0] as Record<string, unknown>).sources).toBeUndefined();
  });

  it("tier isolation: an external-tier key gets 200 but NO team-tier work", async () => {
    const seed = await seedTeam();
    await seedCommit(seed, "internal-only");
    const { key } = await issueKeyFor(seed, "external");

    const res = await fetch(TIMELINE, { headers: keyHeaders(key, seed.teamSlug) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.days).toEqual([]); // external viewer never sees team-tier work
  });
});
