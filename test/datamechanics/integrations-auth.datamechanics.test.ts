import { NextRequest } from "next/server";
import { describe, expect, it } from "vitest";
import { GET as integrationsGET } from "@/app/api/v1/integrations/route";
import { issueApiKey } from "@/lib/admin/keys";
import { ensureAuthUser, linkMemberByEmail } from "@/lib/auth/pg-login";
import { getPool } from "@/lib/db/pg/pool";
import {
  upsertIntegration,
  setIntegrationSecret,
  listEnabledIntegrationSelections,
  listIntegrationSelections,
} from "@/lib/integrations/manage";
import { resolveIntegrationsAdmin } from "@/lib/integrations/read";
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
  const userId = await ensureAuthUser(email);
  // Team-scoped activation: pass the team so the invited row is linked AND activated here.
  await linkMemberByEmail(userId, email, teamId);
  // PRET-4 explicit state: raw-inserted fixture members need their builtin-posture row (in
  // production createMember writes it; the retired recompute no longer heals raw inserts).
  const { placeMemberByTier } = await import("./helpers");
  await placeMemberByTier(teamId, m!.id as string, "team");
  return { memberId: m!.id as string, userId };
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

// AIO-1167 — the explicit disabled-inclusive read (`?include_disabled=1`) the Drive sidecar's
// preflight and pause re-reads depend on. Spec: the DEFAULT stays enabled-only; only the exact
// value `1` adds paused/disabled rows; either way the payload is non-secret and team-scoped. Secrets
// are really stored here (on an enabled AND a disabled row), so "no secret material" is proven
// against data that has some, not against fixtures that never had any.
describe("integrations API read — explicit include_disabled=1 (real Postgres, real route)", () => {
  const ENABLED_TOKEN = "xoxb-enabled-token-qqq111";
  const PAUSED_TOKEN = "xoxb-paused-token-rrr222";

  async function world() {
    const teamA = await seedTeam();
    const teamB = await seedTeam();
    const a = auth(teamA.teamId, teamA.memberId);
    const enabled = await upsertIntegration(db(), a, { type: "slack", name: "eng", config: { channelIds: ["C1"] } });
    await setIntegrationSecret(db(), a, enabled.id, ENABLED_TOKEN);
    const paused = await upsertIntegration(db(), a, {
      type: "slack", name: "paused-eng", config: { channelIds: ["C2"] }, status: "disabled",
    });
    await setIntegrationSecret(db(), a, paused.id, PAUSED_TOKEN);
    // Fixture evidence: both team-A rows really hold stored secret material, so every "no secret in
    // the response" assertion below is made against data that has some. Presence is derived IN SQL —
    // the ciphertext itself is never fetched, so no failure output can ever contain it.
    const { rows: stored } = await getPool().query<{ id: string; has_secret: boolean }>(
      `select id, secret_ciphertext is not null as has_secret
         from integrations where team_id=$1 and id = any($2::uuid[])`,
      [teamA.teamId, [enabled.id, paused.id]],
    );
    const byId = (x: { id: string }, y: { id: string }) => (x.id < y.id ? -1 : x.id > y.id ? 1 : 0);
    expect([...stored].sort(byId)).toEqual(
      [{ id: enabled.id, has_secret: true }, { id: paused.id, has_secret: true }].sort(byId),
    );
    // Another team's rows, enabled and disabled: never in team A's read.
    const b = auth(teamB.teamId, teamB.memberId);
    await upsertIntegration(db(), b, { type: "slack", name: "b-enabled", config: { channelIds: ["CB"] } });
    await upsertIntegration(db(), b, { type: "slack", name: "b-paused", config: { channelIds: ["CB2"] }, status: "disabled" });
    const issued = await issueApiKey(db(), teamA.teamId, teamA.memberId, "integrations read");
    const read = async (query: string, team = teamA.teamSlug) => {
      const response = await integrationsGET(new NextRequest(`http://test/api/v1/integrations${query}`, {
        headers: { Authorization: `Bearer ${issued.key}`, "X-AIOS-Team": team },
      }));
      return { status: response.status, raw: await response.text() };
    };
    return { teamA, teamB, read };
  }

  function assertNonSecret(raw: string) {
    expect(raw).not.toContain(ENABLED_TOKEN);
    expect(raw).not.toContain(PAUSED_TOKEN);
    expect(raw).not.toContain("secret");
    expect(raw).not.toContain("ciphertext");
    for (const row of JSON.parse(raw).integrations as Record<string, unknown>[]) {
      expect(Object.keys(row)).toEqual(["id", "type", "name", "config", "status"]);
    }
  }

  const names = (raw: string) =>
    (JSON.parse(raw).integrations as { name: string; status: string }[]).map((r) => [r.name, r.status]);

  it("defaults to enabled-only selections", async () => {
    const w = await world();
    const { status, raw } = await w.read("");
    expect(status).toBe(200);
    expect(names(raw)).toEqual([["eng", "enabled"]]);
    assertNonSecret(raw);
  });

  it("include_disabled=1 adds the team's disabled rows — still non-secret and team-scoped", async () => {
    const w = await world();
    const { status, raw } = await w.read("?include_disabled=1");
    expect(status).toBe(200);
    expect(names(raw)).toEqual([["eng", "enabled"], ["paused-eng", "disabled"]]);
    expect(raw).not.toContain("b-enabled");
    expect(raw).not.toContain("b-paused");
    assertNonSecret(raw);
  });

  it.each(["?include_disabled=true", "?include_disabled=0", "?include_disabled="])(
    "only the exact value 1 is disabled-inclusive (%s reads enabled-only)",
    async (query) => {
      const w = await world();
      const { status, raw } = await w.read(query);
      expect(status).toBe(200);
      expect(names(raw)).toEqual([["eng", "enabled"]]);
    },
  );

  it("a key presented for ANOTHER team reads nothing, inclusive or not", async () => {
    const w = await world();
    for (const query of ["", "?include_disabled=1"]) {
      const { status, raw } = await w.read(query, w.teamB.teamSlug);
      expect(status, query).toBe(401);
      expect(raw).not.toContain("b-paused");
      expect(raw).not.toContain("paused-eng");
    }
  });

  it("the disabled-inclusive helper itself is team-scoped and never selects secret material", async () => {
    const w = await world();
    const rows = await listIntegrationSelections(db(), w.teamA.teamId);
    expect(rows.map((r) => [r.name, r.status])).toEqual([["eng", "enabled"], ["paused-eng", "disabled"]]);
    assertNonSecret(JSON.stringify({ integrations: rows }));
  });
});
