import { readFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { describe, expect, it } from "vitest";

/**
 * AIO-1170 AM-F2 + AC-02 deep history — the numbered migration's direct, populated upgrade
 * (accepted consolidated contract `aio1170-am-f2-deep-history-consolidated-accepted-spec-migration-v1-20261023.md`,
 * §3.1, §4, §9, §9.3 MR-02/MR-03/MR-05, §10 DH-11, §10.1 F2-12, §12).
 *
 * RED PACKET 2. The reserved migration `postgres/migrations/20261023120000_slack_channel_history_segments.sql`
 * is currently a readable, valid, COMMENT-ONLY scaffold. This case applies it to a populated pre-F2
 * table and requires the catalog it must create. Today that gate is a named assertion mismatch: the
 * catalog readers query only `pg_attribute`, `pg_constraint` and `pg_proc`, never a column that does
 * not exist yet, so there is no SQL error, no ENOENT and no parse failure to mistake for evidence.
 *
 * ON ITS OWN SCRATCH DATABASE, created and dropped here under the isolated data-mechanics URL
 * (`DATABASE_TEST_URL`, provided by `scripts/dm-isolated.sh`), exactly as the existing rollout case in
 * `slack-thread-state.datamechanics.test.ts` does. The schema is loaded by the real loader, unchanged.
 * Never the shared port-5434 service, never production.
 *
 * THE PRE-F2 STATE. The loader builds the CURRENT schema. Today that is already pre-F2. Once the
 * mirror lands in `schema.sql` it will not be, so the case then reconstructs pre-F2 with FIXTURE DDL on
 * this throwaway database only — the contract permits test-only reconstruction of legacy schema states
 * in disposable isolated databases (§9.3) — and asserts that it got there before seeding.
 *
 * THE ONE NARROW CASE (MR-03 / F2-12): one channel row whose HISTORICAL lane is active — anchor, a
 * saved cursor and an attempt-oldest — with no live claim, and whose NEWEST lane is idle; plus one
 * unrelated queued thread row. Applying the migration once is a UNION introduction (both histories
 * and every segment column absent), so per §9:
 *  - the active historical lane restarts EXACTLY ONCE: its cursor and attempt-oldest clear, its
 *    history is `[]` (never seeded from the saved cursor), its scan generation increments by one, and
 *    its new segment tuple stays all-null for the next claim to initialize;
 *  - the idle newest lane keeps its all-null shape with an empty history and an unchanged generation;
 *  - with no claim, the lease tuple, lease generation and `next_lane` are preserved exactly;
 *  - every other column — anchor, certified/provisional/floor state, binding/public state, due time,
 *    attempts, error/success metadata, created time — is unchanged; `updated_at` moves, because only
 *    restarted rows change it, and this row is restarted;
 *  - the unrelated thread row is byte-identical;
 *  - the block emits no NOTICE or WARNING.
 * A second application must then leave the FULL row exactly as the first left it, `updated_at`
 * included, with no further restart and no notice.
 *
 * WHAT REMAINS for later packets, and is NOT claimed here: MR-02 mirror byte-parity and from-zero/
 * upgraded fingerprints and dump/restore; the rest of the MR-03 matrix (history-only and segment-only
 * introduction, one-lane introduction, idle and active lanes together, a cursor-null live claim, an
 * unaffected opposite live claim, mirror-only and both execution orders, replay after initialized
 * segment progress and maximum histories); MR-04 static failures, rollback, cancellation and
 * concurrency; MR-05's existing structural sweeps; the named DH-11 source-fences tests; and MR-06.
 */

const SCRATCH_TIMEOUT = 300_000;
const MIGRATION = join(process.cwd(), "postgres", "migrations", "20261023120000_slack_channel_history_segments.sql");

/** The eight columns §3.1 and §4 add, in name order. */
const NEW_COLUMNS = [
  "historical_completed_segments_oldest_ts",
  "historical_cursor_history",
  "historical_segment_lower_ts",
  "historical_segment_upper_ts",
  "newest_cursor_history",
  "newest_request_lower_ts",
  "newest_segment_lower_ts",
  "newest_segment_upper_ts",
];
const HISTORY_CHECKS = [
  "slack_sync_channels_historical_cursor_history_check",
  "slack_sync_channels_newest_cursor_history_check",
];

/** The accepted catalog, written out (§3.1, §4, §9 "Exact history catalog contract"). */
const TEXT_PROGRESS = { type: "text", not_null: false, default_expr: null, generated: "", identity: "" };
const HISTORY = { type: "jsonb", not_null: true, default_expr: "'[]'::jsonb", generated: "", identity: "" };
const EXPECTED_CATALOG = {
  columns: [
    { name: "historical_completed_segments_oldest_ts", ...TEXT_PROGRESS },
    { name: "historical_cursor_history", ...HISTORY },
    { name: "historical_segment_lower_ts", ...TEXT_PROGRESS },
    { name: "historical_segment_upper_ts", ...TEXT_PROGRESS },
    { name: "newest_cursor_history", ...HISTORY },
    { name: "newest_request_lower_ts", ...TEXT_PROGRESS },
    { name: "newest_segment_lower_ts", ...TEXT_PROGRESS },
    { name: "newest_segment_upper_ts", ...TEXT_PROGRESS },
  ],
  historyChecks: HISTORY_CHECKS,
  validator: [{
    name: "slack_channel_cursor_history_valid", args: "history jsonb", returns: "boolean", language: "sql",
    volatility: "i", strict: true, parallel: "s", security_definer: false, returns_set: false, leakproof: false,
    config: ["search_path=pg_catalog"],
  }],
};

/** Literal fixture identity and state. Nothing is generated except the scratch database's name. */
const TEAM_ID = "5a1b2c3d-4e5f-4a6b-8c7d-0e1f2a3b4c5d";
const WORKSPACE = "T0UPGRADE1";
const CHANNEL = "C0UPGRADE1";
const ROOT = "1718900200.000200";

describe("AM-F2 + AC-02 history/segment migration — direct populated pre-F2 upgrade (real Postgres)", () => {
  it(
    "MR-03 introduces history and segment columns on a populated pre-F2 table with one restart of the active lane, and replays exactly",
    async () => {
      const { loadSchema } = await import("@/scripts/pg-load-schema.mjs");
      const adminUrl = process.env.DATABASE_TEST_URL;
      if (!adminUrl) throw new Error("DATABASE_TEST_URL required: run through the isolated data-mechanics runner");
      const name = `slackhistory_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
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

      const c = new Client({ connectionString: url });
      await c.connect();
      try {
        await c.query("set time zone 'UTC'");
        await loadSchema({ cwd: process.cwd(), databaseUrl: url, logger: { log: () => {} } });

        // ── THE CATALOG READERS: catalogs only, never a possibly absent column. ──
        const catalog = async () => ({
          columns: (await c.query(
            `select a.attname as name, pg_catalog.format_type(a.atttypid, a.atttypmod) as type, a.attnotnull as not_null,
                    pg_catalog.pg_get_expr(d.adbin, d.adrelid) as default_expr,
                    a.attgenerated::text as generated, a.attidentity::text as identity
               from pg_catalog.pg_attribute a
               left join pg_catalog.pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
              where a.attrelid = 'public.slack_sync_channels'::regclass and a.attnum > 0 and not a.attisdropped
                and a.attname = any($1::text[])
              order by a.attname`, [NEW_COLUMNS]
          )).rows,
          historyChecks: (await c.query<{ conname: string }>(
            `select conname from pg_catalog.pg_constraint
              where conrelid = 'public.slack_sync_channels'::regclass and conname = any($1::text[])
              order by conname`, [HISTORY_CHECKS]
          )).rows.map((row) => row.conname),
          validator: (await c.query(
            `select p.proname as name, pg_catalog.pg_get_function_identity_arguments(p.oid) as args,
                    pg_catalog.format_type(p.prorettype, null) as returns, l.lanname as language,
                    p.provolatile::text as volatility, p.proisstrict as strict, p.proparallel::text as parallel,
                    p.prosecdef as security_definer, p.proretset as returns_set, p.proleakproof as leakproof,
                    p.proconfig as config
               from pg_catalog.pg_proc p
               join pg_catalog.pg_namespace n on n.oid = p.pronamespace
               join pg_catalog.pg_language l on l.oid = p.prolang
              where n.nspname = 'public' and p.proname = 'slack_channel_cursor_history_valid'`
          )).rows,
        });

        // ── FIXTURE DDL, this scratch database only: reconstruct the pre-F2 table. ──
        // A no-op today (nothing of it exists yet); once the mirror lands it removes exactly the
        // objects this contract adds, so the migration below meets a genuine pre-F2 table.
        for (const check of HISTORY_CHECKS) {
          await c.query(`alter table public.slack_sync_channels drop constraint if exists ${check}`);
        }
        await c.query(`alter table public.slack_sync_channels ${NEW_COLUMNS.map((column) => `drop column if exists ${column}`).join(", ")}`);
        await c.query(`drop function if exists public.slack_channel_cursor_history_valid(jsonb)`);
        expect(await catalog(), "fixture: the table is pre-F2 — none of the accepted objects exists before the migration").toEqual({
          columns: [], historyChecks: [], validator: [],
        });

        // ── THE POPULATED PRE-F2 STATE, every value literal. ──
        await c.query(`insert into teams (id, slug, name) values ($1, 'upgrade-team', 'Upgrade Team')`, [TEAM_ID]);
        await c.query(
          `insert into slack_sync_channels
             (team_id, workspace_id, channel_id, public_state, public_checked_at,
              newest_anchor_ts, newest_lower_ts, newest_cursor, newest_scan_generation,
              historical_anchor_ts, historical_cursor, historical_scan_generation, historical_oldest_seen_ts,
              historical_floor_reached, completed_lower_ts, completed_upper_ts, newest_catchup_upper_ts,
              metadata_attempt_owner, metadata_attempt_generation, claimed_lane, next_lane,
              lease_owner, lease_generation, lease_expires_at, due_at, attempts, last_error_code,
              last_read_at, created_at, updated_at)
           values ($1, $2, $3, 'public', '2026-01-01 00:00:00+00',
                   null, null, null, 0,
                   '1718900500.000000', 'legacy-cursor-1', 3, '1718900100.000100',
                   false, null, null, null,
                   null, 2, null, 'historical',
                   null, 7, null, '2026-01-02 00:00:00+00', 5, 'invocation_budget',
                   '2026-01-01 12:00:00+00', '2025-12-31 00:00:00+00', '2026-01-02 03:04:05+00')`,
          [TEAM_ID, WORKSPACE, CHANNEL]
        );
        await c.query(
          `insert into slack_sync_threads (team_id, workspace_id, channel_id, root_ts, due_at)
           values ($1, $2, $3, $4, '2026-01-02 00:00:00+00')`,
          [TEAM_ID, WORKSPACE, CHANNEL, ROOT]
        );
        const channelRow = async (): Promise<Record<string, unknown>> =>
          (await c.query<{ row: Record<string, unknown> }>(`select to_jsonb(s) as row from slack_sync_channels s where team_id = $1`, [TEAM_ID])).rows[0].row;
        const threadRows = async (): Promise<unknown[]> =>
          (await c.query<{ row: unknown }>(`select to_jsonb(t) as row from slack_sync_threads t where team_id = $1 order by root_ts`, [TEAM_ID])).rows.map((r) => r.row);
        const before = await channelRow();
        const threadsBefore = await threadRows();

        // ── THE MIGRATION, applied directly: the real file, read from disk. ──
        const migration = readFileSync(MIGRATION, "utf8");
        const notices: string[] = [];
        const onNotice = (notice: { message?: string }): void => {
          notices.push(notice.message ?? "");
        };
        c.on("notice", onNotice);
        await c.query(migration);
        c.removeListener("notice", onNotice);

        // ── THE CATALOG GATE. Today: a named mismatch, the comment-only file created nothing. ──
        expect(await catalog(), "the migration created every accepted history/segment column, both named history CHECKs and the exact validator").toEqual(EXPECTED_CATALOG);

        // ── ONE RESTART of the active historical lane; everything else unchanged. ──
        const after = await channelRow();
        const { updated_at: updatedBefore, ...beforeRest } = before;
        const { updated_at: updatedAfter, ...afterRest } = after;
        expect(afterRest, "union introduction: the active historical lane restarted once; the idle newest lane, the claim, the turn and every other column are as they were").toEqual({
          ...beforeRest,
          historical_cursor: null,
          historical_cursor_history: [],
          historical_scan_generation: 4,
          historical_oldest_seen_ts: null,
          historical_segment_lower_ts: null,
          historical_segment_upper_ts: null,
          historical_completed_segments_oldest_ts: null,
          newest_cursor_history: [],
          newest_request_lower_ts: null,
          newest_segment_lower_ts: null,
          newest_segment_upper_ts: null,
        });
        expect(updatedAfter, "the restarted row's updated_at moved off its seeded value").not.toEqual(updatedBefore);
        expect(await threadRows(), "the unrelated queued thread row is byte-identical").toEqual(threadsBefore);
        expect(notices, "the Slack block emitted no NOTICE or WARNING on introduction").toEqual([]);

        // ── REPLAY: the second execution changes nothing at all. ──
        c.on("notice", onNotice);
        await c.query(migration);
        c.removeListener("notice", onNotice);
        expect(await catalog(), "replay keeps the same catalog").toEqual(EXPECTED_CATALOG);
        expect(await channelRow(), "replay: the FULL row, updated_at included, is exactly as the first execution left it").toEqual(after);
        expect(await threadRows(), "replay: the thread row is still byte-identical").toEqual(threadsBefore);
        expect(notices, "the Slack block emitted no NOTICE or WARNING on replay").toEqual([]);
      } finally {
        await c.end().catch(() => {});
        const dropper = new Client({ connectionString: adminUrl });
        await dropper.connect();
        try {
          await dropper.query(`drop database if exists ${name} with (force)`);
        } finally {
          await dropper.end().catch(() => {});
        }
      }
    },
    SCRATCH_TIMEOUT
  );
});
