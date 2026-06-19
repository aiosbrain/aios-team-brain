import "server-only";
import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { adminClient } from "@/lib/supabase/admin";
import { ingestItem } from "@/lib/ingest";
import { getEnabledIntegrationsWithSecrets } from "@/lib/integrations/manage";
import { SlackClient, fetchSlackChannel } from "./sources/slack";
import { normalizeThread } from "./sources/slack-normalize";

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

/** Find (or auto-provision) the per-team connector member used as the ingest actor. */
async function resolveConnectorAuth(
  supabase: SupabaseClient,
  teamId: string
): Promise<{ teamId: string; memberId: string; apiKeyId: string } | null> {
  const { data: existing } = await supabase
    .from("members")
    .select("id")
    .eq("team_id", teamId)
    .eq("actor_handle", "slack-sync")
    .maybeSingle();

  let memberId = (existing as { id: string } | null)?.id;
  if (!memberId) {
    const { data: created } = await supabase
      .from("members")
      .upsert(
        {
          team_id: teamId,
          email: "slack-sync@connector.local",
          display_name: "Slack Sync",
          actor_handle: "slack-sync",
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
      const auth = await resolveConnectorAuth(supabase, teamId);
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
        const users = await client.usersMap(); // one pass per integration token
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
              const res = await ingestItem(supabase, auth, payload, "team");
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
