import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { db, seedTeam } from "./helpers";
import { countProjectedEpisodes, teamEpisodeGroupIds } from "@/lib/graph/extraction-health";

/**
 * STALLPROBE-1 — the two ledger reads the stall verdict rests on, against real Postgres.
 *
 * Both are here because both were WRONG in a way no pure test could see, and both were found by
 * adversarial review rather than by the suite:
 *
 *  1. `teamEpisodeGroupIds` did not exist: the liveness read was `MATCH (e:Episodic)` across the whole
 *     database while its counterpart `newestEpisodeAtMs` is team-scoped. On an instance hosting more
 *     than one team, any other team completing a job refreshed this team's clock, so a dead extractor
 *     read green forever. The scoping is only as good as this query.
 *  2. `countProjectedEpisodes` counted `''`-sentinel rows — the tombstones the blanking/redaction and
 *     tier-vacate paths park in the ledger without POSTing anything to Graphiti. They inflated the
 *     number that clears `MIN_EPISODES_FOR_EXTRACTION_SIGNAL`, whose contract is "N ACCEPTED episodes
 *     reliably yield ≥1 fact" — so tombstones could license a "0 facts" accusation against a young
 *     team whose first real extraction was still legitimately pending.
 *
 * Real Postgres and not FakeSupabase: the sentinel discrimination is a `filter (where …)` /
 * `where content_sha256 <> ''` clause and the scoping is a `distinct` — SQL semantics are the thing
 * under test, and an in-memory fake would assert the shape of a query rather than its result.
 */

async function insertEpisode(
  teamId: string,
  groupId: string,
  contentSha: string
): Promise<void> {
  const { error } = await db().from("graph_episodes").insert({
    team_id: teamId,
    source_table: "items",
    source_id: randomUUID(),
    group_id: groupId,
    content_sha256: contentSha,
  });
  if (error) throw new Error(error.message);
}

describe("teamEpisodeGroupIds — the scope of the liveness read (data-mechanics)", () => {
  it("returns only THIS team's groups, so another team's extraction can't refresh this team's clock", async () => {
    const mine = await seedTeam();
    const other = await seedTeam();
    await insertEpisode(mine.teamId, `${mine.teamSlug}_team`, "a".repeat(64));
    await insertEpisode(mine.teamId, `${mine.teamSlug}_external`, "b".repeat(64));
    await insertEpisode(other.teamId, `${other.teamSlug}_team`, "c".repeat(64));

    const groups = await teamEpisodeGroupIds(mine.teamId);
    expect(groups).not.toBeNull();
    expect([...groups!].sort()).toEqual([`${mine.teamSlug}_external`, `${mine.teamSlug}_team`]);
    // The whole point: the other team's group must be ABSENT, not merely not-first.
    expect(groups).not.toContain(`${other.teamSlug}_team`);
  });

  it("excludes a group holding nothing but redaction tombstones", async () => {
    const seed = await seedTeam();
    await insertEpisode(seed.teamId, `${seed.teamSlug}_team`, "a".repeat(64));
    // A group that was fully vacated/redacted: rows exist, but nothing was ever POSTed for it.
    await insertEpisode(seed.teamId, `${seed.teamSlug}_private`, "");
    await insertEpisode(seed.teamId, `${seed.teamSlug}_private`, "");

    const groups = await teamEpisodeGroupIds(seed.teamId);
    expect(groups).toEqual([`${seed.teamSlug}_team`]);
  });

  it("is empty — not null — for a team that has pushed nothing", async () => {
    // Empty and unreadable must stay distinguishable: the caller turns BOTH into "can't tell", but
    // only because it checks `length === 0` explicitly. `IN []` matches nothing in Cypher, which
    // would otherwise read as a proven-silent extractor rather than as an absence of evidence.
    const seed = await seedTeam();
    expect(await teamEpisodeGroupIds(seed.teamId)).toEqual([]);
  });
});

describe("countProjectedEpisodes — the floor that licenses a '0 facts' accusation (data-mechanics)", () => {
  it("counts real pushes only; redaction tombstones cannot help clear the floor", async () => {
    const seed = await seedTeam();
    for (let i = 0; i < 20; i++) {
      await insertEpisode(seed.teamId, `${seed.teamSlug}_team`, randomUUID().replace(/-/g, "").padEnd(64, "0"));
    }
    for (let i = 0; i < 5; i++) await insertEpisode(seed.teamId, `${seed.teamSlug}_team`, "");

    // 25 rows in the ledger, but only 20 were ever accepted by Graphiti. The unfiltered count read 25
    // and cleared MIN_EPISODES_FOR_EXTRACTION_SIGNAL; the correct one does not.
    const { count } = await db()
      .from("graph_episodes")
      .select("*", { count: "exact", head: true })
      .eq("team_id", seed.teamId);
    expect(count).toBe(25);
    expect(await countProjectedEpisodes(seed.teamId)).toBe(20);
  });

  it("is team-scoped", async () => {
    const mine = await seedTeam();
    const other = await seedTeam();
    await insertEpisode(mine.teamId, `${mine.teamSlug}_team`, "a".repeat(64));
    await insertEpisode(other.teamId, `${other.teamSlug}_team`, "b".repeat(64));
    expect(await countProjectedEpisodes(mine.teamId)).toBe(1);
  });
});
