/**
 * Slack channel checks for the Admin → Integrations save flow — the mirror of `github-validate`,
 * and kept out of the ingest source for the same reason: the UI must be able to check a channel
 * WITHOUT running a sync.
 *
 * Why this exists at all, given `fetchSlackChannel` already fails closed on a private channel: the
 * ingester's refusal is silent until someone reads a run log, so an admin who pastes a private
 * channel id gets a saved integration that simply never produces anything. The brain's rule is that
 * only channels PUBLIC to the workspace are ingested, so the honest place to say so is the moment
 * the admin adds one. Ingest-time enforcement stays the backstop (it covers the env-token path and
 * a channel that turns private later) — this is the message, not the gate.
 *
 * Pure transport + mapping; `fetchImpl` is injectable so it unit-tests without a live Slack.
 */

const API = "https://slack.com/api";
type Fetch = typeof fetch;

/** public = readable by the whole workspace · private = private channel/DM · unknown = couldn't tell. */
export type ChannelVisibility = "public" | "private" | "unknown";

export interface ChannelCheck {
  channelId: string;
  visibility: ChannelVisibility;
  /** Display name when Slack told us, for a message the admin can recognise. */
  name?: string;
  /** Slack's error code / transport failure, when `visibility` is "unknown". */
  error?: string;
}

/**
 * Probe one channel via `conversations.info`. Never throws.
 *
 * `is_im`/`is_mpim` are reported by Slack SEPARATELY from `is_private`, so a DM must be tested for
 * explicitly or it reads as public. Anything we cannot resolve is `unknown`, never `public` — the
 * caller decides what to do with an unverifiable channel, and defaulting to "public" here would turn
 * a missing scope into consent to ingest private conversations.
 */
export async function checkSlackChannel(
  token: string,
  channelId: string,
  fetchImpl: Fetch = fetch
): Promise<ChannelCheck> {
  try {
    const res = await fetchImpl(`${API}/conversations.info?channel=${encodeURIComponent(channelId)}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const body = (await res.json()) as {
      ok?: boolean;
      error?: string;
      channel?: { name?: string; is_private?: boolean; is_im?: boolean; is_mpim?: boolean };
    };
    if (!body.ok || !body.channel) {
      return { channelId, visibility: "unknown", error: body.error ?? `HTTP ${res.status}` };
    }
    const c = body.channel;
    const isPrivate = Boolean(c.is_private || c.is_im || c.is_mpim);
    return { channelId, visibility: isPrivate ? "private" : "public", name: c.name };
  } catch (e) {
    return { channelId, visibility: "unknown", error: e instanceof Error ? e.message : "could not reach Slack" };
  }
}

/** Probe every configured channel. Sequential — this runs on a form submit of at most a few ids. */
export async function checkSlackChannels(
  token: string,
  channelIds: readonly string[],
  fetchImpl: Fetch = fetch
): Promise<ChannelCheck[]> {
  const out: ChannelCheck[] = [];
  for (const id of channelIds) out.push(await checkSlackChannel(token, id, fetchImpl));
  return out;
}

/**
 * The admin-facing reason to REJECT a save, or null to allow it. Pure — unit-tested.
 *
 * Only a CONFIRMED-private channel blocks. An `unknown` result (no scope, Slack down, a typo'd id)
 * is not evidence of privacy, and blocking on it would make an unreachable Slack an unusable admin
 * page; those are left to the ingester, which fails closed and reports per run.
 */
export function privateChannelRejection(checks: readonly ChannelCheck[]): string | null {
  const priv = checks.filter((c) => c.visibility === "private");
  if (priv.length === 0) return null;
  const named = priv.map((c) => (c.name ? `#${c.name} (${c.channelId})` : c.channelId)).join(", ");
  return (
    `${priv.length === 1 ? "That channel is" : "Those channels are"} private in Slack: ${named}. ` +
    `The brain only syncs channels that are public to the workspace — everything it ingests is ` +
    `readable by the whole team, so private conversations are never added.`
  );
}
