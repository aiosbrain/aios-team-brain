import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * THE ATTRIBUTION REPAIR TURN (AIO-1167) — one ownership boundary for the team-wide repair.
 *
 * Spec.
 *   1. Every transaction of every common-repair entry point takes the team's turn with a
 *      transaction-scoped TRY advisory lock, and takes it BEFORE the identity-authority lock.
 *   2. A turn it cannot take is `busy`: no authority lock, no write, no failure state.
 *   3. A scan turn is ONE transaction: after ownership it rereads revision, status, cursor and retry
 *      deadline, and its status, item/version/evidence writes and cursor commit together.
 *      - a newer revision throws and records nothing against the new revision;
 *      - a complete revision, and a finished scan, are no-ops;
 *      - a deadline that has not passed defers the turn only for a caller that honors deadlines;
 *      - a healthy batch does not touch `attempts`.
 *   4. A failed turn rolls back FIRST; the durable retry (attempts+1, backoff) is written after, in a
 *      transaction of its own.
 *   5. Finalization is its own owned turn: reread → strict purge → complete + epoch, one transaction.
 *      A purge failure completes nothing and is recorded after the rollback.
 *   6. A bounded caller whose budget ends, or who finds the turn busy, reports `continuing` and
 *      kicks the scheduler — after commit, never as a failure.
 *   7. A turn only CONTINUES durable work. A REQUEST — the direct `reattributeItems`, the manual
 *      button — is a durable step of its own: under the turn, in a transaction of ITS OWN that
 *      commits before the strict snapshot read is attempted, the revision is set back to pending
 *      with its cursor cleared. So a snapshot failure (or a crash) after it cannot take the reset
 *      back: the failure is recorded on top of the cleared cursor and the retry scans from the
 *      start. A request reopens `complete`, `awaiting_cache` and `retry`; it leaves a scan in
 *      healthy progress alone, creates no revision, and — if it fails itself — records nothing.
 *
 * The connection below records each statement and answers from a script; the real-PostgreSQL
 * counterpart is `test/datamechanics/attribution-repair-continuation.datamechanics.test.ts`.
 */

type Row = Record<string, unknown>;
type Reply = Row[] | Error | undefined;
type Entry = { sql: string; params: unknown[] };

const norm = (sql: string) => sql.replace(/\s+/g, " ").trim().toLowerCase();

class ScriptedConnection {
  readonly log: Entry[] = [];
  readonly release = vi.fn();

  constructor(private readonly respond: (entry: Entry) => Reply) {}

  async query(text: string, params: unknown[] = []): Promise<Record<string, unknown>> {
    const entry = { sql: norm(text), params };
    this.log.push(entry);
    const command = text.trim().split(/\s+/)[0].toUpperCase();
    if (text === "BEGIN" || text === "COMMIT" || text === "ROLLBACK") return { rows: [], rowCount: null, command };
    const reply = this.respond(entry);
    if (reply instanceof Error) throw reply;
    return { rows: reply ?? [], rowCount: reply?.length ?? 0, command };
  }

  /** The log cut into transactions: the statements between a BEGIN and how it ended. */
  get transactions(): { work: Entry[]; end: string }[] {
    const out: { work: Entry[]; end: string }[] = [];
    let open: Entry[] | null = null;
    for (const entry of this.log) {
      if (entry.sql === "begin") open = [];
      else if (entry.sql === "commit" || entry.sql === "rollback") {
        if (open) out.push({ work: open, end: entry.sql });
        open = null;
      } else open?.push(entry);
    }
    return out;
  }
}

const h = vi.hoisted(() => ({ connection: null as unknown }));

vi.mock("pg", () => ({
  Pool: class {
    on(): void {}
    async connect(): Promise<unknown> {
      return h.connection;
    }
    async query(text: string, params?: unknown[]): Promise<unknown> {
      return (h.connection as { query(text: string, params?: unknown[]): Promise<unknown> }).query(text, params);
    }
  },
  types: { setTypeParser(): void {} },
}));

import { PgClient } from "@/lib/db/pg/client";
import { reattributeItems, takeRepairScanTurn } from "@/lib/ingest/reattribute";
import {
  onAttributionRepairKick,
  repairAttributionNow,
  runAttributionRepairTurn,
  runScheduledAttributionRepairTurn,
} from "@/lib/ingest/reconcile-attribution";

