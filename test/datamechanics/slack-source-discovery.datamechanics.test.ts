import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { TransactionSession } from "@/lib/db/types";
import { claimSlackThread, checkpointSlackThread } from "@/lib/ingest/slack-thread-state";
import { discoverSlackSource, type SlackSourceDiscoveryResult } from "@/lib/ingest/slack-source-discovery";
import { transactionCapability } from "@/lib/projects/context/transaction";
import { db, seedTeam, transactionSessionDecoratedDb, type Seed } from "./helpers";
import {
  authTestBody,
  channelInfoBody,
  channelRow,
  closeRawSql,
  elapse,
  expireChannelLease,
  fakeSlack,
  historyBody,
  rawSql,
  requireSlackSourceTables,
  rootMessage,
  seedSlackIntegration,
  setSlackChannelIds,
  slackJson,
  threadRootTs,
  threadRows,
  type SlackCall,
  type SlackFake,
  type SlackHandler,
} from "./slack-source-helpers";

/**
 * AIO-1170 — ONE budgeted history page becoming durable roots and a frontier, against real Postgres.
 *
 * The failure modes only a real database and a real second connection can show:
 *
 *  1. THE ROOTS AND THE FRONTIER ARE ONE COMMIT. A failure between them must leave neither — and an
 *     in-memory fake would happily keep the half that already "wrote".
 *  2. A REFUSAL WRITES NOTHING. Every fence (owner, generation, expiry, lane, scan generation,
 *     cursor, binding revision) is re-checked at the DATABASE while the row is locked, so a page
 *     whose world changed during the request enqueues no roots and advances no cursor.
 *  3. NO DB TRANSACTION CROSSES THE NETWORK. Asserted from inside the injected fetch with
 *     `for update nowait` on a separate connection: an app-held row lock would raise 55P03 there.
 *  4. PROGRESS IS NOT CERTIFICATION. A partial page moves a cursor; only a genuinely terminal page
 *     moves the completed interval. Nothing about that distinction is visible from a call site.
 *  5. THE NEWEST-LANE SEAM HAS A MARGIN (pre-activation correction PA-3). The anchor a scan freezes
 *     is the DATABASE's clock and a message's `ts` is the PROVIDER's, so a catch-up that starts
 *     exactly on the previous anchor is one message wide against a clock that is not ours. Only a
 *     provider that serves by the request's own bounds can show what that loses.
 */

const WORKSPACE = "T0SOURCE1";
const CHANNEL = "C0SOURCE1";
const TOKEN = "xoxb-synthetic-not-a-real-token";
const APP = "A0SOURCE1";

beforeAll(requireSlackSourceTables);
afterAll(closeRawSql);

function discover(
  seed: Seed,
  integrationId: string,
  fake: SlackFake,
  over: { client?: ReturnType<typeof db>; maxRequests?: number; skewAllowanceMs?: number } = {}
): Promise<SlackSourceDiscoveryResult> {
  return discoverSlackSource(
    { db: over.client ?? db(), teamId: seed.teamId, integrationId },
    {
      fetchImpl: fake.impl,
      envToken: () => null,
      maxRequests: over.maxRequests,
      skewAllowanceMs: over.skewAllowanceMs,
    }
  );
}

/** auth.test + conversations.info answered; the history handler is the test's own subject. */
function pass(history: SlackHandler): SlackFake {
  return fakeSlack({
    "auth.test": () => slackJson(authTestBody({ app_id: APP })),
    "conversations.info": (call) => slackJson(channelInfoBody(call.params.get("channel") ?? "")),
    "conversations.history": history,
  });
}

/** A catch-up (newest, non-seed) request is the one that carries a lower bound. */
function isCatchUp(call: SlackCall): boolean {
  return call.params.get("oldest") !== null;
}

/** The lane the CURRENT lease owns, read while the request is in flight. */
async function laneInFlight(teamId: string): Promise<string | null> {
  const c = await rawSql();
  const { rows } = await c.query<{ claimed_lane: string | null }>(
    `select claimed_lane from slack_sync_channels where team_id = $1`,
    [teamId]
  );
  return rows[0]?.claimed_lane ?? null;
}

function tx<T>(fn: (session: TransactionSession) => Promise<T>): Promise<T> {
  return transactionCapability(db()).transaction(fn);
}

async function setup(seed: Seed, channelIds: readonly string[] = [CHANNEL]): Promise<string> {
  return seedSlackIntegration(seed, { channelIds, token: TOKEN });
}

/** The newest-lane skew allowance's default, STATED rather than imported: a changed constant must fail here. */
const DEFAULT_SKEW_ALLOWANCE_MS = 60_000;
const SIX_DIGIT_TS = /^[0-9]+[.][0-9]{6}$/;
const MICROS_PER_SECOND = BigInt(1_000_000);

function msToMicros(ms: number): bigint {
  return BigInt(ms) * BigInt(1_000);
}

/** A six-digit Slack `ts` as whole microseconds. Integers only — a float cannot hold one exactly. */
function tsMicros(ts: string): bigint {
  const match = /^([0-9]+)[.]([0-9]{6})$/.exec(ts);
  if (!match) throw new Error(`fixture: ${JSON.stringify(ts)} is not a six-digit Slack timestamp`);
  return BigInt(match[1]) * MICROS_PER_SECOND + BigInt(match[2]);
}

/**
 * The test's OWN arithmetic for "this instant, moved by that much": six digits, clamped at zero. It
 * is deliberately not the product's helper — an oracle borrowed from the code under test agrees
 * with it by construction.
 */
function shiftTs(ts: string, deltaMicros: bigint): string {
  const shifted = tsMicros(ts) + deltaMicros;
  const clamped = shifted < BigInt(0) ? BigInt(0) : shifted;
  return `${clamped / MICROS_PER_SECOND}.${String(clamped % MICROS_PER_SECOND).padStart(6, "0")}`;
}

/**
 * AIO-1170 §9.1 FIXTURE RULE: a request's own exact bounds, with integer arithmetic only. `latest` is
 * required and an omitted (historical) `oldest` is zero. A malformed or empty window fails the
 * fixture; there is no wall-clock fallback.
 */
function requestWindow(call: SlackCall): { lower: bigint; upper: bigint } {
  const latest = call.params.get("latest");
  if (latest === null) throw new Error("fixture: a history request without latest");
  const oldest = call.params.get("oldest");
  const window = { lower: oldest === null ? BigInt(0) : tsMicros(oldest), upper: tsMicros(latest) };
  if (window.lower > window.upper) throw new Error("fixture: an empty history request window");
  return window;
}
/** The §9.1 ordinary one-root replacement: a root at the request's own U. */
function rootAtUpper(call: SlackCall): string {
  return shiftTs("0.000000", requestWindow(call).upper);
}
/** True when `ts` lies inside the request's inclusive [S, U]. */
function insideRequest(call: SlackCall, ts: string): boolean {
  const { lower, upper } = requestWindow(call);
  const at = tsMicros(ts);
  return at >= lower && at <= upper;
}

// ── the first page ───────────────────────────────────────────────────────────

describe("the seed scan", () => {
  it("keeps a partial initial scan and its exact continuation without certifying it", async () => {
    const seed = await seedTeam();
    const integrationId = await setup(seed);
    // The first request is anchored to the retained-history floor. A partial answer leaves the
    // certified interval empty and keeps the provider's cursor for the SAME anchored request.
    const fake = pass(() =>
      slackJson(
        historyBody({
          messages: [rootMessage("1718900000.000300"), rootMessage("1718900000.000100")],
          hasMore: true,
          nextCursor: "cursor-1",
        })
      )
    );

    await discover(seed, integrationId, fake);

    const channel = await channelRow(seed.teamId, WORKSPACE, CHANNEL);
    const request = fake.paramsOf("conversations.history")[0];
    expect(channel).toMatchObject({
      newest_cursor: null,
      newest_anchor_ts: null,
      historical_cursor: "cursor-1",
      historical_oldest_seen_ts: "1718900000.000100",
      completed_lower_ts: null,
      completed_upper_ts: null,
      historical_floor_reached: false,
      next_lane: "newest",
    });
    expect(channel?.historical_anchor_ts).toBe(request.get("latest"));
    expect(await threadRootTs(seed.teamId)).toEqual(["1718900000.000100", "1718900000.000300"]);
    expect(request.get("oldest")).toBeNull();
  });

  it("certifies a terminal initial interval to the exact request anchor", async () => {
    const seed = await seedTeam();
    const integrationId = await setup(seed);
    const fake = pass(() =>
      slackJson(historyBody({ messages: [rootMessage("1718900000.000300"), rootMessage("1718900000.000100")] }))
    );
    await discover(seed, integrationId, fake);
    const request = fake.paramsOf("conversations.history")[0];
    const latest = request.get("latest");
    expect(latest).toMatch(/^[0-9]+[.][0-9]{6}$/);
    const channel = await channelRow(seed.teamId, WORKSPACE, CHANNEL);
    expect(channel).toMatchObject({
      completed_lower_ts: "1718900000.000100",
      completed_upper_ts: latest,
      historical_anchor_ts: null,
      historical_cursor: null,
      newest_anchor_ts: null,
      newest_cursor: null,
      claimed_lane: null,
      lease_owner: null,
      lease_expires_at: null,
      historical_floor_reached: true,
    });
    expect(request.get("oldest")).toBeNull();
  });

  it("takes every structurally top-level root, and only those", async () => {
    const seed = await seedTeam();
    const integrationId = await setup(seed);
    const fake = pass(() =>
      slackJson(
        historyBody({
          messages: [
            // A tombstone and a text-less root are still THREADS. Discovery is structural: an
            // eligibility filter here would silently drop work that publication decides about later.
            rootMessage("1718900000.000400", { subtype: "tombstone", text: "This message was deleted." }),
            rootMessage("1718900000.000300", { text: "" }),
            rootMessage("1718900000.000200", { thread_ts: "1718900000.000200", reply_count: 4 }),
            // A REPLY that surfaced in history is not a root.
            rootMessage("1718900000.000150", { thread_ts: "1718900000.000100" }),
            rootMessage("1718900000.000100"),
          ],
        })
      )
    );

    await discover(seed, integrationId, fake);

    expect(await threadRootTs(seed.teamId)).toEqual([
      "1718900000.000100",
      "1718900000.000200",
      "1718900000.000300",
      "1718900000.000400",
    ]);
  });
});

// ── the two lanes ────────────────────────────────────────────────────────────

describe("newest and historical lanes", () => {
  it("alternates, so a one-request budget still advances both", async () => {
    const seed = await seedTeam();
    const integrationId = await setup(seed);
    const lanes: (string | null)[] = [];
    let page = 0;
    const fake = pass(async (call) => {
      lanes.push(await laneInFlight(seed.teamId));
      if (isCatchUp(call)) return slackJson(historyBody({ messages: [] }));
      page += 1;
      return slackJson(
        historyBody({
          messages: [rootMessage(`17188${String(99000 - page).padStart(5, "0")}.000100`)],
          hasMore: true,
          nextCursor: `cursor-${page}`,
        })
      );
    });

    for (let i = 0; i < 4; i++) {
      await discover(seed, integrationId, fake);
      await elapse(seed.teamId);
    }

    // Initial historical → newest → historical → newest. A lane position recomputed per invocation
    // would hand every slot to the same lane; the persisted `next_lane` is what stops that.
    expect(lanes).toEqual(["historical", "newest", "historical", "newest"]);
  });

  it("keeps a partial historical page as PROGRESS, and certifies only at its terminal page", async () => {
    const seed = await seedTeam();
    const integrationId = await setup(seed);
    let historical = 0;
    const fake = pass((call) => {
      if (isCatchUp(call)) return slackJson(historyBody({ messages: [] }));
      historical += 1;
      // Page 1 is the initial historical scan; it stays open until its terminal page.
      if (historical === 1) {
        return slackJson(historyBody({ messages: [rootMessage("1718900000.000900")], hasMore: true, nextCursor: "cursor-1" }));
      }
      if (historical === 2) {
        return slackJson(
          historyBody({
            messages: [rootMessage("1718900000.000800")],
            hasMore: true,
            nextCursor: "cursor-deep",
          })
        );
      }
      return slackJson(historyBody({ messages: [rootMessage("1718900000.000100")] }));
    });

    await discover(seed, integrationId, fake); // initial historical page, partial
    const afterSeed = await channelRow(seed.teamId, WORKSPACE, CHANNEL);
    await elapse(seed.teamId);
    await discover(seed, integrationId, fake); // newest catch-up, terminal
    await elapse(seed.teamId);
    await discover(seed, integrationId, fake); // historical continuation, partial

    const partial = await channelRow(seed.teamId, WORKSPACE, CHANNEL);
    expect(partial?.historical_cursor).toBe("cursor-deep");
    expect(partial?.historical_oldest_seen_ts).toBe("1718900000.000800");
    // The certified interval did NOT move: pages below this one have not been read.
    expect(partial?.completed_lower_ts).toBe(afterSeed?.completed_lower_ts);
    expect(partial?.historical_floor_reached).toBe(false);
    // …and the partial page's roots are durable work regardless.
    expect(await threadRootTs(seed.teamId)).toContain("1718900000.000800");

    await elapse(seed.teamId);
    await discover(seed, integrationId, fake); // newest catch-up (empty terminal)
    await elapse(seed.teamId);
    await discover(seed, integrationId, fake); // historical continuation, terminal

    const done = await channelRow(seed.teamId, WORKSPACE, CHANNEL);
    expect(done).toMatchObject({
      historical_cursor: null,
      historical_anchor_ts: null,
      historical_floor_reached: true,
      completed_lower_ts: "1718900000.000100",
    });
    // The continuation carried the stored cursor, not a fresh scan.
    const cursors = fake.paramsOf("conversations.history").map((p) => p.get("cursor"));
    expect(cursors).toContain("cursor-deep");
  });

  it("discovers far more than one page of roots across bounded invocations", async () => {
    const seed = await seedTeam();
    const integrationId = await setup(seed);
    const PAGES = 22;
    let page = 0;
    const fake = pass((call) => {
      if (isCatchUp(call)) return slackJson(historyBody({ messages: [] }));
      page += 1;
      const messages = Array.from({ length: 15 }, (_, i) =>
        rootMessage(`${1718900000 + PAGES * 20 - page * 15 - i}.000100`)
      );
      const last = page >= PAGES;
      return slackJson(
        historyBody({ messages, hasMore: !last, nextCursor: last ? null : `cursor-${page}` })
      );
    });

    for (let i = 0; i < PAGES * 2 + 2 && !(await channelRow(seed.teamId, WORKSPACE, CHANNEL))?.historical_floor_reached; i++) {
      await discover(seed, integrationId, fake);
      await elapse(seed.teamId);
    }

    const roots = await threadRootTs(seed.teamId);
    // The historical lane reaches the provider's retained floor; it is not capped at one page, at
    // 300 roots, or at whatever the newest lane happened to see.
    expect(roots.length).toBeGreaterThan(300);
    expect(new Set(roots).size).toBe(roots.length);
    expect((await channelRow(seed.teamId, WORKSPACE, CHANNEL))?.historical_floor_reached).toBe(true);
  });
});

