import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { audit } from "@/lib/api/audit";
import { encryptSecret, decryptSecret } from "@/lib/secrets/crypto";
import {
  validateIntegrationConfig,
  type IntegrationInput,
  type IntegrationType,
} from "@/lib/api/schemas";

/**
 * The ONLY write path for the `integrations` table (single-writer guarded, CLAUDE.md §2).
 * Validates the NON-SECRET config (per-type allowlist + secret-key rejection + byte cap), sets
 * `updated_at` explicitly (no DB trigger exists), and audits every change with config KEYS only
 * — never values. Callable from admin server actions / API routes after the caller has checked
 * the actor is a team admin. Secrets never reach here: the sidecar merges tokens locally.
 */

export interface IntegrationAuth {
  teamId: string;
  memberId: string;
}

export async function upsertIntegration(
  supabase: SupabaseClient,
  auth: IntegrationAuth,
  input: IntegrationInput
): Promise<{ id: string; status: string }> {
  const config = validateIntegrationConfig(input.type, input.config); // throws IntegrationConfigError → 400
  const now = new Date().toISOString();
  const { data, error } = await supabase
    .from("integrations")
    .upsert(
      {
        team_id: auth.teamId,
        type: input.type,
        name: input.name,
        config,
        status: input.status ?? "enabled",
        created_by: auth.memberId,
        updated_at: now,
      },
      { onConflict: "team_id,type,name" }
    )
    .select("id, status")
    .single();
  if (error || !data) throw new Error(`integration upsert failed: ${error?.message}`);

  await audit(supabase, {
    team_id: auth.teamId,
    actor_kind: "member",
    member_id: auth.memberId,
    action: "integration.upserted",
    target_type: "integration",
    target_id: data.id as string,
    meta: { type: input.type, name: input.name, configKeys: Object.keys(config) }, // redacted: keys only
  });
  return { id: data.id as string, status: data.status as string };
}

export async function setIntegrationStatus(
  supabase: SupabaseClient,
  auth: IntegrationAuth,
  id: string,
  status: "enabled" | "disabled"
): Promise<void> {
  const { error } = await supabase
    .from("integrations")
    .update({ status, updated_at: new Date().toISOString() })
    .eq("id", id)
    .eq("team_id", auth.teamId); // team-scope the write — no cross-team mutation
  if (error) throw new Error(`integration status update failed: ${error.message}`);
  await audit(supabase, {
    team_id: auth.teamId,
    actor_kind: "member",
    member_id: auth.memberId,
    action: "integration.status_changed",
    target_type: "integration",
    target_id: id,
    meta: { status },
  });
}

export async function deleteIntegration(
  supabase: SupabaseClient,
  auth: IntegrationAuth,
  id: string
): Promise<void> {
  const { error } = await supabase
    .from("integrations")
    .delete()
    .eq("id", id)
    .eq("team_id", auth.teamId);
  if (error) throw new Error(`integration delete failed: ${error.message}`);
  await audit(supabase, {
    team_id: auth.teamId,
    actor_kind: "member",
    member_id: auth.memberId,
    action: "integration.deleted",
    target_type: "integration",
    target_id: id,
  });
}

/**
 * Set/rotate an integration's connector secret (Option B: stored ENCRYPTED in the brain).
 * Team-scoped write of the dedicated `secret_ciphertext` column — never `config`, so the
 * config secret-key rejection is untouched. Audits that a secret was set (keys/flags only,
 * never the value).
 */
export async function setIntegrationSecret(
  supabase: SupabaseClient,
  auth: IntegrationAuth,
  id: string,
  secret: string
): Promise<void> {
  const { error } = await supabase
    .from("integrations")
    .update({ secret_ciphertext: encryptSecret(secret), updated_at: new Date().toISOString() })
    .eq("id", id)
    .eq("team_id", auth.teamId);
  if (error) throw new Error(`integration secret update failed: ${error.message}`);
  await audit(supabase, {
    team_id: auth.teamId,
    actor_kind: "member",
    member_id: auth.memberId,
    action: "integration.secret_set",
    target_type: "integration",
    target_id: id,
    meta: { secretSet: true }, // never the value
  });
}

export interface IntegrationWithSecret {
  id: string;
  type: IntegrationType;
  name: string;
  config: Record<string, unknown>;
  secret: string | null;
}

/**
 * The sidecar read path: enabled integrations for a team with DECRYPTED secrets. Call ONLY
 * from the connector-key-authenticated endpoint (GET /api/v1/integrations) — never a page.
 */
export async function getEnabledIntegrationsWithSecrets(
  supabase: SupabaseClient,
  teamId: string
): Promise<IntegrationWithSecret[]> {
  const { data, error } = await supabase
    .from("integrations")
    .select("id, type, name, config, secret_ciphertext")
    .eq("team_id", teamId)
    .eq("status", "enabled");
  if (error) throw new Error(`load integrations failed: ${error.message}`);
  return (data ?? []).map((r) => ({
    id: r.id as string,
    type: r.type as IntegrationType,
    name: r.name as string,
    config: (r.config as Record<string, unknown>) ?? {},
    secret: r.secret_ciphertext ? decryptSecret(r.secret_ciphertext as string) : null,
  }));
}

/** Re-exported for callers that branch on type without importing schemas directly. */
export type { IntegrationType };
