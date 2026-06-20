import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { upsertIntegration, setIntegrationSecret } from "@/lib/integrations/manage";
import { listIntegrations } from "@/lib/integrations/read";
import { db, seedTeam, type Seed } from "./helpers";

// F5.5 — spec-first, verified to the observable outcome on real Postgres.
//
// Integrations are ADMIN-TIER config: there is no per-row `access` column, and there is NO RLS on
// the postgres target, so the app-code role gate in `listIntegrations` is the SOLE enforcement for
// the dashboard read. Two product invariants:
//   1. Persistence: an integration written through the single writer is read back (config + the
//      derived `hasSecret`) by an ADMIN viewer — and the secret VALUE never appears.
//   2. Tier/role isolation: a non-admin viewer (incl. an `external`-tier collaborator) reads
//      NOTHING through the dashboard helper. (The crown jewel — a leak here exposes admin config
//      with no DB backstop.)

/** Seed a member with a given role + tier directly (no auth link needed for the read-gate test). */
async function seedMember(
  seed: Seed,
  role: "admin" | "lead" | "member",
  tier: "team" | "external"
): Promise<string> {
  const { data, error } = await db()
    .from("members")
    .insert({
      team_id: seed.teamId,
      email: `${randomUUID()}@tier.test`,
      display_name: `${role}-${tier}`,
      actor_handle: `actor-${randomUUID().slice(0, 8)}`,
      role,
      tier,
      status: "active",
    })
    .select("id")
    .single();
  if (error || !data) throw new Error(`seedMember failed: ${error?.message}`);
  return data.id as string;
}

describe("integrations dashboard read — tier/role isolation (real Postgres)", () => {
  it("persists and an ADMIN viewer reads config + hasSecret, but NEVER the secret value", async () => {
    const seed = await seedTeam();
    const adminId = await seedMember(seed, "admin", "team");
    const auth = { teamId: seed.teamId, memberId: adminId };
    const token = "xoxb-TIER-secret-token-abc123";

    const { id } = await upsertIntegration(db(), auth, {
      type: "slack",
      name: "eng-slack",
      config: { channelIds: ["C1", "C2"] },
    });
    await setIntegrationSecret(db(), auth, id, token);

    const rows = await listIntegrations(db(), seed.teamId, { role: "admin" });
    expect(rows).toHaveLength(1); // persisted
    expect(rows[0].type).toBe("slack");
    expect(rows[0].name).toBe("eng-slack");
    expect(rows[0].config).toEqual({ channelIds: ["C1", "C2"] });
    expect(rows[0].hasSecret).toBe(true); // derived, not the value

    // Crown jewel: the decrypted/encrypted secret never rides along on the dashboard read.
    const serialized = JSON.stringify(rows);
    expect(serialized).not.toContain(token);
    expect(serialized).not.toContain("ciphertext");
  });

  it("a non-admin team member reads NOTHING (role gate is the sole enforcement)", async () => {
    const seed = await seedTeam();
    const adminId = await seedMember(seed, "admin", "team");
    await upsertIntegration(db(), { teamId: seed.teamId, memberId: adminId }, {
      type: "github",
      name: "g",
      config: { repos: ["o/r"] },
    });

    expect(await listIntegrations(db(), seed.teamId, { role: "member" })).toEqual([]);
    expect(await listIntegrations(db(), seed.teamId, { role: "lead" })).toEqual([]);
  });

  it("an EXTERNAL-tier collaborator cannot read admin integration config", async () => {
    const seed = await seedTeam();
    const adminId = await seedMember(seed, "admin", "team");
    const externalId = await seedMember(seed, "member", "external");
    await upsertIntegration(db(), { teamId: seed.teamId, memberId: adminId }, {
      type: "slack",
      name: "eng-slack",
      config: { channelIds: ["SECRET-CHANNEL"] },
    });

    // The external collaborator is never an admin → the read returns nothing.
    const externalRole = (
      await db().from("members").select("role").eq("id", externalId).single()
    ).data!.role as string;
    const rows = await listIntegrations(db(), seed.teamId, { role: externalRole });
    expect(rows).toEqual([]);
    expect(JSON.stringify(rows)).not.toContain("SECRET-CHANNEL");

    // Non-vacuity: the same data IS visible to an admin, so the empty result is the gate, not an
    // empty table.
    expect(await listIntegrations(db(), seed.teamId, { role: "admin" })).toHaveLength(1);
  });

  it("a missing/undefined role reads nothing (fail-closed)", async () => {
    const seed = await seedTeam();
    const adminId = await seedMember(seed, "admin", "team");
    await upsertIntegration(db(), { teamId: seed.teamId, memberId: adminId }, {
      type: "slack",
      name: "eng-slack",
      config: { channelIds: ["C1"] },
    });
    expect(await listIntegrations(db(), seed.teamId, { role: undefined })).toEqual([]);
    expect(await listIntegrations(db(), seed.teamId, { role: null })).toEqual([]);
  });
});
