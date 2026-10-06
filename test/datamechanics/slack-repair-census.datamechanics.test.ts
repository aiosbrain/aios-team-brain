import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import { Client } from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it, onTestFinished, vi } from "vitest";

import * as timelineCache from "@/lib/dashboard/timeline-cache";
import * as admin from "@/lib/db/admin";
import { getPool, runSql } from "@/lib/db/pg/pool";
import type { SqlExecutor } from "@/lib/db/types";
import * as arcCache from "@/lib/graph/arc-cache";
import * as identities from "@/lib/identity/member-identities";
import * as sharedIngest from "@/lib/ingest";
import * as channelState from "@/lib/ingest/slack-channel-state";
import * as cleanup from "@/lib/ingest/slack-cleanup";
import * as messageLedger from "@/lib/ingest/slack-message-ledger";
import * as methodBudget from "@/lib/ingest/slack-method-budget";
import * as namespaceGate from "@/lib/ingest/slack-namespace-gate";
import * as publication from "@/lib/ingest/slack-publication";
import * as binding from "@/lib/ingest/slack-source-binding";
import * as discovery from "@/lib/ingest/slack-source-discovery";
import { discoverSlackSource } from "@/lib/ingest/slack-source-discovery";
import * as hydrator from "@/lib/ingest/slack-thread-hydrator";
import * as threadState from "@/lib/ingest/slack-thread-state";
import * as transport from "@/lib/ingest/sources/slack-page-request";
import * as integrations from "@/lib/integrations/manage";
import * as secrets from "@/lib/secrets/crypto";
import { db, seedTeam, type Seed } from "./helpers";
import {
  authTestBody, bindingRow, channelInfoBody, channelRow, closeRawSql, disableSlackIntegration,
  fakeSlack, historyBody, rawSql, requireSlackSourceTables, seedSlackIntegration,
  setSlackChannelIds, slackJson,
} from "./slack-source-helpers";

/**
 * AIO-1170 Slack repair census — the READER (`lib/ingest/slack-repair-census-read.ts`), on real
 * Postgres. One invocation is one `REPEATABLE READ, READ ONLY` transaction that reports what is
 * STORED for one `{teamId, integrationId, channelId}` and writes nothing.
 *
 * Fixture rules:
 *  • A verified binding is reached through the REAL discovery entrypoint answering a fake provider,
 *    as everywhere else in this tier. Degraded variants (rotated workspace, blocked binding, stale
 *    cached selection) are then raw edits of that real row, because they are states the census
 *    must read, not states this slice can produce.
 *  • Item ids are chosen, not generated: the census pages by item UUID, so every "which page is it
 *    on" claim below is a claim about these ids.
 *  • The reader is loaded per test through a non-literal specifier, AFTER the fixtures: while the
 *    module does not exist each case fails on its own at that line, with its fixtures proven.
 */

// Every case first reaches a verified binding through real discovery, and several then take whole-table
// snapshots or seed 50+ rows; the 5s default is a budget for one read, not for that. The two 57014
// cases below still state their own timeout explicitly.
vi.setConfig({ testTimeout: 20_000 });

const REPO = join(import.meta.dirname, "..", "..");
const CHANNEL = "C0ABC";
const WORKSPACE = "T1";
const TOKEN = "xoxb-synthetic-census";
const HASH = "a".repeat(64);
const ROOT = "1718900000.000100";
const ROOT2 = "1718900000.000200";
const ROOT3 = "1718900000.000300";
const GATE_REGEX = /^slack\/[A-Za-z0-9]+\/[A-Za-z0-9]+\/[0-9]+[.][0-9]{6}[.]md$/;
const HOSTILE = "C0ABC'); drop table items;--<script>alert('x')</script>";

type Json = Record<string, unknown>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- the module under test does not exist yet
type Loose = Record<string, any>;
interface Scope {
  teamId: string;
  integrationId: string;
  channelId: string;
}
interface Hook {
  afterFirstRead?: (query: SqlExecutor) => Promise<void>;
}

async function load(file: string): Promise<Loose> {
  const target = join(REPO, file);
  return (await import(/* @vite-ignore */ target)) as Loose;
}

async function read(request: unknown, options?: Hook): Promise<Loose> {
  const { readSlackRepairCensusPage } = await load("lib/ingest/slack-repair-census-read.ts");
  return options === undefined
    ? readSlackRepairCensusPage(request)
    : readSlackRepairCensusPage(request, options);
}

/** Item UUIDs in a chosen order. `lane` keeps two teams' ids disjoint and recognisable. */
function id(n: number, lane = 1): string {
  return `${lane}0000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
}

// ── fixtures ─────────────────────────────────────────────────────────────────

async function verifiedScope(seed: Seed, workspace = WORKSPACE): Promise<Scope> {
  const integrationId = await seedSlackIntegration(seed, { channelIds: [CHANNEL], token: TOKEN });
  const fake = fakeSlack({
    "auth.test": () => slackJson(authTestBody({ app_id: "A0CENSUS1", team_id: workspace })),
    "conversations.info": () => slackJson(channelInfoBody(CHANNEL)),
    "conversations.history": () => slackJson(historyBody({ messages: [] })),
  });
  const result = await discoverSlackSource(
    { db: db(), teamId: seed.teamId, integrationId },
    { fetchImpl: fake.impl, envToken: () => null }
  );
  expect(result.binding?.state, "fixture: the binding verified").toBe("verified");
  expect(await bindingRow(seed.teamId, integrationId), "fixture: stored binding").toMatchObject({
    state: "verified", workspace_id: workspace,
  });
  return { teamId: seed.teamId, integrationId, channelId: CHANNEL };
}

async function project(teamId: string, slug = `p-${randomUUID().slice(0, 8)}`): Promise<string> {
  const { rows } = await runSql<{ id: string }>(
    `insert into projects (team_id, slug) values ($1, $2) returning id`,
    [teamId, slug]
  );
  return rows[0].id;
}

async function item(
  teamId: string,
  projectId: string,
  itemId: string,
  path: string,
  over: { frontmatter?: Json; memberId?: string | null; locked?: boolean } = {},
  sql: SqlExecutor = runSql
): Promise<string> {
  await sql(
    `insert into items
       (id, team_id, project_id, path, kind, access, frontmatter, body, content_sha256,
        member_id, member_id_locked)
     values ($1, $2, $3, $4, 'deliverable', 'team', $5::jsonb, '', $6, $7, $8)`,
    [itemId, teamId, projectId, path, JSON.stringify(over.frontmatter ?? { source: "slack" }), HASH,
      over.memberId ?? null, over.locked ?? false]
  );
  return itemId;
}

async function message(
  teamId: string,
  itemId: string,
  ts: string,
  over: {
    rootTs?: string; workspace?: string; channel?: string; author?: string;
    eligible?: boolean; deleted?: boolean;
  } = {},
  sql: SqlExecutor = runSql
): Promise<void> {
  await sql(
    `insert into slack_messages
       (team_id, item_id, workspace_id, channel_id, message_ts, root_ts, author_external_id,
        occurred_at, is_root, eligible, exclusion_reason, deleted_at, source_hash)
     values ($1, $2, $3, $4, $5, $6, $7,
             to_timestamp(split_part($5, '.', 1)::bigint) +
               split_part($5, '.', 2)::integer * interval '1 microsecond',
             $5 = $6, $8, case when $8 then null else 'bot_message' end,
             case when $9 then now() else null end, $10)`,
    [teamId, itemId, over.workspace ?? WORKSPACE, over.channel ?? CHANNEL, ts, over.rootTs ?? ts,
      over.author ?? "UAUTHOR", over.eligible ?? true, over.deleted ?? false, HASH]
  );
}

async function mapping(
  teamId: string,
  memberId: string,
  externalId: string,
  sql: SqlExecutor = runSql
): Promise<void> {
  await sql(
    `insert into member_identities (team_id, member_id, provider, external_id)
     values ($1, $2, 'slack', $3)`,
    [teamId, memberId, externalId]
  );
}

/** Lower-cased spellings of one qualified id — never the exact one. Collision evidence, not aliases. */
function caseVariants(exact: string, count: number): string[] {
  const letters = [...exact].flatMap((ch, i) => (/[A-Z]/.test(ch) ? [i] : []));
  if (count >= 2 ** letters.length) throw new Error("fixture: not enough letters to vary");
  return Array.from({ length: count }, (_, n) => {
    const chars = [...exact];
    letters.forEach((position, bit) => {
      if ((n + 1) & (1 << bit)) chars[position] = chars[position].toLowerCase();
    });
    return chars.join("");
  });
}

/** A second raw connection, used through pg's own client so writes commit outside the reader. */
async function committed(text: string, params: unknown[] = []): Promise<number> {
  const c = await rawSql();
  return (await c.query(text, params)).rowCount ?? 0;
}

const rawExecutor: SqlExecutor = async <T>(text: string, params: unknown[] = []) => {
  const c = await rawSql();
  const result = await c.query(text, params);
  return { rows: result.rows as T[], rowCount: result.rowCount ?? 0 };
};

/** The spec's ordered v1 tuple, computed here from the stored rows — independently of the reader. */
async function storedFingerprint(scope: Scope): Promise<string> {
  const c = await rawSql();
  const { rows } = await c.query(
    `select i.status,
            to_char(i.updated_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as updated_at,
            i.config->'channelIds' as channel_ids, b.state, b.workspace_id, b.config_revision
       from integrations i
       join slack_integration_bindings b on b.team_id = i.team_id and b.integration_id = i.id
      where i.team_id = $1 and i.id = $2`,
    [scope.teamId, scope.integrationId]
  );
  expect(rows, "fixture: one joined scope row").toHaveLength(1);
  const row = rows[0];
  const ids: unknown[] = Array.isArray(row.channel_ids) ? row.channel_ids : [];
  const selected = [...new Set(ids.filter((v): v is string => typeof v === "string" && /^[A-Za-z0-9]+$/.test(v)))].sort();
  const tuple = [
    "v1", scope.teamId, scope.integrationId, scope.channelId, row.status, row.updated_at, selected,
    row.state, row.workspace_id, row.config_revision,
  ];
  return createHash("sha256").update(JSON.stringify(tuple), "utf8").digest("hex");
}

/**
 * Every table the census could plausibly disturb, as text. The comparison is whole-table on
 * purpose: "no write" is a claim about rows the test did not think to look at.
 */
const WATCHED = [
  "teams", "members", "projects", "integrations", "slack_integration_bindings", "slack_sync_channels",
  "slack_sync_threads", "slack_thread_snapshots", "slack_method_budgets", "slack_workspace_observations",
  "member_identities", "member_identity_suppressions", "items", "item_versions", "slack_messages",
  "slack_channel_migration_gates", "slack_namespace_readiness_proofs", "slack_team_state",
  "work_timeline_cache", "arc_cache", "graph_relationships",
];

async function tables(): Promise<Record<string, string>> {
  const c = await rawSql();
  const present = (
    await c.query<{ tablename: string }>(
      `select tablename from pg_tables where schemaname = 'public' and tablename = any($1::text[])`,
      [WATCHED]
    )
  ).rows.map((r) => r.tablename).sort();
  for (const required of WATCHED.slice(0, 18)) expect(present, `fixture: ${required} exists`).toContain(required);
  const out: Record<string, string> = {};
  for (const table of present) {
    const { rows } = await c.query<{ rows: string }>(
      `select coalesce(jsonb_agg(to_jsonb(t) order by to_jsonb(t)::text), '[]'::jsonb)::text as rows
         from "${table}" t`
    );
    out[table] = rows[0].rows;
  }
  return out;
}

// ── reading + invariants every page must hold ────────────────────────────────

function holds(page: Loose): void {
  expect(page).toMatchObject({
    outcome: "page",
    mode: "dry_run",
    consistency: "page_snapshot",
    historicalCensusComplete: false,
    applyReady: false,
    bindingCurrency: "not_established",
    otherWorkspaceObservationSources: "channel_state_and_scanned_paths_only",
    source: { providerAvailableRange: { status: "unknown_not_read" } },
  });
  // Closed accounting: every scanned row is in exactly one bucket.
  expect(page.scannedItems).toBe(page.entries.length + page.unrelatedItems + page.otherWorkspaceItems);
  const byRelationship = Object.values(page.counts.byRelationship as Record<string, number>);
  expect(byRelationship).toHaveLength(4);
  expect(byRelationship.reduce((a, b) => a + b, 0)).toBe(page.entries.length);
  expect(Object.keys(page.counts.byPendingCategory)).toHaveLength(5);
  expect(page.traversalExhaustedAtThisSnapshot).toBe(page.nextCursor === null);
  expect(page.otherWorkspaceObservations.length).toBeLessThanOrEqual(50);
  expect(Number.isNaN(Date.parse(page.observedAt))).toBe(false);
  expect(page.scopeFingerprint).toMatch(/^[0-9a-f]{64}$/);
  expect(JSON.stringify(page)).not.toMatch(/token_fingerprint|secret_ciphertext|xoxb-|selected_channel_ids/);
}

async function page(scope: Scope, over: Json = {}, options?: Hook): Promise<Loose> {
  const result = await read({ scope, ...over }, options);
  expect(result.outcome, JSON.stringify(result).slice(0, 200)).toBe("page");
  holds(result);
  return result;
}

async function traverse(scope: Scope, pageSize: number): Promise<Loose[]> {
  const pages: Loose[] = [];
  let cursor: string | undefined;
  for (let guard = 0; guard < 200; guard++) {
    const next = await page(scope, cursor === undefined ? { pageSize } : { pageSize, cursor });
    expect(next.scannedItems).toBeLessThanOrEqual(pageSize);
    pages.push(next);
    if (next.nextCursor === null) return pages;
    expect(next.nextCursor).not.toBe(cursor);
    cursor = next.nextCursor as string;
  }
  throw new Error("traversal did not terminate");
}

function entryOf(pages: Loose | Loose[], itemId: string): Loose {
  const entries = (Array.isArray(pages) ? pages : [pages]).flatMap((p) => p.entries as Loose[]);
  const found = entries.filter((entry) => entry.itemId === itemId);
  expect(found, `exactly one entry for ${itemId}`).toHaveLength(1);
  return found[0];
}

function entryIds(pages: Loose | Loose[]): string[] {
  return (Array.isArray(pages) ? pages : [pages]).flatMap((p) => (p.entries as Loose[]).map((e) => e.itemId as string));
}

const REFUSED = (reason: string): Json => ({ outcome: "refused", mode: "dry_run", reason });

/**
 * RUNTIME ZERO-CALL GUARD. "No table changed" cannot prove that no writer RAN: a best-effort cache
 * stale-mark (`staleArcCache(adminClient(), teamId)`), a purge or a due-work read that matches no
 * fixture row leaves every watched table identical. So the queue, ledger, state, identity, ingest and
 * cache exports the census may not call are replaced, AFTER the fixtures, by spies that record the call
 * and throw instead of running — a prohibited call is counted even if the caller swallows the error,
 * and no real writer executes while the guard is up. The secret store keeps its own call-through spies
 * in the test below. `canonicalSlackChannelIds` is deliberately absent: it is the one permitted import.
 *
 * So is `readSlackTeamGenerations`, and only it, from the message ledger: the spec permits optional
 * team-generation diagnostics, and that helper is a team-scoped SELECT on the session it is handed.
 * Every MUTATING ledger export stays guarded; a control below proves the split is exactly that.
 */
const PERMITTED_LEDGER_READER = "readSlackTeamGenerations";
const PROHIBITED_APIS: readonly [string, Loose, readonly string[]][] = [
  ["@/lib/graph/arc-cache", arcCache, [
    "readArcCache", "staleArcCache", "purgeArcCacheKey", "purgePartitionArcCache", "sweepStaleScopedArcCache",
    "sweepOrphanedPartitionArcCache", "writeArcCache", "purgeExternalShapedPartitionRows",
  ]],
  ["@/lib/dashboard/timeline-cache", timelineCache, [
    "timelineViewKey", "resolveTimelineVariant", "readTimelineCache", "writeTimelineCache", "bustTeamTimeline",
    "purgeTimelineCacheTier", "purgeAdmissionTimelineNamespace", "settleTimelineRefreshes", "getCachedWorkTimeline",
  ]],
  ["@/lib/ingest/slack-thread-state", threadState, [
    "enqueueSlackThread", "claimSlackThread", "claimDueSlackThread", "readSlackThreadSnapshot",
    "writeSlackThreadSnapshot", "restartSlackThreadSnapshot", "purgeExpiredSlackThreadSnapshots",
    "checkpointSlackThread", "releaseSlackThreadForRetry",
  ]],
  ["@/lib/ingest/slack-message-ledger", messageLedger, [
    "bumpSlackIdentityGeneration", "bumpSlackIdentityGenerationIfCurrent", "bumpSlackPresentationIfChanged",
    "reconcileCompleteSlackThreadEvidence",
  ]],
  ["@/lib/ingest/slack-channel-state", channelState, [
    "ensureSlackChannel", "dueSlackChannels", "beginSlackChannelMetadata", "recordSlackChannelPublicState",
    "delaySlackChannel", "claimSlackChannelPage", "lockSlackChannelForAcceptance", "acceptSlackChannelPage",
    "restartSlackChannelScan", "releaseSlackChannelForRetry",
  ]],
  ["@/lib/ingest/slack-method-budget", methodBudget, [
    "reserveSlackMethodSlot", "extendSlackMethodBackoff", "markSlackMethodBlocked",
  ]],
  ["@/lib/ingest/slack-namespace-gate", namespaceGate, [
    "ensureBlockedSlackNamespaceGate", "prepareNewSlackChannelNamespace", "invalidateSlackNamespaceGate",
    "lockReadySlackNamespaceGate",
  ]],
  ["@/lib/ingest/slack-publication", publication, ["prepareSlackPublication", "finishSlackPublication"]],
  ["@/lib/ingest/slack-source-binding", binding, [
    "slackTokenFingerprint", "resolveEnvSlackToken", "slackConfigRevision", "lockSlackSelection", "slackBindingRef",
    "teamHasCurrentSlackSource", "isSlackBinderValid", "bindSlackSelection", "recordSlackWorkspaceIdentity",
    "recordSlackAppIdentity", "blockSlackBinding", "delaySlackBinding", "readSlackBinding",
  ]],
  ["@/lib/ingest/slack-thread-hydrator", hydrator, ["hydrateOneSlackThread"]],
  ["@/lib/ingest/slack-source-discovery", discovery, ["discoverSlackSource"]],
  ["@/lib/ingest/sources/slack-page-request", transport, ["slackReservedRequest"]],
  ["@/lib/ingest/slack-cleanup", cleanup, ["purgeDeletedSlackThreads"]],
  ["@/lib/identity/member-identities", identities, [
    "setMemberIdentity", "removeMemberIdentity", "deleteMemberWithIdentityRevision", "disableMemberWithIdentityRevision",
  ]],
  ["@/lib/integrations/manage", integrations, [
    "upsertIntegration", "setIntegrationStatus", "deleteIntegration", "setIntegrationSecret",
    "getEnabledIntegrationsWithSecrets", "getProviderKey",
  ]],
  ["@/lib/ingest", sharedIngest, ["ingestItem"]],
  ["@/lib/db/admin", admin, ["adminClient"]],
];

interface ProhibitedApi {
  label: string;
  namespace: Loose;
  name: string;
  spy: { mock: { calls: unknown[][] }; mockClear: () => unknown; mockRestore: () => void };
}

/** Install the guard. Call only once the fixtures exist: the fixtures themselves use these modules. */
function forbidProhibitedApis(): {
  apis: ProhibitedApi[];
  calls: () => string[];
  clear: () => void;
  restore: () => void;
} {
  const apis = PROHIBITED_APIS.flatMap(([module, namespace, names]) =>
    names.map((name): ProhibitedApi => {
      const label = `${module}#${name}`;
      expect(typeof namespace[name], `fixture: ${label} is a real export`).toBe("function");
      const spy = vi.spyOn(namespace, name).mockImplementation(() => {
        throw new Error(`census fixture: prohibited call to ${label}`);
      });
      return { label, namespace, name, spy };
    })
  );
  return {
    apis,
    calls: () => apis.filter(({ spy }) => spy.mock.calls.length > 0).map(({ label }) => label),
    clear: () => apis.forEach(({ spy }) => spy.mockClear()),
    restore: () => apis.forEach(({ spy }) => spy.mockRestore()),
  };
}

