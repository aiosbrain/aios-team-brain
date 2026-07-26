import { describe, expect, it } from "vitest";
import {
  fetchSlackChannel,
  privateChannelAction,
  SlackError,
  SlackClient as SlackClientCtor,
  type SlackClient,
  type SlackMessage,
} from "@/lib/ingest/sources/slack";

/**
 * Spec: a TRANSIENT Slack failure must never corrupt already-good stored content.
 *
 * A Slack thread is ONE item whose body is the whole conversation, rewritten on every sync. So any
 * path that produces a PARTIAL body writes a real `item_version`, serves a truncated thread to
 * retrieval, and gets churned back on the next good tick. Two such paths existed:
 *  • a `conversations.replies` failure fell back to root-only → the thread lost every reply;
 *  • a `users.list` failure returned an empty map → every author/mention rendered as a raw id, so
 *    EVERY thread body in the workspace changed at once (a version + re-embed + re-projection each).
 * Both must degrade by SKIPPING, not by writing a degraded body — freshness costs nothing here
 * because the previously-stored full item simply stands until the next tick.
 */

/** A client stub exposing only what `fetchSlackChannel` calls. */
function stubClient(over: Partial<Record<"channelInfo" | "usersMap" | "history" | "replies", unknown>>): SlackClient {
  return {
    channelInfo: over.channelInfo ?? (async () => ({ name: "general", isPrivate: false, verified: true })),
    usersMap: over.usersMap ?? (async () => ({ U1: "Alice", U2: "Bob" })),
    history: over.history ?? (async () => []),
    replies: over.replies ?? (async () => []),
  } as unknown as SlackClient;
}

const rootWithReplies = { ts: "1719878400.000100", user: "U1", text: "question?", reply_count: 2 };

describe("fetchSlackChannel — a replies failure skips the thread, never truncates it", () => {
  it("drops the thread and counts it, rather than emitting a root-only body", async () => {
    const client = stubClient({
      history: async () => [rootWithReplies],
      replies: async () => {
        throw new SlackError("slack conversations.replies failed: ratelimited");
      },
    });

    const channel = await fetchSlackChannel(client, "C1", { users: {} });

    // The thread is ABSENT — ingesting it now would rewrite the stored item to a body missing every
    // reply (a content regression), then restore it next tick with a second bogus version.
    expect(channel.threads).toHaveLength(0);
    expect(channel.skippedThreads).toBe(1);
  });

  it("still returns threads whose replies fetched fine", async () => {
    const client = stubClient({
      history: async () => [rootWithReplies],
      replies: async () => [{ ts: "1719878500.000200", user: "U2", text: "answer" }],
    });
    const channel = await fetchSlackChannel(client, "C1", { users: {} });
    expect(channel.threads).toHaveLength(1);
    expect(channel.threads[0].replies).toHaveLength(1);
    expect(channel.skippedThreads).toBe(0);
  });

  it("a root with no replies is unaffected (never calls replies at all)", async () => {
    const client = stubClient({
      history: async () => [{ ts: "1719878400.000100", user: "U1", text: "standalone" }],
      replies: async () => {
        throw new SlackError("should not be called");
      },
    });
    const channel = await fetchSlackChannel(client, "C1", { users: {} });
    expect(channel.threads).toHaveLength(1);
    expect(channel.skippedThreads).toBe(0);
  });
});

/**
 * The users map is the other partial-body vector. An empty map is a LEGITIMATE steady state when the
 * token lacks `users:read` (every tick renders raw ids, consistently — no churn). A transient failure
 * looks identical from the outside but is NOT stable: one bad tick rewrites every body, the next good
 * one rewrites them all back. So the two must be distinguished at the source.
 */
