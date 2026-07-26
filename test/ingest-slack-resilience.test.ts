import { describe, expect, it } from "vitest";
import {
  fetchSlackChannel,
  privateChannelAction,
  SlackError,
  SlackClient as SlackClientCtor,
  type SlackClient,
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