// ── atomicity and fencing ────────────────────────────────────────────────────

describe("the roots and the frontier are one commit", () => {
  it("rolls BOTH back when the frontier write fails after the roots are enqueued", async () => {
    const seed = await seedTeam();
    const integrationId = await setup(seed);
    await discover(seed, integrationId, pass(() => slackJson(historyBody({ messages: [] }))));
    const before = await channelRow(seed.teamId, WORKSPACE, CHANNEL);
    await elapse(seed.teamId);

    const failing = transactionSessionDecoratedDb(db(), (session) => ({
      ...session,
      executeSql: (async (text: string, params?: unknown[]) => {
        // The FRONTIER write specifically — `completed_upper_ts` is set by no other statement — and
        // it runs AFTER the enqueues on this same session.
        if (/update\s+slack_sync_channels[\s\S]*completed_upper_ts\s*=/i.test(text)) {
          throw new Error("forced frontier failure");
        }
        return session.executeSql(text, params);
      }) as TransactionSession["executeSql"],
    }));
    // §9.1 FX-01: the one root is derived from THIS newest request's own U (was a fixed `.000700`).
    const fake = pass((call) => slackJson(historyBody({ messages: [rootMessage(rootAtUpper(call))] })));

    await expect(discover(seed, integrationId, fake, { client: failing })).rejects.toThrow(
      /forced frontier failure/
    );

    // Neither half survived…
    expect(await threadRootTs(seed.teamId)).toEqual([]);
    const after = await channelRow(seed.teamId, WORKSPACE, CHANNEL);
    expect(after?.completed_lower_ts).toBe(before?.completed_lower_ts);
    expect(after?.completed_upper_ts).toBe(before?.completed_upper_ts);
    // …and the request was NOT repeated by the transaction's own retry.
    expect(fake.countOf("conversations.history")).toBe(1);
    // The provider counted that request, and the allowance stays consumed: a rolled-back acceptance
    // is not a refund.
    const c = await rawSql();
    const { rows } = await c.query<{ due: boolean }>(
      `select next_permitted_at > clock_timestamp() as due from slack_method_budgets
        where team_id = $1 and method = 'conversations.history'`,
      [seed.teamId]
    );
    expect(rows[0]?.due).toBe(true);

    // §9.1 FX-01 matched control, AFTER every faulted assertion above. Elapse for budget/due
    // eligibility and expire the still-live claim explicitly; an unfaulted retry through the ordinary
    // client resumes the SAME frozen newest anchor and accepts its own bound-derived root.
    const failedLatest = fake.paramsOf("conversations.history")[0]?.get("latest");
    await elapse(seed.teamId);
    await expireChannelLease(seed.teamId, CHANNEL);
    const retry = pass((call) => slackJson(historyBody({ messages: [rootMessage(rootAtUpper(call))] })));
    const retried = await discover(seed, integrationId, retry);
    const retryRequest = retry.paramsOf("conversations.history")[0];
    expect({
      history: retried.steps.filter((s) => s.stage === "history").map((s) => `${s.result}:${s.category ?? ""}`),
      sameAnchor: retryRequest?.get("latest") === failedLatest && typeof failedLatest === "string",
      roots: await threadRootTs(seed.teamId),
    }, "the unfaulted retry resumes the same anchored newest scan and commits its root").toEqual({
      history: ["ok:"],
      sameAnchor: true,
      roots: [retryRequest?.get("latest")],
    });
  });

  it("refuses a page whose lease was reclaimed during the request", async () => {
    const seed = await seedTeam();
    const integrationId = await setup(seed);
    const fake = pass(async () => {
      // Somebody else took the row: a new owner and a bumped fence, exactly as a reclaim leaves it.
      const c = await rawSql();
      await c.query(
        `update slack_sync_channels
            set lease_owner = gen_random_uuid()::text,
                lease_generation = lease_generation + 1,
                lease_expires_at = clock_timestamp() + interval '5 minutes'
          where team_id = $1`,
        [seed.teamId]
      );
      return slackJson(historyBody({ messages: [rootMessage("1718900000.000600")] }));
    });

    const result = await discover(seed, integrationId, fake);

    expect(result.steps.some((s) => s.stage === "history" && s.result === "refused")).toBe(true);
    expect(await threadRootTs(seed.teamId)).toEqual([]);
    const channel = await channelRow(seed.teamId, WORKSPACE, CHANNEL);
    expect(channel?.completed_upper_ts).toBeNull();
    expect(channel?.newest_cursor).toBeNull();
  });

  it("refuses a page whose integration config changed during the request", async () => {
    const seed = await seedTeam();
    const integrationId = await setup(seed);
    const fake = pass(async () => {
      // A real config write through the real writer, mid-flight.
      await setSlackChannelIds(seed, [CHANNEL, "C0SOURCE9"]);
      return slackJson(historyBody({ messages: [rootMessage("1718900000.000500")] }));
    });

    const result = await discover(seed, integrationId, fake);

    expect(result.steps.some((s) => s.stage === "history" && s.result === "refused")).toBe(true);
    expect(await threadRootTs(seed.teamId)).toEqual([]);
    expect((await channelRow(seed.teamId, WORKSPACE, CHANNEL))?.completed_upper_ts).toBeNull();

    // …and the NEXT invocation cannot proceed on the old binding either: identity is re-proved
    // under the new revision before anything is read again.
    await elapse(seed.teamId);
    const next = pass(() => slackJson(historyBody({ messages: [] })));
    await discover(seed, integrationId, next);
    expect(next.countOf("auth.test")).toBe(1);
  });

  it("holds no row lock across the network, and has already committed its claim", async () => {
    const seed = await seedTeam();
    const integrationId = await setup(seed);
    let lockable: boolean | null = null;
    let leaseVisible: string | null = null;
    const fake = pass(async () => {
      const c = await rawSql();
      const { rows } = await c.query<{ lease_owner: string | null }>(
        `select lease_owner from slack_sync_channels where team_id = $1`,
        [seed.teamId]
      );
      leaseVisible = rows[0]?.lease_owner ?? null;
      try {
        await c.query("begin");
        await c.query(`select 1 from slack_sync_channels where team_id = $1 for update nowait`, [seed.teamId]);
        lockable = true;
      } catch {
        lockable = false;
      } finally {
        await c.query("rollback");
      }
      return slackJson(historyBody({ messages: [] }));
    });

    await discover(seed, integrationId, fake);

    // The claim is COMMITTED (another connection can see the lease) and no transaction is open on
    // the row (another connection can lock it) — the two halves of "no transaction crosses HTTP".
    expect(leaseVisible).not.toBeNull();
    expect(lockable).toBe(true);
  });
});

// ── pagination and page validity ─────────────────────────────────────────────

describe("a page that cannot be trusted advances nothing", () => {
  const bad: { name: string; body: Record<string, unknown>; category: string }[] = [
    {
      name: "has_more with no continuation cursor",
      body: historyBody({ messages: [rootMessage("1718900000.000100")], hasMore: true, nextCursor: null }),
      category: "pagination_incomplete",
    },
    {
      name: "a message with an unparseable timestamp",
      body: historyBody({ messages: [rootMessage("not-a-timestamp")] }),
      category: "malformed_timestamp",
    },
    {
      name: "no messages field at all",
      body: { ok: true, has_more: false },
      category: "malformed_page",
    },
  ];

  for (const { name, body, category } of bad) {
    it(`leaves the scan pending: ${name}`, async () => {
      const seed = await seedTeam();
      const integrationId = await setup(seed);
      const fake = pass(() => slackJson(body));

      const result = await discover(seed, integrationId, fake);

      expect(result.steps.filter((s) => s.stage === "history").map((s) => s.category)).toEqual([category]);
      // The whole page is refused: a page we cannot read entirely must not have its readable half
      // enqueued while its interval is certified.
      expect(await threadRootTs(seed.teamId)).toEqual([]);
      const channel = await channelRow(seed.teamId, WORKSPACE, CHANNEL);
      expect(channel).toMatchObject({
        completed_lower_ts: null,
        completed_upper_ts: null,
        newest_cursor: null,
        last_error_code: category,
      });
      // The anchor SURVIVES: the same anchored scan is resumed, not restarted at a new "now".
      expect(channel?.historical_anchor_ts).not.toBeNull();
    });
  }

  it("refuses a page that repeats the cursor it was asked with", async () => {
    const seed = await seedTeam();
    const integrationId = await setup(seed);
    let page = 0;
    const fake = pass((call) => {
      if (isCatchUp(call)) return slackJson(historyBody({ messages: [] }));
      page += 1;
      return slackJson(
        historyBody({ messages: [rootMessage(`17189000${10 + page}.000100`)], hasMore: true, nextCursor: "loop" })
      );
    });

    await discover(seed, integrationId, fake); // initial historical page
    await elapse(seed.teamId);
    await discover(seed, integrationId, fake); // newest catch-up
    const before = await channelRow(seed.teamId, WORKSPACE, CHANNEL);
    expect(before?.historical_cursor).toBe("loop");
    const rootsBefore = await threadRootTs(seed.teamId);
    await elapse(seed.teamId);
    const result = await discover(seed, integrationId, fake); // historical continuation → repeats "loop"

    expect(result.steps.some((s) => s.category === "cursor_repeated")).toBe(true);
    const after = await channelRow(seed.teamId, WORKSPACE, CHANNEL);
    expect(after?.historical_cursor).toBe("loop"); // not advanced onto itself
    expect(after?.historical_floor_reached).toBe(false);
    expect(await threadRootTs(seed.teamId)).toEqual(rootsBefore);
  });

  it("restarts the SAME anchored initial scan on invalid_cursor without certifying a hole", async () => {
    const seed = await seedTeam();
    const integrationId = await setup(seed);
    let historical = 0;
    const fake = pass((call) => {
      if (isCatchUp(call)) return slackJson(historyBody({ messages: [] }));
      historical += 1;
      if (historical === 1) {
        return slackJson(
          historyBody({ messages: [rootMessage("1718900000.000900")], hasMore: true, nextCursor: "stale" })
        );
      }
      return slackJson({ ok: false, error: "invalid_cursor" });
    });

    await discover(seed, integrationId, fake); // initial historical partial
    const partial = await channelRow(seed.teamId, WORKSPACE, CHANNEL);
    await elapse(seed.teamId);
    await discover(seed, integrationId, fake); // newest catch-up
    await elapse(seed.teamId);
    await discover(seed, integrationId, fake); // historical → invalid_cursor

    const after = await channelRow(seed.teamId, WORKSPACE, CHANNEL);
    expect(after?.historical_cursor).toBeNull();
    expect(after?.historical_anchor_ts).toBe(partial?.historical_anchor_ts);
    expect(Number(after?.historical_scan_generation)).toBe(Number(partial?.historical_scan_generation) + 1);
    // A partial scan never made a certified interval, and an invalid cursor does not mint one.
    expect(after?.completed_lower_ts).toBeNull();
    expect(after?.completed_upper_ts).toBeNull();
    expect(after?.historical_floor_reached).toBe(false);
  });

  /**
   * AM-F3 RED EVIDENCE, group 5 — actual transport → history → persisted state, for a continuation
   * page whose RAW pagination metadata is malformed (accepted amendment
   * `aio1170-f3-accepted-amendment-20261022`).
   *
   * The scan is real: a partial initial historical page leaves cursor `cursor-1` and one root, and an
   * empty newest catch-up passes the turn back. The historical continuation is then answered with a
   * LITERAL body, written out here rather than built with a shared helper. The adjudicated contract:
   * the transport refuses it as the static `transport_error` / `malformed_response_200`, so the pass
   * reports it `delayed`, records that category, enqueues nothing and moves no anchor, cursor, bound
   * or certified interval. The request WAS sent, so its slot is used and the turn passes to the other
   * lane. Only the retry, lease and turn bookkeeping columns may differ from before.
   *
   * EXPECTED RED on the current source, each in its own way:
   *  - numeric `next_cursor` with `has_more` absent or false: read as a TERMINAL page, so the
   *    interval is certified and the historical floor is marked reached;
   *  - a control-character cursor: accepted, and the bad cursor is persisted;
   *  - a whitespace-only or over-bound cursor: accepted by the transport and then refused by the
   *    channel writer, which THROWS out of the pass. The pass is captured as settled-or-thrown so that
   *    this shows as a failed assertion, not as an unrelated error.
   */
  const F3_CANARY = "xoxb-F3-CANARY-history-71e2";
  /** The columns a refused-and-released page may change: retry, lease and turn bookkeeping only. */
  const BOOKKEEPING = ["next_lane", "claimed_lane", "lease_owner", "lease_generation", "lease_expires_at", "due_at", "attempts", "last_error_code", "updated_at"];
  const withoutBookkeeping = (row: Record<string, unknown> | null): Record<string, unknown> =>
    Object.fromEntries(Object.entries(row ?? {}).filter(([key]) => !BOOKKEEPING.includes(key)));

  it.each<[string, Record<string, unknown>]>([
    ["a numeric next_cursor with has_more absent", { ok: true, messages: [rootMessage("1718900000.000500")], response_metadata: { next_cursor: 7 } }],
    ["a numeric next_cursor with has_more false", { ok: true, messages: [rootMessage("1718900000.000500")], has_more: false, response_metadata: { next_cursor: 7 } }],
    ["a control-character cursor", { ok: true, messages: [rootMessage("1718900000.000500")], has_more: true, response_metadata: { next_cursor: `${F3_CANARY}\u0001` } }],
    ["a whitespace-only cursor", { ok: true, messages: [rootMessage("1718900000.000500")], has_more: true, response_metadata: { next_cursor: "  \t " } }],
    ["an over-bound cursor", { ok: true, messages: [rootMessage("1718900000.000500")], has_more: true, response_metadata: { next_cursor: `${F3_CANARY}${"c".repeat(1024)}` } }],
  ])("F3 RED: a continuation answered with %s is delayed as malformed_response_200 and advances nothing", async (_label, malformedBody) => {
    const seed = await seedTeam();
    const integrationId = await setup(seed);
    const fake = pass((call) => {
      if (isCatchUp(call)) return slackJson({ ok: true, messages: [], has_more: false });
      if (call.params.get("cursor") === null) {
        return slackJson({ ok: true, messages: [rootMessage("1718900000.000900")], has_more: true, response_metadata: { next_cursor: "cursor-1" } });
      }
      // The continuation of `cursor-1`: the literal malformed body under test.
      return slackJson(malformedBody);
    });

    await discover(seed, integrationId, fake); // initial historical page, partial
    await elapse(seed.teamId);
    await discover(seed, integrationId, fake); // newest catch-up, terminal and empty
    await elapse(seed.teamId);
    const before = await channelRow(seed.teamId, WORKSPACE, CHANNEL);
    const rootsBefore = await threadRootTs(seed.teamId);
    const historyBefore = fake.countOf("conversations.history");
    expect(before).toMatchObject({ historical_cursor: "cursor-1", next_lane: "historical", completed_lower_ts: null, historical_floor_reached: false });
    expect(rootsBefore).toEqual(["1718900000.000900"]);

    const settled = await discover(seed, integrationId, fake).then(
      (result) => ({ result }),
      (error: unknown) => ({ thrown: error instanceof Error ? error.name : "non-error" })
    );
    expect(settled, "the pass completes; a malformed page is a delay, not an exception").not.toHaveProperty("thrown");
    if (!("result" in settled)) return;

    // The request was really sent, once, with the stored cursor.
    expect(fake.countOf("conversations.history")).toBe(historyBefore + 1);
    expect(fake.paramsOf("conversations.history").at(-1)?.get("cursor")).toBe("cursor-1");
    // Static categorization: one delayed history step, the existing malformed-response category.
    expect(settled.result.steps.filter((s) => s.stage === "history").map((s) => [s.result, s.category])).toEqual([
      ["delayed", "malformed_response_200"],
    ]);
    const after = await channelRow(seed.teamId, WORKSPACE, CHANNEL);
    expect(after).toMatchObject({
      last_error_code: "malformed_response_200",
      // Sent, so the slot was used and the turn PASSES to the other lane.
      next_lane: "newest",
      claimed_lane: null,
      lease_owner: null,
    });
    // Everything else exactly as it was: no anchor, cursor, bound, oldest-seen or certified-interval
    // change, and no floor reached.
    expect(withoutBookkeeping(after)).toEqual(withoutBookkeeping(before));
    expect(await threadRootTs(seed.teamId)).toEqual(rootsBefore);
    // No canary in anything reported or persisted.
    expect(JSON.stringify(settled.result.steps)).not.toContain(F3_CANARY);
    expect(JSON.stringify(after)).not.toContain(F3_CANARY);
    expect(JSON.stringify(await threadRows(seed.teamId))).not.toContain(F3_CANARY);
  });
});