describe("SlackClient users lookup — missing scope degrades, transient failures surface", () => {
  const okJson = (body: unknown) => ({ ok: true, json: async () => body, status: 200 });

  it("returns [] when the token simply lacks the scope (stable — ids every tick)", async () => {
    const orig = globalThis.fetch;
    globalThis.fetch = (async () => okJson({ ok: false, error: "missing_scope" })) as unknown as typeof fetch;
    try {
      await expect(new SlackClientCtor("xoxb-test").usersDetailed()).resolves.toEqual([]);
      await expect(new SlackClientCtor("xoxb-test").usersMap()).resolves.toEqual({});
    } finally {
      globalThis.fetch = orig;
    }
  });

  it("THROWS on a transient failure so the caller skips instead of rewriting every body", async () => {
    const orig = globalThis.fetch;
    globalThis.fetch = (async () => okJson({ ok: false, error: "ratelimited" })) as unknown as typeof fetch;
    try {
      await expect(new SlackClientCtor("xoxb-test").usersDetailed()).rejects.toThrow(/ratelimited/);
      await expect(new SlackClientCtor("xoxb-test").usersMap()).rejects.toThrow(/ratelimited/);
    } finally {
      globalThis.fetch = orig;
    }
  });

});

/**
 * The channel NAME is the PATH KEY (`slack/<channel>/<ts>.md`), so this vector is the worst of the
 * three: a one-tick fallback to the raw channel id re-keys every thread and CREATES a duplicate item
 * per thread. Unlike a churned body, nothing ever diff-deletes those — they pollute retrieval, credit
 * and the timeline permanently. A missing scope is different: it resolves to the id every tick, so
 * paths stay consistent.
 */
describe("SlackClient.channelInfo — transient failures must not re-key every thread path", () => {
  const resp = (body: unknown) => ({ ok: true, status: 200, json: async () => body });

  async function withFetch<T>(body: unknown, fn: () => Promise<T>): Promise<T> {
    const orig = globalThis.fetch;
    globalThis.fetch = (async () => resp(body)) as unknown as typeof fetch;
    try {
      return await fn();
    } finally {
      globalThis.fetch = orig;
    }
  }

  it("falls back to the id for a missing scope AND fails closed (cannot prove it is public)", async () => {
    const name = await withFetch({ ok: false, error: "missing_scope" }, () =>
      new SlackClientCtor("xoxb-test").channelInfo("C0123")
    );
    expect(name).toEqual({ name: "C0123", isPrivate: true, verified: false }); // unverifiable → private, but NOT confirmed (so nothing is purged on it)
  });

  it("THROWS on a transient failure instead of silently duplicating the channel", async () => {
    await withFetch({ ok: false, error: "ratelimited" }, async () => {
      await expect(new SlackClientCtor("xoxb-test").channelInfo("C0123")).rejects.toThrow(/ratelimited/);
    });
  });

  it("a dead token is NOT treated as a graceful degrade", async () => {
    await withFetch({ ok: false, error: "invalid_auth" }, async () => {
      await expect(new SlackClientCtor("xoxb-test").channelInfo("C0123")).rejects.toThrow(/invalid_auth/);
    });
  });
});

describe("fetchSlackChannel — the skip carries its cause for triage", () => {
  it("reports the underlying Slack error so 'retry' vs 'frozen' is distinguishable", async () => {
    const client = stubClient({
      history: async () => [rootWithReplies],
      replies: async () => {
        throw new SlackError("slack conversations.replies failed: ratelimited");
      },
    });
    const channel = await fetchSlackChannel(client, "C1", { users: {} });
    expect(channel.skippedThreadsReason).toMatch(/ratelimited/);
  });
});

/**
 * Spec: the brain only ingests channels that are PUBLIC in the workspace.
 *
 * There are exactly two tiers (team / external) and no stricter one, so anything pulled from a
 * private channel becomes readable by the whole team — which is not what "private" means to the
 * people in it. An admin pasting a channel id can't be relied on to have checked, and
 * `conversations.info` answers directly, so the ingester checks rather than trusts. It must decide
 * BEFORE reading any message, so private content never enters the process at all.
 */
