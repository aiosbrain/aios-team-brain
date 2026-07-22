import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { applyAttributionCorrection } from "@/lib/ingest/attribution-correction";
import { reattributeItems } from "@/lib/ingest/reattribute";
import { staleArcCache, writeArcCache } from "@/lib/graph/arc-cache";
import type { NarrativeArc } from "@/lib/graph/arcs";
import { db, seedTeam, ingest } from "./helpers";

/**
 * Spec (docs/design/attribution-propagation.md): a deliberate NL correction LOCKS an item so automatic
 * re-attribution can never silently revert it; and `staleArcCache` marks arcs stale enough to recompute
 * (past the TTL) but recent enough that the empty-clobber guard still protects a hiccup (< 48h). Real PG.
 */

async function addMember(teamId: string, name: string, email: string): Promise<string> {
  const { data, error } = await db()
    .from("members")
    .insert({ team_id: teamId, email, display_name: name, actor_handle: `h-${randomUUID().slice(0, 8)}`, role: "member", tier: "team", status: "active" })
    .select("id")
    .single();
  if (error || !data) throw new Error(`addMember failed: ${error?.message}`);
  return (data as { id: string }).id;
}

describe("attribution propagation (real Postgres)", () => {
  it("an NL correction LOCKS the item so a later re-attribution cannot revert it", async () => {
    const seed = await seedTeam();
    const alice = await addMember(seed.teamId, "Alice", `alice-${randomUUID()}@corp.com`);
    const bob = await addMember(seed.teamId, "Bob", `bob-${randomUUID()}@corp.com`);
    await db().from("member_emails").insert({ team_id: seed.teamId, member_id: alice, email: "author@x.com" });

    // Item whose frontmatter resolves (via re-attribution) to Alice.
    const { id } = await ingest(seed, { body: `b ${randomUUID()}`, path: `x/${randomUUID()}.md`, access: "team", frontmatter: { source: "x", author_email: "author@x.com" } });
    const row = async () =>
      (await db().from("items").select("member_id, member_id_locked").eq("id", id).single()).data as { member_id: string | null; member_id_locked: boolean };

    await reattributeItems(db(), seed.teamId);
    expect((await row()).member_id).toBe(alice); // re-attribution → Alice (from frontmatter)

    // Admin corrects it to Bob — this locks it.
    const res = await applyAttributionCorrection(db(), seed.teamId, { kind: "reassign", match: { pathPrefix: "x/" }, toMember: "Bob" }, { memberId: seed.memberId });
    expect(res.ok).toBe(true);
    const afterCorrection = await row();
    expect(afterCorrection.member_id).toBe(bob);
    expect(afterCorrection.member_id_locked).toBe(true);

    // Re-attribution runs again (an unrelated mapping edit fires it): frontmatter still resolves to Alice,
    // but the lock must hold — no silent revert.
    await reattributeItems(db(), seed.teamId);
    expect((await row()).member_id).toBe(bob);
  });

  it("preserves a LOCKED correction even when the item's body changes (a real edit doesn't undo it)", async () => {
    const seed = await seedTeam();
    const bob = await addMember(seed.teamId, "Bob", `bob-${randomUUID()}@corp.com`);
    const path = `x/${randomUUID()}.md`;
    await ingest(seed, { body: "v1", path, access: "team", frontmatter: { source: "x" } });
    await applyAttributionCorrection(db(), seed.teamId, { kind: "reassign", match: { pathPrefix: "x/" }, toMember: "Bob" }, { memberId: seed.memberId });
    const { data: i1 } = await db().from("items").select("id, member_id").eq("team_id", seed.teamId).eq("path", path).single();
    expect((i1 as { member_id: string }).member_id).toBe(bob);

    // Real content edit (changed body → not the unchanged fast-path): must NOT overwrite the correction.
    await ingest(seed, { body: "v2 — edited content", path, access: "team", frontmatter: { source: "x" } });
    const { data: i2 } = await db().from("items").select("member_id, member_id_locked, body").eq("id", (i1 as { id: string }).id).single();
    expect((i2 as { member_id: string }).member_id).toBe(bob); // correction preserved
    expect((i2 as { member_id_locked: boolean }).member_id_locked).toBe(true);
    expect((i2 as { body: string }).body).toContain("edited"); // the edit DID land (only member_id was preserved)
  });

  it("staleArcCache marks arcs stale (past the 10-min TTL) but within the 48h empty-clobber cap", async () => {
    const seed = await seedTeam();
    const arc: NarrativeArc = { id: "a", title: "t", confidence: "low", summary: "", participants: [], supporting_sources: [], evidence: [], derived_at: new Date().toISOString() };
    await writeArcCache(db(), seed.teamId, "k", [arc]);
    await staleArcCache(db(), seed.teamId);

    const { data } = await db().from("arc_cache").select("computed_at").eq("team_id", seed.teamId).single();
    const ageMs = Date.now() - new Date((data as { computed_at: string }).computed_at).getTime();
    expect(ageMs).toBeGreaterThan(10 * 60_000); // stale → getArcs fires the SWR recompute
    expect(ageMs).toBeLessThan(48 * 3_600_000); // but a hiccup-empty recompute still KEEPS the prior
  });
});
