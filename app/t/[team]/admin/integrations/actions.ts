"use server";

import { revalidatePath } from "next/cache";
import { adminClient } from "@/lib/db/admin";
import { requireTeamAdmin as requireAdmin } from "@/lib/auth/guard";
import {
  upsertIntegration,
  setIntegrationSecret,
  setIntegrationStatus,
  removeIntegrationById,
  getEnabledIntegrationsWithSecrets,
  getIntegrationWithSecret,
  getIntegrationWithSecretById,
  saveProviderModel as saveProviderModel_,
} from "@/lib/integrations/manage";
import { selectLlmBackend, type AnsweringProvider } from "@/lib/query/llm-backend";
import { resolveAnsweringKeys } from "@/lib/query/answering";
import { runSlackIngestion, runPlaneIngestion, runLinearIngestion, runGithubIngestion } from "@/lib/ingest/run";
import {
  adminSyncResult,
  runManualContextPass,
  type ManualContextEntrypoint,
} from "@/lib/ingest/manual-context";
import { INGEST_DISABLED_MESSAGE, manualIngestionVerdict } from "@/lib/staging/ingest-policy";
import { runGraphProjection } from "@/lib/graph/run";
import { readStagingRuntimeState } from "@/lib/staging/runtime-policy";
import { projectionRunInput, shouldRecordProjectionRun } from "@/lib/graph/projection-run";
import { recordIngestRun } from "@/lib/ingest/runs";
import {
  linkGithubRepo,
  unlinkGithubRepo,
  ensureGithubIntegration,
  githubReposAndToken,
  countPreviouslyImportedTasks,
} from "@/lib/integrations/github-link";
import { saveProvisioningSettings as saveProvisioningSettings_ } from "@/lib/provisioning/settings";
import { validateGithubToken, checkRepoAccess, type RepoAccess } from "@/lib/integrations/github-validate";
import { checkSlackChannels, privateChannelRejection } from "@/lib/integrations/slack-validate";
import { RepoFormatError, normalizeRepo } from "@/lib/integrations/github-repos";
import { estimateGithubImport, type GithubImportEstimate } from "@/lib/integrations/github-estimate";
import { getGraphEfficiency } from "@/lib/metrics/graph-efficiency";
import { validateOpenrouterKey, saveOpenrouterSettings } from "@/lib/integrations/openrouter";
import { MEETING_TASK_STATUSES, type MeetingTaskStatus } from "@/lib/meetings/target-status";
import {
  checkStructuredOutputSupport,
  structuredOutputWarning,
} from "@/lib/llm/structured-output-support";
import { setMeetingTaskStatus as setMeetingTaskStatusDb } from "@/lib/meetings/target-status-db";
import {
  IntegrationConfigError,
  type IntegrationType,
  EMBEDDING_PROVIDER_TYPES,
  isCuratedEmbeddingModel,
  canonicalEmbeddingModel,
  type EmbeddingProvider,
} from "@/lib/api/schemas";
import { buildConfig, toList } from "@/lib/integrations/build-config";
import { audit } from "@/lib/api/audit";
import {
  acquireGdriveAdminTestAuthority,
  authorizeGdriveAdminTestCall,
  provisionGdriveConnectorPrincipal,
  publishGdriveVerifiedSelection,
  publishGdriveVerifiedConfig,
  validateGdriveAudienceProjects,
  type GdriveAdminTestAuthority,
} from "@/lib/integrations/gdrive-authority";

export type PrimaryPmProvider = "plane" | "linear" | null;

async function verifyGdriveTargets(
  authority: GdriveAdminTestAuthority,
  targets: Array<{ kind: "file" | "folder" | "drive"; id: string }>,
): Promise<{ denied: number }> {
  await authorizeGdriveAdminTestCall(authority);
  const tokenResponse = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: authority.credential.clientId, client_secret: authority.credential.clientSecret,
      refresh_token: authority.credential.refreshToken, grant_type: "refresh_token",
    }),
    cache: "no-store", signal: AbortSignal.timeout(15_000),
  });
  const token = await tokenResponse.json().catch(() => ({})) as Record<string, unknown>;
  await authorizeGdriveAdminTestCall(authority);
  if (!tokenResponse.ok || typeof token.access_token !== "string") {
    throw new Error("Google authorization is unavailable; reconnect this account");
  }
  let denied = 0;
  for (const target of targets) {
    await authorizeGdriveAdminTestCall(authority);
    const path = target.kind === "drive"
      ? `https://www.googleapis.com/drive/v3/drives/${encodeURIComponent(target.id)}?fields=id,name`
      : `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(target.id)}?supportsAllDrives=true&fields=id,mimeType,trashed`;
    const response = await fetch(path, {
      headers: { Authorization: `Bearer ${token.access_token}` }, cache: "no-store",
      signal: AbortSignal.timeout(10_000),
    });
    const metadata = response.ok
      ? await response.json().catch(() => ({})) as { id?: string; mimeType?: string; trashed?: boolean }
      : {};
    const expectedMime = target.kind === "file"
      ? "application/vnd.google-apps.document"
      : target.kind === "folder" ? "application/vnd.google-apps.folder" : undefined;
    if (!response.ok || metadata.id !== target.id || metadata.trashed
        || (expectedMime && metadata.mimeType !== expectedMime)) denied += 1;
  }
  await authorizeGdriveAdminTestCall(authority);
  return { denied };
}

/** Explicit, Admin-authorized one-time provisioning/rotation for the remote Drive sidecar key. */
export async function provisionGoogleDriveConnector(
  teamSlug: string,
  integrationId: string,
): Promise<{ ok: boolean; key?: string; rotated?: boolean; error?: string }> {
  const ctx = await requireAdmin(teamSlug);
  if (!ctx) return { ok: false, error: "admins only" };
  try {
    const result = await provisionGdriveConnectorPrincipal({
      teamId: ctx.teamId, integrationId, actorMemberId: ctx.memberId,
    });
    revalidatePath(`/t/${teamSlug}/admin/integrations`);
    return { ok: true, key: result.key, rotated: result.rotated };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "could not provision connector" };
  }
}