describe("fetchSlackChannel — private channels are never ingested", () => {
  const noRead = async () => {
    throw new SlackError("history must not be called for a private channel");
  };

  it("returns nothing and reads NO history for a private channel", async () => {
    const channel = await fetchSlackChannel(
      stubClient({
        channelInfo: async () => ({ name: "managers", isPrivate: true, verified: true }),
        history: noRead,
      }),
      "C0PRIV",
      { users: {} }
    );
    expect(channel.skippedPrivate).toBe(true);
    expect(channel.threads).toHaveLength(0);
  });

  it("treats a DM / group DM as private too", async () => {
    for (const info of [
      { name: "dm", isPrivate: true, verified: true },
      { name: "mpdm", isPrivate: true, verified: true },
    ]) {
      const channel = await fetchSlackChannel(
        stubClient({ channelInfo: async () => info, history: noRead }),
        "D0123",
        { users: {} }
      );
      expect(channel.skippedPrivate).toBe(true);
    }
  });

  /**
   * `privacyVerified` decides whether already-stored content is DELETED, so losing it in transit is
   * the one regression here that destroys data. Without this the field could be dropped from
   * `fetchSlackChannel`'s return and every other test would still pass — silently disabling the
   * purge (safe) or, if it defaulted the other way, deleting a public channel's history (not).
   */
  it("propagates whether Slack CONFIRMED the privacy, in both directions", async () => {
    const confirmed = await fetchSlackChannel(
      stubClient({
        channelInfo: async () => ({ name: "managers", isPrivate: true, verified: true }),
        history: noRead,
      }),
      "C0PRIV",
      { users: {} }
    );
    expect(confirmed.privacyVerified).toBe(true);

    const guessed = await fetchSlackChannel(
      stubClient({
        // What `channelInfo` returns when it can't establish visibility at all.
        channelInfo: async () => ({ name: "C0MAYBE", isPrivate: true, verified: false }),
        history: noRead,
      }),
      "C0MAYBE",
      { users: {} }
    );
    expect(guessed.skippedPrivate).toBe(true);
    expect(guessed.privacyVerified).toBe(false);
  });

  it("ingests a public channel normally", async () => {
    const channel = await fetchSlackChannel(
      stubClient({
        channelInfo: async () => ({ name: "general", isPrivate: false, verified: true }),
        history: async () => [{ ts: "1719878400.000100", user: "U1", text: "hello" }],
      }),
      "C0PUB",
      { users: {} }
    );
    expect(channel.skippedPrivate).toBeUndefined();
    expect(channel.threads).toHaveLength(1);
  });
});

/**
 * `is_private` comes off the raw Slack payload, so pin the mapping — including the DM flags, which
 * Slack reports separately from `is_private`.
 */
describe("SlackClient.channelInfo — privacy mapping", () => {
  const resp = (body: unknown) => ({ ok: true, status: 200, json: async () => body });
  async function info(channel: Record<string, unknown>) {
    const orig = globalThis.fetch;
    globalThis.fetch = (async () => resp({ ok: true, channel })) as unknown as typeof fetch;
    try {
      return await new SlackClientCtor("xoxb-test").channelInfo("C1");
    } finally {
      globalThis.fetch = orig;
    }
  }

  it("maps is_private / is_im / is_mpim all to private", async () => {
    expect((await info({ name: "a", is_private: true })).isPrivate).toBe(true);
    expect((await info({ name: "b", is_im: true })).isPrivate).toBe(true);
    expect((await info({ name: "c", is_mpim: true })).isPrivate).toBe(true);
  });

  it("a plain public channel is not private", async () => {
    expect(await info({ name: "general", is_private: false })).toEqual({ name: "general", isPrivate: false, verified: true });
  });
});

/**
 * Spec: the branch that decides whether to DELETE stored data.
 *
 * The asymmetry is the safety property and it runs both ways: a CONFIRMED-private channel must be
 * purged (skipping alone leaves private content sitting in a team-readable store), while an
 * UNVERIFIABLE one must never be — a missing scope or a bot removed from a PUBLIC channel would
 * otherwise delete that channel's entire history, which nothing can undo. Extracted from the runner
 * loop precisely so this branch is pinned rather than reasoned about.
 */
describe("privateChannelAction — purge only on proof", () => {
  it("purges when Slack CONFIRMED the channel is private", () => {
    const action = privateChannelAction({ channelId: "C0PRIV", privacyVerified: true });
    expect(action.purge).toBe(true);
    expect(action.message).toContain("C0PRIV");
    expect(action.message).toMatch(/removed/i);
  });

  it("never purges when privacy could not be verified, and says the content was RETAINED", () => {
    for (const privacyVerified of [false, undefined]) {
      const action = privateChannelAction({ channelId: "C0MAYBE", privacyVerified });
      expect(action.purge).toBe(false);
      expect(action.message).toMatch(/retained/i); // the residue is stated, not hidden
    }
  });
});

