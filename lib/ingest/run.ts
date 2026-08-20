import "server-only";
import { randomUUID } from "node:crypto";
import { timeoutFetch } from "@/lib/http";
import type { DbClient } from "@/lib/db/types";
import { adminClient } from "@/lib/db/admin";
import { ingestItem } from "@/lib/ingest";
import { purgeItemsByPathPrefix } from "@/lib/ingest/purge";
import { purgeDeletedSlackThreads } from "@/lib/ingest/slack-cleanup";
import { getEnabledIntegrationsWithSecrets } from "@/lib/integrations/manage";
import { SlackClient, fetchSlackChannel, privateChannelAction } from "./sources/slack";
import { normalizeThread, slackChannelPathPrefix } from "./sources/slack-normalize";
import { syncSlackIdentities } from "./sources/slack-identity";
import { syncProviderIdentities } from "@/lib/identity/provider-sync";
import { buildIdentityMap, resolveByProviderId, resolveMember } from "@/lib/identity/resolve";
import { fetchPlaneProject } from "./sources/plane";
import { normalizePlaneProject, normalizePlaneDocs } from "./sources/plane-normalize";
import type { PlaneConnection } from "@/lib/pm-sync/plane-client";
import { fetchLinearTeam } from "./sources/linear";
import { normalizeLinearTeam, normalizeLinearDocs } from "./sources/linear-normalize";
import { fetchGithubRepoIssues, fetchGithubRepoProbe } from "./sources/github";
import { githubCursorKey, readConnectorCursor, writeConnectorCursor } from "@/lib/ingest/cursors";
import { githubRepoConfigHash, identityMapEntries, shouldSkipGithubRepo } from "@/lib/ingest/github-watermark";
import { normalizeGithubRepo } from "./sources/github-normalize";
import { fetchGithubRepoFiles } from "./sources/github-files";
import { normalizeGithubFiles } from "./sources/github-files-normalize";
import { ingestGithubApiScan } from "@/lib/codebases/github-api-scan";
import { commitSinceIso, resolveRepoHistory } from "@/lib/integrations/github-link";

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
  /** Items REMOVED because the source no longer has them (a deleted Slack thread). */
  deleted: number;
  errors: string[];
  skipped?: boolean;
}

function envSlackToken(): string | null {
  // Fallback only — the per-integration encrypted secret is preferred.
  // Canonical env name is SLACK_BOT_TOKEN; tolerate the lowercase form.
  return process.env.SLACK_BOT_TOKEN ?? process.env.slack_bot_token ?? null;
}

