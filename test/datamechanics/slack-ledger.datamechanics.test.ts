import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { SlackMessage } from "@/lib/ingest/sources/slack";
import {
  projectSlackMessageEvidence,
  type SlackEvidenceReason,
  type SlackMessageEvidence,
} from "@/lib/ingest/sources/slack-message-evidence";
import { ingest, seedTeam, type Seed } from "./helpers";

/**
 * AIO-1170 — the Slack source-message ledger (`slack_messages`) and the per-team Slack cache
 * generations (`slack_team_state`), against real Postgres.
 *
 * NOTHING WRITES THESE TABLES YET. That is exactly why these tests exist now: every invariant the
 * publisher and the read legs will lean on is a property of the SCHEMA, and this is the only tier
 * that can observe it — a check constraint, a composite foreign key and microsecond storage are all
 * invisible to the in-memory fake. What is pinned here:
 *
 *  1. message identity is the SOURCE's `(team, workspace, channel, ts)`, and the same channel/ts in
 *     another workspace or another AIOS team is a DIFFERENT message, not a duplicate;
 *  2. the instant survives at Slack's microsecond precision (the current normalizer's
 *     `parseFloat(ts) * 1000` does not — there is a negative control below that shows it collapsing);
 *  3. the eligible/reason codec cannot hold an impossible pair, and an unparseable timestamp is
 *     never given an invented instant — nor a parseable one silently dropped;
 *  4. a ledger row cannot point at another team's item, and cascades follow the item and the team;
 *  5. generations default to 0 and move per team;
 *  6. the DDL is repeatable: an UPGRADE onto a populated pre-AIO-1170 database and a REPLAY onto a
 *     populated ledger both preserve every existing row.
 *
 * The evidence rows are produced by the accepted pure projection
 * (`lib/ingest/sources/slack-message-evidence`) rather than hand-written, so these assertions are
 * about states the source can actually reach. The small `toLedgerRow` codec below is TEST PLUMBING
 * standing in for the publisher that has not been built yet; when it is, it must map
 * `status`/`reason` exactly this way, and the DB constraints here are what will refuse it if it
 * does not.
 */

const WORKSPACE = "T0AIO1170";
const OTHER_WORKSPACE = "T0OTHERWS";
const CHANNEL = "C0LEDGER";
const HUMAN = "UHUMAN1";
const BOT = "UBOT1";
const STRANGER = "USTRANGER";

/** A fixed request instant: the projection has no ambient clock and neither do these tests. */
const NOW = new Date("2024-06-20T18:00:00.000Z");
const NOW_SECONDS = Math.floor(NOW.getTime() / 1000);

/** Every reason the accepted projection can emit. Asserted as a SET below, not sampled. */
const ALL_REASONS: readonly SlackEvidenceReason[] = [
  "invalid_timestamp",
  "no_author",
  "bot_message",
  "tombstone",
  "unsupported_subtype",
  "no_text",
  "bot_identity",
  "author_unclassified",
  "future_timestamp",
];

const DIRECTORY = {
  // The directory STATED both flags false — that is what makes a message creditable. A record
  // carrying only a display name is "unclassified", which is a different (and non-creditable) state.
  [HUMAN]: { displayName: "Alex", isBot: false, isAppUser: false },
  [BOT]: { displayName: "Deploybot", isBot: true, isAppUser: true },
};

function ts(seconds: number, micros = 0): string {
  return `${seconds}.${String(micros).padStart(6, "0")}`;
}

// ── raw SQL client ───────────────────────────────────────────────────────────
// The tier's adapter reports `{ error: { message } }` with no SQLSTATE, and every rejection below is
// about WHICH rule refused — so these go through `pg` directly, on the same database.

let raw: Client | null = null;

