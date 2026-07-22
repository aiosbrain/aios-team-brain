import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { applyAttributionCorrection } from "@/lib/ingest/attribution-correction";
import { correctionPlanSchema } from "@/lib/attribution/correction";
import { db, seedTeam, ingest, type Seed } from "./helpers";

/**
 * Spec: an admin correction is an authoritative MISLABEL-fix, and it lands on the SAME uniform
 * `item.reassigned` transition stream as a source reassignment — but tagged `via: "correction"` (with no
 * `from_owned_since`, because the outgoing owner's window is void). So the windowed-credit consumer can
 * void A's window on a human fix while keeping it on a source handoff. Real Postgres (append-only audit).
 */

async function addMember(seed: Seed, name: string, email: string): Promise<string> {
  const { data, error } = await db()
    .from("members")
    .insert({
      team_id: seed.teamId,
      email,
      display_name: name,
      actor_handle: `h-${randomUUID().slice(0, 8)}`,
      role: "member",
      tier: "team",
      status: "active",
    })
    .select("id")
    .single();
  if (error || !data) throw new Error(`addMember failed: ${error?.message}`);
  return (data as { id: string }).id;
}

async function reassignEvents(teamId: string, itemId: string): Promise<{ meta: Record<string, unknown> }[]> {
  const { data } = await db()
    .from("audit_log")
    .select("meta")
    .eq("team_id", teamId)
    .eq("action", "item.reassigned")
    .eq("target_id", itemId);
  return (data ?? []) as { meta: Record<string, unknown> }[];
}

function itemIdPlan(itemId: string, toMember: string) {
  return correctionPlanSchema.parse({ kind: "reassign", match: { itemId }, toMember });
}

describe("correction → item.reassigned{via:correction} (real Postgres)", () => {
  it("logs a per-item mislabel-fix transition A→B (via correction, no from_owned_since)", async () => {
    const seed = await seedTeam(); // A = seed.memberId (the ingesting/owning member)
    const a = seed.memberId;
    const b = await addMember(seed, "Person B", `b-${randomUUID()}@corp.com`);
    const { id } = await ingest(seed, { body: "mislabeled doc", path: `notion/${randomUUID()}.md`, access: "team" });
    // Ingested → attributed to A. Admin asserts it was always B's (a mislabel).
    const res = await applyAttributionCorrection(db(), seed.teamId, itemIdPlan(id, "Person B"), { memberId: a }, 1);
    expect(res.ok).toBe(true);

    const events = await reassignEvents(seed.teamId, id);
    expect(events).toHaveLength(1);
    expect(events[0].meta).toMatchObject({ from: a, to: b, via: "correction" });
    expect(events[0].meta.from_owned_since).toBeUndefined(); // the outgoing owner's window is VOID
  });

  it("records a correct-to-nobody as a transition to null (A's ownership removed as a mislabel)", async () => {
    const seed = await seedTeam();
    const a = seed.memberId;
    const { id } = await ingest(seed, { body: "not anyone's work", path: `granola/${randomUUID()}.md`, access: "team" });
    const res = await applyAttributionCorrection(db(), seed.teamId, itemIdPlan(id, "nobody"), { memberId: a }, 1);
    expect(res.ok).toBe(true);

    const events = await reassignEvents(seed.teamId, id);
    expect(events).toHaveLength(1);
    expect(events[0].meta).toMatchObject({ from: a, to: null, via: "correction" });
  });

  it("batch-logs one transition per changed item on a MULTI-item correction (exercises the multi-row insert)", async () => {
    const seed = await seedTeam();
    const a = seed.memberId;
    const b = await addMember(seed, "Person B", `b-${randomUUID()}@corp.com`);
    // 3 items owned by A under a shared path prefix → a single pathPrefix correction moves all three to B.
    const prefix = `notion/batch-${randomUUID().slice(0, 8)}/`;
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      const { id } = await ingest(seed, { body: `doc ${i}`, path: `${prefix}${randomUUID()}.md`, access: "team" });
      ids.push(id);
    }
    const plan = correctionPlanSchema.parse({ kind: "reassign", match: { pathPrefix: prefix }, toMember: "Person B" });
    const res = await applyAttributionCorrection(db(), seed.teamId, plan, { memberId: a }, 3);
    expect(res).toMatchObject({ ok: true, updated: 3 });

    // One item.reassigned{via:correction, from:A, to:B} per item — the batched multi-row insert.
    for (const id of ids) {
      const events = await reassignEvents(seed.teamId, id);
      expect(events).toHaveLength(1);
      expect(events[0].meta).toMatchObject({ from: a, to: b, via: "correction" });
    }
  });

  it("does NOT log a transition when the correction FILLS an unattributed item (null→member is not a reassignment)", async () => {
    const seed = await seedTeam();
    const a = seed.memberId;
    const b = await addMember(seed, "Person Fill", `fill-${randomUUID()}@corp.com`);
    const { id } = await ingest(seed, { body: "unowned doc", path: `notion/${randomUUID()}.md`, access: "team" });
    await db().from("items").update({ member_id: null }).eq("id", id); // force unattributed (no prior owner)

    const res = await applyAttributionCorrection(db(), seed.teamId, itemIdPlan(id, "Person Fill"), { memberId: a }, 1);
    expect(res.ok).toBe(true);

    const { data: after } = await db().from("items").select("member_id").eq("id", id).single();
    expect((after as { member_id: string | null }).member_id).toBe(b); // filled
    expect(await reassignEvents(seed.teamId, id)).toHaveLength(0); // …but NOT a reassignment (no prior owner)
  });
});
