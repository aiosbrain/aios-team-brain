import { readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createIsolatedScratchDatabase } from "./slack-history-isolated-url";

/**
 * AIO-1170 AM-F2 + AC-02 deep history — RED PACKET 3: catalog identity, conflicts, the state
 * rejection matrix, claim/restart edges and replay, against the real migration on real PostgreSQL
 * (accepted consolidated contract `aio1170-am-f2-deep-history-consolidated-accepted-spec-migration-v1-20261023.md`,
 * §3.1, §4, §9, §9.3 MR-02/MR-03/MR-04, §10 DH-11, §10.1 F2-12).
 *
 * Sibling of `slack-history-progress-upgrade.datamechanics.test.ts`, which keeps its one narrow
 * populated-union case unchanged. This file uses ONE scratch database per run. It is created and
 * dropped here only after the shared `DATABASE_TEST_URL` guard (`./slack-history-isolated-url.ts`:
 * the isolated local runner, or CI's `postgres:5432` service under `GITHUB_ACTIONS=true`) accepts
 * the URL, and it is loaded once by the real loader. Every database case first rebuilds the pre-F2 table with FIXTURE DDL on that throwaway
 * database only (§9.3 permits test-only legacy reconstruction) and asserts it is pre-F2 before
 * seeding. Migrations run on one session; every inspection after them runs on a SECOND session, so
 * rollback evidence is read from a fresh, usable connection (§9 / MR-04).
 *
 * ORACLES. Every expectation is a literal written here. That includes PostgreSQL's
 * `pg_get_constraintdef` rendering of the four named CHECKs, derived by hand from the accepted
 * predicates and PostgreSQL's deparse rules, and the validator's whole body. None is read back from
 * the migration or the schema under test. The static source fences read those files only as the
 * subject of the parity/discipline rules they state.
 *
 * LITERAL-ORACLE DISCIPLINE. The CHECK renderings and the validator body are exact change detectors
 * for the isolated runner's PostgreSQL 16 (`scripts/dm-isolated.sh` pins `postgres:16`). They are
 * not contract text. A mismatch is evidence to adjudicate, never a value to paste back:
 *  - a deparse-only difference under another server version needs a reviewed literal update;
 *  - any semantic difference is a production finding.
 * The owned-function inventory pins the validator and the deleted-binding trigger function, and
 * forbids any other function in the table's naming families EXCEPT a `…progress…` helper. §9
 * permits one if it is narrowly scoped; adding one requires its own exact metadata/body pin here.
 *
 * PRIVACY. Assertions never print a cursor, a history or an error's free text:
 *  - refusals are projected to SQLSTATE, a message that is either one of the two accepted static
 *    messages or a fixed placeholder, and the PRESENCE (never the content) of every
 *    value-bearing error field;
 *  - cursors and histories are compared by SQL equality (booleans) or as part of a whole-row
 *    digest, never as their own hash;
 *  - row preservation is reported as the NAMES of changed columns, never their values;
 *  - refusal cases plant `CANARY` cursors and require that no error field carries one.
 * Scalar bookkeeping (generations, lease fields, bounds, planted metadata) is literal, non-secret
 * fixture data.
 *
 * WHAT THIS FILE PROVES. Status is stated against production at 83162b68, where the constraint-kind
 * guard and the corrected schema comment have landed, so EVERY test below is expected GREEN. The
 * refusal-surface matrix (packet 4) is proof-only unless its run says otherwise:
 *  - MR-02 catalog identity: the loader-path catalog (schema.sql plus every effective migration, as
 *    `scripts/pg-load-schema.mjs` loads them) and the direct-migration catalog both carry:
 *    · exactly the eight columns;
 *    · exactly the 25 pre-F2 constraints plus the four named CHECKs, each with its exact definition
 *      and validated;
 *    · no other owned function;
 *    · the exact validator, metadata AND body.
 *    Expected GREEN today.
 *  - MR-04 helper conflict: a validator with the accepted identity but a DEFAULTED argument is
 *    refused with static P0001 / AM_F2_UPGRADE_INVALID_STATE, all-or-nothing. Expected GREEN today.
 *  - MR-04 REFUSAL-SURFACE MATRIX (packet 4). Each case starts from a reset table and plants a
 *    baseline:
 *    · one channel row with a CANARY cursor and distinctive non-default safe metadata;
 *    · one unrelated queued `slack_sync_threads` row, with non-vacuity asserted.
 *    It then builds exactly one conflict and asserts that conflict as a literal FIXTURE FACT, so a
 *    setup that silently built nothing cannot pass. It then requires:
 *    · a static P0001 refusal by name family, with no NOTICE, no value-bearing field and no canary;
 *    · from the second session, the table's complete column and constraint catalog, every routine
 *      named like the validator, the owned functions, the channel rows and the thread rows all
 *      exactly as before the run.
 *    Families:
 *    · wrong kind: each of the FOUR reserved CHECK names held by a UNIQUE and by a FOREIGN KEY
 *      constraint (8). A cursor-history name maps to AM_F2, a progress name to AC02.
 *    · partial segment units: one-of-three and two-of-three present, for each lane (4, AC02).
 *    · present-column metadata, on an F2 schema state: a domain, a wrong default, wrong
 *      nullability and GENERATED, each for a history column (AM_F2) and a progress column
 *      (AC02) (8).
 *    · validator identity: security definer; no search_path; another search_path; stable
 *      volatility; not strict; parallel restricted; plpgsql; integer return; set-returning;
 *      argument name; text argument type; leakproof; support function; procedure kind (14,
 *      AM_F2). Each also asserts the exact list of metadata keys in which its fixture differs
 *      from the accepted validator.
 *    ENTRYPOINTS. The whole matrix (34) runs through the migration file. The byte-identical marked
 *    statement extracted from `schema.sql` runs a representative cross-entrypoint set (7): one
 *    wrong-kind FK (AM_F2), one partial unit (AC02), two metadata conflicts (AC02, AM_F2), one
 *    validator conflict (AM_F2), one state rejection (AC02) and one restart-hiding prevalidation
 *    (AC02). Both paths use the same runner, the same expected static error and the same
 *    rollback evidence. B8 (continuation 4) makes the mirror EXHAUSTIVE: every matrix case, the
 *    state refusals, and literal twins of the dedicated migration-only refusals. The REAL deploy
 *    loader (whole `schema.sql`, one atomic query, run before any migration) refuses EVERY one of
 *    those fixtures (B8 tail, continuation 6), with the source-backed reachability noted at
 *    LOADER_SET. Its notices go to its own logger and are not asserted.
 *    POSTGRESQL 16 REPRESENTABILITY:
 *    · an IDENTITY column must be smallint/integer/bigint, so it cannot be built on an owned jsonb
 *      or text column; GENERATED is covered instead;
 *    · an explicit DEFAULT NULL stores no pg_attrdef row, so it is not a distinct conflict;
 *    · a PROCEDURE cannot carry a return type, volatility, strictness or parallel marking, and
 *      `pg_get_function_identity_arguments` renders its argument signature differently from a
 *      function's, so object kind cannot vary alone; its fixture asserts its exact diff (args,
 *      kind, parallel, returns, strict, volatility);
 *    · LEAKPROOF and SUPPORT need a superuser, which the isolated runner's `app` role is (the
 *      `postgres:16` container's POSTGRES_USER).
 *    Expected GREEN; any failure is a newly found production gap.
 *  - MR-04 / §4 state rejection matrix: refused with static errors and full rollback:
 *    · an inactive historical lane carrying an attempt-oldest (AC02);
 *    · an active newest lane with no logical lower B (AC02);
 *    · a legacy null-anchor/non-null-cursor lane (AM_F2);
 *    · persisted histories that are duplicate, terminal-mismatched, empty under a non-null cursor,
 *      non-array or over the entry cap (AM_F2).
 *    Expected GREEN today.
 *  - MR-04 restart-hiding prevalidation: a defect that the one-time restart would itself erase
 *    must be refused BEFORE the restart:
 *    · a history-only introduction whose historical attempt-oldest lies outside [S,U] (AC02);
 *    · a segment-only introduction over a terminal-mismatched newest history (AM_F2).
 *    Each is refused statically, rolls back whole-row from a fresh session, and leaves the absent
 *    columns absent. Expected GREEN today.
 *  - The exact validator's truth table: trim set, C0/DEL, C1, UTF-16 units, distinctness, element
 *    and container types, and the exact inclusive entry/byte caps, including a 1000-entry history
 *    of exactly 1,048,576 serialized bytes. The installed CHECKs enforce linkage and the §4 progress
 *    matrix. Expected GREEN today.
 *  - MR-03 / F2-12 claim/restart edges under a union introduction:
 *    · a cursor-null live claim on the restarted lane (fenced);
 *    · an expired claim (fenced);
 *    · both lanes active with a claim (both restarted, fenced once);
 *    · an anchored null-cursor lane with no claim (restarted, turn kept);
 *    · an idle row, fully untouched including `updated_at`;
 *    · every non-permitted column unchanged, on rows that carry PLANTED non-default values for
 *      attempts, error/success metadata, certification/catch-up state, the metadata owner, the
 *      public proof, the binding, the due time and the created time (non-vacuity asserted first).
 *    Then a history-only one-lane introduction that preserves the opposite live claim and the
 *    restarted lane's segment bounds and aggregate. Its whole row, every planted value included,
 *    is preserved except for the five permitted historical restart fields. Then replay after
 *    segment progress and MAXIMUM histories on both lanes, which must leave every row
 *    byte-identical. Expected GREEN today.
 *  - DH-11 source fences (static, no database):
 *    · exactly one marker pair per file;
 *    · nothing executable outside the migration's marked DO;
 *    · byte parity of the two marked statements;
 *    · placement right after the legacy extractor;
 *    · no skip-NOTICE conditional DDL, notice level, GUC suppression, catch-all handler, value-bearing
 *      DETAIL/HINT or transaction control;
 *    · only the two static errors;
 *    · the table lock before any catalog observation.
 *    Expected GREEN today.
 *  - Schema comment precision: the comment block directly above the eight from-zero columns in
 *    `slack_sync_channels` must not claim, in any wording, that the two paths share a catalog
 *    ("same"/"identical"/"equal"/"agree" … "catalog"). Only the executable statement's byte
 *    identity is guaranteed, and from-zero columns sit in different attribute positions from
 *    upgraded ones. GREEN since the comment was corrected at 83162b68.
 *
 * TEST COUNT: 161 = 5 static (including the MR-05 mutation-hook guard) + 156 database. The
 * database tests are:
 *  - 17 earlier: loader catalog, direct catalog, defaulted helper, 3 state rejections, 5 persisted
 *    histories, 2 restart-hiding, validator truth table, CHECK matrix, union restart, one-lane
 *    replay;
 *  - 34 in the migration refusal matrix;
 *  - 45 in the EXHAUSTIVE schema-mirror refusal set:
 *    · the 34 matrix cases;
 *    · 2 state refusals;
 *    · 9 literal twins of the dedicated migration-only refusals (defaulted helper, the two
 *      newest-lane state rejections, five persisted-history defects, segment-only restart-hiding);
 *  - 45 whole-schema refusals through the REAL deploy loader: the same exhaustive set, every
 *    fixture reachable;
 *  - 11 replay-time cases (B5/B6). The three refusals run through the migration, the marked mirror
 *    AND the real loader (9), and the committing replacement runs through the migration and the
 *    mirror (2):
 *    · a pure replay (all eight columns present) refusing a stored invalid progress tuple left
 *      behind a removed CHECK (AC02);
 *    · the historical-lane legacy null-anchor/non-null-cursor refusal (AM_F2);
 *    · a same-name WEAKER CHECK over a row the canonical one rejects, refused statically BEFORE
 *      any drop, so no value-bearing 23514 failing-row DETAIL can surface (AC02);
 *    · a same-name CHECK with a different definition over VALID rows, replaced by the canonical
 *      one, committing notice-free with no row change;
 *  - 4 B7 atomicity/serialization cases, with PostgreSQL-native coordination: an advisory lock, a
 *    held table lock, and `pg_stat_activity` used only as a bounded readiness probe:
 *    · cancellation INSIDE the block (2 tests: the migration file, and the marked mirror
 *      statement). A fixture trigger blocks the restart UPDATE after the column introduction;
 *      `pg_cancel_backend` then gives 57014. A FRESH session sees no introduced column, the
 *      cancelled session is usable, and every column, constraint, routine, channel and thread row
 *      is as before;
 *    · concurrency (1 test): TWO MIGRATION-FILE executions in two real sessions, queued on one
 *      held lock. Both commit, the active lane restarts EXACTLY once, and the catalog is exactly
 *      the accepted one. The mirror statement is not in this case;
 *    · later-query failure (1 test), in three steps:
 *      1. the repository's COMPLETE real deploy-loader query (whole schema.sql, then every
 *         migration) commits the introduction;
 *      2. a SEPARATE later query, the migration file plus a deliberate 22012, fails. Only that
 *         query rolls back, and the loader-committed state is kept exactly;
 *      3. a MIGRATION-FILE retry commits with no second restart.
 *      No global rollback is claimed. Failures surface only as SQLSTATEs.
 * The two earlier UNIQUE-only wrong-kind cases are absorbed into the matrix. Intended REDs at
 * 83162b68: none.
 *
 * SEPARATE PRODUCTION-COMMENT CLEANUP (not done here; tests never edit production): the migration
 * header's ordered-step comment does not yet list the constraint-kind guard. That belongs to a
 * later production packet.
 *
 * WHAT REMAINS, NOT claimed here:
 *  - MR-02: covered for the Slack-owned objects by the sibling
 *    `slack-history-progress-catalog.datamechanics.test.ts`. That sibling is the Astra-approved
 *    Packet 5 placement amendment, for MR-02 only. It does NOT complete MR-06 or widen production
 *    scope. It proves:
 *    · schema-only vs loader-path fingerprint parity;
 *    · a real custom-format pg_dump and a real pg_restore under an empty search_path;
 *    · after the restore, an exact migration replay and a deploy-loader (`loadSchema`) replay.
 *    Repo-wide parity stays with `npm run test:migrate-from-existing`.
 *  - MR-03:
 *    · mirror-only execution and both execution orders on independent fixtures;
 *    · a COMMITTING segment-only introduction on an F2-only SCHEMA state (only its refusal is here);
 *    · staged/published/ledger evidence rows.
 *  - MR-04 refusals not yet exercised:
 *    · (not missing, for clarity: the B5/B6 replay-time cases run through both the migration and
 *      the marked mirror. Of the B7 cases, only cancellation does; concurrency uses two migration
 *      executions, and the later-query retry starts from the complete loader, then uses migration
 *      failure and migration retry, as itemized above);
 *    · identity metadata (not representable on PostgreSQL 16; see above).
 *  - DH-11: the §9 named tests in the source-fences/upgrade files, including renaming the legacy
 *    three-column replay test to `re-adds the three legacy metadata/provisional columns without
 *    restarting an initialized segment`, and maximum histories through unrelated writers.
 *  - MR-05 structural sweeps; MR-06 (held until PR743 staging); every runtime/DH-12/DH-13 behavior,
 *    which needs the not-yet-wired writer and is not claimed by this migration packet.
 */

const SCRATCH_TIMEOUT = 300_000;
const ROOT = process.cwd();
/**
 * MR-05 controlled-mutation hooks (C10). An ABSOLUTE path in `AIO1170_MR05_MIGRATION_FILE` /
 * `AIO1170_MR05_SCHEMA_FILE` replaces the migration / schema SOURCE this file reads, so the
 * coordinator can run a mutant from a scratch copy without touching production files:
 *  - a mirror-block-only drift in a schema copy must fail the static parity assertion;
 *  - a comment-only migration copy must fail the migration-path catalog/state assertions.
 * Restoring is unsetting the variable. The full-loader entrypoint always reads the real tree.
 * The guard test below fails ANY run where a hook is set, so a normal or CI run cannot pass
 * through an override.
 */
