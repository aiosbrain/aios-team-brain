import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { describe, expect, it } from "vitest";

import { classifyBackstop, readBackstopStatus } from "@/lib/pm-sync/runs";
import { db, seedTeam, type Seed } from "./helpers";

/**
 * ADOPTUNIQ-1 — the partial unique index, and the three ways its migration must REFUSE TO CREATE
 * rather than abort a release.
 *
 * Design: docs/design/task-pm-links-unique-index.md
 *
 * WHY THESE RUN ON THEIR OWN SCRATCH DATABASE. Every test here does DDL — dropping the index,
 * replaying the guarded block, installing a deliberately wrong one. The dm harness truncates ROWS,
 * not DDL, so a mid-test failure against the shared test database would strand it without the index
 * and redden unrelated tests phantomly (and the shared `:5434` container is contended by other
 * worktrees). Each of these opens its own database instead, created and dropped here.
 *
 * The one exception is the LIVE-schema assertion at the end, which reads the catalog of the database
 * the tier itself loaded — that is the only test that can prove the block in `postgres/schema.sql`
 * actually ran during `db:test:up`.
 */

const INDEX = "task_pm_links_provider_resource_uq";

/** The guarded block, byte-identical to the shipped migration — read from disk, never paraphrased. */
async function guardedBlock(): Promise<string> {
  const { readFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  return readFileSync(
    join(__dirname, "..", "..", "postgres", "migrations", "20260826230000_task_pm_links_provider_resource_uq.sql"),
    "utf8",
  );
}

function adminUrl(): string {
  const url = process.env.DATABASE_TEST_URL;
  if (!url) throw new Error("DATABASE_TEST_URL required");
  return url;
}

/** A throwaway database with just enough of the real shape to exercise the index. */
async function withScratchDb<T>(fn: (c: Client, name: string) => Promise<T>): Promise<T> {
  const name = `adoptuniq_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
  /**
   * RETRIED, because it flaked once in a full parallel run and a 1-in-N test is a liability.
   *
   * `create database` takes a short exclusive lock and can transiently fail while other files in the
   * tier are creating or dropping their own scratch databases. The failure surfaced as a bare
   * assertion mismatch in an unrelated-looking case, which is precisely how infrastructure contention
   * gets misread as a product bug. Bounded, and it rethrows rather than silently proceeding against a
   * database that does not exist.
   */
  let created = false;
  let lastErr: unknown = null;
  for (let attempt = 0; attempt < 5 && !created; attempt++) {
    const admin = new Client({ connectionString: adminUrl() });
    try {
      await admin.connect();
      await admin.query(`create database ${name}`);
      created = true;
    } catch (err) {
      lastErr = err;
      await new Promise((r) => setTimeout(r, 100 * (attempt + 1)));
    } finally {
      await admin.end().catch(() => {});
    }
  }
  if (!created) throw new Error(`could not create scratch database ${name}: ${String(lastErr)}`);

  const target = new URL(adminUrl());
  target.pathname = `/${name}`;
  const c = new Client({ connectionString: target.toString() });
  await c.connect();
  try {
    // Minimal shape: the index only needs these four columns, and a full schema load per test would
    // dominate the runtime without testing anything extra.
    await c.query(`
      create table task_pm_links (
        id uuid primary key default gen_random_uuid(),
        team_id uuid not null,
        provider text not null,
        provider_resource_id text,
        row_key text not null
      );
      -- A second relation, so a DEADLOCK cycle can be staged: the deploy transaction locks this one
      -- first (standing in for the ACCESS EXCLUSIVE locks schema.sql accumulates from its earlier
      -- alter-table-if-not-exists no-ops), while the old app version waits on it.
      create table other_rel (x int);
      insert into other_rel values (1);
    `);
    return await fn(c, name);
  } finally {
    await c.end().catch(() => {});
    const cleanup = new Client({ connectionString: adminUrl() });
    await cleanup.connect();
    await cleanup.query(`drop database if exists ${name} with (force)`).catch(() => {});
    await cleanup.end().catch(() => {});
  }
}

const TEAM_A = "11111111-1111-1111-1111-111111111111";
const TEAM_B = "22222222-2222-2222-2222-222222222222";

async function insertLink(
  c: Client,
  over: { team?: string; provider?: string; rid?: string | null; key?: string } = {},
) {
  return c.query(
    `insert into task_pm_links (team_id, provider, provider_resource_id, row_key) values ($1,$2,$3,$4)`,
    [over.team ?? TEAM_A, over.provider ?? "linear", over.rid === undefined ? "issue-1" : over.rid, over.key ?? randomUUID().slice(0, 8)],
  );
}

/** Block until some backend is actually WAITING on `rel` — polling beats a fixed sleep, which would
 *  either flake on a slow machine or silently stage no contention at all. */
async function waitForWaiter(c: Client, rel: string): Promise<void> {
  for (let i = 0; i < 100; i++) {
    const r = await c.query(
      `select count(*)::int as n from pg_locks l
         join pg_class cl on cl.oid = l.relation
        where cl.relname = $1 and not l.granted`,
      [rel],
    );
    if ((r.rows[0].n as number) > 0) return;
    await new Promise((res) => setTimeout(res, 50));
  }
  throw new Error(`no backend ever waited on ${rel} — the deadlock was never staged`);
}

async function indexCount(c: Client): Promise<number> {
  const r = await c.query(`select count(*)::int as n from pg_indexes where indexname = $1`, [INDEX]);
  return r.rows[0].n as number;
}

describe("ADOPTUNIQ-1 — what the index enforces once installed", () => {
  it("REJECTS a second link claiming the same issue, with SQLSTATE 23505", async () => {
    await withScratchDb(async (c) => {
      await c.query(await guardedBlock());
      expect(await indexCount(c)).toBe(1);

      await insertLink(c, { rid: "issue-444" });
      const err = await insertLink(c, { rid: "issue-444" }).catch((e) => e);
      // The CODE, not the message — a message match would pass on an unrelated failure and would
      // break under a non-English lc_messages on a self-hosted fleet.
      expect(err.code).toBe("23505");
      expect(err.constraint).toBe(INDEX);
    });
  });

  it("PERMITS unlimited NULL resource ids — the live orphan row cannot be broken by this", async () => {
    await withScratchDb(async (c) => {
      await c.query(await guardedBlock());
      await insertLink(c, { rid: null });
      await insertLink(c, { rid: null });
      await insertLink(c, { rid: null });
      const n = await c.query(`select count(*)::int as n from task_pm_links where provider_resource_id is null`);
      expect(n.rows[0].n).toBe(3);
    });
  });

  it("keys on ALL THREE columns — same id under a different team or provider is allowed", async () => {
    await withScratchDb(async (c) => {
      await c.query(await guardedBlock());
      await insertLink(c, { rid: "shared", team: TEAM_A, provider: "linear" });
      // different team
      await expect(insertLink(c, { rid: "shared", team: TEAM_B, provider: "linear" })).resolves.toBeDefined();
      // different provider
      await expect(insertLink(c, { rid: "shared", team: TEAM_A, provider: "plane" })).resolves.toBeDefined();
      // and the actual duplicate still rejects, so the permissive cases above aren't vacuous
      await expect(insertLink(c, { rid: "shared", team: TEAM_A, provider: "linear" })).rejects.toMatchObject({ code: "23505" });
    });
  });
});

describe("ADOPTUNIQ-1 — the block SKIPS rather than aborting the release", () => {
  it("DIRTY DATA: completes without raising, index absent, both rows intact", async () => {
    await withScratchDb(async (c) => {
      await insertLink(c, { rid: "dup" });
      await insertLink(c, { rid: "dup" });

      // A statement AFTER the block, in the same transaction, is what proves the schema load survived
      // the caught exception — the property the whole design rests on.
      await c.query(`begin`);
      await c.query(await guardedBlock());
      await c.query(`create table later_ran (x int)`);
      await c.query(`commit`);

      expect(await indexCount(c), "index must NOT be installed on dirty data").toBe(0);
      const later = await c.query(`select count(*)::int as n from pg_tables where tablename = 'later_ran'`);
      expect(later.rows[0].n, "the schema load must continue past the skip").toBe(1);
      const rows = await c.query(`select count(*)::int as n from task_pm_links`);
      expect(rows.rows[0].n, "no row may be touched by the skip").toBe(2);
    });
  });

  /**
   * THE POSITIVE CONTROL FOR THE INVARIANT QUERY, rehomed from
   * `pm-link-uniqueness.datamechanics.test.ts`.
   *
   * That file used to prove its `duplicateGroups` detector non-vacuous by inserting a real duplicate
   * and asserting the query REPORTED it. The index makes that impossible in the tier's shared
   * database — nothing can be duplicated there any more — so the control would have been silently
   * lost, leaving every `toEqual([])` in that file green by construction with nothing proving the
   * query can ever return a non-empty result.
   *
   * Here it still works, because this scratch database has no index until the block runs.
   */
  it("the invariant QUERY can still report a duplicate — the control the index would have deleted", async () => {
    await withScratchDb(async (c) => {
      await insertLink(c, { rid: "dup", key: "A" });
      await insertLink(c, { rid: "dup", key: "B" });
      // Same shape as pm-link-uniqueness's `duplicateGroups`: grouped by (provider, resource id),
      // NULLs excluded by the identical predicate the index uses.
      const groups = await c.query(
        `select provider, provider_resource_id, count(*)::int as n
           from task_pm_links
          where provider_resource_id is not null
          group by provider, provider_resource_id
         having count(*) > 1`,
      );
      expect(groups.rows).toEqual([{ provider: "linear", provider_resource_id: "dup", n: 2 }]);

      // And it is provider-scoped, matching the index it mirrors: the same id under a different
      // provider is NOT a violation.
      await insertLink(c, { rid: "solo", provider: "linear", key: "C" });
      await insertLink(c, { rid: "solo", provider: "plane", key: "D" });
      const after = await c.query(
        `select provider_resource_id from task_pm_links
          where provider_resource_id is not null
          group by provider, provider_resource_id having count(*) > 1`,
      );
      expect(after.rows.map((r) => r.provider_resource_id)).toEqual(["dup"]);
    });
  });

  it("DIRTY DATA committed by a SECOND connection is contained identically", async () => {
    await withScratchDb(async (c, name) => {
      const url = new URL(adminUrl());
      url.pathname = `/${name}`;
      const other = new Client({ connectionString: url.toString() });
      await other.connect();
      try {
        await other.query(
          `insert into task_pm_links (team_id, provider, provider_resource_id, row_key) values ($1,'linear','x','A'),($1,'linear','x','B')`,
          [TEAM_A],
        );
      } finally {
        await other.end();
      }
      await c.query(await guardedBlock());
      expect(await indexCount(c)).toBe(0);
    });
  });

  it("SELF-HEAL asymmetry: the duplicate-data skip does NOT heal until the data is repaired", async () => {
    await withScratchDb(async (c) => {
      await insertLink(c, { rid: "dup", key: "A" });
      await insertLink(c, { rid: "dup", key: "B" });

      await c.query(await guardedBlock());
      expect(await indexCount(c), "still dirty -> still absent").toBe(0);

      // Replaying against unchanged data must stay a clean no-op, not accumulate damage.
      await c.query(await guardedBlock());
      expect(await indexCount(c)).toBe(0);

      // Only repairing the DATA installs it. This is the asymmetry the migration's warning states:
      // unlike the contention skips, this one has no actor and will never self-heal on its own.
      await c.query(`delete from task_pm_links where row_key = 'B'`);
      await c.query(await guardedBlock());
      expect(await indexCount(c), "repaired -> installed on the next deploy").toBe(1);
    });
  });

  it("is IDEMPOTENT on a clean database — replay does not raise or duplicate", async () => {
    await withScratchDb(async (c) => {
      await c.query(await guardedBlock());
      await c.query(await guardedBlock());
      await c.query(await guardedBlock());
      expect(await indexCount(c)).toBe(1);
    });
  });

  /**
   * THE ROUND-2 REGRESSION TEST. `pg-load-schema.mjs:66-67` sets `lock_timeout`. A non-concurrent
   * CREATE INDEX takes SHARE and must wait out in-flight writes from the old app version, which is
   * still serving during preDeploy. Before `when lock_not_available` was added, the timeout escaped
   * the handler, poisoned the implicit transaction, and aborted the release — ON A CLEAN TABLE.
   */
  it("LOCK WAIT on a CLEAN table: contained, and the schema load continues", async () => {
    await withScratchDb(async (c, name) => {
      const url = new URL(adminUrl());
      url.pathname = `/${name}`;
      const holder = new Client({ connectionString: url.toString() });
      await holder.connect();
      try {
        await holder.query(`begin`);
        await holder.query(`insert into task_pm_links (team_id, provider, provider_resource_id, row_key) values ($1,'linear','held','H')`, [TEAM_A]);

        await c.query(`set lock_timeout = 1000`);
        await c.query(`begin`);
        await c.query(await guardedBlock());
        await c.query(`create table later_ran (x int)`);
        await c.query(`commit`);

        expect(await indexCount(c), "could not lock -> not installed").toBe(0);
        const later = await c.query(`select count(*)::int as n from pg_tables where tablename = 'later_ran'`);
        expect(later.rows[0].n, "the release must NOT abort on a lock wait").toBe(1);
      } finally {
        await holder.query(`rollback`).catch(() => {});
        await holder.end().catch(() => {});
      }
    });
  });

  /**
   * THE ROUND-3 REGRESSION TEST, and it exists because the mutation SURVIVED without it.
   *
   * `deadlock_timeout` defaults to 1s — well before the 15s `lock_timeout` — and by the time this
   * block runs, `schema.sql` has already taken ACCESS EXCLUSIVE locks from its earlier
   * `alter table … if not exists` no-ops while the old app version is still serving. So a genuine
   * cycle is ordinary, not exotic. Staged and confirmed: this transaction is chosen victim, and
   * without `when deadlock_detected` the 40P01 escapes, poisons the implicit transaction, and aborts
   * the release — on a CLEAN table, with zero dirty data.
   */
  it("DEADLOCK on a CLEAN table: contained, and the schema load continues", async () => {
    await withScratchDb(async (c, name) => {
      const url = new URL(adminUrl());
      url.pathname = `/${name}`;
      const old = new Client({ connectionString: url.toString() });
      await old.connect();
      try {
        await c.query(`set deadlock_timeout = '100ms'`);
        await c.query(`set lock_timeout = 30000`);

        // 1. The old app takes ROW EXCLUSIVE on task_pm_links — the relation we are about to index.
        await old.query(`begin`);
        await old.query(
          `insert into task_pm_links (team_id, provider, provider_resource_id, row_key) values ($1,'linear','held','H')`,
          [TEAM_A],
        );

        // 2. The deploy transaction takes ACCESS EXCLUSIVE on the other relation.
        await c.query(`begin`);
        await c.query(`lock table other_rel in access exclusive mode`);

        // 3. The old app now requests the relation we hold -> it waits on us. NOT awaited: it blocks.
        const blocked = old.query(`update other_rel set x = x + 1`).catch(() => undefined);
        await waitForWaiter(c, "other_rel");

        // 4. We request the relation IT holds -> cycle. One of us is the victim.
        await c.query(await guardedBlock());
        await c.query(`create table later_ran (x int)`);
        await c.query(`commit`);

        await old.query(`rollback`).catch(() => {});
        await blocked;

        expect(await indexCount(c), "deadlocked -> not installed").toBe(0);
        const later = await c.query(`select count(*)::int as n from pg_tables where tablename = 'later_ran'`);
        expect(later.rows[0].n, "the release must NOT abort on a deadlock").toBe(1);
      } finally {
        await old.query(`rollback`).catch(() => {});
        await old.end().catch(() => {});
      }
    });
  });

  it("the LOCK skip DOES self-heal once the lock clears", async () => {
    await withScratchDb(async (c, name) => {
      const url = new URL(adminUrl());
      url.pathname = `/${name}`;
      const holder = new Client({ connectionString: url.toString() });
      await holder.connect();
      await holder.query(`begin`);
      await holder.query(`insert into task_pm_links (team_id, provider, provider_resource_id, row_key) values ($1,'linear','held','H')`, [TEAM_A]);

      await c.query(`set lock_timeout = 1000`);
      await c.query(await guardedBlock());
      expect(await indexCount(c)).toBe(0);

      await holder.query(`rollback`);
      await holder.end();

      await c.query(await guardedBlock());
      expect(await indexCount(c), "contention cleared -> installed, no operator step").toBe(1);
    });
  });
});

describe("ADOPTUNIQ-1 — the read-side backstop signal", () => {
  it("reports `installed` against the tier's OWN live schema", async () => {
    // The only assertion here that proves the block in postgres/schema.sql actually executed during
    // `db:test:up`. If someone deletes the schema.sql copy, the guard test still passes (it reads
    // files) but THIS reddens.
    expect(await readBackstopStatus()).toBe("installed");
  });

  it("reports `missing` when the index is absent, and `malformed` for a wrong same-named index", async () => {
    await withScratchDb(async (c) => {
      const read = async () => {
        const r = await c.query(
          `select pg_get_indexdef(i.indexrelid) as indexdef, i.indisvalid as isvalid
             from pg_index i join pg_class cl on cl.oid = i.indexrelid
             join pg_namespace n on n.oid = cl.relnamespace
            where n.nspname='public' and cl.relname=$1`,
          [INDEX],
        );
        return classifyBackstop((r.rows[0] ?? null) as { indexdef: string; isvalid: boolean } | null);
      };

      expect(await read()).toBe("missing");

      // The exact hole `create unique index IF NOT EXISTS` leaves open: it matches on NAME alone, so a
      // wrong index of the right name makes every future deploy a silent no-op.
      await c.query(`create index ${INDEX} on task_pm_links (team_id, provider, provider_resource_id) where provider_resource_id is not null`);
      expect(await read(), "non-unique index of the right name must NOT read as installed").toBe("malformed");

      await c.query(`drop index ${INDEX}`);
      await c.query(await guardedBlock());
      expect(await read()).toBe("installed");
    });
  });
});

describe("ADOPTUNIQ-1 — the live schema really carries the constraint", () => {
  it("rejects a duplicate through the ordinary app client, not just raw SQL", async () => {
    // Seeded INSIDE the test, not in beforeAll: the harness truncates between files, so a beforeAll
    // seed is gone by the time the assertion runs and the FK failure reads like a product bug.
    const seed: Seed = await seedTeam();
    const { data: project } = await db()
      .from("projects")
      .insert({ team_id: seed.teamId, slug: `p-${randomUUID().slice(0, 8)}`, name: "p" })
      .select("id")
      .single();
    const projectId = (project as { id: string }).id;
    const rid = `issue-${randomUUID().slice(0, 8)}`;

    const base = {
      team_id: seed.teamId,
      project_id: projectId,
      provider: "linear",
      provider_external_id: "X",
      provider_resource_id: rid,
    };
    const first = await db().from("task_pm_links").insert({ ...base, row_key: "K1" });
    expect(first.error, "the first link must insert").toBeFalsy();

    // The pg adapter returns errors rather than throwing, which is exactly why the outbound path had
    // to start READING them (lib/pm-sync/project.ts persistSuccess).
    const second = await db().from("task_pm_links").insert({ ...base, row_key: "K2" });
    expect(second.error, "a second link on the same issue must be refused by the DB").toBeTruthy();
  });
});
