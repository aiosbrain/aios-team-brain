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
import { runSlackIngestion, runPlaneIngestion, runLinearIngestion, runGithubIngestion } from "@/lib/ingest/run";
import { runGraphProjection } from "@/lib/graph/run";
import { resolveIntegrationsAdmin } from "@/lib/integrations/read";
import { IntegrationConfigError, type IntegrationType } from "@/lib/api/schemas";
import { audit } from "@/lib/api/audit";

export type PrimaryPmProvider = "plane" | "linear" | null;

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

function toKeyValues(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of toList(raw)) {
    const m = part.match(/^([A-Za-z][A-Za-z0-9_-]*)\s*=\s*(.+)$/);
    if (m) out[m[1]] = m[2].trim();
  }
  return out;
}

/** Map a single "selection" field to the per-type NON-SECRET config shape (validated downstream). */
function buildConfig(type: IntegrationType, selection: string): Record<string, unknown> {
  const list = toList(selection);
  const kv = toKeyValues(selection);
  switch (type) {
    case "slack": return { channelIds: list };
    case "github": return { repos: list };
    case "granola": return { matchKeywords: list };
    case "wise": return list[0] ? { profileId: list[0] } : {};
    case "linear":
      return Object.keys(kv).length
        ? { teamId: kv.teamId, projectId: kv.projectId, doneStateName: kv.doneStateName }
        : list[0] ? { projectId: list[0] } : {};
    case "plane":
      return Object.keys(kv).length
        ? {
            baseUrl: kv.baseUrl,
            workspaceSlug: kv.workspaceSlug,
            projectId: kv.projectId,
            doneStateName: kv.doneStateName,
            externalSource: kv.externalSource,
          }
        : list[0] ? { projectId: list[0] } : {};
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

/**
 * Run Plane ingestion now for this team (admins only). Imports the configured project's work-items
 * into the brain (one dedicated task project per Plane project) and reports a one-line summary. The
 * scheduler also runs this on its interval; this is the on-demand trigger.
 */
export async function syncPlaneNow(
  teamSlug: string
): Promise<{ ok: boolean; error?: string; message?: string }> {
  const ctx = await requireAdmin(teamSlug);
  if (!ctx) return { ok: false, error: "admins only" };
  try {
    const s = await runPlaneIngestion({ teamId: ctx.teamId });
    if (!s.ok && s.errors.length) return { ok: false, error: s.errors.join("; ") };
    revalidatePath(`/t/${teamSlug}/admin/integrations`);
    return {
      ok: true,
      message: `Imported ${s.items} work-item(s) from ${s.projects} project(s): +${s.created} new, ~${s.updated} updated, =${s.unchanged} unchanged.`,
    };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "sync failed" };
  }
}

/** Run Linear ingestion now for this team (admins only). Imports the configured team's issues. */
export async function syncLinearNow(
  teamSlug: string
): Promise<{ ok: boolean; error?: string; message?: string }> {
  const ctx = await requireAdmin(teamSlug);
  if (!ctx) return { ok: false, error: "admins only" };
  try {
    const s = await runLinearIngestion({ teamId: ctx.teamId });
    if (!s.ok && s.errors.length) return { ok: false, error: s.errors.join("; ") };
    revalidatePath(`/t/${teamSlug}/admin/integrations`);
    return {
      ok: true,
      message: `Imported ${s.items} issue(s) from ${s.projects} team(s): +${s.created} new, ~${s.updated} updated, =${s.unchanged} unchanged.`,
    };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "sync failed" };
  }
}

/** Run GitHub Issues ingestion now for this team (admins only). Imports each configured repo's issues. */
export async function syncGithubNow(
  teamSlug: string
): Promise<{ ok: boolean; error?: string; message?: string }> {
  const ctx = await requireAdmin(teamSlug);
  if (!ctx) return { ok: false, error: "admins only" };
  try {
    const s = await runGithubIngestion({ teamId: ctx.teamId });
    if (!s.ok && s.errors.length) return { ok: false, error: s.errors.join("; ") };
    revalidatePath(`/t/${teamSlug}/admin/integrations`);
    return {
      ok: true,
      message: `Imported ${s.items} issue(s) from ${s.projects} repo(s): +${s.created} new, ~${s.updated} updated, =${s.unchanged} unchanged.`,
    };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "sync failed" };
  }
}

/**
 * Project this team's brain content (Phase 1: Slack transcripts) into the Graphiti graph memory now
 * (admins only). The scheduler also runs this on its interval; this is the on-demand trigger. Inert
 * (reports "not configured") when GRAPHITI_URL is unset, so it's safe to expose even where the graph
 * is off. Idempotent — re-running re-pushes only changed content.
 */
export async function projectToGraphNow(
  teamSlug: string
): Promise<{ ok: boolean; error?: string; message?: string }> {
  const ctx = await requireAdmin(teamSlug);
  if (!ctx) return { ok: false, error: "admins only" };
  try {
    const s = await runGraphProjection({ teamId: ctx.teamId });
    if (!s.configured) {
      return { ok: false, error: "Graph memory is not configured (set GRAPHITI_URL on the brain)." };
    }
    if (!s.ok && s.errors.length) return { ok: false, error: s.errors.join("; ") };
    revalidatePath(`/t/${teamSlug}/admin/integrations`);
    return {
      ok: true,
      message: `Projected ${s.projected} item(s) to the graph (=${s.skipped} unchanged, ${s.scanned} scanned).`,
    };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "projection failed" };
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

/**
 * Choose the single PM tool the brain projects tasks into (brain-api v1.2). Admins only; audited.
 * Pass `null` to clear it. The projection engine reads `teams.primary_pm_provider`; with it unset it
 * no-ops (or falls back to the sole enabled PM integration).
 */
export async function setPrimaryPmProvider(
  teamSlug: string,
  provider: PrimaryPmProvider
): Promise<{ ok: boolean; error?: string }> {
  const ctx = await requireAdmin(teamSlug);
  if (!ctx) return { ok: false, error: "admins only" };
  if (provider !== null && provider !== "plane" && provider !== "linear") {
    return { ok: false, error: "invalid provider" };
  }
  const db = adminClient();
  const { error } = await db
    .from("teams")
    .update({ primary_pm_provider: provider })
    .eq("id", ctx.teamId);
  if (error) return { ok: false, error: error.message };
  await audit(db, {
    team_id: ctx.teamId,
    actor_kind: "member",
    member_id: ctx.myMemberId,
    action: "team.primary_pm_provider_set",
    target_type: "team",
    target_id: ctx.teamId,
    meta: { provider },
  });
  revalidatePath(`/t/${teamSlug}/admin/integrations`);
  return { ok: true };
}
