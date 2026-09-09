import { beforeEach, describe, expect, it, vi } from "vitest";

import type { DbClient, TransactionCapableDbClient, TransactionSession } from "@/lib/db/types";
import {
  readRetryAfterHeader,
  slackMethodIntervalMs,
  slackMethodPageLimit,
  usableBackoffMs,
  SLACK_BACKOFF_FLOOR_MS,
  SLACK_BACKOFF_REPRESENTABLE_MAX_MS,
  SLACK_BUDGETED_METHODS,
  SLACK_UNKNOWN_CATEGORY_INTERVAL_MS,
  SLACK_UNKNOWN_CATEGORY_PAGE_LIMIT,
  type SlackMethodScope,
} from "@/lib/ingest/slack-method-budget";

/**
 * AIO-1170 — the one-request Slack transport, and the pure budget policy it applies.
 *
 * WHAT THIS FILE PROVES, STATED AS ITS LIMIT. The adapter's OWN decisions: that a committed
 * reservation precedes the request, that a denial reaches no network at all, what is sent, and how a
 * refusal is classified without copying a token or a body into the answer. The reservation's
 * database behaviour — one slot across two connections, a cooldown that only moves later, a rollback
 * that leaves nothing — is NOT provable here and is pinned in
 * `test/datamechanics/slack-method-budget.datamechanics.test.ts` against real Postgres. The two
 * budget functions are stubbed below precisely so this file cannot appear to prove them.
 */

const { reserveSlackMethodSlot, extendSlackMethodBackoff } = vi.hoisted(() => ({
  reserveSlackMethodSlot: vi.fn(),
  extendSlackMethodBackoff: vi.fn(),
}));

vi.mock("@/lib/ingest/slack-method-budget", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/ingest/slack-method-budget")>();
  // The POLICY (intervals, page limit, Retry-After parsing) stays real — it is what the adapter
  // applies, and stubbing it would make the clamp assertions below vacuous.
  return { ...actual, reserveSlackMethodSlot, extendSlackMethodBackoff };
});

// Static, not dynamic: `vi.mock` is hoisted above every import in this file, so the adapter below
// already sees the stubbed budget functions.
import * as pageRequestModule from "@/lib/ingest/sources/slack-page-request";
import { slackReservedRequest } from "@/lib/ingest/sources/slack-page-request";

const TEAM = "3f1a0b2c-4d5e-4f60-8a7b-9c0d1e2f3a4b";
const SCOPE: SlackMethodScope = {
  kind: "verified",
  teamId: TEAM,
  workspaceId: "T0UNIT001",
  appId: "A0UNIT001",
};
const TOKEN = "xoxb-9999-synthetic-unit-token";
const NEXT = "2026-09-09T12:00:00.000Z";

/** Records the order of the two events whose ORDER is the contract. */
let events: string[] = [];

/**
 * A transaction-capable client that records its COMMIT. `transaction()` resolving is what "the
 * reservation is durable" means to the adapter, so recording it here and comparing with the fetch is
 * the same claim the data-mechanics tier makes against a real second connection.
 */
function fakeDb(): TransactionCapableDbClient {
  const session = {} as TransactionSession;
  return {
    from() {
      throw new Error("the adapter must not use the builder");
    },
    async rpc() {
      throw new Error("the adapter must not use rpc");
    },
    async transaction<T>(operation: (bound: TransactionSession) => Promise<T>): Promise<T> {
      const value = await operation(session);
      events.push("commit");
      return value;
    },
  };
}

function fetchStub(
  respond: (url: string, init?: RequestInit) => Response | Promise<Response>
): { impl: typeof fetch; calls: { url: string; init?: RequestInit }[] } {
  const calls: { url: string; init?: RequestInit }[] = [];
  const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    events.push("fetch");
    calls.push({ url: String(input), init });
    return respond(String(input), init);
  }) as unknown as typeof fetch;
  return { impl, calls };
}

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function granted() {
  reserveSlackMethodSlot.mockResolvedValue({
    outcome: "granted",
    scope: SCOPE,
    method: "conversations.history",
    nextPermittedAt: NEXT,
  });
}

