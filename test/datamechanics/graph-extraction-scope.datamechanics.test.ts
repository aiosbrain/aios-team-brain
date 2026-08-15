import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { db, ingest, seedTeam } from "./helpers";
import { projectItemsToGraph } from "@/lib/graph/project";
import { FakeGraphiti, client } from "./fake-graphiti";
import { readExtractionSignals } from "@/lib/graph/extraction-health";

/**
 * The LEDGER half of the stall verdict, against real Postgres (STALLPROBE-1, then STALLSCOPE-1).
 *
 * Every property here was wrong once, and none of them was caught by a pure test:
 *
 *  1. The liveness read was `MATCH (e:Episodic)` across the whole database while its counterpart is
 *     team-scoped, so on a multi-team instance another team's completed job refreshed this team's
 *     clock and a dead extractor read green forever. The scoping is only as good as this query.
 *  2. The item count counted `''`-sentinel rows — the tombstones the blanking/redaction and
 *     tier-vacate paths park in the ledger without POSTing anything, and (since PCCC-3's
 *     reserve-before-push) unlanded reservations. They inflate the number that clears the floor, and
 *     the floor is what licenses a "0 facts" accusation against a team whose first extraction is still
 *     legitimately pending.
 *  3. The age gate was written against `min(projected_at)` — which every content re-push BUMPS, as the
 *     schema's own comment says. `first_seen_at` is the set-once replacement, and "set-once" is a
 *     property of how the projector's four write paths behave against a real database, not of a type.
 *
 * Real Postgres and not FakeSupabase: sentinel discrimination is a `filter (where …)`, the scoping is
 * a `distinct`, and set-once-ness is an `ON CONFLICT DO UPDATE SET` that lists only provided keys. SQL
 * semantics are the thing under test; an in-memory fake would assert the shape of a query, not its
 * result. The reads are unexported (one producer, STALLSCOPE-1 §2g), so everything enters through
 * `readExtractionSignals` — which is also the production path, so a wiring mistake reddens here too.
 *
 * Neo4j is absent in this tier, so every graph leg reads `unreadable` and the VERDICT is not what is
 * pinned here; the ledger signals are.
 */

const REAL_SHA = () => randomUUID().replace(/-/g, "").padEnd(64, "0");

async function insertEpisode(
  teamId: string,
  groupId: string,
  contentSha: string,
  sourceId: string = randomUUID()
): Promise<void> {
  const { error } = await db().from("graph_episodes").insert({
    team_id: teamId,
    source_table: "items",
    source_id: sourceId,
    group_id: groupId,
    content_sha256: contentSha,
  });
  if (error) throw new Error(error.message);
}

