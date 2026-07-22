import "server-only";
import type { DbClient } from "@/lib/db/types";
import { audit } from "@/lib/api/audit";
import { encryptSecret, decryptSecret } from "@/lib/secrets/crypto";
import {
  validateIntegrationConfig,
  PROVIDER_INTEGRATION_TYPES,
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
  // NOTE: disabling the last enabled provider key does NOT clear a `teams.answering_provider` pointer
  // (unlike deleteIntegration's cascade). Disable is REVERSIBLE — re-enabling should restore the
  // team's choice, and clearing it would silently lose that choice — and the fallback is already
  // surfaced live in the admin picker via `describeAnswering().usedFallback` (getProviderSettings
  // filters status='enabled'). Deletion is permanent, so only it resets the stored pointer.
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
  // Read the type BEFORE deleting — the answering/reasoning pointer cascade below needs to know which
  // provider (if any) this key backed, and the row is gone after the delete.
  const { data: existing } = await db
    .from("integrations")
    .select("type")
    .eq("id", id)
    .eq("team_id", auth.teamId)
    .maybeSingle();
  const deletedType = (existing as { type: string } | null)?.type ?? null;

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

  // Cascade: `teams.answering_provider` / `reasoning_provider` are POINTERS at a provider-key
  // integration. Deleting the last enabled key of that provider would leave the pointer dangling —
  // the answer path silently falls back (Anthropic/env) while the Admin picker keeps claiming the
  // deleted provider is active. Reset the matching pointer(s) back to auto so the stored state stops
  // lying. Provider-key deletes only; connectors never touch these.
  if (deletedType && (PROVIDER_INTEGRATION_TYPES as readonly string[]).includes(deletedType)) {
    await clearDanglingProviderPointers(db, auth, deletedType as ProviderIntegrationType);
  }
}

/**
 * After a provider key is deleted, null any team answering/reasoning pointer that referenced it —
 * BUT only when no ENABLED key of that provider remains (a redundant/backup key keeps the pointer
 * valid). Best-effort + audited: a cleanup hiccup must not fail the delete the user already committed.
 */
async function clearDanglingProviderPointers(
  db: DbClient,
  auth: IntegrationAuth,
  deletedType: ProviderIntegrationType
): Promise<void> {
  try {
    const { data: remaining, error: remErr } = await db
      .from("integrations")
      .select("id")
      .eq("team_id", auth.teamId)
      .eq("type", deletedType)
      .eq("status", "enabled")
      .limit(1)
      .maybeSingle();
    // Can't confirm the provider is gone (read error) → keep the pointer (fail-safe: never flip a
    // still-valid override to AUTO on a transient blip).
    if (remErr) return;
    if (remaining) return; // an enabled backup key of this type remains → pointer isn't dangling

    const { data: team, error: teamErr } = await db
      .from("teams")
      .select("answering_provider, reasoning_provider, reasoning_model")
      .eq("id", auth.teamId)
      .maybeSingle();
    if (teamErr) return;
    const row = team as {
      answering_provider: string | null;
      reasoning_provider: string | null;
      reasoning_model: string | null;
    } | null;
    const updates: { answering_provider?: null; reasoning_provider?: null; reasoning_model?: null } = {};
    if (row?.answering_provider === deletedType) updates.answering_provider = null;
    if (row?.reasoning_provider === deletedType) {
      // provider+model are a coupled pair (see setReasoningModel) — an orphaned model on a nulled
      // provider would run on the ANSWERING backend (llm-backend selectLlmBackend), sending e.g. an
      // OpenAI slug to Anthropic → a hard error on every arc synthesis. Null both.
      updates.reasoning_provider = null;
      updates.reasoning_model = null;
    }
    if (Object.keys(updates).length === 0) return; // nothing pointed at the deleted provider

    const { error } = await db.from("teams").update(updates).eq("id", auth.teamId);
    if (error) throw new Error(error.message);
    await audit(db, {
      team_id: auth.teamId,
      actor_kind: "member",
      member_id: auth.memberId,
      action: "team.answering_provider_reset",
      target_type: "team",
      target_id: auth.teamId,
      meta: { reason: "provider_key_deleted", provider: deletedType, cleared: Object.keys(updates) },
    });
  } catch (err) {
    // Best-effort: a cleanup hiccup must not fail the delete the user already committed. The dangling
    // pointer still degrades gracefully — selectLlmBackend falls back to AUTO and the admin picker
    // shows `usedFallback` (describeAnswering) — so log and move on rather than surfacing a false error.
    console.error(
      "[integrations] answering-provider cascade failed:",
      err instanceof Error ? err.message : err
    );
  }
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
  if (error) {
    // A not-yet-migrated DB may lack the `integrations` table entirely. Treat a
    // missing table the same as "no key configured" so callers fall back to the
    // process env (see the doc comment above) instead of 500-ing the query path.
    if (/(relation|table).*does not exist|no such table/i.test(error.message)) {
      return null;
    }
    throw new Error(`load provider key failed: ${error.message}`);
  }
  const blob = (data as { secret_ciphertext: string | null } | null)?.secret_ciphertext;
  return blob ? decryptSecret(blob) : null;
}

