import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "pg";
import { beforeAll, describe, expect, it } from "vitest";
import { loadSchema } from "../../scripts/pg-load-schema.mjs";
import type { TransactionSession } from "@/lib/db/types";
import {
  acceptSlackChannelPage,
  claimSlackChannelPage,
  dueSlackChannels,
  ensureSlackChannel,
  releaseSlackChannelForRetry,
  type SlackChannelClaim,
  type SlackChannelScope,
} from "@/lib/ingest/slack-channel-state";
import { transactionCapability } from "@/lib/projects/context/transaction";
import { db, seedTeam, transactionSessionDecoratedDb } from "./helpers";
import { requireIsolatedTestUrl } from "./slack-history-isolated-url";

/**
 * AIO-1170 AM-F2 — RED-FIRST RUNTIME PACKET 1: STATE-WRITER HISTORY ADMISSION
 * (accepted consolidated contract `aio1170-am-f2-deep-history-consolidated-accepted-spec-migration-v1-20261023.md`,
 * §3.1–§3.3, §4, F2-01–F2-08, DH-02/03/05/06/08).
 *
 * ONE SEAM: `acceptSlackChannelPage` as the SQL authority over a lane's SQL-local cursor history H.
 * It is exercised on the real data-mechanics PostgreSQL, with the now-installed history and
 * progress CHECKs, through the real claim and release writers. Every channel row is a literal
 * fixture with valid FKs:
 *  - initialized segments on both lanes;
 *  - a synthetic historical history and a newest history.
 *
 * WHY THE CURRENT IMPLEMENTATION IS RED, by behavior rather than by a missing export: today's
 * writer moves the lane cursor but never touches H. Under the installed linkage CHECK, a partial,
 * repeated, unrepresentable or terminal acceptance therefore fails inside PostgreSQL with 23514.
 * Each case captures its outcome as a SANITIZED projection:
 *  - `{ outcome, category }` for a typed result;
 *  - `{ threw: true, code, name }` for an exception.
 * The intended RED is always an assertion mismatch on that projection, never an escaped
 * constraint error, a missing export, ENOENT or a parse failure. No assertion expects a raw SQL
 * error as an application outcome.
 *
 * EXPECTED, per the contract:
 *  1. a partial accepted continuation APPENDS the exact decoded cursor (C becomes H's final element)
 *     after the lane's prior entries; the other lane and all unrelated state stay exact (F2-01);
 *  2. exact repetition is a typed `rejected` / `cursor_repeated`. The caller's SAME-transaction
 *     passed-turn `releaseSlackChannelForRetry` is then the only change: H, C, G, progress and
 *     certification are untouched (F2-02, §3.2). Repetition at the entry cap is still
 *     repetition (precedence);
 *  3. entry overflow and byte overflow are DISTINCT categories, computed by SQL on the actual
 *     candidate JSONB (`jsonb_array_length`, `octet_length(candidate::text)`). Overflowing both
 *     caps is `entries`. A TERMINAL page at either exact cap is written, because it appends no
 *     cursor (F2-03/04, §3.1);
 *  4. a lone surrogate is `cursor_unrepresentable`, and the raw value is NEVER sent as a SQL
 *     parameter. A valid surrogate pair and a literal U+FFFD are positive controls, appended
 *     exactly (F2-05, §3.3);
 *  5. stale authority beats cursor classification. A stale lease, binding, public proof or
 *     segment returns `refused` and leaves the row byte-identical (F2-06, DH-08);
 *  6. histories are NOT in `SlackChannelState`, `SlackChannelClaim`, due projections or returned
 *     written state (§3.1). This is behavioral (an older H entry never appears in any returned
 *     object), plus one precise source check of `STATE_COLUMNS`.
 *
 * EXPECTED GREEN TODAY (not RED): the stale-LEASE and stale-BINDING refusals, which today's UPDATE
 * already fences, and the boundary checks in 6. EXPECTED RED: everything else listed in the
 * coordinator report.
 *
 * PRIVACY: cursors and histories are synthetic. They are compared only by SQL equality (booleans),
 * row md5 digests or counts. Errors are projected to SQLSTATE/name. The lone-surrogate recorder
 * stores a boolean, never a value.
 *
 * ISOLATION AND SCHEMA: runs on the data-mechanics tier database, truncated per test by
 * `setup.ts`. In `beforeAll`, in this order:
 *  1. the shared `DATABASE_TEST_URL` guard (`./slack-history-isolated-url.ts`) refuses anything but
 *     the isolated local runner or CI's service;
 *  2. `slack_sync_channels` is emptied (nothing references it), so leftover rows cannot affect the
 *     upgrade;
 *  3. the REAL deploy loader (`scripts/pg-load-schema.mjs`: schema.sql, whose marked block is the
 *     owned upgrade, then every migration) brings that GUARDED database to the current F2/DH
 *     shape. This is the `slack-method-budget` pattern. The tier container may predate the new
 *     columns, so seeding without this hit 42703. It is an idempotent replay.
 *
 * LATER RUNTIME PACKETS, NOT covered here:
 *  - discovery's structural validation order (malformed_page → pagination_incomplete →
 *    malformed_timestamp → page_outside_segment) and root-enqueue atomicity/rollback;
 *  - segment subdivision, initialization before HTTP, and segment application (DH-01/02/03);
 *  - the maximum-history compatibility writers of §3.4;
 *  - the §9.1/§9.2 source-fence and bootstrap fixture corrections;
 *  - DH-09 scheduling/fairness;
 *  - the full DH-11/12/13 matrices and the controlled mutants.
 */

