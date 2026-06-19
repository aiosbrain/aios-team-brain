"use server";

import { revalidatePath } from "next/cache";
import { serverClient } from "@/lib/supabase/server";
import { adminClient } from "@/lib/supabase/admin";
import { getSessionUser } from "@/lib/auth/session";
import {
  upsertIntegration,
  setIntegrationSecret,
  setIntegrationStatus,
  deleteIntegration,
} from "@/lib/integrations/manage";
import { runSlackIngestion } from "@/lib/ingest/run";
import { resolveIntegrationsAdmin } from "@/lib/integrations/read";
import { IntegrationConfigError, type IntegrationType } from "@/lib/api/schemas";

/**
 * Session half of the admin gate: resolve the signed-in user, then delegate to the DB-level
 * `resolveIntegrationsAdmin` (same role==="admin" + active-member check as the /admin layout).
 * Returns null on any non-admin/unknown/wrong-team caller → every write action rejects.
 */
async function requireAdmin(teamSlug: string) {
  const supabase = await serverClient();
  const user = await getSessionUser();
  if (!user) return null;
  const ctx = await resolveIntegrationsAdmin(supabase, teamSlug, user.id);
  if (!ctx) return null;
  return { teamId: ctx.teamId, myMemberId: ctx.memberId };
}

function toList(raw: string): string[] {
  return raw.split(/[\n,]/).map((s) => s.trim()).filter(Boolean);
}

/** Map a single "selection" field to the per-type NON-SECRET config shape (validated downstream). */
function buildConfig(type: IntegrationType, selection: string): Record<string, unknown> {
  const list = toList(selection);
  switch (type) {
    case "slack": return { channelIds: list };
    case "github": return { repos: list };
    case "granola": return { matchKeywords: list };
    case "wise": return list[0] ? { profileId: list[0] } : {};
    case "linear": return list[0] ? { projectId: list[0] } : {};
    case "plane": return list[0] ? { projectId: list[0] } : {};
    default: return {};
  }
}

export async function saveIntegration(
  teamSlug: string,
  form: { type: IntegrationType; name: string; selection: string; secret: string }
): Promise<{ ok: boolean; error?: string }> {
  const ctx = await requireAdmin(teamSlug);
  if (!ctx) return { ok: false, error: "admins only" };
  const name = form.name.trim();
  if (!name) return { ok: false, error: "name is required" };
  const auth = { teamId: ctx.teamId, memberId: ctx.myMemberId };
  try {
    const { id } = await upsertIntegration(adminClient(), auth, {
      type: form.type,
      name,
      config: buildConfig(form.type, form.selection),
      status: "enabled",
    });
    if (form.secret) await setIntegrationSecret(adminClient(), auth, id, form.secret);
  } catch (e) {
    if (e instanceof IntegrationConfigError) return { ok: false, error: e.message };
    return { ok: false, error: e instanceof Error ? e.message : "could not save integration" };
  }
  revalidatePath(`/t/${teamSlug}/admin/integrations`);
  return { ok: true };
}

export async function toggleIntegration(
  teamSlug: string,
  id: string,
  status: "enabled" | "disabled"
): Promise<{ ok: boolean; error?: string }> {
  const ctx = await requireAdmin(teamSlug);
  if (!ctx) return { ok: false, error: "admins only" };
  try {
    await setIntegrationStatus(adminClient(), { teamId: ctx.teamId, memberId: ctx.myMemberId }, id, status);
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "could not update" };
  }
  revalidatePath(`/t/${teamSlug}/admin/integrations`);
  return { ok: true };
}

export async function rotateSecret(
  teamSlug: string,
  id: string,
  secret: string
): Promise<{ ok: boolean; error?: string }> {
  const ctx = await requireAdmin(teamSlug);
  if (!ctx) return { ok: false, error: "admins only" };
  if (!secret) return { ok: false, error: "secret is required" };
  try {
    await setIntegrationSecret(adminClient(), { teamId: ctx.teamId, memberId: ctx.myMemberId }, id, secret);
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "could not rotate" };
  }
  revalidatePath(`/t/${teamSlug}/admin/integrations`);
  return { ok: true };
}

/**
 * Run Slack ingestion now for this team (admins only). Pulls the configured
 * channels through the in-app runner and reports a one-line summary. The
 * scheduler also runs this on its interval; this is the on-demand trigger.
 */
export async function syncSlackNow(
  teamSlug: string
): Promise<{ ok: boolean; error?: string; message?: string }> {
  const ctx = await requireAdmin(teamSlug);
  if (!ctx) return { ok: false, error: "admins only" };
  try {
    const s = await runSlackIngestion({ teamId: ctx.teamId });
    if (!s.ok && s.errors.length) return { ok: false, error: s.errors.join("; ") };
    revalidatePath(`/t/${teamSlug}/admin/integrations`);
    return {
      ok: true,
      message: `Synced ${s.channels} channel(s): +${s.created} new, ~${s.updated} updated, =${s.unchanged} unchanged.`,
    };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "sync failed" };
  }
}

export async function removeIntegration(
  teamSlug: string,
  id: string
): Promise<{ ok: boolean; error?: string }> {
  const ctx = await requireAdmin(teamSlug);
  if (!ctx) return { ok: false, error: "admins only" };
  try {
    await deleteIntegration(adminClient(), { teamId: ctx.teamId, memberId: ctx.myMemberId }, id);
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "could not delete" };
  }
  revalidatePath(`/t/${teamSlug}/admin/integrations`);
  return { ok: true };
}
