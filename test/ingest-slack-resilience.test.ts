import { describe, expect, it } from "vitest";
import {
  fetchSlackChannel,
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
function stubClient(over: Partial<Record<"channelName" | "usersMap" | "history" | "replies", unknown>>): SlackClient {
  return {
    channelName: over.channelName ?? (async () => "general"),
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
describe("SlackClient.channelName — transient failures must not re-key every thread path", () => {
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

  it("falls back to the id ONLY for a missing scope (a stable, consistent path)", async () => {
    const name = await withFetch({ ok: false, error: "missing_scope" }, () =>
      new SlackClientCtor("xoxb-test").channelName("C0123")
    );
    expect(name).toBe("C0123");
  });

  it("THROWS on a transient failure instead of silently duplicating the channel", async () => {
    await withFetch({ ok: false, error: "ratelimited" }, async () => {
      await expect(new SlackClientCtor("xoxb-test").channelName("C0123")).rejects.toThrow(/ratelimited/);
    });
  });

  it("a dead token is NOT treated as a graceful degrade", async () => {
    await withFetch({ ok: false, error: "invalid_auth" }, async () => {
      await expect(new SlackClientCtor("xoxb-test").channelName("C0123")).rejects.toThrow(/invalid_auth/);
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