// ── replay ───────────────────────────────────────────────────────────────────

describe("replay and overlap", () => {
  it("re-reports a root without disturbing the work already running on it", async () => {
    const seed = await seedTeam();
    const integrationId = await setup(seed);
    // §9.1 FX-02: the root is captured ONCE, from the initial request's own U, and the identical string
    // is reused for the claimed thread and the second page. U = A1 lies inside the next catch-up's
    // skew overlap, which the second request asserts; it is never regenerated.
    let captured: string | null = null;
    let secondInside: boolean | null = null;
    const fake = pass((call) => {
      if (captured === null) captured = rootAtUpper(call);
      else secondInside = insideRequest(call, captured);
      return slackJson(historyBody({ messages: [rootMessage(captured)] }));
    });
    const historyOk = (result: SlackSourceDiscoveryResult) =>
      result.steps.filter((s) => s.stage === "history").map((s) => `${s.result}:${s.category ?? ""}`);
    expect(historyOk(await discover(seed, integrationId, fake)), "the initial page is accepted").toEqual(["ok:"]);
    const root = String(captured);

    // Somebody is mid-page on that thread: a lease, a fence and a stored cursor.
    const scope = { teamId: seed.teamId, workspaceId: WORKSPACE, channelId: CHANNEL, rootTs: root };
    const claim = await tx((s) => claimSlackThread(s, scope, { leaseMs: 300_000 }));
    if (!claim) throw new Error("fixture: the queued thread should have been claimable");
    await tx((s) => checkpointSlackThread(s, claim, { pageCursor: "thread-cursor", snapshotGeneration: 3 }));
    const [before] = await threadRows(seed.teamId);

    // The overlap seam re-reports the same root on the next scan.
    await elapse(seed.teamId);
    expect(historyOk(await discover(seed, integrationId, fake)), "the overlap page is accepted").toEqual(["ok:"]);
    expect(secondInside, "the captured root lies inside the second request's actual bounds").toBe(true);

    const [after] = await threadRows(seed.teamId);
    expect(after).toEqual(before);
  });

  // ⚠️ CHANGED ON PURPOSE (pre-activation correction PA-3, AC-PA-08). This test used to assert that
  // the catch-up's `oldest` EQUALS the previous certified top — an overlap exactly one message wide,
  // which is no overlap at all against a provider whose clock is not the database's. The lower
  // bound sent is now that top MINUS the skew allowance; what is stored is unchanged.
  it("overlaps the certified boundary by the skew allowance, not by one message (AC-PA-08)", async () => {
    const seed = await seedTeam();
    const integrationId = await setup(seed);
    const fake = pass((call) =>
      slackJson(historyBody({ messages: isCatchUp(call) ? [] : [rootMessage("1718900000.000100")] }))
    );

    await discover(seed, integrationId, fake); // initial terminal → completed_upper = request anchor
    const seeded = await channelRow(seed.teamId, WORKSPACE, CHANNEL);
    await elapse(seed.teamId);
    await discover(seed, integrationId, fake); // newest catch-up

    const catchUp = fake.calls.filter((c) => c.method === "conversations.history" && isCatchUp(c));
    expect(catchUp).toHaveLength(1);
    // The lower bound is the previous certified top less the DEFAULT allowance of sixty seconds, in
    // the six-digit microsecond form Slack expects, and it is still INCLUSIVE — everything in the
    // margin is read again, and the exact-key enqueue is what makes that harmless.
    expect(catchUp[0].params.get("oldest")).toBe(
      shiftTs(String(seeded?.completed_upper_ts), -msToMicros(DEFAULT_SKEW_ALLOWANCE_MS))
    );
    expect(catchUp[0].params.get("oldest")).toMatch(SIX_DIGIT_TS);
    expect(catchUp[0].params.get("inclusive")).toBe("true");

    // Only the REQUEST moved. The interval that is certified still ends exactly where each scan was
    // anchored, and still starts where it did.
    const after = await channelRow(seed.teamId, WORKSPACE, CHANNEL);
    expect(after?.completed_upper_ts).toBe(catchUp[0].params.get("latest"));
    expect(after?.completed_lower_ts).toBe(seeded?.completed_lower_ts);
  });
});

// ── the newest-lane seam ─────────────────────────────────────────────────────

/** The database's clock as a Slack `ts`: the clock every scan anchor is frozen from. */
async function dbClockTs(): Promise<string> {
  const c = await rawSql();
  const { rows } = await c.query<{ ts: string }>(
    `select to_char(extract(epoch from clock_timestamp()), 'FM9999999999.000000') as ts`
  );
  return rows[0].ts;
}

/**
 * A provider-side channel that SERVES BY THE REQUEST'S OWN BOUNDS: `latest`, `oldest`, `inclusive`,
 * `limit` and a cursor, newest first, exactly as `conversations.history` does.
 *
 * ⚠️ A scripted handler cannot test a seam. It returns whatever the test told it to whatever was
 * asked, so a lower bound that excludes a message and one that includes it look identical. This one
 * forgets nothing and filters on what it is sent — which is the only way "was that root inside the
 * range we asked for?" has an answer.
 *
 * `lagMs` is the provider's clock running BEHIND the database's: a message posted at a database
 * instant is stamped that much earlier, which is how a root comes to carry a `ts` below an anchor
 * that was frozen before the root existed.
 */
function providerChannel(opts: { lagMs?: number } = {}): {
  history: SlackHandler;
  pages: { params: URLSearchParams; served: string[] }[];
  post(ts: string): string;
  postAt(dbInstant: string): string;
} {
  const roots: string[] = [];
  const pages: { params: URLSearchParams; served: string[] }[] = [];
  const history: SlackHandler = (call) => {
    const latest = call.params.get("latest");
    const oldest = call.params.get("oldest");
    const inclusive = call.params.get("inclusive") === "true";
    const limit = Number(call.params.get("limit"));
    const offset = Number((call.params.get("cursor") ?? "offset:0").replace("offset:", ""));
    if (latest === null || !Number.isSafeInteger(limit) || limit <= 0 || !Number.isSafeInteger(offset)) {
      throw new Error("fixture: a history request this provider cannot serve");
    }
    const upper = tsMicros(latest);
    const lower = oldest === null ? null : tsMicros(oldest);
    const inRange = roots
      .filter((ts) => {
        const at = tsMicros(ts);
        if (inclusive ? at > upper : at >= upper) return false;
        return lower === null || (inclusive ? at >= lower : at > lower);
      })
      .sort((a, b) => (tsMicros(a) < tsMicros(b) ? 1 : -1));
    const served = inRange.slice(offset, offset + limit);
    const more = offset + limit < inRange.length;
    pages.push({ params: call.params, served });
    return slackJson(
      historyBody({
        messages: served.map((ts) => rootMessage(ts)),
        hasMore: more,
        nextCursor: more ? `offset:${offset + limit}` : null,
      })
    );
  };
  return {
    history,
    pages,
    post(ts) {
      roots.push(ts);
      return ts;
    },
    postAt(dbInstant) {
      const ts = shiftTs(dbInstant, -msToMicros(opts.lagMs ?? 0));
      roots.push(ts);
      return ts;
    },
  };
}

describe("the newest-lane seam has a margin (PA-3)", () => {
  const OLD_ROOT = "1718900000.000100";

  /**
   * THE MISSED ROOT, with no real clock involved. The seed scan is served and certifies up to its
   * anchor. A provider running two seconds behind the database then takes a message one second
   * AFTER that anchor and stamps it one second BELOW it — inside the interval already certified,
   * and on no page that was ever served.
   */
  async function lateRootBelowTheAnchor(): Promise<{
    seed: Seed;
    integrationId: string;
    channel: ReturnType<typeof providerChannel>;
    fake: SlackFake;
    anchor: string;
    late: string;
  }> {
    const seed = await seedTeam();
    const integrationId = await setup(seed);
    const channel = providerChannel({ lagMs: 2_000 });
    channel.post(OLD_ROOT);
    const fake = pass(channel.history);

    await discover(seed, integrationId, fake);
    const anchor = String((await channelRow(seed.teamId, WORKSPACE, CHANNEL))?.completed_upper_ts);
    // The prior top page was served WITHOUT it: the root did not exist yet.
    expect(channel.pages.map((page) => page.served)).toEqual([[OLD_ROOT]]);

    const late = channel.postAt(shiftTs(anchor, msToMicros(1_000)));
    expect(late).toBe(shiftTs(anchor, -msToMicros(1_000)));
    return { seed, integrationId, channel, fake, anchor, late };
  }

  it("discovers a root a lagging provider stamped BELOW the previous anchor (AC-PA-07)", async () => {
    const { seed, integrationId, channel, fake, late } = await lateRootBelowTheAnchor();

    await elapse(seed.teamId);
    await discover(seed, integrationId, fake);

    expect(channel.pages).toHaveLength(2);
    // The catch-up asked far enough below the anchor to be served the root it would have skipped…
    expect(channel.pages[1].served).toEqual([late]);
    expect(await threadRootTs(seed.teamId)).toEqual([OLD_ROOT, late]);
    // …which matters because the interval is now certified up to this scan's anchor with that root
    // INSIDE it: a root missed here is never looked for again, and its absence later reads as a
    // deletion.
    const after = await channelRow(seed.teamId, WORKSPACE, CHANNEL);
    expect(after?.completed_upper_ts).toBe(channel.pages[1].params.get("latest"));
    expect(tsMicros(late) < tsMicros(String(after?.completed_upper_ts))).toBe(true);
  });

  /**
   * THE CONTROL for the test above, on the same fixture with one thing changed: an allowance
   * configured BELOW the skew. The root is missed again — so it is the margin that found it, not a
   * provider that hands everything back whatever `oldest` says, and the allowance is a real setting
   * rather than a constant.
   */
  it("misses that root when the allowance is configured below the skew (AC-PA-07 control)", async () => {
    const { seed, integrationId, channel, fake, anchor } = await lateRootBelowTheAnchor();

    await elapse(seed.teamId);
    await discover(seed, integrationId, fake, { skewAllowanceMs: 500 });

    expect(channel.pages).toHaveLength(2);
    expect(channel.pages[1].params.get("oldest")).toBe(shiftTs(anchor, -msToMicros(500)));
    expect(channel.pages[1].served).toEqual([]);
    expect(await threadRootTs(seed.teamId)).toEqual([OLD_ROOT]);
  });

  /**
   * ONE SCAN, ONE LOWER BOUND. A catch-up that needs two pages is two wakes and two claims of the
   * same anchored scan. The allowance is taken off the STORED bound when the request is built and
   * never written back — a bound persisted after the subtraction would be subtracted from again on
   * the next page, sliding the window sixty seconds further down every wake.
   */
  it("sends every page of one scan the same lower bound, and stores none of it (AC-PA-08)", async () => {
    const seed = await seedTeam();
    const integrationId = await setup(seed);
    const channel = providerChannel();
    channel.post(OLD_ROOT);
    const fake = pass(channel.history);

    await discover(seed, integrationId, fake);
    const seeded = await channelRow(seed.teamId, WORKSPACE, CHANNEL);
    const anchor = String(seeded?.completed_upper_ts);
    // More new roots than one page holds, all posted just above the certified top.
    const limit = Number(channel.pages[0].params.get("limit"));
    const fresh = Array.from({ length: limit + 5 }, (_, i) => channel.post(shiftTs(anchor, BigInt(i + 1))));

    await elapse(seed.teamId);
    await discover(seed, integrationId, fake); // catch-up, page 1 of 2
    const midScan = await channelRow(seed.teamId, WORKSPACE, CHANNEL);
    await elapse(seed.teamId);
    await discover(seed, integrationId, fake); // catch-up, page 2 of 2
    const after = await channelRow(seed.teamId, WORKSPACE, CHANNEL);

    expect(channel.pages).toHaveLength(3);
    const [, first, second] = channel.pages;
    expect(first.served).toHaveLength(limit);
    expect(second.served).toHaveLength(5);
    expect(second.params.get("cursor")).toBe(midScan?.newest_cursor);

    // The same margin on both pages, under the same frozen anchor.
    const lowerBound = shiftTs(anchor, -msToMicros(DEFAULT_SKEW_ALLOWANCE_MS));
    expect(first.params.get("oldest")).toBe(lowerBound);
    expect(second.params.get("oldest")).toBe(lowerBound);
    expect(lowerBound).toMatch(SIX_DIGIT_TS);
    expect(second.params.get("latest")).toBe(first.params.get("latest"));

    // Between the pages the row holds the scan's bookkeeping EXACTLY as before: the lower bound is
    // the certified top itself, the anchor is the one the scan froze, and nothing is certified yet.
    expect(midScan?.newest_lower_ts).toBe(anchor);
    expect(midScan?.newest_anchor_ts).toBe(first.params.get("latest"));
    expect(midScan?.completed_upper_ts).toBe(anchor);

    // …and the finished scan certifies to its anchor, with every root queued once.
    expect(after).toMatchObject({ newest_cursor: null, newest_anchor_ts: null, newest_lower_ts: null });
    expect(after?.completed_upper_ts).toBe(first.params.get("latest"));
    expect(after?.completed_lower_ts).toBe(seeded?.completed_lower_ts);
    const queued = await threadRootTs(seed.teamId);
    expect(queued).toHaveLength(fresh.length + 1);
    expect(new Set(queued)).toEqual(new Set([OLD_ROOT, ...fresh]));
  });

  it.each([
    {
      name: "a sub-second allowance, borrowing across the second when it has to",
      allowanceMs: 1_999,
      expected: (lower: string) => shiftTs(lower, -msToMicros(1_999)),
    },
    {
      // A century: longer than the epoch is old, so the subtraction goes below zero.
      name: "an allowance larger than the bound itself, clamped at zero",
      allowanceMs: 100 * 365 * 24 * 60 * 60 * 1000,
      expected: () => "0.000000",
    },
  ])("sends the CONFIGURED lower bound in six-digit form: $name (AC-PA-08)", async ({ allowanceMs, expected }) => {
    const seed = await seedTeam();
    const integrationId = await setup(seed);
    const fake = pass((call) =>
      slackJson(historyBody({ messages: isCatchUp(call) ? [] : [rootMessage(OLD_ROOT)] }))
    );

    await discover(seed, integrationId, fake);
    const seeded = await channelRow(seed.teamId, WORKSPACE, CHANNEL);
    await elapse(seed.teamId);
    await discover(seed, integrationId, fake, { skewAllowanceMs: allowanceMs });

    const catchUp = fake.calls.filter((c) => c.method === "conversations.history" && isCatchUp(c));
    expect(catchUp).toHaveLength(1);
    expect(catchUp[0].params.get("oldest")).toBe(expected(String(seeded?.completed_upper_ts)));
    expect(catchUp[0].params.get("oldest")).toMatch(SIX_DIGIT_TS);
    // Zero is the ONLY floor: the certified interval is untouched by how far down the request went.
    const after = await channelRow(seed.teamId, WORKSPACE, CHANNEL);
    expect(after?.completed_upper_ts).toBe(catchUp[0].params.get("latest"));
    expect(after?.completed_lower_ts).toBe(seeded?.completed_lower_ts);
  });

  /** A quiet channel whose only root is ten seconds old on the database's clock when it is seeded. */
  async function quietChannelWithOneRecentRoot(): Promise<{
    seed: Seed;
    integrationId: string;
    channel: ReturnType<typeof providerChannel>;
    fake: SlackFake;
    recent: string;
  }> {
    const seed = await seedTeam();
    const integrationId = await setup(seed);
    const channel = providerChannel();
    // Below the anchor the seed scan is about to freeze, and well inside the allowance beneath it.
    const recent = channel.post(shiftTs(await dbClockTs(), -msToMicros(10_000)));
    const fake = pass(channel.history);

    await discover(seed, integrationId, fake);
    expect(channel.pages.map((page) => page.served)).toEqual([[recent]]);
    return { seed, integrationId, channel, fake, recent };
  }

  it("queues a root ONCE when the overlap reads it a second time (AC-PA-09)", async () => {
    const { seed, integrationId, channel, fake, recent } = await quietChannelWithOneRecentRoot();
    const queued = await threadRows(seed.teamId);
    expect(queued.map((row) => row.root_ts)).toEqual([recent]);

    await elapse(seed.teamId);
    await discover(seed, integrationId, fake);

    // The root really was served twice — by the seed scan, then again inside the catch-up's margin…
    expect(channel.pages.map((page) => page.served)).toEqual([[recent], [recent]]);
    // …and it is still one row, and the same row: the exact-key enqueue did nothing the second time.
    expect(await threadRows(seed.teamId)).toEqual(queued);
  });

  it("spends ONE history request on a quiet channel whose overlap holds one message (AC-PA-09b)", async () => {
    const { seed, integrationId, channel, fake, recent } = await quietChannelWithOneRecentRoot();
    const before = fake.countOf("conversations.history");

    await elapse(seed.teamId);
    const result = await discover(seed, integrationId, fake);

    // The margin is not free in general — it is re-read on a shared budget — but here it holds one
    // message, and one page carries it: the catch-up costs what it cost before there was a margin.
    expect(channel.pages[1]?.served).toEqual([recent]);
    expect(fake.countOf("conversations.history") - before).toBe(1);
    expect(result.steps.filter((s) => s.stage === "history").map((s) => s.result)).toEqual(["ok"]);
    const after = await channelRow(seed.teamId, WORKSPACE, CHANNEL);
    expect(after).toMatchObject({ newest_cursor: null, newest_anchor_ts: null, newest_lower_ts: null });
    expect(after?.completed_upper_ts).toBe(channel.pages[1]?.params.get("latest"));
  });
});