/**
 * A channel Slack won't describe to this token is UNVERIFIABLE, not transient: `channel_not_found`
 * is what Slack returns for a private channel the bot isn't in (it deliberately won't distinguish
 * that from a bad id). Left to the generic throw it produced a bare error every tick and the
 * channel's privacy was never decided at all.
 */
describe("SlackClient.channelInfo — unverifiable vs transient", () => {
  const resp = (body: unknown) => ({ ok: true, status: 200, json: async () => body });
  async function withError<T>(error: string, fn: () => Promise<T>): Promise<T> {
    const orig = globalThis.fetch;
    globalThis.fetch = (async () => resp({ ok: false, error })) as unknown as typeof fetch;
    try {
      return await fn();
    } finally {
      globalThis.fetch = orig;
    }
  }

  it("treats channel_not_found / not_in_channel as unverifiable-private, not an error", async () => {
    for (const error of ["channel_not_found", "not_in_channel"]) {
      const info = await withError(error, () => new SlackClientCtor("xoxb-test").channelInfo("C0123"));
      expect(info).toEqual({ name: "C0123", isPrivate: true, verified: false });
    }
  });
});

/**
 * Spec: the DELETION WINDOW that `fetchSlackChannel` hands to `planSlackDeletions`.
 *
 * `planSlackDeletions` is pure and well-tested, but it is only as safe as the inputs assembled here —
 * and every one of these is a way to delete a LIVE thread. A refactor to
 * `liveRootTs: threads.map(...)` would pass every test in the deletion suite and start destroying
 * data, which is exactly why the wiring is pinned at this layer too.
 */
describe("fetchSlackChannel — the deletion window", () => {
  const msg = (ts: string, over: Partial<SlackMessage> = {}): SlackMessage => ({
    ts,
    user: "U1",
    text: "hello",
    ...over,
  });

  it("reports the OLDEST message read as the window floor (history is newest→oldest)", async () => {
    const channel = await fetchSlackChannel(
      stubClient({ history: async () => [msg("300.0"), msg("200.0"), msg("100.0")] }),
      "C1",
      { users: {} }
    );
    expect(channel.oldestTs).toBe("100.0");
  });

  it("counts a thread whose REPLIES failed as ALIVE (it is only unsafe to ingest, not gone)", async () => {
    const channel = await fetchSlackChannel(
      stubClient({
        history: async () => [rootWithReplies],
        replies: async () => {
          throw new SlackError("slack conversations.replies failed: ratelimited");
        },
      }),
      "C1",
      { users: {} }
    );
    expect(channel.threads).toHaveLength(0); // not ingested this tick…
    expect(channel.liveRootTs).toContain(rootWithReplies.ts); // …but NOT deletable
  });

  it("counts a TOMBSTONED root as alive — deleting a root must not purge its repliers' ledger", async () => {
    // Slack leaves the parent in history when a thread root is deleted while replies live on. It
    // fails the render filter, so judging existence by that filter would purge the whole item —
    // taking `item_versions` with it and destroying the credit of every replier whose messages are
    // still in Slack.
    const channel = await fetchSlackChannel(
      stubClient({ history: async () => [msg("500.0", { subtype: "tombstone", text: "" })] }),
      "C1",
      { users: {} }
    );
    expect(channel.liveRootTs).toEqual(["500.0"]); // the thread EXISTS
  });

  it("counts a root edited down to no text (a file-only message) as alive", async () => {
    const channel = await fetchSlackChannel(
      stubClient({ history: async () => [msg("500.0", { text: "" })] }),
      "C1",
      { users: {} }
    );
    expect(channel.liveRootTs).toEqual(["500.0"]);
  });

  it("still INGESTS a thread whose root was deleted, so the live body stops serving it", async () => {
    // Keeping the thread (above) is only half the answer. If it is never re-normalized it is never
    // re-rendered either, so `items.body` — the surface retrieval and answers read — goes on quoting
    // the deleted root forever, with no future trigger. That is a worse leak than the version
    // history this feature is about, and it is the one the tombstone fix would otherwise create.
    const channel = await fetchSlackChannel(
      stubClient({
        history: async () => [msg("500.0", { subtype: "tombstone", text: "", reply_count: 2 })],
        replies: async () => [msg("501.0", { text: "a reply that still exists" })],
      }),
      "C1",
      { users: {} }
    );
    expect(channel.threads).toHaveLength(1);
    expect(channel.threads[0].replies).toHaveLength(1);
  });

  it("does NOT invent an item for a text-less message that is not a conversation", () => {
    // A bare text-less top-level message (a file post with no caption) has no thread to maintain;
    // rendering it would create an item that never existed. Bounded by `reply_count`.
    return fetchSlackChannel(
      stubClient({ history: async () => [msg("500.0", { text: "" })] }),
      "C1",
      { users: {} }
    ).then((channel) => expect(channel.threads).toHaveLength(0));
  });

  it("excludes replies from the live set — only top-level messages are threads", async () => {
    const channel = await fetchSlackChannel(
      stubClient({
        history: async () => [msg("500.0"), msg("450.0", { thread_ts: "400.0" }), msg("400.0")],
      }),
      "C1",
      { users: {} }
    );
    expect(channel.liveRootTs).toEqual(["500.0", "400.0"]);
  });

  it("has NO floor when the channel returned nothing (deletion must be disabled)", async () => {
    const channel = await fetchSlackChannel(stubClient({ history: async () => [] }), "C1", { users: {} });
    expect(channel.oldestTs).toBeUndefined();
  });
});

