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
  over: { client?: ReturnType<typeof db>; maxRequests?: number } = {}
): Promise<SlackSourceDiscoveryResult> {
  return discoverSlackSource(
    { db: over.client ?? db(), teamId: seed.teamId, integrationId },
    { fetchImpl: fake.impl, envToken: () => null, maxRequests: over.maxRequests }
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

// ── the first page ───────────────────────────────────────────────────────────

describe("the seed scan", () => {
  it("certifies exactly the interval its ONE page covered", async () => {
    const seed = await seedTeam();
    const integrationId = await setup(seed);
    // has_more is TRUE and a cursor is offered: the seed scan still ends here, because what it
    // certifies is the span this page actually returned — everything below it belongs to the
    // historical lane, which starts at that boundary rather than inheriting this cursor.
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
    expect(channel).toMatchObject({
      newest_cursor: null,
      newest_anchor_ts: null, // the scan is over; its anchor is not left behind as live state
      completed_lower_ts: "1718900000.000100",
      historical_floor_reached: false,
      next_lane: "historical",
    });
    expect(channel?.completed_upper_ts).not.toBeNull();
    expect(await threadRootTs(seed.teamId)).toEqual(["1718900000.000100", "1718900000.000300"]);
    // The first request has no lower bound; there is no certified top to catch up from yet.
    expect(fake.paramsOf("conversations.history")[0].get("oldest")).toBeNull();
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

    // Seed (newest) → historical → newest → historical. A lane position recomputed per invocation
    // would hand every slot to the same lane; the persisted `next_lane` is what stops that.
    expect(lanes).toEqual(["newest", "historical", "newest", "historical"]);
  });

  it("keeps a partial historical page as PROGRESS, and certifies only at its terminal page", async () => {
    const seed = await seedTeam();
    const integrationId = await setup(seed);
    let historical = 0;
    const fake = pass((call) => {
      if (isCatchUp(call)) return slackJson(historyBody({ messages: [] }));
      historical += 1;
      // page 1 = the seed; pages 2+ are the historical scan.
      if (historical === 1) {
        return slackJson(historyBody({ messages: [rootMessage("1718900000.000900")] }));
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

    await discover(seed, integrationId, fake); // seed
    const afterSeed = await channelRow(seed.teamId, WORKSPACE, CHANNEL);
    await elapse(seed.teamId);
    await discover(seed, integrationId, fake); // historical, partial

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
      expect(channel?.newest_anchor_ts).not.toBeNull();
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

    await discover(seed, integrationId, fake); // seed page
    await elapse(seed.teamId);
    await discover(seed, integrationId, fake); // historical page 1 → cursor "loop"
    const before = await channelRow(seed.teamId, WORKSPACE, CHANNEL);
    expect(before?.historical_cursor).toBe("loop");
    const rootsBefore = await threadRootTs(seed.teamId);
    await elapse(seed.teamId);
    await discover(seed, integrationId, fake); // newest catch-up
    await elapse(seed.teamId);

    const result = await discover(seed, integrationId, fake); // historical page 2 → "loop" again

    expect(result.steps.some((s) => s.category === "cursor_repeated")).toBe(true);
    const after = await channelRow(seed.teamId, WORKSPACE, CHANNEL);
    expect(after?.historical_cursor).toBe("loop"); // not advanced onto itself
    expect(after?.historical_floor_reached).toBe(false);
    expect(await threadRootTs(seed.teamId)).toEqual(rootsBefore);
  });

  it("restarts the SAME anchored scan on invalid_cursor, keeping what was certified", async () => {
    const seed = await seedTeam();
    const integrationId = await setup(seed);
    let historical = 0;
    const fake = pass((call) => {
      if (isCatchUp(call)) return slackJson(historyBody({ messages: [] }));
      historical += 1;
      if (historical === 1) return slackJson(historyBody({ messages: [rootMessage("1718900000.000900")] }));
      if (historical === 2) {
        return slackJson(
          historyBody({ messages: [rootMessage("1718900000.000800")], hasMore: true, nextCursor: "stale" })
        );
      }
      return slackJson({ ok: false, error: "invalid_cursor" });
    });

    await discover(seed, integrationId, fake); // seed
    const certified = await channelRow(seed.teamId, WORKSPACE, CHANNEL);
    await elapse(seed.teamId);
    await discover(seed, integrationId, fake); // historical partial
    const partial = await channelRow(seed.teamId, WORKSPACE, CHANNEL);
    await elapse(seed.teamId);
    await discover(seed, integrationId, fake); // newest catch-up
    await elapse(seed.teamId);
    await discover(seed, integrationId, fake); // historical → invalid_cursor

    const after = await channelRow(seed.teamId, WORKSPACE, CHANNEL);
    expect(after?.historical_cursor).toBeNull();
    expect(after?.historical_anchor_ts).toBe(partial?.historical_anchor_ts);
    expect(Number(after?.historical_scan_generation)).toBe(Number(partial?.historical_scan_generation) + 1);
    // A restart is not a rollback of what was already proved read.
    expect(after?.completed_lower_ts).toBe(certified?.completed_lower_ts);
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

  it("overlaps the certified boundary rather than skipping past it", async () => {
    const seed = await seedTeam();
    const integrationId = await setup(seed);
    const fake = pass((call) =>
      slackJson(historyBody({ messages: isCatchUp(call) ? [] : [rootMessage("1718900000.000100")] }))
    );

    await discover(seed, integrationId, fake); // seed → completed_upper = anchor
    const seeded = await channelRow(seed.teamId, WORKSPACE, CHANNEL);
    await elapse(seed.teamId);
    await discover(seed, integrationId, fake); // historical
    await elapse(seed.teamId);
    await discover(seed, integrationId, fake); // newest catch-up

    const catchUp = fake.calls.filter((c) => c.method === "conversations.history" && isCatchUp(c));
    expect(catchUp).toHaveLength(1);
    // The lower bound is the previous certified top, and it is INCLUSIVE — the boundary message is
    // read again, and the exact-key enqueue is what makes that harmless.
    expect(catchUp[0].params.get("oldest")).toBe(seeded?.completed_upper_ts);
    expect(catchUp[0].params.get("inclusive")).toBe("true");
  });
});
