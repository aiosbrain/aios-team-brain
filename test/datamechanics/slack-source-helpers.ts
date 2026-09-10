import { Client } from "pg";

import { setIntegrationSecret, setIntegrationStatus, upsertIntegration } from "@/lib/integrations/manage";
import { db, type Seed } from "./helpers";

/**
 * Fixtures for the Slack SOURCE-DISCOVERY tier (AIO-1170): a REAL `integrations` row written through
 * the real writer, a fake provider that answers per Slack method, and raw-SQL readers for the two
 * source-owned tables.
 *
 * Two fixture rules this file exists to keep:
 *
 *  1. NOTHING HERE SHORT-CIRCUITS THE PRODUCT. There is no "mark this channel verified" and no
 *     "bind this app" helper: every verified state in a test is reached by the real entrypoint
 *     answering real fixtures, because a fixture that could mint the verified state would make every
 *     bootstrap assertion vacuous.
 *  2. THE TOKEN IS SYNTHETIC AND THE CONFIG IS REAL. Secrets go in through `setIntegrationSecret`
 *     (so they are genuinely encrypted at rest and genuinely decrypted by the reader under test),
 *     and no test reads a developer-environment secret.
 */

export const SLACK_FAKE_METHODS = [
  "auth.test",
  "bots.info",
  "conversations.info",
  "conversations.history",
  "conversations.replies",
  "users.list",
] as const;

export type SlackFakeMethod = (typeof SLACK_FAKE_METHODS)[number];

export const SLACK_INTEGRATION_NAME = "slack-source";

// ── raw SQL ──────────────────────────────────────────────────────────────────
// A SEPARATE connection from the app pool, for the same reasons as the budget tier: an assertion
// made from inside an injected fetch is only meaningful if it cannot see uncommitted work, and
// `for update nowait` needs SQLSTATE, which the adapter's error envelope drops.

let raw: Client | null = null;

export async function rawSql(): Promise<Client> {
  if (!raw) {
    raw = new Client({ connectionString: process.env.DATABASE_URL });
    await raw.connect();
    await raw.query("set time zone 'UTC'");
  }
  return raw;
}

export async function closeRawSql(): Promise<void> {
  if (raw) await raw.end();
  raw = null;
}

/**
 * A reused per-worktree container is schema-loaded only when it is CREATED (`scripts/dm-isolated.sh`),
 * so one that predates this change silently lacks both new tables — and every test below would fail
 * with a relation error that reads like a product bug. Say what it actually is, once, up front.
 */
export async function requireSlackSourceTables(): Promise<void> {
  const c = await rawSql();
  const { rows } = await c.query<{ tablename: string }>(
    `select tablename from pg_tables
      where schemaname = 'public' and tablename = any($1::text[])`,
    [["slack_integration_bindings", "slack_sync_channels"]]
  );
  if (rows.length !== 2) {
    throw new Error(
      "slack_integration_bindings / slack_sync_channels are missing from the test database. The dm " +
        "container loads the schema only when it is created — re-run with AIOS_DM_RESET=1 " +
        "npm run test:datamechanics:iso <file>"
    );
  }
}

// ── real integration rows ────────────────────────────────────────────────────

export async function seedSlackIntegration(
  seed: Seed,
  opts: { channelIds?: readonly string[]; token?: string | null; name?: string } = {}
): Promise<string> {
  const { id } = await upsertIntegration(
    db(),
    { teamId: seed.teamId, memberId: seed.memberId },
    {
      type: "slack",
      name: opts.name ?? SLACK_INTEGRATION_NAME,
      config: { channelIds: [...(opts.channelIds ?? [])] },
    }
  );
  if (opts.token) {
    await setIntegrationSecret(db(), { teamId: seed.teamId, memberId: seed.memberId }, id, opts.token);
  }
  return id;
}

/** Rotate the SAVED secret through the real writer — which also moves `updated_at`. */
export async function rotateSlackSecret(seed: Seed, integrationId: string, token: string): Promise<void> {
  await setIntegrationSecret(db(), { teamId: seed.teamId, memberId: seed.memberId }, integrationId, token);
}