/** Page 1 of a two-item inventory, so there is a real cursor to carry across a change. */
async function midTraversal(): Promise<{ seed: Seed; scope: Scope; projectId: string; first: Loose; cursor: string }> {
  const seed = await seedTeam();
  const scope = await verifiedScope(seed);
  const projectId = await project(seed.teamId);
  await item(seed.teamId, projectId, id(1), `slack/c0abc/${ROOT}.md`);
  await item(seed.teamId, projectId, id(2), `slack/c0abc/${ROOT2}.md`);
  const first = await page(scope, { pageSize: 1 });
  expect(entryIds(first)).toEqual([id(1)]);
  expect(first.nextCursor).toEqual(expect.any(String));
  return { seed, scope, projectId, first, cursor: first.nextCursor as string };
}

beforeAll(async () => {
  await requireSlackSourceTables();
  const c = await rawSql();
  const { rows } = await c.query(
    `select 1 from pg_tables where schemaname = 'public' and tablename = 'slack_channel_migration_gates'`
  );
  if (rows.length !== 1) throw new Error("recreate the isolated data-mechanics database to load the Slack gate schema");
});
afterEach(() => {
  vi.restoreAllMocks();
});
afterAll(closeRawSql);

describe("slack repair census: scope isolation (real Postgres)", () => {
  it("reports nothing of another team that shares every Slack id, root and path", async () => {
    const a = await seedTeam();
    const b = await seedTeam();
    const scopeA = await verifiedScope(a);
    const scopeB = await verifiedScope(b);
    const projectA = await project(a.teamId, "acme");
    const projectB = await project(b.teamId, "acme");
    for (const [seed, projectId, lane] of [[a, projectA, 1], [b, projectB, 2]] as const) {
      await item(seed.teamId, projectId, id(1, lane), `slack/c0abc/${ROOT}.md`);
      await item(seed.teamId, projectId, id(2, lane), `slack/t1/c0abc/${ROOT2}.md`);
      await message(seed.teamId, id(2, lane), ROOT2);
    }
    // Only team B has: the scoped target, a converging peer, a cross-project twin, a second ledger
    // message, the author's mapping, another workspace for the channel, queued work and a gate.
    await item(b.teamId, projectB, id(3, 2), `slack/t1/c0abc/${ROOT}.md`);
    await item(b.teamId, projectB, id(4, 2), `slack/general/${ROOT}.md`, {
      frontmatter: { source: "slack", channel_id: CHANNEL },
    });
    await item(b.teamId, await project(b.teamId, "other"), id(5, 2), `slack/c0abc/${ROOT}.md`);
    await message(b.teamId, id(2, 2), "1718900001.000300", { rootTs: ROOT2 });
    await mapping(b.teamId, b.memberId, "T1:UAUTHOR");
    await runSql(`insert into slack_sync_channels (team_id, workspace_id, channel_id) values ($1, 'T0SECOND', $2)`, [b.teamId, CHANNEL]);
    await runSql(`insert into slack_sync_threads (team_id, workspace_id, channel_id, root_ts) values ($1, $2, $3, $4)`, [b.teamId, WORKSPACE, CHANNEL, ROOT2]);
    await runSql(`insert into slack_channel_migration_gates (team_id, raw_channel_id, blocked_reason) values ($1, $2, 'legacy_rows_present')`, [b.teamId, CHANNEL]);

    const pageA = await page(scopeA, { pageSize: 50 });
    expect(pageA.scope).toEqual(scopeA);
    expect(pageA.scannedItems).toBe(2);
    expect(entryIds(pageA)).toEqual([id(1, 1), id(2, 1)]);
    expect(entryOf(pageA, id(1, 1))).toMatchObject({
      projectId: projectA,
      relationship: "channel_candidate",
      exactTargetItemId: null,
      sameProjectConvergingItemIds: [],
      sameThreadOtherProjectItemIds: [],
    });
    expect(entryOf(pageA, id(2, 1))).toMatchObject({
      relationship: "scoped_channel_match",
      ledger: { present: true, totalMessages: "1", eligibleNondeletedMessages: "1" },
      authorMapping: { resolved: 0, no_mapping: 1 },
      queueStatus: "not_observed",
    });
    expect(pageA).toMatchObject({
      otherWorkspaceObservations: [],
      otherWorkspaceObservationsTruncated: false,
      otherWorkspaceItems: 0,
      namespaceGate: { status: "absent" },
      source: { threads: { queued: "0", running: "0", withError: "0" } },
    });
    const textA = JSON.stringify(pageA);
    expect(textA).not.toContain(b.teamId);
    expect(textA).not.toContain("20000000-0000-4000-8000-");
    expect(textA).not.toContain(b.memberId);
    expect(textA).not.toContain("T0SECOND");

    // Non-vacuity: the same request shape for team B sees every one of those facts.
    const pageB = await page(scopeB, { pageSize: 50 });
    expect(entryIds(pageB)).toEqual([id(1, 2), id(2, 2), id(3, 2), id(4, 2), id(5, 2)]);
    expect(entryOf(pageB, id(1, 2))).toMatchObject({
      exactTargetItemId: id(3, 2),
      sameProjectConvergingItemIds: [id(4, 2)],
      sameThreadOtherProjectItemIds: [id(5, 2)],
    });
    expect(entryOf(pageB, id(2, 2))).toMatchObject({
      ledger: { totalMessages: "2", eligibleNondeletedMessages: "2" },
      authorMapping: { resolved: 1, no_mapping: 0 },
      queueStatus: "queued",
    });
    expect(pageB).toMatchObject({
      otherWorkspaceObservations: [{ kind: "channel_state", workspaceId: "T0SECOND" }],
      namespaceGate: { status: "blocked", blockedReason: "legacy_rows_present" },
      source: { threads: { queued: "1", running: "0", withError: "0" } },
    });
    expect(JSON.stringify(pageB)).not.toContain("10000000-0000-4000-8000-");

    // Integration lookalikes: a real, verified integration of the OTHER team is not this team's scope.
    expect(await read({ scope: { ...scopeA, integrationId: scopeB.integrationId } })).toEqual(REFUSED("scope_unavailable"));
    expect(await read({ scope: { ...scopeB, integrationId: scopeA.integrationId } })).toEqual(REFUSED("scope_unavailable"));
  });
});

describe("slack repair census: traversal (real Postgres)", () => {
  it("advances one scanned row at a time over matching, unrelated, unresolved and malformed items", async () => {
    const seed = await seedTeam();
    const scope = await verifiedScope(seed);
    const p = await project(seed.teamId);
    const inventory: [number, string, Json, { entry?: string; path?: string }][] = [
      [1, `slack/t1/c0abc/${ROOT}.md`, { source: "slack" }, { entry: "scoped_channel_match", path: "scoped" }],
      [2, `slack/t1/c0other/${ROOT}.md`, { source: "slack" }, {}],
      [3, `slack/general/${ROOT}.md`, { source: "slack" }, { entry: "unresolved_channel", path: "legacy" }],
      [4, `slack//c0abc/${ROOT}.md`, { source: "slack", channel_id: HOSTILE, channel: HOSTILE }, { entry: "unresolved_channel", path: "malformed" }],
      [5, `slack/c0abc/${ROOT}.md`, {}, { entry: "channel_candidate", path: "legacy" }],
      // Source-marked, but not under slack/: still Slack inventory, and still not repaired into a path.
      [6, `notes/${HOSTILE}.md`, { source: "slack" }, { entry: "unresolved_channel", path: "malformed" }],
      [7, `slack/t0other/c0abc/${ROOT}.md`, { source: "slack" }, {}],
      [9, `slack/c0other/${ROOT}.md`, { source: "slack", channel_id: "C0OTHER" }, {}],
    ];
    for (const [n, path, frontmatter] of inventory) await item(seed.teamId, p, id(n), path, { frontmatter });
    // Not Slack inventory at all: never scanned, never counted.
    await item(seed.teamId, p, id(8), "docs/readme.md", { frontmatter: {} });

    const pages = await traverse(scope, 1);
    expect(pages).toHaveLength(inventory.length);
    const fingerprint = await storedFingerprint(scope);
    pages.forEach((current, index) => {
      const [n, path, , expected] = inventory[index];
      expect(current.scannedItems, `page ${index}`).toBe(1);
      expect(current.scopeFingerprint).toBe(fingerprint);
      expect(current.integrationStatus).toBe("enabled");
      expect(current.gateNoncanonicalItems, path).toBe(GATE_REGEX.test(path) ? 0 : 1);
      if (expected.entry) {
        expect(current).toMatchObject({ unrelatedItems: 0, otherWorkspaceItems: 0 });
        expect(current.entries).toHaveLength(1);
        expect(current.entries[0]).toMatchObject({
          itemId: id(n), projectId: p, relationship: expected.entry, path: { kind: expected.path },
        });
        expect(current.counts.byRelationship[expected.entry]).toBe(1);
      } else {
        expect(current.entries).toEqual([]);
        expect(current.unrelatedItems + current.otherWorkspaceItems).toBe(1);
      }
    });
    expect(pages[1]).toMatchObject({ unrelatedItems: 1, otherWorkspaceItems: 0 });
    expect(pages[6]).toMatchObject({
      unrelatedItems: 0,
      otherWorkspaceItems: 1,
      otherWorkspaceObservations: [{ kind: "scanned_scoped_path", workspaceId: "t0other", sourceId: id(7) }],
    });
    expect(pages[7]).toMatchObject({ unrelatedItems: 1, nextCursor: null, traversalExhaustedAtThisSnapshot: true });
    expect(entryOf(pages, id(4)).path).toEqual({ kind: "malformed", category: "unparseable_slack_path" });
    expect(entryOf(pages, id(6)).path).toEqual({ kind: "malformed", category: "unparseable_slack_path" });
    expect(entryOf(pages, id(4)).retainedChannelMetadata).toBe("malformed");
    const text = JSON.stringify(pages);
    for (const fragment of ["drop table", "<script>", "docs/readme", id(8)]) expect(text).not.toContain(fragment);

    // Replay is deterministic for unchanged stored inputs, excluding the observation time.
    const stable = (current: Loose): Loose => ({ ...current, observedAt: null });
    expect(stable(await page(scope, { pageSize: 1, cursor: pages[2].nextCursor }))).toEqual(stable(pages[3]));
    // A wider page is the same scan, differently cut.
    const wide = await page(scope, { pageSize: 50 });
    expect(wide).toMatchObject({ scannedItems: 8, unrelatedItems: 2, otherWorkspaceItems: 1, gateNoncanonicalItems: 5, nextCursor: null });
    expect(entryIds(wide)).toEqual(entryIds(pages));
    const defaulted = await page(scope);
    expect(defaulted.scannedItems).toBe(8);
  });

  it("an empty inventory is an exhausted traversal, not a completed census", async () => {
    const seed = await seedTeam();
    const scope = await verifiedScope(seed);
    await item(seed.teamId, await project(seed.teamId), id(1), "docs/readme.md", { frontmatter: {} });
    const empty = await page(scope);
    expect(empty).toMatchObject({
      scannedItems: 0, entries: [], unrelatedItems: 0, otherWorkspaceItems: 0, gateNoncanonicalItems: 0,
      nextCursor: null, traversalExhaustedAtThisSnapshot: true, historicalCensusComplete: false, applyReady: false,
      counts: { lockedItems: 0 },
    });
  });

  it("default page is 25 and the lookahead row is never classified", async () => {
    const seed = await seedTeam();
    const scope = await verifiedScope(seed);
    const p = await project(seed.teamId);
    for (let n = 1; n <= 26; n++) await item(seed.teamId, p, id(n), `slack/c0abc/1718900000.${String(n).padStart(6, "0")}.md`);
    const first = await page(scope);
    expect(entryIds(first)).toEqual(Array.from({ length: 25 }, (_, i) => id(i + 1)));
    expect(first).toMatchObject({ scannedItems: 25, gateNoncanonicalItems: 25, traversalExhaustedAtThisSnapshot: false });
    const second = await page(scope, { cursor: first.nextCursor });
    expect(entryIds(second)).toEqual([id(26)]);
    expect(second.nextCursor).toBeNull();
  });

  it("an insertion behind the cursor is never seen: exhaustion is not historical completeness", async () => {
    const seed = await seedTeam();
    const scope = await verifiedScope(seed);
    const p = await project(seed.teamId);
    await item(seed.teamId, p, id(5), `slack/c0abc/${ROOT}.md`);
    await item(seed.teamId, p, id(6), `slack/c0abc/${ROOT2}.md`);
    const first = await page(scope, { pageSize: 1 });
    expect(entryIds(first)).toEqual([id(5)]);
    await item(seed.teamId, p, id(1), `slack/c0abc/${ROOT3}.md`);
    const second = await page(scope, { pageSize: 1, cursor: first.nextCursor });
    expect(entryIds(second)).toEqual([id(6)]);
    expect(second).toMatchObject({
      nextCursor: null, traversalExhaustedAtThisSnapshot: true, historicalCensusComplete: false, applyReady: false,
    });
    // The plain item write did not move the scope facts, so nothing told the traversal to stop.
    expect(second.scopeFingerprint).toBe(first.scopeFingerprint);
    expect(entryIds(await traverse(scope, 1))).toEqual([id(1), id(5), id(6)]);
  });
});

