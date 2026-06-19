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
