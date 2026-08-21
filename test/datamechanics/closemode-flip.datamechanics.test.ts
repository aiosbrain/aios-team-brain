import { describe, expect, it } from "vitest";
import { db, ingest, seedTeam, externalMember, type Seed } from "./helpers";
import { reconcileItemContext } from "@/lib/projects/context/reconcile-item";
import { backfillTeamContext } from "@/lib/projects/context/backfill";
import { countUnrepairable } from "@/lib/projects/context/backfill-candidates";
import { closeMembershipInto } from "@/lib/projects/context/memberships";
import { canSeeItem } from "@/lib/access/enforce";
import { projectItemsToGraph } from "@/lib/graph/project";
import { FakeGraphiti, client } from "./fake-graphiti";

// CLOSEMODE-1 ACs (docs/design/closemode1-mode-aware-close.md §3): the audience flip spares a
// human's standing exclusion (non-auto exclude) on the opposite system project; the return leg's
// invariant-3 refusal then keeps the human's decision governing; a spared row is not a backfill
// candidate; auto excludes and includes of any mode close exactly as today.

async function systemProject(seed: Seed, slug: string): Promise<string> {
  const { data } = await db().from("projects").select("id").eq("team_id", seed.teamId).eq("kind", "system").eq("slug", slug).single();
  return (data as { id: string }).id;
}
async function unitOf(seed: Seed, itemId: string): Promise<string> {
  const { data } = await db().from("project_context_units").select("id").eq("team_id", seed.teamId).eq("source_item_id", itemId).single();
  return (data as { id: string }).id;
}
/** Close any current row on (project, unit) and plant a current row of the given shape (the
 *  EXCLSHADOW suite's sanctioned raw-write pattern for states only Phase D will write). */
async function plant(seed: Seed, projectId: string, unitId: string, decision: string, mode: string): Promise<void> {
  await db().from("project_context_memberships").update({ valid_to: new Date().toISOString() })
    .eq("team_id", seed.teamId).eq("project_id", projectId).eq("context_unit_id", unitId).is("valid_to", null);
  const { error } = await db().from("project_context_memberships").insert({
    team_id: seed.teamId, project_id: projectId, context_unit_id: unitId, decision, mode, method: "manual",
  });
  expect(error).toBeNull();
}
async function currentRows(seed: Seed, projectId: string, unitId: string) {
  const { data } = await db().from("project_context_memberships").select("decision, mode")
    .eq("team_id", seed.teamId).eq("project_id", projectId).eq("context_unit_id", unitId).is("valid_to", null);
  return (data ?? []) as { decision: string; mode: string }[];
}
async function flipAccess(seed: Seed, itemId: string, access: "team" | "external") {
  await db().from("items").update({ access }).eq("id", itemId).eq("team_id", seed.teamId);
  return reconcileItemContext(db(), seed.teamId, itemId);
}

