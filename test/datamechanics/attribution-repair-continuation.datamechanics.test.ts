import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { describe, expect, it, vi } from "vitest";
import { AttributionRepairPendingError, authorizationEpoch } from "@/lib/access/authorization-epoch";
import { addAuthorAlias } from "@/lib/admin/aliases";
import { readTimelineCache, resolveTimelineVariant, writeTimelineCache } from "@/lib/dashboard/timeline-cache";
import { getPool } from "@/lib/db/pg/pool";
import type { DbClient } from "@/lib/db/types";
import { createAttributionRepairLoop, type RepairRoundSummary } from "@/lib/ingest/attribution-repair-scheduler";
import { reattributeItems, REPAIR_TURN_BATCH } from "@/lib/ingest/reattribute";
import {
  discoverPendingAttributionRepairs,
  drainPendingAttributionRepairs,
  onAttributionRepairKick,
  reconcileAttribution,
  repairAttributionNow,
  runAttributionRepairTurn,
  runScheduledAttributionRepairTurn,
} from "@/lib/ingest/reconcile-attribution";
import { db, ingest, seedTeam, type Seed } from "./helpers";

/**
 * PROMPT, BOUNDED CONTINUATION of the team-wide attribution repair, against real PostgreSQL
 * (AIO-1167) — the observable half of `test/attribution-repair-turn.test.ts` and
 * `test/attribution-repair-scheduler.test.ts`.
 *
 * Spec. A roster or identity-mapping change leaves a durable repair on the team's authority row and
 * fences attribution-dependent reads until it completes. The scheduler continues that repair:
 *
 *   1. from durable state alone — a loop that has just booted, was told nothing and is never
 *      kicked discovers every pending team and converges it, one bounded batch per team turn,
 *      rotating fairly, however many batches it takes;
 *   2. reads stay fenced through every partial batch AND through `awaiting_cache`; only the strict
 *      finalization (purge + completion + epoch, atomically) lifts the fence;
 *   3. two owners never run a team at once: the loser is `busy`, which changes nothing durable, and
 *      no item is ever scanned twice at one revision;
 *   4. a process that dies mid-batch leaves exactly the last COMMITTED batch; a restart resumes it;
 *   5. a new revision wins: progress resets, a stale owner publishes nothing and records no failure;
 *   6. a real failure rolls its whole batch back and is recorded AFTER, with a deadline the
 *      scheduler honors; healthy batches and busy turns never count as attempts;
 *   7. a bounded Admin budget that ends reports `continuing`, and the work goes on past it;
 *   8. a complete revision is a no-op for everything that only continues; the manual repair is a
 *      REQUEST, which durably re-enqueues it — same revision, fenced, resumable — before scanning.
 *
 * Fixtures and the roster trigger. A roster or mapping write on a team with NOTHING stored records
 * its revision as already complete: there is nothing to repair. So a pending repair here always
 * comes from a production mapping write made AFTER the rows it has to repair exist.
 */

interface AuthorityRow {
  repair_status: string;
  revision: number;
  cursor_item_id: string | null;
  items_scanned: number;
  items_updated: number;
  attempts: number;
  last_error: string | null;
  deferred: boolean;
}

async function authority(seed: Seed): Promise<AuthorityRow> {
  const { rows } = await getPool().query<AuthorityRow>(
    `select repair_status, revision::int as revision, cursor_item_id, items_scanned::int as items_scanned,
            items_updated::int as items_updated, attempts, last_error,
            coalesce(next_attempt_at > now(), false) as deferred
       from team_identity_authority where team_id=$1`, [seed.teamId]);
  return rows[0];
}

async function member(seed: Seed, name: string, status: "active" | "invited" = "active"): Promise<{ id: string; email: string }> {
  const email = `${name.toLowerCase()}-${randomUUID().slice(0, 8)}@roster.example`;
  const { data, error } = await db().from("members").insert({
    team_id: seed.teamId, email, display_name: name,
    actor_handle: `${name.toLowerCase()}-${randomUUID().slice(0, 8)}`,
    role: "member", tier: "team", status, is_connector: false,
  }).select("id").single();
  if (error || !data) throw new Error(`member fixture failed: ${error?.message}`);
  return { id: (data as { id: string }).id, email };
}

const authorAddress = () => `author-${randomUUID().slice(0, 8)}@provider.example`;

/**
 * `count` already-ingested team-tier items naming one author address and credited to nobody — the
 * shape a mapping change has to repair. Written directly: the subject here is the repair of stored
 * rows, and one statement makes thousands of them.
 */
async function storedItems(seed: Seed, count: number, authorEmail: string): Promise<void> {
  const { data, error } = await db().from("projects")
    .insert({ team_id: seed.teamId, slug: `repair-${randomUUID().slice(0, 8)}`, name: "Repair fixtures", kind: "initiative" })
    .select("id").single();
  if (error || !data) throw new Error(`project fixture failed: ${error?.message}`);
  await getPool().query(
    `insert into items (team_id, project_id, path, kind, access, frontmatter, content_sha256)
     select $1, $2, 'stored/' || lpad(g::text, 6, '0') || '.md', 'deliverable', 'team', $3::jsonb, md5(g::text)
       from generate_series(1, $4::int) g`,
    [seed.teamId, (data as { id: string }).id,
      JSON.stringify({ source: "notion", authors: [{ email: authorEmail, role: "author" }] }), count]);
}

