import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { TransactionSession } from "@/lib/db/types";
import { transactionCapability } from "@/lib/projects/context/transaction";
import * as gateModule from "@/lib/ingest/slack-namespace-gate";
import {
  ensureBlockedSlackNamespaceGate,
  invalidateSlackNamespaceGate,
  lockReadySlackNamespaceGate,
} from "@/lib/ingest/slack-namespace-gate";
import { db, seedTeam, type Seed } from "./helpers";

/**
 * AIO-1170 — the per-(team, raw channel) NAMESPACE migration gate
 * (`slack_channel_migration_gates`), against real Postgres.
 *
 * WHAT THIS FILE PROVES, STATED AS ITS LIMIT. A gate can be created BLOCKED, invalidated
 * atomically, and locked/read without absence or stale readiness being mistaken for permission to
 * migrate or publish. It proves NOTHING about provenance: the migration/provenance producer that
 * would be entitled to set `ready` is not built, and this packet deliberately ships no application
 * path that can create a ready row. A locked capability here is namespace readiness ONLY — never
 * source authorization, channel permission, body completeness or permission to publish.
 *
 * The failure modes only a real database can show, and which this file exists to pin:
 *
 *  1. ABSENCE IS NOT READINESS, AND A FAILED READ IS NEITHER. A missing gate refuses and creates
 *     nothing; a poisoned session REJECTS rather than reporting "not ready" — the one outcome that
 *     would let a broken database read as a decision.
 *  2. THE ROW SHAPE IS ENFORCED BY THE DATABASE, not by the writer that happens to exist. Every
 *     partial `ready` shape (no ready revision, a stale one, no workspace, no completed repair id)
 *     is refused by an actual constraint, so a direct DB write cannot manufacture half a readiness.
 *  3. INVALIDATION IS ATOMIC AND SERIALIZED. Bumping the revision and clearing every readiness
 *     proof field happen in one statement on the locked row, so a competing reader can never be
 *     handed pre-invalidation readiness.
 *  4. THE PASSED SESSION IS THE CONNECTION. An invalidation inside a caller transaction that then
 *     rolls back leaves nothing behind — the proof these functions ran on the caller's bound
 *     connection, which is what lets the later publisher compose them into its own transaction.
 *
 * ⚠️ FIXTURE LABEL: `seedReady` below writes a structurally complete ready row in raw SQL. It
 * exercises READ/LOCK behavior only. It is NOT a verification of provenance, NOT an activation
 * path, and NOT a claim that any legacy row was migrated — an administrative direct DB write can
 * seed anything here, as everywhere else in a no-RLS schema. There is no publisher in this packet,
 * so there is deliberately no test here asserting that a legacy item was migrated or that duplicate
 * publication was prevented; those are later integration tests.
 */

const CHANNEL = "C0GATE001";
const OTHER_CHANNEL = "C0GATE002";
const WORKSPACE = "T0AIO1170";
const OTHER_WORKSPACE = "T0OTHERWS";

type Scope = { teamId: string; rawChannelId: string };

// ── raw SQL client ───────────────────────────────────────────────────────────
// A SEPARATE connection from the app pool: the rollback test is only meaningful if the readback
// cannot see the caller transaction's uncommitted work, and the constraint tests need SQLSTATE,
// which the adapter's `{ error: { message } }` envelope drops.

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
    ["slack_channel_migration_gates"]
  );
  if (rows.length !== 1) {
    // A reused per-worktree container is schema-loaded only when it is CREATED
    // (scripts/dm-isolated.sh), so one that predates this change silently lacks the table.
    throw new Error(
      "slack_channel_migration_gates missing from the test database. The dm container loads the " +
        "schema only when it is created — re-run with AIOS_DM_RESET=1 " +
        "npm run test:datamechanics:iso test/datamechanics/slack-namespace-gate.datamechanics.test.ts"
    );
  }
});

// ── fixtures ─────────────────────────────────────────────────────────────────

