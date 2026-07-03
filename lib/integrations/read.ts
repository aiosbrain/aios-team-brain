import "server-only";
import type { DbClient } from "@/lib/db/types";
import type { IntegrationType } from "@/lib/api/schemas";
import { canManageIntegrations } from "@/lib/integrations/visibility";

/**
 * DASHBOARD integration reads — METADATA only (never the secret value, only `hasSecret`).
 * Team-scoped AND admin-gated: every helper here that reads the `integrations` table routes
 * through `canManageIntegrations(viewer.role)`, because integrations are admin-tier and there is
 * no RLS backstop on the postgres target (CLAUDE.md §5). The integrations-tier-filter guard
 * enforces that routing; the data-mechanics tier test proves the outcome.
 *
 * Other boundaries live elsewhere on purpose: the privileged decrypt read used by the in-process
 * runner and the API-key selection read both live in manage.ts (gated by the connector key at the
 * route, not a dashboard role); writes are gated by `resolveIntegrationsAdmin` (below).
 */

/** A viewer of the dashboard integrations surface. `role` is the member's role on the team. */
export interface IntegrationsViewer {
  role: string | null | undefined;
}

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
  supabase: DbClient,
  teamId: string,
  viewer: IntegrationsViewer
): Promise<IntegrationMeta[]> {
  // Admin-tier surface, no RLS on postgres → this app-code gate is the sole enforcement.
  if (!canManageIntegrations(viewer.role)) return [];
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
  supabase: DbClient,
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
