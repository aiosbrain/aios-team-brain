import { readFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * AIO-1170 AM-F2 + AC-02 deep history — RED PACKET 3: catalog identity, conflicts, the state
 * rejection matrix, claim/restart edges and replay, against the real migration on real PostgreSQL
 * (accepted consolidated contract `aio1170-am-f2-deep-history-consolidated-accepted-spec-migration-v1-20261023.md`,
 * §3.1, §4, §9, §9.3 MR-02/MR-03/MR-04, §10 DH-11, §10.1 F2-12).
 *
 * Sibling of `slack-history-progress-upgrade.datamechanics.test.ts`, which keeps its one narrow
 * populated-union case unchanged. This file uses ONE scratch database per run, created and dropped
 * here under the isolated data-mechanics URL exactly as that file does, loaded once by the real
 * loader. Every database case first rebuilds the pre-F2 table with FIXTURE DDL on that throwaway
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
 * PRIVACY. Assertions never print a cursor, a history or an error's free text:
 *  - refusals are projected to SQLSTATE, a message that is either one of the two accepted static
 *    messages or a fixed placeholder, and the PRESENCE (never the content) of every
 *    value-bearing error field;
 *  - cursor/history contents and whole rows are compared only by md5 digests;
 *  - refusal cases plant `CANARY` cursors and require that no error field carries one.
 * Scalar bookkeeping (generations, lease fields, bounds) is literal, non-secret fixture data.
 *
 * WHAT THIS PACKET PROVES, and which assertions are RED by intent at base 1f7902a2:
 *  - MR-02 catalog identity: the from-zero catalog (schema mirror) and the direct-migration catalog
 *    both carry exactly the eight columns, exactly the 25 pre-F2 constraints plus the four named
 *    CHECKs (each with its exact definition, validated), no other owned function, and the exact
 *    validator (metadata AND body). Expected GREEN today.
 *  - MR-04 helper conflict: a validator with the accepted identity but a DEFAULTED argument is
 *    refused with static P0001 / AM_F2_UPGRADE_INVALID_STATE, all-or-nothing. Expected GREEN today.
 *  - MR-04 wrong-kind constraint conflict: an accepted CHECK name already used by a NON-CHECK
 *    constraint must be refused, AM_F2 for a history name and AC02 for a progress name, before any
 *    drop. **RED by intent**: the current block guards each drop by name only, so it silently drops
 *    the foreign UNIQUE constraint and commits. That deletes an object the upgrade does not own, and
 *    §9 requires incompatible catalog objects to be conflicts. The named failing assertion is
 *    "wrong-kind … is refused with the static … error".
 *  - MR-04 / §4 state rejection matrix: refused with static errors and full rollback:
 *    · an inactive historical lane carrying an attempt-oldest (AC02);
 *    · an active newest lane with no logical lower B (AC02);
 *    · a legacy null-anchor/non-null-cursor lane (AM_F2);
 *    · persisted histories that are duplicate, terminal-mismatched, empty under a non-null cursor,
 *      non-array or over the entry cap (AM_F2).
 *    Expected GREEN today.
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
 *    · every non-permitted column unchanged.
 *    Then a history-only one-lane introduction that preserves the opposite live claim and the
 *    restarted lane's segment bounds and aggregate. Then replay after segment progress and MAXIMUM
 *    histories on both lanes, which must leave every row byte-identical. Expected GREEN today.
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
 *  - Schema comment precision: the comment above the eight from-zero columns must not claim the two
 *    paths have the "same final catalog". Only the executable statement's byte identity is
 *    guaranteed, and from-zero columns sit in different attribute positions from upgraded ones.
 *    **RED by intent** until the comment is corrected (this packet does not edit it). The named
 *    failing assertion is "schema comment … same final catalog".
 *
 * WHAT REMAINS, NOT claimed here:
 *  - MR-02: from-zero vs schema-plus-all-migrations fingerprints, empty-search-path dump/restore and
 *    replay after restore;
 *  - MR-03: mirror-only execution and both execution orders on independent fixtures; segment-only
 *    introduction on an F2-only SCHEMA state; staged/published/ledger evidence rows;
 *  - MR-04: injected cancellation, real concurrent sessions (serialization), the failed-later-
 *    migration retry case;
 *  - MR-05 structural sweeps; MR-06 (held until PR743 staging); every runtime/DH-12/DH-13 behavior,
 *    which needs the not-yet-wired writer and is not claimed by this migration packet.
 */

const SCRATCH_TIMEOUT = 300_000;
const ROOT = process.cwd();
const MIGRATION_PATH = join(ROOT, "postgres", "migrations", "20261023120000_slack_channel_history_segments.sql");
const SCHEMA_PATH = join(ROOT, "postgres", "schema.sql");
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
/** Every public function in the table's naming families once F2 is in: no progress helper exists. */
const POST_F2_OWNED_FUNCTIONS = ["slack_channel_cursor_history_valid", "slack_sync_channels_clear_deleted_binding"];

// ── FIXTURE IDENTITY, literal ──

const TEAM_ID = "6b2c3d4e-5f60-4b7c-9d8e-1f2a3b4c5d6e";
const WORKSPACE = "T0CONFLICT1";
const SEEDED_UPDATED_AT = "2026-01-02 03:04:05+00";
const LIVE_EXPIRY = "2030-01-01 00:00:00+00";
const PAST_EXPIRY = "2020-01-01 00:00:00+00";

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

describe("AM-F2 + AC-02 history/segment block — static source fences (DH-11, MR-02 parity)", () => {
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
      transactionControl: /^\s*(?:commit|rollback|begin\s*;|start\s+transaction|savepoint)\b/im.test(code),
      everyRaiseStatic: raises.length > 0 && raises.length === staticRaises.length,
      oneLock: occurrences(code, lock),
      observesBeforeLock: /pg_catalog\.pg_|information_schema|public\.slack_sync_channels/.test(beforeLock),
    }, "the block's notice/error/lock discipline").toEqual({
      skipNoticeDdl: false, noticeLevel: false, gucSuppression: false, catchAll: false, valueBearingField: false,
      transactionControl: false, everyRaiseStatic: true, oneLock: 1, observesBeforeLock: false,
    });
  });

  it("schema comment precision: the from-zero column comment does not claim the same final catalog", () => {
    // RED by intent at 1f7902a2. Only the executable statement's bytes are guaranteed identical;
    // from-zero columns occupy different attribute positions than upgraded ones, so "same final
    // catalog" overstates what either path proves.
    expect(schemaText.includes("same final catalog"), "schema comment above the eight from-zero columns claims the same final catalog").toBe(false);
  });
});

