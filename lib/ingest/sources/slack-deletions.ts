import type { FetchedChannel } from "./slack";

/**
 * WHICH STORED SLACK THREADS WERE DELETED AT THE SOURCE — pure, so the branch that deletes user data
 * is pinned by tests rather than reasoned about inside the runner's loop.
 *
 * Slack does not report deletions; a deleted message is simply absent from the next `history` call.
 * So the signal is "stored here, not there" — and read naively that signal is catastrophic, because
 * a thread is ALSO absent for the entirely innocent reason that it is older than the 300-message
 * window we read. A bare set-difference would delete the channel's whole history on the first tick,
 * every tick.
 *
 * Three conditions therefore gate every deletion, and each one is a bug that would otherwise happen:
 *
 *  1. **The window must have a floor.** Only a stored thread strictly NEWER than the oldest message
 *     actually read can be judged; everything older was never looked at. A channel that returned no
 *     history at all has no floor, so nothing is deletable.
 *  2. **The live set is EVERY top-level message in history** — not the ingestible `threads`, and not
 *     even the content-filtered roots. A thread whose replies failed to fetch is dropped from
 *     `threads` (#388) while being demonstrably alive; a TOMBSTONED root (what Slack leaves when a
 *     thread's first message is deleted but its replies live on) fails the render filter while the
 *     thread plainly still exists. Judging existence by either narrower list deletes live data —
 *     and in the tombstone case it cascades `item_versions`, destroying the credit of every replier
 *     whose messages are still in Slack.
 */

export interface StoredSlackThread {
  id: string;
  /** The thread root's Slack `ts` — `frontmatter.ts`, which is also the item's path segment. */
  ts: string;
}

export interface DeletionPlan {
  /** Item ids whose thread is gone from the source and is inside the window we can judge. */
  itemIds: string[];
  /** Stored threads that were NOT judged, because they predate the window. Reported, not hidden:
   *  it is the difference between "nothing was deleted" and "we couldn't see that far back". */
  outOfWindow: number;
  /** Set when deletion was disabled wholesale this tick, with the reason. */
  disabledReason?: string;
}

/**
 * Compare what the source still has against what we stored. Never throws; returns an empty plan
 * whenever the evidence is insufficient, because the failure direction matters: keeping content a
 * moment too long is recoverable, deleting a live thread is not.
 */
export function planSlackDeletions(
  channel: Pick<FetchedChannel, "liveRootTs" | "oldestTs" | "skippedPrivate">,
  stored: readonly StoredSlackThread[]
): DeletionPlan {
  if (channel.skippedPrivate) {
    // The channel was never read this tick, so absence means nothing. (A confirmed-private channel
    // is purged wholesale by its own path — that is a privacy decision, not a deletion diff.)
    return { itemIds: [], outOfWindow: stored.length, disabledReason: "channel not read this tick" };
  }
  if (!channel.oldestTs || !channel.liveRootTs) {
    return {
      itemIds: [],
      outOfWindow: stored.length,
      disabledReason: "no history read — every stored thread would look deleted",
    };
  }

  const live = new Set(channel.liveRootTs);
  const floor = Number.parseFloat(channel.oldestTs);
  if (!Number.isFinite(floor)) {
    return { itemIds: [], outOfWindow: stored.length, disabledReason: "unparseable window floor" };
  }

  const itemIds: string[] = [];
  let outOfWindow = 0;
  for (const item of stored) {
    if (live.has(item.ts)) continue;
    const ts = Number.parseFloat(item.ts);
    // An unparseable stored ts can't be placed in the window, so it can't be judged — treat it the
    // same as out-of-window rather than guessing it away.
    if (!Number.isFinite(ts) || ts <= floor) {
      outOfWindow++;
      continue;
    }
    itemIds.push(item.id);
  }
  return { itemIds, outOfWindow };
}