async function sql(): Promise<Client> {
  if (!raw) {
    raw = new Client({ connectionString: process.env.DATABASE_URL });
    await raw.connect();
    // So `at time zone 'utc'` readbacks and any implicit rendering are unambiguous.
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
    `select tablename from pg_tables where schemaname = 'public' and tablename = any($1)`,
    [["slack_messages", "slack_team_state"]]
  );
  if (rows.length !== 2) {
    // A reused per-worktree container is only schema-loaded when it is CREATED
    // (scripts/dm-isolated.sh), so one that predates this change silently lacks the tables. Say
    // exactly that instead of reddening with "relation does not exist" in every case.
    throw new Error(
      `slack_messages/slack_team_state missing from the test database (found: ${rows
        .map((r) => r.tablename)
        .join(", ") || "neither"}). The dm container loads the schema only when it is created — ` +
        `re-run with AIOS_DM_RESET=1 npm run test:datamechanics:iso test/datamechanics/slack-ledger.datamechanics.test.ts`
    );
  }
});

// ── fixtures ─────────────────────────────────────────────────────────────────

type LedgerRow = Record<string, unknown>;

/** The test-side codec: projection status/reason → the two stored columns. */
function toLedgerRow(e: SlackMessageEvidence, teamId: string, itemId: string): LedgerRow {
  return {
    team_id: teamId,
    workspace_id: e.workspaceId,
    channel_id: e.channelId,
    message_ts: e.messageTs,
    root_ts: e.rootTs,
    item_id: itemId,
    author_external_id: e.authorExternalId,
    occurred_at: e.occurredAt,
    is_root: e.isRoot,
    eligible: e.status === "eligible",
    exclusion_reason: e.reason,
    source_hash: e.sourceHash,
  };
}

async function insertRow(row: LedgerRow): Promise<string> {
  const cols = Object.keys(row);
  const c = await sql();
  const { rows } = await c.query<{ id: string }>(
    `insert into slack_messages (${cols.join(", ")}) values (${cols
      .map((_, i) => `$${i + 1}`)
      .join(", ")}) returning id`,
    cols.map((k) => row[k])
  );
  return rows[0].id;
}

function project(messages: readonly SlackMessage[], workspaceId = WORKSPACE) {
  return projectSlackMessageEvidence(messages, {
    scope: { workspaceId, channelId: CHANNEL },
    now: NOW,
    users: DIRECTORY,
  });
}

/** One eligible message, projected — the baseline every single-field rejection below deviates from. */
function eligibleRow(teamId: string, itemId: string, messageTs = ts(1718900000, 100)): LedgerRow {
  const { messages } = project([{ ts: messageTs, user: HUMAN, text: "shipped the ledger" }]);
  expect(messages).toHaveLength(1);
  expect(messages[0].status).toBe("eligible");
  return toLedgerRow(messages[0], teamId, itemId);
}

async function seedItem(seed: Seed, path: string): Promise<string> {
  const res = await ingest(seed, { path, body: `body for ${path}`, access: "team" });
  return res.id;
}

/** SQLSTATE plus the constraint that refused — WHICH rule fired is most of what is being tested. */
async function refusal(p: Promise<unknown>): Promise<{ code: string; constraint?: string }> {
  try {
    await p;
  } catch (err) {
    const e = err as { code?: string; constraint?: string };
    return { code: e.code ?? `no-code: ${String(err)}`, constraint: e.constraint };
  }
  return { code: "no-error" };
}

async function errCode(p: Promise<unknown>): Promise<string> {
  return (await refusal(p)).code;
}

/**
 * Re-key a row onto a different message, moving `root_ts` with it.
 *
 * Not a convenience: `is_root` is constrained to agree with `message_ts = root_ts`, so changing
 * only the message id would make EVERY fixture below trip that rule as well as the one it is aiming
 * at — and each rejection would then prove nothing about its own constraint.
 */
function withTs(row: LedgerRow, messageTs: string): LedgerRow {
  return { ...row, message_ts: messageTs, root_ts: messageTs };
}

// ── message identity ─────────────────────────────────────────────────────────