/**
 * A SUCCESSFUL but truncated replies page is the one way a "message was deleted" signal can be
 * forged, and the one way a thread body can still be stored short — `#388` only closed the THROWN
 * case. `has_more` with no cursor to follow means we cannot complete the thread, so it must fail
 * like a fetch error (the caller then skips the thread) rather than return what it happens to have.
 */
describe("SlackClient.replies — completeness", () => {
  function pagedFetch(pages: { messages: unknown[]; has_more?: boolean; cursor?: string }[]) {
    let i = 0;
    return (async () => {
      const p = pages[Math.min(i++, pages.length - 1)];
      return {
        ok: true,
        status: 200,
        json: async () => ({
          ok: true,
          messages: p.messages,
          has_more: p.has_more,
          response_metadata: p.cursor ? { next_cursor: p.cursor } : {},
        }),
      };
    }) as unknown as typeof fetch;
  }

  async function withFetch<T>(f: typeof fetch, fn: () => Promise<T>): Promise<T> {
    const orig = globalThis.fetch;
    globalThis.fetch = f;
    try {
      return await fn();
    } finally {
      globalThis.fetch = orig;
    }
  }

  it("follows the cursor to the end instead of storing a short thread", async () => {
    const replies = await withFetch(
      pagedFetch([
        { messages: [{ ts: "1.0" }, { ts: "2.0" }], has_more: true, cursor: "c1" },
        { messages: [{ ts: "3.0" }] },
      ]),
      () => new SlackClientCtor("xoxb-test").replies("C1", "1.0")
    );
    // Root excluded; both pages present — a single-page read would silently drop "3.0".
    expect(replies.map((m) => m.ts)).toEqual(["2.0", "3.0"]);
  });

  it("THROWS when Slack says there is more but gives no cursor (incomplete, not empty)", async () => {
    await withFetch(pagedFetch([{ messages: [{ ts: "1.0" }, { ts: "2.0" }], has_more: true }]), async () => {
      await expect(new SlackClientCtor("xoxb-test").replies("C1", "1.0")).rejects.toThrow(/incomplete/);
    });
  });
});

/**
 * `isRedactedRoot` decides whether a thread whose root was deleted still gets RE-RENDERED. It must not
 * hinge on a single Slack field: `reply_count` is the obvious signal but Slack doesn't promise to keep
 * it on a tombstone, and losing the signal means the live body silently keeps serving the deleted
 * message. `thread_ts === ts` marks a thread root independently (a standalone message has no
 * `thread_ts` at all), so either signal suffices.
 */
