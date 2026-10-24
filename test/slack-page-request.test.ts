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

const { reserveSlackMethodSlot, extendSlackMethodBackoff, markSlackMethodBlocked } = vi.hoisted(
  () => ({
    reserveSlackMethodSlot: vi.fn(),
    extendSlackMethodBackoff: vi.fn(),
    markSlackMethodBlocked: vi.fn(),
  })
);

vi.mock("@/lib/ingest/slack-method-budget", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/ingest/slack-method-budget")>();
  // The POLICY (intervals, page limit, Retry-After parsing) stays real — it is what the adapter
  // applies, and stubbing it would make the clamp assertions below vacuous.
  return { ...actual, reserveSlackMethodSlot, extendSlackMethodBackoff, markSlackMethodBlocked };
});

// Static, not dynamic: `vi.mock` is hoisted above every import in this file, so the adapter below
// already sees the stubbed budget functions.
import * as pageRequestModule from "@/lib/ingest/sources/slack-page-request";
import { slackReservedRequest } from "@/lib/ingest/sources/slack-page-request";
import { classifySlackCall, validateSlackHistoryPage } from "@/lib/ingest/slack-source-discovery";
import { validateSlackRepliesPage } from "@/lib/ingest/slack-thread-hydrator";

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

/** The default: the marker write succeeds and reports back the category it stored. */
function blockPersists() {
  markSlackMethodBlocked.mockResolvedValue({
    scope: SCOPE,
    method: "conversations.history",
    reason: "retry_after_unrepresentable",
  });
}

