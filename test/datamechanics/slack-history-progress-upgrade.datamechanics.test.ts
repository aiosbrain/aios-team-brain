import { readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
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
 * FIVE DESCRIBES: the MR-05 mutation-hook guard (static), then the four below. The fifth, the
 * DH-11 legacy three-column and unrelated-writer describe (C9), is described in the ledger.
 *  - The first, RED PACKET 2's case, was written against the comment-only scaffold. It is GREEN
 *    since the reserved migration `postgres/migrations/20261023120000_slack_channel_history_segments.sql`
 *    gained its executable block. It applies that migration to a populated pre-F2 table and
 *    requires the catalog it creates. Its catalog readers query only `pg_attribute`,
 *    `pg_constraint` and `pg_proc`.
 *  - The second, MR-03 STATEMENT ORDER (packet 6), and the third, MR-03 INTRODUCTION VARIANTS
 *    (packet 7), are described after the first case's notes below.
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
 * MR-03 INTRODUCTION VARIANTS (packet 7, the third describe). These are the two remaining
 * presence-rule introductions, each under all four statement orders, in independent loader-built
 * databases with identical literal fixtures:
 *  - SEGMENT-ONLY, COMMITTING, on an F2-only SCHEMA: both histories, the validator and both history
 *    CHECKs are present and valid; the six segment/progress columns and both progress CHECKs are
 *    absent. Every active lane restarts once: an active historical lane with history, both lanes
 *    under a live newest claim with a cursor-null historical lane, and a MAXIMUM-history lane under
 *    a live historical claim. Claims on restarted lanes are fenced; an idle row is untouched.
 *  - ONE-LANE HISTORY-ONLY: initialized segment progress on both lanes, a MAXIMUM newest history
 *    and three named CHECKs are present; only `historical_cursor_history` is absent. Only anchored
 *    historical lanes restart, KEEPING their segment bounds and completed-segment aggregate. The
 *    opposite live newest claim and its maximum history are preserved exactly; a live HISTORICAL
 *    claim is fenced; idle and newest-only rows are untouched.
 * Each variant has its own two literal queued thread rows: one on a restarted channel and one on
 * an unrestarted channel. For each variant and order:
 *  - the pre-introduction presence is pinned literally: which accepted columns exist, which named
 *    CHECKs exist (by name, kind and VALIDATED state, as the loader left them; their definitions
 *    are asserted only after introduction, by catalog equality), the validator count, and the
 *    starting maximum histories;
 *  - the first entrypoint commits notice-free with exact literal facts:
 *    · lane generations and the whole lease tuple;
 *    · ALL SIX segment/progress values, read directly: all null on every row for segment-only;
 *      every seeded literal unchanged on every row for history-only;
 *    · cleared lanes, and whether `updated_at` kept its seed;
 *  - restarted rows are byte-identical outside their PERMITTED restart fields; unrestarted rows
 *    and thread rows are exact, `updated_at` included;
 *  - the final Slack catalog equals an untouched loader-built database's catalog exactly;
 *  - the second entrypoint and replays of both compare COMPLETE rows exactly, and keep that catalog;
 *  - valid deterministic segment progress and MAXIMUM histories are then written, every row is
 *    stamped with a literal `updated_at`, and replays of both entrypoints compare COMPLETE rows
 *    exactly with no exclusion at all.
 * Across orders, rows match migration-only:
 *  - after introduction, with ONLY a restarted row's `updated_at` excepted;
 *  - after progress, as complete rows with no exception.
 * A third variant, the SINGLE-LANE SEGMENT-UNIT introduction (only newest's three segment columns
 * absent), restarts only anchored newest lanes. The opposite lane's live historical claim, turn and
 * progress, and an untouched historical maximum history, are preserved exactly.
 *
 * SIBLING RESPONSIBILITIES, not duplicated here. `slack-history-progress-conflicts` owns the
 * migration-path MR-03 / F2-12 edges:
 *  - the union restart's claim/idle edges with planted metadata;
 *  - the history-only one-lane introduction that preserves the opposite live claim;
 *  - progress and maximum-history migration replay;
 *  - every catalog and state conflict.
 * `slack-history-progress-catalog` owns MR-02.
 *
 * WHAT REMAINS for later packets, and is NOT claimed here. No describe completes F2-12, DH-11 or any
 * MR row. Deferred, explicitly. Items since covered by the siblings or by the order and variant
 * describes above are marked as such.
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
 *      populated UNION introduction;
 *    · in the introduction-variants describe here: a COMMITTING segment-only introduction on an
 *      F2-only SCHEMA, and the one-lane history-only introduction. Each runs under statement-level
 *      mirror-only and both statement orders, with exact replay.
 *  - MR-03 / F2-12, COVERED in this phase (introduction-variants describe): the COMMITTING
 *    single-lane (newest) segment-unit introduction, and progress plus maximum histories AFTER
 *    every variant's introduction, followed by exact replay of both entrypoints.
 *  - MIGRATION-VERIFICATION PHASE, COMPLETED items (by continuation):
 *    A3 · DONE (continuation 7), in the statement-order describe. The evidence categories, traced
 *         to their ACTUAL persistence:
 *         · STAGED SNAPSHOT: `slack_thread_snapshots`, FK to its queued `slack_sync_threads` row;
 *         · PUBLISHED ITEM: `items`, under a `projects` row;
 *         · LEDGER: `slack_messages`, FK `(team_id, item_id)` to that item.
 *         Literal rows (1 project, 1 item, 2 ledger rows, 1 staged snapshot) are seeded in each
 *         of the four order databases.
 *         · The project FK support row is seeded WITH the canonical `graph_group_id`, the exact
 *           value `20260815140000_projects_graph_group_id.sql` mints. Its replay backfill is
 *           guarded on a null pointer and is therefore a no-op, rather than legitimately rewriting
 *           a pointer-less row on the full-loader replay.
 *         · Its identity and that canonical pointer are asserted literally.
 *         Each table, the project included, is md5-digested whole with no column excluded, and
 *         must be byte-identical
 *         after the first introduction, after the second entrypoint and every replay, after the
 *         replays over progress, and after the full-loader replay. They are compared WITHIN each
 *         database, not across databases, because later migrations may add `now()`-defaulted
 *         columns this packet does not pin, and excluding them would hide drift. The variant
 *         describes do not seed them;
 *    A4 · DONE (continuation 2). After the progressed replays, the real deploy loader
 *         (`loadSchema`: schema.sql then every migration, on its own fresh session) is replayed
 *         over the POPULATED, progressed rows:
 *         · of all four statement-order databases;
 *         · of every introduction-variant database.
 *         Complete rows (updated_at included) and the Slack catalog must stay exact. The loader's
 *         notices are not asserted: `scripts/pg-load-schema.mjs` prints every PostgreSQL notice
 *         to stdout (console.log) whatever logger is passed, and schema.sql's `if not exists` DDL
 *         may notice. A whole-schema REFUSAL entrypoint is not exercised IN THIS FILE; the
 *         real-loader refusal matrix is in `slack-history-progress-conflicts` (B8 tail);
 *    B5 · DONE (continuation 2), in `slack-history-progress-conflicts`: a pure replay refusing a
 *         stored invalid progress tuple, via both entrypoints;
 *    B6 · DONE (continuation 2), in `slack-history-progress-conflicts`, via both entrypoints:
 *         · the historical null-anchor/non-null-cursor refusal;
 *         · a same-name weaker CHECK over a row the canonical rejects, refused statically before
 *           any drop;
 *         · a same-name CHECK with a different definition over valid rows, replaced canonically;
 *    B7 · DONE (continuations 3 and 5), in `slack-history-progress-conflicts`:
 *         · cancellation INSIDE the block through the migration file AND the marked mirror
 *           statement, with rollback seen from a fresh session;
 *         · concurrency through TWO MIGRATION-FILE executions in real sessions, with exactly one
 *           restart;
 *         · later-query failure: a committed COMPLETE deploy-loader query, then a separate failing
 *           migration+22012 query that rolls back only itself, then a migration-file retry with
 *           no second restart.
 *         Not every B7 case runs through both entrypoints. The populated full-loader replays in
 *         this file go through a sanitized wrapper that reports only success, SQLSTATE and field
 *         presence;
 *    B8 · DONE (continuation 4), in `slack-history-progress-conflicts`. Marked-mirror refusal is
 *         EXHAUSTIVE for its refusal set: the matrix, the state refusals, and literal twins of NINE
 *         dedicated migration-only refusals. The history-only restart-hiding case (attempt-oldest
 *         below S) and the inactive-historical attempt-oldest case are covered by refusal CLASS
 *         through STATE_REFUSALS fixtures on different rows, not as literal twins. The B8 TAIL is
 *         DONE in continuation 6: the REAL deploy loader refuses EVERY
 *         one of those fixtures, plus the three replay-time refusals. No fixture is excluded; the
 *         source-backed reachability is noted at the conflicts suite's LOADER_SET;
 *    C9 · PARTLY DONE (continuation 7), in the DH-11 describe: a migration-scope test titled
 *         exactly `re-adds the three legacy metadata/provisional columns without restarting an
 *         initialized segment`. It has initialized segments and a MAXIMUM history (1,000 entries,
 *         1,048,576 bytes) on BOTH lanes:
 *         · removing ONLY the three legacy columns and replaying the real deploy loader re-adds
 *           them with exact metadata. Every other column, updated_at included, is byte-identical
 *           (no restart), and both maximum histories survive;
 *         · the in-scope UNRELATED DB-level writer, the integration delete (`ON DELETE SET NULL`
 *           plus the binding-clear trigger), changes only the binding pair. Both history CHECKs
 *           re-pass on that UPDATE, and both maximum histories survive;
 *    C10 · DONE (continuation 6): tracked, restorable MR-05 mutation HOOKS, with no production
 *         edit. An ABSOLUTE path in an environment variable redirects the source the tests read:
 *         · `AIO1170_MR05_MIGRATION_FILE` (this file and the conflicts suite): a comment-only
 *           migration copy must fail this file's migration-only legacy case on its CATALOG
 *           assertion;
 *         · `AIO1170_MR05_SCHEMA_FILE` (the conflicts suite): a mirror-block-only drifted schema
 *           copy must fail the static parity assertion.
 *         A static guard test in each file fails any run with a hook set. The coordinator still
 *         executes baseline, mutant and restored runs, and the structural sweeps;
 *  - REMAINING, with source-backed boundaries:
 *    · C9 RENAME: the existing test named in §9, `re-adds every column this slice introduced,
 *      preserving the progress already stored`, lives in
 *      `test/datamechanics/slack-source-fences.datamechanics.test.ts:376`. That file is outside
 *      this packet's permitted migration test files, so it is NOT renamed here; that is a later
 *      bounded test edit;
 *    · C9 RUNTIME WRITERS: §3.4's maximum-history writers are application functions, not reachable
 *      from this migration test area. They need the not-yet-wired runtime packet:
 *      claimSlackChannelPage, releaseSlackChannelForRetry, beginSlackChannelMetadata,
 *      recordSlackChannelPublicState, delaySlackChannel, opposite-lane acceptSlackChannelPage and
 *      restartSlackChannelScan, the fenced rejection/release path, elapse, expireChannelLease and
 *      agePublicProof. Only the DB-level integration-delete path is proved here;
 *    · not scheduled here: the omitted-lease-invalidation mutant (not measured), the §9 named
 *      DH-11 source-fence tests, and MR-06 (held until PR743 staging).
 */

const SCRATCH_TIMEOUT = 300_000;
/**
 * MR-05 controlled-mutation hook (C10). An ABSOLUTE path in `AIO1170_MR05_MIGRATION_FILE`
 * replaces the migration SOURCE these cases read. A readable COMMENT-ONLY copy then executes as
 * an empty statement, so the migration-only legacy case fails on its CATALOG assertion, not on
 * file access or parsing, while every schema-first build stays green. Restoring is unsetting the
 * variable. The guard test below fails ANY run where the hook is set.
 */
function migrationOverride(fallback: string): string {
  const value = process.env.AIO1170_MR05_MIGRATION_FILE;
  if (value === undefined || value === "") return fallback;
  if (!isAbsolute(value)) throw new Error("AIO1170_MR05_MIGRATION_FILE must be an absolute path");
  return value;
}
const MIGRATION = migrationOverride(join(process.cwd(), "postgres", "migrations", "20261023120000_slack_channel_history_segments.sql"));

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

describe("AM-F2 + AC-02 history/segment migration — MR-05 mutation-hook guard (static)", () => {
  it("MR-05 the controlled-mutation hook is unset, so this run reads the real migration", () => {
    expect(process.env.AIO1170_MR05_MIGRATION_FILE ?? "", "AIO1170_MR05_MIGRATION_FILE is set: this is a mutation run, not a normal one").toBe("");
  });
});

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

/**
 * A3: the accepted evidence categories, in their ACTUAL current PostgreSQL persistence (traced in
 * `postgres/schema.sql`):
 *  - STAGED SNAPSHOT: `slack_thread_snapshots`, with a composite FK to its `slack_sync_threads`
 *    row;
 *  - PUBLISHED ITEM: the canonical `items` row, under its `projects` row;
 *  - LEDGER: `slack_messages`, which `schema.sql` itself calls "the ledger", with a composite FK
 *    `(team_id, item_id)` to that item.
 * Each table is digested whole (md5 only), so a change to any column, including a generated one,
 * is caught. These are compared WITHIN one database through every lifecycle step, never across
 * databases: later migrations may add `now()`-defaulted columns this packet does not pin, and
 * excluding them would hide drift.
 */
async function slackEvidence(client: Client) {
  return (await client.query<{ projects: string; items: string; ledger: string; snapshots: string; counts: string }>(
    `select
       (select coalesce(pg_catalog.md5(pg_catalog.string_agg(pg_catalog.to_jsonb(p)::text, '|' order by p.id)), 'no rows')
          from public.projects p where p.team_id = $1) as projects,
       (select coalesce(pg_catalog.md5(pg_catalog.string_agg(pg_catalog.to_jsonb(i)::text, '|' order by i.id)), 'no rows')
          from public.items i where i.team_id = $1) as items,
       (select coalesce(pg_catalog.md5(pg_catalog.string_agg(pg_catalog.to_jsonb(m)::text, '|' order by m.message_ts collate "C")), 'no rows')
          from public.slack_messages m where m.team_id = $1) as ledger,
       (select coalesce(pg_catalog.md5(pg_catalog.string_agg(pg_catalog.to_jsonb(n)::text, '|' order by n.root_ts collate "C")), 'no rows')
          from public.slack_thread_snapshots n where n.team_id = $1) as snapshots,
       (select pg_catalog.count(*) from public.projects where team_id = $1) || '/' ||
       (select pg_catalog.count(*) from public.items where team_id = $1) || '/' ||
       (select pg_catalog.count(*) from public.slack_messages where team_id = $1) || '/' ||
       (select pg_catalog.count(*) from public.slack_thread_snapshots where team_id = $1) as counts`, [ORDER_TEAM_ID]
  )).rows[0];
}
/**
 * The project's Graphiti partition pointer, exactly as
 * `postgres/migrations/20260815140000_projects_graph_group_id.sql` MINTS it for a non-system
 * project: `'g_' || replace(team_id::text, '-', '') || '_p_' || replace(id::text, '-', '')`. That
 * migration's backfill is guarded on `graph_group_id is null`. A project seeded WITHOUT a pointer
 * is therefore legitimately rewritten by the next full-loader replay; that was the one observed
 * `projects` digest change, and it was not evidence mutation. Seeding the canonical pointer makes
 * the guarded backfill a no-op, so the project row keeps EXACT whole-row hashing with nothing
 * excluded.
 */
const ORDER_PROJECT_ID = "0f000000-0000-4000-8000-000000000a01";
const ORDER_PROJECT_GRAPH_GROUP_ID = "g_7e8f9a0b1c2d4e3f8a4b5c6d7e8f9a0b_p_0f000000000040008000000000000a01";
/** Literal staged-snapshot, published-item and ledger rows, with valid FKs, for the order fixture. */
async function seedSlackEvidence(client: Client): Promise<void> {
  await orderFixture(client,
    `insert into public.projects (id, team_id, slug, name, graph_group_id, created_at)
     values ($2, $1, 'order-evidence', 'Order Evidence', $3, '2026-01-01 00:00:00+00')`,
    [ORDER_TEAM_ID, ORDER_PROJECT_ID, ORDER_PROJECT_GRAPH_GROUP_ID]);
  await orderFixture(client,
    `insert into public.items (id, team_id, project_id, path, kind, access, frontmatter, body, content_sha256, actor,
                               created_at, work_at, work_at_from_source, synced_at, updated_at)
     values ('0f000000-0000-4000-8000-000000000a02', $1, '${ORDER_PROJECT_ID}',
             'slack/T0ORDER001/C0ORDER0001/1718900200.000200.md', 'artifact', 'team', '{"source": "slack"}'::jsonb,
             'synthetic order evidence body', $2, 'slack',
             '2026-01-01 00:00:00+00', '2024-06-20 16:16:40+00', true, '2026-01-01 00:00:00+00', '2026-01-01 00:00:00+00')`,
    [ORDER_TEAM_ID, "a".repeat(64)]);
  for (const [id, ts, isRoot, eligible, reason, author] of [
    ["0f000000-0000-4000-8000-000000000a03", "1718900200.000200", true, true, null, "U0ORDER1"],
    ["0f000000-0000-4000-8000-000000000a04", "1718900201.000201", false, false, "bot_message", null],
  ] as Array<[string, string, boolean, boolean, string | null, string | null]>) {
    await orderFixture(client,
      `insert into public.slack_messages (id, team_id, workspace_id, channel_id, message_ts, root_ts, item_id, author_external_id,
                                          occurred_at, is_root, eligible, exclusion_reason, last_seen_generation, source_hash, observed_at)
       values ($1, $2, $3, 'C0ORDER0001', $4, '1718900200.000200', '0f000000-0000-4000-8000-000000000a02', $5,
               '2024-06-20 16:16:40+00', $6, $7, $8, 1, $9, '2026-01-01 00:00:00+00')`,
      [id, ORDER_TEAM_ID, ORDER_WORKSPACE, ts, author, isRoot, eligible, reason, "b".repeat(64)]);
  }
  // The staged snapshot of the queued thread C0ORDER0001/1718900200.000200; stored_bytes is
  // computed by PostgreSQL from the exact stored jsonb, as its CHECK requires.
  await orderFixture(client,
    `insert into public.slack_thread_snapshots (team_id, workspace_id, channel_id, root_ts, snapshot_generation, messages,
                                                stored_bytes, seen_cursors, expires_at, complete, created_at, updated_at)
     values ($1, $2, 'C0ORDER0001', '1718900200.000200', 1, $3::jsonb, pg_catalog.octet_length($3::jsonb::text),
             $4::jsonb, '2026-03-01 00:00:00+00', false, '2026-01-01 00:00:00+00', '2026-01-01 00:00:00+00')`,
    [ORDER_TEAM_ID, ORDER_WORKSPACE, JSON.stringify([{ ts: "1718900200.000200", text: "synthetic staged message" }]), JSON.stringify(["syn-snapshot-cursor-1"])]);
}
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

/**
 * A populated FULL-LOADER replay whose FAILURE diagnostic cannot carry data. On error, the raw
 * PostgreSQL error stays in memory only. The returned diagnostic carries at most the SQLSTATE
 * and the PRESENCE (booleans) of its diagnostic fields, never a message, detail, hint, query,
 * row, cursor, token or member value. Success is exactly `{ outcome: "committed" }`.
 * NOT claimed: global notice privacy. `scripts/pg-load-schema.mjs` prints every PostgreSQL
 * notice to stdout (console.log) whatever logger is passed, and those notices are not asserted.
 * This file's owned block is expected to emit no NOTICE (asserted for the two marked
 * entrypoints), and its fixtures and static failure messages are privacy-safe.
 */
async function sanitizedLoaderReplay(
  loadSchema: (options: Record<string, unknown>) => Promise<void>, databaseUrl: string,
): Promise<Record<string, unknown>> {
  try {
    await loadSchema({ cwd: process.cwd(), databaseUrl, logger: { log: () => {} } });
    return { outcome: "committed" };
  } catch (error) {
    const e = (error ?? {}) as Record<string, unknown>;
    return {
      outcome: "failed", code: typeof e.code === "string" ? e.code : null,
      detail: e.detail !== undefined, hint: e.hint !== undefined, schema: e.schema !== undefined, table: e.table !== undefined,
      column: e.column !== undefined, dataType: e.dataType !== undefined, constraint: e.constraint !== undefined,
    };
  }
}

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
            await seedSlackEvidence(c);
            const seededEvidence = await slackEvidence(c);
            expect(seededEvidence.counts, `${label} fixture: 1 project, 1 published item, 2 ledger rows and 1 staged snapshot are present`).toBe("1/1/2/1");
            // Non-vacuity of the project row: its identity and the canonical pointer the loader's backfill would mint.
            expect((await c.query(
              `select id::text as id, team_id::text as team_id, slug, name, graph_group_id,
                      graph_group_id = 'g_' || replace(team_id::text, '-', '') || '_p_' || replace(id::text, '-', '') as pointer_is_canonical
                 from public.projects where id = $1`, [ORDER_PROJECT_ID]
            )).rows, `${label} fixture: the project carries its literal identity and the canonical graph pointer`).toEqual([{
              id: ORDER_PROJECT_ID, team_id: ORDER_TEAM_ID, slug: "order-evidence", name: "Order Evidence",
              graph_group_id: ORDER_PROJECT_GRAPH_GROUP_ID, pointer_is_canonical: true,
            }]);
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
            expect(await slackEvidence(c), `${label}: the staged snapshot, published item and ledger rows are byte-identical after introduction`).toEqual(seededEvidence);
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
              expect(await slackEvidence(c), `${label}: after the ${step} ${entry}, the evidence rows are byte-identical`).toEqual(seededEvidence);
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
              expect(await slackEvidence(c), `${label}: after the ${entry} replay over progress, the evidence rows are byte-identical`).toEqual(seededEvidence);
            }
            // ── The FULL deploy loader (schema.sql, then every migration) replayed over the populated, progressed rows. ──
            // The loader opens its OWN fresh session; this session is idle, so it holds no lock the loader needs.
            expect(await sanitizedLoaderReplay(loadSchema, scratch.url), `${label}: the full-loader replay over progress commits`).toEqual({ outcome: "committed" });
            expect(exactRows(await orderEvidence(c)), `${label}: after a full-loader replay over progress and maximum histories, every row is exact, updated_at included`).toEqual(exactRows(progressed));
            expect(await slackCatalog(c), `${label}: after a full-loader replay over progress, the Slack catalog is unchanged`).toEqual(progressedCatalog);
            expect(await slackEvidence(c), `${label}: after a full-loader replay over progress, the evidence rows are byte-identical`).toEqual(seededEvidence);

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

