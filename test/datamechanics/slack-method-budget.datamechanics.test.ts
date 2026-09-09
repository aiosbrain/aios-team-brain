import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { TransactionSession } from "@/lib/db/types";
import { transactionCapability } from "@/lib/projects/context/transaction";
import {
  extendSlackMethodBackoff,
  reserveSlackMethodSlot,
  SLACK_BACKOFF_FLOOR_MS,
  SLACK_UNKNOWN_CATEGORY_INTERVAL_MS,
  SLACK_UNKNOWN_CATEGORY_PAGE_LIMIT,
  type SlackBudgetedMethod,
  type SlackMethodScope,
} from "@/lib/ingest/slack-method-budget";
import { slackReservedRequest } from "@/lib/ingest/sources/slack-page-request";
import { db, seedTeam, type Seed } from "./helpers";

/**
 * AIO-1170 — the durable per-method REQUEST RESERVATION (`slack_method_budgets`) and the one-request
 * transport that depends on it, against real Postgres.
 *
 * WHAT THIS FILE PROVES, STATED AS ITS LIMIT. That a request slot can be granted at most once across
 * independent connections, that the scopes which share an allowance do share it and the ones that
 * must not do not, and that a provider cooldown is persisted before the transport reports one. It
 * proves NOTHING about authorization, workspace provenance, app-identity binding or whether any
 * response may be stored: nothing here binds an app, writes a config, or publishes an item, and the
 * bootstrap fixtures below are response-shape contracts for a writer that does not exist yet.
 *
 * The failure modes only a real database (and a real second connection) can show:
 *
 *  1. TWO PROCESSES, ONE SLOT. The reservation is a conditional `UPDATE` whose `WHERE` re-evaluates
 *     after the row lock, so a loser's re-check runs against the winner's COMMITTED value. An
 *     in-memory fake would happily grant both and look identical from the call site.
 *  2. THE KEY IS THE ALLOWANCE. Slack meters per app+workspace+method; a key that admitted a token
 *     or a channel would multiply the allowance silently, and the only symptom would be provider
 *     429s in production. So sharing is asserted as directly as separation is.
 *  3. A DENIAL IS NOT A FAILURE, AND A FAILURE IS NOT A DENIAL. A poisoned session REJECTS rather
 *     than reporting `deferred` — the one outcome that would let a broken database read as "wait".
 *  4. THE RESERVATION IS DURABLE BEFORE THE REQUEST GOES OUT. Asserted from INSIDE the injected
 *     fetch, on a connection outside the app pool: if the reservation were still uncommitted, that
 *     connection could not see it. Nothing about elapsed time is accepted in its place.
 *
 * ⚠️ FIXTURE LABEL: `rewind` below moves a stored deadline backwards in raw SQL to represent elapsed
 * time. It is a CLOCK fixture, never a refund path — no application code may move a deadline nearer,
 * and the tests that matter assert exactly that.
 */

const WORKSPACE = "T0BUDGET1";
const OTHER_WORKSPACE = "T0BUDGET2";
const APP = "A0BUDGET1";
const OTHER_APP = "A0BUDGET2";
const BOT_TOKEN = "xoxb-synthetic-not-a-real-token";

// ── raw SQL client ───────────────────────────────────────────────────────────
// A SEPARATE connection from the app pool: the rollback and commit-ordering tests are only
// meaningful if the readback cannot see uncommitted work, and the constraint tests need SQLSTATE,
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
    ["slack_method_budgets"]
  );
  if (rows.length !== 1) {
    // A reused per-worktree container is schema-loaded only when it is CREATED
    // (scripts/dm-isolated.sh), so one that predates this change silently lacks the table.
    throw new Error(
      "slack_method_budgets missing from the test database. The dm container loads the schema only " +
        "when it is created — re-run with AIOS_DM_RESET=1 " +
        "npm run test:datamechanics:iso test/datamechanics/slack-method-budget.datamechanics.test.ts"
    );
  }
});

// ── fixtures ─────────────────────────────────────────────────────────────────

/** One real transaction on the app's pool — the shape every production caller will compose with. */
function tx<T>(fn: (session: TransactionSession) => Promise<T>): Promise<T> {
  return transactionCapability(db()).transaction(fn);
}

function verified(seed: Seed, over: { workspaceId?: string; appId?: string } = {}): SlackMethodScope {
  return {
    kind: "verified",
    teamId: seed.teamId,
    workspaceId: over.workspaceId ?? WORKSPACE,
    appId: over.appId ?? APP,
  };
}

function bootstrap(seed: Seed, workspaceId = WORKSPACE): SlackMethodScope {
  return { kind: "workspace_bootstrap", teamId: seed.teamId, workspaceId };
}

/** A real `integrations` row, because the provisional scope carries its FK. */
async function seedIntegration(seed: Seed): Promise<string> {
  const c = await sql();
  const { rows } = await c.query<{ id: string }>(
    `insert into integrations (team_id, type, name) values ($1, 'slack', $2) returning id`,
    [seed.teamId, `slack-${randomUUID().slice(0, 8)}`]
  );
  return rows[0].id;
}

type BudgetRow = Record<string, unknown>;

