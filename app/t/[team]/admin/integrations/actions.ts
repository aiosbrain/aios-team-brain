"use server";

import { revalidatePath } from "next/cache";
import { adminClient } from "@/lib/db/admin";
import { requireTeamAdmin as requireAdmin } from "@/lib/auth/guard";
import {
  upsertIntegration,
  setIntegrationSecret,
  setIntegrationStatus,
  deleteIntegration,
  saveProviderModel as saveProviderModel_,
} from "@/lib/integrations/manage";
import type { AnsweringProvider } from "@/lib/query/llm-backend";
import { runSlackIngestion, runPlaneIngestion, runLinearIngestion, runGithubIngestion } from "@/lib/ingest/run";
import { runGraphProjection } from "@/lib/graph/run";
import {
  linkGithubRepo,
  unlinkGithubRepo,
  ensureGithubIntegration,
  githubReposAndToken,
} from "@/lib/integrations/github-link";
import { saveProvisioningSettings as saveProvisioningSettings_ } from "@/lib/provisioning/settings";
import { validateGithubToken, checkRepoAccess, type RepoAccess } from "@/lib/integrations/github-validate";
import { RepoFormatError } from "@/lib/integrations/github-repos";
import { validateOpenrouterKey, saveOpenrouterSettings } from "@/lib/integrations/openrouter";
import { IntegrationConfigError, type IntegrationType } from "@/lib/api/schemas";
import { buildConfig, toList } from "@/lib/integrations/build-config";
import { audit } from "@/lib/api/audit";

export type PrimaryPmProvider = "plane" | "linear" | null;