describe("slack_messages — message identity is the source's", () => {
  it("refuses a second row for the same (team, workspace, channel, message_ts)", async () => {
    const seed = await seedTeam();
    const itemId = await seedItem(seed, "slack/T0AIO1170/C0LEDGER/1718900000.000100.md");
    const row = eligibleRow(seed.teamId, itemId);

    await insertRow(row); // positive control: the baseline itself is accepted
    // A re-read of the same page must fold into the existing row, never create a second one. Note
    // the SECOND observation differs in a non-key column — an overlapping page that saw a later
    // edit — so this pins the KEY, not row equality.
    expect(await errCode(insertRow({ ...row, source_hash: "b".repeat(64) }))).toBe("23505");

    const c = await sql();
    const { rows } = await c.query(`select source_hash from slack_messages where team_id = $1`, [
      seed.teamId,
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0].source_hash).toBe(row.source_hash); // the first row stands; nothing was clobbered
  });

  it("keeps the same channel/ts apart across workspaces and across AIOS teams", async () => {
    const a = await seedTeam();
    const b = await seedTeam();
    const itemA = await seedItem(a, "slack/T0AIO1170/C0LEDGER/1718900000.000100.md");
    const itemB = await seedItem(b, "slack/T0AIO1170/C0LEDGER/1718900000.000100.md");
    const messageTs = ts(1718900000, 100);

    // Same channel id AND same ts, three times over — Slack channel ids are not unique across
    // installations, and AIOS team is a further namespace above workspace. All three are distinct
    // messages, and a schema that keyed on (channel, ts) alone would merge them.
    await insertRow(eligibleRow(a.teamId, itemA, messageTs));
    const otherWs = project(
      [{ ts: messageTs, user: HUMAN, text: "same ts, other workspace" }],
      OTHER_WORKSPACE
    ).messages[0];
    await insertRow(toLedgerRow(otherWs, a.teamId, itemA));
    await insertRow(eligibleRow(b.teamId, itemB, messageTs));

    const c = await sql();
    const { rows: aRows } = await c.query<{ workspace_id: string }>(
      `select workspace_id from slack_messages where team_id = $1`,
      [a.teamId]
    );
    expect(aRows).toHaveLength(2);
    expect(new Set(aRows.map((r) => r.workspace_id))).toEqual(
      new Set([WORKSPACE, OTHER_WORKSPACE])
    );
    // The inverse: team B sees ONLY its own row, so the two teams' identical keys did not merge.
    const { rows: bRows } = await c.query(`select id from slack_messages where team_id = $1`, [
      b.teamId,
    ]);
    expect(bRows).toHaveLength(1);
  });
});

// ── the instant ──────────────────────────────────────────────────────────────

describe("slack_messages — the source instant", () => {
  it("stores two messages one microsecond apart as two distinct instants", async () => {
    const seed = await seedTeam();
    const itemId = await seedItem(seed, "slack/T0AIO1170/C0LEDGER/1718900000.000100.md");
    const earlier = ts(1718900000, 100);
    const later = ts(1718900000, 101);

    // NEGATIVE CONTROL. The conversion this ledger exists to replace erases the difference these
    // assertions are about; if it did not, they would be measuring nothing.
    expect(new Date(parseFloat(earlier) * 1000).toISOString()).toBe(
      new Date(parseFloat(later) * 1000).toISOString()
    );

    const { messages } = project([
      { ts: earlier, user: HUMAN, text: "first" },
      { ts: later, user: HUMAN, text: "second" },
    ]);
    for (const m of messages) await insertRow(toLedgerRow(m, seed.teamId, itemId));

    const c = await sql();
    const { rows } = await c.query<{ exact: string }>(
      `select to_char(occurred_at at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.US') as exact
         from slack_messages where team_id = $1 order by occurred_at`,
      [seed.teamId]
    );
    expect(rows.map((r) => r.exact)).toEqual([
      "2024-06-20T16:13:20.000100",
      "2024-06-20T16:13:20.000101",
    ]);
    const { rows: distinct } = await c.query<{ c: string }>(
      `select count(distinct occurred_at)::text as c from slack_messages where team_id = $1`,
      [seed.teamId]
    );
    expect(distinct[0].c).toBe("2");
  });

  it("refuses to invent an instant for an unparseable ts, and to drop one that parsed", async () => {
    const seed = await seedTeam();
    const itemId = await seedItem(seed, "slack/T0AIO1170/C0LEDGER/1718900000.000100.md");

    // The real projection's own output for a present-but-unparseable ts: excluded, no instant.
    const invalid = project([{ ts: "not-a-timestamp", user: HUMAN, text: "weird" }]).messages[0];
    expect(invalid.reason).toBe("invalid_timestamp");
    expect(invalid.occurredAt).toBeNull();
    const invalidRow = toLedgerRow(invalid, seed.teamId, itemId);
    await insertRow(invalidRow); // positive control

    // …and the row may not acquire one afterwards, from an ingest clock or anywhere else.
    expect(
      await refusal(
        insertRow({ ...withTs(invalidRow, "also-not-a-timestamp"), occurred_at: NOW.toISOString() })
      )
    ).toMatchObject({ code: "23514", constraint: "slack_messages_instant_truth" });

    // The other direction, which is the one an "invalid rows have no timestamp" rule alone misses:
    // a message that DID parse may not be stored without its instant.
    const good = eligibleRow(seed.teamId, itemId);
    expect(await refusal(insertRow({ ...good, occurred_at: null }))).toMatchObject({
      code: "23514",
      constraint: "slack_messages_instant_truth",
    });
    // …including when it is excluded for some OTHER reason.
    const noText = project([{ ts: ts(1718900001), user: HUMAN, text: "   " }]).messages[0];
    expect(noText.reason).toBe("no_text");
    const noTextRow = toLedgerRow(noText, seed.teamId, itemId);
    await insertRow(noTextRow); // positive control: it is accepted WITH its instant
    expect(
      await refusal(insertRow({ ...withTs(noTextRow, ts(1718900002)), occurred_at: null }))
    ).toMatchObject({ code: "23514", constraint: "slack_messages_instant_truth" });
  });
});

