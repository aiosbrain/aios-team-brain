import { describe, expect, it } from "vitest";
import { projectItemsToGraph } from "@/lib/graph/project";
import { reconcileProjectedEpisodes } from "@/lib/graph/reconcile";
import { episodeGroupId } from "@/lib/graph/group";
import { ensureAccessBootstrap } from "@/lib/access/bootstrap";
import { runSql } from "@/lib/db/pg/pool";
import { db, ingest, seedTeam, sha, type Seed } from "./helpers";
import { mkInitiative, tagItem } from "./graph-helpers";
import { FakeGraphiti, client } from "./fake-graphiti";

/**
 * PCCC-6 — restriction-moves-not-copies, LANDED-GATED (spec rule 2; design §2.2's sequencing
 * consequence), plus the untag-of-pushed removed side. The move is copy-then-delete: General is
 * purged only once a landed initiative copy exists — never before (content loss), and never
 * re-pushed after (the parked-sentinel hold). Spec-first.
 */

async function generalProjectId(seed: Seed): Promise<string> {
  const { data } = await db()
    .from("projects")
    .select("id")
    .eq("team_id", seed.teamId)
    .eq("slug", "general")
    .single();
  return (data as { id: string }).id;
}

/** Close the item's General membership — the restriction act itself. */
async function restrictFromGeneral(seed: Seed, itemId: string): Promise<void> {
  const gp = await generalProjectId(seed);
  const { error } = await runSql(
    `update project_context_memberships m set valid_to = now()
       from project_context_units u
      where m.context_unit_id = u.id and m.team_id = $1 and u.source_item_id = $2 and m.project_id = $3`,
    [seed.teamId, itemId, gp]
  ).then(
    () => ({ error: null }),
    (e: unknown) => ({ error: e })
  );
  expect(error).toBeNull();
}

/** The ingest context hook parks items in General; mirror that for these fixtures. */
async function tagIntoGeneral(seed: Seed, itemId: string): Promise<void> {
  await tagItem(seed, itemId, await generalProjectId(seed));
}