const WORKSPACE = "T0HISTADM1";
const CHANNEL = "C0HISTADM1";
const REVISION = "ad".repeat(32);
const OTHER_REVISION = "be".repeat(32);

/** Lane literals: initialized segments on BOTH lanes; the historical lane is the one claimed. */
const NEWEST_FIXTURE = {
  newest_anchor_ts: "1718900800.000000", newest_lower_ts: "1718900700.000000", newest_request_lower_ts: "1718900640.000000",
  newest_segment_lower_ts: "1718900640.000000", newest_segment_upper_ts: "1718900800.000000",
  newest_cursor: "syn-n-1", newest_cursor_history: JSON.stringify(["syn-n-1"]), newest_scan_generation: 2,
};
const HISTORICAL_ANCHOR = "1718900500.000000";

function tx<T>(fn: (session: TransactionSession) => Promise<T>): Promise<T> {
  return transactionCapability(db()).transaction(fn);
}

/** True if the string holds an UNPAIRED UTF-16 surrogate. Scans code units; never stores the value. */
function hasLoneSurrogate(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const unit = value.charCodeAt(i);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) i += 1;
      else return true;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      return true;
    }
  }
  return false;
}

/** A transaction whose every SQL parameter is checked for a lone surrogate; only a boolean is kept. */
function recordingTx<T>(recorder: { loneSurrogateSent: boolean }, fn: (session: TransactionSession) => Promise<T>): Promise<T> {
  const decorated = transactionSessionDecoratedDb(db(), (session) => ({
    ...session,
    executeSql: (async (sql: string, params?: readonly unknown[]) => {
      if ((params ?? []).some((param) => typeof param === "string" && hasLoneSurrogate(param))) recorder.loneSurrogateSent = true;
      return session.executeSql(sql, params as unknown[]);
    }) as TransactionSession["executeSql"],
  }));
  return transactionCapability(decorated).transaction(fn);
}

/** A typed outcome reduced to `{ outcome, category? }`; nothing else (no state, no cursor) is kept. */
function project(result: unknown): Record<string, unknown> {
  const value = (result ?? {}) as { outcome?: unknown; category?: unknown };
  return value.category === undefined ? { outcome: value.outcome } : { outcome: value.outcome, category: value.category };
}

type Page = { terminal: boolean; nextCursor: string | null; oldestTs: string | null };

/**
 * Accept one page in ONE transaction. For a typed `rejected` result, the caller's SAME-transaction
 * passed-turn release follows (§3.2). Any exception is reduced to its SQLSTATE and name, so an
 * intended RED is an assertion mismatch and nothing value-bearing prints.
 */