// ── request slots, under a budget that says "not yet" ────────────────────────

/**
 * AIO-1170 final full-contract review — the two lanes alternate REQUEST SLOTS, not wakes.
 *
 * A wake is cheap and frequent; a request slot is one per minute. After a historical page is read
 * the turn belongs to the newest lane, but the wake that would take it usually arrives inside that
 * minute, claims the newest lane, and is DEFERRED by the method budget: zero HTTP. Handing the lane
 * back used to pass the turn on anyway — so the next real slot went to the historical lane again,
 * and again, and a long backfill starved the newest lane of every request until it was finished.
 * Nothing new in the channel was discovered for as long as the backlog lasted.
 *
 * (A wake that stops at its own INVOCATION ceiling is a different, separately pinned case: there the
 * claim/release bookkeeping, turn included, is the accepted PA-2 contract. This is about the budget.)
 */
describe("history request slots alternate when a wake is deferred by the method budget", () => {
  /** What has been read, and where each scan stands: none of it may move on a wake that sent nothing. */
  const FRONTIER = [
    "historical_cursor",
    "newest_cursor",
    "historical_scan_generation",
    "newest_scan_generation",
    "historical_anchor_ts",
    "historical_oldest_seen_ts",
    "historical_floor_reached",
    "completed_lower_ts",
    "completed_upper_ts",
    "newest_catchup_upper_ts",
    "last_read_at",
  ] as const;

  it("gives the newest lane the next real slot after a deferred wake, so a new root is found mid-backfill", async () => {
    const seed = await seedTeam();
    const integrationId = await setup(seed);
    const channel = providerChannel();
    // A backlog three pages deep: the historical scan needs three request slots to drain it.
    for (let i = 0; i < 40; i++) channel.post(`17189${10_000 + i}.000100`);
    const fake = pass(channel.history);
    const sentLanes = () =>
      fake.calls
        .filter((call) => call.method === "conversations.history")
        .map((call) => (isCatchUp(call) ? "newest" : "historical"));

    /**
     * ONE EARLY WAKE, inside the minute the last request spent. It is genuinely deferred by the
     * stored method budget — no clock is moved to stage it — so it sends nothing, and it must take
     * nothing either: the turn it could not use is still the same lane's, and the frontier is where
     * the last accepted page left it.
     */
    async function deferredWake(): Promise<void> {
      const before = await channelRow(seed.teamId, WORKSPACE, CHANNEL);
      const requests = fake.calls.length;

      const result = await discover(seed, integrationId, fake);

      expect(fake.calls.length).toBe(requests);
      expect(
        result.steps.filter((s) => s.stage === "history").map((s) => `${s.result}:${s.category ?? ""}`)
      ).toEqual(["deferred:budget_deferred"]);
      const after = await channelRow(seed.teamId, WORKSPACE, CHANNEL);
      // THE TURN IS NOT SPENT: no request was sent, so no request slot was used.
      expect(after?.next_lane).toBe(before?.next_lane);
      for (const column of FRONTIER) expect(after?.[column], column).toEqual(before?.[column]);
      expect(after?.lease_owner).toBeNull();
    }
    /** One wake with budget: the minute has passed, so exactly one history request goes out. */
    async function slot(): Promise<void> {
      await elapse(seed.teamId);
      const requests = fake.countOf("conversations.history");
      await discover(seed, integrationId, fake);
      expect(fake.countOf("conversations.history")).toBe(requests + 1);
    }

    // SLOT 1 — the anchored historical scan starts: first page of three, and the turn passes on.
    await discover(seed, integrationId, fake);
    const seeded = await channelRow(seed.teamId, WORKSPACE, CHANNEL);
    expect(seeded).toMatchObject({ historical_cursor: "offset:15", next_lane: "newest", historical_floor_reached: false });
    // Somebody posts in the channel just after that anchor. Only the newest lane can ever see it.
    const fresh = channel.post(shiftTs(String(seeded?.historical_anchor_ts), BigInt(1)));

    await deferredWake();

    // SLOT 2 belongs to the NEWEST lane — the wake in between sent nothing and changes nothing.
    await slot();
    expect(sentLanes()).toEqual(["historical", "newest"]);
    // The new root is queued while the backfill is still two pages from done.
    expect(await threadRootTs(seed.teamId)).toContain(fresh);
    expect(await channelRow(seed.teamId, WORKSPACE, CHANNEL)).toMatchObject({
      historical_cursor: "offset:15",
      historical_floor_reached: false,
    });

    await deferredWake();

    // SLOT 3 — the historical scan resumes exactly where it stopped, under its frozen anchor.
    await slot();
    const resumed = fake.paramsOf("conversations.history")[2];
    expect(resumed?.get("cursor")).toBe("offset:15");
    expect(resumed?.get("latest")).toBe(seeded?.historical_anchor_ts);

    await deferredWake();

    // SLOT 4 — and the newest lane again. Slots alternate for as long as both lanes have work.
    await slot();
    expect(sentLanes()).toEqual(["historical", "newest", "historical", "newest"]);
    expect(await channelRow(seed.teamId, WORKSPACE, CHANNEL)).toMatchObject({
      historical_cursor: "offset:30",
      historical_floor_reached: false,
    });
  }, 30_000);
});

// ── AIO-1170 packet 4b: the request carries the claim's FROZEN segment ────────────────────────

/**
 * AIO-1170 AM-F2 §5 — EVERY history request is `latest = U`, `inclusive = true`, `oldest = S` (the
 * historical lane omits it at S = 0), and `cursor` only when one is stored. These are the claim's
 * frozen segment values. They are not the anchor A, and not "the stored lower minus the allowance
 * passed this time".
 *
 * Status against GREEN3 `9ee7dbd7`:
 *  - RED (5), because discovery still sends `latest = A` and `oldest = B − allowance` (none on the
 *    historical lane):
 *     - a progressed post-split newest segment (S > L): oldest must be S;
 *     - a reclaim under a DIFFERENT allowance: oldest stays the frozen S on every page;
 *     - a noncanonical anchor: latest must be canonical U, not the raw A bytes;
 *     - a literal newest U BELOW A: latest must be that U, which also kills `latest = canonical(A)`;
 *     - a literal historical 0 < S ≤ U < A: oldest = S and latest = U, which kills an omitted oldest.
 *    The last two answer every request with an empty page, so they fail only on the request.
 *  - Controls already covered elsewhere and unchanged: the historical S = 0 omission (seed-scan
 *    tests) and the exact-zero newest oldest (the clamped-allowance PA-3 test).
 * Every root is derived from the request's OWN bounds with the test's integer arithmetic.
 */