async function credited(seed: Seed, memberId: string | null): Promise<number> {
  const { rows } = await getPool().query<{ n: number }>(
    "select count(*)::int as n from items where team_id=$1 and member_id is not distinct from $2",
    [seed.teamId, memberId]);
  return rows[0].n;
}

/** Whether attribution-dependent reads are fenced for this team right now. */
const fenced = (seed: Seed) => authorizationEpoch(db(), seed.teamId)
  .then(() => false, (error: unknown) => {
    if (error instanceof AttributionRepairPendingError) return true;
    throw error;
  });

/**
 * The production scheduler, exactly as `startAttributionRepairScheduler` wires it, minus the timers:
 * the tests drive its rounds by hand. A NEW loop is "the process just booted" — it holds no memory
 * of any team and is never kicked, so everything it does comes from the authority table.
 */
function bootedScheduler(batchSize?: number) {
  return createAttributionRepairLoop({
    discover: (limit, skip) => discoverPendingAttributionRepairs(limit, { skip }),
    runTurn: (team) => runScheduledAttributionRepairTurn(db(), team, { batchSize }),
  });
}

/** Rounds until one has nothing left to continue — the point at which the real loop goes idle. */
async function runUntilIdle(loop: ReturnType<typeof bootedScheduler>, limit = 400): Promise<RepairRoundSummary[]> {
  const rounds: RepairRoundSummary[] = [];
  for (let round = 0; round < limit; round++) {
    const summary = await loop.runRound();
    rounds.push(summary);
    if (summary.continuing === 0 && !summary.capped) return rounds;
  }
  throw new Error(`the scheduler did not go idle within ${limit} rounds`);
}

const round = (over: Partial<RepairRoundSummary>): RepairRoundSummary => ({
  attempted: 0, continuing: 0, settled: 0, busy: 0, deferred: 0, failed: 0, capped: false, ...over,
});

/** The real client, except that one builder operation on one table answers with an error envelope. */
function failingBuilder(table: string, operation: "upsert" | "delete", message: string): DbClient {
  const real = db();
  const failed = { data: null, error: { message } };
  const answer: Record<string, unknown> = {
    then: (resolve: (value: unknown) => unknown) => resolve(failed),
  };
  for (const chained of ["eq", "select", "in"]) answer[chained] = () => answer;
  return new Proxy(real as object, {
    get(target, prop, receiver) {
      if (prop !== "from") return Reflect.get(target, prop, receiver);
      return (name: string) => {
        const query = (target as { from: (n: string) => unknown }).from(name) as object;
        if (name !== table) return query;
        return new Proxy(query, {
          get(inner, key, innerReceiver) {
            return key === operation ? () => answer : Reflect.get(inner, key, innerReceiver);
          },
        });
      };
    },
  }) as DbClient;
}

/** Let a recorded retry deadline pass without waiting for it. */
const passDeadline = (seed: Seed) => getPool().query(
  "update team_identity_authority set next_attempt_at = now() - interval '1 second' where team_id=$1", [seed.teamId]);

/** Keep a recorded retry deadline in the future for as long as the assertions about it take. The
 * first backoff is two seconds; a slow machine must not turn "in backoff" into "due". */
const holdDeadline = (seed: Seed) => getPool().query(
  `update team_identity_authority set next_attempt_at = now() + interval '1 hour'
    where team_id=$1 and next_attempt_at is not null`, [seed.teamId]);