async function admit(
  claim: SlackChannelClaim, page: Page, recorder?: { loneSurrogateSent: boolean },
): Promise<Record<string, unknown>> {
  const run = async (session: TransactionSession) => {
    const accepted = await acceptSlackChannelPage(session, claim, page);
    const view = accepted as unknown as { outcome: string; category?: string };
    if (view.outcome === "rejected" && typeof view.category === "string") {
      const released = await releaseSlackChannelForRetry(session, claim, { errorCode: view.category, turn: "passed", nextDueAt: null });
      return { accept: project(accepted), release: released.outcome };
    }
    return { accept: project(accepted) };
  };
  try {
    return await (recorder ? recordingTx(recorder, run) : tx(run));
  } catch (error) {
    const e = (error ?? {}) as { code?: unknown; name?: unknown };
    return { threw: true, code: typeof e.code === "string" ? e.code : null, name: typeof e.name === "string" ? e.name : null };
  }
}

/** Seed a team, a Slack integration and ONE claimable channel whose historical lane holds `history`. */
async function seedChannel(history: string[]): Promise<{ scope: SlackChannelScope; integrationId: string }> {
  const seed = await seedTeam();
  const scope = { teamId: seed.teamId, workspaceId: WORKSPACE, channelId: CHANNEL };
  const integrationId = await tx(async (session) => (await session.executeSql<{ id: string }>(
    `insert into integrations (team_id, type, name) values ($1, 'slack', 'history-admission-binder') returning id::text as id`, [seed.teamId]
  )).rows[0].id);
  await tx(async (session) => {
    await session.executeSql(
      `insert into slack_sync_channels
         (team_id, workspace_id, channel_id, public_state, public_checked_at, binding_integration_id, binding_config_revision,
          newest_anchor_ts, newest_lower_ts, newest_request_lower_ts, newest_segment_lower_ts, newest_segment_upper_ts,
          newest_cursor, newest_cursor_history, newest_scan_generation,
          historical_anchor_ts, historical_segment_lower_ts, historical_segment_upper_ts,
          historical_cursor, historical_cursor_history, historical_scan_generation,
          next_lane, due_at)
       values ($1, $2, $3, 'public', '2026-01-01 00:00:00+00', $4::uuid, $5,
               $6, $7, $8, $9, $10, $11, $12::jsonb, $13,
               $14, '0.000000', $14, $15, $16::jsonb, 4,
               'historical', '2020-01-01 00:00:00+00')`,
      [seed.teamId, WORKSPACE, CHANNEL, integrationId, REVISION,
        NEWEST_FIXTURE.newest_anchor_ts, NEWEST_FIXTURE.newest_lower_ts, NEWEST_FIXTURE.newest_request_lower_ts,
        NEWEST_FIXTURE.newest_segment_lower_ts, NEWEST_FIXTURE.newest_segment_upper_ts,
        NEWEST_FIXTURE.newest_cursor, NEWEST_FIXTURE.newest_cursor_history, NEWEST_FIXTURE.newest_scan_generation,
        HISTORICAL_ANCHOR, history.length > 0 ? history[history.length - 1] : null, JSON.stringify(history)]
    );
  });
  return { scope, integrationId };
}
async function claimHistorical(scope: SlackChannelScope, integrationId: string): Promise<SlackChannelClaim> {
  const claim = await tx((session) => claimSlackChannelPage(session, scope, { bindingIntegrationId: integrationId, bindingConfigRevision: REVISION }));
  expect({ claimed: claim !== null, lane: claim?.lane, generation: claim?.scanGeneration }, "fixture: the historical lane is claimed at generation 4").toEqual({
    claimed: true, lane: "historical", generation: 4,
  });
  return claim as SlackChannelClaim;
}
/** The row digested without the named columns (md5 only). */
async function rowDigestExcept(scope: SlackChannelScope, excluded: string[]): Promise<string> {
  return tx(async (session) => (await session.executeSql<{ digest: string }>(
    `select pg_catalog.md5((pg_catalog.to_jsonb(s) - $4::text[])::text) as digest
       from slack_sync_channels s where team_id = $1 and workspace_id = $2 and channel_id = $3`,
    [scope.teamId, scope.workspaceId, scope.channelId, excluded]
  )).rows[0].digest);
}
/** Boolean facts about the stored historical lane against literal expectations; values never print. */
async function historicalFacts(scope: SlackChannelScope, cursor: string | null, history: string[]) {
  return tx(async (session) => (await session.executeSql<Record<string, unknown>>(
    `select historical_cursor is not distinct from $4 as cursor_is_expected,
            historical_cursor_history = $5::jsonb as history_is_expected,
            pg_catalog.jsonb_array_length(historical_cursor_history)::int as entries,
            historical_scan_generation::int as generation,
            newest_cursor_history = $6::jsonb and newest_cursor = $7 as newest_lane_unchanged
       from slack_sync_channels where team_id = $1 and workspace_id = $2 and channel_id = $3`,
    [scope.teamId, scope.workspaceId, scope.channelId, cursor, JSON.stringify(history),
      NEWEST_FIXTURE.newest_cursor_history, NEWEST_FIXTURE.newest_cursor]
  )).rows[0]);
}
async function storedHistoricalSize(scope: SlackChannelScope) {
  return tx(async (session) => (await session.executeSql<{ entries: number; bytes: number }>(
    `select pg_catalog.jsonb_array_length(historical_cursor_history)::int as entries,
            pg_catalog.octet_length(historical_cursor_history::text)::int as bytes
       from slack_sync_channels where team_id = $1 and workspace_id = $2 and channel_id = $3`,
    [scope.teamId, scope.workspaceId, scope.channelId]
  )).rows[0]);
}

