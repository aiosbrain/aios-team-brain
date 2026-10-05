import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const stubs = vi.hoisted(() => ({
  claimDueSlackThread: vi.fn(), readSlackThreadSnapshot: vi.fn(), restartSlackThreadSnapshot: vi.fn(),
  writeSlackThreadSnapshot: vi.fn(), checkpointSlackThread: vi.fn(), releaseSlackThreadForRetry: vi.fn(),
  slackReservedRequest: vi.fn(), runContextTransaction: vi.fn(),
}));
vi.mock("@/lib/ingest/slack-thread-state", () => stubs);
vi.mock("@/lib/ingest/sources/slack-page-request", () => ({ slackReservedRequest: stubs.slackReservedRequest }));
vi.mock("@/lib/projects/context/transaction", () => ({ runContextTransaction: stubs.runContextTransaction }));

import { hydrateOneSlackThread } from "@/lib/ingest/slack-thread-hydrator";

const TEAM = "3f1a0b2c-4d5e-4f60-8a7b-9c0d1e2f3a4b";
const ROOT = "1718900000.000100";
const claim = { scope: { teamId: TEAM, workspaceId: "T0UNIT001", channelId: "C0UNIT001", rootTs: ROOT },
  leaseOwner: "owner", leaseGeneration: 1, leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
  attempts: 1, pageCursor: null, snapshotGeneration: 0 };
const input = { db: {} as never, teamId: TEAM, token: "synthetic-test-token",
  methodScope: { kind: "verified" as const, teamId: TEAM, workspaceId: "T0UNIT001", appId: "A0UNIT001" } };

beforeEach(() => {
  Object.values(stubs).forEach((stub) => stub.mockReset());
  stubs.claimDueSlackThread.mockResolvedValue(claim);
  stubs.writeSlackThreadSnapshot.mockResolvedValue("written");
  stubs.checkpointSlackThread.mockResolvedValue({ outcome: "checkpointed" });
  stubs.releaseSlackThreadForRetry.mockResolvedValue({ outcome: "released" });
  stubs.runContextTransaction.mockImplementation(async (_db, work) => work({}));
});

