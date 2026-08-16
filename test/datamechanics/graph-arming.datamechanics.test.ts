import { describe, expect, it } from "vitest";
import { projectItemsToGraph } from "@/lib/graph/project";
import { armProjectsForPrincipal, readyPartitions } from "@/lib/graph/arming";
import { ensureArmingRows } from "@/lib/graph/arming-row";
import { projectGroupId } from "@/lib/graph/group";
import { ensureAccessBootstrap } from "@/lib/access/bootstrap";
import { runSql } from "@/lib/db/pg/pool";
import { db, ingest, seedTeam, sha, type Seed } from "./helpers";
import { FakeGraphiti, client } from "./fake-graphiti";

/**
 * PCCC-6 — arm-on-read + the read-ready MONOTONE latch (design §2.2/§2.3, three review rounds:
 * the latch is an arm-time obligation snapshot — the armed rows themselves — never a live "all
 * currently landed" predicate, which starves busy initiatives and flaps; a partition owing a
 * purge is SUPPRESSED at read time without un-latching). Written before the implementation.
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
  const { data: unit } = await db()
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
  const { error } = await db().from("project_context_memberships").insert({
    team_id: seed.teamId,
    project_id: projectId,
    context_unit_id: (unit as { id: string }).id,
    decision: "include",
    mode: "auto",
    method: "manual",
  });
  expect(error).toBeNull();
}

async function setup(seed: Seed, slug: string): Promise<{ projectId: string; group: string; itemId: string }> {
  expect((await ensureAccessBootstrap(db(), seed.teamId)).ok).toBe(true);
  const init = await mkInitiative(seed, slug);
  const r = await ingest(seed, { body: `content for ${slug}`, path: `${slug}.md`, access: "team" });
  await tagItem(seed, r.id, init.projectId);
  await projectItemsToGraph(db(), { teamId: seed.teamId, teamSlug: seed.teamSlug, client: client(new FakeGraphiti()) });
  return { ...init, itemId: r.id };
}

describe("PCCC-6 — arm-on-read", () => {
  it("arming flips the project's deferred rows and records the arming row, idempotently", async () => {
    const seed = await seedTeam();
    const { projectId, group } = await setup(seed, "arm-me");

    await armProjectsForPrincipal(db(), { teamId: seed.teamId, projectIds: [projectId] });
    const flipped = await runSql<{ deferred: boolean }>(
      "select deferred from graph_episodes where team_id = $1 and group_id = $2",
      [seed.teamId, group]
    );
    expect(flipped.rows).toHaveLength(1);
    expect(flipped.rows[0].deferred).toBe(false);
    const armRow = await runSql<{ n: number }>(
      "select count(*)::int as n from graph_project_arming where team_id = $1 and project_id = $2",
      [seed.teamId, projectId]
    );
    expect(armRow.rows[0].n).toBe(1);

    await armProjectsForPrincipal(db(), { teamId: seed.teamId, projectIds: [projectId] }); // idempotent
    expect(
      (await runSql<{ n: number }>("select count(*)::int as n from graph_project_arming where team_id = $1", [seed.teamId]))
        .rows[0].n
    ).toBe(1);
  });

  it("readiness latches only when every armed row has LANDED (202 ≠ extracted), and the latch is monotone", async () => {
    const seed = await seedTeam();
    const { projectId, group } = await setup(seed, "latch-me");
    await armProjectsForPrincipal(db(), { teamId: seed.teamId, projectIds: [projectId] });

    // Armed but not yet pushed ('' sha) → NOT ready.
    let state = await readyPartitions(db(), { teamId: seed.teamId, projects: [{ id: projectId, group }] });
    expect(state.ready.has(projectId)).toBe(false);

    // Pushed but not reconcile-confirmed (real sha, no episode_uuid) → still NOT ready.
    await runSql("update graph_episodes set content_sha256 = $1 where team_id = $2 and group_id = $3", [
      sha("content"),
      seed.teamId,
      group,
    ]);
    state = await readyPartitions(db(), { teamId: seed.teamId, projects: [{ id: projectId, group }] });
    expect(state.ready.has(projectId)).toBe(false);

    // Confirmed landed → READY, latched.
    await runSql("update graph_episodes set episode_uuid = 'ep-1' where team_id = $1 and group_id = $2", [
      seed.teamId,
      group,
    ]);
    state = await readyPartitions(db(), { teamId: seed.teamId, projects: [{ id: projectId, group }] });
    expect(state.ready.has(projectId)).toBe(true);

    // MONOTONE: a new deferred row (a fresh tag) must NOT un-latch.
    const r2 = await ingest(seed, { body: "late tag", path: "late.md", access: "team" });
    await tagItem(seed, r2.id, projectId);
    await projectItemsToGraph(db(), { teamId: seed.teamId, teamSlug: seed.teamSlug, client: client(new FakeGraphiti()) });
    state = await readyPartitions(db(), { teamId: seed.teamId, projects: [{ id: projectId, group }] });
    expect(state.ready.has(projectId)).toBe(true);

    // The DISCRIMINATING monotone pin: a POST-LATCH re-arm flips the late row into an unlanded
    // obligation (late-tagged content must eventually extract — a LATCHED project flips on every
    // arm touch; an unlatched one does not, see the starvation pin below), and readiness must
    // STILL hold: only the persisted latch survives this; a live predicate flaps.
    await armProjectsForPrincipal(db(), { teamId: seed.teamId, projectIds: [projectId] });
    const late = await runSql<{ deferred: boolean; content_sha256: string }>(
      "select deferred, content_sha256 from graph_episodes where team_id = $1 and group_id = $2 and source_id = $3",
      [seed.teamId, group, r2.id]
    );
    expect(late.rows[0].deferred).toBe(false); // the late row IS flipped — it will extract
    expect(late.rows[0].content_sha256).toBe(""); // …but hasn't landed yet: a live obligation
    state = await readyPartitions(db(), { teamId: seed.teamId, projects: [{ id: projectId, group }] });
    expect(state.ready.has(projectId)).toBe(true); // and the leg does not flap
  });

  it("a partition owing a purge is SUPPRESSED without un-latching (fail closed on narrowing)", async () => {
    const seed = await seedTeam();
    const { projectId, group } = await setup(seed, "suppress-me");
    await armProjectsForPrincipal(db(), { teamId: seed.teamId, projectIds: [projectId] });
    await runSql(
      "update graph_episodes set content_sha256 = $1, episode_uuid = 'ep-s' where team_id = $2 and group_id = $3",
      [sha("x"), seed.teamId, group]
    );
    let state = await readyPartitions(db(), { teamId: seed.teamId, projects: [{ id: projectId, group }] });
    expect(state.ready.has(projectId)).toBe(true);
    expect(state.suppressed.has(projectId)).toBe(false);

    await runSql("update graph_episodes set pending_delete_group_id = $1 where team_id = $2 and group_id = $3", [
      group,
      seed.teamId,
      group,
    ]);
    state = await readyPartitions(db(), { teamId: seed.teamId, projects: [{ id: projectId, group }] });
    expect(state.ready.has(projectId)).toBe(true); // still latched…
    expect(state.suppressed.has(projectId)).toBe(true); // …but not readable until the purge confirms

    await runSql("update graph_episodes set pending_delete_group_id = null where team_id = $1 and group_id = $2", [
      seed.teamId,
      group,
    ]);
    state = await readyPartitions(db(), { teamId: seed.teamId, projects: [{ id: projectId, group }] });
    expect(state.suppressed.has(projectId)).toBe(false);
  });

  it("an EMPTY armed initiative is trivially ready (nothing owed), never vacuously blocked", async () => {
    const seed = await seedTeam();
    expect((await ensureAccessBootstrap(db(), seed.teamId)).ok).toBe(true);
    const init = await mkInitiative(seed, "empty-init");
    await armProjectsForPrincipal(db(), { teamId: seed.teamId, projectIds: [init.projectId] });
    const state = await readyPartitions(db(), { teamId: seed.teamId, projects: [{ id: init.projectId, group: init.group }] });
    expect(state.ready.has(init.projectId)).toBe(true);
  });

  it("a PRE-LATCH re-arm does NOT grow the obligation set — late tags can never starve the first latch (Codex code-review Blocker 2)", async () => {
    const seed = await seedTeam();
    const { projectId, group } = await setup(seed, "no-starve");
    await armProjectsForPrincipal(db(), { teamId: seed.teamId, projectIds: [projectId] }); // snapshot = {A}
    // A lands + confirms, but the latch has NOT been evaluated yet.
    await runSql(
      "update graph_episodes set content_sha256 = $1, episode_uuid = 'ep-a' where team_id = $2 and group_id = $3",
      [sha("a"), seed.teamId, group]
    );
    // B is tagged AFTER the snapshot…
    const r2 = await ingest(seed, { body: "tagged after the snapshot", path: "after.md", access: "team" });
    await tagItem(seed, r2.id, projectId);
    await projectItemsToGraph(db(), { teamId: seed.teamId, teamSlug: seed.teamSlug, client: client(new FakeGraphiti()) });
    // …and the next enforcing read's arm touch must NOT flip it into the pending obligation set:
    // under the rejected semantics every later tag re-enters the snapshot and a busy project
    // delays its first latch indefinitely.
    await armProjectsForPrincipal(db(), { teamId: seed.teamId, projectIds: [projectId] });
    const b = await runSql<{ deferred: boolean }>(
      "select deferred from graph_episodes where team_id = $1 and group_id = $2 and source_id = $3",
      [seed.teamId, group, r2.id]
    );
    expect(b.rows[0].deferred).toBe(true); // invisible to the latch until a post-latch arm
    const state = await readyPartitions(db(), { teamId: seed.teamId, projects: [{ id: projectId, group }] });
    expect(state.ready.has(projectId)).toBe(true); // the arm-time snapshot landed — latch sets
  });

  it("a crash between the arming row and the flip is REPAIRED on the next arm touch — the partition can never stay dark (liveness half)", async () => {
    const seed = await seedTeam();
    const { projectId, group } = await setup(seed, "crashed-arm");
    // The crash state: the arming row is durable, the flip never ran (all rows still deferred).
    await ensureArmingRows(db(), seed.teamId, [projectId]);
    // The next arm touch takes the missed snapshot (never-snapshotted ⇒ flip-eligible).
    await armProjectsForPrincipal(db(), { teamId: seed.teamId, projectIds: [projectId] });
    const flipped = await runSql<{ deferred: boolean }>(
      "select deferred from graph_episodes where team_id = $1 and group_id = $2",
      [seed.teamId, group]
    );
    expect(flipped.rows).toHaveLength(1);
    expect(flipped.rows[0].deferred).toBe(false);
  });

  it("the crashed-arm state never latches VACUOUSLY — readiness refuses an untaken snapshot (latch half)", async () => {
    const seed = await seedTeam();
    const { projectId, group } = await setup(seed, "crashed-latch");
    await ensureArmingRows(db(), seed.teamId, [projectId]);
    // The permissive-union path reads readiness WITHOUT arming — during the crash window the group
    // holds only deferred rows, and `unlanded = 0` would latch a snapshot that was never taken.
    // The latch is permanent, so this lie would never heal.
    const state = await readyPartitions(db(), { teamId: seed.teamId, projects: [{ id: projectId, group }] });
    expect(state.ready.has(projectId)).toBe(false);
  });
});