const TEAM = "10000000-0000-4000-8000-000000000001";
const ITEM_A = "50000000-0000-4000-8000-00000000000a";
const ITEM_B = "50000000-0000-4000-8000-00000000000b";
const REVISION = 7;

// ── statement classes ──────────────────────────────────────────────────────────────────────────
const isTurnLock = (e: Entry) => e.sql.startsWith("select pg_try_advisory_xact_lock(hashtextextended(")
  && e.params[0] === `${TEAM}:attribution-repair-turn`;
const isIdentityLock = (e: Entry) => e.sql.includes("pg_advisory_xact_lock(hashtextextended(")
  && e.params[0] === `${TEAM}:identity-authority`;
const isSnapshotRead = (e: Entry) => e.sql.startsWith("select revision,repair_revision,repair_status,cursor_item_id from team_identity_authority");
const isOwnedReread = (e: Entry) => e.sql.startsWith("select revision,repair_revision,repair_status,cursor_item_id, (next_attempt_at is not null and next_attempt_at>now()) as deferred")
  && e.sql.endsWith("for update");
const isRevisionRead = (e: Entry) => e.sql.startsWith("select revision,repair_revision from team_identity_authority");
const isPeek = (e: Entry) => e.sql === "select repair_status from team_identity_authority where team_id=$1";
const isCandidateRead = (e: Entry) => e.sql.startsWith("select i.id from items i where i.team_id=$1 and (i.access::text");
const isItemRowLock = (e: Entry) => e.sql === "select id,member_id,member_id_locked,frontmatter from items where team_id=$1 and id=$2 for update";
const isEligibilityRead = (e: Entry) => e.sql.includes(") as eligible from items i where");
const isRunning = (e: Entry) => e.sql.startsWith("update team_identity_authority set repair_status='running'");
const isReopen = (e: Entry) => e.sql.startsWith("update team_identity_authority set repair_status='pending'");
const isCursorAdvance = (e: Entry) => e.sql.startsWith("update team_identity_authority set cursor_item_id=$3");
const isAwaitingCache = (e: Entry) => e.sql.startsWith("update team_identity_authority set repair_status='awaiting_cache'");
const isRetry = (e: Entry) => e.sql.startsWith("update team_identity_authority set repair_status='retry'");
const isComplete = (e: Entry) => e.sql.startsWith("update team_identity_authority set repair_status='complete'");
const isEpochAdvance = (e: Entry) => e.sql.startsWith("insert into team_authorization_epochs(team_id,epoch) values ($1,2)");
const isCachePurge = (table: string) => (e: Entry) => e.sql.startsWith("delete from") && e.sql.includes(table);
const isWrite = (e: Entry) => /^(insert|update|delete) /.test(e.sql);
/** `ensureAuthorityRow` is an idempotent insert-if-missing, not repair progress. */
const isEnsureRow = (e: Entry) => e.sql.startsWith("insert into team_identity_authority(");
const repairWrites = (work: Entry[]) => work.filter((e) => isWrite(e) && !isEnsureRow(e));

const indexOf = (entries: Entry[], match: (e: Entry) => boolean) => entries.findIndex(match);

interface Script {
  /** Answers to successive turn-lock attempts; the last one repeats. */
  turn?: boolean[];
  status?: string;
  /** What the owner's reread says, when it differs from the snapshot. */
  owned?: { revision?: number; status?: string; cursor?: string | null; deferred?: boolean };
  /** Successive candidate pages; the last one repeats. */
  candidates?: string[][];
  fail?: (entry: Entry) => Error | undefined;
}