/** The WHOLE row, so an "unchanged" assertion compares every column, not the ones I thought of. */
async function rowOf(scope: SlackMethodScope, method: SlackBudgetedMethod): Promise<BudgetRow> {
  const c = await sql();
  const { rows } = await c.query<BudgetRow>(
    `select * from slack_method_budgets
      where team_id = $1 and scope_kind = $2 and method = $3
        and workspace_id is not distinct from $4
        and app_id is not distinct from $5
        and integration_id is not distinct from $6::uuid`,
    [
      scope.teamId,
      scope.kind,
      method,
      scope.kind === "provisional" ? null : scope.workspaceId,
      scope.kind === "verified" ? scope.appId : null,
      scope.kind === "provisional" ? scope.integrationId : null,
    ]
  );
  if (rows.length !== 1) throw new Error(`expected exactly one bucket, found ${rows.length}`);
  return rows[0];
}

async function rowCount(teamId?: string): Promise<number> {
  const c = await sql();
  const { rows } = await c.query<{ c: string }>(
    teamId
      ? `select count(*)::text as c from slack_method_budgets where team_id = $1`
      : `select count(*)::text as c from slack_method_budgets`,
    teamId ? [teamId] : []
  );
  return Number(rows[0].c);
}

/**
 * ⚠️ CLOCK FIXTURE. Move a stored deadline BACKWARDS to represent elapsed time — the alternative is
 * sleeping through a 60-second interval in a test suite. It is raw SQL precisely because no
 * application path may do this: a slot is never refunded, and every code-level attempt to move a
 * deadline nearer is asserted to fail elsewhere in this file.
 */