describe("AIO-1170 §5: every history request carries the claim's frozen segment", () => {
  /** Exact request bounds, read from the request itself (oldest absent ⇒ 0). Fails the fixture if malformed. */
  function requestBounds(call: SlackCall): { lower: bigint; upper: bigint } {
    const latest = call.params.get("latest");
    if (latest === null) throw new Error("fixture: a history request without latest");
    const oldest = call.params.get("oldest");
    return { lower: oldest === null ? BigInt(0) : tsMicros(oldest), upper: tsMicros(latest) };
  }
  const historyCategories = (result: SlackSourceDiscoveryResult) =>
    result.steps.filter((s) => s.stage === "history").map((s) => `${s.result}:${s.category ?? ""}`);
  const settle = (run: Promise<SlackSourceDiscoveryResult>) =>
    run.then((result) => ({ categories: historyCategories(result) }), (error: unknown) => ({ thrown: error instanceof Error ? error.name : "non-error" }));

  /** First pass: the initial historical scan, terminal and empty, certifying [A1, A1]. Returns A1. */
  async function certifiedChannel(seed: Seed, integrationId: string, fake: SlackFake): Promise<string> {
    await discover(seed, integrationId, fake);
    const row = await channelRow(seed.teamId, WORKSPACE, CHANNEL);
    expect(row?.historical_floor_reached, "fixture: the initial scan certified").toBe(true);
    return String(row?.completed_upper_ts);
  }

  it("a progressed post-split newest segment (S > L) is requested as oldest = S, latest = U, never B − allowance", async () => {
    const seed = await seedTeam();
    const integrationId = await setup(seed);
    const fake = pass((call) => {
      if (!isCatchUp(call)) return slackJson(historyBody({ messages: [] }));
      const { upper } = requestBounds(call);
      return slackJson(historyBody({ messages: [rootMessage(shiftTs("0.000000", upper))] }));
    });
    const top = await certifiedChannel(seed, integrationId, fake);
    // A valid post-progress literal over the certified top: A = top + 10 s, B = top, L = B − 60 s,
    // S = top + 2 s (> L), U = A, C/H empty, G + 1.
    const A = shiftTs(top, msToMicros(10_000));
    const L = shiftTs(top, -msToMicros(DEFAULT_SKEW_ALLOWANCE_MS));
    const S = shiftTs(top, msToMicros(2_000));
    const c = await rawSql();
    await c.query(
      `update slack_sync_channels
          set newest_anchor_ts = $2, newest_lower_ts = $3, newest_request_lower_ts = $4,
              newest_segment_lower_ts = $5, newest_segment_upper_ts = $2,
              newest_scan_generation = newest_scan_generation + 1, next_lane = 'newest'
        where team_id = $1`,
      [seed.teamId, A, top, L, S]
    );
    await elapse(seed.teamId);
    const outcome = await settle(discover(seed, integrationId, fake));
    const sent = fake.calls.filter((call) => call.method === "conversations.history" && isCatchUp(call));
    expect({
      outcome,
      request: sent.map((call) => ({ oldest: call.params.get("oldest"), latest: call.params.get("latest"), inclusive: call.params.get("inclusive"), cursor: call.params.get("cursor") })),
    }, "the frozen segment, exactly").toEqual({
      outcome: { categories: ["ok:"] },
      request: [{ oldest: S, latest: A, inclusive: "true", cursor: null }],
    });
  });

  it("a reclaim under a DIFFERENT configured allowance keeps every page of the segment at the frozen S and U", async () => {
    const seed = await seedTeam();
    const integrationId = await setup(seed);
    const fake = pass((call) => {
      if (!isCatchUp(call)) return slackJson(historyBody({ messages: [] }));
      const { upper } = requestBounds(call);
      const root = rootMessage(shiftTs("0.000000", upper));
      return call.params.get("cursor") === null
        ? slackJson(historyBody({ messages: [root], hasMore: true, nextCursor: "n-1" }))
        : slackJson(historyBody({ messages: [root] }));
    });
    const top = await certifiedChannel(seed, integrationId, fake);
    await elapse(seed.teamId);
    const first = await settle(discover(seed, integrationId, fake, { skewAllowanceMs: 90_000 }));
    await elapse(seed.teamId);
    const second = await settle(discover(seed, integrationId, fake, { skewAllowanceMs: 30_000 }));
    const sent = fake.calls.filter((call) => call.method === "conversations.history" && isCatchUp(call));
    const frozenS = shiftTs(top, -msToMicros(90_000));
    expect({
      outcomes: [first, second],
      oldest: sent.map((call) => call.params.get("oldest")),
      sameLatest: sent.length === 2 && sent[0].params.get("latest") === sent[1].params.get("latest"),
      cursors: sent.map((call) => call.params.get("cursor")),
    }, "L/S are frozen by the claim that initialized the segment; a later allowance does not move them").toEqual({
      outcomes: [{ categories: ["ok:"] }, { categories: ["ok:"] }],
      oldest: [frozenS, frozenS],
      sameLatest: true,
      cursors: [null, "n-1"],
    });
  });

  it("an anchored newest lane with a NONCANONICAL anchor is requested at canonical U, not the raw A bytes", async () => {
    const seed = await seedTeam();
    const integrationId = await setup(seed);
    const fake = pass((call) => {
      if (!isCatchUp(call)) return slackJson(historyBody({ messages: [] }));
      return slackJson(historyBody({ messages: [] }));
    });
    const top = await certifiedChannel(seed, integrationId, fake);
    // A noncanonical anchor (`<top seconds + 1>.5`) between 0.5 s and 1.5 s above the top, depending
    // on the clock's fraction, with B = top (the all-null tuple).
    const seconds = BigInt(top.split(".")[0]) + BigInt(1);
    const rawA = `${seconds}.5`;
    const c = await rawSql();
    await c.query(
      `update slack_sync_channels set newest_anchor_ts = $2, newest_lower_ts = $3, next_lane = 'newest' where team_id = $1`,
      [seed.teamId, rawA, top]
    );
    await elapse(seed.teamId);
    const outcome = await settle(discover(seed, integrationId, fake));
    const sent = fake.calls.filter((call) => call.method === "conversations.history" && isCatchUp(call));
    expect({ outcome, latest: sent.map((call) => call.params.get("latest")), oldest: sent.map((call) => call.params.get("oldest")) },
      "latest is U = canonical(A); the stored anchor keeps its bytes").toEqual({
      outcome: { categories: ["ok:"] },
      latest: [`${seconds}.500000`],
      oldest: [shiftTs(top, -msToMicros(DEFAULT_SKEW_ALLOWANCE_MS))],
    });
    // (A's byte preservation itself is proven at the claim, in the progress suite's packet 3.)
  });

  /** The outbound request bounds, projected (bounds and flags only). */
  const requestOf = (fake: SlackFake) =>
    fake.calls.filter((call) => call.method === "conversations.history").slice(-1).map((call) => ({
      oldest: call.params.get("oldest"), latest: call.params.get("latest"),
      inclusive: call.params.get("inclusive"), cursor: call.params.get("cursor"),
    }));

  it("a newest segment whose stored U lies BELOW A (after an internal terminal) is requested at latest = literal U, never canonical(A)", async () => {
    const seed = await seedTeam();
    const integrationId = await setup(seed);
    // Every response is empty, so the only thing under test is the outbound request.
    const fake = pass(() => slackJson(historyBody({ messages: [] })));
    const top = await certifiedChannel(seed, integrationId, fake);
    // A valid progressed literal: A = top + 10 s, B = top, L = B − 60 s, S = top + 2 s, and
    // U = top + 5 s < A (a terminal upper segment lowered it). C/H empty, G + 1.
    const A = shiftTs(top, msToMicros(10_000));
    const L = shiftTs(top, -msToMicros(DEFAULT_SKEW_ALLOWANCE_MS));
    const S = shiftTs(top, msToMicros(2_000));
    const U = shiftTs(top, msToMicros(5_000));
    expect(tsMicros(U) < tsMicros(A) && tsMicros(S) <= tsMicros(U), "fixture: S ≤ U < A").toBe(true);
    const c = await rawSql();
    await c.query(
      `update slack_sync_channels
          set newest_anchor_ts = $2, newest_lower_ts = $3, newest_request_lower_ts = $4,
              newest_segment_lower_ts = $5, newest_segment_upper_ts = $6,
              newest_scan_generation = newest_scan_generation + 1, next_lane = 'newest'
        where team_id = $1`,
      [seed.teamId, A, top, L, S, U]
    );
    await elapse(seed.teamId);
    const outcome = await settle(discover(seed, integrationId, fake));
    expect({ outcome, request: requestOf(fake) }, "the active segment's literal U is the upper bound, not the envelope anchor").toEqual({
      outcome: { categories: ["ok:"] },
      request: [{ oldest: S, latest: U, inclusive: "true", cursor: null }],
    });
  });

  it("a historical segment with literal 0 < S ≤ U < A is requested as oldest = S, latest = U, inclusive = true", async () => {
    const seed = await seedTeam();
    const integrationId = await setup(seed);
    const fake = pass(() => slackJson(historyBody({ messages: [] })));
    const top = await certifiedChannel(seed, integrationId, fake);
    // A valid progressed historical literal resumed below the certified bottom:
    //  - A = top, S = top − 20 s, U = top − 10 s, so 0 < S ≤ U < A;
    //  - the completed-segments aggregate is top − 5 s, in (U, A];
    //  - attempt-oldest null, C/H empty, G + 1, and the floor not yet reached.
    const S = shiftTs(top, -msToMicros(20_000));
    const U = shiftTs(top, -msToMicros(10_000));
    const aggregate = shiftTs(top, -msToMicros(5_000));
    expect(tsMicros(S) > BigInt(0) && tsMicros(S) <= tsMicros(U) && tsMicros(U) < tsMicros(top), "fixture: 0 < S ≤ U < A").toBe(true);
    const c = await rawSql();
    await c.query(
      `update slack_sync_channels
          set historical_anchor_ts = $2, historical_segment_lower_ts = $3, historical_segment_upper_ts = $4,
              historical_completed_segments_oldest_ts = $5, historical_oldest_seen_ts = null,
              historical_cursor = null, historical_cursor_history = '[]'::jsonb,
              historical_scan_generation = historical_scan_generation + 1,
              historical_floor_reached = false, next_lane = 'historical'
        where team_id = $1`,
      [seed.teamId, top, S, U, aggregate]
    );
    await elapse(seed.teamId);
    const outcome = await settle(discover(seed, integrationId, fake));
    expect({ outcome, request: requestOf(fake) }, "a historical segment above zero sends its own S and U").toEqual({
      outcome: { categories: ["ok:"] },
      request: [{ oldest: S, latest: U, inclusive: "true", cursor: null }],
    });
  });
});

// ── AIO-1170 packet 4c/4d: the L > A step end to end (DH-09), and page_outside_segment (DH-13) ───

/**
 * Status against GREEN3 `9ee7dbd7`:
 *  - 4c, DH-09 (2 tests), expected GREEN: GREEN3 already records the claim-local delay and continues.
 *    These pin that behavior end to end on real PostgreSQL:
 *     - an invalid candidate gives exactly one static `delayed / scan_bounds_invalid` step, one
 *       bookkeeping transition, zero history HTTP and its certificate unchanged;
 *     - 51 invalid candidates (historical work exhausted) come before a 52nd eligible one, past the
 *       default 50-row boundary. That candidate's history is `ok` in the SAME pass with exactly one
 *       HTTP request, and every invalid candidate is transitioned exactly once.
 *    The unsent provider-budget refusal that KEEPS its turn is the contrast already pinned by
 *    "gives the newest lane the next real slot after a deferred wake".
 *  - 4d, page_outside_segment (6 tests):
 *     - RED (3), each requiring the exact step, no roots, release-only row changes, and a FULL
 *       release with the turn passed to the opposite lane (claimed lane and lease expiry null):
 *        - a non-root message above U on the historical lane;
 *        - a root at S − 1 µs and a root at U + 1 µs on the newest lane. These use a deterministic
 *          literal segment whose remainders keep each edge inside its bound's millisecond.
 *       Today the first is accepted and certified, and the newest two reach the state writer, which
 *       throws;
 *     - GREEN controls (3): exact S and U are accepted and an out-of-range `thread_ts` is not
 *       range-filtered; malformed_timestamp precedes the range check; pagination_incomplete precedes
 *       the range check.
 *    The successor-safety part of the release is deferred to the implementation packet's two-session
 *    proof.
 */