// ── MR-03 INTRODUCTION VARIANTS (packet 7): segment-only and one-lane history-only, every statement order ──

/**
 * The two executable entrypoints, after the same parity proof Packet 6 makes: the MIRROR is
 * schema.sql's ONE marked DO statement, byte-identical to the migration's own marked statement.
 */
function assertedEntrypoints(): (entry: OrderEntry) => string {
  const migrationSql = readFileSync(MIGRATION, "utf8");
  const schemaSql = readFileSync(SCHEMA_PATH, "utf8");
  const migrationStatement = markedStatement(migrationSql);
  const mirrorStatement = markedStatement(schemaSql);
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
  return (entry) => (entry === "migration" ? migrationSql : mirrorStatement);
}
/** One execution of an entrypoint on `client`, notices captured; failure redacted to its SQLSTATE. */
async function applyEntrySql(client: Client, sql: string): Promise<{ outcome: string; notices: string[] }> {
  const notices: string[] = [];
  const onNotice = (notice: { message?: string }): void => {
    notices.push(notice.message ?? "");
  };
  client.on("notice", onNotice);
  try {
    await client.query(sql);
    return { outcome: "committed", notices };
  } catch (error) {
    return { outcome: `refused (${String((error as { code?: unknown })?.code)})`, notices };
  } finally {
    client.removeListener("notice", onNotice);
  }
}
/** Each channel row digested WITHOUT the named columns (md5 only). */
async function digestsExcept(client: Client, excluded: string[]) {
  return (await client.query<{ channel_id: string; digest: string }>(
    `select channel_id, pg_catalog.md5((pg_catalog.to_jsonb(s) - $1::text[])::text) as digest
       from public.slack_sync_channels s order by channel_id collate "C"`, [excluded]
  )).rows;
}
/** Which of the eight accepted columns and four named CHECKs exist, plus the validator count. */
async function introductionPresence(client: Client) {
  return {
    columns: (await client.query<{ name: string }>(
      `select attname as name from pg_catalog.pg_attribute
        where attrelid = 'public.slack_sync_channels'::regclass and attnum > 0 and not attisdropped and attname = any($1::text[])
        order by attname collate "C"`, [NEW_COLUMNS]
    )).rows.map((row) => row.name),
    checks: (await client.query<{ name: string; kind: string; validated: boolean }>(
      `select conname as name, contype::text as kind, convalidated as validated from pg_catalog.pg_constraint
        where conrelid = 'public.slack_sync_channels'::regclass and conname = any($1::text[]) order by conname collate "C"`,
      [["slack_sync_channels_historical_cursor_history_check", "slack_sync_channels_historical_progress_check",
        "slack_sync_channels_newest_cursor_history_check", "slack_sync_channels_newest_progress_check"]]
    )).rows.map((row) => ({ name: row.name, kind: row.kind, validated: row.validated })),
    validators: (await client.query<{ n: number }>(
      `select pg_catalog.count(*)::int as n from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname = 'slack_channel_cursor_history_valid'`
    )).rows[0].n,
  };
}
/**
 * Exact facts per row:
 *  - lane generations and the whole lease tuple;
 *  - all six segment/progress values, read directly;
 *  - whether each lane is cleared, and whether `updated_at` kept its seed.
 */