beforeEach(() => {
  events = [];
  reserveSlackMethodSlot.mockReset();
  extendSlackMethodBackoff.mockReset();
});

describe("slackReservedRequest — reserve, commit, then exactly one request", () => {
  it("commits the reservation BEFORE the request leaves", async () => {
    granted();
    const { impl, calls } = fetchStub(() => json({ ok: true, messages: [] }));

    await slackReservedRequest({ db: fakeDb(), scope: SCOPE, token: TOKEN }, "conversations.history", {
      channel: "C0UNIT001",
    }, { fetchImpl: impl });

    // A request Slack has already counted must survive a crash of the process that made it, so the
    // ordering is the contract — not an implementation detail.
    expect(events).toEqual(["commit", "fetch"]);
    expect(calls).toHaveLength(1);
    expect(reserveSlackMethodSlot).toHaveBeenCalledTimes(1);
  });

  it("sends nothing at all when the reservation is denied", async () => {
    reserveSlackMethodSlot.mockResolvedValue({
      outcome: "deferred",
      scope: SCOPE,
      method: "conversations.history",
      nextPermittedAt: NEXT,
      retryAfterMs: 42_000,
    });
    const { impl, calls } = fetchStub(() => {
      throw new Error("a denied reservation must never reach the network");
    });

    const result = await slackReservedRequest(
      { db: fakeDb(), scope: SCOPE, token: TOKEN },
      "conversations.history",
      { channel: "C0UNIT001" },
      { fetchImpl: impl }
    );

    expect(result).toEqual({
      outcome: "deferred",
      method: "conversations.history",
      nextPermittedAt: NEXT,
      retryAfterMs: 42_000,
    });
    expect(calls).toHaveLength(0);
    expect(events).toEqual(["commit"]);
  });

  /**
   * NO CALLER TRANSACTION CROSSES THE NETWORK. The adapter takes a `DbClient` and opens its own
   * short transaction; a client with no transaction capability fails closed rather than degrading to
   * an unreserved request. The type system states the same rule, but a type is not a runtime gate
   * and this is the failure whose consequence is an unmetered call.
   */
  it("refuses a client it cannot open its own transaction on, and sends nothing", async () => {
    const { impl, calls } = fetchStub(() => json({ ok: true }));
    const sessionless = {
      from() {
        throw new Error("unused");
      },
      async rpc() {
        throw new Error("unused");
      },
    } as unknown as DbClient;

    await expect(
      slackReservedRequest({ db: sessionless, scope: SCOPE, token: TOKEN }, "auth.test", {}, { fetchImpl: impl })
    ).rejects.toThrow(/transaction-capability-required/);
    expect(calls).toHaveLength(0);
  });

  /**
   * The module exposes ONE entry point. A second export taking a `TransactionSession` — a
   * "fetch inside the caller's transaction" convenience — is exactly the shape somebody reaches for
   * later, and it would hold DB locks across a network round trip while making a rollback erase a
   * reservation whose request is already in flight.
   */
  it("exports no way to fetch inside somebody else's transaction", () => {
    const exported = Object.entries(pageRequestModule)
      .filter(([, value]) => typeof value === "function")
      .map(([name]) => name)
      .sort();
    expect(exported).toEqual(["slackReservedRequest"]);
  });

  it("clamps a paged request to the conservative page size, and never inflates a smaller one", async () => {
    granted();
    for (const [requested, expected] of [
      [undefined, String(SLACK_UNKNOWN_CATEGORY_PAGE_LIMIT)],
      ["200", String(SLACK_UNKNOWN_CATEGORY_PAGE_LIMIT)],
      ["16", String(SLACK_UNKNOWN_CATEGORY_PAGE_LIMIT)],
      // A DELETION CONFIRMATION probes for exactly one message. Clamping is a `min`, so that request
      // stays a one-message probe instead of becoming a 15-message page.
      ["1", "1"],
      ["0", String(SLACK_UNKNOWN_CATEGORY_PAGE_LIMIT)],
      ["not-a-number", String(SLACK_UNKNOWN_CATEGORY_PAGE_LIMIT)],
    ] as const) {
      const { impl, calls } = fetchStub(() => json({ ok: true, messages: [] }));
      await slackReservedRequest(
        { db: fakeDb(), scope: SCOPE, token: TOKEN },
        "conversations.replies",
        requested === undefined
          ? { channel: "C0UNIT001", ts: "1718900000.000100" }
          : { channel: "C0UNIT001", ts: "1718900000.000100", limit: requested },
        { fetchImpl: impl }
      );
      expect(new URL(calls[0].url).searchParams.get("limit")).toBe(expected);
    }
  });

  it("leaves an unpaged method's parameters exactly as given", async () => {
    granted();
    const { impl, calls } = fetchStub(() => json({ ok: true }));

    await slackReservedRequest(
      { db: fakeDb(), scope: SCOPE, token: TOKEN },
      "conversations.info",
      { channel: "C0UNIT001" },
      { fetchImpl: impl }
    );

    const url = new URL(calls[0].url);
    expect(url.pathname).toBe("/api/conversations.info");
    expect([...url.searchParams.entries()]).toEqual([["channel", "C0UNIT001"]]);
    // The token appears in exactly one place, and it is not the URL.
    expect(calls[0].url).not.toContain(TOKEN);
    expect((calls[0].init?.headers as Record<string, string>).Authorization).toBe(`Bearer ${TOKEN}`);
  });

  it("preserves messages, has_more and next_cursor without advancing or completing anything", async () => {
    granted();
    const { impl } = fetchStub(() =>
      json({
        ok: true,
        messages: [{ ts: "1718900000.000100" }, { ts: "1718900001.000200" }],
        has_more: true,
        response_metadata: { next_cursor: "b2Zmc2V0OjE1" },
      })
    );

    const result = await slackReservedRequest(
      { db: fakeDb(), scope: SCOPE, token: TOKEN },
      "conversations.history",
      { channel: "C0UNIT001" },
      { fetchImpl: impl }
    );

    expect(result).toMatchObject({
      outcome: "ok",
      page: {
        messages: [{ ts: "1718900000.000100" }, { ts: "1718900001.000200" }],
        hasMore: true,
        nextCursor: "b2Zmc2V0OjE1",
      },
    });
  });

  it("reads an empty page as provider data, and Slack's empty cursor as no cursor", async () => {
    granted();
    const { impl } = fetchStub(() =>
      json({ ok: true, messages: [], response_metadata: { next_cursor: "" } })
    );

    const result = await slackReservedRequest(
      { db: fakeDb(), scope: SCOPE, token: TOKEN },
      "conversations.history",
      { channel: "C0UNIT001" },
      { fetchImpl: impl }
    );

    expect(result.outcome).toBe("ok");
    if (result.outcome !== "ok") throw new Error("unreachable");
    // "This page has no messages" is a FACT the source stated. It is not a failure fallback, and a
    // caller must be able to tell it from a method that returns no messages at all (below).
    expect(result.page.messages).toEqual([]);
    expect(result.page.hasMore).toBe(false);
    expect(result.page.nextCursor).toBeNull();
  });

  it("omits messages entirely for a method that returns none", async () => {
    granted();
    const { impl } = fetchStub(() => json({ ok: true, team_id: "T0UNIT001", bot_id: "B0UNIT001" }));

    const result = await slackReservedRequest(
      { db: fakeDb(), scope: SCOPE, token: TOKEN },
      "auth.test",
      {},
      { fetchImpl: impl }
    );

    expect(result.outcome).toBe("ok");
    if (result.outcome !== "ok") throw new Error("unreachable");
    expect("messages" in result.page).toBe(false);
    expect(result.body).toEqual({ ok: true, team_id: "T0UNIT001", bot_id: "B0UNIT001" });
  });
});