function repository(script: Script = {}) {
  const turn = [...(script.turn ?? [true])];
  const candidates = [...(script.candidates ?? [[ITEM_A]])];
  const status = script.status ?? "pending";
  return (entry: Entry): Reply => {
    const failure = script.fail?.(entry);
    if (failure) return failure;
    if (isTurnLock(entry)) return [{ acquired: turn.length > 1 ? turn.shift() : turn[0] }];
    if (isPeek(entry)) return [{ repair_status: script.owned?.status ?? status }];
    if (isSnapshotRead(entry)) {
      return [{ revision: REVISION, repair_revision: REVISION, repair_status: status, cursor_item_id: null }];
    }
    if (isOwnedReread(entry)) {
      const revision = script.owned?.revision ?? REVISION;
      return [{
        revision, repair_revision: revision, repair_status: script.owned?.status ?? status,
        cursor_item_id: script.owned?.cursor ?? null, deferred: script.owned?.deferred ?? false,
      }];
    }
    if (isRevisionRead(entry)) return [{ revision: REVISION, repair_revision: REVISION }];
    if (isCandidateRead(entry)) return (candidates.length > 1 ? candidates.shift()! : candidates[0]).map((id) => ({ id }));
    if (isItemRowLock(entry)) return [{ id: entry.params[1], member_id: null, member_id_locked: false, frontmatter: {} }];
    if (isEligibilityRead(entry)) return [{ eligible: true }];
    if (isComplete(entry)) return [{}];
    if (isEpochAdvance(entry)) return [{ epoch: 2 }];
    return [];
  };
}

function use(script: Script = {}): ScriptedConnection {
  const connection = new ScriptedConnection(repository(script));
  h.connection = connection;
  return connection;
}

const injected = (message: string) => Object.assign(new Error(message), { code: "58030" });

beforeEach(() => {
  vi.stubEnv("DATABASE_URL", "postgres://unit:unit@127.0.0.1:1/unit");
  onAttributionRepairKick(null);
});