// ── the eligible/reason codec ────────────────────────────────────────────────

describe("slack_messages — the three-state codec", () => {
  it("persists every state the accepted projection can produce", async () => {
    const seed = await seedTeam();
    const itemId = await seedItem(seed, "slack/T0AIO1170/C0LEDGER/1718900000.000100.md");

    // One batch reaching all nine exclusion/unresolved reasons plus the eligible state. Driven
    // through the real classifier, so this is what the source can actually produce — not a
    // paraphrase of the constraint's own value list.
    const batch: SlackMessage[] = [
      { ts: ts(1718900000, 1), user: HUMAN, text: "eligible" },
      { ts: ts(NOW_SECONDS + 86_400), user: HUMAN, text: "clock skew" }, // future_timestamp
      { ts: ts(1718900000, 3), user: STRANGER, text: "who?" }, // author_unclassified
      { ts: ts(1718900000, 4), user: BOT, text: "beep" }, // bot_identity
      { ts: ts(1718900000, 5), user: HUMAN, text: "   " }, // no_text
      { ts: ts(1718900000, 6), user: HUMAN, text: "caption", subtype: "file_share" }, // unsupported_subtype
      { ts: ts(1718900000, 7), user: HUMAN, text: "gone", subtype: "tombstone" }, // tombstone
      { ts: ts(1718900000, 8), user: HUMAN, text: "deployed", subtype: "bot_message" }, // bot_message
      { ts: ts(1718900000, 9), text: "orphan" }, // no_author
      { ts: "not-a-timestamp", user: HUMAN, text: "unplaceable" }, // invalid_timestamp
    ];
    const { messages } = project(batch);
    expect(messages).toHaveLength(batch.length);
    expect(new Set(messages.map((m) => m.reason).filter(Boolean))).toEqual(new Set(ALL_REASONS));

    for (const m of messages) await insertRow(toLedgerRow(m, seed.teamId, itemId));

    const c = await sql();
    const { rows } = await c.query<{
      message_ts: string;
      eligible: boolean;
      exclusion_reason: string | null;
    }>(
      `select message_ts, eligible, exclusion_reason from slack_messages where team_id = $1`,
      [seed.teamId]
    );
    const stored = new Map(rows.map((r) => [r.message_ts, r]));
    expect(stored.size).toBe(messages.length);
    for (const m of messages) {
      const row = stored.get(m.messageTs);
      expect(row, `no stored row for ${m.messageTs}`).toBeTruthy();
      // Round-trip: the three states survive as the two columns and can be read back apart.
      expect(row!.eligible, m.messageTs).toBe(m.status === "eligible");
      expect(row!.exclusion_reason, m.messageTs).toBe(m.reason);
    }
  });

  it("refuses the pairs the projection can never produce", async () => {
    const seed = await seedTeam();
    const itemId = await seedItem(seed, "slack/T0AIO1170/C0LEDGER/1718900000.000100.md");
    const base = eligibleRow(seed.teamId, itemId);
    await insertRow(base); // positive control

    const cases: { name: string; over: LedgerRow; constraint: string }[] = [
      // Credit AND a reason not to credit: the state the two-column encoding must not be able to hold.
      {
        name: "eligible with a reason",
        over: { eligible: true, exclusion_reason: "no_text" },
        constraint: "slack_messages_reason_codec",
      },
      // The silent-omission direction: not credited, and no record of why.
      {
        name: "not eligible with no reason",
        over: { eligible: false, exclusion_reason: null },
        constraint: "slack_messages_reason_codec",
      },
      // A reason outside the taxonomy the projection emits — a typo or a private extension would
      // otherwise persist and read as an unknown exclusion forever.
      {
        name: "unknown reason",
        over: { eligible: false, exclusion_reason: "not_a_real_reason" },
        constraint: "slack_messages_reason_taxonomy",
      },
      // Credit needs somebody to credit.
      {
        name: "eligible with no author",
        over: { author_external_id: null },
        constraint: "slack_messages_eligible_has_author",
      },
      // Root-ness is derived from the two timestamps, not asserted next to them.
      {
        name: "root flag disagreeing with root_ts",
        over: { is_root: false },
        constraint: "slack_messages_root_ts_agrees",
      },
      {
        name: "non-root flagged as root",
        over: { root_ts: ts(1718899000), is_root: true },
        constraint: "slack_messages_root_ts_agrees",
      },
    ];
    for (const [i, { name, over, constraint }] of cases.entries()) {
      // Each case differs from the ACCEPTED baseline in exactly one respect AND names the rule it
      // expects to fire, so a fixture that trips a second constraint cannot pass as this one.
      const attempt = { ...withTs(base, ts(1718900500 + i, 0)), ...over };
      expect(await refusal(insertRow(attempt)), name).toMatchObject({ code: "23514", constraint });
    }
  });
});

