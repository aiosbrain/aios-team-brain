import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { db, ingest, seedTeam, type Seed } from "./helpers";
import { backfillTeamContext } from "@/lib/projects/context/backfill";
import { memberEnforcement } from "@/lib/access/enforce";
import { filterArcsByVisibleItems } from "@/lib/graph/arc-visibility";
import { getArcs, partitionArcScopeKey, type NarrativeArc } from "@/lib/graph/arcs";
import { selectEnforcedGraphPartitions } from "@/lib/graph/partition-read";
import { ensureAccessBootstrap } from "@/lib/access/bootstrap";
import { visibleGroupIds } from "@/lib/graph/group";
import { createGroup, grantProjectToGroup } from "@/lib/access/groups";

// Phase B slice 5 (spec §5.8/§5.8b) — arc read enforcement composed against REAL member-visibility
// resolution + a REAL arc_cache read. The route synthesizes arcs via an LLM (not available here), so
// we seed arc_cache directly and prove the enforcement COMPOSITION: getArcs returns the seeded tier
// arcs, and the filter drops any arc citing an item the outsider can't see. The pure filter's own
// cases are in test/graph-arc-visibility.test.ts; this pins that the item ids actually line up with
// what memberEnforcement resolves from the substrate.

async function seedMember(seed: Seed): Promise<string> {
  const { data } = await db()
    .from("members")
    .insert({ team_id: seed.teamId, email: `${randomUUID()}@test.local`, display_name: "M", actor_handle: `h-${randomUUID().slice(0, 10)}`, role: "member", tier: "team", status: "active" })
    .select("id")
    .single();
  return data!.id as string;
}
async function setEnforcement(seed: Seed, mode: "permissive" | "enforcing") {
  await db().from("teams").update({ access_enforcement: mode }).eq("id", seed.teamId);
}
async function restrictItem(seed: Seed, itemId: string): Promise<void> {
  const { data: proj } = await db().from("projects").insert({ team_id: seed.teamId, slug: `r-${randomUUID().slice(0, 8)}`, name: "R", kind: "initiative" }).select("id").single();
  const g = await createGroup(db(), seed.teamId, `rg-${randomUUID().slice(0, 8)}`, "RG", seed.memberId);
  await grantProjectToGroup(db(), seed.teamId, proj!.id as string, g.groupId!, seed.memberId);
  const { data: unit } = await db().from("project_context_units").select("id").eq("source_item_id", itemId).single();
  await db().from("project_context_memberships").update({ valid_to: new Date().toISOString() }).eq("context_unit_id", unit!.id).is("valid_to", null);
  await db().from("project_context_memberships").insert({ team_id: seed.teamId, project_id: proj!.id as string, context_unit_id: unit!.id, method: "manual" });
}
const arc = (id: string, itemIds: string[]): NarrativeArc => ({
  id, title: `arc ${id}`, confidence: "high", summary: `summary about ${id}`, participants: [],
  supporting_sources: [], evidence: itemIds.map((itemId) => ({ fact: `fact ${itemId}`, itemId })), derived_at: new Date().toISOString(),
});
async function seedArcCache(seed: Seed, arcs: NarrativeArc[]) {
  const groupKey = visibleGroupIds(seed.teamSlug, "team").slice().sort().join(",");
  const { error } = await db().from("arc_cache").upsert(
    { team_id: seed.teamId, group_key: groupKey, arcs: JSON.stringify(arcs), computed_at: new Date().toISOString() },
    { onConflict: "team_id,group_key" }
  );
  expect(error, "arc_cache seed must insert").toBeNull();
}
async function visibleArcTitles(seed: Seed, memberId: string): Promise<string[]> {
  const { arcs } = await getArcs(db(), seed.teamId, seed.teamSlug, "team", visibleGroupIds(seed.teamSlug, "team"), { anthropicApiKey: null, openaiApiKey: null } as never);
  const enforce = await memberEnforcement(db(), { teamId: seed.teamId, memberId });
  return filterArcsByVisibleItems(arcs, enforce?.visibleItemIds ?? null).map((a) => a.title);
}