async function variantFacts(client: Client) {
  return (await client.query(
    `select channel_id, newest_scan_generation::int as newest_generation, historical_scan_generation::int as historical_generation,
            lease_generation::int as lease_generation, next_lane, claimed_lane, lease_owner, lease_expires_at::text as lease_expires_at,
            newest_request_lower_ts, newest_segment_lower_ts, newest_segment_upper_ts,
            historical_segment_lower_ts, historical_segment_upper_ts, historical_completed_segments_oldest_ts,
            (newest_cursor is null and newest_cursor_history = '[]'::jsonb) as newest_cleared,
            (historical_cursor is null and historical_cursor_history = '[]'::jsonb and historical_oldest_seen_ts is null) as historical_cleared,
            updated_at = $1::timestamptz as updated_at_seeded
       from public.slack_sync_channels order by channel_id collate "C"`, [ORDER_SEEDED_UPDATED_AT]
  )).rows;
}
/** A stored history's serialized bytes and entry count; `column` is one of two literal names, never input. */
async function storedHistorySize(client: Client, channel: string, column: "newest_cursor_history" | "historical_cursor_history") {
  return (await client.query<{ bytes: number; entries: number }>(
    `select pg_catalog.octet_length(${column}::text) as bytes, pg_catalog.jsonb_array_length(${column}) as entries
       from public.slack_sync_channels where channel_id = $1`, [channel]
  )).rows[0];
}

