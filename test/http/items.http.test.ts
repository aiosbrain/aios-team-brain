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

  it("accepts both 1.12 evidence kinds, inherits audience, and audits the API actor", async () => {
    const seed = await seedTeam();
    const { key } = await issueKeyFor(seed, "team");
    const keyId = key.split("_")[1];
    const { data: issuedKey } = await db()
      .from("api_keys")
      .select("id")
      .eq("team_id", seed.teamId)
      .eq("key_id", keyId)
      .single();
    const factBody = "| fact-http | Launch date is August 4 |";
    const fact = await fetch(ITEMS, {
      method: "POST",
      headers: keyHeaders(key, seed.teamSlug),
      body: JSON.stringify(
        itemBody({
          kind: "fact",
          path: "3-log/facts-team.md",
          body: factBody,
          content_sha256: sha(factBody),
          rows: [
            {
              row_key: "fact-http",
              title: "Launch date is August 4",
              occurred_at: "2026-08-04",
              fact_type: "event",
              source_path: "1-context/transcripts/launch.md",
              source_quote: "The launch date is August 4.",
            },
          ],
        })
      ),
    });
    expect(fact.status).toBe(201);

    const mentionBody = "| mention-http | Sam Rivera | Buyer |";
    const mention = await fetch(ITEMS, {
      method: "POST",
      headers: keyHeaders(key, seed.teamSlug),
      body: JSON.stringify(
        itemBody({
          kind: "stakeholder_mention",
          path: "4-shared/stakeholder-mentions.md",
          access: "external",
          body: mentionBody,
          content_sha256: sha(mentionBody),
          rows: [
            {
              row_key: "mention-http",
              name: "Sam Rivera",
              role: "Buyer",
              source_path: "1-context/transcripts/discovery.md",
              source_quote: "Sam Rivera is the buyer.",
            },
          ],
        })
      ),
    });
    expect(mention.status).toBe(201);

    const [{ data: factRow }, { data: mentionRow }, { data: auditRows }] =
      await Promise.all([
        db()
          .from("extracted_facts")
          .select("audience")
          .eq("team_id", seed.teamId)
          .eq("row_key", "fact-http")
          .single(),
        db()
          .from("stakeholder_mentions")
          .select("audience")
          .eq("team_id", seed.teamId)
          .eq("row_key", "mention-http")
          .single(),
        db()
          .from("audit_log")
          .select("api_key_id, member_id, action")
          .eq("team_id", seed.teamId)
          .eq("action", "item.created"),
      ]);
    expect(factRow).toEqual({ audience: "team" });
    expect(mentionRow).toEqual({ audience: "external" });
    expect(auditRows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          api_key_id: issuedKey?.id,
          member_id: seed.memberId,
          action: "item.created",
        }),
      ])
    );
  });

  it("rejects an entire malformed evidence request before writing its item", async () => {
    const seed = await seedTeam();
    const { key } = await issueKeyFor(seed, "team");
    const body = "| broken-fact | Missing source quote |";
    const res = await fetch(ITEMS, {
      method: "POST",
      headers: keyHeaders(key, seed.teamSlug),
      body: JSON.stringify(
        itemBody({
          kind: "fact",
          path: "3-log/broken-facts.md",
          body,
          content_sha256: sha(body),
          rows: [
            {
              row_key: "broken-fact",
              title: "Missing source quote",
              fact_type: "fact",
              source_path: "1-context/transcripts/broken.md",
              unexpected: "strict rows reject this too",
            },
          ],
        })
      ),
    });
    expect(res.status).toBe(422);
    expect((await res.json()).error.code).toBe("invalid_payload");

    const { data } = await db()
      .from("items")
      .select("id")
      .eq("team_id", seed.teamId)
      .eq("path", "3-log/broken-facts.md")
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