describe("enforced arc reads (Phase B slice 5)", () => {
  it("enforcing: an outsider gets the General-grounded arc but NOT one citing a restricted item", async () => {
    const seed = await seedTeam();
    const openItem = await ingest(seed, { path: "open.md", body: "open work", access: "team", project: "src" });
    const secretItem = await ingest(seed, { path: "secret.md", body: "secret work", access: "team", project: "src" });
    const outsider = await seedMember(seed); // BEFORE backfill — it converges Everyone membership
    await backfillTeamContext(db(), seed.teamId);
    await restrictItem(seed, secretItem.id);
    await setEnforcement(seed, "enforcing");
    await seedArcCache(seed, [
      arc("general", [openItem.id]),
      arc("restricted", [secretItem.id]),
      arc("mixed", [openItem.id, secretItem.id]),
    ]);

    const titles = await visibleArcTitles(seed, outsider);
    expect(titles, "the General-grounded arc reaches the outsider").toContain("arc general");
    expect(titles, "an arc citing a restricted item must not").not.toContain("arc restricted");
    expect(titles, "an arc citing ANY restricted item must not (no partial redaction)").not.toContain("arc mixed");
  });

  it("permissive: the same outsider sees every arc (byte-identical to today)", async () => {
    const seed = await seedTeam();
    const openItem = await ingest(seed, { path: "o.md", body: "o", access: "team", project: "src" });
    const secretItem = await ingest(seed, { path: "s.md", body: "s", access: "team", project: "src" });
    const outsider = await seedMember(seed);
    await backfillTeamContext(db(), seed.teamId);
    await restrictItem(seed, secretItem.id);
    await setEnforcement(seed, "permissive");
    await seedArcCache(seed, [arc("general", [openItem.id]), arc("restricted", [secretItem.id])]);

    const titles = await visibleArcTitles(seed, outsider);
    expect(titles.sort()).toEqual(["arc general", "arc restricted"]);
  });

  it("enforcing: a MIXED arc — one visible item + one entry whose source is restricted — is dropped (real composition, Fable B5 High)", async () => {
    const seed = await seedTeam();
    const openItem = await ingest(seed, { path: "vis.md", body: "vis", access: "team", project: "src" });
    const secretItem = await ingest(seed, { path: "sec.md", body: "sec", access: "team", project: "src" });
    const outsider = await seedMember(seed);
    await backfillTeamContext(db(), seed.teamId);
    await restrictItem(seed, secretItem.id);
    await setEnforcement(seed, "enforcing");
    // Both entries carry a real itemId — one visible, one restricted. The restricted one must fail
    // the whole arc closed (evidence.every, not a filter-then-every).
    await seedArcCache(seed, [arc("mixed", [openItem.id, secretItem.id]), arc("clean", [openItem.id])]);
    const titles = await visibleArcTitles(seed, outsider);
    expect(titles).toContain("arc clean");
    expect(titles, "any restricted evidence entry drops the whole arc").not.toContain("arc mixed");
  });

  it("enforcing: the correction WRITE gate — a restricted arc's id is NOT in the member's visible-arc set, so a correction targeting it is rejected (Codex B5 High poisoning gate)", async () => {
    const { readArcCache } = await import("@/lib/graph/arc-cache");
    const seed = await seedTeam();
    const openItem = await ingest(seed, { path: "ok.md", body: "ok", access: "team", project: "src" });
    const secretItem = await ingest(seed, { path: "no.md", body: "no", access: "team", project: "src" });
    const outsider = await seedMember(seed);
    await backfillTeamContext(db(), seed.teamId);
    await restrictItem(seed, secretItem.id);
    await setEnforcement(seed, "enforcing");
    await seedArcCache(seed, [arc("visible", [openItem.id]), arc("restricted", [secretItem.id])]);

    // Reproduce the recompute route's gate: read the CACHED arcs, filter to the member's visible set,
    // collect the ids they may correct.
    const groupKey = visibleGroupIds(seed.teamSlug, "team").slice().sort().join(",");
    const cached = await readArcCache(db(), seed.teamId, groupKey);
    const enforce = await memberEnforcement(db(), { teamId: seed.teamId, memberId: outsider });
    const visibleIds = new Set(filterArcsByVisibleItems(cached?.arcs ?? [], enforce!.visibleItemIds).map((a) => a.id));
    expect([...visibleIds], "the member may correct the arc they can see").toEqual(["visible"]);
    expect(visibleIds.has("restricted"), "a correction targeting the restricted arc would be rejected").toBe(false);
    expect(visibleIds.has("nonexistent-fabricated-id"), "an arbitrary fabricated id is rejected too").toBe(false);
  });

  it("enforcing: an arc with no linkable evidence item fails closed (dropped) even for the admin", async () => {
    const seed = await seedTeam();
    const item = await ingest(seed, { path: "a.md", body: "a", access: "team", project: "src" });
    await backfillTeamContext(db(), seed.teamId);
    await setEnforcement(seed, "enforcing");
    await seedArcCache(seed, [arc("grounded", [item.id]), { ...arc("pure-graph", []), evidence: [{ fact: "ungrounded fact" }] }]);
    // The seed admin sees General, so the grounded arc stays; the ungrounded one drops for everyone.
    const titles = await visibleArcTitles(seed, seed.memberId);
    expect(titles).toContain("arc grounded");
    expect(titles, "a no-itemId arc has no verifiable basis → fail closed").not.toContain("arc pure-graph");
  });
});

describe("PCCC6B-1 — the enforced arcs read cutover (real Postgres)", () => {
  it("an ENFORCED member's scoped read can NEVER be served the tier cache row — while the tier path still is", async () => {
    const seed = await seedTeam();
    expect((await ensureAccessBootstrap(db(), seed.teamId)).ok).toBe(true);
    await setEnforcement(seed, "enforcing");
    // The laundering artifact: a tier row synthesized with every team correction folded in.
    await seedArcCache(seed, [arc("tier-laundered", [])]);

    const enforce = await memberEnforcement(db(), { teamId: seed.teamId, memberId: seed.memberId });
    expect(enforce).not.toBeNull();
    const scope = await selectEnforcedGraphPartitions(db(), {
      teamId: seed.teamId,
      visibleProjectIds: [...enforce!.visibleProjectIds],
    });
    const scopeKey = partitionArcScopeKey(seed.teamSlug, scope.groups);
    // The scoped key is its OWN cache namespace — even a built-ins-only scope (this member's) whose
    // groups equal the tier pair must not share the tier row.
    expect(scopeKey).not.toBe(visibleGroupIds(seed.teamSlug, "team").slice().sort().join(","));

    const { arcs } = await getArcs(
      db(),
      seed.teamId,
      seed.teamSlug,
      "team",
      scope.groups,
      { anthropicApiKey: null, openaiApiKey: null } as never,
      { scopeKey }
    );
    expect(arcs.map((a) => a.title)).not.toContain("arc tier-laundered");

    // Control: the tier path (permissive readers) still serves the seeded row — without this the
    // assertion above would pass just as happily if the cache were simply broken.
    const tier = await getArcs(
      db(),
      seed.teamId,
      seed.teamSlug,
      "team",
      visibleGroupIds(seed.teamSlug, "team"),
      { anthropicApiKey: null, openaiApiKey: null } as never
    );
    expect(tier.arcs.map((a) => a.title)).toContain("arc tier-laundered");
  });
});