/** Change the channel selection through the real writer (upsert keyed on team+type+name). */
export async function setSlackChannelIds(
  seed: Seed,
  channelIds: readonly string[],
  name = SLACK_INTEGRATION_NAME
): Promise<void> {
  await upsertIntegration(
    db(),
    { teamId: seed.teamId, memberId: seed.memberId },
    { type: "slack", name, config: { channelIds: [...channelIds] } }
  );
}

export async function disableSlackIntegration(seed: Seed, integrationId: string): Promise<void> {
  await setIntegrationStatus(db(), { teamId: seed.teamId, memberId: seed.memberId }, integrationId, "disabled");
}

// ── the fake provider ────────────────────────────────────────────────────────

export interface SlackCall {
  readonly method: SlackFakeMethod;
  readonly params: URLSearchParams;
  readonly authorization: string | null;
}

export type SlackHandler = (call: SlackCall) => Response | Promise<Response>;

export interface SlackFake {
  readonly impl: typeof fetch;
  readonly calls: SlackCall[];
  countOf(method: SlackFakeMethod): number;
  paramsOf(method: SlackFakeMethod): URLSearchParams[];
}

/**
 * A fetch that routes on the Slack method and RECORDS every call. A method with no handler THROWS:
 * "this request was never supposed to happen" is most of what the bootstrap contracts assert, and a
 * default answer would turn each of those into a silent pass.
 */
export function fakeSlack(handlers: Partial<Record<SlackFakeMethod, SlackHandler>>): SlackFake {
  const calls: SlackCall[] = [];
  const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = url.pathname.replace(/^\/api\//, "") as SlackFakeMethod;
    const headers = new Headers(init?.headers ?? {});
    const call: SlackCall = {
      method,
      params: url.searchParams,
      authorization: headers.get("authorization"),
    };
    calls.push(call);
    const handler = handlers[method];
    if (!handler) throw new Error(`fake slack: unexpected ${method} request`);
    return handler(call);
  }) as unknown as typeof fetch;
  return {
    impl,
    calls,
    countOf: (method) => calls.filter((c) => c.method === method).length,
    paramsOf: (method) => calls.filter((c) => c.method === method).map((c) => c.params),
  };
}

export function slackJson(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

export function slackRateLimited(retryAfter = "1"): Response {
  return new Response("<html>rate limited</html>", {
    status: 429,
    headers: { "retry-after": retryAfter, "content-type": "text/html" },
  });
}

// ── canned provider bodies ───────────────────────────────────────────────────

export function authTestBody(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ok: true,
    url: "https://acme.slack.com/",
    team: "Acme",
    user: "aios",
    team_id: "T0SOURCE1",
    user_id: "U0SOURCE1",
    bot_id: "B0SOURCE1",
    ...over,
  };
}

export function botsInfoBody(bot: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ok: true,
    bot: { id: "B0SOURCE1", deleted: false, name: "aios", app_id: "A0SOURCE1", ...bot },
  };
}

export function channelInfoBody(
  channelId: string,
  over: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    ok: true,
    channel: { id: channelId, name: "general", is_channel: true, is_private: false, is_im: false, is_mpim: false, ...over },
  };
}

/** A top-level root exactly as `conversations.history` reports one. No text is required. */
export function rootMessage(ts: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return { type: "message", ts, user: "U0SOURCE1", text: `message ${ts}`, ...over };
}

export function historyBody(input: {
  messages: readonly Record<string, unknown>[];
  hasMore?: boolean;
  nextCursor?: string | null;
}): Record<string, unknown> {
  const cursor = input.nextCursor ?? null;
  return {
    ok: true,
    messages: [...input.messages],
    has_more: input.hasMore ?? false,
    ...(cursor === null ? {} : { response_metadata: { next_cursor: cursor } }),
  };
}

// ── raw readers + clock fixtures ─────────────────────────────────────────────

