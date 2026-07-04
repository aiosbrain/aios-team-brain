import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { ingestMaturitySnapshot } from "@/lib/metrics/individual-maturity-ingest";
import { createMember } from "@/lib/admin/members";
import { maturitySnapshotPayloadSchema } from "@/lib/api/schemas";
import { db, seedTeam } from "./helpers";

// Spec-first, verified to the observable DB outcome: the brain recomputes canonical
// AEM scores from pushed signals, the verification gate holds through persistence,
// the snapshot is idempotent per (member, date), and member resolution is enforced.

function snapshot(over: Record<string, unknown> = {}) {
  return maturitySnapshotPayloadSchema.parse({
    metric: "aem-individual",
    date: "2026-06-18",
    window_days: 1,
    signals: {
      delegation_ratio: 0.3, correction_loop_avg: 1.2, error_rate: 0.05,
      cost_per_task: 0.4, tokens_per_task: 30_000, cache_hit_rate: 0.8,
      tool_diversity: 8, verify_tool_rate: 0.3, subagent_usage: 0.5,
    },
    provisional: { spine: "L9-bogus", axes: { verification: 99 } }, // must NOT be trusted
    sessions: 40, tasks: 130,
    ...over,
  });
}

async function ingest(seed: { teamId: string; memberId: string }, payload: ReturnType<typeof snapshot>) {
  return ingestMaturitySnapshot(db(), { teamId: seed.teamId, memberId: seed.memberId, apiKeyId: randomUUID() }, payload);
}

async function rowFor(teamId: string, memberId: string, date: string) {
  const { data } = await db()
    .from("agentic_maturity_snapshots")
    .select("*")
    .eq("team_id", teamId).eq("member_id", memberId).eq("snapshot_date", date)
    .maybeSingle();
  return data as Record<string, unknown> | null;
}

describe("agentic-maturity snapshot ingest (real Postgres)", () => {
  it("persists raw signals + brain-recomputed canonical scores (ignoring client provisional)", async () => {
    const seed = await seedTeam();
    const res = await ingest(seed, snapshot());
    expect(res.canonical.spine).toMatch(/^L[1-5]$/);

    const row = await rowFor(seed.teamId, seed.memberId, "2026-06-18");
    expect(row).not.toBeNull();
    // raw signal stored
    expect(Number(row!.cache_hit_rate)).toBeCloseTo(0.8, 4);
    expect(Number(row!.tasks)).toBe(130);
    // canonical recomputed by the brain (verify_tool_rate 0.3 → verification 4)
    expect(Number(row!.canonical_verification)).toBe(4);
    // provisional persisted verbatim as provenance, but NOT used as canonical
    expect(row!.provisional_spine).toBe("L9-bogus");
    expect(row!.canonical_spine).not.toBe("L9-bogus");
  });

  it("GATE through the DB: verification ≤ 1 caps canonical Spine at L3 even when else strong", async () => {
    const seed = await seedTeam();
    await ingest(seed, snapshot({
      signals: {
        delegation_ratio: 0.5, correction_loop_avg: 1, error_rate: 0,
        cost_per_task: 0.1, tokens_per_task: 10_000, cache_hit_rate: 0.9,
        tool_diversity: 10, verify_tool_rate: 0, subagent_usage: 0.6, // no verify tools
      },
    }));
    const row = await rowFor(seed.teamId, seed.memberId, "2026-06-18");
    expect(Number(row!.canonical_verification)).toBe(0);
    expect(row!.canonical_spine).toBe("L3");
  });

  it("is idempotent per (member, date): re-push updates in place, no duplicate row", async () => {
    const seed = await seedTeam();
    await ingest(seed, snapshot({ tasks: 100 }));
    await ingest(seed, snapshot({ tasks: 222 }));
    const { data } = await db()
      .from("agentic_maturity_snapshots")
      .select("id")
      .eq("team_id", seed.teamId).eq("member_id", seed.memberId).eq("snapshot_date", "2026-06-18");
    expect((data as unknown[]).length).toBe(1);
    const row = await rowFor(seed.teamId, seed.memberId, "2026-06-18");
    expect(Number(row!.tasks)).toBe(222); // last write wins
  });

  it("an explicit member handle is resolved to that member; unknown handles are rejected", async () => {
    const seed = await seedTeam();
    const alex = await createMember(db(), seed.teamId, {
      email: "alex@x.test", displayName: "Alex", actorHandle: "alex", role: "member",
    });
    const res = await ingest(seed, snapshot({ member: "alex" }));
    expect(res.member_id).toBe(alex.id);

    await expect(ingest(seed, snapshot({ member: "ghost" }))).rejects.toThrow(/unknown member/i);
  });

  describe("ce_band (v1.3 shadow band)", () => {
    it("persists an explicit band; canonical_* is unaffected by its presence", async () => {
      const seed = await seedTeam();
      const withBand = await ingest(seed, snapshot({ ce_band: 3 }));
      const row = await rowFor(seed.teamId, seed.memberId, "2026-06-18");
      expect(row!.ce_band).toBe(3);
      expect(withBand.canonical.spine).toMatch(/^L[1-5]$/);
    });

    it("persists an explicit null", async () => {
      const seed = await seedTeam();
      await ingest(seed, snapshot({ ce_band: null }));
      const row = await rowFor(seed.teamId, seed.memberId, "2026-06-18");
      expect(row!.ce_band).toBeNull();
    });

    it("stays NULL when the field is omitted (older client)", async () => {
      const seed = await seedTeam();
      await ingest(seed, snapshot());
      const row = await rowFor(seed.teamId, seed.memberId, "2026-06-18");
      expect(row!.ce_band).toBeNull();
    });

    it("column-wise merge: push-with-band then re-push-without leaves the band intact", async () => {
      const seed = await seedTeam();
      await ingest(seed, snapshot({ ce_band: 3 }));
      await ingest(seed, snapshot({ tasks: 999 })); // no ce_band key at all
      const row = await rowFor(seed.teamId, seed.memberId, "2026-06-18");
      expect(row!.ce_band).toBe(3);
      expect(Number(row!.tasks)).toBe(999); // the re-push's other fields DID apply
    });

    it("re-push with explicit null clears a previously stored band", async () => {
      const seed = await seedTeam();
      await ingest(seed, snapshot({ ce_band: 3 }));
      await ingest(seed, snapshot({ ce_band: null }));
      const row = await rowFor(seed.teamId, seed.memberId, "2026-06-18");
      expect(row!.ce_band).toBeNull();
    });

    it("canonical_* columns are identical with and without ce_band", async () => {
      const seed = await seedTeam();
      const withBand = await ingest(seed, snapshot({ ce_band: 3 }));
      const rowWith = await rowFor(seed.teamId, seed.memberId, "2026-06-18");

      const seed2 = await seedTeam();
      const withoutBand = await ingest(seed2, snapshot());
      const rowWithout = await rowFor(seed2.teamId, seed2.memberId, "2026-06-18");

      expect(withBand.canonical).toEqual(withoutBand.canonical);
      expect(rowWith!.canonical_spine).toBe(rowWithout!.canonical_spine);
      expect(Number(rowWith!.canonical_overall)).toBe(Number(rowWithout!.canonical_overall));
    });
  });
});