function scopeFor(seed: Seed, rawChannelId = CHANNEL): Scope {
  return { teamId: seed.teamId, rawChannelId };
}

/** One real transaction on the app's pool — the shape every production caller will compose with. */
function tx<T>(fn: (session: TransactionSession) => Promise<T>): Promise<T> {
  return transactionCapability(db()).transaction(fn);
}

type GateRow = Record<string, unknown>;

/** The WHOLE row, so an "unchanged" assertion compares every column, not the ones I thought of. */
async function row(scope: Scope): Promise<GateRow> {
  const c = await sql();
  const { rows } = await c.query<GateRow>(
    `select * from slack_channel_migration_gates where team_id = $1 and raw_channel_id = $2`,
    [scope.teamId, scope.rawChannelId]
  );
  if (rows.length !== 1) throw new Error(`expected exactly one row, found ${rows.length}`);
  return rows[0];
}

async function rowCount(teamId?: string): Promise<number> {
  const c = await sql();
  const { rows } = await c.query<{ c: string }>(
    teamId
      ? `select count(*)::text as c from slack_channel_migration_gates where team_id = $1`
      : `select count(*)::text as c from slack_channel_migration_gates`,
    teamId ? [teamId] : []
  );
  return Number(rows[0].c);
}

async function insertRaw(values: Record<string, unknown>): Promise<unknown> {
  const cols = Object.keys(values);
  const c = await sql();
  return c.query(
    `insert into slack_channel_migration_gates (${cols.join(", ")})
       values (${cols.map((_, i) => `$${i + 1}`).join(", ")})`,
    cols.map((k) => values[k])
  );
}

function baseRaw(seed: Seed, rawChannelId = CHANNEL): Record<string, unknown> {
  return { team_id: seed.teamId, raw_channel_id: rawChannelId };
}

/**
 * ⚠️ A STRUCTURALLY complete ready row, written directly in SQL. See the fixture label in the file
 * header: this is the READ/LOCK fixture and nothing else. No application path in this packet can
 * produce it, and its existence asserts nothing about whether any legacy row was actually resolved.
 */
async function seedReady(
  seed: Seed,
  over: { rawChannelId?: string; workspaces?: string[]; revision?: number } = {}
): Promise<{ repairId: string; revision: number }> {
  const repairId = randomUUID();
  const revision = over.revision ?? 0;
  await insertRaw({
    ...baseRaw(seed, over.rawChannelId ?? CHANNEL),
    state: "ready",
    revision,
    ready_revision: revision,
    resolved_workspace_ids: over.workspaces ?? [WORKSPACE],
    completed_repair_id: repairId,
  });
  return { repairId, revision };
}

async function refusal(p: Promise<unknown>): Promise<{ code: string; constraint?: string }> {
  try {
    await p;
  } catch (err) {
    const e = err as { code?: string; constraint?: string };
    return { code: e.code ?? `no-code: ${String(err)}`, constraint: e.constraint };
  }
  return { code: "no-error" };
}

function deferred<T = void>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

const lockArgs = (scope: Scope, over: Partial<{ workspaceId: string; expectedRevision: number }> = {}) => ({
  teamId: scope.teamId,
  rawChannelId: scope.rawChannelId,
  workspaceId: WORKSPACE,
  expectedRevision: 0,
  ...over,
});

// ── the slice's boundary, stated as the stored shape ─────────────────────────