/** One schema-introduction variant: how its pre-introduction state is built, and its exact literal outcome. */
interface IntroductionVariant {
  label: string;
  /** Fixture DDL turning the loader's full schema into the variant's pre-introduction schema. */
  strip: string[];
  /** Whether the literal rows are written BEFORE the strip DDL (true) or after it (false). */
  insertBeforeStrip: boolean;
  channels: Array<Record<string, unknown>>;
  /** Queued thread rows: one on a restarted channel, one on an unrestarted channel of THIS variant. */
  threads: Array<Record<string, unknown>>;
  /** The pre-introduction presence, literally (each present named CHECK by name, kind and validation). */
  presence: { columns: string[]; checks: Array<{ name: string; kind: string; validated: boolean }>; validators: number };
  /** Maximum histories present before introduction, and those that must still be present after it. */
  maxBefore: Array<[string, "newest_cursor_history" | "historical_cursor_history"]>;
  maxAfter: Array<[string, "newest_cursor_history" | "historical_cursor_history"]>;
  restarted: Set<string>;
  /** The ONLY columns a restarted row may change; every other column must be byte-identical. */
  permitted: string[];
  /** The columns this introduction adds (absent before, so excluded from before/after digests). */
  introduced: string[];
  facts: Array<Record<string, unknown>>;
  /**
   * Valid deterministic progress written AFTER introduction: segment bounds and histories. The
   * runner then stamps every row with the literal progress `updated_at`, and both entrypoints
   * replay against COMPLETE rows, with no exclusion.
   */
  progress: Array<{ sql: string; params: unknown[] }>;
  /** Maximum histories that the progress writes store. */
  maxProgressed: Array<[string, "newest_cursor_history" | "historical_cursor_history"]>;
}

const SEGMENT_COLUMNS = NEW_COLUMNS.filter((column) => !column.endsWith("_cursor_history"));
const BOTH_LANE_RESTART_FIELDS = [
  "newest_cursor", "newest_cursor_history", "newest_scan_generation",
  "historical_cursor", "historical_cursor_history", "historical_scan_generation", "historical_oldest_seen_ts",
  "claimed_lane", "lease_owner", "lease_expires_at", "lease_generation", "next_lane", "updated_at",
];
const HISTORICAL_RESTART_FIELDS = [
  "historical_cursor", "historical_cursor_history", "historical_scan_generation", "historical_oldest_seen_ts",
  "claimed_lane", "lease_owner", "lease_expires_at", "lease_generation", "next_lane", "updated_at",
];
const variantRow = (row: Record<string, unknown>): Record<string, unknown> =>
  ({ team_id: ORDER_TEAM_ID, workspace_id: ORDER_WORKSPACE, updated_at: ORDER_SEEDED_UPDATED_AT, ...row });
const LIVE = "2030-01-01 00:00:00+00";
/** The six segment/progress values of one row, literally. */
type SegmentValues = {
  newest_request_lower_ts: string | null; newest_segment_lower_ts: string | null; newest_segment_upper_ts: string | null;
  historical_segment_lower_ts: string | null; historical_segment_upper_ts: string | null; historical_completed_segments_oldest_ts: string | null;
};
const NO_SEGMENTS: SegmentValues = {
  newest_request_lower_ts: null, newest_segment_lower_ts: null, newest_segment_upper_ts: null,
  historical_segment_lower_ts: null, historical_segment_upper_ts: null, historical_completed_segments_oldest_ts: null,
};
/** The history-only variant's seeded newest segment literals, which must survive unchanged. */
const NEWEST_SEGMENTS = { newest_request_lower_ts: "1718900640.000000", newest_segment_lower_ts: "1718900640.000000", newest_segment_upper_ts: "1718900800.000000" };
const fact = (channel: string, newest: number, historical: number, lease: number, next: string,
  claim: { lane: string | null; owner: string | null; expires: string | null }, segments: SegmentValues,
  newestCleared: boolean, historicalCleared: boolean, seeded: boolean) => ({
  channel_id: channel, newest_generation: newest, historical_generation: historical, lease_generation: lease, next_lane: next,
  claimed_lane: claim.lane, lease_owner: claim.owner, lease_expires_at: claim.expires, ...segments,
  newest_cleared: newestCleared, historical_cleared: historicalCleared, updated_at_seeded: seeded,
});
const NO_CLAIM = { lane: null, owner: null, expires: null };
/** A queued thread row for a variant: every non-constant default explicit. */
const variantThread = (id: string, channel: string, root: string, due: string, created: string): Record<string, unknown> => ({
  id, team_id: ORDER_TEAM_ID, workspace_id: ORDER_WORKSPACE, channel_id: channel, root_ts: root, attempts: 1,
  due_at: due, created_at: created, updated_at: ORDER_SEEDED_UPDATED_AT,
});

/**
 * SEGMENT-ONLY introduction on an F2-only SCHEMA. Both histories, the validator and both history
 * CHECKs exist and are valid; the six segment/progress columns and both progress CHECKs are absent.
 * Both lanes' segment units are absent, so EVERY active lane restarts. One row restarts both lanes
 * under a live newest claim while its historical lane is cursor-null; the maximum-history lane,
 * under a live historical claim, is covered too.
 */
