import { randomUUID } from "node:crypto";
import { issueApiKey } from "@/lib/admin/keys";
import { adminSetPassword } from "@/lib/auth/pg-login";
import { db, seedTeam, type Seed } from "../datamechanics/helpers";
import { BASE_URL } from "./server-url";

// Shared helpers for the HTTP tier. Seeding reuses the data-mechanics helpers
// (same test DB the server reads); requests go over a real socket to BASE_URL.

export { BASE_URL };
export { db, seedTeam, type Seed };

/**
 * Issue an API key for the seeded team member (tier=team) or for a fresh
 * external-tier member on the same team. Mirrors `issueKeyFor` in
 * route-tier-guards.datamechanics.test.ts so the two tiers stay consistent.
 */
export async function issueKeyFor(seed: Seed, tier: "team" | "external"): Promise<{ key: string }> {
  let memberId = seed.memberId;
  if (tier === "external") {
    const { data, error } = await db()
      .from("members")
      .insert({
        team_id: seed.teamId,
        email: `ext-${randomUUID().slice(0, 8)}@test.local`,
        display_name: "External",
        actor_handle: `ext-${randomUUID().slice(0, 8)}`,
        role: "member",
        tier: "external",
        status: "active",
      })
      .select("id")
      .single();
    if (error || !data) throw new Error(`external member seed failed: ${error?.message}`);
    // PRET-4 explicit state: the raw-inserted external member gets their builtin-posture row
    // (production mints members via createMember, which writes it; absent-row would ALSO
    // resolve external, but the row keeps fixtures production-shaped).
    const { placeMemberByTier } = await import("../datamechanics/helpers");
    await placeMemberByTier(seed.teamId, data.id as string, "external");
    memberId = (data as { id: string }).id;
  }
  const { key } = await issueApiKey(db(), seed.teamId, memberId, `${tier} key`);
  return { key };
}

/** Issue a key for a fresh team-tier ADMIN member on the seeded team (for admin-gated route tests). */
export async function issueAdminKey(seed: Seed): Promise<{ key: string }> {
  const { data, error } = await db()
    .from("members")
    .insert({
      team_id: seed.teamId,
      email: `admin-${randomUUID().slice(0, 8)}@test.local`,
      display_name: "Admin",
      actor_handle: `admin-${randomUUID().slice(0, 8)}`,
      role: "admin",
      tier: "team",
      status: "active",
    })
    .select("id")
    .single();
  if (error || !data) throw new Error(`admin member seed failed: ${error?.message}`);
  const { placeMemberByTier } = await import("../datamechanics/helpers");
  await placeMemberByTier(seed.teamId, (data as { id: string }).id, "team");
  const { key } = await issueApiKey(db(), seed.teamId, (data as { id: string }).id, "admin key");
  return { key };
}

/** Seed a member with a known email + password under the seeded team (for login tests). */
export async function seedMemberEmail(seed: Seed): Promise<{ email: string; password: string; memberId: string }> {
  const email = `login-${randomUUID().slice(0, 8)}@test.local`;
  const password = `test-password-${randomUUID().slice(0, 12)}`;
  const { error } = await db()
    .from("members")
    .insert({
      team_id: seed.teamId,
      email,
      display_name: "Login Member",
      actor_handle: `login-${randomUUID().slice(0, 8)}`,
      role: "member",
      tier: "team",
      status: "active",
    });
  if (error) throw new Error(`login member seed failed: ${error.message}`);
  const { data: loginRow } = await db().from("members").select("id").eq("team_id", seed.teamId).eq("email", email).single();
  const { placeMemberByTier } = await import("../datamechanics/helpers");
  await placeMemberByTier(seed.teamId, (loginRow as { id: string }).id, "team");
  await adminSetPassword(email, password);
  return { email, password, memberId: (loginRow as { id: string }).id };
}

/** Standard auth headers for an API-key request. */
export function keyHeaders(key: string, teamSlug: string): Record<string, string> {
  return {
    Authorization: `Bearer ${key}`,
    "X-AIOS-Team": teamSlug,
    "Content-Type": "application/json",
  };
}

/** PRET-6: teams are enforcing by construction, so http fixtures must CONVERGE (partition their
 *  items) before a read — the items route's after() hook is async and racing it is flaky. */
export async function convergeTeam(seed: Seed): Promise<void> {
  const { backfillTeamContext } = await import("@/lib/projects/context/backfill");
  const r = await backfillTeamContext(db(), seed.teamId);
  if (!r.ok) throw new Error(`convergeTeam failed: ${r.error}`);
}