describe("the ledger read — scope, floor and clocks from ONE statement (data-mechanics)", () => {
  it("scopes groups to THIS team, so another team's extraction can't refresh this team's clock", async () => {
    const mine = await seedTeam();
    const other = await seedTeam();
    await insertEpisode(mine.teamId, `${mine.teamSlug}_team`, REAL_SHA());
    await insertEpisode(mine.teamId, `${mine.teamSlug}_external`, REAL_SHA());
    await insertEpisode(other.teamId, `${other.teamSlug}_team`, REAL_SHA());

    const { signals } = await readExtractionSignals(mine.teamId);
    expect(signals.items).toBe(2);
    // The other team's group must be ABSENT from the scope, not merely not-first.
    const groups = await groupsOf(mine.teamId);
    expect(groups.sort()).toEqual([`${mine.teamSlug}_external`, `${mine.teamSlug}_team`]);
    expect(groups).not.toContain(`${other.teamSlug}_team`);
  });

  it("counts real pushes only — no sentinel row of any kind can clear the floor", async () => {
    const seed = await seedTeam();
    for (let i = 0; i < 20; i++) await insertEpisode(seed.teamId, `${seed.teamSlug}_team`, REAL_SHA());
    // FOUR kinds of row share the `''` sentinel now, and the set keeps growing: redaction/tier-vacate
    // tombstones, PCCC-3's unlanded reservations, and PCCC-5's DEFERRED fan-out rows (extraction
    // withheld for a cold initiative). None was accepted by graphiti, so none may clear the floor that
    // licenses an accusation. The deferred one is asserted explicitly because it arrived AFTER this
    // filter was written — a new sentinel meaning is a reason to re-check the filter, not to assume it.
    for (let i = 0; i < 4; i++) await insertEpisode(seed.teamId, `${seed.teamSlug}_team`, "");
    const { error: defErr } = await db().from("graph_episodes").insert({
      team_id: seed.teamId,
      source_table: "items",
      source_id: randomUUID(),
      group_id: `g_${seed.teamSlug}_p_cold`,
      content_sha256: "",
      deferred: true,
    });
    expect(defErr).toBeNull();

    const { count } = await db()
      .from("graph_episodes")
      .select("*", { count: "exact", head: true })
      .eq("team_id", seed.teamId);
    expect(count).toBe(25); // 25 rows in the ledger…
    const { signals } = await readExtractionSignals(seed.teamId);
    expect(signals.items).toBe(20); // …but only 20 were ever accepted by graphiti.
  });

  it("counts DISTINCT ITEMS, so per-(item, group) fan-out cannot inflate the floor", async () => {
    // PCCC-3 moved the ledger's identity to per-(item, group); under PCCC-5 fan-out one item holds one
    // row per project graph. `count(*)` would multiply the floor by the average partition count, and
    // the floor is what licenses an accusation.
    const seed = await seedTeam();
    const itemId = randomUUID();
    await insertEpisode(seed.teamId, `${seed.teamSlug}_team`, REAL_SHA(), itemId);
    await insertEpisode(seed.teamId, `g_${seed.teamSlug}_p_alpha`, REAL_SHA(), itemId);
    const { signals } = await readExtractionSignals(seed.teamId);
    expect(signals.items).toBe(1);
    expect((await groupsOf(seed.teamId)).length).toBe(2);
  });

  it("a team holding ONLY sentinel rows reads as empty — no scope, no clock, no accusation", async () => {
    // Empty must stay distinguishable from unreadable, and neither may accuse: `IN []` matches nothing
    // in Cypher, which would otherwise read as a proven-silent extractor rather than absent evidence.
    const seed = await seedTeam();
    for (let i = 0; i < 30; i++) await insertEpisode(seed.teamId, `${seed.teamSlug}_team`, "");
    const { signals, verdict } = await readExtractionSignals(seed.teamId);
    expect(signals.items).toBe(0);
    expect(signals.firstSeenAtMs).toBeNull();
    expect(signals.newestPushAtMs).toBeNull();
    expect(verdict).toEqual({ stalled: false, cause: null, observed: null });
  });

  it("reports the two push clocks with DIFFERENT sentinel treatment, from one pass", async () => {
    // `newestPushAtMs` (real pushes only) is what the lag is measured against — a redaction wave must
    // not read as "an episode just landed". `lastProjectedAt` (any row) answers "is the projector alive
    // at all", and a redaction pass IS the projector working. They are one query so they cannot drift.
    const seed = await seedTeam();
    await insertEpisode(seed.teamId, `${seed.teamSlug}_team`, REAL_SHA());
    const pushedAt = await newestProjectedAt(seed.teamId);
    await db()
      .from("graph_episodes")
      .update({ projected_at: new Date(Date.parse(pushedAt) + 60_000).toISOString() })
      .eq("team_id", seed.teamId)
      .eq("content_sha256", "");
    await insertEpisode(seed.teamId, `${seed.teamSlug}_team`, "");
    await db()
      .from("graph_episodes")
      .update({ projected_at: new Date(Date.parse(pushedAt) + 3_600_000).toISOString() })
      .eq("team_id", seed.teamId)
      .eq("content_sha256", "");

    const { signals, lastProjectedAt } = await readExtractionSignals(seed.teamId);
    expect(signals.newestPushAtMs).toBe(Date.parse(pushedAt));
    expect(Date.parse(lastProjectedAt!)).toBe(Date.parse(pushedAt) + 3_600_000);
  });
});

