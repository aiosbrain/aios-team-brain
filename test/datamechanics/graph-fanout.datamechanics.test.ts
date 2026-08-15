import { describe, expect, it } from "vitest";
import { projectItemsToGraph, retireEpisodesForItems, recoverUnledgeredFanoutPush } from "@/lib/graph/project";
import { runGraphProjection } from "@/lib/graph/run";
import { reconcileProjectedEpisodes } from "@/lib/graph/reconcile";
import { episodeGroupId, projectGroupId } from "@/lib/graph/group";
import { ensureAccessBootstrap } from "@/lib/access/bootstrap";
import { runSql } from "@/lib/db/pg/pool";
import { db, ingest, seedTeam, sha, type Seed } from "./helpers";
import { FakeGraphiti, client } from "./fake-graphiti";

/**
 * PCCC-5 — initiative fan-out: pointer-resolved home, DEFERRED fan-out rows, arm→push, budget.
 *
 * Design: docs/design/phase-c-per-project-graphs.md §2.2 (fan-out ADD-only, arming/deferral),
 * §2.4 step 3 (push budget), §2.5 (deferred state distinct from the '' sentinel, reconcile
 * exemption), and the rename doctrine (§2.5 — the projector resolving the stored pointer is what
 * dissolves the frozen-pointer vs live-slug divergence). Written before the implementation.
 *
 * Why this tier: deferral, arming, and the budget are ledger states in a REAL Postgres that
 * reconcile must respect; a stubbed store proves none of it.
 */

async function mkInitiative(seed: Seed, slug: string): Promise<{ projectId: string; group: string }> {
  const { data, error } = await db()
    .from("projects")
    .insert({ team_id: seed.teamId, slug, name: slug, kind: "initiative" })
    .select("id")
    .single();
  expect(error).toBeNull();
  const projectId = (data as { id: string }).id;
  const group = projectGroupId(seed.teamId, projectId);
  await runSql("update projects set graph_group_id = $1 where id = $2", [group, projectId]);
  return { projectId, group };
}

async function tagItem(seed: Seed, itemId: string, projectId: string): Promise<void> {
  const { data: unit, error: uErr } = await db()
    .from("project_context_units")
    .insert({
      team_id: seed.teamId,
      unit_kind: "item",
      source_item_id: itemId,
      unit_key: `item:${itemId}`,
      audience: "team",
      content_sha256: sha(itemId),
    })
    .select("id")
    .single();
  expect(uErr).toBeNull();
  const { error: mErr } = await db().from("project_context_memberships").insert({
    team_id: seed.teamId,
    project_id: projectId,
    context_unit_id: (unit as { id: string }).id,
    decision: "include",
    mode: "auto",
    method: "manual",
  });
  expect(mErr).toBeNull();
}

describe("PCCC-5 — the projector resolves the HOME group from the stored pointer", () => {
  it("a repointed General moves where team-tier items land (the pointer is the write authority)", async () => {
    const seed = await seedTeam();
    expect((await ensureAccessBootstrap(db(), seed.teamId)).ok).toBe(true);
    const custom = `g_${"c".repeat(32)}_p_${"d".repeat(32)}`;
    await runSql("update projects set graph_group_id = $1 where team_id = $2 and slug = 'general'", [
      custom,
      seed.teamId,
    ]);

    const fake = new FakeGraphiti();
    await ingest(seed, { body: "team content follows the pointer", path: "p.md", access: "team" });
    await projectItemsToGraph(db(), { teamId: seed.teamId, teamSlug: seed.teamSlug, client: client(fake) });

    expect(await fake.listEpisodes(custom)).toHaveLength(1);
    expect(await fake.listEpisodes(episodeGroupId(seed.teamSlug, "team"))).toHaveLength(0);
  });

  it("a team RENAME no longer diverges the write path — post-rename items still land in the pointer's (old-slug) group", async () => {
    const seed = await seedTeam();
    expect((await ensureAccessBootstrap(db(), seed.teamId)).ok).toBe(true);
    const oldGroup = episodeGroupId(seed.teamSlug, "team");

    const renamed = `moved-${crypto.randomUUID().slice(0, 8)}`;
    expect((await db().from("teams").update({ slug: renamed }).eq("id", seed.teamId)).error).toBeNull();

    const fake = new FakeGraphiti();
    await ingest(seed, { body: "post-rename content", path: "r.md", access: "team" });
    await projectItemsToGraph(db(), { teamId: seed.teamId, teamSlug: renamed, client: client(fake) });

    expect(await fake.listEpisodes(oldGroup)).toHaveLength(1); // the pointer's group — where the graph lives
    expect(await fake.listEpisodes(episodeGroupId(renamed, "team"))).toHaveLength(0);
  });

  it("an unbootstrapped team (no pointers) keeps today's episodeGroupId behavior — the quiet fallback", async () => {
    const seed = await seedTeam();
    const fake = new FakeGraphiti();
    await ingest(seed, { body: "no built-ins yet", path: "f.md", access: "team" });
    await projectItemsToGraph(db(), { teamId: seed.teamId, teamSlug: seed.teamSlug, client: client(fake) });
    expect(await fake.listEpisodes(episodeGroupId(seed.teamSlug, "team"))).toHaveLength(1);
  });
});

