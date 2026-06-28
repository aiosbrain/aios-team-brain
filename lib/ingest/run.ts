import "server-only";
import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { adminClient } from "@/lib/supabase/admin";
import { ingestItem } from "@/lib/ingest";
import { getEnabledIntegrationsWithSecrets } from "@/lib/integrations/manage";
import { SlackClient, fetchSlackChannel } from "./sources/slack";
import { normalizeThread } from "./sources/slack-normalize";
import { syncSlackIdentities } from "./sources/slack-identity";
import { syncProviderIdentities } from "@/lib/identity/provider-sync";
import { buildIdentityMap, resolveByProviderId } from "@/lib/identity/resolve";
import { fetchPlaneProject } from "./sources/plane";
import { normalizePlaneProject, normalizePlaneDocs } from "./sources/plane-normalize";
import type { PlaneConnection } from "@/lib/pm-sync/plane-client";
import { fetchLinearTeam } from "./sources/linear";
import { normalizeLinearTeam, normalizeLinearDocs } from "./sources/linear-normalize";
import { fetchGithubRepoIssues } from "./sources/github";
import { normalizeGithubRepo } from "./sources/github-normalize";
import { fetchGithubRepoFiles } from "./sources/github-files";
import { normalizeGithubFiles } from "./sources/github-files-normalize";

/**
 * In-app ingestion runner — the TypeScript replacement for the Python sidecar's
 * Slack path, running inside the brain (one Railway service). For each team's
 * enabled Slack integration it reads the channel selection (`config.channelIds`)
 * and the per-integration **encrypted token** (set in the dashboard, decrypted by
 * getEnabledIntegrationsWithSecrets) — falling back to the SLACK_BOT_TOKEN env if
 * no secret is stored — pulls via the Slack Web API, and writes through the
 * existing `ingestItem` writer (dedup / version / audit).
 *
 * Idempotent (sha256 dedup) and single-flight per process.
 */

export interface IngestSummary {
  ok: boolean;
  integrations: number;
  channels: number;
  created: number;
  updated: number;
  unchanged: number;
  errors: string[];
  skipped?: boolean;
}

function envSlackToken(): string | null {
  // Fallback only — the per-integration encrypted secret is preferred.
  // Canonical env name is SLACK_BOT_TOKEN; tolerate the lowercase form.
  return process.env.SLACK_BOT_TOKEN ?? process.env.slack_bot_token ?? null;
}

/** Distinct teams that have at least one enabled Slack integration. */
async function teamsWithSlack(supabase: SupabaseClient): Promise<string[]> {
  const { data } = await supabase
    .from("integrations")
    .select("team_id")
    .eq("type", "slack")
    .eq("status", "enabled");
  const ids = (data ?? []).map((r) => (r as { team_id: string }).team_id);
  return [...new Set(ids)];
}

interface ConnectorIdentity {
  handle: string;
  email: string;
  displayName: string;
}

/** Find (or auto-provision) the per-team connector member used as a given source's ingest actor. */
async function resolveConnectorAuth(
  supabase: SupabaseClient,
  teamId: string,
  identity: ConnectorIdentity
): Promise<{ teamId: string; memberId: string; apiKeyId: string } | null> {
  const { data: existing } = await supabase
    .from("members")
    .select("id")
    .eq("team_id", teamId)
    .eq("actor_handle", identity.handle)
    .maybeSingle();

  let memberId = (existing as { id: string } | null)?.id;
  if (!memberId) {
    const { data: created } = await supabase
      .from("members")
      .upsert(
        {
          team_id: teamId,
          email: identity.email,
          display_name: identity.displayName,
          actor_handle: identity.handle,
          role: "member",
          tier: "team",
          status: "active",
        },
        { onConflict: "team_id,actor_handle" }
      )
      .select("id")
      .single();
    memberId = (created as { id: string } | null)?.id;
  }
  if (!memberId) return null;

  // api_key_id is recorded in the audit row (no FK); reuse one if present.
  const { data: key } = await supabase
    .from("api_keys")
    .select("id")
    .eq("team_id", teamId)
    .eq("member_id", memberId)
    .limit(1)
    .maybeSingle();

  return { teamId, memberId, apiKeyId: (key as { id: string } | null)?.id ?? randomUUID() };
}