const segmentOnlyVariant = (historicalMax: string[]): IntroductionVariant => ({
  label: "segment_only",
  strip: [`alter table public.slack_sync_channels ${SEGMENT_COLUMNS.map((column) => `drop column ${column}`).join(", ")}`],
  insertBeforeStrip: false,
  channels: [
    { id: "0f000000-0000-4000-8000-0000000000b1", channel_id: "C0SEGONLY001", historical_anchor_ts: "1718900500.000000",
      historical_cursor: "syn-seg-h-2", historical_cursor_history: JSON.stringify(["syn-seg-h-1", "syn-seg-h-2"]), historical_scan_generation: 3,
      historical_oldest_seen_ts: "1718900100.000100", lease_generation: 7, next_lane: "newest", attempts: 3, last_error_code: "rate_limited",
      due_at: "2026-01-02 00:00:00+00", created_at: "2025-12-31 00:00:00+00" },
    { id: "0f000000-0000-4000-8000-0000000000b2", channel_id: "C0SEGONLY002", newest_anchor_ts: "1718900800.000000",
      newest_lower_ts: "1718900700.000000", newest_cursor: "syn-seg-n-1", newest_cursor_history: JSON.stringify(["syn-seg-n-1"]),
      newest_scan_generation: 5, historical_anchor_ts: "1718900500.000000", historical_scan_generation: 4,
      claimed_lane: "newest", lease_owner: "lease-seg-r2", lease_expires_at: LIVE, lease_generation: 21, next_lane: "historical",
      due_at: "2026-01-05 00:00:00+00", created_at: "2025-12-30 00:00:00+00" },
    { id: "0f000000-0000-4000-8000-0000000000b3", channel_id: "C0SEGONLY003", lease_generation: 4, next_lane: "historical",
      due_at: "2026-01-06 00:00:00+00", created_at: "2025-12-29 00:00:00+00" },
    { id: "0f000000-0000-4000-8000-0000000000b4", channel_id: "C0SEGONLY004", historical_anchor_ts: "1718900500.000000",
      historical_cursor: historicalMax[999], historical_cursor_history: JSON.stringify(historicalMax), historical_scan_generation: 2,
      claimed_lane: "historical", lease_owner: "lease-seg-r4", lease_expires_at: LIVE, lease_generation: 11, next_lane: "newest",
      due_at: "2026-01-07 00:00:00+00", created_at: "2025-12-28 00:00:00+00" },
  ].map(variantRow),
  threads: [
    variantThread("0f000000-0000-4000-8000-0000000000d1", "C0SEGONLY001", "1718900210.000210", "2026-01-03 00:00:00+00", "2025-12-31 01:00:00+00"),
    variantThread("0f000000-0000-4000-8000-0000000000d2", "C0SEGONLY003", "1718900310.000310", "2026-01-04 00:00:00+00", "2025-12-31 02:00:00+00"),
  ],
  presence: {
    columns: ["historical_cursor_history", "newest_cursor_history"],
    checks: [
      { name: "slack_sync_channels_historical_cursor_history_check", kind: "c", validated: true },
      { name: "slack_sync_channels_newest_cursor_history_check", kind: "c", validated: true },
    ],
    validators: 1,
  },
  maxBefore: [["C0SEGONLY004", "historical_cursor_history"]],
  maxAfter: [],
  restarted: new Set(["C0SEGONLY001", "C0SEGONLY002", "C0SEGONLY004"]),
  permitted: BOTH_LANE_RESTART_FIELDS,
  introduced: SEGMENT_COLUMNS,
  // Every newly introduced segment/progress value is null on EVERY row: the all-null initialization tuple.
  facts: [
    fact("C0SEGONLY001", 0, 4, 7, "newest", NO_CLAIM, NO_SEGMENTS, true, true, false),
    fact("C0SEGONLY002", 6, 5, 22, "newest", NO_CLAIM, NO_SEGMENTS, true, true, false),
    fact("C0SEGONLY003", 0, 0, 4, "historical", NO_CLAIM, NO_SEGMENTS, true, true, true),
    fact("C0SEGONLY004", 0, 3, 12, "historical", NO_CLAIM, NO_SEGMENTS, true, true, false),
  ],
  // Initialize the restarted lanes: historical with a MAXIMUM history, newest with one cursor.
  progress: [
    { sql: `update public.slack_sync_channels
               set historical_segment_lower_ts = '0.000000', historical_segment_upper_ts = '1718900500.000000',
                   historical_oldest_seen_ts = '1718900200.000000', historical_cursor_history = $1::jsonb, historical_cursor = $2
             where channel_id = 'C0SEGONLY001'`, params: [JSON.stringify(historicalMax), historicalMax[999]] },
    { sql: `update public.slack_sync_channels
               set newest_request_lower_ts = '1718900640.000000', newest_segment_lower_ts = '1718900640.000000',
                   newest_segment_upper_ts = '1718900800.000000', newest_cursor_history = $1::jsonb, newest_cursor = 'syn-seg-n-9'
             where channel_id = 'C0SEGONLY002'`, params: [JSON.stringify(["syn-seg-n-9"])] },
  ],
  maxProgressed: [["C0SEGONLY001", "historical_cursor_history"]],
});

/**
 * One-lane HISTORY-ONLY introduction. Every segment/progress column, the newest history, the
 * validator and three named CHECKs exist with valid initialized progress, including a MAXIMUM
 * newest history; only `historical_cursor_history` (with its CHECK) is absent. ONLY anchored
 * historical lanes restart, keeping their segment bounds and aggregate. The opposite newest live
 * claim and its maximum history are preserved exactly, and a live HISTORICAL claim is fenced.
 */
const historyOnlyVariant = (newestMax: string[]): IntroductionVariant => ({
  label: "history_only",
  strip: ["alter table public.slack_sync_channels drop column historical_cursor_history"],
  insertBeforeStrip: true,
  channels: [
    { id: "0f000000-0000-4000-8000-0000000000c1", channel_id: "C0HISONLY001",
      newest_anchor_ts: "1718900800.000000", newest_lower_ts: "1718900700.000000", newest_request_lower_ts: "1718900640.000000",
      newest_segment_lower_ts: "1718900640.000000", newest_segment_upper_ts: "1718900800.000000",
      newest_cursor: newestMax[999], newest_cursor_history: JSON.stringify(newestMax), newest_scan_generation: 7,
      historical_anchor_ts: "1718900500.000000", historical_segment_lower_ts: "0.000000", historical_segment_upper_ts: "1718900300.000000",
      historical_completed_segments_oldest_ts: "1718900350.5", historical_oldest_seen_ts: "1718900250.000100",
      historical_cursor: "syn-his-h-1", historical_cursor_history: JSON.stringify(["syn-his-h-1"]), historical_scan_generation: 3,
      claimed_lane: "newest", lease_owner: "lease-his-r1", lease_expires_at: LIVE, lease_generation: 31, next_lane: "historical",
      due_at: "2026-01-02 00:00:00+00", created_at: "2025-12-31 00:00:00+00" },
    { id: "0f000000-0000-4000-8000-0000000000c2", channel_id: "C0HISONLY002",
      historical_anchor_ts: "1718900500.000000", historical_segment_lower_ts: "1718900100.000000", historical_segment_upper_ts: "1718900300.000000",
      historical_oldest_seen_ts: "1718900200.000000", historical_cursor: "syn-his-h-2",
      historical_cursor_history: JSON.stringify(["syn-his-h-0", "syn-his-h-2"]), historical_scan_generation: 2,
      claimed_lane: "historical", lease_owner: "lease-his-r2", lease_expires_at: LIVE, lease_generation: 41, next_lane: "newest",
      due_at: "2026-01-05 00:00:00+00", created_at: "2025-12-30 00:00:00+00" },
    { id: "0f000000-0000-4000-8000-0000000000c3", channel_id: "C0HISONLY003", lease_generation: 4, next_lane: "historical",
      due_at: "2026-01-06 00:00:00+00", created_at: "2025-12-29 00:00:00+00" },
    { id: "0f000000-0000-4000-8000-0000000000c4", channel_id: "C0HISONLY004",
      newest_anchor_ts: "1718900800.000000", newest_lower_ts: "1718900700.000000", newest_request_lower_ts: "1718900640.000000",
      newest_segment_lower_ts: "1718900640.000000", newest_segment_upper_ts: "1718900800.000000", newest_scan_generation: 2,
      lease_generation: 5, next_lane: "newest", due_at: "2026-01-07 00:00:00+00", created_at: "2025-12-28 00:00:00+00" },
  ].map(variantRow),
  threads: [
    variantThread("0f000000-0000-4000-8000-0000000000e1", "C0HISONLY001", "1718900220.000220", "2026-01-03 00:00:00+00", "2025-12-31 01:00:00+00"),
    variantThread("0f000000-0000-4000-8000-0000000000e2", "C0HISONLY003", "1718900320.000320", "2026-01-04 00:00:00+00", "2025-12-31 02:00:00+00"),
  ],
  presence: {
    columns: NEW_COLUMNS.filter((column) => column !== "historical_cursor_history"),
    checks: [
      { name: "slack_sync_channels_historical_progress_check", kind: "c", validated: true },
      { name: "slack_sync_channels_newest_cursor_history_check", kind: "c", validated: true },
      { name: "slack_sync_channels_newest_progress_check", kind: "c", validated: true },
    ],
    validators: 1,
  },
  maxBefore: [["C0HISONLY001", "newest_cursor_history"]],
  maxAfter: [["C0HISONLY001", "newest_cursor_history"]],
  restarted: new Set(["C0HISONLY001", "C0HISONLY002"]),
  permitted: HISTORICAL_RESTART_FIELDS,
  introduced: ["historical_cursor_history"],
  // Every seeded segment/progress literal is unchanged on EVERY row, restarted or not.
  facts: [
    fact("C0HISONLY001", 7, 4, 31, "historical", { lane: "newest", owner: "lease-his-r1", expires: LIVE }, {
      ...NEWEST_SEGMENTS, historical_segment_lower_ts: "0.000000", historical_segment_upper_ts: "1718900300.000000",
      historical_completed_segments_oldest_ts: "1718900350.5",
    }, false, true, false),
    fact("C0HISONLY002", 0, 3, 42, "historical", NO_CLAIM, {
      ...NO_SEGMENTS, historical_segment_lower_ts: "1718900100.000000", historical_segment_upper_ts: "1718900300.000000",
    }, true, true, false),
    fact("C0HISONLY003", 0, 0, 4, "historical", NO_CLAIM, NO_SEGMENTS, true, true, true),
    fact("C0HISONLY004", 2, 0, 5, "newest", NO_CLAIM, { ...NO_SEGMENTS, ...NEWEST_SEGMENTS }, true, true, true),
  ],
  // Resume both restarted historical lanes inside their KEPT segments; one gets a MAXIMUM history.
  progress: [
    { sql: `update public.slack_sync_channels
               set historical_cursor_history = $1::jsonb, historical_cursor = 'syn-his-h-9', historical_oldest_seen_ts = '1718900260.000000'
             where channel_id = 'C0HISONLY001'`, params: [JSON.stringify(["syn-his-h-9"])] },
    { sql: `update public.slack_sync_channels set historical_cursor_history = $1::jsonb, historical_cursor = $2
             where channel_id = 'C0HISONLY002'`, params: [JSON.stringify(newestMax), newestMax[999]] },
  ],
  maxProgressed: [["C0HISONLY001", "newest_cursor_history"], ["C0HISONLY002", "historical_cursor_history"]],
});