function mutationOverride(variable: string, fallback: string): string {
  const value = process.env[variable];
  if (value === undefined || value === "") return fallback;
  if (!isAbsolute(value)) throw new Error(`${variable} must be an absolute path`);
  return value;
}
const MIGRATION_PATH = mutationOverride("AIO1170_MR05_MIGRATION_FILE", join(ROOT, "postgres", "migrations", "20261023120000_slack_channel_history_segments.sql"));
const SCHEMA_PATH = mutationOverride("AIO1170_MR05_SCHEMA_FILE", join(ROOT, "postgres", "schema.sql"));
const MARKER = "slack-channel-history-segments-upgrade";
const AM_F2 = "AM_F2_UPGRADE_INVALID_STATE";
const AC02 = "AC02_PROGRESS_UPGRADE_INVALID_STATE";

// ── THE ACCEPTED CATALOG, written out ──

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
const TEXT_PROGRESS = { type: "text", not_null: false, default_expr: null, generated: "", identity: "" };
const HISTORY = { type: "jsonb", not_null: true, default_expr: "'[]'::jsonb", generated: "", identity: "" };
const EXPECTED_COLUMNS = [
  { name: "historical_completed_segments_oldest_ts", ...TEXT_PROGRESS },
  { name: "historical_cursor_history", ...HISTORY },
  { name: "historical_segment_lower_ts", ...TEXT_PROGRESS },
  { name: "historical_segment_upper_ts", ...TEXT_PROGRESS },
  { name: "newest_cursor_history", ...HISTORY },
  { name: "newest_request_lower_ts", ...TEXT_PROGRESS },
  { name: "newest_segment_lower_ts", ...TEXT_PROGRESS },
  { name: "newest_segment_upper_ts", ...TEXT_PROGRESS },
];

/** The four named CHECKs §9 installs, in byte (C) order. */
const NAMED_CHECKS = [
  "slack_sync_channels_historical_cursor_history_check",
  "slack_sync_channels_historical_progress_check",
  "slack_sync_channels_newest_cursor_history_check",
  "slack_sync_channels_newest_progress_check",
];

/** Building blocks of PostgreSQL's rendering, from literals only. */
const CANONICAL_BOUND = `'^(0|[1-9][0-9]{0,11})[.][0-9]{6}$'::text`;
const PROVIDER_TS = `'^[0-9]+[.][0-9]{1,6}$'::text`;
const canonical = (column: string): string => `(${column} ~ ${CANONICAL_BOUND})`;
const provider = (column: string): string => `(${column} ~ ${PROVIDER_TS})`;
const integerDigits = (column: string): string => `char_length(ltrim(split_part(${column}, '.'::text, 1), '0'::text))`;
const atMostTwelveDigits = (column: string): string => `(${integerDigits(column)} <= 12)`;
const num = (column: string): string => `(${column})::numeric`;

const historyCheck = (lane: "newest" | "historical"): string => [
  "CHECK (",
  "CASE",
  `    WHEN slack_channel_cursor_history_valid(${lane}_cursor_history) THEN`,
  "    CASE",
  `        WHEN (${lane}_cursor IS NULL) THEN (${lane}_cursor_history = '[]'::jsonb)`,
  `        ELSE ((${lane}_anchor_ts IS NOT NULL) AND (jsonb_array_length(${lane}_cursor_history) > 0) AND ((${lane}_cursor_history -> '-1'::integer) = to_jsonb(${lane}_cursor)))`,
  "    END",
  "    ELSE false",
  "END)",
].join("\n");

const NEWEST_PROGRESS_CHECK = [
  "CHECK (",
  "CASE",
  "    WHEN (newest_anchor_ts IS NULL) THEN ((newest_request_lower_ts IS NULL) AND (newest_segment_lower_ts IS NULL) AND (newest_segment_upper_ts IS NULL))",
  "    WHEN ((newest_request_lower_ts IS NULL) AND (newest_segment_lower_ts IS NULL) AND (newest_segment_upper_ts IS NULL)) THEN ((newest_cursor IS NULL) AND (newest_lower_ts IS NOT NULL))",
  `    WHEN (${canonical("newest_request_lower_ts")} AND ${canonical("newest_segment_lower_ts")} AND ${canonical("newest_segment_upper_ts")} AND ${provider("newest_anchor_ts")} AND ${atMostTwelveDigits("newest_anchor_ts")} AND ${provider("newest_lower_ts")}) THEN ((${num("newest_segment_upper_ts")} <= 253402300799.999999) AND (${num("newest_request_lower_ts")} <= ${num("newest_segment_lower_ts")}) AND (${num("newest_segment_lower_ts")} <= ${num("newest_segment_upper_ts")}) AND (${num("newest_segment_upper_ts")} <= ${num("newest_anchor_ts")}) AND`,
  "    CASE",
  `        WHEN (${integerDigits("newest_lower_ts")} > 12) THEN true`,
  `        ELSE (${num("newest_request_lower_ts")} <= ${num("newest_lower_ts")})`,
  "    END)",
  "    ELSE false",
  "END)",
].join("\n");

const HISTORICAL_PROGRESS_CHECK = [
  "CHECK (",
  "CASE",
  "    WHEN (historical_anchor_ts IS NULL) THEN ((historical_segment_lower_ts IS NULL) AND (historical_segment_upper_ts IS NULL) AND (historical_completed_segments_oldest_ts IS NULL) AND (historical_oldest_seen_ts IS NULL))",
  "    WHEN ((historical_segment_lower_ts IS NULL) AND (historical_segment_upper_ts IS NULL)) THEN ((historical_completed_segments_oldest_ts IS NULL) AND (historical_oldest_seen_ts IS NULL) AND (historical_cursor IS NULL))",
  `    WHEN (${canonical("historical_segment_lower_ts")} AND ${canonical("historical_segment_upper_ts")} AND ${provider("historical_anchor_ts")} AND ${atMostTwelveDigits("historical_anchor_ts")} AND ((historical_oldest_seen_ts IS NULL) OR (${provider("historical_oldest_seen_ts")} AND ${atMostTwelveDigits("historical_oldest_seen_ts")})) AND ((historical_completed_segments_oldest_ts IS NULL) OR (${provider("historical_completed_segments_oldest_ts")} AND ${atMostTwelveDigits("historical_completed_segments_oldest_ts")}))) THEN ((${num("historical_segment_upper_ts")} <= 253402300799.999999) AND (${num("historical_segment_lower_ts")} <= ${num("historical_segment_upper_ts")}) AND (${num("historical_segment_upper_ts")} <= ${num("historical_anchor_ts")}) AND`,
  "    CASE",
  "        WHEN (historical_oldest_seen_ts IS NULL) THEN true",
  `        ELSE ((${num("historical_segment_lower_ts")} <= ${num("historical_oldest_seen_ts")}) AND (${num("historical_oldest_seen_ts")} <= ${num("historical_segment_upper_ts")}))`,
  "    END AND",
  "    CASE",
  "        WHEN (historical_completed_segments_oldest_ts IS NULL) THEN true",
  `        ELSE ((${num("historical_segment_upper_ts")} < ${num("historical_completed_segments_oldest_ts")}) AND (${num("historical_completed_segments_oldest_ts")} <= ${num("historical_anchor_ts")}))`,
  "    END)",
  "    ELSE false",
  "END)",
].join("\n");

const EXPECTED_NAMED_CHECKS = [
  { name: "slack_sync_channels_historical_cursor_history_check", kind: "c", definition: historyCheck("historical"), validated: true },
  { name: "slack_sync_channels_historical_progress_check", kind: "c", definition: HISTORICAL_PROGRESS_CHECK, validated: true },
  { name: "slack_sync_channels_newest_cursor_history_check", kind: "c", definition: historyCheck("newest"), validated: true },
  { name: "slack_sync_channels_newest_progress_check", kind: "c", definition: NEWEST_PROGRESS_CHECK, validated: true },
];

/** Every table constraint after F2, by name in byte order: the 25 pre-F2 ones plus the four. */
const POST_F2_CONSTRAINT_NAMES = [
  "attempts_check", "binding_codec", "binding_config_revision_check", "binding_integration_id_fkey",
  "channel_id_check", "claimed_lane_check", "historical_cursor_check", "historical_cursor_history_check",
  "historical_progress_check", "historical_scan_generation_check", "interval_codec", "last_error_code_check",
  "lease_codec", "lease_generation_check", "lease_owner_check", "lease_owner_key",
  "metadata_attempt_generation_check", "newest_cursor_check", "newest_cursor_history_check",
  "newest_progress_check", "newest_scan_generation_check", "next_lane_check", "pkey", "public_codec",
  "public_state_check", "team_id_fkey", "team_id_workspace_id_channel_id_key", "ts_syntax", "workspace_id_check",
].map((suffix) => `slack_sync_channels_${suffix}`);

/** The validator's whole accepted body (`prosrc`), line by line. */
const VALIDATOR_SOURCE = [
  "",
  "    select case",
  "      when pg_catalog.jsonb_typeof(history) is distinct from 'array' then false",
  "      when pg_catalog.jsonb_array_length(history) > 1000 then false",
  "      when pg_catalog.octet_length(history::pg_catalog.text) > 1048576 then false",
  "      else coalesce((",
  "        select pg_catalog.bool_and(",
  "                 pg_catalog.jsonb_typeof(x.e) = 'string'",
  "                 and (x.e #>> '{}') collate pg_catalog.\"C\" ~ ('[^' || pg_catalog.chr(9) || '-' || pg_catalog.chr(13)",
  "                       || pg_catalog.chr(32) || pg_catalog.chr(160) || pg_catalog.chr(5760)",
  "                       || pg_catalog.chr(8192) || '-' || pg_catalog.chr(8202) || pg_catalog.chr(8232)",
  "                       || pg_catalog.chr(8233) || pg_catalog.chr(8239) || pg_catalog.chr(8287)",
  "                       || pg_catalog.chr(12288) || pg_catalog.chr(65279) || ']')",
  "                 and (x.e #>> '{}') collate pg_catalog.\"C\" !~ ('[' || pg_catalog.chr(1) || '-' || pg_catalog.chr(31)",
  "                       || pg_catalog.chr(127) || ']')",
  "                 and pg_catalog.char_length(x.e #>> '{}')",
  "                     + pg_catalog.char_length(pg_catalog.regexp_replace((x.e #>> '{}') collate pg_catalog.\"C\",",
  "                         '[^' || pg_catalog.chr(65536) || '-' || pg_catalog.chr(1114111) || ']', '', 'g')) <= 1024",
  "               ) and pg_catalog.count(distinct x.e) = pg_catalog.count(*)",
  "          from pg_catalog.jsonb_array_elements(history) as x(e)",
  "      ), true)",
  "    end",
  "  ",
].join("\n");
const EXPECTED_VALIDATOR = [{
  name: "slack_channel_cursor_history_valid", args: "history jsonb", returns: "boolean", language: "sql", kind: "f",
  volatility: "i", strict: true, parallel: "s", security_definer: false, returns_set: false, leakproof: false,
  config: ["search_path=pg_catalog"], arg_names: ["history"], arg_defaults: 0, support: "-", source: VALIDATOR_SOURCE,
}];
/**
 * Every public function in the table's naming families once F2 is in, apart from any `…progress…`
 * helper. §9 permits a narrowly scoped one; it is excluded from this inventory, not forbidden, and
 * adding one requires its own exact pin here.
 */
const POST_F2_OWNED_FUNCTIONS = ["slack_channel_cursor_history_valid", "slack_sync_channels_clear_deleted_binding"];

// ── FIXTURE IDENTITY, literal ──

const TEAM_ID = "6b2c3d4e-5f60-4b7c-9d8e-1f2a3b4c5d6e";
const WORKSPACE = "T0CONFLICT1";
const SEEDED_UPDATED_AT = "2026-01-02 03:04:05+00";
const LIVE_EXPIRY = "2030-01-01 00:00:00+00";
const PAST_EXPIRY = "2020-01-01 00:00:00+00";
const INTEGRATION_ID = "7c3d4e5f-6071-4c8d-8e9f-2a3b4c5d6e7f";

/**
 * PLANTED, distinctive, valid non-default values for every column the restart must NOT touch, one
 * set per row, so "unchanged" is never a comparison of nulls and defaults.
 */
const PLANTED: Record<string, Record<string, unknown>> = {
  C0BOTHLANE01: {
    attempts: 7, last_error_code: "rate_limited", last_read_at: "2026-01-01 10:00:00+00",
    completed_lower_ts: "1718899000.000000", completed_upper_ts: "1718899100.000000", historical_floor_reached: false,
    newest_catchup_upper_ts: "1718900900.000000", metadata_attempt_owner: "metadata-owner-r2", metadata_attempt_generation: 5,
    public_state: "public", public_checked_at: "2026-01-01 00:00:00+00",
    binding_integration_id: INTEGRATION_ID, binding_config_revision: "abababababababababababababababababababababababababababababababab",
    due_at: "2026-01-05 00:00:00+00", created_at: "2025-12-30 00:00:00+00",
  },
  C0CLAIMHIST1: {
    attempts: 2, last_error_code: "invocation_budget", last_read_at: "2026-01-01 11:00:00+00",
    completed_lower_ts: "1718898000.000000", completed_upper_ts: "1718898100.000000", historical_floor_reached: true,
    newest_catchup_upper_ts: "1718900950.000000", metadata_attempt_owner: "metadata-owner-r1", metadata_attempt_generation: 3,
    public_state: "private", public_checked_at: "2026-01-01 01:00:00+00",
    binding_integration_id: INTEGRATION_ID, binding_config_revision: "cdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd",
    due_at: "2026-01-06 00:00:00+00", created_at: "2025-12-29 00:00:00+00",
  },
  C0EXPIRED001: {
    attempts: 9, last_error_code: "provider_error", last_read_at: "2026-01-01 12:30:00+00",
    completed_lower_ts: "1718897000.000000", completed_upper_ts: "1718897100.000000", historical_floor_reached: true,
    newest_catchup_upper_ts: "1718900990.000000", metadata_attempt_owner: "metadata-owner-r5", metadata_attempt_generation: 8,
    public_state: "unverifiable", public_checked_at: "2026-01-01 02:00:00+00",
    binding_integration_id: INTEGRATION_ID, binding_config_revision: "efefefefefefefefefefefefefefefefefefefefefefefefefefefefefefefef",
    due_at: "2026-01-07 00:00:00+00", created_at: "2025-12-28 00:00:00+00",
  },
  C0ONELANE001: {
    attempts: 4, last_error_code: "rate_limited", last_read_at: "2026-01-01 09:00:00+00",
    completed_lower_ts: "1718896000.000000", completed_upper_ts: "1718896100.000000", historical_floor_reached: true,
    newest_catchup_upper_ts: "1718900850.000000", metadata_attempt_owner: "metadata-owner-r6", metadata_attempt_generation: 6,
    public_state: "public", public_checked_at: "2026-01-01 03:00:00+00",
    binding_integration_id: INTEGRATION_ID, binding_config_revision: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    due_at: "2026-01-08 00:00:00+00", created_at: "2025-12-27 00:00:00+00",
  },
  // The refusal matrix's baseline row.
  C0MATRIX0001: {
    attempts: 3, last_error_code: "provider_error", last_read_at: "2026-01-01 08:00:00+00",
    completed_lower_ts: "1718895000.000000", completed_upper_ts: "1718895100.000000", historical_floor_reached: true,
    newest_catchup_upper_ts: "1718900800.000000", metadata_attempt_owner: "metadata-owner-mx", metadata_attempt_generation: 2,
    public_state: "private", public_checked_at: "2026-01-01 04:00:00+00",
    binding_integration_id: INTEGRATION_ID, binding_config_revision: "9f9f9f9f9f9f9f9f9f9f9f9f9f9f9f9f9f9f9f9f9f9f9f9f9f9f9f9f9f9f9f9f",
    due_at: "2026-01-09 00:00:00+00", created_at: "2025-12-26 00:00:00+00",
  },
};
/** The refusal matrix's baseline channel and its unrelated queued thread. */
const BASE_CHANNEL = "C0MATRIX0001";
const BASE_THREAD_ROOT = "1718900200.000200";