export async function saveIntegration(
  teamSlug: string,
  form: {
    type: IntegrationType;
    name: string;
    selection: string;
    secret: string;
    /** Linear only: per-team inbound-apply opt-in (Linear→brain). Default off. */
    inboundApply?: boolean;
  }
): Promise<{ ok: boolean; error?: string }> {
  const ctx = await requireAdmin(teamSlug);
  if (!ctx) return { ok: false, error: "admins only" };
  const name = form.name.trim();
  if (!name) return { ok: false, error: "name is required" };
  const auth = { teamId: ctx.teamId, memberId: ctx.memberId };
  try {
    const { id } = await upsertIntegration(adminClient(), auth, {
      type: form.type,
      name,
      config: buildConfig(form.type, form.selection, { inboundApply: form.inboundApply }),
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
    await setIntegrationStatus(adminClient(), { teamId: ctx.teamId, memberId: ctx.memberId }, id, status);
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
    await setIntegrationSecret(adminClient(), { teamId: ctx.teamId, memberId: ctx.memberId }, id, secret);
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
 * Link a GitHub repo to the brain (admins only). `repo` is `owner/name` or a github URL. Persists
 * to the team's canonical github integration's `config.repos` (creating the row on first link) via
 * the single-writer path. The native importer then pulls each repo's issues → tasks + files →
 * deliverables. Returns a clear message on a malformed repo rather than silently dropping it.
 */
export async function addGithubRepo(
  teamSlug: string,
  repo: string
): Promise<{ ok: boolean; error?: string }> {
  const ctx = await requireAdmin(teamSlug);
  if (!ctx) return { ok: false, error: "admins only" };
  try {
    await linkGithubRepo(adminClient(), { teamId: ctx.teamId, memberId: ctx.memberId }, repo);
  } catch (e) {
    if (e instanceof RepoFormatError || e instanceof IntegrationConfigError) {
      return { ok: false, error: e.message };
    }
    return { ok: false, error: e instanceof Error ? e.message : "could not link repo" };
  }
  revalidatePath(`/t/${teamSlug}/admin/integrations`);
  return { ok: true };
}

/** Unlink a GitHub repo from the brain (admins only). Case-insensitive; no-op if not linked. */
export async function removeGithubRepo(
  teamSlug: string,
  repo: string
): Promise<{ ok: boolean; error?: string }> {
  const ctx = await requireAdmin(teamSlug);
  if (!ctx) return { ok: false, error: "admins only" };
  try {
    await unlinkGithubRepo(adminClient(), { teamId: ctx.teamId, memberId: ctx.memberId }, repo);
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "could not unlink repo" };
  }
  revalidatePath(`/t/${teamSlug}/admin/integrations`);
  return { ok: true };
}

/**
 * Connect a GitHub token for private-repo access (admins only). Validates the PAT against GitHub
 * (`GET /user`) BEFORE storing, so a bad/expired token is rejected immediately instead of failing
 * silently at sync time. On success the token is stored encrypted on the team's github integration
 * (row created if needed) and the authenticated login is returned for a "Connected as @login" badge.
 */
export async function connectGithubToken(
  teamSlug: string,
  token: string
): Promise<{ ok: boolean; login?: string; error?: string }> {
  const ctx = await requireAdmin(teamSlug);
  if (!ctx) return { ok: false, error: "admins only" };
  const v = await validateGithubToken(token);
  if (!v.ok) return { ok: false, error: v.error ?? "token validation failed" };
  try {
    const auth = { teamId: ctx.teamId, memberId: ctx.memberId };
    const id = await ensureGithubIntegration(adminClient(), auth);
    await setIntegrationSecret(adminClient(), auth, id, token.trim());
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "could not save token" };
  }
  revalidatePath(`/t/${teamSlug}/admin/integrations`);
  return { ok: true, login: v.login };
}

/**
 * Probe each linked repo's accessibility with the team's stored token (admins only) — public /
 * private (reachable) / no_access (private-without-access or missing). Lets the panel show whether a
 * private repo will actually sync BEFORE running one. Read-only; the token never leaves the server.
 */
export async function checkGithubAccess(
  teamSlug: string
): Promise<{ ok: boolean; access?: RepoAccess[]; error?: string }> {
  const ctx = await requireAdmin(teamSlug);
  if (!ctx) return { ok: false, error: "admins only" };
  try {
    const { repos, token } = await githubReposAndToken(adminClient(), ctx.teamId);
    const access = await Promise.all(repos.map((r) => checkRepoAccess(r, token)));
    return { ok: true, access };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "access check failed" };
  }
}

/**
 * Save OpenRouter settings (admins only) — the model slug and/or the API key. When a key is given it
 * is VALIDATED against OpenRouter (`GET /api/v1/key`) before storing (encrypted), so a bad key is
 * rejected up front. Once set, the query LLM routes through OpenRouter (see selectLlmBackend). Only
 * the provided fields change — save a model without re-entering the key, or vice versa.
 */
export async function saveOpenrouter(
  teamSlug: string,
  input: { key?: string; model?: string }
): Promise<{ ok: boolean; label?: string; error?: string }> {
  const ctx = await requireAdmin(teamSlug);
  if (!ctx) return { ok: false, error: "admins only" };
  let label: string | undefined;
  if (input.key && input.key.trim()) {
    const v = await validateOpenrouterKey(input.key);
    if (!v.ok) return { ok: false, error: v.error ?? "key validation failed" };
    label = v.label;
  }
  try {
    await saveOpenrouterSettings(adminClient(), { teamId: ctx.teamId, memberId: ctx.memberId }, input);
  } catch (e) {
    if (e instanceof IntegrationConfigError) return { ok: false, error: e.message };
    return { ok: false, error: e instanceof Error ? e.message : "could not save OpenRouter settings" };
  }
  revalidatePath(`/t/${teamSlug}/admin/integrations`);
  return { ok: true, label };
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

/**
 * Save the Member-onboarding (provisioning) invite hints (admins only). Delegates the merge-and-write
 * to the single-writer lib helper; only the non-secret provisioning keys are touched.
 */
export async function saveProvisioningSettings(
  teamSlug: string,
  values: { linearTeamIds: string; linearRole: string; slackInviteLink: string; githubOrg: string }
): Promise<{ ok: boolean; error?: string }> {
  const ctx = await requireAdmin(teamSlug);
  if (!ctx) return { ok: false, error: "admins only" };
  try {
    await saveProvisioningSettings_(
      adminClient(),
      { teamId: ctx.teamId, memberId: ctx.memberId },
      {
        linearTeamIds: toList(values.linearTeamIds),
        linearRole: values.linearRole.trim(),
        slackInviteLink: values.slackInviteLink,
        githubOrg: values.githubOrg,
      }
    );
  } catch (e) {
    if (e instanceof IntegrationConfigError) return { ok: false, error: e.message };
    return { ok: false, error: e instanceof Error ? e.message : "could not save settings" };
  }
  revalidatePath(`/t/${teamSlug}/admin/integrations`);
  return { ok: true };
}

/**
 * Set (or clear, with an empty string) the answer model for a provider key (admins only). Stored as
 * the NON-secret `config.model` on the provider's integration row; the answer path reads it via
 * resolveAnsweringKeys. Independent of the key itself — change the model without re-entering the key.
 */
export async function saveProviderModel(
  teamSlug: string,
  provider: "anthropic" | "openai",
  model: string
): Promise<{ ok: boolean; error?: string }> {
  const ctx = await requireAdmin(teamSlug);
  if (!ctx) return { ok: false, error: "admins only" };
  if (provider !== "anthropic" && provider !== "openai") return { ok: false, error: "invalid provider" };
  try {
    await saveProviderModel_(adminClient(), { teamId: ctx.teamId, memberId: ctx.memberId }, provider, model);
  } catch (e) {
    if (e instanceof IntegrationConfigError) return { ok: false, error: e.message };
    return { ok: false, error: e instanceof Error ? e.message : "could not save model" };
  }
  revalidatePath(`/t/${teamSlug}/admin/integrations`);
  return { ok: true };
}

/**
 * Choose the explicit answering backend for the Query box (admins only; audited). Mirrors
 * setPrimaryPmProvider. Pass `null` to clear it → auto precedence (OpenRouter → LLM_BASE_URL →
 * Anthropic). The answer path reads `teams.answering_provider`; if the chosen backend isn't
 * configured, selectLlmBackend falls back to auto (surfaced in the admin indicator).
 */
export async function setAnsweringProvider(
  teamSlug: string,
  provider: AnsweringProvider | null
): Promise<{ ok: boolean; error?: string }> {
  const ctx = await requireAdmin(teamSlug);
  if (!ctx) return { ok: false, error: "admins only" };
  const allowed: (AnsweringProvider | null)[] = [null, "anthropic", "openai", "openrouter", "local"];
  if (!allowed.includes(provider)) return { ok: false, error: "invalid provider" };
  const db = adminClient();
  const { error } = await db.from("teams").update({ answering_provider: provider }).eq("id", ctx.teamId);
  if (error) return { ok: false, error: error.message };
  await audit(db, {
    team_id: ctx.teamId,
    actor_kind: "member",
    member_id: ctx.memberId,
    action: "team.answering_provider_set",
    target_type: "team",
    target_id: ctx.teamId,
    meta: { provider },
  });
  revalidatePath(`/t/${teamSlug}/admin/integrations`);
  return { ok: true };
}

/**
 * Set the answering role as a PROVIDER + MODEL pair (admins only; audited). Writes both in one action:
 * `teams.answering_provider` = provider, and the provider's `config.model` = model (cloud providers —
 * anthropic/openai/openrouter; `local`'s model is env-driven so its model box is ignored). This is the
 * unified control behind the Admin "Answering model" picker. If the chosen backend isn't configured,
 * selectLlmBackend falls back to auto (surfaced in the admin indicator).
 */
export async function setAnsweringModel(
  teamSlug: string,
  provider: AnsweringProvider,
  model: string
): Promise<{ ok: boolean; error?: string }> {
  const ctx = await requireAdmin(teamSlug);
  if (!ctx) return { ok: false, error: "admins only" };
  const allowed: AnsweringProvider[] = ["anthropic", "openai", "openrouter", "local"];
  if (!allowed.includes(provider)) return { ok: false, error: "invalid provider" };
  const db = adminClient();
  try {
    // Persist the model on the provider's integration (local's model comes from env, so skip it).
    if (provider !== "local") {
      await saveProviderModel_(db, { teamId: ctx.teamId, memberId: ctx.memberId }, provider, model);
    }
    const { error } = await db.from("teams").update({ answering_provider: provider }).eq("id", ctx.teamId);
    if (error) return { ok: false, error: error.message };
    await audit(db, {
      team_id: ctx.teamId,
      actor_kind: "member",
      member_id: ctx.memberId,
      action: "team.answering_provider_set",
      target_type: "team",
      target_id: ctx.teamId,
      meta: { provider, model: model.trim() || null },
    });
  } catch (e) {
    if (e instanceof IntegrationConfigError) return { ok: false, error: e.message };
    return { ok: false, error: e instanceof Error ? e.message : "could not save answering model" };
  }
  revalidatePath(`/t/${teamSlug}/admin/integrations`);
  return { ok: true };
}

/**
 * Set the reasoning role as a PROVIDER + MODEL pair (admins only; audited). Both live on `teams`:
 * `reasoning_model` + `reasoning_provider`. An empty model clears BOTH → reasoning-role tasks reuse
 * the query model. A null provider (with a model set) means "same provider as answering, different
 * model" (the pre-existing behavior); a set provider runs reasoning on its own backend.
 */
export async function setReasoningModel(
  teamSlug: string,
  provider: AnsweringProvider | null,
  model: string
): Promise<{ ok: boolean; error?: string }> {
  const ctx = await requireAdmin(teamSlug);
  if (!ctx) return { ok: false, error: "admins only" };
  const allowed: (AnsweringProvider | null)[] = [null, "anthropic", "openai", "openrouter", "local"];
  if (!allowed.includes(provider)) return { ok: false, error: "invalid provider" };
  const trimmed = model.trim().slice(0, 200);
  const reasoningModel = trimmed || null;
  // Clearing the model clears the provider too — no orphaned "reason on X" with no model to run.
  const reasoningProvider = reasoningModel ? provider : null;
  const db = adminClient();
  const { error } = await db
    .from("teams")
    .update({ reasoning_model: reasoningModel, reasoning_provider: reasoningProvider })
    .eq("id", ctx.teamId);
  if (error) return { ok: false, error: error.message };
  await audit(db, {
    team_id: ctx.teamId,
    actor_kind: "member",
    member_id: ctx.memberId,
    action: "team.reasoning_model_set",
    target_type: "team",
    target_id: ctx.teamId,
    meta: { provider: reasoningProvider, model: reasoningModel },
  });
  revalidatePath(`/t/${teamSlug}/admin/integrations`);
  return { ok: true };
}

export async function removeIntegration(
  teamSlug: string,
  id: string
): Promise<{ ok: boolean; error?: string }> {
  const ctx = await requireAdmin(teamSlug);
  if (!ctx) return { ok: false, error: "admins only" };
  try {
    await deleteIntegration(adminClient(), { teamId: ctx.teamId, memberId: ctx.memberId }, id);
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
    member_id: ctx.memberId,
    action: "team.primary_pm_provider_set",
    target_type: "team",
    target_id: ctx.teamId,
    meta: { provider },
  });
  revalidatePath(`/t/${teamSlug}/admin/integrations`);
  return { ok: true };
}
