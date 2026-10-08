import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { TransactionSession } from "@/lib/db/types";
import { transactionCapability } from "@/lib/projects/context/transaction";
import {
  checkpointSlackThread,
  claimDueSlackThread,
  claimSlackThread,
  enqueueSlackThread,
  releaseSlackThreadForRetry,
  readSlackThreadSnapshot,
  writeSlackThreadSnapshot,
  purgeExpiredSlackThreadSnapshots,
  type SlackThreadClaim,
  type SlackThreadScope,
} from "@/lib/ingest/slack-thread-state";
import { hydrateOneSlackThread } from "@/lib/ingest/slack-thread-hydrator";
import { db, ingest, seedTeam, type Seed } from "./helpers";

/**
 * AIO-1170 — durable Slack pending-thread state (`slack_sync_threads`) and its lease/fence
 * primitives, against real Postgres.
 *
 * NOTHING SCHEDULES OR PUBLISHES YET. The queue owns pending work and the inactive hydrator adds
 * expiring raw staging; a lease here
 * proves ownership of a queue row, never source visibility, permission, namespace migration, body
 * completeness or permission to publish. There is deliberately no terminal/acknowledge state — that
 * belongs inside the later `ingestItem` transaction, after the publication gates.
 *
 * The failure modes only a real database can show, and which this file exists to pin:
 *
 *  1. TWO WORKERS, ONE ROW. The claim is one atomic conditional `UPDATE … RETURNING`; a racing pair
 *     of independent sessions must yield exactly ONE claim, with attempts/generation advancing once.
 *     An in-memory fake serializes by construction and would report success either way.
 *  2. FENCING. `lib/jobs/store.ts` conditions completion on id+status alone, so a stale worker can
 *     finalize a reclaimed job (design doc §"Why not the social job store"). Every write here
 *     therefore re-checks owner AND generation AND live expiry at the DB, and the tests replace a
 *     lease under an old claim to prove the old one can neither checkpoint nor requeue.
 *  3. THE DB CLOCK DECIDES. Due-ness and expiry are `clock_timestamp()` at the server, never a
 *     caller-supplied `now`. Fixtures below arrange due/expiry ONLY by writing the columns in SQL —
 *     no sleeps, no injected clock, and no production skip flag.
 *  4. THE PASSED SESSION IS THE CONNECTION. A checkpoint made inside a caller transaction that then
 *     rolls back must leave no progress behind — the proof that these functions ran on the caller's
 *     bound connection rather than the process-wide pool, which is what lets the publisher compose
 *     them later.
 *
 * Fixture state is written directly in SQL on purpose (arranging an expired lease is not an
 * operation the module exposes, and must not become one); the module under test is exercised only
 * through its exported functions.
 */

const WORKSPACE = "T0AIO1170";
const OTHER_WORKSPACE = "T0OTHERWS";
const CHANNEL = "C0THREADS";
const ROOT = "1718900000.000100";
const OTHER_ROOT = "1718900500.000000";
/**
 * The same instant as ROOT once a number is made of it, and a DIFFERENT thread identity: Slack's
 * `ts` is an opaque key that happens to look numeric, and the shared parser
 * (`parseSlackTimestamp`) accepts any number of seconds digits. Thirteen of them is what the
 * packet4a storage check refused.
 */
const PADDED_ROOT = "0001718900000.000100";
const LEASE_MS = 60_000;

// ── raw SQL client ───────────────────────────────────────────────────────────
// A SEPARATE connection from the app pool: the rollback test below is only meaningful if the
// readback cannot see the caller transaction's uncommitted work, and the constraint tests need
// SQLSTATE, which the adapter's `{ error: { message } }` envelope drops.

let raw: Client | null = null;

async function sql(): Promise<Client> {
  if (!raw) {
    raw = new Client({ connectionString: process.env.DATABASE_URL });
    await raw.connect();
    await raw.query("set time zone 'UTC'");
  }
  return raw;
}

afterAll(async () => {
  if (raw) await raw.end();
  raw = null;
});