describe("AIO-1170 DH-09 / DH-13: claim-local delay end to end, and the page range guard", () => {
  const SCAN_BOUNDS_DETAIL = "The scan bounds are inconsistent; no provider request was sent.";
  const OUTSIDE_DETAIL = "The provider returned a message outside the requested time range; the scan remains incomplete.";
  /** Columns a released, sent-but-refused page may change (§3.2 / §5). */
  const RELEASE = ["next_lane", "claimed_lane", "lease_owner", "lease_expires_at", "due_at", "last_error_code", "updated_at"];
  const without = (row: Record<string, unknown> | null | undefined, keys: readonly string[]) =>
    Object.fromEntries(Object.entries(row ?? {}).filter(([key]) => !keys.includes(key)));
  const historySteps = (result: SlackSourceDiscoveryResult) =>
    result.steps.filter((s) => s.stage === "history").map((s) => ({ result: s.result, category: s.category ?? null, detail: s.detail ?? null, channelId: s.channelId ?? null }));
  const settle = (run: Promise<SlackSourceDiscoveryResult>) =>
    run.then((result) => ({ steps: historySteps(result) }), (error: unknown) => ({ thrown: error instanceof Error ? error.name : "non-error" }));
  const ids = (count: number) => Array.from({ length: count }, (_, i) => `C0DH${String(i).padStart(3, "0")}`);

  /**
   * Bring an integration selecting `channels` to a verified binding, then REPLACE its channel rows
   * with literal public, bound rows. `invalid` channels sit under a far-future certified top
   * (newest L > A; historical floor reached); the rest are fresh. The due order follows array order.
   */
  async function seededSelection(seed: Seed, channels: readonly string[], invalid: number): Promise<string> {
    const integrationId = await setup(seed, channels);
    await discover(seed, integrationId, pass(() => slackJson(historyBody({ messages: [] }))));
    const c = await rawSql();
    const { rows } = await c.query<{ revision: string | null }>(
      `select binding_config_revision as revision from slack_sync_channels where team_id = $1 and binding_config_revision is not null limit 1`,
      [seed.teamId]
    );
    const revision = rows[0]?.revision;
    if (!revision) throw new Error("fixture: the first pass bound no channel");
    await c.query(`delete from slack_sync_channels where team_id = $1`, [seed.teamId]);
    for (const [i, channelId] of channels.entries()) {
      const bad = i < invalid;
      await c.query(
        `insert into slack_sync_channels
           (team_id, workspace_id, channel_id, public_state, public_checked_at, binding_integration_id, binding_config_revision,
            completed_lower_ts, completed_upper_ts, historical_floor_reached, next_lane, due_at)
         values ($1, $2, $3, 'public', clock_timestamp(), $4::uuid, $5, $6, $7, $8, $9,
                 timestamptz '2020-01-01 00:00:00+00' + ($10::int * interval '1 second'))`,
        [seed.teamId, WORKSPACE, channelId, integrationId, revision,
          bad ? "1718800000.000001" : null, bad ? "4102444800.000000" : null, bad, bad ? "newest" : "historical", i]
      );
    }
    await elapse(seed.teamId);
    return integrationId;
  }

  /** This team's `conversations.history` budget rows (the same table FX-01 reads), as text values. */
  async function historyBudgetRows(teamId: string): Promise<Record<string, unknown>[]> {
    const c = await rawSql();
    const { rows } = await c.query<Record<string, unknown>>(
      `select to_jsonb(b)::text as row from slack_method_budgets b
        where team_id = $1 and method = 'conversations.history' order by 1`,
      [teamId]
    );
    return rows;
  }

  /** A db client that COUNTS the L > A bookkeeping statements (a count only; no SQL text or value kept). */
  function countingDelays(counter: { delays: number }) {
    return transactionSessionDecoratedDb(db(), (session) => ({
      ...session,
      executeSql: (async (text: string, params?: unknown[]) => {
        if (/last_error_code\s*=\s*'scan_bounds_invalid'/.test(text)) counter.delays += 1;
        return session.executeSql(text, params);
      }) as TransactionSession["executeSql"],
    }));
  }

  it("DH-09: an invalid candidate is one static delayed step and one bookkeeping transition, with zero history HTTP and its certificate unchanged", async () => {
    const seed = await seedTeam();
    const [only] = ids(1);
    const integrationId = await seededSelection(seed, [only], 1);
    const before = await channelRow(seed.teamId, WORKSPACE, only);
    const budgetBefore = await historyBudgetRows(seed.teamId);
    const fake = pass(() => slackJson(historyBody({ messages: [] })));
    const counter = { delays: 0 };
    const result = await discover(seed, integrationId, fake, { client: countingDelays(counter) });
    const after = await channelRow(seed.teamId, WORKSPACE, only);
    expect({
      steps: historySteps(result),
      historyHttp: fake.countOf("conversations.history"),
      delays: counter.delays,
      // DIRECT no-reservation evidence: the history method's budget rows are exactly as before.
      budgetUnchanged: JSON.stringify(await historyBudgetRows(seed.teamId)) === JSON.stringify(budgetBefore),
      certificate: [after?.completed_lower_ts, after?.completed_upper_ts, after?.historical_floor_reached],
      lease: [after?.lease_owner, after?.claimed_lane, Number(after?.attempts), Number(after?.lease_generation)],
      turn: after?.next_lane,
    }, "a local delay sends nothing, reserves nothing and moves only its bookkeeping").toEqual({
      steps: [{ result: "delayed", category: "scan_bounds_invalid", detail: SCAN_BOUNDS_DETAIL, channelId: only }],
      historyHttp: 0,
      delays: 1,
      budgetUnchanged: true,
      certificate: [before?.completed_lower_ts, before?.completed_upper_ts, before?.historical_floor_reached],
      lease: [null, null, Number(before?.attempts), Number(before?.lease_generation)],
      turn: "historical",
    });
  });

  it("DH-09: 51 invalid candidates do not block a 52nd eligible one past the default 50-row boundary, in the SAME pass", async () => {
    const seed = await seedTeam();
    const channels = ids(52);
    const integrationId = await seededSelection(seed, channels, 51);
    const fake = pass(() => slackJson(historyBody({ messages: [] })));
    const counter = { delays: 0 };
    const result = await discover(seed, integrationId, fake, { client: countingDelays(counter) });
    const steps = historySteps(result);
    const eligible = channels[51];
    const rows = await Promise.all(channels.slice(0, 51).map((channelId) => channelRow(seed.teamId, WORKSPACE, channelId)));
    expect({
      delayedSteps: steps.filter((s) => s.category === "scan_bounds_invalid").length,
      delayedChannels: new Set(steps.filter((s) => s.category === "scan_bounds_invalid").map((s) => s.channelId)).size,
      last: steps.at(-1),
      historyHttp: fake.countOf("conversations.history"),
      delays: counter.delays,
      // All three certificate fields exactly as seeded, and no lease left behind.
      invalidCertificatesUnchanged: rows.every((row) =>
        row?.completed_lower_ts === "1718800000.000001" && row?.completed_upper_ts === "4102444800.000000"
        && row?.historical_floor_reached === true && row?.lease_owner === null),
    }, "every invalid candidate is transitioned once and the eligible one is read in the same bounded pass").toEqual({
      delayedSteps: 51,
      delayedChannels: 51,
      last: { result: "ok", category: null, detail: null, channelId: eligible },
      historyHttp: 1,
      delays: 51,
      invalidCertificatesUnchanged: true,
    });
  }, 60_000);

  /** The historical initial scan's in-flight row, then a page built from that request's bounds. */
  function guardedPass(page: (bounds: { lower: bigint; upper: bigint }, call: SlackCall) => Record<string, unknown>) {
    const seen: { inFlight: Record<string, unknown> | null } = { inFlight: null };
    const fake = pass(async (call) => {
      const latest = call.params.get("latest");
      if (latest === null) throw new Error("fixture: a history request without latest");
      const oldest = call.params.get("oldest");
      // The claim is committed before the request, so this is the row the release must leave alone.
      seen.inFlight = await channelRow(currentTeam.id, WORKSPACE, CHANNEL);
      return slackJson(page({ lower: oldest === null ? BigInt(0) : tsMicros(oldest), upper: tsMicros(latest) }, call));
    });
    return { fake, seen };
  }
  const currentTeam = { id: "" };
  const at = (micros: bigint) => shiftTs("0.000000", micros);

  /**
   * Expect a refused-and-released page: the exact step, no roots, and only release bookkeeping moved.
   * The release is FULL and the sent request's turn PASSED. `next_lane` is the exact opposite of the
   * claimed lane, and the claimed lane, lease owner and lease expiry are all null.
   */
  async function expectOutsideSegment(
    seed: Seed,
    outcome: unknown,
    inFlight: Record<string, unknown> | null,
    rootsBefore: string[],
    passedTurnTo: "newest" | "historical"
  ) {
    const after = await channelRow(seed.teamId, WORKSPACE, CHANNEL);
    expect({
      outcome,
      roots: await threadRootTs(seed.teamId),
      onlyRelease: JSON.stringify(without(after, RELEASE)) === JSON.stringify(without(inFlight, RELEASE)),
      released: {
        nextLane: after?.next_lane ?? null,
        claimedLane: after?.claimed_lane ?? null,
        // Booleans, so no lease owner or expiry value lands in failure output.
        leaseCleared: after?.lease_owner === null,
        leaseExpiryCleared: after?.lease_expires_at === null,
        error: after?.last_error_code ?? null,
      },
    }, "the whole page is refused before any root or state write; only the fenced claim is released, turn passed").toEqual({
      outcome: { steps: [{ result: "delayed", category: "page_outside_segment", detail: OUTSIDE_DETAIL, channelId: CHANNEL }] },
      roots: rootsBefore,
      onlyRelease: true,
      released: { nextLane: passedTurnTo, claimedLane: null, leaseCleared: true, leaseExpiryCleared: true, error: "page_outside_segment" },
    });
  }

  it("DH-13 RED: a NON-ROOT message above U refuses the whole historical page (thread_ts in range does not save it)", async () => {
    const seed = await seedTeam();
    currentTeam.id = seed.teamId;
    const integrationId = await setup(seed);
    const { fake, seen } = guardedPass(({ upper }) => historyBody({
      messages: [rootMessage(at(upper)), rootMessage(at(upper + BigInt(1)), { thread_ts: at(upper) })],
    }));
    const outcome = await settle(discover(seed, integrationId, fake));
    // The claimed lane was historical, so the passed turn is newest.
    await expectOutsideSegment(seed, outcome, seen.inFlight, [], "newest");
    expect(JSON.stringify(outcome), "no raw timestamp in the report").not.toMatch(/[0-9]{10}[.][0-9]{6}/);
  });

  // DETERMINISTIC same-millisecond edges: a literal PROGRESSED newest segment, never clock-derived.
  // S and U end in `.123456`, so S − 1 µs (`.123455`) and U + 1 µs (`.123457`) stay inside the SAME
  // millisecond (remainders 456 ≠ 0 and 456 ≠ 999). No formatting or millisecond rounding can carry
  // either edge back into range.
  // U lies strictly BELOW A (`1761000010.123456`), so U + 1 µs is still inside [S, A]. A guard that
  // validated against the anchor A instead of the segment upper U would accept it, and is killed.
  const EDGE = {
    anchor: "1761000010.123456", lower: "1761000001.123456", requestLower: "1760999941.123456",
    segmentLower: "1761000000.123456", segmentUpper: "1761000005.123456",
  };
  it.each([
    { label: "a root at S − 1 µs (same millisecond as S)", bound: EDGE.segmentLower, delta: BigInt(-1), forbidden: BigInt(0) },
    { label: "a root at U + 1 µs (same millisecond as U)", bound: EDGE.segmentUpper, delta: BigInt(1), forbidden: BigInt(999) },
  ])("DH-13 RED: on the newest lane, $label refuses the whole page", async ({ bound, delta, forbidden }) => {
    const edge = tsMicros(bound) + delta;
    expect({
      remainderSafe: tsMicros(bound) % BigInt(1_000) !== forbidden,
      sameMillisecond: edge / BigInt(1_000) === tsMicros(bound) / BigInt(1_000),
    }, "fixture: the edge stays inside its bound's millisecond").toEqual({ remainderSafe: true, sameMillisecond: true });
    const seed = await seedTeam();
    currentTeam.id = seed.teamId;
    const integrationId = await setup(seed);
    const { fake, seen } = guardedPass((_bounds, call) => historyBody({
      messages: isCatchUp(call) ? [rootMessage(at(edge))] : [],
    }));
    await discover(seed, integrationId, fake); // initial historical, terminal and empty
    // A valid literal PROGRESSED newest segment, as a split (S > L) and a terminal upper segment
    // (U < A) would leave it, each incrementing G: L ≤ S ≤ U < A, L ≤ B, C/H empty, G + 1.
    expect(tsMicros(EDGE.segmentUpper) + BigInt(1) <= tsMicros(EDGE.anchor), "fixture: U + 1 µs is still at or below A").toBe(true);
    const c = await rawSql();
    await c.query(
      `update slack_sync_channels
          set newest_anchor_ts = $2, newest_lower_ts = $3, newest_request_lower_ts = $4,
              newest_segment_lower_ts = $5, newest_segment_upper_ts = $6,
              newest_scan_generation = newest_scan_generation + 1, next_lane = 'newest'
        where team_id = $1`,
      [seed.teamId, EDGE.anchor, EDGE.lower, EDGE.requestLower, EDGE.segmentLower, EDGE.segmentUpper]
    );
    await elapse(seed.teamId);
    const outcome = await settle(discover(seed, integrationId, fake));
    // The claimed lane was newest, so the passed turn is historical.
    await expectOutsideSegment(seed, outcome, seen.inFlight, [], "historical");
  });

  it("DH-13 control: roots at EXACTLY S and U are accepted, and an out-of-range thread_ts is not range-filtered", async () => {
    const seed = await seedTeam();
    currentTeam.id = seed.teamId;
    const integrationId = await setup(seed);
    const { fake } = guardedPass(({ lower, upper }, call) => historyBody({
      messages: isCatchUp(call)
        ? [rootMessage(at(upper)), rootMessage(at(upper - BigInt(2)), { thread_ts: "1718900000.000100" }), rootMessage(at(lower))]
        : [],
    }));
    await discover(seed, integrationId, fake);
    await elapse(seed.teamId);
    const result = await discover(seed, integrationId, fake);
    const catchUp = fake.calls.filter((call) => call.method === "conversations.history" && isCatchUp(call))[0];
    expect({
      steps: historySteps(result).map((s) => `${s.result}:${s.category ?? ""}`),
      roots: await threadRootTs(seed.teamId),
    }, "inclusive edges are inside; a reply's root identity is not a range test").toEqual({
      steps: ["ok:"],
      roots: [catchUp?.params.get("oldest"), catchUp?.params.get("latest")],
    });
  });

  it("DH-13 control: malformed_timestamp still precedes the range check", async () => {
    const seed = await seedTeam();
    currentTeam.id = seed.teamId;
    const integrationId = await setup(seed);
    const { fake } = guardedPass(({ upper }) => historyBody({
      messages: [rootMessage(at(upper + BigInt(1))), rootMessage("not-a-timestamp")],
    }));
    const result = await discover(seed, integrationId, fake);
    expect(historySteps(result).map((s) => s.category)).toEqual(["malformed_timestamp"]);
    expect(await threadRootTs(seed.teamId)).toEqual([]);
  });

  it("DH-13 control: pagination_incomplete (has_more with no cursor) still precedes the range check", async () => {
    const seed = await seedTeam();
    currentTeam.id = seed.teamId;
    const integrationId = await setup(seed);
    // The root lies OUTSIDE the segment (U + 1 µs), and the pagination contradiction must win anyway.
    const { fake, seen } = guardedPass(({ upper }) => historyBody({
      messages: [rootMessage(at(upper + BigInt(1)))], hasMore: true, nextCursor: null,
    }));
    const result = await discover(seed, integrationId, fake);
    const row = await channelRow(seed.teamId, WORKSPACE, CHANNEL);
    expect({
      categories: historySteps(result).map((s) => `${s.result}:${s.category ?? ""}`),
      details: historySteps(result).map((s) => s.detail),
      roots: await threadRootTs(seed.teamId),
      // Against the in-flight (claimed) row: nothing outside the release bookkeeping moved.
      onlyRelease: seen.inFlight !== null && JSON.stringify(without(row, RELEASE)) === JSON.stringify(without(seen.inFlight, RELEASE)),
      state: {
        cursor: row?.historical_cursor ?? null, completedLower: row?.completed_lower_ts ?? null,
        completedUpper: row?.completed_upper_ts ?? null, error: row?.last_error_code ?? null,
      },
    }, "a structurally contradictory page is refused for that reason, with nothing written").toEqual({
      categories: ["delayed:pagination_incomplete"],
      details: ["The page could not be read in full, so nothing from it was enqueued or certified."],
      roots: [],
      onlyRelease: true,
      state: { cursor: null, completedLower: null, completedUpper: null, error: "pagination_incomplete" },
    });
  });
});

// ── AIO-1170 packet 5: the caller's acceptance transaction (§3.2, §3.3, §5) ─────────────────────

/**
 * AIO-1170 AM-F2 §3.2/§5 — what discovery does with each typed acceptance outcome, and in what order.
 *
 * The contract:
 *  - structural validation runs first, before the transaction;
 *  - then, inside ONE transaction: selection authority, the full channel fence, stored-state
 *    validity, then admission (unrepresentable, repetition, entries, bytes);
 *  - acceptance comes BEFORE root enqueue, and any later failure rolls the whole transaction back;
 *  - `rejected` is released in that SAME transaction, with the sent turn passed;
 *  - `subdivided` is the writer's own transition and release, with no second caller release;
 *  - nothing is enqueued from a rejected, subdivided or refused page.
 *
 * Status against GREEN4 `3c822f1f`:
 *  - RED (11). Today the caller validates an immediate repeat EARLY (before timestamps and before
 *    authority), enqueues roots before accepting, and THROWS on any non-`written` result:
 *     1. a durable repetition (A → B → A of an older saved cursor) must be `delayed / cursor_repeated`
 *        with its exact detail, one release, zero new roots and a release-only row;
 *     1b. an IMMEDIATE repeat under current authority must match 1 exactly. Today its detail is the
 *        structural one;
 *     1c ×2. a repeated cursor with an out-of-segment or a malformed timestamp must report that
 *        STRUCTURAL category. Today it reports cursor_repeated;
 *     1d. a lease that expires after the writer's real `rejected` but before the caller's release must
 *        be `refused / stale_channel_lease`. The expired claim is not released; only its expiry moved;
 *     2 ×3. an immediate repeat under stale authority is refused, never cursor_repeated:
 *        - a SUPERSEDED lease gives `stale_channel_lease`, with the successor row exact;
 *        - a CHANGED selection gives `binding_changed`, with progress unchanged;
 *        - BOTH stale gives `binding_changed`, because selection is checked first, with the
 *          successor row exact;
 *     3. a wide over-cap continuation must be `delayed / cursor_history_entries_exceeded` with the
 *        subdivision detail. It persists the exact midpoint transition, enqueues zero roots and makes
 *        NO caller release;
 *     4. a singleton over-cap continuation must be `delayed / cursor_history_entries_exceeded` with the
 *        unsplittable detail, one release, a release-only row and zero roots. Fixture assertions prove
 *        the historical continuation ran with S = U and cursor c-1;
 *     6. acceptance before enqueue. A test-only trigger refuses a root insert while this claim's lease
 *        is still live (that is, before acceptance released it); a valid partial page must succeed.
 *  - GREEN controls (3):
 *     5. a successor reclaim during the request: `refused / stale_channel_lease`, zero roots, and the
 *        successor row exact;
 *     7. a test-only root-insert failure makes discovery THROW and roll back everything. The channel
 *        row equals its in-flight (claimed) state and there are no roots. After GREEN this failure
 *        comes after provisional acceptance;
 *     8. a stale STRUCTURAL release under a successor's lease changes nothing in the successor row.
 * Fixture routing is by the CLAIMED lane, never by whether `oldest` is present.
 * Privacy: steps are projected to { result, category, detail, keysAllowed }, and any key outside the
 * step schema fails. Roots, bounds and histories are compared as booleans and counts, so no cursor,
 * bound or payload lands in failure output. The release counter matches only the CHANNEL release
 * statement, whatever its parameter numbers.
 * For rejected cases it also records whether that release ran on the SAME transaction session as the
 * acceptance writer's locking read, which is the direct proof of a same-transaction release. Cases
 * 1–4 (1b, 1c, 1d and 2 included) assert that exactly one decisive historical continuation ran.
 */
