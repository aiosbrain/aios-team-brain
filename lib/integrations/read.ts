import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { IntegrationType } from "@/lib/api/schemas";

/**
 * Integration reads for UI/admin surfaces. METADATA only — never the secret value (only
 * `hasSecret`). Team-scoped; callers (admin pages/actions) gate on role. The privileged
 * decrypt read used by the sidecar lives in manage.ts (getEnabledIntegrationsWithSecrets).
 */

export interface IntegrationMeta {
  id: string;
  type: IntegrationType;
  name: string;
  config: Record<string, unknown>;
  status: "enabled" | "disabled";
  hasSecret: boolean;
  createdAt: string;
}

export async function listIntegrations(
  supabase: SupabaseClient,
  teamId: string
): Promise<IntegrationMeta[]> {
  const { data, error } = await supabase
    .from("integrations")
    .select("id, type, name, config, status, secret_ciphertext, created_at")
    .eq("team_id", teamId)
    .order("created_at", { ascending: true });
  if (error) throw new Error(`list integrations failed: ${error.message}`);
  return (data ?? []).map((r) => ({
    id: r.id as string,
    type: r.type as IntegrationType,
    name: r.name as string,
    config: (r.config as Record<string, unknown>) ?? {},
    status: r.status as "enabled" | "disabled",
    hasSecret: r.secret_ciphertext != null,
    createdAt: r.created_at as string,
  }));
}

/**
 * Resolve a team-slug + auth-user into an admin write context, or null. This is the DB-level
 * half of the dashboard's `requireAdmin` gate (the session lookup happens in the server action):
 * it returns `{ teamId, memberId }` ONLY when the user is an `active`, `role==="admin"` member of
 * the team — exactly the gate `app/t/[team]/admin/layout.tsx` applies. Any non-admin (member/lead),
 * inactive, wrong-team, or unknown user resolves to null → the write is rejected. Tested on real
 * Postgres (F3.4); there is no RLS backstop on the postgres target, so this app-code gate is the
 * isolation.
 */
export async function resolveIntegrationsAdmin(
  supabase: SupabaseClient,
  teamSlug: string,
  userId: string
): Promise<{ teamId: string; memberId: string } | null> {
  const { data: team } = await supabase.from("teams").select("id").eq("slug", teamSlug).maybeSingle();
  if (!team) return null;
  const { data: me } = await supabase
    .from("members")
    .select("id, role")
    .eq("team_id", team.id)
    .eq("auth_user_id", userId)
    .eq("status", "active")
    .maybeSingle();
  if (!me || me.role !== "admin") return null;
  return { teamId: team.id as string, memberId: me.id as string };
}

/** A team's enabled integration selection — NON-SECRET fields only. */
export interface IntegrationSelection {
  id: string;
  type: IntegrationType;
  name: string;
  config: Record<string, unknown>;
  status: "enabled";
}

/**
 * The API read path for `GET /api/v1/integrations`: a team's ENABLED integrations as
 * NON-SECRET selections (type + name + config). It deliberately never selects, decrypts, or
 * returns `secret_ciphertext` — the connector secret never crosses this HTTP boundary, even to
 * an authenticated connector key. (The in-process Slack runner reads decrypted secrets directly
 * via `manage.getEnabledIntegrationsWithSecrets`, never over HTTP.) Team-scoped: only the
 * caller's `teamId` is returned.
 */
export async function listEnabledIntegrationSelections(
  supabase: SupabaseClient,
  teamId: string
): Promise<IntegrationSelection[]> {
  const { data, error } = await supabase
    .from("integrations")
    .select("id, type, name, config, status") // NOTE: no secret_ciphertext — by design
    .eq("team_id", teamId)
    .eq("status", "enabled")
    .order("created_at", { ascending: true });
  if (error) throw new Error(`list integration selections failed: ${error.message}`);
  return (data ?? []).map((r) => ({
    id: r.id as string,
    type: r.type as IntegrationType,
    name: r.name as string,
    config: (r.config as Record<string, unknown>) ?? {},
    status: "enabled" as const,
  }));
}