// ── team consistency and cascades ────────────────────────────────────────────

describe("slack_messages — team-consistent item binding", () => {
  it("refuses a row whose team does not own the item it points at", async () => {
    const a = await seedTeam();
    const b = await seedTeam();
    const itemA = await seedItem(a, "slack/T0AIO1170/C0LEDGER/1718900000.000100.md");

    await insertRow(eligibleRow(a.teamId, itemA)); // positive control: A's own item is fine
    // Team B, team A's item. A single-column FK to items(id) would accept this and quietly bind
    // another team's evidence to it; there is no RLS backstop underneath.
    expect(await errCode(insertRow(eligibleRow(b.teamId, itemA)))).toBe("23503");
    // A team that owns no such item at all is the same refusal.
    expect(await errCode(insertRow(eligibleRow(b.teamId, randomUUID())))).toBe("23503");
  });

  it("cascades with the item, and leaves the item's siblings alone", async () => {
    const seed = await seedTeam();
    const first = await seedItem(seed, "slack/T0AIO1170/C0LEDGER/1718900000.000100.md");
    const second = await seedItem(seed, "slack/T0AIO1170/C0LEDGER/1718900500.000100.md");
    await insertRow(eligibleRow(seed.teamId, first, ts(1718900000, 100)));
    await insertRow(eligibleRow(seed.teamId, second, ts(1718900500, 100)));

    const c = await sql();
    await c.query(`delete from items where id = $1`, [first]);

    const { rows } = await c.query<{ item_id: string }>(
      `select item_id from slack_messages where team_id = $1`,
      [seed.teamId]
    );
    // The purged thread's evidence goes with it; the other thread's is untouched — the half a
    // cascade test that only counts "fewer rows now" cannot tell apart.
    expect(rows.map((r) => r.item_id)).toEqual([second]);
  });

  it("cascades with the team, and leaves another team's ledger and state alone", async () => {
    const a = await seedTeam();
    const b = await seedTeam();
    const itemA = await seedItem(a, "slack/T0AIO1170/C0LEDGER/1718900000.000100.md");
    const itemB = await seedItem(b, "slack/T0AIO1170/C0LEDGER/1718900000.000100.md");
    await insertRow(eligibleRow(a.teamId, itemA));
    await insertRow(eligibleRow(b.teamId, itemB));

    const c = await sql();
    await c.query(
      `insert into slack_team_state (team_id, data_generation) values ($1, 4), ($2, 9)`,
      [a.teamId, b.teamId]
    );
    await c.query(`delete from teams where id = $1`, [a.teamId]);

    const { rows: msgs } = await c.query<{ team_id: string }>(`select team_id from slack_messages`);
    expect(msgs.map((r) => r.team_id)).toEqual([b.teamId]);
    const { rows: state } = await c.query<{ team_id: string; data_generation: string }>(
      `select team_id, data_generation::text from slack_team_state`
    );
    expect(state).toEqual([{ team_id: b.teamId, data_generation: "9" }]);
  });
});