describe("AIO-1170 §3.2/§5: the discovery caller's acceptance transaction", () => {
  const REPEAT_DETAIL = "The page repeated a saved cursor; no roots or coverage were accepted.";
  const SUBDIVIDED_DETAIL = "The scan was divided into a smaller time range; no roots from this page were accepted.";
  const UNSPLITTABLE_DETAIL = "The provider continuation cannot be followed for this timestamp range; the scan remains incomplete.";
  /** §3.2: the only columns a true rejection's release may change. */
  const RELEASE = ["next_lane", "claimed_lane", "lease_owner", "lease_expires_at", "due_at", "last_error_code", "updated_at"];
  /** §5: the columns the writer's subdivision may change. */
  const SUBDIVISION = [
    "historical_segment_lower_ts", "historical_cursor", "historical_cursor_history", "historical_oldest_seen_ts",
    "historical_scan_generation", ...RELEASE,
  ];
  const without = (row: Record<string, unknown> | null | undefined, keys: readonly string[]) =>
    JSON.stringify(Object.fromEntries(Object.entries(row ?? {}).filter(([key]) => !keys.includes(key))));
  /** The only keys a history step may carry: a cursor, bound or payload field would fail `keysAllowed`. */
  const STEP_KEYS = ["stage", "method", "result", "category", "detail", "channelId", "nextPermittedAt"];
  const steps = (result: SlackSourceDiscoveryResult) =>
    result.steps.filter((s) => s.stage === "history").map((s) => ({
      result: s.result, category: s.category ?? null, detail: s.detail ?? null,
      keysAllowed: Object.keys(s).every((key) => STEP_KEYS.includes(key)),
    }));
  const settle = (run: Promise<SlackSourceDiscoveryResult>) =>
    run.then((result) => ({ steps: steps(result) }), (error: unknown) => ({ thrown: error instanceof Error ? error.name : "non-error" }));
  const row = (seed: Seed) => channelRow(seed.teamId, WORKSPACE, CHANNEL);
  const fillers = (count: number) => Array.from({ length: count }, (_, i) => `fill-${String(i).padStart(3, "0")}`);
  /** Root facts as a count and an equality boolean, so no synthetic timestamp lands in failure output. */
  const rootFacts = async (seed: Seed, expected: readonly string[]) => {
    const roots = await threadRootTs(seed.teamId);
    return { count: roots.length, exact: JSON.stringify(roots) === JSON.stringify(expected) };
  };

  /**
   * A historical scan whose continuations are scripted by `continuation`.
   *  - The first page is partial, with cursor `c-1` and `firstRoots`.
   *  - Every NEWEST request is an empty terminal page.
   * Routing is by the CLAIMED lane, read from the committed in-flight row, never by whether `oldest`
   * is present: a historical segment above zero (a singleton, say) sends `oldest` too. `inFlight` holds
   * the claimed row as the last continuation request saw it, and `continuations` counts them.
   */
  function scripted(
    seed: Seed,
    continuation: (call: SlackCall) => Promise<Response> | Response,
    firstRoots: string[] = []
  ): { fake: SlackFake; inFlight: { row: Record<string, unknown> | null; continuations: number } } {
    const inFlight: { row: Record<string, unknown> | null; continuations: number } = { row: null, continuations: 0 };
    const fake = pass(async (call) => {
      const claimed = await row(seed);
      if (claimed?.claimed_lane === "newest") return slackJson(historyBody({ messages: [] }));
      if (call.params.get("cursor") === null) {
        return slackJson(historyBody({ messages: firstRoots.map((ts) => rootMessage(ts)), hasMore: true, nextCursor: "c-1" }));
      }
      inFlight.row = claimed;
      inFlight.continuations += 1;
      return continuation(call);
    });
    return { fake, inFlight };
  }
  /** Initial historical page (cursor c-1), then the empty newest catch-up. The next wake is historical. */
  async function startedScan(seed: Seed, integrationId: string, fake: SlackFake): Promise<void> {
    await discover(seed, integrationId, fake);
    await elapse(seed.teamId);
    await discover(seed, integrationId, fake);
    await elapse(seed.teamId);
    expect(await row(seed), "fixture: the historical continuation is next").toMatchObject({ historical_cursor: "c-1", next_lane: "historical" });
  }
  /**
   * The CHANNEL release writer's statement, matched whatever its parameter numbers. It is an update of
   * `slack_sync_channels` that clears `lease_owner` and sets the due-at clause. A binding delay or any
   * other writer cannot match it, nor trigger the expiry injection below.
   */
  const RELEASE_STATEMENT =
    /update\s+slack_sync_channels[\s\S]*lease_owner\s*=\s*null[\s\S]*due_at\s*=\s*coalesce\(\$\d+::timestamptz,\s*clock_timestamp\(\)\)/i;
  /**
   * The acceptance writer's own locking read on this session, recognized by the stored-history
   * validity check only that read performs (a SQL-local function name, never a value).
   */
  const ACCEPTANCE_LOCK = /slack_channel_cursor_history_valid\([\s\S]*for\s+update/i;
  type ReleaseCounter = { releases: number; releasesInAcceptanceTx: number };
  const newCounter = (): ReleaseCounter => ({ releases: 0, releasesInAcceptanceTx: 0 });
  /**
   * A db client that COUNTS channel release statements (counts only; no SQL text or value is kept).
   * `decorate` runs once per TRANSACTION, so `acceptedHere` is per session. A release counted in
   * `releasesInAcceptanceTx` ran on the SAME transaction session as the acceptance writer's locking
   * read. That is the same-transaction release §3.2 requires.
   *
   * With `expireBeforeRelease`, the FIRST release is preceded, on that same session, by expiring this
   * team's claim: a lease expiring after the writer's verdict but before the caller's release.
   */
  function countingReleases(counter: ReleaseCounter, opts: { expireBeforeRelease?: string } = {}) {
    return transactionSessionDecoratedDb(db(), (session) => {
      let acceptedHere = false;
      return {
        ...session,
        executeSql: (async (text: string, params?: unknown[]) => {
          if (ACCEPTANCE_LOCK.test(text)) acceptedHere = true;
          if (RELEASE_STATEMENT.test(text)) {
            counter.releases += 1;
            if (acceptedHere) counter.releasesInAcceptanceTx += 1;
            if (opts.expireBeforeRelease && counter.releases === 1) {
              await session.executeSql(
                "update slack_sync_channels set lease_expires_at = clock_timestamp() - interval '1 second' where team_id = $1",
                [opts.expireBeforeRelease]
              );
            }
          }
          return session.executeSql(text, params);
        }) as TransactionSession["executeSql"],
      };
    });
  }
  /** Supersede the in-flight claim the way a reclaim leaves it: a new owner and a bumped fence. */
  async function successorReclaim(seed: Seed): Promise<void> {
    const c = await rawSql();
    await c.query(
      `update slack_sync_channels
          set lease_owner = gen_random_uuid()::text, lease_generation = lease_generation + 1,
              lease_expires_at = clock_timestamp() + interval '5 minutes'
        where team_id = $1`,
      [seed.teamId]
    );
  }

  it("1 RED: a durable repetition of an OLDER saved cursor is delayed / cursor_repeated, released in the same pass, with zero roots", async () => {
    const seed = await seedTeam();
    const integrationId = await setup(seed);
    const { fake, inFlight } = scripted(seed, (call) => {
      // c-1 → c-2, then c-2 → c-1: the repeated cursor is an OLDER entry of H, not the one just sent.
      return call.params.get("cursor") === "c-1"
        ? slackJson(historyBody({ messages: [rootMessage("1718900000.000800")], hasMore: true, nextCursor: "c-2" }))
        : slackJson(historyBody({ messages: [rootMessage("1718900000.000700")], hasMore: true, nextCursor: "c-1" }));
    }, ["1718900000.000900"]);
    await startedScan(seed, integrationId, fake);
    await discover(seed, integrationId, fake); // c-1 → c-2, accepted
    await elapse(seed.teamId);
    await discover(seed, integrationId, fake); // newest, empty
    await elapse(seed.teamId);
    const rootsBefore = await threadRootTs(seed.teamId);
    inFlight.continuations = 0; // count only the decisive pass's continuation
    const counter = newCounter();
    const outcome = await settle(discover(seed, integrationId, fake, { client: countingReleases(counter) })); // c-2 → c-1
    const after = await row(seed);
    expect({ continuationRan: inFlight.continuations }, "fixture: exactly the decisive historical continuation ran").toEqual({ continuationRan: 1 });
    expect({
      outcome, releases: counter.releases, sameTransactionReleases: counter.releasesInAcceptanceTx,
      roots: await rootFacts(seed, rootsBefore),
      onlyRelease: without(after, RELEASE) === without(inFlight.row, RELEASE),
      released: { next: after?.next_lane, leaseCleared: after?.lease_owner === null, claimedCleared: after?.claimed_lane === null, error: after?.last_error_code },
    }, "durable repetition: typed rejection, one same-transaction release, no root, nothing else moved").toEqual({
      outcome: { steps: [{ result: "delayed", category: "cursor_repeated", detail: REPEAT_DETAIL, keysAllowed: true }] },
      releases: 1, sameTransactionReleases: 1, roots: { count: rootsBefore.length, exact: true }, onlyRelease: true,
      released: { next: "newest", leaseCleared: true, claimedCleared: true, error: "cursor_repeated" },
    });
  });

  it("1b RED: an IMMEDIATE repeat under current authority matches durable repetition exactly (category, detail, release-only row, no root)", async () => {
    const seed = await seedTeam();
    const integrationId = await setup(seed);
    // Otherwise valid: an in-range root, and the SAME cursor it was asked with.
    const { fake, inFlight } = scripted(seed, (call) =>
      slackJson(historyBody({ messages: [rootMessage(rootAtUpper(call))], hasMore: true, nextCursor: String(call.params.get("cursor")) })),
    ["1718900000.000900"]);
    await startedScan(seed, integrationId, fake);
    const rootsBefore = await threadRootTs(seed.teamId);
    const counter = newCounter();
    const outcome = await settle(discover(seed, integrationId, fake, { client: countingReleases(counter) }));
    const after = await row(seed);
    expect({ continuationRan: inFlight.continuations }, "fixture: exactly the decisive historical continuation ran").toEqual({ continuationRan: 1 });
    expect({
      outcome, releases: counter.releases, sameTransactionReleases: counter.releasesInAcceptanceTx,
      roots: await rootFacts(seed, rootsBefore),
      onlyRelease: without(after, RELEASE) === without(inFlight.row, RELEASE),
      released: { next: after?.next_lane, leaseCleared: after?.lease_owner === null, error: after?.last_error_code },
    }, "an early repeat must be indistinguishable from the durable one").toEqual({
      outcome: { steps: [{ result: "delayed", category: "cursor_repeated", detail: REPEAT_DETAIL, keysAllowed: true }] },
      releases: 1, sameTransactionReleases: 1, roots: { count: rootsBefore.length, exact: true }, onlyRelease: true,
      released: { next: "newest", leaseCleared: true, error: "cursor_repeated" },
    });
  });

  it.each([
    {
      label: "a message outside the segment", category: "page_outside_segment",
      detail: "The provider returned a message outside the requested time range; the scan remains incomplete.",
      messages: (call: SlackCall) => [rootMessage(shiftTs(rootAtUpper(call), BigInt(1)))],
    },
    {
      label: "a malformed timestamp", category: "malformed_timestamp",
      detail: "The page could not be read in full, so nothing from it was enqueued or certified.",
      messages: (call: SlackCall) => [rootMessage(rootAtUpper(call)), rootMessage("not-a-timestamp")],
    },
  ])("1c RED: structural precedence — a repeated cursor with $label reports the STRUCTURAL category, not cursor_repeated", async ({ category, detail, messages }) => {
    const seed = await seedTeam();
    const integrationId = await setup(seed);
    const { fake, inFlight } = scripted(seed, (call) =>
      slackJson(historyBody({ messages: messages(call), hasMore: true, nextCursor: String(call.params.get("cursor")) })),
    ["1718900000.000900"]);
    await startedScan(seed, integrationId, fake);
    const rootsBefore = await threadRootTs(seed.teamId);
    const outcome = await settle(discover(seed, integrationId, fake));
    const after = await row(seed);
    expect({ continuationRan: inFlight.continuations }, "fixture: exactly the decisive historical continuation ran").toEqual({ continuationRan: 1 });
    expect({
      outcome, roots: await rootFacts(seed, rootsBefore),
      onlyRelease: without(after, RELEASE) === without(inFlight.row, RELEASE),
      error: after?.last_error_code,
    }, "structural validation precedes repetition").toEqual({
      outcome: { steps: [{ result: "delayed", category, detail, keysAllowed: true }] },
      roots: { count: rootsBefore.length, exact: true }, onlyRelease: true, error: category,
    });
  });

  it("1d RED: a lease that EXPIRES after the writer's rejection but before the caller's release is refused, not released", async () => {
    const seed = await seedTeam();
    const integrationId = await setup(seed);
    // The same durable A → B → A repetition as case 1, so the writer's verdict is a real `rejected`.
    const { fake, inFlight } = scripted(seed, (call) =>
      call.params.get("cursor") === "c-1"
        ? slackJson(historyBody({ messages: [rootMessage("1718900000.000800")], hasMore: true, nextCursor: "c-2" }))
        : slackJson(historyBody({ messages: [rootMessage("1718900000.000700")], hasMore: true, nextCursor: "c-1" })),
    ["1718900000.000900"]);
    await startedScan(seed, integrationId, fake);
    await discover(seed, integrationId, fake); // c-1 → c-2, accepted
    await elapse(seed.teamId);
    await discover(seed, integrationId, fake); // newest, empty
    await elapse(seed.teamId);
    const rootsBefore = await threadRootTs(seed.teamId);
    inFlight.continuations = 0; // count only the decisive pass's continuation
    const counter = newCounter();
    const outcome = await settle(discover(seed, integrationId, fake, {
      client: countingReleases(counter, { expireBeforeRelease: seed.teamId }),
    }));
    const after = await row(seed);
    expect({ continuationRan: inFlight.continuations }, "fixture: exactly the decisive historical continuation ran").toEqual({ continuationRan: 1 });
    expect({
      outcome, releases: counter.releases, sameTransactionReleases: counter.releasesInAcceptanceTx,
      roots: await rootFacts(seed, rootsBefore),
      // The expired claim is NOT released: everything but the expiry itself is the in-flight row.
      onlyExpiryMoved: without(after, ["lease_expires_at"]) === without(inFlight.row, ["lease_expires_at"]),
      leaseStillOwned: after?.lease_owner === inFlight.row?.lease_owner && after?.lease_owner !== null,
    }, "a stale release reports refusal and never overwrites the row").toEqual({
      outcome: { steps: [{ result: "refused", category: "stale_channel_lease", detail: "The world changed while the page was in flight; no root was queued and no cursor moved.", keysAllowed: true }] },
      releases: 1, sameTransactionReleases: 1, roots: { count: rootsBefore.length, exact: true }, onlyExpiryMoved: true, leaseStillOwned: true,
    });
  });

  it.each([
    { label: "a superseded lease", stale: "stale_channel_lease", mutate: (seed: Seed) => successorReclaim(seed), exactRow: true },
    { label: "a changed selection", stale: "binding_changed", mutate: (seed: Seed) => setSlackChannelIds(seed, [CHANNEL, "C0SOURCE9"]), exactRow: false },
    {
      // BOTH stale: selection authority is checked FIRST, so the category is binding_changed. The
      // successor's row is exact, because the stale caller's release cannot fence it.
      label: "a changed selection AND a superseded lease",
      stale: "binding_changed",
      mutate: async (seed: Seed) => {
        await setSlackChannelIds(seed, [CHANNEL, "C0SOURCE9"]);
        await successorReclaim(seed);
      },
      exactRow: true,
    },
  ])("2 RED: authority beats repetition — an immediate repeat under $label is refused, never cursor_repeated", async ({ stale, mutate, exactRow }) => {
    const seed = await seedTeam();
    const integrationId = await setup(seed);
    let afterMutation: Record<string, unknown> | null = null;
    const { fake, inFlight } = scripted(seed, async (call) => {
      await mutate(seed);
      afterMutation = await row(seed);
      // Otherwise valid: an in-range root, and the SAME cursor it was asked with.
      return slackJson(historyBody({ messages: [rootMessage(rootAtUpper(call))], hasMore: true, nextCursor: String(call.params.get("cursor")) }));
    }, ["1718900000.000900"]);
    await startedScan(seed, integrationId, fake);
    const rootsBefore = await threadRootTs(seed.teamId);
    const outcome = await settle(discover(seed, integrationId, fake));
    const after = await row(seed);
    expect({ continuationRan: inFlight.continuations }, "fixture: exactly the decisive historical continuation ran").toEqual({ continuationRan: 1 });
    expect({
      outcome, roots: await rootFacts(seed, rootsBefore),
      // A superseded lease leaves the SUCCESSOR's row exactly; a stale selection may only release.
      preserved: exactRow
        ? JSON.stringify(after) === JSON.stringify(afterMutation)
        : without(after, RELEASE) === without(inFlight.row, RELEASE),
    }, "stale authority is refused before any admission category").toEqual({
      outcome: { steps: [{ result: "refused", category: stale, detail: "The world changed while the page was in flight; no root was queued and no cursor moved.", keysAllowed: true }] },
      roots: { count: rootsBefore.length, exact: true },
      preserved: true,
    });
  });

  it("3 RED: a WIDE over-cap continuation is the writer's subdivision: exact midpoint, zero roots, no caller release", async () => {
    const seed = await seedTeam();
    const integrationId = await setup(seed);
    const { fake, inFlight } = scripted(seed, (call) =>
      slackJson(historyBody({ messages: [rootMessage(rootAtUpper(call))], hasMore: true, nextCursor: "c-new" })));
    await startedScan(seed, integrationId, fake);
    const c = await rawSql();
    // At the 1,000-entry cap on the wide [0, A] segment: 999 fillers, then the current cursor c-1.
    await c.query(`update slack_sync_channels set historical_cursor_history = $2::jsonb where team_id = $1`,
      [seed.teamId, JSON.stringify([...fillers(999), "c-1"])]);
    const counter = newCounter();
    const outcome = await settle(discover(seed, integrationId, fake, { client: countingReleases(counter) }));
    const after = await row(seed);
    const upper = tsMicros(String(inFlight.row?.historical_segment_upper_ts));
    const midpointPlusOne = shiftTs("0.000000", (tsMicros(String(inFlight.row?.historical_segment_lower_ts)) + upper) / BigInt(2) + BigInt(1));
    expect({
      continuationRan: inFlight.continuations === 1 && inFlight.row !== null,
      outcome, releases: counter.releases, roots: await rootFacts(seed, []),
      unauthorizedUnchanged: without(after, SUBDIVISION) === without(inFlight.row, SUBDIVISION),
      // Booleans and counts only: no bound, cursor or history lands in failure output.
      transition: {
        lowerIsMidpointPlusOne: after?.historical_segment_lower_ts === midpointPlusOne,
        upperUnchanged: after?.historical_segment_upper_ts === inFlight.row?.historical_segment_upper_ts,
        cursorCleared: after?.historical_cursor === null,
        historyLength: Array.isArray(after?.historical_cursor_history) ? (after?.historical_cursor_history as unknown[]).length : -1,
        attemptOldestCleared: after?.historical_oldest_seen_ts === null,
        generationIncremented: Number(after?.historical_scan_generation) === Number(inFlight.row?.historical_scan_generation) + 1,
        next: after?.next_lane, leaseCleared: after?.lease_owner === null && after?.claimed_lane === null,
        error: after?.last_error_code,
      },
    }, "the subdivision is the writer's own transition and release").toEqual({
      continuationRan: true,
      outcome: { steps: [{ result: "delayed", category: "cursor_history_entries_exceeded", detail: SUBDIVIDED_DETAIL, keysAllowed: true }] },
      releases: 0, roots: { count: 0, exact: true }, unauthorizedUnchanged: true,
      transition: {
        lowerIsMidpointPlusOne: true, upperUnchanged: true, cursorCleared: true, historyLength: 0, attemptOldestCleared: true,
        generationIncremented: true, next: "newest", leaseCleared: true, error: "cursor_history_entries_exceeded",
      },
    });
  });

  it("4 RED: a SINGLETON over-cap continuation is an unsplittable rejection: one release only, zero roots", async () => {
    const seed = await seedTeam();
    const integrationId = await setup(seed);
    const { fake, inFlight } = scripted(seed, (call) =>
      slackJson(historyBody({ messages: [rootMessage(rootAtUpper(call))], hasMore: true, nextCursor: "c-new" })));
    await startedScan(seed, integrationId, fake);
    const c = await rawSql();
    // A singleton S = U = A segment at the entry cap. This is a CONSTRUCTED state: it intentionally
    // bypasses the split/terminal transitions (and their generation increments) that would reach a
    // singleton in production. It is CHECK-valid, and a singleton is all the writer's rejection needs.
    await c.query(
      `update slack_sync_channels
          set historical_segment_lower_ts = historical_segment_upper_ts, historical_oldest_seen_ts = null,
              historical_cursor_history = $2::jsonb
        where team_id = $1`,
      [seed.teamId, JSON.stringify([...fillers(999), "c-1"])]
    );
    const counter = newCounter();
    const outcome = await settle(discover(seed, integrationId, fake, { client: countingReleases(counter) }));
    const after = await row(seed);
    // Fixture proof that the HISTORICAL continuation really ran, with S = U and cursor c-1 in flight
    // (a singleton above zero sends `oldest`, which is why routing is by the claimed lane).
    expect({
      continuationRan: inFlight.continuations === 1 && inFlight.row !== null,
      claimedHistorical: inFlight.row?.claimed_lane === "historical",
      singleton: inFlight.row?.historical_segment_lower_ts === inFlight.row?.historical_segment_upper_ts,
      cursorInFlight: inFlight.row?.historical_cursor === "c-1",
      historyAtCap: Array.isArray(inFlight.row?.historical_cursor_history) && (inFlight.row?.historical_cursor_history as unknown[]).length === 1000,
    }, "fixture: the singleton historical continuation was requested").toEqual({
      continuationRan: true, claimedHistorical: true, singleton: true, cursorInFlight: true, historyAtCap: true,
    });
    expect({
      outcome, releases: counter.releases, sameTransactionReleases: counter.releasesInAcceptanceTx,
      roots: await rootFacts(seed, []),
      onlyRelease: without(after, RELEASE) === without(inFlight.row, RELEASE),
      released: { next: after?.next_lane, leaseCleared: after?.lease_owner === null, error: after?.last_error_code },
    }, "an unsplittable range: typed rejection, one same-transaction release, nothing else moved").toEqual({
      outcome: { steps: [{ result: "delayed", category: "cursor_history_entries_exceeded", detail: UNSPLITTABLE_DETAIL, keysAllowed: true }] },
      releases: 1, sameTransactionReleases: 1, roots: { count: 0, exact: true }, onlyRelease: true,
      released: { next: "newest", leaseCleared: true, error: "cursor_history_entries_exceeded" },
    });
  });

  it("5 control: a successor reclaim during the request is refused / stale_channel_lease, zero roots, the successor row exact", async () => {
    const seed = await seedTeam();
    const integrationId = await setup(seed);
    let afterMutation: Record<string, unknown> | null = null;
    const { fake } = scripted(seed, async (call) => {
      await successorReclaim(seed);
      afterMutation = await row(seed);
      return slackJson(historyBody({ messages: [rootMessage(rootAtUpper(call))], hasMore: true, nextCursor: "c-2" }));
    }, ["1718900000.000900"]);
    await startedScan(seed, integrationId, fake);
    const rootsBefore = await threadRootTs(seed.teamId);
    const outcome = await settle(discover(seed, integrationId, fake));
    expect({ outcome, roots: await rootFacts(seed, rootsBefore), successorExact: JSON.stringify(await row(seed)) === JSON.stringify(afterMutation) }).toEqual({
      outcome: { steps: [{ result: "refused", category: "stale_channel_lease", detail: "The world changed while the page was in flight; no root was queued and no cursor moved.", keysAllowed: true }] },
      roots: { count: rootsBefore.length, exact: true }, successorExact: true,
    });
  });

  /**
   * A TEST-ONLY trigger on root insertion, scoped to ONE team by a literal UUID and dropped in
   * `finally`. Its deterministic name is unique to this packet, and its static message carries no
   * cursor, bound or value.
   *  - `when = "lease_live"` refuses a root while this channel's claim is still leased, so the
   *    insert must come AFTER the acceptance that releases it;
   *  - `when = "always"` refuses every root for the team.
   */
  async function withRootTrigger<T>(seed: Seed, when: "lease_live" | "always", run: () => Promise<T>): Promise<T> {
    if (!/^[0-9a-f-]{36}$/.test(seed.teamId)) throw new Error("fixture: the team id is not a UUID");
    const c = await rawSql();
    const condition = when === "always"
      ? "true"
      : `exists (select 1 from public.slack_sync_channels s where s.team_id = new.team_id and s.workspace_id = new.workspace_id
                   and s.channel_id = new.channel_id and s.lease_owner is not null)`;
    await c.query(
      `create or replace function public.aio1170_test_root_insert_oracle() returns trigger language plpgsql as $oracle$
       begin
         if new.team_id = '${seed.teamId}'::uuid and ${condition} then
           raise exception using errcode = 'P0001', message = 'AIO1170_TEST_ROOT_INSERT_ORACLE';
         end if;
         return new;
       end
       $oracle$`
    );
    await c.query(`drop trigger if exists aio1170_test_root_insert_oracle on public.slack_sync_threads`);
    await c.query(
      `create trigger aio1170_test_root_insert_oracle before insert on public.slack_sync_threads
         for each row execute function public.aio1170_test_root_insert_oracle()`
    );
    try {
      return await run();
    } finally {
      await c.query(`drop trigger if exists aio1170_test_root_insert_oracle on public.slack_sync_threads`);
      await c.query(`drop function if exists public.aio1170_test_root_insert_oracle()`);
    }
  }

  it("6 RED: acceptance comes BEFORE root enqueue — a root insert refused while the claim is still leased must not be reached first", async () => {
    const seed = await seedTeam();
    const integrationId = await setup(seed);
    const fake = pass(() => slackJson(historyBody({ messages: [rootMessage("1718900000.000900")], hasMore: true, nextCursor: "c-1" })));
    const outcome = await withRootTrigger(seed, "lease_live", () => settle(discover(seed, integrationId, fake)));
    const after = await row(seed);
    expect({
      outcome, roots: await rootFacts(seed, ["1718900000.000900"]),
      cursorAdvanced: after?.historical_cursor === "c-1",
      historyIsOneEntry: JSON.stringify(after?.historical_cursor_history) === JSON.stringify(["c-1"]),
    }, "the partial page is accepted first, then its one root is enqueued, in one commit").toEqual({
      outcome: { steps: [{ result: "ok", category: null, detail: null, keysAllowed: true }] },
      roots: { count: 1, exact: true }, cursorAdvanced: true, historyIsOneEntry: true,
    });
  });

  it("7 control: a root-insert failure makes discovery THROW and rolls back BOTH the acceptance and the roots", async () => {
    const seed = await seedTeam();
    const integrationId = await setup(seed);
    let inFlight: Record<string, unknown> | null = null;
    const fake = pass(async () => {
      inFlight = await row(seed);
      return slackJson(historyBody({ messages: [rootMessage("1718900000.000900")], hasMore: true, nextCursor: "c-1" }));
    });
    const outcome = await withRootTrigger(seed, "always", () => settle(discover(seed, integrationId, fake)));
    expect({ thrown: "thrown" in outcome, roots: await rootFacts(seed, []), rowIsClaimed: JSON.stringify(await row(seed)) === JSON.stringify(inFlight) },
      "no committing result: the claimed row is exactly as the request saw it and no root exists").toEqual({
      thrown: true, roots: { count: 0, exact: true }, rowIsClaimed: true,
    });
  });

  it("8 control: a stale STRUCTURAL release under a successor's lease changes nothing in the successor row", async () => {
    const seed = await seedTeam();
    const integrationId = await setup(seed);
    let afterMutation: Record<string, unknown> | null = null;
    const { fake } = scripted(seed, async (call) => {
      await successorReclaim(seed);
      afterMutation = await row(seed);
      // pagination_incomplete: has_more with no cursor, and an in-range root.
      return slackJson(historyBody({ messages: [rootMessage(rootAtUpper(call))], hasMore: true, nextCursor: null }));
    }, ["1718900000.000900"]);
    await startedScan(seed, integrationId, fake);
    const rootsBefore = await threadRootTs(seed.teamId);
    const outcome = await settle(discover(seed, integrationId, fake));
    expect({ outcome, roots: await rootFacts(seed, rootsBefore), successorExact: JSON.stringify(await row(seed)) === JSON.stringify(afterMutation) }).toEqual({
      outcome: { steps: [{ result: "delayed", category: "pagination_incomplete", detail: "The page could not be read in full, so nothing from it was enqueued or certified.", keysAllowed: true }] },
      roots: { count: rootsBefore.length, exact: true }, successorExact: true,
    });
  });
});