let running = false;

/** Run Slack ingestion for all enabled integrations (optionally one team). */
export async function runSlackIngestion(opts: { teamId?: string } = {}): Promise<IngestSummary> {
  const empty: IngestSummary = {
    ok: true,
    integrations: 0,
    channels: 0,
    created: 0,
    updated: 0,
    unchanged: 0,
    errors: [],
  };
  if (running) return { ...empty, skipped: true };
  running = true;
  try {
    const supabase = adminClient();
    const teamIds = opts.teamId ? [opts.teamId] : await teamsWithSlack(supabase);
    const envToken = envSlackToken();

    const summary: IngestSummary = { ...empty };
    for (const teamId of teamIds) {
      let slackIntegrations;
      try {
        slackIntegrations = (await getEnabledIntegrationsWithSecrets(supabase, teamId)).filter(
          (i) => i.type === "slack"
        );
      } catch (err) {
        // e.g. SECRETS_KEY missing/wrong → can't decrypt this team's secrets.
        summary.errors.push(`team ${teamId}: ${err instanceof Error ? err.message : "secret read failed"}`);
        continue;
      }
      if (slackIntegrations.length === 0) continue;
      const auth = await resolveConnectorAuth(supabase, teamId, {
        handle: "slack-sync",
        email: "slack-sync@connector.local",
        displayName: "Slack Sync",
      });
      if (!auth) {
        summary.errors.push(`team ${teamId}: no connector member`);
        continue;
      }

      for (const integ of slackIntegrations) {
        summary.integrations++;
        const token = integ.secret ?? envToken;
        if (!token) {
          summary.errors.push(
            `integration "${integ.name}": no token — paste a bot token in the dashboard or set SLACK_BOT_TOKEN`
          );
          continue;
        }
        const channelIds = (integ.config.channelIds as string[] | undefined) ?? [];
        if (channelIds.length === 0) continue;

        const client = new SlackClient(token);
        const detailed = await client.usersDetailed(); // one pass per integration token (incl. emails when scoped)
        // Best-effort reconcile Slack users → members by email, then build the resolver map so
        // each thread's author is attributed to the real person (manual mappings included).
        try {
          await syncSlackIdentities(supabase, teamId, detailed);
        } catch (err) {
          summary.errors.push(`team ${teamId}: slack identity sync: ${err instanceof Error ? err.message : "failed"}`);
        }
        const idMap = await buildIdentityMap(supabase, teamId);
        const users = Object.fromEntries(detailed.map((u) => [u.id, u.displayName]));
        for (const channelId of channelIds) {
          summary.channels++;
          try {
            const channel = await fetchSlackChannel(client, channelId, { users, maxMessages: 300 });
            for (const thread of channel.threads) {
              const payload = normalizeThread(thread, {
                channelId: channel.channelId,
                channelName: channel.channelName,
                users: channel.users,
                project: "slack",
              });
              // Attribute the item to the thread author's mapped member (else the ingesting actor).
              const authorMemberId = resolveByProviderId(idMap, "slack", thread.root.user ?? "");
              const res = await ingestItem(supabase, auth, payload, "team", { authorMemberId });
              if (res.status === "created") summary.created++;
              else if (res.status === "updated") summary.updated++;
              else summary.unchanged++;
            }
          } catch (err) {
            summary.errors.push(
              `${channelId}: ${err instanceof Error ? err.message : "fetch failed"}`
            );
          }
        }
      }
    }
    summary.ok = summary.errors.length === 0;
    return summary;
  } finally {
    running = false;
  }
}

// ── Plane inbound import ──────────────────────────────────────────────────────

export interface PlaneIngestSummary {
  ok: boolean;
  integrations: number;
  projects: number;
  created: number;
  updated: number;
  unchanged: number;
  /** Total work-items imported as task rows this run (after de-dupe). */
  items: number;
  errors: string[];
  skipped?: boolean;
}

/** Distinct teams with at least one enabled Plane integration. */
async function teamsWithPlane(supabase: SupabaseClient): Promise<string[]> {
  const { data } = await supabase
    .from("integrations")
    .select("team_id")
    .eq("type", "plane")
    .eq("status", "enabled");
  const ids = (data ?? []).map((r) => (r as { team_id: string }).team_id);
  return [...new Set(ids)];
}

