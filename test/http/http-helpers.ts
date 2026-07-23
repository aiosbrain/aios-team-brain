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
  const { key } = await issueApiKey(db(), seed.teamId, (data as { id: string }).id, "admin key");
  return { key };
}

/** Seed a member with a known email + password under the seeded team (for login tests). */
export async function seedMemberEmail(seed: Seed): Promise<{ email: string; password: string }> {
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
  await adminSetPassword(email, password);
  return { email, password };
}

/** Standard auth headers for an API-key request. */
export function keyHeaders(key: string, teamSlug: string): Record<string, string> {
  return {
    Authorization: `Bearer ${key}`,
    "X-AIOS-Team": teamSlug,
    "Content-Type": "application/json",
  };
}