// These cases exercise the inactive page worker with real queue/snapshot rows. Slack itself is
// deterministic here; every cursor, lease, generation and rollback assertion reads Postgres.
describe("inactive replies staging — resume, fencing and retention", () => {
  const rootMessage = { ts: ROOT, text: "root" };
  const replyOne = { ts: "1718900001.000200", text: "one" };
  const replyTwo = { ts: "1718900002.000300", text: "two" };
  const page = (messages: unknown[], hasMore: boolean, nextCursor: string | null = null): typeof fetch =>
    (async () => new Response(JSON.stringify({ ok: true, messages, has_more: hasMore,
      response_metadata: { next_cursor: nextCursor ?? "" } }), { status: 200 })) as typeof fetch;
  const input = (teamId: string) => ({ db: db(), teamId, token: "synthetic-test-token",
    methodScope: { kind: "verified" as const, teamId, workspaceId: WORKSPACE, appId: "A0THREADS" } });
  async function staged(scope: SlackThreadScope) {
    const c = await sql();
    const { rows } = await c.query<{ snapshot_generation: string; messages: { ts: string }[]; complete: boolean; stored_bytes: number }>(
      `select snapshot_generation::text as snapshot_generation,messages,complete,stored_bytes
       from slack_thread_snapshots where team_id=$1 and workspace_id=$2 and channel_id=$3 and root_ts=$4`,
      [scope.teamId, scope.workspaceId, scope.channelId, scope.rootTs]
    );
    return rows[0] ?? null;
  }
  async function freeMethod(teamId: string) {
    const c = await sql();
    await c.query(`update slack_method_budgets set next_permitted_at=clock_timestamp()-interval '1 second' where team_id=$1`, [teamId]);
  }

  it("resumes a rootless second page after reclaim and deduplicates a repeated reply", async () => {
    const seed = await seedTeam(); const scope = scopeFor(seed);
    await enqueue(scope);
    expect(await hydrateOneSlackThread(input(seed.teamId), { fetchImpl: page([rootMessage, replyOne, replyOne], true, "page-2") }))
      .toEqual({ outcome: "progressed" });
    expect((await row(scope)).snapshot_generation).toBe("1");
    await expireLease(scope); await freeMethod(seed.teamId);
    let requestedCursor: string | null = null;
    const second = (async (url: string) => { requestedCursor = new URL(url).searchParams.get("cursor");
      return page([replyOne, replyTwo], false)(url); }) as typeof fetch;
    expect(await hydrateOneSlackThread(input(seed.teamId), { fetchImpl: second })).toEqual({ outcome: "progressed" });
    expect(requestedCursor).toBe("page-2");
    expect((await staged(scope))?.messages.map((m) => m.ts)).toEqual([ROOT, replyOne.ts, replyTwo.ts]);
    expect((await staged(scope))?.complete).toBe(true);
    expect((await staged(scope))?.snapshot_generation).toBe("2");
    expect((await row(scope)).snapshot_generation).toBe("2");
    expect((await row(scope)).page_cursor).toBeNull();
  });

  it("does not reclaim a complete live snapshot or touch another workspace's older due root", async () => {
    const seed = await seedTeam();
    const scope = scopeFor(seed);
    const otherScope = { ...scope, workspaceId: OTHER_WORKSPACE, rootTs: OTHER_ROOT };
    await enqueue(otherScope, new Date(Date.now() - 60_000));
    await enqueue(scope);
    expect(await hydrateOneSlackThread(input(seed.teamId), { fetchImpl: page([rootMessage], false) }))
      .toEqual({ outcome: "progressed" });
    expect((await row(otherScope)).attempts).toBe(0);
    expect((await staged(scope))?.complete).toBe(true);
    await expireLease(scope);
    await freeMethod(seed.teamId);
    expect(await hydrateOneSlackThread(input(seed.teamId), { fetchImpl: (async () => {
      throw new Error("complete staging must not be fetched again");
    }) as typeof fetch })).toEqual({ outcome: "idle" });
    expect((await row(scope)).attempts).toBe(1);
    expect((await staged(scope))?.complete).toBe(true);
    expect((await row(otherScope)).attempts).toBe(0);
  });

  it("restarts instead of hiding conflicting observations of one exact message ID", async () => {
    const seed = await seedTeam(); const scope = scopeFor(seed);
    await enqueue(scope);
    await hydrateOneSlackThread(input(seed.teamId), { fetchImpl: page([rootMessage, replyOne], true, "page-2") });
    await expireLease(scope); await freeMethod(seed.teamId);
    expect(await hydrateOneSlackThread(input(seed.teamId), {
      fetchImpl: page([{ ...replyOne, text: "changed" }], false),
    })).toEqual({ outcome: "failed", category: "message_conflict" });
    expect((await row(scope)).page_cursor).toBeNull();
    expect((await row(scope)).status).toBe("queued");
    expect(await staged(scope)).toBeNull();
  });

  it("refuses to renew a staged page that expires while HTTP is in flight", async () => {
    const seed = await seedTeam(); const scope = scopeFor(seed);
    await enqueue(scope);
    await hydrateOneSlackThread(input(seed.teamId), { fetchImpl: page([rootMessage], true, "page-2") });
    await expireLease(scope); await freeMethod(seed.teamId);
    const c = await sql();
    const expiresDuringFetch = (async (url: string) => {
      await c.query(`update slack_thread_snapshots set expires_at=clock_timestamp()-interval '1 second' where team_id=$1`, [seed.teamId]);
      return page([replyOne], false)(url);
    }) as typeof fetch;
    expect(await hydrateOneSlackThread(input(seed.teamId), { fetchImpl: expiresDuringFetch }))
      .toEqual({ outcome: "refused", category: "stale_lease" });
    expect((await row(scope)).page_cursor).toBe("page-2");
    expect((await row(scope)).snapshot_generation).toBe("1");
    await expireLease(scope); await freeMethod(seed.teamId);
    let requestedCursor: string | null = "unset";
    const refetch = (async (url: string) => {
      requestedCursor = new URL(url).searchParams.get("cursor");
      return page([rootMessage, replyOne], false)(url);
    }) as typeof fetch;
    expect(await hydrateOneSlackThread(input(seed.teamId), { fetchImpl: refetch }))
      .toEqual({ outcome: "progressed" });
    expect(requestedCursor).toBeNull();
    expect((await staged(scope))?.messages.map((m) => m.ts)).toEqual([ROOT, replyOne.ts]);
  });

  it("restarts at page one under a new generation when staging expired, preserving no missing content", async () => {
    const seed = await seedTeam(); const scope = scopeFor(seed);
    await enqueue(scope);
    await hydrateOneSlackThread(input(seed.teamId), { fetchImpl: page([rootMessage, replyOne], true, "page-2") });
    const c = await sql();
    await c.query(`update slack_thread_snapshots set expires_at=clock_timestamp()-interval '1 second' where team_id=$1`, [seed.teamId]);
    await expireLease(scope); await freeMethod(seed.teamId);
    let requestedCursor: string | null = "unset";
    const refreshed = (async (url: string) => { requestedCursor = new URL(url).searchParams.get("cursor");
      return page([rootMessage, replyTwo], false)(url); }) as typeof fetch;
    expect(await hydrateOneSlackThread(input(seed.teamId), { fetchImpl: refreshed })).toEqual({ outcome: "progressed" });
    expect(requestedCursor).toBeNull();
    expect((await staged(scope))?.messages.map((m) => m.ts)).toEqual([ROOT, replyTwo.ts]);
    expect((await staged(scope))?.snapshot_generation).toBe("3");
    expect((await row(scope)).snapshot_generation).toBe("3");
  });

  it("requeues a deferred request at the provider budget deadline without dropping cursor or body", async () => {
    const seed = await seedTeam(); const scope = scopeFor(seed);
    await enqueue(scope);
    await hydrateOneSlackThread(input(seed.teamId), { fetchImpl: page([rootMessage], true, "page-2") });
    await expireLease(scope);
    const before = await staged(scope);
    const result = await hydrateOneSlackThread(input(seed.teamId), { fetchImpl: (async () => {
      throw new Error("deferred budget must not send HTTP"); }) as typeof fetch });
    expect(result).toEqual({ outcome: "deferred", category: "deferred" });
    const state = await row(scope);
    expect(state.status).toBe("queued");
    expect(state.page_cursor).toBe("page-2");
    expect(state.snapshot_generation).toBe("1");
    expect(new Date(state.due_at as string).getTime()).toBeGreaterThan(Date.now());
    expect(await staged(scope)).toEqual(before);
  });

  it("rejects a repeated provider cursor without replacing the staged generation", async () => {
    const seed = await seedTeam(); const scope = scopeFor(seed);
    await enqueue(scope);
    await hydrateOneSlackThread(input(seed.teamId), { fetchImpl: page([rootMessage], true, "page-2") });
    const before = await staged(scope);
    await expireLease(scope); await freeMethod(seed.teamId);
    expect(await hydrateOneSlackThread(input(seed.teamId), { fetchImpl: page([replyOne], true, "page-2") }))
      .toEqual({ outcome: "failed", category: "cursor_repeated" });
    expect(await staged(scope)).toEqual(before);
    expect((await row(scope)).page_cursor).toBe("page-2");
    expect((await row(scope)).snapshot_generation).toBe("1");
    expect((await row(scope)).status).toBe("queued");
  });

  it("backs off 429, transport failure and auth refusal without certifying an empty page", async () => {
    const cases: { name: string; fetchImpl: typeof fetch; expected: "deferred" | "failed"; category: string; minimumMs: number }[] = [
      { name: "429", fetchImpl: (async () => new Response("rate limited", { status: 429, headers: { "retry-after": "120" } })) as typeof fetch,
        expected: "deferred", category: "rate_limited", minimumMs: 110_000 },
      { name: "transport", fetchImpl: (async () => { throw new Error("socket closed"); }) as typeof fetch,
        expected: "failed", category: "transport_error", minimumMs: 50_000 },
      { name: "auth", fetchImpl: (async () => new Response(JSON.stringify({ ok: false, error: "invalid_auth" }), { status: 200 })) as typeof fetch,
        expected: "failed", category: "auth_error", minimumMs: 23 * 60 * 60_000 },
    ];
    for (const testCase of cases) {
      const seed = await seedTeam(); const scope = scopeFor(seed);
      await enqueue(scope);
      const result = await hydrateOneSlackThread(input(seed.teamId), { fetchImpl: testCase.fetchImpl });
      expect(result, testCase.name).toEqual({ outcome: testCase.expected, category: testCase.category });
      const state = await row(scope);
      expect(state.status).toBe("queued");
      expect(state.page_cursor).toBeNull();
      expect(new Date(state.due_at as string).getTime() - Date.now()).toBeGreaterThan(testCase.minimumMs);
      expect(await staged(scope)).toBeNull();
    }
  });

  it("fences reads and writes after reclaim and rolls back a snapshot when checkpoint refuses", async () => {
    const seed = await seedTeam(); const scope = scopeFor(seed);
    const stale = await claimed(scope);
    const snapshot = { messages: [rootMessage], complete: false, expiresAt: new Date(Date.now() + 60_000).toISOString() };
    await expect(tx(async (s) => {
      expect(await writeSlackThreadSnapshot(s, stale, snapshot)).toBe("written");
      const checkpoint = await checkpointSlackThread(s, { ...stale, leaseOwner: randomUUID() }, { pageCursor: "page-2", snapshotGeneration: 1 });
      expect(checkpoint.outcome).toBe("refused");
      throw new Error("rollback on checkpoint refusal");
    })).rejects.toThrow("rollback on checkpoint refusal");
    expect(await staged(scope)).toBeNull();
    await expireLease(scope);
    const fresh = await claim(scope);
    expect(fresh).not.toBeNull();
    expect(await tx((s) => readSlackThreadSnapshot(s, stale))).toBeNull();
    expect(await tx((s) => writeSlackThreadSnapshot(s, stale, snapshot))).toBe("refused");
    expect(await tx((s) => writeSlackThreadSnapshot(s, fresh!, snapshot))).toBe("written");
    expect(await tx((s) => checkpointSlackThread(s, fresh!, { pageCursor: "page-2", snapshotGeneration: 1 }))).toMatchObject({ outcome: "checkpointed" });
    expect((await staged(scope))?.snapshot_generation).toBe("1");
  });

  it("refuses a snapshot whose STORED size is over the cap even when its JSON.stringify size is under it", async () => {
    // SPEC (AIO-1170 review P3-01): one snapshot is bounded at 1 MiB, and the bound the database enforces is
    // `octet_length(messages::text)`. jsonb::text writes `": "` and `", "` where JSON.stringify writes `":"`
    // and `","`, so the SAME messages are larger stored than serialized. A cap measured in JS bytes lets a
    // thread through that Postgres then rejects with a raw 23514, which the hydrator does not catch: the lease
    // is left to expire and every reclaim crashes the same way. The refusal must be the ordinary
    // `too_large` result, decided by the same measure the constraint uses.
    const seed = await seedTeam(); const scope = scopeFor(seed);
    const live = await claimed(scope);
    const messages = Array.from({ length: 131_000 }, () => ({ a: 1 }));
    expect(Buffer.byteLength(JSON.stringify(messages), "utf8")).toBeLessThanOrEqual(1_048_576);
    // Non-vacuity: ask Postgres, not JS, so this cannot pass because the payload was simply too small.
    const stored = await tx((s) => s.executeSql<{ n: string }>(`select octet_length(($1::jsonb)::text) as n`, [JSON.stringify(messages)]));
    expect(Number(stored.rows[0].n)).toBeGreaterThan(1_048_576);

    const result = await tx((s) => writeSlackThreadSnapshot(s, live, {
      messages, complete: false, expiresAt: new Date(Date.now() + 60_000).toISOString(),
    }));
    expect(result).toBe("too_large");
    expect(await staged(scope)).toBeNull();
  });

  it("refuses a cursor history whose STORED size is over the cap even when its count and length bounds pass", async () => {
    // AIO-1170 fix-review FX-04: the same gap P3-01 closed for `messages`. `seen_cursors` is bounded in JS by entry
    // count and UTF-16 length, but the database bounds octet_length(seen_cursors::text): multibyte cursors pass the
    // first and fail the second with a raw 23514 the hydrator does not catch.
    const seed = await seedTeam(); const scope = scopeFor(seed);
    const live = await claimed(scope);
    const seenCursors = Array.from({ length: 1000 }, (_, i) => `${String(i).padStart(4, "0")}${"é".repeat(600)}`);
    expect(seenCursors.every((c) => c.length <= 1024)).toBe(true);
    const stored = await tx((s) => s.executeSql<{ n: string }>(`select octet_length(($1::jsonb)::text) as n`, [JSON.stringify(seenCursors)]));
    expect(Number(stored.rows[0].n)).toBeGreaterThan(1_048_576); // non-vacuity: Postgres, not JS, measured it

    const result = await tx((s) => writeSlackThreadSnapshot(s, live, {
      messages: [rootMessage], seenCursors, complete: false, expiresAt: new Date(Date.now() + 60_000).toISOString(),
    }));
    expect(result).toBe("too_large");
    expect(await staged(scope)).toBeNull();
  });

  it("serializes two page writes carrying the same live claim so only one generation commits", async () => {
    const seed = await seedTeam(); const scope = scopeFor(seed);
    const live = await claimed(scope);
    const writePage = (suffix: string) => tx(async (s) => {
      const written = await writeSlackThreadSnapshot(s, live, {
        messages: [rootMessage, { ts: `171890000${suffix}.000200`, text: suffix }],
        seenCursors: [`page-${suffix}`], complete: false,
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      });
      if (written === "refused") return "refused";
      return (await checkpointSlackThread(s, live, { pageCursor: `page-${suffix}`, snapshotGeneration: 1 })).outcome;
    });
    const outcomes = await Promise.all([writePage("1"), writePage("2")]);
    expect(outcomes.sort()).toEqual(["checkpointed", "refused"]);
    expect((await staged(scope))?.snapshot_generation).toBe("1");
    expect((await row(scope)).snapshot_generation).toBe("1");
    expect((await row(scope)).page_cursor).toMatch(/^page-[12]$/);
  });

  it("enforces actual JSON bytes at the database and purges expired staging without deleting the queue", async () => {
    const seed = await seedTeam(); const scope = scopeFor(seed);
    const live = await claimed(scope);
    const c = await sql();
    expect(await refusal(c.query(
      `insert into slack_thread_snapshots(team_id,workspace_id,channel_id,root_ts,snapshot_generation,messages,stored_bytes,expires_at)
       values ($1,$2,$3,$4,1,$5::jsonb,1,clock_timestamp()+interval '1 hour')`,
      [scope.teamId,scope.workspaceId,scope.channelId,scope.rootTs,JSON.stringify([rootMessage])]
    ))).toMatchObject({ code: "23514", constraint: "slack_thread_snapshots_actual_bytes_check" });
    expect(await refusal(c.query(
      `insert into slack_thread_snapshots(team_id,workspace_id,channel_id,root_ts,snapshot_generation,messages,stored_bytes,expires_at)
       values ($1,$2,$3,$4,1,$5::jsonb,1048576,clock_timestamp()+interval '1 hour')`,
      [scope.teamId,scope.workspaceId,scope.channelId,scope.rootTs,JSON.stringify([{ ts: ROOT, text: "x".repeat(1_048_576) }])]
    ))).toMatchObject({ code: "23514", constraint: "slack_thread_snapshots_actual_bytes_check" });
    expect(await tx((s) => writeSlackThreadSnapshot(s, live, { messages: [rootMessage], storedBytes: 1, complete: false,
      expiresAt: new Date(Date.now() + 60_000).toISOString() }))).toBe("written");
    expect((await staged(scope))?.stored_bytes).toBeGreaterThan(1);
    await tx((s) => checkpointSlackThread(s, live, { pageCursor: "page-2", snapshotGeneration: 1 }));
    await c.query(`update slack_thread_snapshots set expires_at=clock_timestamp()-interval '1 second' where team_id=$1`, [seed.teamId]);
    expect(await tx((s) => purgeExpiredSlackThreadSnapshots(s, 1))).toBe(1);
    expect(await staged(scope)).toBeNull();
    expect((await row(scope)).page_cursor).toBe("page-2");
    await expireLease(scope);
    let requestedCursor: string | null = "unset";
    const refetch = (async (url: string) => { requestedCursor = new URL(url).searchParams.get("cursor");
      return page([rootMessage, replyTwo], false)(url); }) as typeof fetch;
    expect(await hydrateOneSlackThread(input(seed.teamId), { fetchImpl: refetch })).toEqual({ outcome: "progressed" });
    expect(requestedCursor).toBeNull();
    expect((await staged(scope))?.messages.map((m) => m.ts)).toEqual([ROOT, replyTwo.ts]);
    expect((await row(scope)).snapshot_generation).toBe("3");
  });
});