let planeRunning = false;

/**
 * Run Plane ingestion for all enabled Plane integrations (optionally one team). Each integration's
 * project is imported into its OWN brain project (`plane-<identifier>`) as one kind="task" item;
 * normalize de-dupes brain-projected round-trippers and the writer dedups unchanged boards.
 */
export async function runPlaneIngestion(opts: { teamId?: string } = {}): Promise<PlaneIngestSummary> {
  const empty: PlaneIngestSummary = {
    ok: true,
    integrations: 0,
    projects: 0,
    created: 0,
    updated: 0,
    unchanged: 0,
    items: 0,
    errors: [],
  };
  if (planeRunning) return { ...empty, skipped: true };
  planeRunning = true;
  try {
    const supabase = adminClient();
    const teamIds = opts.teamId ? [opts.teamId] : await teamsWithPlane(supabase);

    const summary: PlaneIngestSummary = { ...empty };
    for (const teamId of teamIds) {
      let planeIntegrations;
      try {
        planeIntegrations = (await getEnabledIntegrationsWithSecrets(supabase, teamId)).filter(
          (i) => i.type === "plane"
        );
      } catch (err) {
        summary.errors.push(`team ${teamId}: ${err instanceof Error ? err.message : "secret read failed"}`);
        continue;
      }
      if (planeIntegrations.length === 0) continue;
      const auth = await resolveConnectorAuth(supabase, teamId, {
        handle: "plane-sync",
        email: "plane-sync@connector.local",
        displayName: "Plane Sync",
      });
      if (!auth) {
        summary.errors.push(`team ${teamId}: no connector member`);
        continue;
      }

      for (const integ of planeIntegrations) {
        summary.integrations++;
        const apiKey = integ.secret;
        const workspaceSlug = integ.config.workspaceSlug as string | undefined;
        const projectId = integ.config.projectId as string | undefined;
        if (!apiKey || !workspaceSlug || !projectId) {
          summary.errors.push(
            `integration "${integ.name}": needs an API key + workspaceSlug + projectId in the dashboard`
          );
          continue;
        }
        const conn: PlaneConnection = {
          fetchImpl: fetch,
          base: ((integ.config.baseUrl as string | undefined) || "https://api.plane.so").replace(/\/$/, ""),
          apiKey,
          workspaceSlug,
          projectId,
        };
        // Round-tripper de-dupe also honors a custom configured externalSource.
        const externalSource = integ.config.externalSource as string | undefined;
        const aiosSources = [...new Set(["aios", "aios-backlog", ...(externalSource ? [externalSource] : [])])];

        summary.projects++;
        try {
          const fetched = await fetchPlaneProject(conn);
          // Reconcile Plane members → people by email, then build the resolver map so each
          // work-item's assignee is attributed to the real person.
          try {
            await syncProviderIdentities(supabase, teamId, "plane", fetched.memberDetails);
          } catch (err) {
            summary.errors.push(`team ${teamId}: plane identity sync: ${err instanceof Error ? err.message : "failed"}`);
          }
          const idMap = await buildIdentityMap(supabase, teamId);
          // Work-items → tasks (one kind=task item).
          const payload = normalizePlaneProject({ ...fetched, aiosSources });
          summary.items += payload.rows?.length ?? 0;
          const res = await ingestItem(supabase, auth, payload, "team");
          if (res.status === "created") summary.created++;
          else if (res.status === "updated") summary.updated++;
          else summary.unchanged++;
          // Work-item text → deliverable items (searchable), one per work-item; attributed to assignee.
          for (const doc of normalizePlaneDocs({ ...fetched, aiosSources })) {
            const authorMemberId = resolveByProviderId(idMap, "plane", String(doc.frontmatter?.assignee_id ?? ""));
            const r = await ingestItem(supabase, auth, doc, "team", { authorMemberId });
            if (r.status === "created") summary.created++;
            else if (r.status === "updated") summary.updated++;
            else summary.unchanged++;
          }
        } catch (err) {
          summary.errors.push(
            `integration "${integ.name}": ${err instanceof Error ? err.message : "import failed"}`
          );
        }
      }
    }
    summary.ok = summary.errors.length === 0;
    return summary;
  } finally {
    planeRunning = false;
  }
}

