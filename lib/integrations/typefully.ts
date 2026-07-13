import "server-only";
import type { DbClient } from "@/lib/db/types";
import { decryptSecret } from "@/lib/secrets/crypto";
import { setIntegrationSecret, upsertIntegration, type IntegrationAuth } from "./manage";

/**
 * Typefully publishing credential (Social Brain M5). Mirrors the OpenRouter connect flow: the API
 * key is stored ENCRYPTED in the integration's secret_ciphertext; the NON-secret social-set id
 * lives in config. Single-writer via `upsertIntegration`; the admin action is the gate. The key is
 * decrypted only in-process (`getTypefullyCredentials`, for the publish path) and never returned to
 * a browser — the UI only sees `connected`.
 */

interface TypefullyRow {
  name: string;
  status: "enabled" | "disabled";
  config: Record<string, unknown>;
  secret_ciphertext: string | null;
}

async function firstTypefullyRow(db: DbClient, teamId: string): Promise<TypefullyRow | null> {
  const { data } = await db
    .from("integrations")
    .select("name, status, config, secret_ciphertext")
    .eq("team_id", teamId)
    .eq("type", "typefully")
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();
  if (!data) return null;
  return {
    name: (data.name as string) ?? "typefully",
    status: ((data.status as string) ?? "enabled") as "enabled" | "disabled",
    config: (data.config as Record<string, unknown>) ?? {},
    secret_ciphertext: (data.secret_ciphertext as string | null) ?? null,
  };
}

/** Save the Typefully key (encrypted) and/or the social-set id. Only provided fields change. */
export async function saveTypefully(
  db: DbClient,
  auth: IntegrationAuth,
  input: { key?: string; socialSetId?: string }
): Promise<void> {
  const row = await firstTypefullyRow(db, auth.teamId);
  const config: Record<string, unknown> = { ...(row?.config ?? {}) };
  if (input.socialSetId !== undefined) config.socialSetId = input.socialSetId.trim() || undefined;
  const { id } = await upsertIntegration(db, auth, {
    type: "typefully",
    name: row?.name ?? "typefully",
    config,
    status: row?.status ?? "enabled",
  });
  if (input.key && input.key.trim()) {
    await setIntegrationSecret(db, auth, id, input.key.trim());
  }
}

export interface TypefullyCredentials {
  key: string;
  socialSetId: string | null;
}

/** Decrypted credentials for the publish path, or null if no key is set. In-process only. */
export async function getTypefullyCredentials(db: DbClient, teamId: string): Promise<TypefullyCredentials | null> {
  const row = await firstTypefullyRow(db, teamId);
  if (!row?.secret_ciphertext || row.status !== "enabled") return null;
  return {
    key: decryptSecret(row.secret_ciphertext),
    socialSetId: typeof row.config.socialSetId === "string" ? row.config.socialSetId : null,
  };
}

/** Non-secret status for the admin UI (never the key). */
export async function typefullyStatus(db: DbClient, teamId: string): Promise<{ connected: boolean; socialSetId: string | null }> {
  const row = await firstTypefullyRow(db, teamId);
  return {
    connected: !!row?.secret_ciphertext && row.status === "enabled",
    socialSetId: typeof row?.config.socialSetId === "string" ? row.config.socialSetId : null,
  };
}