describe("PCCC-5 — fan-out is DEFERRED until armed; ADD-only", () => {
  it("an initiative membership yields a deferred ledger row and NO push (cold initiatives never extract)", async () => {
    const seed = await seedTeam();
    expect((await ensureAccessBootstrap(db(), seed.teamId)).ok).toBe(true);
    const init = await mkInitiative(seed, "warm-later");
    const r = await ingest(seed, { body: "tagged into an initiative", path: "t.md", access: "team" });
    await tagItem(seed, r.id, init.projectId);

    const fake = new FakeGraphiti();
    await projectItemsToGraph(db(), { teamId: seed.teamId, teamSlug: seed.teamSlug, client: client(fake) });

    expect(await fake.listEpisodes(init.group)).toHaveLength(0); // nothing extracted
    const rows = await runSql<{ deferred: boolean; content_sha256: string }>(
      "select deferred, content_sha256 from graph_episodes where team_id = $1 and source_id = $2 and group_id = $3",
      [seed.teamId, r.id, init.group]
    );
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0].deferred).toBe(true);
    expect(rows.rows[0].content_sha256).toBe("");
  });

  it("an ARMED fan-out row is pushed on the next pass, counted in episodesByGroup, with a real sha", async () => {
    const seed = await seedTeam();
    expect((await ensureAccessBootstrap(db(), seed.teamId)).ok).toBe(true);
    const init = await mkInitiative(seed, "armed-now");
    const r = await ingest(seed, { body: "armed content reaches the graph", path: "a.md", access: "team" });
    await tagItem(seed, r.id, init.projectId);
    const fake = new FakeGraphiti();
    await projectItemsToGraph(db(), { teamId: seed.teamId, teamSlug: seed.teamSlug, client: client(fake) });

    // The PCCC-6 arming interface, exercised directly: deferred → false, sha stays ''.
    await runSql("update graph_episodes set deferred = false where team_id = $1 and source_id = $2 and group_id = $3", [
      seed.teamId,
      r.id,
      init.group,
    ]);
    const summary = await projectItemsToGraph(db(), {
      teamId: seed.teamId,
      teamSlug: seed.teamSlug,
      client: client(fake),
    });

    expect((await fake.listEpisodes(init.group)).length).toBeGreaterThan(0);
    expect(summary.episodesByGroup[init.group] ?? 0).toBeGreaterThan(0);
    const row = await runSql<{ content_sha256: string }>(
      "select content_sha256 from graph_episodes where team_id = $1 and source_id = $2 and group_id = $3",
      [seed.teamId, r.id, init.group]
    );
    expect(row.rows[0].content_sha256).toBe(sha("armed content reaches the graph"));
  });

  it("the fan-out push budget caps armed pushes per pass; the excess stays queued, none is lost", async () => {
    const seed = await seedTeam();
    expect((await ensureAccessBootstrap(db(), seed.teamId)).ok).toBe(true);
    const init = await mkInitiative(seed, "budgeted");
    const ids: string[] = [];
    for (const n of [1, 2, 3]) {
      const r = await ingest(seed, { body: `budgeted item ${n}`, path: `b${n}.md`, access: "team" });
      ids.push(r.id);
      await tagItem(seed, r.id, init.projectId);
    }
    const fake = new FakeGraphiti();
    await projectItemsToGraph(db(), { teamId: seed.teamId, teamSlug: seed.teamSlug, client: client(fake) });
    await runSql("update graph_episodes set deferred = false where team_id = $1 and group_id = $2", [
      seed.teamId,
      init.group,
    ]);

    await projectItemsToGraph(db(), {
      teamId: seed.teamId,
      teamSlug: seed.teamSlug,
      client: client(fake),
      fanoutPushBudget: 1,
    });
    expect(await fake.listEpisodes(init.group)).toHaveLength(1); // exactly the budget

    await projectItemsToGraph(db(), {
      teamId: seed.teamId,
      teamSlug: seed.teamSlug,
      client: client(fake),
      fanoutPushBudget: 10,
    });
    expect(await fake.listEpisodes(init.group)).toHaveLength(3); // the rest converge
  });

  it("the budget holds at RUN level — pages cannot each claim a fresh allowance (review High 1)", async () => {
    const seed = await seedTeam();
    expect((await ensureAccessBootstrap(db(), seed.teamId)).ok).toBe(true);
    const init = await mkInitiative(seed, "run-budgeted");
    for (const n of [1, 2, 3]) {
      const r = await ingest(seed, { body: `run-budget item ${n}`, path: `rb${n}.md`, access: "team" });
      await tagItem(seed, r.id, init.projectId);
    }
    const fake = new FakeGraphiti();
    await runGraphProjection({ teamId: seed.teamId, db: db(), client: client(fake) });
    await runSql("update graph_episodes set deferred = false where team_id = $1 and group_id = $2", [
      seed.teamId,
      init.group,
    ]);

    // limit:1 forces one item per batch — the exact seam where a per-call budget silently resets.
    const summary = await runGraphProjection({
      teamId: seed.teamId,
      db: db(),
      client: client(fake),
      limit: 1,
      fanoutPushBudget: 2,
    });
    expect(await fake.listEpisodes(init.group)).toHaveLength(2); // 2, not 3 — the run-level cap held
    expect(summary.fanoutThrottled).toBeGreaterThanOrEqual(1); // and the remainder is REPORTED
  });

  it("REDACTION of an armed-and-pushed fan-out row tombstones it with a purge pointer (review High 2 — the door B2 closes for home)", async () => {
    const seed = await seedTeam();
    expect((await ensureAccessBootstrap(db(), seed.teamId)).ok).toBe(true);
    const init = await mkInitiative(seed, "redact-armed");
    const r = await ingest(seed, { body: "sensitive, later redacted", path: "sr.md", access: "team" });
    await tagItem(seed, r.id, init.projectId);
    const fake = new FakeGraphiti();
    await projectItemsToGraph(db(), { teamId: seed.teamId, teamSlug: seed.teamSlug, client: client(fake) });
    await runSql("update graph_episodes set deferred = false where team_id = $1 and group_id = $2", [
      seed.teamId,
      init.group,
    ]);
    await projectItemsToGraph(db(), { teamId: seed.teamId, teamSlug: seed.teamSlug, client: client(fake) });
    expect((await fake.listEpisodes(init.group)).length).toBeGreaterThan(0); // armed content is in P's graph

    expect((await db().from("items").update({ body: "" }).eq("id", r.id)).error).toBeNull();
    await projectItemsToGraph(db(), { teamId: seed.teamId, teamSlug: seed.teamSlug, client: client(fake) });

    const row = await runSql<{ content_sha256: string; pending_delete_group_id: string | null }>(
      "select content_sha256, pending_delete_group_id from graph_episodes where team_id = $1 and source_id = $2 and group_id = $3",
      [seed.teamId, r.id, init.group]
    );
    expect(row.rows).toHaveLength(1);
    expect(row.rows[0].content_sha256).toBe(""); // parked, re-pushes if content returns
    expect(row.rows[0].pending_delete_group_id).toBe(init.group); // reconcile owns the durable purge
    expect(await fake.listEpisodes(init.group)).toHaveLength(0); // inline best-effort already cleared it
  });

  it("REDACTION tombstones an armed row even with a '' sha — armed-and-crashed is indistinguishable from armed-unpushed (Codex High 1)", async () => {
    const seed = await seedTeam();
    expect((await ensureAccessBootstrap(db(), seed.teamId)).ok).toBe(true);
    const init = await mkInitiative(seed, "armed-crash-window");
    const r = await ingest(seed, { body: "armed then redacted before recording", path: "acw.md", access: "team" });
    await tagItem(seed, r.id, init.projectId);
    const fake = new FakeGraphiti();
    await projectItemsToGraph(db(), { teamId: seed.teamId, teamSlug: seed.teamSlug, client: client(fake) });
    // Arm but DON'T project — the row sits deferred=false, sha '' (exactly the crash-window state).
    await runSql("update graph_episodes set deferred = false where team_id = $1 and group_id = $2", [
      seed.teamId,
      init.group,
    ]);

    expect((await db().from("items").update({ body: "" }).eq("id", r.id)).error).toBeNull();
    await projectItemsToGraph(db(), { teamId: seed.teamId, teamSlug: seed.teamSlug, client: client(fake) });

    const row = await runSql<{ pending_delete_group_id: string | null }>(
      "select pending_delete_group_id from graph_episodes where team_id = $1 and source_id = $2 and group_id = $3",
      [seed.teamId, r.id, init.group]
    );
    expect(row.rows).toHaveLength(1);
    expect(row.rows[0].pending_delete_group_id).toBe(init.group); // reconcile purges whatever may have landed
  });

  it("an abort AFTER an accepted fan-out push still carries the spend in its partial summary (Codex Medium 3)", async () => {
    const seed = await seedTeam();
    expect((await ensureAccessBootstrap(db(), seed.teamId)).ok).toBe(true);
    const init = await mkInitiative(seed, "abort-counts");
    const r = await ingest(seed, { body: "pushed then write refused", path: "pw.md", access: "team" });
    await tagItem(seed, r.id, init.projectId);
    const fake = new FakeGraphiti();
    await projectItemsToGraph(db(), { teamId: seed.teamId, teamSlug: seed.teamSlug, client: client(fake) });
    await runSql("update graph_episodes set deferred = false where team_id = $1 and group_id = $2", [
      seed.teamId,
      init.group,
    ]);
    // Refuse the item's real-sha ledger writes: on this pass the home row sha-skips, so the only
    // real-sha write is the armed fan-out update — the push precedes it and must still be counted.
    await runSql(
      `create or replace function pccc5_refuse_fanwrite() returns trigger language plpgsql as $$
         begin
           if new.source_id = '${r.id}' and new.content_sha256 <> '' then
             raise exception 'pccc5 fan-out write refused';
           end if;
           return new;
         end $$`,
      []
    );
    await runSql(
      "create trigger pccc5_refuse_fanwrite before insert or update on graph_episodes for each row execute function pccc5_refuse_fanwrite()",
      []
    );
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
      const partial = (err as { partial?: { episodesByGroup: Record<string, number> } }).partial;
      expect(partial!.episodesByGroup[init.group] ?? 0).toBeGreaterThan(0); // the push WAS incurred
    } finally {
      await runSql("drop trigger if exists pccc5_refuse_fanwrite on graph_episodes", []);
      await runSql("drop function if exists pccc5_refuse_fanwrite()", []);
    }
  });

  it("recoverUnledgeredFanoutPush restores a durable purge pointer when the row vanished mid-pass (Codex High 2)", async () => {
    const seed = await seedTeam();
    const group = `g_${"a".repeat(32)}_p_${"9".repeat(32)}`;
    const itemId = crypto.randomUUID();

    // (a) no row at all → a tombstone row with the flag appears
    await recoverUnledgeredFanoutPush(db(), {
      teamId: seed.teamId,
      itemId,
      groupId: group,
      partial: () => ({
        scanned: 0, projected: 0, episodes: 0, episodesByGroup: {}, fanoutPushed: 0,
        fanoutThrottled: 0, skipped: 0, externalGroupVacated: 0,
      }),
    });
    const made = await runSql<{ pending_delete_group_id: string | null; deferred: boolean }>(
      "select pending_delete_group_id, deferred from graph_episodes where team_id = $1 and source_id = $2 and group_id = $3",
      [seed.teamId, itemId, group]
    );
    expect(made.rows).toHaveLength(1);
    expect(made.rows[0].pending_delete_group_id).toBe(group);
    expect(made.rows[0].deferred).toBe(false);

    // (b) a racer's completed row is never stomped
    const doneItem = crypto.randomUUID();
    await db().from("graph_episodes").insert({
      team_id: seed.teamId, source_table: "items", source_id: doneItem, group_id: group.replace(/9/g, "8"),
      content_sha256: sha("racer finished"), deferred: false,
    });
    await recoverUnledgeredFanoutPush(db(), {
      teamId: seed.teamId,
      itemId: doneItem,
      groupId: group.replace(/9/g, "8"),
      partial: () => ({
        scanned: 0, projected: 0, episodes: 0, episodesByGroup: {}, fanoutPushed: 0,
        fanoutThrottled: 0, skipped: 0, externalGroupVacated: 0,
      }),
    });
    const kept = await runSql<{ content_sha256: string; pending_delete_group_id: string | null }>(
      "select content_sha256, pending_delete_group_id from graph_episodes where team_id = $1 and source_id = $2",
      [seed.teamId, doneItem]
    );
    expect(kept.rows[0].content_sha256).toBe(sha("racer finished"));
    expect(kept.rows[0].pending_delete_group_id).toBeNull();
  });

  it("a redacted AND untagged item still gets its deferred bookkeeping cleaned (Codex Low 4)", async () => {
    const seed = await seedTeam();
    expect((await ensureAccessBootstrap(db(), seed.teamId)).ok).toBe(true);
    const init = await mkInitiative(seed, "redact-untag");
    const r = await ingest(seed, { body: "redacted and untagged together", path: "ru.md", access: "team" });
    await tagItem(seed, r.id, init.projectId);
    const fake = new FakeGraphiti();
    await projectItemsToGraph(db(), { teamId: seed.teamId, teamSlug: seed.teamSlug, client: client(fake) });

    expect((await db().from("items").update({ body: "" }).eq("id", r.id)).error).toBeNull();
    expect(
      (
        await db()
          .from("project_context_memberships")
          .update({ valid_to: new Date().toISOString() })
          .eq("team_id", seed.teamId)
          .eq("project_id", init.projectId)
      ).error
    ).toBeNull();
    await projectItemsToGraph(db(), { teamId: seed.teamId, teamSlug: seed.teamSlug, client: client(fake) });

    const left = await runSql<{ n: number }>(
      "select count(*)::int as n from graph_episodes where team_id = $1 and source_id = $2 and group_id = $3",
      [seed.teamId, r.id, init.group]
    );
    expect(left.rows[0].n).toBe(0); // the deferred row is gone despite the redaction exit
  });

  it("purging an ITEM hard-deletes its deferred rows — no zombie invisible to every janitor (review Medium 3)", async () => {
    const seed = await seedTeam();
    expect((await ensureAccessBootstrap(db(), seed.teamId)).ok).toBe(true);
    const init = await mkInitiative(seed, "purge-deferred");
    const r = await ingest(seed, { body: "tagged then purged", path: "tp.md", access: "team" });
    await tagItem(seed, r.id, init.projectId);
    const fake = new FakeGraphiti();
    await projectItemsToGraph(db(), { teamId: seed.teamId, teamSlug: seed.teamSlug, client: client(fake) });

    const retired = await retireEpisodesForItems(db(), seed.teamId, [r.id], { client: client(fake) });
    expect(retired).toBeGreaterThanOrEqual(2); // home row + deferred row both accounted
    const left = await runSql<{ n: number }>(
      "select count(*)::int as n from graph_episodes where team_id = $1 and source_id = $2 and deferred = true",
      [seed.teamId, r.id]
    );
    expect(left.rows[0].n).toBe(0);
  });

  it("untagging a DEFERRED (never-pushed) row deletes it — pure bookkeeping, distinct from the PCCC-6 purge machinery", async () => {
    const seed = await seedTeam();
    expect((await ensureAccessBootstrap(db(), seed.teamId)).ok).toBe(true);
    const init = await mkInitiative(seed, "brief-tag");
    const r = await ingest(seed, { body: "tagged then untagged", path: "u.md", access: "team" });
    await tagItem(seed, r.id, init.projectId);
    const fake = new FakeGraphiti();
    await projectItemsToGraph(db(), { teamId: seed.teamId, teamSlug: seed.teamSlug, client: client(fake) });

    const { error } = await db()
      .from("project_context_memberships")
      .update({ valid_to: new Date().toISOString() })
      .eq("team_id", seed.teamId)
      .eq("project_id", init.projectId);
    expect(error).toBeNull();
    await projectItemsToGraph(db(), { teamId: seed.teamId, teamSlug: seed.teamSlug, client: client(fake) });

    const rows = await runSql<{ n: number }>(
      "select count(*)::int as n from graph_episodes where team_id = $1 and source_id = $2 and group_id = $3",
      [seed.teamId, r.id, init.group]
    );
    expect(rows.rows[0].n).toBe(0);
  });

  it("deferred rows are INVISIBLE to reconcile's landed-check (its never-landed delete would churn them forever)", async () => {
    const seed = await seedTeam();
    expect((await ensureAccessBootstrap(db(), seed.teamId)).ok).toBe(true);
    const init = await mkInitiative(seed, "reconcile-safe");
    const r = await ingest(seed, { body: "deferred through reconcile", path: "rc.md", access: "team" });
    await tagItem(seed, r.id, init.projectId);
    const fake = new FakeGraphiti();
    await projectItemsToGraph(db(), { teamId: seed.teamId, teamSlug: seed.teamSlug, client: client(fake) });

    // Age past every grace so a non-exempt row WOULD be judged, then reconcile.
    await runSql(
      "update graph_episodes set projected_at = now() - interval '2 days' where team_id = $1 and group_id = $2",
      [seed.teamId, init.group]
    );
    await reconcileProjectedEpisodes(db(), client(fake), seed.teamId);

    const rows = await runSql<{ deferred: boolean }>(
      "select deferred from graph_episodes where team_id = $1 and source_id = $2 and group_id = $3",
      [seed.teamId, r.id, init.group]
    );
    expect(rows.rows).toHaveLength(1); // survived, still deferred
    expect(rows.rows[0].deferred).toBe(true);
  });

  it("fan-out rows never disturb HOME semantics: a tier flip moves the home row only", async () => {
    const seed = await seedTeam();
    expect((await ensureAccessBootstrap(db(), seed.teamId)).ok).toBe(true);
    const init = await mkInitiative(seed, "home-safe");
    const r = await ingest(seed, { body: "home and fan-out coexist", path: "h.md", access: "external" });
    await tagItem(seed, r.id, init.projectId);
    const fake = new FakeGraphiti();
    await projectItemsToGraph(db(), { teamId: seed.teamId, teamSlug: seed.teamSlug, client: client(fake) });

    expect((await db().from("items").update({ access: "team" }).eq("id", r.id)).error).toBeNull();
    await projectItemsToGraph(db(), { teamId: seed.teamId, teamSlug: seed.teamSlug, client: client(fake) });

    const rows = await runSql<{ group_id: string; deferred: boolean; pending_delete_group_id: string | null }>(
      "select group_id, deferred, pending_delete_group_id from graph_episodes where team_id = $1 and source_id = $2 order by deferred",
      [seed.teamId, r.id]
    );
    expect(rows.rows).toHaveLength(2); // moved home row + untouched deferred fan-out row
    const home = rows.rows.find((x) => !x.deferred)!;
    const fan = rows.rows.find((x) => x.deferred)!;
    expect(home.group_id).toBe(episodeGroupId(seed.teamSlug, "team"));
    expect(home.pending_delete_group_id).toBe(episodeGroupId(seed.teamSlug, "external"));
    expect(fan.group_id).toBe(init.group);
  });
});