describe("slack repair census: availability and cursor refusal (real Postgres)", () => {
  const sql = (text: string) => async (scope: Scope) => {
    expect(await committed(text, [scope.teamId, scope.integrationId]), "fixture: the change hit a row").toBe(1);
  };
  const changes: {
    label: string;
    change: (scope: Scope, seed: Seed) => Promise<void>;
    resumed: string;
    fresh: "page" | "scope_unavailable";
    expected?: Json;
  }[] = [
    {
      label: "the binding's workspace rotates",
      change: sql(`update slack_integration_bindings set workspace_id = 'T0ROTATED' where team_id = $1 and integration_id = $2`),
      resumed: "scope_changed",
      fresh: "page",
    },
    {
      label: "the binding's config revision moves",
      change: sql(`update slack_integration_bindings set config_revision = repeat('e', 64) where team_id = $1 and integration_id = $2`),
      resumed: "scope_changed",
      fresh: "page",
    },
    {
      label: "updated_at moves by one microsecond",
      change: sql(`update integrations set updated_at = updated_at + interval '1 microsecond' where team_id = $1 and id = $2`),
      resumed: "scope_changed",
      fresh: "page",
    },
    {
      label: "the integration is disabled",
      change: async (scope, seed) => disableSlackIntegration(seed, scope.integrationId),
      resumed: "scope_changed",
      fresh: "page",
      expected: { integrationStatus: "disabled" },
    },
    {
      label: "the channel is deselected while the binding's cached selection still lists it",
      change: async (scope, seed) => {
        await setSlackChannelIds(seed, ["C0OTHER"]);
        // Force the stale cache explicitly, so this does not depend on which writer refreshes it.
        await sql(`update slack_integration_bindings set selected_channel_ids = array['C0ABC'] where team_id = $1 and integration_id = $2`)(scope);
      },
      resumed: "scope_changed",
      fresh: "scope_unavailable",
    },
    {
      label: "the binding is blocked",
      change: sql(`update slack_integration_bindings set state = 'blocked', error_code = 'test_block' where team_id = $1 and integration_id = $2`),
      resumed: "scope_changed",
      fresh: "scope_unavailable",
    },
    {
      label: "the binding row is gone",
      change: sql(`delete from slack_integration_bindings where team_id = $1 and integration_id = $2`),
      resumed: "scope_unavailable",
      fresh: "scope_unavailable",
    },
    {
      label: "the integration row is gone",
      change: sql(`delete from integrations where team_id = $1 and id = $2`),
      resumed: "scope_unavailable",
      fresh: "scope_unavailable",
    },
    {
      label: "the integration is no longer a Slack integration (nothing else moved)",
      change: sql(`update integrations set type = 'github' where team_id = $1 and id = $2`),
      resumed: "scope_unavailable",
      fresh: "scope_unavailable",
    },
    {
      label: "the integration is no longer a Slack integration (and its row was edited)",
      change: sql(`update integrations set type = 'github', updated_at = updated_at + interval '1 second', status = 'disabled' where team_id = $1 and id = $2`),
      resumed: "scope_unavailable",
      fresh: "scope_unavailable",
    },
  ];

  it.each(changes)("after $label: a cursor is refused as $resumed, a fresh request is $fresh", async (c) => {
    const { seed, scope, first, cursor } = await midTraversal();
    await c.change(scope, seed);
    const before = await tables();
    expect(await read({ scope, pageSize: 1, cursor })).toEqual(REFUSED(c.resumed));
    if (c.fresh === "page") {
      const fresh = await page(scope, { pageSize: 1 });
      expect(fresh.scopeFingerprint).not.toBe(first.scopeFingerprint);
      expect(fresh.scopeFingerprint).toBe(await storedFingerprint(scope));
      expect(fresh).toMatchObject(c.expected ?? { integrationStatus: "enabled" });
      // The old cursor stays dead; only the fresh traversal's own cursor continues.
      expect(entryIds(await page(scope, { pageSize: 1, cursor: fresh.nextCursor }))).toEqual([id(2)]);
    } else {
      expect(await read({ scope, pageSize: 1 })).toEqual(REFUSED("scope_unavailable"));
    }
    expect(await tables()).toEqual(before);
  });

  it("a rotated workspace moves every hypothetical target; it never resumes under the old one", async () => {
    const { scope, first, cursor } = await midTraversal();
    expect(entryOf(first, id(1)).hypotheticalTarget).toEqual({
      hypothetical: true, workspace: "stored_binding_workspace", path: `slack/t1/c0abc/${ROOT}.md`,
    });
    await committed(`update slack_integration_bindings set workspace_id = 'T0ROTATED' where team_id = $1`, [scope.teamId]);
    expect(await read({ scope, cursor })).toEqual(REFUSED("scope_changed"));
    const fresh = await page(scope);
    expect(entryOf(fresh, id(1)).hypotheticalTarget).toMatchObject({ path: `slack/t0rotated/c0abc/${ROOT}.md` });
  });

  it("availability reads the CURRENT config selection, never the binding's cache", async () => {
    const { scope } = await midTraversal();
    await committed(`update slack_integration_bindings set selected_channel_ids = '{}' where team_id = $1`, [scope.teamId]);
    expect(entryIds(await page(scope))).toEqual([id(1), id(2)]);
    // A channel only the cache names is not available, and neither is a case variant of a selected one.
    await committed(`update slack_integration_bindings set selected_channel_ids = array['C0ABC', 'C0CACHED'] where team_id = $1`, [scope.teamId]);
    expect(await read({ scope: { ...scope, channelId: "C0CACHED" } })).toEqual(REFUSED("scope_unavailable"));
    expect(await read({ scope: { ...scope, channelId: "c0abc" } })).toEqual(REFUSED("scope_unavailable"));
  });

  it("an unchanged fingerprint cannot resume a scope that is not available", async () => {
    const { scope, cursor } = await midTraversal();
    const { encodeSlackRepairCursor } = await load("lib/ingest/slack-repair-census.ts");
    const forge = async (target: Scope): Promise<string> =>
      encodeSlackRepairCursor({ scope: target, scopeFingerprint: await storedFingerprint(target), lastItemId: id(1) });
    // Control: this forgery IS the cursor the reader minted, so the fingerprint above is the real one.
    expect(await forge(scope)).toBe(cursor);
    expect(entryIds(await page(scope, { pageSize: 1, cursor: await forge(scope) }))).toEqual([id(2)]);
    const never = { ...scope, channelId: "C0NEVER" };
    expect(await read({ scope: never, cursor: await forge(never) })).toEqual(REFUSED("scope_unavailable"));
    // A cursor for another scope is not a cursor for this one — rejected before any transaction.
    await expect(read({ scope: never, cursor })).rejects.toMatchObject({ category: "invalid_cursor" });
  });
});

describe("slack repair census: collisions and convergence (real Postgres)", () => {
  it("finds same-project converging peers on other pages, and keeps other projects separate", async () => {
    const seed = await seedTeam();
    const scope = await verifiedScope(seed);
    const p1 = await project(seed.teamId, "one");
    const p2 = await project(seed.teamId, "two");
    const meta = { frontmatter: { source: "slack", channel_id: CHANNEL } };
    const [A, D, S, Z1, Z2, T, W, B] = [1, 3, 4, 5, 6, 7, 8, 9].map((n) => id(n));
    const PADDED = "0001718900000.000100";
    await item(seed.teamId, p1, A, `slack/c0abc/${ROOT}.md`);
    await item(seed.teamId, p1, B, `slack/general/${ROOT}.md`, meta);
    await item(seed.teamId, p2, D, `slack/c0abc/${ROOT}.md`); // same path, different project: legal
    await item(seed.teamId, p1, S, `slack/c0abc/${ROOT2}.md`); // different root
    await item(seed.teamId, p1, Z1, `slack/c0abc/${PADDED}.md`); // same instant, different bytes
    await item(seed.teamId, p1, Z2, `slack/random/${PADDED}.md`, meta);
    await item(seed.teamId, p2, W, `slack/t0other/c0abc/${ROOT}.md`); // definitely another workspace

    const pages = await traverse(scope, 1);
    expect(pages).toHaveLength(7);
    expect(entryIds(pages)).toEqual([A, D, S, Z1, Z2, B]);
    const target = { hypothetical: true, workspace: "stored_binding_workspace", path: `slack/t1/c0abc/${ROOT}.md` };
    expect(entryOf(pages, A)).toMatchObject({
      relationship: "channel_candidate", hypotheticalTarget: target, exactTargetItemId: null,
      sameProjectConvergingItemIds: [B], sameProjectConvergingItemIdsTruncated: false,
      sameThreadOtherProjectItemIds: [D], sameThreadOtherProjectItemIdsTruncated: false,
    });
    expect(entryOf(pages, B)).toMatchObject({
      relationship: "channel_candidate", evidence: ["retained_channel_metadata"], hypotheticalTarget: target,
      exactTargetItemId: null, sameProjectConvergingItemIds: [A], sameThreadOtherProjectItemIds: [D],
    });
    expect(entryOf(pages, D)).toMatchObject({
      projectId: p2, exactTargetItemId: null, sameProjectConvergingItemIds: [], sameThreadOtherProjectItemIds: [A, B],
    });
    expect(entryOf(pages, S)).toMatchObject({ sameProjectConvergingItemIds: [], sameThreadOtherProjectItemIds: [], exactTargetItemId: null });
    expect(entryOf(pages, Z1)).toMatchObject({
      path: { kind: "legacy", rootTs: PADDED },
      hypotheticalTarget: { path: `slack/t1/c0abc/${PADDED}.md` },
      sameProjectConvergingItemIds: [Z2],
    });
    expect(entryOf(pages, Z2)).toMatchObject({ sameProjectConvergingItemIds: [Z1] });
    for (const peer of [A, B, Z1, Z2]) expect(entryOf(pages, peer).pending).toContain("provenance_review_required");
    for (const current of pages) expect(JSON.stringify(current.entries)).not.toContain(W);
    expect(pages.reduce((sum, current) => sum + current.otherWorkspaceItems, 0)).toBe(1);

    // Replay with the target actually occupied: the two diagnoses coexist, and project still decides.
    await item(seed.teamId, p1, T, `slack/t1/c0abc/${ROOT}.md`);
    const replay = await traverse(scope, 1);
    expect(entryOf(replay, A)).toMatchObject({ exactTargetItemId: T, sameProjectConvergingItemIds: [B] });
    expect(entryOf(replay, B)).toMatchObject({ exactTargetItemId: T, sameProjectConvergingItemIds: [A] });
    expect(entryOf(replay, D)).toMatchObject({ exactTargetItemId: null, sameThreadOtherProjectItemIds: [A, T, B] });
    expect(entryOf(replay, T)).toMatchObject({
      relationship: "scoped_channel_match", hypotheticalTarget: null, exactTargetItemId: null,
      sameThreadOtherProjectItemIds: [D],
    });
    expect(entryOf(replay, Z1)).toMatchObject({ exactTargetItemId: null });
  });

  it("caps peers at 50 and proves overflow with the 51st, wherever the main cursor is", async () => {
    const seed = await seedTeam();
    const scope = await verifiedScope(seed);
    const home = await project(seed.teamId, "home");
    await item(seed.teamId, home, id(1), `slack/c0abc/${ROOT}.md`);
    // 51 distinct legacy slugs in the SAME project whose retained metadata names this channel…
    await runSql(
      `insert into items (id, team_id, project_id, path, kind, access, frontmatter, body, content_sha256)
       select ('10000000-0000-4000-8000-' || lpad((100 + n)::text, 12, '0'))::uuid, $1::uuid, $2::uuid,
              'slack/slug-' || n::text || '/' || $3::text || '.md', 'deliverable', 'team',
              jsonb_build_object('source', 'slack', 'channel_id', $4::text), '', $5::text
         from generate_series(1, 51) n`,
      [seed.teamId, home, ROOT, CHANNEL, HASH]
    );
    // …one slug peer whose metadata names ANOTHER channel (never a peer)…
    await item(seed.teamId, home, id(99), `slack/slug-other/${ROOT}.md`, {
      frontmatter: { source: "slack", channel_id: "C0OTHER" },
    });
    // …and 51 twins, each in its own project.
    await runSql(
      `with made as (
         insert into projects (team_id, slug) select $1::uuid, 'twin-' || n::text from generate_series(1, 51) n
         returning id, slug
       )
       insert into items (id, team_id, project_id, path, kind, access, frontmatter, body, content_sha256)
       select ('10000000-0000-4000-8000-' || lpad((500 + split_part(slug, '-', 2)::int)::text, 12, '0'))::uuid,
              $1::uuid, id, 'slack/c0abc/' || $2::text || '.md', 'deliverable', 'team',
              '{"source":"slack"}'::jsonb, '', $3::text
         from made`,
      [seed.teamId, ROOT, HASH]
    );
    const peers = Array.from({ length: 51 }, (_, i) => id(101 + i));
    const twins = Array.from({ length: 51 }, (_, i) => id(501 + i));

    // pageSize 1: every peer is on a LATER page than the entry that must list it.
    const first = await page(scope, { pageSize: 1 });
    expect(first.scannedItems).toBe(1);
    expect(entryOf(first, id(1))).toMatchObject({
      sameProjectConvergingItemIds: peers.slice(0, 50),
      sameProjectConvergingItemIdsTruncated: true,
      sameThreadOtherProjectItemIds: twins.slice(0, 50),
      sameThreadOtherProjectItemIdsTruncated: true,
      exactTargetItemId: null,
    });
    expect(entryOf(first, id(1)).pending).toContain("provenance_review_required");
    expect(first.counts.byPendingCategory.provenance_review_required).toBe(1);

    // …and on an EARLIER page than the last peer, which lists the first 50 of its own 51 others.
    const { encodeSlackRepairCursor } = await load("lib/ingest/slack-repair-census.ts");
    const late = await page(scope, {
      pageSize: 1,
      cursor: encodeSlackRepairCursor({ scope, scopeFingerprint: first.scopeFingerprint, lastItemId: id(150) }),
    });
    expect(entryIds(late)).toEqual([id(151)]);
    expect(entryOf(late, id(151))).toMatchObject({
      sameProjectConvergingItemIds: [id(1), ...peers.slice(0, 49)],
      sameProjectConvergingItemIdsTruncated: true,
    });

    // Exactly 50 is not an overflow.
    await runSql(`delete from items where id = any($1::uuid[])`, [[id(151), id(551)]]);
    expect(entryOf(await page(scope, { pageSize: 1 }), id(1))).toMatchObject({
      sameProjectConvergingItemIds: peers.slice(0, 50),
      sameProjectConvergingItemIdsTruncated: false,
      sameThreadOtherProjectItemIds: twins.slice(0, 50),
      sameThreadOtherProjectItemIdsTruncated: false,
    });
  });

  it("closes the page accounting even when other-workspace observations are truncated", async () => {
    const seed = await seedTeam();
    const scope = await verifiedScope(seed);
    const p = await project(seed.teamId);
    await item(seed.teamId, p, id(1), `slack/t1/c0other/${ROOT}.md`); // unrelated
    await item(seed.teamId, p, id(2), `slack/c0abc/${ROOT}.md`); // entry
    await item(seed.teamId, p, id(3), `slack/t0zzz/c0abc/${ROOT}.md`); // another workspace, scanned
    await runSql(
      `insert into slack_sync_channels (team_id, workspace_id, channel_id)
       select $1::uuid, 'T0WS' || lpad(n::text, 3, '0'), $2::text from generate_series(1, 51) n`,
      [seed.teamId, CHANNEL]
    );
    // Not observations: another channel in another workspace, and this channel's own state row.
    await runSql(`insert into slack_sync_channels (team_id, workspace_id, channel_id) values ($1, 'T0WS999', 'C0OTHER')`, [seed.teamId]);
    expect(await channelRow(seed.teamId, WORKSPACE, CHANNEL), "fixture: requested channel state").not.toBeNull();

    const truncated = await page(scope, { pageSize: 50 });
    expect(truncated).toMatchObject({
      scannedItems: 3, unrelatedItems: 1, otherWorkspaceItems: 1, otherWorkspaceObservationsTruncated: true,
      gateNoncanonicalItems: 1,
    });
    expect(entryIds(truncated)).toEqual([id(2)]);
    expect(truncated.otherWorkspaceObservations).toHaveLength(50);
    expect(truncated.otherWorkspaceObservations.map((o: Loose) => [o.kind, o.workspaceId])).toEqual(
      Array.from({ length: 50 }, (_, i) => ["channel_state", `T0WS${String(i + 1).padStart(3, "0")}`])
    );
    for (const observation of truncated.otherWorkspaceObservations) {
      expect(observation.sourceId).toMatch(/^[0-9a-f-]{36}$/);
    }

    await runSql(`delete from slack_sync_channels where team_id = $1 and workspace_id like 'T0WS0%' and workspace_id > 'T0WS002'`, [seed.teamId]);
    const whole = await page(scope, { pageSize: 50 });
    expect(whole.otherWorkspaceObservationsTruncated).toBe(false);
    expect(whole.otherWorkspaceObservations.map((o: Loose) => [o.kind, o.workspaceId, o.kind === "scanned_scoped_path" ? o.sourceId : null])).toEqual([
      ["channel_state", "T0WS001", null],
      ["channel_state", "T0WS002", null],
      ["scanned_scoped_path", "t0zzz", id(3)],
    ]);
    expect(whole).toMatchObject({ scannedItems: 3, unrelatedItems: 1, otherWorkspaceItems: 1 });
  });
});