/** Distinct teams that have at least one enabled Slack integration. */
async function teamsWithSlack(db: DbClient): Promise<string[]> {
  const { data } = await db
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

/** Find (or auto-provision) the per-team connector member used as a given source's ingest actor.
 *  Exported for the PRET-4 dm arm (a post-marker connector mint must resolve team posture). */
export async function resolveConnectorAuth(
  db: DbClient,
  teamId: string,
  identity: ConnectorIdentity
): Promise<{ teamId: string; memberId: string; apiKeyId: string } | null> {
  const { data: existing } = await db
    .from("members")
    .select("id")
    .eq("team_id", teamId)
    .eq("actor_handle", identity.handle)
    .maybeSingle();

  let memberId = (existing as { id: string } | null)?.id;
  if (!memberId) {
    const { data: created } = await db
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
          is_connector: true,
        },
        { onConflict: "team_id,actor_handle" }
      )
      .select("id")
      .single();
    memberId = (created as { id: string } | null)?.id;
  }
  if (!memberId) return null;

  // PRET-4 (diff-review H1): connectors are minted HERE, not via createMember, so the
  // invite-default membership write must ride this path or a post-materialization connector
  // is permanently external-posture and its key's permissive corpus reads silently narrow —
  // the exact class the spec's connector row exists to prevent. Idempotent and called on
  // EVERY ensure (not just create), so a previously-failed write self-heals on the next
  // ingest run. Loud on failure; never fails ingestion.
  try {
    const { writeInviteDefaultMembership } = await import("@/lib/access/groups");
    const w = await writeInviteDefaultMembership(db, teamId, memberId, "team");
    if (!w.ok) console.error(`[ingest] connector posture write failed (retries next run): ${w.error}`);
  } catch (e) {
    console.error(`[ingest] connector posture write threw (retries next run): ${e instanceof Error ? e.message : String(e)}`);
  }

  // api_key_id is recorded in the audit row (no FK); reuse one if present.
  const { data: key } = await db
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
    deleted: 0,
    errors: [],
  };
  if (running) return { ...empty, skipped: true };
  running = true;
  try {
    const db = adminClient();
    const teamIds = opts.teamId ? [opts.teamId] : await teamsWithSlack(db);
    const envToken = envSlackToken();

    const summary: IngestSummary = { ...empty };
    for (const teamId of teamIds) {
      let slackIntegrations;
      try {
        slackIntegrations = (await getEnabledIntegrationsWithSecrets(db, teamId)).filter(
          (i) => i.type === "slack"
        );
      } catch (err) {
        // e.g. SECRETS_KEY missing/wrong → can't decrypt this team's secrets.
        summary.errors.push(`team ${teamId}: ${err instanceof Error ? err.message : "secret read failed"}`);
        continue;
      }
      if (slackIntegrations.length === 0) continue;
      const auth = await resolveConnectorAuth(db, teamId, {
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
        // One pass per integration token (incl. emails when scoped). A TRANSIENT failure here now
        // throws (a missing scope still returns []): rendering raw ids for one tick would rewrite
        // EVERY thread body in every channel — a version + re-embed + re-projection each, churned
        // back on the next good tick. Skip the integration instead; the existing items stand.
        let detailed;
        try {
          detailed = await client.usersDetailed();
        } catch (err) {
          summary.errors.push(
            `integration "${integ.name}": slack users lookup failed — skipped this tick (${err instanceof Error ? err.message : "unknown"})`
          );
          continue;
        }
        // Best-effort reconcile Slack users → members by email, then build the resolver map so
        // each thread's author is attributed to the real person (manual mappings included).
        try {
          await syncSlackIdentities(db, teamId, detailed);
        } catch (err) {
          summary.errors.push(`team ${teamId}: slack identity sync: ${err instanceof Error ? err.message : "failed"}`);
        }
        const idMap = await buildIdentityMap(db, teamId);
        const users = Object.fromEntries(detailed.map((u) => [u.id, u.displayName]));
        let unverifiable = 0; // channels this token couldn't establish as public, per integration
        for (const channelId of channelIds) {
          summary.channels++;
          try {
            const channel = await fetchSlackChannel(client, channelId, { users, maxMessages: 300 });
            // A channel the brain refuses to read is deliberately not ingested — say so, or the admin
            // sees a channel in the list that silently never produces anything.
            if (channel.skippedPrivate) {
              const action = privateChannelAction(channel);
              summary.errors.push(action.message);
              if (!action.purge) unverifiable++;
              if (action.purge) {
                try {
                  const purged = await purgeItemsByPathPrefix(
                    db,
                    teamId,
                    slackChannelPathPrefix(channelId),
                    "slack channel is private",
                    { actor: { memberId: auth.memberId, apiKeyId: auth.apiKeyId } }
                  );
                  if (purged.items > 0) {
                    summary.errors.push(
                      `${channelId}: purged ${purged.items} previously-ingested private item(s)`
                    );
                  }
                } catch (err) {
                  summary.errors.push(
                    `${channelId}: private-channel purge failed — ${err instanceof Error ? err.message : "unknown"}`
                  );
                }
              }
              continue;
            }
            // A thread whose replies couldn't be fetched is dropped rather than truncated — make that
            // visible so a systematic failure doesn't read as a quiet channel.
            if (channel.skippedThreads > 0) {
              summary.errors.push(
                `${channelId}: ${channel.skippedThreads} thread(s) skipped — replies fetch failed` +
                  `${channel.skippedThreadsReason ? ` (${channel.skippedThreadsReason})` : ""}` +
                  ` — any already-stored version stands`
              );
            }
            for (const thread of channel.threads) {
              const payload = normalizeThread(thread, {
                channelId: channel.channelId,
                channelName: channel.channelName,
                users: channel.users,
                project: "slack",
              });
              // Attribute the item to the thread author's mapped member (else the ingesting actor).
              const authorMemberId = resolveByProviderId(idMap, "slack", thread.root.user ?? "");
              const res = await ingestItem(db, auth, payload, "team", { authorMemberId });
              if (res.status === "created") summary.created++;
              else if (res.status === "updated") summary.updated++;
              else summary.unchanged++;
            }
            // DELETED THREADS. Slack reports no deletion event, so "stored here, absent there" is
            // the only signal — and it is trustworthy ONLY inside the window we actually read
            // (see `planSlackDeletions`, where every guard is a bug that would otherwise happen).
            try {
              summary.deleted += await purgeDeletedSlackThreads(
                db,
                teamId,
                channel,
                client,
                { memberId: auth.memberId, apiKeyId: auth.apiKeyId },
                (notice) => summary.errors.push(notice)
              );
            } catch (err) {
              summary.errors.push(
                `${channelId}: deleted-thread cleanup failed — ${err instanceof Error ? err.message : "unknown"}`
              );
            }
          } catch (err) {
            summary.errors.push(
              `${channelId}: ${err instanceof Error ? err.message : "fetch failed"}`
            );
          }
        }
        // EVERY channel unverifiable is one diagnosis, not N: the token almost certainly lacks
        // `channels:read`, and Slack ingestion for this integration has stopped entirely. Left as N
        // per-channel lines it reads as N unrelated permission oddities, which is how a fail-closed
        // check turns into a silent outage.
        if (unverifiable > 0 && unverifiable === channelIds.length) {
          summary.errors.push(
            `integration "${integ.name}": NO channel could be verified public (${unverifiable}/${channelIds.length}) — ` +
              `nothing was ingested. The bot token most likely lacks the channels:read scope.`
          );
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
  /** TICKFIT-1 (github only): repos whose files+commit legs the watermark proved unchanged
   *  and skipped this run. NOT counted into `unchanged` — a skip diff-syncs nothing. */
  skippedRepos?: string[];
}

/** Distinct teams with at least one enabled Plane integration. */
async function teamsWithPlane(db: DbClient): Promise<string[]> {
  const { data } = await db
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
    const db = adminClient();
    const teamIds = opts.teamId ? [opts.teamId] : await teamsWithPlane(db);

    const summary: PlaneIngestSummary = { ...empty };
    for (const teamId of teamIds) {
      let planeIntegrations;
      try {
        planeIntegrations = (await getEnabledIntegrationsWithSecrets(db, teamId)).filter(
          (i) => i.type === "plane"
        );
      } catch (err) {
        summary.errors.push(`team ${teamId}: ${err instanceof Error ? err.message : "secret read failed"}`);
        continue;
      }
      if (planeIntegrations.length === 0) continue;
      const auth = await resolveConnectorAuth(db, teamId, {
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
          fetchImpl: timeoutFetch,
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
            await syncProviderIdentities(db, teamId, "plane", fetched.memberDetails);
          } catch (err) {
            summary.errors.push(`team ${teamId}: plane identity sync: ${err instanceof Error ? err.message : "failed"}`);
          }
          const idMap = await buildIdentityMap(db, teamId);
          // Work-items → tasks (one kind=task item).
          const payload = normalizePlaneProject({ ...fetched, aiosSources });
          summary.items += payload.rows?.length ?? 0;
          const res = await ingestItem(db, auth, payload, "team");
          if (res.status === "created") summary.created++;
          else if (res.status === "updated") summary.updated++;
          else summary.unchanged++;
          // Work-item text → deliverable items (searchable), one per work-item; attributed to assignee.
          for (const doc of normalizePlaneDocs({ ...fetched, aiosSources })) {
            const authorMemberId = resolveByProviderId(idMap, "plane", String(doc.frontmatter?.assignee_id ?? ""));
            const r = await ingestItem(db, auth, doc, "team", { authorMemberId });
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
async function teamsWithType(db: DbClient, type: "linear" | "github"): Promise<string[]> {
  const { data } = await db
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
    const db = adminClient();
    const teamIds = opts.teamId ? [opts.teamId] : await teamsWithType(db, "linear");
    const summary = emptyImportSummary();
    for (const teamId of teamIds) {
      let integrations;
      try {
        integrations = (await getEnabledIntegrationsWithSecrets(db, teamId)).filter((i) => i.type === "linear");
      } catch (err) {
        summary.errors.push(`team ${teamId}: ${err instanceof Error ? err.message : "secret read failed"}`);
        continue;
      }
      if (integrations.length === 0) continue;
      const auth = await resolveConnectorAuth(db, teamId, {
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
      const { data: ownedLinks } = await db
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
            await syncProviderIdentities(db, teamId, "linear", fetched.members);
          } catch (err) {
            summary.errors.push(`team ${teamId}: linear identity sync: ${err instanceof Error ? err.message : "failed"}`);
          }
          const idMap = await buildIdentityMap(db, teamId);
          // Issues → tasks (one kind=task item). Brain-owned issues are excluded (only Linear-authored import).
          const payload = normalizeLinearTeam({ ...fetched, ownedResourceIds });
          summary.items += payload.rows?.length ?? 0;
          const res = await ingestItem(db, auth, payload, "team");
          if (res.status === "created") summary.created++;
          else if (res.status === "updated") summary.updated++;
          else summary.unchanged++;
          // Issue text → deliverable items (searchable), one per issue; attributed to assignee.
          for (const doc of normalizeLinearDocs({ ...fetched, ownedResourceIds })) {
            const authorMemberId = resolveByProviderId(idMap, "linear", String(doc.frontmatter?.assignee_id ?? ""));
            const r = await ingestItem(db, auth, doc, "team", { authorMemberId });
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
/**
 * TICKFIT-1 (docs/design/tickfit1-github-watermark.md): the FILES and COMMIT-PAGINATION legs
 * sit behind a per-repo remote watermark — one probe call proves a repo unchanged and skips
 * the ~19-min re-scan of an idle corpus. The ISSUES pass and the scan's METADATA leg run
 * every tick (issues deliberately un-watermarked — round 2: `updated_at` semantics unproven
 * for assignee changes; metadata needs no watermark — it's two cheap calls). `force: true`
 * (both manual "sync now" paths) bypasses the watermark: the button promises a real pass.
 * If a scheduler run is already in flight, a forced manual run still returns
 * `skipped: true` — "could not start, already running" (stated, accepted).
 */
export async function runGithubIngestion(opts: { teamId?: string; force?: boolean } = {}): Promise<ImportSummary> {
  if (githubRunning) return { ...emptyImportSummary(), skipped: true };
  githubRunning = true;
  try {
    const db = adminClient();
    const teamIds = opts.teamId ? [opts.teamId] : await teamsWithType(db, "github");
    const summary = emptyImportSummary();
    summary.skippedRepos = [];
    for (const teamId of teamIds) {
      let integrations;
      try {
        integrations = (await getEnabledIntegrationsWithSecrets(db, teamId)).filter((i) => i.type === "github");
      } catch (err) {
        summary.errors.push(`team ${teamId}: ${err instanceof Error ? err.message : "secret read failed"}`);
        continue;
      }
      if (integrations.length === 0) continue;
      const auth = await resolveConnectorAuth(db, teamId, {
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
          // Per-repo history window chosen at link time (AIO-798). null = linked before windows
          // existed (or outside the panel) = the pre-window behaviour. The stored sinceIso anchor is
          // read back VERBATIM — recomputing it here would be the sliding window that diff-deletes
          // imported issues as they age out (plan-review blocker; pinned by a guard).
          const history = resolveRepoHistory(integ.config, full);
          const [owner, repo] = full.split("/", 2);
          if (!owner || !repo) {
            summary.errors.push(`integration "${integ.name}": repo "${full}" must be "owner/name"`);
            continue;
          }
          summary.projects++;

          // TICKFIT-1: the probe-first watermark. ONE `GET /repos` yields the remote's own
          // pushed_at/updated_at/default_branch; equality with the stored cursor (+ an
          // unchanged config/identity hash) proves the FILES tree and COMMIT history
          // unchanged — those change only via a push or a branch switch — and skips the two
          // expensive legs below. Probe error → full pass (fail toward freshness). The probe
          // runs even under `force` so a manual pass still refreshes the cursor; `force`
          // only bypasses the SKIP decision. The hash covers the window's stored IDENTITY
          // (anchor + days), never a resolved instant — the default window's `now − 90d`
          // slides every tick and would make the cursor never match (the vacuity failure).
          const idMap = await buildIdentityMap(db, auth.teamId);
          const configHash = githubRepoConfigHash({
            fileGlobs,
            historySinceIso: history?.sinceIso ?? null,
            historyDays: history?.days ?? null,
            identityEntries: identityMapEntries(idMap),
          });
          let probe: Awaited<ReturnType<typeof fetchGithubRepoProbe>> | null = null;
          let skipDeep = false;
          try {
            probe = await fetchGithubRepoProbe({ owner, repo, token });
            if (!opts.force) {
              const stored = await readConnectorCursor(db, auth.teamId, githubCursorKey(owner, repo));
              skipDeep = shouldSkipGithubRepo(stored, probe, configHash);
            }
          } catch (err) {
            // Fail toward freshness — but LOUDLY (Fable diff L1): a persistently failing
            // probe silently reverts the stage to its full 19-min cost, and the operator
            // needs the why, not just the duration.
            console.warn(`[ingest] github probe failed for ${full} (full pass): ${err instanceof Error ? err.message : String(err)}`);
            probe = null;
            skipDeep = false;
          }
          const errorsBefore = summary.errors.length;

          // Issues → tasks (one kind=task item, diff-synced). ALWAYS runs — deliberately NOT
          // watermarked (TICKFIT-1 design round 2: issue `updated_at` is not proven to bump
          // for every normalized field, e.g. assignees, and this is the cheap leg).
          try {
            const fetched = await fetchGithubRepoIssues({ owner, repo, token, sinceIso: history?.sinceIso });
            const payload = normalizeGithubRepo(fetched);
            summary.items += payload.rows?.length ?? 0;
            const res = await ingestItem(db, auth, payload, "team");
            if (res.status === "created") summary.created++;
            else if (res.status === "updated") summary.updated++;
            else summary.unchanged++;
          } catch (err) {
            summary.errors.push(`${full} issues: ${err instanceof Error ? err.message : "import failed"}`);
          }
          // Repo files → deliverable items (one per file, idempotent by path+sha). Each file is
          // attributed to its last-commit author (resolved via the identity map by git email, then
          // login), NOT the ingesting connector — else arcs/events built on repo docs name no human.
          // Unresolved author → authorMemberId:null (honestly unattributed), never the connector.
          // Behind the watermark: the tree can change only via push/branch-switch, both probed.
          if (!skipDeep) {
            try {
              const fetched = await fetchGithubRepoFiles({ owner, repo, token, globs: fileGlobs });
              const payloads = normalizeGithubFiles(fetched);
              summary.items += payloads.length;
              for (const payload of payloads) {
                const fm = payload.frontmatter ?? {};
                const authorMemberId = resolveMember(idMap, {
                  email: typeof fm.author_email === "string" ? fm.author_email : undefined,
                  key: typeof fm.author_login === "string" ? fm.author_login : undefined,
                });
                const res = await ingestItem(db, auth, payload, "team", { authorMemberId });
                if (res.status === "created") summary.created++;
                else if (res.status === "updated") summary.updated++;
                else summary.unchanged++;
              }
            } catch (err) {
              summary.errors.push(`${full} files: ${err instanceof Error ? err.message : "import failed"}`);
            }
          }
          // Contributions + commit volume → codebases + code_contributions via the GitHub API
          // (no checkout). Auto-populates the per-person + commit-volume graphs on link. No-op for
          // a repo a real `aios-ingest scan` already owns (the scanner's rows are richer).
          // The METADATA leg always runs (two cheap calls — star/language/branch freshness is
          // untouched by the watermark); only the commit PAGINATION sits behind it.
          try {
            // The cutoff is RESOLVED here, once, from the stored anchor (AIO-807) — never re-derived
            // downstream from `days`. `days: 0` ("No history") means no BACKFILL, not "no contributor
            // graphs ever": a window recomputed as `now − 0` each tick left every commit pushed
            // between two ticks outside both windows, forever. Absent entry → null → 90d, as before.
            await ingestGithubApiScan(db, auth, {
              owner, repo, slug: repo, token: token ?? "",
              sinceIso: commitSinceIso(history, Date.now()),
              skipCommits: skipDeep,
            });
          } catch (err) {
            summary.errors.push(`${full} contributions: ${err instanceof Error ? err.message : "sync failed"}`);
          }

          if (skipDeep) {
            summary.skippedRepos!.push(full);
          } else if (probe && summary.errors.length === errorsBefore) {
            // Advance the watermark ONLY after a fully-successful pass over THIS repo — a failed
            // pass must not orphan the delta behind an advanced cursor (spec D2).
            const w = await writeConnectorCursor(db, auth.teamId, githubCursorKey(owner, repo), { ...probe, configHash });
            if (!w.ok) console.error(`[ingest] github cursor write failed for ${full}: ${w.error}`);
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
