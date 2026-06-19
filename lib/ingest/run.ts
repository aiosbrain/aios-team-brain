import "server-only";
import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { adminClient } from "@/lib/supabase/admin";
import { ingestItem } from "@/lib/ingest";
import { SlackClient, fetchSlackChannel } from "./sources/slack";
import { normalizeThread } from "./sources/slack-normalize";

/**
 * In-app ingestion runner — the TypeScript replacement for the Python sidecar's
 * Slack path, running inside the brain (one Railway service). Reads each team's
 * enabled Slack integration (`integrations.config.channelIds`, set from the
 * dashboard — non-secret), pulls via the Slack Web API using SLACK_BOT_TOKEN,
 * and writes through the existing `ingestItem` writer (dedup / version / audit).
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

function slackToken(): string | null {
  // Canonical is SLACK_BOT_TOKEN; tolerate the lowercase form some deployers set.
  return process.env.SLACK_BOT_TOKEN ?? process.env.slack_bot_token ?? null;
}

interface IntegrationRow {
  id: string;
  team_id: string;
  name: string;
  config: { channelIds?: string[] } | null;
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
    const token = slackToken();
    if (!token) return { ...empty, ok: false, errors: ["SLACK_BOT_TOKEN not set"] };

    const supabase = adminClient();
    let q = supabase
      .from("integrations")
      .select("id, team_id, name, config")
      .eq("type", "slack")
      .eq("status", "enabled");
    if (opts.teamId) q = q.eq("team_id", opts.teamId);
    const { data: rows } = await q;
    const integrations = (rows ?? []) as IntegrationRow[];

    const summary: IngestSummary = { ...empty, integrations: integrations.length };
    if (integrations.length === 0) return summary;

    const client = new SlackClient(token);
    const users = await client.usersMap(); // one workspace-wide pass, reused across channels

    for (const integ of integrations) {
      const channelIds = integ.config?.channelIds ?? [];
      if (channelIds.length === 0) continue;
      const auth = await resolveConnectorAuth(supabase, integ.team_id);
      if (!auth) {
        summary.errors.push(`team ${integ.team_id}: no connector member`);
        continue;
      }
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
          summary.errors.push(`${channelId}: ${err instanceof Error ? err.message : "fetch failed"}`);
        }
      }
    }
    summary.ok = summary.errors.length === 0;
    return summary;
  } finally {
    running = false;
  }
}