/** A fixture statement's failure, redacted to SQLSTATE and constraint name: never a failing-row DETAIL. */
class FixtureError extends Error {
  readonly code: unknown;
  readonly constraint: unknown;
  constructor(code: unknown, constraint: unknown) {
    super(`fixture statement failed (SQLSTATE ${String(code)}${constraint ? `, constraint ${String(constraint)}` : ""})`);
    this.code = code;
    this.constraint = constraint;
  }
}

/**
 * A maximum accepted history (§3.1): 1,000 distinct valid entries serialized as EXACTLY 1,048,576
 * bytes by PostgreSQL's jsonb text form (`["a", "b"]`: 2 brackets, 2 quotes per entry, ", " between).
 * Each entry is a 4-byte ASCII id plus U+4E00 (3 UTF-8 bytes, 1 UTF-16 unit) padding: 576 entries
 * of 1,045 bytes and 424 of 1,044, so 2 + 1,044,576 + 2,000 + 1,998 = 1,048,576. `overByOne` makes
 * entry 576 one byte longer, which yields 1,048,577 bytes with the same 1,000 entries.
 */
function maxHistory(prefix: string, overByOne = false): string[] {
  const entries: string[] = [];
  const long = overByOne ? 577 : 576;
  for (let i = 0; i < 1000; i += 1) {
    const id = `${prefix}${String(i).padStart(3, "0")}`;
    entries.push(i < long ? id + "一".repeat(347) : `${id}${"一".repeat(346)}aa`);
  }
  return entries;
}
/** The independent byte oracle for the jsonb text form of an array of plain strings. */
function jsonbTextBytes(entries: string[]): number {
  return 2 + entries.reduce((sum, entry) => sum + Buffer.byteLength(entry, "utf8") + 2, 0) + 2 * (entries.length - 1);
}

const STATIC_MESSAGES = new Set([AM_F2, AC02]);
/** A refusal, redacted: SQLSTATE, a static message or a placeholder, and field PRESENCE only. */
function refusalOf(error: unknown): Record<string, unknown> {
  if (error === null) return { outcome: "the migration committed" };
  const e = (error ?? {}) as Record<string, unknown>;
  return {
    outcome: "refused",
    code: typeof e.code === "string" ? e.code : null,
    message: typeof e.message === "string" && STATIC_MESSAGES.has(e.message) ? e.message : "<withheld: not an accepted static message>",
    detail: e.detail !== undefined, hint: e.hint !== undefined, schema: e.schema !== undefined, table: e.table !== undefined,
    column: e.column !== undefined, dataType: e.dataType !== undefined, constraint: e.constraint !== undefined,
  };
}
const refusedWith = (message: string): Record<string, unknown> => ({
  outcome: "refused", code: "P0001", message,
  detail: false, hint: false, schema: false, table: false, column: false, dataType: false, constraint: false,
});
/** Whether any string field of the error (message, detail, hint, where, …) carries a planted canary. */
function carriesCanary(error: unknown): boolean {
  if (error === null || typeof error !== "object") return false;
  const record = error as Record<string, unknown>;
  return [...Object.values(record), record.message].some((value) => typeof value === "string" && value.includes("CANARY"));
}

// ── THE STATIC SOURCE FENCES (DH-11 / MR-02 parity), no database ──

const migrationText = readFileSync(MIGRATION_PATH, "utf8");
const schemaText = readFileSync(SCHEMA_PATH, "utf8");
const occurrences = (text: string, needle: string): number => text.split(needle).length - 1;
/** The text strictly between the begin marker line and the end marker line. */
function markedStatement(text: string): string {
  const begin = `-- ${MARKER}:begin\n`;
  const end = `\n-- ${MARKER}:end`;
  const start = text.indexOf(begin);
  const stop = text.indexOf(end);
  return start >= 0 && stop > start ? text.slice(start + begin.length, stop) : "";
}
const withoutLineComments = (sql: string): string => sql.replace(/--[^\n]*/g, "");
/** The schema mirror's executable entrypoint: its marked DO statement, exactly as extracted for parity. */
const MIRROR_STATEMENT = markedStatement(schemaText);

