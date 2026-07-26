import { describe, expect, it } from "vitest";
import type { FetchedChannel } from "@/lib/ingest/sources/slack";
import { purgeDeletedSlackThreads, storedSlackThreads } from "@/lib/ingest/slack-cleanup";
import { SlackError, type SlackClient } from "@/lib/ingest/sources/slack";
import { db, seedTeam, ingest, type Seed } from "./helpers";

/**
 * A Slack stub for the CONFIRMATION step. `purgeDeletedSlackThreads` doesn't act on the absence
 * inference alone — it asks Slack whether each candidate thread is really gone — so every test here
 * must say what Slack would answer. `gone` is the confirming answer (`thread_not_found`).
 */
function slackStub(answer: "gone" | "alive" | "error"): SlackClient & { calls: () => number } {
  let calls = 0;
  const stub = {
    threadExists: async () => {
      calls++;
      if (answer === "error") throw new SlackError("slack conversations.replies failed: ratelimited");
      return answer === "alive";
    },
    calls: () => calls,
  };
  return stub as unknown as SlackClient & { calls: () => number };
}

/**
 * Spec: what Slack no longer has, the brain no longer has.
 *
 * Two halves, because a Slack thread is ONE item whose body is the whole conversation:
 *  • a deleted THREAD leaves nothing behind to re-render, so the item itself must go;
 *  • a deleted MESSAGE self-heals in the current body on the next sync — but `item_versions`
 *    retains every superseded body, so the erased text lives on in the store. That retention is
 *    invisible except against a real database, which is why this is here and not a unit test.
 */

const CHANNEL = "C0PUB";
const PREFIX = "slack/c0pub/";
const T = { old: "1750000000.000100", mid: "1780000000.000100", new: "1790000000.000100" };

function channel(over: Partial<FetchedChannel>): FetchedChannel {
  return {
    channelId: CHANNEL,
    channelName: "general",
    threads: [],
    users: {},
    skippedThreads: 0,
    ...over,
  };
}

async function ingestThread(seed: Seed, ts: string, body: string) {
  return ingest(seed, {
    path: `${PREFIX}${ts}.md`,
    project: "slack",
    kind: "transcript",
    access: "team",
    body,
    frontmatter: { source: "slack", channel_id: CHANNEL, ts },
  });
}

async function paths(seed: Seed): Promise<string[]> {
  const { data } = await db().from("items").select("path").eq("team_id", seed.teamId);
  return (data ?? []).map((r) => (r as { path: string }).path).sort();
}