describe("slack_channel_migration_gates — the columns this slice may own", () => {
  /**
   * Provider metadata, a history cursor and per-method reservations belong to the later
   * source-state packets. A column added here ahead of the producer that earns it is exactly the
   * placeholder that gets switched on by accident — and an empty/default channel row would prove
   * neither provider scope nor provenance.
   */
  it("stores a namespace gate, and nothing that could be mistaken for source state", async () => {
    const c = await sql();
    const { rows } = await c.query<{ column_name: string }>(
      `select column_name from information_schema.columns
        where table_schema = 'public' and table_name = 'slack_channel_migration_gates'
        order by column_name`
    );
    expect(rows.map((r) => r.column_name)).toEqual([
      "blocked_reason",
      "completed_repair_id",
      "created_at",
      "raw_channel_id",
      "ready_revision",
      "resolved_workspace_ids",
      "revision",
      "state",
      "team_id",
      "updated_at",
    ]);
  });

  /**
   * The absence of an activation path is the packet's central claim, so it is asserted rather than
   * asserted-in-prose: no `markReady`, no verified-boolean entry point, nothing that accepts a
   * caller's legacy-item list as proof. The capability constructor is module-private (its brand is
   * an unexported symbol), so a caller cannot mint one either.
   */
  it("exports no way to make a gate ready", async () => {
    const exported = Object.entries(gateModule)
      .filter(([, value]) => typeof value === "function")
      .map(([name]) => name)
      .sort();
    expect(exported).toEqual([
      "ensureBlockedSlackNamespaceGate",
      "invalidateSlackNamespaceGate",
      "lockReadySlackNamespaceGate",
    ]);
  });

  it("admits only blocked/ready, and refuses raw-channel syntax the namespace helper would not mint", async () => {
    const seed = await seedTeam();
    expect(await refusal(insertRaw({ ...baseRaw(seed), state: "migrating" }))).toMatchObject({
      code: "23514",
      constraint: "slack_channel_migration_gates_state_check",
    });
    for (const rawChannelId of ["", "C 1", "C1:X", "old-channel-name"]) {
      expect(await refusal(insertRaw(baseRaw(seed, rawChannelId)))).toMatchObject({ code: "23514" });
    }
    expect(await rowCount(seed.teamId)).toBe(0);
  });

  it("refuses every partial ready shape, and every readiness field on a blocked row", async () => {
    const seed = await seedTeam();
    const ready = { state: "ready", revision: 3 };
    const partial: Record<string, unknown>[] = [
      // ready, but no ready revision at all
      { ...ready, resolved_workspace_ids: [WORKSPACE], completed_repair_id: randomUUID() },
      // ready at a STALE revision — readiness that a later invalidation already outran
      {
        ...ready,
        ready_revision: 2,
        resolved_workspace_ids: [WORKSPACE],
        completed_repair_id: randomUUID(),
      },
      // ready with no resolved workspace: readiness that resolved nothing
      { ...ready, ready_revision: 3, resolved_workspace_ids: [], completed_repair_id: randomUUID() },
      // ready with no completed repair identity
      { ...ready, ready_revision: 3, resolved_workspace_ids: [WORKSPACE] },
      // blocked, carrying readiness proof fields anyway
      { ready_revision: 0 },
      { resolved_workspace_ids: [WORKSPACE] },
      { completed_repair_id: randomUUID() },
    ];
    for (const over of partial) {
      expect(await refusal(insertRaw({ ...baseRaw(seed), ...over }))).toMatchObject({
        code: "23514",
        constraint: "slack_channel_migration_gates_ready_codec",
      });
    }
    expect(await rowCount(seed.teamId)).toBe(0);

    // …and the complete shape IS accepted, so the seven refusals above are refusing the partiality
    // and not the fixture.
    await seedReady(seed);
    expect((await row(scopeFor(seed))).state).toBe("ready");
  });

  it("refuses a rewound revision, an unsanitized reason and a workspace set it could not have resolved", async () => {
    const seed = await seedTeam();
    await insertRaw(baseRaw(seed));
    const c = await sql();
    const set = (assignment: string) =>
      refusal(
        c.query(`update slack_channel_migration_gates set ${assignment} where team_id = $1`, [
          seed.teamId,
        ])
      );

    expect(await set("revision = -1")).toMatchObject({ code: "23514" });
    // A sanitized CATEGORY, never a provider message or a token — the same discipline as
    // `slack_sync_threads.last_error_code`, restated for this column because it is a storage rule.
    expect(await set("blocked_reason = 'invalid_auth: xoxb-1-2'")).toMatchObject({ code: "23514" });
    expect(await set("blocked_reason = ''")).toMatchObject({ code: "23514" });

    const other = await seedTeam();
    // Workspace ids are provider ids, not free text: a NULL element, a non-id element and a
    // multidimensional array are all refused, so `cardinality > 0` cannot be satisfied by junk.
    for (const workspaces of [
      "'{NULL}'::text[]",
      "'{\"T 1\"}'::text[]",
      "'{\"\"}'::text[]",
      "'{{T1},{T2}}'::text[]",
    ]) {
      expect(
        await refusal(
          c.query(
            `insert into slack_channel_migration_gates
               (team_id, raw_channel_id, state, revision, ready_revision,
                resolved_workspace_ids, completed_repair_id)
             values ($1, $2, 'ready', 0, 0, ${workspaces}, gen_random_uuid())`,
            [other.teamId, CHANNEL]
          )
        )
      ).toMatchObject({ code: "23514" });
    }
    expect(await rowCount(other.teamId)).toBe(0);
  });

  it("keeps one gate per team and raw channel", async () => {
    const seed = await seedTeam();
    await insertRaw(baseRaw(seed));
    expect(await refusal(insertRaw(baseRaw(seed)))).toMatchObject({ code: "23505" });
    await insertRaw(baseRaw(seed, OTHER_CHANNEL));
    expect(await rowCount(seed.teamId)).toBe(2);
  });
});