describe("first_seen_at — the SET-ONCE clock the age gate needs (data-mechanics)", () => {
  it("survives a content re-push that moves projected_at", async () => {
    // The property that refuted the first design: `projected_at` is LAST-touched (`lib/graph/project`
    // bumps it on every real re-push), so gating on `min(projected_at)` lets a re-pushed corpus keep the
    // minimum inside the grace window and silence a dead-from-birth extractor indefinitely.
    const seed = await seedTeam();
    const itemId = randomUUID();
    await insertEpisode(seed.teamId, `${seed.teamSlug}_team`, REAL_SHA(), itemId);
    const before = await firstSeenAt(seed.teamId);

    // The projector's own upsert shape: the payload names `projected_at` and NOT `first_seen_at`, so
    // `ON CONFLICT DO UPDATE SET` (which lists only provided keys) must leave the clock alone.
    const { error } = await db()
      .from("graph_episodes")
      .upsert(
        {
          team_id: seed.teamId,
          source_table: "items",
          source_id: itemId,
          group_id: `${seed.teamSlug}_team`,
          content_sha256: REAL_SHA(),
          projected_at: new Date(Date.now() + 120_000).toISOString(),
        },
        { onConflict: "team_id,source_table,source_id,group_id" }
      );
    expect(error).toBeNull();

    expect(await firstSeenAt(seed.teamId)).toBe(before);
    expect(Date.parse(await newestProjectedAt(seed.teamId))).toBeGreaterThan(Date.parse(before));
  });

  it("survives the group-move UPDATE — the tier-flip path, which relocates a row in place", async () => {
    // The write shape most likely to be rewritten later as delete+insert, which would silently reset the
    // clock and re-open the fresh-install grace for a mature team.
    const seed = await seedTeam();
    const itemId = randomUUID();
    await insertEpisode(seed.teamId, `${seed.teamSlug}_team`, REAL_SHA(), itemId);
    const before = await firstSeenAt(seed.teamId);

    const { error } = await db()
      .from("graph_episodes")
      .update({ group_id: `${seed.teamSlug}_external`, projected_at: new Date().toISOString() })
      .eq("team_id", seed.teamId)
      .eq("source_id", itemId);
    expect(error).toBeNull();

    expect(await firstSeenAt(seed.teamId)).toBe(before);
    expect(await groupsOf(seed.teamId)).toEqual([`${seed.teamSlug}_external`]);
  });

  it("survives a REAL projector re-push — the production path, not a replayed payload shape", async () => {
    // Review's point: the two cases above replay the projector's payload SHAPES by hand, so they stay
    // green if `lib/graph/project.ts` ever starts naming the column. This one drives the projector
    // itself, twice, with the body changed in between so the second pass genuinely re-pushes.
    const seed = await seedTeam();
    const fake = new FakeGraphiti();
    const item = await ingest(seed, { path: "docs/clock.md", body: "first body", access: "team" });
    await projectItemsToGraph(db(), { teamId: seed.teamId, teamSlug: seed.teamSlug, client: client(fake) });
    const before = await firstSeenAt(seed.teamId);

    await ingest(seed, { path: "docs/clock.md", body: "second body, materially different", access: "team" });
    const second = await projectItemsToGraph(db(), { teamId: seed.teamId, teamSlug: seed.teamSlug, client: client(fake) });
    expect(second.projected).toBeGreaterThanOrEqual(1); // it really did re-push
    expect(item.id).toBeTruthy();

    expect(await firstSeenAt(seed.teamId)).toBe(before);
    expect(Date.parse(await newestProjectedAt(seed.teamId))).toBeGreaterThanOrEqual(Date.parse(before));
  });

  it("is the OLDEST row's stamp, and the read exposes it as the gate clock", async () => {
    const seed = await seedTeam();
    await insertEpisode(seed.teamId, `${seed.teamSlug}_team`, REAL_SHA());
    const old = new Date(Date.now() - 7 * 86_400_000).toISOString();
    await db().from("graph_episodes").update({ first_seen_at: old }).eq("team_id", seed.teamId);
    await insertEpisode(seed.teamId, `${seed.teamSlug}_team`, REAL_SHA());

    const { signals } = await readExtractionSignals(seed.teamId);
    expect(signals.firstSeenAtMs).toBe(Date.parse(old));
  });
});

/** Helpers that read the ledger directly — deliberately NOT through the module under test. */
async function groupsOf(teamId: string): Promise<string[]> {
  const { data } = await db()
    .from("graph_episodes")
    .select("group_id, content_sha256")
    .eq("team_id", teamId);
  return [
    ...new Set(
      (data ?? [])
        .filter((r) => (r as { content_sha256: string }).content_sha256 !== "")
        .map((r) => (r as { group_id: string }).group_id)
    ),
  ];
}

async function firstSeenAt(teamId: string): Promise<string> {
  const { data } = await db()
    .from("graph_episodes")
    .select("first_seen_at")
    .eq("team_id", teamId)
    .order("first_seen_at", { ascending: true })
    .limit(1);
  return String((data?.[0] as { first_seen_at: string | Date }).first_seen_at);
}

async function newestProjectedAt(teamId: string): Promise<string> {
  const { data } = await db()
    .from("graph_episodes")
    .select("projected_at")
    .eq("team_id", teamId)
    .order("projected_at", { ascending: false })
    .limit(1);
  return String((data?.[0] as { projected_at: string | Date }).projected_at);
}
