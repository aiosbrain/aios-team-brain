import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { db, ingest, seedTeam, type Seed } from "./helpers";
import { assessAccessHealth } from "@/lib/admin/access-health";
import { ensureAccessBootstrap } from "@/lib/access/bootstrap";
import { backfillTeamContext } from "@/lib/projects/context/backfill";

// PRET-6 §1/AC5 — the flip subsystem's readiness scan, re-homed as the STANDING access-health
// check when its subsystem retired. The properties that survive the move, proven against the
// real oracle: a blind human is a BLOCKER, an unpartitioned item is a BLOCKER, an unplaced
// agent and an active connector are WARNINGS (never fatal), and a converged team is healthy.

async function seedMemberRow(
  seed: Seed,
  over: Partial<{ kind: string; tier: string; status: string; is_connector: boolean }> = {}
): Promise<string> {
  const { data, error } = await db()
    .from("members")
    .insert({
      team_id: seed.teamId,
      email: `${randomUUID()}@test.local`,
      display_name: `M-${randomUUID().slice(0, 6)}`,
      actor_handle: `h-${randomUUID().slice(0, 10)}`,
      role: "member",
      tier: over.tier ?? "team",
      status: over.status ?? "active",
      is_connector: over.is_connector ?? false,
      kind: over.kind ?? "human",
    })
    .select("id")
    .single();
  if (error || !data) throw new Error(`seed member failed: ${error?.message}`);
  return data.id as string;
}

async function converge(seed: Seed): Promise<void> {
  expect((await ensureAccessBootstrap(db(), seed.teamId)).ok).toBe(true);
  const r = await backfillTeamContext(db(), seed.teamId);
  expect(r.ok, r.error).toBe(true);
}

describe("access health — the re-homed standing scan (PRET-6 AC5)", () => {
  it("a converged team with placed humans is healthy: no blockers, counts populated", async () => {
    const seed = await seedTeam();
    await ingest(seed, { path: "a.md", body: "a", access: "team", project: "src" });
    await converge(seed);

    const h = await assessAccessHealth(db(), seed.teamId);
    expect(h.blockers, h.blockers.join("; ")).toEqual([]);
    expect(h.healthy).toBe(true);
    expect(h.humanPrincipals).toBeGreaterThan(0);
    expect(h.blindHumans).toEqual([]);
    expect(h.unpartitioned.count).toBe(0);
  });

  it("a BLIND human (in no builtin, no granted group) is a blocker — found through the oracle, not a table proxy", async () => {
    const seed = await seedTeam();
    await ingest(seed, { path: "b.md", body: "b", access: "team", project: "src" });
    await converge(seed);
    const lonely = await seedMemberRow(seed); // active human, never placed in any group

    const h = await assessAccessHealth(db(), seed.teamId);
    expect(h.healthy).toBe(false);
    expect(h.blindHumans.map((b) => b.memberId), "the unplaced human is the blind one").toContain(lonely);
    expect(h.blockers.join(" "), "a lockout is a blocker").toMatch(/see NOTHING/);
  });

  it("an UNPARTITIONED item is a blocker — invisible to everyone until the backfill covers it", async () => {
    const seed = await seedTeam();
    const item = await ingest(seed, { path: "c.md", body: "c", access: "team", project: "src" });
    await converge(seed);
    // Strip the item's live membership — the coverage gap the scan exists to catch.
    const { data: unit } = await db().from("project_context_units").select("id").eq("source_item_id", item.id).single();
    await db().from("project_context_memberships").update({ valid_to: new Date().toISOString() }).eq("context_unit_id", unit!.id).is("valid_to", null);

    const h = await assessAccessHealth(db(), seed.teamId);
    expect(h.healthy).toBe(false);
    expect(h.unpartitioned.count).toBeGreaterThan(0);
    expect(h.blockers.join(" ")).toMatch(/no current project membership/);
  });

  it("a CUSTOM-ONLY human (no builtin, but granted a project through an ordinary group) is a WARNING, not a blind blocker (Codex diff-review Medium)", async () => {
    const seed = await seedTeam();
    await ingest(seed, { path: "co.md", body: "co", access: "team", project: "src" });
    await converge(seed);
    const custom = await seedMemberRow(seed); // human, never placed in a builtin
    const { createGroup, grantProjectToGroup, addMemberToGroup } = await import("@/lib/access/groups");
    const { data: proj } = await db().from("projects").insert({ team_id: seed.teamId, slug: "co-proj", name: "CO", kind: "initiative" }).select("id").single();
    const g = await createGroup(db(), seed.teamId, "co-g", "CO", seed.memberId);
    await addMemberToGroup(db(), seed.teamId, g.groupId!, custom, seed.memberId);
    await grantProjectToGroup(db(), seed.teamId, proj!.id as string, g.groupId!, seed.memberId);

    const h = await assessAccessHealth(db(), seed.teamId);
    expect(h.blindHumans.map((b) => b.memberId), "a member with real grants is NOT blind").not.toContain(custom);
    expect(h.blockers).toEqual([]);
    expect(h.healthy).toBe(true);
    expect(h.warnings.join(" "), "the missing builtin floor is reported").toMatch(/NO builtin group/);
  });

  it("an unplaced AGENT and an active CONNECTOR are warnings, never blockers — the team stays healthy", async () => {
    const seed = await seedTeam();
    await ingest(seed, { path: "d.md", body: "d", access: "team", project: "src" });
    await converge(seed);
    const agent = await seedMemberRow(seed, { kind: "agent" });
    const connector = await seedMemberRow(seed, { is_connector: true });

    const h = await assessAccessHealth(db(), seed.teamId);
    expect(h.healthy, "warnings must not flip health").toBe(true);
    expect(h.blockers).toEqual([]);
    expect(h.unplacedAgents.map((a) => a.memberId)).toContain(agent);
    expect(h.activeConnectors.map((c) => c.memberId)).toContain(connector);
    expect(h.warnings.length).toBeGreaterThanOrEqual(2);
  });
});