// AIO-1170 replies transient backoff: five-minute-capped, jittered, driven by the PERSISTED lifetime
// claim ordinal. Everything here runs the real hydrator, the real `slackReservedRequest`, the real
// method reservation and the real queue against a stub `fetchImpl`; the sampler is injected through
// `options.random` so each case names its sample. The application clock chooses `due_at` (bracketed
// by a reading before and after the call); the DATABASE clock alone decides due-ness and lease
// expiry, and every temporal transition below is arranged in SQL — no sleeps, no clock bypass.
describe("inactive replies hydrator — transient backoff on the durable queue (TB-01…TB-08)", () => {
  const rootMessage = { ts: ROOT, text: "root" };
  const replyOne = { ts: "1718900001.000200", text: "one" };
  const replyTwo = { ts: "1718900002.000300", text: "two" };
  const NEAR_ONE = 1 - 2 ** -53; // the largest double below 1
  const FIVE_MINUTES = 300_000;
  const UNKNOWN = "synthetic_unrecognised_provider_text";

  /** A stub provider answer. A string body is sent verbatim, so an exact wire body can be pinned. */
  const respond = (body: unknown, status = 200): typeof fetch =>
    (async () => new Response(typeof body === "string" ? body : JSON.stringify(body), { status })) as typeof fetch;
  const page = (messages: unknown[], hasMore: boolean, nextCursor: string | null = null): typeof fetch =>
    respond({ ok: true, messages, has_more: hasMore, response_metadata: { next_cursor: nextCursor ?? "" } });
  const rejecting = (error: Error): typeof fetch => (async () => { throw error; }) as typeof fetch;
  const mustNotFetch = rejecting(new Error("fixture: this invocation must not reach HTTP"));
  const input = (teamId: string) => ({ db: db(), teamId, token: "synthetic-test-token",
    methodScope: { kind: "verified" as const, teamId, workspaceId: WORKSPACE, appId: "A0THREADS" } });

  /** The WHOLE staged row, so "preserved" compares every column — expiry and timestamps included. */
  async function snapshotRow(scope: SlackThreadScope): Promise<ThreadRow | null> {
    const c = await sql();
    const { rows } = await c.query<ThreadRow>(
      `select * from slack_thread_snapshots where team_id=$1 and workspace_id=$2 and channel_id=$3 and root_ts=$4`,
      [scope.teamId, scope.workspaceId, scope.channelId, scope.rootTs]
    );
    return rows[0] ?? null;
  }
  async function freeMethod(teamId: string) {
    const c = await sql();
    await c.query(`update slack_method_budgets set next_permitted_at=clock_timestamp()-interval '1 second' where team_id=$1`, [teamId]);
  }
  const makeDue = (scope: SlackThreadScope) => setColumn(scope, "due_at", "clock_timestamp() - interval '1 second'");
  const claimDue = (teamId: string) =>
    tx((s) => claimDueSlackThread(s, teamId, { leaseMs: LEASE_MS, workspaceId: WORKSPACE }));
  const instant = (value: unknown): number => new Date(value as string).getTime();
  const stagedTs = async (scope: SlackThreadScope): Promise<string[] | null> =>
    ((await snapshotRow(scope))?.messages as { ts: string }[] | undefined)?.map((m) => m.ts) ?? null;

  interface Attempt {
    result: unknown;
    /** Application-clock readings around the call: the chosen `due_at` is app-now + delay, between them. */
    before: number;
    after: number;
    http: number;
    samples: number;
  }

  /** One real hydrator invocation with a fixed sample, counting HTTP calls and sampler calls. */
  async function run(teamId: string, fetchImpl: typeof fetch, sample: number, options: Record<string, unknown> = {}): Promise<Attempt> {
    let http = 0;
    let samples = 0;
    const counted = (async (...args: Parameters<typeof fetch>) => { http += 1; return fetchImpl(...args); }) as typeof fetch;
    const random = (): number => { samples += 1; return sample; };
    const before = Date.now();
    const result = await hydrateOneSlackThread(input(teamId), { fetchImpl: counted, random, ...options } as never);
    return { result, before, after: Date.now(), http, samples };
  }

  /** `due_at` is exactly app-now + `delayMs` for some app-now inside the bracket. */
  function expectDue(state: ThreadRow, attempt: Attempt, delayMs: number, label = ""): void {
    expect(instant(state.due_at), `${label} due_at lower bound`).toBeGreaterThanOrEqual(attempt.before + delayMs);
    expect(instant(state.due_at), `${label} due_at upper bound`).toBeLessThanOrEqual(attempt.after + delayMs);
  }

  /** Not due by the DATABASE clock: the stored deadline is ahead of it and no claim path yields work. */
  async function expectNotYetDue(seed: Seed, scope: SlackThreadScope): Promise<void> {
    const c = await sql();
    const { rows } = await c.query<{ pending: boolean }>(
      `select due_at > clock_timestamp() as pending from slack_sync_threads
        where team_id=$1 and workspace_id=$2 and channel_id=$3 and root_ts=$4`,
      [scope.teamId, scope.workspaceId, scope.channelId, scope.rootTs]
    );
    expect(rows).toEqual([{ pending: true }]);
    const untouched = await row(scope);
    expect(await claimDue(seed.teamId)).toBeNull();
    expect(await claim(scope)).toBeNull();
    const idle = await run(seed.teamId, mustNotFetch, 0.5);
    expect(idle).toMatchObject({ result: { outcome: "idle" }, http: 0, samples: 0 });
    expect(await row(scope)).toEqual(untouched);
  }

  // ── TB-01: the real transport matrix ───────────────────────────────────────

  const timeoutError = (): Error => Object.assign(new Error("fixture: the request timed out"), { name: "TimeoutError" });
  const TRANSIENT: [string, () => typeof fetch, "provider_error" | "transport_error"][] = [
    ["JSON HTTP 500", () => respond({ ok: false }, 500), "provider_error"],
    ["JSON HTTP 503", () => respond({ ok: false, error: "service_unavailable" }, 503), "provider_error"],
    ["JSON HTTP 599", () => respond({ ok: false, error: UNKNOWN }, 599), "provider_error"],
    ["a 5xx body that claims ok:true", () => respond({ ok: true, messages: [rootMessage], has_more: false }, 502), "provider_error"],
    ["a 5xx body that carries invalid_auth", () => respond({ ok: false, error: "invalid_auth" }, 500), "provider_error"],
    ["a non-JSON 5xx", () => respond("<html>bad gateway</html>", 502), "transport_error"],
    ["a rejected fetch", () => rejecting(new Error("socket closed")), "transport_error"],
    ["a rejected fetch named TimeoutError", () => rejecting(timeoutError()), "transport_error"],
    ["HTTP 200 ratelimited", () => respond({ ok: false, error: "ratelimited" }), "provider_error"],
    ["HTTP 200 internal_error", () => respond({ ok: false, error: "internal_error" }), "provider_error"],
    ["HTTP 200 service_unavailable", () => respond({ ok: false, error: "service_unavailable" }), "provider_error"],
    ["HTTP 200 fatal_error", () => respond({ ok: false, error: "fatal_error" }), "provider_error"],
    ["HTTP 200 request_timeout", () => respond({ ok: false, error: "request_timeout" }), "provider_error"],
  ];

  it.each(TRANSIENT)("TB-01 %s takes the jittered transient path and stages nothing", async (_name, make, coarse) => {
    const seed = await seedTeam(); const scope = scopeFor(seed);
    await enqueue(scope);
    // First lifetime claim, sample 0.25: 60_000 + floor(0.25 * 60_001) = 75_000 ms — an interior value
    // that is neither the old deterministic minute, nor the flat five minutes, nor the 24-hour auth hold.
    const attempt = await run(seed.teamId, make(), 0.25);
    expect(attempt.http).toBe(1);
    expect(attempt.result).toEqual({ outcome: "failed", category: coarse });
    expect(attempt.samples).toBe(1);
    const state = await row(scope);
    expect(state).toMatchObject({
      status: "queued", last_error_code: coarse, attempts: 1, lease_generation: "1",
      lease_owner: null, lease_expires_at: null, page_cursor: null, snapshot_generation: "0",
    });
    expectDue(state, attempt, 75_000);
    // A transient response never stages a page — not even a 5xx body that says ok:true.
    expect(await snapshotRow(scope)).toBeNull();
    await expectNotYetDue(seed, scope);
  });

  const FLAT: [string, () => typeof fetch][] = [
    // The exact wire body: ok:false and NO `error` field, so the transport reports `http_499` / `http_404`.
    ["JSON HTTP 499 with no error field", () => respond('{"ok": false}', 499)],
    ["JSON HTTP 404 with no error field", () => respond('{"ok": false}', 404)],
    ["HTTP 200 with an unrecognised error", () => respond({ ok: false, error: UNKNOWN })],
    ["HTTP 200 channel_not_found", () => respond({ ok: false, error: "channel_not_found" })],
    ["HTTP 200 thread_not_found", () => respond({ ok: false, error: "thread_not_found" })],
  ];

  it.each(FLAT)("TB-01 %s keeps the flat five minutes and never samples (negative control)", async (_name, make) => {
    const seed = await seedTeam(); const scope = scopeFor(seed);
    await enqueue(scope);
    const attempt = await run(seed.teamId, make(), 0.25);
    expect(attempt.http).toBe(1);
    expect(attempt.result).toEqual({ outcome: "failed", category: "provider_error" });
    expect(attempt.samples).toBe(0);
    const state = await row(scope);
    expect(state).toMatchObject({ status: "queued", last_error_code: "provider_error", attempts: 1, lease_owner: null, page_cursor: null });
    expectDue(state, attempt, FIVE_MINUTES);
    expect(await snapshotRow(scope)).toBeNull();
    // Arbitrary remote text reaches neither the stored nor the returned category.
    expect(JSON.stringify([attempt.result, state.last_error_code])).not.toContain(UNKNOWN);
  });

  // ── TB-03: the persisted ordinal ───────────────────────────────────────────

  it("TB-03 takes the ordinal from the claim the database returned, not from how often this process ran", async () => {
    const seed = await seedTeam(); const scope = scopeFor(seed);
    // Another actor claims the row once and hands it back, in its own committed transactions, before the
    // hydrator has ever been invoked for it: stored attempts = 1, in-process hydrator invocations = 0.
    const earlier = await claimed(scope);
    expect(await tx((s) => releaseSlackThreadForRetry(s, earlier, { nextDueAt: new Date(Date.now() - 1_000) })))
      .toMatchObject({ outcome: "released" });
    expect(await row(scope)).toMatchObject({ status: "queued", attempts: 1, lease_generation: "1" });

    // The hydrator's FIRST invocation is the row's SECOND claim: sample 0 → 120_000, not a first-call 60_000.
    const first = await run(seed.teamId, respond({ ok: false }, 503), 0);
    expect(first).toMatchObject({ result: { outcome: "failed", category: "provider_error" }, http: 1, samples: 1 });
    const second = await row(scope);
    expect(second).toMatchObject({ status: "queued", attempts: 2, lease_generation: "2", last_error_code: "provider_error", lease_owner: null });
    expectDue(second, first, 120_000, "second lifetime claim");
    await expectNotYetDue(seed, scope);

    // Due by the database clock, budget free: the third lifetime claim is at the cap's lower bound.
    await makeDue(scope); await freeMethod(seed.teamId);
    const next = await run(seed.teamId, rejecting(new Error("socket closed")), 0);
    expect(next).toMatchObject({ result: { outcome: "failed", category: "transport_error" }, http: 1, samples: 1 });
    const third = await row(scope);
    expect(third).toMatchObject({ status: "queued", attempts: 3, lease_generation: "3", last_error_code: "transport_error", lease_owner: null });
    expectDue(third, next, 150_000, "third lifetime claim");

    // A different row whose stored ordinal is far past anything this process did: the cap, from the row.
    const other = await seedTeam(); const otherScope = scopeFor(other);
    await enqueue(otherScope);
    await setColumn(otherScope, "attempts", "1000000");
    const capped = await run(other.teamId, respond({ ok: false, error: "internal_error" }), 0);
    expect(capped).toMatchObject({ result: { outcome: "failed", category: "provider_error" }, http: 1, samples: 1 });
    const cappedRow = await row(otherScope);
    expect(cappedRow).toMatchObject({ status: "queued", attempts: 1_000_001, lease_generation: "1", last_error_code: "provider_error" });
    expectDue(cappedRow, capped, 150_000, "high stored ordinal");
  });

  // ── TB-04: partial state and due-ness ──────────────────────────────────────

  it("TB-04 a transient retry from a live partial snapshot preserves the staged page and resumes its cursor", async () => {
    const seed = await seedTeam(); const scope = scopeFor(seed);
    await enqueue(scope);
    expect((await run(seed.teamId, page([rootMessage, replyOne], true, "page-2"), 0.5)).result).toEqual({ outcome: "progressed" });
    await expireLease(scope); await freeMethod(seed.teamId);
    const stagedBefore = await snapshotRow(scope);
    const queueBefore = await row(scope);
    expect(stagedBefore).toMatchObject({ snapshot_generation: "1", complete: false });
    expect(queueBefore).toMatchObject({ attempts: 1, page_cursor: "page-2", snapshot_generation: "1" });

    // Second lifetime claim, sample 0.5: 120_000 + floor(0.5 * 120_001) = 180_000.
    const failure = await run(seed.teamId, respond({ ok: false, error: "fatal_error" }, 503), 0.5);
    expect(failure).toMatchObject({ result: { outcome: "failed", category: "provider_error" }, http: 1, samples: 1 });

    // The ENTIRE staged row: messages, seen cursors, complete flag, stored bytes, expiry and timestamps.
    expect(await snapshotRow(scope)).toEqual(stagedBefore);
    const released = await row(scope);
    expect(released).toMatchObject({
      id: queueBefore.id, team_id: scope.teamId, workspace_id: scope.workspaceId, channel_id: scope.channelId, root_ts: scope.rootTs,
      status: "queued", lease_owner: null, lease_expires_at: null, last_error_code: "provider_error",
      attempts: 2, page_cursor: "page-2", snapshot_generation: "1",
    });
    expect(released.lease_generation).toBe(String(Number(queueBefore.lease_generation) + 1));
    expect(released.checkpointed_at).toEqual(queueBefore.checkpointed_at);
    expect(released.created_at).toEqual(queueBefore.created_at);
    expectDue(released, failure, 180_000);
    await expectNotYetDue(seed, scope);
    expect(await snapshotRow(scope)).toEqual(stagedBefore);

    // Due by the database clock: the continuation sends the RETAINED cursor and assembles the whole body.
    await makeDue(scope); await freeMethod(seed.teamId);
    let requestedCursor: string | null = "unset";
    const continuation = (async (url: string) => { requestedCursor = new URL(url).searchParams.get("cursor");
      return page([replyOne, replyTwo], false)(url); }) as typeof fetch;
    expect((await run(seed.teamId, continuation, 0.5)).result).toEqual({ outcome: "progressed" });
    expect(requestedCursor).toBe("page-2");
    expect(await stagedTs(scope)).toEqual([ROOT, replyOne.ts, replyTwo.ts]);
    expect(await snapshotRow(scope)).toMatchObject({ complete: true, snapshot_generation: "2" });
    expect(await row(scope)).toMatchObject({ attempts: 3, page_cursor: null, snapshot_generation: "2" });
  });

  // ── TB-05: the hydrator's own fence on the transient path ──────────────────

  it("TB-05 a lease that expires before the transient release is refused, and the row is left exactly as it was", async () => {
    const seed = await seedTeam(); const scope = scopeFor(seed);
    await enqueue(scope);
    let captured: ThreadRow | null = null;
    const expiresDuringFetch = (async () => {
      await expireLease(scope);
      captured = await row(scope);
      return new Response(JSON.stringify({ ok: false }), { status: 503 });
    }) as typeof fetch;
    const attempt = await run(seed.teamId, expiresDuringFetch, 0.5);
    // Never `failed`: an expired claim has no authority to postpone or requeue anything.
    expect(attempt.result).toEqual({ outcome: "refused", category: "stale_lease" });
    expect(attempt.http).toBe(1);
    expect(attempt.samples).toBe(1);
    expect(captured).toMatchObject({ status: "running", attempts: 1, lease_generation: "1", last_error_code: null });
    expect(await row(scope)).toEqual(captured);
    expect(await snapshotRow(scope)).toBeNull();
  });

  it("TB-05 a replaced lease cannot be postponed or released by the stale hydrator's transient retry", async () => {
    const seed = await seedTeam(); const scope = scopeFor(seed);
    await enqueue(scope);
    expect((await run(seed.teamId, page([rootMessage, replyOne], true, "page-2"), 0.5)).result).toEqual({ outcome: "progressed" });
    await expireLease(scope); await freeMethod(seed.teamId);

    let replacement: SlackThreadClaim | null = null;
    let capturedQueue: ThreadRow | null = null;
    let capturedStaged: ThreadRow | null = null;
    const replacedDuringFetch = (async () => {
      await expireLease(scope);
      replacement = await claim(scope); // another worker, in its own committed transaction
      capturedQueue = await row(scope);
      capturedStaged = await snapshotRow(scope);
      return new Response(JSON.stringify({ ok: false, error: "service_unavailable" }), { status: 503 });
    }) as typeof fetch;
    const attempt = await run(seed.teamId, replacedDuringFetch, 0.5);
    expect(attempt.result).toEqual({ outcome: "refused", category: "stale_lease" });
    expect(attempt.http).toBe(1);
    expect(attempt.samples).toBe(1);

    expect(replacement).not.toBeNull();
    const live = replacement as unknown as SlackThreadClaim;
    expect(capturedQueue).toMatchObject({
      status: "running", lease_owner: live.leaseOwner, lease_generation: String(live.leaseGeneration),
      attempts: 3, page_cursor: "page-2", snapshot_generation: "1", last_error_code: null,
    });
    // Whole rows: due_at, category, owner, fence, attempts, cursor, generation, status and timestamps.
    expect(await row(scope)).toEqual(capturedQueue);
    expect(await snapshotRow(scope)).toEqual(capturedStaged);
    // The replacement's authority is intact: it can still read its staged page under its own fence.
    expect((await tx((s) => readSlackThreadSnapshot(s, live)))?.messages.map((m) => m.ts)).toEqual([ROOT, replyOne.ts]);
  });

  // ── TB-06: preservation controls on the real transport ─────────────────────

  it("TB-06 a provider cooldown, an auth refusal, a budget deferral, success and idle never consult the sampler", async () => {
    // 429 with a ten-minute Retry-After: the provider deadline wins over the five-minute transient cap.
    const limited = await seedTeam(); const limitedScope = scopeFor(limited);
    await enqueue(limitedScope);
    const cooled = await run(limited.teamId, (async () => new Response("rate limited", { status: 429, headers: { "retry-after": "600" } })) as typeof fetch, 0);
    expect(cooled).toMatchObject({ result: { outcome: "deferred", category: "rate_limited" }, http: 1, samples: 0 });
    const cooledRow = await row(limitedScope);
    expect(cooledRow).toMatchObject({ status: "queued", last_error_code: "rate_limited" });
    expect(instant(cooledRow.due_at) - cooled.before).toBeGreaterThan(590_000);

    // A credential refusal keeps the 24-hour hold.
    const refused = await seedTeam(); const refusedScope = scopeFor(refused);
    await enqueue(refusedScope);
    const auth = await run(refused.teamId, respond({ ok: false, error: "invalid_auth" }), 0);
    expect(auth).toMatchObject({ result: { outcome: "failed", category: "auth_error" }, http: 1, samples: 0 });
    expect(instant((await row(refusedScope)).due_at) - auth.before).toBeGreaterThanOrEqual(24 * 60 * 60_000);

    // Success, then a budget deferral (zero HTTP) released at the reservation's own deadline, then idle.
    const seed = await seedTeam(); const scope = scopeFor(seed);
    await enqueue(scope);
    const progressed = await run(seed.teamId, page([rootMessage], true, "page-2"), 0);
    expect(progressed).toMatchObject({ result: { outcome: "progressed" }, http: 1, samples: 0 });
    await expireLease(scope);
    const deferred = await run(seed.teamId, mustNotFetch, 0);
    expect(deferred).toMatchObject({ result: { outcome: "deferred", category: "deferred" }, http: 0, samples: 0 });
    expect(await row(scope)).toMatchObject({ status: "queued", last_error_code: "deferred", page_cursor: "page-2", attempts: 2 });
    const idle = await run(seed.teamId, mustNotFetch, 0);
    expect(idle).toMatchObject({ result: { outcome: "idle" }, http: 0, samples: 0 });
  });

  // ── TB-07: an invalid sample ───────────────────────────────────────────────

  it("TB-07 an invalid sample throws before any release: the claimed row stays exactly as it was after the claim", async () => {
    const seed = await seedTeam(); const scope = scopeFor(seed);
    await enqueue(scope);
    // No cursor and no staging, so nothing is restarted: the only writes before HTTP are the claim itself
    // and the method reservation. The row captured inside `fetchImpl` is therefore the post-claim row.
    let postClaim: ThreadRow | null = null;
    let http = 0;
    let samples = 0;
    const transient = (async () => {
      http += 1;
      postClaim = await row(scope);
      return new Response(JSON.stringify({ ok: false }), { status: 503 });
    }) as typeof fetch;
    const random = (): number => { samples += 1; return Number.NaN; };
    await expect(hydrateOneSlackThread(input(seed.teamId), { fetchImpl: transient, random } as never))
      .rejects.toBeInstanceOf(TypeError);
    expect(http).toBe(1);
    expect(samples).toBe(1);

    expect(postClaim).toMatchObject({ status: "running", attempts: 1, lease_generation: "1", last_error_code: null, page_cursor: null });
    expect((postClaim as unknown as ThreadRow).lease_owner).toEqual(expect.any(String));
    // Byte for byte: no release, no postponement, no error code, no cleanup.
    expect(await row(scope)).toEqual(postClaim);
    expect(await snapshotRow(scope)).toBeNull();

    // The method reservation it consumed is not refunded.
    const c = await sql();
    const budget = await c.query<{ held: boolean }>(
      `select next_permitted_at > clock_timestamp() as held from slack_method_budgets where team_id=$1`, [seed.teamId]);
    expect(budget.rows.length).toBeGreaterThanOrEqual(1);
    expect(budget.rows.every((r) => r.held)).toBe(true);

    // The lease is still live, so nobody else can take the row…
    expect(await claim(scope)).toBeNull();
    expect(await claimDue(seed.teamId)).toBeNull();
    expect(await row(scope)).toEqual(postClaim);
    // …until it expires, by the database clock, through the ordinary reclaim path.
    await expireLease(scope);
    const reclaimed = await claim(scope);
    expect(reclaimed).not.toBeNull();
    expect(reclaimed?.leaseOwner).not.toBe((postClaim as unknown as ThreadRow).lease_owner);
    expect(reclaimed).toMatchObject({ leaseGeneration: 2, attempts: 2, pageCursor: null, snapshotGeneration: 0 });
  });

  // ── TB-08: the five-minute cap against the snapshot TTL ────────────────────

  it("TB-08 a high lifetime ordinal still retries within five minutes, so fresh staging outlives the retry", async () => {
    const seed = await seedTeam(); const scope = scopeFor(seed);
    await enqueue(scope);
    expect((await run(seed.teamId, page([rootMessage, replyOne], true, "page-2"), 0.5)).result).toEqual({ outcome: "progressed" });
    // Forty lifetime claims of routine pagination and budget deferrals — none of them a transient failure.
    await setColumn(scope, "attempts", "40");
    await expireLease(scope); await freeMethod(seed.teamId);
    const stagedBefore = await snapshotRow(scope);

    // The top of the sampler's range at the cap: exactly five minutes, never the old 30–60 minutes.
    const failure = await run(seed.teamId, rejecting(new Error("socket closed")), NEAR_ONE);
    expect(failure).toMatchObject({ result: { outcome: "failed", category: "transport_error" }, http: 1, samples: 1 });
    const released = await row(scope);
    expect(released).toMatchObject({ status: "queued", attempts: 41, last_error_code: "transport_error", page_cursor: "page-2", snapshot_generation: "1" });
    expectDue(released, failure, FIVE_MINUTES);
    // No TTL renewal on failure, and — before any temporal fixture SQL — the retry lands inside the TTL.
    const stagedAfter = await snapshotRow(scope);
    expect(stagedAfter).toEqual(stagedBefore);
    expect(instant(released.due_at)).toBeLessThan(instant(stagedAfter?.expires_at));
    await expectNotYetDue(seed, scope);

    // Still live when the retry comes due: resume from the stored cursor, complete the body.
    await makeDue(scope); await freeMethod(seed.teamId);
    let requestedCursor: string | null = "unset";
    const continuation = (async (url: string) => { requestedCursor = new URL(url).searchParams.get("cursor");
      return page([replyTwo], false)(url); }) as typeof fetch;
    expect((await run(seed.teamId, continuation, 0.5)).result).toEqual({ outcome: "progressed" });
    expect(requestedCursor).toBe("page-2");
    expect(await stagedTs(scope)).toEqual([ROOT, replyOne.ts, replyTwo.ts]);
    expect(await snapshotRow(scope)).toMatchObject({ complete: true });
  });

  it("TB-08 staging that expires before the retry is due restarts safely at page one, with no resurrected messages", async () => {
    const seed = await seedTeam(); const scope = scopeFor(seed);
    await enqueue(scope);
    const expiredReply = { ts: "1718900009.000900", text: "staged before expiry" };
    const freshOne = { ts: "1718900011.000100", text: "fresh one" };
    const freshTwo = { ts: "1718900012.000200", text: "fresh two" };
    // Near-expiry staging: a thirty-second TTL, far shorter than any transient retry.
    expect((await run(seed.teamId, page([rootMessage, expiredReply], true, "old-2"), 0.5, { snapshotTtlMs: 30_000 })).result)
      .toEqual({ outcome: "progressed" });
    await expireLease(scope); await freeMethod(seed.teamId);
    const stagedBefore = await snapshotRow(scope);

    // Second lifetime claim, sample 0: 120_000 ms.
    const failure = await run(seed.teamId, respond({ ok: false }, 500), 0, { snapshotTtlMs: 30_000 });
    expect(failure).toMatchObject({ result: { outcome: "failed", category: "provider_error" }, http: 1, samples: 1 });
    const released = await row(scope);
    expect(released).toMatchObject({ status: "queued", attempts: 2, page_cursor: "old-2", snapshot_generation: "1", last_error_code: "provider_error" });
    expectDue(released, failure, 120_000);
    // The failure did not renew the TTL, and — before any temporal fixture SQL — staging expires first.
    const stagedAfter = await snapshotRow(scope);
    expect(stagedAfter).toEqual(stagedBefore);
    expect(instant(stagedAfter?.expires_at)).toBeLessThan(instant(released.due_at));

    // Both transitions arranged in SQL: the staging has expired AND the retry is due.
    const c = await sql();
    await c.query(`update slack_thread_snapshots set expires_at=clock_timestamp()-interval '1 second' where team_id=$1`, [seed.teamId]);
    await makeDue(scope); await freeMethod(seed.teamId);
    let requestedCursor: string | null = "unset";
    const freshFirstPage = (async (url: string) => { requestedCursor = new URL(url).searchParams.get("cursor");
      return page([rootMessage, freshOne], true, "fresh-2")(url); }) as typeof fetch;
    expect((await run(seed.teamId, freshFirstPage, 0.5)).result).toEqual({ outcome: "progressed" });
    // Page one again, under a new generation, holding exactly the fresh page.
    expect(requestedCursor).toBeNull();
    const restarted = await snapshotRow(scope);
    expect(Number(restarted?.snapshot_generation)).toBeGreaterThan(1);
    expect(restarted).toMatchObject({ complete: false });
    expect(await stagedTs(scope)).toEqual([ROOT, freshOne.ts]);
    // The root is still pending — not lost, not completed, not published.
    const pending = await row(scope);
    expect(pending).toMatchObject({ status: "running", attempts: 3, page_cursor: "fresh-2", snapshot_generation: restarted?.snapshot_generation });
    expect(await rowCount(seed.teamId)).toBe(1);
    const published = await c.query<{ n: string }>(`select count(*)::text as n from items where team_id=$1`, [seed.teamId]);
    expect(published.rows[0].n).toBe("0");

    // The terminal continuation completes the FRESH body: root and fresh replies, nothing from the expired stage.
    await expireLease(scope); await freeMethod(seed.teamId);
    const terminal = (async (url: string) => { requestedCursor = new URL(url).searchParams.get("cursor");
      return page([freshTwo], false)(url); }) as typeof fetch;
    expect((await run(seed.teamId, terminal, 0.5)).result).toEqual({ outcome: "progressed" });
    expect(requestedCursor).toBe("fresh-2");
    expect(await stagedTs(scope)).toEqual([ROOT, freshOne.ts, freshTwo.ts]);
    expect(await stagedTs(scope)).not.toContain(expiredReply.ts);
    expect(await snapshotRow(scope)).toMatchObject({ complete: true });
    expect(await rowCount(seed.teamId)).toBe(1);
  });
});