describe("scan turn: owned, atomic, and never waits for ownership", () => {
  it("BOTH transactions take the turn before the identity-authority lock; status, repair and cursor commit in ONE", async () => {
    const c = use({ candidates: [[ITEM_A, ITEM_B]] });
    await expect(takeRepairScanTurn(new PgClient(), TEAM, { batchSize: 25 }))
      .resolves.toMatchObject({ scanned: 2, partial: false, revision: REVISION, turn: "scanned" });

    const transactions = c.transactions;
    expect(transactions.map((t) => t.end)).toEqual(["commit", "commit"]);
    for (const { work } of transactions) {
      expect(isTurnLock(work[0]), "the turn is the first thing a repair transaction takes").toBe(true);
      expect(indexOf(work, isIdentityLock)).toBeGreaterThan(0);
    }
    const [snapshot, batch] = transactions.map((t) => t.work);
    // The snapshot is a read: it nominates, and leaves no repair progress behind.
    expect(repairWrites(snapshot)).toEqual([]);
    // The batch: ownership → authority → reread → running → candidates → per-item → awaiting-cache.
    const order = [
      indexOf(batch, isTurnLock),
      indexOf(batch, isIdentityLock),
      indexOf(batch, isOwnedReread),
      indexOf(batch, isRunning),
      indexOf(batch, isCandidateRead),
      indexOf(batch, isItemRowLock),
      indexOf(batch, isCursorAdvance),
      indexOf(batch, isAwaitingCache),
    ];
    expect(order.every((index) => index >= 0), `missing a step: ${order}`).toBe(true);
    expect(order).toEqual([...order].sort((a, b) => a - b));
    // Both items' cursor moves are in this one transaction, in id order.
    expect(batch.filter(isCursorAdvance).map((e) => e.params[2])).toEqual([ITEM_A, ITEM_B]);
    // A healthy batch is not an attempt: it clears the failure fields and leaves the count alone.
    const running = batch.find(isRunning)!;
    expect(running.sql).toContain("last_error=null,next_attempt_at=null");
    expect(running.sql).not.toContain("attempts");
    expect(c.log.filter(isRetry)).toEqual([]);
  });

  it("the batch scans from the cursor the OWNER reread, not the one the snapshot nominated", async () => {
    const c = use({ owned: { cursor: ITEM_A }, candidates: [[ITEM_B]] });
    await takeRepairScanTurn(new PgClient(), TEAM, { batchSize: 1 });
    expect(c.log.find(isCandidateRead)!.params).toEqual([TEAM, ITEM_A, 1]);
  });

  it("BUSY before the snapshot: no authority lock, no read of the roster, no write", async () => {
    const c = use({ turn: [false] });
    await expect(takeRepairScanTurn(new PgClient(), TEAM))
      .resolves.toMatchObject({ turn: "busy", partial: true, scanned: 0, revision: 0 });
    expect(c.transactions).toHaveLength(1);
    expect(c.transactions[0].work.every(isTurnLock)).toBe(true);
    expect(c.log.filter(isWrite)).toEqual([]);
  });

  it("BUSY at the batch: another owner took the turn after the snapshot — nothing is written, nothing fails", async () => {
    const c = use({ turn: [true, false] });
    await expect(takeRepairScanTurn(new PgClient(), TEAM))
      .resolves.toMatchObject({ turn: "busy", partial: true, scanned: 0, revision: REVISION });
    const batch = c.transactions[1].work;
    expect(batch.every(isTurnLock)).toBe(true);
    expect(c.log.filter((e) => isRunning(e) || isRetry(e) || isCursorAdvance(e))).toEqual([]);
  });

  it("a NEWER REVISION found under ownership throws, rolls back, and records no failure against it", async () => {
    const c = use({ owned: { revision: REVISION + 1 } });
    await expect(takeRepairScanTurn(new PgClient(), TEAM)).rejects.toThrow(/identity mapping changed/);
    expect(c.transactions.map((t) => t.end)).toEqual(["commit", "rollback"]);
    expect(c.log.filter((e) => isRunning(e) || isCandidateRead(e) || isRetry(e))).toEqual([]);
  });

  it.each([
    ["complete", "complete"],
    ["awaiting_cache", "awaiting_cache"],
  ] as const)("a revision the owner finds %s is a no-op: no status write, no candidate read", async (status, turn) => {
    const c = use({ owned: { status } });
    await expect(takeRepairScanTurn(new PgClient(), TEAM))
      .resolves.toMatchObject({ turn, partial: false, scanned: 0, revision: REVISION });
    expect(c.log.filter((e) => isRunning(e) || isCandidateRead(e) || isRetry(e))).toEqual([]);
    expect(c.transactions.map((t) => t.end)).toEqual(["commit", "commit"]);
  });

  it("a retry DEADLINE that has not passed defers only a caller that honors deadlines", async () => {
    const scheduled = use({ status: "retry", owned: { status: "retry", deferred: true } });
    await expect(takeRepairScanTurn(new PgClient(), TEAM, { honorRetryDeadline: true }))
      .resolves.toMatchObject({ turn: "deferred", partial: true, scanned: 0 });
    expect(scheduled.log.filter((e) => isRunning(e) || isCandidateRead(e) || isRetry(e))).toEqual([]);

    // The explicit manual repair runs now, and clears the deadline as part of its batch.
    const manual = use({ status: "retry", owned: { status: "retry", deferred: true } });
    await expect(takeRepairScanTurn(new PgClient(), TEAM)).resolves.toMatchObject({ turn: "scanned" });
    expect(manual.log.filter(isRunning)).toHaveLength(1);
  });

  it("a FAILED batch rolls back first; the retry — attempts+1 and backoff — is written afterwards in its own transaction", async () => {
    const c = use({
      candidates: [[ITEM_A, ITEM_B]],
      fail: (e) => (isEligibilityRead(e) && e.params[1] === ITEM_B ? injected("mapping read unavailable") : undefined),
    });
    await expect(takeRepairScanTurn(new PgClient(), TEAM)).rejects.toThrow(/mapping read unavailable/);

    const [, batch, record] = c.transactions;
    // ITEM_A's cursor move was in the batch that rolled back: it did not survive.
    expect(batch.end).toBe("rollback");
    expect(batch.work.filter(isCursorAdvance).map((e) => e.params[2])).toEqual([ITEM_A]);
    expect(record.end).toBe("commit");
    const retry = record.work.find(isRetry)!;
    expect(retry.sql).toContain("attempts=attempts+1");
    expect(retry.sql).toContain("power(2,least(attempts+1,10))");
    expect(retry.params).toEqual([TEAM, REVISION, "mapping read unavailable"]);
    // After, not during: the record is not part of the transaction it describes.
    expect(c.log.indexOf(retry)).toBeGreaterThan(c.log.findIndex((e) => e.sql === "rollback"));
  });
});

