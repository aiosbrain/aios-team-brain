import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { previewCorrection, type CorrectionPlan } from "@/lib/attribution/correction";
import { applyAttributionCorrection } from "@/lib/ingest/attribution-correction";
import { db, seedTeam, ingest, type Seed } from "./helpers";

/**
 * Spec: a previewed correction re-points exactly the matched items' `items.member_id` (or clears them),
 * scoped, audited, and never beyond the preview. Real Postgres (the write goes through the single-writer
 * path in lib/ingest; preview + apply share one resolution).
 */

async function seedItem(seed: Seed, source: string, memberId: string | null): Promise<void> {
  const path = `${source}/${randomUUID()}.md`;
  const { id } = await ingest(seed, { body: `b ${path}`, path, access: "team", frontmatter: { source } });
  if (memberId !== seed.memberId) {
    const { error } = await db().from("items").update({ member_id: memberId }).eq("id", id);
    if (error) throw new Error(error.message);
  }
}

async function memberIdsFor(seed: Seed, source: string): Promise<(string | null)[]> {
  const { data } = await db().from("items").select("member_id, path").eq("team_id", seed.teamId);
  return ((data ?? []) as { member_id: string | null; path: string }[])
    .filter((r) => r.path.startsWith(`${source}/`))
    .map((r) => r.member_id);
}

describe("attribution correction apply (real Postgres)", () => {
  it("re-points exactly the scoped matched items to the target member, leaving others untouched", async () => {
    const seed = await seedTeam(); // member "Tester"
    await seedItem(seed, "linear", null); // unattributed
    await seedItem(seed, "linear", null);
    await seedItem(seed, "github", seed.memberId); // control — different source, must not move

    const plan: CorrectionPlan = { kind: "reassign", match: { source: "linear", onlyUnattributed: true }, toMember: "Tester" };
    const preview = await previewCorrection(seed.teamId, plan);
    expect(preview.matchedCount).toBe(2);
    expect(preview.target).toMatchObject({ label: "Tester", clear: false });

    const res = await applyAttributionCorrection(db(), seed.teamId, plan, { memberId: seed.memberId });
    expect(res).toMatchObject({ ok: true, updated: 2 });

    expect((await memberIdsFor(seed, "linear")).every((m) => m === seed.memberId)).toBe(true);
    expect(await memberIdsFor(seed, "github")).toEqual([seed.memberId]); // control unchanged

    // Audited.
    const { data: audits } = await db().from("audit_log").select("action").eq("team_id", seed.teamId).eq("action", "attribution.corrected");
    expect((audits ?? []).length).toBeGreaterThan(0);
  });

  it("clears attribution to nobody for a 'nobody' target (signal-style correction)", async () => {
    const seed = await seedTeam();
    await seedItem(seed, "granola", seed.memberId);
    const plan: CorrectionPlan = { kind: "reassign", match: { source: "granola" }, toMember: "nobody" };
    const res = await applyAttributionCorrection(db(), seed.teamId, plan, { memberId: seed.memberId });
    expect(res).toMatchObject({ ok: true, updated: 1 });
    expect(await memberIdsFor(seed, "granola")).toEqual([null]);
  });

  it("aborts (writes nothing) when the live match no longer equals the previewed count (TOCTOU)", async () => {
    const seed = await seedTeam();
    await seedItem(seed, "linear", null);
    await seedItem(seed, "linear", null); // 2 match now
    const plan: CorrectionPlan = { kind: "reassign", match: { source: "linear", onlyUnattributed: true }, toMember: "Tester" };
    // Admin "previewed" 1, but 2 actually match → abort rather than touch the unseen item.
    const res = await applyAttributionCorrection(db(), seed.teamId, plan, { memberId: seed.memberId }, 1);
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/changed since preview/);
    expect((await memberIdsFor(seed, "linear")).every((m) => m === null)).toBe(true); // unchanged
  });

  it("fails loudly on an unknown target member (writes nothing)", async () => {
    const seed = await seedTeam();
    await seedItem(seed, "linear", null);
    const plan: CorrectionPlan = { kind: "reassign", match: { source: "linear" }, toMember: "Ghost" };
    const res = await applyAttributionCorrection(db(), seed.teamId, plan, { memberId: seed.memberId });
    expect(res.ok).toBe(false);
    expect(res.error).toBeTruthy();
    expect(await memberIdsFor(seed, "linear")).toEqual([null]); // unchanged
  });
});
