import type { DbClient } from "@/lib/db/types";
import { upsertIntegration, setIntegrationSecret, type IntegrationAuth } from "./manage";
import { OPENROUTER_BASE_URL } from "@/lib/query/llm-backend";

/**
 * OpenRouter provider connect flow for Admin → Integrations. Validation is separate from the ingest
 * path so the UI can verify a key without running a query. `fetchImpl` is injectable for tests.
 */

type Fetch = typeof fetch;

export interface OpenrouterValidation {
  ok: boolean;
  label?: string; // the key's label from OpenRouter, shown as confirmation
  error?: string;
}

/** Validate an OpenRouter key via GET /api/v1/key. Never throws. */
export async function validateOpenrouterKey(
  key: string,
  fetchImpl: Fetch = fetch
): Promise<OpenrouterValidation> {
  if (!key.trim()) return { ok: false, error: "key is empty" };
  try {
    const res = await fetchImpl(`${OPENROUTER_BASE_URL}/key`, {
      headers: { Authorization: `Bearer ${key.trim()}` },
    });
    if (res.status === 200) {
      const body = (await res.json().catch(() => ({}))) as { data?: { label?: string } };
      return { ok: true, label: body.data?.label };
    }
    if (res.status === 401) return { ok: false, error: "key invalid or expired (401)" };
    return { ok: false, error: `OpenRouter returned ${res.status}` };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "could not reach OpenRouter" };
  }
}

interface OpenrouterRow {
  name: string;
  status: "enabled" | "disabled";
  config: Record<string, unknown>;
}

async function firstOpenrouterRow(db: DbClient, teamId: string): Promise<OpenrouterRow | null> {
  const { data } = await db
    .from("integrations")
    .select("name, status, config")
    .eq("team_id", teamId)
    .eq("type", "openrouter")
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();
  if (!data) return null;
  return {
    name: data.name as string,
    status: (data.status as "enabled" | "disabled") ?? "enabled",
    config: ((data.config as Record<string, unknown>) ?? {}) as Record<string, unknown>,
  };
}

/**
 * Persist OpenRouter settings — the model (config) and/or the key (encrypted secret) — into the
 * team's canonical openrouter integration (created on first save). Only the fields provided are
 * changed: a model-only save preserves the stored key and vice versa. Single-writer via
 * `upsertIntegration`; caller (the admin action) is the gate.
 */
export async function saveOpenrouterSettings(
  db: DbClient,
  auth: IntegrationAuth,
  input: { key?: string; model?: string }
): Promise<void> {
  const row = await firstOpenrouterRow(db, auth.teamId);
  const config: Record<string, unknown> = { ...(row?.config ?? {}) };
  if (input.model !== undefined) config.model = input.model.trim() || undefined;
  const { id } = await upsertIntegration(db, auth, {
    type: "openrouter",
    name: row?.name ?? "openrouter",
    config,
    status: row?.status ?? "enabled",
  });
  if (input.key && input.key.trim()) {
    await setIntegrationSecret(db, auth, id, input.key.trim());
  }
}