const NEWEST_SEGMENT_COLUMNS = ["newest_request_lower_ts", "newest_segment_lower_ts", "newest_segment_upper_ts"];
const NEWEST_RESTART_FIELDS = [
  "newest_cursor", "newest_cursor_history", "newest_scan_generation",
  "claimed_lane", "lease_owner", "lease_expires_at", "lease_generation", "next_lane", "updated_at",
];
/**
 * SINGLE-LANE SEGMENT-UNIT introduction. ONLY the newest lane's three segment columns, with the
 * newest progress CHECK, are absent; the historical unit, both histories, the validator and three
 * named CHECKs are present.
 *  - only anchored NEWEST lanes restart: one under the opposite lane's live HISTORICAL claim,
 *    whose claim, turn and historical progress survive, and one under its own live newest claim,
 *    which is fenced;
 *  - an idle row is untouched;
 *  - a historical-only row with initialized progress and a MAXIMUM history is untouched.
 */
const newestUnitVariant = (newestMax: string[], historicalMax: string[]): IntroductionVariant => ({
  label: "newest_unit",
  strip: [`alter table public.slack_sync_channels ${NEWEST_SEGMENT_COLUMNS.map((column) => `drop column ${column}`).join(", ")}`],
  insertBeforeStrip: false,
  channels: [
    { id: "0f000000-0000-4000-8000-0000000000f1", channel_id: "C0NEWUNIT001",
      newest_anchor_ts: "1718900800.000000", newest_lower_ts: "1718900700.000000", newest_cursor: "syn-nu-n-2",
      newest_cursor_history: JSON.stringify(["syn-nu-n-1", "syn-nu-n-2"]), newest_scan_generation: 5,
      historical_anchor_ts: "1718900500.000000", historical_segment_lower_ts: "0.000000", historical_segment_upper_ts: "1718900300.000000",
      historical_completed_segments_oldest_ts: "1718900350.5", historical_oldest_seen_ts: "1718900250.000100",
      historical_cursor: "syn-nu-h-1", historical_cursor_history: JSON.stringify(["syn-nu-h-1"]), historical_scan_generation: 3,
      claimed_lane: "historical", lease_owner: "lease-nu-r1", lease_expires_at: LIVE, lease_generation: 31, next_lane: "newest",
      due_at: "2026-01-02 00:00:00+00", created_at: "2025-12-31 00:00:00+00" },
    { id: "0f000000-0000-4000-8000-0000000000f2", channel_id: "C0NEWUNIT002",
      newest_anchor_ts: "1718900800.000000", newest_lower_ts: "1718900700.000000", newest_scan_generation: 2,
      claimed_lane: "newest", lease_owner: "lease-nu-r2", lease_expires_at: LIVE, lease_generation: 41, next_lane: "historical",
      due_at: "2026-01-05 00:00:00+00", created_at: "2025-12-30 00:00:00+00" },
    { id: "0f000000-0000-4000-8000-0000000000f3", channel_id: "C0NEWUNIT003", lease_generation: 4, next_lane: "historical",
      due_at: "2026-01-06 00:00:00+00", created_at: "2025-12-29 00:00:00+00" },
    { id: "0f000000-0000-4000-8000-0000000000f4", channel_id: "C0NEWUNIT004",
      historical_anchor_ts: "1718900500.000000", historical_segment_lower_ts: "1718900100.000000", historical_segment_upper_ts: "1718900300.000000",
      historical_cursor: historicalMax[999], historical_cursor_history: JSON.stringify(historicalMax), historical_scan_generation: 2,
      lease_generation: 5, next_lane: "historical", due_at: "2026-01-07 00:00:00+00", created_at: "2025-12-28 00:00:00+00" },
  ].map(variantRow),
  threads: [
    variantThread("0f000000-0000-4000-8000-0000000000f5", "C0NEWUNIT001", "1718900230.000230", "2026-01-03 00:00:00+00", "2025-12-31 01:00:00+00"),
    variantThread("0f000000-0000-4000-8000-0000000000f6", "C0NEWUNIT003", "1718900330.000330", "2026-01-04 00:00:00+00", "2025-12-31 02:00:00+00"),
  ],
  presence: {
    columns: ["historical_completed_segments_oldest_ts", "historical_cursor_history", "historical_segment_lower_ts",
      "historical_segment_upper_ts", "newest_cursor_history"],
    checks: [
      { name: "slack_sync_channels_historical_cursor_history_check", kind: "c", validated: true },
      { name: "slack_sync_channels_historical_progress_check", kind: "c", validated: true },
      { name: "slack_sync_channels_newest_cursor_history_check", kind: "c", validated: true },
    ],
    validators: 1,
  },
  maxBefore: [["C0NEWUNIT004", "historical_cursor_history"]],
  maxAfter: [["C0NEWUNIT004", "historical_cursor_history"]],
  restarted: new Set(["C0NEWUNIT001", "C0NEWUNIT002"]),
  permitted: NEWEST_RESTART_FIELDS,
  introduced: NEWEST_SEGMENT_COLUMNS,
  // Newly introduced newest values are null everywhere; every seeded historical literal is unchanged.
  facts: [
    fact("C0NEWUNIT001", 6, 3, 31, "newest", { lane: "historical", owner: "lease-nu-r1", expires: LIVE }, {
      ...NO_SEGMENTS, historical_segment_lower_ts: "0.000000", historical_segment_upper_ts: "1718900300.000000",
      historical_completed_segments_oldest_ts: "1718900350.5",
    }, true, false, false),
    fact("C0NEWUNIT002", 3, 0, 42, "newest", NO_CLAIM, NO_SEGMENTS, true, true, false),
    fact("C0NEWUNIT003", 0, 0, 4, "historical", NO_CLAIM, NO_SEGMENTS, true, true, true),
    fact("C0NEWUNIT004", 0, 2, 5, "historical", NO_CLAIM, {
      ...NO_SEGMENTS, historical_segment_lower_ts: "1718900100.000000", historical_segment_upper_ts: "1718900300.000000",
    }, true, false, true),
  ],
  // Initialize both restarted newest lanes; one gets a MAXIMUM history.
  progress: [
    { sql: `update public.slack_sync_channels
               set newest_request_lower_ts = '1718900640.000000', newest_segment_lower_ts = '1718900640.000000',
                   newest_segment_upper_ts = '1718900800.000000', newest_cursor_history = $1::jsonb, newest_cursor = $2
             where channel_id = 'C0NEWUNIT001'`, params: [JSON.stringify(newestMax), newestMax[999]] },
    { sql: `update public.slack_sync_channels
               set newest_request_lower_ts = '1718900640.000000', newest_segment_lower_ts = '1718900640.000000',
                   newest_segment_upper_ts = '1718900800.000000', newest_cursor_history = $1::jsonb, newest_cursor = 'syn-nu-n-9'
             where channel_id = 'C0NEWUNIT002'`, params: [JSON.stringify(["syn-nu-n-9"])] },
  ],
  maxProgressed: [["C0NEWUNIT001", "newest_cursor_history"], ["C0NEWUNIT004", "historical_cursor_history"]],
});

/**
 * Run one variant through all four statement orders, each in its own loader-built database
 * seeded with the variant's identical literal fixture. A fifth, untouched loader-built database
 * supplies the exact accepted final Slack catalog.
 */