// ── Linear + GitHub inbound import (mirror Plane) ─────────────────────────────

/** Same shape as PlaneIngestSummary — `projects` counts brain projects written (1/team for Linear, 1/repo for GitHub). */
export type ImportSummary = PlaneIngestSummary;

/** Distinct teams with at least one enabled integration of a given type. */
async function teamsWithType(supabase: SupabaseClient, type: "linear" | "github"): Promise<string[]> {
  const { data } = await supabase
    .from("integrations")
    .select("team_id")
    .eq("type", type)
    .eq("status", "enabled");
  const ids = (data ?? []).map((r) => (r as { team_id: string }).team_id);
  return [...new Set(ids)];
}

function emptyImportSummary(): ImportSummary {
  return { ok: true, integrations: 0, projects: 0, created: 0, updated: 0, unchanged: 0, items: 0, errors: [] };
}

let linearRunning = false;

/**
 * Run Linear ingestion for all enabled Linear integrations (optionally one team). Each integration's
 * team is imported into its own brain project (`linear-<teamKey>`) as one kind="task" item; normalize
 * de-dupes brain-projected round-trippers (aios-ext footer) and the writer dedups unchanged teams.
 */
export async function runLinearIngestion(opts: { teamId?: string } = {}): Promise<ImportSummary> {
  if (linearRunning) return { ...emptyImportSummary(), skipped: true };
  linearRunning = true;
  try {
    const supabase = adminClient();
    const teamIds = opts.teamId ? [opts.teamId] : await teamsWithType(supabase, "linear");
    const summary = emptyImportSummary();
    for (const teamId of teamIds) {
      let integrations;
      try {
        integrations = (await getEnabledIntegrationsWithSecrets(supabase, teamId)).filter((i) => i.type === "linear");
      } catch (err) {
        summary.errors.push(`team ${teamId}: ${err instanceof Error ? err.message : "secret read failed"}`);
        continue;
      }
      if (integrations.length === 0) continue;
      const auth = await resolveConnectorAuth(supabase, teamId, {
        handle: "linear-sync",
        email: "linear-sync@connector.local",
        displayName: "Linear Sync",
      });
      if (!auth) {
        summary.errors.push(`team ${teamId}: no connector member`);
        continue;
      }
      // Linear node ids the brain already owns via a projection/adoption link — excluded from the
      // inbound mirror so only net-new Linear-authored issues import (brain authors → Linear out;
      // only Linear-side tasks flow back in). Footer round-trippers are filtered in normalize too.
      const { data: ownedLinks } = await supabase
        .from("task_pm_links")
        .select("provider_resource_id")
        .eq("team_id", teamId)
        .eq("provider", "linear")
        .not("provider_resource_id", "is", null);
      const ownedResourceIds = new Set(
        ((ownedLinks ?? []) as { provider_resource_id: string | null }[])
          .map((l) => l.provider_resource_id)
          .filter((v): v is string => !!v)
      );
      for (const integ of integrations) {
        summary.integrations++;
        const apiKey = integ.secret;
        const linearTeamId = integ.config.teamId as string | undefined;
        if (!apiKey || !linearTeamId) {
          summary.errors.push(`integration "${integ.name}": needs an API key + teamId in the dashboard`);
          continue;
        }
        summary.projects++;
        try {
          const fetched = await fetchLinearTeam({ apiKey, teamId: linearTeamId });
          // Reconcile Linear members → people by email, then build the resolver map so each
          // issue's assignee is attributed to the real person.
          try {
            await syncProviderIdentities(supabase, teamId, "linear", fetched.members);
          } catch (err) {
            summary.errors.push(`team ${teamId}: linear identity sync: ${err instanceof Error ? err.message : "failed"}`);
          }
          const idMap = await buildIdentityMap(supabase, teamId);
          // Issues → tasks (one kind=task item). Brain-owned issues are excluded (only Linear-authored import).
          const payload = normalizeLinearTeam({ ...fetched, ownedResourceIds });
          summary.items += payload.rows?.length ?? 0;
          const res = await ingestItem(supabase, auth, payload, "team");
          if (res.status === "created") summary.created++;
          else if (res.status === "updated") summary.updated++;
          else summary.unchanged++;
          // Issue text → deliverable items (searchable), one per issue; attributed to assignee.
          for (const doc of normalizeLinearDocs({ ...fetched, ownedResourceIds })) {
            const authorMemberId = resolveByProviderId(idMap, "linear", String(doc.frontmatter?.assignee_id ?? ""));
            const r = await ingestItem(supabase, auth, doc, "team", { authorMemberId });
            if (r.status === "created") summary.created++;
            else if (r.status === "updated") summary.updated++;
            else summary.unchanged++;
          }
        } catch (err) {
          summary.errors.push(`integration "${integ.name}": ${err instanceof Error ? err.message : "import failed"}`);
        }
      }
    }
    summary.ok = summary.errors.length === 0;
    return summary;
  } finally {
    linearRunning = false;
  }
}

