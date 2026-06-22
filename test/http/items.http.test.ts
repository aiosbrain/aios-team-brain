import { describe, expect, it } from "vitest";
import { sha } from "../datamechanics/helpers";
import { BASE_URL, db, issueKeyFor, keyHeaders, seedTeam } from "./http-helpers";

// HTTP edge of POST/GET /api/v1/items — the cross-the-wire path the in-process
// data-mechanics tier bypasses. Closes the gap previously covered only by the
// bash `scripts/e2e.sh`: the admin-tier 422 and the GET tier filter over a real socket.

const ITEMS = `${BASE_URL}/api/v1/items`;

function itemBody(over: Record<string, unknown> = {}) {
  const body = (over.body as string) ?? "hello world";
  return {
    project: "acme",
    path: "2-work/deliverable.md",
    kind: "deliverable",
    access: "team",
    actor: "tester",
    frontmatter: {},
    body,
    content_sha256: sha(body),
    ...over,
  };
}

describe("POST /api/v1/items (HTTP)", () => {
  it("persists a team item and returns 201", async () => {
    const seed = await seedTeam();
    const { key } = await issueKeyFor(seed, "team");

    const res = await fetch(ITEMS, {
      method: "POST",
      headers: keyHeaders(key, seed.teamSlug),
      body: JSON.stringify(itemBody({ path: "2-work/created.md" })),
    });
    expect(res.status).toBe(201);

    const { data } = await db()
      .from("items")
      .select("path, access")
      .eq("team_id", seed.teamId)
      .eq("path", "2-work/created.md")
      .single();
    expect(data).toMatchObject({ path: "2-work/created.md", access: "team" });
  });

  it("rejects admin-tier content with 422 forbidden_tier", async () => {
    const seed = await seedTeam();
    const { key } = await issueKeyFor(seed, "team");

    const res = await fetch(ITEMS, {
      method: "POST",
      headers: keyHeaders(key, seed.teamSlug),
      body: JSON.stringify(itemBody({ access: "admin", path: "5-personal/secret.md" })),
    });
    expect(res.status).toBe(422);
    expect((await res.json()).error.code).toBe("forbidden_tier");

    // And it must NOT have been persisted.
    const { data } = await db()
      .from("items")
      .select("id")
      .eq("team_id", seed.teamId)
      .eq("path", "5-personal/secret.md")
      .maybeSingle();
    expect(data).toBeNull();
  });
});

describe("GET /api/v1/items (HTTP) — tier filter over the wire", () => {
  it("a team key sees team+external items; an external key sees only external", async () => {
    const seed = await seedTeam();
    const { key: teamKey } = await issueKeyFor(seed, "team");

    // Seed one team and one external item over HTTP (a team key may publish either).
    for (const [path, access] of [
      ["2-work/team-only.md", "team"],
      ["4-shared/client-facing.md", "external"],
    ] as const) {
      const r = await fetch(ITEMS, {
        method: "POST",
        headers: keyHeaders(teamKey, seed.teamSlug),
        body: JSON.stringify(itemBody({ path, access, body: path })),
      });
      expect(r.status).toBe(201);
    }

    const teamView = await fetch(ITEMS, { headers: keyHeaders(teamKey, seed.teamSlug) });
    expect(teamView.status).toBe(200);
    const teamPaths = (await teamView.json()).items.map((i: { path: string }) => i.path);
    expect(teamPaths).toEqual(
      expect.arrayContaining(["2-work/team-only.md", "4-shared/client-facing.md"])
    );

    const { key: extKey } = await issueKeyFor(seed, "external");
    const extView = await fetch(ITEMS, { headers: keyHeaders(extKey, seed.teamSlug) });
    expect(extView.status).toBe(200);
    const extItems = (await extView.json()).items as { path: string; access: string }[];
    expect(extItems.every((i) => i.access === "external")).toBe(true);
    expect(extItems.map((i) => i.path)).not.toContain("2-work/team-only.md");
  });
});
