import { afterAll, describe, expect, it } from "vitest";
import { projectItemsToGraph } from "@/lib/graph/project";
import { runGraphProjection } from "@/lib/graph/run";
import { episodeGroupId } from "@/lib/graph/group";
import { countProjectedEpisodes } from "@/lib/graph/extraction-health";
import { runSql } from "@/lib/db/pg/pool";
import { db, ingest, seedTeam, sha } from "./helpers";
import { FakeGraphiti, client } from "./fake-graphiti";

/**
 * PCCC-3 (Deploy A) — graph_episodes identity widens to per-(item, group).
 *
 * Spec: docs/design/phase-c-per-project-graphs.md §2.1/§2.2 (three-round plan review), governed by
 * docs/specs/project-context-classification-v1.md §6/§17-C. Written from the design's acceptance
 * shape, not from the implementation — on pre-PCCC-3 code the identity tests are RED (no wide
 * index; upserts conflict on the 3-column key; ledger writes discard errors; push precedes the
 * ledger reservation).
 *
 * Why this tier: every claim is about what a REAL Postgres does with the widened key — arbiter
 * index matching, the narrow unique rejecting a second-group row during Deploy A, a trigger-forced
 * write failure surfacing loudly. A stubbed store proves none of that.
 */

const WIDE_INDEX = "graph_episodes_item_group_key";
const NARROW_CONSTRAINT = "graph_episodes_team_id_source_table_source_id_key";

/** A FakeGraphiti that, at the moment of each push, witnesses whether the ledger row for the
 *  pushed (team, item, group) already exists — the reservation-before-push order pin (Codex
 *  High 4). Recorded per push, not asserted inside, so a failure reads as data. */
class WitnessGraphiti extends FakeGraphiti {
  reservedAtPush: Array<{ groupId: string; reserved: boolean }> = [];
  constructor(private teamId: string, private sourceIds: string[]) {
    super();
  }
  override async addEpisodes(groupId: string, episodes: Parameters<FakeGraphiti["addEpisodes"]>[1]): Promise<void> {
    const res = await runSql<{ n: number }>(
      "select count(*)::int as n from graph_episodes where team_id = $1 and group_id = $2 and source_id = any($3)",
      [this.teamId, groupId, this.sourceIds]
    );
    this.reservedAtPush.push({ groupId, reserved: (res.rows[0]?.n ?? 0) > 0 });
    await super.addEpisodes(groupId, episodes);
  }
}

class ThrowingGraphiti extends FakeGraphiti {
  override async addEpisodes(): Promise<void> {
    throw new Error("simulated Graphiti outage");
  }
}