/**
 * Resolve one provider's answering settings — the decrypted key plus the chosen model slug
 * (`config.model`) — in one read. Used by the answering resolver (lib/query/answering) to build the
 * per-team backend keys. Returns nulls when unset/disabled so the caller falls through. Server-only;
 * the key is decrypted only here, in-process.
 */
export async function getProviderSettings(
  db: DbClient,
  teamId: string,
  type: ProviderIntegrationType
): Promise<{ key: string | null; model: string | null }> {
  const { data, error } = await db
    .from("integrations")
    .select("secret_ciphertext, config")
    .eq("team_id", teamId)
    .eq("type", type)
    .eq("status", "enabled")
    .limit(1)
    .maybeSingle();
  if (error) {
    // A not-yet-migrated DB may lack the `integrations` table — treat as "not configured".
    if (/(relation|table).*does not exist|no such table/i.test(error.message)) {
      return { key: null, model: null };
    }
    throw new Error(`load ${type} settings failed: ${error.message}`);
  }
  const row = data as { secret_ciphertext: string | null; config: Record<string, unknown> | null } | null;
  const key = row?.secret_ciphertext ? decryptSecret(row.secret_ciphertext) : null;
  const model = typeof row?.config?.model === "string" ? (row.config.model as string) : null;
  return { key, model };
}

/** OpenRouter settings — a thin alias for the generic reader (kept for existing callers). */
export function getOpenrouterSettings(
  db: DbClient,
  teamId: string
): Promise<{ key: string | null; model: string | null }> {
  return getProviderSettings(db, teamId, "openrouter");
}

/**
 * Persist the NON-secret answer-model slug on a provider key (anthropic/openai/openrouter), merging
 * into the row's existing config so the encrypted key is preserved. Creates a keyless row if none
 * exists yet (a model-only choice is valid — e.g. Anthropic answers via the SDK's env key). Empty
 * string clears the choice (falls back to the provider's default model). Single-writer via
 * `upsertIntegration`; the caller (admin action) is the gate.
 */
export async function saveProviderModel(
  db: DbClient,
  auth: IntegrationAuth,
  type: ProviderIntegrationType,
  model: string
): Promise<void> {
  const { data } = await db
    .from("integrations")
    .select("name, status, config")
    .eq("team_id", auth.teamId)
    .eq("type", type)
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();
  const row = data as
    | { name: string; status: "enabled" | "disabled"; config: Record<string, unknown> | null }
    | null;
  const config: Record<string, unknown> = { ...(row?.config ?? {}) };
  config.model = model.trim() || undefined;
  await upsertIntegration(db, auth, {
    type,
    name: row?.name ?? type,
    config,
    status: row?.status ?? "enabled",
  });
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
