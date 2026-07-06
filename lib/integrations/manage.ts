import "server-only";
import type { DbClient } from "@/lib/db/types";
import { audit } from "@/lib/api/audit";
import { encryptSecret, decryptSecret } from "@/lib/secrets/crypto";
import {
  validateIntegrationConfig,
  type IntegrationInput,
  type IntegrationType,
  type ProviderIntegrationType,
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
  db: DbClient,
  auth: IntegrationAuth,
  input: IntegrationInput
): Promise<{ id: string; status: string }> {
  const config = validateIntegrationConfig(input.type, input.config); // throws IntegrationConfigError → 400
  const now = new Date().toISOString();
  const { data, error } = await db
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

  await audit(db, {
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
  db: DbClient,
  auth: IntegrationAuth,
  id: string,
  status: "enabled" | "disabled"
): Promise<void> {
  const { error } = await db
    .from("integrations")
    .update({ status, updated_at: new Date().toISOString() })
    .eq("id", id)
    .eq("team_id", auth.teamId); // team-scope the write — no cross-team mutation
  if (error) throw new Error(`integration status update failed: ${error.message}`);
  await audit(db, {
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
  db: DbClient,
  auth: IntegrationAuth,
  id: string
): Promise<void> {
  const { error } = await db
    .from("integrations")
    .delete()
    .eq("id", id)
    .eq("team_id", auth.teamId);
  if (error) throw new Error(`integration delete failed: ${error.message}`);
  await audit(db, {
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
  db: DbClient,
  auth: IntegrationAuth,
  id: string,
  secret: string
): Promise<void> {
  const { error } = await db
    .from("integrations")
    .update({ secret_ciphertext: encryptSecret(secret), updated_at: new Date().toISOString() })
    .eq("id", id)
    .eq("team_id", auth.teamId);
  if (error) throw new Error(`integration secret update failed: ${error.message}`);
  await audit(db, {
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
  db: DbClient,
  teamId: string
): Promise<IntegrationWithSecret[]> {
  const { data, error } = await db
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

/**
 * Resolve a team's stored LLM provider API key (decrypted), or null if none is set/enabled.
 * Server-only consumption path for the query LLM (lib/query/claude.ts) and embeddings — callers
 * fall back to the process env when this is null, so an unset key keeps today's env behavior.
 * Never reaches a browser; the key is decrypted only here, in-process.
 */
export async function getProviderKey(
  db: DbClient,
  teamId: string,
  type: ProviderIntegrationType
): Promise<string | null> {
  const { data, error } = await db
    .from("integrations")
    .select("secret_ciphertext")
    .eq("team_id", teamId)
    .eq("type", type)
    .eq("status", "enabled")
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(`load provider key failed: ${error.message}`);
  const blob = (data as { secret_ciphertext: string | null } | null)?.secret_ciphertext;
  return blob ? decryptSecret(blob) : null;
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
 * The API read path for `GET /api/v1/integrations`: a team's ENABLED integrations as NON-SECRET
 * selections (type + name + config). It deliberately never selects, decrypts, or returns
 * `secret_ciphertext` — the connector secret never crosses this HTTP boundary, even to an
 * authenticated connector key. (The in-process Slack runner reads decrypted secrets directly via
 * `getEnabledIntegrationsWithSecrets` above, never over HTTP.) Gated by the connector key at the
 * route (`authenticateApiKey`), not a dashboard role — so it lives here, not in read.ts (whose
 * helpers are all admin-role-gated). Team-scoped: only the caller's `teamId` is returned.
 */
export async function listEnabledIntegrationSelections(
  db: DbClient,
  teamId: string
): Promise<IntegrationSelection[]> {
  const { data, error } = await db
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

/** Re-exported for callers that branch on type without importing schemas directly. */
export type { IntegrationType };