let githubRunning = false;

/**
 * Run GitHub Issues ingestion for all enabled GitHub integrations (optionally one team). Each repo in
 * an integration's `config.repos` is imported into its own brain project (`github-<owner>-<repo>`) as
 * one kind="task" item. GitHub is not a pm-sync provider, so idempotency is the stable row_key + sha.
 */
export async function runGithubIngestion(opts: { teamId?: string } = {}): Promise<ImportSummary> {
  if (githubRunning) return { ...emptyImportSummary(), skipped: true };
  githubRunning = true;
  try {
    const supabase = adminClient();
    const teamIds = opts.teamId ? [opts.teamId] : await teamsWithType(supabase, "github");
    const summary = emptyImportSummary();
    for (const teamId of teamIds) {
      let integrations;
      try {
        integrations = (await getEnabledIntegrationsWithSecrets(supabase, teamId)).filter((i) => i.type === "github");
      } catch (err) {
        summary.errors.push(`team ${teamId}: ${err instanceof Error ? err.message : "secret read failed"}`);
        continue;
      }
      if (integrations.length === 0) continue;
      const auth = await resolveConnectorAuth(supabase, teamId, {
        handle: "github-sync",
        email: "github-sync@connector.local",
        displayName: "GitHub Sync",
      });
      if (!auth) {
        summary.errors.push(`team ${teamId}: no connector member`);
        continue;
      }
      for (const integ of integrations) {
        summary.integrations++;
        const token = integ.secret; // optional — public repos work token-free
        const repos = (integ.config.repos as string[] | undefined) ?? [];
        const fileGlobs = integ.config.fileGlobs as string[] | undefined;
        for (const full of repos) {
          const [owner, repo] = full.split("/", 2);
          if (!owner || !repo) {
            summary.errors.push(`integration "${integ.name}": repo "${full}" must be "owner/name"`);
            continue;
          }
          summary.projects++;
          // Issues → tasks (one kind=task item, diff-synced).
          try {
            const fetched = await fetchGithubRepoIssues({ owner, repo, token });
            const payload = normalizeGithubRepo(fetched);
            summary.items += payload.rows?.length ?? 0;
            const res = await ingestItem(supabase, auth, payload, "team");
            if (res.status === "created") summary.created++;
            else if (res.status === "updated") summary.updated++;
            else summary.unchanged++;
          } catch (err) {
            summary.errors.push(`${full} issues: ${err instanceof Error ? err.message : "import failed"}`);
          }
          // Repo files → deliverable items (one per file, idempotent by path+sha).
          try {
            const fetched = await fetchGithubRepoFiles({ owner, repo, token, globs: fileGlobs });
            const payloads = normalizeGithubFiles(fetched);
            summary.items += payloads.length;
            for (const payload of payloads) {
              const res = await ingestItem(supabase, auth, payload, "team");
              if (res.status === "created") summary.created++;
              else if (res.status === "updated") summary.updated++;
              else summary.unchanged++;
            }
          } catch (err) {
            summary.errors.push(`${full} files: ${err instanceof Error ? err.message : "import failed"}`);
          }
        }
      }
    }
    summary.ok = summary.errors.length === 0;
    return summary;
  } finally {
    githubRunning = false;
  }
}
