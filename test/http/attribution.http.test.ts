import { describe, expect, it } from "vitest";
import { BASE_URL, issueAdminKey, issueKeyFor, keyHeaders, seedTeam } from "./http-helpers";
import { ingest } from "../datamechanics/helpers";

// HTTP edge of GET /api/v1/attribution (attribution health context layer, brain-api v1.13): auth, the
// team-ADMIN gate (all-tier read, no RLS backstop — an external or non-admin principal must never reach
// it), the summary wire shape, and the per-member drill-down. Seeding uses the shared test DB.

const ATTRIBUTION = `${BASE_URL}/api/v1/attribution`;

async function seedCommit(seed: Awaited<ReturnType<typeof seedTeam>>, title: string) {
  await ingest(seed, {
    path: `commits/x/${title}.md`,
    project: "commits",
    kind: "artifact",
    frontmatter: { source: "git", title, committed_at: new Date().toISOString() },
    body: `# ${title}`,
    access: "team",
  });
}

describe("GET /api/v1/attribution (HTTP)", () => {
  it("rejects a missing/invalid API key with 401", async () => {
    const res = await fetch(ATTRIBUTION, { headers: { Authorization: "Bearer nope", "X-AIOS-Team": "x" } });
    expect(res.status).toBe(401);
  });

  it("forbids an external-tier key with 403 (all-tier read is admin-only, no RLS backstop)", async () => {
    const seed = await seedTeam();
    const { key } = await issueKeyFor(seed, "external");
    const res = await fetch(ATTRIBUTION, { headers: keyHeaders(key, seed.teamSlug) });
    expect(res.status).toBe(403);
  });

  it("forbids a NON-admin team key with 403", async () => {
    const seed = await seedTeam(); // seeded member is role=member
    const { key } = await issueKeyFor(seed, "team");
    const res = await fetch(ATTRIBUTION, { headers: keyHeaders(key, seed.teamSlug) });
    expect(res.status).toBe(403);
  });

  it("returns the health summary for a team-admin key ({ bySource, byMember, lowAttributionSources })", async () => {
    const seed = await seedTeam();
    await seedCommit(seed, "shipped-it");
    const { key } = await issueAdminKey(seed);

    const res = await fetch(ATTRIBUTION, { headers: keyHeaders(key, seed.teamSlug) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.bySource)).toBe(true);
    expect(Array.isArray(body.byMember)).toBe(true);
    expect(Array.isArray(body.lowAttributionSources)).toBe(true);
    const git = body.bySource.find((s: { source: string }) => s.source === "git");
    expect(git).toBeDefined();
    expect(git.items).toBeGreaterThan(0);
  });

  it("drill-down: ?member=<uuid> returns that member's attributed items ({ member, items })", async () => {
    const seed = await seedTeam();
    await seedCommit(seed, "my-commit");
    const { key } = await issueAdminKey(seed);

    const res = await fetch(`${ATTRIBUTION}?member=${seed.memberId}`, { headers: keyHeaders(key, seed.teamSlug) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.member).toBe(seed.memberId);
    expect(Array.isArray(body.items)).toBe(true);
    expect(body.items.some((i: { title: string }) => i.title === "my-commit")).toBe(true);
  });

  it("drill-down: ?member=unattributed returns the null bucket (200, array)", async () => {
    const seed = await seedTeam();
    const { key } = await issueAdminKey(seed);
    const res = await fetch(`${ATTRIBUTION}?member=unattributed`, { headers: keyHeaders(key, seed.teamSlug) });
    expect(res.status).toBe(200);
    expect(Array.isArray((await res.json()).items)).toBe(true);
  });

  it("rejects a non-UUID member param with 400", async () => {
    const seed = await seedTeam();
    const { key } = await issueAdminKey(seed);
    const res = await fetch(`${ATTRIBUTION}?member=not-a-uuid`, { headers: keyHeaders(key, seed.teamSlug) });
    expect(res.status).toBe(400);
  });
});