// ── generations ──────────────────────────────────────────────────────────────

describe("slack_team_state — generations", () => {
  it("defaults both generations to 0 and moves them independently, per team", async () => {
    const a = await seedTeam();
    const b = await seedTeam();
    const c = await sql();

    // The default is SCHEMA-owned: a publisher that inserts the row without naming the counters
    // must get 0, because "absent row" and "generation 0" have to mean the same thing.
    await c.query(`insert into slack_team_state (team_id) values ($1), ($2)`, [a.teamId, b.teamId]);
    const read = async (teamId: string) => {
      const { rows } = await c.query<{ d: string; i: string }>(
        `select data_generation::text as d, identity_generation::text as i
           from slack_team_state where team_id = $1`,
        [teamId]
      );
      return rows[0];
    };
    expect(await read(a.teamId)).toEqual({ d: "0", i: "0" });
    expect(await read(b.teamId)).toEqual({ d: "0", i: "0" });

    // A data bump is not an identity bump: an identity mismatch forces an inline cold rebuild while
    // a data mismatch is a background refresh, so a schema that moved them together would turn
    // every re-publication into a full rebuild.
    await c.query(
      `update slack_team_state set data_generation = data_generation + 1 where team_id = $1`,
      [a.teamId]
    );
    expect(await read(a.teamId)).toEqual({ d: "1", i: "0" });
    await c.query(
      `update slack_team_state set identity_generation = identity_generation + 1 where team_id = $1`,
      [a.teamId]
    );
    expect(await read(a.teamId)).toEqual({ d: "1", i: "1" });
    // …and neither one leaked into the other team.
    expect(await read(b.teamId)).toEqual({ d: "0", i: "0" });
  });

  it("refuses a negative generation and a second row for one team", async () => {
    const seed = await seedTeam();
    const c = await sql();
    await c.query(`insert into slack_team_state (team_id) values ($1)`, [seed.teamId]);

    expect(
      await errCode(
        c.query(`update slack_team_state set data_generation = -1 where team_id = $1`, [seed.teamId])
      )
    ).toBe("23514");
    expect(
      await errCode(c.query(`insert into slack_team_state (team_id) values ($1)`, [seed.teamId]))
    ).toBe("23505");
  });
});

// ── repeatable rollout ───────────────────────────────────────────────────────

/**
 * On its OWN scratch database, because it runs the real schema loader three times and the dm
 * harness truncates rows, not DDL — a mid-test failure against the shared database would strand it
 * and redden unrelated files. Generous timeout: each load applies schema.sql plus every migration.
 */
const SCRATCH_TIMEOUT = 300_000;

