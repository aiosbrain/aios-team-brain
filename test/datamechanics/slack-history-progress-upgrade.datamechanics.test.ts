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
 * in disposable isolated databases (§9.3). Before seeding, it asserts that the table IS the pre-F2
 * table, exactly: every column with its type, nullability and default; every table constraint by
 * name, definition and validation state; and every public function and trigger owned by the table,
 * all against LITERAL expectations written out below, never read back from the catalog. A progress
 * helper or constraint the fixture failed to remove, or a lost pre-F2 CHECK, is a mismatch.
 *
 * ISOLATION. Before anything is created, the URL must be the isolated runner's shape: a loopback
 * host, a port other than the shared 5434 service, and the `app_test` database. Anything else is
 * refused with a static error that does not print the URL.
 *
 * THE ONE NARROW CASE (one row of MR-03 / F2-12, not either whole): one channel row whose HISTORICAL
 * lane is active — anchor, a saved cursor and an attempt-oldest — with no live claim, and whose NEWEST
 * lane is idle; plus one unrelated queued thread row. The row also carries a provisional catch-up top,
 * a metadata attempt owner and `next_lane = 'newest'`, so that their preservation is observable: an
 * implementation that forced the turn to the restarted lane without a claim would be caught. Applying the migration once is a UNION introduction (both histories
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
 * WHAT REMAINS for later packets, and is NOT claimed here. This case does not complete F2-12, DH-11
 * or any MR row. Deferred, explicitly:
 *  - MR-02: mirror byte-parity, from-zero/upgraded fingerprints, dump/restore, and the EXACT
 *    definitions and validation state of the new history and progress CHECKs (this case checks only
 *    that the two named history CHECKs exist, and the PRE-F2 constraints exactly);
 *  - MR-03 / F2-12 edges:
 *    · a RESTARTED lane carrying a live claim with a nonnull cursor, where the claim must be
 *      invalidated (lease cleared, lease generation incremented, turn set to that lane), including
 *      the omitted-lease-invalidation mutant;
 *    · an expired claim;
 *    · a cursor-null live claim (an in-flight first page);
 *    · an unaffected opposite-lane live claim;
 *    · an anchored lane with a null cursor and no claim;
 *    · staged-snapshot, published-item and ledger evidence rows (only one queued thread row is here);
 *    · history-only and segment-only introduction, one-lane introduction, both lanes active;
 *    · mirror-only execution and both execution orders;
 *    · replay after initialized segment progress, and with maximum histories;
 *  - MR-04: static failures, rollback, cancellation and concurrency;
 *  - MR-05: the existing structural sweeps;
 *  - the named DH-11 source-fences tests;
 *  - MR-06.
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

// ── THE PRE-F2 TABLE, written out from `postgres/schema.sql` as it stood before AM-F2 ──

/** One column's catalog facts. `generated` and `identity` are empty for an ordinary column. */
const col = (name: string, type: string, notNull: boolean, defaultExpr: string | null) =>
  ({ name, type, not_null: notNull, default_expr: defaultExpr, generated: "", identity: "" });
const TSTZ = "timestamp with time zone";
/** Every column of the pre-F2 table, in name order. */
const PRE_F2_COLUMNS = [
  col("attempts", "integer", true, "0"),
  col("binding_config_revision", "text", false, null),
  col("binding_integration_id", "uuid", false, null),
  col("channel_id", "text", true, null),
  col("claimed_lane", "text", false, null),
  col("completed_lower_ts", "text", false, null),
  col("completed_upper_ts", "text", false, null),
  col("created_at", TSTZ, true, "now()"),
  col("due_at", TSTZ, true, "now()"),
  col("historical_anchor_ts", "text", false, null),
  col("historical_cursor", "text", false, null),
  col("historical_floor_reached", "boolean", true, "false"),
  col("historical_oldest_seen_ts", "text", false, null),
  col("historical_scan_generation", "bigint", true, "0"),
  col("id", "uuid", true, "gen_random_uuid()"),
  col("last_error_code", "text", false, null),
  col("last_read_at", TSTZ, false, null),
  col("lease_expires_at", TSTZ, false, null),
  col("lease_generation", "bigint", true, "0"),
  col("lease_owner", "text", false, null),
  col("metadata_attempt_generation", "bigint", true, "0"),
  col("metadata_attempt_owner", "text", false, null),
  col("newest_anchor_ts", "text", false, null),
  col("newest_catchup_upper_ts", "text", false, null),
  col("newest_cursor", "text", false, null),
  col("newest_lower_ts", "text", false, null),
  col("newest_scan_generation", "bigint", true, "0"),
  col("next_lane", "text", true, "'newest'::text"),
  col("public_checked_at", TSTZ, false, null),
  col("public_state", "text", true, "'unknown'::text"),
  col("team_id", "uuid", true, null),
  col("updated_at", TSTZ, true, "now()"),
  col("workspace_id", "text", true, null),
];

/** PostgreSQL's own rendering (`pg_get_constraintdef`) of the pre-F2 constraints, built from literals. */
const nonBlankBoundedCursor = (column: string): string =>
  `CHECK (((${column} IS NULL) OR ((btrim(${column}) <> ''::text) AND (length(${column}) <= 1024))))`;
const nonNegative = (column: string): string => `CHECK ((${column} >= 0))`;
const TS_COLUMNS = [
  "newest_anchor_ts", "newest_lower_ts", "historical_anchor_ts", "historical_oldest_seen_ts",
  "completed_lower_ts", "completed_upper_ts", "newest_catchup_upper_ts",
];
const TS_SYNTAX = `CHECK ((${TS_COLUMNS.map((column) => `((${column} IS NULL) OR (${column} ~ '^[0-9]+[.][0-9]{1,6}$'::text))`).join(" AND ")}))`;
/**
 * Every pre-F2 table constraint, in name order, VALIDATED. Not-null constraints (which recent
 * PostgreSQL versions also list in `pg_constraint`) are excluded from this list by query; the column
 * list above states nullability.
 */
const PRE_F2_CONSTRAINTS = [
  ["slack_sync_channels_attempts_check", nonNegative("attempts")],
  ["slack_sync_channels_binding_codec", "CHECK (((binding_integration_id IS NULL) = (binding_config_revision IS NULL)))"],
  ["slack_sync_channels_binding_config_revision_check", "CHECK ((binding_config_revision ~ '^[0-9a-f]{64}$'::text))"],
  ["slack_sync_channels_binding_integration_id_fkey", "FOREIGN KEY (binding_integration_id) REFERENCES integrations(id) ON DELETE SET NULL"],
  ["slack_sync_channels_channel_id_check", "CHECK ((channel_id ~ '^[A-Za-z0-9]+$'::text))"],
  ["slack_sync_channels_claimed_lane_check", "CHECK (((claimed_lane IS NULL) OR (claimed_lane = ANY (ARRAY['newest'::text, 'historical'::text]))))"],
  ["slack_sync_channels_historical_cursor_check", nonBlankBoundedCursor("historical_cursor")],
  ["slack_sync_channels_historical_scan_generation_check", nonNegative("historical_scan_generation")],
  ["slack_sync_channels_interval_codec", "CHECK (((completed_lower_ts IS NULL) = (completed_upper_ts IS NULL)))"],
  ["slack_sync_channels_last_error_code_check", "CHECK (((last_error_code IS NULL) OR (last_error_code ~ '^[a-z][a-z0-9_]{0,39}$'::text)))"],
  ["slack_sync_channels_lease_codec", "CHECK ((((lease_owner IS NULL) = (lease_expires_at IS NULL)) AND ((lease_owner IS NULL) = (claimed_lane IS NULL))))"],
  ["slack_sync_channels_lease_generation_check", nonNegative("lease_generation")],
  ["slack_sync_channels_lease_owner_check", "CHECK (((lease_owner IS NULL) OR ((length(lease_owner) >= 8) AND (length(lease_owner) <= 128) AND (lease_owner !~ '[[:space:]]'::text))))"],
  ["slack_sync_channels_lease_owner_key", "UNIQUE (lease_owner)"],
  ["slack_sync_channels_metadata_attempt_generation_check", nonNegative("metadata_attempt_generation")],
  ["slack_sync_channels_newest_cursor_check", nonBlankBoundedCursor("newest_cursor")],
  ["slack_sync_channels_newest_scan_generation_check", nonNegative("newest_scan_generation")],
  ["slack_sync_channels_next_lane_check", "CHECK ((next_lane = ANY (ARRAY['newest'::text, 'historical'::text])))"],
  ["slack_sync_channels_pkey", "PRIMARY KEY (id)"],
  ["slack_sync_channels_public_codec", "CHECK (((public_state = 'unknown'::text) = (public_checked_at IS NULL)))"],
  ["slack_sync_channels_public_state_check", "CHECK ((public_state = ANY (ARRAY['unknown'::text, 'public'::text, 'private'::text, 'unverifiable'::text])))"],
  ["slack_sync_channels_team_id_fkey", "FOREIGN KEY (team_id) REFERENCES teams(id) ON DELETE CASCADE"],
  ["slack_sync_channels_team_id_workspace_id_channel_id_key", "UNIQUE (team_id, workspace_id, channel_id)"],
  ["slack_sync_channels_ts_syntax", TS_SYNTAX],
  ["slack_sync_channels_workspace_id_check", "CHECK ((workspace_id ~ '^[A-Za-z0-9]+$'::text))"],
].map(([name, definition]) => ({ name, definition, validated: true }));

/**
 * Every public function this table owns, by its naming families (`slack_sync_channels_*`,
 * `slack_channel_*`), with its whole body. Before F2 that is the deleted-binding trigger function
 * only; a progress or history helper left behind by the fixture would appear here.
 */
const PRE_F2_FUNCTIONS = [{
  name: "slack_sync_channels_clear_deleted_binding", args: "", returns: "trigger", language: "plpgsql",
  volatility: "v", strict: false, parallel: "u", security_definer: false, returns_set: false, leakproof: false,
  config: null,
  source: "\nbegin\n  if new.binding_integration_id is null then\n    new.binding_config_revision := null;\n  end if;\n  return new;\nend;\n",
}];
/** Every user trigger on the table. */
const PRE_F2_TRIGGERS = [{ name: "slack_sync_channels_clear_deleted_binding", function: "slack_sync_channels_clear_deleted_binding", enabled: "O" }];

/**
 * The isolated runner's URL shape, and nothing else: a loopback host, a port that is present and is
 * not the shared 5434 service, and the `app_test` database. The error never prints the URL.
 */
function requireIsolatedTestUrl(raw: string | undefined): string {
  const refuse = (): never => {
    throw new Error("refusing to run: DATABASE_TEST_URL is not the isolated data-mechanics runner's database");
  };
  if (!raw) return refuse();
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return refuse();
  }
  const loopback = ["localhost", "127.0.0.1", "[::1]", "::1"].includes(parsed.hostname);
  if (!loopback || parsed.port === "" || parsed.port === "5434" || parsed.pathname !== "/app_test") return refuse();
  return raw;
}

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
      // Refused BEFORE any connection or database creation.
      const adminUrl = requireIsolatedTestUrl(process.env.DATABASE_TEST_URL);
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
        expect(await catalog(), "fixture: none of the accepted objects exists before the migration").toEqual({
          columns: [], historyChecks: [], validator: [],
        });

        // ── THE EXACT PRE-F2 TABLE, against literal expectations: nothing extra, nothing lost. ──
        const preF2Catalog = async () => ({
          columns: (await c.query(
            `select a.attname as name, pg_catalog.format_type(a.atttypid, a.atttypmod) as type, a.attnotnull as not_null,
                    pg_catalog.pg_get_expr(d.adbin, d.adrelid) as default_expr,
                    a.attgenerated::text as generated, a.attidentity::text as identity
               from pg_catalog.pg_attribute a
               left join pg_catalog.pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
              where a.attrelid = 'public.slack_sync_channels'::regclass and a.attnum > 0 and not a.attisdropped
              order by a.attname`
          )).rows,
          constraints: (await c.query(
            `select conname as name, pg_catalog.pg_get_constraintdef(oid) as definition, convalidated as validated
               from pg_catalog.pg_constraint
              where conrelid = 'public.slack_sync_channels'::regclass and contype <> 'n'
              order by conname`
          )).rows,
          functions: (await c.query(
            `select p.proname as name, pg_catalog.pg_get_function_identity_arguments(p.oid) as args,
                    pg_catalog.format_type(p.prorettype, null) as returns, l.lanname as language,
                    p.provolatile::text as volatility, p.proisstrict as strict, p.proparallel::text as parallel,
                    p.prosecdef as security_definer, p.proretset as returns_set, p.proleakproof as leakproof,
                    p.proconfig as config, p.prosrc as source
               from pg_catalog.pg_proc p
               join pg_catalog.pg_namespace n on n.oid = p.pronamespace
               join pg_catalog.pg_language l on l.oid = p.prolang
              where n.nspname = 'public'
                and (p.proname like 'slack\\_sync\\_channels\\_%' or p.proname like 'slack\\_channel\\_%')
              order by p.proname, pg_catalog.pg_get_function_identity_arguments(p.oid)`
          )).rows,
          triggers: (await c.query(
            `select t.tgname as name, p.proname as function, t.tgenabled::text as enabled
               from pg_catalog.pg_trigger t
               join pg_catalog.pg_proc p on p.oid = t.tgfoid
              where t.tgrelid = 'public.slack_sync_channels'::regclass and not t.tgisinternal
              order by t.tgname`
          )).rows,
        });
        expect(await preF2Catalog(), "fixture: the reconstructed table is EXACTLY the pre-F2 table — columns, constraints, owned functions and triggers").toEqual({
          columns: PRE_F2_COLUMNS, constraints: PRE_F2_CONSTRAINTS, functions: PRE_F2_FUNCTIONS, triggers: PRE_F2_TRIGGERS,
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
                   false, null, null, '1718900400.000000',
                   'metadata-owner-1', 2, null, 'newest',
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
        // Nonvacuity: the values whose preservation is asserted below are really there.
        expect({
          newest_catchup_upper_ts: before.newest_catchup_upper_ts, metadata_attempt_owner: before.metadata_attempt_owner,
          next_lane: before.next_lane, claimed_lane: before.claimed_lane, lease_owner: before.lease_owner,
        }, "fixture: a provisional catch-up top, a metadata owner, and an unclaimed row whose turn is NOT the restarted lane").toEqual({
          newest_catchup_upper_ts: "1718900400.000000", metadata_attempt_owner: "metadata-owner-1",
          next_lane: "newest", claimed_lane: null, lease_owner: null,
        });

        // ── THE MIGRATION, applied directly: the real file, read from disk. ──
        const migration = readFileSync(MIGRATION, "utf8");
        const notices: string[] = [];
        const onNotice = (notice: { message?: string }): void => {
          notices.push(notice.message ?? "");
        };
        /** One execution of the migration with its notices captured; the listener never outlives it. */
        const applyMigration = async (): Promise<void> => {
          c.on("notice", onNotice);
          try {
            await c.query(migration);
          } finally {
            c.removeListener("notice", onNotice);
          }
        };
        await applyMigration();

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
        await applyMigration();
        expect(await catalog(), "replay keeps the same catalog").toEqual(EXPECTED_CATALOG);
        expect(await channelRow(), "replay: the FULL row, updated_at included, is exactly as the first execution left it").toEqual(after);
        expect(await threadRows(), "replay: the thread row is still byte-identical").toEqual(threadsBefore);
        expect(notices, "the Slack block emitted no NOTICE or WARNING on replay").toEqual([]);
      } finally {
        await c.end().catch(() => {});
        // Cleanup never replaces the primary failure: every step is caught, as the repository precedent does.
        const dropper = new Client({ connectionString: adminUrl });
        await dropper.connect().catch(() => {});
        await dropper.query(`drop database if exists ${name} with (force)`).catch(() => {});
        await dropper.end().catch(() => {});
      }
    },
    SCRATCH_TIMEOUT
  );
});