beforeAll(async () => {
  const c = await sql();
  const { rows } = await c.query<{ tablename: string }>(
    `select tablename from pg_tables where schemaname = 'public' and tablename = any($1)`,
    [["slack_sync_threads", "slack_thread_snapshots"]]
  );
  if (rows.length !== 2) {
    // A reused per-worktree container is schema-loaded only when it is CREATED
    // (scripts/dm-isolated.sh), so one that predates this change silently lacks the table.
    throw new Error(
      "Slack thread queue/snapshot tables missing from the test database. The dm container loads the schema only " +
        "when it is created — re-run with AIOS_DM_RESET=1 npm run test:datamechanics:iso " +
        "test/datamechanics/slack-thread-state.datamechanics.test.ts"
    );
  }
});

// ── fixtures ─────────────────────────────────────────────────────────────────

function scopeFor(
  seed: Seed,
  over: Partial<Omit<SlackThreadScope, "teamId">> = {}
): SlackThreadScope {
  return { teamId: seed.teamId, workspaceId: WORKSPACE, channelId: CHANNEL, rootTs: ROOT, ...over };
}

/** One real transaction on the app's pool — the shape every production caller will compose with. */
function tx<T>(fn: (session: TransactionSession) => Promise<T>): Promise<T> {
  return transactionCapability(db()).transaction(fn);
}

