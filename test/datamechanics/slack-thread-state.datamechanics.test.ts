import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { TransactionSession } from "@/lib/db/types";
import { transactionCapability } from "@/lib/projects/context/transaction";
import {
  checkpointSlackThread,
  claimSlackThread,
  enqueueSlackThread,
  releaseSlackThreadForRetry,
  type SlackThreadClaim,
  type SlackThreadScope,
} from "@/lib/ingest/slack-thread-state";
import { db, ingest, seedTeam, type Seed } from "./helpers";

/**
 * AIO-1170 — durable Slack pending-thread state (`slack_sync_threads`) and its lease/fence
 * primitives, against real Postgres.
 *
 * NOTHING SCHEDULES OR PUBLISHES YET. This slice owns pending WORK and nothing else: a lease here
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

beforeAll(async () => {
  const c = await sql();
  const { rows } = await c.query<{ tablename: string }>(
    `select tablename from pg_tables where schemaname = 'public' and tablename = $1`,
    ["slack_sync_threads"]
  );
  if (rows.length !== 1) {
    // A reused per-worktree container is schema-loaded only when it is CREATED
    // (scripts/dm-isolated.sh), so one that predates this change silently lacks the table.
    throw new Error(
      "slack_sync_threads missing from the test database. The dm container loads the schema only " +
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
    await expect(
      tx((s) =>
        releaseSlackThreadForRetry(s, live, {
          nextDueAt: new Date(),
          errorCode: "invalid_auth: xoxb-1-2",
        })
      )
    ).rejects.toThrow(/error/i);

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