/** Queue a durable manual/retry request. The sidecar consumes it through the same connection-bound
 * coordinator as scheduled/watch work, so clicking twice or racing the scheduler never creates a
 * second writer. */
export async function runGoogleDriveNow(
  teamSlug: string,
  integrationId: string,
  trigger: "manual" | "retry" = "manual",
): Promise<{ ok: boolean; error?: string; message?: string }> {
  const ctx = await requireAdmin(teamSlug);
  if (!ctx) return { ok: false, error: "admins only" };
  const db = adminClient();
  const integration = await getIntegrationWithSecretById(db, ctx.teamId, integrationId);
  if (!integration || integration.type !== "gdrive") return { ok: false, error: "Google Drive connection was not found" };
  if (integration.status !== "enabled") {
    return { ok: false, error: "Resume Google Drive before running it" };
  }
  if (String(integration.config.authMode ?? "oauth") === "oauth" && !integration.secret) {
    return { ok: false, error: "Reconnect Google Drive before running it" };
  }
  const { error } = await db.from("gdrive_run_requests").insert({
    team_id: ctx.teamId, integration_id: integrationId, requested_by: ctx.memberId,
    trigger, status: "pending",
  });
  if (error && !String(error.message).includes("gdrive_run_requests_one_active_idx")) {
    return { ok: false, error: "Google Drive run could not be queued" };
  }
  await audit(db, {
    team_id: ctx.teamId, actor_kind: "member", member_id: ctx.memberId,
    action: trigger === "retry" ? "gdrive.run_retried" : "gdrive.run_requested",
    target_type: "integration", target_id: integrationId, meta: {},
  });
  revalidatePath(`/t/${teamSlug}/admin/integrations`);
  return { ok: true, message: error ? "A Google Drive run is already queued or running." : "Google Drive run queued." };
}

/**
 * The admin-facing error when a Slack save names a private channel, or null to let it through.
 *
 * Token resolution mirrors the ingester's (`runSlackIngestion`): the secret being submitted, else the
 * one already stored for this integration, else `SLACK_BOT_TOKEN`. With no token we cannot ask Slack,
 * so the save proceeds — the ingester fails closed on every channel it can't PROVE is public, which
 * is where the rule is actually enforced. Never throws: a Slack outage must not block admin work.
 */