describe("AIO-1167 attribution repair continues promptly from durable state (real Postgres)", () => {
  it("MIGRATION-LIKE: a booted scheduler finds every pending team, rotates one batch per turn, and each team stays fenced until ITS finalization", async () => {
    // Three teams left pending with nothing to announce them — as a migration that seeds the
    // authority table leaves every existing team that has content — with repairs of very different
    // sizes. Each one's pending revision comes from its own production mapping write: the alias
    // trigger finds stored rows and enqueues their repair. A fourth team has NOTHING stored, and
    // for such a team the same trigger records the revision as already complete: there is nothing
    // to repair, so it must never be discovered, fenced or touched.
    const large = await seedTeam();
    const small = await seedTeam();
    const tiny = await seedTeam();
    const empty = await seedTeam();
    const alice = await member(large, "Alice");
    const bob = await member(small, "Bob");
    const carol = await member(tiny, "Carol");
    await member(empty, "Dana");
    const largeAuthor = authorAddress();
    const smallAuthor = authorAddress();
    const tinyAuthor = authorAddress();
    await storedItems(large, 12, largeAuthor);
    await storedItems(small, 3, smallAuthor);
    await storedItems(tiny, 1, tinyAuthor);
    // Until a mapping changes, a team's stored rows are consistent with its completed revision.
    for (const seed of [large, small, tiny, empty]) {
      expect(await authority(seed)).toMatchObject({ repair_status: "complete" });
    }
    expect(await addAuthorAlias(db(), large.teamId, alice.id, largeAuthor)).toMatchObject({ aliased: true });
    expect(await addAuthorAlias(db(), small.teamId, bob.id, smallAuthor)).toMatchObject({ aliased: true });
    expect(await addAuthorAlias(db(), tiny.teamId, carol.id, tinyAuthor)).toMatchObject({ aliased: true });
    expect(await addAuthorAlias(db(), empty.teamId, (await member(empty, "Erin")).id, authorAddress())).toMatchObject({ aliased: true });
    for (const seed of [large, small, tiny]) {
      expect(await authority(seed)).toMatchObject({ repair_status: "pending", cursor_item_id: null, attempts: 0 });
      expect(await fenced(seed)).toBe(true);
    }
    const untouched = await authority(empty);
    expect(untouched).toMatchObject({ repair_status: "complete", items_scanned: 0, attempts: 0 });
    expect(await fenced(empty)).toBe(false);
    // The durable queue, as the scheduler pages it: one stable order, and the page after a capped
    // one starts where it ended — no team is on both, none is on neither.
    const queue = (await discoverPendingAttributionRepairs(20)).map((team) => team.teamId);
    expect([...queue].sort()).toEqual([large.teamId, small.teamId, tiny.teamId].sort());
    const firstPage = (await discoverPendingAttributionRepairs(2)).map((team) => team.teamId);
    const secondPage = (await discoverPendingAttributionRepairs(2, { skip: 2 })).map((team) => team.teamId);
    expect([...firstPage, ...secondPage]).toEqual(queue);

    const scheduler = bootedScheduler(5);
    // Round 1: every pending team gets exactly one turn. `large` commits 5 of 12; the others finish
    // their scan — and a finished scan is NOT completion.
    expect(await scheduler.runRound()).toEqual(round({ attempted: 3, continuing: 3 }));
    expect(await authority(large)).toMatchObject({ repair_status: "running", items_scanned: 5, items_updated: 5 });
    expect(await authority(small)).toMatchObject({ repair_status: "awaiting_cache", items_scanned: 3, items_updated: 3 });
    expect(await authority(tiny)).toMatchObject({ repair_status: "awaiting_cache", items_scanned: 1, items_updated: 1 });
    expect(await credited(small, bob.id)).toBe(3);
    expect(await credited(tiny, carol.id)).toBe(1);
    for (const seed of [large, small, tiny]) expect(await fenced(seed)).toBe(true);

    // Round 2: the small teams finalize while the large one is still mid-scan. Nobody waited for it.
    expect(await scheduler.runRound()).toEqual(round({ attempted: 3, continuing: 1, settled: 2 }));
    expect(await authority(small)).toMatchObject({ repair_status: "complete" });
    expect(await authority(tiny)).toMatchObject({ repair_status: "complete" });
    expect(await fenced(small)).toBe(false);
    expect(await fenced(tiny)).toBe(false);
    expect(await authority(large)).toMatchObject({ repair_status: "running", items_scanned: 10 });
    expect(await credited(large, alice.id)).toBe(10);
    expect(await fenced(large)).toBe(true);

    // Round 3 ends the large scan; round 4 is its finalization. Then there is nothing to discover.
    expect(await scheduler.runRound()).toEqual(round({ attempted: 1, continuing: 1 }));
    expect(await authority(large)).toMatchObject({ repair_status: "awaiting_cache", items_scanned: 12 });
    expect(await fenced(large)).toBe(true);
    expect(await scheduler.runRound()).toEqual(round({ attempted: 1, settled: 1 }));
    expect(await authority(large)).toMatchObject({
      repair_status: "complete", items_scanned: 12, items_updated: 12, attempts: 0, last_error: null,
    });
    expect(await credited(large, alice.id)).toBe(12);
    expect(await fenced(large)).toBe(false);
    expect(await scheduler.runRound()).toEqual(round({}));
    // The team with nothing to repair was never anyone's turn: its row is byte-for-byte as the
    // trigger left it, and it was readable throughout.
    expect(await authority(empty)).toEqual(untouched);
    expect(await fenced(empty)).toBe(false);
  }, 60_000);

  it("INVITED → ACTIVE: no hook announces it; the published cache is fenced through every batch and replaced only by strict completion", async () => {
    const seed = await seedTeam();
    const invitee = await member(seed, "Invitee", "invited");
    // Content already stored when the invitation is accepted, written under an address nobody on
    // the roster had: unresolved at ingest, so credited to nobody. That is a CONSISTENT state — the
    // team's revision is complete (no roster write has found anything to repair), reads are open,
    // and a ledger is published under it.
    const signInAddress = authorAddress();
    await storedItems(seed, 11, signInAddress);
    expect(await authority(seed)).toMatchObject({ repair_status: "complete" });
    expect(await credited(seed, null)).toBe(11);
    const vis = await resolveTimelineVariant(db(), seed.teamId, seed.memberId);
    const healthyEpoch = await authorizationEpoch(db(), seed.teamId);
    expect(await writeTimelineCache(db(), seed.teamId, "team", [], false, vis, healthyEpoch))
      .toMatchObject({ status: "published" });
    expect(await readTimelineCache(db(), seed.teamId, "team", vis)).not.toBeNull();

    // The invitee signs in for the first time, with that address. Two production roster writes —
    // the address becomes theirs, and the invitation becomes an active membership — and nothing
    // else: no Admin action ran, so nothing kicks, reconciles or schedules anything.
    const kicks = vi.fn();
    onAttributionRepairKick(kicks);
    try {
      expect(await addAuthorAlias(db(), seed.teamId, invitee.id, signInAddress)).toMatchObject({ aliased: true });
      const aliased = await authority(seed);
      expect(aliased).toMatchObject({ repair_status: "pending", cursor_item_id: null, items_scanned: 0 });
      const accepted = await db().from("members").update({ status: "active" }).eq("id", invitee.id).eq("team_id", seed.teamId);
      expect(accepted.error).toBeNull();
      // The activation is its own durable revision, enqueued by the roster trigger alone.
      const pending = await authority(seed);
      expect(pending).toMatchObject({ repair_status: "pending", cursor_item_id: null, items_scanned: 0, attempts: 0 });
      expect(pending.revision).toBe(aliased.revision + 1);
      expect(await credited(seed, invitee.id)).toBe(0);
      expect(await readTimelineCache(db(), seed.teamId, "team", vis)).toBeNull();

      const scheduler = bootedScheduler(4);
      const statuses: string[] = [];
      for (;;) {
        const summary = await scheduler.runRound();
        const now = await authority(seed);
        statuses.push(now.repair_status);
        if (now.repair_status !== "complete") {
          // Mid-repair — including the turn after the scan finished: the old ledger is not served,
          // and neither it nor a fresh build can be published.
          expect(summary).toEqual(round({ attempted: 1, continuing: 1 }));
          expect(await fenced(seed)).toBe(true);
          expect(await readTimelineCache(db(), seed.teamId, "team", vis)).toBeNull();
          expect(await writeTimelineCache(db(), seed.teamId, "team", [], false, vis, healthyEpoch))
            .toMatchObject({ status: "cache_failed" });
          expect(await writeTimelineCache(db(), seed.teamId, "team", [], false, vis))
            .toMatchObject({ status: "cache_failed" });
          continue;
        }
        expect(summary).toEqual(round({ attempted: 1, settled: 1 }));
        break;
      }
      // 11 items in batches of 4: three scan turns, then the finalization.
      expect(statuses).toEqual(["running", "running", "awaiting_cache", "complete"]);
      expect(await authority(seed)).toMatchObject({
        revision: pending.revision, items_scanned: 11, items_updated: 11, attempts: 0, last_error: null,
      });
      expect(await credited(seed, invitee.id)).toBe(11);
      expect(kicks).not.toHaveBeenCalled();
    } finally {
      onAttributionRepairKick(null);
    }

    // Strict completion: the superseded ledger is physically gone, its epoch is dead, and the new
    // generation publishes and serves.
    const { rows: leftover } = await getPool().query<{ n: number }>(
      "select count(*)::int as n from work_timeline_cache where team_id=$1", [seed.teamId]);
    expect(leftover[0].n).toBe(0);
    const completedEpoch = await authorizationEpoch(db(), seed.teamId);
    expect(completedEpoch).toBeGreaterThan(healthyEpoch);
    expect(await writeTimelineCache(db(), seed.teamId, "team", [], false, vis, healthyEpoch))
      .toMatchObject({ status: "epoch_rejected", currentAuthorizationEpoch: completedEpoch });
    expect(await writeTimelineCache(db(), seed.teamId, "team", [], false, vis, completedEpoch))
      .toMatchObject({ status: "published" });
    expect(await readTimelineCache(db(), seed.teamId, "team", vis)).not.toBeNull();
  }, 60_000);

  it("TWO CALLERS: while one owns the turn every other entry point is busy — nothing durable changes — and no item is scanned twice", async () => {
    const seed = await seedTeam();
    const alice = await member(seed, "Alice");
    const author = authorAddress();
    await storedItems(seed, 12, author);
    await addAuthorAlias(db(), seed.teamId, alice.id, author);
    const before = await authority(seed);

    let release!: () => void;
    let owned!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const owning = new Promise<void>((resolve) => { owned = resolve; });
    // The owner: it holds the turn and the identity authority, and has written nothing yet.
    const owner = reattributeItems(db(), seed.teamId, {
      batchSize: 5, afterOwnership: async () => { owned(); await gate; },
    });
    owner.catch(() => undefined);
    try {
      await owning;
      // The manual/Admin form, the scheduler's turn, the ingest-chain backstop and the post-response
      // hook all answer at once, and none of them is a failure.
      expect(await repairAttributionNow(db(), seed.teamId, seed.teamSlug, { maxBatches: 10, batchSize: 5 }))
        .toMatchObject({ status: "continuing", busy: true, scanned: 0, partial: true });
      expect(await reattributeItems(db(), seed.teamId, { batchSize: 5 })).toMatchObject({ turn: "busy", scanned: 0 });
      expect(await bootedScheduler(5).runRound()).toEqual(round({ attempted: 1, busy: 1 }));
      expect(await drainPendingAttributionRepairs(db(), { maxBatchesPerTeam: 2, batchSize: 5 }))
        .toEqual({ attempted: 1, complete: 0, continuing: 1, failed: 0 });
      await expect(reconcileAttribution(db(), seed.teamId, seed.teamSlug)).resolves.toBeUndefined();
      // Busy wrote nothing: not progress, not an attempt, not an error, not a deadline.
      expect(await authority(seed)).toEqual(before);
      expect(await credited(seed, alice.id)).toBe(0);
    } finally {
      release();
    }
    await expect(owner).resolves.toMatchObject({ turn: "scanned", scanned: 5, partial: true });
    expect(await authority(seed)).toMatchObject({ repair_status: "running", items_scanned: 5, attempts: 0 });

    // Now a free-for-all: three callers race every remaining turn. Whoever loses a turn is busy;
    // between them the revision completes, and the counters show each item was scanned once.
    const [manual, hook, rounds] = await Promise.all([
      repairAttributionNow(db(), seed.teamId, seed.teamSlug, { maxBatches: 10, batchSize: 5 }),
      repairAttributionNow(db(), seed.teamId, seed.teamSlug, { maxBatches: 10, batchSize: 5 }),
      runUntilIdle(bootedScheduler(5)),
    ]);
    for (const outcome of [manual, hook]) {
      expect(["complete", "continuing"]).toContain(outcome.status);
      if (outcome.status === "continuing") expect(outcome.busy).toBe(true);
    }
    expect(rounds.reduce((n, summary) => n + summary.failed, 0)).toBe(0);
    // Whatever the interleaving left, one more pass settles it, and nothing was done twice.
    expect(await repairAttributionNow(db(), seed.teamId, seed.teamSlug, { maxBatches: 10, batchSize: 5 }))
      .toMatchObject({ status: "complete" });
    expect(await authority(seed)).toMatchObject({
      repair_status: "complete", revision: before.revision, items_scanned: 12, items_updated: 12,
      attempts: 0, last_error: null, deferred: false,
    });
    expect(await credited(seed, alice.id)).toBe(12);
  }, 60_000);

  it("CRASH / RESTART: an owner that dies mid-batch leaves exactly the last committed batch, and a restarted scheduler resumes from it", async () => {
    const seed = await seedTeam();
    const alice = await member(seed, "Alice");
    const author = authorAddress();
    await storedItems(seed, 12, author);
    await addAuthorAlias(db(), seed.teamId, alice.id, author);

    // The first process commits one batch.
    expect(await bootedScheduler(5).runRound()).toEqual(round({ attempted: 1, continuing: 1 }));
    const committed = await authority(seed);
    expect(committed).toMatchObject({ repair_status: "running", items_scanned: 5, attempts: 0 });
    expect(committed.cursor_item_id).not.toBeNull();

    // Then it dies in the middle of its next one: the turn and the identity authority are held and
    // three more items are written, uncommitted, when the backend goes away. It runs no cleanup —
    // there is no process left to run any.
    const dying = new Client({ connectionString: process.env.DATABASE_URL });
    dying.on("error", () => undefined);
    await dying.connect();
    try {
      await dying.query("begin");
      const turn = await dying.query<{ acquired: boolean }>(
        "select pg_try_advisory_xact_lock(hashtextextended($1,0)) as acquired", [`${seed.teamId}:attribution-repair-turn`]);
      expect(turn.rows[0].acquired).toBe(true);
      await dying.query("select pg_advisory_xact_lock(hashtextextended($1,0))", [`${seed.teamId}:identity-authority`]);
      const written = await dying.query<{ id: string }>(
        `update items set member_id=$2
          where id in (select id from items where team_id=$1 and id>$3::uuid order by id limit 3)
        returning id`, [seed.teamId, alice.id, committed.cursor_item_id]);
      expect(written.rows).toHaveLength(3);
      const last = written.rows.map((row) => row.id).sort().at(-1);
      await dying.query(
        "update team_identity_authority set cursor_item_id=$2, items_scanned=items_scanned+3 where team_id=$1",
        [seed.teamId, last]);

      // While it is still alive it IS the owner: everyone else is busy, and stays out.
      expect(await bootedScheduler(5).runRound()).toEqual(round({ attempted: 1, busy: 1 }));
      expect(await authority(seed)).toEqual(committed);

      const { rows: backend } = await dying.query<{ pid: number }>("select pg_backend_pid() as pid");
      await getPool().query("select pg_terminate_backend($1)", [backend[0].pid]);
    } finally {
      await dying.end().catch(() => undefined);
    }

    // The death released the turn and took the uncommitted batch with it. Nothing recorded a
    // failure, because nothing was left to record one: the durable row is the committed batch.
    await expect.poll(async () => (await bootedScheduler(5).runRound()).busy, { timeout: 10_000 }).toBe(0);
    // That poll's successful round was the restarted process's first turn: batch two, for real.
    expect(await authority(seed)).toMatchObject({
      repair_status: "running", items_scanned: 10, items_updated: 10, attempts: 0, last_error: null,
    });
    expect(await credited(seed, alice.id)).toBe(10);

    const rounds = await runUntilIdle(bootedScheduler(5));
    expect(rounds.reduce((n, summary) => n + summary.failed, 0)).toBe(0);
    expect(await authority(seed)).toMatchObject({
      repair_status: "complete", revision: committed.revision, items_scanned: 12, items_updated: 12, attempts: 0,
    });
    expect(await credited(seed, alice.id)).toBe(12);
    expect(await fenced(seed)).toBe(false);
  }, 60_000);

  it("REVISION RESET: a new revision wins — progress starts over, a stale owner writes nothing and records no failure", async () => {
    const seed = await seedTeam();
    const alice = await member(seed, "Alice");
    const bob = await member(seed, "Bob");
    const author = authorAddress();
    await storedItems(seed, 12, author);
    await addAuthorAlias(db(), seed.teamId, alice.id, author);

    const scheduler = bootedScheduler(5);
    expect(await scheduler.runRound()).toEqual(round({ attempted: 1, continuing: 1 }));
    const first = await authority(seed);
    expect(first).toMatchObject({ repair_status: "running", items_scanned: 5 });
    expect(await credited(seed, alice.id)).toBe(5);

    // An owner nominated at the old revision, paused before it takes its batch.
    let release!: () => void;
    let ready!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const snapshotted = new Promise<void>((resolve) => { ready = resolve; });
    const stale = reattributeItems(db(), seed.teamId, {
      batchSize: 5, afterSnapshot: async () => { ready(); await gate; },
    });
    stale.catch(() => undefined);
    try {
      await snapshotted;
      // The address is remapped to Bob: a new revision.
      expect(await addAuthorAlias(db(), seed.teamId, bob.id, author, { force: true })).toMatchObject({ aliased: true });
    } finally {
      release();
    }
    await expect(stale).rejects.toThrow(/identity mapping changed/);

    // The mutation reset the durable progress, and the stale owner left it exactly so: no cursor,
    // no counters, no attempt, no error, no deadline — and none of ITS credit.
    const reset = await authority(seed);
    expect(reset).toMatchObject({
      repair_status: "pending", cursor_item_id: null, items_scanned: 0, items_updated: 0,
      attempts: 0, last_error: null, deferred: false,
    });
    expect(reset.revision).toBeGreaterThan(first.revision);
    expect(await credited(seed, bob.id)).toBe(0);
    expect(await credited(seed, alice.id)).toBe(5);
    expect(await fenced(seed)).toBe(true);

    // The scheduler simply continues, at the new revision, from the beginning: the five rows the
    // old revision had already given to Alice are repaired again, to Bob.
    const rounds = await runUntilIdle(scheduler);
    expect(rounds.reduce((n, summary) => n + summary.failed, 0)).toBe(0);
    expect(await authority(seed)).toMatchObject({
      repair_status: "complete", revision: reset.revision, items_scanned: 12, items_updated: 12, attempts: 0,
    });
    expect(await credited(seed, bob.id)).toBe(12);
    expect(await credited(seed, alice.id)).toBe(0);
  }, 60_000);

  it("ITEM FAILURE: the whole batch rolls back, the retry is recorded after it, the scheduler honors the deadline, and healthy batches never count as attempts", async () => {
    const seed = await seedTeam();
    const alice = await member(seed, "Alice");
    const author = authorAddress();
    await storedItems(seed, 12, author);
    await addAuthorAlias(db(), seed.teamId, alice.id, author);
    const scheduler = bootedScheduler(5);
    expect(await scheduler.runRound()).toEqual(round({ attempted: 1, continuing: 1 }));
    const committed = await authority(seed);

    // The second batch fails on its THIRD item: two items' repairs and cursor moves are already
    // written in that transaction when it does.
    let repaired = 0;
    await expect(reattributeItems(db(), seed.teamId, {
      batchSize: 5,
      afterItem: async () => { if (++repaired === 3) throw new Error("injected item failure"); },
    })).rejects.toThrow(/injected item failure/);
    expect(repaired).toBe(3);
    // Nothing of the failed batch survived, and the failure is durable.
    expect(await authority(seed)).toMatchObject({
      repair_status: "retry", cursor_item_id: committed.cursor_item_id, items_scanned: 5, items_updated: 5,
      attempts: 1, last_error: "injected item failure", deferred: true,
    });
    expect(await credited(seed, alice.id)).toBe(5);
    expect(await fenced(seed)).toBe(true);

    // In backoff: the scheduler does not discover it, and a turn nominated anyway is deferred —
    // neither is another attempt, and neither writes anything.
    await holdDeadline(seed);
    const failed = await authority(seed);
    expect(await scheduler.runRound()).toEqual(round({}));
    expect(await runScheduledAttributionRepairTurn(db(), { teamId: seed.teamId, teamSlug: seed.teamSlug }, { batchSize: 5 }))
      .toBe("deferred");
    expect(await authority(seed)).toEqual(failed);

    // Once the deadline has passed it converges. The first healthy batch clears the error and the
    // deadline; none of the healthy turns adds an attempt.
    await passDeadline(seed);
    expect(await scheduler.runRound()).toEqual(round({ attempted: 1, continuing: 1 }));
    expect(await authority(seed)).toMatchObject({
      repair_status: "running", items_scanned: 10, attempts: 1, last_error: null, deferred: false,
    });
    const rounds = await runUntilIdle(scheduler);
    expect(rounds.reduce((n, summary) => n + summary.failed, 0)).toBe(0);
    expect(await authority(seed)).toMatchObject({
      repair_status: "complete", items_scanned: 12, items_updated: 12, attempts: 1, last_error: null, deferred: false,
    });
    expect(await credited(seed, alice.id)).toBe(12);
  }, 60_000);

  it("EVIDENCE and PURGE FAILURE through the scheduler: no partial repair, no false completion, and each resumes after its deadline", async () => {
    const seed = await seedTeam();
    const alice = await member(seed, "Alice");
    const editor = { key: `permission:editor-${randomUUID().slice(0, 8)}`, email: authorAddress() };
    // A Drive document: its repair writes contribution evidence as well as credit.
    const drive = await ingest(seed, {
      project: "drive-repair", path: `gdrive/${randomUUID()}.md`, access: "team", body: "drive body",
      frontmatter: {
        source: "gdrive", source_id: `doc-${randomUUID().slice(0, 8)}`, title: "Drive doc",
        authors: [{ provider: "gdrive", external_id: editor.key, email: editor.email, role: "editor" }],
        contributions: [{ external_id: editor.key, email: editor.email, role: "editor", at: new Date().toISOString() }],
      },
    });
    await getPool().query("update items set member_id=null where id=$1", [drive.id]);
    await getPool().query("update item_versions set member_id=null where item_id=$1", [drive.id]);
    await addAuthorAlias(db(), seed.teamId, alice.id, editor.email);
    const team = { teamId: seed.teamId, teamSlug: seed.teamSlug };

    // The evidence write fails: the item and version credit of that batch go with it.
    await expect(runScheduledAttributionRepairTurn(
      failingBuilder("gdrive_contribution_evidence", "upsert", "injected evidence outage"), team,
    )).rejects.toThrow(/injected evidence outage/);
    expect(await authority(seed)).toMatchObject({
      repair_status: "retry", cursor_item_id: null, items_scanned: 0, attempts: 1,
      last_error: expect.stringContaining("injected evidence outage"), deferred: true,
    });
    expect(await credited(seed, alice.id)).toBe(0);
    await holdDeadline(seed);
    expect(await bootedScheduler().runRound()).toEqual(round({}));

    // After the deadline the scan completes — and stops at `awaiting_cache`.
    await passDeadline(seed);
    expect(await bootedScheduler().runRound()).toEqual(round({ attempted: 1, continuing: 1 }));
    expect(await authority(seed)).toMatchObject({ repair_status: "awaiting_cache", items_scanned: 1, attempts: 1 });
    expect(await credited(seed, alice.id)).toBe(1);

    // The strict purge fails: the credit is durable, the completion is not, and reads stay fenced.
    await expect(runScheduledAttributionRepairTurn(
      failingBuilder("work_timeline_cache", "delete", "injected purge outage"), team,
    )).rejects.toThrow(/injected purge outage/);
    expect(await authority(seed)).toMatchObject({
      repair_status: "retry", items_scanned: 1, attempts: 2,
      last_error: expect.stringContaining("injected purge outage"), deferred: true,
    });
    expect(await fenced(seed)).toBe(true);
    await holdDeadline(seed);
    expect(await bootedScheduler().runRound()).toEqual(round({}));

    // After that deadline: an empty scan turn re-establishes `awaiting_cache`, then finalization.
    await passDeadline(seed);
    const rounds = await runUntilIdle(bootedScheduler());
    expect(rounds).toEqual([round({ attempted: 1, continuing: 1 }), round({ attempted: 1, settled: 1 })]);
    expect(await authority(seed)).toMatchObject({ repair_status: "complete", items_scanned: 1, attempts: 2, last_error: null });
    expect(await fenced(seed)).toBe(false);
  }, 60_000);

  it("ADMIN BUDGET: a spent budget reports `continuing` — never an error — kicks after the fact, and the ingest-chain backstop reports the same", async () => {
    const seed = await seedTeam();
    const alice = await member(seed, "Alice");
    const author = authorAddress();
    await storedItems(seed, 23, author);
    await addAuthorAlias(db(), seed.teamId, alice.id, author);

    const kicks = vi.fn();
    onAttributionRepairKick(kicks);
    try {
      const outcome = await repairAttributionNow(db(), seed.teamId, seed.teamSlug, { maxBatches: 2, batchSize: 5 });
      expect(outcome).toMatchObject({ status: "continuing", busy: false, partial: true, scanned: 10, updated: 10 });
      expect(kicks).toHaveBeenCalledTimes(1);
      expect(await authority(seed)).toMatchObject({
        repair_status: "running", items_scanned: 10, attempts: 0, last_error: null, deferred: false,
      });
      // The backstop takes its own bounded share and says so.
      expect(await drainPendingAttributionRepairs(db(), { maxBatchesPerTeam: 1, batchSize: 5 }))
        .toEqual({ attempted: 1, complete: 0, continuing: 1, failed: 0 });
      expect(await authority(seed)).toMatchObject({ repair_status: "running", items_scanned: 15, attempts: 0 });
      // A budget that is large enough simply finishes, and a finished revision is a no-op after.
      expect(await repairAttributionNow(db(), seed.teamId, seed.teamSlug, { maxBatches: 10, batchSize: 5 }))
        .toMatchObject({ status: "complete", busy: false, partial: false, scanned: 8 });
      kicks.mockClear();
      const done = await authority(seed);
      expect(await repairAttributionNow(db(), seed.teamId, seed.teamSlug, { maxBatches: 10, batchSize: 5 }))
        .toMatchObject({ status: "complete", scanned: 0, updated: 0 });
      expect(await runAttributionRepairTurn(db(), seed.teamId, seed.teamSlug))
        .toMatchObject({ status: "complete", summary: { scanned: 0, partial: false } });
      expect(await bootedScheduler(5).runRound()).toEqual(round({}));
      expect(await drainPendingAttributionRepairs(db())).toEqual({ attempted: 0, complete: 0, continuing: 0, failed: 0 });
      expect(await authority(seed)).toEqual(done);
      expect(kicks).not.toHaveBeenCalled();
    } finally {
      onAttributionRepairKick(null);
    }
    expect(await credited(seed, alice.id)).toBe(23);
  }, 60_000);

  it("REQUEST: the manual repair durably re-enqueues a complete revision before scanning — fenced, resumable, the same revision — and legacy rows are put right", async () => {
    const seed = await seedTeam();
    const alice = await member(seed, "Alice");
    const author = authorAddress();
    await storedItems(seed, 12, author);
    await addAuthorAlias(db(), seed.teamId, alice.id, author);
    expect(await repairAttributionNow(db(), seed.teamId, seed.teamSlug)).toMatchObject({ status: "complete", scanned: 12 });
    const completed = await authority(seed);
    const completedEpoch = await authorizationEpoch(db(), seed.teamId);
    expect(await fenced(seed)).toBe(false);

    // Rows that predate a rule: stored by a path that credited them wrongly, with no roster change
    // since to enqueue their repair. Nothing durable says they need one — which is exactly why the
    // manual repair exists, and why continuing entry points must leave a complete revision alone.
    await getPool().query(
      `update items set member_id=$2
        where id in (select id from items where team_id=$1 order by id limit 7)`, [seed.teamId, seed.memberId]);
    expect(await credited(seed, alice.id)).toBe(5);
    expect(await bootedScheduler(5).runRound()).toEqual(round({}));
    await expect(reconcileAttribution(db(), seed.teamId, seed.teamSlug)).resolves.toBeUndefined();
    expect(await authority(seed)).toEqual(completed);
    expect(await credited(seed, alice.id)).toBe(5);

    // The manual button's entry point, with a budget smaller than the team: the request is durable
    // at once — pending progress from the start, reads fenced — and it hands over mid-scan.
    const requested = await repairAttributionNow(db(), seed.teamId, seed.teamSlug, { maxBatches: 1, batchSize: 5, request: true });
    expect(requested).toMatchObject({ status: "continuing", busy: false, scanned: 5, revision: completed.revision });
    expect(await authority(seed)).toMatchObject({
      repair_status: "running", revision: completed.revision, items_scanned: 5, attempts: 0, last_error: null,
    });
    expect(await fenced(seed)).toBe(true);

    // A second request while that repair is in progress continues it; it does not start it again.
    const again = await repairAttributionNow(db(), seed.teamId, seed.teamSlug, { maxBatches: 1, batchSize: 5, request: true });
    expect(again).toMatchObject({ status: "continuing", scanned: 5 });
    expect(await authority(seed)).toMatchObject({ repair_status: "running", items_scanned: 10 });

    // The scheduler finishes it like any other durable repair, through the strict finalization.
    const rounds = await runUntilIdle(bootedScheduler(5));
    expect(rounds.reduce((n, summary) => n + summary.failed, 0)).toBe(0);
    expect(await authority(seed)).toMatchObject({
      repair_status: "complete", revision: completed.revision, items_scanned: 12, items_updated: 7, attempts: 0,
    });
    expect(await credited(seed, alice.id)).toBe(12);
    expect(await fenced(seed)).toBe(false);
    expect(await authorizationEpoch(db(), seed.teamId)).toBeGreaterThan(completedEpoch);

    // The direct form requests too, and on consistent rows a full rescan changes nothing.
    expect(await reattributeItems(db(), seed.teamId, { batchSize: 50 }))
      .toMatchObject({ turn: "scanned", scanned: 12, updated: 0, partial: false, revision: completed.revision });
    expect(await authority(seed)).toMatchObject({ repair_status: "awaiting_cache", items_scanned: 12, items_updated: 0 });
    expect(await repairAttributionNow(db(), seed.teamId, seed.teamSlug)).toMatchObject({ status: "complete" });
  }, 60_000);

  it("BEYOND THE OLD 5,000-ITEM CALLBACK BUDGET: the Admin hook hands over at its budget and the production scheduler converges the rest", async () => {
    const TOTAL = 5_200;
    const seed = await seedTeam();
    const alice = await member(seed, "Alice");
    const author = authorAddress();
    await storedItems(seed, TOTAL, author);
    await addAuthorAlias(db(), seed.teamId, alice.id, author);

    // The post-response hook, with its production budget and batch size. It used to be the whole
    // repair: when its budget ran out it threw, and the rest waited for the 30-minute chain.
    const kicks = vi.fn();
    onAttributionRepairKick(kicks);
    try {
      await expect(reconcileAttribution(db(), seed.teamId, seed.teamSlug)).resolves.toBeUndefined();
    } finally {
      onAttributionRepairKick(null);
    }
    const handedOver = await authority(seed);
    expect(handedOver).toMatchObject({
      repair_status: "running", items_scanned: 20 * REPAIR_TURN_BATCH, attempts: 0, last_error: null, deferred: false,
    });
    expect(handedOver.items_scanned).toBeLessThan(TOTAL);
    expect(kicks).toHaveBeenCalledTimes(1);
    expect(await fenced(seed)).toBe(true);

    // The scheduler with production defaults — no budget of its own to run out.
    const rounds = await runUntilIdle(bootedScheduler());
    expect(rounds.reduce((n, summary) => n + summary.failed + summary.busy + summary.deferred, 0)).toBe(0);
    // One batch per round: it took as many rounds as the remaining work, not a fixed allowance.
    expect(rounds.length).toBeGreaterThanOrEqual((TOTAL - handedOver.items_scanned) / REPAIR_TURN_BATCH);
    expect(await authority(seed)).toMatchObject({
      repair_status: "complete", revision: handedOver.revision, items_scanned: TOTAL, items_updated: TOTAL,
      attempts: 0, last_error: null,
    });
    expect(await credited(seed, alice.id)).toBe(TOTAL);
    expect(await credited(seed, null)).toBe(0);
    expect(await fenced(seed)).toBe(false);
  }, 300_000);
});
