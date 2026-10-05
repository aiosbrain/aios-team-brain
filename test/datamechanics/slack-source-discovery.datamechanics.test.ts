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
    const fake = pass(() => slackJson(historyBody({ messages: [rootMessage("1718900000.000700")] })));

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
});

// ── replay ───────────────────────────────────────────────────────────────────

describe("replay and overlap", () => {
  it("re-reports a root without disturbing the work already running on it", async () => {
    const seed = await seedTeam();
    const integrationId = await setup(seed);
    const root = "1718900000.000100";
    const fake = pass(() => slackJson(historyBody({ messages: [rootMessage(root)] })));
    await discover(seed, integrationId, fake);

    // Somebody is mid-page on that thread: a lease, a fence and a stored cursor.
    const scope = { teamId: seed.teamId, workspaceId: WORKSPACE, channelId: CHANNEL, rootTs: root };
    const claim = await tx((s) => claimSlackThread(s, scope, { leaseMs: 300_000 }));
    if (!claim) throw new Error("fixture: the queued thread should have been claimable");
    await tx((s) => checkpointSlackThread(s, claim, { pageCursor: "thread-cursor", snapshotGeneration: 3 }));
    const [before] = await threadRows(seed.teamId);

    // The overlap seam re-reports the same root on the next scan.
    await elapse(seed.teamId);
    await discover(seed, integrationId, fake);

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