describe("inactive hydration failure decisions", () => {
  it("rejects its transaction when the snapshot writes but the checkpoint refuses", async () => {
    stubs.slackReservedRequest.mockResolvedValue({ outcome: "ok", page: {
      messages: [{ ts: ROOT, text: "root" }], hasMore: true, nextCursor: "page-2" } });
    stubs.checkpointSlackThread.mockResolvedValue({ outcome: "refused" });
    let completedTransactions = 0;
    let inTransaction = false;
    stubs.runContextTransaction.mockImplementation(async (_db, work) => {
      inTransaction = true;
      try { const result = await work({}); completedTransactions += 1; return result; }
      finally { inTransaction = false; }
    });
    stubs.slackReservedRequest.mockImplementation(async () => {
      expect(inTransaction).toBe(false);
      return { outcome: "ok", page: { messages: [{ ts: ROOT, text: "root" }], hasMore: true, nextCursor: "page-2" } };
    });
    expect(await hydrateOneSlackThread(input)).toEqual({ outcome: "refused", category: "stale_lease" });
    expect(stubs.writeSlackThreadSnapshot).toHaveBeenCalledTimes(1);
    expect(stubs.checkpointSlackThread).toHaveBeenCalledTimes(1);
    expect(completedTransactions).toBe(1); // claim committed; page transaction threw and rolled back
  });

  it("requeues, rather than throwing, when the database measures the snapshot over the cap", async () => {
    // AIO-1170 review P3-01: the DB bound is octet_length(messages::text), larger than the JSON.stringify count
    // the hydrator pre-checks, so the write itself can report `too_large` for a thread that passed the pre-check.
    // Uncaught, that reached the caller as a raw 23514 with the lease left to expire and every reclaim repeating it.
    stubs.slackReservedRequest.mockResolvedValue({ outcome: "ok", page: {
      messages: [{ ts: ROOT, text: "root" }], hasMore: false, nextCursor: null } });
    stubs.writeSlackThreadSnapshot.mockResolvedValue("too_large");
    expect(await hydrateOneSlackThread(input)).toEqual({ outcome: "failed", category: "snapshot_too_large" });
    expect(stubs.checkpointSlackThread).not.toHaveBeenCalled();
    expect(stubs.releaseSlackThreadForRetry.mock.calls[0][2].errorCode).toBe("snapshot_too_large");
  });

  it("resets a cursor with no matching staged body before refetching the root", async () => {
    const resumed = { ...claim, pageCursor: "page-2", snapshotGeneration: 1 };
    const restarted = { ...resumed, pageCursor: null, snapshotGeneration: 2 };
    stubs.claimDueSlackThread.mockResolvedValue(resumed);
    stubs.readSlackThreadSnapshot.mockResolvedValue(null);
    stubs.restartSlackThreadSnapshot.mockResolvedValue(restarted);
    stubs.slackReservedRequest.mockResolvedValue({ outcome: "ok", page: {
      messages: [{ ts: ROOT }], hasMore: false, nextCursor: null } });
    expect(await hydrateOneSlackThread(input)).toEqual({ outcome: "progressed" });
    expect(stubs.restartSlackThreadSnapshot).toHaveBeenCalledWith(expect.anything(), resumed);
    expect(stubs.slackReservedRequest.mock.calls[0][2]).toEqual({ channel: claim.scope.channelId, ts: ROOT });
    expect(stubs.writeSlackThreadSnapshot.mock.calls[0][1]).toEqual(restarted);
    expect(stubs.checkpointSlackThread.mock.calls[0][2].snapshotGeneration).toBe(3);
  });

  it("uses the provider deadline to release a deferred claim and keeps HTTP untouched", async () => {
    const deadline = new Date(Date.now() + 120_000).toISOString();
    stubs.slackReservedRequest.mockResolvedValue({ outcome: "deferred", nextPermittedAt: deadline });
    expect(await hydrateOneSlackThread(input)).toEqual({ outcome: "deferred", category: "deferred" });
    expect(stubs.writeSlackThreadSnapshot).not.toHaveBeenCalled();
    const release = stubs.releaseSlackThreadForRetry.mock.calls[0][2];
    expect(release.errorCode).toBe("deferred");
    expect(release.nextDueAt.getTime()).toBeGreaterThanOrEqual(new Date(deadline).getTime());
  });

  it("backs off auth refusal and does not stage an empty success", async () => {
    stubs.slackReservedRequest.mockResolvedValue({ outcome: "auth_error", category: "invalid_auth" });
    const before = Date.now();
    expect(await hydrateOneSlackThread(input)).toEqual({ outcome: "failed", category: "auth_error" });
    expect(stubs.writeSlackThreadSnapshot).not.toHaveBeenCalled();
    const release = stubs.releaseSlackThreadForRetry.mock.calls[0][2];
    expect(release.nextDueAt.getTime()).toBeGreaterThanOrEqual(before + 24 * 60 * 60_000);
  });

  it("invalidates a rejected provider cursor before queuing a fresh first page", async () => {
    const resumed = { ...claim, pageCursor: "bad-cursor", snapshotGeneration: 1 };
    const restarted = { ...resumed, pageCursor: null, snapshotGeneration: 2 };
    stubs.claimDueSlackThread.mockResolvedValue(resumed);
    stubs.readSlackThreadSnapshot.mockResolvedValue({ messages: [{ ts: ROOT }], seenCursors: ["bad-cursor"], complete: false });
    stubs.slackReservedRequest.mockResolvedValue({ outcome: "provider_error", category: "invalid_cursor" });
    stubs.restartSlackThreadSnapshot.mockResolvedValue(restarted);
    expect(await hydrateOneSlackThread(input)).toEqual({ outcome: "failed", category: "invalid_cursor" });
    expect(stubs.restartSlackThreadSnapshot).toHaveBeenCalledWith(expect.anything(), resumed);
    expect(stubs.releaseSlackThreadForRetry.mock.calls[0][1]).toEqual(restarted);
    expect(stubs.writeSlackThreadSnapshot).not.toHaveBeenCalled();
  });

  it("selects due work only in the verified workspace before any HTTP", async () => {
    const mismatched = { ...input, methodScope: { ...input.methodScope, workspaceId: "T0OTHER" } };
    stubs.claimDueSlackThread.mockResolvedValue(null);
    expect(await hydrateOneSlackThread(mismatched)).toEqual({ outcome: "idle" });
    expect(stubs.claimDueSlackThread.mock.calls[0][2]).toMatchObject({ workspaceId: "T0OTHER" });
    expect(stubs.slackReservedRequest).not.toHaveBeenCalled();
    expect(stubs.releaseSlackThreadForRetry).not.toHaveBeenCalled();
  });
});