describe("a request is a durable step; a turn alone only continues", () => {
  /** A team whose revision is `complete` until a reopen statement reaches the database. */
  function completedTeam(
    stored: { status: string; cursor: string | null },
    fail?: (entry: Entry) => Error | undefined,
  ) {
    const base = repository({ candidates: [[ITEM_A]] });
    const connection = new ScriptedConnection((entry) => {
      const failure = fail?.(entry);
      if (failure) return failure;
      if (isReopen(entry)) {
        // The statement's own WHERE: a scan in healthy progress is not reopened.
        if (stored.status === "pending" || stored.status === "running") return [];
        stored.status = "pending";
        stored.cursor = null;
        return [{}];
      }
      // A recorded failure changes the status and nothing else: it keeps whatever cursor is stored.
      if (isRetry(entry)) stored.status = "retry";
      if (isAwaitingCache(entry)) stored.status = "awaiting_cache";
      if (isComplete(entry)) stored.status = "complete";
      if (isPeek(entry)) return [{ repair_status: stored.status }];
      if (isSnapshotRead(entry)) {
        return [{ revision: REVISION, repair_revision: REVISION, repair_status: stored.status, cursor_item_id: stored.cursor }];
      }
      if (isOwnedReread(entry)) {
        return [{
          revision: REVISION, repair_revision: REVISION, repair_status: stored.status,
          cursor_item_id: stored.cursor, deferred: false,
        }];
      }
      return base(entry);
    });
    h.connection = connection;
    return connection;
  }

  it("WITHOUT a request a complete revision is left exactly as it is: no reopen, no status write, no scan", async () => {
    const stored = { status: "complete", cursor: ITEM_B };
    const c = completedTeam(stored);
    await expect(takeRepairScanTurn(new PgClient(), TEAM)).resolves.toMatchObject({ turn: "complete", scanned: 0, partial: false });
    await expect(runAttributionRepairTurn(new PgClient(), TEAM, "acme")).resolves.toMatchObject({ status: "complete" });
    await expect(runScheduledAttributionRepairTurn(new PgClient(), { teamId: TEAM, teamSlug: "acme" })).resolves.toBe("settled");
    expect(c.log.filter((e) => isReopen(e) || isRunning(e) || isCandidateRead(e) || isCursorAdvance(e))).toEqual([]);
    expect(stored).toEqual({ status: "complete", cursor: ITEM_B });
  });

  it("the DIRECT call is a request: the reopen is taken under the turn and COMMITTED on its own, before the snapshot and the scan", async () => {
    const stored = { status: "complete", cursor: ITEM_B };
    const c = completedTeam(stored);
    await expect(reattributeItems(new PgClient(), TEAM, { batchSize: 25 }))
      .resolves.toMatchObject({ turn: "scanned", scanned: 1, partial: false, revision: REVISION });

    const [request, snapshot, batch] = c.transactions;
    expect(c.transactions.map((t) => t.end)).toEqual(["commit", "commit", "commit"]);
    const order = [
      indexOf(request.work, isTurnLock),
      indexOf(request.work, isIdentityLock),
      indexOf(request.work, isReopen),
    ];
    expect(order[0]).toBe(0);
    expect(order.every((index) => index >= 0), `missing a step: ${order}`).toBe(true);
    expect(order).toEqual([...order].sort((a, b) => a - b));
    // The request transaction is ONLY the request: the strict snapshot read — which can fail — is
    // not in it, so nothing after this commit can take the reset back.
    expect(request.work.filter((e) => isSnapshotRead(e) || isCandidateRead(e) || isRunning(e) || isCursorAdvance(e))).toEqual([]);
    // Each later transaction takes the turn again, first.
    expect(isTurnLock(snapshot.work[0])).toBe(true);
    expect(indexOf(snapshot.work, isSnapshotRead)).toBeGreaterThan(0);
    expect(snapshot.work.filter(isReopen)).toEqual([]);
    expect(isTurnLock(batch.work[0])).toBe(true);
    // The scan is a later transaction: it never runs against a revision that still says complete.
    expect(batch.work.filter(isReopen)).toEqual([]);
    // From the start: the stored cursor of the finished scan was cleared with the status.
    expect(batch.work.find(isCandidateRead)!.params).toEqual([TEAM, null, 25]);

    const reopen = request.work.find(isReopen)!;
    const [assignments, where] = reopen.sql.split(" where ");
    expect(assignments).toContain("cursor_item_id=null");
    expect(assignments).toContain("items_scanned=0");
    expect(assignments).toContain("attempts=0,last_error=null,next_attempt_at=null");
    // No new revision: nothing that validated the current mappings is invalidated by a request.
    expect(assignments).not.toMatch(/\brevision=/);
    // A finished scan and a failed one are reopened; a scan in healthy progress is never restarted.
    expect(where).toBe("team_id=$1 and repair_revision=revision and repair_status in ('complete','awaiting_cache','retry')");
    expect(reopen.params).toEqual([TEAM]);
  });

  it("the request OUTLIVES a failed snapshot: the reset stays committed, the failure is recorded on top of it, and the retry scans from the beginning", async () => {
    const stored = { status: "complete", cursor: ITEM_B as string | null };
    let outage = true;
    const c = completedTeam(stored, (entry) => (
      outage && isSnapshotRead(entry) ? injected("identity authority read unavailable") : undefined
    ));
    await expect(reattributeItems(new PgClient(), TEAM, { batchSize: 25 })).rejects.toThrow(/read unavailable/);

    // request (committed) → snapshot (rolled back) → the failure record (committed).
    expect(c.transactions.map((t) => t.end)).toEqual(["commit", "rollback", "commit"]);
    const [request, snapshot, record] = c.transactions;
    expect(request.work.filter(isReopen)).toHaveLength(1);
    expect(snapshot.work.filter(isReopen)).toEqual([]);
    expect(record.work.filter(isRetry)).toHaveLength(1);
    // What is durable now: a failed repair whose cursor is the request's, not the finished scan's.
    expect(stored).toEqual({ status: "retry", cursor: null });

    // The scheduler's turn — which requests nothing — therefore scans from the start.
    outage = false;
    const before = c.log.length;
    await expect(runScheduledAttributionRepairTurn(new PgClient(), { teamId: TEAM, teamSlug: "acme" }, { batchSize: 25 }))
      .resolves.toBe("continuing");
    const turn = c.log.slice(before);
    expect(turn.filter(isReopen)).toEqual([]);
    expect(turn.find(isCandidateRead)!.params).toEqual([TEAM, null, 25]);
  });

  it("a request made during RETRY starts over: a failed turn's cursor is not trusted to mean the rows behind it are right", async () => {
    // A failed finalization leaves `retry` with the cursor at the END of a finished scan.
    const stored = { status: "retry", cursor: ITEM_B as string | null };
    const c = completedTeam(stored);
    await expect(reattributeItems(new PgClient(), TEAM, { batchSize: 25 })).resolves.toMatchObject({ turn: "scanned", scanned: 1 });
    expect(c.log.find(isCandidateRead)!.params).toEqual([TEAM, null, 25]);
    // Whereas a turn that only continues keeps that cursor, as it must.
    const continued = { status: "retry", cursor: ITEM_B as string | null };
    const d = completedTeam(continued);
    await takeRepairScanTurn(new PgClient(), TEAM, { batchSize: 25 });
    expect(d.log.filter(isReopen)).toEqual([]);
    expect(d.log.find(isCandidateRead)!.params).toEqual([TEAM, ITEM_B, 25]);
  });

  it("a request that itself fails enqueued nothing and records nothing: it is only reported", async () => {
    const stored = { status: "complete", cursor: ITEM_B as string | null };
    const c = completedTeam(stored, (entry) => (isReopen(entry) ? injected("authority write unavailable") : undefined));
    await expect(reattributeItems(new PgClient(), TEAM)).rejects.toThrow(/write unavailable/);
    expect(c.transactions.map((t) => t.end)).toEqual(["rollback"]);
    expect(c.log.filter(isRetry)).toEqual([]);
    expect(stored).toEqual({ status: "complete", cursor: ITEM_B });
  });

  it("a request does not restart a repair in progress: it continues from the committed cursor", async () => {
    const stored = { status: "running", cursor: ITEM_A as string | null };
    const c = completedTeam(stored);
    await expect(reattributeItems(new PgClient(), TEAM, { batchSize: 25 })).resolves.toMatchObject({ turn: "scanned" });
    // The request was made and matched nothing.
    expect(c.log.filter(isReopen)).toHaveLength(1);
    expect(c.log.find(isCandidateRead)!.params).toEqual([TEAM, ITEM_A, 25]);
  });

  it("a request that finds the turn BUSY requests nothing", async () => {
    const c = use({ status: "complete", turn: [false] });
    await expect(reattributeItems(new PgClient(), TEAM)).resolves.toMatchObject({ turn: "busy", scanned: 0 });
    expect(c.log.filter((e) => isReopen(e) || isIdentityLock(e))).toEqual([]);
  });

  it("the bounded caller requests ONCE: its first turn reopens, every later turn only continues, and it finalizes", async () => {
    const stored = { status: "complete", cursor: ITEM_B as string | null };
    const c = completedTeam(stored);
    const outcome = await repairAttributionNow(new PgClient(), TEAM, "acme", { maxBatches: 5, batchSize: 25, request: true });
    expect(outcome).toMatchObject({ status: "complete", scanned: 1, partial: false, busy: false });
    expect(c.log.filter(isReopen)).toHaveLength(1);
    // Scan, then the finalization turn: the reopened revision completed the strict way.
    expect(c.log.filter(isCandidateRead)).toHaveLength(1);
    expect(c.log.filter(isComplete)).toHaveLength(1);
    expect(c.log.filter(isEpochAdvance)).toHaveLength(1);

    // The same caller WITHOUT a request, on the now-complete revision, does nothing at all.
    const before = c.log.length;
    await expect(repairAttributionNow(new PgClient(), TEAM, "acme", { maxBatches: 5, batchSize: 25 }))
      .resolves.toMatchObject({ status: "complete", scanned: 0 });
    expect(c.log.slice(before).filter((e) => isReopen(e) || isCandidateRead(e) || isComplete(e))).toEqual([]);
  });

  it("a request on a finished-but-unfinalized scan is honored as a rescan, not routed to the finalization", async () => {
    const stored = { status: "awaiting_cache", cursor: ITEM_B as string | null };
    const c = completedTeam(stored);
    await expect(runAttributionRepairTurn(new PgClient(), TEAM, "acme", { batchSize: 25, request: true }))
      .resolves.toMatchObject({ status: "awaiting_cache", summary: { scanned: 1, turn: "scanned" } });
    expect(c.log.filter(isReopen)).toHaveLength(1);
    expect(c.log.filter(isComplete)).toEqual([]);
    expect(c.log.find(isCandidateRead)!.params).toEqual([TEAM, null, 25]);
  });
});