describe("slack repair census: ledger, attribution and locks (real Postgres)", () => {
  it("counts the requested source's messages exactly, across UTC midnight, and classifies each author", async () => {
    const seed = await seedTeam();
    const scope = await verifiedScope(seed);
    const p = await project(seed.teamId);
    const M = id(1);
    const root = "1718927999.999999"; // 2024-06-20T23:59:59.999999Z — one microsecond before midnight
    await item(seed.teamId, p, M, `slack/t1/c0abc/${root}.md`, { locked: true, memberId: null });
    await message(seed.teamId, M, root);
    const reply = (ts: string, over: Parameters<typeof message>[3] = {}): Promise<void> =>
      message(seed.teamId, M, ts, { rootTs: root, ...over });
    await reply("1718928000.000000"); // 2024-06-21T00:00:00.000000Z
    await reply("1718928000.000001", { author: "UNOMAP" });
    await reply("1718928001.000000", { author: "UBOT" });
    await reply("1718928002.000000", { author: "UTRIM" });
    await reply("1718928003.000000", { author: "UMANY" });
    await reply("1718928004.000000", { author: "UCAPPED" });
    // Days nobody is credited for: deleted (06-22), excluded (06-23), and both at once.
    await reply("1719014400.000000", { deleted: true });
    await reply("1719100800.000000", { eligible: false });
    await reply("1719100801.000000", { eligible: false, deleted: true });

    await mapping(seed.teamId, seed.memberId, "T1:UAUTHOR");
    const connector = (
      await runSql<{ id: string }>(
        `insert into members (team_id, email, display_name, actor_handle, role, tier, status, is_connector)
         values ($1, $2, 'Slack connector', $3, 'member', 'team', 'active', true) returning id`,
        [seed.teamId, `${randomUUID()}@test.local`, `connector-${randomUUID().slice(0, 8)}`]
      )
    ).rows[0].id;
    await mapping(seed.teamId, connector, "T1:UBOT");
    // JS `trim()` strips U+00A0 and SQL `btrim` does not: the only stored row for this account is a
    // spelling variant, and missing it would report `no_mapping` for an account that has a conflict.
    await mapping(seed.teamId, seed.memberId, "T1:UTRIM ");
    // 51 spelling variants PLUS the exact row: over the candidate bound, so never resolved.
    await mapping(seed.teamId, seed.memberId, "T1:UMANY");
    for (const variant of caseVariants("T1:UMANY", 51)) await mapping(seed.teamId, seed.memberId, variant);
    // Exactly at the bound: every candidate was read, and they conflict.
    for (const variant of caseVariants("T1:UCAPPED", 50)) await mapping(seed.teamId, seed.memberId, variant);

    // A legacy item with a participant list: ids are counted, never resolved, whatever is mapped.
    const L = id(2);
    await item(seed.teamId, p, L, `slack/c0abc/${ROOT}.md`, {
      locked: true,
      memberId: seed.memberId,
      frontmatter: {
        source: "slack",
        channel_id: CHANNEL,
        participants: [
          { author_id: "UAUTHOR", display_name: "A", message_count: 2, first_ts: "2024-06-01T09:00:00.000000Z", last_ts: "2024-06-20T17:00:00.000000Z" },
          { author_id: "T1:UAUTHOR", display_name: "B", message_count: 1, first_ts: "2024-06-05T09:00:00.000000Z", last_ts: "2024-06-05T09:00:00.000000Z" },
        ],
      },
    });
    // A scoped match whose own ledger row names a case-only variant of the stored workspace.
    const K = id(3);
    await item(seed.teamId, p, K, `slack/t1/c0abc/${ROOT2}.md`);
    await message(seed.teamId, K, ROOT2, { workspace: "t1" });
    // A legacy id path whose retained metadata names another channel.
    const N = id(4);
    await item(seed.teamId, p, N, `slack/c0abc/${ROOT3}.md`, { frontmatter: { source: "slack", channel_id: "C0OTHER" } });

    const result = await page(scope, { pageSize: 50 });
    expect(entryIds(result)).toEqual([M, L, K, N]);
    const m = entryOf(result, M);
    expect(m).toMatchObject({
      relationship: "scoped_channel_match",
      evidence: ["scoped_path_segments", "source_ledger"],
      provenance: "scoped_ledger_observed",
      correctionLock: "locked_no_owner",
      participants: { status: "absent", validCount: 0 },
    });
    expect(m.ledger).toEqual({
      present: true,
      totalMessages: "10",
      eligibleNondeletedMessages: "7",
      excludedMessages: "2",
      deletedMessages: "2",
      eligibleNondeletedUtcDays: "2",
      conflictingSourceMessages: "0",
    });
    expect(m.authorMapping).toMatchObject({
      resolved: 1, no_mapping: 1, nonhuman_member: 1, conflicting_mapping: 2, mapping_candidates_overflow: 1,
      incomplete_provenance: 0, invalid_input: 0,
    });
    expect(Object.values(m.authorMapping as Record<string, number>).reduce((a, b) => a + b, 0)).toBe(6);
    expect(m.pending).toEqual(expect.arrayContaining(["mapping_review_required", "lock_exception"]));
    expect(JSON.stringify(m)).not.toMatch(/owner_deleted|owner_cleared|manually_cleared/);

    const l = entryOf(result, L);
    expect(l).toMatchObject({
      relationship: "channel_candidate",
      provenance: "unproven",
      correctionLock: "locked_with_owner",
      participants: {
        status: "present_valid", validCount: 2,
        earliestAttestedTs: "2024-06-01T09:00:00.000000Z", latestAttestedTs: "2024-06-20T17:00:00.000000Z",
      },
      ledger: { present: false, totalMessages: "0", eligibleNondeletedUtcDays: "0" },
      authorMapping: { incomplete_provenance: 2, resolved: 0, no_mapping: 0 },
    });
    expect(l.pending).toEqual(expect.arrayContaining(["source_refetch_required", "provenance_review_required", "mapping_review_required"]));
    for (let day = 2; day <= 19; day++) expect(JSON.stringify(l)).not.toContain(`2024-06-${String(day).padStart(2, "0")}`);

    expect(entryOf(result, K)).toMatchObject({
      relationship: "conflicting_evidence",
      provenance: "conflicting",
      ledger: { totalMessages: "0", eligibleNondeletedMessages: "0", conflictingSourceMessages: "1" },
    });
    expect(entryOf(result, N)).toMatchObject({ relationship: "conflicting_evidence", provenance: "conflicting" });
    expect(result.counts).toMatchObject({
      byRelationship: { channel_candidate: 1, scoped_channel_match: 1, unresolved_channel: 0, conflicting_evidence: 2 },
      lockedItems: 2,
    });
    expect(result.counts.byPendingCategory.mapping_review_required).toBeGreaterThanOrEqual(2);
    expect(result.counts.byPendingCategory.lock_exception).toBeGreaterThanOrEqual(1);
    const text = JSON.stringify(result);
    for (const leaked of [seed.memberId, connector, "UAUTHOR", "UTRIM", "umany"]) expect(text).not.toContain(leaked);
  });

  it("resolves a ledger author only to a HUMAN member: a standing agent and an offroster actor are nonhuman_member, like a connector", async () => {
    const seed = await seedTeam();
    const scope = await verifiedScope(seed);
    const p = await project(seed.teamId);
    /** An active member row of the given kind. Only `kind` and `is_connector` differ between them. */
    const member = async (kind: "human" | "agent" | "offroster", isConnector = false): Promise<string> =>
      (
        await runSql<{ id: string }>(
          `insert into members (team_id, email, display_name, actor_handle, role, tier, status, kind, is_connector)
           values ($1, $2, $3, $4, 'member', 'team', 'active', $5, $6) returning id`,
          [seed.teamId, `${randomUUID()}@test.local`, `Census ${kind} ${randomUUID().slice(0, 6)}`, `census-${randomUUID().slice(0, 10)}`, kind, isConnector]
        )
      ).rows[0].id;
    const human = await member("human");
    const agent = await member("agent");
    const offroster = await member("offroster");
    const connector = await member("human", true);
    // Fixture preconditions, read back: the two rows under test are NOT connectors, so nothing but
    // their kind can be what keeps them from resolving.
    const stored = (
      await runSql<{ id: string; kind: string; is_connector: boolean; status: string }>(
        `select id::text as id, kind, is_connector, status from members where id = any($1::uuid[])`,
        [[human, agent, offroster, connector]]
      )
    ).rows;
    const facts = new Map(stored.map((row) => [row.id, `${row.kind}/${row.is_connector ? "connector" : "member"}/${row.status}`]));
    expect([human, agent, offroster, connector].map((memberId) => facts.get(memberId))).toEqual([
      "human/member/active", "agent/member/active", "offroster/member/active", "human/connector/active",
    ]);

    // One scoped item per author, each with one eligible, live, exactly mapped ledger message — the
    // same evidence four times over, differing only in WHO the account is mapped to.
    const cases: [number, string, string, string][] = [
      [1, ROOT, "UHUMAN", human],
      [2, ROOT2, "UAGENT", agent],
      [3, ROOT3, "UOFFROSTER", offroster],
      [4, "1718900000.000400", "UCONNECTOR", connector],
    ];
    for (const [n, root, author, memberId] of cases) {
      await item(seed.teamId, p, id(n), `slack/t1/c0abc/${root}.md`);
      await message(seed.teamId, id(n), root, { author });
      await mapping(seed.teamId, memberId, `T1:${author}`);
    }
    // A fifth item whose thread has ALL four authors: the statuses are counted per author, not per item.
    const MIXED = "1718900000.000500";
    await item(seed.teamId, p, id(5), `slack/t1/c0abc/${MIXED}.md`);
    await message(seed.teamId, id(5), MIXED, { author: "UHUMAN" });
    for (const [n, , author] of cases.slice(1)) {
      await message(seed.teamId, id(5), `1718900001.00000${n}`, { rootTs: MIXED, author });
    }

    const result = await page(scope, { pageSize: 50 });
    expect(entryIds(result)).toEqual([id(1), id(2), id(3), id(4), id(5)]);
    for (const entry of result.entries as Loose[]) {
      expect(entry, entry.itemId).toMatchObject({
        relationship: "scoped_channel_match", provenance: "scoped_ledger_observed", ledger: { present: true },
      });
    }

    // Positive control: the human member resolves, and nothing about its mapping needs review.
    const resolved = entryOf(result, id(1));
    expect(resolved.authorMapping).toMatchObject({ resolved: 1, nonhuman_member: 0, no_mapping: 0, conflicting_mapping: 0 });
    expect(resolved.pending).not.toContain("mapping_review_required");

    // A standing agent is a principal, and an offroster row is an attribution-only actor. Neither is
    // a person whose Slack messages are personal contribution, however exactly the account is mapped.
    for (const [n, label] of [[2, "agent"], [3, "offroster"]] as const) {
      const entry = entryOf(result, id(n));
      expect(entry.authorMapping, label).toMatchObject({ resolved: 0, nonhuman_member: 1, no_mapping: 0, conflicting_mapping: 0 });
      expect(Object.values(entry.authorMapping as Record<string, number>).reduce((a, b) => a + b, 0), label).toBe(1);
      expect(entry.pending, label).toContain("mapping_review_required");
    }

    // Existing behaviour, retained as the control for the other half of the predicate: a connector.
    const viaConnector = entryOf(result, id(4));
    expect(viaConnector.authorMapping).toMatchObject({ resolved: 0, nonhuman_member: 1 });
    expect(viaConnector.pending).toContain("mapping_review_required");

    const mixed = entryOf(result, id(5));
    expect(mixed.ledger).toMatchObject({ totalMessages: "4", eligibleNondeletedMessages: "4" });
    expect(mixed.authorMapping).toMatchObject({ resolved: 1, nonhuman_member: 3, no_mapping: 0, conflicting_mapping: 0 });
    expect(mixed.pending).toContain("mapping_review_required");
    // Four of the five entries need a mapping review; the human-only one does not.
    expect(result.counts.byPendingCategory.mapping_review_required).toBe(4);
    const text = JSON.stringify(result);
    for (const leaked of [human, agent, offroster, connector, "UAGENT", "UOFFROSTER"]) expect(text).not.toContain(leaked);
  });
});