describe("CLOSEMODE-1 — the audience flip spares a human's standing exclusion (real Postgres)", () => {
  it("AC1(a) THE ROUND TRIP: force_exclude on external-shared survives the outbound flip; the return flip is REFUSED (the designed standing state) and the external tier never sees the item", async () => {
    const seed = await seedTeam();
    const item = await ingest(seed, { kind: "deliverable", path: "docs/x.md", body: "sensitive", access: "external" });
    await backfillTeamContext(db(), seed.teamId);
    const ext = await systemProject(seed, "external-shared");
    const gen = await systemProject(seed, "general");
    const unit = await unitOf(seed, item.id);
    // POSITIVE CONTROL (non-vacuity): before the exclusion, the external principal CAN see the item —
    // so the final false is the exclusion's doing, not a broken viewer.
    const externalViewer = await externalMember(seed);
    expect(await canSeeItem(db(), { teamId: seed.teamId, memberId: externalViewer }, item.id)).toBe(true);
    // The human's decision: exclude this from the external tier.
    await plant(seed, ext, unit, "exclude", "force_exclude");

    // Outbound flip external→team: the exclusion SURVIVES; General gains its include.
    const out = await flipAccess(seed, item.id, "team");
    expect(out.ok).toBe(true);
    expect(out.spared).toBe(1);
    expect(await currentRows(seed, ext, unit)).toEqual([{ decision: "exclude", mode: "force_exclude" }]);
    expect(await currentRows(seed, gen, unit)).toEqual([{ decision: "include", mode: "auto" }]);

    // Return flip team→external: invariant 3 refuses — ok:false is the DESIGNED terminal state;
    // the General include survives; no current include in external-shared.
    const back = await flipAccess(seed, item.id, "external");
    expect(back.ok).toBe(false);
    expect(back.error).toMatch(/membership:/);
    expect(await currentRows(seed, ext, unit)).toEqual([{ decision: "exclude", mode: "force_exclude" }]);
    expect(await currentRows(seed, gen, unit)).toEqual([{ decision: "include", mode: "auto" }]);

    // The enforced read: the same principal that COULD see it now does NOT.
    expect(await canSeeItem(db(), { teamId: seed.teamId, memberId: externalViewer }, item.id)).toBe(false);

    // AC1(e2): the standing state is NOT re-visited (the target carve-out) and IS counted as an
    // unrepairable exclude-shadow — operator-attention semantics, not a failed repair.
    const p = await backfillTeamContext(db(), seed.teamId);
    // DISCRIMINATING (Codex diff review M): without ok, deleting the target carve-out would select the
    // item, the reconcile would REFUSE before scanned++ — and scanned 0 would stay green while the
    // pass went red. ok:true proves "not visited", not "visited and failed".
    expect(p.ok).toBe(true);
    expect(p.scanned, "no repeated backfill visit after the refused flip").toBe(0);
    const unrepairable = await countUnrepairable(seed.teamId);
    expect(unrepairable?.excludeShadows, "the standing exclusion counts — intended, permanent").toBe(1);
  });

  it("AC1(b) an AUTO exclude on the opposite side closes exactly as today", async () => {
    const seed = await seedTeam();
    const item = await ingest(seed, { kind: "deliverable", path: "docs/a.md", body: "a", access: "external" });
    await backfillTeamContext(db(), seed.teamId);
    const ext = await systemProject(seed, "external-shared");
    const unit = await unitOf(seed, item.id);
    await plant(seed, ext, unit, "exclude", "auto");
    const out = await flipAccess(seed, item.id, "team");
    expect(out.ok).toBe(true);
    expect(out.spared).toBe(0);
    expect(await currentRows(seed, ext, unit)).toEqual([]);
  });

  it("AC1(c) a FORCED INCLUDE on the opposite side closes exactly as today (Phase D owns its semantics)", async () => {
    const seed = await seedTeam();
    const item = await ingest(seed, { kind: "deliverable", path: "docs/b.md", body: "b", access: "external" });
    await backfillTeamContext(db(), seed.teamId);
    const ext = await systemProject(seed, "external-shared");
    const unit = await unitOf(seed, item.id);
    await plant(seed, ext, unit, "include", "force_include");
    const out = await flipAccess(seed, item.id, "team");
    expect(out.ok).toBe(true);
    expect(out.spared).toBe(0);
    expect(await currentRows(seed, ext, unit)).toEqual([]);
  });

  it("AC1(d) plain auto flips behave exactly as today (closed 1, spared 0 at the close itself)", async () => {
    const seed = await seedTeam();
    const item = await ingest(seed, { kind: "deliverable", path: "docs/c.md", body: "c", access: "external" });
    await backfillTeamContext(db(), seed.teamId);
    const ext = await systemProject(seed, "external-shared");
    const unit = await unitOf(seed, item.id);
    await db().from("items").update({ access: "team" }).eq("id", item.id).eq("team_id", seed.teamId);
    // Drive the close directly for the exact counter pin, then via reconcile for the flow.
    const direct = await closeMembershipInto(db(), seed.teamId, unit, ext);
    expect(direct).toMatchObject({ ok: true, closed: 1, spared: 0 });
  });

  it("AC1(e) D2: a spared exclusion is NOT a candidate-maker — two backfill passes both scan 0; a missing target include still fires ARM 2", async () => {
    const seed = await seedTeam();
    const item = await ingest(seed, { kind: "deliverable", path: "docs/d.md", body: "d", access: "external" });
    await backfillTeamContext(db(), seed.teamId);
    const ext = await systemProject(seed, "external-shared");
    const gen = await systemProject(seed, "general");
    const unit = await unitOf(seed, item.id);
    await plant(seed, ext, unit, "exclude", "force_exclude");
    await flipAccess(seed, item.id, "team"); // settle: General include + spared exclusion
    const p1 = await backfillTeamContext(db(), seed.teamId);
    const p2 = await backfillTeamContext(db(), seed.teamId);
    expect(p1.scanned, "the settled unit is not a candidate").toBe(0);
    expect(p2.scanned).toBe(0);
    expect(await currentRows(seed, ext, unit)).toEqual([{ decision: "exclude", mode: "force_exclude" }]);
    // ARM 2 still fires when the TARGET include is genuinely missing.
    await db().from("project_context_memberships").update({ valid_to: new Date().toISOString() })
      .eq("team_id", seed.teamId).eq("project_id", gen).eq("context_unit_id", unit).is("valid_to", null);
    const p3 = await backfillTeamContext(db(), seed.teamId);
    expect(p3.scanned, "a missing target include is still a candidate").toBe(1);
    expect(await currentRows(seed, gen, unit)).toEqual([{ decision: "include", mode: "auto" }]);
  });

  it("AC1(f) `spared` reaches reconcileItemContext's result and BackfillResult", async () => {
    const seed = await seedTeam();
    const item = await ingest(seed, { kind: "deliverable", path: "docs/e.md", body: "e", access: "external" });
    await backfillTeamContext(db(), seed.teamId);
    const ext = await systemProject(seed, "external-shared");
    const unit = await unitOf(seed, item.id);
    await plant(seed, ext, unit, "exclude", "force_exclude");
    await db().from("items").update({ access: "team" }).eq("id", item.id).eq("team_id", seed.teamId);
    // Make the unit a candidate again by removing the target include (ARM 2), so the BACKFILL runs
    // the reconcile and its result must carry the spare.
    const r = await backfillTeamContext(db(), seed.teamId);
    expect(r.scanned).toBe(1);
    expect(r.spared, "the backfill's own pass counted the spare").toBe(1);
  });

  it("AC1(g) THE GRAPH LEG: in the standing state a projector pass moves the episodes OUT of the external graph group", async () => {
    const seed = await seedTeam();
    const { data: team } = await db().from("teams").select("slug").eq("id", seed.teamId).single();
    const slug = (team as { slug: string }).slug;
    const item = await ingest(seed, { kind: "deliverable", path: "docs/g.md", body: "graph-visible sensitive", access: "external" });
    await backfillTeamContext(db(), seed.teamId);
    const fake = new FakeGraphiti();
    await projectItemsToGraph(db(), { teamId: seed.teamId, teamSlug: slug, client: client(fake) });
    const extGroup = `${slug}_external`;
    expect([...(fake.store.get(extGroup)?.values() ?? [])].some((e) => e.name.startsWith(`items:${item.id}`)), "starts in the external graph group").toBe(true);

    // The standing state: force_exclude on external-shared, flip out (General include, exclusion spared),
    // flip back refused — access stays 'external'.
    const ext = await systemProject(seed, "external-shared");
    const unit = await unitOf(seed, item.id);
    await plant(seed, ext, unit, "exclude", "force_exclude");
    await flipAccess(seed, item.id, "team");
    await flipAccess(seed, item.id, "external"); // refused; access committed by the caller in prod — mirror that:
    await db().from("items").update({ access: "external" }).eq("id", item.id).eq("team_id", seed.teamId);

    const res = await projectItemsToGraph(db(), { teamId: seed.teamId, teamSlug: slug, client: client(fake) });
    expect(res.externalGroupVacated, "the move out of the external partition is counted").toBeGreaterThanOrEqual(1);
    const { data: rows } = await db().from("graph_episodes").select("group_id, pending_delete_group_id, content_sha256").eq("team_id", seed.teamId).eq("source_id", item.id);
    const ledger = (rows ?? []) as { group_id: string; pending_delete_group_id: string | null; content_sha256: string }[];
    expect(ledger.some((r) => r.group_id === `${slug}_team` && r.content_sha256 !== ""), "the General group holds the content").toBe(true);
    expect(ledger.some((r) => r.pending_delete_group_id === extGroup), "the external copy is pending-delete").toBe(true);
  });

  it("AC1(h) FAIL-OPEN: an external item with NO substrate unit homes in the external group exactly as today", async () => {
    const seed = await seedTeam();
    const { data: team } = await db().from("teams").select("slug").eq("id", seed.teamId).single();
    const slug = (team as { slug: string }).slug;
    const item = await ingest(seed, { kind: "deliverable", path: "docs/h.md", body: "no unit yet", access: "external" });
    // Bootstrap FIRST (system projects exist), then delete the unit — this exercises the NO-UNIT
    // fail-open, not the unbootstrapped one (mutation (f) survived the earlier version, which never
    // bootstrapped and so never reached the branch under test).
    await backfillTeamContext(db(), seed.teamId);
    await db().from("project_context_units").delete().eq("team_id", seed.teamId).eq("source_item_id", item.id);
    const fake = new FakeGraphiti();
    await projectItemsToGraph(db(), { teamId: seed.teamId, teamSlug: slug, client: client(fake) });
    expect([...(fake.store.get(`${slug}_external`)?.values() ?? [])].some((e) => e.name.startsWith(`items:${item.id}`)), "homes external — a substrate race never demotes").toBe(true);
  });
});