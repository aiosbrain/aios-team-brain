import { readFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { describe, expect, it } from "vitest";
import { fingerprint } from "../../scripts/schema-fingerprint.mjs";
import { createIsolatedScratchDatabase } from "./slack-history-isolated-url";

/**
 * AIO-1170 AM-F2 + AC-02 deep history — the numbered migration's direct, populated upgrade
 * (accepted consolidated contract `aio1170-am-f2-deep-history-consolidated-accepted-spec-migration-v1-20261023.md`,
 * §3.1, §4, §9, §9.3 MR-02/MR-03/MR-05, §10 DH-11, §10.1 F2-12, §12).
 *
 * TWO DESCRIBES.
 *  - The first, RED PACKET 2's case, was written against the comment-only scaffold. It is GREEN
 *    since the reserved migration `postgres/migrations/20261023120000_slack_channel_history_segments.sql`
 *    gained its executable block. It applies that migration to a populated pre-F2 table and
 *    requires the catalog it creates. Its catalog readers query only `pg_attribute`,
 *    `pg_constraint` and `pg_proc`.
 *  - The second, MR-03 ENTRYPOINT ORDER (packet 6), is described after the first case's notes
 *    below.
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
 * ISOLATION. Before anything is created, the shared guard (`./slack-history-isolated-url.ts`, tested
 * by `test/slack-history-isolated-url.test.ts`) requires one of two runner shapes for the `app_test`
 * database:
 *  - the isolated local runner: a loopback host on an explicit port other than the shared 5434
 *    service;
 *  - CI's service container: exactly `postgres:5432`, and only under `GITHUB_ACTIONS=true`.
 * Anything else is refused with a static error that does not print the URL.
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
 * MR-03 STATEMENT ORDER (packet 6, the second describe). This is STATEMENT-LEVEL mirror-only
 * execution and statement orders: the MIRROR entrypoint is only the ONE marked DO statement of
 * `postgres/schema.sql`, never the whole file. It is extracted between its unique
 * `slack-channel-history-segments-upgrade` marker pair, and used only after it is proved
 * byte-identical to the migration's own marked statement.
 *
 * Four INDEPENDENT disposable databases are each built by the real loader, reconstructed to the
 * exact pre-F2 table, and seeded with the SAME literal fixture:
 *  - explicit ids, `created_at`, `due_at` and a seeded `updated_at`;
 *  - three restarted lanes (no claim; both lanes with a live newest claim; a cursor-null live
 *    claim) and one idle row;
 *  - two queued thread rows.
 * The four statement orders are migration-only, statement-level mirror-only, mirror
 * statement→migration and migration→mirror statement. In each
 * database:
 *  - the first entrypoint commits notice-free with exact literal restart/fence facts. `updated_at`
 *    moves ONLY on the three restarted rows; the idle row and both thread rows stay exactly as
 *    seeded;
 *  - the second entrypoint and replays of both compare COMPLETE rows exactly (`updated_at`
 *    included), and the Slack catalog unchanged;
 *  - identical literal progress writes then initialize segments and store MAXIMUM histories (1,000
 *    entries, exactly 1,048,576 bytes) on both lanes, stamping every row with a literal
 *    `updated_at`;
 *  - replays of both entrypoints again leave complete rows and the catalog exact.
 * ACROSS databases, every order must match migration-only:
 *  - the Slack catalog (repository fingerprint plus exact CHECK/validator reads);
 *  - every channel and thread row. The ONLY exception, after introduction, is a restarted row's
 *    clock-varying `updated_at`. After the progress writes, complete rows are compared, with no
 *    exception at all.
 * Row content is compared only by md5 digest, so no cursor or history prints.
 *
 * SIBLING RESPONSIBILITIES, not duplicated here. `slack-history-progress-conflicts` owns the
 * migration-path MR-03 / F2-12 edges:
 *  - the union restart's claim/idle edges with planted metadata;
 *  - the history-only one-lane introduction that preserves the opposite live claim;
 *  - progress and maximum-history migration replay;
 *  - every catalog and state conflict.
 * `slack-history-progress-catalog` owns MR-02.
 *
 * WHAT REMAINS for later packets, and is NOT claimed here. Neither describe completes F2-12, DH-11
 * or any MR row. Deferred, explicitly. Items since covered by the siblings or by the order
 * describe above are marked as such.
 *  - MR-02: NOT claimed by this case (it checks only that the two named history CHECKs exist, and
 *    the PRE-F2 constraints exactly). Packet 5 since covered it in siblings:
 *    · `slack-history-progress-conflicts`: exact CHECK definitions and validation, and mirror byte
 *      parity;
 *    · `slack-history-progress-catalog`: from-zero/loader fingerprints, a real dump/restore and the
 *      replays (the Astra-approved MR-02 placement amendment).
 *  - MR-03 / F2-12, COVERED since:
 *    · in `slack-history-progress-conflicts`: a restarted lane's live claim fenced, an expired
 *      claim, a cursor-null live claim, an anchored null-cursor lane with no claim, both lanes
 *      active, the history-only one-lane introduction with its unaffected opposite live claim,
 *      and migration replay after progress and maximum histories;
 *    · in the statement-order describe here: statement-level mirror-only execution, both
 *      statement orders, and statement-order replay after progress and maximum histories, for the
 *      populated UNION introduction.
 *  - MR-03 / F2-12, STILL OPEN:
 *    · a COMMITTING segment-only introduction on an F2-only SCHEMA fixture;
 *    · the statement-level mirror-only and statement-order proofs repeated for the history-only,
 *      segment-only and one-lane introduction states, which only the union introduction has here;
 *    · staged-snapshot, published-item and ledger evidence rows (only queued thread rows here);
 *    · the omitted-lease-invalidation mutant, which is not measured;
 *    · the WHOLE `schema.sql` file as the mirror entrypoint: HELD, since only its marked statement
 *      runs here;
 *    · a full loader/`schema.sql` replay over the POPULATED, progressed rows of these order
 *      databases (only the two marked statements replay here).
 *  - MR-04: the refusals still listed in `slack-history-progress-conflicts`' WHAT REMAINS ledger
 *    (its static refusal matrix is not complete), plus cancellation, real concurrent sessions and
 *    retry after a later migration fails;
 *  - MR-05: the existing structural sweeps;
 *  - DH-11: the §9 named source-fences/upgrade tests, the legacy three-column rename, and maximum
 *    histories through unrelated writers;
 *  - MR-06 (held until PR743 staging).
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
      // The shared guard refuses BEFORE any connection or database creation (slack-history-isolated-url.ts).
      const name = `slackhistory_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
      const { adminUrl, url } = await createIsolatedScratchDatabase(name);

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
                   false, null, null, '1718900600.000000',
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
          newest_catchup_upper_ts: "1718900600.000000", metadata_attempt_owner: "metadata-owner-1",
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

// ── MR-03 STATEMENT ORDER (packet 6): migration-only, statement-level mirror-only, and both statement orders ──

const ORDER_TIMEOUT = 900_000;
const SCHEMA_PATH = join(process.cwd(), "postgres", "schema.sql");
const MARKER = "slack-channel-history-segments-upgrade";
const occurrences = (text: string, needle: string): number => text.split(needle).length - 1;
/** The text strictly between the dedicated begin marker line and end marker line, or "" if absent. */
function markedStatement(text: string): string {
  const begin = `-- ${MARKER}:begin\n`;
  const end = `\n-- ${MARKER}:end`;
  const start = text.indexOf(begin);
  const stop = text.indexOf(end);
  return start >= 0 && stop > start ? text.slice(start + begin.length, stop) : "";
}

/** Literal fixture identity, identical in every order database. Nothing here is generated. */
const ORDER_TEAM_ID = "7e8f9a0b-1c2d-4e3f-8a4b-5c6d7e8f9a0b";
const ORDER_WORKSPACE = "T0ORDER001";
const ORDER_SEEDED_UPDATED_AT = "2026-01-02 03:04:05+00";
const ORDER_PROGRESS_UPDATED_AT = "2026-02-01 00:00:00+00";
/**
 * Four channels, with every non-constant default (`id`, `created_at`, `due_at`, `updated_at`) set
 * explicitly:
 *  - 0001: an active historical lane with a cursor and an attempt-oldest, and no claim;
 *  - 0002: both lanes active, with a live newest claim;
 *  - 0003: idle;
 *  - 0004: an anchored, cursor-null historical lane with a live claim (an in-flight first page).
 */
const ORDER_CHANNELS: Array<Record<string, unknown>> = [
  {
    id: "0f000000-0000-4000-8000-000000000001", channel_id: "C0ORDER0001", public_state: "public", public_checked_at: "2026-01-01 00:00:00+00",
    historical_anchor_ts: "1718900500.000000", historical_cursor: "syn-order-h-1", historical_scan_generation: 3,
    historical_oldest_seen_ts: "1718900100.000100", newest_catchup_upper_ts: "1718900600.000000",
    metadata_attempt_owner: "metadata-order-1", metadata_attempt_generation: 2, next_lane: "newest", lease_generation: 7,
    attempts: 5, last_error_code: "invocation_budget", last_read_at: "2026-01-01 12:00:00+00",
    due_at: "2026-01-02 00:00:00+00", created_at: "2025-12-31 00:00:00+00",
  },
  {
    id: "0f000000-0000-4000-8000-000000000002", channel_id: "C0ORDER0002",
    newest_anchor_ts: "1718900800.000000", newest_lower_ts: "1718900700.000000", newest_cursor: "syn-order-n-2", newest_scan_generation: 5,
    historical_anchor_ts: "1718900500.000000", historical_cursor: "syn-order-h-2", historical_scan_generation: 4,
    historical_oldest_seen_ts: "1718900200.000000", completed_lower_ts: "1718899000.000000", completed_upper_ts: "1718899100.000000",
    claimed_lane: "newest", lease_owner: "lease-order-r2", lease_expires_at: "2030-01-01 00:00:00+00", lease_generation: 21,
    next_lane: "historical", attempts: 2, due_at: "2026-01-05 00:00:00+00", created_at: "2025-12-30 00:00:00+00",
  },
  {
    id: "0f000000-0000-4000-8000-000000000003", channel_id: "C0ORDER0003", lease_generation: 4, next_lane: "historical",
    attempts: 1, due_at: "2026-01-06 00:00:00+00", created_at: "2025-12-29 00:00:00+00",
  },
  {
    id: "0f000000-0000-4000-8000-000000000004", channel_id: "C0ORDER0004", historical_anchor_ts: "1718900500.000000",
    historical_scan_generation: 2, claimed_lane: "historical", lease_owner: "lease-order-r4", lease_expires_at: "2030-01-01 00:00:00+00",
    lease_generation: 11, next_lane: "newest", due_at: "2026-01-07 00:00:00+00", created_at: "2025-12-28 00:00:00+00",
  },
].map((row) => ({ team_id: ORDER_TEAM_ID, workspace_id: ORDER_WORKSPACE, updated_at: ORDER_SEEDED_UPDATED_AT, ...row }));
/** Two unrelated queued thread rows (related evidence), every non-constant default explicit. */
const ORDER_THREADS: Array<Record<string, unknown>> = [
  { id: "0f000000-0000-4000-8000-0000000000a1", channel_id: "C0ORDER0001", root_ts: "1718900200.000200", attempts: 1,
    due_at: "2026-01-03 00:00:00+00", created_at: "2025-12-31 01:00:00+00", updated_at: "2026-01-02 03:04:05+00" },
  { id: "0f000000-0000-4000-8000-0000000000a2", channel_id: "C0ORDER0003", root_ts: "1718900300.000300", attempts: 0,
    due_at: "2026-01-04 00:00:00+00", created_at: "2025-12-31 02:00:00+00", updated_at: "2026-01-02 03:04:05+00" },
].map((row) => ({ team_id: ORDER_TEAM_ID, workspace_id: ORDER_WORKSPACE, ...row }));
/** The rows the one-time union restart touches (their `updated_at` legitimately becomes the DB clock). */
const ORDER_RESTARTED = new Set(["C0ORDER0001", "C0ORDER0002", "C0ORDER0004"]);
/**
 * Each row's exact restart/fence facts after the FIRST entrypoint, in every order database:
 * restarted lanes increment their generation once; a claim on a restarted lane is fenced; the idle
 * row is untouched, `updated_at` included.
 */
const ORDER_RESTART_FACTS = [
  { channel_id: "C0ORDER0001", newest_generation: 0, historical_generation: 4, lease_generation: 7, next_lane: "newest", claimed_lane: null, lanes_cleared: true, updated_at_seeded: false },
  { channel_id: "C0ORDER0002", newest_generation: 6, historical_generation: 5, lease_generation: 22, next_lane: "newest", claimed_lane: null, lanes_cleared: true, updated_at_seeded: false },
  { channel_id: "C0ORDER0003", newest_generation: 0, historical_generation: 0, lease_generation: 4, next_lane: "historical", claimed_lane: null, lanes_cleared: true, updated_at_seeded: true },
  { channel_id: "C0ORDER0004", newest_generation: 0, historical_generation: 3, lease_generation: 12, next_lane: "historical", claimed_lane: null, lanes_cleared: true, updated_at_seeded: false },
];

/**
 * A maximum accepted history (§3.1). It has 1,000 distinct valid entries that PostgreSQL's jsonb
 * text form (`["a", "b"]`) serializes as EXACTLY 1,048,576 bytes. Each entry is a 4-byte ASCII id
 * plus U+4E00 padding (3 UTF-8 bytes, 1 UTF-16 unit): 576 entries of 1,045 bytes and 424 of 1,044.
 * So 2 + 1,044,576 + 2,000 + 1,998 = 1,048,576. This is the same construction as the conflicts
 * suite's, kept local so this file stays self-contained.
 */
function orderMaxHistory(prefix: string): string[] {
  const entries: string[] = [];
  for (let i = 0; i < 1000; i += 1) {
    const id = `${prefix}${String(i).padStart(3, "0")}`;
    entries.push(i < 576 ? id + "一".repeat(347) : `${id}${"一".repeat(346)}aa`);
  }
  return entries;
}
const jsonbTextBytes = (entries: string[]): number =>
  2 + entries.reduce((sum, entry) => sum + Buffer.byteLength(entry, "utf8") + 2, 0) + 2 * (entries.length - 1);

/** A fixture statement whose failure reports only SQLSTATE and constraint: never a failing-row DETAIL. */
async function orderFixture(client: Client, sql: string, params: unknown[] = []): Promise<void> {
  try {
    await client.query(sql, params);
  } catch (error) {
    const e = (error ?? {}) as { code?: unknown; constraint?: unknown };
    throw new Error(`order fixture statement failed (SQLSTATE ${String(e.code)}${e.constraint ? `, constraint ${String(e.constraint)}` : ""})`);
  }
}
async function insertLiteralRow(client: Client, table: string, row: Record<string, unknown>): Promise<void> {
  const columns = Object.keys(row);
  await orderFixture(client,
    `insert into public.${table} (${columns.join(", ")}) values (${columns.map((_, i) => `$${i + 1}`).join(", ")})`,
    Object.values(row));
}

/** The pre-F2 table's full inventory, read exactly as the existing case reads it (literal oracle above). */
async function preF2Inventory(client: Client) {
  return {
    columns: (await client.query(
      `select a.attname as name, pg_catalog.format_type(a.atttypid, a.atttypmod) as type, a.attnotnull as not_null,
              pg_catalog.pg_get_expr(d.adbin, d.adrelid) as default_expr,
              a.attgenerated::text as generated, a.attidentity::text as identity
         from pg_catalog.pg_attribute a
         left join pg_catalog.pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
        where a.attrelid = 'public.slack_sync_channels'::regclass and a.attnum > 0 and not a.attisdropped
        order by a.attname`
    )).rows,
    constraints: (await client.query(
      `select conname as name, pg_catalog.pg_get_constraintdef(oid) as definition, convalidated as validated
         from pg_catalog.pg_constraint
        where conrelid = 'public.slack_sync_channels'::regclass and contype <> 'n'
        order by conname`
    )).rows,
    functions: (await client.query(
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
    triggers: (await client.query(
      `select t.tgname as name, p.proname as function, t.tgenabled::text as enabled
         from pg_catalog.pg_trigger t
         join pg_catalog.pg_proc p on p.oid = t.tgfoid
        where t.tgrelid = 'public.slack_sync_channels'::regclass and not t.tgisinternal
        order by t.tgname`
    )).rows,
  };
}

/**
 * Slack catalog identity across databases:
 *  - every repository-fingerprint line (`scripts/schema-fingerprint.mjs`) whose identity starts
 *    with `slack_`, or that is a function whose name contains `slack_`;
 *  - plus whitespace-exact reads of the four named CHECKs and the validator.
 */
async function slackCatalog(client: Client) {
  const lines = ((await fingerprint(client)) as string[]).filter((line) => {
    const [kind = "", ident = ""] = line.split("\t");
    return ident.startsWith("slack_") || (kind === "function" && ident.slice(0, ident.indexOf("(")).includes("slack_"));
  });
  return {
    lines,
    checks: (await client.query(
      `select conname as name, pg_catalog.pg_get_constraintdef(oid) as definition, convalidated as validated
         from pg_catalog.pg_constraint
        where conrelid = 'public.slack_sync_channels'::regclass and conname = any($1::text[]) order by conname collate "C"`,
      [["slack_sync_channels_historical_cursor_history_check", "slack_sync_channels_historical_progress_check",
        "slack_sync_channels_newest_cursor_history_check", "slack_sync_channels_newest_progress_check"]]
    )).rows,
    validator: (await client.query(
      `select p.proconfig as config, p.provolatile::text as volatility, p.proisstrict as strict, p.proparallel::text as parallel,
              p.prosecdef as security_definer, p.proleakproof as leakproof, p.prosrc as source
         from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname = 'slack_channel_cursor_history_valid'`
    )).rows,
  };
}

/**
 * Every channel and thread row, digested (md5 only, so no cursor or history can print):
 *  - `full`: the whole row, `updated_at` included;
 *  - `withoutUpdatedAt`: the whole row minus ONLY `updated_at`;
 *  - `preF2Part`: the whole row minus the eight introduced columns (for the before/after check of
 *    rows the restart must not touch).
 */
async function orderEvidence(client: Client) {
  return {
    channels: (await client.query<{ channel_id: string; full_row: string; without_updated_at: string; pre_f2_part: string }>(
      `select channel_id, pg_catalog.md5(pg_catalog.to_jsonb(s)::text) as full_row,
              pg_catalog.md5((pg_catalog.to_jsonb(s) - 'updated_at')::text) as without_updated_at,
              pg_catalog.md5((pg_catalog.to_jsonb(s) - $1::text[])::text) as pre_f2_part
         from public.slack_sync_channels s order by channel_id collate "C"`, [NEW_COLUMNS]
    )).rows,
    threads: (await client.query<{ root_ts: string; full_row: string }>(
      `select root_ts, pg_catalog.md5(pg_catalog.to_jsonb(t)::text) as full_row
         from public.slack_sync_threads t order by root_ts collate "C"`
    )).rows,
  };
}
type OrderEvidence = Awaited<ReturnType<typeof orderEvidence>>;
/** Complete rows, compared exactly (within one database). */
const exactRows = (evidence: OrderEvidence) => ({
  channels: evidence.channels.map((row) => ({ channel_id: row.channel_id, full_row: row.full_row })),
  threads: evidence.threads,
});
/**
 * The cross-database logical view: complete rows, except that a RESTARTED channel drops ONLY its
 * clock-varying `updated_at`. That exception is independently justified per database by
 * ORDER_RESTART_FACTS.
 */
const logicalRows = (evidence: OrderEvidence) => ({
  channels: evidence.channels.map((row) => ({
    channel_id: row.channel_id, digest: ORDER_RESTARTED.has(row.channel_id) ? row.without_updated_at : row.full_row,
  })),
  threads: evidence.threads,
});

type OrderEntry = "migration" | "mirror";
type OrderRun = { introducedLogical: unknown; introducedCatalog: unknown; progressedRows: unknown; progressedCatalog: unknown };

describe("AM-F2 + AC-02 history/segment block — MR-03 statement order: migration-only, statement-level mirror-only, mirror statement→migration, migration→mirror statement (real Postgres)", () => {
  it(
    "MR-03 every statement order reaches the same Slack catalog and rows; each second execution and replay is exact, including after progress and maximum histories",
    async () => {
      const { loadSchema } = await import("@/scripts/pg-load-schema.mjs");
      const migrationSql = readFileSync(MIGRATION, "utf8");
      const schemaSql = readFileSync(SCHEMA_PATH, "utf8");
      const migrationStatement = markedStatement(migrationSql);
      const mirrorStatement = markedStatement(schemaSql);
      // The MIRROR entrypoint is the exact marked statement of schema.sql, used only after it is
      // proved byte-identical to the migration's own marked statement.
      expect({
        markers: [occurrences(migrationSql, `${MARKER}:begin`), occurrences(migrationSql, `${MARKER}:end`),
          occurrences(schemaSql, `${MARKER}:begin`), occurrences(schemaSql, `${MARKER}:end`)],
        oneStatement: mirrorStatement.startsWith("do $slack_channel_history_segments$\n")
          && mirrorStatement.endsWith("\nend\n$slack_channel_history_segments$;"),
        dollarTagCount: occurrences(mirrorStatement, "$slack_channel_history_segments$"),
        identical: mirrorStatement.length > 0 && mirrorStatement === migrationStatement,
      }, "the mirror entrypoint is schema.sql's ONE marked DO statement, byte-identical to the migration's").toEqual({
        markers: [1, 1, 1, 1], oneStatement: true, dollarTagCount: 2, identical: true,
      });
      const sqlFor = (entry: OrderEntry): string => (entry === "migration" ? migrationSql : mirrorStatement);

      // Non-vacuity of the maximum histories, by the independent byte oracle.
      const newestMax = orderMaxHistory("n");
      const historicalMax = orderMaxHistory("h");
      expect({ newest: [newestMax.length, jsonbTextBytes(newestMax)], historical: [historicalMax.length, jsonbTextBytes(historicalMax)] },
        "fixture: both maximum histories are 1,000 entries of exactly 1,048,576 serialized bytes").toEqual({
        newest: [1000, 1048576], historical: [1000, 1048576],
      });

      const created: Array<{ adminUrl: string; name: string }> = [];
      const runs: Record<string, OrderRun> = {};
      try {
        for (const [label, first, second] of [
          ["migration_only", "migration", "migration"],
          ["mirror_only", "mirror", "mirror"],
          ["mirror_then_migration", "mirror", "migration"],
          ["migration_then_mirror", "migration", "mirror"],
        ] as Array<[string, OrderEntry, OrderEntry]>) {
          const name = `slackorder_${label}_${randomUUID().replace(/-/g, "").slice(0, 8)}`;
          // The shared guard refuses BEFORE any connection or database creation.
          const scratch = await createIsolatedScratchDatabase(name);
          created.push({ adminUrl: scratch.adminUrl, name });
          await loadSchema({ cwd: process.cwd(), databaseUrl: scratch.url, logger: { log: () => {} } });
          const c = new Client({ connectionString: scratch.url });
          await c.connect();
          try {
            await c.query("set time zone 'UTC'");
            /** One execution of an entrypoint, notices captured; failure redacted to its SQLSTATE. */
            const apply = async (entry: OrderEntry) => {
              const notices: string[] = [];
              const onNotice = (notice: { message?: string }): void => {
                notices.push(notice.message ?? "");
              };
              c.on("notice", onNotice);
              try {
                await c.query(sqlFor(entry));
                return { outcome: "committed", notices };
              } catch (error) {
                return { outcome: `refused (${String((error as { code?: unknown })?.code)})`, notices };
              } finally {
                c.removeListener("notice", onNotice);
              }
            };

            // ── The identical populated pre-F2 fixture. ──
            for (const check of HISTORY_CHECKS) await c.query(`alter table public.slack_sync_channels drop constraint if exists ${check}`);
            await c.query(`alter table public.slack_sync_channels ${NEW_COLUMNS.map((column) => `drop column if exists ${column}`).join(", ")}`);
            await c.query("drop function if exists public.slack_channel_cursor_history_valid(jsonb)");
            expect(await preF2Inventory(c), `${label} fixture: the reconstructed table is EXACTLY the pre-F2 table`).toEqual({
              columns: PRE_F2_COLUMNS, constraints: PRE_F2_CONSTRAINTS, functions: PRE_F2_FUNCTIONS, triggers: PRE_F2_TRIGGERS,
            });
            await orderFixture(c, `insert into teams (id, slug, name) values ($1, 'order-team', 'Order Team')`, [ORDER_TEAM_ID]);
            for (const row of ORDER_CHANNELS) await insertLiteralRow(c, "slack_sync_channels", row);
            for (const row of ORDER_THREADS) await insertLiteralRow(c, "slack_sync_threads", row);
            const seeded = await orderEvidence(c);

            // ── FIRST entrypoint: the one-time union introduction. ──
            expect(await apply(first), `${label}: the first entrypoint (${first}) commits with no NOTICE`).toEqual({ outcome: "committed", notices: [] });
            expect((await c.query(
              `select channel_id, newest_scan_generation::int as newest_generation, historical_scan_generation::int as historical_generation,
                      lease_generation::int as lease_generation, next_lane, claimed_lane,
                      (newest_cursor is null and historical_cursor is null and newest_cursor_history = '[]'::jsonb
                        and historical_cursor_history = '[]'::jsonb) as lanes_cleared,
                      updated_at = $1::timestamptz as updated_at_seeded
                 from public.slack_sync_channels order by channel_id collate "C"`, [ORDER_SEEDED_UPDATED_AT]
            )).rows, `${label}: one restart and fence per active lane; updated_at moved ONLY on the restarted rows`).toEqual(ORDER_RESTART_FACTS);
            const introduced = await orderEvidence(c);
            // The unrestarted row (apart from the eight introduced columns) and every thread row are byte-identical to the seed.
            expect({
              unrestarted: introduced.channels.filter((row) => !ORDER_RESTARTED.has(row.channel_id)).map((row) => row.pre_f2_part),
              threads: introduced.threads,
            }, `${label}: the unrestarted channel row and the thread rows are exactly as seeded, updated_at included`).toEqual({
              unrestarted: seeded.channels.filter((row) => !ORDER_RESTARTED.has(row.channel_id)).map((row) => row.pre_f2_part),
              threads: seeded.threads,
            });
            const introducedCatalog = await slackCatalog(c);
            // Absolute non-vacuity, per database: cross-database equality is not the only oracle.
            expect({
              fingerprintLines: introducedCatalog.lines.length > 0,
              namedChecks: introducedCatalog.checks.length,
              validators: introducedCatalog.validator.length,
            }, `${label}: after introduction the Slack catalog is non-empty, with four named CHECKs and one validator`).toEqual({
              fingerprintLines: true, namedChecks: 4, validators: 1,
            });

            // ── SECOND entrypoint, then replays of both: complete rows exact, updated_at included. ──
            for (const [step, entry] of [["second", second], ["replay", first], ["replay", second]] as Array<[string, OrderEntry]>) {
              expect(await apply(entry), `${label}: ${step} ${entry} commits with no NOTICE`).toEqual({ outcome: "committed", notices: [] });
              expect(exactRows(await orderEvidence(c)), `${label}: after the ${step} ${entry}, every channel and thread row is exact, updated_at included`).toEqual(exactRows(introduced));
              expect(await slackCatalog(c), `${label}: after the ${step} ${entry}, the Slack catalog is unchanged`).toEqual(introducedCatalog);
            }

            // ── Initialized segment progress and MAXIMUM histories on both lanes, identical literal writes. ──
            await orderFixture(c,
              `update public.slack_sync_channels
                  set historical_segment_lower_ts = '0.000000', historical_segment_upper_ts = '1718900500.000000',
                      historical_oldest_seen_ts = '1718900200.000000',
                      historical_cursor_history = $1::jsonb, historical_cursor = $2, updated_at = $3::timestamptz
                where channel_id = 'C0ORDER0001'`,
              [JSON.stringify(historicalMax), historicalMax[999], ORDER_PROGRESS_UPDATED_AT]);
            await orderFixture(c,
              `update public.slack_sync_channels
                  set newest_request_lower_ts = '1718900640.000000', newest_segment_lower_ts = '1718900640.000000',
                      newest_segment_upper_ts = '1718900800.000000',
                      newest_cursor_history = $1::jsonb, newest_cursor = $2,
                      historical_segment_lower_ts = '0.000000', historical_segment_upper_ts = '1718900300.000000',
                      historical_completed_segments_oldest_ts = '1718900350.5',
                      historical_cursor_history = $3::jsonb, historical_cursor = 'syn-order-h-3', updated_at = $4::timestamptz
                where channel_id = 'C0ORDER0002'`,
              [JSON.stringify(newestMax), newestMax[999], JSON.stringify(["syn-order-h-3"]), ORDER_PROGRESS_UPDATED_AT]);
            await orderFixture(c,
              "update public.slack_sync_channels set updated_at = $1::timestamptz where channel_id in ('C0ORDER0003', 'C0ORDER0004')",
              [ORDER_PROGRESS_UPDATED_AT]);
            expect((await c.query(
              `select (select pg_catalog.octet_length(historical_cursor_history::text) from public.slack_sync_channels where channel_id = 'C0ORDER0001') as historical_bytes,
                      (select pg_catalog.jsonb_array_length(historical_cursor_history) from public.slack_sync_channels where channel_id = 'C0ORDER0001') as historical_entries,
                      (select pg_catalog.octet_length(newest_cursor_history::text) from public.slack_sync_channels where channel_id = 'C0ORDER0002') as newest_bytes,
                      (select pg_catalog.jsonb_array_length(newest_cursor_history) from public.slack_sync_channels where channel_id = 'C0ORDER0002') as newest_entries,
                      (select pg_catalog.count(*)::int from public.slack_sync_channels where updated_at = $1::timestamptz) as progress_stamped`,
              [ORDER_PROGRESS_UPDATED_AT]
            )).rows[0], `${label} fixture: maximum histories stored and every row carries the literal progress timestamp`).toEqual({
              historical_bytes: 1048576, historical_entries: 1000, newest_bytes: 1048576, newest_entries: 1000, progress_stamped: 4,
            });
            const progressed = await orderEvidence(c);
            const progressedCatalog = await slackCatalog(c);
            for (const entry of [second, first] as OrderEntry[]) {
              expect(await apply(entry), `${label}: ${entry} replay after progress commits with no NOTICE`).toEqual({ outcome: "committed", notices: [] });
              expect(exactRows(await orderEvidence(c)), `${label}: after the ${entry} replay over progress and maximum histories, every row is exact, updated_at included`).toEqual(exactRows(progressed));
              expect(await slackCatalog(c), `${label}: after the ${entry} replay over progress, the Slack catalog is unchanged`).toEqual(progressedCatalog);
            }

            runs[label] = {
              introducedLogical: logicalRows(introduced), introducedCatalog,
              progressedRows: exactRows(progressed), progressedCatalog,
            };
          } finally {
            await c.end().catch(() => {});
          }
        }

        // ── ACROSS the four independent databases. ──
        const reference = runs.migration_only;
        for (const label of ["mirror_only", "mirror_then_migration", "migration_then_mirror"]) {
          expect(runs[label].introducedCatalog, `${label} vs migration_only: identical Slack catalog after introduction`).toEqual(reference.introducedCatalog);
          expect(runs[label].introducedLogical,
            `${label} vs migration_only: identical full channel and thread rows after introduction (restarted rows differ ONLY in clock-varying updated_at)`).toEqual(reference.introducedLogical);
          expect(runs[label].progressedCatalog, `${label} vs migration_only: identical Slack catalog after progress`).toEqual(reference.progressedCatalog);
          expect(runs[label].progressedRows, `${label} vs migration_only: identical complete rows after progress and maximum histories, updated_at included`).toEqual(reference.progressedRows);
        }
      } finally {
        // Cleanup never replaces the primary failure: every step is caught, as the repository precedent does.
        for (const { adminUrl, name } of created) {
          const dropper = new Client({ connectionString: adminUrl });
          await dropper.connect().catch(() => {});
          await dropper.query(`drop database if exists ${name} with (force)`).catch(() => {});
          await dropper.end().catch(() => {});
        }
      }
    },
    ORDER_TIMEOUT
  );
});