export type Row = Record<string, unknown>;

export async function bindingRow(teamId: string, integrationId: string): Promise<Row | null> {
  const c = await rawSql();
  const { rows } = await c.query<Row>(
    `select * from slack_integration_bindings where team_id = $1 and integration_id = $2`,
    [teamId, integrationId]
  );
  return rows[0] ?? null;
}

export async function integrationRow(integrationId: string): Promise<Row | null> {
  const c = await rawSql();
  const { rows } = await c.query<Row>(`select * from integrations where id = $1`, [integrationId]);
  return rows[0] ?? null;
}

export async function channelRow(
  teamId: string,
  workspaceId: string,
  channelId: string
): Promise<Row | null> {
  const c = await rawSql();
  const { rows } = await c.query<Row>(
    `select * from slack_sync_channels
      where team_id = $1 and workspace_id = $2 and channel_id = $3`,
    [teamId, workspaceId, channelId]
  );
  return rows[0] ?? null;
}

export async function channelRows(teamId?: string): Promise<Row[]> {
  const c = await rawSql();
  const { rows } = await c.query<Row>(
    teamId
      ? `select * from slack_sync_channels where team_id = $1 order by workspace_id, channel_id`
      : `select * from slack_sync_channels order by team_id, workspace_id, channel_id`,
    teamId ? [teamId] : []
  );
  return rows;
}

export async function threadRows(teamId: string): Promise<Row[]> {
  const c = await rawSql();
  const { rows } = await c.query<Row>(
    `select * from slack_sync_threads where team_id = $1 order by channel_id, root_ts`,
    [teamId]
  );
  return rows;
}

export async function threadRootTs(teamId: string): Promise<string[]> {
  return (await threadRows(teamId)).map((r) => r.root_ts as string);
}

/**
 * ⚠️ CLOCK FIXTURE — the same one the budget tier uses, and the same warning. It moves persisted
 * deadlines BACKWARDS to represent elapsed time so a suite need not sleep through a 60-second
 * interval. No application path may do this; a slot is never refunded.
 */
export async function elapse(teamId: string, ms = 120_000): Promise<void> {
  const c = await rawSql();
  const shift = `- ($2::double precision * interval '1 millisecond')`;
  // Every persisted NOT-BEFORE for this team, so "two minutes passed" means the same thing to the
  // request budget, the channel lane and the bootstrap. Lease expiries are deliberately NOT moved:
  // faking an expiry is a different fixture (`expireChannelLease`) with a different meaning.
  await c.query(
    `update slack_method_budgets set next_permitted_at = next_permitted_at ${shift} where team_id = $1`,
    [teamId, ms]
  );
  await c.query(`update slack_sync_channels set due_at = due_at ${shift} where team_id = $1`, [teamId, ms]);
  await c.query(`update slack_integration_bindings set due_at = due_at ${shift} where team_id = $1`, [
    teamId,
    ms,
  ]);
}

/**
 * Age a channel's public proof past its metadata TTL, so the next invocation actually RE-CHECKS it.
 * Without this the recheck contracts are vacuous: a fresh proof is reused, the fixture's failing
 * `conversations.info` handler is never called, and the assertion passes for the wrong reason.
 */
export async function agePublicProof(teamId: string, channelId: string, days = 7): Promise<void> {
  const c = await rawSql();
  await c.query(
    `update slack_sync_channels
        set public_checked_at = public_checked_at - ($3::int * interval '1 day')
      where team_id = $1 and channel_id = $2 and public_checked_at is not null`,
    [teamId, channelId, days]
  );
}

/** Expire a channel lease in place — the reclaim arm, without waiting out a real lease. */
export async function expireChannelLease(teamId: string, channelId: string): Promise<void> {
  const c = await rawSql();
  await c.query(
    `update slack_sync_channels
        set lease_expires_at = clock_timestamp() - interval '1 second'
      where team_id = $1 and channel_id = $2 and lease_owner is not null`,
    [teamId, channelId]
  );
}
