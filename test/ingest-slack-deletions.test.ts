import { describe, expect, it } from "vitest";
import { planSlackDeletions, type StoredSlackThread } from "@/lib/ingest/sources/slack-deletions";

/**
 * Spec: a Slack thread deleted at the source must leave the brain — and NOTHING else may.
 *
 * Slack reports no deletion event, so the only available signal is "stored here, absent there". Read
 * naively that signal is catastrophic: a thread is also absent for the entirely innocent reason that
 * it is older than the 300-message window we read, so a bare set-difference deletes the channel's
 * whole history on the first tick, and every tick after.
 *
 * These cases are therefore mostly about what must NOT be deleted. The asymmetry is deliberate:
 * keeping content a moment too long is recoverable; deleting a live thread is not.
 */

const stored = (ts: string, id = `item-${ts}`): StoredSlackThread => ({ id, ts });

/** Slack `ts` is "<epoch seconds>.<sequence>" and sorts numerically. */
const T = {
  ancient: "1700000000.000100",
  old: "1750000000.000100",
  mid: "1780000000.000100",
  new: "1790000000.000100",
};

describe("planSlackDeletions", () => {
  it("deletes a thread the source no longer has, inside the window", () => {
    const plan = planSlackDeletions(
      { liveRootTs: [T.mid], oldestTs: T.old },
      [stored(T.mid), stored(T.new)]
    );
    expect(plan.itemIds).toEqual([`item-${T.new}`]);
  });

  it("NEVER deletes a thread older than the oldest message it read", () => {
    // The whole reason a floor exists: `ancient` is absent only because the 300-message window
    // didn't reach it. Without the bound this deletes the channel's entire history, every tick.
    const plan = planSlackDeletions(
      { liveRootTs: [T.new], oldestTs: T.mid },
      [stored(T.ancient), stored(T.old), stored(T.new)]
    );
    expect(plan.itemIds).toEqual([]);
    expect(plan.outOfWindow).toBe(2); // counted, not silently ignored
  });

  it("deletes nothing when the channel returned no history at all", () => {
    // Every stored thread would look deleted. A quiet tick, a bad cursor, a channel the bot just
    // lost read access to — all produce this, and none of them mean "the team deleted everything".
    const plan = planSlackDeletions({ liveRootTs: [], oldestTs: undefined }, [stored(T.new)]);
    expect(plan.itemIds).toEqual([]);
    expect(plan.disabledReason).toMatch(/no history/i);
  });

  it("deletes nothing for a channel that was skipped, not read", () => {
    const plan = planSlackDeletions(
      { skippedPrivate: true, liveRootTs: undefined, oldestTs: undefined },
      [stored(T.new)]
    );
    expect(plan.itemIds).toEqual([]);
    expect(plan.disabledReason).toMatch(/not read/i);
  });

  it("keeps a thread that is alive but was skipped from ingestion this tick", () => {
    // The live set is every TOP-LEVEL message in history, not the ingestible `threads` — a thread
    // whose replies failed to fetch is dropped from `threads` (#388) while being demonstrably alive.
    // Diffing against the thinner list would delete a live thread on a transient Slack hiccup.
    const plan = planSlackDeletions(
      { liveRootTs: [T.mid, T.new], oldestTs: T.old }, // both alive; only one was ingestible
      [stored(T.mid), stored(T.new)]
    );
    expect(plan.itemIds).toEqual([]);
  });

  it("does not judge a stored thread whose ts can't be placed in the window", () => {
    const plan = planSlackDeletions({ liveRootTs: [T.new], oldestTs: T.old }, [
      stored("not-a-timestamp", "item-weird"),
    ]);
    expect(plan.itemIds).toEqual([]);
    expect(plan.outOfWindow).toBe(1);
  });

  it("does not delete on an unparseable window floor", () => {
    const plan = planSlackDeletions({ liveRootTs: [], oldestTs: "garbage" }, [stored(T.new)]);
    expect(plan.itemIds).toEqual([]);
    expect(plan.disabledReason).toMatch(/floor/i);
  });

  it("treats a thread exactly AT the floor as out of window (the boundary is inclusive-safe)", () => {
    const plan = planSlackDeletions({ liveRootTs: [], oldestTs: T.mid }, [stored(T.mid, "at-floor")]);
    expect(plan.itemIds).toEqual([]);
  });
});