describe("PCCC-6 — the landed-gated restriction move", () => {
  it("General keeps the content until a LANDED initiative copy exists — restriction never loses content", async () => {
    const seed = await seedTeam();
    expect((await ensureAccessBootstrap(db(), seed.teamId)).ok).toBe(true);
    const init = await mkInitiative(seed, "restricted-project");
    const r = await ingest(seed, { body: "sensitive supplier terms", path: "sup.md", access: "team" });
    await tagIntoGeneral(seed, r.id);
    await tagItem(seed, r.id, init.projectId);
    const fake = new FakeGraphiti();
    await projectItemsToGraph(db(), { teamId: seed.teamId, teamSlug: seed.teamSlug, client: client(fake) });

    await restrictFromGeneral(seed, r.id);
    await projectItemsToGraph(db(), { teamId: seed.teamId, teamSlug: seed.teamSlug, client: client(fake) });

    // The initiative copy is still DEFERRED (never armed) → the home row must be untouched.
    const home = await runSql<{ content_sha256: string; pending_delete_group_id: string | null }>(
      "select content_sha256, pending_delete_group_id from graph_episodes where team_id = $1 and source_id = $2 and group_id = $3",
      [seed.teamId, r.id, episodeGroupId(seed.teamSlug, "team")]
    );
    expect(home.rows[0].content_sha256).toBe(sha("sensitive supplier terms"));
    expect(home.rows[0].pending_delete_group_id).toBeNull();
  });

  it("once the initiative copy LANDS, the move completes: home tombstoned with a self purge flag, then PARKED — never re-pushed", async () => {
    const seed = await seedTeam();
    expect((await ensureAccessBootstrap(db(), seed.teamId)).ok).toBe(true);
    const init = await mkInitiative(seed, "restricted-landing");
    const r = await ingest(seed, { body: "moving to restricted", path: "mv.md", access: "team" });
    await tagIntoGeneral(seed, r.id);
    await tagItem(seed, r.id, init.projectId);
    const fake = new FakeGraphiti();
    await projectItemsToGraph(db(), { teamId: seed.teamId, teamSlug: seed.teamSlug, client: client(fake) });
    // Arm + push the initiative copy (the enforcing reader's side effects, exercised directly).
    await runSql("update graph_episodes set deferred = false where team_id = $1 and group_id = $2", [
      seed.teamId,
      init.group,
    ]);
    await projectItemsToGraph(db(), { teamId: seed.teamId, teamSlug: seed.teamSlug, client: client(fake) });
    // Reconcile-CONFIRM the copy (review-2 High 3: a 202'd-but-unconfirmed copy must not complete
    // the move — a silently-dead worker would lose the content everywhere).
    await runSql("update graph_episodes set episode_uuid = 'ep-c' where team_id = $1 and group_id = $2", [
      seed.teamId,
      init.group,
    ]);

    await restrictFromGeneral(seed, r.id);
    await projectItemsToGraph(db(), { teamId: seed.teamId, teamSlug: seed.teamSlug, client: client(fake) });

    const homeGroup = episodeGroupId(seed.teamSlug, "team");
    const home = await runSql<{ content_sha256: string; pending_delete_group_id: string | null }>(
      "select content_sha256, pending_delete_group_id from graph_episodes where team_id = $1 and source_id = $2 and group_id = $3",
      [seed.teamId, r.id, homeGroup]
    );
    expect(home.rows[0].content_sha256).toBe("");
    expect(home.rows[0].pending_delete_group_id).toBe(homeGroup); // reconcile owns the durable purge

    // Simulate the purge confirming (flag cleared) — the parked sentinel must HOLD, not re-push.
    await runSql(
      "update graph_episodes set pending_delete_group_id = null where team_id = $1 and source_id = $2 and group_id = $3",
      [seed.teamId, r.id, homeGroup]
    );
    const before = (await fake.listEpisodes(homeGroup)).length;
    await projectItemsToGraph(db(), { teamId: seed.teamId, teamSlug: seed.teamSlug, client: client(fake) });
    expect((await fake.listEpisodes(homeGroup)).length).toBe(before); // no hourly resurrection
    const parked = await runSql<{ content_sha256: string }>(
      "select content_sha256 from graph_episodes where team_id = $1 and source_id = $2 and group_id = $3",
      [seed.teamId, r.id, homeGroup]
    );
    expect(parked.rows[0].content_sha256).toBe("");
  });

  it("content restricted FROM INGEST (exclusive flow) never enters General's graph at all", async () => {
    const seed = await seedTeam();
    expect((await ensureAccessBootstrap(db(), seed.teamId)).ok).toBe(true);
    const init = await mkInitiative(seed, "exclusive-from-birth");
    const r = await ingest(seed, { body: "born restricted", path: "born.md", access: "team" });
    // Tagged into the initiative ONLY — an explicit unit exists, no General membership.
    await tagItem(seed, r.id, init.projectId);
    const fake = new FakeGraphiti();
    await projectItemsToGraph(db(), { teamId: seed.teamId, teamSlug: seed.teamSlug, client: client(fake) });

    expect(await fake.listEpisodes(episodeGroupId(seed.teamSlug, "team"))).toHaveLength(0);
    const homeRow = await runSql<{ n: number }>(
      "select count(*)::int as n from graph_episodes where team_id = $1 and source_id = $2 and group_id = $3",
      [seed.teamId, r.id, episodeGroupId(seed.teamSlug, "team")]
    );
    expect(homeRow.rows[0].n).toBe(0);
    const fanRow = await runSql<{ deferred: boolean }>(
      "select deferred from graph_episodes where team_id = $1 and source_id = $2 and group_id = $3",
      [seed.teamId, r.id, init.group]
    );
    expect(fanRow.rows[0].deferred).toBe(true); // deferral still governs its extraction
  });

  it("restriction creates the ARMING ROW itself — a permissive team's moved content stays latchable and union-servable (review-2 Blocker 1)", async () => {
    const seed = await seedTeam();
    expect((await ensureAccessBootstrap(db(), seed.teamId)).ok).toBe(true);
    const init = await mkInitiative(seed, "permissive-move");
    const r = await ingest(seed, { body: "moved on a permissive team", path: "pm.md", access: "team" });
    await tagIntoGeneral(seed, r.id);
    await tagItem(seed, r.id, init.projectId);
    const fake = new FakeGraphiti();
    await projectItemsToGraph(db(), { teamId: seed.teamId, teamSlug: seed.teamSlug, client: client(fake) });

    await restrictFromGeneral(seed, r.id);
    await projectItemsToGraph(db(), { teamId: seed.teamId, teamSlug: seed.teamSlug, client: client(fake) });

    const armRow = await runSql<{ n: number }>(
      "select count(*)::int as n from graph_project_arming where team_id = $1 and project_id = $2",
      [seed.teamId, init.projectId]
    );
    expect(armRow.rows[0].n).toBe(1); // no reader required — readyPartitions can latch this partition
  });

  it("reconcile's never-landed judge SKIPS armed-but-unpushed rows — the restriction copy survives a reader-quiet cycle (review-2 Blocker 2)", async () => {
    const seed = await seedTeam();
    expect((await ensureAccessBootstrap(db(), seed.teamId)).ok).toBe(true);
    const init = await mkInitiative(seed, "quiet-team");
    const r = await ingest(seed, { body: "restricted on a quiet team", path: "qt.md", access: "team" });
    await tagIntoGeneral(seed, r.id);
    await tagItem(seed, r.id, init.projectId);
    const fake = new FakeGraphiti();
    await projectItemsToGraph(db(), { teamId: seed.teamId, teamSlug: seed.teamSlug, client: client(fake) });
    await restrictFromGeneral(seed, r.id);
    await projectItemsToGraph(db(), { teamId: seed.teamId, teamSlug: seed.teamSlug, client: client(fake) });

    // Armed ('' sha, empty chunk ledger), aged past every grace — the exact state reconcile's
    // never-landed delete used to eat, re-cold-starting the arm every cycle forever.
    await runSql(
      "update graph_episodes set projected_at = now() - interval '2 days' where team_id = $1 and group_id = $2",
      [seed.teamId, init.group]
    );
    await reconcileProjectedEpisodes(db(), client(fake), seed.teamId);

    const row = await runSql<{ deferred: boolean; content_sha256: string }>(
      "select deferred, content_sha256 from graph_episodes where team_id = $1 and source_id = $2 and group_id = $3",
      [seed.teamId, r.id, init.group]
    );
    expect(row.rows).toHaveLength(1); // survived — the projector owns its convergence
    expect(row.rows[0].deferred).toBe(false); // still armed, still queued for its budgeted push
  });

  it("an item with NO substrate rows keeps today's home write — only explicit membership state restricts", async () => {
    const seed = await seedTeam();
    expect((await ensureAccessBootstrap(db(), seed.teamId)).ok).toBe(true);
    const fake = new FakeGraphiti();
    await ingest(seed, { body: "pre-substrate content", path: "pre.md", access: "team" });
    await projectItemsToGraph(db(), { teamId: seed.teamId, teamSlug: seed.teamSlug, client: client(fake) });
    expect(await fake.listEpisodes(episodeGroupId(seed.teamSlug, "team"))).toHaveLength(1);
  });

  it("UNTAG of a PUSHED fan-out row tombstones it — the removed side is live for pushed content", async () => {
    const seed = await seedTeam();
    expect((await ensureAccessBootstrap(db(), seed.teamId)).ok).toBe(true);
    const init = await mkInitiative(seed, "untag-pushed");
    const r = await ingest(seed, { body: "pushed then untagged", path: "pu.md", access: "team" });
    await tagIntoGeneral(seed, r.id);
    await tagItem(seed, r.id, init.projectId);
    const fake = new FakeGraphiti();
    await projectItemsToGraph(db(), { teamId: seed.teamId, teamSlug: seed.teamSlug, client: client(fake) });
    await runSql("update graph_episodes set deferred = false where team_id = $1 and group_id = $2", [
      seed.teamId,
      init.group,
    ]);
    await projectItemsToGraph(db(), { teamId: seed.teamId, teamSlug: seed.teamSlug, client: client(fake) });
    expect((await fake.listEpisodes(init.group)).length).toBeGreaterThan(0);

    const gp = init.projectId;
    const { error } = await db()
      .from("project_context_memberships")
      .update({ valid_to: new Date().toISOString() })
      .eq("team_id", seed.teamId)
      .eq("project_id", gp);
    expect(error).toBeNull();
    await projectItemsToGraph(db(), { teamId: seed.teamId, teamSlug: seed.teamSlug, client: client(fake) });

    const row = await runSql<{ content_sha256: string; pending_delete_group_id: string | null }>(
      "select content_sha256, pending_delete_group_id from graph_episodes where team_id = $1 and source_id = $2 and group_id = $3",
      [seed.teamId, r.id, init.group]
    );
    expect(row.rows[0].content_sha256).toBe("");
    expect(row.rows[0].pending_delete_group_id).toBe(init.group);
    expect(await fake.listEpisodes(init.group)).toHaveLength(0); // inline best-effort cleared it

    // LIFECYCLE COMPLETION (review High 1): once reconcile confirms the purge (flag cleared, row
    // kept at ''), the next pass must DELETE the row — not re-tombstone it, which would suppress
    // the partition forever, block the latch (High 2), and deep-scan Graphiti hourly.
    await runSql(
      "update graph_episodes set pending_delete_group_id = null where team_id = $1 and source_id = $2 and group_id = $3",
      [seed.teamId, r.id, init.group]
    );
    await projectItemsToGraph(db(), { teamId: seed.teamId, teamSlug: seed.teamSlug, client: client(fake) });
    const done = await runSql<{ n: number }>(
      "select count(*)::int as n from graph_episodes where team_id = $1 and source_id = $2 and group_id = $3",
      [seed.teamId, r.id, init.group]
    );
    expect(done.rows[0].n).toBe(0); // the lifecycle ends; nothing re-tombstones, nothing suppresses
  });

  it("RESTRICTION arms the deferred copy itself — the move never waits for a reader (review High 3)", async () => {
    const seed = await seedTeam();
    expect((await ensureAccessBootstrap(db(), seed.teamId)).ok).toBe(true);
    const init = await mkInitiative(seed, "arm-on-restrict");
    const r = await ingest(seed, { body: "restricted, nobody queries P", path: "nq.md", access: "team" });
    await tagIntoGeneral(seed, r.id);
    await tagItem(seed, r.id, init.projectId);
    const fake = new FakeGraphiti();
    await projectItemsToGraph(db(), { teamId: seed.teamId, teamSlug: seed.teamSlug, client: client(fake) });
    // Copy exists but is DEFERRED (no reader ever armed it).
    await restrictFromGeneral(seed, r.id);
    const summary = await projectItemsToGraph(db(), {
      teamId: seed.teamId,
      teamSlug: seed.teamSlug,
      client: client(fake),
    });
    expect(summary.restrictionMovesPending).toBeGreaterThanOrEqual(1); // the exposure is OBSERVABLE
    const copy = await runSql<{ deferred: boolean }>(
      "select deferred from graph_episodes where team_id = $1 and source_id = $2 and group_id = $3",
      [seed.teamId, r.id, init.group]
    );
    expect(copy.rows[0].deferred).toBe(false); // restriction itself armed the copy

    // The copy pushes on a later pass; once landed, the move completes without any reader.
    await projectItemsToGraph(db(), { teamId: seed.teamId, teamSlug: seed.teamSlug, client: client(fake) });
    await runSql("update graph_episodes set episode_uuid = 'ep-l' where team_id = $1 and group_id = $2", [
      seed.teamId,
      init.group,
    ]);
    await projectItemsToGraph(db(), { teamId: seed.teamId, teamSlug: seed.teamSlug, client: client(fake) });
    const home = await runSql<{ content_sha256: string }>(
      "select content_sha256 from graph_episodes where team_id = $1 and source_id = $2 and group_id = $3",
      [seed.teamId, r.id, episodeGroupId(seed.teamSlug, "team")]
    );
    expect(home.rows[0].content_sha256).toBe(""); // the move completed reader-free
  });
});