async function enqueue(scope: SlackThreadScope, dueAt?: Date) {
  return tx((s) => enqueueSlackThread(s, scope, dueAt ? { dueAt } : undefined));
}

async function claim(scope: SlackThreadScope, leaseMs = LEASE_MS): Promise<SlackThreadClaim | null> {
  return tx((s) => claimSlackThread(s, scope, { leaseMs }));
}

/** A committed, live claim: the baseline every fencing case below deviates from. */
async function claimed(scope: SlackThreadScope, leaseMs = LEASE_MS): Promise<SlackThreadClaim> {
  await enqueue(scope);
  const acquired = await claim(scope, leaseMs);
  if (!acquired) throw new Error("fixture: expected the queued, due row to be claimable");
  return acquired;
}

type ThreadRow = Record<string, unknown>;

/** The WHOLE row, so a "refused" assertion can compare every column rather than the ones I thought of. */
async function row(scope: SlackThreadScope): Promise<ThreadRow> {
  const c = await sql();
  const { rows } = await c.query<ThreadRow>(
    `select * from slack_sync_threads
      where team_id = $1 and workspace_id = $2 and channel_id = $3 and root_ts = $4`,
    [scope.teamId, scope.workspaceId, scope.channelId, scope.rootTs]
  );
  if (rows.length !== 1) throw new Error(`expected exactly one row, found ${rows.length}`);
  return rows[0];
}

async function rowCount(teamId?: string): Promise<number> {
  const c = await sql();
  const { rows } = await c.query<{ c: string }>(
    teamId
      ? `select count(*)::text as c from slack_sync_threads where team_id = $1`
      : `select count(*)::text as c from slack_sync_threads`,
    teamId ? [teamId] : []
  );
  return Number(rows[0].c);
}

/** Arrange due/expiry the only way this tier may: by writing the column. */
async function setColumn(scope: SlackThreadScope, column: string, expression: string): Promise<void> {
  const c = await sql();
  const { rowCount: n } = await c.query(
    `update slack_sync_threads set ${column} = ${expression}
      where team_id = $1 and workspace_id = $2 and channel_id = $3 and root_ts = $4`,
    [scope.teamId, scope.workspaceId, scope.channelId, scope.rootTs]
  );
  if (n !== 1) throw new Error(`fixture: expected to update one row, updated ${n}`);
}

const expireLease = (scope: SlackThreadScope) =>
  setColumn(scope, "lease_expires_at", "now() - interval '1 second'");

async function refusal(p: Promise<unknown>): Promise<{ code: string; constraint?: string }> {
  try {
    await p;
  } catch (err) {
    const e = err as { code?: string; constraint?: string };
    return { code: e.code ?? `no-code: ${String(err)}`, constraint: e.constraint };
  }
  return { code: "no-error" };
}

/**
 * Everything a log line, a crash reporter or a serializer could pull off a thrown error: its own
 * `String()` form, its stack, every scalar own property, and the whole `cause` chain. A validator
 * that keeps a rejected value out of `message` alone still leaks it through any of these, so the
 * non-echo assertion below is made against this, not against `err.message`.
 */
function diagnostics(err: unknown): string {
  const parts: string[] = [];
  const seen = new Set<object>();
  let node: unknown = err;
  while (node !== undefined && node !== null) {
    parts.push(String(node));
    if (typeof node !== "object") break;
    if (seen.has(node)) break;
    seen.add(node);
    const names = Object.getOwnPropertyNames(node);
    parts.push(names.join(","));
    for (const name of names) {
      const value = (node as Record<string, unknown>)[name];
      if (typeof value !== "object" || value === null) parts.push(`${name}=${String(value)}`);
    }
    node = (node as { cause?: unknown }).cause;
  }
  return parts.join("\n");
}

async function insertRaw(values: Record<string, unknown>): Promise<unknown> {
  const cols = Object.keys(values);
  const c = await sql();
  return c.query(
    `insert into slack_sync_threads (${cols.join(", ")}) values (${cols
      .map((_, i) => `$${i + 1}`)
      .join(", ")})`,
    cols.map((k) => values[k])
  );
}

function baseRaw(seed: Seed): Record<string, unknown> {
  return {
    team_id: seed.teamId,
    workspace_id: WORKSPACE,
    channel_id: CHANNEL,
    root_ts: ROOT,
  };
}

// ── the slice's boundary, stated as the stored shape ─────────────────────────

describe("slack_sync_threads — the columns this slice may own", () => {
  /**
   * The packet's fence, made observable. Item binding, a completed-read time, a staged body, channel
   * provenance, a migration gate and any terminal/acknowledged state are LATER slices; a column
   * added here ahead of the algorithm that earns it is exactly the placeholder that gets switched on
   * by accident. If a dependent slice legitimately adds one, this list changes WITH it.
   */
  it("stores queue progress and a lease, and nothing that could be mistaken for publication", async () => {
    const c = await sql();
    const { rows } = await c.query<{ column_name: string }>(
      `select column_name from information_schema.columns
        where table_schema = 'public' and table_name = 'slack_sync_threads'
        order by column_name`
    );
    expect(rows.map((r) => r.column_name)).toEqual([
      "attempts",
      "channel_id",
      "checkpointed_at",
      "created_at",
      "due_at",
      "id",
      "last_error_code",
      "lease_expires_at",
      "lease_generation",
      "lease_owner",
      "page_cursor",
      "root_ts",
      "snapshot_generation",
      "status",
      "team_id",
      "updated_at",
      "workspace_id",
    ]);
  });

  it("admits only queued/running — there is no terminal state to reach yet", async () => {
    const seed = await seedTeam();
    expect(await refusal(insertRaw({ ...baseRaw(seed), status: "done" }))).toMatchObject({
      code: "23514",
      constraint: "slack_sync_threads_status_check",
    });
    await insertRaw({ ...baseRaw(seed), status: "queued" });
    expect((await row(scopeFor(seed))).status).toBe("queued");
  });

  it("keeps the lease codec: owner and expiry are present exactly when running", async () => {
    const seed = await seedTeam();
    const bad = [
      { status: "running" }, // running with no lease
      { status: "queued", lease_owner: "orphan-token-000000", lease_expires_at: new Date() },
      { status: "running", lease_owner: "no-expiry-token-0000" },
      { status: "running", lease_expires_at: new Date() },
    ];
    for (const over of bad) {
      expect(await refusal(insertRaw({ ...baseRaw(seed), ...over }))).toMatchObject({
        code: "23514",
        constraint: "slack_sync_threads_lease_codec",
      });
    }
    expect(await rowCount(seed.teamId)).toBe(0);
  });

  it("refuses a duplicate scope, a rewound counter and unsanitized progress", async () => {
    const seed = await seedTeam();
    await insertRaw(baseRaw(seed));

    expect(await refusal(insertRaw(baseRaw(seed)))).toMatchObject({ code: "23505" });

    const c = await sql();
    const set = (assignment: string) =>
      refusal(
        c.query(`update slack_sync_threads set ${assignment} where team_id = $1`, [seed.teamId])
      );

    expect(await set("attempts = -1")).toMatchObject({ code: "23514" });
    expect(await set("lease_generation = -1")).toMatchObject({ code: "23514" });
    expect(await set("snapshot_generation = -1")).toMatchObject({ code: "23514" });
    // A category, never a message or a token: a provider error string, free text and a blank are
    // all refused at the storage layer, not merely by the caller that happens to write today.
    expect(await set("last_error_code = 'invalid_auth: xoxb-1-2'")).toMatchObject({ code: "23514" });
    expect(await set("last_error_code = ''")).toMatchObject({ code: "23514" });
    // The cursor is provider pagination state, not staging: a body-sized value cannot land in it.
    expect(await set("page_cursor = repeat('x', 1025)")).toMatchObject({ code: "23514" });
  });

  it("refuses scope syntax the namespace helpers would never mint", async () => {
    const seed = await seedTeam();
    const bad = [
      { workspace_id: "" },
      { workspace_id: "T 0" },
      { workspace_id: "T0:X" },
      { channel_id: "old-channel-name" }, // a legacy display-name slug is not a channel id
      { root_ts: "1718900000" }, // no micros
      { root_ts: "not-a-ts" },
      { root_ts: "1718900000.0000001" }, // seven digits
    ];
    for (const over of bad) {
      expect(await refusal(insertRaw({ ...baseRaw(seed), ...over }))).toMatchObject({
        code: "23514",
      });
    }
    expect(await rowCount(seed.teamId)).toBe(0);
  });
});