describe("slackReservedRequest — 429 before JSON, and sanitized categories", () => {
  it("recognises a 429 without requiring a readable body, and persists the cooldown first", async () => {
    granted();
    extendSlackMethodBackoff.mockResolvedValue({
      scope: SCOPE,
      method: "conversations.history",
      nextPermittedAt: "2026-09-09T12:02:00.000Z",
      retryAfterMs: 120_000,
    });
    const { impl } = fetchStub(
      () => new Response("<html>too many requests</html>", { status: 429, headers: { "retry-after": "120" } })
    );

    const result = await slackReservedRequest(
      { db: fakeDb(), scope: SCOPE, token: TOKEN },
      "conversations.history",
      { channel: "C0UNIT001" },
      { fetchImpl: impl }
    );

    // The header is read and handed on as MILLISECONDS. Requiring valid JSON first would turn this
    // into a parse error and the cooldown would never be recorded at all.
    expect(extendSlackMethodBackoff).toHaveBeenCalledWith(expect.anything(), SCOPE, "conversations.history", {
      retryAfterMs: 120_000,
    });
    expect(result).toEqual({
      outcome: "rate_limited",
      method: "conversations.history",
      category: "rate_limited",
      nextPermittedAt: "2026-09-09T12:02:00.000Z",
      retryAfterMs: 120_000,
    });
    // The cooldown was written in its own transaction, after the request — two commits, one fetch.
    expect(events).toEqual(["commit", "fetch", "commit"]);
  });

  it("passes an unreadable Retry-After through as null, for the budget's floor to decide", async () => {
    granted();
    extendSlackMethodBackoff.mockResolvedValue({
      scope: SCOPE,
      method: "conversations.history",
      nextPermittedAt: NEXT,
      retryAfterMs: SLACK_BACKOFF_FLOOR_MS,
    });
    const { impl } = fetchStub(
      () => new Response("", { status: 429, headers: { "retry-after": "Wed, 21 Oct 2026 07:28:00 GMT" } })
    );

    await slackReservedRequest({ db: fakeDb(), scope: SCOPE, token: TOKEN }, "conversations.history", {}, {
      fetchImpl: impl,
    });

    expect(extendSlackMethodBackoff).toHaveBeenCalledWith(expect.anything(), SCOPE, "conversations.history", {
      retryAfterMs: null,
    });
  });

  it("surfaces a failure to persist the cooldown, never an empty page", async () => {
    granted();
    const dbFailure = new Error("connection terminated unexpectedly");
    extendSlackMethodBackoff.mockRejectedValue(dbFailure);
    const { impl } = fetchStub(() => new Response("", { status: 429, headers: { "retry-after": "30" } }));

    // If this returned a plain rate-limit result — or worse, an empty page — the caller would go
    // straight back to the provider inside the cooldown Slack just asked for.
    await expect(
      slackReservedRequest({ db: fakeDb(), scope: SCOPE, token: TOKEN }, "conversations.history", {}, {
        fetchImpl: impl,
      })
    ).rejects.toBe(dbFailure);
  });

  it("hands a 48-hour cooldown on in full, rather than a day", async () => {
    granted();
    const persisted = "2026-09-11T12:00:00.000Z";
    extendSlackMethodBackoff.mockResolvedValue({
      scope: SCOPE,
      method: "conversations.history",
      nextPermittedAt: persisted,
      retryAfterMs: 172_800_000,
    });
    const { impl } = fetchStub(
      () => new Response("", { status: 429, headers: { "retry-after": "172800" } })
    );

    const result = await slackReservedRequest(
      { db: fakeDb(), scope: SCOPE, token: TOKEN },
      "conversations.history",
      {},
      { fetchImpl: impl }
    );

    // Shortened to 24h, the next request would go out a full day inside a cooldown the provider
    // stated — so the whole duration has to survive both the parse and the hand-off.
    expect(extendSlackMethodBackoff).toHaveBeenCalledWith(expect.anything(), SCOPE, "conversations.history", {
      retryAfterMs: 172_800_000,
    });
    expect(result).toMatchObject({
      outcome: "rate_limited",
      retryAfterMs: 172_800_000,
      nextPermittedAt: persisted,
    });
  });

  /**
   * A cooldown we cannot carry end to end is a BLOCKED configuration, not a slow one. Persisting the
   * 60-second floor instead would send the next request while the provider is still refusing, and it
   * would look like an ordinary deferral in the table.
   */
  it("reports an unrepresentable Retry-After as blocked, and persists no near-term cooldown", async () => {
    granted();
    const { impl } = fetchStub(
      () => new Response("", { status: 429, headers: { "retry-after": "99999999999999999999" } })
    );

    const result = await slackReservedRequest(
      { db: fakeDb(), scope: SCOPE, token: TOKEN },
      "conversations.history",
      {},
      { fetchImpl: impl }
    );

    expect(result).toEqual({
      outcome: "blocked",
      method: "conversations.history",
      category: "retry_after_unrepresentable",
    });
    expect(extendSlackMethodBackoff).not.toHaveBeenCalled();
  });

  it.each([
    ["invalid_auth", "auth_error"],
    ["missing_scope", "auth_error"],
    ["token_revoked", "auth_error"],
    ["not_allowed_token_type", "auth_error"],
    ["channel_not_found", "provider_error"],
    ["thread_not_found", "provider_error"],
    ["internal_error", "provider_error"],
  ])("classifies %s as %s", async (error, outcome) => {
    granted();
    const { impl } = fetchStub(() => json({ ok: false, error }));

    const result = await slackReservedRequest(
      { db: fakeDb(), scope: SCOPE, token: TOKEN },
      "conversations.info",
      { channel: "C0UNIT001" },
      { fetchImpl: impl }
    );

    expect(result).toEqual({ outcome, method: "conversations.info", category: error });
  });

  /**
   * A category is RECOGNISED, never merely well-shaped. `synthetic_secret_token` satisfies every
   * lower-case/underscore rule a syntax check could state, and echoing it would copy provider text
   * into every log and `last_error_code` column that records the failure — the shape of a value says
   * nothing about whether it is safe to keep.
   */
  it.each([
    ["Rate limit exceeded for token xoxb-1-2; retry later", "xoxb-1-2"],
    ["synthetic_secret_token", "synthetic_secret_token"],
    ["a_code_this_path_has_never_heard_of", "a_code_this_path_has_never_heard_of"],
  ])("replaces an unrecognised provider code (%s) instead of echoing it", async (error, leak) => {
    granted();
    const { impl } = fetchStub(() => json({ ok: false, error }));

    const result = await slackReservedRequest(
      { db: fakeDb(), scope: SCOPE, token: TOKEN },
      "conversations.info",
      { channel: "C0UNIT001" },
      { fetchImpl: impl }
    );

    expect(result).toEqual({
      outcome: "provider_error",
      method: "conversations.info",
      category: "provider_error",
    });
    expect(JSON.stringify(result)).not.toContain(leak);
  });

  it("keeps the known cursor, channel and thread codes distinguishable for a later worker", async () => {
    for (const error of ["invalid_cursor", "not_in_channel", "is_archived", "thread_not_found"]) {
      granted();
      const { impl } = fetchStub(() => json({ ok: false, error }));
      const result = await slackReservedRequest(
        { db: fakeDb(), scope: SCOPE, token: TOKEN },
        "conversations.replies",
        { channel: "C0UNIT001", ts: "1718900000.000100" },
        { fetchImpl: impl }
      );
      expect(result).toEqual({ outcome: "provider_error", method: "conversations.replies", category: error });
    }
  });

  /**
   * HTTP FAILURE IS NEVER SUCCESS. A 5xx carrying `{"ok":true,"messages":[]}` is a broken or
   * intercepted response; reading a page out of it would hand a worker an empty page as provider
   * fact, and an empty page is exactly what a history scan reads as "nothing here".
   */
  it("refuses to call a failed HTTP status successful, whatever the body claims", async () => {
    for (const status of [500, 502, 400, 404]) {
      granted();
      const { impl } = fetchStub(() => json({ ok: true, messages: [] }, status));
      const result = await slackReservedRequest(
        { db: fakeDb(), scope: SCOPE, token: TOKEN },
        "conversations.history",
        { channel: "C0UNIT001" },
        { fetchImpl: impl }
      );
      expect(result).toEqual({
        outcome: "provider_error",
        method: "conversations.history",
        category: `http_${status}`,
      });
      // No partial body fallback: a failure carries no page at all.
      expect("page" in result).toBe(false);
      expect("body" in result).toBe(false);
    }
  });

  it("still reports a recognised error code on a failed status, rather than the bare status", async () => {
    granted();
    const { impl } = fetchStub(() => json({ ok: false, error: "missing_scope" }, 403));

    const result = await slackReservedRequest(
      { db: fakeDb(), scope: SCOPE, token: TOKEN },
      "bots.info",
      { bot: "B0UNIT001" },
      { fetchImpl: impl }
    );

    expect(result).toEqual({ outcome: "auth_error", method: "bots.info", category: "missing_scope" });
  });

  it("keeps a 200 with ok:true successful", async () => {
    granted();
    const { impl } = fetchStub(() => json({ ok: true, messages: [] }, 200));

    const result = await slackReservedRequest(
      { db: fakeDb(), scope: SCOPE, token: TOKEN },
      "conversations.history",
      { channel: "C0UNIT001" },
      { fetchImpl: impl }
    );

    // The negative control for the four statuses above: the status check refuses failures, and does
    // not simply refuse everything.
    expect(result.outcome).toBe("ok");
  });

  it.each([
    [Object.assign(new Error("timed out"), { name: "TimeoutError" }), "timeout"],
    [Object.assign(new Error("aborted"), { name: "AbortError" }), "aborted"],
    [new Error("socket hang up"), "network_error"],
  ])("reports a transport failure as a category, with no slot refund attempted", async (thrown, category) => {
    granted();
    const { impl } = fetchStub(() => {
      throw thrown;
    });

    const result = await slackReservedRequest(
      { db: fakeDb(), scope: SCOPE, token: TOKEN },
      "conversations.history",
      { channel: "C0UNIT001" },
      { fetchImpl: impl }
    );

    expect(result).toEqual({ outcome: "transport_error", method: "conversations.history", category });
    // Nothing tried to hand the slot back: the provider counted the request, and refunding it is how
    // a failing worker turns into an unmetered request loop.
    expect(extendSlackMethodBackoff).not.toHaveBeenCalled();
  });

  it("rejects a blank token without quoting it, and before any request", async () => {
    granted();
    const { impl, calls } = fetchStub(() => json({ ok: true }));

    for (const token of ["", "   ", null, undefined, 42]) {
      let thrown: unknown;
      try {
        await slackReservedRequest(
          { db: fakeDb(), scope: SCOPE, token: token as unknown as string },
          "auth.test",
          {},
          { fetchImpl: impl }
        );
      } catch (err) {
        thrown = err;
      }
      expect(thrown).toBeInstanceOf(TypeError);
      // The rejected value is the hazard, so the message is STATIC — asserted by identity across
      // every input rather than by "does not contain", which is unfalsifiable for the empty string.
      // A message quoting what it refused would copy a token into every log that records the throw.
      expect((thrown as Error).message).toBe(
        "slack page request: token must be a non-empty string. Its value is deliberately omitted " +
          "from this message."
      );
    }
    expect(calls).toHaveLength(0);
    expect(reserveSlackMethodSlot).not.toHaveBeenCalled();
  });
});