describe("finalization: its own owned turn", () => {
  it("reread → strict purge → complete + epoch, in ONE transaction, the turn taken first", async () => {
    const c = use({ status: "awaiting_cache" });
    await expect(runAttributionRepairTurn(new PgClient(), TEAM, "acme"))
      .resolves.toMatchObject({ status: "finalized", summary: { revision: REVISION, partial: false } });

    // The routing read is outside any transaction and locks nothing.
    expect(isPeek(c.log[0])).toBe(true);
    expect(c.transactions).toHaveLength(1);
    const { work, end } = c.transactions[0];
    expect(end).toBe("commit");
    const order = [
      indexOf(work, isTurnLock),
      indexOf(work, isIdentityLock),
      indexOf(work, isOwnedReread),
      indexOf(work, isCachePurge("work_timeline_cache")),
      indexOf(work, isCachePurge("arc_cache")),
      indexOf(work, isComplete),
      indexOf(work, isEpochAdvance),
    ];
    expect(order[0]).toBe(0);
    expect(order.every((index) => index >= 0), `missing a step: ${order}`).toBe(true);
    expect(order).toEqual([...order].sort((a, b) => a - b));
    // Finalization scans nothing.
    expect(work.filter((e) => isCandidateRead(e) || isRunning(e))).toEqual([]);
  });

  it("a PURGE FAILURE completes nothing: rollback, then the retry is recorded", async () => {
    const c = use({
      status: "awaiting_cache",
      fail: (e) => (isCachePurge("arc_cache")(e) ? injected("arc purge outage") : undefined),
    });
    await expect(runAttributionRepairTurn(new PgClient(), TEAM, "acme")).rejects.toThrow(/arc purge outage/);
    const [finalization, record] = c.transactions;
    expect(finalization.end).toBe("rollback");
    expect(c.log.filter((e) => isComplete(e) || isEpochAdvance(e))).toEqual([]);
    expect(record.end).toBe("commit");
    expect(record.work.find(isRetry)!.params.slice(0, 2)).toEqual([TEAM, REVISION]);
  });

  it("BUSY: a finalization another owner holds is left to it", async () => {
    const c = use({ status: "awaiting_cache", turn: [false] });
    await expect(runAttributionRepairTurn(new PgClient(), TEAM, "acme")).resolves.toMatchObject({ status: "busy" });
    expect(c.log.filter(isWrite)).toEqual([]);
    expect(c.log.filter(isIdentityLock)).toEqual([]);
  });
});