describe("AM-F2 + AC-02 history/segment block — static source fences (DH-11, MR-02 parity)", () => {
  it("MR-05 the controlled-mutation hooks are unset, so this run reads the real migration and schema", () => {
    expect({
      migration: process.env.AIO1170_MR05_MIGRATION_FILE ?? "", schema: process.env.AIO1170_MR05_SCHEMA_FILE ?? "",
    }, "an AIO1170_MR05_* hook is set: this is a mutation run, not a normal one").toEqual({ migration: "", schema: "" });
  });

  it("DH-11 each file carries exactly one marker pair in order, the migration has nothing executable outside it, and both statements are byte-identical", () => {
    const counts = (text: string) => ({
      begin: occurrences(text, `${MARKER}:begin`), end: occurrences(text, `${MARKER}:end`),
      beginLine: occurrences(`\n${text}`, `\n-- ${MARKER}:begin\n`), endLine: occurrences(`\n${text}`, `\n-- ${MARKER}:end\n`),
    });
    expect({ migration: counts(migrationText), schema: counts(schemaText) }, "exactly one begin and one end marker per file, each on its own line").toEqual({
      migration: { begin: 1, end: 1, beginLine: 1, endLine: 1 }, schema: { begin: 1, end: 1, beginLine: 1, endLine: 1 },
    });
    const migrationStatement = markedStatement(migrationText);
    const schemaStatement = markedStatement(schemaText);
    expect({
      migrationNonEmpty: migrationStatement.length > 0, schemaNonEmpty: schemaStatement.length > 0,
      identical: migrationStatement === schemaStatement,
    }, "the marked statements are non-empty and byte-identical").toEqual({ migrationNonEmpty: true, schemaNonEmpty: true, identical: true });
    expect({
      opens: migrationStatement.startsWith("do $slack_channel_history_segments$\n"),
      closes: migrationStatement.endsWith("\nend\n$slack_channel_history_segments$;"),
      tagCount: occurrences(migrationStatement, "$slack_channel_history_segments$"),
    }, "the marked text is ONE complete DO statement").toEqual({ opens: true, closes: true, tagCount: 2 });

    const beginAt = migrationText.indexOf(`-- ${MARKER}:begin\n`);
    const endLine = `-- ${MARKER}:end`;
    const endAt = migrationText.indexOf(endLine);
    const outside = `${migrationText.slice(0, beginAt)}${migrationText.slice(endAt + endLine.length)}`;
    const executableOutside = outside.split("\n").filter((line) => !/^\s*(--.*)?$/.test(line)).length;
    expect(executableOutside, "the migration has only comments and whitespace outside its marked DO").toBe(0);
  });

  it("DH-11 the schema block sits immediately after the legacy slack-source-upgrade pair, outside it, which is preserved once", () => {
    const legacyBegin = schemaText.indexOf("-- slack-source-upgrade:begin\n");
    const legacyEnd = schemaText.indexOf("-- slack-source-upgrade:end\n");
    const blockBegin = schemaText.indexOf(`-- ${MARKER}:begin\n`);
    expect({
      legacyPairs: [occurrences(schemaText, "slack-source-upgrade:begin"), occurrences(schemaText, "slack-source-upgrade:end")],
      ordered: legacyBegin >= 0 && legacyBegin < legacyEnd && legacyEnd < blockBegin,
      adjacent: schemaText.includes(`-- slack-source-upgrade:end\n-- ${MARKER}:begin\n`),
    }, "one legacy pair, then the new block directly after its end marker").toEqual({ legacyPairs: [1, 1], ordered: true, adjacent: true });
  });

  it("DH-11 the block uses no skip-NOTICE DDL, notice level, GUC suppression, catch-all, value-bearing field or transaction control, raises only the two static errors, and locks before observing", () => {
    const code = withoutLineComments(markedStatement(migrationText));
    const raises = code.match(/\braise\b/gi) ?? [];
    const staticRaises = code.match(/raise exception using errcode = 'P0001', message = '(?:AM_F2_UPGRADE_INVALID_STATE|AC02_PROGRESS_UPGRADE_INVALID_STATE)';/g) ?? [];
    const lock = "lock table public.slack_sync_channels in access exclusive mode;";
    const beforeLock = code.slice(0, code.indexOf(lock));
    expect({
      skipNoticeDdl: /\b(?:drop|add)\s+(?:column|constraint)\s+if\s+(?:not\s+)?exists\b/i.test(code)
        || /\b(?:create|drop)\s+(?:table|index|function|trigger)\s+if\s+(?:not\s+)?exists\b/i.test(code),
      noticeLevel: /\braise\s+(?:notice|warning|info|log|debug)\b/i.test(code),
      gucSuppression: /client_min_messages|set_config\s*\(|\bset\s+local\b/i.test(code),
      catchAll: /\bwhen\s+others\b|\bexception\s+when\b/i.test(code),
      valueBearingField: /\b(?:detail|hint)\s*=/i.test(code),
      transactionControl: /^\s*(?:commit\b|rollback\b|begin\s*;|start\s+transaction\b|savepoint\b)/im.test(code),
      everyRaiseStatic: raises.length > 0 && raises.length === staticRaises.length,
      oneLock: occurrences(code, lock),
      observesBeforeLock: /pg_catalog\.pg_|information_schema|public\.slack_sync_channels/.test(beforeLock),
    }, "the block's notice/error/lock discipline").toEqual({
      skipNoticeDdl: false, noticeLevel: false, gucSuppression: false, catchAll: false, valueBearingField: false,
      transactionControl: false, everyRaiseStatic: true, oneLock: 1, observesBeforeLock: false,
    });
  });

  it("schema comment precision: the from-zero column comment does not claim catalog sameness", () => {
    // GREEN since the comment was corrected at 83162b68. Only the executable statement's bytes are guaranteed identical;
    // from-zero columns occupy different attribute positions than upgraded ones, so a claim that the
    // two paths share a catalog overstates what either path proves.
    const tableStart = schemaText.indexOf("create table if not exists slack_sync_channels (");
    const firstNewColumn = "  newest_cursor_history jsonb not null default '[]'::jsonb,\n";
    const columnAt = schemaText.indexOf(firstNewColumn, tableStart);
    const lines = schemaText.slice(tableStart, columnAt).split("\n");
    lines.pop(); // the empty remainder after the last newline before the column line
    const comment: string[] = [];
    while (lines.length > 0 && /^\s*--/.test(lines[lines.length - 1])) comment.unshift(lines.pop() as string);
    const text = comment.join("\n");
    expect({
      tableFound: tableStart >= 0, columnInTable: columnAt > tableStart, columnOnce: occurrences(schemaText, firstNewColumn),
      commentLines: comment.length > 0, namesTheBlock: text.includes(MARKER),
    }, "fixture: the Slack from-zero column block and its comment are where this check looks").toEqual({
      tableFound: true, columnInTable: true, columnOnce: 1, commentLines: true, namesTheBlock: true,
    });
    expect(/(same|identical|equal|agree)[^.]*catalog|catalog[^.]*(same|identical|equal|agree)/i.test(text),
      "schema comment above the eight from-zero columns claims catalog sameness").toBe(false);
  });
});

// ── THE REAL POSTGRESQL CASES ──

describe("AM-F2 + AC-02 history/segment migration — catalog identity, conflicts, rejections and claim edges (real Postgres)", () => {
  let adminUrl = "";
  let scratch = "";
  let c: Client; // runs the migration (notices captured here)
  let probe: Client; // a second session: every post-migration inspection
  let fromZero: Record<string, unknown> = {};
  let scratchUrl = ""; // the scratch database, for the extra sessions the MR-04 B7 cases open
  let loadSchemaFn: unknown = null; // the real deploy loader, for the whole-schema refusal entrypoint
  const migration = migrationText;

  const newColumns = async () => (await probe.query(
    `select a.attname as name, pg_catalog.format_type(a.atttypid, a.atttypmod) as type, a.attnotnull as not_null,
            pg_catalog.pg_get_expr(d.adbin, d.adrelid) as default_expr,
            a.attgenerated::text as generated, a.attidentity::text as identity
       from pg_catalog.pg_attribute a
       left join pg_catalog.pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
      where a.attrelid = 'public.slack_sync_channels'::regclass and a.attnum > 0 and not a.attisdropped
        and a.attname = any($1::text[])
      order by a.attname collate "C"`, [NEW_COLUMNS]
  )).rows;
  const namedConstraints = async () => (await probe.query(
    `select conname as name, contype::text as kind, pg_catalog.pg_get_constraintdef(oid) as definition, convalidated as validated
       from pg_catalog.pg_constraint
      where conrelid = 'public.slack_sync_channels'::regclass and conname = any($1::text[])
      order by conname collate "C"`, [NAMED_CHECKS]
  )).rows;
  const constraintNames = async () => (await probe.query<{ name: string }>(
    `select conname as name from pg_catalog.pg_constraint
      where conrelid = 'public.slack_sync_channels'::regclass and contype <> 'n'
      order by conname collate "C"`
  )).rows.map((row) => row.name);
  const validator = async () => (await probe.query(
    `select p.proname as name, pg_catalog.pg_get_function_identity_arguments(p.oid) as args,
            pg_catalog.format_type(p.prorettype, null) as returns, l.lanname as language, p.prokind::text as kind,
            p.provolatile::text as volatility, p.proisstrict as strict, p.proparallel::text as parallel,
            p.prosecdef as security_definer, p.proretset as returns_set, p.proleakproof as leakproof,
            p.proconfig as config, p.proargnames as arg_names, p.pronargdefaults::int as arg_defaults,
            p.prosupport::text as support, p.prosrc as source
       from pg_catalog.pg_proc p
       join pg_catalog.pg_namespace n on n.oid = p.pronamespace
       join pg_catalog.pg_language l on l.oid = p.prolang
      where n.nspname = 'public' and p.proname = 'slack_channel_cursor_history_valid'`
  )).rows;
  const ownedFunctions = async () => (await probe.query<{ name: string }>(
    `select p.proname as name from pg_catalog.pg_proc p
       join pg_catalog.pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public'
        and (p.proname like 'slack\\_sync\\_channels\\_%' or p.proname like 'slack\\_channel\\_%')
      order by p.proname collate "C"`
  )).rows.map((row) => row.name);
  const fullCatalog = async () => ({
    columns: await newColumns(), constraintNames: await constraintNames(), namedChecks: await namedConstraints(),
    functions: (await ownedFunctions()).filter((name) => !name.includes("progress")), validator: await validator(),
  });
  const EXPECTED_FULL_CATALOG = {
    columns: EXPECTED_COLUMNS, constraintNames: POST_F2_CONSTRAINT_NAMES, namedChecks: EXPECTED_NAMED_CHECKS,
    functions: POST_F2_OWNED_FUNCTIONS, validator: EXPECTED_VALIDATOR,
  };
  /** Every queued thread row, digested the same way (the rows carry no cursor in these fixtures). */
  const threadsDigest = async (): Promise<string> => (await probe.query<{ digest: string }>(
    `select coalesce(pg_catalog.md5(pg_catalog.string_agg(pg_catalog.to_jsonb(t)::text, '|' order by t.root_ts collate "C")), 'no rows') as digest
       from public.slack_sync_threads t`
  )).rows[0].digest;
  /** Every channel row, digested: equality proves byte-identical rows without printing one. */
  const rowsDigest = async (): Promise<string> => (await probe.query<{ digest: string }>(
    `select coalesce(pg_catalog.md5(pg_catalog.string_agg(pg_catalog.to_jsonb(s)::text, '|' order by s.channel_id collate "C")), 'no rows') as digest
       from public.slack_sync_channels s`
  )).rows[0].digest;

  /** One execution of an entrypoint's SQL; notices captured only for its duration. */
  const applyStatement = async (sql: string): Promise<{ error: unknown; notices: string[] }> => {
    const notices: string[] = [];
    const onNotice = (notice: { message?: string }): void => {
      notices.push(notice.message ?? "");
    };
    c.on("notice", onNotice);
    try {
      await c.query(sql);
      return { error: null, notices };
    } catch (error) {
      return { error, notices };
    } finally {
      c.removeListener("notice", onNotice);
    }
  };
  /** One execution of the real migration file. */
  const applyMigration = (): Promise<{ error: unknown; notices: string[] }> => applyStatement(migration);
  /** The refusal matrix's two executable entrypoints. */
  type Entry = "migration" | "schema mirror" | "full loader";
  /**
   * The executable entrypoints:
   *  - the migration file;
   *  - the marked mirror statement;
   *  - the REAL deploy loader (`loadSchema`: the whole `schema.sql` as ONE atomic query, then every
   *    migration, on its own fresh session). Its notices go to its own logger, so they are NOT
   *    captured or asserted for the loader.
   */
  const applyEntry = async (entry: Entry): Promise<{ error: unknown; notices: string[] }> => {
    if (entry !== "full loader") return applyStatement(entry === "migration" ? migration : MIRROR_STATEMENT);
    try {
      await (loadSchemaFn as (options: Record<string, unknown>) => Promise<void>)({ cwd: process.cwd(), databaseUrl: scratchUrl, logger: { log: () => {} } });
      return { error: null, notices: [] };
    } catch (error) {
      return { error, notices: [] };
    }
  };

  /** A fixture DML statement whose failure is redacted (FixtureError), so a seeded canary never prints. */
  const runFixture = async (sql: string, params: unknown[] = []): Promise<void> => {
    try {
      await c.query(sql, params);
    } catch (error) {
      const e = (error ?? {}) as Record<string, unknown>;
      throw new FixtureError(e.code ?? null, e.constraint ?? null);
    }
  };
  /** Insert one channel row from literal column values (histories as JSON text). */
  const insertChannel = async (row: Record<string, unknown>): Promise<void> => {
    const columns = ["team_id", "workspace_id", ...Object.keys(row)];
    const values = [TEAM_ID, WORKSPACE, ...Object.values(row)];
    await runFixture(
      `insert into public.slack_sync_channels (${columns.join(", ")}) values (${values.map((_, i) => `$${i + 1}`).join(", ")})`,
      values
    );
  };
  /** The planted columns of the named rows, projected literally (timestamps as UTC text). */
  const plantedProjection = async (channels: string[]) => (await probe.query(
    `select channel_id, attempts, last_error_code, last_read_at::text as last_read_at,
            completed_lower_ts, completed_upper_ts, historical_floor_reached, newest_catchup_upper_ts,
            metadata_attempt_owner, metadata_attempt_generation::int as metadata_attempt_generation,
            public_state, public_checked_at::text as public_checked_at,
            binding_integration_id::text as binding_integration_id, binding_config_revision,
            due_at::text as due_at, created_at::text as created_at
       from public.slack_sync_channels where channel_id = any($1::text[]) order by channel_id collate "C"`, [channels]
  )).rows;
  const expectedPlanted = (channels: string[]) => [...channels].sort().map((channel) => ({ channel_id: channel, ...PLANTED[channel] }));
  /** One row as jsonb text without the excluded columns — kept in memory only, never asserted directly. */
  const rowExcept = async (channel: string, excluded: string[]): Promise<string> => (await probe.query<{ row: string }>(
    `select (pg_catalog.to_jsonb(s) - $2::text[])::text as row from public.slack_sync_channels s where s.channel_id = $1`,
    [channel, excluded]
  )).rows[0].row;
  /** The NAMES (never the values) of the columns whose value differs from `before`, excluded columns aside. */
  const changedColumns = async (channel: string, before: string, excluded: string[]): Promise<string[]> => (await probe.query<{ changed: string[] }>(
    `select coalesce(pg_catalog.array_agg(coalesce(b.key, a.key) order by coalesce(b.key, a.key) collate "C"), '{}'::text[]) as changed
       from pg_catalog.jsonb_each($2::jsonb) as b
       full join pg_catalog.jsonb_each((select pg_catalog.to_jsonb(s) - $3::text[] from public.slack_sync_channels s where s.channel_id = $1)) as a
         on a.key = b.key
      where a.value is distinct from b.value`,
    [channel, before, excluded]
  )).rows[0].changed;

  /** FIXTURE DDL on this scratch database only: back to the exact pre-F2 table, with no rows. */
  const resetToPreF2 = async (): Promise<void> => {
    await c.query("delete from public.slack_sync_channels");
    await c.query("delete from public.slack_sync_threads");
    for (const name of NAMED_CHECKS) {
      await c.query(`alter table public.slack_sync_channels drop constraint if exists ${name}`);
    }
    await c.query(`alter table public.slack_sync_channels ${NEW_COLUMNS.map((column) => `drop column if exists ${column}`).join(", ")}`);
    // Any routine a conflict fixture left under the validator's name (function or procedure, either signature).
    await c.query("drop routine if exists public.slack_channel_cursor_history_valid(jsonb)");
    await c.query("drop routine if exists public.slack_channel_cursor_history_valid(text)");
    await c.query("drop domain if exists public.slack_conflict_jsonb, public.slack_conflict_text");
    expect({
      columns: await newColumns(), namedChecks: await namedConstraints(), validator: await validator(),
      rows: await rowsDigest(), threads: await threadsDigest(),
    }, "fixture: the table is back to pre-F2 — no new column, named CHECK or validator, and no channel or thread rows").toEqual({
      columns: [], namedChecks: [], validator: [], rows: "no rows", threads: "no rows",
    });
  };
  /** The rollback evidence for a refused pre-F2 introduction. */
  const preF2Shape = async () => ({ columns: await newColumns(), validator: (await validator()).length, rows: await rowsDigest() });

  beforeAll(async () => {
    const { loadSchema } = await import("@/scripts/pg-load-schema.mjs");
    loadSchemaFn = loadSchema;
    // The shared guard refuses BEFORE any connection or database creation (slack-history-isolated-url.ts).
    const name = `slackconflict_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
    const created = await createIsolatedScratchDatabase(name);
    adminUrl = created.adminUrl;
    scratch = name;
    const url = created.url;
    scratchUrl = url;
    await loadSchema({ cwd: process.cwd(), databaseUrl: url, logger: { log: () => {} } });
    c = new Client({ connectionString: url });
    probe = new Client({ connectionString: url });
    await c.connect();
    await probe.connect();
    await c.query("set time zone 'UTC'");
    await probe.query("set time zone 'UTC'");
    // The loader-path catalog (schema.sql, then every effective migration), captured before any fixture DDL.
    fromZero = await fullCatalog();
    await c.query(`insert into teams (id, slug, name) values ($1, 'conflict-team', 'Conflict Team')`, [TEAM_ID]);
    // The binder the planted binding proofs point at; channel rows are deleted per case, this is not.
    await c.query(`insert into integrations (id, team_id, type, name) values ($1, $2, 'slack', 'conflict-slack')`, [INTEGRATION_ID, TEAM_ID]);
  }, SCRATCH_TIMEOUT);

  afterAll(async () => {
    await c?.end().catch(() => {});
    await probe?.end().catch(() => {});
    if (!scratch) return;
    // Cleanup never replaces the primary failure: every step is caught, as the repository precedent does.
    const dropper = new Client({ connectionString: adminUrl });
    await dropper.connect().catch(() => {});
    await dropper.query(`drop database if exists ${scratch} with (force)`).catch(() => {});
    await dropper.end().catch(() => {});
  }, SCRATCH_TIMEOUT);

  // ── MR-02 CATALOG IDENTITY ──

  it("MR-02 the loader path (schema.sql plus every effective migration) carries the exact accepted columns, constraints, four named CHECK definitions and validator", () => {
    expect(fromZero, "loader-path catalog (schema plus migrations): columns, every constraint, the four named CHECK definitions (validated), owned functions and the exact validator").toEqual(EXPECTED_FULL_CATALOG);
  }, SCRATCH_TIMEOUT);

  it("MR-02 the direct migration on a pre-F2 table installs the same exact catalog, with no notice", async () => {
    await resetToPreF2();
    const { error, notices } = await applyMigration();
    expect(notices, "no NOTICE or WARNING on introduction").toEqual([]);
    expect(refusalOf(error), "the migration commits on an empty pre-F2 table").toEqual({ outcome: "the migration committed" });
    expect(await fullCatalog(), "migrated catalog: columns, every constraint, the four named CHECK definitions (validated), owned functions and the exact validator").toEqual(EXPECTED_FULL_CATALOG);
  }, SCRATCH_TIMEOUT);

  // ── MR-04 CATALOG CONFLICTS ──

  it("MR-04 a pre-existing validator with a DEFAULTED argument is refused statically and nothing persists", async () => {
    await resetToPreF2();
    await insertChannel({ channel_id: "C0DEFAULTED1", historical_anchor_ts: "1718900500.000000", historical_cursor: "CANARY-defaulted-1", updated_at: SEEDED_UPDATED_AT });
    await c.query(
      `create function public.slack_channel_cursor_history_valid(history jsonb default '[]'::jsonb) returns boolean
       language sql immutable strict parallel safe security invoker set search_path = pg_catalog
       as $$ select true $$`
    );
    const before = await rowsDigest();
    const { error, notices } = await applyMigration();
    expect(notices, "no NOTICE or WARNING on refusal").toEqual([]);
    expect(refusalOf(error), "the defaulted helper is refused with the static AM_F2 error and no value-bearing field").toEqual(refusedWith(AM_F2));
    expect(carriesCanary(error), "no error field carries the planted cursor canary").toBe(false);
    expect({
      columns: await newColumns(), namedChecks: await namedConstraints(), rows: await rowsDigest(),
      validator: (await validator()).map((row) => ({ arg_defaults: row.arg_defaults, source: row.source })),
    }, "rollback: no column, CHECK or row change; the conflicting helper is untouched").toEqual({
      columns: [], namedChecks: [], rows: before, validator: [{ arg_defaults: 1, source: " select true " }],
    });
  }, SCRATCH_TIMEOUT);

  // ── MR-04 REFUSAL-SURFACE MATRIX (packet 4) ──

  /**
   * One refusal case. `setup` runs after the reset and the planted baseline and builds exactly one
   * conflict. Its literal `fact` proves the conflict really exists, so a no-op setup fails here
   * rather than passing as a refusal.
   */
  interface Refusal {
    id: string;
    message: string;
    state: "pre-F2" | "F2";
    setup: () => Promise<unknown>;
    fact: unknown;
  }

  /** Everything a refused run must leave exactly as it found it, read from the SECOND session. */
  const refusalEvidence = async () => ({
    columns: (await probe.query(
      `select a.attname as name, pg_catalog.format_type(a.atttypid, a.atttypmod) as type, a.attnotnull as not_null,
              pg_catalog.pg_get_expr(d.adbin, d.adrelid) as default_expr,
              a.attgenerated::text as generated, a.attidentity::text as identity
         from pg_catalog.pg_attribute a
         left join pg_catalog.pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
        where a.attrelid = 'public.slack_sync_channels'::regclass and a.attnum > 0 and not a.attisdropped
        order by a.attname collate "C"`
    )).rows,
    constraints: (await probe.query(
      `select conname as name, contype::text as kind, pg_catalog.pg_get_constraintdef(oid) as definition, convalidated as validated
         from pg_catalog.pg_constraint where conrelid = 'public.slack_sync_channels'::regclass
        order by conname collate "C"`
    )).rows,
    routines: await validator(),
    functions: await ownedFunctions(),
    channels: await rowsDigest(),
    threads: await threadsDigest(),
  });

  /**
   * The baseline every refusal case plants: one channel row carrying a CANARY cursor and the
   * C0MATRIX0001 planted metadata (pre-F2 shape, or a valid initialized-historical F2 shape), plus
   * one unrelated queued thread row.
   */
  const plantBaseline = async (state: "pre-F2" | "F2"): Promise<void> => {
    await insertChannel({
      channel_id: BASE_CHANNEL, historical_anchor_ts: "1718900500.000000", historical_cursor: "CANARY-matrix-h",
      historical_scan_generation: 2, updated_at: SEEDED_UPDATED_AT, ...PLANTED[BASE_CHANNEL],
      ...(state === "F2" ? {
        historical_segment_lower_ts: "0.000000", historical_segment_upper_ts: "1718900300.000000",
        historical_cursor_history: JSON.stringify(["CANARY-matrix-h"]),
      } : {}),
    });
    await runFixture(
      `insert into public.slack_sync_threads (team_id, workspace_id, channel_id, root_ts, due_at, attempts)
       values ($1, $2, $3, $4, '2026-01-09 00:00:00+00', 2)`,
      [TEAM_ID, WORKSPACE, BASE_CHANNEL, BASE_THREAD_ROOT]
    );
    expect({
      planted: await plantedProjection([BASE_CHANNEL]),
      threads: (await probe.query<{ n: number }>("select pg_catalog.count(*)::int as n from public.slack_sync_threads")).rows[0].n,
    }, "fixture: the baseline channel carries its planted metadata and one unrelated queued thread exists").toEqual({
      planted: expectedPlanted([BASE_CHANNEL]), threads: 1,
    });
  };

  /** Build the case, then require a static refusal that leaves every piece of evidence untouched. */
  const runRefusal = async (refusal: Refusal, entry: Entry): Promise<void> => {
    await resetToPreF2();
    if (refusal.state === "F2") {
      expect(refusalOf((await applyMigration()).error), "setup: the introduction commits on an empty table").toEqual({ outcome: "the migration committed" });
    }
    await plantBaseline(refusal.state);
    expect(await refusal.setup(), `fixture: ${refusal.id} is really in place`).toEqual(refusal.fact);
    const before = await refusalEvidence();
    const { error, notices } = await applyEntry(entry);
    if (entry !== "full loader") expect(notices, `${entry}: no NOTICE or WARNING on refusal`).toEqual([]);
    expect(refusalOf(error), `${entry}: ${refusal.id} is refused with the static ${refusal.message} error and no value-bearing field`).toEqual(refusedWith(refusal.message));
    expect(carriesCanary(error), `${entry}: no error field carries the planted cursor canary`).toBe(false);
    expect(await refusalEvidence(),
      `${entry}: rollback from a fresh session — every column and constraint, validator-name routine, owned function, channel row and thread row exactly as before`).toEqual(before);
  };

  /** The named reserved constraints present, as name and kind only. */
  const namedKinds = async () => (await namedConstraints()).map((row) => ({ name: row.name, kind: row.kind }));
  /** One owned column's single metadata field, or "absent". */
  const columnFact = async (column: string, field: string): Promise<unknown> => {
    const row = (await newColumns()).find((candidate) => candidate.name === column);
    return { [column]: row ? row[field] : "absent" };
  };
  /** The metadata keys (never values) in which the routine under the validator's name differs from the accepted one. */
  const validatorDiff = async (): Promise<unknown> => {
    const rows = await validator();
    if (rows.length !== 1) return { routinesUnderTheName: rows.length };
    const accepted = EXPECTED_VALIDATOR[0] as Record<string, unknown>;
    return Object.keys(accepted)
      .filter((key) => key !== "source" && JSON.stringify(rows[0][key]) !== JSON.stringify(accepted[key]))
      .sort();
  };
  const alter = (clause: string): string => `alter table public.slack_sync_channels ${clause}`;
  const runDdl = async (statements: string[]): Promise<void> => {
    for (const statement of statements) await c.query(statement);
  };

  const WRONG_KIND: Refusal[] = NAMED_CHECKS.flatMap((name) => [
    { label: "UNIQUE", kind: "u", clause: "unique (id)" },
    { label: "FOREIGN KEY", kind: "f", clause: "foreign key (team_id) references public.teams (id)" },
  ].map(({ label, kind, clause }) => ({
    id: `wrong-kind ${label} holding ${name}`,
    message: name.includes("cursor_history") ? AM_F2 : AC02,
    state: "pre-F2" as const,
    setup: async () => {
      await c.query(alter(`add constraint ${name} ${clause}`));
      return namedKinds();
    },
    fact: [{ name, kind }],
  })));

  const PARTIAL_UNITS: Refusal[] = [
    { lane: "newest", present: ["newest_request_lower_ts"] },
    { lane: "newest", present: ["newest_segment_lower_ts", "newest_segment_upper_ts"] },
    { lane: "historical", present: ["historical_completed_segments_oldest_ts"] },
    { lane: "historical", present: ["historical_segment_lower_ts", "historical_segment_upper_ts"] },
  ].map(({ lane, present }) => ({
    id: `partial ${lane} segment unit, ${present.length} of 3 present`,
    message: AC02,
    state: "pre-F2" as const,
    setup: async () => {
      await c.query(alter(present.map((column) => `add column ${column} pg_catalog.text`).join(", ")));
      return (await newColumns()).map((row) => row.name);
    },
    fact: present,
  }));

  const METADATA: Refusal[] = [
    {
      conflict: "history column over a jsonb DOMAIN", message: AM_F2, column: "newest_cursor_history", field: "type", value: "slack_conflict_jsonb",
      ddl: ["create domain public.slack_conflict_jsonb as pg_catalog.jsonb", alter("drop column newest_cursor_history"),
        alter("add column newest_cursor_history public.slack_conflict_jsonb not null default '[]'::jsonb")],
    },
    {
      conflict: "progress column over a text DOMAIN", message: AC02, column: "newest_request_lower_ts", field: "type", value: "slack_conflict_text",
      ddl: ["create domain public.slack_conflict_text as pg_catalog.text", alter("drop column newest_request_lower_ts"),
        alter("add column newest_request_lower_ts public.slack_conflict_text")],
    },
    {
      conflict: "history column with a wrong default", message: AM_F2, column: "historical_cursor_history", field: "default_expr", value: "'{}'::jsonb",
      ddl: [alter("alter column historical_cursor_history set default '{}'::jsonb")],
    },
    {
      conflict: "progress column with a default", message: AC02, column: "newest_segment_upper_ts", field: "default_expr", value: "'1718900800.000000'::text",
      ddl: [alter("alter column newest_segment_upper_ts set default '1718900800.000000'")],
    },
    {
      conflict: "nullable history column", message: AM_F2, column: "newest_cursor_history", field: "not_null", value: false,
      ddl: [alter("alter column newest_cursor_history drop not null")],
    },
    {
      conflict: "NOT NULL progress column", message: AC02, column: "historical_segment_lower_ts", field: "not_null", value: true,
      ddl: [alter("alter column historical_segment_lower_ts set not null")],
    },
    {
      conflict: "GENERATED history column", message: AM_F2, column: "newest_cursor_history", field: "generated", value: "s",
      ddl: [alter("drop column newest_cursor_history"),
        alter("add column newest_cursor_history pg_catalog.jsonb not null generated always as ('[]'::jsonb) stored")],
    },
    {
      conflict: "GENERATED progress column", message: AC02, column: "historical_completed_segments_oldest_ts", field: "generated", value: "s",
      ddl: [alter("drop column historical_completed_segments_oldest_ts"),
        alter("add column historical_completed_segments_oldest_ts pg_catalog.text generated always as (null::text) stored")],
    },
  ].map(({ conflict, message, column, field, value, ddl }) => ({
    id: `metadata ${conflict}`,
    message,
    state: "F2" as const,
    setup: async () => {
      await runDdl(ddl);
      return columnFact(column, field);
    },
    fact: { [column]: value },
  }));

  /** A validator fixture: the accepted identity, with exactly the named overrides. */
  const validatorDdl = (o: {
    args?: string; returns?: string; language?: string; volatility?: string; strict?: string; parallel?: string;
    security?: string; extra?: string; config?: string; body?: string;
  } = {}): string =>
    `create function public.slack_channel_cursor_history_valid(${o.args ?? "history jsonb"}) returns ${o.returns ?? "boolean"}
       language ${o.language ?? "sql"} ${o.volatility ?? "immutable"} ${o.strict ?? "strict"} parallel ${o.parallel ?? "safe"}
       security ${o.security ?? "invoker"} ${o.extra ?? ""} ${o.config ?? "set search_path = pg_catalog"}
       as $$ ${o.body ?? "select true"} $$`;
  const VALIDATOR_CONFLICTS: Refusal[] = [
    { dimension: "security definer", ddl: validatorDdl({ security: "definer" }), differs: ["security_definer"] },
    { dimension: "no search_path", ddl: validatorDdl({ config: "" }), differs: ["config"] },
    { dimension: "another search_path", ddl: validatorDdl({ config: "set search_path = public" }), differs: ["config"] },
    { dimension: "stable volatility", ddl: validatorDdl({ volatility: "stable" }), differs: ["volatility"] },
    { dimension: "not strict", ddl: validatorDdl({ strict: "called on null input" }), differs: ["strict"] },
    { dimension: "parallel restricted", ddl: validatorDdl({ parallel: "restricted" }), differs: ["parallel"] },
    { dimension: "plpgsql language", ddl: validatorDdl({ language: "plpgsql", body: "begin return true; end" }), differs: ["language"] },
    { dimension: "integer return type", ddl: validatorDdl({ returns: "integer", body: "select 1" }), differs: ["returns"] },
    { dimension: "set-returning", ddl: validatorDdl({ returns: "setof boolean" }), differs: ["returns_set"] },
    { dimension: "argument name", ddl: validatorDdl({ args: "h jsonb" }), differs: ["arg_names", "args"] },
    { dimension: "text argument type", ddl: validatorDdl({ args: "history text" }), differs: ["args"] },
    { dimension: "leakproof", ddl: validatorDdl({ extra: "leakproof" }), differs: ["leakproof"] },
    { dimension: "support function", ddl: validatorDdl({ extra: "support pg_catalog.textlike_support" }), differs: ["support"] },
    {
      // PostgreSQL 16: a procedure cannot carry a return type, volatility, strictness or parallel
      // marking, and its identity-argument rendering differs from a function's, so object kind
      // cannot vary alone; the exact resulting diff is asserted instead.
      dimension: "procedure kind",
      ddl: "create procedure public.slack_channel_cursor_history_valid(history jsonb) language sql set search_path = pg_catalog as $$ select 1 $$",
      differs: ["args", "kind", "parallel", "returns", "strict", "volatility"],
    },
  ].map(({ dimension, ddl, differs }) => ({
    id: `validator ${dimension}`,
    message: AM_F2,
    state: "pre-F2" as const,
    setup: async () => {
      await c.query(ddl);
      return validatorDiff();
    },
    fact: differs,
  }));

  /** Cross-entrypoint-only state cases: their migration-path twins are the earlier dedicated tests. */
  const STATE_REFUSALS: Refusal[] = [
    {
      id: "state inactive historical lane carrying an attempt-oldest",
      message: AC02,
      state: "pre-F2",
      setup: async () => {
        await insertChannel({ channel_id: "C0MATRIXOLD1", historical_oldest_seen_ts: "1718900100.000100", updated_at: SEEDED_UPDATED_AT });
        return (await probe.query<{ n: number }>(
          "select pg_catalog.count(*)::int as n from public.slack_sync_channels where historical_anchor_ts is null and historical_oldest_seen_ts is not null"
        )).rows[0].n;
      },
      fact: 1,
    },
    {
      id: "restart-hiding history-only introduction with an attempt-oldest above U",
      message: AC02,
      state: "F2",
      setup: async () => {
        await c.query(alter("drop column historical_cursor_history"));
        await c.query(alter("drop constraint slack_sync_channels_historical_progress_check"));
        await runFixture("update public.slack_sync_channels set historical_oldest_seen_ts = '1718900400.000000' where channel_id = $1", [BASE_CHANNEL]);
        return {
          historyColumn: await columnFact("historical_cursor_history", "type"),
          outside: (await probe.query<{ outside: boolean }>(
            `select historical_oldest_seen_ts::numeric > historical_segment_upper_ts::numeric as outside
               from public.slack_sync_channels where channel_id = $1`, [BASE_CHANNEL]
          )).rows[0].outside,
        };
      },
      fact: { historyColumn: { historical_cursor_history: "absent" }, outside: true },
    },
  ];

  const MIGRATION_MATRIX: Refusal[] = [...WRONG_KIND, ...PARTIAL_UNITS, ...METADATA, ...VALIDATOR_CONFLICTS];
  /**
   * B8: marked-mirror TWINS of the dedicated migration-only refusal tests below. Each uses the
   * same literal defect as its migration twin, rebuilt as a Refusal so it runs through the shared
   * baseline, fact, privacy and whole-rollback oracle.
   */
  /** The same literal initialized newest tuple as NEWEST_INITIALIZED below (declared here, before first use). */
  const NEWEST_INITIALIZED_FOR_TWINS = {
    newest_anchor_ts: "1718900800.000000", newest_lower_ts: "1718900700.000000",
    newest_request_lower_ts: "1718900640.000000", newest_segment_lower_ts: "1718900640.000000",
    newest_segment_upper_ts: "1718900800.000000",
  };
  const linkageRow = { channel_id: "C0LINKAGE001", ...NEWEST_INITIALIZED_FOR_TWINS, newest_cursor: "CANARY-c-1", newest_cursor_history: JSON.stringify(["CANARY-c-1"]) };
  const PERSISTED_HISTORY_TWINS: Array<{ label: string; history: unknown; cursor: string | null }> = [
    { label: "a duplicate history", history: ["CANARY-c-1", "CANARY-c-1"], cursor: "CANARY-c-1" },
    { label: "a history whose final element is not the cursor", history: ["CANARY-c-1", "CANARY-c-2"], cursor: "CANARY-c-1" },
    { label: "an empty history under a non-null cursor", history: [], cursor: "CANARY-c-1" },
    { label: "a non-array history", history: { CANARY: 1 }, cursor: null },
    { label: "a history over the 1,000-entry cap", history: Array.from({ length: 1001 }, (_, i) => `CANARY-${i}`), cursor: "CANARY-1000" },
  ];
  const MIGRATION_ONLY_TWINS: Refusal[] = [
    {
      id: "twin: a pre-existing validator with a DEFAULTED argument", message: AM_F2, state: "pre-F2",
      setup: async () => {
        await c.query(`create function public.slack_channel_cursor_history_valid(history jsonb default '[]'::jsonb) returns boolean
                       language sql immutable strict parallel safe security invoker set search_path = pg_catalog as $$ select true $$`);
        return validatorDiff();
      },
      fact: ["arg_defaults"],
    },
    {
      id: "twin: an active newest lane with no logical lower B", message: AC02, state: "pre-F2",
      setup: async () => {
        await insertChannel({ channel_id: "C0NEWNOLOW01", newest_anchor_ts: "1718900800.000000", newest_cursor: "CANARY-newest-b", updated_at: SEEDED_UPDATED_AT });
        return (await probe.query<{ n: number }>(
          "select pg_catalog.count(*)::int as n from public.slack_sync_channels where newest_anchor_ts is not null and newest_lower_ts is null"
        )).rows[0].n;
      },
      fact: 1,
    },
    {
      id: "twin: a legacy newest null-anchor lane with a non-null cursor", message: AM_F2, state: "pre-F2",
      setup: async () => {
        await insertChannel({ channel_id: "C0NULLANCH01", newest_cursor: "CANARY-newest-c", updated_at: SEEDED_UPDATED_AT });
        return (await probe.query<{ n: number }>(
          "select pg_catalog.count(*)::int as n from public.slack_sync_channels where newest_anchor_ts is null and newest_cursor is not null"
        )).rows[0].n;
      },
      fact: 1,
    },
    ...PERSISTED_HISTORY_TWINS.map(({ label, history, cursor }): Refusal => ({
      id: `twin: replay over ${label} left behind its removed CHECK`, message: AM_F2, state: "F2",
      setup: async () => {
        await insertChannel(linkageRow);
        await c.query(alter("drop constraint slack_sync_channels_newest_cursor_history_check"));
        await runFixture("update public.slack_sync_channels set newest_cursor_history = $1::jsonb, newest_cursor = $2 where channel_id = 'C0LINKAGE001'",
          [JSON.stringify(history), cursor]);
        return (await namedConstraints()).map((row) => row.name).includes("slack_sync_channels_newest_cursor_history_check");
      },
      fact: false,
    })),
    {
      id: "twin: a segment-only introduction over a terminal-mismatched newest history", message: AM_F2, state: "F2",
      setup: async () => {
        await insertChannel({ channel_id: "C0HIDEHIST01", ...NEWEST_INITIALIZED_FOR_TWINS, newest_cursor: "CANARY-c-1", newest_cursor_history: JSON.stringify(["CANARY-c-1"]) });
        await c.query(alter("drop column newest_request_lower_ts, drop column newest_segment_lower_ts, drop column newest_segment_upper_ts"));
        await c.query(alter("drop constraint slack_sync_channels_newest_cursor_history_check"));
        await runFixture("update public.slack_sync_channels set newest_cursor_history = $1::jsonb where channel_id = 'C0HIDEHIST01'",
          [JSON.stringify(["CANARY-c-1", "CANARY-c-2"])]);
        return (await newColumns()).map((row) => row.name);
      },
      fact: NEW_COLUMNS.filter((column) => !["newest_request_lower_ts", "newest_segment_lower_ts", "newest_segment_upper_ts"].includes(column)),
    },
  ];
  /** EXHAUSTIVE: every migration refusal of the matrix, the state refusals, and the migration-only twins. */
  const MIRROR_SET: Refusal[] = [...MIGRATION_MATRIX, ...STATE_REFUSALS, ...MIGRATION_ONLY_TWINS];
  /**
   * The REAL deploy loader as a refusal entrypoint, for EVERY refusal fixture (B8 tail). It
   * reaches each planted state because `loadSchema` runs the whole `schema.sql` FIRST, as one
   * atomic query, and the mirrored block inside it refuses before any migration file runs. So the
   * rollback unit is the whole schema query.
   *
   * Source-backed reachability: nothing in `schema.sql` BEFORE the marked block references the
   * eight owned columns, the validator or the four named CHECKs. Its only earlier
   * `slack_sync_channels` DDL is:
   *  - the no-op `create table if not exists`;
   *  - the legacy three-column `add column if not exists`;
   *  - the binding trigger;
   *  - two indexes;
   *  - the `ts_syntax` drop and re-add, which every fixture row satisfies.
   * So no fixture is excluded.
   */
  const LOADER_SET: Refusal[] = MIRROR_SET;

  it.each(MIGRATION_MATRIX)("MR-04 migration refuses $id statically before any mutation and rolls back whole", async (refusal) => {
    await runRefusal(refusal, "migration");
  }, SCRATCH_TIMEOUT);

  it.each(MIRROR_SET)("MR-04 schema-mirror statement refuses $id with the same static error and whole rollback", async (refusal) => {
    expect(MIRROR_STATEMENT.startsWith("do $slack_channel_history_segments$\n"), "fixture: the schema mirror's marked DO statement was extracted").toBe(true);
    await runRefusal(refusal, "schema mirror");
  }, SCRATCH_TIMEOUT);

  it.each(LOADER_SET)("MR-04 the real deploy loader (whole schema.sql) refuses $id with the same static error and whole rollback", async (refusal) => {
    await runRefusal(refusal, "full loader");
  }, SCRATCH_TIMEOUT);

  // ── MR-04 REPLAY-TIME REFUSALS (B5/B6), through BOTH entrypoints ──

  const outsideHistoricalSegment = async (): Promise<boolean> => (await probe.query<{ outside: boolean }>(
    `select historical_oldest_seen_ts::numeric > historical_segment_upper_ts::numeric as outside
       from public.slack_sync_channels where channel_id = $1`, [BASE_CHANNEL]
  )).rows[0].outside;
  const REPLAY_REFUSALS: Refusal[] = [
    {
      // B5: every column present, so nothing restarts; the stored tuple must still be revalidated.
      id: "a pure replay over a stored invalid progress tuple left behind a removed CHECK",
      message: AC02,
      state: "F2",
      setup: async () => {
        await c.query(alter("drop constraint slack_sync_channels_historical_progress_check"));
        await runFixture("update public.slack_sync_channels set historical_oldest_seen_ts = '1718900400.000000' where channel_id = $1", [BASE_CHANNEL]);
        return { presentColumns: (await newColumns()).length, outside: await outsideHistoricalSegment() };
      },
      fact: { presentColumns: 8, outside: true },
    },
    {
      // B6: the historical-lane twin of the legacy null-anchor/non-null-cursor refusal.
      id: "a legacy historical null-anchor lane with a non-null cursor",
      message: AM_F2,
      state: "pre-F2",
      setup: async () => {
        await insertChannel({ channel_id: "C0MATRIXHNA1", historical_cursor: "CANARY-historical-null-anchor", updated_at: SEEDED_UPDATED_AT });
        return (await probe.query<{ n: number }>(
          "select pg_catalog.count(*)::int as n from public.slack_sync_channels where historical_anchor_ts is null and historical_cursor is not null"
        )).rows[0].n;
      },
      fact: 1,
    },
    {
      // B6: a same-name CHECK with a DIFFERENT, weaker definition, over a row the canonical one
      // rejects. The block must refuse statically, BEFORE dropping it; it must never surface
      // PostgreSQL's value-bearing 23514 failing-row DETAIL by re-adding the canonical CHECK over
      // that row.
      id: "a same-name weaker CHECK over a stored row the canonical CHECK rejects",
      message: AC02,
      state: "F2",
      setup: async () => {
        await c.query(alter("drop constraint slack_sync_channels_historical_progress_check"));
        await c.query(alter("add constraint slack_sync_channels_historical_progress_check check (true)"));
        await runFixture("update public.slack_sync_channels set historical_oldest_seen_ts = '1718900400.000000' where channel_id = $1", [BASE_CHANNEL]);
        return {
          weaker: (await namedConstraints()).filter((row) => row.name === "slack_sync_channels_historical_progress_check")
            .map((row) => ({ kind: row.kind, definition: row.definition })),
          outside: await outsideHistoricalSegment(),
        };
      },
      fact: { weaker: [{ kind: "c", definition: "CHECK (true)" }], outside: true },
    },
  ];
  it.each(REPLAY_REFUSALS.flatMap((refusal) => (["migration", "schema mirror", "full loader"] as Entry[]).map((entry) => ({ ...refusal, entry }))))(
    "MR-04 $entry refuses $id statically and rolls back whole", async (refusal) => {
      await runRefusal(refusal, refusal.entry);
    }, SCRATCH_TIMEOUT);

  it.each(["migration", "schema mirror"] as Entry[])(
    "MR-04 %s replaces a same-name CHECK with a different definition by the canonical one, committing with no NOTICE and no row change",
    async (entry) => {
      await resetToPreF2();
      expect(refusalOf((await applyMigration()).error), "setup: the introduction commits on an empty table").toEqual({ outcome: "the migration committed" });
      await plantBaseline("F2");
      await c.query(alter("drop constraint slack_sync_channels_newest_progress_check"));
      await c.query(alter("add constraint slack_sync_channels_newest_progress_check check (true)"));
      expect((await namedConstraints()).filter((row) => row.name === "slack_sync_channels_newest_progress_check").map((row) => row.definition),
        "fixture: the same-name CHECK carries a different definition").toEqual(["CHECK (true)"]);
      const before = { channels: await rowsDigest(), threads: await threadsDigest() };
      const { error, notices } = await applyEntry(entry);
      expect(notices, `${entry}: no NOTICE or WARNING`).toEqual([]);
      expect(refusalOf(error), `${entry}: the replacement commits`).toEqual({ outcome: "the migration committed" });
      expect(await namedConstraints(), `${entry}: all four named CHECKs are exactly the accepted definitions, validated`).toEqual(EXPECTED_NAMED_CHECKS);
      expect({ channels: await rowsDigest(), threads: await threadsDigest() }, `${entry}: every channel and thread row is unchanged`).toEqual(before);
    }, SCRATCH_TIMEOUT);

  // ── MR-04 B7: interruption inside the block, real two-session serialization, and a later failing query ──

  /**
   * Bounded readiness probe: is backend `pid` waiting on a lock of class `wait`? It only decides
   * WHEN to act. The oracles are the committed or rolled-back catalog and rows read afterwards.
   */
  const waitForLockWait = async (pid: number, wait: "advisory" | "relation"): Promise<boolean> => {
    for (let attempt = 0; attempt < 400; attempt += 1) {
      const { rows } = await probe.query<{ waiting: boolean }>(
        `select exists (select 1 from pg_catalog.pg_stat_activity
                         where pid = $1 and wait_event_type = 'Lock' and wait_event = $2) as waiting`, [pid, wait]);
      if (rows[0].waiting) return true;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    return false;
  };
  const backendPid = async (client: Client): Promise<number> =>
    (await client.query<{ pid: number }>("select pg_catalog.pg_backend_pid() as pid")).rows[0].pid;
  const historicalGeneration = async (): Promise<number> => (await probe.query<{ g: number }>(
    "select historical_scan_generation::int as g from public.slack_sync_channels where channel_id = $1", [BASE_CHANNEL]
  )).rows[0].g;
  /** One execution of `sql` on `client`, notices captured; the error object is returned, never printed. */
  const runOn = async (client: Client, sql: string): Promise<{ error: unknown; notices: string[] }> => {
    const notices: string[] = [];
    const onNotice = (notice: { message?: string }): void => {
      notices.push(notice.message ?? "");
    };
    client.on("notice", onNotice);
    try {
      await client.query(sql);
      return { error: null, notices };
    } catch (error) {
      return { error, notices };
    } finally {
      client.removeListener("notice", onNotice);
    }
  };
  const codeOf = (error: unknown): unknown => (error === null ? "committed" : (error as { code?: unknown })?.code ?? null);

  it.each(["migration", "schema mirror"] as Entry[])(
    "MR-04 B7 %s cancelled INSIDE the block, after it has added columns, rolls back whole, observed from a fresh usable session",
    async (entry) => {
      await resetToPreF2();
      await plantBaseline("pre-F2");
      const holder = new Client({ connectionString: scratchUrl });
      await holder.connect();
      try {
        // FIXTURE: a row trigger that waits on a transaction advisory lock, so the block blocks
        // inside its restart UPDATE, after its column introduction and constraint drops.
        await c.query(`create function public.mr04_fixture_wait() returns trigger language plpgsql
                         as $$ begin perform pg_catalog.pg_advisory_xact_lock(711170); return new; end $$`);
        await c.query("create trigger mr04_fixture_wait before update on public.slack_sync_channels for each row execute function public.mr04_fixture_wait()");
        const before = await refusalEvidence();
        await holder.query("begin");
        await holder.query("select pg_catalog.pg_advisory_xact_lock(711170)");
        const pid = await backendPid(c);
        const pending = applyEntry(entry);
        expect(await waitForLockWait(pid, "advisory"), `${entry}: the block reached its restart UPDATE and is blocked inside it`).toBe(true);
        expect((await probe.query<{ cancelled: boolean }>("select pg_catalog.pg_cancel_backend($1) as cancelled", [pid])).rows[0].cancelled,
          `${entry}: the backend was cancelled`).toBe(true);
        const { error, notices } = await pending;
        await holder.query("rollback");
        expect({ code: codeOf(error), canary: carriesCanary(error), notices }, `${entry}: the statement was cancelled (57014), with no canary and no notice`).toEqual({
          code: "57014", canary: false, notices: [],
        });
        // A FRESH session sees nothing of the interrupted block, and the cancelled session is still usable.
        const fresh = new Client({ connectionString: scratchUrl });
        await fresh.connect();
        try {
          expect((await fresh.query<{ n: number }>(
            `select pg_catalog.count(*)::int as n from pg_catalog.pg_attribute
              where attrelid = 'public.slack_sync_channels'::regclass and not attisdropped and attname = any($1::text[])`, [NEW_COLUMNS]
          )).rows[0].n, `${entry}: a fresh session sees none of the eight introduced columns`).toBe(0);
        } finally {
          await fresh.end().catch(() => {});
        }
        expect((await c.query<{ ok: number }>("select 1 as ok")).rows[0].ok, `${entry}: the cancelled session is usable`).toBe(1);
        expect(await refusalEvidence(), `${entry}: rollback — every column, constraint, routine, owned function, channel and thread row as before`).toEqual(before);
      } finally {
        await holder.query("rollback").catch(() => {});
        await holder.end().catch(() => {});
        await c.query("drop trigger if exists mr04_fixture_wait on public.slack_sync_channels").catch(() => {});
        await c.query("drop function if exists public.mr04_fixture_wait()").catch(() => {});
      }
    }, SCRATCH_TIMEOUT);

  it("MR-04 B7 two concurrent migrations serialize on the table lock: both commit and the active lane restarts EXACTLY once", async () => {
    await resetToPreF2();
    await plantBaseline("pre-F2");
    const generationBefore = await historicalGeneration();
    const blocker = new Client({ connectionString: scratchUrl });
    const second = new Client({ connectionString: scratchUrl });
    await blocker.connect();
    await second.connect();
    try {
      // Both executions queue behind one held ACCESS SHARE lock, then race for ACCESS EXCLUSIVE.
      await blocker.query("begin");
      await blocker.query("lock table public.slack_sync_channels in access share mode");
      const firstPid = await backendPid(c);
      const secondPid = await backendPid(second);
      const first = runOn(c, migration);
      const other = runOn(second, migration);
      expect({ first: await waitForLockWait(firstPid, "relation"), second: await waitForLockWait(secondPid, "relation") },
        "both executions are waiting on the table lock").toEqual({ first: true, second: true });
      await blocker.query("commit");
      const [a, b] = await Promise.all([first, other]);
      expect({ first: codeOf(a.error), second: codeOf(b.error), notices: [...a.notices, ...b.notices] },
        "both serialized executions commit with no notice").toEqual({ first: "committed", second: "committed", notices: [] });
      expect(await historicalGeneration(), "the active historical lane restarted EXACTLY once").toBe(generationBefore + 1);
      expect(await fullCatalog(), "the serialized pair leaves exactly the accepted catalog").toEqual(EXPECTED_FULL_CATALOG);
      expect(await plantedProjection([BASE_CHANNEL]), "the planted metadata survived both executions").toEqual(expectedPlanted([BASE_CHANNEL]));
    } finally {
      await blocker.query("rollback").catch(() => {});
      await blocker.end().catch(() => {});
      await second.end().catch(() => {});
    }
  }, SCRATCH_TIMEOUT);

  it("MR-04 B7 a committed COMPLETE deploy-loader query survives a LATER failing migration query, and the retry commits with no second restart", async () => {
    await resetToPreF2();
    await plantBaseline("pre-F2");
    const generationBefore = await historicalGeneration();
    // 1. The repository's COMPLETE real deploy loader commits: the whole schema.sql, whose mirrored
    //    block performs the one-time introduction and restart, then every migration. A loader
    //    failure is reduced to its SQLSTATE by codeOf: the raw error never prints.
    expect(codeOf((await applyEntry("full loader")).error), "the complete deploy-loader query commits").toBe("committed");
    const committed = { channels: await rowsDigest(), threads: await threadsDigest(), catalog: await fullCatalog() };
    expect({ generation: await historicalGeneration(), catalog: committed.catalog }, "the committed introduction restarted once and left the accepted catalog").toEqual({
      generation: generationBefore + 1, catalog: EXPECTED_FULL_CATALOG,
    });
    // 2. A LATER, separate migration query fails deliberately: the migration file followed by a failing statement.
    const failing = await runOn(c, `${migration}\nselect pg_catalog.int4div(1, 0);\n`);
    expect({ code: codeOf(failing.error), canary: carriesCanary(failing.error) }, "the later query fails on its own deliberate error").toEqual({ code: "22012", canary: false });
    // Only THAT query rolled back; the earlier committed loader query is untouched. No global rollback is claimed.
    expect({ channels: await rowsDigest(), threads: await threadsDigest(), catalog: await fullCatalog() },
      "the committed Slack state survives the later failure exactly, updated_at included").toEqual(committed);
    // 3. The retry commits with no second restart: complete rows exact.
    const retry = await applyEntry("migration");
    expect({ code: codeOf(retry.error), notices: retry.notices }, "the retry commits with no notice").toEqual({ code: "committed", notices: [] });
    expect({ channels: await rowsDigest(), threads: await threadsDigest(), catalog: await fullCatalog(), generation: await historicalGeneration() },
      "after the retry every row is exact (no second restart) and the catalog is the accepted one").toEqual({ ...committed, generation: generationBefore + 1 });
  }, SCRATCH_TIMEOUT);

  // ── MR-04 / §4 STATE REJECTION MATRIX, pre-F2 introduction ──

  it.each([
    {
      label: "an inactive historical lane carrying an attempt-oldest", message: AC02,
      row: { channel_id: "C0INACTOLD01", historical_oldest_seen_ts: "1718900100.000100", newest_cursor: null },
    },
    {
      label: "an active newest lane with no logical lower B", message: AC02,
      row: { channel_id: "C0NEWNOLOW01", newest_anchor_ts: "1718900800.000000", newest_cursor: "CANARY-newest-b" },
    },
    {
      label: "a legacy null-anchor lane with a non-null cursor", message: AM_F2,
      row: { channel_id: "C0NULLANCH01", newest_cursor: "CANARY-newest-c" },
    },
  ])("MR-04 refuses $label with the static error and rolls everything back", async ({ row, message }) => {
    await resetToPreF2();
    await insertChannel({ ...row, updated_at: SEEDED_UPDATED_AT });
    const before = await rowsDigest();
    const { error, notices } = await applyMigration();
    expect(notices, "no NOTICE or WARNING on refusal").toEqual([]);
    expect(refusalOf(error), `refused with the static ${message} error and no value-bearing field`).toEqual(refusedWith(message));
    expect(carriesCanary(error), "no error field carries a planted cursor canary").toBe(false);
    expect({ shape: await preF2Shape(), namedChecks: await namedConstraints() }, "rollback: no column, validator, CHECK or row change").toEqual({
      shape: { columns: [], validator: 0, rows: before }, namedChecks: [],
    });
  }, SCRATCH_TIMEOUT);

  // ── MR-04 / §3.1 PERSISTED HISTORY REJECTION on replay of an F2 SCHEMA state ──

  const NEWEST_INITIALIZED = {
    newest_anchor_ts: "1718900800.000000", newest_lower_ts: "1718900700.000000",
    newest_request_lower_ts: "1718900640.000000", newest_segment_lower_ts: "1718900640.000000",
    newest_segment_upper_ts: "1718900800.000000",
  };

  it.each([
    { label: "a duplicate history", history: ["CANARY-c-1", "CANARY-c-1"], cursor: "CANARY-c-1" },
    { label: "a history whose final element is not the cursor", history: ["CANARY-c-1", "CANARY-c-2"], cursor: "CANARY-c-1" },
    { label: "an empty history under a non-null cursor", history: [], cursor: "CANARY-c-1" },
    { label: "a non-array history", history: { CANARY: 1 }, cursor: null },
    { label: "a history over the 1,000-entry cap", history: Array.from({ length: 1001 }, (_, i) => `CANARY-${i}`), cursor: "CANARY-1000" },
  ])("MR-04 replay refuses $label, left behind with its CHECK removed, with static AM_F2 and rolls back", async ({ history, cursor }) => {
    await resetToPreF2();
    expect(refusalOf((await applyMigration()).error), "setup: the introduction commits on an empty table").toEqual({ outcome: "the migration committed" });
    await insertChannel({ channel_id: "C0LINKAGE001", ...NEWEST_INITIALIZED, newest_cursor: "CANARY-c-1", newest_cursor_history: JSON.stringify(["CANARY-c-1"]) });
    // FIXTURE DDL: the state an operator's manual repair could leave — a present history whose CHECK is gone.
    await c.query("alter table public.slack_sync_channels drop constraint slack_sync_channels_newest_cursor_history_check");
    await runFixture(
      "update public.slack_sync_channels set newest_cursor_history = $1::jsonb, newest_cursor = $2 where channel_id = 'C0LINKAGE001'",
      [JSON.stringify(history), cursor]
    );
    const before = await rowsDigest();
    const { error, notices } = await applyMigration();
    expect(notices, "no NOTICE or WARNING on refusal").toEqual([]);
    expect(refusalOf(error), "refused with the static AM_F2 error and no value-bearing field").toEqual(refusedWith(AM_F2));
    expect(carriesCanary(error), "no error field carries a planted cursor canary").toBe(false);
    expect({ rows: await rowsDigest(), checks: (await namedConstraints()).map((row) => row.name), validator: await validator() },
      "rollback: rows unchanged, the removed CHECK not reinstalled, the validator exactly as it was").toEqual({
      rows: before, validator: EXPECTED_VALIDATOR,
      checks: ["slack_sync_channels_historical_cursor_history_check", "slack_sync_channels_historical_progress_check", "slack_sync_channels_newest_progress_check"],
    });
  }, SCRATCH_TIMEOUT);

  // ── MR-04 / §9 RESTART-HIDING PREVALIDATION: refused BEFORE the restart could erase the defect ──

  it("MR-04 a history-only introduction refuses an attempt-oldest outside [S,U] before the restart could clear it (AC02)", async () => {
    await resetToPreF2();
    expect(refusalOf((await applyMigration()).error), "setup: the introduction commits on an empty table").toEqual({ outcome: "the migration committed" });
    await insertChannel({
      channel_id: "C0HIDEOLDEST",
      historical_anchor_ts: "1718900500.000000", historical_segment_lower_ts: "1718900100.000000", historical_segment_upper_ts: "1718900300.000000",
      historical_oldest_seen_ts: "1718900200.000000", historical_cursor: "CANARY-h-hide", historical_cursor_history: JSON.stringify(["CANARY-h-hide"]),
      historical_scan_generation: 2, updated_at: SEEDED_UPDATED_AT,
    });
    // FIXTURE DDL: the historical history column is absent (history-only introduction) and the
    // progress CHECK is gone, so the attempt-oldest can sit BELOW S. The restart this introduction
    // performs clears exactly that field: only prevalidation can still see the defect.
    await c.query("alter table public.slack_sync_channels drop column historical_cursor_history");
    await c.query("alter table public.slack_sync_channels drop constraint slack_sync_channels_historical_progress_check");
    await runFixture("update public.slack_sync_channels set historical_oldest_seen_ts = '1718900050.000000' where channel_id = 'C0HIDEOLDEST'");
    const before = await rowsDigest();
    const { error, notices } = await applyMigration();
    expect(notices, "no NOTICE or WARNING on refusal").toEqual([]);
    expect(refusalOf(error), "refused with the static AC02 error and no value-bearing field").toEqual(refusedWith(AC02));
    expect(carriesCanary(error), "no error field carries a planted cursor canary").toBe(false);
    expect({
      rows: await rowsDigest(), columns: (await newColumns()).map((row) => row.name),
      checks: (await namedConstraints()).map((row) => row.name),
    }, "rollback from a fresh session: the row is byte-identical, the history column is still absent, no CHECK reinstalled").toEqual({
      rows: before, columns: NEW_COLUMNS.filter((column) => column !== "historical_cursor_history"),
      checks: ["slack_sync_channels_newest_cursor_history_check", "slack_sync_channels_newest_progress_check"],
    });
  }, SCRATCH_TIMEOUT);

  it("MR-04 a segment-only introduction refuses a terminal-mismatched newest history before the restart could clear it (AM_F2)", async () => {
    await resetToPreF2();
    expect(refusalOf((await applyMigration()).error), "setup: the introduction commits on an empty table").toEqual({ outcome: "the migration committed" });
    await insertChannel({
      channel_id: "C0HIDEHIST01", ...NEWEST_INITIALIZED,
      newest_cursor: "CANARY-c-1", newest_cursor_history: JSON.stringify(["CANARY-c-1"]), updated_at: SEEDED_UPDATED_AT,
    });
    // FIXTURE DDL: an F2-only SCHEMA state — the newest segment columns are absent (segment-only
    // introduction) — whose history CHECK is gone, so the stored history can end in another cursor.
    // The restart clears C/H: only prevalidation can still see the defect.
    await c.query("alter table public.slack_sync_channels drop column newest_request_lower_ts, drop column newest_segment_lower_ts, drop column newest_segment_upper_ts");
    await c.query("alter table public.slack_sync_channels drop constraint slack_sync_channels_newest_cursor_history_check");
    await runFixture(
      "update public.slack_sync_channels set newest_cursor_history = $1::jsonb where channel_id = 'C0HIDEHIST01'",
      [JSON.stringify(["CANARY-c-1", "CANARY-c-2"])]
    );
    const before = await rowsDigest();
    const { error, notices } = await applyMigration();
    expect(notices, "no NOTICE or WARNING on refusal").toEqual([]);
    expect(refusalOf(error), "refused with the static AM_F2 error and no value-bearing field").toEqual(refusedWith(AM_F2));
    expect(carriesCanary(error), "no error field carries a planted cursor canary").toBe(false);
    expect({
      rows: await rowsDigest(), columns: (await newColumns()).map((row) => row.name),
      checks: (await namedConstraints()).map((row) => row.name),
    }, "rollback from a fresh session: the row is byte-identical, the segment columns are still absent, no CHECK reinstalled").toEqual({
      rows: before,
      columns: NEW_COLUMNS.filter((column) => !["newest_request_lower_ts", "newest_segment_lower_ts", "newest_segment_upper_ts"].includes(column)),
      checks: ["slack_sync_channels_historical_cursor_history_check", "slack_sync_channels_historical_progress_check"],
    });
  }, SCRATCH_TIMEOUT);

  // ── §3.1 THE EXACT VALIDATOR, and §3.1/§4 THE INSTALLED CHECKS ──

  it("§3.1 the installed validator decides the exact accepted grammar, distinctness and inclusive caps", async () => {
    await resetToPreF2();
    expect(refusalOf((await applyMigration()).error), "setup: the introduction commits on an empty table").toEqual({ outcome: "the migration committed" });
    const atCap = maxHistory("m");
    const overBytes = maxHistory("m", true);
    // Independent byte oracle first, then PostgreSQL's own serialization of the same fixture.
    expect({ atCap: [atCap.length, jsonbTextBytes(atCap)], overBytes: [overBytes.length, jsonbTextBytes(overBytes)] },
      "fixture: 1,000 entries at exactly 1,048,576 bytes, and the same count one byte over").toEqual({ atCap: [1000, 1048576], overBytes: [1000, 1048577] });
    const serialized = (await probe.query<{ at_cap: number; over: number }>(
      "select pg_catalog.octet_length($1::jsonb::text) as at_cap, pg_catalog.octet_length($2::jsonb::text) as over",
      [JSON.stringify(atCap), JSON.stringify(overBytes)]
    )).rows[0];
    expect(serialized, "fixture: PostgreSQL serializes the fixtures to the oracle's byte counts").toEqual({ at_cap: 1048576, over: 1048577 });

    /** Explicit code points, so no fixture depends on how an invisible character was saved. */
    const cp = (...points: number[]): string => String.fromCodePoint(...points);
    const cases: Record<string, unknown> = {
      loneC1U0085: [cp(0x85)],
      blankU2001toU2009: [cp(0x2001, 0x2002, 0x2003, 0x2004, 0x2005, 0x2006, 0x2007, 0x2008, 0x2009)],
      c0U0001: [cp(0x61, 0x01)],
      c0TabInside: [cp(0x61, 0x09, 0x62)],
      empty: [],
      plain: ["a"],
      edgeWhitespaceKept: [" a "],
      caseDistinct: ["a", "A"],
      nfdNfcDistinct: [cp(0x65, 0x301), cp(0xe9)], // the same code points as first written: ["é", "é"],
      notTrimU180E: [cp(0x180e)],
      notTrimU200B: [cp(0x200b)],
      c1Allowed: ["a\u0085"],
      bmp1024: ["a".repeat(1024)],
      astral512: ["\u{1F600}".repeat(512)],
      entries1000AtByteCap: atCap,
      duplicate: ["a", "a"],
      blankEmpty: [""],
      blankSpace: [" "],
      blankNbspIdeographic: [cp(0xa0, 0x3000)], // the same code points as first written: [" 　"],
      blankU1680: [cp(0x1680)], // the same code point as first written: [" "],
      blankU2000toU200A: [cp(0x2000, 0x200a)], // the same code points as first written: ["  "],
      blankU2028U2029: [cp(0x2028, 0x2029)],
      // U+2028/U+2029 end a JavaScript line comment, so the originally written raw literal stays a
      // string sample (valid since ES2019) rather than a comment; it holds the same two code points.
      blankU2028U2029AsWritten: ["  "],
      blankU202FU205F: [cp(0x202f, 0x205f)], // the same code points as first written: ["  "],
      blankFEFF: [cp(0xfeff)],
      c0Control: ["a\u001f"],
      del: ["a\u007f"],
      bmp1025: ["a".repeat(1025)],
      astral513: ["\u{1F600}".repeat(513)],
      utf16NotCodePoints: ["a".repeat(1023) + "\u{1F600}"],
      entries1001: Array.from({ length: 1001 }, (_, i) => `e${i}`),
      bytesOverCap: overBytes,
      numberElement: [1],
      nullElement: [null],
      nestedElement: ["a", ["b"]],
      objectContainer: { a: "b" },
      stringScalar: "a",
      jsonNull: null,
    };
    const decided: Record<string, unknown> = {};
    for (const [label, value] of Object.entries(cases)) {
      decided[label] = (await probe.query<{ valid: boolean | null }>(
        "select public.slack_channel_cursor_history_valid($1::jsonb) as valid", [JSON.stringify(value)]
      )).rows[0].valid;
    }
    decided.sqlNull = (await probe.query<{ valid: boolean | null }>(
      "select public.slack_channel_cursor_history_valid(null::jsonb) as valid"
    )).rows[0].valid;
    expect(decided, "the validator's exact decisions").toEqual({
      loneC1U0085: true, blankU2001toU2009: false, c0U0001: false, c0TabInside: false,
      empty: true, plain: true, edgeWhitespaceKept: true, caseDistinct: true, nfdNfcDistinct: true,
      notTrimU180E: true, notTrimU200B: true, c1Allowed: true, bmp1024: true, astral512: true, entries1000AtByteCap: true,
      duplicate: false, blankEmpty: false, blankSpace: false, blankNbspIdeographic: false, blankU1680: false,
      blankU2000toU200A: false, blankU2028U2029: false, blankU2028U2029AsWritten: false, blankU202FU205F: false, blankFEFF: false,
      c0Control: false, del: false, bmp1025: false, astral513: false, utf16NotCodePoints: false,
      entries1001: false, bytesOverCap: false, numberElement: false, nullElement: false, nestedElement: false,
      objectContainer: false, stringScalar: false, jsonNull: false, sqlNull: null,
    });
  }, SCRATCH_TIMEOUT);

  it("§3.1/§4 the installed CHECKs enforce linkage, the canonical bound domain and the exact progress matrix", async () => {
    await resetToPreF2();
    expect(refusalOf((await applyMigration()).error), "setup: the introduction commits on an empty table").toEqual({ outcome: "the migration committed" });
    const HISTORICAL_INITIALIZED = {
      historical_anchor_ts: "1718900500.000000", historical_segment_lower_ts: "0.000000", historical_segment_upper_ts: "1718900300.000000",
    };
    const attempts: Record<string, Record<string, unknown>> = {
      newestBase: { ...NEWEST_INITIALIZED, newest_cursor: "c-1", newest_cursor_history: JSON.stringify(["c-1"]) },
      newestTerminalMismatch: { ...NEWEST_INITIALIZED, newest_cursor: "c-1", newest_cursor_history: JSON.stringify(["c-1", "c-2"]) },
      newestDuplicate: { ...NEWEST_INITIALIZED, newest_cursor: "c-1", newest_cursor_history: JSON.stringify(["c-1", "c-1"]) },
      newestNoncanonicalLower: { ...NEWEST_INITIALIZED, newest_segment_lower_ts: "1718900640.5" },
      newestRequestAboveLogicalLower: { ...NEWEST_INITIALIZED, newest_lower_ts: "1718900600.000000" },
      newestPartialTuple: { ...NEWEST_INITIALIZED, newest_request_lower_ts: null },
      newestInitializationWithoutB: { newest_anchor_ts: "1718900800.000000" },
      newestInitializationWithB: { newest_anchor_ts: "1718900800.000000", newest_lower_ts: "1718900700.000000" },
      historicalInactiveWithOldest: { historical_oldest_seen_ts: "1718900100.000100" },
      historicalBase: { ...HISTORICAL_INITIALIZED },
      historicalAggregateProviderSpelling: { ...HISTORICAL_INITIALIZED, historical_completed_segments_oldest_ts: "1718900350.5" },
      historicalAggregateEqualsUpper: { ...HISTORICAL_INITIALIZED, historical_completed_segments_oldest_ts: "1718900300.000000" },
      historicalAggregateAboveAnchor: { ...HISTORICAL_INITIALIZED, historical_completed_segments_oldest_ts: "1718900500.000001" },
      historicalOldestBelowLower: { ...HISTORICAL_INITIALIZED, historical_segment_lower_ts: "1718900100.000000", historical_oldest_seen_ts: "1718900099.999999" },
      historicalOldestWithinSegment: { ...HISTORICAL_INITIALIZED, historical_oldest_seen_ts: "1718900250.0001" },
      historicalLowerAboveUpper: { ...HISTORICAL_INITIALIZED, historical_segment_lower_ts: "1718900300.000001" },
      historicalUpperAtMaximum: { historical_anchor_ts: "253402300799.999999", historical_segment_lower_ts: "0.000000", historical_segment_upper_ts: "253402300799.999999" },
      historicalUpperAboveMaximum: { historical_anchor_ts: "253402300800.000000", historical_segment_lower_ts: "0.000000", historical_segment_upper_ts: "253402300800.000000" },
      historicalInitializationWithAggregate: { historical_anchor_ts: "1718900500.000000", historical_completed_segments_oldest_ts: "1718900400.000000" },
    };
    const outcomes: Record<string, unknown> = {};
    let n = 0;
    for (const [label, row] of Object.entries(attempts)) {
      n += 1;
      try {
        await insertChannel({ channel_id: `C0CHECK${String(n).padStart(4, "0")}`, ...row });
        outcomes[label] = "accepted";
      } catch (error) {
        const e = error as Record<string, unknown>;
        outcomes[label] = { code: e.code ?? null, constraint: e.constraint ?? null };
      }
    }
    const violates = (constraint: string) => ({ code: "23514", constraint });
    expect(outcomes, "each attempted row's outcome: accepted, or the exact named CHECK it violates").toEqual({
      newestBase: "accepted",
      newestTerminalMismatch: violates("slack_sync_channels_newest_cursor_history_check"),
      newestDuplicate: violates("slack_sync_channels_newest_cursor_history_check"),
      newestNoncanonicalLower: violates("slack_sync_channels_newest_progress_check"),
      newestRequestAboveLogicalLower: violates("slack_sync_channels_newest_progress_check"),
      newestPartialTuple: violates("slack_sync_channels_newest_progress_check"),
      newestInitializationWithoutB: violates("slack_sync_channels_newest_progress_check"),
      newestInitializationWithB: "accepted",
      historicalInactiveWithOldest: violates("slack_sync_channels_historical_progress_check"),
      historicalBase: "accepted",
      historicalAggregateProviderSpelling: "accepted",
      historicalAggregateEqualsUpper: violates("slack_sync_channels_historical_progress_check"),
      historicalAggregateAboveAnchor: violates("slack_sync_channels_historical_progress_check"),
      historicalOldestBelowLower: violates("slack_sync_channels_historical_progress_check"),
      historicalOldestWithinSegment: "accepted",
      historicalLowerAboveUpper: violates("slack_sync_channels_historical_progress_check"),
      historicalUpperAtMaximum: "accepted",
      historicalUpperAboveMaximum: violates("slack_sync_channels_historical_progress_check"),
      historicalInitializationWithAggregate: violates("slack_sync_channels_historical_progress_check"),
    });
  }, SCRATCH_TIMEOUT);

  // ── MR-03 / F2-12 CLAIM AND RESTART EDGES ──

  /** The permitted restart/fence fields, projected; cursor and history only as null/empty facts. */
  const laneProjection = async () => (await probe.query(
    `select channel_id,
            newest_cursor is null as newest_cursor_null, newest_cursor_history = '[]'::jsonb as newest_history_empty,
            newest_scan_generation::int as newest_generation, newest_lower_ts,
            newest_request_lower_ts, newest_segment_lower_ts, newest_segment_upper_ts,
            historical_cursor is null as historical_cursor_null, historical_cursor_history = '[]'::jsonb as historical_history_empty,
            historical_scan_generation::int as historical_generation, historical_oldest_seen_ts,
            historical_segment_lower_ts, historical_segment_upper_ts, historical_completed_segments_oldest_ts,
            claimed_lane, lease_owner, lease_expires_at::text as lease_expires_at, lease_generation::int as lease_generation,
            next_lane, updated_at = $1::timestamptz as updated_at_seeded
       from public.slack_sync_channels order by channel_id collate "C"`, [SEEDED_UPDATED_AT]
  )).rows;
  /** Everything EXCEPT the §9 permitted restart fields and the eight new columns, digested per row. */
  const RESTART_FIELDS = [
    "newest_cursor", "newest_scan_generation", "historical_cursor", "historical_scan_generation", "historical_oldest_seen_ts",
    "claimed_lane", "lease_owner", "lease_expires_at", "lease_generation", "next_lane", "updated_at", ...NEW_COLUMNS,
  ];
  const unpermittedDigests = async () => (await probe.query(
    `select channel_id, pg_catalog.md5((pg_catalog.to_jsonb(s) - $1::text[])::text) as rest
       from public.slack_sync_channels s order by channel_id collate "C"`, [RESTART_FIELDS]
  )).rows;
  const idleLane = { cursor_null: true, history_empty: true };
  const projected = (row: {
    channel: string; newest: { generation: number; lower?: string | null }; historical: { generation: number; oldest?: string | null };
    claim: { lane: string | null; owner: string | null; expires: string | null; generation: number; next: string }; seeded: boolean;
  }) => ({
    channel_id: row.channel,
    newest_cursor_null: idleLane.cursor_null, newest_history_empty: idleLane.history_empty,
    newest_generation: row.newest.generation, newest_lower_ts: row.newest.lower ?? null,
    newest_request_lower_ts: null, newest_segment_lower_ts: null, newest_segment_upper_ts: null,
    historical_cursor_null: true, historical_history_empty: true,
    historical_generation: row.historical.generation, historical_oldest_seen_ts: row.historical.oldest ?? null,
    historical_segment_lower_ts: null, historical_segment_upper_ts: null, historical_completed_segments_oldest_ts: null,
    claimed_lane: row.claim.lane, lease_owner: row.claim.owner, lease_expires_at: row.claim.expires,
    lease_generation: row.claim.generation, next_lane: row.claim.next, updated_at_seeded: row.seeded,
  });
  const fenced = (generation: number, next: string) => ({ lane: null, owner: null, expires: null, generation, next });

  it("MR-03 union introduction fences a cursor-null live claim, an expired claim and a both-lanes claim, restarts anchored lanes once, and leaves an idle row untouched", async () => {
    await resetToPreF2();
    await insertChannel({
      channel_id: "C0ANCHONLY01", historical_anchor_ts: "1718900500.000000", historical_scan_generation: 0,
      lease_generation: 3, next_lane: "newest", updated_at: SEEDED_UPDATED_AT,
    });
    await insertChannel({
      channel_id: "C0BOTHLANE01",
      newest_anchor_ts: "1718900800.000000", newest_lower_ts: "1718900700.000000", newest_cursor: "CANARY-n-2", newest_scan_generation: 5,
      historical_anchor_ts: "1718900500.000000", historical_cursor: "CANARY-h-2", historical_scan_generation: 4,
      historical_oldest_seen_ts: "1718900200.000000",
      claimed_lane: "newest", lease_owner: "lease-owner-r2", lease_expires_at: LIVE_EXPIRY, lease_generation: 21, next_lane: "historical",
      updated_at: SEEDED_UPDATED_AT, ...PLANTED.C0BOTHLANE01,
    });
    await insertChannel({
      channel_id: "C0CLAIMHIST1", historical_anchor_ts: "1718900500.000000", historical_scan_generation: 2,
      claimed_lane: "historical", lease_owner: "lease-owner-r1", lease_expires_at: LIVE_EXPIRY, lease_generation: 11, next_lane: "newest",
      updated_at: SEEDED_UPDATED_AT, ...PLANTED.C0CLAIMHIST1,
    });
    await insertChannel({
      channel_id: "C0EXPIRED001", historical_anchor_ts: "1718900500.000000", historical_cursor: "CANARY-h-5", historical_scan_generation: 1,
      historical_oldest_seen_ts: "1718900300.000000",
      claimed_lane: "historical", lease_owner: "lease-owner-r5", lease_expires_at: PAST_EXPIRY, lease_generation: 9, next_lane: "newest",
      updated_at: SEEDED_UPDATED_AT, ...PLANTED.C0EXPIRED001,
    });
    await insertChannel({ channel_id: "C0IDLE000001", lease_generation: 4, next_lane: "historical", updated_at: SEEDED_UPDATED_AT });
    const claimRows = ["C0BOTHLANE01", "C0CLAIMHIST1", "C0EXPIRED001"];
    // Non-vacuity: the claim rows really carry the planted non-default values the digest preserves.
    expect(await plantedProjection(claimRows), "fixture: the claim rows carry their planted attempts, error/success, certification, catch-up, metadata-owner, public, binding, due and created values").toEqual(expectedPlanted(claimRows));
    const restBefore = await unpermittedDigests();

    const { error, notices } = await applyMigration();
    expect(notices, "no NOTICE or WARNING on introduction").toEqual([]);
    expect(refusalOf(error), "the union introduction commits").toEqual({ outcome: "the migration committed" });
    expect(await laneProjection(), "each row's exact restart/fence outcome").toEqual([
      // An anchored, cursor-null lane with no claim: restarted once, claim and turn preserved.
      projected({ channel: "C0ANCHONLY01", newest: { generation: 0 }, historical: { generation: 1 },
        claim: { lane: null, owner: null, expires: null, generation: 3, next: "newest" }, seeded: false }),
      // Both lanes active, claim on newest: both restart once; the claim is fenced once and the turn goes to newest.
      projected({ channel: "C0BOTHLANE01", newest: { generation: 6, lower: "1718900700.000000" }, historical: { generation: 5 },
        claim: fenced(22, "newest"), seeded: false }),
      // A cursor-null LIVE claim (an in-flight first page) on the restarted lane: fenced.
      projected({ channel: "C0CLAIMHIST1", newest: { generation: 0 }, historical: { generation: 3 },
        claim: fenced(12, "historical"), seeded: false }),
      // An expired claim on the restarted lane: fenced the same way.
      projected({ channel: "C0EXPIRED001", newest: { generation: 0 }, historical: { generation: 2 },
        claim: fenced(10, "historical"), seeded: false }),
      // An idle row: nothing restarted, nothing written — updated_at included.
      projected({ channel: "C0IDLE000001", newest: { generation: 0 }, historical: { generation: 0 },
        claim: { lane: null, owner: null, expires: null, generation: 4, next: "historical" }, seeded: true }),
    ]);
    expect(await unpermittedDigests(), "every column outside the permitted restart fields is byte-identical").toEqual(restBefore);
    expect(await plantedProjection(claimRows), "fencing kept every planted value on the claim rows").toEqual(expectedPlanted(claimRows));

    const afterFirst = await rowsDigest();
    const replay = await applyMigration();
    expect(replay.notices, "no NOTICE or WARNING on replay").toEqual([]);
    expect(refusalOf(replay.error), "replay commits").toEqual({ outcome: "the migration committed" });
    expect(await rowsDigest(), "replay: every row byte-identical, updated_at included").toEqual(afterFirst);
  }, SCRATCH_TIMEOUT);

  it("MR-03 a history-only one-lane introduction preserves the opposite live claim and the restarted lane's bounds, then replay after progress and MAXIMUM histories changes nothing", async () => {
    await resetToPreF2();
    expect(refusalOf((await applyMigration()).error), "setup: the introduction commits on an empty table").toEqual({ outcome: "the migration committed" });
    await insertChannel({
      channel_id: "C0ONELANE001", ...NEWEST_INITIALIZED,
      newest_cursor: "CANARY-n-2", newest_cursor_history: JSON.stringify(["CANARY-n-1", "CANARY-n-2"]), newest_scan_generation: 7,
      historical_anchor_ts: "1718900500.000000", historical_segment_lower_ts: "0.000000", historical_segment_upper_ts: "1718900300.000000",
      historical_completed_segments_oldest_ts: "1718900350.5", historical_oldest_seen_ts: "1718900250.000100",
      historical_cursor: "CANARY-h-1", historical_cursor_history: JSON.stringify(["CANARY-h-1"]), historical_scan_generation: 3,
      claimed_lane: "newest", lease_owner: "lease-owner-r6", lease_expires_at: LIVE_EXPIRY, lease_generation: 31, next_lane: "historical",
      updated_at: SEEDED_UPDATED_AT, ...PLANTED.C0ONELANE001,
    });
    /** The newest cursor and history by SQL equality with their literals — booleans, never a hash. */
    const newestKept = async () => (await probe.query(
      `select newest_cursor = $2 as cursor_kept, newest_cursor_history = $3::jsonb as history_kept
         from public.slack_sync_channels where channel_id = $1`,
      ["C0ONELANE001", "CANARY-n-2", JSON.stringify(["CANARY-n-1", "CANARY-n-2"])]
    )).rows[0];
    // The ONLY columns §9 lets a history-only historical restart change.
    const HISTORICAL_RESTART_FIELDS = ["historical_cursor", "historical_cursor_history", "historical_scan_generation", "historical_oldest_seen_ts", "updated_at"];
    // Non-vacuity: every preservation-relevant column carries a distinctive value before the upgrade.
    expect({
      planted: await plantedProjection(["C0ONELANE001"]), newest: await newestKept(),
      anchors: (await probe.query(
        `select newest_anchor_ts, newest_lower_ts, historical_anchor_ts from public.slack_sync_channels where channel_id = 'C0ONELANE001'`
      )).rows[0],
    }, "fixture: the one-lane row carries its planted metadata, its newest history and both anchors").toEqual({
      planted: expectedPlanted(["C0ONELANE001"]), newest: { cursor_kept: true, history_kept: true },
      anchors: { newest_anchor_ts: "1718900800.000000", newest_lower_ts: "1718900700.000000", historical_anchor_ts: "1718900500.000000" },
    });
    const preserved = await rowExcept("C0ONELANE001", HISTORICAL_RESTART_FIELDS);
    // FIXTURE DDL: an F2 SCHEMA state missing only the historical history column (§9 history-only introduction).
    await c.query("alter table public.slack_sync_channels drop column historical_cursor_history");

    const { error, notices } = await applyMigration();
    expect(notices, "no NOTICE or WARNING on the one-lane introduction").toEqual([]);
    expect(refusalOf(error), "the one-lane introduction commits").toEqual({ outcome: "the migration committed" });
    expect(await laneProjection(), "historical restarted once with its bounds and aggregate kept; the newest lane and its live claim untouched").toEqual([{
      channel_id: "C0ONELANE001",
      newest_cursor_null: false, newest_history_empty: false, newest_generation: 7, newest_lower_ts: "1718900700.000000",
      newest_request_lower_ts: "1718900640.000000", newest_segment_lower_ts: "1718900640.000000", newest_segment_upper_ts: "1718900800.000000",
      historical_cursor_null: true, historical_history_empty: true, historical_generation: 4, historical_oldest_seen_ts: null,
      historical_segment_lower_ts: "0.000000", historical_segment_upper_ts: "1718900300.000000", historical_completed_segments_oldest_ts: "1718900350.5",
      claimed_lane: "newest", lease_owner: "lease-owner-r6", lease_expires_at: LIVE_EXPIRY, lease_generation: 31, next_lane: "historical",
      updated_at_seeded: false,
    }]);
    expect(await newestKept(), "the newest cursor and history are exactly as seeded").toEqual({ cursor_kept: true, history_kept: true });
    expect(await changedColumns("C0ONELANE001", preserved, HISTORICAL_RESTART_FIELDS),
      "whole row: no column outside the five permitted historical restart fields changed (anchors, newest history/segments, historical bounds/aggregate and every planted value included)").toEqual([]);
    expect(await fullCatalog(), "the one-lane introduction ends at the exact accepted catalog").toEqual(EXPECTED_FULL_CATALOG);

    // Segment progress and MAXIMUM histories on BOTH lanes, written under the installed CHECKs.
    const newestMax = maxHistory("n");
    const historicalMax = maxHistory("h");
    await runFixture(
      `update public.slack_sync_channels
          set newest_cursor_history = $1::jsonb, newest_cursor = $2,
              historical_cursor_history = $3::jsonb, historical_cursor = $4, historical_oldest_seen_ts = '1718900280.000000'
        where channel_id = 'C0ONELANE001'`,
      [JSON.stringify(newestMax), newestMax[999], JSON.stringify(historicalMax), historicalMax[999]]
    );
    expect((await probe.query(
      `select pg_catalog.jsonb_array_length(newest_cursor_history) as newest_entries, pg_catalog.octet_length(newest_cursor_history::text) as newest_bytes,
              pg_catalog.jsonb_array_length(historical_cursor_history) as historical_entries, pg_catalog.octet_length(historical_cursor_history::text) as historical_bytes
         from public.slack_sync_channels where channel_id = 'C0ONELANE001'`
    )).rows[0], "fixture: both lanes hold a maximum accepted history").toEqual({
      newest_entries: 1000, newest_bytes: 1048576, historical_entries: 1000, historical_bytes: 1048576,
    });
    const progressed = await rowsDigest();
    for (const pass of ["first", "second"]) {
      const replay = await applyMigration();
      expect(replay.notices, `no NOTICE or WARNING on the ${pass} replay`).toEqual([]);
      expect(refusalOf(replay.error), `the ${pass} replay commits`).toEqual({ outcome: "the migration committed" });
      expect(await rowsDigest(), `${pass} replay after progress and maximum histories: the full row, updated_at included, is byte-identical`).toEqual(progressed);
    }
  }, SCRATCH_TIMEOUT);
});
