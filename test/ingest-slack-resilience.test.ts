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

/**
 * AIO-1170 AC-07 (DIR-01, DIR-06): `usersDetailed` keeps Slack's five classification facts, and keeps
 * them HONEST.
 *
 * A directory record says whether an account is a bot, an app user, deleted, a guest or a
 * single-channel guest. Those facts decide whether an account may be linked to a person automatically,
 * so the one thing this projection must never do is invent a `false`: a flag Slack did not send as a
 * literal boolean is UNKNOWN, and unknown is not "human". The projection also has to survive a
 * malformed entry without losing the valid people beside it, and without becoming a second request.
 */
describe("SlackClient.usersDetailed — classification projection (AC-07)", () => {
  const FLAGS: [provider: string, projected: string][] = [
    ["is_bot", "isBot"],
    ["is_app_user", "isAppUser"],
    ["deleted", "deleted"],
    ["is_restricted", "isRestricted"],
    ["is_ultra_restricted", "isUltraRestricted"],
  ];
  const PROJECTED_KEYS = ["id", "displayName", "email", ...FLAGS.map(([, projected]) => projected)];
  type Projected = Record<string, unknown>;
  type Page = { members?: unknown; cursor?: string } | { error: string };

  /** `users.list`, one page per call. Anything else — another method, another host — fails the test. */
  async function directory(pages: Page[]): Promise<{ users: Projected[]; requests: URL[] }> {
    const requests: URL[] = [];
    const orig = globalThis.fetch;
    globalThis.fetch = (async (input: unknown) => {
      const url = new URL(String(input));
      requests.push(url);
      if (url.origin !== "https://slack.com" || url.pathname !== "/api/users.list") {
        throw new Error(`fixture: unexpected request to ${url.origin}${url.pathname}`);
      }
      const page = pages[requests.length - 1];
      if (!page) throw new Error("fixture: more users.list pages were requested than the provider has");
      const body = "error" in page
        ? { ok: false, error: page.error }
        : { ok: true, members: page.members, response_metadata: page.cursor ? { next_cursor: page.cursor } : {} };
      return { ok: true, status: 200, json: async () => body };
    }) as unknown as typeof fetch;
    try {
      const users = (await new SlackClientCtor("xoxb-synthetic-directory").usersDetailed()) as unknown as Projected[];
      return { users, requests };
    } finally {
      globalThis.fetch = orig;
    }
  }

  /** Semantic unknown: an omitted key and an own `undefined` are the same thing to a reader. */
  function expectFlags(user: Projected | undefined, expected: Record<string, boolean | undefined>): void {
    expect(user, "the record is in the directory").toBeDefined();
    for (const [, projected] of FLAGS) {
      expect(user?.[projected], `${String(user?.id)}.${projected}`).toBe(expected[projected]);
    }
  }
  const byId = (users: Projected[], id: string): Projected | undefined => users.find((user) => user.id === id);
  const allFalse = { is_bot: false, is_app_user: false, deleted: false, is_restricted: false, is_ultra_restricted: false };
  const allTrue = { is_bot: true, is_app_user: true, deleted: true, is_restricted: true, is_ultra_restricted: true };

  it("DIR-01 retains all five facts as literal booleans, across two pages, in directory order", async () => {
    const { users, requests } = await directory([
      { cursor: "page-2", members: [
        { id: "U0HUMAN1", name: "alice", profile: { display_name: "Alice", email: "alice@roster.test" }, ...allFalse },
        { id: "U0BOT1", name: "deploybot", profile: { real_name: "Deploy Bot", email: "bot@roster.test" }, ...allFalse, is_bot: true },
        { id: "U0APP1", real_name: "Connected App", profile: {}, ...allFalse, is_app_user: true },
      ] },
      { members: [
        { id: "U0GUEST1", name: "guest", profile: { display_name: "Guest", email: "guest@roster.test" }, ...allFalse, is_restricted: true },
        { id: "U0SINGLE1", name: "single", profile: { email: "single@roster.test" }, ...allFalse, is_restricted: true, is_ultra_restricted: true },
        { id: "U0GONE1", name: "former", ...allFalse, deleted: true },
        { id: "U0EVERY1", name: "everything", ...allTrue },
      ] },
    ]);

    // One paginated `users.list` pass and nothing else: no second method, no extra request.
    expect(requests.map((url) => url.pathname)).toEqual(["/api/users.list", "/api/users.list"]);
    expect(requests.map((url) => url.searchParams.get("cursor"))).toEqual([null, "page-2"]);
    expect(requests.map((url) => url.searchParams.get("limit"))).toEqual(["200", "200"]);

    expect(users.map((user) => user.id)).toEqual(["U0HUMAN1", "U0BOT1", "U0APP1", "U0GUEST1", "U0SINGLE1", "U0GONE1", "U0EVERY1"]);
    const none = { isBot: false, isAppUser: false, deleted: false, isRestricted: false, isUltraRestricted: false };
    expectFlags(byId(users, "U0HUMAN1"), none);
    expectFlags(byId(users, "U0BOT1"), { ...none, isBot: true });
    expectFlags(byId(users, "U0APP1"), { ...none, isAppUser: true });
    expectFlags(byId(users, "U0GUEST1"), { ...none, isRestricted: true });
    expectFlags(byId(users, "U0SINGLE1"), { ...none, isRestricted: true, isUltraRestricted: true });
    expectFlags(byId(users, "U0GONE1"), { ...none, deleted: true });
    expectFlags(byId(users, "U0EVERY1"), { isBot: true, isAppUser: true, deleted: true, isRestricted: true, isUltraRestricted: true });

    // Bot/app records stay in the directory with their names and email: transcripts still need them.
    expect(users.map(({ id, displayName, email }) => ({ id, displayName, email }))).toEqual([
      { id: "U0HUMAN1", displayName: "Alice", email: "alice@roster.test" },
      { id: "U0BOT1", displayName: "Deploy Bot", email: "bot@roster.test" },
      { id: "U0APP1", displayName: "Connected App", email: undefined },
      { id: "U0GUEST1", displayName: "Guest", email: "guest@roster.test" },
      { id: "U0SINGLE1", displayName: "single", email: "single@roster.test" },
      { id: "U0GONE1", displayName: "former", email: undefined },
      { id: "U0EVERY1", displayName: "everything", email: undefined },
    ]);
  });

  // A value that is not a literal boolean is unknown. It is never coerced, parsed or defaulted.
  const NOT_A_BOOLEAN: [string, unknown][] = [
    ["null", null], ["0", 0], ["an empty string", ""], ['"false"', "false"], ['"true"', "true"], ["1", 1],
    ["an array", []], ["an object", {}],
  ];

  it.each(FLAGS)("DIR-01 leaves %s unknown unless Slack sent a literal boolean, and keeps its siblings exact", async (provider, projected) => {
    const absent: Record<string, unknown> = { ...allTrue };
    delete absent[provider];
    const members = [
      { id: "U0ABSENT", name: "absent", ...absent },
      ...NOT_A_BOOLEAN.map(([, value], index) => ({ id: `U0WRONG${index}`, name: `wrong-${index}`, ...allTrue, [provider]: value })),
      // Controls: the same record with the flag as each literal boolean.
      { id: "U0TRUE", name: "true", ...allFalse, [provider]: true },
      { id: "U0FALSE", name: "false", ...allTrue, [provider]: false },
    ];
    const { users } = await directory([{ members }]);
    expect(users.map((user) => user.id)).toEqual(members.map((member) => member.id));

    const everyTrue = Object.fromEntries(FLAGS.map(([, key]) => [key, true as boolean | undefined]));
    const everyFalse = Object.fromEntries(FLAGS.map(([, key]) => [key, false as boolean | undefined]));
    expectFlags(byId(users, "U0ABSENT"), { ...everyTrue, [projected]: undefined });
    NOT_A_BOOLEAN.forEach(([label], index) => {
      const user = byId(users, `U0WRONG${index}`);
      expect(user?.[projected], `${provider} = ${label}`).toBeUndefined();
      // The four siblings are untouched by one unreadable flag.
      expectFlags(user, { ...everyTrue, [projected]: undefined });
    });
    expectFlags(byId(users, "U0TRUE"), { ...everyFalse, [projected]: true });
    expectFlags(byId(users, "U0FALSE"), { ...everyTrue, [projected]: false });
  });

  it("DIR-01 reads only the top-level fields: a look-alike nested in `profile` is not a classification", async () => {
    const decoys = { is_bot: false, is_app_user: false, deleted: false, is_restricted: false, is_ultra_restricted: false };
    const { users } = await directory([{ members: [
      { id: "U0DECOY", name: "decoy", profile: { email: "decoy@roster.test", ...decoys } },
      { id: "U0MIXED", name: "mixed", is_bot: true, profile: { email: "mixed@roster.test", is_bot: false, is_app_user: false } },
      { id: "U0NOPROFILE", name: "bare" },
      // Control: a top-level record beside them projects normally.
      { id: "U0HUMAN1", name: "alice", profile: { email: "alice@roster.test", is_bot: true, is_app_user: true }, ...decoys },
    ] }]);
    const unknown = { isBot: undefined, isAppUser: undefined, deleted: undefined, isRestricted: undefined, isUltraRestricted: undefined };
    expectFlags(byId(users, "U0DECOY"), unknown);
    expectFlags(byId(users, "U0MIXED"), { ...unknown, isBot: true });
    // A missing profile is a supported no-email record, not a classification and not an error.
    expectFlags(byId(users, "U0NOPROFILE"), unknown);
    expect(byId(users, "U0NOPROFILE")).toMatchObject({ id: "U0NOPROFILE", displayName: "bare" });
    expect(byId(users, "U0NOPROFILE")?.email).toBeUndefined();
    expectFlags(byId(users, "U0HUMAN1"), { isBot: false, isAppUser: false, deleted: false, isRestricted: false, isUltraRestricted: false });
  });

  it("DIR-01 keeps the display-name fallback order and returns no raw provider data", async () => {
    const { users } = await directory([{ members: [
      { id: "U0NAME1", name: "handle", real_name: "Top Real", profile: { display_name: "Display", real_name: "Profile Real", email: "one@roster.test" }, ...allFalse },
      { id: "U0NAME2", name: "handle", real_name: "Top Real", profile: { display_name: "", real_name: "Profile Real" }, ...allFalse },
      { id: "U0NAME3", name: "handle", real_name: "Top Real", profile: {}, ...allFalse },
      { id: "U0NAME4", name: "handle", ...allFalse },
      { id: "U0NAME5", ...allFalse, is_bot: true, is_admin: true, tz: "Etc/UTC", profile: { phone: "synthetic-phone", title: "synthetic-title", image_72: "synthetic-image" } },
    ] }]);
    expect(users.map(({ id, displayName, email }) => ({ id, displayName, email }))).toEqual([
      { id: "U0NAME1", displayName: "Display", email: "one@roster.test" },
      { id: "U0NAME2", displayName: "Profile Real", email: undefined },
      { id: "U0NAME3", displayName: "Top Real", email: undefined },
      { id: "U0NAME4", displayName: "handle", email: undefined },
      { id: "U0NAME5", displayName: "U0NAME5", email: undefined },
    ]);
    expectFlags(byId(users, "U0NAME5"), { isBot: true, isAppUser: false, deleted: false, isRestricted: false, isUltraRestricted: false });
    for (const user of users) {
      for (const key of Object.keys(user)) expect(PROJECTED_KEYS, `${String(user.id)} carries ${key}`).toContain(key);
    }
    expect(JSON.stringify(users)).not.toMatch(/synthetic-phone|synthetic-title|synthetic-image|is_admin|Etc\/UTC/);
  });

  it("DIR-01 omits an entry with no usable id without aborting the valid records around it", async () => {
    const { users, requests } = await directory([
      { cursor: "page-2", members: [
        null,
        "U0BARESTRING",
        42,
        [],
        { name: "no-id", profile: { email: "no-id@roster.test" }, ...allFalse },
        { id: null, name: "null-id", ...allFalse },
        { id: 1234567, name: "numeric-id", ...allFalse },
        { id: true, name: "boolean-id", ...allFalse },
        { id: { toString: () => "U0COERCED" }, name: "object-id", ...allFalse },
        { id: ["U0ARRAY"], name: "array-id", ...allFalse },
        { id: "", name: "empty-id", ...allFalse },
        { id: "   ", name: "blank-id", ...allFalse },
        { id: "U0VALID1", name: "first", profile: { email: "first@roster.test" }, ...allFalse },
      ] },
      { members: [
        undefined,
        { id: "\t", name: "tab-id", ...allFalse },
        // A valid nonblank id is returned unchanged — outer whitespace and case included.
        { id: " u0Padded ", name: "padded", ...allFalse, is_bot: true },
        { id: "U0VALID2", name: "second", profile: { email: "second@roster.test" }, ...allFalse },
      ] },
    ]);
    expect(requests).toHaveLength(2);
    expect(users.map((user) => user.id)).toEqual(["U0VALID1", " u0Padded ", "U0VALID2"]);
    expect(users.map((user) => user.email)).toEqual(["first@roster.test", undefined, "second@roster.test"]);
    expectFlags(byId(users, " u0Padded "), { isBot: true, isAppUser: false, deleted: false, isRestricted: false, isUltraRestricted: false });
    for (const user of users) expect(typeof user.id).toBe("string");
    expect(JSON.stringify(users)).not.toMatch(/U0COERCED|U0ARRAY|U0BARESTRING|1234567/);
  });

  it("DIR-06 a late-page transient failure fails the whole directory — it is never a complete, classified result", async () => {
    await expect(directory([
      { cursor: "page-2", members: [{ id: "U0HUMAN1", name: "alice", profile: { email: "alice@roster.test" }, ...allFalse }] },
      { error: "ratelimited" },
    ])).rejects.toThrow(/ratelimited/);
    await expect(directory([
      { cursor: "page-2", members: [{ id: "U0HUMAN1", name: "alice", ...allFalse }] },
      { error: "invalid_auth" },
    ])).rejects.toThrow(/invalid_auth/);
  });

  it("DIR-06 a late-page missing scope keeps its existing partial result, classification intact", async () => {
    const { users, requests } = await directory([
      { cursor: "page-2", members: [
        { id: "U0HUMAN1", name: "alice", profile: { email: "alice@roster.test" }, ...allFalse },
        { id: "U0BOT1", name: "bot", ...allFalse, is_bot: true },
      ] },
      { error: "missing_scope" },
    ]);
    expect(requests).toHaveLength(2);
    expect(users.map((user) => user.id)).toEqual(["U0HUMAN1", "U0BOT1"]);
    expectFlags(byId(users, "U0HUMAN1"), { isBot: false, isAppUser: false, deleted: false, isRestricted: false, isUltraRestricted: false });
    expectFlags(byId(users, "U0BOT1"), { isBot: true, isAppUser: false, deleted: false, isRestricted: false, isUltraRestricted: false });
  });
});