async function rejectPrivateSlackChannels(
  teamId: string,
  name: string,
  submittedSecret: string,
  config: Record<string, unknown>
): Promise<string | null> {
  const channelIds = (config.channelIds as string[] | undefined) ?? [];
  if (channelIds.length === 0) return null;
  try {
    let token = submittedSecret.trim();
    if (!token) {
      const existing = await getEnabledIntegrationsWithSecrets(adminClient(), teamId);
      token = existing.find((i) => i.type === "slack" && i.name === name)?.secret ?? "";
    }
    if (!token) token = process.env.SLACK_BOT_TOKEN ?? "";
    if (!token) return null;
    return privateChannelRejection(await checkSlackChannels(token, channelIds));
  } catch {
    return null; // couldn't verify → not evidence of privacy; the ingester still fails closed
  }
}

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
    let config = buildConfig(form.type, form.selection, { inboundApply: form.inboundApply });
    if (form.type === "gdrive") {
      const existing = await getIntegrationWithSecret(adminClient(), ctx.teamId, "gdrive", name);
      // Selection saves must not erase OAuth account/scope diagnostics or change credential mode.
      config = {
        ...config,
        ...(existing?.config.authenticatedAccount
          ? { authenticatedAccount: existing.config.authenticatedAccount }
          : {}),
        ...(existing?.config.authenticatedAccountId
          ? { authenticatedAccountId: existing.config.authenticatedAccountId }
          : {}),
        ...(existing?.config.scopeSet ? { scopeSet: existing.config.scopeSet } : {}),
        authMode: config.authMode ?? existing?.config.authMode ?? "oauth",
      };
      const authMode = String(config.authMode ?? "oauth");
      if (authMode === "service_account") {
        delete config.authenticatedAccount;
        delete config.authenticatedAccountId;
        delete config.scopeSet;
        config = {
          ...config,
          serviceAccountStatus:
            existing?.config.authMode === "service_account"
              ? (existing.config.serviceAccountStatus ?? "pending")
              : "pending",
          ...(existing?.config.serviceAccountIdentity
            ? { serviceAccountIdentity: existing.config.serviceAccountIdentity }
            : {}),
        };
      }
      const audience = Array.isArray(config.audienceProjectIds)
        ? [...new Set(config.audienceProjectIds.filter((id): id is string => typeof id === "string"))]
        : [];
      if (audience.length === 0) {
        return { ok: false, error: "Google Drive requires at least one approved audience project" };
      }
      if (!await validateGdriveAudienceProjects(ctx.teamId, audience)) {
        return { ok: false, error: "Every Google Drive audience must be an existing project with an access grant" };
      }
      const roots = [
        ...((config.fileIds as string[] | undefined) ?? []).map((id) => ({ kind: "file" as const, id })),
        ...((config.folderIds as string[] | undefined) ?? []).map((id) => ({ kind: "folder" as const, id })),
        ...((config.sharedDriveIds as string[] | undefined) ?? []).map((id) => ({ kind: "drive" as const, id })),
      ];
      const oldRoots = new Set([
        ...((existing?.config.fileIds as string[] | undefined) ?? []).map((id) => `file:${id}`),
        ...((existing?.config.folderIds as string[] | undefined) ?? []).map((id) => `folder:${id}`),
        ...((existing?.config.sharedDriveIds as string[] | undefined) ?? []).map((id) => `drive:${id}`),
      ]);
      const added = roots.filter((root) => !oldRoots.has(`${root.kind}:${root.id}`));
      const rootSelectionChanged = roots.length !== oldRoots.size || added.length > 0;
      if (authMode === "service_account"
          && (rootSelectionChanged || existing?.config.authMode !== "service_account")) {
        config.serviceAccountStatus = "pending";
        delete config.serviceAccountIdentity;
      }
      if (added.length > 0) {
        if (authMode === "service_account") {
          // Local credentials are deliberately not uploaded. Their first fenced provider read
          // verifies these roots and publishes a non-secret account identity.
        } else if (!existing || existing.config.authMode !== "oauth") {
          return { ok: false, error: "Connect Google Drive before saving manual root IDs" };
        } else {
          const authority = await acquireGdriveAdminTestAuthority({
            teamId: ctx.teamId, memberId: ctx.memberId, integrationName: name,
          });
          const proof = await verifyGdriveTargets(authority, added);
          if (proof.denied > 0) {
            return { ok: false, error: `${proof.denied} pasted root ID(s) are not accessible to this Google connection; the saved selection was unchanged` };
          }
          await publishGdriveVerifiedConfig(authority, config, "gdrive.selection_manual_verified");
          revalidatePath(`/t/${teamSlug}/admin/integrations`);
          return { ok: true };
        }
      }
    }
    // Only channels PUBLIC to the workspace may be ingested — refuse the save rather than accept a
    // private channel the ingester will silently skip forever (see `slack-validate`).
    if (form.type === "slack") {
      const rejection = await rejectPrivateSlackChannels(ctx.teamId, name, form.secret, config);
      if (rejection) return { ok: false, error: rejection };
    }
    const { id } = await upsertIntegration(adminClient(), auth, {
      type: form.type,
      name,
      config,
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
 * The shared body of the four "Run now" actions (AUDITFIX-14).
 *
 * Import → ONE bounded project-context pass → revalidate, in that order, on EVERY authorized attempt.
 *
 *   • The context pass runs even when the import returned errors, threw, was skipped or reported zero
 *     changes: a thrown run is not proof that nothing was committed, and an older candidate backlog is
 *     invisible in the returned counts. With `INGEST_POLL_ENABLED=false` nothing else will partition
 *     that content, so it would be readable by nobody indefinitely.
 *   • The revalidation now happens after the context stage for all four. Slack already revalidated
 *     before its error return, because a confirmed-private channel reports an error AND PURGES its
 *     items — that property is preserved and the other three gain it.
 *   • `ok`/`error` composition lives in `adminSyncResult`, next to the reason pending work must not be
 *     returned as `{ok:true, message}`.
 *
 * Authorization is the CALLER's job and happens before this is reached: an unauthorized action must
 * invoke neither the importer nor the reconciliation, and must not revalidate.
 *
 * AC-07: a copied staging deployment refuses the whole thing here — after that authorization and
 * before the import, so the "run the context pass even when the import failed" rule above never
 * fires on a leg that failed BECAUSE the deployment is disabled. Nothing is imported, reconciled or
 * revalidated, and the admin is told which of the two it is.
 */
async function runNowThenReconcile<S extends { ok: boolean; errors: string[]; skipped?: boolean }>(
  teamId: string,
  teamSlug: string,
  entrypoint: ManualContextEntrypoint,
  run: () => Promise<S>,
  describe: (s: S) => string
): Promise<{ ok: boolean; error?: string; message?: string }> {
  const gate = await manualIngestionVerdict();
  if (!gate.allowed) return { ok: false, error: gate.message ?? INGEST_DISABLED_MESSAGE };
  let importOk = true;
  let importError: string | null = null;
  let importMessage: string | null = null;
  try {
    const s = await run();
    if (s.skipped) {
      // Single-flight refused the import. NEVER report this as a successful one.
      importOk = false;
      importError = "Import skipped — another sync is already running; try again in a moment.";
    } else if (!s.ok && s.errors.length) {
      importOk = false;
      importError = s.errors.join("; ");
    } else {
      importMessage = describe(s);
    }
  } catch (e) {
    importOk = false;
    importError = e instanceof Error ? e.message : "sync failed";
  }
  const context = await runManualContextPass(teamId, entrypoint);
  revalidatePath(`/t/${teamSlug}/admin/integrations`);
  return adminSyncResult({ importOk, importError, importMessage, context });
}

/**
 * Run Slack ingestion now for this team (admins only). Pulls the configured
 * channels through the in-app runner and reports a one-line summary. The
 * scheduler also runs this on its interval; this is the on-demand trigger.
 *
 * NOTE: `s.ok` is `errors.length === 0`, so a private/unverifiable channel among otherwise healthy
 * ones makes the whole run report as failed, with the per-channel lines as the error text. That is
 * the intended loudness — a configured channel the brain refuses to ingest is a configuration error
 * the admin has to resolve, not a notice to file away — and it's why the messages from
 * `privateChannelAction` say what to do, not just what happened.
 */
export async function syncSlackNow(
  teamSlug: string
): Promise<{ ok: boolean; error?: string; message?: string }> {
  const ctx = await requireAdmin(teamSlug);
  if (!ctx) return { ok: false, error: "admins only" };
  return runNowThenReconcile(
    ctx.teamId,
    teamSlug,
    "slack",
    () => runSlackIngestion({ teamId: ctx.teamId }),
    (s) => `Synced ${s.channels} channel(s): +${s.created} new, ~${s.updated} updated, =${s.unchanged} unchanged.`
  );
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
  return runNowThenReconcile(
    ctx.teamId,
    teamSlug,
    "plane",
    () => runPlaneIngestion({ teamId: ctx.teamId }),
    (s) =>
      `Imported ${s.items} work-item(s) from ${s.projects} project(s): +${s.created} new, ~${s.updated} updated, =${s.unchanged} unchanged.`
  );
}

/** Run Linear ingestion now for this team (admins only). Imports the configured team's issues. */
export async function syncLinearNow(
  teamSlug: string
): Promise<{ ok: boolean; error?: string; message?: string }> {
  const ctx = await requireAdmin(teamSlug);
  if (!ctx) return { ok: false, error: "admins only" };
  return runNowThenReconcile(
    ctx.teamId,
    teamSlug,
    "linear",
    () => runLinearIngestion({ teamId: ctx.teamId }),
    (s) =>
      `Imported ${s.items} issue(s) from ${s.projects} team(s): +${s.created} new, ~${s.updated} updated, =${s.unchanged} unchanged.`
  );
}

/** Run GitHub Issues ingestion now for this team (admins only). Imports each configured repo's issues. */
export async function syncGithubNow(
  teamSlug: string
): Promise<{ ok: boolean; error?: string; message?: string }> {
  const ctx = await requireAdmin(teamSlug);
  if (!ctx) return { ok: false, error: "admins only" };
  return runNowThenReconcile(
    ctx.teamId,
    teamSlug,
    "github",
    // TICKFIT-1 D2f: the admin "Run now" button promises a REAL pass — bypass the watermark.
    () => runGithubIngestion({ teamId: ctx.teamId, force: true }),
    (s) =>
      `Imported ${s.items} issue(s) from ${s.projects} repo(s): +${s.created} new, ~${s.updated} updated, =${s.unchanged} unchanged.`
  );
}

/**
 * Link a GitHub repo to the brain (admins only). `repo` is `owner/name` or a github URL. Persists
 * to the team's canonical github integration's `config.repos` (creating the row on first link) via
 * the single-writer path. The native importer then pulls each repo's issues → tasks + files →
 * deliverables. Returns a clear message on a malformed repo rather than silently dropping it.
 */
export async function addGithubRepo(
  teamSlug: string,
  repo: string,
  /** History window chosen in the estimate step (AIO-798). Omitted = pre-window behaviour. */
  historyDays?: number
): Promise<{ ok: boolean; error?: string }> {
  const ctx = await requireAdmin(teamSlug);
  if (!ctx) return { ok: false, error: "admins only" };
  if (historyDays !== undefined && (!Number.isInteger(historyDays) || historyDays < 0 || historyDays > 3650)) {
    return { ok: false, error: "invalid history window" };
  }
  try {
    await linkGithubRepo(adminClient(), { teamId: ctx.teamId, memberId: ctx.memberId }, repo, historyDays);
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
 * Pre-link import estimate for a GitHub repo (AIO-798, admins only — it reads the stored PAT).
 * Runs BEFORE anything is fetched into the brain: ~3 GitHub metadata calls sized against the
 * projector's own chunk math, priced by the Costs page's own reader (`getGraphEfficiency`), so the
 * estimate and the dashboard cannot disagree. Re-links are warned: unlink never purges items, so a
 * narrower window's first fetch would diff-delete previously imported tasks.
 */
export async function estimateGithubImportAction(
  teamSlug: string,
  repoInput: string,
  historyDays: number
): Promise<{
  ok: boolean;
  error?: string;
  estimate?: GithubImportEstimate;
  /** episodes x this install's measured cost/episode; null = no local price history OR the metric
   *  fetch was truncated — episodes shown, dollars withheld, never fabricated. */
  priceUsd?: number | null;
  unreachable?: boolean;
  /** Tasks already imported for this repo (a re-link) — a narrower window diff-deletes them. */
  previouslyImportedTasks?: number;
}> {
  const ctx = await requireAdmin(teamSlug);
  if (!ctx) return { ok: false, error: "admins only" };
  if (!Number.isInteger(historyDays) || historyDays < 0 || historyDays > 3650) {
    return { ok: false, error: "invalid history window" };
  }
  let full: string;
  try {
    full = normalizeRepo(repoInput);
  } catch (e) {
    return { ok: false, error: e instanceof RepoFormatError ? e.message : "malformed repo" };
  }
  const db = adminClient();
  try {
    // fileGlobs too: an estimate against the default globs while the importer honours custom ones
    // would size the wrong file set (review finding — the call site nothing pins, again).
    const { token, fileGlobs } = await githubReposAndToken(db, ctx.teamId);
    const [owner, repo] = full.split("/", 2);
    const result = await estimateGithubImport({ owner, repo, token, historyDays, fileGlobs });
    if (!result.ok) {
      return result.reason === "unreachable"
        ? { ok: true, unreachable: true }
        : { ok: false, error: result.detail };
    }
    // Price from the cost dashboard's own reader; null or truncated -> withhold, never fabricate.
    const efficiency = await getGraphEfficiency(db, ctx.teamId, "30d", {
      isAdmin: true,
      memberId: ctx.memberId,
    });
    const priceUsd =
      efficiency.costPerEpisode !== null && !efficiency.truncated
        ? result.episodes * efficiency.costPerEpisode
        : null;
    // Re-link warning: tasks already materialized from this repo's issues project.
    const prior = await countPreviouslyImportedTasks(ctx.teamId, owner, repo);
    const { ok: _resultOk, ...estimate } = result;
    return {
      ok: true,
      estimate,
      priceUsd,
      previouslyImportedTasks: prior,
    };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "estimate failed" };
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
  // M3/AC-07: the MANUAL entrypoint is policy-gated too, after authorization and before any run
  // accounting. `runGraphProjection` refuses on its own — this is not the only gate — but a button
  // that returns "refused" out of the runner would still have opened an `ingest_runs` row and told
  // the admin nothing useful. Authorization first, deliberately: "admins only" is the answer to a
  // non-admin whatever the runtime is, and leaking the runtime posture to them is not this
  // function's job. Uses the same shared classification as the runner, not a second mode detector.
  const runtime = await readStagingRuntimeState();
  if (!runtime.ready || runtime.mode === "copy-ready" || runtime.mode === "copy-safe-refusal") {
    return { ok: false, error: `graph projection is disabled on this ${runtime.mode} staging runtime` };
  }
  const startedAt = Date.now();
  try {
    const s = await runGraphProjection({ teamId: ctx.teamId });
    // Record the run through the SAME gate as the scheduler (`shouldRecordProjectionRun`). This button pushes episodes that BURN metered
    // extraction calls, so a run that leaves no `ingest_runs` row gives the Costs page's
    // calls-per-episode ratio a numerator with no denominator — and the admin most likely to click it
    // is the one diagnosing extraction, who would then read a spuriously high ratio caused by their
    // own clicking. Best-effort: a ledger write must never fail the projection.
    // `partialItems` joins the condition (RECONCILE-1): a manual run that projects nothing but
    // OBSERVES partially-landed items carries the one signal this measurement exists to capture, and
    // dropping it here would make the metric queryable from the scheduler but not from the button an
    // admin actually clicks while diagnosing extraction. TICKFIT-2 (Fable diff review M2): this button
    // used to carry its OWN inline condition, which had already drifted five signals behind the
    // scheduler's and would have been blind to a failing batched ledger read and a slow walk — the
    // durable-visibility contract held for one of the two callers. One shared predicate now.
    if (shouldRecordProjectionRun(s)) {
      await recordIngestRun(adminClient(), projectionRunInput(s, "manual", startedAt, Date.now(), ctx.teamId));
    }
    if (!s.configured) {
      return { ok: false, error: "Graph memory is not configured (set GRAPHITI_URL on the brain)." };
    }
    if (!s.ok && s.errors.length) return { ok: false, error: s.errors.join("; ") };
    if (s.lockedOut) {
      return { ok: false, error: "Another brain instance is projecting this team right now (deploy overlap) — try again in a minute." };
    }
    revalidatePath(`/t/${teamSlug}/admin/integrations`);
    return {
      ok: true,
      message: `Projected ${s.projected} item(s) / ${s.episodes} episode(s) to the graph (=${s.skipped} unchanged, ${s.scanned} scanned).`,
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
): Promise<{ ok: boolean; error?: string; warning?: string }> {
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
  // The save SUCCEEDED — this is advisory. A model without structured-output support silently empties
  // the graph: Graphiti keeps returning 202, arcs go blank, and the next signal is the stall detector
  // six hours later. Surfacing it here turns that into a sentence at the moment of the choice.
  // Best-effort — an unreachable catalogue or an unlisted model yields no warning rather than a false
  // accusation.
  //
  // CONDITIONAL on the extraction role being unset. This warning exists because the graph proxy made
  // the ANSWERING picker also drive Graphiti's extraction — and the moment `extraction_model` is set
  // that is no longer true. Warning anyway would accuse a model that never touches the graph, which is
  // the false-accusation failure mode this check was explicitly built to avoid. The extraction save
  // carries the warning instead (see `setExtractionModel`).
  // Suppressed when the extraction role governs the graph: this save then changes nothing Graphiti uses,
  // so warning about it would accuse a model that never touches the graph. When extraction is unset the
  // answering model IS the graph's model, and `graphModelWarning` resolves exactly that.
  try {
    if (await extractionRoleActive(db, ctx.teamId)) return { ok: true };
  } catch {
    // Fall through and warn: a failed read must not silence a real problem.
  }
  return { ok: true, ...(await graphModelWarning(db, ctx.teamId)) };
}

/**
 * Does a distinct extraction model govern the graph leg? Decides which picker owns the
 * structured-output warning, so exactly one of them speaks about it.
 */
async function extractionRoleActive(db: ReturnType<typeof adminClient>, teamId: string): Promise<boolean> {
  const { data } = await db.from("teams").select("extraction_model").eq("id", teamId).maybeSingle();
  const model = (data as { extraction_model: string | null } | null)?.extraction_model;
  return !!model && model.trim().length > 0;
}

/**
 * Set the EXTRACTION role as a PROVIDER + MODEL pair (admins only; audited). Both live on `teams`:
 * `extraction_model` + `extraction_provider`.
 *
 * WHY THIS EXISTS. Graph extraction was 99% of the brain's LLM bill, because the proxy forced Graphiti
 * onto the ANSWERING model — a reasoning model whose completion tokens were ~87% chain-of-thought on a
 * mechanical, schema-constrained transformation. This is the one control that separates "what answers
 * the Query box" from "what does the high-volume machine work", and it is where nearly all the spend is.
 *
 * Semantics mirror `setReasoningModel` so all three roles behave alike: an empty model clears BOTH →
 * extraction reuses the answering model. A null provider with a model set means "the answering backend,
 * different model" — the cheapest useful case.
 *
 * `anthropic` is REFUSED with a reason, not a generic "invalid provider": Graphiti extracts via OpenAI
 * structured outputs, so an Anthropic extraction backend would 501 every call while Graphiti kept
 * answering 202 — a silently empty graph. Validated here and not only in the picker, because a server
 * action is callable without the UI.
 */
export async function setExtractionModel(
  teamSlug: string,
  // Deliberately the WIDER type: the caller is a picker over all providers, and `anthropic` must get a
  // reason rather than being unrepresentable-and-therefore-unexplained at the boundary.
  provider: AnsweringProvider | null,
  model: string
): Promise<{ ok: boolean; error?: string; warning?: string }> {
  const ctx = await requireAdmin(teamSlug);
  if (!ctx) return { ok: false, error: "admins only" };
  if (provider === "anthropic") {
    return {
      ok: false,
      error:
        "Anthropic can't serve graph extraction — Graphiti extracts with OpenAI structured outputs, " +
        "which Anthropic's API doesn't speak. Pick OpenRouter, OpenAI, or a local endpoint.",
    };
  }
  const allowed: (AnsweringProvider | null)[] = [null, "openai", "openrouter", "local"];
  if (!allowed.includes(provider)) return { ok: false, error: "invalid provider" };
  const trimmed = model.trim().slice(0, 200);
  const extractionModel = trimmed || null;
  // Clearing the model clears the provider too — no orphaned "extract on X" with no model to run.
  const extractionProvider = extractionModel ? provider : null;
  const db = adminClient();
  const { error } = await db
    .from("teams")
    .update({ extraction_model: extractionModel, extraction_provider: extractionProvider })
    .eq("id", ctx.teamId);
  if (error) return { ok: false, error: error.message };
  await audit(db, {
    team_id: ctx.teamId,
    actor_kind: "member",
    member_id: ctx.memberId,
    action: "team.extraction_model_set",
    target_type: "team",
    target_id: ctx.teamId,
    meta: { provider: extractionProvider, model: extractionModel },
  });
  revalidatePath(`/t/${teamSlug}/admin/integrations`);
  return { ok: true, ...(await graphModelWarning(db, ctx.teamId)) };
}

/**
 * Set the CHEAP model for the extraction calls Graphiti itself marks simple (admins only; audited).
 *
 * WHY A SECOND MODEL FIELD. `graphiti_core` asks for `ModelSize.small` on several of the prompts on
 * the add_episode path, and the proxy used to discard that and serve everything with the extraction
 * model. Those two — filling attributes onto entities `extract_nodes` already found, and choosing
 * among edges `extract_edges` already produced — were a majority of graph spend once `call_kind`
 * made it measurable, and neither can reduce what the graph knows about. This is the control that
 * lets them run cheap while entity and edge extraction keep the strong model.
 *
 * NO PROVIDER PAIR, deliberately: it rides the extraction backend's provider and key. A second
 * provider would reintroduce the half-swap the extraction branch's WHOLE fallback exists to prevent.
 *
 * Empty clears it → every call is served by the extraction model, exactly as before. The setting is
 * also INERT (and reported so on the card) whenever the extraction role itself is off or fell back —
 * see `selectSmallExtractionBackend`; a cost setting that reverts unnoticed is a surprise bill.
 */
export async function setExtractionSmallModel(
  teamSlug: string,
  model: string
): Promise<{ ok: boolean; error?: string; warning?: string }> {
  const ctx = await requireAdmin(teamSlug);
  if (!ctx) return { ok: false, error: "admins only" };
  const trimmed = model.trim().slice(0, 200);
  const db = adminClient();
  const { error } = await db
    .from("teams")
    .update({ extraction_small_model: trimmed || null })
    .eq("id", ctx.teamId);
  if (error) return { ok: false, error: error.message };
  await audit(db, {
    team_id: ctx.teamId,
    actor_kind: "member",
    member_id: ctx.memberId,
    action: "team.extraction_small_model_set",
    target_type: "team",
    target_id: ctx.teamId,
    meta: { model: trimmed || null },
  });
  revalidatePath(`/t/${teamSlug}/admin/integrations`);
  // Same advisory the extraction picker carries, asked of the SMALL model on the extraction backend.
  // A model without structured-output support fails every call it is routed — and because these two
  // calls only refine existing entities, the damage is quieter than an empty graph: attributes and
  // edge resolution silently stop while extraction keeps working. Best-effort; an unreachable
  // catalogue yields no warning rather than a false accusation.
  return { ok: true, ...(await smallModelWarning(db, ctx.teamId, trimmed)) };
}

/** Structured-output advisory for the SMALL extraction model, on the extraction backend's provider. */
async function smallModelWarning(
  db: ReturnType<typeof adminClient>,
  teamId: string,
  model: string
): Promise<{ warning?: string }> {
  if (!model) return {};
  try {
    const keys = await resolveAnsweringKeys(db, teamId);
    const backend = selectLlmBackend(
      { LLM_BASE_URL: process.env.LLM_BASE_URL, LLM_MODEL: process.env.LLM_MODEL },
      keys,
      { role: "extraction" }
    );
    const warning = structuredOutputWarning(await checkStructuredOutputSupport(backend.provider, model));
    return warning ? { warning } : {};
  } catch {
    return {};
  }
}

/**
 * The advisory sentence about whatever now governs the graph leg. Both model pickers end here.
 *
 * Asked of the RESOLVED backend, never of the submitted values, and this is the whole point:
 *
 *  • "Same as answering" (provider null) still runs the model on whatever answers, so asking about the
 *    submitted `null` would return "can't tell" on the configuration most people will use.
 *  • CLEARING the extraction model hands the graph back to the answering model — which may be one that
 *    was never warned about, because this very function suppressed the warning on the answering save
 *    while extraction governed. Set flash as the answer model (silently, correctly), then clear
 *    extraction, and without resolving after the write the graph would run a schema-incapable model with
 *    nobody ever having said so. Resolving means the question is always "what will Graphiti use now",
 *    which has no ordering hole.
 *
 * Advisory only, never blocking, and silent on "can't tell" — an unreachable catalogue or an unlisted
 * model must not become an accusation (the work-key lesson).
 */
async function graphModelWarning(
  db: ReturnType<typeof adminClient>,
  teamId: string
): Promise<{ warning?: string }> {
  try {
    const keys = await resolveAnsweringKeys(db, teamId);
    const backend = selectLlmBackend(
      { LLM_BASE_URL: process.env.LLM_BASE_URL, LLM_MODEL: process.env.LLM_MODEL },
      keys,
      { role: "extraction" }
    );
    // Anthropic can't serve extraction at all, and this is reachable WITHOUT choosing it for the role:
    // answering on Anthropic + "same as answering" resolves here. `setExtractionModel` refuses an
    // explicit Anthropic pick with a sentence, so the equivalent config must not save wordlessly.
    if (backend.provider === "anthropic") {
      return {
        warning:
          "Graph extraction will run on Anthropic (your answering provider), which can't serve it — " +
          "Graphiti extracts with OpenAI structured outputs. Pick OpenRouter, OpenAI, or a local " +
          "endpoint as the extraction provider, or the graph will stay empty.",
      };
    }
    const warning = structuredOutputWarning(
      await checkStructuredOutputSupport(backend.provider, backend.model)
    );
    return warning ? { warning } : {};
  } catch {
    return {};
  }
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

/**
 * Set the EMBEDDINGS role as a PROVIDER + MODEL pair (admins only; audited). Both live on `teams`:
 * `embedding_provider` + `embedding_model`. A null provider clears BOTH → the semantic index falls
 * back to env `EMBEDDINGS_URL` (self-host) or off. Only openai/openrouter, and only curated 1536-dim
 * models (the `item_chunks.embedding vector(1536)` column is fixed), so the picker can't corrupt the
 * index. A save-time vector-SPACE guard additionally refuses a model whose canonical space differs
 * from the index's existing baseline (env `EMBEDDINGS_MODEL`), since mixing spaces silently degrades
 * search and the sha-based dedup would make it permanent — switching that needs a re-index (future).
 */
export async function setEmbeddingModel(
  teamSlug: string,
  provider: EmbeddingProvider | null,
  model: string
): Promise<{ ok: boolean; error?: string }> {
  const ctx = await requireAdmin(teamSlug);
  if (!ctx) return { ok: false, error: "admins only" };
  const allowed: (EmbeddingProvider | null)[] = [null, ...EMBEDDING_PROVIDER_TYPES];
  if (!allowed.includes(provider)) return { ok: false, error: "invalid provider" };

  let embeddingProvider: EmbeddingProvider | null = null;
  let embeddingModel: string | null = null;
  if (provider) {
    const picked = model.trim();
    // Dimension guard: only curated 1536-dim models are storable (bypass-proof, not just UI).
    if (!isCuratedEmbeddingModel(provider, picked)) {
      return { ok: false, error: "unsupported embedding model — only 1536-dim models are allowed" };
    }
    // Vector-space guard: refuse a model in a different space than the existing index baseline.
    const baseline = canonicalEmbeddingModel(process.env.EMBEDDINGS_MODEL || "text-embedding-3-small");
    if (process.env.EMBEDDINGS_URL && canonicalEmbeddingModel(picked) !== baseline) {
      return {
        ok: false,
        error: `the semantic index was built with "${baseline}"; switching the embedding space needs a re-index (not yet supported)`,
      };
    }
    embeddingProvider = provider;
    embeddingModel = picked;
  }

  const db = adminClient();
  const { error } = await db
    .from("teams")
    .update({ embedding_provider: embeddingProvider, embedding_model: embeddingModel })
    .eq("id", ctx.teamId);
  if (error) return { ok: false, error: error.message };
  await audit(db, {
    team_id: ctx.teamId,
    actor_kind: "member",
    member_id: ctx.memberId,
    action: "team.embedding_provider_set",
    target_type: "team",
    target_id: ctx.teamId,
    meta: { provider: embeddingProvider, model: embeddingModel },
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
    const db = adminClient();
    await removeIntegrationById(db, { teamId: ctx.teamId, memberId: ctx.memberId }, id);
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "could not delete" };
  }
  revalidatePath(`/t/${teamSlug}/admin/integrations`);
  return { ok: true };
}

/**
 * Admin-only OAuth connection test and selected-scope preview. Provider calls are limited to the
 * exact saved file/folder/Shared Drive roots; this never lists unrelated Drive content and never
 * returns the access token or encrypted credential to the browser.
 */
export async function testGoogleDriveConnection(
  teamSlug: string,
  name: string,
  continuation = 0,
): Promise<{ ok: boolean; error?: string; message?: string; checked?: number; total?: number; continuation?: number }> {
  const ctx = await requireAdmin(teamSlug);
  if (!ctx) return { ok: false, error: "admins only" };
  try {
    const stored = await getIntegrationWithSecret(adminClient(), ctx.teamId, "gdrive", name);
    if (stored?.config.authMode === "service_account") {
      const verified = stored.config.serviceAccountStatus === "verified";
      return {
        ok: verified,
        ...(verified ? {} : { error: "Local service-account credentials have not completed a verified provider run" }),
        message: verified
          ? `Verified local service account ${String(stored.config.serviceAccountIdentity ?? "")}; credentials remain on the sidecar.`
          : "Service-account mode is configured. Provision the connector principal and run the sidecar with local credentials to verify access.",
        checked: 0,
        total: [
          ...((stored.config.fileIds as string[] | undefined) ?? []),
          ...((stored.config.folderIds as string[] | undefined) ?? []),
          ...((stored.config.sharedDriveIds as string[] | undefined) ?? []),
        ].length,
      };
    }
    const authority = await acquireGdriveAdminTestAuthority({
      teamId: ctx.teamId, memberId: ctx.memberId, integrationName: name,
    });
    await authorizeGdriveAdminTestCall(authority);
    const tokenResponse = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: authority.credential.clientId,
        client_secret: authority.credential.clientSecret,
        refresh_token: authority.credential.refreshToken,
        grant_type: "refresh_token",
      }),
      cache: "no-store", signal: AbortSignal.timeout(15_000),
    });
    const token = await tokenResponse.json().catch(() => ({})) as Record<string, unknown>;
    await authorizeGdriveAdminTestCall(authority);
    if (!tokenResponse.ok || typeof token.access_token !== "string") {
      return { ok: false, error: tokenResponse.status === 400 || tokenResponse.status === 401
        ? "Google authorization was revoked; reconnect this account"
        : "Google Drive is temporarily unavailable" };
    }
    const config = authority.config;
    const targets = [
      ...((config.fileIds as string[] | undefined) ?? []).map((id) => ({ kind: "file", id })),
      ...((config.folderIds as string[] | undefined) ?? []).map((id) => ({ kind: "folder", id })),
      ...((config.sharedDriveIds as string[] | undefined) ?? []).map((id) => ({ kind: "drive", id })),
    ];
    const start = Math.max(0, Math.min(continuation, targets.length));
    const batch = targets.slice(start, start + 100);
    let reachable = 0;
    let denied = 0;
    let checked = 0;
    for (const target of batch) {
      await authorizeGdriveAdminTestCall(authority);
      const path = target.kind === "drive"
        ? `https://www.googleapis.com/drive/v3/drives/${encodeURIComponent(target.id)}?fields=id,name`
        : `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(target.id)}?supportsAllDrives=true&fields=id,name,mimeType,driveId`;
      let response: Response;
      try {
        response = await fetch(path, {
          headers: { Authorization: `Bearer ${token.access_token}` }, cache: "no-store",
          signal: AbortSignal.timeout(10_000),
        });
      } catch {
        const resumeAt = start + checked;
        return {
          ok: false,
          error: "Google Drive preview was interrupted; unchecked roots were not reported healthy",
          message: `${resumeAt} of ${targets.length} selected roots checked; continue at ${resumeAt}.`,
          checked: resumeAt, total: targets.length, continuation: resumeAt,
        };
      }
      checked += 1;
      if (response.ok) reachable += 1;
      else denied += 1;
    }
    await authorizeGdriveAdminTestCall(authority);
    const scopes = typeof token.scope === "string"
      ? token.scope.split(/\s+/).filter(Boolean)
      : ((config.scopeSet as string[] | undefined) ?? []);
    const empty = config.selectionState === "empty";
    const next = start + checked < targets.length ? start + checked : undefined;
    return {
      ok: denied === 0,
      ...(denied ? { error: `${denied} of ${batch.length} checked roots are not accessible; the saved scope was not broadened` } : {}),
      message: `${String(config.authenticatedAccount ?? "Google account")} authenticated with ${scopes.length} granted scope(s). ${empty ? "The saved selection is intentionally empty" : `${reachable} of ${checked} checked root(s) reachable`}; checked ${start + checked}/${targets.length}${next !== undefined ? ` (continue at ${next})` : ""}; recursive=${String(Boolean(config.recursive))}.`,
      checked: start + checked,
      total: targets.length,
      continuation: next,
    };
  } catch {
    return { ok: false, error: "Google Drive connection test failed without changing the saved selection" };
  }
}

/** Persist only Google Docs that Picker granted to this OAuth client and the server can verify.
 * Picker's browser token is intentionally never sent here; the encrypted refresh credential owner
 * performs the proof, and selection publication revalidates the same Admin/credential generation. */
export async function saveGoogleDrivePickerSelection(
  teamSlug: string,
  name: string,
  selectedIds: string[],
): Promise<{ ok: boolean; error?: string; message?: string }> {
  const ctx = await requireAdmin(teamSlug);
  if (!ctx) return { ok: false, error: "admins only" };
  const ids = [...new Set(selectedIds.map((id) => id.trim()).filter(Boolean))].slice(0, 100);
  if (ids.length === 0) return { ok: false, error: "No Google Docs were selected" };
  try {
    const authority = await acquireGdriveAdminTestAuthority({
      teamId: ctx.teamId, memberId: ctx.memberId, integrationName: name,
    });
    await authorizeGdriveAdminTestCall(authority);
    const tokenResponse = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: authority.credential.clientId,
        client_secret: authority.credential.clientSecret,
        refresh_token: authority.credential.refreshToken,
        grant_type: "refresh_token",
      }),
      cache: "no-store", signal: AbortSignal.timeout(15_000),
    });
    const token = await tokenResponse.json().catch(() => ({})) as Record<string, unknown>;
    await authorizeGdriveAdminTestCall(authority);
    if (!tokenResponse.ok || typeof token.access_token !== "string") {
      return { ok: false, error: "Google authorization is unavailable; reconnect this account" };
    }
    const verified: string[] = [];
    const denied: string[] = [];
    for (const id of ids) {
      await authorizeGdriveAdminTestCall(authority);
      const response = await fetch(
        `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(id)}?supportsAllDrives=true&fields=id,mimeType,trashed`,
        { headers: { Authorization: `Bearer ${token.access_token}` }, cache: "no-store", signal: AbortSignal.timeout(10_000) },
      );
      const metadata = response.ok
        ? await response.json().catch(() => ({})) as { id?: string; mimeType?: string; trashed?: boolean }
        : {};
      if (response.ok && metadata.id === id
          && metadata.mimeType === "application/vnd.google-apps.document" && !metadata.trashed) {
        verified.push(id);
      } else {
        denied.push(id);
      }
    }
    await authorizeGdriveAdminTestCall(authority);
    if (denied.length > 0 || verified.length !== ids.length) {
      return { ok: false, error: `${denied.length} selected item(s) are inaccessible or are not Google Docs; the saved selection was unchanged` };
    }
    await publishGdriveVerifiedSelection(authority, verified);
    revalidatePath(`/t/${teamSlug}/admin/integrations`);
    return { ok: true, message: `Saved ${verified.length} Picker-authorized Google Doc(s).` };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "Google Picker selection could not be verified" };
  }
}