/** Columns a PARTIAL acceptance may change; every other column must be byte-identical. */
const PARTIAL_PERMITTED = [
  "historical_cursor", "historical_cursor_history", "historical_oldest_seen_ts",
  "next_lane", "claimed_lane", "lease_owner", "lease_expires_at", "last_error_code", "last_read_at", "due_at", "updated_at",
];
/** Columns the §3.2 passed-turn release may change after a true rejection; nothing else may move. */
const RELEASE_PERMITTED = ["next_lane", "claimed_lane", "lease_owner", "lease_expires_at", "due_at", "last_error_code", "updated_at"];

/** 1,000 distinct short entries: the ENTRY cap, far below the byte cap. */
const entryCapHistory = (): string[] => Array.from({ length: 1000 }, (_, i) => `cap${String(i).padStart(3, "0")}`);
/**
 * A maximum accepted history: 1,000 distinct entries at EXACTLY 1,048,576 serialized bytes (4-byte
 * id plus U+4E00 padding; 576 × 1,045 + 424 × 1,044 bytes, plus brackets, quotes and separators).
 */
function byteCapHistory(): string[] {
  const pad = String.fromCodePoint(0x4e00);
  return Array.from({ length: 1000 }, (_, i) => {
    const id = `b${String(i).padStart(3, "0")}`;
    return i < 576 ? id + pad.repeat(347) : `${id}${pad.repeat(346)}aa`;
  });
}
/** 999 entries of 1,045 bytes: 1,047,951 serialized bytes, so a 700-byte cursor overflows ONLY the byte cap. */
function nearByteCapHistory(): string[] {
  const pad = String.fromCodePoint(0x4e00);
  return Array.from({ length: 999 }, (_, i) => `n${String(i).padStart(3, "0")}${pad.repeat(347)}`);
}