describe("bounded callers report `continuing`; they do not fail", () => {
  it("a spent scan budget returns `continuing`, writes no failure state, and kicks the scheduler", async () => {
    const kicks = vi.fn();
    onAttributionRepairKick(kicks);
    // Every page is full: the scan never finishes inside the budget.
    const c = use({ status: "running", candidates: [[ITEM_A]] });
    const outcome = await repairAttributionNow(new PgClient(), TEAM, "acme", { maxBatches: 3, batchSize: 1 });
    expect(outcome).toMatchObject({ status: "continuing", busy: false, partial: true, scanned: 3, revision: REVISION });
    expect(c.log.filter(isCandidateRead)).toHaveLength(3);
    expect(c.log.filter(isRetry)).toEqual([]);
    expect(kicks).toHaveBeenCalledTimes(1);
  });

  it("a busy turn returns `continuing` with busy=true and kicks; the scheduler sees `busy`, not a failure", async () => {
    const kicks = vi.fn();
    onAttributionRepairKick(kicks);
    const c = use({ turn: [false] });
    await expect(repairAttributionNow(new PgClient(), TEAM, "acme"))
      .resolves.toMatchObject({ status: "continuing", busy: true, scanned: 0 });
    expect(kicks).toHaveBeenCalledTimes(1);
    expect(c.log.filter(isWrite)).toEqual([]);

    use({ turn: [false] });
    await expect(runScheduledAttributionRepairTurn(new PgClient(), { teamId: TEAM, teamSlug: "acme" }))
      .resolves.toBe("busy");
  });

  it("scan then finalization converge inside one budget, and a completed revision is not kicked", async () => {
    const kicks = vi.fn();
    onAttributionRepairKick(kicks);
    let finished = false;
    const base = repository({ candidates: [[ITEM_A]] });
    h.connection = new ScriptedConnection((entry) => {
      if (isAwaitingCache(entry)) finished = true;
      if (isPeek(entry)) return [{ repair_status: finished ? "awaiting_cache" : "pending" }];
      if (isOwnedReread(entry)) {
        return [{
          revision: REVISION, repair_revision: REVISION, repair_status: finished ? "awaiting_cache" : "pending",
          cursor_item_id: null, deferred: false,
        }];
      }
      return base(entry);
    });
    await expect(repairAttributionNow(new PgClient(), TEAM, "acme", { maxBatches: 5, batchSize: 25 }))
      .resolves.toMatchObject({ status: "complete", busy: false, partial: false, scanned: 1, revision: REVISION });
    expect(kicks).not.toHaveBeenCalled();
  });

  it("the scheduler's turn treats a superseded revision as work to continue, and a real failure as a failure", async () => {
    use({ owned: { revision: REVISION + 1 } });
    await expect(runScheduledAttributionRepairTurn(new PgClient(), { teamId: TEAM, teamSlug: "acme" }))
      .resolves.toBe("continuing");
    use({ fail: (e) => (isCandidateRead(e) ? injected("candidate read unavailable") : undefined) });
    await expect(runScheduledAttributionRepairTurn(new PgClient(), { teamId: TEAM, teamSlug: "acme" }))
      .rejects.toThrow(/candidate read unavailable/);
  });
});