/**
 * Choose the single PM tool the brain projects tasks into (brain-api v1.2). Admins only; audited.
 * Pass `null` to clear it. The projection engine reads `teams.primary_pm_provider`; with it unset it
 * no-ops (or falls back to the sole enabled PM integration).
 */
/**
 * Set the category extracted MEETING action items land in when pushed to the PM tool (admins only).
 * A brain task status (backlog/ready/in_progress/done) mapped to the provider's state group on push.
 */
export async function setMeetingTaskStatus(
  teamSlug: string,
  status: MeetingTaskStatus
): Promise<{ ok: boolean; error?: string }> {
  const ctx = await requireAdmin(teamSlug);
  if (!ctx) return { ok: false, error: "admins only" };
  if (!(MEETING_TASK_STATUSES as readonly string[]).includes(status)) {
    return { ok: false, error: "invalid category" };
  }
  const db = adminClient();
  try {
    await setMeetingTaskStatusDb(db, ctx.teamId, status);
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "could not save" };
  }
  await audit(db, {
    team_id: ctx.teamId,
    actor_kind: "member",
    member_id: ctx.memberId,
    action: "team.meeting_task_status_set",
    target_type: "team",
    target_id: ctx.teamId,
    meta: { status },
  });
  revalidatePath(`/t/${teamSlug}/admin/integrations`);
  return { ok: true };
}

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
