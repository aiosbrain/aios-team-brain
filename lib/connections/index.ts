import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { encryptSecret, decryptSecret } from "@/lib/secrets/crypto";

/**
 * Ingestion connections (Integrations settings) — the SOLE writer of the `connections`
 * table. Secrets are encrypted at rest (lib/secrets); plaintext only crosses this boundary
 * on input (set*) and on the sidecar read path (getEnabledConnectionsWithSecrets). Metadata
 * reads never include the secret. Team-scoped throughout.
 */

export interface ConnectionMeta {
  id: string;
  source: string;
  name: string;
  config: Record<string, unknown>;
  enabled: boolean;
  hasSecret: boolean;
  createdAt: string;
}

export interface ConnectionWithSecret {
  source: string;
  name: string;
  config: Record<string, unknown>;
  secret: string | null;
  enabled: boolean;
}

type Row = {
  id: string;
  source: string;
  name: string;
  config: Record<string, unknown> | null;
  enabled: boolean;
  secret_ciphertext: string | null;
  created_at: string;
};

/** List a team's connections as METADATA only — never returns the secret. */
export async function listConnections(
  supabase: SupabaseClient,
  teamId: string
): Promise<ConnectionMeta[]> {
  const { data, error } = await supabase
    .from("connections")
    .select("id, source, name, config, enabled, secret_ciphertext, created_at")
    .eq("team_id", teamId)
    .order("created_at", { ascending: true });
  if (error) throw new Error(`list connections failed: ${error.message}`);
  return (data ?? []).map((r: Row) => ({
    id: r.id,
    source: r.source,
    name: r.name,
    config: r.config ?? {},
    enabled: r.enabled,
    hasSecret: r.secret_ciphertext != null,
    createdAt: r.created_at,
  }));
}

export async function createConnection(
  supabase: SupabaseClient,
  args: {
    teamId: string;
    source: string;
    name: string;
    config?: Record<string, unknown>;
    secret?: string | null;
    createdBy?: string | null;
  }
): Promise<{ id: string }> {
  const secret_ciphertext =
    args.secret != null && args.secret !== "" ? encryptSecret(args.secret) : null;
  const { data, error } = await supabase
    .from("connections")
    .insert({
      team_id: args.teamId,
      source: args.source,
      name: args.name,
      config: args.config ?? {},
      secret_ciphertext,
      created_by: args.createdBy ?? null,
    })
    .select("id")
    .single();
  if (error || !data) throw new Error(`create connection failed: ${error?.message}`);
  return { id: data.id };
}

export async function updateConnection(
  supabase: SupabaseClient,
  args: {
    teamId: string;
    id: string;
    config?: Record<string, unknown>;
    enabled?: boolean;
    /** Provide to rotate the secret; omit (undefined) to leave it unchanged. */
    secret?: string;
  }
): Promise<void> {
  const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (args.config !== undefined) patch.config = args.config;
  if (args.enabled !== undefined) patch.enabled = args.enabled;
  if (args.secret !== undefined && args.secret !== "") {
    patch.secret_ciphertext = encryptSecret(args.secret);
  }
  const { error } = await supabase
    .from("connections")
    .update(patch)
    .eq("team_id", args.teamId)
    .eq("id", args.id);
  if (error) throw new Error(`update connection failed: ${error.message}`);
}

export async function deleteConnection(
  supabase: SupabaseClient,
  teamId: string,
  id: string
): Promise<void> {
  const { error } = await supabase
    .from("connections")
    .delete()
    .eq("team_id", teamId)
    .eq("id", id);
  if (error) throw new Error(`delete connection failed: ${error.message}`);
}

/**
 * The sidecar read path: enabled connections with DECRYPTED secrets. Only call from the
 * connector-key-authenticated endpoint (GET /api/v1/connections), never from a page.
 */
export async function getEnabledConnectionsWithSecrets(
  supabase: SupabaseClient,
  teamId: string
): Promise<ConnectionWithSecret[]> {
  const { data, error } = await supabase
    .from("connections")
    .select("source, name, config, enabled, secret_ciphertext")
    .eq("team_id", teamId)
    .eq("enabled", true);
  if (error) throw new Error(`load connections failed: ${error.message}`);
  return (data ?? []).map((r: Omit<Row, "id" | "created_at">) => ({
    source: r.source,
    name: r.name,
    config: r.config ?? {},
    enabled: r.enabled,
    secret: r.secret_ciphertext ? decryptSecret(r.secret_ciphertext) : null,
  }));
}
