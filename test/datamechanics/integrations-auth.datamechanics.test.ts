import { describe, expect, it } from "vitest";
import { loginByEmail } from "@/lib/auth/pg-login";
import { upsertIntegration, setIntegrationSecret } from "@/lib/integrations/manage";
import {
  resolveIntegrationsAdmin,
  listEnabledIntegrationSelections,
} from "@/lib/integrations/read";
import { db, seedTeam } from "./helpers";

// F3.4 — spec-first, verified to the observable outcome on real Postgres.
//
// Two product invariants for the integrations auth surfaces:
//  1. (F3.1 write gate) The dashboard write is admin-gated by the same role==="admin" check the
//     /admin layout uses. A non-admin (member/lead) member must NOT resolve to a write context.
//     There is no RLS backstop on the postgres target, so this app-code gate is the isolation.
//  2. (F3.2 API read) GET /api/v1/integrations returns enabled selections as NON-SECRET fields
//     only — never the connector secret / secret_ciphertext — and is team-scoped.

function auth(teamId: string, memberId: string) {
  return { teamId, memberId };
}

/** Insert a member with a known role + email, then force-link an auth user via the login path. */
async function seedMemberWithAuth(
  teamId: string,
  role: "admin" | "lead" | "member",
  email: string
): Promise<{ memberId: string; userId: string }> {
  const { data: m } = await db()
    .from("members")
    .insert({
      team_id: teamId,
      email,
      display_name: role,
      actor_handle: `${role}-${email.split("@")[0]}`,
      role,
      tier: "team",
      status: "invited",
    })
    .select("id")
    .single();
  const user = await loginByEmail(email); // activates + links auth_user_id
  if (!user) throw new Error("login link failed in seed");
  return { memberId: m!.id as string, userId: user.id };
}

describe("integrations dashboard write gate (real Postgres)", () => {
  it("an admin member resolves to a write context", async () => {
    const seed = await seedTeam();
    const admin = await seedMemberWithAuth(seed.teamId, "admin", "admin@f3.test");
    const ctx = await resolveIntegrationsAdmin(db(), seed.teamSlug, admin.userId);
    expect(ctx).not.toBeNull();
    expect(ctx!.teamId).toBe(seed.teamId);
    expect(ctx!.memberId).toBe(admin.memberId);
  });

  it("a non-admin (member-role) is REJECTED — no write context", async () => {
    const seed = await seedTeam();
    const member = await seedMemberWithAuth(seed.teamId, "member", "member@f3.test");
    expect(await resolveIntegrationsAdmin(db(), seed.teamSlug, member.userId)).toBeNull();
  });

  it("a lead-role member is REJECTED — admin-only, not lead", async () => {
    const seed = await seedTeam();
    const lead = await seedMemberWithAuth(seed.teamId, "lead", "lead@f3.test");
    expect(await resolveIntegrationsAdmin(db(), seed.teamSlug, lead.userId)).toBeNull();
  });

  it("an admin of ANOTHER team cannot resolve against this team", async () => {
    const teamA = await seedTeam();
    const teamB = await seedTeam();
    const adminB = await seedMemberWithAuth(teamB.teamId, "admin", "adminB@f3.test");
    // Admin of B, querying A's slug → no membership in A → null.
    expect(await resolveIntegrationsAdmin(db(), teamA.teamSlug, adminB.userId)).toBeNull();
  });
});

describe("integrations API read — non-secret + team-scoped (real Postgres)", () => {
  it("returns enabled selections with NO secret material, even when a secret is set", async () => {
    const seed = await seedTeam();
    const a = auth(seed.teamId, seed.memberId);
    const token = "xoxb-SUPER-secret-token-zzz999";

    const { id } = await upsertIntegration(db(), a, {
      type: "slack",
      name: "eng",
      config: { channelIds: ["C1", "C2"] },
    });
    await setIntegrationSecret(db(), a, id, token);

    const selections = await listEnabledIntegrationSelections(db(), seed.teamId);
    expect(selections).toHaveLength(1);
    const sel = selections[0];
    expect(sel.type).toBe("slack");
    expect(sel.name).toBe("eng");
    expect(sel.config).toEqual({ channelIds: ["C1", "C2"] });

    // Crown jewel: no secret, no ciphertext, no decrypted token anywhere in the payload.
    const serialized = JSON.stringify(selections);
    expect(serialized).not.toContain(token);
    expect(serialized).not.toContain("secret");
    expect(serialized).not.toContain("ciphertext");
    expect(Object.keys(sel)).toEqual(["id", "type", "name", "config", "status"]);
  });

  it("excludes disabled integrations", async () => {
    const seed = await seedTeam();
    const a = auth(seed.teamId, seed.memberId);
    await upsertIntegration(db(), a, {
      type: "github",
      name: "g",
      config: { repos: ["o/r"] },
      status: "disabled",
    });
    expect(await listEnabledIntegrationSelections(db(), seed.teamId)).toHaveLength(0);
  });

  it("is team-scoped: never returns another team's integrations", async () => {
    const teamA = await seedTeam();
    const teamB = await seedTeam();
    await upsertIntegration(db(), auth(teamA.teamId, teamA.memberId), {
      type: "slack",
      name: "a-only",
      config: { channelIds: ["CA"] },
    });
    await upsertIntegration(db(), auth(teamB.teamId, teamB.memberId), {
      type: "slack",
      name: "b-only",
      config: { channelIds: ["CB"] },
    });

    const aSel = await listEnabledIntegrationSelections(db(), teamA.teamId);
    expect(aSel.map((s) => s.name)).toEqual(["a-only"]);
    const bSel = await listEnabledIntegrationSelections(db(), teamB.teamId);
    expect(bSel.map((s) => s.name)).toEqual(["b-only"]);
  });
});