describe("AM-F2 runtime packet 1 — state-writer history admission (real Postgres)", () => {
  beforeAll(async () => {
    // 1. The shared guard FIRST: only the isolated local runner or CI's service. The error never
    //    prints the URL, and nothing below runs unless the URL is accepted.
    const guardedUrl = requireIsolatedTestUrl(process.env.DATABASE_TEST_URL);
    // 2. Empty the ONE table the upgrade block validates, so a previous suite's leftover rows (setup.ts
    //    truncates before each TEST, not before this hook) cannot decide the upgrade.
    const client = new Client({ connectionString: guardedUrl });
    await client.connect();
    try {
      await client.query("truncate table public.slack_sync_channels");
    } finally {
      await client.end().catch(() => {});
    }
    // 3. Bring the tier database to the CURRENT F2/DH schema with the REAL deploy loader, exactly as
    //    `slack-method-budget` does. It runs schema.sql, whose byte-identical marked block upgrades
    //    `slack_sync_channels`, then every migration. Replay is idempotent, and it runs against the
    //    GUARDED url only. Its notices print to stdout and are not asserted.
    await loadSchema({ cwd: process.cwd(), databaseUrl: guardedUrl, logger: { log: () => {} } });
  }, 300_000);

  it("F2-01 a partial continuation APPENDS the exact decoded cursor after the lane's prior entries; the other lane and unrelated state stay exact", async () => {
    const { scope, integrationId } = await seedChannel(["syn-h-1", "syn-h-2"]);
    const claim = await claimHistorical(scope, integrationId);
    const before = await rowDigestExcept(scope, PARTIAL_PERMITTED);
    const outcome = await admit(claim, { terminal: false, nextCursor: "syn-h-3", oldestTs: "1718900400.000000" });
    expect({
      outcome,
      facts: await historicalFacts(scope, "syn-h-3", ["syn-h-1", "syn-h-2", "syn-h-3"]),
      unrelatedUnchanged: (await rowDigestExcept(scope, PARTIAL_PERMITTED)) === before,
    }, "the cursor is appended (not replaced) as H's final element; nothing outside the permitted partial fields moves").toEqual({
      outcome: { accept: { outcome: "written" } },
      facts: { cursor_is_expected: true, history_is_expected: true, entries: 3, generation: 4, newest_lane_unchanged: true },
      unrelatedUnchanged: true,
    });
  });

  it("F2-02 an exact repetition is rejected as cursor_repeated, and the same-transaction passed-turn release is the only change", async () => {
    const { scope, integrationId } = await seedChannel(["syn-h-1", "syn-h-2"]);
    const claim = await claimHistorical(scope, integrationId);
    const before = await rowDigestExcept(scope, RELEASE_PERMITTED);
    const outcome = await admit(claim, { terminal: false, nextCursor: "syn-h-1", oldestTs: "1718900400.000000" });
    const bookkeeping = await tx(async (session) => (await session.executeSql<Record<string, unknown>>(
      `select next_lane, claimed_lane, lease_owner is null as lease_cleared, last_error_code
         from slack_sync_channels where team_id = $1 and workspace_id = $2 and channel_id = $3`,
      [scope.teamId, scope.workspaceId, scope.channelId]
    )).rows[0]);
    expect({
      outcome, bookkeeping,
      facts: await historicalFacts(scope, "syn-h-2", ["syn-h-1", "syn-h-2"]),
      onlyReleaseFieldsMoved: (await rowDigestExcept(scope, RELEASE_PERMITTED)) === before,
    }, "typed cursor_repeated; no history, cursor, generation, progress or certification change; the turn passes").toEqual({
      outcome: { accept: { outcome: "rejected", category: "cursor_repeated" }, release: "written" },
      bookkeeping: { next_lane: "newest", claimed_lane: null, lease_cleared: true, last_error_code: "cursor_repeated" },
      facts: { cursor_is_expected: true, history_is_expected: true, entries: 2, generation: 4, newest_lane_unchanged: true },
      onlyReleaseFieldsMoved: true,
    });
  });

  it("F2-02 repetition AT the entry cap is still cursor_repeated (repetition precedes capacity)", async () => {
    const history = entryCapHistory();
    const { scope, integrationId } = await seedChannel(history);
    expect((await storedHistoricalSize(scope)).entries, "fixture: the historical lane is at the 1,000-entry cap").toBe(1000);
    const claim = await claimHistorical(scope, integrationId);
    const before = await rowDigestExcept(scope, RELEASE_PERMITTED);
    const outcome = await admit(claim, { terminal: false, nextCursor: history[500], oldestTs: "1718900400.000000" });
    expect({ outcome, onlyReleaseFieldsMoved: (await rowDigestExcept(scope, RELEASE_PERMITTED)) === before },
      "a repeated cursor at the cap is repetition, not entry overflow").toEqual({
      outcome: { accept: { outcome: "rejected", category: "cursor_repeated" }, release: "written" }, onlyReleaseFieldsMoved: true,
    });
  });

  it.each([
    { label: "ENTRY overflow (1,000 short entries + one new cursor)", history: entryCapHistory, cursor: "cap-new", category: "cursor_history_entries_exceeded" },
    { label: "BYTE overflow only (999 entries near the byte cap + a 700-byte cursor)", history: nearByteCapHistory, cursor: "z".repeat(700), category: "cursor_history_bytes_exceeded" },
    { label: "BOTH caps (a maximum history + one new cursor) is entries", history: byteCapHistory, cursor: "both-new", category: "cursor_history_entries_exceeded" },
  ])("F2-03/04 $label is the typed $category, computed on the actual candidate, with only the release moving", async ({ history, cursor, category }) => {
    const { scope, integrationId } = await seedChannel(history());
    const size = await storedHistoricalSize(scope);
    expect(size.entries <= 1000 && size.bytes <= 1048576, "fixture: the stored history is within both caps").toBe(true);
    const claim = await claimHistorical(scope, integrationId);
    const before = await rowDigestExcept(scope, RELEASE_PERMITTED);
    const outcome = await admit(claim, { terminal: false, nextCursor: cursor, oldestTs: "1718900400.000000" });
    expect({ outcome, onlyReleaseFieldsMoved: (await rowDigestExcept(scope, RELEASE_PERMITTED)) === before, after: await storedHistoricalSize(scope) },
      `typed ${category}; the stored history is untouched`).toEqual({
      outcome: { accept: { outcome: "rejected", category }, release: "written" }, onlyReleaseFieldsMoved: true, after: size,
    });
  });

  it.each([
    { label: "the exact entry cap", history: entryCapHistory, entries: 1000 },
    { label: "the exact byte cap (1,048,576 bytes)", history: byteCapHistory, entries: 1000 },
  ])("F2-03/04 a TERMINAL page at $label is written: it appends no cursor", async ({ history, entries }) => {
    const { scope, integrationId } = await seedChannel(history());
    expect((await storedHistoricalSize(scope)).entries, "fixture: the lane is at its cap").toBe(entries);
    const claim = await claimHistorical(scope, integrationId);
    const outcome = await admit(claim, { terminal: true, nextCursor: null, oldestTs: "1718900100.000000" });
    const facts = await historicalFacts(scope, null, []);
    expect({ outcome, cursorCleared: facts.cursor_is_expected, historyCleared: facts.history_is_expected, newestUnchanged: facts.newest_lane_unchanged },
      "a terminal page at a cap is admitted: C is cleared and H is empty, as linkage requires").toEqual({
      outcome: { accept: { outcome: "written" } }, cursorCleared: true, historyCleared: true, newestUnchanged: true,
    });
  });

  it("F2-05 a lone surrogate is cursor_unrepresentable, and the raw value is NEVER sent to SQL", async () => {
    const { scope, integrationId } = await seedChannel(["syn-h-1", "syn-h-2"]);
    const claim = await claimHistorical(scope, integrationId);
    const before = await rowDigestExcept(scope, RELEASE_PERMITTED);
    const recorder = { loneSurrogateSent: false };
    const lone = `syn-lone-${String.fromCharCode(0xd800)}-x`;
    const outcome = await admit(claim, { terminal: false, nextCursor: lone, oldestTs: "1718900400.000000" }, recorder);
    expect({
      outcome, loneSurrogateSentToSql: recorder.loneSurrogateSent,
      onlyReleaseFieldsMoved: (await rowDigestExcept(scope, RELEASE_PERMITTED)) === before,
    }, "typed cursor_unrepresentable before any SQL parameter carries the raw cursor").toEqual({
      outcome: { accept: { outcome: "rejected", category: "cursor_unrepresentable" }, release: "written" },
      loneSurrogateSentToSql: false, onlyReleaseFieldsMoved: true,
    });
  });

  it.each([
    { label: "a valid surrogate pair", cursor: `syn-pair-${String.fromCodePoint(0x1f600)}-x` },
    { label: "a literal U+FFFD", cursor: `syn-fffd-${String.fromCodePoint(0xfffd)}-x` },
  ])("F2-05 positive control: $label is representable and appended EXACTLY", async ({ cursor }) => {
    const { scope, integrationId } = await seedChannel(["syn-h-1"]);
    const claim = await claimHistorical(scope, integrationId);
    const outcome = await admit(claim, { terminal: false, nextCursor: cursor, oldestTs: "1718900400.000000" });
    expect({ outcome, facts: await historicalFacts(scope, cursor, ["syn-h-1", cursor]) }, "written, and the exact UTF-16 string is H's final element").toEqual({
      outcome: { accept: { outcome: "written" } },
      facts: { cursor_is_expected: true, history_is_expected: true, entries: 2, generation: 4, newest_lane_unchanged: true },
    });
  });

  it.each([
    { label: "an expired lease", sql: "update slack_sync_channels set lease_expires_at = clock_timestamp() - interval '1 second' where team_id = $1" },
    { label: "a changed binding revision", sql: `update slack_sync_channels set binding_config_revision = '${OTHER_REVISION}' where team_id = $1` },
    { label: "a revoked public proof", sql: "update slack_sync_channels set public_state = 'private' where team_id = $1" },
    { label: "moved segment bounds under the same generation", sql: "update slack_sync_channels set historical_segment_upper_ts = '1718900400.000000' where team_id = $1" },
  ])("F2-06 stale authority — $label — beats cursor classification: refused, and the row is byte-identical", async ({ sql }) => {
    const { scope, integrationId } = await seedChannel(["syn-h-1", "syn-h-2"]);
    const claim = await claimHistorical(scope, integrationId);
    await tx((session) => session.executeSql(sql, [scope.teamId]));
    const before = await rowDigestExcept(scope, []);
    // A REPEATED cursor: were the fence not first, this would classify as cursor_repeated.
    const outcome = await admit(claim, { terminal: false, nextCursor: "syn-h-1", oldestTs: "1718900400.000000" });
    expect({ outcome, rowUnchanged: (await rowDigestExcept(scope, [])) === before }, "stale authority is refused before any cursor category").toEqual({
      outcome: { accept: { outcome: "refused" } }, rowUnchanged: true,
    });
  });

  it("§3.1 histories never leave SQL: no older history entry appears in a claim, an ensured or due state, or a written state", async () => {
    const { scope, integrationId } = await seedChannel(["syn-h-older", "syn-h-2"]);
    const claim = await claimHistorical(scope, integrationId);
    const ensured = await tx((session) => ensureSlackChannel(session, scope));
    const due = await tx((session) => dueSlackChannels(session, { teamId: scope.teamId, workspaceId: WORKSPACE, channelIds: [CHANNEL] }));
    const released = await tx((session) => releaseSlackChannelForRetry(session, claim, { errorCode: "boundary_probe", turn: "kept", nextDueAt: null }));
    const leaks = (value: unknown): { historyKey: boolean; olderEntry: boolean } => {
      const text = JSON.stringify(value);
      return { historyKey: /history/i.test(text), olderEntry: text.includes("syn-h-older") };
    };
    expect({
      stored: (await storedHistoricalSize(scope)).entries,
      claim: leaks(claim), ensured: leaks(ensured), due: leaks(due), released: { outcome: released.outcome, ...leaks(released) },
    }, "H exists in SQL (2 entries) and appears in NO returned projection").toEqual({
      stored: 2,
      claim: { historyKey: false, olderEntry: false }, ensured: { historyKey: false, olderEntry: false },
      due: { historyKey: false, olderEntry: false }, released: { outcome: "written", historyKey: false, olderEntry: false },
    });
  });

  it("§3.1 the shared STATE_COLUMNS projection selects no cursor-history column (source boundary)", () => {
    const source = readFileSync(join(process.cwd(), "lib", "ingest", "slack-channel-state.ts"), "utf8");
    const start = source.indexOf("const STATE_COLUMNS = `");
    const end = source.indexOf("`;", start);
    const projection = start >= 0 && end > start ? source.slice(start, end) : "";
    expect({ found: projection.includes("newest_cursor") && projection.includes("historical_cursor"), selectsHistory: projection.includes("cursor_history") },
      "STATE_COLUMNS is located and selects the cursors but neither history").toEqual({ found: true, selectsHistory: false });
  });
});
