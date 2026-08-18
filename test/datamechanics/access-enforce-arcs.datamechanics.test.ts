import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { db, ingest, seedTeam, type Seed } from "./helpers";
import { backfillTeamContext } from "@/lib/projects/context/backfill";
import { memberEnforcement } from "@/lib/access/enforce";
import { filterArcsByVisibleItems } from "@/lib/graph/arc-visibility";
import { type NarrativeArc } from "@/lib/graph/arcs";
import { resolveArcScope } from "@/lib/graph/partition-read";
import { getFusedArcs } from "@/lib/graph/arc-fusion";
import { ensureAccessBootstrap } from "@/lib/access/bootstrap";
import { episodeGroupId } from "@/lib/graph/group";
import { createGroup, grantProjectToGroup } from "@/lib/access/groups";

// Phase B slice 5 (spec §5.8/§5.8b), re-homed onto the PRET-3 unified read: the enforcement
// COMPOSITION is proven over the FUSED path every reader now uses — resolveArcScope resolves the
// member's scope, getFusedArcs serves the g: partition rows (seeded directly — the LLM is not
// available here), and the evidence filter drops any arc citing an item the member can't see.
// The pure filter's own cases are in test/graph-arc-visibility.test.ts.

async function seedMember(seed: Seed): Promise<string> {
  const { data } = await db()
    .from("members")
    .insert({ team_id: seed.teamId, email: `${randomUUID()}@test.local`, display_name: "M", actor_handle: `h-${randomUUID().slice(0, 10)}`, role: "member", tier: "team", status: "active" })
    .select("id")
    .single();
  const { placeMemberByTier } = await import("./helpers");
  await placeMemberByTier(seed.teamId, data!.id as string, "team");
  return data!.id as string;
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
  // The General built-in's PARTITION row — where the fused read actually looks (PRET-3).
  const groupKey = `g:${episodeGroupId(seed.teamSlug, "team")}`;
  const { error } = await db().from("arc_cache").upsert(
    { team_id: seed.teamId, group_key: groupKey, arcs: JSON.stringify(arcs), computed_at: new Date().toISOString() },
    { onConflict: "team_id,group_key" }
  );
  expect(error, "arc_cache seed must insert").toBeNull();
}
/** Mirrors the arcs route post-PRET-3: resolveArcScope → getFusedArcs → the evidence filter. */
async function visibleArcTitles(seed: Seed, memberId: string): Promise<string[]> {
  expect((await ensureAccessBootstrap(db(), seed.teamId)).ok).toBe(true);
  const enforce = await memberEnforcement(db(), { teamId: seed.teamId, memberId });
  const scope = await resolveArcScope(db(), { teamId: seed.teamId, teamSlug: seed.teamSlug, memberId, tier: "team", enforcement: enforce });
  const { arcs } = await getFusedArcs(db(), seed.teamId, seed.teamSlug, scope.groups, { anthropicApiKey: null, openaiApiKey: null } as never);
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

  it("enforcing: a MIXED arc — one visible item + one entry whose source is restricted — is dropped (real composition, Fable B5 High)", async () => {
    const seed = await seedTeam();
    const openItem = await ingest(seed, { path: "vis.md", body: "vis", access: "team", project: "src" });
    const secretItem = await ingest(seed, { path: "sec.md", body: "sec", access: "team", project: "src" });
    const outsider = await seedMember(seed);
    await backfillTeamContext(db(), seed.teamId);
    await restrictItem(seed, secretItem.id);
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
    await seedArcCache(seed, [arc("visible", [openItem.id]), arc("restricted", [secretItem.id])]);

    // Reproduce the recompute route's gate post-PRET-3: the route reads the member's OWN
    // partition-scope row (scopeKey = g:<sourceGroup>) — here the General built-in's.
    const groupKey = `g:${episodeGroupId(seed.teamSlug, "team")}`;
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
    await seedArcCache(seed, [arc("grounded", [item.id]), { ...arc("pure-graph", []), evidence: [{ fact: "ungrounded fact" }] }]);
    // The seed admin sees General, so the grounded arc stays; the ungrounded one drops for everyone.
    const titles = await visibleArcTitles(seed, seed.memberId);
    expect(titles).toContain("arc grounded");
    expect(titles, "a no-itemId arc has no verifiable basis → fail closed").not.toContain("arc pure-graph");
  });
});

describe("the arcs read serves ONLY partition rows (PCCC6B-1 property; PRET-3: for everyone)", () => {
  it("a tier-key row is structurally unreachable — present in the cache, absent from every panel", async () => {
    const seed = await seedTeam();
    expect((await ensureAccessBootstrap(db(), seed.teamId)).ok).toBe(true);
    // The laundering artifact: a tier row synthesized with every team correction folded in.
    // PRE-PRET-3 this was the permissive/external serving row; post-PRET-6 it is unreachable
    // dead weight — no read path can reach a non-g: key (getArcs/getFusedArcs are g:-only by
    // signature), which is the WHOLE mechanism.
    const tierKey = [episodeGroupId(seed.teamSlug, "team"), episodeGroupId(seed.teamSlug, "external")].sort().join(",");
    await db().from("arc_cache").upsert(
      { team_id: seed.teamId, group_key: tierKey, arcs: JSON.stringify([arc("tier-laundered", [])]), computed_at: new Date().toISOString() },
      { onConflict: "team_id,group_key" }
    );

    const titles = await visibleArcTitles(seed, seed.memberId);
    expect(titles, "the tier row's content reaches no panel").not.toContain("arc tier-laundered");
    // Non-vacuity: the sentinel row genuinely exists in the cache.
    const { readArcCache } = await import("@/lib/graph/arc-cache");
    const raw = await readArcCache(db(), seed.teamId, tierKey);
    expect(raw?.arcs.map((a) => a.title)).toContain("arc tier-laundered");
  });
});
