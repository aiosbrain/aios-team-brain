import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { getAttributionHealth } from "@/lib/attribution/health";
import { db, seedTeam, ingest, type Seed } from "./helpers";

/**
 * Spec: the attribution-health read reports, per source, how much lands on a real human vs a connector
 * service-account vs nobody — and per person, what they own — so misattribution is visible. Verified on
 * real Postgres (FakeSupabase has no generated columns/constraints; this must be the real DB).
 */

async function addConnector(teamId: string): Promise<string> {
  const { data, error } = await db()
    .from("members")
    .insert({
      team_id: teamId,
      email: `sync-${randomUUID()}@test.local`,
      display_name: "Notion Sync",
      actor_handle: `sync-${randomUUID().slice(0, 8)}`,
      role: "member",
      tier: "team",
      status: "active",
      is_connector: true,
    })
    .select("id")
    .single();
  if (error || !data) throw new Error(`addConnector failed: ${error?.message}`);
  return (data as { id: string }).id;
}

async function seedItem(seed: Seed, source: string, memberId: string | null): Promise<void> {
  const path = `${source}/${randomUUID()}.md`;
  const { id } = await ingest(seed, { body: `body ${path}`, path, access: "team", frontmatter: { source } });
  // ingest attributes to the seed member (a human); re-point to model connector / unattributed cases.
  if (memberId !== seed.memberId) {
    const { error } = await db().from("items").update({ member_id: memberId }).eq("id", id);
    if (error) throw new Error(`repoint failed: ${error.message}`);
  }
}

describe("attribution health (real Postgres)", () => {
  it("breaks attribution down by source (human / connector / unattributed) and by person", async () => {
    const seed = await seedTeam(); // human member = "Tester"
    const connectorId = await addConnector(seed.teamId);

    // git: 2 items, both a real human → 100% human.
    await seedItem(seed, "git", seed.memberId);
    await seedItem(seed, "git", seed.memberId);
    // notion: 3 items — 1 human, 1 connector-attributed, 1 unattributed → 33.3% human (an alert source).
    await seedItem(seed, "notion", seed.memberId);
    await seedItem(seed, "notion", connectorId);
    await seedItem(seed, "notion", null);
    // granola: a SIGNAL source attributed to a human — must NOT count as an alert even if low.
    await seedItem(seed, "granola", seed.memberId);
    // an item with NO frontmatter.source → must bucket under its kind ("deliverable"), exercising the
    // coalesce→kind fallback (guards a refactor that drops the `::text`/coalesce arm).
    await ingest(seed, { body: `body ${randomUUID()}`, path: `nosrc/${randomUUID()}.md`, access: "team" });

    const health = await getAttributionHealth(seed.teamId);
    const bySrc = Object.fromEntries(health.bySource.map((s) => [s.source, s]));

    expect(bySrc.git).toMatchObject({ items: 2, human: 2, connector: 0, unattributed: 0, pctHuman: 100 });
    expect(bySrc.notion).toMatchObject({ items: 3, human: 1, connector: 1, unattributed: 1, pctHuman: 33.3, isSignal: false });
    expect(bySrc.granola).toMatchObject({ items: 1, isSignal: true });
    expect(bySrc.deliverable).toMatchObject({ items: 1, human: 1 }); // kind fallback (no source key)

    // Alert list: notion (33.3% < 50, output source) flagged; git (97%) and granola (signal) not.
    expect(health.lowAttributionSources.map((s) => s.source)).toEqual(["notion"]);

    // Per person: git×2 + notion×1 + granola×1 + deliverable×1 = 5; the connector is excluded entirely.
    const tester = health.byMember.find((m) => m.memberId === seed.memberId)!;
    expect(tester.total).toBe(5);
    expect(tester.bySource.find((s) => s.source === "git")?.items).toBe(2);
    expect(health.byMember.some((m) => m.memberId === connectorId)).toBe(false);
  });
});