// ── ensure ───────────────────────────────────────────────────────────────────

describe("ensure — creates blocked, and can never revoke, reset or promote", () => {
  it("creates exactly one blocked gate with no readiness of any kind", async () => {
    const seed = await seedTeam();
    const scope = scopeFor(seed);

    const state = await tx((s) => ensureBlockedSlackNamespaceGate(s, scope));

    expect(state).toMatchObject({
      scope,
      state: "blocked",
      revision: 0,
      readyRevision: null,
      resolvedWorkspaceIds: [],
      completedRepairId: null,
      blockedReason: null,
    });
    // The default is not a readiness: the row it just created cannot be locked.
    expect(await tx((s) => lockReadySlackNamespaceGate(s, lockArgs(scope)))).toEqual({
      outcome: "refused",
    });
    expect(await rowCount(seed.teamId)).toBe(1);
  });

  it("preserves an existing row's revision, state and every proof field", async () => {
    const seed = await seedTeam();
    const scope = scopeFor(seed);
    const { repairId } = await seedReady(seed, { revision: 4 });
    const before = await row(scope);

    const first = await tx((s) => ensureBlockedSlackNamespaceGate(s, scope));
    const second = await tx((s) => ensureBlockedSlackNamespaceGate(s, scope));

    // It REPORTS the current state — that is a read, not a capability — and it changes nothing.
    expect(first).toMatchObject({
      state: "ready",
      revision: 4,
      readyRevision: 4,
      resolvedWorkspaceIds: [WORKSPACE],
      completedRepairId: repairId,
    });
    expect(second).toEqual(first);
    expect(await row(scope)).toEqual(before);
    expect(await rowCount(seed.teamId)).toBe(1);
  });

  it("does not touch another team's or another channel's gate", async () => {
    const seed = await seedTeam();
    const other = await seedTeam();
    await seedReady(other);
    await seedReady(seed, { rawChannelId: OTHER_CHANNEL });
    const otherBefore = await row(scopeFor(other));
    const siblingBefore = await row(scopeFor(seed, OTHER_CHANNEL));

    await tx((s) => ensureBlockedSlackNamespaceGate(s, scopeFor(seed)));
    await tx((s) => invalidateSlackNamespaceGate(s, scopeFor(seed), "workspace_changed"));

    expect(await row(scopeFor(other))).toEqual(otherBefore);
    expect(await row(scopeFor(seed, OTHER_CHANNEL))).toEqual(siblingBefore);
    expect(await rowCount(other.teamId)).toBe(1);
  });

  it("rejects a scope the namespace helper would refuse, without writing anything", async () => {
    const seed = await seedTeam();
    for (const rawChannelId of ["", "C 1", "old-channel-name"]) {
      await expect(
        tx((s) => ensureBlockedSlackNamespaceGate(s, { teamId: seed.teamId, rawChannelId }))
      ).rejects.toThrow(TypeError);
    }
    await expect(
      tx((s) => ensureBlockedSlackNamespaceGate(s, { teamId: "not-a-uuid", rawChannelId: CHANNEL }))
    ).rejects.toThrow(TypeError);
    expect(await rowCount()).toBe(0);
  });

  it("reports a SQL failure as a rejection, never as an absent or blocked gate", async () => {
    const seed = await seedTeam();
    const scope = scopeFor(seed);
    await seedReady(seed);

    // A poisoned transaction: every later statement fails with 25P02. A `catch → return null/blocked`
    // anywhere in these paths would make a broken database indistinguishable from a decision.
    const inner: { returned?: unknown; threw?: unknown }[] = [];
    await tx(async (session) => {
      await session.executeSql("select 1 / 0").catch(() => {});
      for (const operation of [
        () => ensureBlockedSlackNamespaceGate(session, scope),
        () => lockReadySlackNamespaceGate(session, lockArgs(scope)),
        () => invalidateSlackNamespaceGate(session, scope, "probe"),
      ]) {
        try {
          inner.push({ returned: await operation() });
        } catch (err) {
          inner.push({ threw: err });
        }
      }
      throw new Error("rollback");
    }).catch(() => {});

    expect(inner).toHaveLength(3);
    for (const outcome of inner) {
      expect(outcome.threw).toBeDefined();
      expect("returned" in outcome).toBe(false);
    }
    // The ready fixture is untouched: nothing was written, and nothing was reported.
    expect((await row(scope)).state).toBe("ready");
  });
});