describe("fetchSlackChannel — a redacted root is recognised by either thread signal", () => {
  it("re-renders AND fetches replies when only thread_ts identifies it as a root", async () => {
    const channel = await fetchSlackChannel(
      stubClient({
        history: async () => [{ ts: "500.0", user: "U1", text: "", thread_ts: "500.0" }],
        replies: async () => [{ ts: "501.0", user: "U2", text: "a reply that still exists" }],
      }),
      "C1",
      { users: {} }
    );
    expect(channel.threads).toHaveLength(1);
    // Asserting the REPLIES land is the whole point. Admitting the root without fetching them is
    // worse than not admitting it: the re-render would be placeholder-only, overwrite the stored
    // conversation, and the forget pass would then blank the superseded body — erasing replies that
    // are still live in Slack. Stopping at `threads.length === 1` passed while that bug was present.
    expect(channel.threads[0].replies).toHaveLength(1);
  });

  it("recognises Slack's REAL tombstone payload, which carries text", async () => {
    // The actual wire format is `{subtype: "tombstone", text: "This message was deleted."}` — a
    // `!text` test never fires on it, so the thread would be kept alive but never re-rendered and
    // `items.body` would serve the deleted root forever. Testing the subtype tests what Slack says,
    // not what we assumed it says.
    const channel = await fetchSlackChannel(
      stubClient({
        history: async () => [
          { ts: "500.0", user: "USLACKBOT", text: "This message was deleted.", subtype: "tombstone", reply_count: 1 },
        ],
        replies: async () => [{ ts: "501.0", user: "U2", text: "reply still here" }],
      }),
      "C1",
      { users: {} }
    );
    expect(channel.threads).toHaveLength(1);
    expect(channel.threads[0].replies).toHaveLength(1);
    expect(channel.liveRootTs).toEqual(["500.0"]); // and still counted as alive
  });
});

/**
 * `threadExists` is the ONLY thing that authorizes deleting stored content, so its failure direction
 * is the whole safety property.
 *
 * The trap it exists to avoid: `replies()` strips the root (callers want the replies *around* a root
 * they already hold), and reusing it here would read a LIVE STANDALONE message — which
 * `conversations.replies` returns as exactly one message, the root — as "nothing there", confirming a
 * deletion that never happened. That is precisely the case the confirmation is for.
 */
describe("SlackClient.threadExists — the deletion confirmation", () => {
  const resp = (body: unknown) => ({ ok: true, status: 200, json: async () => body });
  async function withBody<T>(body: unknown, fn: (c: SlackClientCtor) => Promise<T>): Promise<T> {
    const orig = globalThis.fetch;
    globalThis.fetch = (async () => resp(body)) as unknown as typeof fetch;
    try {
      return await fn(new SlackClientCtor("xoxb-test"));
    } finally {
      globalThis.fetch = orig;
    }
  }

  it("says a LIVE STANDALONE message exists — the root alone counts", async () => {
    const alive = await withBody({ ok: true, messages: [{ ts: "500.0", user: "U1", text: "solo" }] }, (c) =>
      c.threadExists("C1", "500.0")
    );
    expect(alive).toBe(true);
  });

  it("says a thread with replies exists", async () => {
    const alive = await withBody(
      { ok: true, messages: [{ ts: "500.0", text: "root" }, { ts: "501.0", text: "reply" }] },
      (c) => c.threadExists("C1", "500.0")
    );
    expect(alive).toBe(true);
  });

  it("confirms deletion ONLY when Slack says the content is gone", async () => {
    for (const error of ["thread_not_found", "message_not_found"]) {
      expect(await withBody({ ok: false, error }, (c) => c.threadExists("C1", "500.0"))).toBe(false);
    }
  });

  it("THROWS on any other failure — not being able to ask is not evidence", async () => {
    for (const error of ["ratelimited", "invalid_auth", "internal_error"]) {
      await expect(withBody({ ok: false, error }, (c) => c.threadExists("C1", "500.0"))).rejects.toThrow();
    }
  });
});