describe("PCCC-3 Deploy A — per-(item, group) ledger identity", () => {
  it("the wide unique index exists, is unique, and covers exactly (team_id, source_table, source_id, group_id)", async () => {
    const res = await runSql<{ indexdef: string }>(
      "select indexdef from pg_indexes where tablename = 'graph_episodes' and indexname = $1",
      [WIDE_INDEX]
    );
    const def = res.rows[0]?.indexdef ?? "";
    expect(def).toContain("UNIQUE");
    expect(def.replace(/\s+/g, " ")).toContain("(team_id, source_table, source_id, group_id)");
  });

  it("a duplicate (item, group) row is rejected by the wide index", async () => {
    const seed = await seedTeam();
    const group = episodeGroupId(seed.teamSlug, "team");
    const row = {
      team_id: seed.teamId,
      source_table: "items",
      source_id: crypto.randomUUID(),
      group_id: group,
      content_sha256: sha("x"),
    };
    const first = await db().from("graph_episodes").insert(row);
    expect(first.error).toBeNull();
    const dup = await db().from("graph_episodes").insert(row);
    expect(dup.error).not.toBeNull();
  });

  it("Deploy A invariant: a second row for the same item in a DIFFERENT group is still rejected (narrow unique stands until Deploy B)", async () => {
    const seed = await seedTeam();
    const sourceId = crypto.randomUUID();
    const base = {
      team_id: seed.teamId,
      source_table: "items",
      source_id: sourceId,
      content_sha256: sha("x"),
    };
    const first = await db()
      .from("graph_episodes")
      .insert({ ...base, group_id: episodeGroupId(seed.teamSlug, "team") });
    expect(first.error).toBeNull();
    const second = await db()
      .from("graph_episodes")
      .insert({ ...base, group_id: episodeGroupId(seed.teamSlug, "external") });
    expect(second.error).not.toBeNull();
  });

  it("a tier flip MOVES the single ledger row (explicit UPDATE while the narrow unique stands) and records the old group as pending-delete", async () => {
    const seed = await seedTeam();
    const fake = new FakeGraphiti();
    const r = await ingest(seed, { body: "flip me across tiers", path: "flip.md", access: "external" });
    await projectItemsToGraph(db(), { teamId: seed.teamId, teamSlug: seed.teamSlug, client: client(fake) });

    const { error: flipErr } = await db().from("items").update({ access: "team" }).eq("id", r.id);
    expect(flipErr).toBeNull();
    await projectItemsToGraph(db(), { teamId: seed.teamId, teamSlug: seed.teamSlug, client: client(fake) });

    const rows = await runSql<{ group_id: string; pending_delete_group_id: string | null }>(
      "select group_id, pending_delete_group_id from graph_episodes where team_id = $1 and source_id = $2",
      [seed.teamId, r.id]
    );
    expect(rows.rows).toHaveLength(1); // moved, not duplicated
    expect(rows.rows[0].group_id).toBe(episodeGroupId(seed.teamSlug, "team"));
    expect(rows.rows[0].pending_delete_group_id).toBe(episodeGroupId(seed.teamSlug, "external"));
  });

  it("the ledger row is RESERVED before the irreversible Graphiti push (Codex High 4)", async () => {
    const seed = await seedTeam();
    const r = await ingest(seed, { body: "reservation order matters", path: "res.md", access: "team" });
    const witness = new WitnessGraphiti(seed.teamId, [r.id]);
    await projectItemsToGraph(db(), { teamId: seed.teamId, teamSlug: seed.teamSlug, client: client(witness) });

    expect(witness.reservedAtPush.length).toBeGreaterThan(0);
    for (const p of witness.reservedAtPush) expect(p.reserved).toBe(true);
  });

  it("a push failure leaves the reservation ('' sentinel) so reconcile can re-queue, and a later pass converges", async () => {
    const seed = await seedTeam();
    const r = await ingest(seed, { body: "crash between reserve and push", path: "crash.md", access: "team" });

    await expect(
      projectItemsToGraph(db(), {
        teamId: seed.teamId,
        teamSlug: seed.teamSlug,
        client: client(new ThrowingGraphiti()),
      })
    ).rejects.toThrow();

    const after = await runSql<{ content_sha256: string; group_id: string }>(
      "select content_sha256, group_id from graph_episodes where team_id = $1 and source_id = $2",
      [seed.teamId, r.id]
    );
    expect(after.rows).toHaveLength(1);
    expect(after.rows[0].content_sha256).toBe(""); // reserved, not landed
    expect(after.rows[0].group_id).toBe(episodeGroupId(seed.teamSlug, "team"));

    const fake = new FakeGraphiti();
    await projectItemsToGraph(db(), { teamId: seed.teamId, teamSlug: seed.teamSlug, client: client(fake) });
    const healed = await runSql<{ content_sha256: string }>(
      "select content_sha256 from graph_episodes where team_id = $1 and source_id = $2",
      [seed.teamId, r.id]
    );
    expect(healed.rows[0].content_sha256).toBe(sha("crash between reserve and push"));
    expect(fake.pushedEpisodes.length).toBeGreaterThan(0);
  });

  it("a ledger write failure is LOUD: the pass rejects instead of silently pushing on (was: both upserts discarded { error })", async () => {
    const seed = await seedTeam();
    const r = await ingest(seed, { body: "this write will be refused", path: "loud.md", access: "team" });

    // A real-Postgres fault: refuse the item's REAL-SHA ledger write only — the `''` reservation
    // insert passes. Conditioned on the sha deliberately: the reservation's own throw also matches
    // a broad refusal, which would mask a muted final-write throw (each defense layer needs its
    // DISTINCT property pinned). The pg adapter returns { error } rather than throwing, so
    // pre-PCCC-3 code sails past this and resolves — exactly the silence the design forbids.
    await runSql(
      `create or replace function pccc3_refuse_marked() returns trigger language plpgsql as $$
         begin
           if new.source_id = '${r.id}' and new.content_sha256 <> '' then
             raise exception 'pccc3 marked row refused';
           end if;
           return new;
         end $$`,
      []
    );
    await runSql(
      "create trigger pccc3_refuse before insert or update on graph_episodes for each row execute function pccc3_refuse_marked()",
      []
    );
    try {
      await expect(
        projectItemsToGraph(db(), {
          teamId: seed.teamId,
          teamSlug: seed.teamSlug,
          client: client(new FakeGraphiti()),
        })
      ).rejects.toThrow(/pccc3 marked row refused|ledger/);
    } finally {
      await runSql("drop trigger if exists pccc3_refuse on graph_episodes", []);
      await runSql("drop function if exists pccc3_refuse_marked()", []);
    }
  });

  it("a FAILED reservation blocks the push — nothing may land in a graph unledgered (Codex Medium 4)", async () => {
    const seed = await seedTeam();
    const r = await ingest(seed, { body: "must never push unreserved", path: "guard.md", access: "team" });

    // Refuse the '' reservation INSERT for this item — a stand-in for the cross-group loser's
    // narrow-unique rejection (any non-benign reservation error must stop the push).
    await runSql(
      `create or replace function pccc3_refuse_reserve() returns trigger language plpgsql as $$
         begin
           if new.source_id = '${r.id}' and new.content_sha256 = '' then
             raise exception 'pccc3 reservation refused';
           end if;
           return new;
         end $$`,
      []
    );
    await runSql(
      "create trigger pccc3_refuse_reserve before insert on graph_episodes for each row execute function pccc3_refuse_reserve()",
      []
    );
    const fake = new FakeGraphiti();
    try {
      await expect(
        projectItemsToGraph(db(), { teamId: seed.teamId, teamSlug: seed.teamSlug, client: client(fake) })
      ).rejects.toThrow(/reservation/);
      expect(fake.pushedEpisodes).toHaveLength(0); // the guard held: no unledgered episode exists
    } finally {
      await runSql("drop trigger if exists pccc3_refuse_reserve on graph_episodes", []);
      await runSql("drop function if exists pccc3_refuse_reserve()", []);
    }
  });

  it("an aborted pass still reports the episodes it already pushed (the cost denominator survives the abort)", async () => {
    const seed = await seedTeam();
    const r1 = await ingest(seed, { body: "first item lands fine", path: "one.md", access: "team" });
    const r2 = await ingest(seed, { body: "second item's write is refused", path: "two.md", access: "team" });
    expect(r1.id).not.toBe(r2.id);

    // Refuse only the SECOND item's real-sha ledger write: item 1 pushes and completes, then the
    // pass aborts loudly — and the abort must carry item 1's pushed episodes, because Graphiti
    // billed that extraction whether or not the pass finished (Codex review Medium 3).
    await runSql(
      `create or replace function pccc3_refuse_second() returns trigger language plpgsql as $$
         begin
           if new.source_id = '${r2.id}' and new.content_sha256 <> '' then
             raise exception 'pccc3 second item refused';
           end if;
           return new;
         end $$`,
      []
    );
    await runSql(
      "create trigger pccc3_refuse_second before insert or update on graph_episodes for each row execute function pccc3_refuse_second()",
      []
    );
    const fake = new FakeGraphiti();
    const group = episodeGroupId(seed.teamSlug, "team");
    try {
      const err = await projectItemsToGraph(db(), {
        teamId: seed.teamId,
        teamSlug: seed.teamSlug,
        client: client(fake),
      }).then(
        () => null,
        (e: unknown) => e
      );
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).name).toBe("ProjectionAbortError");
      const partial = (err as { partial?: { episodes: number; episodesByGroup: Record<string, number> } }).partial;
      expect(partial).toBeDefined();
      expect(partial!.episodes).toBeGreaterThanOrEqual(1);
      expect(partial!.episodesByGroup[group]).toBeGreaterThanOrEqual(1);
    } finally {
      await runSql("drop trigger if exists pccc3_refuse_second on graph_episodes", []);
      await runSql("drop function if exists pccc3_refuse_second()", []);
    }
  });

  it("runGraphProjection records an aborted batch's partial pushes in the run summary (the catch-merge call site)", async () => {
    const seed = await seedTeam();
    const r1 = await ingest(seed, { body: "run-level: first lands", path: "run-one.md", access: "team" });
    const r2 = await ingest(seed, { body: "run-level: second refused", path: "run-two.md", access: "team" });
    expect(r1.id).not.toBe(r2.id);

    await runSql(
      `create or replace function pccc3_refuse_run() returns trigger language plpgsql as $$
         begin
           if new.source_id = '${r2.id}' and new.content_sha256 <> '' then
             raise exception 'pccc3 run-level refusal';
           end if;
           return new;
         end $$`,
      []
    );
    await runSql(
      "create trigger pccc3_refuse_run before insert or update on graph_episodes for each row execute function pccc3_refuse_run()",
      []
    );
    const fake = new FakeGraphiti();
    const group = episodeGroupId(seed.teamSlug, "team");
    try {
      const summary = await runGraphProjection({ teamId: seed.teamId, db: db(), client: client(fake) });
      expect(summary.ok).toBe(false); // the abort is still an error…
      expect(summary.errors.join(" ")).toContain("pccc3 run-level refusal");
      expect(summary.episodes).toBeGreaterThanOrEqual(1); // …but the paid-for pushes are recorded
      expect(summary.episodesByGroup[group]).toBeGreaterThanOrEqual(1);
    } finally {
      await runSql("drop trigger if exists pccc3_refuse_run on graph_episodes", []);
      await runSql("drop function if exists pccc3_refuse_run()", []);
    }
  });

  it("a refused push (outstanding purge failed, content unchanged) contributes NOTHING to episodesByGroup", async () => {
    const seed = await seedTeam();
    const fake = new FakeGraphiti();
    const r = await ingest(seed, { body: "unchanged under a failed purge", path: "refuse.md", access: "team" });
    await projectItemsToGraph(db(), { teamId: seed.teamId, teamSlug: seed.teamSlug, client: client(fake) });

    const group = episodeGroupId(seed.teamSlug, "team");
    // Simulate a pending purge on the push target (a redaction that was undone before reconcile
    // finished), then make the purge FAIL: the projector must refuse the re-push (pushing again
    // would duplicate) — and the refusal must not be counted as pushed episodes, or the Phase C
    // cost denominator inflates with pushes that never happened.
    const { error: flagErr } = await db()
      .from("graph_episodes")
      .update({ pending_delete_group_id: group, pending_delete_at: new Date().toISOString() })
      .eq("team_id", seed.teamId)
      .eq("source_id", r.id);
    expect(flagErr).toBeNull();

    fake.failDeletes = true;
    const before = fake.pushedEpisodes.length;
    const summary = await projectItemsToGraph(db(), {
      teamId: seed.teamId,
      teamSlug: seed.teamSlug,
      client: client(fake),
    });
    fake.failDeletes = false;

    expect(fake.pushedEpisodes.length).toBe(before); // the refusal pushed nothing…
    expect(summary.episodes).toBe(0); // …and neither counter claims it did
    expect(summary.episodesByGroup[group] ?? 0).toBe(0);
  });

  it("a ledger write failure on the REDACTION path is loud too (a silent one strands pre-redaction episodes with pendingCleanups reading 0)", async () => {
    const seed = await seedTeam();
    const fake = new FakeGraphiti();
    const r = await ingest(seed, { body: "soon to be redacted", path: "redact.md", access: "team" });
    await projectItemsToGraph(db(), { teamId: seed.teamId, teamSlug: seed.teamSlug, client: client(fake) });

    const { error: blankErr } = await db().from("items").update({ body: "" }).eq("id", r.id);
    expect(blankErr).toBeNull();

    await runSql(
      `create or replace function pccc3_refuse_redact() returns trigger language plpgsql as $$
         begin
           if new.source_id = '${r.id}' then raise exception 'pccc3 redaction write refused'; end if;
           return new;
         end $$`,
      []
    );
    await runSql(
      "create trigger pccc3_refuse_redact before insert or update on graph_episodes for each row execute function pccc3_refuse_redact()",
      []
    );
    try {
      await expect(
        projectItemsToGraph(db(), { teamId: seed.teamId, teamSlug: seed.teamSlug, client: client(fake) })
      ).rejects.toThrow(/pccc3 redaction write refused|redaction ledger/);
    } finally {
      await runSql("drop trigger if exists pccc3_refuse_redact on graph_episodes", []);
      await runSql("drop function if exists pccc3_refuse_redact()", []);
    }
  });

  it("the projection summary reports pushed episodes PER GROUP (the cost gate's denominator)", async () => {
    const seed = await seedTeam();
    const fake = new FakeGraphiti();
    await ingest(seed, { body: "team-tier content", path: "t.md", access: "team" });
    await ingest(seed, { body: "external-tier content", path: "e.md", access: "external" });

    const summary = await projectItemsToGraph(db(), {
      teamId: seed.teamId,
      teamSlug: seed.teamSlug,
      client: client(fake),
    });

    const teamGroup = episodeGroupId(seed.teamSlug, "team");
    const externalGroup = episodeGroupId(seed.teamSlug, "external");
    const pushedBy = (g: string) =>
      fake.pushes.filter((p) => p.groupId === g).reduce((n, p) => n + p.episodes.length, 0);
    expect(summary.episodesByGroup).toBeDefined();
    expect(summary.episodesByGroup![teamGroup]).toBe(pushedBy(teamGroup));
    expect(summary.episodesByGroup![externalGroup]).toBe(pushedBy(externalGroup));
    expect(pushedBy(teamGroup)).toBeGreaterThan(0);
    expect(pushedBy(externalGroup)).toBeGreaterThan(0);
  });
});