// ── lock / read ──────────────────────────────────────────────────────────────

describe("lock — a namespace capability, or a refusal; never an absence read as permission", () => {
  it("refuses a missing gate and creates no row", async () => {
    const seed = await seedTeam();
    const scope = scopeFor(seed);

    expect(await tx((s) => lockReadySlackNamespaceGate(s, lockArgs(scope)))).toEqual({
      outcome: "refused",
    });
    expect(await rowCount(seed.teamId)).toBe(0);
  });

  it("accepts the included workspace at the current revision", async () => {
    const seed = await seedTeam();
    const scope = scopeFor(seed);
    await seedReady(seed, { workspaces: [WORKSPACE, OTHER_WORKSPACE], revision: 2 });
    const before = await row(scope);

    const result = await tx((s) =>
      lockReadySlackNamespaceGate(s, lockArgs(scope, { expectedRevision: 2 }))
    );

    expect(result.outcome).toBe("locked");
    if (result.outcome !== "locked") throw new Error("unreachable");
    expect(result.lock.scope).toEqual(scope);
    expect(result.lock.workspaceId).toBe(WORKSPACE);
    expect(result.lock.revision).toBe(2);
    // A read that locks is still a read: nothing about the gate moved.
    expect(await row(scope)).toEqual(before);

    // The second listed workspace is equally included — the set is the producer's output, and the
    // lock does not silently pick the first entry.
    const second = await tx((s) =>
      lockReadySlackNamespaceGate(
        s,
        lockArgs(scope, { workspaceId: OTHER_WORKSPACE, expectedRevision: 2 })
      )
    );
    expect(second.outcome).toBe("locked");
  });

  it("refuses another team, another channel, another workspace and another revision", async () => {
    const seed = await seedTeam();
    const other = await seedTeam();
    const scope = scopeFor(seed);
    await seedReady(seed, { revision: 2 });
    // A REAL ready row for the same raw channel under another team: a cross-team read would
    // otherwise be invisible against an empty table.
    await seedReady(other, { revision: 2 });
    await seedReady(seed, { rawChannelId: OTHER_CHANNEL, revision: 2 });
    const before = await row(scope);

    const denied = [
      lockArgs({ teamId: other.teamId, rawChannelId: CHANNEL }, { expectedRevision: 3 }),
      lockArgs(scope, { workspaceId: OTHER_WORKSPACE, expectedRevision: 2 }),
      lockArgs(scope, { expectedRevision: 1 }),
      lockArgs(scope, { expectedRevision: 3 }),
      lockArgs(scope, { expectedRevision: 0 }),
    ];
    for (const args of denied) {
      expect(await tx((s) => lockReadySlackNamespaceGate(s, args))).toEqual({ outcome: "refused" });
    }
    // …and a channel this team has never resolved is refused even though its SIBLING is ready.
    expect(
      await tx((s) =>
        lockReadySlackNamespaceGate(
          s,
          lockArgs(scopeFor(seed, "C0NEVER01"), { expectedRevision: 2 })
        )
      )
    ).toEqual({ outcome: "refused" });
    expect(await row(scope)).toEqual(before);
    expect(await rowCount(seed.teamId)).toBe(2);
  });

  it("refuses a blocked gate at its own current revision", async () => {
    const seed = await seedTeam();
    const scope = scopeFor(seed);
    await tx((s) => ensureBlockedSlackNamespaceGate(s, scope));
    await tx((s) => invalidateSlackNamespaceGate(s, scope, "workspace_changed"));

    // Reading the row's own revision back and offering it is not readiness: `state` decides.
    for (const expectedRevision of [0, 1]) {
      expect(
        await tx((s) => lockReadySlackNamespaceGate(s, lockArgs(scope, { expectedRevision })))
      ).toEqual({ outcome: "refused" });
    }
  });

  it("rejects a malformed workspace or revision rather than refusing it", async () => {
    const seed = await seedTeam();
    const scope = scopeFor(seed);
    await seedReady(seed);
    const before = await row(scope);

    // A validation failure is a caller BUG, not a gate decision — reporting it as `refused` would
    // hide a broken call site behind the same value a correctly blocked channel produces.
    for (const workspaceId of ["", "T 1", "T1:X"]) {
      await expect(
        tx((s) => lockReadySlackNamespaceGate(s, lockArgs(scope, { workspaceId })))
      ).rejects.toThrow(TypeError);
    }
    for (const expectedRevision of [-1, 1.5, Number.NaN]) {
      await expect(
        tx((s) => lockReadySlackNamespaceGate(s, lockArgs(scope, { expectedRevision })))
      ).rejects.toThrow(TypeError);
    }
    expect(await row(scope)).toEqual(before);
  });

  it("refuses a stored row whose ready shape the codec cannot trust", async () => {
    const seed = await seedTeam();
    const scope = scopeFor(seed);
    await seedReady(seed);
    const c = await sql();
    // The DB constraint is dropped for this fixture ONLY, to manufacture the state a future
    // constraint change — or a hand-repaired production row — could leave behind. The app codec is
    // the second reading of the same rule; a row it cannot trust is an ERROR, never a quiet
    // "ready". The definition is READ BACK and restored verbatim rather than retyped here: a copy
    // of the rule in this file would keep restoring the OLD rule the day schema.sql changes it.
    const name = "slack_channel_migration_gates_ready_codec";
    const { rows } = await c.query<{ def: string }>(
      `select pg_get_constraintdef(oid) as def from pg_constraint
        where conname = $1 and conrelid = 'slack_channel_migration_gates'::regclass`,
      [name]
    );
    expect(rows).toHaveLength(1);
    await c.query(`alter table slack_channel_migration_gates drop constraint ${name}`);
    try {
      await c.query(
        `update slack_channel_migration_gates set ready_revision = null where team_id = $1`,
        [seed.teamId]
      );
      await expect(tx((s) => lockReadySlackNamespaceGate(s, lockArgs(scope)))).rejects.toThrow(
        TypeError
      );
      await expect(tx((s) => ensureBlockedSlackNamespaceGate(s, scope))).rejects.toThrow(TypeError);
    } finally {
      await c.query(`delete from slack_channel_migration_gates where team_id = $1`, [seed.teamId]);
      await c.query(
        `alter table slack_channel_migration_gates add constraint ${name} ${rows[0].def}`
      );
    }
    // Negative control: the restored constraint still refuses the shape the fixture created, so a
    // later test in this file cannot pass against a table this one silently left unguarded.
    expect(
      await refusal(
        insertRaw({
          ...baseRaw(seed),
          state: "ready",
          resolved_workspace_ids: [WORKSPACE],
          completed_repair_id: randomUUID(),
        })
      )
    ).toMatchObject({ code: "23514", constraint: name });
  });
});