beforeEach(() => {
  events = [];
  reserveSlackMethodSlot.mockReset();
  extendSlackMethodBackoff.mockReset();
  markSlackMethodBlocked.mockReset();
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

  it.each(["true", null, 1])("refuses malformed has_more %s even with a continuation cursor", async (hasMore) => {
    granted();
    const { impl } = fetchStub(() =>
      json({
        ok: true,
        messages: [],
        has_more: hasMore,
        response_metadata: { next_cursor: "b2Zmc2V0OjE1" },
      })
    );

    const result = await slackReservedRequest(
      { db: fakeDb(), scope: SCOPE, token: TOKEN },
      "conversations.history",
      { channel: "C0UNIT001" },
      { fetchImpl: impl }
    );

    expect(result).toEqual({
      outcome: "transport_error",
      method: "conversations.history",
      category: "malformed_response_200",
    });
  });

  /**
   * AM-F3 RED EVIDENCE — STRICT RAW PAGINATION METADATA (accepted amendment
   * `aio1170-f3-accepted-amendment-20261022`, groups 1 to 4 of its required red evidence).
   *
   * `SlackPage.nextCursor` is `string | null` only after the RAW provider fields have been validated.
   * Today the private `readPage` reads any non-object `response_metadata`, and any non-string
   * `next_cursor`, as "no cursor", and keeps any string cursor as it is — so a missing or broken cursor
   * with `has_more` absent or false is what a history scan certifies as the end of the channel. A
   * malformed answer must instead be the existing static `transport_error` / `malformed_response_200`
   * outcome, which carries nothing it received.
   *
   * WHAT IS EXPECTED RED on the current source, and what is not:
   *  - RED: every row of the malformed metadata/cursor matrix, under each of `has_more` absent, false
   *    and true. Today each is an `ok` page.
   *  - RED: the U+00A0-only cursor and the over-bound non-BMP cursor.
   *  - PASSING NOW, as regression guards: the malformed `has_more` rows (the reader already refuses a
   *    present non-boolean), every valid control, both consistency contradictions, the precedence
   *    guards and the non-pagination controls.
   *
   * "Byte for byte" below means the identical UTF-16 code units, compared as UTF-8 bytes: neither
   * trimmed nor normalized.
   */
  const F3_CANARY = "xoxb-F3-CANARY-cursor-4b1d";
  const VALID_CURSOR = "dXNlcjpVMDYxTkZUVDI=/+_-.~";
  const LONGEST_CURSOR = "c".repeat(1024);
  /** 512 copies of one non-BMP character: 1,024 UTF-16 code units, 512 code points. */
  const LONGEST_NON_BMP_CURSOR = "\u{1F600}".repeat(512);

  async function readPageOf(method: "conversations.history" | "conversations.replies" | "auth.test" | "bots.info" | "conversations.info", body: Record<string, unknown>, status = 200) {
    granted();
    const { impl } = fetchStub(() => json(body, status));
    return slackReservedRequest({ db: fakeDb(), scope: SCOPE, token: TOKEN }, method, method === "auth.test" ? {} : { channel: "C0UNIT001" }, { fetchImpl: impl });
  }
  const readHistoryPage = (body: Record<string, unknown>) => readPageOf("conversations.history", body);
  const sameBytes = (a: string | null, b: string): boolean => a !== null && Buffer.from(a, "utf8").equals(Buffer.from(b, "utf8"));

  // ── group 1: valid controls ────────────────────────────────────────────────

  it.each<[string, Record<string, unknown>, { hasMore: boolean; nextCursor: string | null }]>([
    ["response_metadata absent", { ok: true, messages: [] }, { hasMore: false, nextCursor: null }],
    ["response_metadata an object without next_cursor", { ok: true, messages: [], response_metadata: {} }, { hasMore: false, nextCursor: null }],
    ["response_metadata carrying only warnings", { ok: true, messages: [], response_metadata: { warnings: ["superfluous_charset"] } }, { hasMore: false, nextCursor: null }],
    ["an empty next_cursor", { ok: true, messages: [], response_metadata: { next_cursor: "" } }, { hasMore: false, nextCursor: null }],
    ["a valid continuation cursor", { ok: true, messages: [], has_more: true, response_metadata: { next_cursor: VALID_CURSOR } }, { hasMore: true, nextCursor: VALID_CURSOR }],
    ["has_more false, kept", { ok: true, messages: [], has_more: false }, { hasMore: false, nextCursor: null }],
    ["has_more true, kept", { ok: true, messages: [], has_more: true, response_metadata: { next_cursor: VALID_CURSOR } }, { hasMore: true, nextCursor: VALID_CURSOR }],
  ])("F3 control: reads %s as a valid page", async (_label, body, page) => {
    const result = await readHistoryPage(body);
    expect(result).toMatchObject({ outcome: "ok", page });
  });

  // ── group 2: opaque strings, Unicode whitespace and the UTF-16 bound ──────

  it.each<[string, string]>([
    ["leading and trailing spaces", `  ${VALID_CURSOR}  `],
    ["a precomposed e-acute (NFC)", "café-cursor"],
    ["a decomposed e plus combining acute (NFD)", "café-cursor"],
    ["exactly 1,024 ASCII code units", LONGEST_CURSOR],
    ["exactly 1,024 UTF-16 code units of non-BMP characters", LONGEST_NON_BMP_CURSOR],
  ])("F3 control: keeps a cursor with %s byte for byte", async (_label, cursor) => {
    const result = await readHistoryPage({ ok: true, messages: [], has_more: true, response_metadata: { next_cursor: cursor } });
    expect(result.outcome).toBe("ok");
    if (result.outcome !== "ok") return;
    expect(sameBytes(result.page.nextCursor, cursor)).toBe(true);
    expect(result.page.nextCursor?.length).toBe(cursor.length);
  });

  it("F3 control: the NFC and NFD cursors stay DISTINCT — neither is normalized into the other", async () => {
    const nfc = await readHistoryPage({ ok: true, messages: [], has_more: true, response_metadata: { next_cursor: "café-cursor" } });
    const nfd = await readHistoryPage({ ok: true, messages: [], has_more: true, response_metadata: { next_cursor: "café-cursor" } });
    if (nfc.outcome !== "ok" || nfd.outcome !== "ok") throw new Error("fixture: both cursors must be valid pages");
    expect(nfc.page.nextCursor).not.toBe(nfd.page.nextCursor);
    expect(nfc.page.nextCursor?.normalize("NFC")).toBe(nfd.page.nextCursor?.normalize("NFC"));
  });

  it("F3 fixture: the boundary cursors have the lengths the contract counts in", () => {
    expect([LONGEST_CURSOR.length, LONGEST_NON_BMP_CURSOR.length, [...LONGEST_NON_BMP_CURSOR].length]).toEqual([1024, 1024, 512]);
    expect(["  ".trim().length, `${LONGEST_NON_BMP_CURSOR}c`.length]).toEqual([0, 1025]);
  });

  // ── group 1 and 2: the malformed matrix, under each has_more ──────────────

  /** Every malformed metadata container and cursor value the amendment names. */
  const MALFORMED_METADATA: [string, unknown][] = [
    ["response_metadata null", null],
    ["response_metadata an array", [{ next_cursor: VALID_CURSOR }]],
    ["response_metadata a string", F3_CANARY],
    ["response_metadata a number", 7],
    ["response_metadata a boolean", true],
    ["next_cursor null", { next_cursor: null }],
    ["next_cursor a number", { next_cursor: 7 }],
    ["next_cursor a boolean", { next_cursor: false }],
    ["next_cursor an array", { next_cursor: [VALID_CURSOR] }],
    ["next_cursor an object", { next_cursor: { cursor: F3_CANARY } }],
    ["an ASCII whitespace-only cursor", { next_cursor: " \t " }],
    ["a U+00A0 whitespace-only cursor", { next_cursor: "  " }],
    ["a cursor of 1,025 ASCII code units", { next_cursor: `${LONGEST_CURSOR}c` }],
    ["a cursor of 1,025 UTF-16 code units with non-BMP characters", { next_cursor: `${LONGEST_NON_BMP_CURSOR}c` }],
    ["a cursor carrying a NUL", { next_cursor: `${F3_CANARY}\u0000` }],
    ["a cursor carrying a newline", { next_cursor: `${F3_CANARY}\n` }],
    ["a cursor carrying a unit separator", { next_cursor: `${F3_CANARY}\u001f` }],
    ["a cursor carrying DEL", { next_cursor: `${F3_CANARY}\u007f` }],
  ];
  const HAS_MORE: [string, Record<string, unknown>][] = [
    ["has_more absent", {}],
    ["has_more false", { has_more: false }],
    ["has_more true", { has_more: true }],
  ];
  const MATRIX = MALFORMED_METADATA.flatMap(([shape, metadata]) =>
    HAS_MORE.map(([flag, fields]) => [`${shape}, ${flag}`, { ...fields, response_metadata: metadata }] as [string, Record<string, unknown>])
  );

  it.each(MATRIX)("F3 RED: refuses %s as the static malformed_response transport error, quoting nothing", async (_label, fields) => {
    const result = await readHistoryPage({ ok: true, messages: [{ ts: "1718900000.000100" }], ...fields });
    // Exact equality: no page, no body, and no copy of the canary or of anything else it received.
    expect(result).toEqual({ outcome: "transport_error", method: "conversations.history", category: "malformed_response_200" });
    expect(JSON.stringify(result)).not.toContain(F3_CANARY);
  });

  it.each<[string, unknown]>([
    ["the string false", "false"],
    ["zero", 0],
    ["an object", {}],
    ["null", null],
  ])("F3 regression guard (passes now): refuses has_more as %s", async (_label, hasMore) => {
    const result = await readHistoryPage({ ok: true, messages: [], has_more: hasMore });
    expect(result).toEqual({ outcome: "transport_error", method: "conversations.history", category: "malformed_response_200" });
  });

  it("F3 RED: the replies method reads through the same strict reader", async () => {
    const result = await readPageOf("conversations.replies", { ok: true, messages: [{ ts: "1718900000.000100" }], has_more: false, response_metadata: { next_cursor: 7 } });
    expect(result).toEqual({ outcome: "transport_error", method: "conversations.replies", category: "malformed_response_200" });
  });

  // ── group 1: both consistency contradictions stay the CALLER's refusal ────

  it("F3 control: a well-formed contradiction is a valid transport page, refused as pagination_incomplete by both callers", async () => {
    const noCursor = await readHistoryPage({ ok: true, messages: [{ ts: "1718900000.000100" }], has_more: true });
    const liveCursor = await readHistoryPage({ ok: true, messages: [{ ts: "1718900000.000100" }], has_more: false, response_metadata: { next_cursor: VALID_CURSOR } });
    if (noCursor.outcome !== "ok" || liveCursor.outcome !== "ok") throw new Error("fixture: both contradictions are well-formed pages");
    expect([noCursor.page, liveCursor.page].map((page) => validateSlackHistoryPage(page, { sentCursor: null }))).toEqual([
      { ok: false, category: "pagination_incomplete" }, { ok: false, category: "pagination_incomplete" },
    ]);
    expect([noCursor.page, liveCursor.page].map((page) => validateSlackRepliesPage(page, "1718900000.000100", null))).toEqual([
      { ok: false, category: "pagination_incomplete" }, { ok: false, category: "pagination_incomplete" },
    ]);
  });

  // ── group 3: response precedence is unchanged by malformed metadata ───────

  it("F3 regression guard (passes now): a 429 carrying malformed metadata is still rate_limited, with its cooldown persisted", async () => {
    granted();
    extendSlackMethodBackoff.mockResolvedValue({ scope: SCOPE, method: "conversations.history", nextPermittedAt: NEXT, retryAfterMs: 30_000 });
    const { impl } = fetchStub(() => json({ ok: true, messages: [], response_metadata: { next_cursor: 7 } }, 429, { "retry-after": "30" }));
    const result = await slackReservedRequest({ db: fakeDb(), scope: SCOPE, token: TOKEN }, "conversations.history", { channel: "C0UNIT001" }, { fetchImpl: impl });
    expect(result).toEqual({ outcome: "rate_limited", method: "conversations.history", category: "rate_limited", nextPermittedAt: NEXT, retryAfterMs: 30_000 });
    expect(extendSlackMethodBackoff).toHaveBeenCalledTimes(1);
  });

  it.each<[string, number, Record<string, unknown>, unknown, ReturnType<typeof classifySlackCall>]>([
    ["ok:false invalid_cursor", 200, { ok: false, error: "invalid_cursor", response_metadata: null },
      { outcome: "provider_error", method: "conversations.history", category: "invalid_cursor" }, { kind: "refused", category: "invalid_cursor" }],
    ["an HTTP 503", 503, { ok: true, messages: [], response_metadata: { next_cursor: 7 } },
      { outcome: "provider_error", method: "conversations.history", category: "http_503" }, { kind: "transient", category: "http_503" }],
    ["an auth error", 200, { ok: false, error: "invalid_auth", response_metadata: [F3_CANARY] },
      { outcome: "auth_error", method: "conversations.history", category: "invalid_auth" }, { kind: "blocked", category: "invalid_auth" }],
  ])("F3 regression guard (passes now): %s carrying malformed metadata keeps its own outcome and recovery category", async (_label, status, body, outcome, disposition) => {
    const result = await readPageOf("conversations.history", body, status);
    expect(result).toEqual(outcome);
    // The recovery a source takes is decided by this disposition: `invalid_cursor` restarts the scan,
    // a 5xx is a blip, an auth error blocks. Malformed metadata must not turn any of them into a
    // malformed-response transport error.
    expect(classifySlackCall(result)).toEqual(disposition);
    expect(JSON.stringify(result)).not.toContain(F3_CANARY);
  });

  // ── group 4: non-pagination methods share the reader ──────────────────────

  it.each<[string, "auth.test" | "bots.info" | "conversations.info", Record<string, unknown>]>([
    ["auth.test", "auth.test", { ok: true, team_id: "T0UNIT001", user_id: "U0UNIT001", bot_id: "B0UNIT001" }],
    ["bots.info", "bots.info", { ok: true, bot: { id: "B0UNIT001", app_id: "A0UNIT001" } }],
    ["conversations.info", "conversations.info", { ok: true, channel: { id: "C0UNIT001", is_channel: true, is_private: false } }],
  ])("F3 control (passes now, must keep passing): %s succeeds with absent and with warning-only metadata", async (_label, method, body) => {
    for (const metadata of [{}, { response_metadata: { warnings: ["missing_charset"] } }]) {
      const result = await readPageOf(method, { ...body, ...metadata });
      expect(result).toMatchObject({ outcome: "ok", method, page: { hasMore: false, nextCursor: null } });
      if (result.outcome === "ok") expect("messages" in result.page).toBe(false);
    }
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

/**
 * AIO-1170 pre-activation correction PA-1 — `beforeSend`, the one point between "the slot is
 * granted" and "the request leaves".
 *
 * A caller that must commit something BECAUSE a request is going out (the metadata stage opens its
 * ordering attempt there) cannot do it before the reservation, since a deferred or blocked
 * reservation sends nothing; and it cannot do it after the fetch, since the write has to be durable
 * before an answer can come back. The hook is that point, and its contract is three sentences: it
 * runs only for a GRANTED reservation, it has FINISHED before the request leaves, and if it throws
 * there is no request and no result — the promise rejects.
 *
 * WHAT THIS DOES NOT PROVE: that any stage passes one. The metadata call site is pinned against real
 * Postgres in `test/datamechanics/slack-source-fences.datamechanics.test.ts`; this file can only say
 * what the transport does with a hook it is given.
 */
describe("slackReservedRequest — beforeSend runs between the grant and the request", () => {
  it("finishes the hook AFTER the reservation commits and BEFORE the request leaves", async () => {
    granted();
    const { impl, calls } = fetchStub(() => json({ ok: true, channel: { id: "C0UNIT001" } }));
    const beforeSend = vi.fn(async () => {
      events.push("hook:start");
      // A real hook is a short transaction of its own, so it settles on a LATER turn of the event
      // loop. A transport that called it without awaiting it would have fetched by then.
      await new Promise((resolve) => setTimeout(resolve, 0));
      events.push("hook:end");
    });

    const result = await slackReservedRequest(
      { db: fakeDb(), scope: SCOPE, token: TOKEN },
      "conversations.info",
      { channel: "C0UNIT001" },
      { fetchImpl: impl, beforeSend }
    );

    expect(events).toEqual(["commit", "hook:start", "hook:end", "fetch"]);
    expect(beforeSend).toHaveBeenCalledTimes(1);
    expect(calls).toHaveLength(1);
    expect(result.outcome).toBe("ok");
  });

  it("sends nothing and REJECTS with the hook's own failure, leaving the slot consumed", async () => {
    granted();
    const abort = new Error("the row this request was about is gone");
    const { impl, calls } = fetchStub(() => {
      throw new Error("an aborted send must never reach the network");
    });

    // ⚠️ REJECTS, by identity. There is deliberately no `aborted` variant of `SlackRequestResult`:
    // every variant is something a source may classify and carry on from, and a caller's own hook
    // failing is not one of those — reported as a transport error it would read as a blip.
    await expect(
      slackReservedRequest(
        { db: fakeDb(), scope: SCOPE, token: TOKEN },
        "conversations.info",
        { channel: "C0UNIT001" },
        {
          fetchImpl: impl,
          beforeSend: async () => {
            events.push("hook");
            throw abort;
          },
        }
      )
    ).rejects.toBe(abort);

    expect(calls).toHaveLength(0);
    // ONE commit — the reservation's — and nothing after the hook: no second transaction that could
    // hand the slot back, and no cooldown or block written for a request that was never made.
    expect(events).toEqual(["commit", "hook"]);
    expect(reserveSlackMethodSlot).toHaveBeenCalledTimes(1);
    expect(extendSlackMethodBackoff).not.toHaveBeenCalled();
    expect(markSlackMethodBlocked).not.toHaveBeenCalled();
  });

  it("runs the hook for a GRANTED reservation only", async () => {
    const beforeSend = vi.fn(async () => {});
    const { impl, calls } = fetchStub(() => json({ ok: true, channel: { id: "C0UNIT001" } }));
    const send = () =>
      slackReservedRequest(
        { db: fakeDb(), scope: SCOPE, token: TOKEN },
        "conversations.info",
        { channel: "C0UNIT001" },
        { fetchImpl: impl, beforeSend }
      );

    reserveSlackMethodSlot.mockResolvedValueOnce({
      outcome: "deferred",
      scope: SCOPE,
      method: "conversations.info",
      nextPermittedAt: NEXT,
      retryAfterMs: 42_000,
    });
    expect((await send()).outcome).toBe("deferred");
    reserveSlackMethodSlot.mockResolvedValueOnce({
      outcome: "blocked",
      scope: SCOPE,
      method: "conversations.info",
      reason: "retry_after_unrepresentable",
    });
    expect((await send()).outcome).toBe("blocked");

    // Neither denial sends anything, so neither may let the caller commit anything on its behalf.
    expect(beforeSend).not.toHaveBeenCalled();
    expect(calls).toHaveLength(0);

    // The positive control, on the SAME spy: "never called" above cannot be satisfied by a transport
    // that simply ignores the hook.
    granted();
    expect((await send()).outcome).toBe("ok");
    expect(beforeSend).toHaveBeenCalledTimes(1);
    expect(calls).toHaveLength(1);
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
   *
   * ⚠️ WHAT REPLACED "persists nothing". Returning blocked WITHOUT storing it left the bucket holding
   * only the reservation's own 60-second deadline, so any other caller of the same method bucket —
   * this is a provider allowance shared by every process, not per-worker state — was free to request
   * again once that minute passed. The marker is therefore persisted BEFORE this returns, and still
   * no date is fabricated: no cooldown timestamp, and no retry-at on the result.
   */
  it("persists the block BEFORE reporting it, and fabricates no retry-at", async () => {
    granted();
    blockPersists();
    const { impl } = fetchStub(
      () => new Response("", { status: 429, headers: { "retry-after": "99999999999999999999" } })
    );

    const result = await slackReservedRequest(
      { db: fakeDb(), scope: SCOPE, token: TOKEN },
      "conversations.history",
      {},
      { fetchImpl: impl }
    );

    expect(markSlackMethodBlocked).toHaveBeenCalledWith(
      expect.anything(),
      SCOPE,
      "conversations.history",
      "retry_after_unrepresentable"
    );
    // The category is the reason the WRITER read back, not one this adapter decided on its own.
    expect(result).toEqual({
      outcome: "blocked",
      method: "conversations.history",
      category: "retry_after_unrepresentable",
    });
    // No invented date, in either shape: no ordinary cooldown write, and no retry-at to schedule on.
    expect(extendSlackMethodBackoff).not.toHaveBeenCalled();
    expect("nextPermittedAt" in result).toBe(false);
    expect("retryAfterMs" in result).toBe(false);
    // The marker's transaction COMMITTED before the result existed — two commits, one fetch. Without
    // this the write could be in flight while a caller already treats the bucket as blocked.
    expect(events).toEqual(["commit", "fetch", "commit"]);
  });

  /**
   * The DB failure asymmetry, on the blocked path. A swallowed marker write would report a blocked
   * configuration that nothing recorded — so the next caller of this shared bucket would go back to
   * the provider the moment the reservation's own minute elapsed, which is exactly the hole the
   * marker exists to close.
   */
  it("surfaces a failure to persist the block, never a blocked result", async () => {
    granted();
    const dbFailure = new Error("connection terminated unexpectedly");
    markSlackMethodBlocked.mockRejectedValue(dbFailure);
    const { impl } = fetchStub(
      () => new Response("", { status: 429, headers: { "retry-after": "99999999999999999999" } })
    );

    await expect(
      slackReservedRequest({ db: fakeDb(), scope: SCOPE, token: TOKEN }, "conversations.history", {}, {
        fetchImpl: impl,
      })
    ).rejects.toBe(dbFailure);
    expect(extendSlackMethodBackoff).not.toHaveBeenCalled();
  });

  /**
   * The other half of the same contract, and the reason the marker is durable at all: a caller that
   * finds the bucket ALREADY blocked sends nothing. This is the process that did not see the 429 —
   * a later validation pass, a cleanup, another worker — and no elapsed deadline releases it.
   */
  it("sends zero requests when the bucket is already blocked, and promises no retry time", async () => {
    reserveSlackMethodSlot.mockResolvedValue({
      outcome: "blocked",
      scope: SCOPE,
      method: "conversations.history",
      reason: "retry_after_unrepresentable",
    });
    const { impl, calls } = fetchStub(() => {
      throw new Error("a blocked bucket must never reach the network");
    });

    const result = await slackReservedRequest(
      { db: fakeDb(), scope: SCOPE, token: TOKEN },
      "conversations.history",
      { channel: "C0UNIT001" },
      { fetchImpl: impl }
    );

    expect(result).toEqual({
      outcome: "blocked",
      method: "conversations.history",
      category: "retry_after_unrepresentable",
    });
    expect(calls).toHaveLength(0);
    expect(events).toEqual(["commit"]);
    // A blocked bucket needs an operator, so there is nothing to schedule on — and no second write
    // that could quietly re-date the block it just read.
    expect("nextPermittedAt" in result).toBe(false);
    expect("retryAfterMs" in result).toBe(false);
    expect(markSlackMethodBlocked).not.toHaveBeenCalled();
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
    // …and a transient fault is not written down as a blocked configuration: that marker has no
    // automatic clearing path, so recording one here would need an operator to undo a timeout.
    expect(markSlackMethodBlocked).not.toHaveBeenCalled();
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

/**
 * AIO-1170 final full-contract review — the transport and the classifier, COMPOSED.
 *
 * Each half is right on its own terms and wrong together. The transport reports a failed HTTP status
 * by the body's error name when it recognises one, and by `http_<status>` when it does not; the
 * classifier treats a provider error as a passing fault only if its NAME is on a short list. So a
 * readable 500/502/503 whose body carries no error, an unrecognised one, a claim of `ok`, or even a
 * credential error name comes out as a stated refusal — and a source acts on refusals: bootstrap
 * blocks until someone edits the config, and a metadata recheck writes `unverifiable` over a valid
 * public proof. The contract is the other way round: a 5xx is the PROVIDER failing, so nothing its
 * body says about this request is a verdict.
 *
 * `classifySlackCall` is imported from the discovery module on purpose: this is the pairing a
 * source actually runs, and neither unit suite alone can see it.
 */
describe("slackReservedRequest × classifySlackCall — an HTTP 5xx is a blip, whatever its body says", () => {
  const ask = async (status: number, body: unknown) => {
    granted();
    const { impl } = fetchStub(() => json(body, status));
    const result = await slackReservedRequest(
      { db: fakeDb(), scope: SCOPE, token: TOKEN },
      "conversations.info",
      { channel: "C0UNIT001" },
      { fetchImpl: impl }
    );
    return { result, disposition: classifySlackCall(result) };
  };

  it.each([
    { status: 500, shape: "no error field", body: { ok: false } },
    { status: 502, shape: "an unrecognised error name", body: { ok: false, error: "upstream_gateway_fault" } },
    { status: 503, shape: "a body that claims ok", body: { ok: true, channel: { id: "C0UNIT001" } } },
    { status: 500, shape: "a credential error name", body: { ok: false, error: "invalid_auth" } },
    { status: 503, shape: "a reachability error name", body: { ok: false, error: "channel_not_found" } },
  ])("treats HTTP $status with $shape as transient", async ({ status, body }) => {
    const { result, disposition } = await ask(status, body);

    // Worth trying again later — not a refusal about this request, and not a blocked credential.
    expect(disposition.kind).toBe("transient");
    // …and still never a success: a 5xx carries no page and no body, whatever it claimed.
    expect(result.outcome).not.toBe("ok");
    expect("page" in result).toBe(false);
    // The category stays a sanitized code: remote text is not echoed on the way through.
    expect(JSON.stringify(disposition)).not.toContain("upstream_gateway_fault");
  });

  // THE CONTROLS. Below 500 the provider ANSWERED, and what it said about this request stands: a
  // credential refusal still needs an operator and a stated refusal is still a refusal. Without
  // these, "everything that fails is transient" would satisfy the block above.
  it.each([
    { status: 200, body: { ok: false, error: "invalid_auth" }, kind: "blocked", category: "invalid_auth" },
    { status: 401, body: { ok: false, error: "token_revoked" }, kind: "blocked", category: "token_revoked" },
    { status: 403, body: { ok: false, error: "missing_scope" }, kind: "blocked", category: "missing_scope" },
    { status: 200, body: { ok: false, error: "channel_not_found" }, kind: "refused", category: "channel_not_found" },
    { status: 404, body: { ok: true }, kind: "refused", category: "http_404" },
  ])("still classifies HTTP $status $category as $kind (control)", async ({ status, body, kind, category }) => {
    const { disposition } = await ask(status, body);
    expect(disposition).toMatchObject({ kind, category });
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