describe("rollout — repeatable from zero, on upgrade, and on replay", () => {
  it(
    "creates the tables on a populated pre-AIO-1170 database and preserves every row on replay",
    async () => {
      const { loadSchema } = await import("@/scripts/pg-load-schema.mjs");
      const adminUrl = process.env.DATABASE_TEST_URL;
      if (!adminUrl) throw new Error("DATABASE_TEST_URL required");
      const name = `slackledger_${randomUUID().replace(/-/g, "").slice(0, 16)}`;

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
      const load = () =>
        loadSchema({ cwd: process.cwd(), databaseUrl: url, logger: { log: () => {} } });

      const c = new Client({ connectionString: url });
      await c.connect();
      try {
        await c.query("set time zone 'UTC'");

        // 1. FROM ZERO.
        await load();
        const tableCount = async () =>
          (
            await c.query<{ c: string }>(
              `select count(*)::text as c from pg_tables
                where schemaname='public' and tablename in ('slack_messages','slack_team_state')`
            )
          ).rows[0].c;
        expect(await tableCount()).toBe("2");

        // 2. Populate the tables this change does NOT own, then drop the two it does — that is
        //    exactly the shape of a released database that predates AIO-1170.
        const teamId = randomUUID();
        const projectId = randomUUID();
        const itemId = randomUUID();
        await c.query(`insert into teams (id, slug, name) values ($1, 'legacy-team', 'Legacy')`, [
          teamId,
        ]);
        await c.query(
          `insert into projects (id, team_id, slug, name) values ($1, $2, 'acme', 'Acme')`,
          [projectId, teamId]
        );
        await c.query(
          `insert into items (id, team_id, project_id, path, kind, access, body, content_sha256)
             values ($1, $2, $3, 'slack/T0AIO1170/C0LEDGER/1718900000.000100.md',
                     'deliverable', 'team', 'legacy body', repeat('a', 64))`,
          [itemId, teamId, projectId]
        );
        await c.query(`drop table slack_messages`);
        await c.query(`drop table slack_team_state`);
        expect(await tableCount()).toBe("0");

        // 3. UPGRADE. The loader must create both tables against the populated database…
        await load();
        expect(await tableCount()).toBe("2");
        // …without disturbing the source data it found there…
        const { rows: survivors } = await c.query<{ id: string; body: string }>(
          `select id, body from items`
        );
        expect(survivors).toEqual([{ id: itemId, body: "legacy body" }]);
        // …and the new composite FK must bind to a PRE-EXISTING item, which is the only thing that
        // proves the constraint was built against real rows rather than an empty table.
        const evidence = project([{ ts: ts(1718900000, 100), user: HUMAN, text: "legacy thread" }])
          .messages[0];
        const row = toLedgerRow(evidence, teamId, itemId);
        const cols = Object.keys(row);
        await c.query(
          `insert into slack_messages (${cols.join(", ")}) values (${cols
            .map((_, i) => `$${i + 1}`)
            .join(", ")})`,
          cols.map((k) => row[k])
        );
        await c.query(
          `insert into slack_team_state (team_id, data_generation, identity_generation)
             values ($1, 7, 3)`,
          [teamId]
        );

        const snapshot = async () => {
          const { rows: m } = await c.query(
            `select workspace_id, channel_id, message_ts, root_ts, item_id, author_external_id,
                    to_char(occurred_at at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.US') as exact,
                    is_root, eligible, exclusion_reason, source_hash,
                    last_seen_generation::text as gen
               from slack_messages order by message_ts`
          );
          const { rows: s } = await c.query(
            `select team_id, data_generation::text as d, identity_generation::text as i
               from slack_team_state order by team_id`
          );
          return { m, s };
        };
        const before = await snapshot();
        expect(before.m).toHaveLength(1);
        expect(before.m[0].exact).toBe("2024-06-20T16:13:20.000100");
        expect(before.s).toEqual([{ team_id: teamId, d: "7", i: "3" }]);

        // 4. REPLAY on the now-populated ledger — every deploy re-runs this path.
        await load();
        expect(await snapshot()).toEqual(before);
        // The constraints are still the ones being replayed, not a weakened re-creation.
        expect(
          await errCode(
            c.query(
              `insert into slack_messages (${cols.join(", ")}) values (${cols
                .map((_, i) => `$${i + 1}`)
                .join(", ")})`,
              cols.map((k) => row[k])
            )
          )
        ).toBe("23505");
        expect(
          await errCode(
            c.query(`update slack_messages set occurred_at = null where item_id = $1`, [itemId])
          )
        ).toBe("23514");
      } finally {
        await c.end().catch(() => {});
        const dropper = new Client({ connectionString: adminUrl });
        await dropper.connect();
        await dropper.query(`drop database if exists ${name} with (force)`).catch(() => {});
        await dropper.end().catch(() => {});
      }
    },
    SCRATCH_TIMEOUT
  );
});