// ── invalidate ───────────────────────────────────────────────────────────────

describe("invalidate — one atomic step from readiness to blocked", () => {
  it("bumps the revision and clears every readiness proof field", async () => {
    const seed = await seedTeam();
    const scope = scopeFor(seed);
    await seedReady(seed, { revision: 7 });

    const state = await tx((s) => invalidateSlackNamespaceGate(s, scope, "workspace_changed"));

    expect(state).toMatchObject({
      scope,
      state: "blocked",
      revision: 8,
      readyRevision: null,
      resolvedWorkspaceIds: [],
      completedRepairId: null,
      blockedReason: "workspace_changed",
    });
    const stored = await row(scope);
    expect(stored.revision).toBe("8");
    expect(stored.ready_revision).toBeNull();
    expect(stored.resolved_workspace_ids).toEqual([]);
    expect(stored.completed_repair_id).toBeNull();
    expect(stored.state).toBe("blocked");

    // The readiness the caller was holding is gone, at the old revision AND at the new one.
    for (const expectedRevision of [7, 8]) {
      expect(
        await tx((s) => lockReadySlackNamespaceGate(s, lockArgs(scope, { expectedRevision })))
      ).toEqual({ outcome: "refused" });
    }
  });

  it("creates a blocked gate when there is none, and stays monotonic across repeats", async () => {
    const seed = await seedTeam();
    const scope = scopeFor(seed);

    const created = await tx((s) => invalidateSlackNamespaceGate(s, scope, "unknown_provenance"));
    expect(created).toMatchObject({ state: "blocked", revision: 0 });

    const again = await tx((s) => invalidateSlackNamespaceGate(s, scope, "conflicting_row"));
    expect(again.revision).toBe(1);
    expect(again.blockedReason).toBe("conflicting_row");
    expect(await rowCount(seed.teamId)).toBe(1);
  });

  it("invalidates readiness a NEW revision then restores — and the old expectation stays invalid", async () => {
    const seed = await seedTeam();
    const scope = scopeFor(seed);
    await seedReady(seed, { revision: 0 });
    await tx((s) => invalidateSlackNamespaceGate(s, scope, "workspace_changed"));

    // A later fixture models what the (unbuilt) producer would eventually write: readiness AT the
    // current revision. Fixture only — it verifies no provenance and activates nothing.
    const c = await sql();
    await c.query(
      `update slack_channel_migration_gates
          set state = 'ready', ready_revision = revision, blocked_reason = null,
              resolved_workspace_ids = $2, completed_repair_id = gen_random_uuid()
        where team_id = $1`,
      [seed.teamId, [WORKSPACE]]
    );

    expect(await tx((s) => lockReadySlackNamespaceGate(s, lockArgs(scope)))).toEqual({
      outcome: "refused",
    });
    expect(
      await tx((s) => lockReadySlackNamespaceGate(s, lockArgs(scope, { expectedRevision: 1 })))
    ).toMatchObject({ outcome: "locked" });
  });

  it("refuses an unsanitized reason before touching the row", async () => {
    const seed = await seedTeam();
    const scope = scopeFor(seed);
    await seedReady(seed);
    const before = await row(scope);

    // Synthetic, but shaped like the thing this rule exists for: a provider error carrying a token.
    const leaky = "invalid_auth: xoxb-1-2";
    let thrown: unknown;
    try {
      await tx((s) => invalidateSlackNamespaceGate(s, scope, leaky));
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(TypeError);
    // The rejected value is the hazard: a message that quoted it would copy the token into every
    // log that records the throw, which is exactly what the sanitized category prevents.
    expect(String(thrown)).not.toContain("xoxb-1-2");
    for (const reason of ["", "Workspace Changed", "x".repeat(41), null, undefined]) {
      await expect(
        tx((s) => invalidateSlackNamespaceGate(s, scope, reason as unknown as string))
      ).rejects.toThrow(TypeError);
    }
    expect(await row(scope)).toEqual(before);
  });

  it("uses the caller's session: a rolled-back invalidation leaves the gate as it was", async () => {
    const seed = await seedTeam();
    const scope = scopeFor(seed);
    await seedReady(seed, { revision: 2 });
    const before = await row(scope);

    // Captured, not asserted inside the callback: an assertion that throws in there would be
    // swallowed by the rollback catch, and the test would pass having checked nothing.
    let inTransaction: unknown;
    await tx(async (session) => {
      inTransaction = await invalidateSlackNamespaceGate(session, scope, "workspace_changed");
      throw new Error("rollback");
    }).catch(() => {});
    expect(inTransaction).toMatchObject({ state: "blocked", revision: 3 });

    // Read on the SEPARATE raw connection: had the module reached for the process-wide pool, this
    // write would have committed on its own connection and survived the caller's rollback.
    expect(await row(scope)).toEqual(before);
    expect((await row(scope)).state).toBe("ready");
  });

  it("cannot hand pre-invalidation readiness to a competing session", async () => {
    const seed = await seedTeam();
    const scope = scopeFor(seed);
    await seedReady(seed, { revision: 0 });

    const invalidated = deferred();
    const readerStarted = deferred();

    const writer = tx(async (session) => {
      const state = await invalidateSlackNamespaceGate(session, scope, "workspace_changed");
      invalidated.resolve();
      // Hold the transaction open until the reader is committed to its attempt. The reader signals
      // BEFORE issuing its statement, so the writer can always commit and neither side can wedge.
      await readerStarted.promise;
      return state;
    });

    const reader = (async () => {
      await invalidated.promise;
      return tx(async (session) => {
        readerStarted.resolve();
        // Ordinarily this blocks on the row lock until the writer commits. If it instead runs after
        // the commit, it reads the invalidated row directly — the assertion below holds either way,
        // and there is no interleaving in which pre-invalidation readiness is returned.
        return lockReadySlackNamespaceGate(session, lockArgs(scope));
      });
    })();

    const [written, read] = await Promise.all([writer, reader]);

    expect(written.revision).toBe(1);
    expect(read).toEqual({ outcome: "refused" });
    const stored = await row(scope);
    expect(stored.state).toBe("blocked");
    expect(stored.revision).toBe("1");
    expect(stored.ready_revision).toBeNull();
    expect(stored.resolved_workspace_ids).toEqual([]);
  });

  it("serializes two concurrent invalidations into two revisions", async () => {
    const seed = await seedTeam();
    const scope = scopeFor(seed);
    await seedReady(seed, { revision: 0 });

    const both = await Promise.all([
      tx((s) => invalidateSlackNamespaceGate(s, scope, "workspace_changed")),
      tx((s) => invalidateSlackNamespaceGate(s, scope, "conflicting_row")),
    ]);

    // Revision is what a later publisher pins its work to, so a lost update here would let one
    // caller's expectation survive another caller's invalidation.
    expect(both.map((r) => r.revision).sort()).toEqual([1, 2]);
    expect((await row(scope)).revision).toBe("2");
    expect(await rowCount(seed.teamId)).toBe(1);
  });
});