// ── enqueue ──────────────────────────────────────────────────────────────────

describe("enqueue — idempotent, and never a reset", () => {
  it("creates one queued, unleased row and returns the existing one on a duplicate", async () => {
    const seed = await seedTeam();
    const scope = scopeFor(seed);

    const first = await enqueue(scope);
    expect(first.inserted).toBe(true);
    expect(first.state).toMatchObject({
      status: "queued",
      attempts: 0,
      leaseGeneration: 0,
      leaseOwner: null,
      leaseExpiresAt: null,
      pageCursor: null,
      snapshotGeneration: 0,
      checkpointedAt: null,
      lastErrorCode: null,
    });

    const second = await enqueue(scope);
    expect(second.inserted).toBe(false);
    expect(second.state).toEqual(first.state);
    expect(await rowCount(seed.teamId)).toBe(1);
  });

  it("cannot reset a running lease, attempts, due time, cursor or generation", async () => {
    const seed = await seedTeam();
    const scope = scopeFor(seed);
    const live = await claimed(scope);
    const ok = await tx((s) =>
      checkpointSlackThread(s, live, { pageCursor: "cursor-1", snapshotGeneration: 4 })
    );
    expect(ok.outcome).toBe("checkpointed");
    const before = await row(scope);

    const again = await enqueue(scope, new Date("2099-01-01T00:00:00.000Z"));

    expect(again.inserted).toBe(false);
    expect(again.state).toMatchObject({
      status: "running",
      attempts: 1,
      leaseGeneration: 1,
      leaseOwner: live.leaseOwner,
      pageCursor: "cursor-1",
      snapshotGeneration: 4,
    });
    expect(await row(scope)).toEqual(before);
    expect(await rowCount(seed.teamId)).toBe(1);
  });

  it("keeps the same root in another workspace, channel or team separate", async () => {
    const seed = await seedTeam();
    const other = await seedTeam();

    await enqueue(scopeFor(seed));
    await enqueue(scopeFor(seed, { workspaceId: OTHER_WORKSPACE }));
    await enqueue(scopeFor(seed, { channelId: "C0OTHER" }));
    await enqueue(scopeFor(other));

    expect(await rowCount(seed.teamId)).toBe(3);
    expect(await rowCount(other.teamId)).toBe(1);

    // And claiming one leaves the other three untouched — scope is part of the claim predicate,
    // not a filter the caller is trusted to have applied.
    const live = await claim(scopeFor(seed));
    expect(live).not.toBeNull();
    expect((await row(scopeFor(other))).status).toBe("queued");
    expect((await row(scopeFor(seed, { workspaceId: OTHER_WORKSPACE }))).status).toBe("queued");
  });

  it("stores a leading-zero root byte-exact, and never merges it with its unpadded twin", async () => {
    const seed = await seedTeam();
    const padded = scopeFor(seed, { rootTs: PADDED_ROOT });
    const plain = scopeFor(seed);

    const first = await enqueue(padded);
    expect(first.inserted).toBe(true);
    // Byte-exact on the way back out: not re-parsed, not trimmed of its zeros, not re-formatted.
    expect(first.state.scope.rootTs).toBe(PADDED_ROOT);

    const second = await enqueue(plain);
    // TWO rows, not a conflict: the scope key is the provider's bytes. Numeric-equal spellings are
    // distinct threads until something authoritative says otherwise, and normalizing either way here
    // would silently merge two queues — or resurface one thread's cursor under the other's identity.
    expect(second.inserted).toBe(true);
    expect(await rowCount(seed.teamId)).toBe(2);
    expect((await row(padded)).root_ts).toBe(PADDED_ROOT);
    expect((await row(plain)).root_ts).toBe(ROOT);

    // …and it is claimable under its own spelling, leaving the twin alone.
    const live = await claim(padded);
    expect(live?.scope.rootTs).toBe(PADDED_ROOT);
    expect((await row(plain)).status).toBe("queued");
    expect((await row(plain)).lease_owner).toBeNull();
  });
});

// ── claim / reclaim ──────────────────────────────────────────────────────────

describe("claim — the DB clock decides, and the token comes back from the row", () => {
  it("claims a due row, and the persisted owner is the token the caller was handed", async () => {
    const seed = await seedTeam();
    const scope = scopeFor(seed);
    await enqueue(scope);

    const live = await claim(scope);
    expect(live).not.toBeNull();
    expect(live?.leaseGeneration).toBe(1);
    expect(live?.attempts).toBe(1);

    const stored = await row(scope);
    expect(stored.status).toBe("running");
    expect(stored.lease_owner).toBe(live?.leaseOwner);
    expect(stored.attempts).toBe(1);
    expect(stored.lease_generation).toBe("1");
    expect(new Date(stored.lease_expires_at as string).getTime()).toBeGreaterThan(Date.now());
  });

  it("does not claim a row that is not yet due, and does not touch it", async () => {
    const seed = await seedTeam();
    const scope = scopeFor(seed);
    await enqueue(scope, new Date(Date.now() + 3_600_000));
    const before = await row(scope);

    expect(await claim(scope)).toBeNull();
    expect(await row(scope)).toEqual(before);
  });

  it("does not steal a live lease", async () => {
    const seed = await seedTeam();
    const scope = scopeFor(seed);
    const live = await claimed(scope);
    const before = await row(scope);

    expect(await claim(scope)).toBeNull();
    expect(await row(scope)).toEqual(before);
    expect((await row(scope)).lease_owner).toBe(live.leaseOwner);
  });

  it("returns null for a scope that has never been enqueued", async () => {
    const seed = await seedTeam();
    expect(await claim(scopeFor(seed, { rootTs: OTHER_ROOT }))).toBeNull();
  });

  it("reclaims an EXPIRED lease and advances the fence past the old owner", async () => {
    const seed = await seedTeam();
    const scope = scopeFor(seed);
    const stale = await claimed(scope);
    await expireLease(scope);

    const fresh = await claim(scope);
    expect(fresh).not.toBeNull();
    expect(fresh?.leaseOwner).not.toBe(stale.leaseOwner);
    expect(fresh?.leaseGeneration).toBe(2);
    expect(fresh?.attempts).toBe(2);
    expect((await row(scope)).lease_owner).toBe(fresh?.leaseOwner);
  });

  it("reports a SQL failure as a rejection, never as 'no work'", async () => {
    const seed = await seedTeam();
    const scope = scopeFor(seed);
    await enqueue(scope);

    // A poisoned transaction: every later statement fails with 25P02. A `catch → return null`
    // anywhere in the claim path would render this indistinguishable from a row that is not due.
    let inner: { returned?: unknown; threw?: unknown } = {};
    await tx(async (session) => {
      await session.executeSql("select 1 / 0").catch(() => {});
      try {
        inner = { returned: await claimSlackThread(session, scope, { leaseMs: LEASE_MS }) };
      } catch (err) {
        inner = { threw: err };
      }
      throw new Error("rollback");
    }).catch(() => {});

    expect(inner.threw).toBeDefined();
    expect("returned" in inner).toBe(false);
    expect((await row(scope)).status).toBe("queued");
  });

  it("refuses a lease duration that is absent, negative, fractional, NaN or effectively permanent", async () => {
    const seed = await seedTeam();
    const scope = scopeFor(seed);
    await enqueue(scope);
    const before = await row(scope);

    // Bounds restated here on purpose rather than imported: a test that reads the constant under
    // test moves with it and would keep passing after a 100-year lease became legal.
    for (const leaseMs of [0, -1, 1.5, Number.NaN, 999, 900_001, 315_360_000_000]) {
      await expect(claim(scope, leaseMs)).rejects.toThrow(/lease/i);
    }
    expect(await row(scope)).toEqual(before);

    const live = await claim(scope, 1_000);
    expect(live).not.toBeNull();
  });

  it("gives exactly one of two racing sessions the row, and advances the counters once", async () => {
    const seed = await seedTeam();
    const scope = scopeFor(seed);
    await enqueue(scope);

    const [a, b] = await Promise.all([claim(scope), claim(scope)]);
    const winners = [a, b].filter((c): c is SlackThreadClaim => c !== null);

    expect(winners).toHaveLength(1);
    const stored = await row(scope);
    // The returned counts alone would be satisfied by two claims that each reported "1"; the
    // persisted owner is what proves the loser holds no authority.
    expect(stored.lease_owner).toBe(winners[0].leaseOwner);
    expect(stored.attempts).toBe(1);
    expect(stored.lease_generation).toBe("1");
    expect(stored.status).toBe("running");
  });
});

// ── checkpoint ───────────────────────────────────────────────────────────────