describe("slack repair census: stored source, queue and gate observations (real Postgres)", () => {
  it("reports recorded progress and exact-scope queue facts, and never reads absence as completion", async () => {
    const seed = await seedTeam();
    const scope = await verifiedScope(seed);
    const p = await project(seed.teamId);
    const [R1, R2, R3, R4] = [ROOT, ROOT2, ROOT3, "1718900000.000400"];
    await item(seed.teamId, p, id(1), `slack/t1/c0abc/${R1}.md`);
    await item(seed.teamId, p, id(2), `slack/t1/c0abc/${R2}.md`);
    await item(seed.teamId, p, id(3), `slack/t1/c0abc/${R3}.md`);
    await item(seed.teamId, p, id(4), `slack/c0abc/${R1}.md`); // legacy, SAME root as the queued thread
    const thread = `insert into slack_sync_threads (team_id, workspace_id, channel_id, root_ts, last_error_code) values ($1, $2, $3, $4, $5)`;
    await runSql(thread, [seed.teamId, WORKSPACE, CHANNEL, R1, null]);
    await runSql(thread, [seed.teamId, WORKSPACE, CHANNEL, R4, "timeout"]);
    await runSql(
      `insert into slack_sync_threads
         (team_id, workspace_id, channel_id, root_ts, status, lease_generation, lease_owner, lease_expires_at, last_error_code)
       values ($1, $2, $3, $4, 'running', 1, 'census-fixture-owner', now() + interval '1 hour', 'http_503')`,
      [seed.teamId, WORKSPACE, CHANNEL, R2]
    );
    // Same root in another workspace, and in another channel: neither is this scope's queue.
    await runSql(thread, [seed.teamId, "T0SECOND", CHANNEL, R3, null]);
    await runSql(thread, [seed.teamId, WORKSPACE, "C0OTHER", R3, "timeout"]);
    await committed(
      `update slack_sync_channels
          set newest_anchor_ts = '1718999999.000900', historical_anchor_ts = '1718800000.000001',
              completed_lower_ts = '1718800000.000001', completed_upper_ts = '1718999999.000900'
        where team_id = $1 and workspace_id = $2 and channel_id = $3`,
      [seed.teamId, WORKSPACE, CHANNEL]
    );
    const stored = await channelRow(seed.teamId, WORKSPACE, CHANNEL);
    expect(stored, "fixture: discovery recorded the channel").toMatchObject({ newest_anchor_ts: "1718999999.000900" });

    const before = await tables();
    const result = await page(scope, { pageSize: 50 });
    expect(result.source).toMatchObject({
      channelState: "present",
      publicState: stored?.public_state,
      publicCheckedAt: expect.any(String),
      newestAnchorTs: "1718999999.000900",
      historicalAnchorTs: "1718800000.000001",
      recordedCoverage: { completedLowerTs: "1718800000.000001", completedUpperTs: "1718999999.000900" },
      threads: { queued: "2", running: "1", withError: "2" },
      providerAvailableRange: { status: "unknown_not_read" },
    });
    expect(entryOf(result, id(1))).toMatchObject({ queueStatus: "queued", queueErrorObserved: false });
    expect(entryOf(result, id(2))).toMatchObject({ queueStatus: "running", queueErrorObserved: true });
    expect(entryOf(result, id(3))).toMatchObject({ queueStatus: "not_observed", queueErrorObserved: false });
    expect(entryOf(result, id(4))).toMatchObject({ relationship: "channel_candidate", queueStatus: "not_applicable" });
    expect(entryOf(result, id(1)).pending).toContain("pending_queue_work");
    expect(entryOf(result, id(3)).pending).not.toContain("pending_queue_work");
    expect(entryOf(result, id(4)).pending).not.toContain("pending_queue_work");
    expect(result.counts.byPendingCategory.pending_queue_work).toBe(2);
    expect(JSON.stringify(result)).not.toContain("census-fixture-owner");
    expect(result.namespaceGate).toEqual({ status: "absent" });
    expect(await tables()).toEqual(before);
  });

  it("reports a missing channel state and a missing gate as absent, and creates neither", async () => {
    const seed = await seedTeam();
    const scope = await verifiedScope(seed);
    await item(seed.teamId, await project(seed.teamId), id(1), `slack/c0abc/${ROOT}.md`);
    await committed(`delete from slack_sync_channels where team_id = $1`, [seed.teamId]);
    const before = await tables();
    const result = await page(scope);
    expect(result.source).toMatchObject({
      channelState: "absent", publicState: null, publicCheckedAt: null, newestAnchorTs: null, historicalAnchorTs: null,
      recordedCoverage: { completedLowerTs: null, completedUpperTs: null },
      threads: { queued: "0", running: "0", withError: "0" },
      providerAvailableRange: { status: "unknown_not_read" },
    });
    expect(result.namespaceGate).toEqual({ status: "absent" });
    expect(entryIds(result)).toEqual([id(1)]);
    const after = await tables();
    expect(after).toEqual(before);
    expect(after.slack_channel_migration_gates).toBe("[]");
    expect(after.slack_sync_channels).toBe("[]");
    expect(after.slack_namespace_readiness_proofs).toBe("[]");
  });

  it("decodes the stored gate with the existing codec, and rejects a corrupt one outright", async () => {
    const seed = await seedTeam();
    const scope = await verifiedScope(seed);
    await item(seed.teamId, await project(seed.teamId), id(1), `slack/c0abc/${ROOT}.md`);
    const repair = randomUUID();
    await committed(
      `insert into slack_channel_migration_gates (team_id, raw_channel_id, revision, blocked_reason)
       values ($1, $2, 3, 'legacy_rows_present')`,
      [seed.teamId, CHANNEL]
    );
    // A case variant of the raw channel is another gate, not this one.
    await committed(`insert into slack_channel_migration_gates (team_id, raw_channel_id, revision) values ($1, 'c0abc', 9)`, [seed.teamId]);
    expect((await page(scope)).namespaceGate).toEqual({ status: "blocked", revision: 3, blockedReason: "legacy_rows_present" });

    const ready = `update slack_channel_migration_gates
                      set state = 'ready', revision = 4, ready_revision = 4, resolved_workspace_ids = $3::text[],
                          completed_repair_id = $4, blocked_reason = null
                    where team_id = $1 and raw_channel_id = $2`;
    await committed(ready, [seed.teamId, CHANNEL, [WORKSPACE, "T0SECOND"], repair]);
    const open = await page(scope);
    expect(open.namespaceGate).toEqual({
      status: "ready", revision: 4, readyRevision: 4, resolvedWorkspaceIds: [WORKSPACE, "T0SECOND"], completedRepairId: repair,
    });
    // A ready gate is an observation. It changes no flag on the report.
    expect(open).toMatchObject({ applyReady: false, historicalCensusComplete: false });
    expect(entryOf(open, id(1))).toMatchObject({ relationship: "channel_candidate", provenance: "unproven" });

    // A ready row the schema ACCEPTS and the decoder must not report. Every CHECK holds — the two
    // revisions agree, the workspaces are provider ids, the repair id is set, no blocking reason — but
    // the revision is 2^53 + 1, which no JavaScript number holds: reading it would silently report a
    // different revision. (A malformed workspace id is not storable here: the table's
    // `slack_channel_migration_gates_workspace_syntax` CHECK refuses it, so that arm of the codec is
    // pinned on the pure decoder instead.)
    const UNSAFE_REVISION = "9007199254740993";
    expect(Number.isSafeInteger(Number(UNSAFE_REVISION)), "fixture: the revision is past the safe range").toBe(false);
    expect(
      await committed(
        `update slack_channel_migration_gates
            set revision = $3::bigint, ready_revision = $3::bigint
          where team_id = $1 and raw_channel_id = $2 and state = 'ready'`,
        [seed.teamId, CHANNEL, UNSAFE_REVISION]
      ),
      "fixture: the corrupt-for-decoder gate was stored"
    ).toBe(1);
    const storedGate = await (await rawSql()).query(
      `select state, revision::text as revision, ready_revision::text as ready_revision, resolved_workspace_ids
         from slack_channel_migration_gates where team_id = $1 and raw_channel_id = $2`,
      [seed.teamId, CHANNEL]
    );
    expect(storedGate.rows).toEqual([
      {
        state: "ready",
        revision: UNSAFE_REVISION,
        ready_revision: UNSAFE_REVISION,
        resolved_workspace_ids: [WORKSPACE, "T0SECOND"],
      },
    ]);
    const before = await tables();
    const failure = await read({ scope }).then(
      (value) => ({ returned: value }),
      (error: unknown) => ({ error: error as Loose })
    );
    expect(failure).not.toHaveProperty("returned");
    expect((failure as { error: Loose }).error).toBeInstanceOf(Error);
    // The stored value that failed the codec is not quoted — neither exactly nor as its rounded float.
    const message = String((failure as { error: Loose }).error.message);
    expect(message).not.toContain(UNSAFE_REVISION);
    expect(message).not.toContain(String(Number(UNSAFE_REVISION)));
    expect(message).not.toMatch(/[0-9]{6,}/);
    expect(await tables()).toEqual(before);
  });
});

describe("slack repair census: case-only stored-id variants in channel state (real Postgres)", () => {
  /** A legacy candidate, a scoped match with a ledger and a queued root, and an unresolved slug. */
  async function matches(): Promise<{ seed: Seed; scope: Scope }> {
    const seed = await seedTeam();
    const scope = await verifiedScope(seed);
    const p = await project(seed.teamId);
    await item(seed.teamId, p, id(1), `slack/c0abc/${ROOT}.md`);
    await item(seed.teamId, p, id(2), `slack/t1/c0abc/${ROOT2}.md`);
    await message(seed.teamId, id(2), ROOT2);
    await item(seed.teamId, p, id(3), `slack/general/${ROOT3}.md`);
    await runSql(
      `insert into slack_sync_threads (team_id, workspace_id, channel_id, root_ts) values ($1, $2, $3, $4)`,
      [seed.teamId, WORKSPACE, CHANNEL, ROOT2]
    );
    expect(await channelRow(seed.teamId, WORKSPACE, CHANNEL), "fixture: the exact channel state").not.toBeNull();
    // Control: with no variant on record these are plain matches.
    plain(await page(scope));
    return { seed, scope };
  }

  const channelState = async (teamId: string, workspaceId: string, channelId: string): Promise<void> => {
    await runSql(`insert into slack_sync_channels (team_id, workspace_id, channel_id) values ($1, $2, $3)`, [
      teamId, workspaceId, channelId,
    ]);
  };

  function plain(result: Loose): void {
    expect(entryOf(result, id(1))).toMatchObject({ relationship: "channel_candidate", evidence: ["legacy_path_segment"] });
    expect(entryOf(result, id(2))).toMatchObject({
      relationship: "scoped_channel_match",
      evidence: ["scoped_path_segments", "source_ledger"],
      provenance: "scoped_ledger_observed",
      queueStatus: "queued",
    });
    expect(JSON.stringify(result.entries)).not.toContain("channel_state");
  }

  function contradicted(result: Loose): void {
    expect(entryOf(result, id(1))).toMatchObject({
      relationship: "conflicting_evidence",
      provenance: "conflicting",
      evidence: ["legacy_path_segment", "channel_state"],
      hypotheticalTarget: { hypothetical: true, path: `slack/t1/c0abc/${ROOT}.md` },
    });
    expect(entryOf(result, id(2))).toMatchObject({
      relationship: "conflicting_evidence",
      provenance: "conflicting",
      evidence: ["scoped_path_segments", "source_ledger", "channel_state"],
      // The source-key reads stayed byte-exact: the item's own ledger rows are still the requested
      // source's, and a contradicted match gets no queue association.
      ledger: { present: true, totalMessages: "1", conflictingSourceMessages: "0" },
      queueStatus: "not_applicable",
    });
    // Not a match to begin with: a variant contradicts a match, it does not create an entry or a label.
    expect(entryOf(result, id(3))).toMatchObject({ relationship: "unresolved_channel", evidence: [] });
    expect(result.counts.byRelationship).toEqual({
      channel_candidate: 0, scoped_channel_match: 0, unresolved_channel: 1, conflicting_evidence: 2,
    });
    expect(result.source).toMatchObject({ channelState: "present", threads: { queued: "1", running: "0" } });
  }

  it.each([
    ["a workspace-only variant", "t1", CHANNEL, [{ kind: "channel_state", workspaceId: "t1" }]],
    ["a channel-only variant", WORKSPACE, "c0abc", []],
  ])("%s overrides every match to conflicting_evidence", async (_label, workspaceId, channelId, observations) => {
    const { seed, scope } = await matches();
    await channelState(seed.teamId, workspaceId, channelId);
    const before = await tables();
    const result = await page(scope);
    contradicted(result);
    // The variant is not an alias for the requested source in any other read either: it is listed as
    // another workspace only when its workspace bytes differ for this exact channel.
    expect(result.otherWorkspaceObservations).toHaveLength(observations.length);
    expect(result.otherWorkspaceObservations).toMatchObject(observations);
    expect(result.otherWorkspaceObservationsTruncated).toBe(false);
    expect(await tables()).toEqual(before);
  });

  it("ignores the same variants when another team holds them", async () => {
    const { scope } = await matches();
    const other = await seedTeam();
    await channelState(other.teamId, "t1", CHANNEL);
    await channelState(other.teamId, WORKSPACE, "c0abc");
    await channelState(other.teamId, WORKSPACE, CHANNEL);
    const result = await page(scope);
    plain(result);
    expect(result.otherWorkspaceObservations).toEqual([]);
    expect(result.counts.byRelationship.conflicting_evidence).toBe(0);
  });

  it("detects a variant that the capped observation array does not show", async () => {
    const { seed, scope } = await matches();
    await runSql(
      `insert into slack_sync_channels (team_id, workspace_id, channel_id)
       select $1::uuid, 'T0WS' || lpad(n::text, 3, '0'), $2::text from generate_series(1, 51) n`,
      [seed.teamId, CHANNEL]
    );
    // Byte order puts every upper-case `T0WS…` before `t1`, so the variant is the 52nd observation.
    await channelState(seed.teamId, "t1", CHANNEL);
    const result = await page(scope);
    expect(result.otherWorkspaceObservationsTruncated).toBe(true);
    expect(result.otherWorkspaceObservations).toHaveLength(50);
    expect(result.otherWorkspaceObservations.map((o: Loose) => o.workspaceId)).not.toContain("t1");
    contradicted(result);
  });
});

describe("slack repair census: stored ids longer than the request bound (real Postgres)", () => {
  it("reads a 65-character stored binding workspace, ready-gate workspace and retained metadata channel", async () => {
    const LONG_WORKSPACE = `T${"0".repeat(64)}`;
    const LONG_CHANNEL = `C${"9".repeat(64)}`;
    const seed = await seedTeam();
    const scope = await verifiedScope(seed);
    const p = await project(seed.teamId);
    await item(seed.teamId, p, id(1), `slack/c0abc/${ROOT}.md`);
    await item(seed.teamId, p, id(2), `slack/c0abc/${ROOT2}.md`, {
      frontmatter: { source: "slack", channel_id: LONG_CHANNEL },
    });
    await item(seed.teamId, p, id(3), `slack/${LONG_WORKSPACE.toLowerCase()}/c0abc/${ROOT3}.md`);
    await message(seed.teamId, id(3), ROOT3, { workspace: LONG_WORKSPACE });
    const repair = randomUUID();
    expect(
      await committed(`update slack_integration_bindings set workspace_id = $2 where team_id = $1`, [seed.teamId, LONG_WORKSPACE]),
      "fixture: the long workspace is storable"
    ).toBe(1);
    expect(
      await committed(
        `insert into slack_channel_migration_gates
           (team_id, raw_channel_id, state, revision, ready_revision, resolved_workspace_ids, completed_repair_id)
         values ($1, $2, 'ready', 0, 0, $3::text[], $4)`,
        [seed.teamId, CHANNEL, [LONG_WORKSPACE], repair]
      ),
      "fixture: the long gate workspace is storable"
    ).toBe(1);

    const result = await page(scope, { pageSize: 50 });
    expect(result.scopeFingerprint).toBe(await storedFingerprint(scope));
    expect(entryIds(result)).toEqual([id(1), id(2), id(3)]);
    expect(entryOf(result, id(1))).toMatchObject({
      relationship: "channel_candidate",
      hypotheticalTarget: { path: `slack/${LONG_WORKSPACE.toLowerCase()}/c0abc/${ROOT}.md` },
    });
    // Valid contradictory evidence — a real, different channel id — not a malformed value.
    expect(entryOf(result, id(2))).toMatchObject({
      relationship: "conflicting_evidence", provenance: "conflicting", retainedChannelMetadata: "valid",
    });
    expect(entryOf(result, id(3))).toMatchObject({
      relationship: "scoped_channel_match",
      provenance: "scoped_ledger_observed",
      ledger: { totalMessages: "1", conflictingSourceMessages: "0" },
    });
    expect(result.namespaceGate).toEqual({
      status: "ready", revision: 0, readyRevision: 0, resolvedWorkspaceIds: [LONG_WORKSPACE], completedRepairId: repair,
    });
    // The channel state discovery recorded under the old workspace is now another workspace's.
    expect(result.otherWorkspaceObservations).toMatchObject([{ kind: "channel_state", workspaceId: WORKSPACE }]);

    // The cursor still fits its bound and still continues: the stored workspace is not in it.
    const first = await page(scope, { pageSize: 1 });
    expect(first.nextCursor.length).toBeLessThanOrEqual(512);
    expect(entryIds(await page(scope, { pageSize: 1, cursor: first.nextCursor }))).toEqual([id(2)]);
    // What a CALLER supplies is still bounded.
    await expect(read({ scope: { ...scope, channelId: LONG_CHANNEL } })).rejects.toMatchObject({
      category: "invalid_scope",
    });
  });
});