async function runIntroductionVariant(variant: IntroductionVariant): Promise<void> {
  const { loadSchema } = await import("@/scripts/pg-load-schema.mjs");
  const sqlFor = assertedEntrypoints();
  const created: Array<{ adminUrl: string; name: string }> = [];
  const newLoadedScratch = async (role: string): Promise<string> => {
    const name = `slackvar_${variant.label}_${role}_${randomUUID().replace(/-/g, "").slice(0, 8)}`;
    // The shared guard refuses BEFORE any connection or database creation.
    const scratch = await createIsolatedScratchDatabase(name);
    created.push({ adminUrl: scratch.adminUrl, name });
    await loadSchema({ cwd: process.cwd(), databaseUrl: scratch.url, logger: { log: () => {} } });
    return scratch.url;
  };
  const runs: Record<string, { logical: unknown; catalog: unknown; progressed: unknown }> = {};
  try {
    // ── The exact accepted final catalog, from an untouched loader-built database. ──
    const referenceUrl = await newLoadedScratch("reference");
    const referenceCatalog = await (async () => {
      const referenceClient = new Client({ connectionString: referenceUrl });
      await referenceClient.connect();
      try {
        return await slackCatalog(referenceClient);
      } finally {
        await referenceClient.end().catch(() => {});
      }
    })();
    expect({ lines: referenceCatalog.lines.length > 0, checks: referenceCatalog.checks.length, validators: referenceCatalog.validator.length },
      `${variant.label}: the reference loader catalog is non-empty, with four named CHECKs and one validator`).toEqual({ lines: true, checks: 4, validators: 1 });

    for (const [label, first, second] of [
      ["migration_only", "migration", "migration"],
      ["mirror_only", "mirror", "mirror"],
      ["mirror_then_migration", "mirror", "migration"],
      ["migration_then_mirror", "migration", "mirror"],
    ] as Array<[string, OrderEntry, OrderEntry]>) {
      const run = `${variant.label}/${label}`;
      const url = await newLoadedScratch(label);
      const c = new Client({ connectionString: url });
      await c.connect();
      try {
        await c.query("set time zone 'UTC'");
        // ── The identical literal pre-introduction fixture. ──
        await orderFixture(c, `insert into teams (id, slug, name) values ($1, 'variant-team', 'Variant Team')`, [ORDER_TEAM_ID]);
        if (!variant.insertBeforeStrip) for (const ddl of variant.strip) await c.query(ddl);
        for (const row of variant.channels) await insertLiteralRow(c, "slack_sync_channels", row);
        for (const row of variant.threads) await insertLiteralRow(c, "slack_sync_threads", row);
        if (variant.insertBeforeStrip) for (const ddl of variant.strip) await c.query(ddl);
        expect(await introductionPresence(c), `${run} fixture: the pre-introduction schema is exactly the variant's`).toEqual(variant.presence);
        for (const [channel, column] of variant.maxBefore) {
          expect(await storedHistorySize(c, channel, column), `${run} fixture: a maximum history is stored before introduction`).toEqual({ bytes: 1048576, entries: 1000 });
        }
        const seeded = await orderEvidence(c);
        const seededPreserved = await digestsExcept(c, [...variant.permitted, ...variant.introduced]);
        const seededComplete = await digestsExcept(c, variant.introduced);

        // ── FIRST entrypoint: the variant's one-time introduction. ──
        expect(await applyEntrySql(c, sqlFor(first)), `${run}: the first entrypoint (${first}) commits with no NOTICE`).toEqual({ outcome: "committed", notices: [] });
        expect(await variantFacts(c), `${run}: exact restart/fence facts; updated_at moved ONLY on the restarted rows`).toEqual(variant.facts);
        const introducedPreserved = await digestsExcept(c, [...variant.permitted, ...variant.introduced]);
        const introducedComplete = await digestsExcept(c, variant.introduced);
        expect({
          restarted: introducedPreserved.filter((row) => variant.restarted.has(row.channel_id)),
          unrestarted: introducedComplete.filter((row) => !variant.restarted.has(row.channel_id)),
        }, `${run}: restarted rows changed ONLY permitted fields; unrestarted rows are exactly as seeded, updated_at included`).toEqual({
          restarted: seededPreserved.filter((row) => variant.restarted.has(row.channel_id)),
          unrestarted: seededComplete.filter((row) => !variant.restarted.has(row.channel_id)),
        });
        for (const [channel, column] of variant.maxAfter) {
          expect(await storedHistorySize(c, channel, column), `${run}: the preserved maximum history is still exactly the maximum`).toEqual({ bytes: 1048576, entries: 1000 });
        }
        const introduced = await orderEvidence(c);
        expect(introduced.threads, `${run}: the thread rows are exactly as seeded`).toEqual(seeded.threads);
        expect(await slackCatalog(c), `${run}: the final Slack catalog is exactly the accepted loader catalog`).toEqual(referenceCatalog);

        // ── SECOND entrypoint, then replays of both: complete rows exact, updated_at included. ──
        for (const [step, entry] of [["second", second], ["replay", first], ["replay", second]] as Array<[string, OrderEntry]>) {
          expect(await applyEntrySql(c, sqlFor(entry)), `${run}: ${step} ${entry} commits with no NOTICE`).toEqual({ outcome: "committed", notices: [] });
          expect(exactRows(await orderEvidence(c)), `${run}: after the ${step} ${entry}, every channel and thread row is exact, updated_at included`).toEqual(exactRows(introduced));
          expect(await slackCatalog(c), `${run}: after the ${step} ${entry}, the Slack catalog is still the accepted one`).toEqual(referenceCatalog);
        }
        // ── Valid progress and MAXIMUM histories AFTER introduction, then replays of both: NO exclusion at all. ──
        for (const { sql, params } of variant.progress) await orderFixture(c, sql, params);
        await orderFixture(c, "update public.slack_sync_channels set updated_at = $1::timestamptz", [ORDER_PROGRESS_UPDATED_AT]);
        for (const [channel, column] of variant.maxProgressed) {
          expect(await storedHistorySize(c, channel, column), `${run}: the progress writes stored a maximum history`).toEqual({ bytes: 1048576, entries: 1000 });
        }
        const progressed = await orderEvidence(c);
        for (const entry of [second, first] as OrderEntry[]) {
          expect(await applyEntrySql(c, sqlFor(entry)), `${run}: ${entry} replay after progress commits with no NOTICE`).toEqual({ outcome: "committed", notices: [] });
          expect(exactRows(await orderEvidence(c)), `${run}: after the ${entry} replay over progress and maximum histories, every row is exact, updated_at included`).toEqual(exactRows(progressed));
          expect(await slackCatalog(c), `${run}: after the ${entry} replay over progress, the Slack catalog is still the accepted one`).toEqual(referenceCatalog);
        }
        // ── The FULL deploy loader replayed over the populated, progressed rows, on its own fresh session. ──
        expect(await sanitizedLoaderReplay(loadSchema, url), `${run}: the full-loader replay over progress commits`).toEqual({ outcome: "committed" });
        expect(exactRows(await orderEvidence(c)), `${run}: after a full-loader replay over progress, every row is exact, updated_at included`).toEqual(exactRows(progressed));
        expect(await slackCatalog(c), `${run}: after a full-loader replay over progress, the Slack catalog is still the accepted one`).toEqual(referenceCatalog);
        runs[label] = {
          logical: {
            channels: introduced.channels.map((row) => ({
              channel_id: row.channel_id, digest: variant.restarted.has(row.channel_id) ? row.without_updated_at : row.full_row,
            })),
            threads: introduced.threads,
          },
          catalog: await slackCatalog(c),
          progressed: exactRows(progressed),
        };
      } finally {
        await c.end().catch(() => {});
      }
    }

    // ── ACROSS the four independent databases: restarted rows differ ONLY in clock-varying updated_at. ──
    for (const label of ["mirror_only", "mirror_then_migration", "migration_then_mirror"]) {
      expect(runs[label].catalog, `${variant.label}: ${label} vs migration_only, identical Slack catalog`).toEqual(runs.migration_only.catalog);
      expect(runs[label].logical,
        `${variant.label}: ${label} vs migration_only, identical channel and thread rows (restarted rows differ ONLY in updated_at)`).toEqual(runs.migration_only.logical);
      expect(runs[label].progressed,
        `${variant.label}: ${label} vs migration_only, identical COMPLETE rows after progress and maximum histories, updated_at included`).toEqual(runs.migration_only.progressed);
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
}

describe("AM-F2 + AC-02 history/segment block — MR-03 introduction variants under every statement order (real Postgres)", () => {
  it(
    "MR-03 a committing segment-only introduction on an F2-only schema restarts every active lane once, under every statement order, and replays exactly",
    async () => {
      const historicalMax = orderMaxHistory("s");
      expect([historicalMax.length, jsonbTextBytes(historicalMax)], "fixture: the maximum history is 1,000 entries of exactly 1,048,576 bytes").toEqual([1000, 1048576]);
      await runIntroductionVariant(segmentOnlyVariant(historicalMax));
    },
    ORDER_TIMEOUT
  );

  it(
    "MR-03 a one-lane history-only introduction restarts only historical lanes, preserving progress, the opposite live claim and its maximum history, under every statement order",
    async () => {
      const newestMax = orderMaxHistory("m");
      expect([newestMax.length, jsonbTextBytes(newestMax)], "fixture: the maximum history is 1,000 entries of exactly 1,048,576 bytes").toEqual([1000, 1048576]);
      await runIntroductionVariant(historyOnlyVariant(newestMax));
    },
    ORDER_TIMEOUT
  );

  it(
    "MR-03 a committing single-lane segment-unit introduction restarts only the affected newest lanes, preserving the opposite live claim and progress, under every statement order",
    async () => {
      const newestMax = orderMaxHistory("p");
      const historicalMax = orderMaxHistory("q");
      expect([[newestMax.length, jsonbTextBytes(newestMax)], [historicalMax.length, jsonbTextBytes(historicalMax)]],
        "fixture: both maximum histories are 1,000 entries of exactly 1,048,576 bytes").toEqual([[1000, 1048576], [1000, 1048576]]);
      await runIntroductionVariant(newestUnitVariant(newestMax, historicalMax));
    },
    ORDER_TIMEOUT
  );
});

// ── DH-11 / C9: the legacy three-column replay, and maximum histories through an unrelated DB writer ──

const LEGACY_THREE_COLUMNS = ["newest_catchup_upper_ts", "metadata_attempt_owner", "metadata_attempt_generation"];
const C9_INTEGRATION_ID = "0f000000-0000-4000-8000-000000000c90";
const C9_CHANNEL = "C0LEGACY3001";

describe("AM-F2 + AC-02 history/segment block — DH-11 legacy three-column replay and unrelated-writer maximum histories (real Postgres)", () => {
  it(
    "re-adds the three legacy metadata/provisional columns without restarting an initialized segment",
    async () => {
      const { loadSchema } = await import("@/scripts/pg-load-schema.mjs");
      const newestMax = orderMaxHistory("x");
      const historicalMax = orderMaxHistory("y");
      expect([[newestMax.length, jsonbTextBytes(newestMax)], [historicalMax.length, jsonbTextBytes(historicalMax)]],
        "fixture: both maximum histories are 1,000 entries of exactly 1,048,576 bytes").toEqual([[1000, 1048576], [1000, 1048576]]);
      const name = `slackc9_${randomUUID().replace(/-/g, "").slice(0, 8)}`;
      // The shared guard refuses BEFORE any connection or database creation.
      const scratch = await createIsolatedScratchDatabase(name);
      try {
        await loadSchema({ cwd: process.cwd(), databaseUrl: scratch.url, logger: { log: () => {} } });
        const c = new Client({ connectionString: scratch.url });
        await c.connect();
        try {
          await c.query("set time zone 'UTC'");
          await orderFixture(c, `insert into teams (id, slug, name) values ($1, 'c9-team', 'C9 Team')`, [ORDER_TEAM_ID]);
          await orderFixture(c, `insert into public.integrations (id, team_id, type, name) values ($1, $2, 'slack', 'c9-binder')`, [C9_INTEGRATION_ID, ORDER_TEAM_ID]);
          // Initialized segments on BOTH lanes, a MAXIMUM history on each, a binding, and planted legacy values.
          await insertLiteralRow(c, "slack_sync_channels", variantRow({
            id: "0f000000-0000-4000-8000-000000000c91", channel_id: C9_CHANNEL, public_state: "public", public_checked_at: "2026-01-01 00:00:00+00",
            binding_integration_id: C9_INTEGRATION_ID, binding_config_revision: "c9".repeat(32),
            newest_anchor_ts: "1718900800.000000", newest_lower_ts: "1718900700.000000", ...NEWEST_SEGMENTS,
            newest_cursor: newestMax[999], newest_cursor_history: JSON.stringify(newestMax), newest_scan_generation: 7,
            historical_anchor_ts: "1718900500.000000", historical_segment_lower_ts: "0.000000", historical_segment_upper_ts: "1718900300.000000",
            historical_completed_segments_oldest_ts: "1718900350.5", historical_oldest_seen_ts: "1718900250.000100",
            historical_cursor: historicalMax[999], historical_cursor_history: JSON.stringify(historicalMax), historical_scan_generation: 3,
            newest_catchup_upper_ts: "1718900900.000000", metadata_attempt_owner: "metadata-c9", metadata_attempt_generation: 3,
            lease_generation: 6, next_lane: "historical", attempts: 2, due_at: "2026-01-02 00:00:00+00", created_at: "2025-12-31 00:00:00+00",
          }));
          const MAX = { bytes: 1048576, entries: 1000 };
          const sizes = async () => [await storedHistorySize(c, C9_CHANNEL, "newest_cursor_history"), await storedHistorySize(c, C9_CHANNEL, "historical_cursor_history")];
          const digestExcept = async (excluded: string[]): Promise<string> => (await digestsExcept(c, excluded))[0].digest;
          expect(await sizes(), "fixture: both lanes hold a maximum history").toEqual([MAX, MAX]);
          const beforeLegacy = await digestExcept(LEGACY_THREE_COLUMNS);

          // ── FIXTURE DDL: remove ONLY the three legacy columns; the real deploy loader must re-add them. ──
          await c.query("alter table public.slack_sync_channels drop column newest_catchup_upper_ts, drop column metadata_attempt_owner, drop column metadata_attempt_generation");
          expect(await sanitizedLoaderReplay(loadSchema, scratch.url), "the full-loader replay commits").toEqual({ outcome: "committed" });
          expect((await c.query(
            `select a.attname as name, pg_catalog.format_type(a.atttypid, a.atttypmod) as type, a.attnotnull as not_null,
                    pg_catalog.pg_get_expr(d.adbin, d.adrelid) as default_expr
               from pg_catalog.pg_attribute a left join pg_catalog.pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
              where a.attrelid = 'public.slack_sync_channels'::regclass and not a.attisdropped and a.attname = any($1::text[])
              order by a.attname collate "C"`, [LEGACY_THREE_COLUMNS]
          )).rows, "the three legacy columns are re-added with their exact metadata").toEqual([
            { name: "metadata_attempt_generation", type: "bigint", not_null: true, default_expr: "0" },
            { name: "metadata_attempt_owner", type: "text", not_null: false, default_expr: null },
            { name: "newest_catchup_upper_ts", type: "text", not_null: false, default_expr: null },
          ]);
          expect((await c.query(
            "select newest_catchup_upper_ts, metadata_attempt_owner, metadata_attempt_generation::int as metadata_attempt_generation from public.slack_sync_channels where channel_id = $1",
            [C9_CHANNEL]
          )).rows[0], "the re-added legacy columns carry their re-add values (the dropped values are gone, by design)").toEqual({
            newest_catchup_upper_ts: null, metadata_attempt_owner: null, metadata_attempt_generation: 0,
          });
          // NO restart: every other column, generations, cursors, histories, segments and updated_at included, is byte-identical.
          expect(await digestExcept(LEGACY_THREE_COLUMNS), "no segment restarted: every column outside the three legacy ones is byte-identical").toBe(beforeLegacy);
          expect(await sizes(), "both maximum histories survive the legacy re-add").toEqual([MAX, MAX]);

          // ── An UNRELATED DB-level writer: integration delete → ON DELETE SET NULL → the binding-clear trigger. ──
          const BINDING = ["binding_integration_id", "binding_config_revision"];
          // Non-vacuity: the four owned named CHECKs exist and are VALIDATED, so the UPDATE below really re-checks them.
          const catalogBeforeDelete = await slackCatalog(c);
          expect(catalogBeforeDelete.checks.map((row) => ({ name: row.name, validated: row.validated })),
            "the four owned named CHECKs are present and validated before the unrelated writer runs").toEqual([
            { name: "slack_sync_channels_historical_cursor_history_check", validated: true },
            { name: "slack_sync_channels_historical_progress_check", validated: true },
            { name: "slack_sync_channels_newest_cursor_history_check", validated: true },
            { name: "slack_sync_channels_newest_progress_check", validated: true },
          ]);
          const beforeDelete = await digestExcept(BINDING);
          await orderFixture(c, "delete from public.integrations where id = $1", [C9_INTEGRATION_ID]);
          expect((await c.query(
            "select binding_integration_id is null as integration_cleared, binding_config_revision is null as revision_cleared from public.slack_sync_channels where channel_id = $1",
            [C9_CHANNEL]
          )).rows[0], "the FK cleared the binding and the trigger cleared its paired revision").toEqual({ integration_cleared: true, revision_cleared: true });
          expect(await digestExcept(BINDING), "the binding writer changed nothing else; both history CHECKs re-passed on that UPDATE").toBe(beforeDelete);
          expect(await sizes(), "both maximum histories survive the unrelated binding writer").toEqual([MAX, MAX]);
          expect(await slackCatalog(c), "the Slack catalog, the four validated named CHECKs included, is unchanged by the unrelated writer").toEqual(catalogBeforeDelete);
        } finally {
          await c.end().catch(() => {});
        }
      } finally {
        // Cleanup never replaces the primary failure: every step is caught, as the repository precedent does.
        const dropper = new Client({ connectionString: scratch.adminUrl });
        await dropper.connect().catch(() => {});
        await dropper.query(`drop database if exists ${name} with (force)`).catch(() => {});
        await dropper.end().catch(() => {});
      }
    },
    ORDER_TIMEOUT
  );
});