describe("slack deletions (real Postgres)", () => {
  it("removes a thread the source no longer has", async () => {
    const seed = await seedTeam();
    await ingestThread(seed, T.mid, "still there");
    await ingestThread(seed, T.new, "deleted at the source");

    const removed = await purgeDeletedSlackThreads(
      db(),
      seed.teamId,
      channel({ liveRootTs: [T.mid], oldestTs: T.old }),
      slackStub("gone")
    );

    expect(removed).toBe(1);
    expect(await paths(seed)).toEqual([`${PREFIX}${T.mid}.md`]);
  });

  it("keeps every thread older than the window, even though all are 'absent'", async () => {
    // The failure this exists to prevent: reading "absent" as "deleted" wipes the channel's whole
    // history on the very first tick, because the 300-message window never reaches back that far.
    const seed = await seedTeam();
    await ingestThread(seed, T.old, "ancient but alive");
    await ingestThread(seed, T.mid, "also alive");

    const removed = await purgeDeletedSlackThreads(
      db(),
      seed.teamId,
      channel({ liveRootTs: [], oldestTs: T.new }),
      slackStub("gone")
    );

    expect(removed).toBe(0);
    expect(await paths(seed)).toHaveLength(2);
  });

  it("reads the stored threads' ts back off the frontmatter", async () => {
    const seed = await seedTeam();
    await ingestThread(seed, T.mid, "body");
    const stored = await storedSlackThreads(db(), seed.teamId, CHANNEL);
    expect(stored).toEqual([{ id: expect.any(String), ts: T.mid }]);
  });

  it("a message deleted at the source leaves NO copy in the retained bodies", async () => {
    const seed = await seedTeam();
    const item = await ingestThread(seed, T.mid, "root\n\n---\n\nsecret reply nobody should keep");
    // The next sync re-renders the thread WITHOUT the deleted reply. The current body self-heals…
    await ingestThread(seed, T.mid, "root");

    const { data } = await db()
      .from("item_versions")
      .select("id, body, member_id")
      .eq("item_id", item.id);
    const rows = (data ?? []) as { id: string; body: string; member_id: string | null }[];

    // …and the superseded body no longer quotes it. Without the rule this row still holds the text
    // the author erased, verbatim, forever.
    expect(rows).toHaveLength(2);
    expect(rows.some((r) => r.body.includes("secret reply"))).toBe(false);

    // The ROWS survive with their attribution: `item_versions` is the work ledger behind contributor
    // credit, the timeline and arcs — dropping rows would silently rewrite who did what.
    expect(rows.every((r) => r.member_id !== null)).toBe(true);
    // The CURRENT version keeps its body — that content is still live at the source.
    expect(rows.filter((r) => r.body === "root")).toHaveLength(1);
    const { data: live } = await db().from("items").select("body").eq("id", item.id).maybeSingle();
    expect((live as { body: string }).body).toBe("root");
  });

  it("does NOT forget history for a source whose old revisions were genuinely authored", async () => {
    // The rule is per-source, and the default is to keep history. A document's superseded revisions
    // are a real record; only a re-render of retractable source-owned content opts out.
    const seed = await seedTeam();
    const doc = await ingest(seed, {
      path: "docs/spec.md", project: "acme", kind: "deliverable", access: "team",
      body: "draft one", frontmatter: { source: "notion" },
    });
    await ingest(seed, {
      path: "docs/spec.md", project: "acme", kind: "deliverable", access: "team",
      body: "draft two", frontmatter: { source: "notion" },
    });
    const { data } = await db().from("item_versions").select("body").eq("item_id", doc.id);
    expect((data ?? []).map((r) => (r as { body: string }).body).sort()).toEqual(["draft one", "draft two"]);
  });

  it("a body that REVERTS to an earlier one leaves only content that is still live", async () => {
    // A→B→A is the exact Slack shape (reply added, then deleted). `keepSha` spares every row matching
    // the just-written sha rather than just the newest, which is what keeps this coherent: the older
    // A row is spared too, and its body is byte-identical to what is live. (It was already blanked
    // when B superseded it — forgetting is one-way — so what survives is only ever content the source
    // still has, which is the invariant that actually matters.)
    const seed = await seedTeam();
    const item = await ingestThread(seed, T.mid, "root");
    await ingestThread(seed, T.mid, "root\n\n---\n\ntransient reply");
    await ingestThread(seed, T.mid, "root");

    const { data } = await db().from("item_versions").select("body").eq("item_id", item.id);
    const bodies = (data ?? []).map((r) => (r as { body: string }).body);
    expect(bodies.some((b) => b.includes("transient reply"))).toBe(false); // retracted → gone
    expect(bodies).toContain("root"); // live content → kept
    expect(bodies).toHaveLength(3); // three pushes, three ledger rows: credit is never rewritten
  });

  it("a purged thread takes its retained bodies with it (cascade), not just the live row", async () => {
    const seed = await seedTeam();
    const gone = await ingestThread(seed, T.new, "v1");
    await ingestThread(seed, T.new, "v2 — edited");

    await purgeDeletedSlackThreads(db(), seed.teamId, channel({ liveRootTs: [], oldestTs: T.mid }), slackStub("gone"));

    const { data } = await db().from("item_versions").select("id").eq("item_id", gone.id);
    expect(data ?? []).toHaveLength(0);
  });

  /**
   * The absence inference is only as good as our model of what Slack puts in `history` — an
   * assumption about a wire format holding up an irreversible cascade through `item_versions`. So the
   * purge ASKS. Only Slack saying the thread is gone authorizes the delete.
   */
  it("spares a candidate that Slack says is still there", async () => {
    const seed = await seedTeam();
    const alive = await ingestThread(seed, T.mid, "absent from history, but not actually deleted");

    const slack = slackStub("alive");
    const removed = await purgeDeletedSlackThreads(
      db(),
      seed.teamId,
      channel({ liveRootTs: [], oldestTs: T.old }),
      slack
    );

    // Assert the confirmation actually RAN. Without this the test passes for the wrong reason — a
    // renamed/missing `threadExists` throws, the catch spares everything, and "spared" looks correct
    // while the guard is gone.
    expect(slack.calls()).toBe(1);
    expect(removed).toBe(0);
    const { data } = await db().from("items").select("id").eq("id", alive.id);
    expect(data ?? []).toHaveLength(1);
  });

  it("spares a candidate when Slack could not be asked (an error is not evidence)", async () => {
    const seed = await seedTeam();
    const spared = await ingestThread(seed, T.mid, "unconfirmed");

    const slack = slackStub("error");
    const removed = await purgeDeletedSlackThreads(
      db(),
      seed.teamId,
      channel({ liveRootTs: [], oldestTs: T.old }),
      slack
    );

    expect(slack.calls()).toBe(1); // it asked, and the ASKING failed — not a skipped check
    expect(removed).toBe(0);
    const { data } = await db().from("items").select("id").eq("id", spared.id);
    expect(data ?? []).toHaveLength(1);
  });
});