// ── THE REAL POSTGRESQL CASES ──

describe("AM-F2 + AC-02 history/segment migration — catalog identity, conflicts, rejections and claim edges (real Postgres)", () => {
  let adminUrl = "";
  let scratch = "";
  let c: Client; // runs the migration (notices captured here)
  let probe: Client; // a second session: every post-migration inspection
  let fromZero: Record<string, unknown> = {};
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
    functions: await ownedFunctions(), validator: await validator(),
  });
  const EXPECTED_FULL_CATALOG = {
    columns: EXPECTED_COLUMNS, constraintNames: POST_F2_CONSTRAINT_NAMES, namedChecks: EXPECTED_NAMED_CHECKS,
    functions: POST_F2_OWNED_FUNCTIONS, validator: EXPECTED_VALIDATOR,
  };
  /** Every channel row, digested: equality proves byte-identical rows without printing one. */
  const rowsDigest = async (): Promise<string> => (await probe.query<{ digest: string }>(
    `select coalesce(pg_catalog.md5(pg_catalog.string_agg(pg_catalog.to_jsonb(s)::text, '|' order by s.channel_id collate "C")), 'no rows') as digest
       from public.slack_sync_channels s`
  )).rows[0].digest;

  /** One execution of the real migration file; notices captured only for its duration. */
  const applyMigration = async (): Promise<{ error: unknown; notices: string[] }> => {
    const notices: string[] = [];
    const onNotice = (notice: { message?: string }): void => {
      notices.push(notice.message ?? "");
    };
    c.on("notice", onNotice);
    try {
      await c.query(migration);
      return { error: null, notices };
    } catch (error) {
      return { error, notices };
    } finally {
      c.removeListener("notice", onNotice);
    }
  };

  /** Insert one channel row from literal column values (histories as JSON text). */
  const insertChannel = async (row: Record<string, unknown>): Promise<void> => {
    const columns = ["team_id", "workspace_id", ...Object.keys(row)];
    const values = [TEAM_ID, WORKSPACE, ...Object.values(row)];
    await c.query(
      `insert into public.slack_sync_channels (${columns.join(", ")}) values (${values.map((_, i) => `$${i + 1}`).join(", ")})`,
      values
    );
  };

  /** FIXTURE DDL on this scratch database only: back to the exact pre-F2 table, with no rows. */
  const resetToPreF2 = async (): Promise<void> => {
    await c.query("delete from public.slack_sync_channels");
    for (const name of NAMED_CHECKS) {
      await c.query(`alter table public.slack_sync_channels drop constraint if exists ${name}`);
    }
    await c.query(`alter table public.slack_sync_channels ${NEW_COLUMNS.map((column) => `drop column if exists ${column}`).join(", ")}`);
    await c.query("drop function if exists public.slack_channel_cursor_history_valid(jsonb)");
    expect({
      columns: await newColumns(), namedChecks: await namedConstraints(), validator: await validator(),
      rows: await rowsDigest(),
    }, "fixture: the table is back to pre-F2 — no new column, named CHECK or validator, and no rows").toEqual({
      columns: [], namedChecks: [], validator: [], rows: "no rows",
    });
  };
  /** The rollback evidence for a refused pre-F2 introduction. */
  const preF2Shape = async () => ({ columns: await newColumns(), validator: (await validator()).length, rows: await rowsDigest() });

  beforeAll(async () => {
    const { loadSchema } = await import("@/scripts/pg-load-schema.mjs");
    // Refused BEFORE any connection or database creation.
    adminUrl = requireIsolatedTestUrl(process.env.DATABASE_TEST_URL);
    scratch = `slackconflict_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
    const admin = new Client({ connectionString: adminUrl });
    await admin.connect();
    try {
      await admin.query(`create database ${scratch}`);
    } finally {
      await admin.end().catch(() => {});
    }
    const target = new URL(adminUrl);
    target.pathname = `/${scratch}`;
    const url = target.toString();
    await loadSchema({ cwd: process.cwd(), databaseUrl: url, logger: { log: () => {} } });
    c = new Client({ connectionString: url });
    probe = new Client({ connectionString: url });
    await c.connect();
    await probe.connect();
    await c.query("set time zone 'UTC'");
    await probe.query("set time zone 'UTC'");
    // The from-zero catalog, captured before any fixture DDL touches it.
    fromZero = await fullCatalog();
    await c.query(`insert into teams (id, slug, name) values ($1, 'conflict-team', 'Conflict Team')`, [TEAM_ID]);
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

  it("MR-02 the from-zero schema carries the exact accepted columns, constraints, four named CHECK definitions and validator", () => {
    expect(fromZero, "from-zero catalog: columns, every constraint, the four named CHECK definitions (validated), owned functions and the exact validator").toEqual(EXPECTED_FULL_CATALOG);
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

  it.each([
    { label: "a history CHECK name", name: "slack_sync_channels_newest_cursor_history_check", message: AM_F2 },
    { label: "a progress CHECK name", name: "slack_sync_channels_historical_progress_check", message: AC02 },
  ])("MR-04 wrong-kind: $label held by a UNIQUE constraint is refused before any drop (RED until the kind guard lands)", async ({ name, message }) => {
    await resetToPreF2();
    await insertChannel({ channel_id: "C0WRONGKIND1", historical_anchor_ts: "1718900500.000000", historical_cursor: "CANARY-wrongkind-1", updated_at: SEEDED_UPDATED_AT });
    await c.query(`alter table public.slack_sync_channels add constraint ${name} unique (id)`);
    const before = await rowsDigest();
    const { error, notices } = await applyMigration();
    expect(notices, "no skip NOTICE or WARNING").toEqual([]);
    // THE INTENDED RED: today the name-only guard drops the foreign UNIQUE constraint and commits.
    expect(refusalOf(error), `wrong-kind ${name} is refused with the static ${message} error and no value-bearing or constraint field`).toEqual(refusedWith(message));
    expect(carriesCanary(error), "no error field carries the planted cursor canary").toBe(false);
    expect({ shape: await preF2Shape(), held: (await namedConstraints()).map((row) => ({ name: row.name, kind: row.kind })) },
      "rollback: still pre-F2, rows unchanged, and the foreign UNIQUE constraint still holds its name").toEqual({
      shape: { columns: [], validator: 0, rows: before }, held: [{ name, kind: "u" }],
    });
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
    await c.query(
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

    const cases: Record<string, unknown> = {
      empty: [],
      plain: ["a"],
      edgeWhitespaceKept: [" a "],
      caseDistinct: ["a", "A"],
      nfdNfcDistinct: ["é", "é"],
      notTrimU180E: ["᠎"],
      notTrimU200B: ["​"],
      c1Allowed: ["a\u0085"],
      bmp1024: ["a".repeat(1024)],
      astral512: ["\u{1F600}".repeat(512)],
      entries1000AtByteCap: atCap,
      duplicate: ["a", "a"],
      blankEmpty: [""],
      blankSpace: [" "],
      blankNbspIdeographic: [" 　"],
      blankU1680: [" "],
      blankU2000toU200A: ["  "],
      blankU2028U2029: ["  "],
      blankU202FU205F: ["  "],
      blankFEFF: ["﻿"],
      c0Control: ["a\u001f"],
      del: ["a\u007f"],
      bmp1025: ["a".repeat(1025)],
      astral513: ["\u{1F600}".repeat(513)],
      utf16Not CodePoints: ["a".repeat(1023) + "\u{1F600}"],
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
      empty: true, plain: true, edgeWhitespaceKept: true, caseDistinct: true, nfdNfcDistinct: true,
      notTrimU180E: true, notTrimU200B: true, c1Allowed: true, bmp1024: true, astral512: true, entries1000AtByteCap: true,
      duplicate: false, blankEmpty: false, blankSpace: false, blankNbspIdeographic: false, blankU1680: false,
      blankU2000toU200A: false, blankU2028U2029: false, blankU202FU205F: false, blankFEFF: false,
      c0Control: false, del: false, bmp1025: false, astral513: false, "utf16Not CodePoints": false,
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
      updated_at: SEEDED_UPDATED_AT,
    });
    await insertChannel({
      channel_id: "C0CLAIMHIST1", historical_anchor_ts: "1718900500.000000", historical_scan_generation: 2,
      claimed_lane: "historical", lease_owner: "lease-owner-r1", lease_expires_at: LIVE_EXPIRY, lease_generation: 11, next_lane: "newest",
      updated_at: SEEDED_UPDATED_AT,
    });
    await insertChannel({
      channel_id: "C0EXPIRED001", historical_anchor_ts: "1718900500.000000", historical_cursor: "CANARY-h-5", historical_scan_generation: 1,
      historical_oldest_seen_ts: "1718900300.000000",
      claimed_lane: "historical", lease_owner: "lease-owner-r5", lease_expires_at: PAST_EXPIRY, lease_generation: 9, next_lane: "newest",
      updated_at: SEEDED_UPDATED_AT,
    });
    await insertChannel({ channel_id: "C0IDLE000001", lease_generation: 4, next_lane: "historical", updated_at: SEEDED_UPDATED_AT });
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
      updated_at: SEEDED_UPDATED_AT,
    });
    const newestDigest = async () => (await probe.query(
      `select pg_catalog.md5(newest_cursor) as cursor, pg_catalog.md5(newest_cursor_history::text) as history
         from public.slack_sync_channels where channel_id = 'C0ONELANE001'`
    )).rows[0];
    const newestBefore = await newestDigest();
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
    expect(await newestDigest(), "the newest cursor and history are byte-identical").toEqual(newestBefore);
    expect(await fullCatalog(), "the one-lane introduction ends at the exact accepted catalog").toEqual(EXPECTED_FULL_CATALOG);

    // Segment progress and MAXIMUM histories on BOTH lanes, written under the installed CHECKs.
    const newestMax = maxHistory("n");
    const historicalMax = maxHistory("h");
    await c.query(
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