describe("slack repair census: diagnostics on a contradicted legacy entry (real Postgres)", () => {
  it("keeps the exact target and the qualified peers of a legacy requested-channel entry made conflicting", async () => {
    const seed = await seedTeam();
    const scope = await verifiedScope(seed);
    const p1 = await project(seed.teamId, "one");
    const p2 = await project(seed.teamId, "two");
    const [N, T, P, B, U, X] = [1, 2, 3, 4, 5, 6].map((n) => id(n));
    // N: a legacy path for the requested channel whose retained metadata names another channel.
    await item(seed.teamId, p1, N, `slack/c0abc/${ROOT}.md`, { frontmatter: { source: "slack", channel_id: "C0OTHER" } });
    await item(seed.teamId, p1, T, `slack/t1/c0abc/${ROOT}.md`); // the same-project occupant of N's target
    await item(seed.teamId, p2, P, `slack/c0abc/${ROOT}.md`); // a compatible peer in another project
    await item(seed.teamId, p1, B, `slack/general/${ROOT}.md`, { frontmatter: { source: "slack", channel_id: CHANNEL } });
    // U: agrees with ANOTHER channel in path and metadata, and is an entry only because of a ledger row.
    await item(seed.teamId, p1, U, `slack/c0other/${ROOT}.md`, { frontmatter: { source: "slack", channel_id: "C0OTHER" } });
    await message(seed.teamId, U, ROOT);
    await item(seed.teamId, p1, X, `slack//c0abc/${ROOT}.md`); // unparseable
    await runSql(
      `insert into slack_sync_threads (team_id, workspace_id, channel_id, root_ts) values ($1, $2, $3, $4)`,
      [seed.teamId, WORKSPACE, CHANNEL, ROOT]
    );

    const pages = await traverse(scope, 1);
    const target = { hypothetical: true, workspace: "stored_binding_workspace", path: `slack/t1/c0abc/${ROOT}.md` };
    const n = entryOf(pages, N);
    expect(n).toMatchObject({
      relationship: "conflicting_evidence",
      provenance: "conflicting",
      retainedChannelMetadata: "valid",
      hypotheticalTarget: target,
      exactTargetItemId: T,
      sameProjectConvergingItemIds: [B],
      sameProjectConvergingItemIdsTruncated: false,
      sameThreadOtherProjectItemIds: [P],
      sameThreadOtherProjectItemIdsTruncated: false,
      // The queue holds this very root for the requested source, and a legacy item still gets none.
      queueStatus: "not_applicable",
      queueErrorObserved: false,
    });
    expect(n.pending).toEqual(expect.arrayContaining(["source_refetch_required", "provenance_review_required"]));
    expect(n.pending).not.toContain("pending_queue_work");
    // Control: the queue row is real, and the scoped match for that root is what observes it.
    expect(entryOf(pages, T)).toMatchObject({ relationship: "scoped_channel_match", queueStatus: "queued" });

    // N seeks peers but is not one: a contradicted item is never counted as somebody's candidate.
    expect(entryOf(pages, B)).toMatchObject({
      relationship: "channel_candidate", exactTargetItemId: T, sameProjectConvergingItemIds: [],
      sameThreadOtherProjectItemIds: [P],
    });
    expect(entryOf(pages, P)).toMatchObject({
      relationship: "channel_candidate", exactTargetItemId: null, sameProjectConvergingItemIds: [],
      sameThreadOtherProjectItemIds: [T, B],
    });

    // No target is manufactured for a row that never had one.
    for (const none of [U, X]) {
      expect(entryOf(pages, none)).toMatchObject({
        hypotheticalTarget: null, exactTargetItemId: null, sameProjectConvergingItemIds: [],
        sameThreadOtherProjectItemIds: [], queueStatus: "not_applicable",
      });
    }
    expect(entryOf(pages, U).relationship).toBe("conflicting_evidence");
    expect(entryOf(pages, X).relationship).toBe("unresolved_channel");
  });

  it("distinguishes a missing channel_id from a present null one", async () => {
    const seed = await seedTeam();
    const scope = await verifiedScope(seed);
    const p = await project(seed.teamId);
    const root = (n: number): string => `1718900000.${String(n).padStart(6, "0")}`;
    await item(seed.teamId, p, id(1), `slack/c0abc/${root(1)}.md`, { frontmatter: { source: "slack" } });
    await item(seed.teamId, p, id(2), `slack/c0abc/${root(2)}.md`, { frontmatter: { source: "slack", channel_id: null } });
    await item(seed.teamId, p, id(3), `slack/c0abc/${root(3)}.md`, { frontmatter: { source: "slack", channel_id: "C0 ABC!" } });
    await item(seed.teamId, p, id(4), `slack/c0abc/${root(4)}.md`, { frontmatter: { source: "slack", channel_id: CHANNEL } });
    await item(seed.teamId, p, id(5), `slack/general/${root(5)}.md`, { frontmatter: { source: "slack", channel_id: null } });
    const stored = await runSql<{ present: boolean; value: string }>(
      `select jsonb_exists(frontmatter, 'channel_id') as present, jsonb_typeof(frontmatter->'channel_id') as value
         from items where id = $1`,
      [id(2)]
    );
    expect(stored.rows, "fixture: the key is stored, holding JSON null").toEqual([{ present: true, value: "null" }]);

    const result = await page(scope);
    expect(entryOf(result, id(1))).toMatchObject({ relationship: "channel_candidate", retainedChannelMetadata: "absent" });
    expect(entryOf(result, id(2))).toMatchObject({
      relationship: "channel_candidate", retainedChannelMetadata: "malformed", evidence: ["legacy_path_segment"],
    });
    expect(entryOf(result, id(3))).toMatchObject({ relationship: "channel_candidate", retainedChannelMetadata: "malformed" });
    expect(entryOf(result, id(4))).toMatchObject({
      relationship: "channel_candidate", retainedChannelMetadata: "valid",
      evidence: ["legacy_path_segment", "retained_channel_metadata"],
    });
    expect(entryOf(result, id(5))).toMatchObject({ relationship: "unresolved_channel", retainedChannelMetadata: "malformed" });
  });
});

describe("slack repair census: the peer inventory read continues past a batch (real Postgres)", () => {
  it("finds a qualifying peer after more than 500 disqualified root-sharing rows, and terminates", async () => {
    const seed = await seedTeam();
    const scope = await verifiedScope(seed);
    const home = await project(seed.teamId, "home");
    const elsewhere = await project(seed.teamId, "elsewhere");
    const slugs = (from: number, count: number, prefix: string): Promise<unknown> =>
      runSql(
        `insert into items (id, team_id, project_id, path, kind, access, frontmatter, body, content_sha256)
         select ('10000000-0000-4000-8000-' || lpad(($5::int + n)::text, 12, '0'))::uuid, $1::uuid, $2::uuid,
                'slack/' || $6::text || '-' || n::text || '/' || $3::text || '.md', 'deliverable', 'team',
                '{"source":"slack"}'::jsonb, '', $4::text
           from generate_series(1, $7::int) n`,
        [seed.teamId, home, ROOT, HASH, from, prefix, count]
      );
    await item(seed.teamId, home, id(1), `slack/c0abc/${ROOT}.md`);
    // Disqualified early: tied to the channel by metadata, contradicted by its own ledger.
    await item(seed.teamId, home, id(50), `slack/early/${ROOT}.md`, { frontmatter: { source: "slack", channel_id: CHANNEL } });
    await message(seed.teamId, id(50), ROOT, { workspace: "T2" });
    // 600 unresolved slugs sharing the root, ids 101…700: the first internal batch holds no peer at all.
    await slugs(100, 600, "slug");
    // The only qualifying peers sit beyond that batch.
    await item(seed.teamId, home, id(900), `slack/late/${ROOT}.md`, { frontmatter: { source: "slack", channel_id: CHANNEL } });
    await item(seed.teamId, elsewhere, id(901), `slack/c0abc/${ROOT}.md`);
    const sharing = async (): Promise<number> =>
      Number(
        (await runSql<{ n: string }>(`select count(*)::text as n from items where team_id = $1 and path like $2`, [
          seed.teamId, `slack/%/${ROOT}.md`,
        ])).rows[0].n
      );
    expect(await sharing(), "fixture: more root-sharing rows than one batch").toBe(604);

    const expected = {
      relationship: "channel_candidate",
      exactTargetItemId: null,
      sameProjectConvergingItemIds: [id(900)],
      sameProjectConvergingItemIdsTruncated: false,
      sameThreadOtherProjectItemIds: [id(901)],
      sameThreadOtherProjectItemIdsTruncated: false,
    };
    const first = await page(scope, { pageSize: 1 });
    expect(first.scannedItems).toBe(1);
    expect(entryOf(first, id(1))).toMatchObject(expected);

    // Exactly two full batches: the read must also stop when the last batch is full and the next empty.
    await slugs(1000, 396, "pad");
    expect(await sharing(), "fixture: a whole number of batches").toBe(1000);
    expect(entryOf(await page(scope, { pageSize: 1 }), id(1))).toMatchObject(expected);
  });
});

describe("slack repair census: the hook's executor is revoked with its invocation (real Postgres)", () => {
  it("rejects a captured executor after a page, a refusal and a failed invocation, and cannot write", async () => {
    const seed = await seedTeam();
    const scope = await verifiedScope(seed);
    await item(seed.teamId, await project(seed.teamId), id(1), `slack/c0abc/${ROOT}.md`);
    const captured: SqlExecutor[] = [];
    const capture = async (query: SqlExecutor): Promise<void> => {
      // While the invocation is live the executor works, on the reader's own read-only transaction.
      expect((await query<{ one: number }>("select 1 as one")).rows).toEqual([{ one: 1 }]);
      expect((await query<{ transaction_read_only: string }>("show transaction_read_only")).rows[0].transaction_read_only).toBe("on");
      captured.push(query);
    };

    expect(entryIds(await page(scope, {}, { afterFirstRead: capture }))).toEqual([id(1)]);
    expect(await read({ scope: { ...scope, channelId: "C0NEVER" } }, { afterFirstRead: capture })).toEqual(
      REFUSED("scope_unavailable")
    );
    await expect(
      read({ scope }, {
        afterFirstRead: async (query) => {
          await capture(query);
          throw new Error("census-fixture-abort");
        },
      })
    ).rejects.toThrow("census-fixture-abort");
    expect(captured).toHaveLength(3);

    // Statements that would SUCCEED on an ordinary pooled connection — which is what the closure holds
    // once the transaction is over. Each must be refused before it reaches PostgreSQL.
    const insertGate = `insert into slack_channel_migration_gates (team_id, raw_channel_id) values ($1, 'C0ABC')`;
    const lockItem = `update items set member_id_locked = true where team_id = $1 and id = '${id(1)}'`;
    const before = await tables();
    for (const query of captured) {
      for (const [statement, params] of [["select 1", []], [insertGate, [seed.teamId]], [lockItem, [seed.teamId]]] as const) {
        const outcome = await query(statement, [...params]).then(
          (value) => ({ returned: value }),
          (error: unknown) => ({ error: error as Loose })
        );
        expect(outcome, statement).not.toHaveProperty("returned");
        expect((outcome as { error: Loose }).error).toMatchObject({ name: "SlackRepairCensusHookRevokedError" });
        // Refused by the revocation, not by a read-only transaction that no longer exists.
        expect((outcome as { error: Loose }).error).not.toHaveProperty("code");
      }
    }
    expect(await tables()).toEqual(before);

    // Control: the very same statements ARE valid writes through the pool, so it was the revocation
    // that protected the rows. The reader is unaffected and the pool is healthy.
    expect(await committed(insertGate, [seed.teamId])).toBe(1);
    expect(await committed(lockItem, [seed.teamId])).toBe(1);
    expect(await tables()).not.toEqual(before);
    const after = await page(scope, {}, { afterFirstRead: capture });
    expect(entryOf(after, id(1))).toMatchObject({ correctionLock: "locked_no_owner" });
    expect(after.namespaceGate).toMatchObject({ status: "blocked" });
    expect(captured).toHaveLength(4);
  });
});