describe("budget policy — the pure half", () => {
  it("gives every supported method the conservative unknown-category interval", () => {
    for (const method of SLACK_BUDGETED_METHODS) {
      expect(slackMethodIntervalMs(method)).toBe(SLACK_UNKNOWN_CATEGORY_INTERVAL_MS);
    }
    // Unknown is never a permissive default: an unbudgeted method throws rather than defaulting to
    // an interval of zero.
    expect(() => slackMethodIntervalMs("chat.postMessage" as never)).toThrow(TypeError);
  });

  it("pages only the two methods that page", () => {
    expect(slackMethodPageLimit("conversations.history")).toBe(SLACK_UNKNOWN_CATEGORY_PAGE_LIMIT);
    expect(slackMethodPageLimit("conversations.replies")).toBe(SLACK_UNKNOWN_CATEGORY_PAGE_LIMIT);
    for (const method of ["auth.test", "bots.info", "conversations.info", "users.list"] as const) {
      expect(slackMethodPageLimit(method)).toBeNull();
    }
  });

  it("reads Retry-After as an integer count of SECONDS, and nothing else", () => {
    expect(readRetryAfterHeader("120")).toEqual({ kind: "delay", retryAfterMs: 120_000 });
    expect(readRetryAfterHeader(" 30 ")).toEqual({ kind: "delay", retryAfterMs: 30_000 });
    expect(readRetryAfterHeader("0")).toEqual({ kind: "delay", retryAfterMs: 0 });
    for (const header of [
      // RFC 9110 also allows an HTTP-date; accepting one would mean trusting a remote clock to
      // schedule our own requests, so it reads as unusable and takes the floor instead.
      "Wed, 21 Oct 2026 07:28:00 GMT",
      "12.5",
      "-5",
      "1e3",
      "",
      "   ",
      null,
      undefined,
      120 as unknown as string,
    ]) {
      expect(readRetryAfterHeader(header)).toEqual({ kind: "unreadable" });
    }
  });

  /**
   * A VALID cooldown keeps its full duration. There is no evidence that a genuine Slack cooldown is
   * under a day, so an upper clamp could only ever shorten a real one — and a request sent a day
   * early during a 48-hour cooldown is the failure that clamp would cause.
   */
  it("keeps a long but valid Retry-After at its full duration, leading zeros included", () => {
    expect(readRetryAfterHeader("172800")).toEqual({ kind: "delay", retryAfterMs: 172_800_000 });
    // Leading zeros are syntax, not magnitude: this is the SAME duration as the line above.
    expect(readRetryAfterHeader("0000172800")).toEqual({ kind: "delay", retryAfterMs: 172_800_000 });
    expect(usableBackoffMs(172_800_000)).toBe(172_800_000);
  });

  /**
   * A digits-only header too large to carry end to end is NOT malformed, and must not be quietly
   * downgraded to the 60-second fallback — that would schedule a request far earlier than the
   * provider permitted while looking like an ordinary cooldown. It is reported as its own state.
   */
  it("separates a digits-only but unrepresentable duration from a malformed one", () => {
    for (const header of ["9999999999999", "99999999999999999999"]) {
      expect(readRetryAfterHeader(header)).toEqual({ kind: "unrepresentable" });
    }
    expect(
      readRetryAfterHeader(String(SLACK_BACKOFF_REPRESENTABLE_MAX_MS / 1_000))
    ).toEqual({ kind: "delay", retryAfterMs: SLACK_BACKOFF_REPRESENTABLE_MAX_MS });
    expect(readRetryAfterHeader(String(SLACK_BACKOFF_REPRESENTABLE_MAX_MS / 1_000 + 1))).toEqual({
      kind: "unrepresentable",
    });
  });

  it("floors what it cannot read, and refuses to shorten what it cannot represent", () => {
    for (const unusable of [null, undefined, Number.NaN, Number.POSITIVE_INFINITY, 0, -1_000]) {
      expect(usableBackoffMs(unusable)).toBe(SLACK_BACKOFF_FLOOR_MS);
    }
    expect(usableBackoffMs(SLACK_BACKOFF_FLOOR_MS + 1)).toBe(SLACK_BACKOFF_FLOOR_MS + 1);
    expect(usableBackoffMs(120_000)).toBe(120_000);
    // Not the floor, and not a fabricated maximum: an explicit refusal, because both of those would
    // persist a deadline earlier than the one we were told to honour.
    for (const unrepresentable of [SLACK_BACKOFF_REPRESENTABLE_MAX_MS + 1, 1e300]) {
      expect(() => usableBackoffMs(unrepresentable)).toThrow(TypeError);
    }
  });
});