describe("PCCC-3 — consumers count ITEMS, not (item, group) rows", () => {
  const fanoutTeamIds: string[] = [];
  afterAll(async () => {
    // Restore the Deploy-A shape for any test file running after this one. The duplicate rows this
    // suite created must go FIRST — re-adding the unique over them fails and would silently leave
    // the whole container without the narrow invariant (observed: one leaked run reddened the
    // Deploy-A tests on the next).
    for (const teamId of fanoutTeamIds) {
      await runSql("delete from graph_episodes where team_id = $1", [teamId]);
    }
    await runSql(
      `do $$ begin
         if not exists (select 1 from pg_constraint where conname = '${NARROW_CONSTRAINT}') then
           alter table graph_episodes add constraint ${NARROW_CONSTRAINT} unique (team_id, source_table, source_id);
         end if;
       end $$`,
      []
    );
    const restored = await runSql<{ n: number }>(
      "select count(*)::int as n from pg_constraint where conname = $1",
      [NARROW_CONSTRAINT]
    );
    if ((restored.rows[0]?.n ?? 0) !== 1) throw new Error("narrow unique NOT restored — container is dirty");
  });

  it("the projector operates against the wide arbiter ALONE (Deploy B state: narrow unique dropped)", async () => {
    const seed = await seedTeam();
    fanoutTeamIds.push(seed.teamId);
    await runSql(`alter table graph_episodes drop constraint if exists ${NARROW_CONSTRAINT}`, []);

    // A 3-column conflict target would error here ("no unique or exclusion constraint matching") —
    // this is the test that keeps the 4-column target honest, because under Deploy A the narrow
    // unique also satisfies a 3-column target and every other test stays green (the
    // guard-must-cover-the-level-that-changed trap).
    const fake = new FakeGraphiti();
    const r = await ingest(seed, { body: "deploy B world", path: "b.md", access: "team" });
    await projectItemsToGraph(db(), { teamId: seed.teamId, teamSlug: seed.teamSlug, client: client(fake) });

    const rows = await runSql<{ content_sha256: string }>(
      "select content_sha256 from graph_episodes where team_id = $1 and source_id = $2",
      [seed.teamId, r.id]
    );
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0].content_sha256).toBe(sha("deploy B world"));
  });

  it("countProjectedEpisodes is invariant under fan-out (two group rows for one item = one item)", async () => {
    const seed = await seedTeam();
    fanoutTeamIds.push(seed.teamId);
    // Simulate the Deploy-B state this code must already tolerate: drop the narrow unique so one
    // item can legally hold rows in two groups (exactly what PCCC-5 fan-out produces).
    await runSql(`alter table graph_episodes drop constraint if exists ${NARROW_CONSTRAINT}`, []);

    const itemA = crypto.randomUUID();
    const itemB = crypto.randomUUID();
    const mk = (sourceId: string, group: string) =>
      db().from("graph_episodes").insert({
        team_id: seed.teamId,
        source_table: "items",
        source_id: sourceId,
        group_id: group,
        content_sha256: sha(sourceId + group),
      });
    expect((await mk(itemA, episodeGroupId(seed.teamSlug, "team"))).error).toBeNull();
    expect((await mk(itemA, `g_${"a".repeat(32)}_p_${"b".repeat(32)}`)).error).toBeNull();
    expect((await mk(itemB, episodeGroupId(seed.teamSlug, "team"))).error).toBeNull();

    expect(await countProjectedEpisodes(seed.teamId)).toBe(2); // items, not the 3 rows
  });
});