describe("slack repair census: contradiction precedence on stored rows (real Postgres)", () => {
  const root = (n: number): string => `1718900000.${String(n).padStart(6, "0")}`;

  it("makes a contradicted other-workspace path or legacy slug ONE conflicting entry, with closed accounting", async () => {
    const seed = await seedTeam();
    const scope = await verifiedScope(seed);
    const p = await project(seed.teamId);
    // Requested scope T1/C0ABC. These paths say workspace t2, channel c0abc.
    const elsewhere = (n: number): string => `slack/t2/c0abc/${root(n)}.md`;
    // 1: valid retained metadata names another channel; no ledger.
    await item(seed.teamId, p, id(1), elsewhere(1), { frontmatter: { source: "slack", channel_id: "COTHER" } });
    // 2: its own ledger row is stored under a THIRD workspace, contradicting the path's.
    await item(seed.teamId, p, id(2), elsewhere(2));
    await message(seed.teamId, id(2), root(2), { workspace: "T3" });
    // 3: a legacy slug whose retained metadata says COTHER and whose ledger says the requested source.
    await item(seed.teamId, p, id(3), `slack/general/${root(3)}.md`, {
      frontmatter: { source: "slack", channel_id: "COTHER" },
    });
    await message(seed.teamId, id(3), root(3));
    // Controls — nothing stored contradicts these: a bare path, and one whose metadata and own ledger
    // both agree with it (the other workspace's rows, never the requested source's).
    await item(seed.teamId, p, id(4), elsewhere(4));
    await item(seed.teamId, p, id(5), elsewhere(5), { frontmatter: { source: "slack", channel_id: CHANNEL } });
    await message(seed.teamId, id(5), root(5), { workspace: "T2" });
    const ledger = await runSql<{ item_id: string; workspace_id: string; channel_id: string }>(
      `select item_id::text as item_id, workspace_id, channel_id from slack_messages where team_id = $1 order by item_id`,
      [seed.teamId]
    );
    expect(ledger.rows, "fixture: the stored ledger sources").toEqual([
      { item_id: id(2), workspace_id: "T3", channel_id: CHANNEL },
      { item_id: id(3), workspace_id: WORKSPACE, channel_id: CHANNEL },
      { item_id: id(5), workspace_id: "T2", channel_id: CHANNEL },
    ]);

    const before = await tables();
    const result = await page(scope, { pageSize: 50 });
    // Closed accounting: five scanned rows, each in exactly one bucket.
    expect(result).toMatchObject({
      scannedItems: 5, unrelatedItems: 0, otherWorkspaceItems: 2, gateNoncanonicalItems: 1,
      otherWorkspaceObservationsTruncated: false,
    });
    expect(entryIds(result)).toEqual([id(1), id(2), id(3)]);
    // A contradicted row is NOT also an other-workspace observation.
    expect(result.otherWorkspaceObservations).toEqual([
      { kind: "scanned_scoped_path", workspaceId: "t2", sourceId: id(4) },
      { kind: "scanned_scoped_path", workspaceId: "t2", sourceId: id(5) },
    ]);
    expect(result.counts.byRelationship).toEqual({
      channel_candidate: 0, scoped_channel_match: 0, unresolved_channel: 0, conflicting_evidence: 3,
    });
    expect(result.counts.byPendingCategory.provenance_review_required).toBe(3);

    const noRequestedMessages = { present: false, totalMessages: "0", eligibleNondeletedMessages: "0", eligibleNondeletedUtcDays: "0" };
    const scopedConflict = {
      relationship: "conflicting_evidence",
      provenance: "conflicting",
      path: { kind: "scoped", workspaceSegment: "t2", channelSegment: "c0abc" },
      hypotheticalTarget: null,
      exactTargetItemId: null,
      sameProjectConvergingItemIds: [],
      sameThreadOtherProjectItemIds: [],
      queueStatus: "not_applicable",
    };
    expect(entryOf(result, id(1))).toMatchObject({
      ...scopedConflict,
      retainedChannelMetadata: "valid",
      ledger: { ...noRequestedMessages, conflictingSourceMessages: "0" },
    });
    // Its only ledger row is another source's: reported apart, never as a requested-source message.
    const second = entryOf(result, id(2));
    expect(second).toMatchObject({
      ...scopedConflict,
      retainedChannelMetadata: "absent",
      ledger: { ...noRequestedMessages, conflictingSourceMessages: "1" },
    });
    expect(Object.values(second.authorMapping as Record<string, number>).reduce((a, b) => a + b, 0)).toBe(0);
    const third = entryOf(result, id(3));
    expect(third).toMatchObject({
      relationship: "conflicting_evidence",
      provenance: "conflicting",
      path: { kind: "legacy", channelSegment: "general", rootTs: root(3) },
      retainedChannelMetadata: "valid",
      ledger: { present: true, totalMessages: "1", conflictingSourceMessages: "0" },
      queueStatus: "not_applicable",
    });
    expect(third.evidence).toContain("source_ledger");
    for (const contradicted of [entryOf(result, id(1)), second, third]) {
      expect(contradicted.pending).toContain("provenance_review_required");
      expect(contradicted.pending).not.toContain("pending_queue_work");
    }
    // The contradicting stored values are evidence, not output.
    const text = JSON.stringify(result.entries);
    for (const stored of ["COTHER", "T3", "T2"]) expect(text).not.toContain(stored);
    expect(await tables()).toEqual(before);

    // One row per page: a contradicted row occupies the entries bucket and nothing else.
    const pages = await traverse(scope, 1);
    expect(pages).toHaveLength(5);
    for (const index of [0, 1, 2]) {
      expect(pages[index], `page ${index}`).toMatchObject({
        scannedItems: 1, unrelatedItems: 0, otherWorkspaceItems: 0, otherWorkspaceObservations: [],
      });
      expect(pages[index].entries).toHaveLength(1);
      expect(pages[index].entries[0].relationship).toBe("conflicting_evidence");
    }
    for (const index of [3, 4]) {
      expect(pages[index], `page ${index}`).toMatchObject({ scannedItems: 1, unrelatedItems: 0, otherWorkspaceItems: 1, entries: [] });
      expect(pages[index].otherWorkspaceObservations).toEqual([
        { kind: "scanned_scoped_path", workspaceId: "t2", sourceId: id(index + 1) },
      ]);
    }
  });

  it("treats two stored ledger workspaces that differ only by case as a contradiction, not as one other workspace", async () => {
    const seed = await seedTeam();
    const scope = await verifiedScope(seed);
    const p = await project(seed.teamId);
    // Requested scope T1/C0ABC. Every path says workspace t2, channel c0abc, and every item's retained
    // metadata agrees with its path — so the item's own ledger alone decides each row.
    const agreeing = { frontmatter: { source: "slack", channel_id: CHANNEL } };
    const reply = (n: number): string => `1718900000.${String(n * 1000 + 1).padStart(6, "0")}`;
    for (const n of [1, 2, 3]) await item(seed.teamId, p, id(n), `slack/t2/c0abc/${root(n)}.md`, agreeing);
    // 1: rows under `T2` AND under `t2` — two stored workspace identities, byte-different.
    await message(seed.teamId, id(1), root(1), { workspace: "T2" });
    await message(seed.teamId, id(1), reply(1), { workspace: "t2", rootTs: root(1) });
    // 2 (control): one identity that folds to the path — the other workspace's own ledger.
    await message(seed.teamId, id(2), root(2), { workspace: "T2" });
    await message(seed.teamId, id(2), reply(2), { workspace: "T2", rootTs: root(2) });
    // 3 (control): an identity that does not fold to the path was already a contradiction.
    await message(seed.teamId, id(3), root(3), { workspace: "T2" });
    await message(seed.teamId, id(3), reply(3), { workspace: "T3", rootTs: root(3) });
    const stored = await runSql<{ item_id: string; workspaces: string[] }>(
      `select item_id::text as item_id,
              array_agg(distinct workspace_id collate "C" order by workspace_id collate "C") as workspaces
         from slack_messages where team_id = $1 group by item_id order by item_id`,
      [seed.teamId]
    );
    expect(stored.rows, "fixture: the exact stored workspace identities per item").toEqual([
      { item_id: id(1), workspaces: ["T2", "t2"] },
      { item_id: id(2), workspaces: ["T2"] },
      { item_id: id(3), workspaces: ["T2", "T3"] },
    ]);

    const before = await tables();
    const result = await page(scope, { pageSize: 50 });
    // Closed accounting: three scanned rows, each in exactly one bucket.
    expect(result).toMatchObject({
      scannedItems: 3, unrelatedItems: 0, otherWorkspaceItems: 1, gateNoncanonicalItems: 0,
      otherWorkspaceObservationsTruncated: false,
    });
    expect(entryIds(result)).toEqual([id(1), id(3)]);
    expect(result.otherWorkspaceObservations).toEqual([
      { kind: "scanned_scoped_path", workspaceId: "t2", sourceId: id(2) },
    ]);
    expect(result.counts.byRelationship).toEqual({
      channel_candidate: 0, scoped_channel_match: 0, unresolved_channel: 0, conflicting_evidence: 2,
    });
    for (const contradicted of [entryOf(result, id(1)), entryOf(result, id(3))]) {
      expect(contradicted).toMatchObject({
        relationship: "conflicting_evidence",
        provenance: "conflicting",
        path: { kind: "scoped", workspaceSegment: "t2", channelSegment: "c0abc" },
        retainedChannelMetadata: "valid",
        hypotheticalTarget: null,
        exactTargetItemId: null,
        queueStatus: "not_applicable",
        // Neither row is the requested source's: both are reported apart and none is counted in.
        ledger: { present: false, totalMessages: "0", eligibleNondeletedMessages: "0", conflictingSourceMessages: "2" },
      });
      expect(contradicted.evidence).not.toContain("source_ledger");
      expect(contradicted.pending).toContain("provenance_review_required");
      expect(Object.values(contradicted.authorMapping as Record<string, number>).reduce((a, b) => a + b, 0)).toBe(0);
    }
    expect(await tables()).toEqual(before);

    // One row per page: the case-variant row occupies the entries bucket and nothing else.
    const pages = await traverse(scope, 1);
    expect(pages).toHaveLength(3);
    expect(pages[0]).toMatchObject({
      scannedItems: 1, unrelatedItems: 0, otherWorkspaceItems: 0, otherWorkspaceObservations: [],
    });
    expect(entryIds(pages[0])).toEqual([id(1)]);
    expect(pages[1]).toMatchObject({ scannedItems: 1, entries: [], otherWorkspaceItems: 1 });
    expect(pages[2]).toMatchObject({ scannedItems: 1, otherWorkspaceItems: 0, otherWorkspaceObservations: [] });
    expect(entryIds(pages[2])).toEqual([id(3)]);
  });

  it("keeps a present non-string participant author visible to the author diagnostics as invalid input", async () => {
    const seed = await seedTeam();
    const scope = await verifiedScope(seed);
    const p = await project(seed.teamId);
    const VALID = {
      author_id: "U1", display_name: "One", message_count: 2,
      first_ts: "2024-06-01T09:00:00.000000Z", last_ts: "2024-06-20T17:00:00.000000Z",
    };
    const endpoints = { first_ts: VALID.first_ts, last_ts: VALID.last_ts };
    // Legacy candidates with NO ledger, so retained participants are the only author evidence.
    const withParticipants = (n: number, participants: unknown[]): Promise<string> =>
      item(seed.teamId, p, id(n), `slack/c0abc/${root(n)}.md`, { frontmatter: { source: "slack", participants } });
    await withParticipants(1, [VALID, { ...VALID, author_id: 7 }, { ...VALID, author_id: null }]);
    await withParticipants(2, [{ ...VALID, author_id: 7 }]);
    await withParticipants(3, [{ ...VALID, author_id: null }]);
    // Controls: a participant with no `author_id` key at all, alone and beside a valid one; two valid strings.
    await withParticipants(4, [VALID, endpoints]);
    await withParticipants(5, [endpoints]);
    await withParticipants(6, [VALID, { ...VALID, author_id: "T1:U2" }]);
    const stored = await runSql<{ id: string; kinds: (string | null)[] }>(
      `select i.id::text as id,
              array(select case when jsonb_exists(e, 'author_id') then jsonb_typeof(e->'author_id') end
                      from jsonb_array_elements(i.frontmatter->'participants') with ordinality as t(e, n)
                     order by n) as kinds
         from items i where i.team_id = $1 order by i.id`,
      [seed.teamId]
    );
    expect(stored.rows, "fixture: what is stored under each participant's author_id").toEqual([
      { id: id(1), kinds: ["string", "number", "null"] },
      { id: id(2), kinds: ["number"] },
      { id: id(3), kinds: ["null"] },
      { id: id(4), kinds: ["string", null] },
      { id: id(5), kinds: [null] },
      { id: id(6), kinds: ["string", "string"] },
    ]);

    const result = await page(scope);
    const attested = { earliestAttestedTs: VALID.first_ts, latestAttestedTs: VALID.last_ts };
    const notAttested = { status: "present_malformed", validCount: 0, earliestAttestedTs: null, latestAttestedTs: null };
    const authorTotal = (entry: Loose): number =>
      Object.values(entry.authorMapping as Record<string, number>).reduce((a, b) => a + b, 0);
    for (const n of [1, 2, 3, 4, 5, 6]) {
      expect(entryOf(result, id(n))).toMatchObject({ relationship: "channel_candidate", ledger: { present: false } });
    }

    // Present and not a string: a malformed participant AND an invalid-input author, one per value.
    const mixed = entryOf(result, id(1));
    expect(mixed.participants).toEqual({ status: "present_malformed", validCount: 1, ...attested });
    expect(mixed.authorMapping).toMatchObject({ incomplete_provenance: 1, invalid_input: 2, resolved: 0 });
    expect(authorTotal(mixed)).toBe(3);
    for (const n of [2, 3]) {
      const lone = entryOf(result, id(n));
      expect(lone.participants, `item ${n}`).toEqual(notAttested);
      expect(lone.authorMapping, `item ${n}`).toMatchObject({ invalid_input: 1, incomplete_provenance: 0, resolved: 0 });
      expect(authorTotal(lone), `item ${n}`).toBe(1);
      // Its only author evidence is invalid: that is still author evidence needing review.
      expect(lone.pending, `item ${n}`).toContain("mapping_review_required");
    }

    // Absence is not an author: the participant is malformed, and there is nothing to diagnose.
    const besideValid = entryOf(result, id(4));
    expect(besideValid.participants).toEqual({ status: "present_malformed", validCount: 1, ...attested });
    expect(besideValid.authorMapping).toMatchObject({ incomplete_provenance: 1, invalid_input: 0 });
    expect(authorTotal(besideValid)).toBe(1);
    const absent = entryOf(result, id(5));
    expect(absent.participants).toEqual(notAttested);
    expect(authorTotal(absent)).toBe(0);
    expect(absent.pending).not.toContain("mapping_review_required");
    // Valid strings are as they were.
    const valid = entryOf(result, id(6));
    expect(valid.participants).toEqual({ status: "present_valid", validCount: 2, ...attested });
    expect(valid.authorMapping).toMatchObject({ incomplete_provenance: 2, invalid_input: 0, resolved: 0 });
    expect(result.counts.byPendingCategory.mapping_review_required).toBe(5);
  });

  it("does not attest a calendar-invalid endpoint or count a malformed participant author", async () => {
    const seed = await seedTeam();
    const scope = await verifiedScope(seed);
    const p = await project(seed.teamId);
    const VALID = {
      author_id: "U1", display_name: "One", message_count: 2,
      first_ts: "2024-06-01T09:00:00.000000Z", last_ts: "2024-06-20T17:00:00.000000Z",
    };
    const withParticipants = (n: number, participants: unknown[]): Promise<string> =>
      item(seed.teamId, p, id(n), `slack/c0abc/${root(n)}.md`, { frontmatter: { source: "slack", participants } });
    // 1: 30 February does not exist. JavaScript's own parser would roll it over to 1 March.
    await withParticipants(1, [VALID, { ...VALID, author_id: "U2", first_ts: "2024-02-30T12:00:00.000000Z", last_ts: "2024-02-30T12:00:00.000000Z" }]);
    // 2: control — a real leap day.
    await withParticipants(2, [{ ...VALID, first_ts: "2024-02-29T12:00:00.000000Z", last_ts: "2024-02-29T12:00:00.000000Z" }]);
    // 3: an author that is not a Slack id.
    await withParticipants(3, [VALID, { ...VALID, author_id: "bad<script>" }]);
    // 4: control — two valid legacy ids, one of them qualified and even mapped.
    await withParticipants(4, [VALID, { ...VALID, author_id: "T1:U2" }]);
    await mapping(seed.teamId, seed.memberId, "T1:U2");
    const stored = await runSql<{ author: string; endpoint: string }>(
      `select (select frontmatter->'participants'->1->>'author_id' from items where id = $1) as author,
              (select frontmatter->'participants'->1->>'first_ts' from items where id = $2) as endpoint`,
      [id(3), id(1)]
    );
    expect(stored.rows, "fixture: the hostile author and the impossible date are really stored").toEqual([
      { author: "bad<script>", endpoint: "2024-02-30T12:00:00.000000Z" },
    ]);

    const result = await page(scope);
    const attested = { earliestAttestedTs: VALID.first_ts, latestAttestedTs: VALID.last_ts };
    expect(entryOf(result, id(1)).participants).toEqual({ status: "present_malformed", validCount: 1, ...attested });
    expect(entryOf(result, id(2)).participants).toEqual({
      status: "present_valid", validCount: 1,
      earliestAttestedTs: "2024-02-29T12:00:00.000000Z", latestAttestedTs: "2024-02-29T12:00:00.000000Z",
    });
    const third = entryOf(result, id(3));
    expect(third.participants).toEqual({ status: "present_malformed", validCount: 1, ...attested });
    // The valid id is still a legacy id lacking provenance; the malformed one takes the invalid-input path.
    expect(third.authorMapping).toMatchObject({ incomplete_provenance: 1, invalid_input: 1, resolved: 0 });
    expect(third.pending).toContain("mapping_review_required");
    const fourth = entryOf(result, id(4));
    expect(fourth.participants).toEqual({ status: "present_valid", validCount: 2, ...attested });
    expect(fourth.authorMapping).toMatchObject({ incomplete_provenance: 2, invalid_input: 0, resolved: 0 });

    const text = JSON.stringify(result);
    for (const fragment of ["2024-02-30", "2024-03-01", "<script>", "bad<"]) expect(text).not.toContain(fragment);
  });
});