describe("checkpoint — progress metadata, gated on the whole fence", () => {
  it("records the cursor and snapshot generation for a live, matching claim", async () => {
    const seed = await seedTeam();
    const scope = scopeFor(seed);
    const live = await claimed(scope);

    const result = await tx((s) =>
      checkpointSlackThread(s, live, { pageCursor: "page-2", snapshotGeneration: 3 })
    );

    expect(result).toMatchObject({
      outcome: "checkpointed",
      state: { pageCursor: "page-2", snapshotGeneration: 3, status: "running", attempts: 1 },
    });
    const stored = await row(scope);
    expect(stored.page_cursor).toBe("page-2");
    expect(stored.snapshot_generation).toBe("3");
    expect(stored.checkpointed_at).not.toBeNull();
    // Progress is not publication: nothing about the claim's authority moved.
    expect(stored.lease_generation).toBe("1");
    expect(stored.attempts).toBe(1);
    expect(stored.lease_owner).toBe(live.leaseOwner);
  });

  it("refuses a wrong owner, a wrong generation and a mismatched scope, without mutating anything", async () => {
    const seed = await seedTeam();
    const other = await seedTeam();
    const scope = scopeFor(seed);
    const live = await claimed(scope);
    // A REAL row for the same (workspace, channel, root) under another team, itself claimed: a
    // cross-team write would otherwise be invisible against an empty table.
    const otherScope = scopeFor(other);
    const otherClaim = await claimed(otherScope);
    const before = await row(scope);
    const otherBefore = await row(otherScope);

    const forged: SlackThreadClaim[] = [
      { ...live, leaseOwner: otherClaim.leaseOwner },
      { ...live, leaseOwner: randomUUID() },
      { ...live, leaseGeneration: live.leaseGeneration + 1 },
      { ...live, leaseGeneration: live.leaseGeneration - 1 },
      { ...live, scope: { ...live.scope, teamId: other.teamId } },
      { ...live, scope: { ...live.scope, workspaceId: OTHER_WORKSPACE } },
      { ...live, scope: { ...live.scope, channelId: "C0OTHER" } },
      { ...live, scope: { ...live.scope, rootTs: OTHER_ROOT } },
    ];
    for (const claimToken of forged) {
      const result = await tx((s) =>
        checkpointSlackThread(s, claimToken, { pageCursor: "forged", snapshotGeneration: 9 })
      );
      expect(result).toEqual({ outcome: "refused" });
    }

    expect(await row(scope)).toEqual(before);
    expect(await row(otherScope)).toEqual(otherBefore);
  });

  it("strips authority the moment the lease expires — before anyone reclaims", async () => {
    const seed = await seedTeam();
    const scope = scopeFor(seed);
    const live = await claimed(scope);
    await expireLease(scope);
    const before = await row(scope);
    // Still `running`, still this owner's row. Only the clock changed.
    expect(before.status).toBe("running");
    expect(before.lease_owner).toBe(live.leaseOwner);

    expect(
      await tx((s) => checkpointSlackThread(s, live, { pageCursor: "late", snapshotGeneration: 1 }))
    ).toEqual({ outcome: "refused" });
    expect(
      await tx((s) =>
        releaseSlackThreadForRetry(s, live, { nextDueAt: new Date(), errorCode: "late" })
      )
    ).toEqual({ outcome: "refused" });
    expect(await row(scope)).toEqual(before);
  });

  it("keeps refusing the replaced owner after a reclaim, and accepts the new one", async () => {
    const seed = await seedTeam();
    const scope = scopeFor(seed);
    const stale = await claimed(scope);
    await expireLease(scope);
    const fresh = await claim(scope);
    if (!fresh) throw new Error("fixture: expected the expired lease to be reclaimable");

    // The row is `running` again — id+status is exactly the authority `lib/jobs/store` accepts, and
    // exactly what must NOT be enough here.
    expect((await row(scope)).status).toBe("running");
    expect(
      await tx((s) => checkpointSlackThread(s, stale, { pageCursor: "zombie", snapshotGeneration: 7 }))
    ).toEqual({ outcome: "refused" });
    expect(
      await tx((s) =>
        releaseSlackThreadForRetry(s, stale, {
          nextDueAt: new Date(Date.now() + 86_400_000),
          errorCode: "zombie",
        })
      )
    ).toEqual({ outcome: "refused" });

    const stored = await row(scope);
    expect(stored.page_cursor).toBeNull();
    expect(stored.status).toBe("running");
    expect(stored.lease_owner).toBe(fresh.leaseOwner);

    expect(
      await tx((s) => checkpointSlackThread(s, fresh, { pageCursor: "page-9", snapshotGeneration: 2 }))
    ).toMatchObject({ outcome: "checkpointed" });
  });

  it("refuses a rewound snapshot generation and writes nothing with it", async () => {
    const seed = await seedTeam();
    const scope = scopeFor(seed);
    const live = await claimed(scope);
    await tx((s) => checkpointSlackThread(s, live, { pageCursor: "page-5", snapshotGeneration: 5 }));

    expect(
      await tx((s) =>
        checkpointSlackThread(s, live, { pageCursor: "rewound", snapshotGeneration: 4 })
      )
    ).toEqual({ outcome: "refused" });

    const stored = await row(scope);
    expect(stored.snapshot_generation).toBe("5");
    // The refusal is atomic with the generation test — the rewind's cursor must not have landed.
    expect(stored.page_cursor).toBe("page-5");

    // The SAME generation is a later page of one snapshot, not a rewind.
    expect(
      await tx((s) => checkpointSlackThread(s, live, { pageCursor: "page-6", snapshotGeneration: 5 }))
    ).toMatchObject({ outcome: "checkpointed" });
    expect((await row(scope)).page_cursor).toBe("page-6");
  });

  it("refuses an unsanitized error category and an unusable cursor before touching the row", async () => {
    const seed = await seedTeam();
    const scope = scopeFor(seed);
    const live = await claimed(scope);
    const before = await row(scope);

    await expect(
      tx((s) => checkpointSlackThread(s, live, { pageCursor: "x".repeat(1025), snapshotGeneration: 1 }))
    ).rejects.toThrow(/cursor/i);
    await expect(
      tx((s) => checkpointSlackThread(s, live, { pageCursor: "  ", snapshotGeneration: 1 }))
    ).rejects.toThrow(/cursor/i);
    await expect(
      tx((s) => checkpointSlackThread(s, live, { pageCursor: null, snapshotGeneration: -1 }))
    ).rejects.toThrow(/generation/i);

    // Synthetic, but shaped like the thing this rule exists for: a provider error string carrying a
    // token. The rejection must be a VALIDATION error — raised before any statement — and it must
    // not echo the value back, because a message that quotes what it rejected copies the token into
    // every log that records the throw. That is the leak the sanitized category exists to prevent,
    // so the value is checked against the whole diagnostic surface, not just `message`.
    const leaky = "invalid_auth: xoxb-1-2";
    let thrown: unknown;
    try {
      await tx((s) =>
        releaseSlackThreadForRetry(s, live, { nextDueAt: new Date(), errorCode: leaky })
      );
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(TypeError);
    expect((thrown as Error).message).toMatch(/errorCode/);
    const exposed = diagnostics(thrown);
    for (const secret of [leaky, "xoxb-1-2", "invalid_auth"]) {
      expect(exposed).not.toContain(secret);
    }

    expect(await row(scope)).toEqual(before);
  });

  it("uses the caller's session: a rolled-back checkpoint leaves no progress", async () => {
    const seed = await seedTeam();
    const scope = scopeFor(seed);
    const live = await claimed(scope);
    const before = await row(scope);

    // Captured, not asserted inside the callback: an assertion that throws in there would be
    // swallowed by the rollback catch, and the test would pass having checked nothing.
    let inTransaction: unknown;
    await tx(async (session) => {
      inTransaction = await checkpointSlackThread(session, live, {
        pageCursor: "uncommitted",
        snapshotGeneration: 8,
      });
      throw new Error("rollback");
    }).catch(() => {});
    expect(inTransaction).toMatchObject({ outcome: "checkpointed" });

    // Read on the SEPARATE raw connection: had the module reached for the process-wide pool, this
    // write would have committed on its own connection and survived the caller's rollback.
    expect(await row(scope)).toEqual(before);
    expect((await row(scope)).page_cursor).toBeNull();
  });
});

// ── release for retry ────────────────────────────────────────────────────────

describe("release — requeue keeps the progress it did not earn the right to drop", () => {
  it("requeues at the supplied time with a sanitized category, preserving cursor and counters", async () => {
    const seed = await seedTeam();
    const scope = scopeFor(seed);
    const live = await claimed(scope);
    await tx((s) => checkpointSlackThread(s, live, { pageCursor: "page-3", snapshotGeneration: 6 }));

    const nextDueAt = new Date(Date.now() + 600_000);
    const result = await tx((s) =>
      releaseSlackThreadForRetry(s, live, { nextDueAt, errorCode: "rate_limited" })
    );

    expect(result).toMatchObject({
      outcome: "released",
      state: {
        status: "queued",
        leaseOwner: null,
        leaseExpiresAt: null,
        pageCursor: "page-3",
        snapshotGeneration: 6,
        lastErrorCode: "rate_limited",
        attempts: 1,
        leaseGeneration: 1,
      },
    });
    const stored = await row(scope);
    expect(new Date(stored.due_at as string).toISOString()).toBe(nextDueAt.toISOString());
    expect(stored.lease_owner).toBeNull();
    expect(stored.lease_expires_at).toBeNull();
    // No terminal counter exists to be incremented — the requeue is the whole outcome.
    expect(stored.page_cursor).toBe("page-3");
    expect(stored.snapshot_generation).toBe("6");
    expect(stored.attempts).toBe(1);

    // …and the requeued row is claimable again once due, which is what makes the retry real.
    await setColumn(scope, "due_at", "now() - interval '1 second'");
    const next = await claim(scope);
    expect(next?.leaseGeneration).toBe(2);
    expect(next?.attempts).toBe(2);
    expect(next?.pageCursor).toBe("page-3");
    expect(next?.snapshotGeneration).toBe(6);
  });

  it("cannot be used by a stale worker to postpone the current claim", async () => {
    const seed = await seedTeam();
    const scope = scopeFor(seed);
    const stale = await claimed(scope);
    await expireLease(scope);
    const fresh = await claim(scope);
    if (!fresh) throw new Error("fixture: expected the expired lease to be reclaimable");
    const before = await row(scope);

    expect(
      await tx((s) =>
        releaseSlackThreadForRetry(s, stale, {
          nextDueAt: new Date(Date.now() + 86_400_000),
          errorCode: "stale_worker",
        })
      )
    ).toEqual({ outcome: "refused" });
    expect(await row(scope)).toEqual(before);

    // The live worker still owns it.
    expect(
      await tx((s) =>
        releaseSlackThreadForRetry(s, fresh, { nextDueAt: new Date(), errorCode: null })
      )
    ).toMatchObject({ outcome: "released" });
  });

  it("refuses a release from a caller that never held the row", async () => {
    const seed = await seedTeam();
    const scope = scopeFor(seed);
    await enqueue(scope);
    const before = await row(scope);

    const forged: SlackThreadClaim = {
      scope,
      leaseOwner: randomUUID(),
      leaseGeneration: 1,
      leaseExpiresAt: new Date(Date.now() + LEASE_MS).toISOString(),
      attempts: 1,
      pageCursor: null,
      snapshotGeneration: 0,
    };
    expect(
      await tx((s) =>
        releaseSlackThreadForRetry(s, forged, { nextDueAt: new Date(), errorCode: null })
      )
    ).toEqual({ outcome: "refused" });
    expect(await row(scope)).toEqual(before);
  });
});

// ── M11: the owner token, when the generations cannot tell two claims apart ──

/**
 * The known-root requeue specification's mutation row M11 (owner fence), characterized against this
 * module's fenced checkpoint.
 *
 * `lease_generation` is a counter ON A ROW. When the row is deleted and the same scope is enqueued
 * again, the counter starts over, so a claim on the new row can carry exactly the generations a
 * claim on the deleted row carried. Scope, status, lease generation, snapshot generation and a live
 * lease then all match the old claim: the owner token is the ONLY thing that says the row is not
 * the old claim's to write. The cases above that refuse a replaced owner differ in generation too,
 * and the forged-owner case never deletes anything; neither arranges this.
 *
 * Both claims here are made the same way, through the module: enqueue, claim, checkpoint, expire,
 * reclaim. The deletion and the expiry are fixture SQL, as everywhere in this file.
 */
describe("M11 owner fence — a deleted, recreated and reclaimed row at the same generations", () => {
  const LEASE_GENERATION = 2;
  const SNAPSHOT_GENERATION = 4;
  const CURSOR_BEFORE_THE_RECLAIM = "m11-page-before-the-reclaim";
  const CURSOR_FROM_THE_STALE_CLAIM = "m11-written-by-the-stale-claim";
  const CURSOR_FROM_THE_REPLACEMENT = "m11-written-by-the-replacement";

  /** A live claim at lease generation 2 and snapshot generation 4, reached only through the module's own operations. */
  async function reclaimedAtTheNamedGenerations(scope: SlackThreadScope): Promise<SlackThreadClaim> {
    const first = await claimed(scope);
    const progressed = await tx((s) =>
      checkpointSlackThread(s, first, { pageCursor: CURSOR_BEFORE_THE_RECLAIM, snapshotGeneration: SNAPSHOT_GENERATION })
    );
    if (progressed.outcome !== "checkpointed") throw new Error("fixture: expected the first claim to checkpoint");
    await expireLease(scope);
    const again = await claim(scope);
    if (!again) throw new Error("fixture: expected the expired lease to be reclaimable");
    return again;
  }

  /** The whole stored row as the database's own JSON text, so a timestamp keeps the microseconds a JavaScript Date drops. */
  async function storedRow(scope: SlackThreadScope): Promise<{ text: string; columns: Record<string, unknown> }> {
    const c = await sql();
    const { rows } = await c.query<{ stored: string; lease_is_live: boolean }>(
      `select to_jsonb(t)::text as stored, t.lease_expires_at > clock_timestamp() as lease_is_live
         from slack_sync_threads t
        where t.team_id = $1 and t.workspace_id = $2 and t.channel_id = $3 and t.root_ts = $4`,
      [scope.teamId, scope.workspaceId, scope.channelId, scope.rootTs]
    );
    if (rows.length !== 1) throw new Error(`fixture: expected exactly one row, found ${rows.length}`);
    return {
      text: rows[0].stored,
      columns: { ...(JSON.parse(rows[0].stored) as Record<string, unknown>), lease_is_live: rows[0].lease_is_live },
    };
  }

  /** Everything a claim carries except the two things a new claim always changes: its owner token and its expiry. */
  const withoutOwnerAndExpiry = (held: SlackThreadClaim) => ({
    scope: held.scope,
    leaseGeneration: held.leaseGeneration,
    attempts: held.attempts,
    pageCursor: held.pageCursor,
    snapshotGeneration: held.snapshotGeneration,
  });

  it("M11: a checkpoint by the stale claim is refused and leaves the replacement row exactly as it was, when only the owner token tells the two claims apart", async () => {
    const seed = await seedTeam();
    const scope = scopeFor(seed);

    const stale = await reclaimedAtTheNamedGenerations(scope);
    const deletedRowId = (await storedRow(scope)).columns.id;

    // FIXTURE DML: the row the stale claim was made on is deleted. Nothing in this module deletes a
    // queue row; in the product the publication transaction does.
    const c = await sql();
    const deleted = await c.query(
      `delete from slack_sync_threads
        where team_id = $1 and workspace_id = $2 and channel_id = $3 and root_ts = $4`,
      [scope.teamId, scope.workspaceId, scope.channelId, scope.rootTs]
    );
    if (deleted.rowCount !== 1 || (await rowCount(seed.teamId)) !== 0) {
      throw new Error("fixture: expected to delete exactly the one queue row of this scope");
    }

    // The same scope is enqueued again and brought, the same way, to the same generations.
    const replacement = await reclaimedAtTheNamedGenerations(scope);
    const before = await storedRow(scope);

    // FIXTURE: everything a fenced write checks — scope, status, lease generation, a live lease and
    // a snapshot generation that is not rewound — is the same for the two claims. They differ in the
    // owner token, and the row is a different row.
    const sameButForTheOwner = {
      scope, leaseGeneration: LEASE_GENERATION, attempts: 2, pageCursor: CURSOR_BEFORE_THE_RECLAIM, snapshotGeneration: SNAPSHOT_GENERATION,
    };
    expect({
      the_stale_claim_without_owner_and_expiry: withoutOwnerAndExpiry(stale),
      the_replacement_claim_without_owner_and_expiry: withoutOwnerAndExpiry(replacement),
      the_owner_tokens_differ: stale.leaseOwner !== replacement.leaseOwner,
      the_replacement_is_another_row: before.columns.id !== deletedRowId,
      replacement_row: {
        status: before.columns.status,
        lease_generation: before.columns.lease_generation,
        snapshot_generation: before.columns.snapshot_generation,
        lease_owner_is_the_replacement_claims: before.columns.lease_owner === replacement.leaseOwner,
        lease_is_live_by_the_database_clock: before.columns.lease_is_live,
      },
    }, "M11: fixture: the stale and the replacement claim have the same scope, lease generation and snapshot generation, on a recreated running row with a live lease, and different owner tokens").toEqual({
      the_stale_claim_without_owner_and_expiry: sameButForTheOwner,
      the_replacement_claim_without_owner_and_expiry: sameButForTheOwner,
      the_owner_tokens_differ: true,
      the_replacement_is_another_row: true,
      replacement_row: {
        status: "running",
        lease_generation: LEASE_GENERATION,
        snapshot_generation: SNAPSHOT_GENERATION,
        lease_owner_is_the_replacement_claims: true,
        lease_is_live_by_the_database_clock: true,
      },
    });

    // THE NAMED WRITE, by the stale claim, at the snapshot generation both claims hold.
    const attempted = await tx((s) =>
      checkpointSlackThread(s, stale, { pageCursor: CURSOR_FROM_THE_STALE_CLAIM, snapshotGeneration: stale.snapshotGeneration })
    );
    const after = await storedRow(scope);

    expect({
      the_stale_claims_checkpoint: attempted.outcome,
      replacement_page_cursor: after.columns.page_cursor,
      replacement_row_is_exactly_as_it_was: after.text === before.text,
    }, "M11: a checkpoint by the stale claim is refused, and the replacement row keeps its own cursor and every other column").toEqual({
      the_stale_claims_checkpoint: "refused",
      replacement_page_cursor: CURSOR_BEFORE_THE_RECLAIM,
      replacement_row_is_exactly_as_it_was: true,
    });
    expect(after.columns).toEqual(before.columns);

    // CONTROL: the same write, at the same generations, by the claim whose owner token the row
    // holds, is accepted. The owner token was the one thing the stale claim lacked.
    const own = await tx((s) =>
      checkpointSlackThread(s, replacement, { pageCursor: CURSOR_FROM_THE_REPLACEMENT, snapshotGeneration: replacement.snapshotGeneration })
    );
    expect(own, "M11: control: the replacement claim's own checkpoint, at the same generations, is accepted").toMatchObject({
      outcome: "checkpointed",
      state: {
        status: "running",
        pageCursor: CURSOR_FROM_THE_REPLACEMENT,
        leaseOwner: replacement.leaseOwner,
        leaseGeneration: LEASE_GENERATION,
        snapshotGeneration: SNAPSHOT_GENERATION,
      },
    });
    expect((await storedRow(scope)).columns.page_cursor).toBe(CURSOR_FROM_THE_REPLACEMENT);
  });
});

// ── the rest of the system does not notice ───────────────────────────────────

describe("an empty, or newly populated, queue changes nothing else", () => {
  it("leaves ingestion, the message ledger and the cache generations exactly as they were", async () => {
    const seed = await seedTeam();
    const scope = scopeFor(seed);
    await claimed(scope);

    const result = await ingest(seed, {
      path: "slack/c0threads/1718900000.000100.md",
      body: "an ordinary ingested thread",
      access: "team",
    });
    expect(result.status).toBeTruthy();
    expect(result.id).toBeTruthy();

    const c = await sql();
    const counts = await c.query<{ messages: string; state: string }>(
      `select (select count(*)::text from slack_messages) as messages,
              (select count(*)::text from slack_team_state) as state`
    );
    // A queued/running thread is pending WORK. It is not evidence, and it does not bump a cache
    // generation — those belong to the publisher that does not exist yet.
    expect(counts.rows[0]).toEqual({ messages: "0", state: "0" });
    expect(await rowCount(seed.teamId)).toBe(1);
  });
});

// ── repeatable rollout ───────────────────────────────────────────────────────

/**
 * On its OWN scratch database, because it runs the real schema loader three times and the dm
 * harness truncates rows, not DDL — a mid-test failure against the shared database would strand it
 * and redden unrelated files. Generous timeout: each load applies schema.sql plus every migration.
 */
const SCRATCH_TIMEOUT = 300_000;

describe("rollout — repeatable from zero, on upgrade, and on replay", () => {
  it(
    "creates the table on a populated pre-packet database and preserves state on replay",
    async () => {
      const { loadSchema } = await import("@/scripts/pg-load-schema.mjs");
      const adminUrl = process.env.DATABASE_TEST_URL;
      if (!adminUrl) throw new Error("DATABASE_TEST_URL required");
      const name = `slackthreads_${randomUUID().replace(/-/g, "").slice(0, 16)}`;

      const admin = new Client({ connectionString: adminUrl });
      await admin.connect();
      try {
        await admin.query(`create database ${name}`);
      } finally {
        await admin.end().catch(() => {});
      }
      const target = new URL(adminUrl);
      target.pathname = `/${name}`;
      const url = target.toString();
      const load = () =>
        loadSchema({ cwd: process.cwd(), databaseUrl: url, logger: { log: () => {} } });

      const c = new Client({ connectionString: url });
      await c.connect();
      try {
        await c.query("set time zone 'UTC'");

        const present = async () =>
          (
            await c.query<{ c: string }>(
              `select count(*)::text as c from pg_tables
                where schemaname='public' and tablename = 'slack_sync_threads'`
            )
          ).rows[0].c;

        // 1. FROM ZERO.
        await load();
        expect(await present()).toBe("1");

        // 2. A released database that predates this packet: the tables it does own, populated.
        const teamId = randomUUID();
        await c.query(`insert into teams (id, slug, name) values ($1, 'legacy-team', 'Legacy')`, [
          teamId,
        ]);
        await c.query(`drop table slack_thread_snapshots`);
        await c.query(`drop table slack_sync_threads`);
        expect(await present()).toBe("0");

        // 3. UPGRADE onto it.
        await load();
        expect(await present()).toBe("1");
        expect((await c.query(`select id from teams`)).rows).toEqual([{ id: teamId }]);

        await c.query(
          `insert into slack_sync_threads
             (team_id, workspace_id, channel_id, root_ts, status, attempts, lease_generation,
              lease_owner, lease_expires_at, page_cursor, snapshot_generation)
           values ($1, $2, $3, $4, 'running', 3, 5, 'owner-token-1', now() + interval '1 hour',
                   'page-7', 9)`,
          [teamId, WORKSPACE, CHANNEL, ROOT]
        );
        const snapshot = async () =>
          (
            await c.query(
              `select workspace_id, channel_id, root_ts, status, attempts,
                      lease_generation::text as lease_generation, lease_owner,
                      page_cursor, snapshot_generation::text as snapshot_generation
                 from slack_sync_threads order by root_ts`
            )
          ).rows;
        const before = await snapshot();
        expect(before).toHaveLength(1);

        // 4. REPLAY on the populated table — every deploy re-runs this path.
        await load();
        expect(await snapshot()).toEqual(before);
        // The constraints are the replayed ones, not a weakened re-creation.
        expect(
          await refusal(
            c.query(
              `insert into slack_sync_threads (team_id, workspace_id, channel_id, root_ts)
                 values ($1, $2, $3, $4)`,
              [teamId, WORKSPACE, CHANNEL, ROOT]
            )
          )
        ).toMatchObject({ code: "23505" });
        expect(
          await refusal(c.query(`update slack_sync_threads set lease_owner = null`))
        ).toMatchObject({ code: "23514", constraint: "slack_sync_threads_lease_codec" });

        // 5. A CHECKPOINT-CREATED database, still carrying the FORMER 12-digit `root_ts` check.
        // This DDL is test fixture, on this throwaway database only — it manufactures the state a
        // container created from the earlier packet is already in, which is precisely the state
        // `create table if not exists` cannot see and therefore cannot repair.
        await c.query(
          `alter table slack_sync_threads drop constraint if exists slack_sync_threads_root_ts_check`
        );
        await c.query(
          `alter table slack_sync_threads add constraint slack_sync_threads_root_ts_check
             check (root_ts ~ '^[0-9]{1,12}[.][0-9]{1,6}$')`
        );
        const insertPadded = () =>
          c.query(
            `insert into slack_sync_threads (team_id, workspace_id, channel_id, root_ts)
               values ($1, $2, $3, $4)`,
            [teamId, WORKSPACE, CHANNEL, PADDED_ROOT]
          );
        // The fixture is a real reproduction, not a name: the old rule rejects the padded root.
        expect(await refusal(insertPadded())).toMatchObject({
          code: "23514",
          constraint: "slack_sync_threads_root_ts_check",
        });

        // 6. REPAIR. The replay must WIDEN the existing constraint, not skip the table it already
        // found. Skipping is the failure this step exists to catch, and it is invisible from zero.
        await load();
        await insertPadded();

        // Negative control: a "repair" that only DROPPED the old rule would satisfy the line above
        // just as well. The widened constraint must be present, under its name, still refusing the
        // syntax it always refused.
        expect(
          await refusal(
            c.query(
              `insert into slack_sync_threads (team_id, workspace_id, channel_id, root_ts)
                 values ($1, $2, $3, '1718900000.0000001')`,
              [teamId, WORKSPACE, CHANNEL]
            )
          )
        ).toMatchObject({ code: "23514", constraint: "slack_sync_threads_root_ts_check" });

        const after = await snapshot();
        expect(after.filter((r) => r.root_ts === PADDED_ROOT)).toHaveLength(1);
        // The pre-existing packet4a row — lease, cursor, counters — survived the constraint swap.
        expect(after.filter((r) => r.root_ts === ROOT)).toEqual(before);
      } finally {
        await c.end().catch(() => {});
        const dropper = new Client({ connectionString: adminUrl });
        await dropper.connect();
        await dropper.query(`drop database if exists ${name} with (force)`).catch(() => {});
        await dropper.end().catch(() => {});
      }
    },
    SCRATCH_TIMEOUT
  );
});