async function rewind(scope: SlackMethodScope, method: SlackBudgetedMethod, ms: number): Promise<void> {
  const c = await sql();
  await c.query(
    `update slack_method_budgets
        set next_permitted_at = next_permitted_at - ($2::double precision * interval '1 millisecond')
      where id = $1`,
    [(await rowOf(scope, method)).id, ms]
  );
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

async function insertRaw(values: Record<string, unknown>): Promise<unknown> {
  const cols = Object.keys(values);
  const c = await sql();
  return c.query(
    `insert into slack_method_budgets (${cols.join(", ")})
       values (${cols.map((_, i) => `$${i + 1}`).join(", ")})`,
    cols.map((k) => values[k])
  );
}

/** A two-party gate, so both connections are demonstrably in flight when they race for one slot. */
function barrier(parties: number): () => Promise<void> {
  let arrived = 0;
  let open!: () => void;
  const gate = new Promise<void>((resolve) => {
    open = resolve;
  });
  return async () => {
    arrived += 1;
    if (arrived >= parties) open();
    await gate;
  };
}

// ── the slice's boundary, stated as the stored shape ─────────────────────────

describe("slack_method_budgets — the columns this slice may own", () => {
  /**
   * THE KEY IS THE ALLOWANCE, so the column list is the contract. A token column or a channel column
   * would each split one provider bucket into many — the exact allowance multiplier the scope design
   * exists to prevent — and neither would be visible from any call site until Slack started
   * refusing. Page cursors, response payloads and lease state belong to other tables.
   */
  it("stores a reservation clock, and nothing that could multiply an allowance", async () => {
    const c = await sql();
    const { rows } = await c.query<{ column_name: string }>(
      `select column_name from information_schema.columns
        where table_schema = 'public' and table_name = 'slack_method_budgets'
        order by column_name`
    );
    expect(rows.map((r) => r.column_name)).toEqual([
      "app_id",
      "created_at",
      "id",
      "integration_id",
      "method",
      "next_permitted_at",
      "scope_kind",
      "team_id",
      "updated_at",
      "workspace_id",
    ]);
  });

  it("refuses every mixed or incomplete scope shape", async () => {
    const seed = await seedTeam();
    const integrationId = await seedIntegration(seed);
    const base = { team_id: seed.teamId, method: "auth.test" };
    const mixed: Record<string, unknown>[] = [
      // verified, missing half its key
      { ...base, scope_kind: "verified", workspace_id: WORKSPACE },
      { ...base, scope_kind: "verified", app_id: APP },
      // verified, carrying an integration as well — two keys, and no reader could say which wins
      { ...base, scope_kind: "verified", workspace_id: WORKSPACE, app_id: APP, integration_id: integrationId },
      // provisional, carrying provider identity it does not have yet
      { ...base, scope_kind: "provisional", integration_id: integrationId, workspace_id: WORKSPACE },
      { ...base, scope_kind: "provisional" },
      // bootstrap, with an app id — the synthetic-app shape the design refuses by name
      { ...base, scope_kind: "workspace_bootstrap", method: "bots.info", workspace_id: WORKSPACE, app_id: APP },
      { ...base, scope_kind: "workspace_bootstrap", method: "bots.info" },
    ];
    for (const values of mixed) {
      expect(await refusal(insertRaw(values))).toMatchObject({
        code: "23514",
        constraint: "slack_method_budgets_scope_codec",
      });
    }
    expect(await rowCount(seed.teamId)).toBe(0);

    // …and each complete shape IS accepted, so the seven refusals refuse the partiality, not the
    // fixture.
    await insertRaw({ ...base, scope_kind: "verified", workspace_id: WORKSPACE, app_id: APP });
    await insertRaw({ ...base, scope_kind: "provisional", integration_id: integrationId });
    await insertRaw({
      team_id: seed.teamId,
      method: "bots.info",
      scope_kind: "workspace_bootstrap",
      workspace_id: WORKSPACE,
    });
    expect(await rowCount(seed.teamId)).toBe(3);
  });

  /**
   * The narrow scopes exist for ONE bootstrap call each. Storage states that rule too, because app
   * validation is not a guarantee about what is in the table — and a `conversations.history` row
   * under a provisional scope would be a read budget for an unverified identity.
   */
  it("refuses every method a narrow scope may not budget, at the database", async () => {
    const seed = await seedTeam();
    const integrationId = await seedIntegration(seed);
    for (const method of ["bots.info", "conversations.history", "users.list"]) {
      expect(
        await refusal(
          insertRaw({ team_id: seed.teamId, scope_kind: "provisional", integration_id: integrationId, method })
        )
      ).toMatchObject({ code: "23514", constraint: "slack_method_budgets_method_scope" });
    }
    for (const method of ["auth.test", "conversations.replies", "users.list"]) {
      expect(
        await refusal(
          insertRaw({
            team_id: seed.teamId,
            scope_kind: "workspace_bootstrap",
            workspace_id: WORKSPACE,
            method,
          })
        )
      ).toMatchObject({ code: "23514", constraint: "slack_method_budgets_method_scope" });
    }
    // An unsupported method has no budget under ANY scope, including the verified one.
    expect(
      await refusal(
        insertRaw({
          team_id: seed.teamId,
          scope_kind: "verified",
          workspace_id: WORKSPACE,
          app_id: APP,
          method: "chat.postMessage",
        })
      )
    ).toMatchObject({ code: "23514" });
    expect(await rowCount(seed.teamId)).toBe(0);
  });

  it("keeps one bucket per scope and method", async () => {
    const seed = await seedTeam();
    const verifiedRow = {
      team_id: seed.teamId,
      scope_kind: "verified",
      workspace_id: WORKSPACE,
      app_id: APP,
      method: "conversations.history",
    };
    await insertRaw(verifiedRow);
    expect(await refusal(insertRaw(verifiedRow))).toMatchObject({ code: "23505" });
    await insertRaw({ ...verifiedRow, method: "conversations.replies" });
    await insertRaw({ ...verifiedRow, app_id: OTHER_APP });
    expect(await rowCount(seed.teamId)).toBe(3);
  });
});

// ── reserve ──────────────────────────────────────────────────────────────────

describe("reserve — one slot, once, decided by the database", () => {
  it("grants a fresh bucket and persists the next permitted time", async () => {
    const seed = await seedTeam();
    const scope = verified(seed);

    const first = await tx((s) => reserveSlackMethodSlot(s, scope, "conversations.history"));

    expect(first.outcome).toBe("granted");
    if (first.outcome !== "granted") throw new Error("unreachable");
    const stored = await rowOf(scope, "conversations.history");
    expect(new Date(stored.next_permitted_at as string).toISOString()).toBe(first.nextPermittedAt);
    // The interval is the conservative unknown-category budget, measured from the DB's own clock.
    const ahead = new Date(first.nextPermittedAt).getTime() - Date.now();
    expect(ahead).toBeGreaterThan(SLACK_UNKNOWN_CATEGORY_INTERVAL_MS / 2);
    expect(await rowCount(seed.teamId)).toBe(1);
  });

  /**
   * TWO INDEPENDENT CONNECTIONS, ONE SLOT. Both transactions are held at a barrier until both are
   * bound, so the reservations are genuinely in flight together rather than accidentally serial —
   * the schedule on which a broken implementation grants twice.
   */
  it("grants exactly one slot to simultaneous independent-connection reservations", async () => {
    const seed = await seedTeam();
    const scope = verified(seed);
    const arrive = barrier(2);

    const both = await Promise.all([
      tx(async (s) => {
        await s.executeSql("select 1");
        await arrive();
        return reserveSlackMethodSlot(s, scope, "conversations.history");
      }),
      tx(async (s) => {
        await s.executeSql("select 1");
        await arrive();
        return reserveSlackMethodSlot(s, scope, "conversations.history");
      }),
    ]);

    expect(both.map((r) => r.outcome).sort()).toEqual(["deferred", "granted"]);
    const granted = both.find((r) => r.outcome === "granted");
    const deferred = both.find((r) => r.outcome === "deferred");
    if (granted?.outcome !== "granted" || deferred?.outcome !== "deferred") {
      throw new Error("unreachable");
    }
    // The loser sees the WINNER's deadline: it re-checked against committed state, and did not book
    // a second, later slot of its own.
    expect(deferred.nextPermittedAt).toBe(granted.nextPermittedAt);
    expect(deferred.retryAfterMs).toBeGreaterThan(0);
    expect(await rowCount(seed.teamId)).toBe(1);
  });

  it("defers an immediate repeat without moving the deadline, and grants again once it has passed", async () => {
    const seed = await seedTeam();
    const scope = verified(seed);

    const first = await tx((s) => reserveSlackMethodSlot(s, scope, "conversations.replies"));
    const before = await rowOf(scope, "conversations.replies");
    const second = await tx((s) => reserveSlackMethodSlot(s, scope, "conversations.replies"));
    const third = await tx((s) => reserveSlackMethodSlot(s, scope, "conversations.replies"));

    expect(second.outcome).toBe("deferred");
    expect(third.outcome).toBe("deferred");
    // A denial does NOT reserve a future slot: two denials in a row leave the SAME deadline, so N
    // pollers in one tick cannot book N turns. Compared over the whole row, not just the deadline.
    expect(await rowOf(scope, "conversations.replies")).toEqual(before);
    if (second.outcome !== "deferred") throw new Error("unreachable");
    if (first.outcome !== "granted") throw new Error("unreachable");
    expect(second.nextPermittedAt).toBe(first.nextPermittedAt);

    // ⚠️ clock fixture — the interval elapses, and the next attempt is granted.
    await rewind(scope, "conversations.replies", SLACK_UNKNOWN_CATEGORY_INTERVAL_MS + 1_000);
    expect((await tx((s) => reserveSlackMethodSlot(s, scope, "conversations.replies"))).outcome).toBe(
      "granted"
    );
  });

  it("does not collide across methods, apps, workspaces or teams", async () => {
    const seed = await seedTeam();
    const other = await seedTeam();
    const scope = verified(seed);
    await tx((s) => reserveSlackMethodSlot(s, scope, "conversations.history"));

    // Each of these differs from the consumed bucket in exactly ONE key field, so a grant here is
    // evidence about that field and nothing else.
    const independent: [SlackMethodScope, SlackBudgetedMethod][] = [
      [scope, "conversations.replies"],
      [verified(seed, { appId: OTHER_APP }), "conversations.history"],
      [verified(seed, { workspaceId: OTHER_WORKSPACE }), "conversations.history"],
      [verified(other), "conversations.history"],
    ];
    for (const [independentScope, method] of independent) {
      expect((await tx((s) => reserveSlackMethodSlot(s, independentScope, method))).outcome).toBe(
        "granted"
      );
    }
    // …and the original is still spent, so the four grants above are not "everything is granted".
    expect((await tx((s) => reserveSlackMethodSlot(s, scope, "conversations.history"))).outcome).toBe(
      "deferred"
    );
  });

  /**
   * THE SHARING HALF OF THE SAME RULE, and the one a per-integration key would silently break: two
   * different integrations — two different tokens, as far as this table is concerned — reserving the
   * same verified app+workspace+method share ONE allowance. The scope carries no integration at all,
   * which is exactly why.
   */
  it("shares one verified bucket regardless of which integration is asking", async () => {
    const seed = await seedTeam();
    const one = await seedIntegration(seed);
    const two = await seedIntegration(seed);
    const scope = verified(seed);

    // The CONTRAST is the evidence, and it is why both halves are in one test: these two
    // integrations demonstrably do NOT share a provisional bucket…
    expect(
      (await tx((s) => reserveSlackMethodSlot(s, { kind: "provisional", teamId: seed.teamId, integrationId: one }, "auth.test"))).outcome
    ).toBe("granted");
    expect(
      (await tx((s) => reserveSlackMethodSlot(s, { kind: "provisional", teamId: seed.teamId, integrationId: two }, "auth.test"))).outcome
    ).toBe("granted");

    // …and yet, once both are verified against the SAME app and workspace, they share one allowance:
    // the verified scope has no integration field for them to differ in. A per-integration key here
    // would double the allowance we are supposed to be respecting, and the only symptom would be
    // provider 429s.
    const first = await tx((s) => reserveSlackMethodSlot(s, verified(seed), "users.list"));
    const second = await tx((s) => reserveSlackMethodSlot(s, verified(seed), "users.list"));

    expect(first.outcome).toBe("granted");
    expect(second.outcome).toBe("deferred");
    expect(scope).not.toHaveProperty("integrationId");
    // Two provisional buckets + one shared verified bucket.
    expect(await rowCount(seed.teamId)).toBe(3);
  });

  it("gives each integration its own provisional auth.test bucket, and refuses every other method", async () => {
    const seed = await seedTeam();
    const one = await seedIntegration(seed);
    const two = await seedIntegration(seed);
    const scopeOne: SlackMethodScope = { kind: "provisional", teamId: seed.teamId, integrationId: one };
    const scopeTwo: SlackMethodScope = { kind: "provisional", teamId: seed.teamId, integrationId: two };

    // Before a workspace is verified there is nothing else to key on, so these are separate — and
    // that is the reason the scope is bounded to the single call that establishes the workspace.
    expect((await tx((s) => reserveSlackMethodSlot(s, scopeOne, "auth.test"))).outcome).toBe("granted");
    expect((await tx((s) => reserveSlackMethodSlot(s, scopeTwo, "auth.test"))).outcome).toBe("granted");
    expect((await tx((s) => reserveSlackMethodSlot(s, scopeOne, "auth.test"))).outcome).toBe("deferred");

    for (const method of ["bots.info", "conversations.info", "conversations.history", "users.list"] as const) {
      await expect(tx((s) => reserveSlackMethodSlot(s, scopeOne, method))).rejects.toThrow(TypeError);
    }
    expect(await rowCount(seed.teamId)).toBe(2);
  });

  /**
   * ONE bots.info bucket per workspace, shared by every integration and app in it — and RETAINED, so
   * reaching verified state cannot hand the same workspace a second bots.info allowance for its
   * identity refreshes.
   */
  it("shares one workspace-bootstrap bots.info bucket, and refuses every other method", async () => {
    const seed = await seedTeam();
    await seedIntegration(seed);
    await seedIntegration(seed);
    const scope = bootstrap(seed);

    expect((await tx((s) => reserveSlackMethodSlot(s, scope, "bots.info"))).outcome).toBe("granted");
    expect((await tx((s) => reserveSlackMethodSlot(s, bootstrap(seed), "bots.info"))).outcome).toBe(
      "deferred"
    );
    // A different workspace is a different bucket; the same workspace under a verified scope is a
    // DIFFERENT row by design, which is why the bootstrap row must be kept rather than migrated.
    expect((await tx((s) => reserveSlackMethodSlot(s, bootstrap(seed, OTHER_WORKSPACE), "bots.info"))).outcome).toBe(
      "granted"
    );

    for (const method of ["auth.test", "conversations.info", "conversations.replies", "users.list"] as const) {
      await expect(tx((s) => reserveSlackMethodSlot(s, scope, method))).rejects.toThrow(TypeError);
    }
    expect(await rowCount(seed.teamId)).toBe(2);
  });

  /**
   * ONE bots.info bucket, and the verified scope is not a second one. `bots.info` under a verified
   * scope would hand the same workspace a fresh allowance the moment an app id is bound — and a
   * per-app one at that — so one bootstrap request could be followed immediately by another. The
   * refusal is app-code AND storage, and it happens BEFORE a bucket exists.
   */
  it("refuses bots.info under a verified scope, before any row is created", async () => {
    const seed = await seedTeam();
    const scope = verified(seed);

    await expect(tx((s) => reserveSlackMethodSlot(s, scope, "bots.info"))).rejects.toThrow(TypeError);
    await expect(
      tx((s) => extendSlackMethodBackoff(s, scope, "bots.info", { retryAfterMs: 30_000 }))
    ).rejects.toThrow(TypeError);
    // The refusal is not a silent translation into the bootstrap bucket either: NOTHING was written.
    expect(await rowCount(seed.teamId)).toBe(0);

    // …and the database says the same thing, by name, so a writer that bypassed the module cannot
    // store the row app code refuses to create.
    expect(
      await refusal(
        insertRaw({
          team_id: seed.teamId,
          scope_kind: "verified",
          workspace_id: WORKSPACE,
          app_id: APP,
          method: "bots.info",
        })
      )
    ).toMatchObject({ code: "23514", constraint: "slack_method_budgets_method_scope" });

    // The negative control: every OTHER method the verified scope exists for still works.
    for (const method of [
      "auth.test",
      "conversations.info",
      "conversations.history",
      "conversations.replies",
      "users.list",
    ] as const) {
      expect((await tx((s) => reserveSlackMethodSlot(s, scope, method))).outcome).toBe("granted");
    }
    expect(await rowCount(seed.teamId)).toBe(5);
  });

  it("uses the caller's session: a rolled-back reservation leaves no bucket at all", async () => {
    const seed = await seedTeam();
    const scope = verified(seed);

    // Captured, not asserted inside the callback: an assertion that throws in there would be
    // swallowed by the rollback catch, and the test would pass having checked nothing.
    let inTransaction: unknown;
    await tx(async (session) => {
      inTransaction = await reserveSlackMethodSlot(session, scope, "conversations.history");
      throw new Error("rollback");
    }).catch(() => {});
    expect(inTransaction).toMatchObject({ outcome: "granted" });

    // Read on the SEPARATE raw connection: had the module reached for the process-wide pool, this
    // reservation would have committed on its own connection and survived the caller's rollback.
    expect(await rowCount(seed.teamId)).toBe(0);
    // …and the slot is genuinely still available, which is what "no reservation" has to mean.
    expect((await tx((s) => reserveSlackMethodSlot(s, scope, "conversations.history"))).outcome).toBe(
      "granted"
    );
  });

  it("reports a SQL failure as a rejection, never as a deferred slot", async () => {
    const seed = await seedTeam();
    const scope = verified(seed);

    // A poisoned transaction: every later statement fails with 25P02. A `catch → return deferred`
    // anywhere in these paths would make a broken database indistinguishable from a busy budget —
    // and a caller would back off politely forever instead of reporting an outage.
    const inner: { returned?: unknown; threw?: unknown }[] = [];
    await tx(async (session) => {
      await session.executeSql("select 1 / 0").catch(() => {});
      for (const operation of [
        () => reserveSlackMethodSlot(session, scope, "conversations.history"),
        () => extendSlackMethodBackoff(session, scope, "conversations.history", { retryAfterMs: 30_000 }),
      ]) {
        try {
          inner.push({ returned: await operation() });
        } catch (err) {
          inner.push({ threw: err });
        }
      }
      throw new Error("rollback");
    }).catch(() => {});

    expect(inner).toHaveLength(2);
    for (const outcome of inner) {
      expect(outcome.threw).toBeDefined();
      expect("returned" in outcome).toBe(false);
    }
    expect(await rowCount(seed.teamId)).toBe(0);
  });

  it("rejects a malformed scope rather than deferring it, and writes nothing", async () => {
    const seed = await seedTeam();
    const malformed: SlackMethodScope[] = [
      { kind: "verified", teamId: "not-a-uuid", workspaceId: WORKSPACE, appId: APP },
      { kind: "verified", teamId: seed.teamId, workspaceId: "T 1", appId: APP },
      { kind: "verified", teamId: seed.teamId, workspaceId: WORKSPACE, appId: "" },
      { kind: "provisional", teamId: seed.teamId, integrationId: "not-a-uuid" },
      { kind: "workspace_bootstrap", teamId: seed.teamId, workspaceId: "T:1" },
      { kind: "elevated", teamId: seed.teamId } as unknown as SlackMethodScope,
    ];
    for (const scope of malformed) {
      const method: SlackBudgetedMethod =
        scope.kind === "workspace_bootstrap"
          ? "bots.info"
          : scope.kind === "provisional"
            ? "auth.test"
            : "conversations.history";
      await expect(tx((s) => reserveSlackMethodSlot(s, scope, method))).rejects.toThrow(TypeError);
    }
    expect(await rowCount()).toBe(0);
  });
});

// ── backoff ──────────────────────────────────────────────────────────────────

describe("backoff — the deadline only ever moves later", () => {
  it("extends the SAME bucket the request was reserved from", async () => {
    const seed = await seedTeam();
    const scope = verified(seed);
    await tx((s) => reserveSlackMethodSlot(s, scope, "conversations.history"));

    const backoff = await tx((s) =>
      extendSlackMethodBackoff(s, scope, "conversations.history", { retryAfterMs: 300_000 })
    );

    expect(backoff.retryAfterMs).toBeGreaterThan(SLACK_UNKNOWN_CATEGORY_INTERVAL_MS);
    // One bucket, not a parallel cooldown row that the reservation would never consult.
    expect(await rowCount(seed.teamId)).toBe(1);
    const stored = await rowOf(scope, "conversations.history");
    expect(new Date(stored.next_permitted_at as string).toISOString()).toBe(backoff.nextPermittedAt);
  });

  it("never rewinds a later deadline, whatever arrives afterwards", async () => {
    const seed = await seedTeam();
    const scope = verified(seed);
    const long = await tx((s) =>
      extendSlackMethodBackoff(s, scope, "conversations.history", { retryAfterMs: 600_000 })
    );

    // A LATE 429 for an older request, carrying a shorter cooldown; and a missing header, which
    // takes the conservative floor. Neither may shorten what is already stored.
    for (const retryAfterMs of [1_000, SLACK_BACKOFF_FLOOR_MS, null, undefined, Number.NaN]) {
      const again = await tx((s) =>
        extendSlackMethodBackoff(s, scope, "conversations.history", { retryAfterMs })
      );
      expect(again.nextPermittedAt).toBe(long.nextPermittedAt);
    }
    expect((await tx((s) => reserveSlackMethodSlot(s, scope, "conversations.history"))).outcome).toBe(
      "deferred"
    );
  });

  /**
   * A VALID cooldown is persisted at its FULL duration. The bound is read off the database's own
   * clock either side of the write, so this cannot pass by being generous about "about 48 hours":
   * a 24-hour clamp lands a day short of the lower bound.
   */
  it("persists a 48-hour cooldown as 48 hours, not as a day", async () => {
    const seed = await seedTeam();
    const scope = verified(seed);
    const c = await sql();
    const before = new Date((await c.query<{ t: Date }>("select clock_timestamp() as t")).rows[0].t);

    const long = await tx((s) =>
      extendSlackMethodBackoff(s, scope, "conversations.history", { retryAfterMs: 172_800_000 })
    );

    const after = new Date((await c.query<{ t: Date }>("select clock_timestamp() as t")).rows[0].t);
    const stored = new Date(
      (await rowOf(scope, "conversations.history")).next_permitted_at as string
    ).getTime();
    expect(stored).toBeGreaterThanOrEqual(before.getTime() + 172_800_000);
    expect(stored).toBeLessThanOrEqual(after.getTime() + 172_800_000);
    expect(new Date(long.nextPermittedAt).getTime()).toBe(stored);
    expect(long.retryAfterMs).toBeGreaterThan(86_400_000);

    // A shorter cooldown arriving afterwards still cannot rewind it.
    const shorter = await tx((s) =>
      extendSlackMethodBackoff(s, scope, "conversations.history", { retryAfterMs: 3_600_000 })
    );
    expect(shorter.nextPermittedAt).toBe(long.nextPermittedAt);
  });

  /**
   * A delay we cannot carry end to end must not become a near-term one. Recording the 60-second
   * floor here would be indistinguishable, in the table, from an ordinary cooldown — and it would
   * release the next request while the provider is still refusing.
   */
  it("refuses an unrepresentable delay rather than storing a shorter one", async () => {
    const seed = await seedTeam();
    const scope = verified(seed);
    const granted = await tx((s) => reserveSlackMethodSlot(s, scope, "users.list"));
    const before = await rowOf(scope, "users.list");

    await expect(
      tx((s) => extendSlackMethodBackoff(s, scope, "users.list", { retryAfterMs: 1e300 }))
    ).rejects.toThrow(TypeError);

    if (granted.outcome !== "granted") throw new Error("unreachable");
    // Whole-row comparison: no deadline, and no metadata, moved on the way out.
    expect(await rowOf(scope, "users.list")).toEqual(before);
  });

  it("takes the conservative floor when there is nothing usable to read", async () => {
    const seed = await seedTeam();
    const scope = verified(seed);

    const floored = await tx((s) => extendSlackMethodBackoff(s, scope, "users.list", {}));

    // "We could not read the cooldown" must never resolve to "retry now" — the provider has just
    // told us to stop.
    expect(floored.retryAfterMs).toBeGreaterThan(SLACK_BACKOFF_FLOOR_MS / 2);
    expect((await tx((s) => reserveSlackMethodSlot(s, scope, "users.list"))).outcome).toBe("deferred");
  });
});

// ── the one-request transport, over the real budget ──────────────────────────

describe("slackReservedRequest — commit, then exactly one request", () => {
  /** A fetch that records what it was called with and answers with a canned response. */
  function recordingFetch(
    respond: (url: string, init: RequestInit | undefined) => Promise<Response> | Response
  ): { impl: typeof fetch; calls: { url: string; init?: RequestInit }[] } {
    const calls: { url: string; init?: RequestInit }[] = [];
    const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), init });
      return respond(String(input), init);
    }) as unknown as typeof fetch;
    return { impl, calls };
  }

  function jsonResponse(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  }

  it("holds the reservation COMMITTED before the request leaves, and preserves the page", async () => {
    const seed = await seedTeam();
    const scope = verified(seed);
    let visibleDuringFetch: string | null = null;

    const { impl, calls } = recordingFetch(async () => {
      // Read the bucket from a connection OUTSIDE the app pool, from INSIDE the request. If the
      // reservation were still an open transaction, this connection could not see it — so this is
      // the durability claim asserted at the only moment it matters, not inferred from ordering.
      const c = await sql();
      const { rows } = await c.query<{ next_permitted_at: Date }>(
        `select next_permitted_at from slack_method_budgets where team_id = $1`,
        [seed.teamId]
      );
      visibleDuringFetch = rows[0] ? new Date(rows[0].next_permitted_at).toISOString() : null;
      return jsonResponse({
        ok: true,
        messages: [{ ts: "1718900000.000100", text: "hello" }],
        has_more: true,
        response_metadata: { next_cursor: "dXNlcjpVMDYxTkZUVDI=" },
      });
    });

    const result = await slackReservedRequest(
      { db: db(), scope, token: BOT_TOKEN },
      "conversations.history",
      { channel: "C0BUDGET1" },
      { fetchImpl: impl }
    );

    expect(visibleDuringFetch).not.toBeNull();
    const stored = await rowOf(scope, "conversations.history");
    expect(visibleDuringFetch).toBe(new Date(stored.next_permitted_at as string).toISOString());

    expect(result.outcome).toBe("ok");
    if (result.outcome !== "ok") throw new Error("unreachable");
    // Preserved, not interpreted: the worker decides what a cursor and `has_more` mean.
    expect(result.page.messages).toEqual([{ ts: "1718900000.000100", text: "hello" }]);
    expect(result.page.hasMore).toBe(true);
    expect(result.page.nextCursor).toBe("dXNlcjpVMDYxTkZUVDI=");
    // The conservative page size is applied where the request is built, not left to the call site.
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toContain(`limit=${SLACK_UNKNOWN_CATEGORY_PAGE_LIMIT}`);
  });

  it("sends ZERO requests when the budget denies the slot", async () => {
    const seed = await seedTeam();
    const scope = verified(seed);
    await tx((s) => reserveSlackMethodSlot(s, scope, "conversations.history"));
    const before = await rowOf(scope, "conversations.history");
    const { impl, calls } = recordingFetch(() => {
      throw new Error("a denied reservation must never reach the network");
    });

    const result = await slackReservedRequest(
      { db: db(), scope, token: BOT_TOKEN },
      "conversations.history",
      { channel: "C0BUDGET1" },
      { fetchImpl: impl }
    );

    expect(result.outcome).toBe("deferred");
    expect(calls).toHaveLength(0);
    // A denial does not touch the bucket either — no future slot was booked on the way past.
    expect(await rowOf(scope, "conversations.history")).toEqual(before);
  });

  /**
   * A 429 IS RECOGNISED BEFORE THE BODY IS PARSED. Slack's rate-limit response is often not JSON;
   * requiring a parse first turns a cooldown into a parse error and the cooldown is never stored —
   * so this fixture is deliberately HTML, and the assertion is the persisted deadline.
   */
  it("persists a cooldown from a non-JSON 429 with a valid Retry-After", async () => {
    const seed = await seedTeam();
    const scope = verified(seed);
    const { impl } = recordingFetch(
      () =>
        new Response("<html>rate limited</html>", {
          status: 429,
          headers: { "retry-after": "120", "content-type": "text/html" },
        })
    );

    const result = await slackReservedRequest(
      { db: db(), scope, token: BOT_TOKEN },
      "conversations.replies",
      { channel: "C0BUDGET1", ts: "1718900000.000100" },
      { fetchImpl: impl }
    );

    expect(result.outcome).toBe("rate_limited");
    if (result.outcome !== "rate_limited") throw new Error("unreachable");
    expect(result.retryAfterMs).toBeGreaterThan(SLACK_UNKNOWN_CATEGORY_INTERVAL_MS);
    const stored = await rowOf(scope, "conversations.replies");
    expect(new Date(stored.next_permitted_at as string).toISOString()).toBe(result.nextPermittedAt);
    // The cooldown is real: the next attempt is refused by the persisted deadline, not by memory.
    expect((await tx((s) => reserveSlackMethodSlot(s, scope, "conversations.replies"))).outcome).toBe(
      "deferred"
    );
    // Nothing about the provider's body reached the result.
    expect(JSON.stringify(result)).not.toContain("html");
  });

  it("leaves the slot consumed when the request fails, and never refunds it", async () => {
    const seed = await seedTeam();
    const scope = verified(seed);
    const { impl } = recordingFetch(() => {
      throw Object.assign(new Error("socket hang up"), { name: "TypeError" });
    });

    const result = await slackReservedRequest(
      { db: db(), scope, token: BOT_TOKEN },
      "conversations.info",
      { channel: "C0BUDGET1" },
      { fetchImpl: impl }
    );

    expect(result.outcome).toBe("transport_error");
    // Slack may well have served the request before the socket died. Refunding the slot on a failure
    // we cannot classify is exactly how a crash-looping worker becomes an unmetered request flood.
    expect((await tx((s) => reserveSlackMethodSlot(s, scope, "conversations.info"))).outcome).toBe(
      "deferred"
    );
  });

  /**
   * BOOTSTRAP RESPONSE CONTRACTS. These pin the SHAPES the later app-identity binder must accept and
   * refuse. ⚠️ They prove nothing about that binder: no binding, config or source-state writer
   * exists in this packet, and nothing here stores an app id. A "verified scope" below is a scope
   * this test constructs, never one the fixtures earned.
   */
  it("carries an auth.test workspace and its optional app id through unchanged", async () => {
    const seed = await seedTeam();
    const integrationId = await seedIntegration(seed);
    const scope: SlackMethodScope = { kind: "provisional", teamId: seed.teamId, integrationId };
    const { impl } = recordingFetch(() =>
      jsonResponse({ ok: true, team_id: WORKSPACE, bot_id: "B0BUDGET1", app_id: APP })
    );

    const result = await slackReservedRequest(
      { db: db(), scope, token: BOT_TOKEN },
      "auth.test",
      {},
      { fetchImpl: impl }
    );

    expect(result.outcome).toBe("ok");
    if (result.outcome !== "ok") throw new Error("unreachable");
    // A present, valid `app_id` is the direct route: no bots.info request is needed, and this
    // adapter neither makes one nor decides that it should be made.
    expect(result.body).toMatchObject({ team_id: WORKSPACE, bot_id: "B0BUDGET1", app_id: APP });
    expect(result.page.messages).toBeUndefined();
    expect(result.page.hasMore).toBe(false);
    expect(result.page.nextCursor).toBeNull();
  });

  it("carries a bots.info fallback answer through, and reports its refusals as categories", async () => {
    const seed = await seedTeam();
    const scope = bootstrap(seed);

    const matching = recordingFetch(() =>
      jsonResponse({ ok: true, bot: { id: "B0BUDGET1", deleted: false, app_id: APP } })
    );
    const ok = await slackReservedRequest(
      { db: db(), scope, token: BOT_TOKEN },
      "bots.info",
      { bot: "B0BUDGET1" },
      { fetchImpl: matching.impl }
    );
    expect(ok.outcome).toBe("ok");
    if (ok.outcome !== "ok") throw new Error("unreachable");
    expect(ok.body).toMatchObject({ bot: { id: "B0BUDGET1", deleted: false, app_id: APP } });

    // ⚠️ Missing/malformed/deleted/mismatched bot metadata is NOT this module's verdict — it reports
    // exactly what Slack said, and the (unbuilt) binder must refuse those shapes. What IS pinned
    // here: a refused bootstrap never becomes a verified scope, because this adapter binds nothing.
    for (const body of [
      { ok: true },
      { ok: true, bot: { id: "B0OTHER01", deleted: false, app_id: APP } },
      { ok: true, bot: { id: "B0BUDGET1", deleted: true, app_id: APP } },
      { ok: true, bot: { id: "B0BUDGET1", deleted: false } },
    ]) {
      await rewind(scope, "bots.info", SLACK_UNKNOWN_CATEGORY_INTERVAL_MS + 1_000);
      const fixture = recordingFetch(() => jsonResponse(body));
      const result = await slackReservedRequest(
        { db: db(), scope, token: BOT_TOKEN },
        "bots.info",
        { bot: "B0BUDGET1" },
        { fetchImpl: fixture.impl }
      );
      expect(result.outcome).toBe("ok");
      if (result.outcome !== "ok") throw new Error("unreachable");
      expect(result.body).toEqual(body);
    }

    // `missing_scope` on this route is the one the diagnostic must name users:read for — reported as
    // a credential category, not as a transient fault to retry on a timer.
    await rewind(scope, "bots.info", SLACK_UNKNOWN_CATEGORY_INTERVAL_MS + 1_000);
    const refused = recordingFetch(() => jsonResponse({ ok: false, error: "missing_scope", needed: "users:read" }));
    const blocked = await slackReservedRequest(
      { db: db(), scope, token: BOT_TOKEN },
      "bots.info",
      { bot: "B0BUDGET1" },
      { fetchImpl: refused.impl }
    );
    expect(blocked).toEqual({ outcome: "auth_error", method: "bots.info", category: "missing_scope" });
  });

  it("never echoes the token or the provider body in any diagnostic", async () => {
    const seed = await seedTeam();
    const scope = verified(seed);
    const secret = "xoxb-9999-synthetic-secret-value";
    const leak = "SENSITIVE-PROVIDER-BODY";
    const { impl } = recordingFetch(
      () =>
        new Response(`{"ok":false,"error":"internal_error","detail":"${leak}"} trailing`, {
          status: 500,
          headers: { "content-type": "application/json" },
        })
    );

    const result = await slackReservedRequest(
      { db: db(), scope, token: secret },
      "conversations.info",
      { channel: "C0BUDGET1" },
      { fetchImpl: impl }
    );

    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(secret);
    expect(serialized).not.toContain(leak);
    expect(result.outcome).toBe("transport_error");
    if (result.outcome !== "transport_error") throw new Error("unreachable");
    expect(result.category).toBe("malformed_response_500");
  });
});