/**
 * AIO-1170 replies transient backoff: five-minute-capped, jittered, driven by the claim's persisted
 * lifetime ordinal (`claim.attempts`), never by an in-process counter.
 *
 * The application clock is FROZEN here so every chosen delay is an exact number of milliseconds, and
 * the sampler is injected through `options.random` so each case names the sample it gets. What only a
 * database can show — the persisted ordinal, due-ness, the fence, staged-page preservation and expiry
 * restart — is pinned in `test/datamechanics/slack-thread-state.datamechanics.test.ts`.
 */
describe("inactive hydration transient backoff — exact jitter, taxonomy and sampler contract", () => {
  const FROZEN = Date.UTC(2026, 9, 5, 12, 0, 0);
  const NEAR_ONE = 1 - 2 ** -53; // the largest double below 1: the top of the sampler's range
  const FIVE_MINUTES = 300_000;
  const DAY = 24 * 60 * 60_000;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(FROZEN);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  type Call = Record<string, unknown>;
  const transport = (category: string): Call => ({ outcome: "transport_error", method: "conversations.replies", category });
  const provider = (category: string): Call => ({ outcome: "provider_error", method: "conversations.replies", category });

  /** One hydrator invocation against a mocked transport outcome, with the decision it made. */
  async function decide(call: Call, opts: { attempts?: unknown; sample?: unknown; claimOver?: Record<string, unknown> } = {}) {
    const claimed = { ...claim, attempts: "attempts" in opts ? opts.attempts : 1, ...opts.claimOver };
    stubs.claimDueSlackThread.mockResolvedValue(claimed);
    stubs.slackReservedRequest.mockResolvedValue(call);
    const sampler = vi.fn(() => ("sample" in opts ? opts.sample : 0) as number);
    const outcome = await hydrateOneSlackThread(input, { random: sampler } as never).then(
      (result) => ({ result, error: null as unknown }),
      (error: unknown) => ({ result: null, error })
    );
    const release = stubs.releaseSlackThreadForRetry.mock.calls[0]?.[2] as { nextDueAt: Date; errorCode: string } | undefined;
    return {
      ...outcome,
      claimed,
      release,
      releasedClaim: stubs.releaseSlackThreadForRetry.mock.calls[0]?.[1],
      delayMs: release ? release.nextDueAt.getTime() - FROZEN : null,
      sampler,
    };
  }

  function nothingStagedOrAdvanced(): void {
    expect(stubs.writeSlackThreadSnapshot).not.toHaveBeenCalled();
    expect(stubs.checkpointSlackThread).not.toHaveBeenCalled();
  }

  // Every transient class of the closed taxonomy, with the COARSE category it stores and returns.
  const TRANSIENT: [string, Call, string][] = [
    ["transport: network_error", transport("network_error"), "transport_error"],
    ["transport: timeout", transport("timeout"), "transport_error"],
    ["transport: aborted", transport("aborted"), "transport_error"],
    ["transport: a non-JSON 5xx (malformed_response_502)", transport("malformed_response_502"), "transport_error"],
    ["transport: a malformed 200 (malformed_response_200)", transport("malformed_response_200"), "transport_error"],
    ["transport: a diagnostic this module has never seen", transport("some_future_diagnostic"), "transport_error"],
    ["provider: http_500", provider("http_500"), "provider_error"],
    ["provider: http_503", provider("http_503"), "provider_error"],
    ["provider: http_599", provider("http_599"), "provider_error"],
    ["provider: ratelimited", provider("ratelimited"), "provider_error"],
    ["provider: internal_error", provider("internal_error"), "provider_error"],
    ["provider: service_unavailable", provider("service_unavailable"), "provider_error"],
    ["provider: fatal_error", provider("fatal_error"), "provider_error"],
    ["provider: request_timeout", provider("request_timeout"), "provider_error"],
  ];

  it.each(TRANSIENT)("TB-01 jitters %s and keeps the coarse stored and returned category", async (_name, call, coarse) => {
    const decision = await decide(call, { attempts: 1, sample: 0.5 });
    expect(decision.error).toBeNull();
    expect(decision.result).toEqual({ outcome: "failed", category: coarse });
    expect(decision.release?.errorCode).toBe(coarse);
    // Attempt 1, sample 0.5: the middle of [60s, 120s] — neither the old deterministic 60s nor the flat 5 minutes.
    expect(decision.delayMs).toBe(90_000);
    expect(decision.sampler).toHaveBeenCalledTimes(1);
    expect(decision.releasedClaim).toEqual(decision.claimed);
    expect(stubs.releaseSlackThreadForRetry).toHaveBeenCalledTimes(1);
    nothingStagedOrAdvanced();
    expect(stubs.restartSlackThreadSnapshot).not.toHaveBeenCalled();
  });

  // attempt → [r = 0, r = 0.5, r = 1 - 2^-53]
  const TABLE: [unknown, [number, number, number]][] = [
    [1, [60_000, 90_000, 120_000]],
    [2, [120_000, 180_000, 240_000]],
    [3, [150_000, 225_000, 300_000]],
    [6, [150_000, 225_000, 300_000]],
    [41, [150_000, 225_000, 300_000]],
    [Number.MAX_SAFE_INTEGER, [150_000, 225_000, 300_000]],
  ];

  it.each(TABLE)("TB-02 attempt %s maps samples 0, 0.5 and 1 - 2^-53 onto the exact inclusive band", async (attempts, expected) => {
    for (const call of [transport("network_error"), provider("http_503"), provider("ratelimited")]) {
      const delays: (number | null)[] = [];
      for (const sample of [0, 0.5, NEAR_ONE]) {
        stubs.releaseSlackThreadForRetry.mockClear();
        const decision = await decide(call, { attempts, sample });
        expect(decision.error).toBeNull();
        expect(decision.sampler).toHaveBeenCalledTimes(1);
        delays.push(decision.delayMs);
      }
      expect(delays, JSON.stringify(call)).toEqual(expected);
      // Jitter, not a fixed bound: the three samples are three different due times.
      expect(new Set(delays).size).toBe(3);
    }
  });

  it("TB-02 maps the unit interval onto EVERY integer of the inclusive band, endpoints included", async () => {
    // delay = lower + floor(r * (upper - lower + 1)). Attempt 1: lower 60_000, width 60_001.
    const WIDTH = 60_001;
    const cases: [number, number][] = [
      [0, 60_000],
      [0.5 / WIDTH, 60_000],
      [1.5 / WIDTH, 60_001],
      [30_000.5 / WIDTH, 90_000],
      [59_999.5 / WIDTH, 119_999],
      [60_000.5 / WIDTH, 120_000], // reachable only because the mapping is inclusive (`+ 1`)
      [NEAR_ONE, 120_000],
    ];
    for (const [sample, expected] of cases) {
      stubs.releaseSlackThreadForRetry.mockClear();
      expect((await decide(provider("http_500"), { attempts: 1, sample })).delayMs, `sample ${sample}`).toBe(expected);
    }
  });

  it("TB-02 repeated failures past the second claim never lengthen the delay beyond five minutes", async () => {
    for (const attempts of [3, 4, 7, 8, 64, 1_000_000, Number.MAX_SAFE_INTEGER]) {
      for (const call of [transport("timeout"), provider("http_502"), provider("internal_error")]) {
        stubs.releaseSlackThreadForRetry.mockClear();
        const top = await decide(call, { attempts, sample: NEAR_ONE });
        expect(top.delayMs, `attempt ${attempts}`).toBe(FIVE_MINUTES);
        stubs.releaseSlackThreadForRetry.mockClear();
        // …and the cap is still jittered: it is a band, not a fixed five minutes.
        expect((await decide(call, { attempts, sample: 0 })).delayMs, `attempt ${attempts}`).toBe(150_000);
      }
    }
  });

  it("TB-02 uses the claim it actually holds: a same-lease snapshot restart keeps the ordinal", async () => {
    const resumed = { ...claim, attempts: 2, pageCursor: "page-2", snapshotGeneration: 1 };
    const restarted = { ...resumed, pageCursor: null, snapshotGeneration: 2 };
    stubs.readSlackThreadSnapshot.mockResolvedValue(null);
    stubs.restartSlackThreadSnapshot.mockResolvedValue(restarted);
    const decision = await decide(transport("network_error"), { attempts: 2, sample: 0.5, claimOver: resumed });
    expect(decision.result).toEqual({ outcome: "failed", category: "transport_error" });
    expect(decision.releasedClaim).toEqual(restarted);
    expect(decision.delayMs).toBe(180_000);
    expect(decision.sampler).toHaveBeenCalledTimes(1);
    nothingStagedOrAdvanced();
  });

  it.each([[0], [-1], [1.5], [Number.NaN], [Number.POSITIVE_INFINITY], [Number.NEGATIVE_INFINITY], [2 ** 53], ["2"], [null], [undefined]])(
    "TB-02 rejects claim ordinal %s before sampling or releasing",
    async (attempts) => {
      const messages = new Set<string>();
      for (const call of [transport("network_error"), provider("http_503"), provider("service_unavailable")]) {
        stubs.releaseSlackThreadForRetry.mockClear();
        const decision = await decide(call, { attempts, sample: 0.5 });
        expect(decision.result, JSON.stringify(call)).toBeNull();
        expect(decision.error).toBeInstanceOf(TypeError);
        expect(decision.sampler).not.toHaveBeenCalled();
        expect(stubs.releaseSlackThreadForRetry).not.toHaveBeenCalled();
        nothingStagedOrAdvanced();
        messages.add(String((decision.error as Error).message));
      }
      // A static message: the rejected value is not clamped into a delay and not echoed into the error.
      expect(messages.size).toBe(1);
      for (const echoed of ["1.5", "-1", "Infinity", "NaN", "9007199254740992"]) expect([...messages][0]).not.toContain(echoed);
    }
  );

  // Flat five minutes, and the sampler is never consulted.
  const FLAT: string[] = [
    // not 5xx: the rule is exactly /^http_5[0-9]{2}$/ on the transport's sanitized category
    "http_499", "http_404", "http_400", "http_600", "http_50", "http_5000", "http_5xx", "xhttp_500", "http_500 ", "HTTP_500",
    // unknown, and reachability / refusal codes
    "provider_error", "channel_not_found", "not_in_channel", "is_archived", "restricted_action",
    "method_not_supported_for_channel_type", "thread_not_found", "message_not_found", "bot_not_found", "user_not_found",
    // near-misses of the five transient codes
    "RATELIMITED", "ratelimited_extra", "rate_limited", "internal", "timeout",
    // cursor codes WITHOUT a page cursor stay the generic provider failure
    "invalid_cursor", "pagination_not_available",
  ];

  it.each(FLAT.map((category) => [category]))("TB-01 keeps provider category %j on the flat five minutes with no sample", async (category) => {
    for (const attempts of [1, 2, 9]) {
      stubs.releaseSlackThreadForRetry.mockClear();
      const decision = await decide(provider(category), { attempts, sample: 0.25 });
      expect(decision.result).toEqual({ outcome: "failed", category: "provider_error" });
      expect(decision.release?.errorCode).toBe("provider_error");
      expect(decision.delayMs).toBe(FIVE_MINUTES);
      expect(decision.sampler).not.toHaveBeenCalled();
      nothingStagedOrAdvanced();
    }
  });

  it("TB-06 a provider deadline keeps its precedence and its minimum, and is never jittered or capped", async () => {
    const at = (offsetMs: number): string => new Date(FROZEN + offsetMs).toISOString();
    const cases: [Call, number, { outcome: string; category: string }][] = [
      // A future deadline beyond the five-minute transient cap is honoured exactly.
      [{ outcome: "rate_limited", category: "rate_limited", nextPermittedAt: at(600_000) }, 600_000, { outcome: "deferred", category: "rate_limited" }],
      [{ outcome: "rate_limited", category: "rate_limited", nextPermittedAt: at(3 * 60 * 60_000) }, 3 * 60 * 60_000, { outcome: "deferred", category: "rate_limited" }],
      // …and a near or past one is raised to the one-minute rate-limit minimum.
      [{ outcome: "rate_limited", category: "rate_limited", nextPermittedAt: at(10_000) }, 60_000, { outcome: "deferred", category: "rate_limited" }],
      [{ outcome: "rate_limited", category: "rate_limited", nextPermittedAt: at(-600_000) }, 60_000, { outcome: "deferred", category: "rate_limited" }],
      [{ outcome: "deferred", nextPermittedAt: at(420_000) }, 420_000, { outcome: "deferred", category: "deferred" }],
      [{ outcome: "deferred", nextPermittedAt: at(250) }, 1_000, { outcome: "deferred", category: "deferred" }],
      [{ outcome: "deferred", nextPermittedAt: at(-5_000) }, 1_000, { outcome: "deferred", category: "deferred" }],
    ];
    for (const [call, expected, result] of cases) {
      for (const attempts of [1, 2, 9]) {
        stubs.releaseSlackThreadForRetry.mockClear();
        const decision = await decide(call, { attempts, sample: 0.25 });
        expect(decision.result, JSON.stringify(call)).toEqual(result);
        expect(decision.release?.errorCode).toBe(result.category);
        expect(decision.delayMs, JSON.stringify(call)).toBe(expected);
        expect(decision.sampler).not.toHaveBeenCalled();
      }
    }
  });

  it("TB-06 an absent, empty or unparsable deadline uses the old deterministic fallback, never the jittered cap", async () => {
    for (const nextPermittedAt of [undefined, "", "not-a-date"]) {
      // rate_limited: min(1h, 60s * 2^min(n-1, 6)) — it grows past five minutes and tops out at one hour.
      const rateLimited: [number, number][] = [[1, 60_000], [2, 120_000], [3, 240_000], [4, 480_000], [6, 1_920_000], [7, 3_600_000], [8, 3_600_000], [500, 3_600_000]];
      for (const [attempts, expected] of rateLimited) {
        stubs.releaseSlackThreadForRetry.mockClear();
        const decision = await decide({ outcome: "rate_limited", category: "rate_limited", nextPermittedAt }, { attempts, sample: 0.25 });
        expect(decision.result).toEqual({ outcome: "deferred", category: "rate_limited" });
        expect(decision.delayMs, `rate_limited attempt ${attempts}, deadline ${JSON.stringify(nextPermittedAt)}`).toBe(expected);
        expect(decision.sampler).not.toHaveBeenCalled();
      }
      for (const attempts of [1, 2, 9]) {
        stubs.releaseSlackThreadForRetry.mockClear();
        const decision = await decide({ outcome: "deferred", nextPermittedAt }, { attempts, sample: 0.25 });
        expect(decision.result).toEqual({ outcome: "deferred", category: "deferred" });
        expect(decision.delayMs).toBe(FIVE_MINUTES);
        expect(decision.sampler).not.toHaveBeenCalled();
      }
    }
  });

  it("TB-06 body-level `ratelimited` is a transient provider failure with the short floor, unlike a rate_limited outcome", async () => {
    // HTTP 200 `{"ok":false,"error":"ratelimited"}` persists no provider cooldown, so it carries no deadline.
    const body = await decide(provider("ratelimited"), { attempts: 1, sample: 0 });
    expect(body.result).toEqual({ outcome: "failed", category: "provider_error" });
    expect(body.delayMs).toBe(60_000);
    expect(body.sampler).toHaveBeenCalledTimes(1);
    stubs.releaseSlackThreadForRetry.mockClear();
    const capped = await decide(provider("ratelimited"), { attempts: 7, sample: NEAR_ONE });
    expect(capped.delayMs).toBe(FIVE_MINUTES);
    stubs.releaseSlackThreadForRetry.mockClear();
    // The 429 outcome with no usable deadline is the deterministic fallback instead: one hour at attempt 7.
    const outcome = await decide({ outcome: "rate_limited", category: "rate_limited" }, { attempts: 7, sample: NEAR_ONE });
    expect(outcome.result).toEqual({ outcome: "deferred", category: "rate_limited" });
    expect(outcome.delayMs).toBe(3_600_000);
    expect(outcome.sampler).not.toHaveBeenCalled();
  });

  it.each([[0], [-1], [1.5], [Number.NaN], [Number.POSITIVE_INFINITY], [2 ** 53], ["2"]])(
    "TB-06 validates ordinal %s on the deterministic rate-limit fallback too",
    async (attempts) => {
      const decision = await decide({ outcome: "rate_limited", category: "rate_limited", nextPermittedAt: "" }, { attempts, sample: 0.25 });
      expect(decision.result).toBeNull();
      expect(decision.error).toBeInstanceOf(TypeError);
      expect(decision.sampler).not.toHaveBeenCalled();
      expect(stubs.releaseSlackThreadForRetry).not.toHaveBeenCalled();
    }
  );

  it("TB-06 never samples on auth, block, idle, success, a page fault or a cursor restart", async () => {
    for (const [call, category] of [
      [{ outcome: "auth_error", category: "invalid_auth" }, "auth_error"],
      [{ outcome: "blocked", category: "retry_after_unrepresentable" }, "blocked"],
    ] as [Call, string][]) {
      stubs.releaseSlackThreadForRetry.mockClear();
      const decision = await decide(call, { attempts: 9, sample: 0.25 });
      expect(decision.result).toEqual({ outcome: "failed", category });
      expect(decision.release?.errorCode).toBe(category);
      expect(decision.delayMs).toBe(DAY);
      expect(decision.sampler).not.toHaveBeenCalled();
    }

    // idle
    const sampler = vi.fn(() => 0.25);
    stubs.claimDueSlackThread.mockResolvedValue(null);
    expect(await hydrateOneSlackThread(input, { random: sampler } as never)).toEqual({ outcome: "idle" });
    expect(sampler).not.toHaveBeenCalled();

    // success
    stubs.releaseSlackThreadForRetry.mockClear();
    const ok = await decide({ outcome: "ok", page: { messages: [{ ts: ROOT, text: "root" }], hasMore: false, nextCursor: null } }, { attempts: 9, sample: 0.25 });
    expect(ok.result).toEqual({ outcome: "progressed" });
    expect(ok.sampler).not.toHaveBeenCalled();
    expect(stubs.releaseSlackThreadForRetry).not.toHaveBeenCalled();

    // a page/content fault keeps its own category and the flat five minutes
    stubs.writeSlackThreadSnapshot.mockClear();
    stubs.checkpointSlackThread.mockClear();
    const missingRoot = await decide({ outcome: "ok", page: { messages: [{ ts: "1718900001.000200" }], hasMore: false, nextCursor: null } }, { attempts: 9, sample: 0.25 });
    expect(missingRoot.result).toEqual({ outcome: "failed", category: "missing_root" });
    expect(missingRoot.delayMs).toBe(FIVE_MINUTES);
    expect(missingRoot.sampler).not.toHaveBeenCalled();

    // the cursor restart exception keeps its exact category, five minutes and no sample
    for (const category of ["invalid_cursor", "pagination_not_available"]) {
      stubs.releaseSlackThreadForRetry.mockClear();
      const resumed = { ...claim, attempts: 9, pageCursor: "bad-cursor", snapshotGeneration: 1 };
      const restarted = { ...resumed, pageCursor: null, snapshotGeneration: 2 };
      stubs.readSlackThreadSnapshot.mockResolvedValue({ messages: [{ ts: ROOT }], seenCursors: ["bad-cursor"], complete: false });
      stubs.restartSlackThreadSnapshot.mockResolvedValue(restarted);
      const decision = await decide(provider(category), { attempts: 9, sample: 0.25, claimOver: resumed });
      expect(decision.result).toEqual({ outcome: "failed", category });
      expect(decision.release?.errorCode).toBe(category);
      expect(decision.releasedClaim).toEqual(restarted);
      expect(decision.delayMs).toBe(FIVE_MINUTES);
      expect(decision.sampler).not.toHaveBeenCalled();
    }
  });

  it.each([
    ["NaN", Number.NaN],
    ["+Infinity", Number.POSITIVE_INFINITY],
    ["-Infinity", Number.NEGATIVE_INFINITY],
    ["a negative number", -0.000001],
    ["exactly 1", 1],
    ["more than 1", 1.5],
    ["a numeric string", "0.5"],
    ["null", null],
    ["undefined", undefined],
    ["an object", { valueOf: () => 0.5 }],
    ["a boolean", true],
  ])("TB-07 rejects a sample of %s without coercion, release or any later mutation", async (_name, sample) => {
    const messages = new Set<string>();
    for (const call of [transport("network_error"), provider("http_503"), provider("request_timeout")]) {
      for (const attempts of [1, 2, 9]) {
        stubs.releaseSlackThreadForRetry.mockClear();
        const decision = await decide(call, { attempts, sample });
        expect(decision.result, `${JSON.stringify(call)} attempt ${attempts}`).toBeNull();
        expect(decision.error).toBeInstanceOf(TypeError);
        // The sample WAS consumed — once — and then refused.
        expect(decision.sampler).toHaveBeenCalledTimes(1);
        expect(stubs.releaseSlackThreadForRetry).not.toHaveBeenCalled();
        expect(stubs.restartSlackThreadSnapshot).not.toHaveBeenCalled();
        nothingStagedOrAdvanced();
        messages.add(String((decision.error as Error).message));
      }
    }
    expect(messages.size).toBe(1);
    for (const echoed of ["1.5", "-0.000001", "Infinity", "NaN"]) expect([...messages][0]).not.toContain(echoed);
  });

  it("TB-07 propagates a throwing sampler without releasing the claim", async () => {
    const boom = new Error("sampler-fixture-failure");
    for (const call of [transport("network_error"), provider("http_500")]) {
      stubs.releaseSlackThreadForRetry.mockClear();
      stubs.claimDueSlackThread.mockResolvedValue({ ...claim, attempts: 2 });
      stubs.slackReservedRequest.mockResolvedValue(call);
      const sampler = vi.fn(() => {
        throw boom;
      });
      await expect(hydrateOneSlackThread(input, { random: sampler } as never)).rejects.toBe(boom);
      expect(sampler).toHaveBeenCalledTimes(1);
      expect(stubs.releaseSlackThreadForRetry).not.toHaveBeenCalled();
      nothingStagedOrAdvanced();
    }
  });

  it("TB-05 a transient retry refused by the fence is reported as refused — after exactly one sample", async () => {
    for (const call of [transport("network_error"), provider("http_503"), provider("ratelimited")]) {
      stubs.releaseSlackThreadForRetry.mockClear();
      stubs.releaseSlackThreadForRetry.mockResolvedValue({ outcome: "refused" });
      const decision = await decide(call, { attempts: 2, sample: 0.5 });
      // Never `failed`, `deferred` or `progressed`: the stale worker changed nothing.
      expect(decision.result, JSON.stringify(call)).toEqual({ outcome: "refused", category: "stale_lease" });
      expect(decision.delayMs).toBe(180_000);
      expect(decision.sampler).toHaveBeenCalledTimes(1);
      expect(stubs.releaseSlackThreadForRetry).toHaveBeenCalledTimes(1);
      nothingStagedOrAdvanced();
    }
  });

  it("TB-01 defaults to the platform sampler: with no injected sampler the delay still lies inside the band", async () => {
    const platform = vi.spyOn(Math, "random").mockReturnValue(0.5);
    try {
      for (const [call, coarse] of [[transport("network_error"), "transport_error"], [provider("http_503"), "provider_error"]] as [Call, string][]) {
        stubs.releaseSlackThreadForRetry.mockClear();
        platform.mockClear();
        stubs.claimDueSlackThread.mockResolvedValue({ ...claim, attempts: 2 });
        stubs.slackReservedRequest.mockResolvedValue(call);
        expect(await hydrateOneSlackThread(input)).toEqual({ outcome: "failed", category: coarse });
        const release = stubs.releaseSlackThreadForRetry.mock.calls[0][2];
        expect(release.nextDueAt.getTime() - FROZEN).toBe(180_000);
        expect(platform).toHaveBeenCalledTimes(1);
      }
    } finally {
      platform.mockRestore();
    }
  });
});