describe("slack repair census: one read-only snapshot per invocation (real Postgres)", () => {
  async function census(): Promise<{ seed: Seed; scope: Scope; projectId: string }> {
    const seed = await seedTeam();
    const scope = await verifiedScope(seed);
    const projectId = await project(seed.teamId);
    await item(seed.teamId, projectId, id(1), `slack/c0abc/${ROOT}.md`);
    await item(seed.teamId, projectId, id(2), `slack/t1/c0abc/${ROOT2}.md`);
    await message(seed.teamId, id(2), ROOT2);
    await item(seed.teamId, projectId, id(3), `slack/c0abc/${ROOT3}.md`);
    return { seed, scope, projectId };
  }

  it("runs REPEATABLE READ, READ ONLY with a 5s statement timeout, and hands the hook only a query function", async () => {
    const { scope } = await census();
    const seen: unknown[][] = [];
    const result = await page(scope, {}, {
      afterFirstRead: async (...args: unknown[]) => {
        seen.push(args);
        const query = args[0] as SqlExecutor;
        const show = async (name: string): Promise<unknown> => Object.values((await query(`show ${name}`)).rows[0] as Json)[0];
        expect(await show("transaction_isolation")).toBe("repeatable read");
        expect(await show("transaction_read_only")).toBe("on");
        expect(await show("statement_timeout")).toBe("5s");
      },
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toHaveLength(1);
    expect(typeof seen[0][0]).toBe("function");
    expect(entryIds(result)).toEqual([id(1), id(2), id(3)]);
    // The timeout was transaction-local: the pooled connection does not keep it.
    const { rows } = await runSql<{ statement_timeout: string }>("show statement_timeout");
    expect(rows[0].statement_timeout).not.toBe("5s");
  });

  it.each([
    ["INSERT", `insert into slack_channel_migration_gates (team_id, raw_channel_id) values ($1, 'C0ABC')`],
    ["UPDATE", `update items set member_id_locked = true where team_id = $1 and id = '${id(1)}'`],
    ["DELETE", `delete from slack_messages where team_id = $1 and item_id = '${id(2)}'`],
  ])("refuses a real %s on the reader's own connection with 25006, and changes nothing", async (_verb, statement) => {
    const { seed, scope } = await census();
    const before = await tables();
    let attempts = 0;
    await expect(
      read({ scope }, {
        afterFirstRead: async (query) => {
          attempts += 1;
          await query(statement, [seed.teamId]);
        },
      })
    ).rejects.toMatchObject({ code: "25006" });
    expect(attempts).toBe(1);
    expect(await tables()).toEqual(before);
    // Control: outside the reader the very same statement is a valid write against a real row.
    expect(await committed(statement, [seed.teamId])).toBe(1);
    expect(await tables()).not.toEqual(before);
  });

  it("holds one snapshot while another connection commits item, ledger, mapping, lock, queue and gate changes", async () => {
    const { seed, scope, projectId } = await census();
    let calls = 0;
    const old = await page(scope, { pageSize: 50 }, {
      afterFirstRead: async () => {
        calls += 1;
        await item(seed.teamId, projectId, id(4), `slack/general/${ROOT}.md`, { frontmatter: { source: "slack", channel_id: CHANNEL } }, rawExecutor);
        await item(seed.teamId, projectId, id(5), `slack/t1/c0abc/${ROOT}.md`, {}, rawExecutor);
        await message(seed.teamId, id(2), "1718900001.000000", { rootTs: ROOT2 }, rawExecutor);
        await mapping(seed.teamId, seed.memberId, "T1:UAUTHOR", rawExecutor);
        expect(await committed(`update items set member_id_locked = true where id = $1`, [id(3)])).toBe(1);
        await committed(`insert into slack_sync_threads (team_id, workspace_id, channel_id, root_ts) values ($1, $2, $3, $4)`, [seed.teamId, WORKSPACE, CHANNEL, ROOT2]);
        await committed(`insert into slack_channel_migration_gates (team_id, raw_channel_id, blocked_reason) values ($1, $2, 'legacy_rows_present')`, [seed.teamId, CHANNEL]);
        await committed(`insert into slack_sync_channels (team_id, workspace_id, channel_id) values ($1, 'T0SECOND', $2)`, [seed.teamId, CHANNEL]);
      },
    });
    expect(calls).toBe(1);
    expect(entryIds(old)).toEqual([id(1), id(2), id(3)]);
    expect(entryOf(old, id(1))).toMatchObject({ exactTargetItemId: null, sameProjectConvergingItemIds: [] });
    expect(entryOf(old, id(2))).toMatchObject({
      ledger: { totalMessages: "1" }, authorMapping: { resolved: 0, no_mapping: 1 }, queueStatus: "not_observed",
    });
    expect(entryOf(old, id(3))).toMatchObject({ correctionLock: "unlocked" });
    expect(old).toMatchObject({
      namespaceGate: { status: "absent" }, otherWorkspaceObservations: [], counts: { lockedItems: 0 },
      source: { threads: { queued: "0" } },
    });

    // The commits were real: a fresh invocation observes every one of them.
    const fresh = await page(scope, { pageSize: 50 });
    expect(entryIds(fresh)).toEqual([id(1), id(2), id(3), id(4), id(5)]);
    expect(entryOf(fresh, id(1))).toMatchObject({ exactTargetItemId: id(5), sameProjectConvergingItemIds: [id(4)] });
    expect(entryOf(fresh, id(2))).toMatchObject({
      ledger: { totalMessages: "2" }, authorMapping: { resolved: 1, no_mapping: 0 }, queueStatus: "queued",
    });
    expect(entryOf(fresh, id(3))).toMatchObject({ correctionLock: "locked_no_owner" });
    expect(fresh).toMatchObject({
      namespaceGate: { status: "blocked" },
      otherWorkspaceObservations: [{ kind: "channel_state", workspaceId: "T0SECOND" }],
      counts: { lockedItems: 1 },
      source: { threads: { queued: "1" } },
    });
  });

  it("writes nothing on a page, a refusal or a rejection, and calls neither the provider nor the secret store", async () => {
    const { seed, scope } = await census();
    await mapping(seed.teamId, seed.memberId, "T1:UAUTHOR");
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const decrypt = vi.spyOn(secrets, "decryptSecret");
    const decryptBytes = vi.spyOn(secrets, "decryptSecretBytes");
    // After the fixtures (which legitimately run discovery, the budget and the binding writers), and
    // restored on every outcome so a failure here cannot leave a throwing export behind.
    const prohibited = forbidProhibitedApis();
    onTestFinished(() => prohibited.restore());
    const before = await tables();

    for (const current of await traverse(scope, 1)) expect(current.outcome).toBe("page");
    await page(scope, { pageSize: 50 });
    expect(await read({ scope: { ...scope, channelId: "C0NEVER" } })).toEqual(REFUSED("scope_unavailable"));
    expect(await read({ scope: { ...scope, integrationId: randomUUID() } })).toEqual(REFUSED("scope_unavailable"));
    await expect(read({ scope, mode: "apply" })).rejects.toMatchObject({ category: "invalid_mode" });
    await expect(
      read({ scope }, { afterFirstRead: async () => { throw new Error("census-fixture-abort"); } })
    ).rejects.toThrow("census-fixture-abort");

    expect(await tables()).toEqual(before);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(decrypt).not.toHaveBeenCalled();
    expect(decryptBytes).not.toHaveBeenCalled();
    // Across every path above — pages, both refusals, the validation rejection and the aborted read —
    // no queue, ledger, state, identity, ingest or cache export was called, whether or not it would
    // have changed a row.
    expect(prohibited.calls()).toEqual([]);
  });

  it("the prohibited-API guard detects a call to every export it covers, without running one (positive control)", async () => {
    const teamId = randomUUID();
    const before = await tables();
    const prohibited = forbidProhibitedApis();
    onTestFinished(() => prohibited.restore());
    expect(prohibited.apis.map((api) => api.label)).toEqual(
      expect.arrayContaining([
        "@/lib/graph/arc-cache#staleArcCache",
        "@/lib/ingest/slack-thread-state#enqueueSlackThread",
        "@/lib/ingest/slack-message-ledger#bumpSlackIdentityGeneration",
        "@/lib/dashboard/timeline-cache#bustTeamTimeline",
        "@/lib/db/admin#adminClient",
      ])
    );
    expect(prohibited.calls()).toEqual([]);

    // Each export, called the way an importing module calls it — through the module namespace. The
    // replacement throws before any real code runs, so nothing here reaches a writer.
    for (const api of prohibited.apis) {
      expect(() => api.namespace[api.name](), api.label).toThrow(`prohibited call to ${api.label}`);
      expect(prohibited.calls(), api.label).toEqual([api.label]);
      prohibited.clear();
      expect(prohibited.calls()).toEqual([]);
    }

    // The reviewed counterexample, spelled as a census would spell it and swallowed as a best-effort
    // call would be: the guard still counts it, at the first prohibited export it touches…
    const bestEffort = async (run: () => unknown): Promise<void> => {
      try {
        await run();
      } catch {
        // a best-effort caller hides the failure; the guard must not depend on seeing it
      }
    };
    await bestEffort(() => arcCache.staleArcCache(admin.adminClient(), teamId));
    expect(prohibited.calls()).toEqual(["@/lib/db/admin#adminClient"]);
    prohibited.clear();
    // …and at the cache writer itself when the client came from somewhere the guard does not cover.
    await bestEffort(() => arcCache.staleArcCache({} as never, teamId));
    expect(prohibited.calls()).toEqual(["@/lib/graph/arc-cache#staleArcCache"]);

    // Nothing real ran, and the guard comes off cleanly.
    expect(await tables()).toEqual(before);
    prohibited.restore();
    for (const api of prohibited.apis) {
      expect(vi.isMockFunction(api.namespace[api.name]), `${api.label} restored`).toBe(false);
    }
    expect(typeof admin.adminClient().from).toBe("function");
  });

  it("the guard leaves exactly one ledger export callable — the team-generation reader — and still counts every ledger writer", async () => {
    const seed = await seedTeam();
    await runSql(
      `insert into slack_team_state (team_id, data_generation, identity_generation, presentation_generation)
       values ($1, 7, 8, 9)`,
      [seed.teamId]
    );
    const before = await tables();
    const prohibited = forbidProhibitedApis();
    onTestFinished(() => prohibited.restore());

    // The split, read off the module itself: every function it exports is guarded except the reader.
    const ledgerLabel = (name: string): string => `@/lib/ingest/slack-message-ledger#${name}`;
    // (Its one exported Error class is a type to catch, not an API that touches the database.)
    const exported = Object.keys(messageLedger).filter((name) => {
      const value = (messageLedger as Loose)[name];
      return typeof value === "function" && !(value.prototype instanceof Error);
    });
    const guarded = prohibited.apis.filter((api) => api.namespace === messageLedger).map((api) => api.name);
    expect(guarded).not.toContain(PERMITTED_LEDGER_READER);
    expect(exported.filter((name) => !guarded.includes(name))).toEqual([PERMITTED_LEDGER_READER]);
    expect(vi.isMockFunction(messageLedger.readSlackTeamGenerations)).toBe(false);
    for (const name of guarded) expect(vi.isMockFunction((messageLedger as Loose)[name]), name).toBe(true);
    expect(guarded.sort()).toEqual([
      "bumpSlackIdentityGeneration", "bumpSlackIdentityGenerationIfCurrent", "bumpSlackPresentationIfChanged",
      "reconcileCompleteSlackThreadEvidence",
    ]);

    // The permitted call, made the way the census may make it: on a session bound to ONE read-only,
    // repeatable-read transaction. It really runs, it reads the stored row, and the guard counts nothing.
    const client = await getPool().connect();
    try {
      await client.query("begin transaction isolation level repeatable read read only");
      const executeSql: SqlExecutor = async <T>(text: string, params: unknown[] = []) => {
        const result = await client.query(text, params);
        return { rows: result.rows as T[], rowCount: result.rowCount ?? 0 };
      };
      const session = { executeSql } as never;
      expect(await messageLedger.readSlackTeamGenerations(session, seed.teamId)).toEqual({
        dataGeneration: "7", identityGeneration: "8", presentationGeneration: "9",
      });
      // A team with no row reads as zero and creates nothing: there is no "ensure" arm to permit.
      expect(await messageLedger.readSlackTeamGenerations(session, randomUUID())).toEqual({
        dataGeneration: "0", identityGeneration: "0", presentationGeneration: "0",
      });
      expect(prohibited.calls()).toEqual([]);

      // Every ledger writer on that SAME session is counted, and stopped before it issues a statement.
      for (const name of guarded) {
        expect(() => (messageLedger as Loose)[name](session, seed.teamId), name).toThrow(
          `prohibited call to ${ledgerLabel(name)}`
        );
        expect(prohibited.calls(), name).toEqual([ledgerLabel(name)]);
        prohibited.clear();
      }
      // The transaction is still usable: no writer reached PostgreSQL to abort it.
      expect((await client.query("show transaction_read_only")).rows[0].transaction_read_only).toBe("on");
    } finally {
      await client.query("rollback").catch(() => {});
      client.release();
    }
    expect(prohibited.calls()).toEqual([]);
    expect(await tables()).toEqual(before);
  });
});

describe("slack repair census: the hook seam and failure behaviour (real Postgres)", () => {
  it("rejects invalid input before any transaction, and never reaches the hook", async () => {
    const seed = await seedTeam();
    const scope = await verifiedScope(seed);
    const connect = vi.spyOn(getPool(), "connect");
    const hook = vi.fn(async () => {});
    const invalid: [Json, string][] = [
      [{ scope, mode: "apply" }, "invalid_mode"],
      [{ scope, pageSize: 51 }, "invalid_page_size"],
      [{ scope, pageSize: 0 }, "invalid_page_size"],
      [{ scope: { ...scope, teamId: HOSTILE } }, "invalid_scope"],
      [{ scope: { ...scope, channelId: HOSTILE } }, "invalid_scope"],
      [{ scope, cursor: HOSTILE }, "invalid_cursor"],
      [{ scope, verified: true }, "invalid_request"],
    ];
    for (const [request, category] of invalid) {
      const error = await read(request, { afterFirstRead: hook }).then(
        () => null,
        (caught: unknown) => caught as Loose
      );
      expect(error, category).toMatchObject({ category });
      expect(String(error?.message)).not.toContain("drop table");
    }
    expect(hook).not.toHaveBeenCalled();
    expect(connect).not.toHaveBeenCalled();
  });

  it("fires the hook exactly once after the first scope read — also on a request that is then refused", async () => {
    const seed = await seedTeam();
    const scope = await verifiedScope(seed);
    const hook = vi.fn(async (query: SqlExecutor) => {
      // The snapshot exists and is the reader's own transaction.
      expect((await query<{ transaction_read_only: string }>("show transaction_read_only")).rows[0].transaction_read_only).toBe("on");
    });
    expect(await read({ scope: { ...scope, integrationId: randomUUID() } }, { afterFirstRead: hook })).toEqual(REFUSED("scope_unavailable"));
    expect(hook).toHaveBeenCalledTimes(1);
    expect(await read({ scope: { ...scope, teamId: randomUUID() } }, { afterFirstRead: hook })).toEqual(REFUSED("scope_unavailable"));
    expect(await read({ scope: { ...scope, channelId: "C0NEVER" } }, { afterFirstRead: hook })).toEqual(REFUSED("scope_unavailable"));
    expect(hook).toHaveBeenCalledTimes(3);
    await page(scope, {}, { afterFirstRead: hook });
    expect(hook).toHaveBeenCalledTimes(4);
  });

  it("propagates a hook failure: no page and no refusal escapes", async () => {
    const seed = await seedTeam();
    const scope = await verifiedScope(seed);
    await item(seed.teamId, await project(seed.teamId), id(1), `slack/c0abc/${ROOT}.md`);
    const boom = new Error("census-fixture-hook-failure");
    await expect(read({ scope }, { afterFirstRead: async () => { throw boom; } })).rejects.toBe(boom);
    // The pool is healthy afterwards: the failed transaction was rolled back, not leaked.
    expect(entryIds(await page(scope))).toEqual([id(1)]);
  });

  it("a SQL failure after the first read rejects the invocation — never an empty successful page", async () => {
    const seed = await seedTeam();
    const scope = await verifiedScope(seed);
    await item(seed.teamId, await project(seed.teamId), id(1), `slack/c0abc/${ROOT}.md`);
    let failedInsideHook: unknown = null;
    const outcome = await read({ scope }, {
      afterFirstRead: async (query) => {
        // A REAL failing SELECT, caught here so the hook itself returns normally. PostgreSQL has now
        // aborted the transaction; the reader's next own statement is what must fail.
        failedInsideHook = await query("select 1 from slack_repair_census_no_such_relation").then(
          () => null,
          (error: unknown) => error
        );
      },
    }).then(
      (value) => ({ returned: value }),
      (error: unknown) => ({ error: error as Loose })
    );
    expect(failedInsideHook).toMatchObject({ code: "42P01" });
    expect(outcome).not.toHaveProperty("returned");
    expect((outcome as { error: Loose }).error).toMatchObject({ code: "25P02" });
    expect(entryIds(await page(scope))).toEqual([id(1)]);
  });

  it("times out a blocked first scope read with 57014 and never reaches the hook", { timeout: 15_000 }, async () => {
    const seed = await seedTeam();
    const scope = await verifiedScope(seed);
    await load("lib/ingest/slack-repair-census-read.ts");
    const hook = vi.fn(async () => {});
    const locker = new Client({ connectionString: process.env.DATABASE_URL });
    await locker.connect();
    try {
      await locker.query("begin");
      await locker.query("set local lock_timeout = '2s'");
      await locker.query("lock table integrations in access exclusive mode");
      const started = Date.now();
      await expect(read({ scope }, { afterFirstRead: hook })).rejects.toMatchObject({ code: "57014" });
      const elapsed = Date.now() - started;
      expect(elapsed).toBeGreaterThanOrEqual(4_500);
      expect(elapsed).toBeLessThan(10_000);
      expect(hook).not.toHaveBeenCalled();
    } finally {
      await locker.query("rollback").catch(() => {});
      await locker.end();
    }
    expect((await page(scope)).scannedItems).toBe(0);
  });

  it("times out the reader's own item read with 57014 instead of returning a truncated page", { timeout: 15_000 }, async () => {
    const seed = await seedTeam();
    const scope = await verifiedScope(seed);
    await item(seed.teamId, await project(seed.teamId), id(1), `slack/c0abc/${ROOT}.md`);
    await load("lib/ingest/slack-repair-census-read.ts");
    const before = await tables();
    const locker = new Client({ connectionString: process.env.DATABASE_URL });
    await locker.connect();
    let locked = 0;
    try {
      const started = Date.now();
      const outcome = await read({ scope }, {
        afterFirstRead: async () => {
          // After the scope read, before the item scan. A short lock_timeout turns "the reader had
          // already touched items" into a loud fixture failure instead of a mutual wait.
          await locker.query("begin");
          await locker.query("set local lock_timeout = '2s'");
          await locker.query("lock table items in access exclusive mode");
          locked += 1;
        },
      }).then(
        (value) => ({ returned: value }),
        (error: unknown) => ({ error: error as Loose })
      );
      const elapsed = Date.now() - started;
      expect(locked).toBe(1);
      expect(outcome).not.toHaveProperty("returned");
      expect((outcome as { error: Loose }).error).toMatchObject({ code: "57014" });
      expect(elapsed).toBeGreaterThanOrEqual(4_500);
      expect(elapsed).toBeLessThan(10_000);
    } finally {
      await locker.query("rollback").catch(() => {});
      await locker.end();
    }
    expect(await tables()).toEqual(before);
    expect(entryIds(await page(scope))).toEqual([id(1)]);
  });
});
