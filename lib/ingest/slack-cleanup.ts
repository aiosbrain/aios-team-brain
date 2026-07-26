import "server-only";
import type { DbClient } from "@/lib/db/types";
import { SlackError, type FetchedChannel, type SlackClient } from "./sources/slack";
import { slackChannelPathPrefix } from "./sources/slack-normalize";
import { planSlackDeletions, type StoredSlackThread } from "./sources/slack-deletions";
import { escapeLike, purgeItemIds, type PurgeOptions } from "./purge";

/**
 * Remove the Slack threads a channel no longer has — the DB half of the deletion path (the decision
 * itself is pure, in `slack-deletions`).
 *
 * This is the deleted-THREAD half. The deleted-MESSAGE half lives in the writer
 * (`lib/ingest/forget-bodies`, driven by the source's `retainSupersededBodies` rule), because a
 * thread's item body is the whole conversation: deleting one message self-heals the current body on
 * the next sync, and what doesn't self-heal is the retained bodies in `item_versions`.
 *
 * Until now nothing removed a deleted thread at all: it stayed searchable, quotable in answers, and
 * counted as credit, indefinitely. For a product ingesting a team's conversations, "the brain
 * remembers what the source erased" is the wrong default.
 */

/** Threads currently stored for one channel, keyed by their Slack root `ts`. */
export async function storedSlackThreads(
  db: DbClient,
  teamId: string,
  channelId: string
): Promise<StoredSlackThread[]> {
  const { data, error } = await db
    .from("items")
    .select("id, frontmatter")
    .eq("team_id", teamId)
    .like("path", `${escapeLike(slackChannelPathPrefix(channelId))}%`);
  if (error) throw new Error(`slack stored-thread read: ${error.message}`);
  return ((data ?? []) as { id: string; frontmatter: Record<string, unknown> | null }[])
    .map((r) => ({ id: r.id, ts: typeof r.frontmatter?.ts === "string" ? r.frontmatter.ts : "" }))
    .filter((t) => t.ts !== "");
}

/**
 * Purge every stored thread of `channel` that the source no longer has, and return how many went.
 *
 * Deliberately conservative at every turn: nothing is deleted unless the channel was actually read
 * this tick, the thread is newer than the oldest message we saw, and it is absent from EVERY
 * top-level message history returned (not the thinner ingestible set, and not the content-filtered
 * roots). Keeping content a moment too long is recoverable; deleting a live thread is not.
 *
 * And then, having inferred all that, it ASKS SLACK before acting. `client` is required rather than
 * optional precisely so no caller can quietly fall back to inference alone.
 */
export async function purgeDeletedSlackThreads(
  db: DbClient,
  teamId: string,
  channel: FetchedChannel,
  client: SlackClient,
  actor?: PurgeOptions["actor"],
  onNotice?: (message: string) => void
): Promise<number> {
  const stored = await storedSlackThreads(db, teamId, channel.channelId);
  const plan = planSlackDeletions(channel, stored);
  if (plan.itemIds.length === 0) return 0;

  // POSITIVE CONFIRMATION before anything is deleted. Everything above infers deletion from ABSENCE,
  // and absence is only as trustworthy as our model of what Slack puts in `history` — an assumption
  // about a wire format, holding up an irreversible cascade through `item_versions` that would destroy
  // the credit of every replier whose messages are still in Slack. So each candidate is checked
  // against the source directly (`client.threadExists`) — Slack answers "is this really gone?"
  // instead of us deducing it. Only a definite NO authorizes the delete; a live thread, or any error
  // that means we couldn't ask, spares it.
  const byId = new Map(stored.map((t) => [t.id, t.ts]));
  const confirmed: string[] = [];
  let unconfirmed = 0;
  for (const id of plan.itemIds) {
    const ts = byId.get(id);
    if (!ts) continue;
    try {
      if (!(await client.threadExists(channel.channelId, ts))) confirmed.push(id);
    } catch (err) {
      // We failed to ASK Slack (ratelimited, a network blip, a lost scope). Never evidence of
      // deletion, so the thread is spared and re-judged next tick.
      //
      // Narrowed to SlackError deliberately: a bare `catch {}` also swallows a TypeError from a
      // client missing `threadExists`, which would turn this whole guard into a permanent silent
      // no-op — safe in direction, but rotted with no signal and still green under most tests.
      if (!(err instanceof SlackError)) throw err;
      unconfirmed++;
    }
  }
  // A confirmation that never succeeds means deletion is switched off for this channel. Silence there
  // is the same failure as a silent purge, one sign flipped: "we deleted nothing" and "we could not
  // check" must not look identical in the run log.
  if (unconfirmed > 0) {
    onNotice?.(
      `${channel.channelId}: ${unconfirmed} deletion candidate(s) could not be confirmed with Slack — ` +
        `kept (a failed check is not evidence of deletion)`
    );
  }
  if (confirmed.length === 0) return 0;

  const res = await purgeItemIds(db, teamId, confirmed, "deleted at the source (slack)", {
    actor,
    scope: slackChannelPathPrefix(channel.channelId),
  });
  return res.items;
}
