import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";

import { TransactionExecutionError } from "@/lib/db/pg/tx";
import type { SqlExecutor, TransactionSession } from "@/lib/db/types";
import { setMemberIdentity } from "@/lib/identity/member-identities";
import { ingestItem } from "@/lib/ingest";
import {
  createSlackKnownRootExecution,
  readSlackKnownRootItemPage,
  type SlackKnownRootEntry,
  type SlackKnownRootExecution,
  type SlackKnownRootItemPage,
} from "@/lib/ingest/slack-known-root-page";
import {
  classifySlackKnownRootPreparationFailure,
  prepareSlackKnownRootRequeue,
  tallySlackKnownRootPage,
  type SlackKnownRootPreparationResult,
  type SlackKnownRootReceipt,
} from "@/lib/ingest/slack-known-root-requeue";
import { invalidateSlackNamespaceGate, prepareNewSlackChannelNamespace } from "@/lib/ingest/slack-namespace-gate";
import { slackPublicationOption } from "@/lib/ingest/slack-publication";
import { lockSlackSelection, resolveEnvSlackToken, slackBindingRef } from "@/lib/ingest/slack-source-binding";
import { discoverSlackSource } from "@/lib/ingest/slack-source-discovery";
import {
  checkpointSlackThread,
  claimSlackThread,
  enqueueSlackThread,
  releaseSlackThreadForRetry,
  writeSlackThreadSnapshot,
  type SlackThreadClaim,
} from "@/lib/ingest/slack-thread-state";
import type { SlackMessage } from "@/lib/ingest/sources/slack";
import { parseSlackTimestamp, type SlackEvidenceUser } from "@/lib/ingest/sources/slack-message-evidence";
import { scopedSlackItemPath } from "@/lib/ingest/sources/slack-namespace";
import { normalizeThread } from "@/lib/ingest/sources/slack-normalize";
import { runContextTransaction, transactionCapability } from "@/lib/projects/context/transaction";
import { encryptSecret } from "@/lib/secrets/crypto";
import { db, ingest, seedTeam, transactionSessionDecoratedDb, type Seed } from "./helpers";
import {
  authTestBody,
  channelInfoBody,
  channelRow,
  closeRawSql,
  elapse,
  fakeSlack,
  historyBody,
  rawSql,
  requireSlackSourceTables,
  rootMessage,
  seedSlackIntegration,
  slackJson,
  type SlackCall,
  type SlackFake,
} from "./slack-source-helpers";

/**
 * AIO-1170 AC-02 — the inactive known-root requeue packet on REAL Postgres
 * (`docs/design/slack-known-root-requeue-spec.md` §2, §11; KR-01 and the permanent characterization).
 *
 * The gap, reproduced with the product's own writers: a root is published through the real
 * `ingestItem` publication, which deletes its queue row and its staging; the channel's history is
 * complete; and from then on a newest-history pass that does not happen to contain that root
 * schedules nothing for it. A later remote reply changes no local durable state, so nothing ever
 * brings the root back.
 *
 * HISTORY. The first three cases below were written at the first red checkpoint, when the two new
 * modules were typed stubs that did no work; both modules are implemented now, and all three pass.
 * The first case is a permanent CHARACTERIZATION of the gap and passed before and after this slice.
 * The other two were behavioural red against the stubs: they imported, set up, connected and ran
 * normally, and failed only on the assertion that the enumeration found the published root and that
 * preparation rebuilt its pending row. The later groups in this file state their own history.
 *
 * Fixture rules:
 *  - The published root is reached through the real discovery entrypoint (a verified binding), the
 *    real readiness producer, the real thread-state writers and the real publication. Its FIRST
 *    queue row is enqueued by the fixture, exactly as the publication suite does; that is how the
 *    root comes to be published at all, and is not a revisit producer.
 *  - Preparation is given the team and an entry the enumeration returned, and nothing else. The
 *    constants below are used to BUILD the fixture and to CHECK what enumeration returned; none is
 *    ever handed to the preparer.
 *  - Elapsed time is a fixture: the root witness's observation is aged in place so the revisit
 *    interval has passed. No application path does that.
 */

vi.setConfig({ testTimeout: 30_000 });

const WORKSPACE = "T0SOURCE1";
const CHANNEL = "C0KNOWN1170";
const OLD_ROOT = "1718900000.000100";
const OLD_REPLY = "1718900000.000101";
const USERS = { U1: { displayName: "Person One", isBot: false, isAppUser: false } };
const ROOT_MESSAGE: SlackMessage = { ts: OLD_ROOT, user: "U1", text: "root" };
const REPLY_MESSAGE: SlackMessage = { ts: OLD_REPLY, thread_ts: OLD_ROOT, user: "U1", text: "reply" };
const REVISIT_AFTER_MS = 60_000;

beforeAll(requireSlackSourceTables);
afterAll(closeRawSql);

const tx = <T>(fn: (session: TransactionSession) => Promise<T>): Promise<T> => transactionCapability(db()).transaction(fn);

type Row = Record<string, unknown>;

async function query<T extends Row = Row>(text: string, params: unknown[] = []): Promise<T[]> {
  return (await (await rawSql()).query<T>(text, params)).rows;
}

interface Published {
  seed: Seed;
  integrationId: string;
  fake: SlackFake;
  /** Replace what the fake provider answers `conversations.history` with. */
  answerHistory: (handler: (call: SlackCall) => readonly Record<string, unknown>[]) => void;
  itemId: string;
  /** Facts the fixture observed while building, for CHECKING enumeration output only. */
  namespaceRevision: number;
}

/** One thread as the provider returns it, and the workspace directory its authors are classified with. */
interface PublishedThread {
  root: SlackMessage;
  replies: readonly SlackMessage[];
  users: Readonly<Record<string, SlackEvidenceUser>>;
}
/** The thread every fixture publishes unless it supplies its own: one human's root and that human's reply. */
const DEFAULT_THREAD: PublishedThread = { root: ROOT_MESSAGE, replies: [REPLY_MESSAGE], users: USERS };

/**
 * A canonical old root, published through the real publication into a channel whose history is
 * complete. The thread is the default one unless the caller supplies another; its root is always
 * `OLD_ROOT`, and nothing else about the fixture varies with it.
 */
async function publishOldRoot(thread: PublishedThread = DEFAULT_THREAD): Promise<Published> {
  const seed = await seedTeam();
  const integrationId = await seedSlackIntegration(seed, { channelIds: [CHANNEL], token: "xoxb-synthetic-known-root" });
  let history: (call: SlackCall) => readonly Record<string, unknown>[] = () => [];
  const fake = fakeSlack({
    "auth.test": () => slackJson(authTestBody({ app_id: "A0SOURCE1" })),
    "conversations.info": () => slackJson(channelInfoBody(CHANNEL)),
    "conversations.history": (call) => slackJson(historyBody({ messages: history(call) })),
  });
  // The initial history scan is empty and terminal: the channel's history is complete from here on.
  const discovered = await discoverSlackSource(
    { db: db(), teamId: seed.teamId, integrationId },
    { fetchImpl: fake.impl, envToken: () => null }
  );
  expect(discovered.binding?.state, "fixture: the binding verified").toBe("verified");
  const gate = await tx((s) => prepareNewSlackChannelNamespace(s, { teamId: seed.teamId, rawChannelId: CHANNEL }));
  if (gate.outcome !== "ready") throw new Error("fixture: the namespace is not ready");
  const selection = await tx((s) => lockSlackSelection(s, { teamId: seed.teamId, integrationId, envToken: () => null }));
  if (selection.outcome !== "current") throw new Error("fixture: the selection is not current");

  // The root's first queue row, its claim and its complete staged snapshot — the state a hydrator
  // leaves behind — and then the real publication.
  const scope = { teamId: seed.teamId, workspaceId: WORKSPACE, channelId: CHANNEL, rootTs: OLD_ROOT };
  await tx((s) => enqueueSlackThread(s, scope));
  const acquired = await tx((s) => claimSlackThread(s, scope, { leaseMs: 900_000 }));
  if (!acquired) throw new Error("fixture: the claim was refused");
  const staged = await tx(async (s) => {
    const written = await writeSlackThreadSnapshot(s, acquired, {
      messages: [thread.root, ...thread.replies], complete: true, expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    });
    if (written !== "written") throw new Error("fixture: the snapshot was refused");
    return checkpointSlackThread(s, acquired, { pageCursor: null, snapshotGeneration: 1 });
  });
  if (staged.outcome !== "checkpointed") throw new Error("fixture: the checkpoint was refused");
  const claim: SlackThreadClaim = { ...acquired, snapshotGeneration: 1 };
  const option = slackPublicationOption({
    claim, binding: slackBindingRef(selection.selection), namespaceRevision: gate.gate.revision, channelName: "general", users: thread.users,
  });
  // The display names publication renders with: each directory record's name, or its id.
  const displayNames = Object.fromEntries(Object.entries(thread.users).map(([id, user]) => [id, user.displayName ?? id]));
  const normalized = normalizeThread({ root: thread.root, replies: [...thread.replies] }, {
    channelId: CHANNEL, channelName: "general", users: displayNames, project: "slack",
  });
  const payload = {
    ...normalized,
    path: scopedSlackItemPath(WORKSPACE, CHANNEL, OLD_ROOT),
    frontmatter: { ...normalized.frontmatter, workspace_id: WORKSPACE, source_ts: parseSlackTimestamp(OLD_ROOT)!.iso },
  };
  const auth = { teamId: seed.teamId, memberId: seed.memberId, apiKeyId: randomUUID() };
  const published = await ingestItem(db(), auth, payload, "team", { authorMemberId: null }, "team", option);
  expect(published, "fixture: the real publication created the item").toMatchObject({ status: "created" });

  const items = await query<{ id: string }>(`select id::text as id from items where team_id = $1 and path = $2`, [
    seed.teamId, scopedSlackItemPath(WORKSPACE, CHANNEL, OLD_ROOT),
  ]);
  expect(items, "fixture: exactly one canonical item").toHaveLength(1);
  return {
    seed, integrationId, fake, itemId: items[0].id, namespaceRevision: gate.gate.revision,
    answerHistory: (handler) => { history = handler; },
  };
}

/** What is durably stored for the old root: its queue row, its staging, and its ledger evidence. */
async function stored(teamId: string): Promise<{ queue: Row[]; allQueue: Row[]; snapshots: number; ledger: Row[] }> {
  const allQueue = await query(
    `select workspace_id, channel_id, root_ts, status, attempts,
            due_at <= clock_timestamp() as due
       from slack_sync_threads where team_id = $1 order by root_ts`, [teamId]
  );
  const snapshots = (await query<{ n: number }>(`select count(*)::int as n from slack_thread_snapshots where team_id = $1`, [teamId]))[0].n;
  const ledger = await query(
    `select message_ts, root_ts, is_root, item_id::text as item_id, deleted_at is null as live
       from slack_messages where team_id = $1 order by message_ts`, [teamId]
  );
  return { queue: allQueue.filter((row) => row.root_ts === OLD_ROOT), allQueue, snapshots, ledger };
}

/** A root one second below the request's own upper bound: recent, and inside what was asked for. */
function recentRootFor(call: SlackCall): string {
  const latest = /^([0-9]+)[.]([0-9]{6})$/.exec(call.params.get("latest") ?? "");
  const seconds = latest ? Number(latest[1]) - 1 : Math.floor(Date.now() / 1000) - 1;
  return `${seconds}.000001`;
}

/**
 * Run newest-history passes until the provider has been asked for history once more, answering
 * every request with ONE recent root and never the old one. Returns every recent root it served.
 */
async function newestPassOmittingOldRoot(f: Published): Promise<string[]> {
  const served = new Set<string>();
  f.answerHistory((call) => {
    const recent = recentRootFor(call);
    served.add(recent);
    return [rootMessage(recent)];
  });
  const before = f.fake.countOf("conversations.history");
  for (let pass = 0; pass < 4 && f.fake.countOf("conversations.history") === before; pass++) {
    await elapse(f.seed.teamId);
    await discoverSlackSource(
      { db: db(), teamId: f.seed.teamId, integrationId: f.integrationId },
      { fetchImpl: f.fake.impl, envToken: () => null }
    );
  }
  expect(f.fake.countOf("conversations.history"), "fixture: a newest-history page was requested").toBeGreaterThan(before);
  expect(served.has(OLD_ROOT), "fixture: the old root was never served again").toBe(false);
  return [...served].sort();
}

/**
 * An unrelated item of the same team that is not Slack's at all: another project, another source,
 * written through ordinary ingest. Enumeration examines EVERY team item, so it must come back as an
 * entry of its own — unlocated, `not_slack` — and never be skipped in search of a Slack root.
 */
async function seedUnrelatedItem(seed: Seed): Promise<string> {
  const created = await ingest(seed, {
    project: "notes", path: `notes/unrelated-${randomUUID().slice(0, 8)}.md`, body: "an unrelated note", access: "team",
    frontmatter: { source: "github" },
  });
  expect(created.status, "fixture: the unrelated item was created").toBe("created");
  const [row] = await query<{ source: string | null; path: string }>(
    `select frontmatter->>'source' as source, path from items where team_id = $1 and id = $2`, [seed.teamId, created.id]
  );
  expect(row, "fixture: the unrelated item is stored, and is not a Slack item").toMatchObject({ source: "github" });
  expect(row.path.startsWith("slack/")).toBe(false);
  return created.id;
}

/** FIXTURE CLOCK: the stored observation of this team's ledger rows, moved two hours into the past. */
async function ageObservation(teamId: string): Promise<void> {
  const aged = await (await rawSql()).query(
    `update slack_messages set observed_at = observed_at - interval '2 hours' where team_id = $1`, [teamId]
  );
  expect(aged.rowCount, "fixture: the ledger observation was aged").toBeGreaterThan(0);
}

const enumerate = (teamId: string): Promise<SlackKnownRootItemPage> =>
  tx((s) => readSlackKnownRootItemPage(
    s, { teamId, pageSize: 100, revisitAfterMs: REVISIT_AFTER_MS }, createSlackKnownRootExecution({ ambientDeadlineAt: null })
  ));

describe("a published old root that newest history no longer returns (real Postgres)", () => {
  // PERMANENT CHARACTERIZATION — passes before and after this slice. It is the evidence of the gap,
  // not a red-to-green proof: discovery alone never revisits a completed root.
  it("is left with no pending work by discovery alone: publication deleted its queue row and staging, and a newest pass that omits it schedules nothing", async () => {
    const f = await publishOldRoot();
    const channel = await channelRow(f.seed.teamId, WORKSPACE, CHANNEL);
    expect(channel, "fixture: the channel's history is complete").toMatchObject({ historical_floor_reached: true, public_state: "public" });

    // The real publication committed the item and its ledger, and acknowledged by DELETING the queue
    // row; the staged snapshot went with it.
    const afterPublication = await stored(f.seed.teamId);
    expect(afterPublication.allQueue, "publication deleted the queue row").toEqual([]);
    expect(afterPublication.snapshots, "publication deleted the staging").toBe(0);
    expect(afterPublication.ledger).toEqual([
      { message_ts: OLD_ROOT, root_ts: OLD_ROOT, is_root: true, item_id: f.itemId, live: true },
      { message_ts: OLD_REPLY, root_ts: OLD_ROOT, is_root: false, item_id: f.itemId, live: true },
    ]);

    // Newest history returns only a recent root. Discovery accepts the page and enqueues THAT root…
    const recent = await newestPassOmittingOldRoot(f);
    expect(recent.length).toBeGreaterThan(0);
    const afterNewest = await stored(f.seed.teamId);
    expect(afterNewest.allQueue.map((row) => row.root_ts), "the newest pass enqueued what it was served, and only that").toEqual(recent);
    // …and the old root remains exactly as publication left it: published, and unscheduled.
    expect(afterNewest.queue, "the old root has no pending work").toEqual([]);
    expect(afterNewest.snapshots).toBe(0);
    expect(afterNewest.ledger).toEqual(afterPublication.ledger);

    // Time passing changes nothing either: there is no producer for a completed root.
    await ageObservation(f.seed.teamId);
    await newestPassOmittingOldRoot(f);
    expect((await stored(f.seed.teamId)).queue, "the old root is still unscheduled after a further pass").toEqual([]);
  });

  // WAS BEHAVIOURAL RED against the stub reader, which returned a placeholder page with no entries.
  it("is found by enumeration, with the exact durable locator of its published item", async () => {
    const f = await publishOldRoot();
    const unrelatedItemId = await seedUnrelatedItem(f.seed);
    const channel = await channelRow(f.seed.teamId, WORKSPACE, CHANNEL);
    const teamItems = (await query<{ n: number }>(`select count(*)::int as n from items where team_id = $1`, [f.seed.teamId]))[0].n;
    expect(teamItems, "fixture: the team has the published root AND an unrelated item").toBeGreaterThanOrEqual(2);
    // The expected revision below is a real stored one, not an absent value two `undefined`s would agree on.
    expect(channel?.binding_config_revision, "fixture: the channel row stores a configuration revision").toMatch(/^[0-9a-f]{64}$/);

    const page = await enumerate(f.seed.teamId);

    // One entry per examined item, and the published root's entry carries exactly what was durably
    // recorded for it: provider ids byte-exact from the item, the binder from the channel row, the
    // namespace revision from the gate.
    const located = page.entries.filter((entry) => "locator" in entry);
    expect(located).toEqual([
      {
        teamId: f.seed.teamId,
        itemId: f.itemId,
        revisitAfterMs: REVISIT_AFTER_MS,
        locator: {
          workspaceId: WORKSPACE,
          channelId: CHANNEL,
          rootTs: OLD_ROOT,
          integrationId: f.integrationId,
          bindingConfigRevision: channel?.binding_config_revision,
          namespaceRevision: f.namespaceRevision,
        },
      },
    ]);
    expect(channel?.binding_integration_id, "fixture: the channel is bound to the seeded integration").toBe(f.integrationId);
    // The unrelated item is an entry too — exactly this one, with the closed reason it has no locator.
    expect(page.entries.filter((entry) => entry.itemId === unrelatedItemId)).toEqual([
      { teamId: f.seed.teamId, itemId: unrelatedItemId, revisitAfterMs: REVISIT_AFTER_MS, unlocated: "not_slack" },
    ]);
    // Every other examined item is unlocated as well: the published root is the page's only locator.
    for (const entry of page.entries) {
      if (entry.itemId !== f.itemId) expect(entry, entry.itemId).toHaveProperty("unlocated");
    }
    expect(page.examined).toBe(teamItems);
    expect(page.entries).toHaveLength(teamItems);
    expect(page).toMatchObject({ exhausted: true, nextCursor: null });
    // Enumeration only reads: it created no work and changed no evidence.
    expect((await stored(f.seed.teamId)).allQueue).toEqual([]);
  });

  // WAS BEHAVIOURAL RED (KR-01). Against the stub reader there was no entry to prepare; against a
  // real reader and the no-op stub preparer there was an entry and still no row. Either way the
  // failing assertion was the same one: the old root's pending row was not rebuilt.
  it("gets exactly one due pending row back from preparation, given only the team and its enumerated entry", async () => {
    const f = await publishOldRoot();
    const unrelatedItemId = await seedUnrelatedItem(f.seed);
    const recent = await newestPassOmittingOldRoot(f);
    await ageObservation(f.seed.teamId);
    const before = await stored(f.seed.teamId);
    expect(before.queue, "fixture: the old root has no pending work").toEqual([]);

    // Enumerate on its own transaction, then prepare every entry on its own transaction — from the
    // team and the entry alone. No workspace, channel, root, integration or revision is supplied here.
    const page = await enumerate(f.seed.teamId);
    const results: { entry: SlackKnownRootEntry; result: SlackKnownRootPreparationResult }[] = [];
    for (const entry of page.entries) {
      const result = await tx((s) => prepareSlackKnownRootRequeue(
        s, { teamId: f.seed.teamId, entry }, createSlackKnownRootExecution({ ambientDeadlineAt: null })
      ));
      results.push({ entry, result });
    }

    const after = await stored(f.seed.teamId);
    // Exactly one row for the old root, queued, never attempted, and due now.
    expect(after.queue).toEqual([
      { workspace_id: WORKSPACE, channel_id: CHANNEL, root_ts: OLD_ROOT, status: "queued", attempts: 0, due: true },
    ]);
    // Its due instant is the witness's observation plus the revisit interval, rounded up to the
    // millisecond — not the moment preparation happened to run.
    const [derivation] = await query<{ derived: boolean }>(
      `select t.due_at >= w.observed_at + interval '60 seconds'
              and t.due_at < w.observed_at + interval '60 seconds' + interval '1 millisecond' as derived
         from slack_sync_threads t
         join slack_messages w
           on w.team_id = t.team_id and w.workspace_id = t.workspace_id and w.channel_id = t.channel_id
          and w.message_ts = t.root_ts and w.is_root
        where t.team_id = $1 and t.root_ts = $2`, [f.seed.teamId, OLD_ROOT]
    );
    expect(derivation?.derived, "the due instant derives from the stored observation").toBe(true);
    // The root's own entry reports the insertion; nothing else was scheduled or disturbed.
    const mine = results.filter(({ entry }) => entry.itemId === f.itemId);
    expect(mine.map(({ result }) => result)).toEqual([{ outcome: "enqueued" }]);
    // The unrelated item was prepared like every other entry, and is unattested for this observation.
    expect(results.filter(({ entry }) => entry.itemId === unrelatedItemId).map(({ result }) => result)).toEqual([
      { outcome: "unattested", reason: "not_slack" },
    ]);
    expect(after.allQueue.map((row) => row.root_ts).sort()).toEqual([OLD_ROOT, ...recent].sort());
    expect(after.snapshots).toBe(0);
    expect(after.ledger).toEqual(before.ledger);

    // Replay on fresh transactions: the single durable row is preserved, and reported as pending.
    const replay = await enumerate(f.seed.teamId);
    for (const entry of replay.entries.filter((candidate) => candidate.itemId === f.itemId)) {
      expect(await tx((s) => prepareSlackKnownRootRequeue(
        s, { teamId: f.seed.teamId, entry }, createSlackKnownRootExecution({ ambientDeadlineAt: null })
      ))).toEqual({ outcome: "already_pending" });
    }
    expect((await stored(f.seed.teamId)).queue).toEqual(after.queue);
  });
});

/**
 * Source review of the implemented primitive: two findings only a real database can show.
 *
 * Both start from a root that is published, enumerated and otherwise fully preparable, and then
 * change ONE stored fact through fixture DML — a state no application writer produces, which is
 * exactly why preparation has to read it defensively. The entry handed to the preparer is always the
 * one enumeration returned BEFORE the change; nothing else is supplied.
 */
describe("a published root whose stored facts were corrupted after enumeration (real Postgres)", () => {
  async function locatedEntryOf(f: Published): Promise<SlackKnownRootEntry> {
    const page = await enumerate(f.seed.teamId);
    const entry = page.entries.find((candidate) => candidate.itemId === f.itemId && "locator" in candidate);
    if (!entry) throw new Error("fixture: enumeration did not locate the published root");
    return entry;
  }

  const prepare = (f: Published, entry: SlackKnownRootEntry): Promise<SlackKnownRootPreparationResult> =>
    tx((s) => prepareSlackKnownRootRequeue(s, { teamId: f.seed.teamId, entry }, createSlackKnownRootExecution({ ambientDeadlineAt: null })));

  async function storedFrontmatter(itemId: string): Promise<Record<string, unknown>> {
    const [row] = await query<{ frontmatter: Record<string, unknown> }>(`select frontmatter from items where id = $1`, [itemId]);
    return row.frontmatter;
  }

  // EXPECTED RED at the source-reviewed checkpoint: every corrupted value below is currently
  // reported as `canonical_mismatch`.
  //
  // What the specification says LITERALLY, in §6, is about size: "Oversized stored values are
  // `invalid_metadata`, never silently truncated into accepted identities", with bounds of 256 bytes
  // per provider id and 128 bytes per timestamp. The over-bound rows below are that sentence.
  //
  // The WRONG-TYPE rows are not a quotation. §6 requires new projections to "check JSON string types
  // and byte lengths before returning values" and names no reason for a value that fails the type
  // check. Reporting it as `invalid_metadata` too is the accepted, consistent fail-closed
  // classification from the source review: the same projection rejects both, and a value that is not
  // a string is no more a DIFFERENT identity than one that is too long — it is no identity at all.
  //
  // The distinction matters to whoever reads the counts: a mismatch says "this item belongs to
  // another thread", invalid metadata says "this item's stored metadata is unusable", and the two
  // call for different repairs.
  //
  // NOT COVERED HERE, deliberately: a stored value that IS a string, IS within its bound, and is
  // syntactically invalid — a workspace id with a space in it, a `ts` the exact parser refuses. The
  // accepted findings do not say whether that is `invalid_metadata` or `canonical_mismatch`, and
  // this focused red does not choose. It remains a later KR-16 case.
  it("reports a locked item whose stored locator metadata is of the wrong type or past its byte bound as invalid_metadata, not as a mismatch", async () => {
    const f = await publishOldRoot();
    await ageObservation(f.seed.teamId);
    const entry = await locatedEntryOf(f);
    const original = await storedFrontmatter(f.itemId);
    for (const key of ["workspace_id", "channel_id", "ts", "thread_ts"]) expect(typeof original[key], `fixture: stored ${key} is a string`).toBe("string");

    const corruptions: [string, string, unknown][] = [
      ["a numeric workspace_id", "workspace_id", 12345],
      ["an object workspace_id", "workspace_id", { id: WORKSPACE }],
      ["a workspace_id of 257 bytes", "workspace_id", "T".repeat(257)],
      ["an array channel_id", "channel_id", [CHANNEL]],
      ["a boolean channel_id", "channel_id", false],
      ["a channel_id of 257 bytes", "channel_id", "C".repeat(257)],
      ["a numeric ts", "ts", 1718900000.0001],
      ["a ts of 257 bytes", "ts", "1".repeat(257)],
      ["a null thread_ts", "thread_ts", null],
      ["an array thread_ts", "thread_ts", [OLD_ROOT]],
      ["a thread_ts of 257 bytes", "thread_ts", "1".repeat(257)],
    ];
    for (const [label, key, value] of corruptions) {
      const changed = await (await rawSql()).query(
        `update items set frontmatter = jsonb_set(frontmatter, array[$2::text], $3::jsonb, true) where id = $1`,
        [f.itemId, key, JSON.stringify(value)]
      );
      expect(changed.rowCount, `fixture: ${label} was stored`).toBe(1);
      expect((await storedFrontmatter(f.itemId))[key], `fixture: ${label} reads back`).toEqual(value);

      const result = await prepare(f, entry);
      expect.soft(result, label).toEqual({ outcome: "unattested", reason: "invalid_metadata" });
      // Whatever it is called, it is never work: nothing was enqueued for the root.
      expect((await stored(f.seed.teamId)).queue, `${label}: nothing was enqueued`).toEqual([]);

      await (await rawSql()).query(`update items set frontmatter = $2::jsonb where id = $1`, [f.itemId, JSON.stringify(original)]);
      expect(await storedFrontmatter(f.itemId), "fixture: the stored frontmatter was put back").toEqual(original);
    }

    // CONTROLS (expected green) — exactly AT the bound. A string of exactly 256 bytes in a provider
    // id, or exactly 128 bytes in a timestamp, is within the bound: it is a real, well-typed,
    // syntactically valid value that simply is not this root's, so it is a mismatch and not invalid
    // metadata. Each value below is valid for its field's own syntax — the ids are ASCII
    // alphanumeric, and the timestamps are the root's own instant written with leading zeros, which
    // the exact parser accepts and which is a different string of bytes. So none of them is the
    // undecided "in-bound but syntactically invalid" case described above.
    const paddedRoot = `${"0".repeat(128 - OLD_ROOT.length)}${OLD_ROOT}`;
    expect(Buffer.byteLength(paddedRoot, "utf8"), "fixture: the padded timestamp is exactly 128 bytes").toBe(128);
    expect(parseSlackTimestamp(paddedRoot)?.iso, "fixture: the exact parser accepts it, as the same instant").toBe(parseSlackTimestamp(OLD_ROOT)!.iso);
    const atBound: [string, string, string][] = [
      ["a workspace_id of exactly 256 bytes", "workspace_id", `T${"0".repeat(255)}`],
      ["a channel_id of exactly 256 bytes", "channel_id", `C${"0".repeat(255)}`],
      ["a ts of exactly 128 bytes", "ts", paddedRoot],
      ["a thread_ts of exactly 128 bytes", "thread_ts", paddedRoot],
    ];
    for (const [label, key, value] of atBound) {
      const bound = key === "ts" || key === "thread_ts" ? 128 : 256;
      expect(Buffer.byteLength(value, "utf8"), `fixture: ${label}`).toBe(bound);
      const changed = await (await rawSql()).query(
        `update items set frontmatter = jsonb_set(frontmatter, array[$2::text], $3::jsonb, true) where id = $1`,
        [f.itemId, key, JSON.stringify(value)]
      );
      expect(changed.rowCount, `fixture: ${label} was stored`).toBe(1);
      expect((await storedFrontmatter(f.itemId))[key], `fixture: ${label} reads back`).toBe(value);

      expect(await prepare(f, entry), label).toEqual({ outcome: "unattested", reason: "canonical_mismatch" });
      expect((await stored(f.seed.teamId)).queue, `${label}: nothing was enqueued`).toEqual([]);

      await (await rawSql()).query(`update items set frontmatter = $2::jsonb where id = $1`, [f.itemId, JSON.stringify(original)]);
      expect(await storedFrontmatter(f.itemId), "fixture: the stored frontmatter was put back").toEqual(original);
    }

    // CONTROLS (expected green). A well-typed, in-bound value that simply DIFFERS is a mismatch —
    // here the workspace changed only by case, which no path comparison could tell apart…
    await (await rawSql()).query(
      `update items set frontmatter = jsonb_set(frontmatter, '{workspace_id}', $2::jsonb) where id = $1`,
      [f.itemId, JSON.stringify(WORKSPACE.toLowerCase())]
    );
    expect(await prepare(f, entry)).toEqual({ outcome: "unattested", reason: "canonical_mismatch" });
    expect((await stored(f.seed.teamId)).queue).toEqual([]);
    // …and with the original metadata back, the very same entry prepares. Nothing above was refused
    // for a reason other than the one value that was changed.
    await (await rawSql()).query(`update items set frontmatter = $2::jsonb where id = $1`, [f.itemId, JSON.stringify(original)]);
    expect(await prepare(f, entry)).toEqual({ outcome: "enqueued" });
    expect((await stored(f.seed.teamId)).queue).toHaveLength(1);
  });

  // EXPECTED RED at checkpoint b075dfba (affected-fix review). The item lock projects `path` through
  // the same 2,048-byte bound §6 states for paths, and returns NULL for a longer one — but the result
  // is then only COMPARED with the canonical path, so an over-bound path is reported as a mismatch.
  // §6: "Oversized stored values are `invalid_metadata`". A path past its bound is not a different
  // canonical path; it is a stored value this primitive refuses to read at all.
  it("reports a locked item whose stored path is past its 2,048-byte bound as invalid_metadata, and a different in-bound path as a mismatch", async () => {
    const f = await publishOldRoot();
    await ageObservation(f.seed.teamId);
    const entry = await locatedEntryOf(f);
    const canonicalPath = scopedSlackItemPath(WORKSPACE, CHANNEL, OLD_ROOT);
    const storedPath = async (): Promise<{ path: string; bytes: number }> =>
      (await query<{ path: string; bytes: number }>(`select path, octet_length(path)::int as bytes from items where id = $1`, [f.itemId]))[0];
    expect(await storedPath(), "fixture: the published item is at its canonical path").toEqual({
      path: canonicalPath, bytes: Buffer.byteLength(canonicalPath, "utf8"),
    });
    /** A path under the same scoped prefix, of exactly `bytes` bytes of ASCII, ending in `.md`. */
    const pathOf = (bytes: number): string => {
      const prefix = canonicalPath.slice(0, canonicalPath.lastIndexOf("/") + 1);
      return `${prefix}${"p".repeat(bytes - prefix.length - 3)}.md`;
    };
    const setPath = async (path: string): Promise<void> => {
      const changed = await (await rawSql()).query(`update items set path = $2 where id = $1`, [f.itemId, path]);
      expect(changed.rowCount, "fixture: the path was stored").toBe(1);
      expect(await storedPath(), "fixture: the path reads back, byte for byte").toEqual({ path, bytes: Buffer.byteLength(path, "utf8") });
    };

    // One byte past the bound.
    const overBound = pathOf(2_049);
    expect(Buffer.byteLength(overBound, "utf8")).toBe(2_049);
    await setPath(overBound);
    expect.soft(await prepare(f, entry), "a 2,049-byte path").toEqual({ outcome: "unattested", reason: "invalid_metadata" });
    expect((await stored(f.seed.teamId)).queue, "a 2,049-byte path: nothing was enqueued").toEqual([]);
    await setPath(canonicalPath);

    // CONTROLS (expected green). Exactly AT the bound, and comfortably inside it: a well-formed
    // stored path that simply is not the canonical one is a mismatch, not invalid metadata.
    const atBound = pathOf(2_048);
    expect(Buffer.byteLength(atBound, "utf8")).toBe(2_048);
    const controls: [string, string][] = [
      ["a different path of exactly 2,048 bytes", atBound],
      ["an in-bound path that is not the canonical one", `${canonicalPath.slice(0, -3)}.moved.md`],
      ["an in-bound path outside the Slack namespace", `notes/known-root-${OLD_ROOT}.md`],
    ];
    for (const [label, path] of controls) {
      await setPath(path);
      expect(await prepare(f, entry), label).toEqual({ outcome: "unattested", reason: "canonical_mismatch" });
      expect((await stored(f.seed.teamId)).queue, `${label}: nothing was enqueued`).toEqual([]);
      await setPath(canonicalPath);
    }

    // With the canonical path back, the very same entry prepares: nothing above was refused for a
    // reason other than the path that was stored.
    expect(await prepare(f, entry)).toEqual({ outcome: "enqueued" });
    expect((await stored(f.seed.teamId)).queue).toHaveLength(1);
  });

  // EXPECTED RED at the source-reviewed checkpoint: the due instant is the stored observation plus
  // the revisit interval, so an observation in the year 1, or before the common era, is "due" by
  // two thousand years — and the row is enqueued with that instant as its due_at. The queue is
  // claimed in due order, so one corrupt observation would sort ahead of every real root. A stored
  // observation that cannot be a real one must fail closed: no row, and no date from before the
  // epoch anywhere in the queue.
  it.each([
    ["in the year 0001", "0001-01-01 00:00:00+00"],
    // No offset on this one: the fixture connection's time zone is UTC, and the era suffix is last.
    ["before the common era", "0044-03-15 12:00:00 BC"],
  ])("fails closed on a root witness observed %s: nothing is enqueued and no ancient due date enters the queue", async (_label, observedAt) => {
    const f = await publishOldRoot();
    const entry = await locatedEntryOf(f);
    const changed = await (await rawSql()).query(
      `update slack_messages set observed_at = $2::timestamptz where team_id = $1 and is_root and message_ts = $3`,
      [f.seed.teamId, observedAt, OLD_ROOT]
    );
    expect(changed.rowCount, "fixture: the root witness's observation was replaced").toBe(1);
    // The stored value is FINITE and schema-valid: nothing but its implausibility distinguishes it.
    const [witness] = await query<{ finite: boolean; ancient: boolean; live: boolean }>(
      `select isfinite(observed_at) as finite, observed_at < timestamptz '1000-01-01 00:00:00+00' as ancient,
              deleted_at is null as live
         from slack_messages where team_id = $1 and is_root and message_ts = $2`, [f.seed.teamId, OLD_ROOT]
    );
    expect(witness).toEqual({ finite: true, ancient: true, live: true });

    let result: SlackKnownRootPreparationResult | null = null;
    let failure: unknown;
    try {
      result = await prepare(f, entry);
    } catch (error) {
      failure = error;
    }

    // No pending row for the root, and no due date from before the epoch for anything in the team.
    const after = await stored(f.seed.teamId);
    expect(after.queue, "nothing was enqueued for the root").toEqual([]);
    const [ancient] = await query<{ n: number }>(
      `select count(*)::int as n from slack_sync_threads where team_id = $1 and due_at < timestamptz '1970-01-01 00:00:00+00'`,
      [f.seed.teamId]
    );
    expect(ancient.n, "no queue row carries an ancient due date").toBe(0);

    if (result !== null) {
      // A closed refusal — never the insertion, never "work already exists", and never "not yet due":
      // by its own arithmetic this observation is due, so calling it not-due would be a guess.
      expect(["unattested", "refused"], "a closed refusal").toContain(result.outcome);
      expect(Object.keys(result).sort()).toEqual(["outcome", "reason"]);
    } else {
      // Or a thrown failure, static: it rolls the caller back and quotes nothing that was stored.
      expect(failure).toBeInstanceOf(Error);
      const text = `${(failure as Error).name}\n${(failure as Error).message}`;
      for (const leaked of ["0001-01-01", "0044", " BC", OLD_ROOT, WORKSPACE, CHANNEL, f.itemId]) expect(text).not.toContain(leaked);
      // Not only those spellings. The same instant can reach a message as an ISO string with a
      // negative or zero-padded year, as epoch seconds, or as the rounded due instant in epoch
      // milliseconds — whatever the database or the driver renders. Each of those is computed here,
      // from what is stored, and none may appear.
      for (const rendering of await renderingsOfStoredObservation(f)) {
        expect(text.includes(rendering), `the failure does not carry the rendering ${rendering.slice(0, 6)}…`).toBe(false);
      }
      // And it is one of the packet's own errors or a plain static one: its text is the same
      // whatever was stored, which the case after this one checks across both instants.
      expect(text).not.toMatch(/\d{6,}/);
    }
    // The ledger and the item are untouched, and the observation is still exactly what was stored.
    expect(after.ledger.map((row) => row.message_ts)).toEqual([OLD_ROOT, OLD_REPLY]);
    expect((await query(`select 1 from items where id = $1`, [f.itemId]))).toHaveLength(1);
  });

  /**
   * Every way the stored observation, and the due instant derived from it, can be rendered as text:
   * by the database (day, epoch seconds, rounded due milliseconds) and by JavaScript (the ISO string
   * of the due instant, which writes a year before the common era as a signed six-digit year).
   */
  async function renderingsOfStoredObservation(f: Published): Promise<string[]> {
    const [row] = await query<{ day: string; epoch_seconds: string; epoch_ms: string; due_ms: string }>(
      `select to_char(observed_at at time zone 'UTC', 'YYYY-MM-DD') as day,
              trunc(extract(epoch from observed_at)::numeric)::text as epoch_seconds,
              trunc(extract(epoch from observed_at)::numeric * 1000)::text as epoch_ms,
              ceil(extract(epoch from (observed_at + interval '60 seconds'))::numeric * 1000)::text as due_ms
         from slack_messages where team_id = $1 and is_root and message_ts = $2`, [f.seed.teamId, OLD_ROOT]
    );
    const digits = (value: string): string => value.replace(/^-/, "").replace(/\.0*$/, "");
    const due = new Date(Number(row.due_ms));
    const observed = new Date(Number(row.epoch_ms));
    const renderings = [
      row.day,
      digits(row.epoch_seconds), digits(row.epoch_ms), digits(row.due_ms),
      due.toISOString(), due.toISOString().slice(0, due.toISOString().indexOf("T")),
      observed.toISOString(), observed.toISOString().slice(0, observed.toISOString().indexOf("T")),
    ];
    // Fixture precondition: these really are long, specific strings, not a digit or two.
    for (const rendering of renderings) expect(rendering.length, `fixture: the rendering ${rendering} is specific`).toBeGreaterThanOrEqual(8);
    return [...new Set(renderings)];
  }

  // EXPECTED RED at the source-reviewed checkpoint, for the same reason as the two cases above, and
  // stated the strongest way: two DIFFERENT corrupt instants, in two different teams, must be refused
  // IDENTICALLY — the same closed result, or an error of the same class with byte-for-byte the same
  // message. An outcome that is the same for both cannot have been derived from either instant, or
  // from either team's ids, however a leak would have been spelled. Today one is enqueued and the
  // other is not, so they are not even the same kind of outcome.
  it("refuses two different corrupt observations identically: the same closed result, or the same static error", async () => {
    const outcomes: { observedAt: string; queue: Row[]; ancient: number; shape: Record<string, unknown> }[] = [];
    for (const observedAt of ["0001-01-01 00:00:00+00", "0044-03-15 12:00:00 BC"]) {
      const f = await publishOldRoot();
      const entry = await locatedEntryOf(f);
      const changed = await (await rawSql()).query(
        `update slack_messages set observed_at = $2::timestamptz where team_id = $1 and is_root and message_ts = $3`,
        [f.seed.teamId, observedAt, OLD_ROOT]
      );
      expect(changed.rowCount, `fixture: the witness of ${observedAt} was replaced`).toBe(1);

      let shape: Record<string, unknown>;
      try {
        shape = { kind: "result", result: await prepare(f, entry) };
      } catch (error) {
        const thrown = error as { name?: unknown; message?: unknown; constructor?: { name?: unknown } };
        shape = {
          kind: "error", isError: error instanceof Error, class: thrown?.constructor?.name,
          name: thrown?.name, message: thrown?.message,
        };
      }
      const [ancient] = await query<{ n: number }>(
        `select count(*)::int as n from slack_sync_threads where team_id = $1 and due_at < timestamptz '1970-01-01 00:00:00+00'`,
        [f.seed.teamId]
      );
      outcomes.push({ observedAt, queue: (await stored(f.seed.teamId)).queue, ancient: ancient.n, shape });
    }

    // No-enqueue proof, for each instant on its own.
    for (const outcome of outcomes) {
      expect.soft(outcome.queue, `${outcome.observedAt}: nothing was enqueued for the root`).toEqual([]);
      expect.soft(outcome.ancient, `${outcome.observedAt}: no queue row carries an ancient due date`).toBe(0);
      if (outcome.shape.kind === "result") {
        // Never the insertion, never existing work, and never "not yet due" for a value that is due.
        expect.soft(["unattested", "refused"], `${outcome.observedAt}: a closed refusal`).toContain((outcome.shape.result as SlackKnownRootPreparationResult).outcome);
      } else {
        expect.soft(outcome.shape.isError, `${outcome.observedAt}: a thrown failure is an Error`).toBe(true);
        expect.soft(typeof outcome.shape.message, `${outcome.observedAt}: with a message`).toBe("string");
      }
    }
    // The identity check: both instants, both teams, one outcome.
    expect(outcomes[1].shape, "the two corrupt observations are refused identically").toEqual(outcomes[0].shape);
  });

  // EXPECTED RED at checkpoint b075dfba (affected-fix review). The lower bound that keeps ancient
  // observations out admits the Unix epoch itself: an observation at exactly 1970-01-01T00:00:00Z
  // passes, and its root is enqueued with a due instant one revisit interval after the epoch — still
  // decades ahead of every real root in a queue that is claimed in due order. Zero is not an
  // observation either. The codebase's own exact parser already says so for Slack instants: epoch
  // seconds of zero or less are not a real message time, and are refused rather than planted in
  // 1970. An observation at the epoch must fail closed in exactly the way the year 0001 does — the
  // same closed outcome, no new reason — with nothing enqueued and nothing of the input repeated.
  it("fails closed on a root witness observed at exactly the Unix epoch, identically to an ancient one", async () => {
    const outcomes: { observedAt: string; queue: Row[]; early: number; shape: Record<string, unknown>; text: string }[] = [];
    for (const observedAt of ["1970-01-01 00:00:00+00", "0001-01-01 00:00:00+00"]) {
      const f = await publishOldRoot();
      const entry = await locatedEntryOf(f);
      const changed = await (await rawSql()).query(
        `update slack_messages set observed_at = $2::timestamptz where team_id = $1 and is_root and message_ts = $3`,
        [f.seed.teamId, observedAt, OLD_ROOT]
      );
      expect(changed.rowCount, `fixture: the witness of ${observedAt} was replaced`).toBe(1);
      // The stored value is finite, live and schema-valid, and — for the first instant — is zero.
      const [witness] = await query<{ finite: boolean; live: boolean; epoch_seconds: string }>(
        `select isfinite(observed_at) as finite, deleted_at is null as live,
                trunc(extract(epoch from observed_at)::numeric)::text as epoch_seconds
           from slack_messages where team_id = $1 and is_root and message_ts = $2`, [f.seed.teamId, OLD_ROOT]
      );
      expect(witness).toMatchObject({ finite: true, live: true });
      if (observedAt.startsWith("1970")) expect(witness.epoch_seconds, "fixture: the observation is exactly the epoch").toBe("0");
      else expect(Number(witness.epoch_seconds), "fixture: the comparison observation is ancient").toBeLessThan(0);

      let shape: Record<string, unknown>;
      let text = "";
      try {
        shape = { kind: "result", result: await prepare(f, entry) };
      } catch (error) {
        const thrown = error as { name?: unknown; message?: unknown; constructor?: { name?: unknown } };
        shape = {
          kind: "error", isError: error instanceof Error, class: thrown?.constructor?.name,
          name: thrown?.name, message: thrown?.message,
        };
        text = `${String(thrown?.name)}\n${String(thrown?.message)}`;
      }
      // Nothing due before any real Slack root could exist: the epoch's own due instant included.
      const [early] = await query<{ n: number }>(
        `select count(*)::int as n from slack_sync_threads where team_id = $1 and due_at < timestamptz '2000-01-01 00:00:00+00'`,
        [f.seed.teamId]
      );
      outcomes.push({ observedAt, queue: (await stored(f.seed.teamId)).queue, early: early.n, shape, text });
    }

    for (const outcome of outcomes) {
      expect.soft(outcome.queue, `${outcome.observedAt}: nothing was enqueued for the root`).toEqual([]);
      expect.soft(outcome.early, `${outcome.observedAt}: no queue row is due before the year 2000`).toBe(0);
      if (outcome.shape.kind === "result") {
        // A closed refusal: never the insertion, never existing work, never "not yet due".
        const result = outcome.shape.result as SlackKnownRootPreparationResult;
        expect.soft(["unattested", "refused"], `${outcome.observedAt}: a closed refusal`).toContain(result.outcome);
        expect.soft(Object.keys(result).sort(), `${outcome.observedAt}: an outcome and a reason, nothing else`).toEqual(["outcome", "reason"]);
      } else {
        // A thrown failure is static: no date, no epoch value, no identifier of the root.
        expect.soft(outcome.shape.isError, `${outcome.observedAt}: a thrown failure is an Error`).toBe(true);
        expect.soft(outcome.text, `${outcome.observedAt}: no long digit run`).not.toMatch(/\d{4,}/);
        for (const leaked of ["1970", "0001", "epoch", OLD_ROOT, WORKSPACE, CHANNEL]) {
          expect.soft(outcome.text.includes(leaked), `${outcome.observedAt}: the failure does not carry ${leaked}`).toBe(false);
        }
      }
    }
    // The identity check, and with it "no new public reason": the epoch is refused exactly as the
    // year 0001 already is — same kind of outcome, same reason or same static error.
    expect(outcomes[0].shape, "the epoch is refused identically to an ancient observation").toEqual(outcomes[1].shape);
  });
});

/**
 * KR-03 — canonical proof, and the operative falsifiers M1d, M1e, M1f, M1g, M1h and M2 of the
 * specification's mutation matrix (`docs/design/slack-known-root-requeue-spec.md` §5.2–§5.4, §11, §12).
 *
 * EVIDENCE, NOT RED: every scenario here is expected to pass on source checkpoint `c5679f89`.
 *
 * ONE PUBLISHED ROOT PER GROUP. Publishing a root through the real discovery, readiness, staging and
 * publication paths is the expensive part of this fixture, so the scenarios of one logical group run
 * one after another against a single published, enumerated root (`inSequence`). Reuse is made safe
 * rather than assumed: a scenario removes the one queue row its closing proof created, through
 * explicit fixture DML that must delete exactly that row, and the whole-team snapshot must then equal
 * the snapshot the group started from before the next scenario may begin. A scenario that fails is
 * still undone and still checked against that baseline, and the scenarios after it still run — so a
 * mutation run is told EVERY scenario a mutant breaks, by label, not only the first of a loop.
 * Nothing is soft: any failed scenario fails its test, and a root that cannot be returned to its
 * baseline stops its group there instead of reporting later scenarios against a root that is no
 * longer the fixture.
 *
 * Every refusal scenario has the same movements:
 *
 *  1. ARRANGE one stored fact that is wrong — through fixture DML, on a root that the REAL
 *     publication produced and the REAL enumeration located. Authority (binding, channel proof,
 *     namespace gate, integration secret) is whatever the real discovery, readiness and publication
 *     paths left behind; no authority constant is supplied to preparation.
 *  2. PREPARE, from the team and the entry enumeration returned before the change, and require the
 *     exact closed result. A whole-table snapshot of the team's items, versions, ledger, queue,
 *     staging, channels, bindings, gates, integrations and projects is taken AFTER the arrangement
 *     and BEFORE the call, and must be byte-identical afterwards: a refusal writes nothing.
 *  3. UNDO that one fact and prepare again with the very same entry: it must now enqueue. So the
 *     arranged fact — and nothing else in the fixture — is what was refused.
 *  4. REMOVE that one queue row and require the group's baseline snapshot again.
 *
 * A CONTROL scenario arranges a fact that must not be a refusal, requires the same entry to enqueue,
 * and then removes what it planted and its queue row in the same way.
 *
 * The oracles are the test's own: results are compared with literal values, the legacy path is
 * written out here rather than taken from the helper under test, and "nothing changed" is the
 * database's own rendering of every row.
 */
describe("KR-03 — canonical proof refuses exactly what it should, and nothing else moves (real Postgres)", () => {
  interface Ctx { f: Published; entry: SlackKnownRootEntry; teamId: string; itemId: string }
  type Outcome = SlackKnownRootPreparationResult;

  const run = async (text: string, params: unknown[] = []): Promise<Row[]> => (await (await rawSql()).query<Row>(text, params)).rows;
  const one = async (text: string, params: unknown[] = []): Promise<Row> => {
    const rows = await run(text, params);
    if (rows.length !== 1) throw new Error(`fixture: expected exactly one row, got ${rows.length}`);
    return rows[0];
  };
  /** Fixture DML that must change exactly one row. */
  const change = async (text: string, params: unknown[]): Promise<void> => {
    const result = await (await rawSql()).query(text, params);
    if (result.rowCount !== 1) throw new Error(`fixture: expected to change exactly one row, changed ${result.rowCount}`);
  };

  /** A published, aged, enumerated root that prepares as it stands. */
  async function preparable(): Promise<Ctx> {
    const f = await publishOldRoot();
    await ageObservation(f.seed.teamId);
    const page = await enumerate(f.seed.teamId);
    const entry = page.entries.find((candidate) => candidate.itemId === f.itemId && "locator" in candidate);
    if (!entry) throw new Error("fixture: enumeration did not locate the published root");
    return { f, entry, teamId: f.seed.teamId, itemId: f.itemId };
  }

  const prepareEntry = (ctx: Ctx): Promise<Outcome> =>
    tx((s) => prepareSlackKnownRootRequeue(s, { teamId: ctx.teamId, entry: ctx.entry }, createSlackKnownRootExecution({ ambientDeadlineAt: null })));

  /** The tables preparation could plausibly disturb. Every row of the team, exactly as the database renders it. */
  const SNAPSHOT_TABLES = [
    "items", "slack_messages", "slack_sync_threads", "slack_thread_snapshots", "slack_sync_channels",
    "slack_integration_bindings", "slack_channel_migration_gates", "integrations", "projects",
    "slack_team_state", "slack_method_budgets", "slack_workspace_observations", "member_identities",
  ];
  const SNAPSHOT_REQUIRED = [
    "items", "slack_messages", "slack_sync_threads", "slack_sync_channels", "slack_integration_bindings",
    "slack_channel_migration_gates", "integrations", "projects",
  ];

  async function snapshot(teamId: string): Promise<Record<string, string>> {
    const scoped = (await run(
      `select table_name from information_schema.columns
        where table_schema = 'public' and column_name = 'team_id' and table_name = any($1::text[])
        order by table_name`, [SNAPSHOT_TABLES]
    )).map((row) => row.table_name as string);
    for (const required of SNAPSHOT_REQUIRED) expect(scoped, `fixture: ${required} is snapshotted`).toContain(required);
    const out: Record<string, string> = {};
    for (const table of scoped) {
      out[table] = (await one(
        `select coalesce(jsonb_agg(to_jsonb(t) order by to_jsonb(t)::text), '[]'::jsonb)::text as rows from "${table}" t where t.team_id = $1`,
        [teamId]
      )).rows as string;
    }
    out.item_versions = (await one(
      `select coalesce(jsonb_agg(to_jsonb(v) order by to_jsonb(v)::text), '[]'::jsonb)::text as rows
         from item_versions v join items i on i.id = v.item_id where i.team_id = $1`, [teamId]
    )).rows as string;
    return out;
  }

  const queuedRoots = async (teamId: string): Promise<unknown[]> =>
    (await run(`select root_ts from slack_sync_threads where team_id = $1 order by root_ts`, [teamId])).map((row) => row.root_ts);

  interface Case<Token = unknown> {
    label: string;
    /** Makes ONE stored fact wrong. What it returns is handed to `undo`. */
    arrange: (ctx: Ctx) => Promise<Token>;
    /** Fixture facts read back after the arrangement and before the call. If one is false the arrangement is still undone. */
    verify?: (ctx: Ctx, token: Token) => Promise<void>;
    undo: (ctx: Ctx, token: Token) => Promise<void>;
    expected: Outcome;
  }
  const scenario = <Token>(value: Case<Token>): Case => value as unknown as Case;

  type Cleanup = () => Promise<void>;
  /** One labeled scenario on a shared root. `later` collects what has to be put back if the scenario stops early. */
  interface Step { label: string; run: (ctx: Ctx, later: Cleanup[]) => Promise<void> }

  /** Movements 1–3 above for one arranged fact; `inSequence` performs the fourth. */
  const refusal = (scenarioCase: Case): Step => ({
    label: scenarioCase.label,
    run: async (ctx, later) => {
      const { label } = scenarioCase;
      const token = await scenarioCase.arrange(ctx);
      let undone = false;
      const undo: Cleanup = async () => {
        if (undone) return;
        undone = true;
        await scenarioCase.undo(ctx, token);
      };
      later.push(undo);
      await scenarioCase.verify?.(ctx, token);

      const before = await snapshot(ctx.teamId);
      expect(await queuedRoots(ctx.teamId), `${label}: fixture: the root has no pending work`).toEqual([]);
      const result = await prepareEntry(ctx);
      expect(result, label).toEqual(scenarioCase.expected);
      // No queue row, and no row of any snapshotted table differs: the queue table is in the snapshot.
      expect(await queuedRoots(ctx.teamId), `${label}: nothing was enqueued`).toEqual([]);
      expect(await snapshot(ctx.teamId), `${label}: nothing was written`).toEqual(before);

      await undo();
      expect(await prepareEntry(ctx), `${label}: with that one fact undone the same entry prepares`).toEqual({ outcome: "enqueued" });
      expect(await queuedRoots(ctx.teamId), `${label}: with that one fact undone the root is queued`).toEqual([OLD_ROOT]);
    },
  });

  /** A fact that must NOT be a refusal: arrange it, and the same entry still enqueues. What it plants goes on `later`. */
  const control = (label: string, arrange: (ctx: Ctx, later: Cleanup[]) => Promise<unknown>): Step => ({
    label,
    run: async (ctx, later) => {
      await arrange(ctx, later);
      expect(await queuedRoots(ctx.teamId), `${label}: fixture: the root has no pending work`).toEqual([]);
      expect(await prepareEntry(ctx), label).toEqual({ outcome: "enqueued" });
      expect(await queuedRoots(ctx.teamId), `${label}: the root is queued`).toEqual([OLD_ROOT]);
    },
  });

  /**
   * Runs labeled scenarios one after another against ONE published root.
   *
   * A scenario that passes has left exactly one queue row — the root's — and that row, and only that
   * row, is deleted here by scope; a delete that does not remove exactly one row is itself a failure
   * of the scenario. Whatever the scenario registered is then put back, and the team must read
   * exactly as it did before the first scenario. A scenario that FAILS is recorded under its label,
   * is put back the same way (with whatever queue rows it left removed), and the next scenario runs
   * only if the baseline was really restored. Every recorded failure is thrown at the end.
   */
  async function inSequence(ctx: Ctx, steps: readonly Step[]): Promise<void> {
    const baseline = await snapshot(ctx.teamId);
    expect(baseline.slack_sync_threads, "fixture: the reusable root has no pending work").toBe("[]");
    const failures: Error[] = [];
    const labeled = (label: string, error: unknown): Error => {
      const failure = error instanceof Error ? error : new Error(String(error));
      if (!failure.message.includes(label)) failure.message = `${label}: ${failure.message}`;
      return failure;
    };

    let ran = 0;
    for (const step of steps) {
      ran += 1;
      const later: Cleanup[] = [];
      let passed = false;
      try {
        await step.run(ctx, later);
        await change(
          `delete from slack_sync_threads where team_id = $1 and workspace_id = $2 and channel_id = $3 and root_ts = $4`,
          [ctx.teamId, WORKSPACE, CHANNEL, OLD_ROOT]
        );
        passed = true;
      } catch (error) {
        failures.push(labeled(step.label, error));
      }
      try {
        for (const putBack of later.reverse()) await putBack();
        if (!passed) await run(`delete from slack_sync_threads where team_id = $1`, [ctx.teamId]);
        expect(await snapshot(ctx.teamId), `${step.label}: the reusable baseline is restored`).toEqual(baseline);
      } catch (error) {
        failures.push(labeled(
          `${step.label}: the root could NOT be returned to its baseline, so the ${steps.length - ran} scenario(s) after it were not run`, error
        ));
        break;
      }
    }

    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) {
      throw new AggregateError(
        failures,
        `${failures.length} failures across ${steps.length} scenarios on one root:\n${failures.map((failure) => `  - ${failure.message}`).join("\n")}`
      );
    }
  }

  /** One published root for the whole list of refusals. */
  const refusesEach = async (cases: readonly Case[]): Promise<void> => inSequence(await preparable(), cases.map(refusal));

  // ── fixture builders ───────────────────────────────────────────────────────

  /** The canonical scoped path and the legacy path of the fixture root, WRITTEN OUT, not built by the code under test. */
  const SCOPED_PATH = `slack/t0source1/c0known1170/${OLD_ROOT}.md`;
  const LEGACY_PATH = `slack/c0known1170/${OLD_ROOT}.md`;
  const OTHER_REPLY = "1718900000.000150";

  const frontmatterOf = async (ctx: Ctx): Promise<string> =>
    JSON.stringify((await one(`select frontmatter from items where id = $1`, [ctx.itemId])).frontmatter);
  const restoreFrontmatter = (ctx: Ctx, original: string): Promise<void> =>
    change(`update items set frontmatter = $2::jsonb where id = $1`, [ctx.itemId, original]);
  /** Replace one frontmatter key with a JSON value, or remove it. Returns the original frontmatter. */
  const frontmatterCase = (label: string, key: string, value: unknown, expected: Outcome, remove = false): Case => scenario<string>({
    label, expected,
    arrange: async (ctx) => {
      const original = await frontmatterOf(ctx);
      if (remove) await change(`update items set frontmatter = frontmatter - $2::text where id = $1`, [ctx.itemId, key]);
      else await change(`update items set frontmatter = jsonb_set(frontmatter, array[$2::text], $3::jsonb, true) where id = $1`, [ctx.itemId, key, JSON.stringify(value)]);
      const stored = (await one(`select frontmatter ? $2::text as present, frontmatter->$2::text as value from items where id = $1`, [ctx.itemId, key]));
      expect(stored.present, `fixture: ${label}`).toBe(!remove);
      if (!remove) expect(stored.value, `fixture: ${label} reads back`).toEqual(value);
      return original;
    },
    undo: restoreFrontmatter,
  });
  const columnCase = (label: string, column: "kind" | "access" | "path", value: string, expected: Outcome): Case => scenario<string>({
    label, expected,
    arrange: async (ctx) => {
      const original = (await one(`select ${column}::text as value from items where id = $1`, [ctx.itemId])).value as string;
      expect(original, `fixture: the ${column} differs from the arranged one`).not.toBe(value);
      await change(`update items set ${column} = $2 where id = $1`, [ctx.itemId, value]);
      const stored = await one(`select ${column}::text as value, octet_length(${column}::text)::int as bytes from items where id = $1`, [ctx.itemId]);
      expect(stored, `fixture: ${label} reads back`).toEqual({ value, bytes: Buffer.byteLength(value, "utf8") });
      return original;
    },
    undo: (ctx, original) => change(`update items set ${column} = $2 where id = $1`, [ctx.itemId, original]),
  });

  /** One schema-valid ledger row, as the stored codec requires it. Returns its id. */
  async function ledgerRow(teamId: string, itemId: string, row: {
    workspace?: string; channel?: string; messageTs: string; rootTs: string; deleted?: boolean;
  }): Promise<string> {
    return (await one(
      `insert into slack_messages
         (team_id, item_id, workspace_id, channel_id, message_ts, root_ts, author_external_id,
          occurred_at, is_root, eligible, exclusion_reason, deleted_at, source_hash)
       values ($1, $2::uuid, $3, $4, $5, $6, 'U1',
               to_timestamp(split_part($5, '.', 1)::bigint) + split_part($5, '.', 2)::integer * interval '1 microsecond',
               $5 = $6, true, null, case when $7 then now() else null end, repeat('a', 64))
       returning id::text as id`,
      [teamId, itemId, row.workspace ?? WORKSPACE, row.channel ?? CHANNEL, row.messageTs, row.rootTs, row.deleted === true]
    )).id as string;
  }
  const dropLedgerRow = (_ctx: Ctx, id: string): Promise<void> => change(`delete from slack_messages where id = $1::uuid`, [id]);

  async function projectId(teamId: string, slug: string, create = false): Promise<string> {
    if (create) return (await one(`insert into projects (team_id, slug) values ($1, $2) returning id::text as id`, [teamId, slug])).id as string;
    return (await one(`select id::text as id from projects where team_id = $1 and slug = $2`, [teamId, slug])).id as string;
  }
  /** A bare item row at a chosen path: the shape a conflicting writer would leave behind. Returns its id. */
  async function plantItem(teamId: string, project: string, path: string, over: { kind?: string; access?: string; frontmatter?: Record<string, unknown> } = {}): Promise<string> {
    return (await one(
      `insert into items (id, team_id, project_id, path, kind, access, frontmatter, body, content_sha256, member_id, member_id_locked)
       values (gen_random_uuid(), $1, $2::uuid, $3, $4, $5, $6::jsonb, '', repeat('a', 64), null, false)
       returning id::text as id`,
      [teamId, project, path, over.kind ?? "deliverable", over.access ?? "team", JSON.stringify(over.frontmatter ?? {})]
    )).id as string;
  }
  const dropItem = (_ctx: Ctx, id: string): Promise<void> => change(`delete from items where id = $1::uuid`, [id]);
  const dropProject = (id: string): Promise<void> => change(`delete from projects where id = $1::uuid`, [id]);
  /** A planted item TOGETHER WITH the project that was created to hold it: a shared root must get both back. */
  const dropPlanted = async (ctx: Ctx, token: { item: string; project: string }): Promise<void> => {
    await dropItem(ctx, token.item);
    await dropProject(token.project);
  };

  // The same rows for a CONTROL, which has no undo of its own: each one is removed, newest first,
  // when its scenario ends — whether or not the scenario passed.
  async function plantedLedgerRow(later: Cleanup[], teamId: string, itemId: string, row: Parameters<typeof ledgerRow>[2]): Promise<string> {
    const id = await ledgerRow(teamId, itemId, row);
    later.push(() => change(`delete from slack_messages where id = $1::uuid`, [id]));
    return id;
  }
  async function plantedProject(later: Cleanup[], teamId: string): Promise<string> {
    const id = await projectId(teamId, `other-${randomUUID().slice(0, 8)}`, true);
    later.push(() => dropProject(id));
    return id;
  }
  async function plantedItem(later: Cleanup[], teamId: string, project: string, path: string): Promise<string> {
    const id = await plantItem(teamId, project, path);
    later.push(() => change(`delete from items where id = $1::uuid`, [id]));
    return id;
  }

  const mismatch: Outcome = { outcome: "unattested", reason: "canonical_mismatch" };
  const invalidMetadata: Outcome = { outcome: "unattested", reason: "invalid_metadata" };
  const noWitness: Outcome = { outcome: "unattested", reason: "missing_root_witness" };
  const contradictory: Outcome = { outcome: "unattested", reason: "contradictory_ledger" };

  // ── the baseline, and the snapshot's own non-vacuity ───────────────────────

  it("prepares the untouched root, changing the queue and NOTHING else (baseline, and the snapshot's own control)", async () => {
    const ctx = await preparable();
    const before = await snapshot(ctx.teamId);
    // Fixture preconditions the cases below lean on, stated once against real rows.
    expect((await one(`select path, kind::text as kind, access::text as access from items where id = $1`, [ctx.itemId])))
      .toEqual({ path: SCOPED_PATH, kind: "transcript", access: "team" });
    expect(SCOPED_PATH, "fixture: the written-out scoped path is the publication's").toBe(scopedSlackItemPath(WORKSPACE, CHANNEL, OLD_ROOT));
    expect(await run(`select 1 from items where team_id = $1 and path = $2`, [ctx.teamId, LEGACY_PATH]), "fixture: nothing is at the legacy path").toEqual([]);

    expect(await prepareEntry(ctx)).toEqual({ outcome: "enqueued" });
    const after = await snapshot(ctx.teamId);
    // The snapshot SEES a write: the queue table differs…
    expect(after.slack_sync_threads).not.toBe(before.slack_sync_threads);
    expect(await queuedRoots(ctx.teamId)).toEqual([OLD_ROOT]);
    // …and it is the only table that does. Preparation writes no item, version, ledger row, channel,
    // binding, gate, integration, project, generation, budget, observation or identity.
    for (const table of Object.keys(before)) {
      if (table !== "slack_sync_threads") expect(after[table], `${table} is unchanged by a successful preparation`).toBe(before[table]);
    }
  });

  // ── §5.3 the locked item: project, kind, access, typed metadata, path ──────

  describe("the locked item", () => {
    it("is a canonical mismatch for each well-formed fact that is not the candidate's — project, kind, access, path (M1g), source, channel, root", () => refusesEach([
      scenario<string>({
        label: "the team has no project with the slug slack any more",
        expected: mismatch,
        arrange: async (ctx) => {
          const slack = await projectId(ctx.teamId, "slack");
          await change(`update projects set slug = $2 where id = $1::uuid`, [slack, `renamed-${randomUUID().slice(0, 8)}`]);
          return slack;
        },
        undo: (_ctx, slack) => change(`update projects set slug = 'slack' where id = $1::uuid`, [slack]),
      }),
      scenario<{ slack: string; impostor: string }>({
        label: "another project now holds the slug slack, and the item is not in it",
        expected: mismatch,
        arrange: async (ctx) => {
          const slack = await projectId(ctx.teamId, "slack");
          await change(`update projects set slug = $2 where id = $1::uuid`, [slack, `renamed-${randomUUID().slice(0, 8)}`]);
          const impostor = await projectId(ctx.teamId, "slack", true);
          expect((await one(`select project_id::text as id from items where id = $1`, [ctx.itemId])).id, "fixture: the item stayed in its own project").toBe(slack);
          return { slack, impostor };
        },
        undo: async (_ctx, token) => {
          await change(`delete from projects where id = $1::uuid`, [token.impostor]);
          await change(`update projects set slug = 'slack' where id = $1::uuid`, [token.slack]);
        },
      }),
      columnCase("the item's kind is not transcript", "kind", "deliverable", mismatch),
      columnCase("the item's access is not team", "access", "external", mismatch),
      // M1g: only the path changes, to a well-formed one that is not canonical.
      columnCase("the item's path is a well-formed path that is not the canonical one (M1g)", "path", `slack/t0source1/c0known1170/${OLD_ROOT}.moved.md`, mismatch),
      columnCase("the item's path is the LEGACY path of the same root (M1g)", "path", LEGACY_PATH, mismatch),
      frontmatterCase("the stored source is not slack", "source", "github", mismatch),
      frontmatterCase("the stored channel_id is another well-formed channel", "channel_id", "C0OTHER1170", mismatch),
      frontmatterCase("the stored ts is another well-formed root", "ts", "1718900000.000200", mismatch),
      frontmatterCase("the stored thread_ts is another well-formed root", "thread_ts", "1718900000.000200", mismatch),
    ]));

    it("is invalid metadata for each missing, wrong-typed or over-bound stored field, and for a path over 2,048 bytes", () => refusesEach([
      frontmatterCase("the stored workspace_id is missing", "workspace_id", null, invalidMetadata, true),
      frontmatterCase("the stored channel_id is missing", "channel_id", null, invalidMetadata, true),
      frontmatterCase("the stored ts is missing", "ts", null, invalidMetadata, true),
      frontmatterCase("the stored thread_ts is missing", "thread_ts", null, invalidMetadata, true),
      frontmatterCase("the stored workspace_id is a number", "workspace_id", 7, invalidMetadata),
      frontmatterCase("the stored channel_id is an object", "channel_id", { id: CHANNEL }, invalidMetadata),
      frontmatterCase("the stored ts is a boolean", "ts", true, invalidMetadata),
      frontmatterCase("the stored thread_ts is JSON null", "thread_ts", null, invalidMetadata),
      frontmatterCase("the stored workspace_id is 257 bytes", "workspace_id", `T${"0".repeat(256)}`, invalidMetadata),
      // One byte past the TIMESTAMP bound, in a spelling the exact parser would otherwise accept.
      frontmatterCase("the stored ts is 129 bytes", "ts", `${"0".repeat(129 - OLD_ROOT.length)}${OLD_ROOT}`, invalidMetadata),
      frontmatterCase("the stored thread_ts is 129 bytes", "thread_ts", `${"0".repeat(129 - OLD_ROOT.length)}${OLD_ROOT}`, invalidMetadata),
      columnCase("the item's path is 2,049 bytes of ASCII", "path", `slack/t0source1/c0known1170/${"p".repeat(2_049 - 28 - 3)}.md`, invalidMetadata),
      // BYTES, not characters: 1,100 two-byte characters are 2,200 bytes in well under 2,048 characters.
      columnCase("the item's path is over 2,048 BYTES in fewer than 2,048 characters", "path", `slack/t0source1/c0known1170/${"é".repeat(1_100)}.md`, invalidMetadata),
    ]));
  });

  // ── §5.3 the root witness: KR-03 and M2 ────────────────────────────────────

  describe("the root witness", () => {
    const rootRow = `team_id = $1 and message_ts = $2 and root_ts = $2 and is_root`;

    it("is missing for each way the root's own row fails to witness it: deleted, absent, or observed at a non-finite instant", () => refusesEach([
      scenario<null>({
        label: "the root's ledger row is deleted (soft-deleted evidence is not a witness)",
        expected: noWitness,
        arrange: async (ctx) => {
          await change(`update slack_messages set deleted_at = now() where ${rootRow}`, [ctx.teamId, OLD_ROOT]);
          return null;
        },
        undo: (ctx) => change(`update slack_messages set deleted_at = null where ${rootRow}`, [ctx.teamId, OLD_ROOT]),
      }),
      scenario<string>({
        label: "the root's ledger row is absent while its reply remains",
        expected: noWitness,
        arrange: async (ctx) => {
          const saved = (await one(`select to_jsonb(m)::text as saved from slack_messages m where ${rootRow}`, [ctx.teamId, OLD_ROOT])).saved as string;
          await change(`delete from slack_messages where ${rootRow}`, [ctx.teamId, OLD_ROOT]);
          expect((await run(`select message_ts from slack_messages where team_id = $1 order by message_ts`, [ctx.teamId])).map((row) => row.message_ts))
            .toEqual([OLD_REPLY]);
          return saved;
        },
        undo: (_ctx, saved) => change(`insert into slack_messages select * from jsonb_populate_record(null::slack_messages, $1::jsonb)`, [saved]),
      }),
      ...(["infinity", "-infinity"] as const).map((value) => scenario<string>({
        label: `the root's observation is ${value} (not finite)`,
        expected: noWitness,
        arrange: async (ctx) => {
          const original = (await one(`select observed_at::text as at from slack_messages where ${rootRow}`, [ctx.teamId, OLD_ROOT])).at as string;
          await change(`update slack_messages set observed_at = $3::timestamptz where ${rootRow}`, [ctx.teamId, OLD_ROOT, value]);
          expect((await one(`select isfinite(observed_at) as finite, deleted_at is null as live from slack_messages where ${rootRow}`, [ctx.teamId, OLD_ROOT])))
            .toEqual({ finite: false, live: true });
          return original;
        },
        undo: (ctx, original) => change(`update slack_messages set observed_at = $3::timestamptz where ${rootRow}`, [ctx.teamId, OLD_ROOT, original]),
      })),
    ]));

    /**
     * M2. The mutant bypasses the existence of a live root witness while still supplying a due
     * observation. For that mutant to be KILLED rather than to crash, the fixture has to be one in
     * which everything except the witness is in order — so that with the check gone, the path to the
     * enqueue is open. That is asserted here against the stored rows, with the test's own counts,
     * before the call: a row for the root with a finite, overdue observation exists; it is not
     * live; nothing else binds the item or the thread elsewhere; neither path is in conflict; and no
     * work is pending. On the unmutated source the answer is `missing_root_witness` and nothing is
     * written; on the mutant the same fixture reaches the enqueue helper and a row appears.
     */
    const onlyTheWitnessIsMissing = (label: string, expectedRows: { overdue_root_rows: number; live_root_rows: number }) => async (ctx: Ctx): Promise<void> => {
      const facts = await one(
        `select
           (select count(*)::int from slack_messages
             where team_id = $1 and workspace_id = $4 and channel_id = $5 and message_ts = $2 and item_id = $3::uuid
               and isfinite(observed_at) and observed_at + interval '60 seconds' <= clock_timestamp()) as overdue_root_rows,
           (select count(*)::int from slack_messages
             where team_id = $1 and message_ts = $2 and root_ts = $2 and is_root and deleted_at is null) as live_root_rows,
           (select count(*)::int from slack_messages
             where team_id = $1 and item_id = $3::uuid and (workspace_id <> $4 or channel_id <> $5 or root_ts <> $2)) as item_rows_elsewhere,
           (select count(*)::int from slack_messages
             where team_id = $1 and workspace_id = $4 and channel_id = $5 and root_ts = $2 and item_id <> $3::uuid) as thread_rows_of_other_items,
           (select count(*)::int from items where team_id = $1 and path = $6) as items_at_legacy_path,
           (select count(*)::int from items where team_id = $1 and path = $7 and id <> $3::uuid) as other_items_at_scoped_path,
           (select count(*)::int from slack_sync_threads where team_id = $1) as queue_rows`,
        [ctx.teamId, OLD_ROOT, ctx.itemId, WORKSPACE, CHANNEL, LEGACY_PATH, SCOPED_PATH]
      );
      expect(facts, `${label}: fixture: only the witness is missing; everything a mutant would need to enqueue is present`).toEqual({
        ...expectedRows, item_rows_elsewhere: 0, thread_rows_of_other_items: 0,
        items_at_legacy_path: 0, other_items_at_scoped_path: 0, queue_rows: 0,
      });
    };

    // Each scenario then goes on, like every other refusal, to put the witness back and require the
    // same entry to enqueue: the witness, and nothing else in the fixture, is what was refused.
    const M2_DELETED = "M2: the root row is present but deleted, and its observation is finite and overdue";
    const M2_GONE = "M2: the root row is gone and only the overdue reply remains";
    it("stays missing_root_witness on a fixture where only the witness stands between it and an enqueue (M2)", () => refusesEach([
      scenario<null>({
        label: M2_DELETED, expected: noWitness,
        arrange: async (ctx) => {
          await change(`update slack_messages set deleted_at = now() where ${rootRow}`, [ctx.teamId, OLD_ROOT]);
          return null;
        },
        verify: onlyTheWitnessIsMissing(M2_DELETED, { overdue_root_rows: 1, live_root_rows: 0 }),
        undo: (ctx) => change(`update slack_messages set deleted_at = null where ${rootRow}`, [ctx.teamId, OLD_ROOT]),
      }),
      scenario<string>({
        label: M2_GONE, expected: noWitness,
        arrange: async (ctx) => {
          const saved = (await one(`select to_jsonb(m)::text as saved from slack_messages m where ${rootRow}`, [ctx.teamId, OLD_ROOT])).saved as string;
          await change(`delete from slack_messages where ${rootRow}`, [ctx.teamId, OLD_ROOT]);
          return saved;
        },
        verify: async (ctx) => {
          // The reply is still there, live, bound to this item and overdue: an observation a mutant
          // could be handed, on a thread that has no root witness at all.
          expect(await run(
            `select message_ts from slack_messages
              where team_id = $1 and item_id = $3::uuid and root_ts = $2 and deleted_at is null
                and isfinite(observed_at) and observed_at + interval '60 seconds' <= clock_timestamp()`, [ctx.teamId, OLD_ROOT, ctx.itemId]
          ), `${M2_GONE}: fixture: the overdue reply remains`).toEqual([{ message_ts: OLD_REPLY }]);
          await onlyTheWitnessIsMissing(M2_GONE, { overdue_root_rows: 0, live_root_rows: 0 })(ctx);
        },
        undo: (_ctx, saved) => change(`insert into slack_messages select * from jsonb_populate_record(null::slack_messages, $1::jsonb)`, [saved]),
      }),
    ]));
  });

  // ── §5.3 the same item bound to another thread or scope: M1d, M1e, M1f ─────

  describe("the item's own ledger rows", () => {
    const sameItem = (where: string, row: Parameters<typeof ledgerRow>[2]): Step => refusal(scenario<string>({
      label: `a ledger row of the candidate's OWN item is in ${where}`, expected: contradictory,
      arrange: async (ctx) => {
        const id = await ledgerRow(ctx.teamId, ctx.itemId, row);
        // Fixture: exactly ONE component of the stored row differs from the candidate's scope.
        const stored = await one(
          `select (workspace_id <> $2)::int + (channel_id <> $3)::int + (root_ts <> $4)::int as differing,
                  message_ts <> root_ts as is_reply, is_root, (deleted_at is not null) as deleted
             from slack_messages where id = $1::uuid`, [id, WORKSPACE, CHANNEL, OLD_ROOT]
        );
        expect(stored, `fixture: the own item's row is in ${where}`).toEqual({ differing: 1, is_reply: true, is_root: false, deleted: row.deleted === true });
        return id;
      },
      undo: dropLedgerRow,
    }));

    it("contradict the candidate when ONE component of one of them differs — workspace (M1d), channel (M1e), root (M1f), live or deleted — and not when they are further replies of the same root", async () => inSequence(await preparable(), [
      sameItem("another WORKSPACE only (M1d)", { workspace: "T0OTHER9", messageTs: OTHER_REPLY, rootTs: OLD_ROOT }),
      sameItem("another CHANNEL only (M1e)", { channel: "C0OTHER1170", messageTs: OTHER_REPLY, rootTs: OLD_ROOT }),
      sameItem("another ROOT only (M1f)", { messageTs: "1718800000.000101", rootTs: "1718800000.000100" }),
      sameItem("another workspace only, on a DELETED row", { workspace: "T0OTHER9", messageTs: OTHER_REPLY, rootTs: OLD_ROOT, deleted: true }),
      sameItem("another channel only, on a DELETED row", { channel: "C0OTHER1170", messageTs: OTHER_REPLY, rootTs: OLD_ROOT, deleted: true }),
      sameItem("another root only, on a DELETED row", { messageTs: "1718800000.000101", rootTs: "1718800000.000100", deleted: true }),
      control("further replies of the SAME root in the same scope, one live and one deleted, belong to the candidate's own item (control)", async (ctx, later) => {
        await plantedLedgerRow(later, ctx.teamId, ctx.itemId, { messageTs: OTHER_REPLY, rootTs: OLD_ROOT });
        await plantedLedgerRow(later, ctx.teamId, ctx.itemId, { messageTs: "1718900000.000151", rootTs: OLD_ROOT, deleted: true });
      }),
    ]));
  });

  // ── §5.3 the same scoped thread bound to another item: M1h ─────────────────

  describe("a second item owning part of the same thread", () => {
    /** A second item of the same team at an unrelated, non-conflicting path. */
    async function secondItem(ctx: Ctx): Promise<string> {
      const second = await seedUnrelatedItem(ctx.f.seed);
      const stored = await one(`select path, team_id::text as team_id from items where id = $1`, [second]);
      expect(stored.team_id).toBe(ctx.teamId);
      expect([SCOPED_PATH, LEGACY_PATH], "fixture: the second item's path conflicts with neither path of the root").not.toContain(stored.path);
      expect(String(stored.path).startsWith("slack/"), "fixture: the second item is outside the Slack namespace").toBe(false);
      return second;
    }
    const ownedReply = (label: string, second: string, deleted: boolean): Step => refusal(scenario<string>({
      label, expected: contradictory,
      arrange: async (ctx) => {
        const id = await ledgerRow(ctx.teamId, second, { messageTs: OTHER_REPLY, rootTs: OLD_ROOT, deleted });
        // The row M1h is about, read back: a REPLY — its own timestamp is not the root's — of this
        // exact root, in this exact team, workspace and channel, owned by the second item.
        expect(await one(
          `select team_id::text as team_id, workspace_id, channel_id, root_ts, message_ts, is_root, item_id::text as item_id,
                  (deleted_at is not null) as deleted, eligible, exclusion_reason
             from slack_messages where id = $1::uuid`, [id]
        )).toEqual({
          team_id: ctx.teamId, workspace_id: WORKSPACE, channel_id: CHANNEL, root_ts: OLD_ROOT, message_ts: OTHER_REPLY,
          is_root: false, item_id: second, deleted, eligible: true, exclusion_reason: null,
        });
        expect(OTHER_REPLY).not.toBe(OLD_ROOT);
        // The candidate's own witness is untouched and live: only the second owner is wrong.
        expect(await run(
          `select item_id::text as item_id from slack_messages
            where team_id = $1 and message_ts = $2 and root_ts = $2 and is_root and deleted_at is null`, [ctx.teamId, OLD_ROOT]
        )).toEqual([{ item_id: ctx.itemId }]);
        return id;
      },
      undo: dropLedgerRow,
    }));

    /** One root and ONE second item for the whole list: the baseline `inSequence` takes already contains that item. */
    async function withSecondItem(steps: (second: string) => readonly Step[]): Promise<void> {
      const ctx = await preparable();
      const second = await secondItem(ctx);
      await inSequence(ctx, steps(second));
    }

    // The two M1h variants stay separate tests, each on its own root, because each is the operative
    // falsifier of a different mutant and should be named on its own in a mutation run.
    // Kills `root_ts = rootTs` replaced by `message_ts = rootTs`: this row's message_ts is NOT the root's.
    it("contradicts the candidate when the second item owns a LIVE reply of the same root (M1h)", () =>
      withSecondItem((second) => [ownedReply("a second item owns a live reply of the same root (M1h)", second, false)]));

    // Kills `deleted_at IS NULL` added to the contradiction check: this row is deleted, and still binds.
    it("contradicts the candidate when the second item's reply of the same root is DELETED (M1h, deleted-row variant)", () =>
      withSecondItem((second) => [ownedReply("a second item owns a deleted reply of the same root (M1h, deleted-row variant)", second, true)]));

    it("does not contradict it when the second item's row is outside the candidate's scope, or the same scope is another team's (scope and tenant controls)", () =>
      withSecondItem((second) => [
        control("the second item's row is in another CHANNEL of the same workspace (scope control)", (ctx, later) =>
          plantedLedgerRow(later, ctx.teamId, second, { channel: "C0OTHER1170", messageTs: OTHER_REPLY, rootTs: OLD_ROOT })),
        control("the second item's row is in another WORKSPACE with the same channel id (scope control)", (ctx, later) =>
          plantedLedgerRow(later, ctx.teamId, second, { workspace: "T0OTHER9", messageTs: OTHER_REPLY, rootTs: OLD_ROOT })),
        control("the second item's row is of ANOTHER root in the same channel (scope control)", (ctx, later) =>
          plantedLedgerRow(later, ctx.teamId, second, { messageTs: "1718800000.000101", rootTs: "1718800000.000100" })),
        // LAST in its group: the other team and its own ingested item outlive the scenario. Only the
        // two ledger rows planted here are removed, and nothing runs on this root afterwards.
        control("ANOTHER TEAM stores the same workspace, channel and root under its own item (tenant control)", async (ctx, later) => {
          const otherTeam = await seedTeam();
          const theirs = await seedUnrelatedItem(otherTeam);
          // The same provider ids and the same timestamps, root and reply, in a different tenant.
          await plantedLedgerRow(later, otherTeam.teamId, theirs, { messageTs: OLD_ROOT, rootTs: OLD_ROOT });
          await plantedLedgerRow(later, otherTeam.teamId, theirs, { messageTs: OTHER_REPLY, rootTs: OLD_ROOT });
          expect(otherTeam.teamId, "fixture: the other team is another team").not.toBe(ctx.teamId);
        }),
      ]));
  });

  // ── §5.4 exact path conflicts ──────────────────────────────────────────────

  describe("another item at one of the root's two paths", () => {
    it("refuses when another project's item is at the scoped path, and when an item is at the legacy path in the Slack project or in another project", () => refusesEach([
      scenario<{ item: string; project: string }>({
        label: "the SCOPED path is owned by an item of another project",
        expected: { outcome: "refused", reason: "scoped_path_conflict" },
        arrange: async (ctx) => {
          const project = await projectId(ctx.teamId, `other-${randomUUID().slice(0, 8)}`, true);
          const item = await plantItem(ctx.teamId, project, SCOPED_PATH);
          expect(project, "fixture: the conflicting item is in another project").not.toBe(await projectId(ctx.teamId, "slack"));
          return { item, project };
        },
        undo: dropPlanted,
      }),
      scenario<string>({
        label: "an item exists at the LEGACY path in the Slack project",
        expected: { outcome: "refused", reason: "legacy_path_conflict" },
        arrange: async (ctx) => plantItem(ctx.teamId, await projectId(ctx.teamId, "slack"), LEGACY_PATH, { frontmatter: { source: "slack" } }),
        undo: dropItem,
      }),
      // "Live legacy path" is ANY extant item row there. This one is in another project, with another
      // access and no Slack frontmatter at all; its kind is the candidate's own (`transcript`), where
      // the variant above planted `deliverable`. Only the legacy path is varied this way: the scoped
      // path has the one variant above.
      scenario<{ item: string; project: string }>({
        label: "an item exists at the LEGACY path in another project, with the candidate's own kind, another access and no Slack metadata",
        expected: { outcome: "refused", reason: "legacy_path_conflict" },
        arrange: async (ctx) => {
          const project = await projectId(ctx.teamId, `other-${randomUUID().slice(0, 8)}`, true);
          const item = await plantItem(ctx.teamId, project, LEGACY_PATH, { kind: "transcript", access: "external" });
          return { item, project };
        },
        undo: dropPlanted,
      }),
    ]));

    it("does not refuse for an item at another root's path, or for another team's items at this root's own two paths (scope and tenant controls)", async () => inSequence(await preparable(), [
      control("the legacy path of ANOTHER root of the same channel is occupied (scope control)", async (ctx, later) =>
        plantedItem(later, ctx.teamId, await projectId(ctx.teamId, "slack"), `slack/c0known1170/1718900000.000200.md`)),
      control("the scoped path of ANOTHER root is owned by another project (scope control)", async (ctx, later) =>
        plantedItem(later, ctx.teamId, await plantedProject(later, ctx.teamId), `slack/t0source1/c0known1170/1718900000.000200.md`)),
      // LAST in its group: the other team outlives the scenario; what was planted in it does not.
      control("ANOTHER TEAM has items at both of the root's paths (tenant control)", async (ctx, later) => {
        const otherTeam = await seedTeam();
        expect(otherTeam.teamId, "fixture: the other team is another team").not.toBe(ctx.teamId);
        const theirs = await plantedProject(later, otherTeam.teamId);
        await plantedItem(later, otherTeam.teamId, theirs, SCOPED_PATH);
        await plantedItem(later, otherTeam.teamId, theirs, LEGACY_PATH);
      }),
    ]));
  });

  // ── §5.3 stored provider ids that differ ONLY BY CASE: M1b, M1c (and KR-04 in part) ──

  describe("stored provider ids that differ from the locator only by case", () => {
    /**
     * M1b and M1c. EVIDENCE, NOT RED: expected to pass on the current source.
     *
     * The scoped path lowercases its workspace and channel segments, so a stored provider id that
     * differs from the locator only by case leaves the canonical path — and with it the path
     * comparison — exactly as it was. Nothing but the comparison of the stored frontmatter value
     * itself can refuse such an item. Each scenario changes ONE stored field of the really published
     * item, by case only, after the real enumeration; `verify` then reads back, before the call,
     * that everything else the candidate is proven by is untouched: the other stored id, both stored
     * timestamps, the path (which the real builder gives for BOTH spellings), and the live root
     * witness in the exact provider scope. Authority rows are never touched. The scenario then goes
     * through the same movements as every other refusal of this group: exact closed result, nothing
     * enqueued, whole-team snapshot unchanged, and the same entry enqueues once the field is restored.
     */
    const caseOnly = (label: string, key: "workspace_id" | "channel_id", stored: string, exact: string): Case => ({
      ...frontmatterCase(label, key, stored, mismatch),
      verify: async (ctx) => {
        expect([stored === exact, stored.toUpperCase() === exact.toUpperCase()], `${label}: fixture: the stored spelling differs from the locator's, and only by case`).toEqual([false, true]);
        expect(await one(
          `select frontmatter->>'workspace_id' as workspace_id, frontmatter->>'channel_id' as channel_id,
                  frontmatter->>'ts' as ts, frontmatter->>'thread_ts' as thread_ts, path
             from items where id = $1`, [ctx.itemId]
        ), `${label}: fixture: ONE stored field changed, and the path did not`).toEqual({
          workspace_id: key === "workspace_id" ? stored : WORKSPACE, channel_id: key === "channel_id" ? stored : CHANNEL,
          ts: OLD_ROOT, thread_ts: OLD_ROOT, path: SCOPED_PATH,
        });
        // Path equality cannot stand in for the missing comparison: the real builder gives the SAME
        // path for the stored spelling and for the locator's.
        const pathOfStoredSpelling = key === "workspace_id" ? scopedSlackItemPath(stored, CHANNEL, OLD_ROOT) : scopedSlackItemPath(WORKSPACE, stored, OLD_ROOT);
        expect([pathOfStoredSpelling, scopedSlackItemPath(WORKSPACE, CHANNEL, OLD_ROOT)], `${label}: fixture: one canonical path for both spellings`).toEqual([SCOPED_PATH, SCOPED_PATH]);
        // The witness keeps the provider's exact ids, bound to this item, live.
        expect(await run(
          `select workspace_id, channel_id, message_ts, root_ts, item_id::text as item_id
             from slack_messages where team_id = $1 and is_root and deleted_at is null`, [ctx.teamId]
        ), `${label}: fixture: the live root witness is untouched, in the exact provider scope`).toEqual([
          { workspace_id: WORKSPACE, channel_id: CHANNEL, message_ts: OLD_ROOT, root_ts: OLD_ROOT, item_id: ctx.itemId },
        ]);
      },
    });

    it("is a canonical mismatch when the stored workspace_id or channel_id differs from the locator only by case, with the path, the witness and the authority facts unchanged (M1b, M1c)", () => refusesEach([
      // Kills removal of ONLY the locked workspace equality: without it this item enqueues.
      caseOnly("the stored workspace_id differs from the locator only by case (M1b)", "workspace_id", "t0source1", WORKSPACE),
      // Kills removal of ONLY the locked channel equality, independently of the scenario above.
      caseOnly("the stored channel_id differs from the locator only by case (M1c)", "channel_id", "c0known1170", CHANNEL),
    ]));
  });
});

/**
 * KR-17 — the §7.5 single-channel capacity fixture, its query plans and the numeric stop
 * (`docs/design/slack-known-root-requeue-spec.md` §7.5, §9 and §11).
 *
 * EVIDENCE, NOT RED, and the one place in this file where a FAILURE IS A RESULT: an observation over
 * a stop threshold is "NOT READY, pending schema-owner adjudication" (§7.5), not a test to be fixed.
 * The thresholds are the specification's and are not tunable here: every measured data statement at
 * most 200 ms, every complete page operation and complete preparation operation at most 750 ms.
 *
 * THE FIXTURE is the specification's minimum, built by set-based fixture DML on top of ONE root that
 * the real discovery, readiness, staging and publication paths produced: one team; 100,000 non-Slack
 * items; 601 canonical Slack root items in one exact workspace and one exact channel (the real one
 * and 600 synthetic); one live root witness and 100 distinct replies per root, 90 live and 10
 * deleted — 60,701 ledger rows in that channel. Every synthetic row is labeled (`kr17_synthetic` in
 * its frontmatter, deterministic ids and timestamps), every cardinality is read back and compared
 * exactly, and the synthetic roots are proven to be canonical the only way that counts: the real
 * enumeration locates them and the real preparation enqueues one. Authority — binding, channel
 * proof, namespace gate, integration secret — is whatever the real paths left behind.
 *
 * WHAT IS MEASURED IS THE PRIMITIVE'S OWN SQL. Nothing here restates a query. The real exported
 * functions run on a recording session — a test-only wrapper of the caller's `executeSql`, the kind
 * of instrumented wrapper `SqlExecutor` is documented to allow — which keeps the text and the
 * parameters of every statement the primitive and its dependencies actually issue, and how long each
 * took. Those captured statements are then given back, unchanged, to
 * `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)` inside a transaction that is rolled back, so the locks and
 * the enqueue insert are measured and leave nothing behind. A statement this test cannot name by a
 * fragment of its text is reported as an evidence gap and fails the test: nothing unnamed is measured
 * on trust.
 *
 * OBSERVATIONS, exactly as accepted: for each case the FIRST five ordinary executions after fixture
 * loading and `ANALYZE` are retained — operation time from primitive entry to its return, settings
 * round trips included, checkout and commit excluded — and then five plan observations of each
 * captured statement, compared as planning plus execution time. There is no warm-up run, nothing is
 * discarded or replaced, and nothing is averaged: every retained observation is printed, and each one
 * is compared with its stop on its own. The traversal's remaining pages are measured too and are held
 * to the same stops; only their maximum is printed.
 *
 * NOT CERTIFIED HERE: cold-cache behaviour; contention; any other fixture; sweep cadence or capacity
 * (the 1,007 page transactions are §9's traversal cost, characterized, not accepted); KR-11's insert
 * semantics; and the plan SHAPES, which are recorded as the planner chose them and never forced.
 * The catalog case states which indexes exist; the single shape assertion is the one that follows
 * from the catalog alone.
 */
const KR17 = Object.freeze({
  statementStopMs: 200,
  operationStopMs: 750,
  retained: 5,
  pageSize: 100,
  nonSlackItems: 100_000,
  syntheticRoots: 600,
  repliesPerRoot: 100,
  /** Every tenth reply of a root is a deleted ledger row: 10 of its 100. */
  deletedReplyEvery: 10,
  /** Fixed instants of every synthetic row. Both are far enough in the past to be due at any revisit policy. */
  observedAt: "2024-07-01T00:00:00Z",
  deletedAt: "2024-07-02T00:00:00Z",
});
const KR17_ROOTS = KR17.syntheticRoots + 1;
const KR17_ITEMS = KR17.nonSlackItems + KR17_ROOTS;
const KR17_LEDGER_ROWS = KR17_ROOTS * (KR17.repliesPerRoot + 1);
const KR17_PAGES = Math.ceil(KR17_ITEMS / KR17.pageSize);

// Deterministic ids. Synthetic items sort, in PostgreSQL's UUID order, as: the 100,000 non-Slack
// items, then the 600 synthetic roots. The one really published item has a random id, which the
// fixture requires to sort after both blocks, so a page of 100 holds either no root at all or roots
// only: both extremes of the locator read are in the fixture, at known pages.
const kr17RootItemId = (k: number): string => `00000000-0000-4000-9000-${k.toString(16).padStart(12, "0")}`;
const kr17RootTs = (k: number): string => `${1_718_000_000 + k}.000100`;
const KR17_ABOVE_EVERY_SYNTHETIC_ID = "00000000-0000-4000-9000-ffffffffffff";

/** One statement the primitive really issued, as the recording session saw it. */
interface Kr17Issued { name: string; kind: "settings" | "data"; text: string; params: unknown[]; elapsedMs: number }
interface Kr17Sample { operationMs: number; issued: Kr17Issued[] }
interface Kr17PlanObservation { planningMs: number; executionMs: number; totalMs: number; nodes: Row[] }
interface Kr17PlanCase { name: string; parameters: string[]; observations: Kr17PlanObservation[] }

/**
 * NAMES, not queries: each data statement is recognized by one fragment of its own text, with
 * whitespace collapsed. A statement that matches no fragment, or more than one, is unnamed.
 */
const KR17_STATEMENTS: readonly (readonly [name: string, fragment: string])[] = [
  ["page: upper-bound id read", "from items where team_id = $1::uuid order by id desc limit 1"],
  ["page: first id read", "from items where team_id = $1::uuid and id <= $2::uuid order by id limit $3"],
  ["page: continuation id read", "from items where team_id = $1::uuid and id > $2::uuid and id <= $3::uuid order by id limit $4"],
  ["page: locator enrichment", "from unnest($2::uuid[]) as wanted(id) join items i on i.team_id = $1::uuid and i.id = wanted.id"],
  ["preparation: namespace gate lock", "from slack_channel_migration_gates where team_id = $1 and raw_channel_id = $2 for update"],
  ["preparation: integration selection lock", "from integrations where team_id = $1 and id = $2::uuid for update"],
  ["preparation: binding row lock", "from slack_integration_bindings where team_id = $1::uuid and integration_id = $2::uuid for update"],
  ["preparation: scoped channel row lock", "from slack_sync_channels where team_id = $1::uuid and workspace_id = $2 and channel_id = $3 for update"],
  ["preparation: plain queue read", "select 1 as pending from slack_sync_threads where team_id = $1::uuid"],
  ["preparation: item lock", "from items i where i.team_id = $1::uuid and i.id = $2::uuid for update"],
  ["preparation: slack project read", "from projects where team_id = $1::uuid and slug = $2"],
  ["preparation: root witness", "select 1 as witnessed from slack_messages w where"],
  ["preparation: ledger contradictions", ") as item_bound_elsewhere, exists ("],
  ["preparation: path conflicts", ") as scoped_conflict, exists ("],
  ["preparation: due decision", "end as due_epoch_ms from slack_messages w where"],
  ["preparation: enqueue insert", "insert into slack_sync_threads (team_id, workspace_id, channel_id, root_ts, due_at)"],
];
const KR17_UNNAMED = "UNNAMED STATEMENT (evidence gap)";
const KR17_FIRST_PAGE = ["page: upper-bound id read", "page: first id read", "page: locator enrichment"];
const KR17_NEXT_PAGE = ["page: continuation id read", "page: locator enrichment"];
/** A complete preparation that reaches the enqueue, in the specification's order (§5.1–§5.5). */
const KR17_PREPARATION = [
  "preparation: namespace gate lock", "preparation: integration selection lock", "preparation: binding row lock",
  "preparation: scoped channel row lock", "preparation: plain queue read", "preparation: item lock",
  "preparation: slack project read", "preparation: root witness", "preparation: ledger contradictions",
  "preparation: path conflicts", "preparation: due decision", "preparation: enqueue insert",
];

function kr17Named(text: string): Pick<Kr17Issued, "name" | "kind"> {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.includes("from pg_settings")) return { name: "settings: read both timeouts", kind: "settings" };
  if (flat.includes("set_config('statement_timeout'")) return { name: "settings: apply both timeouts", kind: "settings" };
  const matches = KR17_STATEMENTS.filter(([, fragment]) => flat.includes(fragment));
  // The start of the SQL text identifies the gap. It carries no parameter value.
  return { name: matches.length === 1 ? matches[0][0] : `${KR17_UNNAMED}: ${flat.slice(0, 120)}`, kind: "data" };
}

/** The caller's session, unchanged in behaviour, with every statement it is asked for written down. */
function kr17Recording(session: TransactionSession, issued: Kr17Issued[]): TransactionSession {
  const executeSql: SqlExecutor = async <T = Record<string, unknown>>(text: string, params?: unknown[]) => {
    const started = performance.now();
    const result = await session.executeSql<T>(text, params);
    issued.push({ ...kr17Named(text), text, params: params === undefined ? [] : [...params], elapsedMs: performance.now() - started });
    return result;
  };
  return {
    get db() {
      return session.db;
    },
    executeSql,
    optionalAudit<T>(operation: () => Promise<T>, fallback: T): Promise<T> {
      return session.optionalAudit(operation, fallback);
    },
  };
}

/**
 * ONE ordinary execution of one primitive, on its own transaction. The clock runs from the call of
 * the primitive to its return: validation, both settings round trips, every data statement and the
 * restoration are inside it; connection checkout, BEGIN and COMMIT are not. The default 2,000 ms
 * allowance, the real monotonic clock, and a declared absence of any ambient deadline.
 */
function kr17Measured<T>(
  operation: (session: TransactionSession, execution: SlackKnownRootExecution) => Promise<T>
): Promise<Kr17Sample & { value: T }> {
  return tx(async (s) => {
    const issued: Kr17Issued[] = [];
    const session = kr17Recording(s, issued);
    const execution = createSlackKnownRootExecution({ ambientDeadlineAt: null });
    const started = performance.now();
    const value = await operation(session, execution);
    const operationMs = performance.now() - started;
    return { value, operationMs, issued };
  });
}

const kr17Data = (sample: Kr17Sample): Kr17Issued[] => sample.issued.filter((statement) => statement.kind === "data");
const kr17DataNames = (sample: Kr17Sample): string[] => kr17Data(sample).map((statement) => statement.name);

/** A parameter by its kind and size, never by its value. */
function kr17Described(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (Array.isArray(value)) return `array[${value.length}]`;
  if (value instanceof Date) return "timestamp";
  if (typeof value === "string") return /^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(value) ? "uuid" : `text(${Buffer.byteLength(value, "utf8")} bytes)`;
  return typeof value;
}

const KR17_PLAN_KEYS = [
  "Node Type", "Parent Relationship", "Subplan Name", "Operation", "Conflict Resolution", "Relation Name", "Index Name",
  "Scan Direction", "Index Cond", "Recheck Cond", "Filter", "Rows Removed by Filter", "Heap Fetches", "Actual Rows", "Actual Loops",
  "Actual Total Time", "Shared Hit Blocks", "Shared Read Blocks", "Workers Launched",
];

/** The plan as a flat list of its nodes: access path, conditions, rows, loops, buffers and time. */
function kr17PlanNodes(node: Row, depth = 0, out: Row[] = []): Row[] {
  const kept: Row = { depth };
  for (const key of KR17_PLAN_KEYS) if (node[key] !== undefined) kept[key] = node[key];
  out.push(kept);
  for (const child of (node.Plans as Row[] | undefined) ?? []) kr17PlanNodes(child, depth + 1, out);
  return out;
}

/**
 * Five plan observations of each captured statement. Every observation runs the statements in the
 * order the primitive issued them, with the parameters it issued them with, inside one transaction on
 * the fixture connection that is ROLLED BACK: row locks are taken and the enqueue insert really
 * inserts, and neither survives. No planner setting is changed and no index is added.
 */
async function kr17PlanCases(label: string, statements: readonly Kr17Issued[]): Promise<Kr17PlanCase[]> {
  const raw = await rawSql();
  const cases: Kr17PlanCase[] = statements.map((statement) => ({
    name: `${label} · ${statement.name}`, parameters: statement.params.map(kr17Described), observations: [],
  }));
  for (let observation = 0; observation < KR17.retained; observation++) {
    await raw.query("begin");
    try {
      for (const [index, statement] of statements.entries()) {
        const explained = await raw.query<Row>(`explain (analyze, buffers, format json) ${statement.text}`, statement.params);
        const column = explained.rows[0]?.["QUERY PLAN"];
        const [top] = (typeof column === "string" ? JSON.parse(column) : column) as Row[];
        const planningMs = Number(top["Planning Time"]);
        const executionMs = Number(top["Execution Time"]);
        cases[index].observations.push({ planningMs, executionMs, totalMs: planningMs + executionMs, nodes: kr17PlanNodes(top.Plan as Row) });
      }
    } finally {
      await raw.query("rollback");
    }
  }
  return cases;
}

/** Over the stop, or not a measurement at all: a value that is not a finite duration never passes. */
const kr17Over = (ms: number, stopMs: number): boolean => !(Number.isFinite(ms) && ms >= 0 && ms <= stopMs);
const kr17Ms = (ms: number): number | string => (Number.isFinite(ms) ? Math.round(ms * 1000) / 1000 : String(ms));

/** Ordinary executions of one case: every retained operation and every data statement against its stop. */
function kr17Ordinary(name: string, samples: readonly Kr17Sample[], retained: number, print: "every observation" | "maximum only"): { evidence: Row; violations: string[] } {
  const violations: string[] = [];
  if (samples.length !== retained) violations.push(`${name}: ${samples.length} observations were retained, not ${retained}`);
  const statements = new Map<string, number[]>();
  samples.forEach((sample, index) => {
    const at = `ordinary execution ${index + 1} of ${samples.length}`;
    if (kr17Over(sample.operationMs, KR17.operationStopMs)) {
      violations.push(`${name} · COMPLETE OPERATION · ${at}: measured ${kr17Ms(sample.operationMs)} ms against the ${KR17.operationStopMs} ms operation stop`);
    }
    for (const statement of kr17Data(sample)) {
      statements.set(statement.name, [...(statements.get(statement.name) ?? []), statement.elapsedMs]);
      if (kr17Over(statement.elapsedMs, KR17.statementStopMs)) {
        violations.push(`${name} · ${statement.name} · ${at}: measured ${kr17Ms(statement.elapsedMs)} ms against the ${KR17.statementStopMs} ms statement stop`);
      }
    }
  });
  const operations = samples.map((sample) => sample.operationMs);
  const evidence: Row = {
    case: name, observations: samples.length, operationStopMs: KR17.operationStopMs, statementStopMs: KR17.statementStopMs,
    maxOperationMs: kr17Ms(Math.max(...operations)),
    maxStatementMs: Object.fromEntries([...statements].map(([statement, elapsed]) => [statement, kr17Ms(Math.max(...elapsed))])),
    settingsRoundTripsPerOperation: [...new Set(samples.map((sample) => sample.issued.length - kr17Data(sample).length))],
  };
  if (print === "every observation") {
    evidence.operationMs = operations.map(kr17Ms);
    evidence.statementMs = Object.fromEntries([...statements].map(([statement, elapsed]) => [statement, elapsed.map(kr17Ms)]));
  }
  return { evidence, violations };
}

/** Plan observations: planning plus execution time of every observation against the statement stop. */
function kr17Plans(cases: readonly Kr17PlanCase[]): { evidence: Row[]; violations: string[] } {
  const violations: string[] = [];
  const evidence = cases.map((planCase): Row => {
    if (planCase.observations.length !== KR17.retained) violations.push(`${planCase.name}: ${planCase.observations.length} plan observations were retained, not ${KR17.retained}`);
    planCase.observations.forEach((observation, index) => {
      if (kr17Over(observation.totalMs, KR17.statementStopMs)) {
        violations.push(
          `${planCase.name} · plan observation ${index + 1} of ${planCase.observations.length}: planning ${kr17Ms(observation.planningMs)} ms + execution ` +
          `${kr17Ms(observation.executionMs)} ms = ${kr17Ms(observation.totalMs)} ms against the ${KR17.statementStopMs} ms statement stop · plan ${JSON.stringify(observation.nodes)}`
        );
      }
    });
    const slowest = [...planCase.observations].sort((a, b) => b.totalMs - a.totalMs)[0];
    return {
      plan: planCase.name, parameters: planCase.parameters, statementStopMs: KR17.statementStopMs,
      observationsMs: planCase.observations.map((observation) => ({
        planning: kr17Ms(observation.planningMs), execution: kr17Ms(observation.executionMs), total: kr17Ms(observation.totalMs),
      })),
      maxTotalMs: slowest ? kr17Ms(slowest.totalMs) : null,
      slowestObservationPlan: slowest ? slowest.nodes : null,
    };
  });
  return { evidence, violations };
}

/** What the run was measured on. Printed with every evidence report; none of it is a secret or an id. */
async function kr17Environment(): Promise<Row> {
  const [server] = await query(
    `select version() as version,
            current_setting('shared_buffers') as shared_buffers, current_setting('work_mem') as work_mem,
            current_setting('effective_cache_size') as effective_cache_size, current_setting('random_page_cost') as random_page_cost,
            current_setting('max_parallel_workers_per_gather') as max_parallel_workers_per_gather, current_setting('jit') as jit,
            pg_relation_size('items')::text as items_heap_bytes, pg_relation_size('slack_messages')::text as slack_messages_heap_bytes`
  );
  // The session settings the primitive finds and restores: those of an ordinary pooled connection.
  const pooled = await tx((s) => s.executeSql<Row>(
    `select current_setting('statement_timeout') as statement_timeout, current_setting('lock_timeout') as lock_timeout`
  ));
  return { server, originalSessionSettings: pooled.rows[0], node: process.version, platform: `${process.platform}/${process.arch}` };
}

const kr17Report = (title: string, evidence: Row): void => console.info(`[KR-17 evidence · ${title}]\n${JSON.stringify(evidence, null, 2)}`);

const kr17Change = async (text: string, params: unknown[]): Promise<void> => {
  const result = await (await rawSql()).query(text, params);
  if (result.rowCount !== 1) throw new Error(`fixture: expected to change exactly one row, changed ${result.rowCount}`);
};

describe("KR-17 — the index premise of §7.5, read from the catalog (real Postgres)", () => {
  // §7.5 rests on five statements about the schema. They are facts of the catalog, so they are read
  // from it; a schema that has since gained one of the "absent" indexes has changed the premise of
  // the fixture below, and that is for adjudication, not for this test to absorb.
  it("has the three access paths §7.5 says the schema provides, and neither of the two it says are absent", async () => {
    const indexes = await query<{ table_name: string; index_name: string; is_unique: boolean; columns: string[] }>(
      `select c.relname::text as table_name, i.relname::text as index_name, x.indisunique as is_unique,
              array(select a.attname::text
                      from unnest(x.indkey::int2[]) with ordinality as k(attnum, position)
                      join pg_attribute a on a.attrelid = x.indrelid and a.attnum = k.attnum
                     order by k.position) as columns
         from pg_index x
         join pg_class i on i.oid = x.indexrelid
         join pg_class c on c.oid = x.indrelid
         join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and c.relname in ('items', 'slack_messages')
        order by 1, 2`
    );
    kr17Report("catalog", { indexes });
    const on = (table: string) => indexes.filter((index) => index.table_name === table);
    const leads = (columns: readonly string[], prefix: readonly string[]): boolean => prefix.every((column, position) => columns[position] === column);
    const exactly = (columns: readonly string[], wanted: readonly string[]): boolean => columns.length === wanted.length && leads(columns, wanted);

    // PROVIDED.
    expect(on("items").some((index) => index.is_unique && exactly(index.columns, ["team_id", "id"])),
      "items has a unique index on exactly (team_id, id): the enumeration's key range").toBe(true);
    expect(on("slack_messages").some((index) => leads(index.columns, ["team_id", "item_id", "occurred_at"])),
      "slack_messages has an index leading with (team_id, item_id, occurred_at): the per-item ledger lookup").toBe(true);
    expect(on("slack_messages").some((index) => index.is_unique && exactly(index.columns, ["team_id", "workspace_id", "channel_id", "message_ts"])),
      "slack_messages has a unique index on exactly (team_id, workspace_id, channel_id, message_ts): the root witness").toBe(true);

    // NOT PROVIDED. Either of these changing is a changed premise, not a pass.
    expect(on("items").filter((index) => leads(index.columns, ["team_id", "path"])).map((index) => index.index_name),
      "PREMISE: no index leads with (team_id, path), so a cross-project path conflict check is not an indexed lookup").toEqual([]);
    expect(on("slack_messages").filter((index) => index.columns.includes("root_ts")).map((index) => index.index_name),
      "PREMISE: no index contains root_ts, so the second contradictory-ledger predicate is not an indexed lookup").toEqual([]);
  });
});

describe("KR-17 — the §7.5 single-channel capacity fixture: plans and the numeric stop (real Postgres)", () => {
  interface Capacity {
    f: Published; teamId: string; realItemId: string; realPath: string; slackProjectId: string; capacityProjectId: string;
    cardinalities: Row; statistics: string;
  }
  let loading: Omit<Capacity, "cardinalities" | "statistics"> & { frontmatter: string };
  let readbacks: { items: Row; messages: Row; threadsWithACompleteCohort: number };
  let capacity: Capacity;

  // The fixture is built by the five hooks below, before each of the two cases: the global setup
  // truncates every table before every test, so nothing built earlier survives to be shared.

  // FIRST HALF: the one really published root, and the 100,000 non-Slack items.
  beforeEach(async () => {
    const f = await publishOldRoot();
    const teamId = f.seed.teamId;
    // FIXTURE CLOCK, as everywhere in this file: the published witness is aged so that it is due.
    await ageObservation(teamId);
    const [real] = await query<{ project_id: string; path: string; frontmatter: Record<string, unknown> }>(
      `select project_id::text as project_id, path, frontmatter from items where team_id = $1 and id = $2`, [teamId, f.itemId]
    );
    expect(real.path, "fixture: the published root is at its canonical scoped path").toBe(scopedSlackItemPath(WORKSPACE, CHANNEL, OLD_ROOT));
    const realItemId = f.itemId.toLowerCase();
    expect(realItemId > KR17_ABOVE_EVERY_SYNTHETIC_ID,
      "fixture: the published item's random id sorts after every synthetic id (a one-in-four-billion miss: run again)").toBe(true);

    const [project] = await query<{ id: string }>(`insert into projects (team_id, slug) values ($1, 'kr17-capacity') returning id::text as id`, [teamId]);
    // SYNTHETIC CAPACITY FIXTURE: 100,000 non-Slack items, by one set-based statement.
    const inserted = await (await rawSql()).query(
      `insert into items (id, team_id, project_id, path, kind, access, frontmatter, body, content_sha256, member_id, member_id_locked,
                          created_at, work_at, work_at_from_source, synced_at, updated_at)
       select ('00000000-0000-4000-8000-' || lpad(to_hex(n), 12, '0'))::uuid, $1::uuid, $2::uuid,
              'kr17/capacity-' || lpad(n::text, 6, '0') || '.md', 'deliverable'::item_kind, 'team'::access_tier,
              '{"source":"kr17-capacity","kr17_synthetic":true}'::jsonb, '', repeat('a', 64), null::uuid, false,
              $3::timestamptz, $3::timestamptz, false, $3::timestamptz, $3::timestamptz
         from generate_series(1, $4::int) as n`,
      [teamId, project.id, KR17.observedAt, KR17.nonSlackItems]
    );
    expect(inserted.rowCount, "fixture: the non-Slack items were inserted").toBe(KR17.nonSlackItems);
    loading = {
      f, teamId, realItemId, realPath: real.path, slackProjectId: real.project_id, capacityProjectId: project.id,
      frontmatter: JSON.stringify(real.frontmatter),
    };
  });

  // SECOND HALF, as four hooks that run in this order, each with the hook timeout to itself: 600
  // synthetic canonical roots in the SAME workspace and channel (A), the ledger of all 601 roots (B),
  // exact readbacks (C), and statistics (D). The statements, their order and their parameters are
  // those of the single hook this was.

  // A: the 600 synthetic roots.
  beforeEach(async () => {
    const { teamId, realPath, slackProjectId, frontmatter } = loading;
    const raw = await rawSql();
    const pathPrefix = realPath.slice(0, realPath.length - `${OLD_ROOT}.md`.length);
    expect(`${pathPrefix}${OLD_ROOT}.md`, "fixture: the scoped path ends in the root timestamp").toBe(realPath);

    // SYNTHETIC CAPACITY FIXTURE: 600 root items with the published item's own stored metadata and
    // only the two root timestamps replaced. Same project, kind, access and scoped path shape.
    const roots = await raw.query(
      `insert into items (id, team_id, project_id, path, kind, access, frontmatter, body, content_sha256, member_id, member_id_locked,
                          created_at, work_at, work_at_from_source, synced_at, updated_at)
       select ('00000000-0000-4000-9000-' || lpad(to_hex(k), 12, '0'))::uuid, $1::uuid, $2::uuid,
              $3::text || r.ts || '.md', 'transcript'::item_kind, 'team'::access_tier,
              $4::jsonb || jsonb_build_object('ts', r.ts, 'thread_ts', r.ts, 'kr17_synthetic', true),
              '', repeat('a', 64), null::uuid, false,
              $5::timestamptz, $5::timestamptz, false, $5::timestamptz, $5::timestamptz
         from generate_series(1, $6::int) as k
        cross join lateral (select (1718000000 + k)::text || '.000100' as ts) r`,
      [teamId, slackProjectId, pathPrefix, frontmatter, KR17.observedAt, KR17.syntheticRoots]
    );
    expect(roots.rowCount, "fixture: the synthetic roots were inserted").toBe(KR17.syntheticRoots);
  });

  // B: the root witnesses and the 100 replies of every root.
  beforeEach(async () => {
    const { teamId, realItemId } = loading;
    const raw = await rawSql();
    // SYNTHETIC CAPACITY FIXTURE: the ledger. For each synthetic root, its witness (j = 0) and 100
    // replies; for the published root, replies 2 to 100 — its witness and its first reply are the
    // publication's own rows. Every tenth reply is deleted. All in the one workspace and channel.
    const ledger = await raw.query(
      `with roots as (
         select ('00000000-0000-4000-9000-' || lpad(to_hex(k), 12, '0'))::uuid as item_id,
                (1718000000 + k)::text || '.000100' as root_ts, 0 as first_j
           from generate_series(1, $8::int) as k
         union all
         select $6::uuid, $7::text, 2
       )
       insert into slack_messages (id, team_id, item_id, workspace_id, channel_id, message_ts, root_ts, author_external_id,
                                   occurred_at, is_root, eligible, exclusion_reason, deleted_at, last_seen_generation, source_hash, observed_at)
       select md5('kr17:message:' || r.root_ts || ':' || j::text)::uuid, $1::uuid, r.item_id, $2::text, $3::text,
              split_part(r.root_ts, '.', 1) || '.' || lpad((100 + j)::text, 6, '0'), r.root_ts, 'U1',
              to_timestamp(split_part(r.root_ts, '.', 1)::bigint) + (100 + j) * interval '1 microsecond',
              j = 0, true, null,
              case when j > 0 and j % $10::int = 0 then $4::timestamptz end,
              0, repeat('a', 64), $5::timestamptz
         from roots r
        cross join lateral generate_series(r.first_j, $9::int) as j`,
      [teamId, WORKSPACE, CHANNEL, KR17.deletedAt, KR17.observedAt, realItemId, OLD_ROOT, KR17.syntheticRoots, KR17.repliesPerRoot, KR17.deletedReplyEvery]
    );
    expect(ledger.rowCount, "fixture: the ledger rows were inserted").toBe(KR17_LEDGER_ROWS - 2);
  });

  // C: the cardinality, cohort and canonical readbacks.
  beforeEach(async () => {
    const { teamId, slackProjectId, capacityProjectId } = loading;
    // EXACT READBACKS. The literals are the specification's numbers, not arithmetic on the constants.
    expect({ roots: KR17_ROOTS, items: KR17_ITEMS, ledger: KR17_LEDGER_ROWS, pages: KR17_PAGES })
      .toEqual({ roots: 601, items: 100_601, ledger: 60_701, pages: 1_007 });
    const [items] = await query(
      `select count(*)::int as items,
              count(*) filter (where project_id = $2::uuid)::int as non_slack_items,
              count(*) filter (where project_id = $3::uuid)::int as slack_project_items,
              count(*) filter (where project_id = $3::uuid and kind = 'transcript' and access = 'team'
                                 and frontmatter->>'source' = 'slack' and frontmatter->>'workspace_id' = $4 and frontmatter->>'channel_id' = $5
                                 and frontmatter->>'ts' = frontmatter->>'thread_ts')::int as canonical_shaped_roots,
              count(*) filter (where frontmatter->>'kr17_synthetic' = 'true')::int as labeled_synthetic
         from items where team_id = $1`, [teamId, capacityProjectId, slackProjectId, WORKSPACE, CHANNEL]
    );
    expect(items, "fixture: item cardinalities").toEqual({
      items: 100_601, non_slack_items: 100_000, slack_project_items: 601, canonical_shaped_roots: 601, labeled_synthetic: 100_600,
    });
    const [messages] = await query(
      `select count(*)::int as ledger_rows,
              count(distinct message_ts)::int as distinct_message_ts,
              count(*) filter (where workspace_id = $2 and channel_id = $3)::int as in_the_one_channel,
              count(distinct root_ts)::int as threads,
              count(distinct item_id)::int as owning_items,
              count(*) filter (where is_root)::int as root_rows,
              count(*) filter (where is_root and deleted_at is null and isfinite(observed_at))::int as live_root_witnesses,
              count(*) filter (where not is_root and deleted_at is null)::int as live_replies,
              count(*) filter (where not is_root and deleted_at is not null)::int as deleted_replies
         from slack_messages where team_id = $1`, [teamId, WORKSPACE, CHANNEL]
    );
    expect(messages, "fixture: ledger cardinalities, all in one exact workspace and channel").toEqual({
      ledger_rows: 60_701, distinct_message_ts: 60_701, in_the_one_channel: 60_701, threads: 601, owning_items: 601,
      root_rows: 601, live_root_witnesses: 601, live_replies: 54_090, deleted_replies: 6_010,
    });
    const [shape] = await query<{ threads: number }>(
      `select count(*)::int as threads from (
         select root_ts from slack_messages where team_id = $1
          group by root_ts
         having count(*) = 101 and count(distinct item_id) = 1
            and count(*) filter (where is_root and message_ts = root_ts and deleted_at is null) = 1
            and count(*) filter (where not is_root and deleted_at is null) = 90
            and count(*) filter (where not is_root and deleted_at is not null) = 10
       ) complete`, [teamId]
    );
    expect(shape.threads, "fixture: every root has its whole cohort — one live witness, 90 live and 10 deleted replies, one owning item").toBe(601);
    // Each root item is bound to its own live witness, and sits at the path the real builder gives.
    const bound = await query<{ ts: string; path: string }>(
      `select i.frontmatter->>'ts' as ts, i.path
         from items i
         join slack_messages w on w.team_id = i.team_id and w.item_id = i.id and w.is_root and w.deleted_at is null
                              and w.message_ts = i.frontmatter->>'ts' and w.root_ts = i.frontmatter->>'ts'
        where i.team_id = $1 and i.project_id = $2::uuid
        order by 1`, [teamId, slackProjectId]
    );
    expect(bound.length, "fixture: every root item has its own live witness").toBe(601);
    expect(bound.filter((root) => root.path !== scopedSlackItemPath(WORKSPACE, CHANNEL, root.ts)).length,
      "fixture: every root item is at its canonical scoped path").toBe(0);
    expect(bound.map((root) => root.ts).sort(), "fixture: the 601 roots are exactly the expected ones")
      .toEqual([...Array.from({ length: KR17.syntheticRoots }, (_unused, index) => kr17RootTs(index + 1)), OLD_ROOT].sort());
    expect(await query(`select 1 from slack_sync_threads where team_id = $1`, [teamId]), "fixture: no pending work").toEqual([]);
    readbacks = { items, messages, threadsWithACompleteCohort: shape.threads };
  });

  // D: statistics, and the capacity state the two cases read.
  beforeEach(async () => {
    const { teamId, realItemId, realPath, slackProjectId, capacityProjectId } = loading;
    const { items, messages, threadsWithACompleteCohort } = readbacks;
    const raw = await rawSql();
    // STATISTICS COLLECTION, the last step before anything is measured. ANALYZE only: no VACUUM, no
    // planner setting, no index.
    const analyzed = "items, slack_messages, slack_sync_threads, slack_sync_channels, slack_channel_migration_gates, slack_integration_bindings, integrations, projects";
    await raw.query(`analyze ${analyzed}`);
    capacity = {
      f: loading.f, teamId, realItemId, realPath, slackProjectId, capacityProjectId,
      cardinalities: { items, messages, threadsWithACompleteCohort, workspace: "one", channel: "one", reallyPublishedRoots: 1, syntheticRoots: KR17.syntheticRoots },
      statistics: `ANALYZE ${analyzed} — after loading, before the first measured statement`,
    };
  });

  type Located = Extract<SlackKnownRootEntry, { locator: unknown }>;
  const isLocated = (entry: SlackKnownRootEntry): entry is Located => "locator" in entry;
  const queuedRoots = async (teamId: string): Promise<unknown[]> =>
    (await query(`select root_ts from slack_sync_threads where team_id = $1 order by root_ts`, [teamId])).map((row) => row.root_ts);

  // ── ENUMERATION: page operations. Not evidence of preparation. ─────────────

  it("PAGE ENUMERATION: reads all 100,601 items in exactly 1,007 page transactions of 100, every page operation at most 750 ms and every statement at most 200 ms", async () => {
    const { teamId, f, realItemId } = capacity;
    const request = { teamId, pageSize: KR17.pageSize, revisitAfterMs: REVISIT_AFTER_MS };
    const pageOf = (cursor?: SlackKnownRootItemPage["nextCursor"]) =>
      kr17Measured((session, execution) => readSlackKnownRootItemPage(session, cursor ? { ...request, cursor } : request, execution));

    // The FIRST five ordinary executions of the first-page operation: nothing ran before them.
    const firstPages: (Kr17Sample & { value: SlackKnownRootItemPage })[] = [];
    for (let sample = 0; sample < KR17.retained; sample++) firstPages.push(await pageOf());
    // THE TRAVERSAL: the fifth first page, then every continuation, each on its own transaction.
    const traversal = [firstPages[KR17.retained - 1]];
    for (let cursor = traversal[0].value.nextCursor; cursor !== null; ) {
      if (traversal.length > KR17_PAGES + 10) throw new Error("fixture: the traversal did not end where the population does");
      const next = await pageOf(cursor);
      traversal.push(next);
      cursor = next.value.nextCursor;
    }

    // ── what was traversed: exact pages, exact ids, exact classification ──
    expect(traversal.length, "ceil(100,601 / 100) nonempty pages, one transaction each").toBe(1_007);
    const examinedPerPage = traversal.map((page) => [page.value.examined, page.value.entries.length]);
    expect(examinedPerPage.slice(0, -1).filter(([examined, entries]) => examined !== KR17.pageSize || entries !== KR17.pageSize).length,
      "every page but the last examines exactly 100 items").toBe(0);
    expect(examinedPerPage[examinedPerPage.length - 1], "the last page examines the one remaining item").toEqual([1, 1]);
    expect(traversal.slice(0, -1).filter((page) => page.value.exhausted || page.value.nextCursor === null).length,
      "every page but the last continues").toBe(0);
    expect(traversal[traversal.length - 1].value, "the last page ends the key range").toMatchObject({ exhausted: true, nextCursor: null });

    const examined = traversal.flatMap((page) => page.value.entries);
    const stored = (await query<{ id: string }>(`select id::text as id from items where team_id = $1 order by id`, [teamId])).map((row) => row.id);
    expect([examined.length, stored.length], "one entry per stored item").toEqual([100_601, 100_601]);
    expect(examined.findIndex((entry, index) => entry.itemId !== stored[index]),
      "the traversal returned exactly the stored ids, each once, in PostgreSQL's UUID order (index of the first difference)").toBe(-1);

    const located = examined.filter(isLocated);
    expect([located.length, examined.length - located.length], "601 located roots and 100,000 unlocated items").toEqual([601, 100_000]);
    expect(examined.filter((entry) => !isLocated(entry) && entry.unlocated !== "not_slack").length, "every unlocated item is not_slack").toBe(0);
    expect(located.filter(({ locator }) => locator.workspaceId !== WORKSPACE || locator.channelId !== CHANNEL ||
      locator.integrationId !== f.integrationId || locator.namespaceRevision !== f.namespaceRevision).length,
      "every root is located in the one exact workspace and channel, under the one binding and gate revision").toBe(0);
    expect(located.map(({ locator }) => locator.rootTs).sort(), "the located roots are exactly the fixture's 601")
      .toEqual([...Array.from({ length: KR17.syntheticRoots }, (_unused, index) => kr17RootTs(index + 1)), OLD_ROOT].sort());
    expect(located[located.length - 1].itemId, "the really published root is the last item of the range").toBe(realItemId);
    // Where the roots are: none in the first 1,000 pages, 100 in each of the next six, one in the last.
    const locatedPerPage = traversal.map((page) => page.value.entries.filter(isLocated).length);
    expect(locatedPerPage.slice(0, 1_000).filter((count) => count !== 0).length, "pages 1–1,000 hold only non-Slack items").toBe(0);
    expect(locatedPerPage.slice(1_000), "pages 1,001–1,006 hold 100 located roots each; page 1,007 holds the published one")
      .toEqual([100, 100, 100, 100, 100, 100, 1]);

    // ── what was issued: the exact data statements of every page operation ──
    expect(firstPages.map(kr17DataNames), "a first page issues exactly these data statements").toEqual(firstPages.map(() => KR17_FIRST_PAGE));
    expect(traversal.slice(1).filter((page) => JSON.stringify(kr17DataNames(page)) !== JSON.stringify(KR17_NEXT_PAGE)).map(kr17DataNames).slice(0, 3),
      "a continuation page issues exactly the continuation read and the locator read (first three that did not)").toEqual([]);
    // Enumeration only reads.
    expect(await queuedRoots(teamId), "enumeration created no pending work").toEqual([]);

    // ── retained observations, plans, and the stop ──
    const ordinary = [
      kr17Ordinary("PAGE OPERATION · first page, 100 non-Slack items · five first-page requests", firstPages, KR17.retained, "every observation"),
      kr17Ordinary("PAGE OPERATION · continuation, 100 non-Slack items · traversal pages 2–6", traversal.slice(1, 6), KR17.retained, "every observation"),
      kr17Ordinary("PAGE OPERATION · continuation, 100 located roots · traversal pages 1,001–1,005", traversal.slice(1_000, 1_005), KR17.retained, "every observation"),
      kr17Ordinary("PAGE OPERATION · every page of the traversal, pages 1–1,007", traversal, 1_007, "maximum only"),
    ];
    const plans = kr17Plans([
      ...(await kr17PlanCases("first page, 100 non-Slack items", kr17Data(firstPages[0]))),
      ...(await kr17PlanCases("continuation page 2, 100 non-Slack items", kr17Data(traversal[1]))),
      ...(await kr17PlanCases("continuation page 1,001, after 100,000 ids, 100 located roots", kr17Data(traversal[1_000]))),
    ]);
    const traversalMs = traversal.reduce((total, page) => total + page.operationMs, 0);
    kr17Report("page enumeration", {
      environment: await kr17Environment(), statistics: capacity.statistics, fixture: capacity.cardinalities,
      traversal: {
        pageSize: KR17.pageSize, pageTransactions: traversal.length, additionalFirstPageTransactions: KR17.retained - 1,
        itemsExamined: examined.length, sumOfPageOperationMs: kr17Ms(traversalMs),
      },
      ordinary: ordinary.map((result) => result.evidence), plans: plans.evidence,
    });

    const gaps = [...firstPages, ...traversal].flatMap((page) => kr17DataNames(page)).filter((name) => name.startsWith(KR17_UNNAMED));
    expect([...new Set(gaps)], "EVIDENCE GAP: a data statement of the page read that this test could not name was not measured on trust").toEqual([]);
    expect([...ordinary.flatMap((result) => result.violations), ...plans.violations],
      "§7.5 NUMERIC STOP — PAGE ENUMERATION. Any entry is NOT READY pending schema-owner adjudication, not a test to adjust").toEqual([]);
  });

  // ── PREPARATION: preparation operations. Not evidence of enumeration. ──────

  it("PREPARATION: prepares a root of the 601-root channel to its enqueue, and refuses each hit case, every preparation operation at most 750 ms and every statement at most 200 ms", async () => {
    const { teamId, realItemId, realPath, capacityProjectId } = capacity;

    // The two entries come from the real page reader. The key range is the one a real first page
    // froze; only the position inside it is chosen, so that a page of one lands on the wanted root.
    const range = (await tx((s) => readSlackKnownRootItemPage(
      s, { teamId, pageSize: 1, revisitAfterMs: REVISIT_AFTER_MS }, createSlackKnownRootExecution({ ambientDeadlineAt: null })
    ))).nextCursor;
    if (range === null) throw new Error("fixture: a first page of one item has no continuation");
    const entryAfter = async (afterItemId: string, itemId: string): Promise<Located> => {
      const page = await tx((s) => readSlackKnownRootItemPage(
        s, { teamId, pageSize: 1, revisitAfterMs: REVISIT_AFTER_MS, cursor: { ...range, afterItemId } }, createSlackKnownRootExecution({ ambientDeadlineAt: null })
      ));
      const [entry] = page.entries;
      expect(entry?.itemId, "fixture: the page of one is the wanted root").toBe(itemId);
      if (!entry || !isLocated(entry)) throw new Error("fixture: enumeration did not locate the root");
      return entry;
    };
    const realEntry = await entryAfter(kr17RootItemId(KR17.syntheticRoots), realItemId);
    const syntheticEntry = await entryAfter(kr17RootItemId(299), kr17RootItemId(300));
    expect([realEntry.locator.rootTs, syntheticEntry.locator.rootTs]).toEqual([OLD_ROOT, kr17RootTs(300)]);

    const prepared = (entry: SlackKnownRootEntry) =>
      kr17Measured((session, execution) => prepareSlackKnownRootRequeue(session, { teamId, entry }, execution));
    const ordinary: ReturnType<typeof kr17Ordinary>[] = [];
    const planCases: Kr17PlanCase[] = [];
    const everySample: Kr17Sample[] = [];

    // ── the complete path, to the enqueue: NO-HIT scans of both ledger checks and both path checks ──
    const enqueueCases: [label: string, entry: Located, rootTs: string][] = [
      ["the REALLY PUBLISHED root (last in the channel's message order)", realEntry, OLD_ROOT],
      ["SYNTHETIC capacity root 300 (mid-channel)", syntheticEntry, kr17RootTs(300)],
    ];
    for (const [label, entry, rootTs] of enqueueCases) {
      const samples: (Kr17Sample & { value: SlackKnownRootPreparationResult })[] = [];
      for (let sample = 0; sample < KR17.retained; sample++) {
        // The queue is reset before every observation, so the early existing-row shortcut can never
        // stand in for the full path.
        expect(await queuedRoots(teamId), `${label}, observation ${sample + 1}: fixture: no pending work`).toEqual([]);
        const observed = await prepared(entry);
        expect(observed.value, `${label}, observation ${sample + 1}`).toEqual({ outcome: "enqueued" });
        expect(kr17DataNames(observed), `${label}, observation ${sample + 1}: the complete preparation's data statements, in order`).toEqual(KR17_PREPARATION);
        expect(await queuedRoots(teamId), `${label}, observation ${sample + 1}: exactly this root was enqueued`).toEqual([rootTs]);
        await kr17Change(
          `delete from slack_sync_threads where team_id = $1 and workspace_id = $2 and channel_id = $3 and root_ts = $4`, [teamId, WORKSPACE, CHANNEL, rootTs]
        );
        samples.push(observed);
      }
      everySample.push(...samples);
      ordinary.push(kr17Ordinary(`PREPARATION OPERATION · complete path to the enqueue · ${label}`, samples, KR17.retained, "every observation"));
      // Every statement of that complete preparation, the enqueue insert included, rollback-controlled.
      planCases.push(...(await kr17PlanCases(`preparation to the enqueue, NO HIT, ${label}`, kr17Data(samples[0]))));
      expect(await queuedRoots(teamId), `${label}: the plan observations' enqueue inserts were rolled back`).toEqual([]);
    }

    // ── the hit cases, each on the really published root, each arranged and removed by fixture DML ──
    const SECOND_ITEM = "00000000-0000-4000-a000-000000000001";
    const SCOPED_CONFLICT_ITEM = "00000000-0000-4000-a000-000000000002";
    const LEGACY_CONFLICT_ITEM = "00000000-0000-4000-a000-000000000003";
    const SECOND_REPLY_ROW = "00000000-0000-4000-b000-000000000001";
    // A reply of the published root that is NOT the root's own timestamp, later than every message
    // of the channel: an ordered scan of the channel meets it last.
    const SECOND_REPLY_TS = "1718900000.000250";
    const bareItem = (id: string, path: string): Promise<void> => kr17Change(
      `insert into items (id, team_id, project_id, path, kind, access, frontmatter, body, content_sha256, member_id, member_id_locked)
       values ($1::uuid, $2::uuid, $3::uuid, $4, 'deliverable', 'team', '{"kr17_synthetic":true}'::jsonb, '', repeat('a', 64), null, false)`,
      [id, teamId, capacityProjectId, path]
    );
    const dropItem = (id: string): Promise<void> => kr17Change(`delete from items where team_id = $1 and id = $2::uuid`, [teamId, id]);
    const secondItemReply = async (deleted: boolean): Promise<void> => {
      await bareItem(SECOND_ITEM, "kr17/second-owner.md");
      await kr17Change(
        `insert into slack_messages (id, team_id, item_id, workspace_id, channel_id, message_ts, root_ts, author_external_id,
                                     occurred_at, is_root, eligible, exclusion_reason, deleted_at, source_hash, observed_at)
         values ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6, $7, 'U1',
                 to_timestamp(split_part($6, '.', 1)::bigint) + split_part($6, '.', 2)::integer * interval '1 microsecond',
                 false, true, null, case when $8::boolean then $9::timestamptz end, repeat('a', 64), $10::timestamptz)`,
        [SECOND_REPLY_ROW, teamId, SECOND_ITEM, WORKSPACE, CHANNEL, SECOND_REPLY_TS, OLD_ROOT, deleted, KR17.deletedAt, KR17.observedAt]
      );
    };
    const dropSecondItemReply = async (): Promise<void> => {
      await kr17Change(`delete from slack_messages where team_id = $1 and id = $2::uuid`, [teamId, SECOND_REPLY_ROW]);
      await dropItem(SECOND_ITEM);
    };
    const contradictory: SlackKnownRootPreparationResult = { outcome: "unattested", reason: "contradictory_ledger" };
    const hits: { label: string; arrange: () => Promise<void>; undo: () => Promise<void>; expected: SlackKnownRootPreparationResult; last: string }[] = [
      { label: "HIT: a second item owns a LIVE reply of the root", arrange: () => secondItemReply(false), undo: dropSecondItemReply,
        expected: contradictory, last: "preparation: ledger contradictions" },
      { label: "HIT: a second item owns a DELETED reply of the root", arrange: () => secondItemReply(true), undo: dropSecondItemReply,
        expected: contradictory, last: "preparation: ledger contradictions" },
      { label: "HIT: another project's item is at the root's SCOPED path", arrange: () => bareItem(SCOPED_CONFLICT_ITEM, realPath),
        undo: () => dropItem(SCOPED_CONFLICT_ITEM), expected: { outcome: "refused", reason: "scoped_path_conflict" }, last: "preparation: path conflicts" },
      // The legacy path of the root, WRITTEN OUT, as in the KR-03 group.
      { label: "HIT: an item is at the root's LEGACY path", arrange: () => bareItem(LEGACY_CONFLICT_ITEM, `slack/c0known1170/${OLD_ROOT}.md`),
        undo: () => dropItem(LEGACY_CONFLICT_ITEM), expected: { outcome: "refused", reason: "legacy_path_conflict" }, last: "preparation: path conflicts" },
    ];
    for (const hit of hits) {
      await hit.arrange();
      const expectedStatements = KR17_PREPARATION.slice(0, KR17_PREPARATION.indexOf(hit.last) + 1);
      const samples: (Kr17Sample & { value: SlackKnownRootPreparationResult })[] = [];
      for (let sample = 0; sample < KR17.retained; sample++) {
        const observed = await prepared(realEntry);
        expect(observed.value, `${hit.label}, observation ${sample + 1}`).toEqual(hit.expected);
        expect(kr17DataNames(observed), `${hit.label}, observation ${sample + 1}: the preparation stops at the statement that hit`).toEqual(expectedStatements);
        expect(await queuedRoots(teamId), `${hit.label}, observation ${sample + 1}: nothing was enqueued`).toEqual([]);
        samples.push(observed);
      }
      everySample.push(...samples);
      ordinary.push(kr17Ordinary(`PREPARATION OPERATION · ${hit.label}`, samples, KR17.retained, "every observation"));
      planCases.push(...(await kr17PlanCases(hit.label, kr17Data(samples[0]).filter((statement) => statement.name === hit.last))));
      await hit.undo();
    }
    // With every arranged hit removed, the very same entry prepares: the hits were what was refused.
    expect((await prepared(realEntry)).value, "control: with the hit cases removed the published root prepares again").toEqual({ outcome: "enqueued" });

    const plans = kr17Plans(planCases);
    kr17Report("preparation", {
      environment: await kr17Environment(), statistics: capacity.statistics, fixture: capacity.cardinalities,
      ordinary: ordinary.map((result) => result.evidence), plans: plans.evidence,
    });

    // PLAN PREMISE, not the numeric stop: with no index containing root_ts, the second-item
    // predicate's `root_ts = …` can only ever be a filter over scanned ledger rows.
    const noHitScan = planCases.filter((planCase) => planCase.name.includes("NO HIT") && planCase.name.endsWith("preparation: ledger contradictions"))
      .flatMap((planCase) => planCase.observations).flatMap((observation) => observation.nodes);
    expect(noHitScan.some((node) => node["Relation Name"] === "slack_messages" && String(node.Filter ?? "").includes("root_ts = ")),
      "PLAN PREMISE: the root_ts equality of the second contradictory-ledger predicate is a FILTER on a slack_messages scan").toBe(true);
    expect(noHitScan.filter((node) => String(node["Index Cond"] ?? "").includes("root_ts")).length,
      "PLAN PREMISE: root_ts is never an index condition").toBe(0);

    const gaps = everySample.flatMap((sample) => kr17DataNames(sample)).filter((name) => name.startsWith(KR17_UNNAMED));
    expect([...new Set(gaps)], "EVIDENCE GAP: a data statement of preparation that this test could not name was not measured on trust").toEqual([]);
    expect([...ordinary.flatMap((result) => result.violations), ...plans.violations],
      "§7.5 NUMERIC STOP — PREPARATION. Any entry is NOT READY pending schema-owner adjudication, not a test to adjust").toEqual([]);
  });
});

/**
 * KR-10 and M15a in their REAL-WRAPPER form (`docs/design/slack-known-root-requeue-spec.md` §8.2, §8.3,
 * §11 "Retry and accounting fixtures", §12).
 *
 * EVIDENCE, NOT RED. The unit suite already pins the reducer on receipts a test wrote by hand. This
 * case writes none by hand: every receipt is the FINAL outcome of a complete
 * `runContextTransaction` promise — the actual wrapper, unmodified, on the real pool — and the two
 * outcomes the specification names are real two-attempt transactions.
 *
 *  - THE RETRYABLE FAILURE is raised by the server. After the real preparation has run inside the
 *    callback, the callback issues one fixture statement on the same transaction session whose only
 *    effect is `RAISE EXCEPTION USING ERRCODE = '40001'`. PostgreSQL answers with SQLSTATE 40001,
 *    the driver rejects, the transaction engine rolls the attempt back, and the wrapper's own retry
 *    policy decides what happens next. Nothing is slept on, raced or stubbed, and no source seam is
 *    used: this is the "injected retryable SQLSTATE" the accepted clarification allows.
 *  - ONE EXECUTION CONTEXT per logical invocation, created before the transaction and handed to both
 *    attempts, as §7.2 requires: the second attempt gets no fresh allowance.
 *  - RECEIPTS ARE TERMINAL ONLY. A slot's receipt is built after its promise settles, from the
 *    resolved value or from the exported classifier's reading of the final rejection, and from the
 *    number of callbacks the wrapper ran. What each attempt provisionally returned is kept only to
 *    show that the first attempt's insert was rolled back; it never reaches the reducer.
 *
 * FIRST, A CONTINUATION: a traversal in pages of ONE. The slot of its first page fails terminally,
 * by the same wrapper and the same server-raised 40001, and the cursor that page returned is then
 * used for the next page, which must be the other item. That is "a failed entry does not prevent
 * obtaining the next enumeration page", shown with a real cursor. It involves no tally.
 *
 * THEN TWO SWEEPS, each one real enumeration page of the same two items, each with complete
 * receipts: in the first, both attempts for the published root fail, so its slot is one terminal
 * failure and the root simply waits; in the second — a LATER SWEEP that reads the same page again,
 * not a next page — the first attempt fails and the second commits.
 */
describe("M15a real-wrapper retry accounting — KR-10 through runContextTransaction and a server-raised 40001 (real Postgres)", () => {
  /** FIXTURE STATEMENT: the server raises a serialization failure. It reads and writes nothing. */
  const RAISE_SERIALIZATION_FAILURE =
    `do $$ begin raise exception using errcode = '40001', message = 'aio-1170 fixture: injected serialization failure'; end $$`;

  const NO_UNATTESTED = {
    not_slack: 0, invalid_metadata: 0, missing_channel_binding: 0, missing_namespace_pin: 0, item_missing: 0,
    canonical_mismatch: 0, missing_root_witness: 0, contradictory_ledger: 0,
  };
  const NO_REFUSED = {
    namespace_changed_or_unready: 0, source_not_current: 0, binding_changed: 0, channel_not_public: 0,
    scoped_path_conflict: 0, legacy_path_conflict: 0,
  };
  const NO_FAILURE = {
    lock_timeout: 0, statement_timeout: 0, deadline_exceeded: 0, serialization_failure: 0, deadlock: 0,
    database_failure: 0, dependency_failure: 0, commit_unknown: 0,
  };
  type Tally = ReturnType<typeof tallySlackKnownRootPage>;
  const sum = (counts: Readonly<Record<string, number>>): number => Object.values(counts).reduce((total, count) => total + count, 0);
  /** The tally together with the four sums of §8.2's accounting identity, taken from the tally itself. */
  const accounted = (tally: Tally) => ({
    tally,
    sumOfTheSevenOutcomes: tally.enqueued + tally.already_pending + tally.not_due + tally.unattested + tally.refused + tally.preparation_failed + tally.not_attempted,
    sumOfFailureCounts: sum(tally.failureCounts),
    sumOfUnattestedCounts: sum(tally.unattestedCounts),
    sumOfRefusedCounts: sum(tally.refusedCounts),
  });

  it("counts one serialization_failure for a slot whose two attempts both failed and one enqueued for a slot whose second attempt committed, from the final outcomes of real two-attempt transactions", async () => {
    const f = await publishOldRoot();
    const teamId = f.seed.teamId;
    const unrelatedItemId = await seedUnrelatedItem(f.seed);
    await ageObservation(teamId);
    expect((await stored(teamId)).allQueue, "fixture: no pending work").toEqual([]);

    interface Settled {
      receipt: SlackKnownRootReceipt;
      /** The attempt numbers the WRAPPER passed to the callback, in order. */
      attempts: number[];
      /** What each attempt's preparation returned before its transaction ended. Never a receipt. */
      provisional: SlackKnownRootPreparationResult[];
      rejection: unknown;
    }
    /**
     * ONE logical invocation for one page slot, through the actual wrapper. The fixture statement
     * runs after the preparation on every attempt named in `failingAttempts`.
     */
    async function settle(entryIndex: number, entry: SlackKnownRootEntry, failingAttempts: readonly number[]): Promise<Settled> {
      // Created BEFORE the transaction and shared by every attempt of it.
      const execution = createSlackKnownRootExecution({ ambientDeadlineAt: null });
      const attempts: number[] = [];
      const provisional: SlackKnownRootPreparationResult[] = [];
      try {
        const result = await runContextTransaction(db(), async (session, attempt) => {
          attempts.push(attempt);
          const outcome = await prepareSlackKnownRootRequeue(session, { teamId, entry }, execution);
          provisional.push(outcome);
          if (failingAttempts.includes(attempt)) await session.executeSql(RAISE_SERIALIZATION_FAILURE);
          return outcome;
        });
        // The complete promise RESOLVED: a committed receipt, with the callbacks that actually ran.
        return { receipt: { entryIndex, state: "committed", attempts: attempts.length as 1 | 2, result }, attempts, provisional, rejection: undefined };
      } catch (rejection) {
        // The complete promise finally REJECTED: classified outside it, by the exported classifier.
        const failure = classifySlackKnownRootPreparationFailure(rejection);
        return { receipt: { entryIndex, state: "failed", attempts: attempts.length as 0 | 1 | 2, failure }, attempts, provisional, rejection };
      }
    }
    /** One real enumeration page, one settled invocation per slot in order, and the exported tally of its receipts. */
    async function sweep(rootAttemptsThatFail: readonly number[]) {
      const page = await enumerate(teamId);
      const settled: Settled[] = [];
      for (const [entryIndex, entry] of page.entries.entries()) {
        settled.push(await settle(entryIndex, entry, entry.itemId === f.itemId ? rootAttemptsThatFail : []));
      }
      const rootIndex = page.entries.findIndex((entry) => entry.itemId === f.itemId);
      const unrelatedIndex = page.entries.findIndex((entry) => entry.itemId === unrelatedItemId);
      expect([page.examined, page.entries.length, [rootIndex, unrelatedIndex].sort()], "fixture: the page is the published root and the unrelated item").toEqual([2, 2, [0, 1]]);
      // Every started invocation has settled: the receipts are complete, one per slot.
      const tally = tallySlackKnownRootPage({ examined: page.examined, receipts: settled.map((slot) => slot.receipt) });
      return { page, root: settled[rootIndex], unrelated: settled[unrelatedIndex], rootIndex, unrelatedIndex, tally };
    }
    const notSlack: SlackKnownRootPreparationResult = { outcome: "unattested", reason: "not_slack" };
    const enqueuedTwice: SlackKnownRootPreparationResult[] = [{ outcome: "enqueued" }, { outcome: "enqueued" }];

    // ── CONTINUATION: a slot that failed terminally does not prevent obtaining the NEXT PAGE ──
    // A traversal in pages of one. Whichever of the two items sorts first is the first page's only
    // slot; it is failed on both attempts, and the cursor that page returned is then continued.
    const pageOfOne = (cursor?: SlackKnownRootItemPage["nextCursor"]) => tx((s) => readSlackKnownRootItemPage(
      s, { teamId, pageSize: 1, revisitAfterMs: REVISIT_AFTER_MS, ...(cursor ? { cursor } : {}) }, createSlackKnownRootExecution({ ambientDeadlineAt: null })
    ));
    const firstPage = await pageOfOne();
    const continuation = firstPage.nextCursor;
    expect([firstPage.examined, firstPage.entries.length, firstPage.exhausted, continuation === null],
      "continuation: the first page of one examines one item and is not the end of the range").toEqual([1, 1, false, false]);
    if (continuation === null) throw new Error("fixture: a page of one of two items has no continuation");
    const [firstSlot] = firstPage.entries;
    expect([f.itemId, unrelatedItemId], "continuation: the first slot is one of the team's two items").toContain(firstSlot.itemId);
    const otherItemId = firstSlot.itemId === f.itemId ? unrelatedItemId : f.itemId;
    // The page committed and returned its cursor BEFORE this preparation was started and failed.
    const failedFirstSlot = await settle(0, firstSlot, [1, 2]);
    expect([failedFirstSlot.attempts, failedFirstSlot.receipt], "continuation: the first slot failed terminally, on both attempts, with the server's 40001").toEqual([
      [1, 2], { entryIndex: 0, state: "failed", attempts: 2, failure: "serialization_failure" },
    ]);
    expect((await stored(teamId)).allQueue, "continuation: the failed slot left nothing durable").toEqual([]);
    // THE NEXT PAGE, from the cursor the first page returned: the other item, and the end of the range.
    expect(continuation.afterItemId, "continuation: the cursor continues after the slot that failed").toBe(firstSlot.itemId);
    const nextPage = await pageOfOne(continuation);
    expect([nextPage.examined, nextPage.entries.map((entry) => entry.itemId), nextPage.exhausted, nextPage.nextCursor],
      "continuation: the failed slot did not prevent obtaining the next page, which is the other item").toEqual([1, [otherItemId], true, null]);

    // ── FIRST SWEEP: both attempts for the published root fail with the server's 40001 ──
    const first = await sweep([1, 2]);
    expect(first.root.attempts, "terminal failure: the wrapper ran the callback as attempt 1 and attempt 2, and no third time").toEqual([1, 2]);
    // Each attempt's preparation really reached the enqueue. Had attempt 1's insert survived its
    // rollback, attempt 2 would have found the row and answered `already_pending`.
    expect(first.root.provisional, "terminal failure: each attempt inserted, and each insert was rolled back").toEqual(enqueuedTwice);
    expect(first.root.rejection, "terminal failure: the final rejection is the transaction engine's own error").toBeInstanceOf(TransactionExecutionError);
    expect([(first.root.rejection as TransactionExecutionError).code, (first.root.rejection as TransactionExecutionError).unknownCommit],
      "terminal failure: it carries the server's SQLSTATE and is not an unknown commit").toEqual(["40001", false]);
    expect(first.root.receipt, "terminal failure: ONE failed receipt for the slot, with both attempts counted on it").toEqual({
      entryIndex: first.rootIndex, state: "failed", attempts: 2, failure: "serialization_failure",
    });
    expect([first.unrelated.attempts, first.unrelated.receipt], "the other slot committed on its only attempt").toEqual([
      [1], { entryIndex: first.unrelatedIndex, state: "committed", attempts: 1, result: notSlack },
    ]);
    // TRANSACTION EFFECT, read back: both attempts rolled back, so nothing durable was written.
    const afterFirst = await stored(teamId);
    expect(afterFirst.allQueue, "terminal failure: no pending row survived either attempt").toEqual([]);

    // ── SECOND SWEEP: a LATER sweep, reading the same page again; attempt 1 fails with the same 40001, attempt 2 commits ──
    const second = await sweep([1]);
    expect(second.page, "a later sweep reads the same page again: the entry that failed is simply offered once more").toEqual(first.page);
    expect(second.root.attempts, "retry: the wrapper ran the callback as attempt 1 and attempt 2").toEqual([1, 2]);
    expect(second.root.provisional, "retry: attempt 1 inserted and was rolled back, so attempt 2 inserted again").toEqual(enqueuedTwice);
    expect(second.root.rejection, "retry: the complete promise resolved").toBeUndefined();
    expect(second.root.receipt, "retry: ONE committed receipt for the slot, with both attempts counted on it").toEqual({
      entryIndex: second.rootIndex, state: "committed", attempts: 2, result: { outcome: "enqueued" },
    });
    expect(second.unrelated.receipt).toEqual({ entryIndex: second.unrelatedIndex, state: "committed", attempts: 1, result: notSlack });
    // TRANSACTION EFFECT, read back: exactly one durable row, from the attempt that committed.
    const afterSecond = await stored(teamId);
    expect(afterSecond.allQueue, "retry: exactly one pending row, the root's, queued and due").toEqual([
      { workspace_id: WORKSPACE, channel_id: CHANNEL, root_ts: OLD_ROOT, status: "queued", attempts: 0, due: true },
    ]);
    expect(afterSecond.ledger, "neither sweep touched the ledger").toEqual(afterFirst.ledger);

    // ── THE ACCOUNTING, of both pages at once, as literals ──
    // One contribution per slot however many attempts its transaction took: the two-attempt failure
    // is ONE preparation_failed and ONE serialization_failure; the two-attempt commit is ONE enqueued.
    // Each page's seven outcomes sum to its examined count, and each category sums to its parent.
    expect({ terminalTwoAttemptFailure: accounted(first.tally), retryThatCommitted: accounted(second.tally) },
      "M15a: one contribution per page slot, from real two-attempt transactions").toEqual({
      terminalTwoAttemptFailure: {
        tally: {
          examined: 2, enqueued: 0, already_pending: 0, not_due: 0, unattested: 1, refused: 0, preparation_failed: 1, not_attempted: 0,
          unattestedCounts: { ...NO_UNATTESTED, not_slack: 1 }, refusedCounts: NO_REFUSED, failureCounts: { ...NO_FAILURE, serialization_failure: 1 },
        },
        sumOfTheSevenOutcomes: 2, sumOfFailureCounts: 1, sumOfUnattestedCounts: 1, sumOfRefusedCounts: 0,
      },
      retryThatCommitted: {
        tally: {
          examined: 2, enqueued: 1, already_pending: 0, not_due: 0, unattested: 1, refused: 0, preparation_failed: 0, not_attempted: 0,
          unattestedCounts: { ...NO_UNATTESTED, not_slack: 1 }, refusedCounts: NO_REFUSED, failureCounts: NO_FAILURE,
        },
        sumOfTheSevenOutcomes: 2, sumOfFailureCounts: 0, sumOfUnattestedCounts: 1, sumOfRefusedCounts: 0,
      },
    });
    // The identity itself, as a relation on the reducer's own output rather than on the literals.
    for (const [label, tally] of [["terminal two-attempt failure", first.tally], ["retry that committed", second.tally]] as const) {
      const sums = accounted(tally);
      expect(sums.sumOfTheSevenOutcomes, `${label}: examined is the sum of the seven outcomes`).toBe(tally.examined);
      expect(sums.sumOfFailureCounts, `${label}: failure categories sum to preparation_failed`).toBe(tally.preparation_failed);
      expect(sums.sumOfUnattestedCounts, `${label}: unattested reasons sum to unattested`).toBe(tally.unattested);
      expect(sums.sumOfRefusedCounts, `${label}: refused reasons sum to refused`).toBe(tally.refused);
    }
  });
});

/**
 * M1a — team-bounded enumeration, and the page-boundary part of KR-02 it rests on
 * (`docs/design/slack-known-root-requeue-spec.md` §4.2, §4.3, §11 KR-02, §12 M1a).
 *
 * EVIDENCE, NOT RED: expected to pass on the current source. The falsifier is the fixture: ANOTHER
 * TEAM's item ids are placed INSIDE the key range every page reads — one below the target team's
 * first id, and one immediately after each of its first three ids — so that the only thing keeping
 * them out of a page is the team predicate of the bounded id read itself. None of them is above the
 * upper bound: the kill does not depend on a foreign row falling outside the range, nor on the
 * upper-bound read.
 *
 * The target team has four items: a really published, eligible root; an unrelated item written by
 * ordinary ingest; and two fixture items with the lowest and highest ids, which fix where the range
 * starts and ends whatever random ids the two real items were given. The foreign items are bare
 * fixture rows with chosen ids, in the other team's own project: an id cannot be chosen through the
 * application's writers. Every expected page is written out, for five page sizes — one item per
 * page, an exact multiple, a remainder, exactly the population, and more than the population.
 *
 * NOT CLAIMED: KR-02's 601-root traversal at several page sizes (the KR-17 fixture traverses 601
 * roots at page size 100 only), or anything of KR-04 beyond the case-only stored ids above.
 */
describe("M1a team-bounded enumeration — another team's item ids inside the key range (real Postgres)", () => {
  const FIRST_ID = "00000000-0000-4000-8000-000000000010";
  const LAST_ID = "ffffffff-ffff-4fff-bfff-fffffffffff0";
  const FOREIGN_BELOW_FIRST = "00000000-0000-4000-8000-000000000001";
  /** The UUID that sorts immediately after this one. */
  const nextUuid = (id: string): string => {
    const hex = (BigInt(`0x${id.replace(/-/g, "")}`) + BigInt(1)).toString(16).padStart(32, "0");
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  };
  /** FIXTURE DML: a bare, non-Slack item row with a CHOSEN id. */
  const bareItem = async (id: string, teamId: string, projectId: string, path: string): Promise<void> => {
    const inserted = await (await rawSql()).query(
      `insert into items (id, team_id, project_id, path, kind, access, frontmatter, body, content_sha256, member_id, member_id_locked)
       values ($1::uuid, $2::uuid, $3::uuid, $4, 'deliverable', 'team', '{}'::jsonb, '', repeat('a', 64), null, false)`,
      [id, teamId, projectId, path]
    );
    if (inserted.rowCount !== 1) throw new Error(`fixture: expected to insert exactly one item, inserted ${inserted.rowCount}`);
  };
  /** The page layouts, WRITTEN OUT: for each page size, which of the four ids each page examines. */
  const LAYOUTS: [pageSize: number, pages: number[][]][] = [
    [1, [[0], [1], [2], [3]]],
    [2, [[0, 1], [2, 3]]],
    [3, [[0, 1, 2], [3]]],
    [4, [[0, 1, 2, 3]]],
    [100, [[0, 1, 2, 3]]],
  ];

  it("returns exactly the target team item ids, cursors and exhaustion at every page size while another team has item ids inside every page key range", async () => {
    const f = await publishOldRoot();
    const teamId = f.seed.teamId;
    const unrelatedItemId = await seedUnrelatedItem(f.seed);
    const other = await seedTeam();
    expect(other.teamId, "fixture: the other team is another team").not.toBe(teamId);
    const [mine] = await query<{ id: string }>(`insert into projects (team_id, slug) values ($1, 'm1a-bracket') returning id::text as id`, [teamId]);
    const [theirs] = await query<{ id: string }>(`insert into projects (team_id, slug) values ($1, 'm1a-foreign') returning id::text as id`, [other.teamId]);

    // THE TARGET TEAM: two bracket items around the published root and the ingested item.
    await bareItem(FIRST_ID, teamId, mine.id, "m1a/first.md");
    await bareItem(LAST_ID, teamId, mine.id, "m1a/last.md");
    const publishedId = f.itemId.toLowerCase();
    const [second, third] = [publishedId, unrelatedItemId.toLowerCase()].sort();
    const targetIds = [FIRST_ID, second, third, LAST_ID];
    expect(FIRST_ID < second && second < third && nextUuid(third) < LAST_ID,
      "fixture: the two real items' random ids lie strictly between the bracket ids (a one-in-four-billion miss: run again)").toBe(true);

    // THE OTHER TEAM: one id below the target's first, and the id immediately after each of the
    // target's first three. All four are at or below the target's upper bound.
    const foreignIds = [FOREIGN_BELOW_FIRST, nextUuid(FIRST_ID), nextUuid(second), nextUuid(third)];
    expect(foreignIds.filter((id) => targetIds.includes(id)), "fixture: no foreign id is a target id").toEqual([]);
    expect(foreignIds.filter((id) => id > LAST_ID), "fixture: no foreign id is above the range's upper bound").toEqual([]);
    for (const [index, id] of foreignIds.entries()) await bareItem(id, other.teamId, theirs.id, `m1a/foreign-${index}.md`);

    // READBACK, across both teams and with no team predicate of the product's: the foreign ids
    // really are interleaved with the target's, in PostgreSQL's own UUID order.
    const everyItem = (): Promise<{ id: string; team_id: string }[]> => query<{ id: string; team_id: string }>(
      `select id::text as id, team_id::text as team_id from items where team_id = any($1::uuid[]) order by id`, [[teamId, other.teamId]]
    );
    const interleaved = await everyItem();
    expect(interleaved.map((row) => [row.id, row.team_id === teamId ? "target" : "FOREIGN"]), "fixture: a foreign id inside every page's key range").toEqual([
      [FOREIGN_BELOW_FIRST, "FOREIGN"], [FIRST_ID, "target"], [nextUuid(FIRST_ID), "FOREIGN"], [second, "target"],
      [nextUuid(second), "FOREIGN"], [third, "target"], [nextUuid(third), "FOREIGN"], [LAST_ID, "target"],
    ]);

    // What each target item is: the published root is located by exactly its durable facts; the
    // other three are unlocated, each with the closed reason.
    const channel = await channelRow(teamId, WORKSPACE, CHANNEL);
    expect(channel?.binding_config_revision, "fixture: the channel row stores a configuration revision").toMatch(/^[0-9a-f]{64}$/);
    const entryOf = (itemId: string) => (itemId === publishedId
      ? {
          teamId, itemId, revisitAfterMs: REVISIT_AFTER_MS,
          locator: {
            workspaceId: WORKSPACE, channelId: CHANNEL, rootTs: OLD_ROOT, integrationId: f.integrationId,
            bindingConfigRevision: channel?.binding_config_revision, namespaceRevision: f.namespaceRevision,
          },
        }
      : { teamId, itemId, revisitAfterMs: REVISIT_AFTER_MS, unlocated: "not_slack" });

    for (const [pageSize, layout] of LAYOUTS) {
      // A complete traversal at this page size: the first page, then every cursor it is handed.
      const pages: SlackKnownRootItemPage[] = [];
      for (let cursor: SlackKnownRootItemPage["nextCursor"] | undefined; cursor !== null; ) {
        if (pages.length > 8) throw new Error(`fixture: the traversal at page size ${pageSize} did not end`);
        const request = { teamId, pageSize, revisitAfterMs: REVISIT_AFTER_MS, ...(cursor ? { cursor } : {}) };
        const page = await tx((s) => readSlackKnownRootItemPage(s, request, createSlackKnownRootExecution({ ambientDeadlineAt: null })));
        pages.push(page);
        cursor = page.nextCursor;
      }

      // EVERY page, whole: exactly the target team's ids in order with their entries, the examined
      // count, whether the range ended, and the exact cursor — which continues after the last
      // examined id inside the range the first page froze, or is null on the last page.
      const expected = layout.map((indexes, position) => {
        const ids = indexes.map((index) => targetIds[index]);
        const last = position === layout.length - 1;
        return {
          entries: ids.map(entryOf),
          nextCursor: last ? null : { version: 1, teamId, upperItemId: LAST_ID, afterItemId: ids[ids.length - 1], revisitAfterMs: REVISIT_AFTER_MS },
          exhausted: last,
          examined: ids.length,
        };
      });
      expect(pages, `M1a: exactly the target team's pages at page size ${pageSize}`).toEqual(expected);
      // Stated on its own as well: no entry of any page is another team's item.
      expect(pages.flatMap((page) => page.entries.map((entry) => entry.itemId)).filter((id) => foreignIds.includes(id)),
        `M1a: no foreign item id at page size ${pageSize}`).toEqual([]);
    }

    // Enumeration only reads: no pending work for either team, and both teams' items are as they were.
    expect(await query(`select 1 from slack_sync_threads where team_id = any($1::uuid[])`, [[teamId, other.teamId]]), "no pending work was created for either team").toEqual([]);
    expect(await everyItem(), "no item of either team was added, removed or re-keyed").toEqual(interleaved);
  });
});

/**
 * KR-05 — a witnessed root stays schedulable whatever its attribution, and the three falsifiers of M3
 * (`docs/design/slack-known-root-requeue-spec.md` §5.3, §10, §11 KR-05, §12 M3).
 *
 * EVIDENCE, NOT RED: every case here is expected to pass on the current source. Preparation reads
 * no author, no eligibility verdict, no exclusion reason and no identity mapping, and it must not:
 * "no mapping, correction owner, contributor count or member eligibility controls root scheduling".
 *
 * ONE REFERENCE, AND FOUR SHAPES. The reference is a thread an attribution gate could find nothing
 * wrong with: a root by a human whose account is mapped to a member, and a reply by that same
 * mapped human. Each shape KR-05 names changes the root, or removes the reply, and every reply it
 * has is still the mapped human's:
 *
 *   - the root's author is a human whose account is mapped to nobody. This shape has two mapped
 *     human replies where the reference has one, because KR-05 names "replies";
 *   - the root was posted by a bot, with one mapped human reply. Its root row is ineligible, and
 *     its author is unmapped as well;
 *   - the root has no reply at all, and its author is the mapped human;
 *   - the root is a tombstone, what the provider leaves in place of a deleted root whose replies
 *     live on, with one mapped human reply. Its root row is ineligible, and its author is unmapped
 *     as well.
 *
 * The shapes are therefore NOT each one step from the reference: the unmapped shape also has a
 * second reply, and the bot and tombstone roots differ from it in both eligibility and mapping.
 *
 * WHAT THE PRODUCT WROTE. Every thread is published by the real publication, from the provider's
 * own message shape and a workspace directory, so the ledger's author, eligibility verdict and
 * exclusion reason are the publication's verdicts and not fixture columns. The mapping is written by
 * the product's single identity writer. Each case then reads back, as literals: every ledger row;
 * the team's identity rows; the stored item; and the one entry enumeration returns, with its exact
 * locator. The only fixture DML is the clock — the stored observation is aged, as everywhere in
 * this file — and, in the tombstone case, the root row's `deleted_at`.
 *
 * A TOMBSTONE IS NOT A DELETED WITNESS. `exclusion_reason = 'tombstone'` says the root message is not
 * itself evidence of anybody's work; its row is live and still witnesses the root. `deleted_at` says
 * reconciliation confirmed the message gone, and such a row witnesses nothing — tombstone or not.
 * The tombstone case shows both on one root: with its row also deleted it is `missing_root_witness`
 * and nothing is written; with the row live again, the same entry is enqueued.
 *
 * M3 IS ONE MUTANT: a gate on the root's author. The live root witness is strengthened to require
 * `eligible = true` and a Slack `member_identities` mapping, in the same team, for the root row's
 * `author_external_id`; its scope, liveness and observation predicates stay as they are. Under it
 * the unmapped, bot and tombstone roots are refused, each at its labeled enqueue: those three cases
 * are M3's falsifiers. The reference and the zero-reply root are both roots of the mapped human, so
 * the gate admits them and they still enqueue: they are KR-05 baseline evidence and M3's positive
 * controls, which show a refusal of the other three to be the gate's doing and not a statement that
 * no longer matches anything. A case's two preparations are both made before either is judged, and
 * the labeled enqueue is judged first, so the gate fails each falsifier once, at that label. The
 * tombstone case's contrast is `missing_root_witness` with or without the gate, and does not fail
 * under it.
 *
 * Each case is its own team in a database truncated before it, and ends by counting the queue rows
 * of EVERY team: one.
 */
describe("KR-05 — a witnessed root stays schedulable whatever its attribution (real Postgres)", () => {
  type Outcome = SlackKnownRootPreparationResult;
  interface Shape {
    label: string;
    thread: PublishedThread;
    /** Every ledger row the publication must leave, WRITTEN OUT: message, author, eligible, exclusion reason. */
    ledger: readonly (readonly [messageTs: string, author: string, eligible: boolean, exclusionReason: string | null])[];
  }
  interface Ctx { shape: Shape; teamId: string; entry: SlackKnownRootEntry }

  /** The canonical scoped path of the fixture root, WRITTEN OUT, not built by the code under test. */
  const CANONICAL_PATH = `slack/t0source1/c0known1170/${OLD_ROOT}.md`;
  const SECOND_REPLY = "1718900000.000102";
  /** A human the directory classifies, whose account is mapped to NOBODY. */
  const UNMAPPED_HUMAN = "U1";
  /** A human the directory classifies, whose account every case maps to the team's member. */
  const MAPPED_HUMAN = "U2";
  const BOT_USER = "U0BOT1";
  /** The provider's own service account, which it attributes a tombstone to. */
  const SERVICE_ACCOUNT = "USLACKBOT";
  const DIRECTORY: Readonly<Record<string, SlackEvidenceUser>> = {
    U1: { displayName: "Person One", isBot: false, isAppUser: false },
    U2: { displayName: "Person Two", isBot: false, isAppUser: false },
    U0BOT1: { displayName: "Deploy Bot", isBot: true, isAppUser: false },
  };
  const humanRoot = (user: string): SlackMessage => ({ ts: OLD_ROOT, user, text: "root" });
  const mappedReply = (ts: string): SlackMessage => ({ ts, thread_ts: OLD_ROOT, user: MAPPED_HUMAN, text: "reply" });

  const REFERENCE: Shape = {
    label: "the reference: a mapped human's root with a mapped human reply is enqueued (control, and not an M3 falsifier)",
    thread: { root: humanRoot(MAPPED_HUMAN), replies: [mappedReply(OLD_REPLY)], users: DIRECTORY },
    ledger: [[OLD_ROOT, MAPPED_HUMAN, true, null], [OLD_REPLY, MAPPED_HUMAN, true, null]],
  };
  const UNMAPPED_ROOT: Shape = {
    label: "an UNMAPPED human's root with mapped human replies is enqueued (KR-05, M3)",
    thread: { root: humanRoot(UNMAPPED_HUMAN), replies: [mappedReply(OLD_REPLY), mappedReply(SECOND_REPLY)], users: DIRECTORY },
    ledger: [[OLD_ROOT, UNMAPPED_HUMAN, true, null], [OLD_REPLY, MAPPED_HUMAN, true, null], [SECOND_REPLY, MAPPED_HUMAN, true, null]],
  };
  const BOT_ROOT: Shape = {
    label: "a BOT-authored root with a mapped human reply is enqueued (KR-05, M3)",
    thread: {
      root: { ts: OLD_ROOT, user: BOT_USER, bot_id: "B0BOT1", subtype: "bot_message", text: "automated root" },
      replies: [mappedReply(OLD_REPLY)], users: DIRECTORY,
    },
    ledger: [[OLD_ROOT, BOT_USER, false, "bot_message"], [OLD_REPLY, MAPPED_HUMAN, true, null]],
  };
  const ZERO_REPLY_ROOT: Shape = {
    label: "a ZERO-REPLY root of a mapped human is enqueued (KR-05 baseline, and a positive control for M3)",
    thread: { root: humanRoot(MAPPED_HUMAN), replies: [], users: DIRECTORY },
    ledger: [[OLD_ROOT, MAPPED_HUMAN, true, null]],
  };
  const TOMBSTONE_ROOT: Shape = {
    label: "a TOMBSTONE root with a mapped human reply, its ledger row live, is enqueued (KR-05, M3)",
    thread: {
      root: { ts: OLD_ROOT, user: SERVICE_ACCOUNT, subtype: "tombstone", text: "This message was deleted." },
      replies: [mappedReply(OLD_REPLY)], users: DIRECTORY,
    },
    ledger: [[OLD_ROOT, SERVICE_ACCOUNT, false, "tombstone"], [OLD_REPLY, MAPPED_HUMAN, true, null]],
  };

  const ledgerFacts = (teamId: string): Promise<Row[]> => query(
    `select workspace_id, channel_id, message_ts, root_ts, is_root, item_id::text as item_id, author_external_id,
            eligible, exclusion_reason, deleted_at is null as live, isfinite(observed_at) as finite
       from slack_messages where team_id = $1 order by message_ts`, [teamId]
  );
  /** Everything of the team that identity is stored in: its mappings, its unlink fences and its identity generation. */
  async function identityFacts(teamId: string): Promise<{ identities: Row[]; suppressions: Row[]; identityGeneration: unknown[] }> {
    const identities = await query(
      `select provider, external_id, member_id::text as member_id from member_identities where team_id = $1 order by provider, external_id`, [teamId]
    );
    const suppressions = await query(
      `select provider, external_id from member_identity_suppressions where team_id = $1 order by provider, external_id`, [teamId]
    );
    const state = await query(`select identity_generation::text as identity_generation from slack_team_state where team_id = $1`, [teamId]);
    return { identities, suppressions, identityGeneration: state.map((row) => row.identity_generation) };
  }

  /** The tables preparation could plausibly disturb, with the identity tables: every row of the team, as the database renders it. */
  const SNAPSHOT_TABLES = [
    "items", "slack_messages", "slack_sync_threads", "slack_thread_snapshots", "slack_sync_channels",
    "slack_integration_bindings", "slack_channel_migration_gates", "integrations", "projects",
    "slack_team_state", "slack_method_budgets", "slack_workspace_observations",
    "member_identities", "member_identity_suppressions",
  ];
  const SNAPSHOT_REQUIRED = [
    "items", "slack_messages", "slack_sync_threads", "slack_sync_channels", "slack_integration_bindings",
    "slack_channel_migration_gates", "integrations", "projects", "slack_team_state", "member_identities", "member_identity_suppressions",
  ];
  async function snapshot(teamId: string): Promise<Record<string, string>> {
    const scoped = (await query(
      `select table_name from information_schema.columns
        where table_schema = 'public' and column_name = 'team_id' and table_name = any($1::text[])
        order by table_name`, [SNAPSHOT_TABLES]
    )).map((row) => row.table_name as string);
    for (const required of SNAPSHOT_REQUIRED) expect(scoped, `fixture: ${required} is snapshotted`).toContain(required);
    const out: Record<string, string> = {};
    for (const table of scoped) {
      const [aggregate] = await query(
        `select coalesce(jsonb_agg(to_jsonb(t) order by to_jsonb(t)::text), '[]'::jsonb)::text as rows from "${table}" t where t.team_id = $1`, [teamId]
      );
      out[table] = aggregate.rows as string;
    }
    const [versions] = await query(
      `select coalesce(jsonb_agg(to_jsonb(v) order by to_jsonb(v)::text), '[]'::jsonb)::text as rows
         from item_versions v join items i on i.id = v.item_id where i.team_id = $1`, [teamId]
    );
    out.item_versions = versions.rows as string;
    return out;
  }

  const prepareEntry = (ctx: Ctx): Promise<Outcome> =>
    tx((s) => prepareSlackKnownRootRequeue(s, { teamId: ctx.teamId, entry: ctx.entry }, createSlackKnownRootExecution({ ambientDeadlineAt: null })));

  /**
   * One shape, published by the real publication, with the mapped human's account linked by the
   * product's identity writer, and every fact the case rests on read back as a literal.
   */
  async function published(shape: Shape): Promise<Ctx> {
    const { label } = shape;
    const f = await publishOldRoot(shape.thread);
    const teamId = f.seed.teamId;
    // The mapping: the raw account id, which is what a team that has not been cut over stores.
    const linked = await setMemberIdentity(db(), teamId, f.seed.memberId, { provider: "slack", externalId: MAPPED_HUMAN });
    expect(linked, `${label}: fixture: the mapped human's account was linked to the member`).toMatchObject({ created: true, conflict: false });

    // READBACK — the ledger, exactly as the publication left it: one live, finite row per message of
    // this thread, in the exact provider scope, bound to this item, with the publication's own verdict.
    expect(await ledgerFacts(teamId), `${label}: fixture: the ledger the real publication wrote`).toEqual(
      shape.ledger.map(([messageTs, author, eligible, exclusionReason]) => ({
        workspace_id: WORKSPACE, channel_id: CHANNEL, message_ts: messageTs, root_ts: OLD_ROOT, is_root: messageTs === OLD_ROOT,
        item_id: f.itemId, author_external_id: author, eligible, exclusion_reason: exclusionReason, live: true, finite: true,
      }))
    );
    expect(shape.ledger.map(([messageTs]) => messageTs).filter((messageTs) => messageTs === OLD_ROOT),
      `${label}: fixture: exactly one of those rows is the root's`).toEqual([OLD_ROOT]);
    // READBACK — identity: ONE mapping, the mapped human's, and so none for any other author here.
    expect(await identityFacts(teamId), `${label}: fixture: the mapped human, and nobody else, is mapped`).toEqual({
      identities: [{ provider: "slack", external_id: MAPPED_HUMAN, member_id: f.seed.memberId }],
      suppressions: [],
      identityGeneration: [expect.stringMatching(/^[1-9][0-9]*$/)],
    });
    // READBACK — the item: canonical, in scope, and of the shape the case is about.
    expect(await query(
      `select path, kind::text as kind, access::text as access, frontmatter->>'source' as source,
              frontmatter->>'workspace_id' as workspace_id, frontmatter->>'channel_id' as channel_id,
              frontmatter->>'ts' as ts, frontmatter->>'thread_ts' as thread_ts,
              frontmatter->>'author_id' as root_author, (frontmatter->>'reply_count')::int as reply_count
         from items where team_id = $1`, [teamId]
    ), `${label}: fixture: the team's one item is the canonical item of this root`).toEqual([{
      path: CANONICAL_PATH, kind: "transcript", access: "team", source: "slack", workspace_id: WORKSPACE, channel_id: CHANNEL,
      ts: OLD_ROOT, thread_ts: OLD_ROOT, root_author: shape.thread.root.user, reply_count: shape.thread.replies.length,
    }]);

    // The real enumeration: one item, one located entry, with the authority the real discovery,
    // readiness and publication paths recorded. Nothing below supplies an authority of its own.
    const channel = await channelRow(teamId, WORKSPACE, CHANNEL);
    expect(channel, `${label}: fixture: the channel is public and bound to the seeded integration`).toMatchObject({
      public_state: "public", binding_integration_id: f.integrationId,
    });
    expect(channel?.binding_config_revision, `${label}: fixture: the channel row stores a configuration revision`).toMatch(/^[0-9a-f]{64}$/);
    const page = await enumerate(teamId);
    expect(page, `${label}: fixture: enumeration returns exactly this root, located`).toEqual({
      entries: [{
        teamId, itemId: f.itemId, revisitAfterMs: REVISIT_AFTER_MS,
        locator: {
          workspaceId: WORKSPACE, channelId: CHANNEL, rootTs: OLD_ROOT, integrationId: f.integrationId,
          bindingConfigRevision: channel?.binding_config_revision, namespaceRevision: f.namespaceRevision,
        },
      }],
      nextCursor: null, exhausted: true, examined: 1,
    });
    expect((await stored(teamId)).allQueue, `${label}: fixture: the root has no pending work`).toEqual([]);
    return { shape, teamId, entry: page.entries[0] };
  }

  /**
   * The same entry, prepared twice: once before the revisit interval has passed, and once after the
   * fixture clock has aged the observation. Both calls are made before anything is asserted, and the
   * labeled enqueue is asserted FIRST, so that the M3 gate fails a case it refuses exactly once, there.
   */
  async function staysSchedulable(ctx: Ctx): Promise<void> {
    const { label } = ctx.shape;
    const identity = await identityFacts(ctx.teamId);

    const atPublication = await snapshot(ctx.teamId);
    const fresh = await prepareEntry(ctx);
    const afterFresh = await snapshot(ctx.teamId);
    const queueAfterFresh = (await stored(ctx.teamId)).allQueue;

    // FIXTURE CLOCK: the revisit interval has passed. No attribution fact is touched.
    await ageObservation(ctx.teamId);
    const overdue = await snapshot(ctx.teamId);
    const aged = await prepareEntry(ctx);
    const afterAged = await snapshot(ctx.teamId);

    // KR-05: the root is enqueued. For the unmapped, bot and tombstone roots this is also M3's falsifier.
    expect(aged, label).toEqual({ outcome: "enqueued" });

    // DUE BEHAVIOR. Before the interval had passed the root was admitted and simply not due: the
    // witness, the ledger checks and the path checks all come before the due decision. Nothing was written.
    expect(fresh, `${label}: before the revisit interval has passed it is not due`).toEqual({ outcome: "not_due" });
    expect(queueAfterFresh, `${label}: a root that is not due is not queued`).toEqual([]);
    expect(afterFresh, `${label}: a root that is not due writes nothing`).toEqual(atPublication);

    // THE QUEUE ROW: exactly one, the root's, queued, never attempted and due…
    expect((await stored(ctx.teamId)).allQueue, `${label}: exactly one pending row, in the root's exact scope`).toEqual([
      { workspace_id: WORKSPACE, channel_id: CHANNEL, root_ts: OLD_ROOT, status: "queued", attempts: 0, due: true },
    ]);
    // …at the root witness's own observation plus the revisit interval, rounded up to the millisecond.
    const [derivation] = await query<{ derived: boolean }>(
      `select t.due_at >= w.observed_at + interval '60 seconds'
              and t.due_at < w.observed_at + interval '60 seconds' + interval '1 millisecond' as derived
         from slack_sync_threads t
         join slack_messages w
           on w.team_id = t.team_id and w.workspace_id = t.workspace_id and w.channel_id = t.channel_id
          and w.message_ts = t.root_ts and w.root_ts = t.root_ts and w.is_root and w.deleted_at is null
        where t.team_id = $1 and t.root_ts = $2`, [ctx.teamId, OLD_ROOT]
    );
    expect(derivation?.derived, `${label}: the due instant derives from the root witness's stored observation`).toBe(true);

    // NOTHING ELSE MOVED. The queue is the only table of the team that differs: no item, version,
    // ledger row, channel, binding, gate, integration, project, generation or identity was written.
    expect(afterAged.slack_sync_threads, `${label}: the snapshot sees the queue row`).not.toBe(overdue.slack_sync_threads);
    for (const table of Object.keys(overdue)) {
      if (table !== "slack_sync_threads") expect(afterAged[table], `${label}: ${table} is unchanged by the preparation`).toBe(overdue[table]);
    }
    expect(overdue.member_identities, `${label}: fixture: the snapshot holds the mapping`).toContain(`"external_id": "${MAPPED_HUMAN}"`);
    expect(await identityFacts(ctx.teamId), `${label}: no mapping, unlink fence or identity generation was written`).toEqual(identity);
    expect(await ledgerFacts(ctx.teamId), `${label}: every ledger verdict is as the publication left it`).toEqual(
      ctx.shape.ledger.map(([messageTs, author, eligible, exclusionReason]) => expect.objectContaining({
        message_ts: messageTs, author_external_id: author, eligible, exclusion_reason: exclusionReason, live: true,
      }))
    );

    // ISOLATION: this case's root is the only pending work of ANY team.
    expect(await query(`select team_id::text as team_id, root_ts from slack_sync_threads`), `${label}: the only queue row in the database is this root's`)
      .toEqual([{ team_id: ctx.teamId, root_ts: OLD_ROOT }]);
  }

  it("enqueues the reference thread, a mapped human's root with a mapped human reply (control)", async () =>
    staysSchedulable(await published(REFERENCE)));

  it("enqueues an unmapped human's root that has mapped human replies (KR-05, M3)", async () =>
    staysSchedulable(await published(UNMAPPED_ROOT)));

  it("enqueues a bot-authored root (KR-05, M3)", async () =>
    staysSchedulable(await published(BOT_ROOT)));

  it("enqueues a zero-reply root (KR-05 baseline, and a positive control for M3)", async () =>
    staysSchedulable(await published(ZERO_REPLY_ROOT)));

  it("enqueues a tombstone root whose ledger row is live, and refuses the same root while that row is deleted (KR-05, M3)", async () => {
    const ctx = await published(TOMBSTONE_ROOT);
    const label = "a tombstone root whose ledger row is ALSO deleted is not witnessed (contrast)";
    const rootRow = `team_id = $1 and message_ts = $2 and root_ts = $2 and is_root`;
    const rootFacts = () => query(
      `select eligible, exclusion_reason, deleted_at is null as live from slack_messages where ${rootRow}`, [ctx.teamId, OLD_ROOT]
    );
    /** Fixture DML that must change exactly the root's one ledger row. */
    const changeRoot = async (assignment: string): Promise<void> => {
      const changed = await (await rawSql()).query(`update slack_messages set ${assignment} where ${rootRow}`, [ctx.teamId, OLD_ROOT]);
      if (changed.rowCount !== 1) throw new Error(`fixture: expected to change exactly the root's row, changed ${changed.rowCount}`);
    };

    // THE CONTRAST: the same tombstone root, with its ledger row deleted as reconciliation deletes a
    // message that is gone. The exclusion reason is untouched; only `deleted_at` is set.
    const live = await snapshot(ctx.teamId);
    expect(await rootFacts(), `${label}: fixture: the root's row is a live tombstone`).toEqual([{ eligible: false, exclusion_reason: "tombstone", live: true }]);
    await changeRoot(`deleted_at = clock_timestamp()`);
    expect(await rootFacts(), `${label}: fixture: the same row, the same reason, now deleted`).toEqual([{ eligible: false, exclusion_reason: "tombstone", live: false }]);
    const deleted = await snapshot(ctx.teamId);
    expect(await prepareEntry(ctx), label).toEqual({ outcome: "unattested", reason: "missing_root_witness" });
    expect((await stored(ctx.teamId)).allQueue, `${label}: nothing was enqueued`).toEqual([]);
    expect(await snapshot(ctx.teamId), `${label}: nothing was written`).toEqual(deleted);
    // Undone: the team reads exactly as it did before the row was deleted.
    await changeRoot(`deleted_at = null`);
    expect(await snapshot(ctx.teamId), `${label}: fixture: the deletion is undone, and nothing else differs`).toEqual(live);

    // The live tombstone, from the same entry.
    await staysSchedulable(ctx);
  });
});

/**
 * KR-06 — the deterministic conflict-do-nothing branch, and the falsifier of M4
 * (`docs/design/slack-known-root-requeue-spec.md` §5.2, §5.5, §7.2, §11 KR-06 and "Deterministic
 * conflict-do-nothing race", §12 M4).
 *
 * EVIDENCE, NOT RED: expected to pass on the current source. It is ONE branch of KR-06 — a pending
 * row that appears AFTER preparation's plain queue read and BEFORE its enqueue. The rows that exist
 * before the read (queued, backed off, running, expired, with a partial or a complete snapshot) take
 * the early `already_pending` return and are not this case; they are not claimed here.
 *
 * TWO CONNECTIONS, AND ONE BARRIER THAT IS NOT A SLEEP.
 *
 *   A  the preparation, on its own transaction. It runs on a TEST-ONLY wrapper of that transaction's
 *      `executeSql`. The wrapper forwards every statement unchanged. When the REAL plain queue read
 *      has come back from the database it looks at what came back, tells the test, and then withholds
 *      only the resolution of that one call from the preparer until the test releases it. Nothing in
 *      the product knows the wrapper is there.
 *   C  an independent queue writer, on another connection and its own transaction, using the existing
 *      thread-state helpers and nothing else: enqueue, claim, release, claim, checkpoint, release.
 *      It commits a row no fresh insert could be mistaken for. Discovery is not used: it would need
 *      the integration lock A is holding.
 *
 * While A is held, the test reads from a third connection what the specification says must be true:
 * A's read returned no row; A has no statement in flight and is idle in its transaction, waiting on
 * no lock; the four authority rows are locked; and the item row is not, the item lock not having
 * been requested. The lock probes show that a row is locked, not who holds it: that the holder is A
 * follows from the same probes finding every row free before A starts and after it commits, and
 * from C touching only the queue.
 *
 * THE CONTROLLED CLOCK (§7.2). A's execution context is given a test clock: the real monotonic clock
 * minus the time the barrier held A. It stops when the barrier is reached and resumes, from the same
 * reading, when A is released, so the artificial pause — and only that — is outside A's operation
 * budget. This case proves nothing about timeouts or speed.
 *
 * M4. With the enqueue's `on conflict … do nothing` replaced by a resetting update, the same
 * interleaving rewrites C's row and reports an insertion. The one labeled assertion below then
 * fails: the outcome is `enqueued`, the insert returns a row, and the stored row is no longer the
 * one C committed. An `already_pending` from the early read could not show this, which is why the
 * case first proves that A's read saw nothing.
 */
describe("KR-06 — a queue row committed between the plain queue read and the enqueue is left exactly as committed (real Postgres)", () => {
  const QUEUE_READ = "preparation: plain queue read";
  const ITEM_LOCK = "preparation: item lock";
  const ENQUEUE_INSERT = "preparation: enqueue insert";
  const CONFLICT_READBACK = "preparation: enqueue conflict readback";
  const PAGE_CURSOR = "kr06-backed-off-page-2";
  const M4_LABEL = "M4: the row another connection committed after the plain queue read is preserved field for field, and the conflicting enqueue inserts nothing";

  /** One data statement A was asked for, by name, and how many rows the database returned for it. */
  interface Issued { name: string; rows: number }
  /** What the wrapper saw at the moment it held A. */
  interface AtBarrier { queueReadRows: number; requested: string[]; inFlight: number }

  /** The KR-17 names, and one more: the read the enqueue helper makes only when its insert conflicted. */
  function nameOf(text: string): { name: string; kind: "settings" | "data" } {
    const known = kr17Named(text);
    if (known.kind !== "data" || !known.name.startsWith(KR17_UNNAMED)) return known;
    const flat = text.replace(/\s+/g, " ").trim();
    const conflictReadback = flat.startsWith("select team_id,") &&
      flat.endsWith("from slack_sync_threads where team_id = $1 and workspace_id = $2 and channel_id = $3 and root_ts = $4");
    return conflictReadback ? { name: CONFLICT_READBACK, kind: "data" } : known;
  }

  /** Every row of the team in the tables preparation could plausibly disturb, exactly as the database renders it. */
  const SNAPSHOT_TABLES = [
    "items", "slack_messages", "slack_sync_threads", "slack_thread_snapshots", "slack_sync_channels",
    "slack_integration_bindings", "slack_channel_migration_gates", "integrations", "projects",
    "slack_team_state", "slack_method_budgets", "slack_workspace_observations", "member_identities",
  ];
  const SNAPSHOT_REQUIRED = [
    "items", "slack_messages", "slack_sync_threads", "slack_sync_channels", "slack_integration_bindings",
    "slack_channel_migration_gates", "integrations", "projects",
  ];
  async function snapshot(teamId: string): Promise<Record<string, string>> {
    const scoped = (await query(
      `select table_name from information_schema.columns
        where table_schema = 'public' and column_name = 'team_id' and table_name = any($1::text[])
        order by table_name`, [SNAPSHOT_TABLES]
    )).map((row) => row.table_name as string);
    for (const required of SNAPSHOT_REQUIRED) expect(scoped, `fixture: ${required} is snapshotted`).toContain(required);
    const out: Record<string, string> = {};
    for (const table of scoped) {
      const [aggregate] = await query(
        `select coalesce(jsonb_agg(to_jsonb(t) order by to_jsonb(t)::text), '[]'::jsonb)::text as rows from "${table}" t where t.team_id = $1`, [teamId]
      );
      out[table] = aggregate.rows as string;
    }
    const [versions] = await query(
      `select coalesce(jsonb_agg(to_jsonb(v) order by to_jsonb(v)::text), '[]'::jsonb)::text as rows
         from item_versions v join items i on i.id = v.item_id where i.team_id = $1`, [teamId]
    );
    out.item_versions = versions.rows as string;
    return out;
  }

  /** EVERY column of every queue row of the team, as the database renders the row: ids, counters, state and all timestamps. */
  const queueRowsExactly = async (teamId: string): Promise<string[]> =>
    (await query(`select to_jsonb(t)::text as stored from slack_sync_threads t where t.team_id = $1 order by t.root_ts`, [teamId]))
      .map((row) => row.stored as string);

  it("returns already_pending through the enqueue's own conflict clause, and changes no field of the backed-off row another connection committed after the plain queue read (KR-06 conflict branch, M4)", async () => {
    const f = await publishOldRoot();
    const teamId = f.seed.teamId;
    // Aged, so that nothing but the conflicting row stands between A and an insertion: A is due.
    await ageObservation(teamId);
    const scope = { teamId, workspaceId: WORKSPACE, channelId: CHANNEL, rootTs: OLD_ROOT };
    const page = await enumerate(teamId);
    const entry = page.entries.find((candidate) => candidate.itemId === f.itemId && "locator" in candidate);
    if (!entry) throw new Error("fixture: enumeration did not locate the published root");
    expect((await stored(teamId)).allQueue, "fixture: the root has no pending work").toEqual([]);

    /**
     * Which of the rows preparation locks are free RIGHT NOW, asked from a third connection that
     * waits for nothing: a locked row is skipped, and a free one is locked and released at once.
     * It reports THAT a row is locked, never by which connection.
     */
    const free = async (text: string, params: unknown[]): Promise<"free" | "LOCKED"> =>
      (await query(`${text} for update skip locked`, params)).length === 1 ? "free" : "LOCKED";
    const locks = async () => ({
      namespaceGate: await free(`select 1 as free from slack_channel_migration_gates where team_id = $1 and raw_channel_id = $2`, [teamId, CHANNEL]),
      integration: await free(`select 1 as free from integrations where team_id = $1 and id = $2`, [teamId, f.integrationId]),
      binding: await free(`select 1 as free from slack_integration_bindings where team_id = $1 and integration_id = $2`, [teamId, f.integrationId]),
      channel: await free(`select 1 as free from slack_sync_channels where team_id = $1 and workspace_id = $2 and channel_id = $3`, [teamId, WORKSPACE, CHANNEL]),
      item: await free(`select 1 as free from items where team_id = $1 and id = $2`, [teamId, f.itemId]),
    });
    const ALL_FREE = { namespaceGate: "free", integration: "free", binding: "free", channel: "free", item: "free" };
    expect(await locks(), "fixture: all five rows exist and none is locked before A starts (the probe's own control)").toEqual(ALL_FREE);
    const atStart = await snapshot(teamId);

    // ── THE BARRIER: two observable promises. Nothing here waits for time to pass. ──
    let signalReached!: (seen: AtBarrier) => void;
    const reached = new Promise<AtBarrier>((resolve) => { signalReached = resolve; });
    let releaseA!: () => void;
    const released = new Promise<void>((resolve) => { releaseA = resolve; });
    /** Release A's barrier, once. Every later call does nothing. */
    let barrierReleased = false;
    const releaseBarrier = (): void => {
      if (barrierReleased) return;
      barrierReleased = true;
      releaseA();
    };
    // LAST RESORT, for a case whose body does not reach the `try`/`finally` below, or that times out:
    // when the case finishes, this releases A's barrier. It RELEASES ONLY. It does not await A's
    // transaction, which then ends asynchronously, some time after this hook has returned. When the
    // `finally` below did run, it has already released A and this does nothing. The hook asserts
    // nothing and throws nothing, so it cannot replace the error the case ended with.
    onTestFinished(() => {
      releaseBarrier();
    });

    // ── THE CONTROLLED CLOCK of §7.2: the real monotonic clock, less the time the barrier holds A. ──
    let excludedMs = 0;
    let heldSince: number | null = null;
    const monotonicNow = (): number => (heldSince ?? performance.now()) - excludedMs;
    const clockIsStopped = (): boolean => heldSince !== null;
    // Created before A's transaction, as every execution context is.
    const execution = createSlackKnownRootExecution({ ambientDeadlineAt: null, monotonicNow });

    // ── A's TEST-ONLY executor wrapper. Every statement is forwarded unchanged. ──
    const issued: Issued[] = [];
    const requested: string[] = [];
    let inFlight = 0;
    let held = false;
    const barrierSession = (session: TransactionSession): TransactionSession => {
      const executeSql: SqlExecutor = async <T = Record<string, unknown>>(text: string, params?: unknown[]) => {
        const { name, kind } = nameOf(text);
        if (kind === "data") requested.push(name);
        inFlight += 1;
        const result = await session.executeSql<T>(text, params).finally(() => { inFlight -= 1; });
        if (kind === "data") issued.push({ name, rows: result.rows.length });
        if (name === QUEUE_READ && !held) {
          // The ACTUAL plain queue read has returned. What it returned is reported as it is.
          held = true;
          const heldAt = performance.now();
          heldSince = heldAt; // the controlled clock stops
          signalReached({ queueReadRows: result.rows.length, requested: [...requested], inFlight });
          await released; // ONLY the resolution to the preparer is withheld
          excludedMs += performance.now() - heldAt;
          heldSince = null; // ordinary progression again, from the reading it stopped at
        }
        return result;
      };
      return {
        get db() {
          return session.db;
        },
        executeSql,
        optionalAudit<T>(operation: () => Promise<T>, fallback: T): Promise<T> {
          return session.optionalAudit(operation, fallback);
        },
      };
    };

    // ── CONNECTION A: the preparation, from the team and the enumerated entry alone. ──
    let pidOfA = 0;
    const preparation = tx(async (a) => {
      pidOfA = Number((await a.executeSql<{ pid: number }>(`select pg_backend_pid() as pid`)).rows[0].pid);
      return prepareSlackKnownRootRequeue(barrierSession(a), { teamId, entry }, execution);
    });
    type Settled = { state: "resolved"; value: SlackKnownRootPreparationResult } | { state: "rejected"; error: unknown };
    const settled: Promise<Settled> = preparation.then(
      (value) => ({ state: "resolved" as const, value }),
      (error: unknown) => ({ state: "rejected" as const, error })
    );
    const seen = await Promise.race([
      reached,
      settled.then((ended): AtBarrier => {
        if (ended.state === "rejected") throw ended.error;
        throw new Error("fixture: the preparation ended before its plain queue read was held");
      }),
    ]);

    let committedRows: string[] = [];
    let afterC: Record<string, string> = {};
    let pidOfC = 0;
    try {
      const stoppedAt = monotonicNow();

      // ── A IS HELD. What the wrapper saw: the real read returned NO row; nothing is in flight; the
      //    four authority locks and the queue read were asked for, in order, and nothing after them. ──
      expect(seen, "barrier: A's actual plain queue read returned no row, with nothing in flight and the item lock not yet requested").toEqual({
        queueReadRows: 0, inFlight: 0, requested: KR17_PREPARATION.slice(0, KR17_PREPARATION.indexOf(QUEUE_READ) + 1),
      });
      expect([seen.requested.includes(QUEUE_READ), seen.requested.includes(ITEM_LOCK)], "barrier: the queue read was requested and the item lock was not").toEqual([true, false]);
      // What the DATABASE says about A, from another connection: idle in its transaction, waiting on no lock.
      expect(await query(
        `select a.state, a.wait_event_type is not distinct from 'Lock' as waiting_for_a_lock,
                (select count(*)::int from pg_locks l where l.pid = a.pid and not l.granted) as ungranted_locks
           from pg_stat_activity a where a.pid = $1`, [pidOfA]
      ), "barrier: A has no statement in flight and no lock wait is running").toEqual([
        { state: "idle in transaction", waiting_for_a_lock: false, ungranted_locks: 0 },
      ]);
      // The four authority rows are LOCKED and the item row is free. The probe shows that a row is
      // locked, not by whom. That it is A follows from the controls: the same probe found all five
      // rows free before A started and finds them free again after A commits, and the only other
      // writer, C, touches the queue table and none of these rows.
      expect(await locks(), "barrier: A holds its authority locks and not the item lock").toEqual({
        namespaceGate: "LOCKED", integration: "LOCKED", binding: "LOCKED", channel: "LOCKED", item: "free",
      });
      expect((await stored(teamId)).allQueue, "barrier: no queue row is committed, as A's read said").toEqual([]);

      // ── CONNECTION C: an independent writer, the existing helpers only, ONE committed transaction. ──
      const written = await tx(async (c) => {
        pidOfC = Number((await c.executeSql<{ pid: number }>(`select pg_backend_pid() as pid`)).rows[0].pid);
        const enqueued = await enqueueSlackThread(c, scope);
        const first = await claimSlackThread(c, scope, { leaseMs: 60_000 });
        if (!first) throw new Error("fixture: C's first claim was refused");
        const retried = await releaseSlackThreadForRetry(c, first, { nextDueAt: new Date(Date.now() - 60_000), errorCode: "slack_timeout" });
        const second = await claimSlackThread(c, scope, { leaseMs: 60_000 });
        if (!second) throw new Error("fixture: C's second claim was refused");
        const progressed = await checkpointSlackThread(c, second, { pageCursor: PAGE_CURSOR, snapshotGeneration: 3 });
        const backedOff = await releaseSlackThreadForRetry(c, second, { nextDueAt: new Date(Date.now() + 3_600_000), errorCode: "rate_limited" });
        return { inserted: enqueued.inserted, retried: retried.outcome, progressed: progressed.outcome, backedOff: backedOff.outcome };
      });
      // C's own enqueue INSERTED: there was no row for it to conflict with either.
      expect(written, "fixture: C inserted the row, then claimed, released, claimed, checkpointed and released it").toEqual({
        inserted: true, retried: "released", progressed: "checkpointed", backedOff: "released",
      });
      expect([pidOfA > 0, pidOfC > 0, pidOfC !== pidOfA], "fixture: C ran on another connection than A").toEqual([true, true, true]);

      // ── THE COMMITTED ROW, read back and RETAINED: every column, as the database renders it. ──
      committedRows = await queueRowsExactly(teamId);
      expect(committedRows, "fixture: C committed exactly one queue row").toHaveLength(1);
      expect(await query(
        `select status, attempts, lease_generation::text as lease_generation, lease_owner, lease_expires_at, page_cursor,
                snapshot_generation::text as snapshot_generation, last_error_code, checkpointed_at is not null as checkpointed,
                due_at > clock_timestamp() + interval '30 minutes' as backed_off, updated_at > created_at as updated_after_creation
           from slack_sync_threads where team_id = $1 and workspace_id = $2 and channel_id = $3 and root_ts = $4`, [teamId, WORKSPACE, CHANNEL, OLD_ROOT]
      ), "fixture: the committed row is recognizably NOT a fresh insert: backed off, twice attempted, fenced, checkpointed, with an error code").toEqual([{
        status: "queued", attempts: 2, lease_generation: "2", lease_owner: null, lease_expires_at: null, page_cursor: PAGE_CURSOR,
        snapshot_generation: "3", last_error_code: "rate_limited", checkpointed: true, backed_off: true, updated_after_creation: true,
      }]);
      afterC = await snapshot(teamId);
      for (const table of Object.keys(atStart)) {
        if (table !== "slack_sync_threads") expect(afterC[table], `fixture: C changed nothing of the team but the queue (${table})`).toBe(atStart[table]);
      }
      expect(afterC.slack_sync_threads, "fixture: the snapshot sees C's row").not.toBe(atStart.slack_sync_threads);

      // A is STILL held exactly where it was, and its clock has not moved while C worked.
      expect(await locks(), "barrier: A still holds its authority locks and still not the item lock").toEqual({
        namespaceGate: "LOCKED", integration: "LOCKED", binding: "LOCKED", channel: "LOCKED", item: "free",
      });
      // `requested` is the wrapper's live list; `seen.requested` is the copy it took when it held A.
      expect([held, clockIsStopped(), monotonicNow() === stoppedAt, requested, issued.map((statement) => statement.name).includes(ITEM_LOCK)],
        "barrier: A is held, its controlled clock is stopped, and it has issued nothing since").toEqual([true, true, true, seen.requested, false]);
    } finally {
      // RELEASE A — also when something above failed, so that A never outlives the case.
      releaseBarrier();
      await settled;
    }
    const ended = await settled;
    if (ended.state === "rejected") throw ended.error;

    // ── M4's FALSIFIER, FIRST. A reached the existing enqueue's conflict clause: its insert returned
    //    no row, its outcome is `already_pending`, and the stored row is, column for column, the row
    //    C committed. A resetting update fails this one assertion. ──
    const rowsOf = (name: string): number[] => issued.filter((statement) => statement.name === name).map((statement) => statement.rows);
    expect({ outcome: ended.value, rowsReturnedByTheEnqueueInsert: rowsOf(ENQUEUE_INSERT), queueRows: await queueRowsExactly(teamId) }, M4_LABEL).toEqual({
      outcome: { outcome: "already_pending" }, rowsReturnedByTheEnqueueInsert: [0], queueRows: committedRows,
    });

    // ── THE BRANCH, in A's own statements. After its release A locked the item, read the project,
    //    proved the witness, checked both contradictions and both paths, decided it was due, issued
    //    the enqueue insert, and — because that insert conflicted — read the existing row back. ──
    expect(issued.map((statement) => statement.name), "branch: the complete preparation, then the conflict readback").toEqual([...KR17_PREPARATION, CONFLICT_READBACK]);
    expect({ queueRead: rowsOf(QUEUE_READ), itemLock: rowsOf(ITEM_LOCK), conflictReadback: rowsOf(CONFLICT_READBACK) },
      "branch: the queue read saw no row, the item lock found the item, and the conflict readback found C's row").toEqual({
      queueRead: [0], itemLock: [1], conflictReadback: [1],
    });

    // ── NOTHING ELSE MOVED, AND THERE IS NO SECOND ROW. A's whole transaction changed no row of the
    //    team in any snapshotted table, the queue included. ──
    expect(await snapshot(teamId), "A's committed transaction changed nothing: every snapshotted table reads as it did after C committed").toEqual(afterC);
    expect(await query(`select team_id::text as team_id, root_ts from slack_sync_threads`), "the only queue row in the database is the one C committed").toEqual([
      { team_id: teamId, root_ts: OLD_ROOT },
    ]);
    expect(await locks(), "A committed and released every lock").toEqual(ALL_FREE);
    // The controlled clock is running again, from where it stopped; the pause it excluded was real.
    expect([clockIsStopped(), excludedMs > 0], "the controlled clock resumed on release").toEqual([false, true]);
  });
});

/**
 * KR-07 — the EXACT persisted due instant, and the falsifier of M5
 * (`docs/design/slack-known-root-requeue-spec.md` §5.5, §11 KR-07, §12 M5).
 *
 * EVIDENCE, NOT RED: every case here is expected to pass on the current source. It is PART of
 * KR-07: the due instant a preparation persists, for four literal observations, and one future
 * observation that must not be due. The rest of KR-07 is not claimed here — `clock_timestamp()`
 * against the transaction's start time, the finite bounds, and an unchanged publication refreshing
 * the observation without semantic-generation churn.
 *
 * EVERYTHING EXPECTED IS A LITERAL. Each overdue case sets the root witness's stored observation to
 * a written-out UTC instant, enumerates under a written-out revisit interval, and requires the
 * committed queue row's `due_at` to be a written-out UTC instant. The expected instant is not
 * computed here, by this file or by SQL that mirrors the product's: it was worked out by hand, as
 * the observation plus the interval, rounded UP to the next whole millisecond. What is compared is
 * the database's own rendering of the stored `due_at` in UTC with six fractional digits, as text.
 * No JavaScript `Date` is on that path.
 *
 * WHAT EACH OVERDUE CASE IS THERE FOR.
 *
 *   aligned       the sum is already on a millisecond: an unconditional "+1 ms" would be wrong.
 *   one micro     the sum is one microsecond past a millisecond: truncation, and rounding to the
 *                 nearest millisecond, would both land one millisecond early.
 *   rollover      the ceiling carries into the next second.
 *   whole day     the maximum interval, with the micro again: a hard-coded 60 seconds would be wrong.
 *
 * The second case's interval is 60,001 ms, so no case but the first and third could pass with a
 * hard-coded 60,000. NOT CLAIMED: that these cases tell a ceiling taken AFTER the interval is added
 * from one taken before it. The interval is a whole number of milliseconds, and the two agree.
 *
 * THE FIXTURE. Every case starts from the real publication. The only fixture DML is the stored
 * observation of the ONE root witness row, changed by a statement that must change exactly one row
 * and read back as text. The reply's row is not touched. Enumeration and preparation each run on a
 * transaction of their own, each with an execution context created before that transaction, and
 * preparation is given the team and the enumerated entry and nothing else.
 *
 * M5. With the line that turns the database's due instant into the persisted one replaced by the
 * moment of the invocation (`const dueAt = dueDate(due.due_epoch_ms);` → `const dueAt = new Date();`),
 * each overdue case still enqueues and still passes every assertion before the one labeled
 * "M5: persisted due is the literal observation-derived instant" — and fails there, because the
 * stored instant is then today and not in July 2024. The future control returns `not_due` before
 * that line is reached, and passes with or without the mutant.
 *
 * The named-table snapshot shows that these preparations wrote nothing else to those tables. It is
 * not the whole of KR-13.
 */
describe("KR-07 exact due persistence — observation age and millisecond ceiling (real Postgres)", () => {
  const M5_LABEL = "M5: persisted due is the literal observation-derived instant";

  /** An instant as the DATABASE renders it: UTC, six fractional digits, as text. The expression is parenthesized as a whole. */
  const utc = (expression: string): string => `to_char((${expression}) at time zone 'UTC', 'YYYY-MM-DD HH24:MI:SS.US') || '+00'`;
  /** The one root witness row of the fixture, as `w`, and no other ledger row. */
  const ROOT_WITNESS = `w.team_id = $1 and w.workspace_id = $2 and w.channel_id = $3 and w.message_ts = $4 and w.root_ts = $4 and w.is_root and w.item_id = $5::uuid`;
  const witnessOf = (f: Published): unknown[] => [f.seed.teamId, WORKSPACE, CHANNEL, OLD_ROOT, f.itemId];

  /** FIXTURE DML: the stored observation of the root witness row, and of that row only. */
  async function setRootObservation(f: Published, observedAt: string, label: string): Promise<void> {
    const changed = await (await rawSql()).query(
      `update slack_messages w set observed_at = $6::timestamptz where ${ROOT_WITNESS}`, [...witnessOf(f), observedAt]
    );
    expect(changed.rowCount, `${label}: fixture: exactly one ledger row, the root witness, was changed`).toBe(1);
  }
  /** The root witness as stored: its observation as text, whether it is live, and how many of the team's ledger rows carry that same instant. */
  const rootWitness = (f: Published): Promise<Row[]> => query(
    `select ${utc("w.observed_at")} as observed_at_utc, w.deleted_at is null as live,
            (select count(*)::int from slack_messages m where m.team_id = w.team_id and m.observed_at = w.observed_at) as rows_with_this_observation
       from slack_messages w where ${ROOT_WITNESS}`, witnessOf(f)
  );
  /** Every queue row of the team: its scope and state, and its due instant as the database renders it. */
  const queueOf = (teamId: string): Promise<Row[]> => query(
    `select workspace_id, channel_id, root_ts, status, attempts, ${utc("due_at")} as due_at_utc
       from slack_sync_threads where team_id = $1 order by root_ts`, [teamId]
  );

  /** Every row of the team in the named tables, exactly as the database renders it. Not the whole of KR-13. */
  const SNAPSHOT_TABLES = [
    "items", "slack_messages", "slack_sync_threads", "slack_thread_snapshots", "slack_sync_channels",
    "slack_integration_bindings", "slack_channel_migration_gates", "integrations", "projects", "slack_team_state",
  ];
  async function snapshot(teamId: string): Promise<Record<string, string>> {
    const scoped = (await query(
      `select table_name from information_schema.columns
        where table_schema = 'public' and column_name = 'team_id' and table_name = any($1::text[])
        order by table_name`, [SNAPSHOT_TABLES]
    )).map((row) => row.table_name as string);
    for (const required of SNAPSHOT_TABLES) expect(scoped, `fixture: ${required} is snapshotted`).toContain(required);
    const out: Record<string, string> = {};
    for (const table of scoped) {
      const [aggregate] = await query(
        `select coalesce(jsonb_agg(to_jsonb(t) order by to_jsonb(t)::text), '[]'::jsonb)::text as rows from "${table}" t where t.team_id = $1`, [teamId]
      );
      out[table] = aggregate.rows as string;
    }
    const [versions] = await query(
      `select coalesce(jsonb_agg(to_jsonb(v) order by to_jsonb(v)::text), '[]'::jsonb)::text as rows
         from item_versions v join items i on i.id = v.item_id where i.team_id = $1`, [teamId]
    );
    out.item_versions = versions.rows as string;
    return out;
  }

  /** The real publication, checked to have acknowledged: no queue row and no staging are left. */
  async function published(label: string): Promise<Published> {
    const f = await publishOldRoot();
    const afterPublication = await stored(f.seed.teamId);
    expect([afterPublication.allQueue, afterPublication.snapshots], `${label}: fixture: the real publication removed the queue row and the staging`).toEqual([[], 0]);
    return f;
  }

  /** The real enumeration under THIS case's revisit policy, on its own transaction: the one located entry of the published root. */
  async function enumerated(f: Published, revisitAfterMs: number, label: string): Promise<SlackKnownRootEntry> {
    const teamId = f.seed.teamId;
    const channel = await channelRow(teamId, WORKSPACE, CHANNEL);
    expect(channel?.binding_config_revision, `${label}: fixture: the channel row stores a configuration revision`).toMatch(/^[0-9a-f]{64}$/);
    // The execution context is created BEFORE the transaction it is used in.
    const execution = createSlackKnownRootExecution({ ambientDeadlineAt: null });
    const page = await tx((s) => readSlackKnownRootItemPage(s, { teamId, pageSize: 100, revisitAfterMs }, execution));
    expect(page, `${label}: fixture: enumeration returns exactly this root, located, under this case's revisit policy`).toEqual({
      entries: [{
        teamId, itemId: f.itemId, revisitAfterMs,
        locator: {
          workspaceId: WORKSPACE, channelId: CHANNEL, rootTs: OLD_ROOT, integrationId: f.integrationId,
          bindingConfigRevision: channel?.binding_config_revision, namespaceRevision: f.namespaceRevision,
        },
      }],
      nextCursor: null, exhausted: true, examined: 1,
    });
    return page.entries[0];
  }

  /** Preparation on a transaction of its own, from the team and the enumerated entry ALONE. The result is the COMMITTED one. */
  function prepared(teamId: string, entry: SlackKnownRootEntry): Promise<SlackKnownRootPreparationResult> {
    // The execution context is created BEFORE the transaction it is used in.
    const execution = createSlackKnownRootExecution({ ambientDeadlineAt: null });
    return tx((s) => prepareSlackKnownRootRequeue(s, { teamId, entry }, execution));
  }

  interface Overdue {
    /** The root witness's stored observation, WRITTEN OUT. */
    observedAt: string;
    /** The revisit interval the traversal is started with, WRITTEN OUT. */
    revisitAfterMs: number;
    /** The due instant that must be persisted, WRITTEN OUT: worked out by hand, not computed. */
    dueAt: string;
  }

  /** One overdue case: the committed queue row's due instant is the literal one, and nothing else of the named tables moved. */
  async function persistsExactly(label: string, expected: Overdue): Promise<void> {
    const f = await published(label);
    const teamId = f.seed.teamId;

    // FIXTURE DML, and its readback as text: ONE row, the root witness, at the literal instant.
    await setRootObservation(f, expected.observedAt, label);
    expect(await rootWitness(f), `${label}: fixture: the root witness stores exactly the literal observation, live, and no other ledger row carries it`).toEqual([
      { observed_at_utc: expected.observedAt, live: true, rows_with_this_observation: 1 },
    ]);
    // FIXTURE EVIDENCE, not the product's due decision: the literal expected instant is already past.
    expect(await query(`select $1::timestamptz < clock_timestamp() as already_past`, [expected.dueAt]), `${label}: fixture: the literal due instant is already past`).toEqual([
      { already_past: true },
    ]);

    const entry = await enumerated(f, expected.revisitAfterMs, label);
    const before = await snapshot(teamId);
    const result = await prepared(teamId, entry);
    const queue = await queueOf(teamId);
    const after = await snapshot(teamId);

    expect(result, `${label}: the committed outcome`).toEqual({ outcome: "enqueued" });
    // THE STORED VALUE, as text from the database, against the literal. M5's falsifier.
    expect(queue.map((row) => row.due_at_utc), M5_LABEL).toEqual([expected.dueAt]);

    // Exactly one row, in the root's exact scope, queued and never attempted; and no staging.
    expect(queue.map((row) => ({ workspace_id: row.workspace_id, channel_id: row.channel_id, root_ts: row.root_ts, status: row.status, attempts: row.attempts })),
      `${label}: exactly one queue row, in the root's exact scope, queued and never attempted`).toEqual([
      { workspace_id: WORKSPACE, channel_id: CHANNEL, root_ts: OLD_ROOT, status: "queued", attempts: 0 },
    ]);
    expect((await stored(teamId)).snapshots, `${label}: no staging`).toBe(0);
    expect(await query(`select team_id::text as team_id, root_ts from slack_sync_threads`), `${label}: the only queue row in the database is this root's`).toEqual([
      { team_id: teamId, root_ts: OLD_ROOT },
    ]);
    // Of the named tables, only the queue differs; and the witness still stores the literal observation.
    expect(after.slack_sync_threads, `${label}: the snapshot sees the queue row`).not.toBe(before.slack_sync_threads);
    for (const table of Object.keys(before)) {
      if (table !== "slack_sync_threads") expect(after[table], `${label}: ${table} is unchanged by the preparation`).toBe(before[table]);
    }
    expect(await rootWitness(f), `${label}: the root witness's observation is still exactly the literal`).toEqual([
      { observed_at_utc: expected.observedAt, live: true, rows_with_this_observation: 1 },
    ]);
  }

  it("persists the due instant unchanged when the observation plus the interval already falls on a millisecond (aligned, 60,000 ms)", () =>
    persistsExactly("aligned", {
      observedAt: "2024-07-01 12:34:56.123000+00", revisitAfterMs: 60_000, dueAt: "2024-07-01 12:35:56.123000+00",
    }));

  it("persists the due instant rounded UP to the next millisecond when the sum is one microsecond past one (60,001 ms)", () =>
    persistsExactly("one microsecond past a millisecond", {
      observedAt: "2024-07-01 12:34:56.123001+00", revisitAfterMs: 60_001, dueAt: "2024-07-01 12:35:56.125000+00",
    }));

  it("persists the due instant carried into the next second when the observation ends in .999999 (rollover, 60,000 ms)", () =>
    persistsExactly("rollover into the next second", {
      observedAt: "2024-07-01 12:34:56.999999+00", revisitAfterMs: 60_000, dueAt: "2024-07-01 12:35:57.000000+00",
    }));

  it("persists the due instant a whole day after the observation, rounded UP, under the maximum interval (86,400,000 ms)", () =>
    persistsExactly("the maximum interval, a whole day", {
      observedAt: "2024-07-01 12:34:56.123001+00", revisitAfterMs: 86_400_000, dueAt: "2024-07-02 12:34:56.124000+00",
    }));

  it("is not due, and writes nothing, when the root witness's observation is a day in the future (control, 60,000 ms)", async () => {
    const label = "future observation (control)";
    const f = await published(label);
    const teamId = f.seed.teamId;

    // An exact FUTURE instant, captured from the database's own clock as text, then stored and read back.
    const [{ future }] = await query<{ future: string }>(`select ${utc("clock_timestamp() + interval '1 day'")} as future`);
    await setRootObservation(f, future, label);
    expect(await rootWitness(f), `${label}: fixture: the root witness stores exactly the captured future observation, live, and no other ledger row carries it`).toEqual([
      { observed_at_utc: future, live: true, rows_with_this_observation: 1 },
    ]);
    // FIXTURE EVIDENCE, not the product's due decision: the observation, and so anything derived from it by adding an interval, is in the future.
    expect(await query(`select $1::timestamptz > clock_timestamp() + interval '23 hours' as in_the_future`, [future]), `${label}: fixture: the stored observation is in the future`).toEqual([
      { in_the_future: true },
    ]);

    const entry = await enumerated(f, 60_000, label);
    const before = await snapshot(teamId);
    const result = await prepared(teamId, entry);
    const after = await snapshot(teamId);

    expect(result, `${label}: the committed outcome`).toEqual({ outcome: "not_due" });
    expect(await queueOf(teamId), `${label}: no queue row`).toEqual([]);
    expect((await stored(teamId)).snapshots, `${label}: no staging`).toBe(0);
    expect(await query(`select 1 as pending from slack_sync_threads`), `${label}: no queue row of any team`).toEqual([]);
    expect(after, `${label}: every named table, the queue included, is unchanged by the preparation`).toEqual(before);
    expect(await rootWitness(f), `${label}: the root witness's observation is still exactly the captured one`).toEqual([
      { observed_at_utc: future, live: true, rows_with_this_observation: 1 },
    ]);
  });
});

/**
 * KR-07 — the DECISION CLOCK: due-ness is decided against `clock_timestamp()`, not against the
 * moment the preparation's transaction began
 * (`docs/design/slack-known-root-requeue-spec.md` §5.5, §11 KR-07).
 *
 * EVIDENCE, NOT RED, AND SUPPLEMENTARY: every case here is expected to pass on the current source.
 * It adds the clock part of KR-07 to the exact-persistence part above. It closes no row of the
 * mutation matrix. Still not claimed: KR-07's finite and conversion bounds, and an unchanged
 * publication refreshing the observation without semantic-generation churn.
 *
 * THE CROSSED CASE. Preparation runs inside the caller's transaction, and a transaction can be
 * older than the instant a root comes due. The case builds exactly that, with no sleep and no
 * mocked clock, by ordering completed queries:
 *
 *   1. transaction A begins, and through A's own executor its `transaction_timestamp()` and its
 *      backend pid are read and kept;
 *   2. while A sits idle in its transaction — no statement in flight, and no preparation lock,
 *      because preparation has not been called — an independent connection C sets the root
 *      witness's observation to the DATABASE's `clock_timestamp() - interval '60 seconds'` and
 *      commits. Under the minimum interval of 60,000 ms the exact due instant is therefore the
 *      instant of C's own statement: after A began, and already past for any later statement;
 *   3. through A it is read back that A is the same connection in the same transaction, that C was
 *      another connection, and that `transaction_timestamp() < exact due <= clock_timestamp()`;
 *   4. the real preparation is then called in that same transaction A, and A commits.
 *
 * The clock that says the root is due is the statement clock. The transaction's start says it is
 * not. A decision made against the transaction's start would answer `not_due`.
 *
 * TWO CONTROLS. A root whose due instant was already past before A began is enqueued under either
 * clock. A root whose due instant is a day ahead is `not_due` under either clock. They show that
 * the crossed case's result is about WHICH clock, not about the fixture.
 *
 * FIXTURE AGING is labeled as such wherever it happens. It is the only fixture DML: one statement on
 * the one root witness row, which must change exactly one row. Fixture facts are asserted before
 * the preparation is called, under `fixture` labels, so a setup that did not produce the intended
 * interleaving fails as a fixture and cannot be read as a behavioral result.
 *
 * THE EXECUTION CONTEXT is created before transaction A and is never replaced: A's fixture reads,
 * C's statement and a snapshot all happen inside its allowance. It is created with the largest
 * allowance the contract permits, 5,000 ms, because the crossed case does fixture work between the
 * context's creation and the preparation. This suite is not timeout evidence.
 *
 * THE LATER CONTROLLED FALSIFIER, not made here: in the due read, the one decision comparison
 * `<= clock_timestamp()` becomes `<= transaction_timestamp()`, with the arithmetic, the ceiling,
 * the witness and the enqueue untouched. Expected: this suite passes 3 of 3 before and after; under
 * the substitution ONLY the crossed case fails, at the assertion labeled
 * "KR-07 CLOCK: due after transaction start is enqueued", receiving `not_due`; both controls pass.
 * A setup, deadline or SQL failure, or any other failed case, is inconclusive and not a kill.
 *
 * The named-table snapshot is not the whole of KR-13.
 */
describe("KR-07 decision clock", () => {
  const CLOCK_LABEL = "KR-07 CLOCK: due after transaction start is enqueued";
  /** The minimum revisit interval. The fixture's `interval '60 seconds'` below is this same interval, written out. */
  const REVISIT_MS = 60_000;

  /** An instant as the DATABASE renders it: UTC, six fractional digits, as text. The expression is parenthesized as a whole. */
  const utc = (expression: string): string => `to_char((${expression}) at time zone 'UTC', 'YYYY-MM-DD HH24:MI:SS.US') || '+00'`;
  /** The one root witness row of the fixture, as `w`, and no other ledger row. */
  const ROOT_WITNESS = `w.team_id = $1 and w.workspace_id = $2 and w.channel_id = $3 and w.message_ts = $4 and w.root_ts = $4 and w.is_root and w.item_id = $5::uuid`;
  const witnessOf = (f: Published): unknown[] => [f.seed.teamId, WORKSPACE, CHANNEL, OLD_ROOT, f.itemId];

  /** What the fixture aging stored, as the database renders it, and the connection that stored it. */
  interface Aged {
    pidOfC: number;
    /** The root witness's stored observation. */
    observedAt: string;
    /** The observation plus the 60,000 ms interval, to the microsecond: the exact due instant, before any rounding. */
    exactDue: string;
  }

  /**
   * FIXTURE AGING, on an independent connection C, in one transaction that commits before this
   * returns: the root witness's observation becomes the database's own clock shifted by `shift`.
   * It must change exactly one row. What it stored is returned as the database renders it.
   */
  async function ageRootWitness(f: Published, shift: "- interval '60 seconds'" | "- interval '2 hours'" | "+ interval '1 day'", label: string): Promise<Aged> {
    const written = await tx(async (c) => {
      const pid = Number((await c.executeSql<{ pid: number }>(`select pg_backend_pid() as pid`)).rows[0].pid);
      const changed = await c.executeSql<{ observed_at_utc: string; exact_due_utc: string }>(
        `update slack_messages w set observed_at = clock_timestamp() ${shift}
          where ${ROOT_WITNESS}
      returning ${utc("w.observed_at")} as observed_at_utc, ${utc("w.observed_at + interval '60 seconds'")} as exact_due_utc`, witnessOf(f)
      );
      return { pid, rows: changed.rows };
    });
    expect(written.rows.length, `${label}: fixture aging: exactly one ledger row, the root witness, was changed`).toBe(1);
    const aged: Aged = { pidOfC: written.pid, observedAt: written.rows[0].observed_at_utc, exactDue: written.rows[0].exact_due_utc };
    expect(await rootWitness(f), `${label}: fixture aging: the committed root witness stores exactly that observation, live, and no other ledger row carries it`).toEqual([
      { observed_at_utc: aged.observedAt, live: true, rows_with_this_observation: 1 },
    ]);
    return aged;
  }
  /** The root witness as stored: its observation as text, whether it is live, and how many of the team's ledger rows carry that same instant. */
  const rootWitness = (f: Published): Promise<Row[]> => query(
    `select ${utc("w.observed_at")} as observed_at_utc, w.deleted_at is null as live,
            (select count(*)::int from slack_messages m where m.team_id = w.team_id and m.observed_at = w.observed_at) as rows_with_this_observation
       from slack_messages w where ${ROOT_WITNESS}`, witnessOf(f)
  );

  /** Every row of the team in the named tables, exactly as the database renders it. Not the whole of KR-13. */
  const SNAPSHOT_TABLES = [
    "items", "slack_messages", "slack_sync_threads", "slack_thread_snapshots", "slack_sync_channels",
    "slack_integration_bindings", "slack_channel_migration_gates", "integrations", "projects", "slack_team_state",
  ];
  async function snapshot(teamId: string): Promise<Record<string, string>> {
    const scoped = (await query(
      `select table_name from information_schema.columns
        where table_schema = 'public' and column_name = 'team_id' and table_name = any($1::text[])
        order by table_name`, [SNAPSHOT_TABLES]
    )).map((row) => row.table_name as string);
    for (const required of SNAPSHOT_TABLES) expect(scoped, `fixture: ${required} is snapshotted`).toContain(required);
    const out: Record<string, string> = {};
    for (const table of scoped) {
      const [aggregate] = await query(
        `select coalesce(jsonb_agg(to_jsonb(t) order by to_jsonb(t)::text), '[]'::jsonb)::text as rows from "${table}" t where t.team_id = $1`, [teamId]
      );
      out[table] = aggregate.rows as string;
    }
    const [versions] = await query(
      `select coalesce(jsonb_agg(to_jsonb(v) order by to_jsonb(v)::text), '[]'::jsonb)::text as rows
         from item_versions v join items i on i.id = v.item_id where i.team_id = $1`, [teamId]
    );
    out.item_versions = versions.rows as string;
    return out;
  }

  /** The real publication, checked to have acknowledged, and the real enumeration under the minimum interval, on its own completed transaction. */
  async function publishedAndEnumerated(label: string): Promise<{ f: Published; entry: SlackKnownRootEntry }> {
    const f = await publishOldRoot();
    const teamId = f.seed.teamId;
    const afterPublication = await stored(teamId);
    expect([afterPublication.allQueue, afterPublication.snapshots], `${label}: fixture: the real publication removed the queue row and the staging`).toEqual([[], 0]);
    const channel = await channelRow(teamId, WORKSPACE, CHANNEL);
    expect(channel?.binding_config_revision, `${label}: fixture: the channel row stores a configuration revision`).toMatch(/^[0-9a-f]{64}$/);
    const pageExecution = createSlackKnownRootExecution({ ambientDeadlineAt: null });
    const page = await tx((s) => readSlackKnownRootItemPage(s, { teamId, pageSize: 100, revisitAfterMs: REVISIT_MS }, pageExecution));
    expect(page, `${label}: fixture: enumeration returns exactly this root, located, under the minimum revisit interval`).toEqual({
      entries: [{
        teamId, itemId: f.itemId, revisitAfterMs: 60_000,
        locator: {
          workspaceId: WORKSPACE, channelId: CHANNEL, rootTs: OLD_ROOT, integrationId: f.integrationId,
          bindingConfigRevision: channel?.binding_config_revision, namespaceRevision: f.namespaceRevision,
        },
      }],
      nextCursor: null, exhausted: true, examined: 1,
    });
    return { f, entry: page.entries[0] };
  }

  /** The context of ONE preparation, created BEFORE its transaction A and never replaced. The largest allowance the contract permits. */
  const contextBeforeA = (): SlackKnownRootExecution => createSlackKnownRootExecution({ ambientDeadlineAt: null, allowanceMs: 5_000 });

  /** Where an exact due instant lies against A's two clocks, read through A's OWN executor, with A's identity. */
  interface ClockFacts {
    pid: number;
    transaction_start: string;
    transaction_starts_before_due: boolean;
    due_before_transaction_start: boolean;
    due_by_the_decision_clock: boolean;
  }
  async function clockFacts(a: TransactionSession, exactDue: string): Promise<ClockFacts> {
    const { rows } = await a.executeSql<ClockFacts>(
      `select pg_backend_pid() as pid, ${utc("transaction_timestamp()")} as transaction_start,
              transaction_timestamp() < $1::timestamptz as transaction_starts_before_due,
              $1::timestamptz < transaction_timestamp() as due_before_transaction_start,
              $1::timestamptz <= clock_timestamp() as due_by_the_decision_clock`, [exactDue]
    );
    return { ...rows[0], pid: Number(rows[0].pid) };
  }

  /** The committed state after an enqueue, read on another connection: the queue row, its persisted due, and nothing else moved. */
  async function enqueuedExactly(f: Published, aged: Aged, before: Record<string, string>, label: string): Promise<void> {
    const teamId = f.seed.teamId;
    // The persisted due is the retained exact due rounded UP to its millisecond: not before it, less
    // than a millisecond after it, and on a whole millisecond. Only one instant is all three.
    expect(await query(
      `select t.workspace_id, t.channel_id, t.root_ts, t.status, t.attempts,
              t.due_at >= $2::timestamptz as not_before_the_exact_due,
              t.due_at < $2::timestamptz + interval '1 millisecond' as less_than_a_millisecond_after_it,
              to_char(t.due_at at time zone 'UTC', 'US') like '%000' as on_a_whole_millisecond
         from slack_sync_threads t where t.team_id = $1 order by t.root_ts`, [teamId, aged.exactDue]
    ), `${label}: exactly one queue row, in the root's exact scope, queued and never attempted, due at the exact due instant rounded up to its millisecond`).toEqual([{
      workspace_id: WORKSPACE, channel_id: CHANNEL, root_ts: OLD_ROOT, status: "queued", attempts: 0,
      not_before_the_exact_due: true, less_than_a_millisecond_after_it: true, on_a_whole_millisecond: true,
    }]);
    expect((await stored(teamId)).snapshots, `${label}: no staging`).toBe(0);
    expect(await query(`select team_id::text as team_id, root_ts from slack_sync_threads`), `${label}: the only queue row in the database is this root's`).toEqual([
      { team_id: teamId, root_ts: OLD_ROOT },
    ]);
    const after = await snapshot(teamId);
    expect(after.slack_sync_threads, `${label}: the snapshot sees the queue row`).not.toBe(before.slack_sync_threads);
    for (const table of Object.keys(before)) {
      if (table !== "slack_sync_threads") expect(after[table], `${label}: ${table} is unchanged by the preparation`).toBe(before[table]);
    }
    expect(await rootWitness(f), `${label}: the root witness is unchanged by the preparation`).toEqual([
      { observed_at_utc: aged.observedAt, live: true, rows_with_this_observation: 1 },
    ]);
  }

  // THE FALSIFIER of a decision made against the transaction's start.
  it("enqueues a root whose due instant falls after the preparation's transaction began and before its due decision (crossed transaction start)", async () => {
    const label = "crossed transaction start";
    const { f, entry } = await publishedAndEnumerated(label);
    const teamId = f.seed.teamId;

    // Created BEFORE transaction A. Everything A does before the preparation is inside this allowance.
    const execution = contextBeforeA();
    const committed = await tx(async (a) => {
      // 1. A HAS BEGUN. Its transaction start and its backend pid, through A's own executor.
      const begun = await a.executeSql<{ pid: number; transaction_start: string }>(
        `select pg_backend_pid() as pid, ${utc("transaction_timestamp()")} as transaction_start`
      );
      const pidOfA = Number(begun.rows[0].pid);
      const transactionStart = begun.rows[0].transaction_start;

      // 2. FIXTURE AGING, by C, while A is idle: the exact due instant becomes the instant of C's own
      //    statement, which is after A began. C commits before this returns.
      const aged = await ageRootWitness(f, "- interval '60 seconds'", label);
      // What the DATABASE says about A, from a third connection: idle in its transaction, waiting on no lock.
      expect(await query(
        `select s.state, s.wait_event_type is not distinct from 'Lock' as waiting_for_a_lock,
                (select count(*)::int from pg_locks l where l.pid = s.pid and not l.granted) as ungranted_locks
           from pg_stat_activity s where s.pid = $1`, [pidOfA]
      ), `${label}: fixture: A is idle in its transaction, with no statement in flight and no lock wait, while C ages the witness`).toEqual([
        { state: "idle in transaction", waiting_for_a_lock: false, ungranted_locks: 0 },
      ]);
      const before = await snapshot(teamId);

      // 3. THE INTERLEAVING, read through A: the same connection, the same transaction, another
      //    connection than C; and the exact due instant is AFTER A's start and NOT AFTER the clock.
      const facts = await clockFacts(a, aged.exactDue);
      expect({
        sameConnection: facts.pid === pidOfA, sameTransactionStart: facts.transaction_start === transactionStart, cWasAnotherConnection: aged.pidOfC !== pidOfA,
        transaction_starts_before_due: facts.transaction_starts_before_due, due_before_transaction_start: facts.due_before_transaction_start,
        due_by_the_decision_clock: facts.due_by_the_decision_clock,
      }, `${label}: fixture: transaction_timestamp() < exact due <= clock_timestamp(), in the one unchanged transaction A, with C another connection`).toEqual({
        sameConnection: true, sameTransactionStart: true, cWasAnotherConnection: true,
        transaction_starts_before_due: true, due_before_transaction_start: false, due_by_the_decision_clock: true,
      });

      // 4. THE REAL PREPARATION, in the same transaction A, from the team and the enumerated entry alone.
      const result = await prepareSlackKnownRootRequeue(a, { teamId, entry }, execution);
      return { result, aged, before };
    });

    // A COMMITTED. The decision was made against the clock: the root is enqueued.
    expect(committed.result, CLOCK_LABEL).toEqual({ outcome: "enqueued" });
    await enqueuedExactly(f, committed.aged, committed.before, label);
  });

  it("enqueues a root whose due instant was already past when the preparation's transaction began (positive control)", async () => {
    const label = "already overdue before the transaction (control)";
    const { f, entry } = await publishedAndEnumerated(label);
    const teamId = f.seed.teamId;

    // FIXTURE AGING, completed and committed BEFORE transaction A begins: due about two hours ago.
    const aged = await ageRootWitness(f, "- interval '2 hours'", label);
    const before = await snapshot(teamId);

    const execution = contextBeforeA();
    const result = await tx(async (a) => {
      const facts = await clockFacts(a, aged.exactDue);
      expect({
        transaction_starts_before_due: facts.transaction_starts_before_due, due_before_transaction_start: facts.due_before_transaction_start,
        due_by_the_decision_clock: facts.due_by_the_decision_clock,
      }, `${label}: fixture: exact due < transaction_timestamp(), so the root is due under either clock`).toEqual({
        transaction_starts_before_due: false, due_before_transaction_start: true, due_by_the_decision_clock: true,
      });
      return prepareSlackKnownRootRequeue(a, { teamId, entry }, execution);
    });

    expect(result, `${label}: the committed outcome`).toEqual({ outcome: "enqueued" });
    await enqueuedExactly(f, aged, before, label);
  });

  it("is not due when the due instant is a day ahead of both the transaction's start and the decision clock (negative control)", async () => {
    const label = "a day ahead of both clocks (control)";
    const { f, entry } = await publishedAndEnumerated(label);
    const teamId = f.seed.teamId;

    // FIXTURE AGING, the other way and by the database's own clock: the observation is a day AHEAD.
    const aged = await ageRootWitness(f, "+ interval '1 day'", label);
    const before = await snapshot(teamId);
    const AHEAD_OF_BOTH = { transaction_starts_before_due: true, due_before_transaction_start: false, due_by_the_decision_clock: false };
    const position = (facts: ClockFacts) => ({
      transaction_starts_before_due: facts.transaction_starts_before_due, due_before_transaction_start: facts.due_before_transaction_start,
      due_by_the_decision_clock: facts.due_by_the_decision_clock,
    });

    const execution = contextBeforeA();
    const committed = await tx(async (a) => {
      const beforePreparation = await clockFacts(a, aged.exactDue);
      expect(position(beforePreparation), `${label}: fixture: before the preparation the exact due is ahead of the transaction's start and of the clock`).toEqual(AHEAD_OF_BOTH);
      const result = await prepareSlackKnownRootRequeue(a, { teamId, entry }, execution);
      // Read through A again, in the same transaction, after the preparation has returned.
      const afterPreparation = await clockFacts(a, aged.exactDue);
      return { result, beforePreparation, afterPreparation };
    });

    expect({
      position: position(committed.afterPreparation),
      sameConnection: committed.afterPreparation.pid === committed.beforePreparation.pid,
      sameTransactionStart: committed.afterPreparation.transaction_start === committed.beforePreparation.transaction_start,
    }, `${label}: fixture: after the preparation, in the same transaction, the exact due is still ahead of both clocks`).toEqual({
      position: AHEAD_OF_BOTH, sameConnection: true, sameTransactionStart: true,
    });
    expect(committed.result, `${label}: the committed outcome`).toEqual({ outcome: "not_due" });
    expect(await query(`select 1 as pending from slack_sync_threads`), `${label}: no queue row, of this team or any other`).toEqual([]);
    expect((await stored(teamId)).snapshots, `${label}: no staging`).toBe(0);
    expect(await snapshot(teamId), `${label}: every named table, the queue included, is unchanged by the preparation`).toEqual(before);
    expect(await rootWitness(f), `${label}: the root witness is unchanged by the preparation`).toEqual([
      { observed_at_utc: aged.observedAt, live: true, rows_with_this_observation: 1 },
    ]);
  });
});

/**
 * KR-07 — FINITE observations at and beyond the upper arithmetic guard of the due read
 * (`docs/design/slack-known-root-requeue-spec.md` §5.5, §11 KR-07).
 *
 * EVIDENCE, NOT RED, AND SUPPLEMENTARY: every case here is expected to pass on the current source.
 * It closes no row of the mutation matrix. The due read does its date arithmetic only for an
 * observation at or before 9999-12-31 00:00:00 UTC; a later one is answered `not_due` without being
 * added to. These cases CHARACTERIZE that conservative cutoff as it is. They are not a claim about
 * calendar support in general. Still not claimed: KR-07's JavaScript conversion boundaries, an
 * unchanged publication refreshing the observation, and other clock variants.
 *
 * FOUR STORED OBSERVATIONS, all finite, all written out, all under the maximum interval of
 * 86,400,000 ms:
 *
 *   ordinary     2024-07-01 12:34:56.123001   enqueued, at its literal due instant. The control: the
 *                                             maximum interval does enqueue an overdue root.
 *   boundary     9999-12-31 00:00:00.000000   exactly AT the guard. Added to, and not due.
 *   above        9999-12-31 00:00:00.000001   one microsecond ABOVE the guard. Not added to; not due.
 *   extreme      294276-12-31 00:00:00.000000 a finite instant PostgreSQL stores, whose sum with the
 *                                             interval it CANNOT represent. Not added to; not due.
 *
 * NO EXTREME VALUE EVER BECOMES A JAVASCRIPT DATE. Every observation is written as text, cast by the
 * database, and read back as the database's own text rendering.
 *
 * THE EXTREME CASE HAS TWO SEPARATE THINGS IN IT, which must not be confused.
 *
 *   The FIXTURE PROBE, on another connection and before any preparation, deliberately asks the
 *   database for that observation plus the interval and requires the statement to FAIL with SQLSTATE
 *   22008. Its error is caught there and nowhere else. It proves the hazard is real; if it does not
 *   fail that way the case stops as a fixture failure, before any product verdict.
 *
 *   The DUE OBSERVER is a test-only wrapper of the preparation's own executor. It forwards every
 *   statement unchanged; for the actual due read and for nothing else it counts the statement and,
 *   if that statement is rejected, records the rejection's SQLSTATE and rethrows the same error. The
 *   probe's 22008 cannot reach it. Outside the transaction, the preparation's end is formed into one
 *   closed observation — the committed outcome or the classified failure, how many due reads were
 *   issued, and the SQLSTATE of a rejected one — and that observation is asserted whole, under the
 *   label "KR-07 FINITE: extreme finite observation commits not_due without arithmetic overflow".
 *   A preparation that threw is therefore a failed assertion with its cause in it, never an
 *   uncaught error.
 *
 * THE LATER CONTROLLED FALSIFIER, not made here: in the due read, both occurrences — and only those
 * two — of `case when w.observed_at <= timestamptz '9999-12-31 00:00:00+00'` become `case when true`.
 * Expected: this suite passes 4 of 4 before and after. Under the substitution ONLY the extreme case
 * fails, at the labeled assertion, after the actual due read was rejected with 22008; the ordinary,
 * boundary and above cases pass, because their sums are representable and in the future or the
 * past as before. A setup, timeout or unrelated failure is inconclusive and not a kill.
 *
 * The named-table snapshot is not the whole of KR-13.
 */
describe("KR-07 finite upper observation bounds", () => {
  const FINITE_LABEL = "KR-07 FINITE: extreme finite observation commits not_due without arithmetic overflow";
  /** The maximum revisit interval the contract accepts. */
  const REVISIT_MS = 86_400_000;
  /** The KR-17 name of the due read: the one statement the observer watches. */
  const DUE_STATEMENT = "preparation: due decision";

  /** An instant as the DATABASE renders it: UTC, six fractional digits, as text. The expression is parenthesized as a whole. */
  const utc = (expression: string): string => `to_char((${expression}) at time zone 'UTC', 'YYYY-MM-DD HH24:MI:SS.US') || '+00'`;
  /** The one root witness row of the fixture, as `w`, and no other ledger row. */
  const ROOT_WITNESS = `w.team_id = $1 and w.workspace_id = $2 and w.channel_id = $3 and w.message_ts = $4 and w.root_ts = $4 and w.is_root and w.item_id = $5::uuid`;
  const witnessOf = (f: Published): unknown[] => [f.seed.teamId, WORKSPACE, CHANNEL, OLD_ROOT, f.itemId];

  /** The SQLSTATE an error carries, or a fixed token when it carries none. */
  const sqlstateOf = (error: unknown): string => {
    const code = typeof error === "object" && error !== null ? (error as { code?: unknown }).code : undefined;
    return typeof code === "string" ? code : "NO SQLSTATE";
  };

  /**
   * The root witness as stored, all as the database renders it and none of it through a JavaScript
   * Date: its observation as text; live; finite; its exact scope; how many of the team's ledger rows
   * carry that same instant; and on which side of the guard's literal instant it lies.
   */
  const rootWitness = (f: Published): Promise<Row[]> => query(
    `select ${utc("w.observed_at")} as observed_at_utc, w.deleted_at is null as live, isfinite(w.observed_at) as finite,
            w.workspace_id, w.channel_id, w.message_ts, w.root_ts, w.is_root, w.item_id::text as item_id,
            (select count(*)::int from slack_messages m where m.team_id = w.team_id and m.observed_at = w.observed_at) as rows_with_this_observation,
            w.observed_at <= timestamptz '9999-12-31 00:00:00+00' as at_or_before_the_guard
       from slack_messages w where ${ROOT_WITNESS}`, witnessOf(f)
  );
  const witnessAt = (f: Published, observedAt: string, atOrBeforeTheGuard: boolean) => [{
    observed_at_utc: observedAt, live: true, finite: true,
    workspace_id: WORKSPACE, channel_id: CHANNEL, message_ts: OLD_ROOT, root_ts: OLD_ROOT, is_root: true, item_id: f.itemId,
    rows_with_this_observation: 1, at_or_before_the_guard: atOrBeforeTheGuard,
  }];

  /** Every row of the team in the named tables, exactly as the database renders it. Not the whole of KR-13. */
  const SNAPSHOT_TABLES = [
    "items", "slack_messages", "slack_sync_threads", "slack_thread_snapshots", "slack_sync_channels",
    "slack_integration_bindings", "slack_channel_migration_gates", "integrations", "projects", "slack_team_state",
  ];
  async function snapshot(teamId: string): Promise<Record<string, string>> {
    const scoped = (await query(
      `select table_name from information_schema.columns
        where table_schema = 'public' and column_name = 'team_id' and table_name = any($1::text[])
        order by table_name`, [SNAPSHOT_TABLES]
    )).map((row) => row.table_name as string);
    for (const required of SNAPSHOT_TABLES) expect(scoped, `fixture: ${required} is snapshotted`).toContain(required);
    const out: Record<string, string> = {};
    for (const table of scoped) {
      const [aggregate] = await query(
        `select coalesce(jsonb_agg(to_jsonb(t) order by to_jsonb(t)::text), '[]'::jsonb)::text as rows from "${table}" t where t.team_id = $1`, [teamId]
      );
      out[table] = aggregate.rows as string;
    }
    const [versions] = await query(
      `select coalesce(jsonb_agg(to_jsonb(v) order by to_jsonb(v)::text), '[]'::jsonb)::text as rows
         from item_versions v join items i on i.id = v.item_id where i.team_id = $1`, [teamId]
    );
    out.item_versions = versions.rows as string;
    return out;
  }

  /**
   * One case's fixture: the real publication, checked to have acknowledged; then FIXTURE DML that
   * sets the stored observation of the ONE root witness row and must change exactly one row, read
   * back whole; then the real enumeration under the maximum interval, on its own completed transaction.
   */
  async function publishedObservedAt(observedAt: string, atOrBeforeTheGuard: boolean, label: string): Promise<{ f: Published; entry: SlackKnownRootEntry }> {
    const f = await publishOldRoot();
    const teamId = f.seed.teamId;
    const afterPublication = await stored(teamId);
    expect([afterPublication.allQueue, afterPublication.snapshots], `${label}: fixture: the real publication removed the queue row and the staging`).toEqual([[], 0]);

    // FIXTURE DML: the observation is written as TEXT and cast by the database.
    const changed = await (await rawSql()).query(
      `update slack_messages w set observed_at = $6::timestamptz where ${ROOT_WITNESS}`, [...witnessOf(f), observedAt]
    );
    expect(changed.rowCount, `${label}: fixture: exactly one ledger row, the root witness, was changed`).toBe(1);
    expect(await rootWitness(f), `${label}: fixture: the root witness stores exactly the literal observation — accepted, finite, live, in its exact scope — and no other ledger row carries it`)
      .toEqual(witnessAt(f, observedAt, atOrBeforeTheGuard));

    const channel = await channelRow(teamId, WORKSPACE, CHANNEL);
    expect(channel?.binding_config_revision, `${label}: fixture: the channel row stores a configuration revision`).toMatch(/^[0-9a-f]{64}$/);
    const pageExecution = createSlackKnownRootExecution({ ambientDeadlineAt: null });
    const page = await tx((s) => readSlackKnownRootItemPage(s, { teamId, pageSize: 100, revisitAfterMs: REVISIT_MS }, pageExecution));
    expect(page, `${label}: fixture: enumeration returns exactly this root, located, under the maximum revisit interval`).toEqual({
      entries: [{
        teamId, itemId: f.itemId, revisitAfterMs: 86_400_000,
        locator: {
          workspaceId: WORKSPACE, channelId: CHANNEL, rootTs: OLD_ROOT, integrationId: f.integrationId,
          bindingConfigRevision: channel?.binding_config_revision, namespaceRevision: f.namespaceRevision,
        },
      }],
      nextCursor: null, exhausted: true, examined: 1,
    });
    return { f, entry: page.entries[0] };
  }

  /** Preparation on a transaction of its own, from the team and the enumerated entry ALONE. The result is the COMMITTED one. */
  function prepared(teamId: string, entry: SlackKnownRootEntry): Promise<SlackKnownRootPreparationResult> {
    // The ordinary bounded context, created BEFORE the transaction it is used in.
    const execution = createSlackKnownRootExecution({ ambientDeadlineAt: null });
    return tx((s) => prepareSlackKnownRootRequeue(s, { teamId, entry }, execution));
  }

  /** Committed state after a `not_due`: nothing queued or staged anywhere, no named table changed, and the witness as it was. */
  async function nothingMoved(f: Published, observedAt: string, atOrBeforeTheGuard: boolean, before: Record<string, string>, label: string): Promise<void> {
    const teamId = f.seed.teamId;
    expect(await query(`select 1 as pending from slack_sync_threads`), `${label}: no queue row, of this team or any other`).toEqual([]);
    expect(await query(`select 1 as staged from slack_thread_snapshots`), `${label}: no staging, of this team or any other`).toEqual([]);
    expect(await snapshot(teamId), `${label}: every named table, the queue included, is unchanged by the preparation`).toEqual(before);
    expect(await rootWitness(f), `${label}: the root witness is unchanged by the preparation`).toEqual(witnessAt(f, observedAt, atOrBeforeTheGuard));
  }

  /** A guarded observation whose sum with the interval IS representable: asserted computable and in the future, then `not_due`. */
  async function notDueAt(observedAt: string, atOrBeforeTheGuard: boolean, label: string): Promise<void> {
    const { f, entry } = await publishedObservedAt(observedAt, atOrBeforeTheGuard, label);
    const teamId = f.seed.teamId;
    // FIXTURE EVIDENCE, not the product's decision: for THIS observation the sum can be computed, and it is in the future.
    expect(await query(
      `select (w.observed_at + ($6::bigint * interval '1 millisecond')) > clock_timestamp() as sum_is_computable_and_in_the_future
         from slack_messages w where ${ROOT_WITNESS}`, [...witnessOf(f), REVISIT_MS]
    ), `${label}: fixture: observation + 86,400,000 ms is representable, and in the future`).toEqual([{ sum_is_computable_and_in_the_future: true }]);

    const before = await snapshot(teamId);
    const result = await prepared(teamId, entry);

    expect(result, `${label}: the committed outcome`).toEqual({ outcome: "not_due" });
    await nothingMoved(f, observedAt, atOrBeforeTheGuard, before, label);
  }

  it("enqueues an ordinary overdue root under the maximum interval, at its literal due instant (control)", async () => {
    const label = "ordinary overdue (control)";
    const observedAt = "2024-07-01 12:34:56.123001+00";
    const dueAt = "2024-07-02 12:34:56.124000+00";
    const { f, entry } = await publishedObservedAt(observedAt, true, label);
    const teamId = f.seed.teamId;
    expect(await query(`select $1::timestamptz < clock_timestamp() as already_past`, [dueAt]), `${label}: fixture: the literal due instant is already past`).toEqual([{ already_past: true }]);

    const before = await snapshot(teamId);
    const result = await prepared(teamId, entry);

    expect(result, `${label}: the committed outcome`).toEqual({ outcome: "enqueued" });
    // The stored due instant, as text from the database, against the literal.
    expect(await query(
      `select workspace_id, channel_id, root_ts, status, attempts, ${utc("due_at")} as due_at_utc
         from slack_sync_threads where team_id = $1 order by root_ts`, [teamId]
    ), `${label}: exactly one queue row, in the root's exact scope, queued and never attempted, at the literal due instant`).toEqual([
      { workspace_id: WORKSPACE, channel_id: CHANNEL, root_ts: OLD_ROOT, status: "queued", attempts: 0, due_at_utc: dueAt },
    ]);
    expect((await stored(teamId)).snapshots, `${label}: no staging`).toBe(0);
    expect(await query(`select team_id::text as team_id, root_ts from slack_sync_threads`), `${label}: the only queue row in the database is this root's`).toEqual([
      { team_id: teamId, root_ts: OLD_ROOT },
    ]);
    const after = await snapshot(teamId);
    expect(after.slack_sync_threads, `${label}: the snapshot sees the queue row`).not.toBe(before.slack_sync_threads);
    for (const table of Object.keys(before)) {
      if (table !== "slack_sync_threads") expect(after[table], `${label}: ${table} is unchanged by the preparation`).toBe(before[table]);
    }
    expect(await rootWitness(f), `${label}: the root witness is unchanged by the preparation`).toEqual(witnessAt(f, observedAt, true));
  });

  it("is not due for an observation exactly at the arithmetic guard, 9999-12-31 00:00:00 UTC (boundary)", () =>
    notDueAt("9999-12-31 00:00:00.000000+00", true, "exactly at the guard (boundary)"));

  it("is not due for an observation one microsecond above the arithmetic guard (immediately above)", () =>
    notDueAt("9999-12-31 00:00:00.000001+00", false, "one microsecond above the guard"));

  it("commits not_due, with no arithmetic failure, for a finite observation whose due instant PostgreSQL cannot represent (extreme)", async () => {
    const label = "extreme finite observation";
    const observedAt = "294276-12-31 00:00:00.000000+00";
    // The readback inside proves the database ACCEPTED the value and that it is finite, live and in scope.
    const { f, entry } = await publishedObservedAt(observedAt, false, label);
    const teamId = f.seed.teamId;

    // THE FIXTURE PROBE, on another connection and before any preparation. It is MEANT to fail: the
    // sum is outside PostgreSQL's timestamp range. Its error is caught here, for this precondition
    // only, and it is not the product's statement.
    const probed = await (await rawSql()).query(
      `select (w.observed_at + ($6::bigint * interval '1 millisecond')) is not null as computed
         from slack_messages w where ${ROOT_WITNESS}`, [...witnessOf(f), REVISIT_MS]
    ).then((answered) => `NO ERROR (${answered.rowCount} row)`, (error: unknown) => sqlstateOf(error));
    expect(probed, `${label}: fixture: observation + 86,400,000 ms is outside PostgreSQL's timestamp range (SQLSTATE 22008)`).toBe("22008");
    expect(await rootWitness(f), `${label}: fixture: the probe changed nothing`).toEqual(witnessAt(f, observedAt, false));

    const before = await snapshot(teamId);

    // THE DUE OBSERVER: every statement forwarded unchanged; the actual due read counted, and its
    // rejection's SQLSTATE recorded and rethrown.
    const due = { issued: 0, rejectedWith: null as string | null };
    const observingDue = (session: TransactionSession): TransactionSession => {
      const executeSql: SqlExecutor = async <T = Record<string, unknown>>(text: string, params?: unknown[]) => {
        if (kr17Named(text).name !== DUE_STATEMENT) return session.executeSql<T>(text, params);
        due.issued += 1;
        try {
          return await session.executeSql<T>(text, params);
        } catch (error) {
          due.rejectedWith = sqlstateOf(error);
          throw error;
        }
      };
      return {
        get db() {
          return session.db;
        },
        executeSql,
        optionalAudit<T>(operation: () => Promise<T>, fallback: T): Promise<T> {
          return session.optionalAudit(operation, fallback);
        },
      };
    };

    // The ordinary bounded context, created BEFORE the transaction it is used in.
    const execution = createSlackKnownRootExecution({ ambientDeadlineAt: null });
    // The preparation's END, whichever it is, as one closed observation formed OUTSIDE the transaction.
    const ended = await tx((s) => prepareSlackKnownRootRequeue(observingDue(s), { teamId, entry }, execution)).then(
      (committed) => ({ committed, failure: null }),
      (error: unknown) => ({ committed: null, failure: classifySlackKnownRootPreparationFailure(error) })
    );

    expect({ ...ended, dueReadsIssued: due.issued, dueReadRejectedWithSqlstate: due.rejectedWith }, FINITE_LABEL).toEqual({
      committed: { outcome: "not_due" }, failure: null, dueReadsIssued: 1, dueReadRejectedWithSqlstate: null,
    });
    await nothingMoved(f, observedAt, false, before, label);
  });
});

/**
 * KR-06 — a pending row that ALREADY EXISTS when preparation reads the queue is left exactly as it is
 * (`docs/design/slack-known-root-requeue-spec.md` §5.2, §10, §11 KR-06, and KR-13 as scoped below).
 *
 * EVIDENCE, NOT RED: every case here is expected to pass on the current source.
 *
 * SIX STATES, each established on its own freshly published root through the existing thread-state
 * helpers — enqueue, claim, release, checkpoint, snapshot write — and each made recognizable, so that
 * no freshly inserted row could be mistaken for it:
 *
 *   queued              never claimed, at a written-out due instant
 *   backed off          claimed once and released with an error code, due at a written-out future instant
 *   running             claimed twice, live lease, with a checkpointed cursor and snapshot generation
 *   expired lease       claimed, and its lease then expired
 *   partial snapshot    claimed, an incomplete staged snapshot, a checkpointed cursor
 *   complete snapshot   claimed, a complete staged snapshot, checkpointed with no cursor
 *
 * The ONLY fixture DML on the queue is in the expired-lease case and is labeled there: no helper
 * moves a lease's expiry into the past. The stored observation is aged as everywhere in this file,
 * so that the root is otherwise due and nothing but the existing row stands between preparation and
 * an insertion.
 *
 * WHAT IS REQUIRED. Preparation, from the team and the real enumerated entry, commits
 * `already_pending`. Its data statements end at the plain queue read, which returned the one row:
 * the item is never locked. Every column of the queue row and of the staged snapshot, as the
 * database renders the whole row, is identical before and after — attempts, due and lease instants,
 * owner, generations and cursor included. And no row of the team differs in any snapshotted table.
 *
 * TWO SNAPSHOTS, KEPT APART. What the FIXTURE changed is asserted on its own: between the aged
 * publication and the established state, only the queue table differs, and the staging table in the
 * two snapshot cases. What the PREPARATION changed is asserted separately: nothing.
 *
 * SCOPED KR-13. The snapshot here covers the surfaces a preparation is forbidden to touch — item and
 * versions, ledger, identity, access, generations, channel and source authority, budgets and runs,
 * queue and staging — for these six early returns. It is not the whole of KR-13: it does not cover
 * the outcomes that are not `already_pending`, the audit log, or tables that are not listed.
 *
 * THIS DOES NOT REPLACE THE M4 EVIDENCE. Here the row exists BEFORE the queue read, and the result
 * comes from the early return. The conflict-do-nothing branch — a row committed AFTER the queue read
 * — is the suite "KR-06 — a queue row committed between the plain queue read and the enqueue is left
 * exactly as committed" above, with its controlled M4 run. Neither stands in for the other, and no
 * mutant is claimed to be killed by this suite.
 */
describe("KR-06 existing queue state preservation", () => {
  const QUEUE_READ = "preparation: plain queue read";
  const FIRST_DUE = new Date("2024-03-05T06:07:08.901Z");
  const FIRST_DUE_UTC = "2024-03-05 06:07:08.901000+00";
  const RETRY_DUE = new Date("2024-04-05T06:07:08.902Z");
  const RETRY_DUE_UTC = "2024-04-05 06:07:08.902000+00";
  const BACKED_OFF_DUE = new Date("2099-02-03T04:05:06.789Z");
  const BACKED_OFF_DUE_UTC = "2099-02-03 04:05:06.789000+00";
  const RUNNING_CURSOR = "kr06-running-page-3";
  const PARTIAL_CURSOR = "kr06-partial-page-2";

  type Scope = { teamId: string; workspaceId: string; channelId: string; rootTs: string };
  const QUEUE_SCOPE = `team_id = $1 and workspace_id = $2 and channel_id = $3 and root_ts = $4`;
  const scopeParams = (teamId: string): unknown[] => [teamId, WORKSPACE, CHANNEL, OLD_ROOT];

  /**
   * The surfaces a preparation must not touch, by what they are. Every one of these tables has a
   * `team_id`, and every row of the team is rendered whole by the database. Not the whole of KR-13.
   */
  const SNAPSHOT_TABLES = [
    // queue and staging
    "slack_sync_threads", "slack_thread_snapshots",
    // item (its versions are added below, through the item), and the ledger
    "items", "slack_messages",
    // identity
    "members", "member_identities", "member_identity_suppressions",
    // access
    "projects", "groups", "group_members", "project_groups", "project_context_units", "project_context_memberships",
    // generations
    "slack_team_state",
    // channel and source authority
    "slack_sync_channels", "slack_integration_bindings", "slack_channel_migration_gates", "slack_namespace_readiness_proofs",
    "integrations", "slack_workspace_observations",
    // budgets and runs
    "slack_method_budgets", "ingest_runs", "connector_cursors",
  ];
  async function snapshot(teamId: string): Promise<Record<string, string>> {
    const scoped = (await query(
      `select table_name from information_schema.columns
        where table_schema = 'public' and column_name = 'team_id' and table_name = any($1::text[])
        order by table_name`, [SNAPSHOT_TABLES]
    )).map((row) => row.table_name as string).sort();
    expect(scoped, "fixture: every named surface is snapshotted").toEqual([...SNAPSHOT_TABLES].sort());
    const out: Record<string, string> = {};
    for (const table of scoped) {
      const [aggregate] = await query(
        `select coalesce(jsonb_agg(to_jsonb(t) order by to_jsonb(t)::text), '[]'::jsonb)::text as rows from "${table}" t where t.team_id = $1`, [teamId]
      );
      out[table] = aggregate.rows as string;
    }
    const [versions] = await query(
      `select coalesce(jsonb_agg(to_jsonb(v) order by to_jsonb(v)::text), '[]'::jsonb)::text as rows
         from item_versions v join items i on i.id = v.item_id where i.team_id = $1`, [teamId]
    );
    out.item_versions = versions.rows as string;
    return out;
  }
  const tablesThatDiffer = (from: Record<string, string>, to: Record<string, string>): string[] =>
    Object.keys(from).filter((table) => from[table] !== to[table]).sort();

  /** EVERY column of every row of the team in one table, as the database renders the whole row. */
  const rowsExactly = async (table: "slack_sync_threads" | "slack_thread_snapshots", teamId: string): Promise<string[]> =>
    (await query(`select to_jsonb(t)::text as stored from "${table}" t where t.team_id = $1 order by t.root_ts`, [teamId])).map((row) => row.stored as string);

  /** The queue row's recognizable facts, for the fixture's readback against literals. */
  const queueFacts = (teamId: string): Promise<Row[]> => query(
    `select status, attempts, lease_generation::text as lease_generation, snapshot_generation::text as snapshot_generation,
            page_cursor, last_error_code, checkpointed_at is not null as checkpointed,
            to_char(due_at at time zone 'UTC', 'YYYY-MM-DD HH24:MI:SS.US') || '+00' as due_at_utc,
            due_at > clock_timestamp() as due_in_the_future,
            case when lease_owner is null and lease_expires_at is null then 'none'
                 when lease_owner is not null and lease_expires_at > clock_timestamp() then 'live'
                 when lease_owner is not null and lease_expires_at <= clock_timestamp() then 'expired'
                 else 'INCONSISTENT' end as lease
       from slack_sync_threads where ${QUEUE_SCOPE}`, scopeParams(teamId)
  );
  /** The staged snapshot's recognizable facts. */
  const stagingFacts = (teamId: string): Promise<Row[]> => query(
    `select snapshot_generation::text as snapshot_generation, complete, jsonb_array_length(messages) as messages,
            stored_bytes > 0 as has_bytes, expires_at > clock_timestamp() as live
       from slack_thread_snapshots where ${QUEUE_SCOPE}`, scopeParams(teamId)
  );

  /** A claim that must succeed. */
  async function claimed(session: TransactionSession, scope: Scope): Promise<SlackThreadClaim> {
    const claim = await claimSlackThread(session, scope, { leaseMs: 900_000 });
    if (!claim) throw new Error("fixture: the claim was refused");
    return claim;
  }
  /** A staged snapshot and its checkpoint, in the claim's own transaction, as a hydrator leaves them. */
  async function staged(session: TransactionSession, claim: SlackThreadClaim, messages: readonly SlackMessage[], complete: boolean, pageCursor: string | null): Promise<void> {
    const written = await writeSlackThreadSnapshot(session, claim, {
      messages: [...messages], complete, expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    });
    if (written !== "written") throw new Error("fixture: the snapshot was refused");
    const checkpointed = await checkpointSlackThread(session, claim, { pageCursor, snapshotGeneration: 1 });
    if (checkpointed.outcome !== "checkpointed") throw new Error("fixture: the checkpoint was refused");
  }

  interface State {
    label: string;
    /** Establishes the state, committed, through the existing helpers. */
    establish: (scope: Scope) => Promise<void>;
    /** The queue row's facts, WRITTEN OUT. */
    queue: Row;
    /** The staged snapshot's facts, WRITTEN OUT; empty when the state has none. */
    staging: Row[];
  }

  /** One state: established, read back, and then shown untouched by a committed preparation that returns already_pending. */
  async function preserved(state: State): Promise<void> {
    const { label } = state;
    const f = await publishOldRoot();
    const teamId = f.seed.teamId;
    const scope: Scope = { teamId, workspaceId: WORKSPACE, channelId: CHANNEL, rootTs: OLD_ROOT };
    const afterPublication = await stored(teamId);
    expect([afterPublication.allQueue, afterPublication.snapshots], `${label}: fixture: the real publication removed the queue row and the staging`).toEqual([[], 0]);

    // FIXTURE CLOCK: the root is otherwise due, so only the existing row keeps preparation from inserting.
    await ageObservation(teamId);
    expect(await query(
      `select w.observed_at + interval '60 seconds' <= clock_timestamp() as otherwise_due
         from slack_messages w where w.team_id = $1 and w.message_ts = $2 and w.root_ts = $2 and w.is_root and w.deleted_at is null`, [teamId, OLD_ROOT]
    ), `${label}: fixture: the root's own due instant is past`).toEqual([{ otherwise_due: true }]);
    const aged = await snapshot(teamId);

    // ── THE FIXTURE'S CHANGE: the state, established and committed, and read back against literals. ──
    await state.establish(scope);
    expect(await queueFacts(teamId), `${label}: fixture: the established queue row`).toEqual([state.queue]);
    expect(await stagingFacts(teamId), `${label}: fixture: the established staging`).toEqual(state.staging);
    const established = await snapshot(teamId);
    expect(tablesThatDiffer(aged, established), `${label}: fixture: establishing the state changed the queue${state.staging.length > 0 ? " and the staging" : ""}, and nothing else`)
      .toEqual(state.staging.length > 0 ? ["slack_sync_threads", "slack_thread_snapshots"] : ["slack_sync_threads"]);
    // Retained whole: every column of the queue row and of the staged snapshot.
    const queueBefore = await rowsExactly("slack_sync_threads", teamId);
    const stagingBefore = await rowsExactly("slack_thread_snapshots", teamId);
    expect([queueBefore.length, stagingBefore.length], `${label}: fixture: one queue row, and the staging the state has`).toEqual([1, state.staging.length]);

    // The real enumeration: this root, located. The existing queue row does not change what is enumerated.
    const channel = await channelRow(teamId, WORKSPACE, CHANNEL);
    expect(channel?.binding_config_revision, `${label}: fixture: the channel row stores a configuration revision`).toMatch(/^[0-9a-f]{64}$/);
    const page = await enumerate(teamId);
    expect(page, `${label}: fixture: enumeration returns exactly this root, located`).toEqual({
      entries: [{
        teamId, itemId: f.itemId, revisitAfterMs: REVISIT_AFTER_MS,
        locator: {
          workspaceId: WORKSPACE, channelId: CHANNEL, rootTs: OLD_ROOT, integrationId: f.integrationId,
          bindingConfigRevision: channel?.binding_config_revision, namespaceRevision: f.namespaceRevision,
        },
      }],
      nextCursor: null, exhausted: true, examined: 1,
    });
    const entry = page.entries[0];
    expect(await snapshot(teamId), `${label}: fixture: enumeration changed nothing`).toEqual(established);

    // ── THE PREPARATION, on its own transaction, from the team and the enumerated entry alone. Its
    //    statements are forwarded unchanged and written down by name with their row counts. ──
    const issued: { name: string; rows: number }[] = [];
    const recording = (session: TransactionSession): TransactionSession => {
      const executeSql: SqlExecutor = async <T = Record<string, unknown>>(text: string, params?: unknown[]) => {
        const result = await session.executeSql<T>(text, params);
        const named = kr17Named(text);
        if (named.kind === "data") issued.push({ name: named.name, rows: result.rows.length });
        return result;
      };
      return {
        get db() {
          return session.db;
        },
        executeSql,
        optionalAudit<T>(operation: () => Promise<T>, fallback: T): Promise<T> {
          return session.optionalAudit(operation, fallback);
        },
      };
    };
    // The execution context is created BEFORE the transaction it is used in.
    const execution = createSlackKnownRootExecution({ ambientDeadlineAt: null });
    const result = await tx((s) => prepareSlackKnownRootRequeue(recording(s), { teamId, entry }, execution));

    expect(result, `${label}: the committed outcome`).toEqual({ outcome: "already_pending" });
    // The EARLY return: the statements end at the plain queue read, which found the one row. The item
    // was never locked and the enqueue was never reached.
    expect(issued, `${label}: the preparation ends at the plain queue read, which returned the existing row`).toEqual([
      ...KR17_PREPARATION.slice(0, KR17_PREPARATION.indexOf(QUEUE_READ)).map((name) => ({ name, rows: 1 })),
      { name: QUEUE_READ, rows: 1 },
    ]);

    // ── THE PREPARATION'S CHANGE: none. ──
    expect(await rowsExactly("slack_sync_threads", teamId), `${label}: every column of the queue row is byte-identical`).toEqual(queueBefore);
    expect(await rowsExactly("slack_thread_snapshots", teamId), `${label}: every column of the staged snapshot is byte-identical`).toEqual(stagingBefore);
    expect(await snapshot(teamId), `${label}: no row of any snapshotted surface was changed by the preparation`).toEqual(established);
    expect(await query(`select team_id::text as team_id, root_ts from slack_sync_threads`), `${label}: the only queue row in the database is the established one`).toEqual([
      { team_id: teamId, root_ts: OLD_ROOT },
    ]);
  }

  it("returns already_pending and leaves a queued row that was never claimed byte-identical (queued)", () => preserved({
    label: "queued",
    establish: async (scope) => {
      const enqueued = await tx((c) => enqueueSlackThread(c, scope, { dueAt: FIRST_DUE }));
      if (!enqueued.inserted) throw new Error("fixture: the enqueue did not insert");
    },
    queue: {
      status: "queued", attempts: 0, lease_generation: "0", snapshot_generation: "0", page_cursor: null, last_error_code: null,
      checkpointed: false, due_at_utc: FIRST_DUE_UTC, due_in_the_future: false, lease: "none",
    },
    staging: [],
  }));

  it("returns already_pending and leaves a row released for a later retry byte-identical (backed off)", () => preserved({
    label: "backed off",
    establish: (scope) => tx(async (c) => {
      await enqueueSlackThread(c, scope, { dueAt: FIRST_DUE });
      const released = await releaseSlackThreadForRetry(c, await claimed(c, scope), { nextDueAt: BACKED_OFF_DUE, errorCode: "rate_limited" });
      if (released.outcome !== "released") throw new Error("fixture: the release was refused");
    }),
    queue: {
      status: "queued", attempts: 1, lease_generation: "1", snapshot_generation: "0", page_cursor: null, last_error_code: "rate_limited",
      checkpointed: false, due_at_utc: BACKED_OFF_DUE_UTC, due_in_the_future: true, lease: "none",
    },
    staging: [],
  }));

  it("returns already_pending and leaves a twice-claimed row with a live lease and a checkpointed cursor byte-identical (running)", () => preserved({
    label: "running",
    establish: (scope) => tx(async (c) => {
      await enqueueSlackThread(c, scope, { dueAt: FIRST_DUE });
      const released = await releaseSlackThreadForRetry(c, await claimed(c, scope), { nextDueAt: RETRY_DUE, errorCode: "slack_timeout" });
      if (released.outcome !== "released") throw new Error("fixture: the release was refused");
      const checkpointed = await checkpointSlackThread(c, await claimed(c, scope), { pageCursor: RUNNING_CURSOR, snapshotGeneration: 2 });
      if (checkpointed.outcome !== "checkpointed") throw new Error("fixture: the checkpoint was refused");
    }),
    queue: {
      status: "running", attempts: 2, lease_generation: "2", snapshot_generation: "2", page_cursor: RUNNING_CURSOR, last_error_code: "slack_timeout",
      checkpointed: true, due_at_utc: RETRY_DUE_UTC, due_in_the_future: false, lease: "live",
    },
    staging: [],
  }));

  it("returns already_pending and leaves a claimed row whose lease has expired byte-identical (expired lease)", () => preserved({
    label: "expired lease",
    establish: async (scope) => {
      await tx(async (c) => {
        await enqueueSlackThread(c, scope, { dueAt: FIRST_DUE });
        await claimed(c, scope);
      });
      // FIXTURE DML, the only one on the queue in this suite: no helper moves a lease's expiry into
      // the past. It changes that one column of the one claimed row, and must change exactly one row.
      const expired = await (await rawSql()).query(
        `update slack_sync_threads set lease_expires_at = clock_timestamp() - interval '1 hour' where ${QUEUE_SCOPE} and status = 'running'`,
        [scope.teamId, scope.workspaceId, scope.channelId, scope.rootTs]
      );
      if (expired.rowCount !== 1) throw new Error(`fixture: expected to expire exactly one lease, changed ${expired.rowCount}`);
    },
    queue: {
      status: "running", attempts: 1, lease_generation: "1", snapshot_generation: "0", page_cursor: null, last_error_code: null,
      checkpointed: false, due_at_utc: FIRST_DUE_UTC, due_in_the_future: false, lease: "expired",
    },
    staging: [],
  }));

  it("returns already_pending and leaves a claimed row with an incomplete staged snapshot, and that snapshot, byte-identical (partial snapshot)", () => preserved({
    label: "partial snapshot",
    establish: (scope) => tx(async (c) => {
      await enqueueSlackThread(c, scope, { dueAt: FIRST_DUE });
      await staged(c, await claimed(c, scope), [ROOT_MESSAGE], false, PARTIAL_CURSOR);
    }),
    queue: {
      status: "running", attempts: 1, lease_generation: "1", snapshot_generation: "1", page_cursor: PARTIAL_CURSOR, last_error_code: null,
      checkpointed: true, due_at_utc: FIRST_DUE_UTC, due_in_the_future: false, lease: "live",
    },
    staging: [{ snapshot_generation: "1", complete: false, messages: 1, has_bytes: true, live: true }],
  }));

  it("returns already_pending and leaves a claimed row with a complete staged snapshot, and that snapshot, byte-identical (complete snapshot)", () => preserved({
    label: "complete snapshot",
    establish: (scope) => tx(async (c) => {
      await enqueueSlackThread(c, scope, { dueAt: FIRST_DUE });
      await staged(c, await claimed(c, scope), [ROOT_MESSAGE, REPLY_MESSAGE], true, null);
    }),
    queue: {
      status: "running", attempts: 1, lease_generation: "1", snapshot_generation: "1", page_cursor: null, last_error_code: null,
      checkpointed: true, due_at_utc: FIRST_DUE_UTC, due_in_the_future: false, lease: "live",
    },
    staging: [{ snapshot_generation: "1", complete: true, messages: 2, has_bytes: true, live: true }],
  }));
});

// ── Lifecycle packet: what the two suites below share ────────────────────────────────────────────
// New, file-local helpers for "KR-07 unchanged republication refresh" and "KR-08 rollback and
// replay". No earlier helper or case is moved. One earlier fixture value was changed in the same
// packet: the backed-off due instant of "KR-06 existing queue state preservation" was moved to a
// stable far-future literal. No KR-17 hook is involved in either selection.

/** An instant as the DATABASE renders it: UTC, six fractional digits, as text. The expression is parenthesized as a whole. */
const lifecycleUtc = (expression: string): string => `to_char((${expression}) at time zone 'UTC', 'YYYY-MM-DD HH24:MI:SS.US') || '+00'`;
/** The one root witness row of the fixture, as `w`, and no other ledger row. */
const LIFECYCLE_ROOT_WITNESS = `w.team_id = $1 and w.workspace_id = $2 and w.channel_id = $3 and w.message_ts = $4 and w.root_ts = $4 and w.is_root and w.item_id = $5::uuid`;
const lifecycleWitnessOf = (f: Published): unknown[] => [f.seed.teamId, WORKSPACE, CHANNEL, OLD_ROOT, f.itemId];

/**
 * The surfaces a preparation must not touch, by what they are: queue and staging; item (and, through
 * it, its versions) and ledger; identity; access; generations; channel and source authority; budgets
 * and runs. Every row of the team, rendered whole by the database. SCOPED KR-13: it covers the
 * preparations of the two suites below, and is not the whole of KR-13 — the audit log and tables
 * that are not listed are outside it.
 */
const LIFECYCLE_SNAPSHOT_TABLES = [
  "slack_sync_threads", "slack_thread_snapshots",
  "items", "slack_messages",
  "members", "member_identities", "member_identity_suppressions",
  "projects", "groups", "group_members", "project_groups", "project_context_units", "project_context_memberships",
  "slack_team_state",
  "slack_sync_channels", "slack_integration_bindings", "slack_channel_migration_gates", "slack_namespace_readiness_proofs",
  "integrations", "slack_workspace_observations",
  "slack_method_budgets", "ingest_runs", "connector_cursors",
];
async function lifecycleSnapshot(teamId: string): Promise<Record<string, string>> {
  const scoped = (await query(
    `select table_name from information_schema.columns
      where table_schema = 'public' and column_name = 'team_id' and table_name = any($1::text[])`, [LIFECYCLE_SNAPSHOT_TABLES]
  )).map((row) => row.table_name as string).sort();
  expect(scoped, "fixture: every named surface is snapshotted").toEqual([...LIFECYCLE_SNAPSHOT_TABLES].sort());
  const out: Record<string, string> = {};
  for (const table of scoped) {
    const [aggregate] = await query(
      `select coalesce(jsonb_agg(to_jsonb(t) order by to_jsonb(t)::text), '[]'::jsonb)::text as rows from "${table}" t where t.team_id = $1`, [teamId]
    );
    out[table] = aggregate.rows as string;
  }
  const [versions] = await query(
    `select coalesce(jsonb_agg(to_jsonb(v) order by to_jsonb(v)::text), '[]'::jsonb)::text as rows
       from item_versions v join items i on i.id = v.item_id where i.team_id = $1`, [teamId]
  );
  out.item_versions = versions.rows as string;
  return out;
}
const lifecycleTablesThatDiffer = (from: Record<string, string>, to: Record<string, string>): string[] =>
  Object.keys(from).filter((table) => from[table] !== to[table]).sort();

/** The backend pid of the connection a session is bound to. */
const lifecyclePidOf = async (session: TransactionSession): Promise<number> =>
  Number((await session.executeSql<{ pid: number }>(`select pg_backend_pid() as pid`)).rows[0].pid);

/** A published root whose root witness, and nothing else, was aged; its enumerated entry; and its exact due instant. */
interface LifecycleAgedRoot {
  f: Published;
  teamId: string;
  entry: SlackKnownRootEntry;
  /** The root witness's aged observation, as the database renders it. */
  agedObservedAt: string;
  /** The aged observation plus the revisit interval, to the microsecond, before any rounding. */
  exactDue: string;
}
/**
 * The real publication; FIXTURE AGING of the exact root witness row only, by two hours; and the
 * real enumeration under the given revisit policy on its own completed transaction. The interval is
 * given twice, WRITTEN OUT both ways: as the policy's milliseconds and as the SQL interval the
 * fixture adds to the stored observation.
 */
async function lifecycleAgedRoot(label: string, revisit: { ms: number; sqlInterval: string }): Promise<LifecycleAgedRoot> {
  const f = await publishOldRoot();
  const teamId = f.seed.teamId;
  const afterPublication = await stored(teamId);
  expect([afterPublication.allQueue, afterPublication.snapshots], `${label}: fixture: the real publication removed the queue row and the staging`).toEqual([[], 0]);

  // FIXTURE AGING: one statement, on the one root witness row, which must change exactly one row.
  const aged = await (await rawSql()).query<{ observed_at_utc: string; exact_due_utc: string }>(
    `update slack_messages w set observed_at = w.observed_at - interval '2 hours'
      where ${LIFECYCLE_ROOT_WITNESS}
  returning ${lifecycleUtc("w.observed_at")} as observed_at_utc, ${lifecycleUtc(`w.observed_at + interval '${revisit.sqlInterval}'`)} as exact_due_utc`, lifecycleWitnessOf(f)
  );
  expect(aged.rowCount, `${label}: fixture aging: exactly one ledger row, the root witness, was changed`).toBe(1);
  const agedObservedAt = aged.rows[0].observed_at_utc;
  const exactDue = aged.rows[0].exact_due_utc;
  expect(await query(
    `select ${lifecycleUtc("w.observed_at")} as observed_at_utc, w.deleted_at is null as live,
            (select count(*)::int from slack_messages m where m.team_id = w.team_id and m.observed_at = w.observed_at) as rows_with_this_observation,
            $6::timestamptz < clock_timestamp() as exact_due_is_past
       from slack_messages w where ${LIFECYCLE_ROOT_WITNESS}`, [...lifecycleWitnessOf(f), exactDue]
  ), `${label}: fixture aging: only the root witness carries the aged observation, live, and its exact due instant is past`).toEqual([
    { observed_at_utc: agedObservedAt, live: true, rows_with_this_observation: 1, exact_due_is_past: true },
  ]);

  const channel = await channelRow(teamId, WORKSPACE, CHANNEL);
  expect(channel?.binding_config_revision, `${label}: fixture: the channel row stores a configuration revision`).toMatch(/^[0-9a-f]{64}$/);
  // The execution context is created BEFORE the transaction it is used in.
  const pageExecution = createSlackKnownRootExecution({ ambientDeadlineAt: null });
  const page = await tx((s) => readSlackKnownRootItemPage(s, { teamId, pageSize: 100, revisitAfterMs: revisit.ms }, pageExecution));
  expect(page, `${label}: fixture: enumeration returns exactly this root, located, under this suite's revisit policy`).toEqual({
    entries: [{
      teamId, itemId: f.itemId, revisitAfterMs: revisit.ms,
      locator: {
        workspaceId: WORKSPACE, channelId: CHANNEL, rootTs: OLD_ROOT, integrationId: f.integrationId,
        bindingConfigRevision: channel?.binding_config_revision, namespaceRevision: f.namespaceRevision,
      },
    }],
    nextCursor: null, exhausted: true, examined: 1,
  });
  return { f, teamId, entry: page.entries[0], agedObservedAt, exactDue };
}

/** Every queue row of the team against an exact due instant: scope, state, and the due rounded UP to its millisecond. */
const lifecycleQueueAgainst = (teamId: string, exactDue: string): Promise<Row[]> => query(
  `select t.workspace_id, t.channel_id, t.root_ts, t.status, t.attempts,
          t.due_at >= $2::timestamptz as not_before_the_exact_due,
          t.due_at < $2::timestamptz + interval '1 millisecond' as less_than_a_millisecond_after_it,
          to_char(t.due_at at time zone 'UTC', 'US') like '%000' as on_a_whole_millisecond
     from slack_sync_threads t where t.team_id = $1 order by t.root_ts`, [teamId, exactDue]
);
/** ONE queued, never-attempted row in the root's exact scope, due at the exact due instant rounded up to its millisecond. */
const LIFECYCLE_ONE_ROW_AT_THE_EXACT_DUE = [{
  workspace_id: WORKSPACE, channel_id: CHANNEL, root_ts: OLD_ROOT, status: "queued", attempts: 0,
  not_before_the_exact_due: true, less_than_a_millisecond_after_it: true, on_a_whole_millisecond: true,
}];
/** EVERY column of every queue row of the team, as the database renders the whole row. */
const lifecycleQueueRowsExactly = async (teamId: string): Promise<string[]> =>
  (await query(`select to_jsonb(t)::text as stored from slack_sync_threads t where t.team_id = $1 order by t.root_ts`, [teamId])).map((row) => row.stored as string);
/** Every queue row and every staged snapshot in the DATABASE, of any team. */
const lifecycleQueueAndStagingAnywhere = async (): Promise<{ queue: Row[]; staging: Row[] }> => ({
  queue: await query(`select team_id::text as team_id, root_ts from slack_sync_threads order by team_id, root_ts`),
  staging: await query(`select team_id::text as team_id, root_ts from slack_thread_snapshots order by team_id, root_ts`),
});

/**
 * KR-07 — an UNCHANGED republication refreshes the root's observation without semantic churn, and so
 * postpones preparation (`docs/design/slack-known-root-requeue-spec.md` §5.3, §5.5, §11 KR-07).
 *
 * EVIDENCE, NOT RED: both cases are expected to pass on the current source. It is PART of KR-07 and
 * closes no row of the mutation matrix.
 *
 * THE MAIN CASE. A root is published by the real publication and its root witness alone is aged, so
 * that under a roomy one-hour revisit policy its exact due instant is an hour in the past. It is
 * enumerated, and that entry is kept. The identical complete thread is then staged again through the
 * existing enqueue, claim, snapshot and checkpoint helpers and published again through the real
 * `ingestItem`, with the same payload, the same directory and the same binding. Required of that
 * republication, all read from the database:
 *
 *   - its status is `unchanged`, for the same item id, with the same number of versions;
 *   - the team's data, identity and presentation generations are unchanged;
 *   - every semantic field of every ledger row, and its `last_seen_generation`, is unchanged;
 *   - the root's `observed_at` is strictly later than the aged value and lies between two database
 *     clock readings taken on either side of the republication;
 *   - its queue row and its staging are gone.
 *
 * The preparation is then run from the PREVIOUSLY enumerated entry. It commits `not_due`: the
 * refreshed observation plus one hour is an hour ahead. It inserts no queue row and changes no
 * snapshotted surface.
 *
 * THE CONTROL. The same aged root, NOT republished, is enqueued at its previously established exact
 * due instant. So the main case's `not_due` is the refresh's doing.
 *
 * TWO KINDS OF CHANGE, KEPT APART. What the fixture and the republication change is asserted by the
 * specific readbacks above. The scoped snapshot is taken only AFTER the republication, immediately
 * around the preparation, and must not differ at all.
 *
 * No sleep, and no equality with a JavaScript clock: every time comparison is a database inequality.
 * One thing is not identical between the two publications and is not part of the payload: each call
 * is made with its own random API-key id, as the publication fixture already does.
 */
describe("KR-07 unchanged republication refresh", () => {
  /** A roomy policy: an hour. The fixture ages the witness by two. */
  const REVISIT = { ms: 3_600_000, sqlInterval: "1 hour" };

  /** Preparation on a transaction of its own, from the team and the enumerated entry ALONE. The result is the COMMITTED one. */
  function prepared(teamId: string, entry: SlackKnownRootEntry): Promise<SlackKnownRootPreparationResult> {
    // The execution context is created BEFORE the transaction it is used in.
    const execution = createSlackKnownRootExecution({ ambientDeadlineAt: null });
    return tx((s) => prepareSlackKnownRootRequeue(s, { teamId, entry }, execution));
  }

  /** The semantic fields of every ledger row of the team — everything but `observed_at` — as the database renders them. */
  const ledgerSemantics = (teamId: string): Promise<Row[]> => query(
    `select workspace_id, channel_id, message_ts, root_ts, is_root, item_id::text as item_id, author_external_id,
            ${lifecycleUtc("occurred_at")} as occurred_at_utc, eligible, exclusion_reason, source_hash,
            deleted_at is null as live, last_seen_generation::text as last_seen_generation
       from slack_messages where team_id = $1 order by message_ts`, [teamId]
  );
  const generations = (teamId: string): Promise<Row[]> => query(
    `select data_generation::text as data_generation, identity_generation::text as identity_generation,
            presentation_generation::text as presentation_generation
       from slack_team_state where team_id = $1`, [teamId]
  );
  const itemAndVersions = (teamId: string): Promise<Row[]> => query(
    `select i.id::text as id, (select count(*)::int from item_versions v where v.item_id = i.id) as versions
       from items i where i.team_id = $1 order by i.id`, [teamId]
  );
  const databaseClock = async (): Promise<string> =>
    (await query<{ at: string }>(`select ${lifecycleUtc("clock_timestamp()")} as at`))[0].at;

  /**
   * The identical complete thread, staged again as a hydrator leaves it — a queue row, its claim, a
   * complete snapshot, a checkpoint — and published again through the real `ingestItem`. Every value
   * is the one the first publication used.
   */
  async function republishIdentical(f: Published): Promise<unknown> {
    const teamId = f.seed.teamId;
    const selection = await tx((s) => lockSlackSelection(s, { teamId, integrationId: f.integrationId, envToken: () => null }));
    if (selection.outcome !== "current") throw new Error("fixture: the selection is not current");
    const scope = { teamId, workspaceId: WORKSPACE, channelId: CHANNEL, rootTs: OLD_ROOT };
    await tx((s) => enqueueSlackThread(s, scope));
    const acquired = await tx((s) => claimSlackThread(s, scope, { leaseMs: 900_000 }));
    if (!acquired) throw new Error("fixture: the claim was refused");
    const staged = await tx(async (s) => {
      const written = await writeSlackThreadSnapshot(s, acquired, {
        messages: [ROOT_MESSAGE, REPLY_MESSAGE], complete: true, expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      });
      if (written !== "written") throw new Error("fixture: the snapshot was refused");
      return checkpointSlackThread(s, acquired, { pageCursor: null, snapshotGeneration: 1 });
    });
    if (staged.outcome !== "checkpointed") throw new Error("fixture: the checkpoint was refused");
    const claim: SlackThreadClaim = { ...acquired, snapshotGeneration: 1 };
    const option = slackPublicationOption({
      claim, binding: slackBindingRef(selection.selection), namespaceRevision: f.namespaceRevision, channelName: "general", users: USERS,
    });
    const normalized = normalizeThread({ root: ROOT_MESSAGE, replies: [REPLY_MESSAGE] }, {
      channelId: CHANNEL, channelName: "general", users: { U1: "Person One" }, project: "slack",
    });
    const payload = {
      ...normalized,
      path: scopedSlackItemPath(WORKSPACE, CHANNEL, OLD_ROOT),
      frontmatter: { ...normalized.frontmatter, workspace_id: WORKSPACE, source_ts: parseSlackTimestamp(OLD_ROOT)!.iso },
    };
    const auth = { teamId, memberId: f.seed.memberId, apiKeyId: randomUUID() };
    return ingestItem(db(), auth, payload, "team", { authorMemberId: null }, "team", option);
  }

  it("enqueues an aged root that was not republished, at its previously established exact due instant (control)", async () => {
    const label = "aged, not republished (control)";
    const { f, teamId, entry, agedObservedAt, exactDue } = await lifecycleAgedRoot(label, REVISIT);

    const before = await lifecycleSnapshot(teamId);
    const result = await prepared(teamId, entry);

    expect(result, `${label}: the committed outcome`).toEqual({ outcome: "enqueued" });
    expect(await lifecycleQueueAgainst(teamId, exactDue), `${label}: exactly one queue row, at the previously established exact due instant rounded up to its millisecond`)
      .toEqual(LIFECYCLE_ONE_ROW_AT_THE_EXACT_DUE);
    expect(await lifecycleQueueAndStagingAnywhere(), `${label}: the only queue row in the database is this root's, and nothing is staged`).toEqual({
      queue: [{ team_id: teamId, root_ts: OLD_ROOT }], staging: [],
    });
    expect(lifecycleTablesThatDiffer(before, await lifecycleSnapshot(teamId)), `${label}: of the snapshotted surfaces the preparation changed the queue, and nothing else`).toEqual(["slack_sync_threads"]);
    expect(await query(`select ${lifecycleUtc("w.observed_at")} as observed_at_utc from slack_messages w where ${LIFECYCLE_ROOT_WITNESS}`, lifecycleWitnessOf(f)),
      `${label}: the root witness still stores the aged observation`).toEqual([{ observed_at_utc: agedObservedAt }]);
  });

  it("commits not_due from the previously enumerated entry after an identical republication refreshed the root observation, with generations, ledger semantics, item and versions unchanged", async () => {
    const label = "identical republication";
    const { f, teamId, entry, agedObservedAt, exactDue } = await lifecycleAgedRoot(label, REVISIT);

    // ── BEFORE THE REPUBLICATION: what must not change, read from the database. ──
    const itemBefore = await itemAndVersions(teamId);
    const generationsBefore = await generations(teamId);
    const ledgerBefore = await ledgerSemantics(teamId);
    expect(itemBefore.map((row) => row.id), `${label}: fixture: the team's one item is the published root's`).toEqual([f.itemId]);
    expect(generationsBefore, `${label}: fixture: the team has one generation row`).toHaveLength(1);
    expect(ledgerBefore.map((row) => [row.message_ts, row.is_root, row.live]), `${label}: fixture: the ledger holds the live root and its live reply`).toEqual([
      [OLD_ROOT, true, true], [OLD_REPLY, false, true],
    ]);

    // ── THE REPUBLICATION, between two readings of the database's own clock. ──
    const clockBefore = await databaseClock();
    const republished = await republishIdentical(f);
    const clockAfter = await databaseClock();

    expect(republished, `${label}: the republication's status is unchanged, for the same item`).toMatchObject({ status: "unchanged", id: f.itemId });
    expect(await itemAndVersions(teamId), `${label}: the same item id and the same number of versions`).toEqual(itemBefore);
    expect(await generations(teamId), `${label}: the data, identity and presentation generations are unchanged`).toEqual(generationsBefore);
    expect(await ledgerSemantics(teamId), `${label}: every semantic ledger field, and last_seen_generation, is unchanged`).toEqual(ledgerBefore);
    // The observation, by database inequalities only: later than the aged value, and inside the bracket.
    expect(await query(
      `select w.observed_at > $6::timestamptz as strictly_after_the_aged_observation,
              w.observed_at >= $7::timestamptz as not_before_the_clock_reading_before,
              w.observed_at <= $8::timestamptz as not_after_the_clock_reading_after,
              w.deleted_at is null as live,
              w.observed_at + interval '1 hour' > clock_timestamp() as refreshed_due_is_in_the_future,
              $9::timestamptz < clock_timestamp() as old_exact_due_is_still_past
         from slack_messages w where ${LIFECYCLE_ROOT_WITNESS}`, [...lifecycleWitnessOf(f), agedObservedAt, clockBefore, clockAfter, exactDue]
    ), `${label}: the root observation strictly advanced, to an instant between the two database clock readings`).toEqual([{
      strictly_after_the_aged_observation: true, not_before_the_clock_reading_before: true, not_after_the_clock_reading_after: true,
      live: true, refreshed_due_is_in_the_future: true, old_exact_due_is_still_past: true,
    }]);
    expect(await lifecycleQueueAndStagingAnywhere(), `${label}: the republication removed its queue row and its staging`).toEqual({ queue: [], staging: [] });

    // ── THE PREPARATION, from the entry enumerated BEFORE the republication. Its own snapshots. ──
    const before = await lifecycleSnapshot(teamId);
    const result = await prepared(teamId, entry);

    expect(result, `${label}: the committed outcome`).toEqual({ outcome: "not_due" });
    expect(await lifecycleQueueAndStagingAnywhere(), `${label}: no queue row was inserted, and nothing is staged`).toEqual({ queue: [], staging: [] });
    expect(await lifecycleSnapshot(teamId), `${label}: no row of any snapshotted surface was changed by the preparation`).toEqual(before);
  });
});

/**
 * KR-08 in part — caller rollback, replay on another connection, and an application that loses its
 * receipt after a known commit (`docs/design/slack-known-root-requeue-spec.md` §8.3, §8.4, §11 KR-08).
 *
 * EVIDENCE, NOT RED: all three cases are expected to pass on the current source. It is PART of
 * KR-08: the two-preparer race, both publisher orderings and the stale-claim characterization are
 * not here.
 *
 * ROLLBACK. Preparation returns `enqueued` inside the caller's transaction, and through that same
 * transaction the inserted row is read. The caller then throws. From another connection there is no
 * queue row and no snapshotted surface differs: a preparation result is provisional until the
 * caller's transaction commits.
 *
 * RETRY. After that rollback, the same entry is prepared again on ANOTHER connection — a different
 * backend than the one that rolled back — and commits. There is exactly one row, at the same
 * observation-derived due instant the rolled-back attempt had computed.
 *
 * "APPLICATION RECEIPT LOSS AFTER KNOWN COMMIT". The transaction's promise RESOLVES — the commit is
 * known to have happened — and the application deliberately keeps nothing of what preparation
 * returned. A replay on another connection returns `already_pending` and leaves the single committed
 * row byte-identical. This is exactly that: an application that lost a result it had. It is NOT
 * network ambiguity, NOT a commit whose outcome is unknown, and NOT evidence about how the
 * transaction manager reports one; it does not replace the `commit_unknown` evidence of M15c.
 *
 * "Another connection" is established, not assumed: every connection's backend pid is read, and a
 * pooled connection that turns out to be the one to avoid is kept checked out while another is taken.
 */
describe("KR-08 rollback and replay", () => {
  /** The minimum policy. The fixture ages the witness by two hours, so the exact due instant is long past. */
  const REVISIT = { ms: 60_000, sqlInterval: "60 seconds" };

  /** What the caller throws to abandon its transaction. */
  class CallerAbort extends Error {}

  /** Runs on a pooled connection whose backend is NOT `avoidPid`; one that is, is kept checked out while another is taken. */
  function onAnotherConnection<T>(avoidPid: number, run: (session: TransactionSession, pid: number) => Promise<T>): Promise<T> {
    return tx(async (first) => {
      const firstPid = await lifecyclePidOf(first);
      if (firstPid !== avoidPid) return run(first, firstPid);
      return tx(async (second) => {
        const secondPid = await lifecyclePidOf(second);
        if (secondPid === avoidPid) throw new Error("fixture: two checked-out connections report the same backend");
        return run(second, secondPid);
      });
    });
  }

  /** The due instant of every queue row of the team, as the database renders it. */
  const DUE_OF_THE_QUEUE = `select ${lifecycleUtc("due_at")} as due_at_utc from slack_sync_threads where team_id = $1 order by root_ts`;

  /**
   * One preparation that returns `enqueued` and is then ROLLED BACK by its caller. Returns what was
   * seen inside the transaction and how its promise ended; asserts nothing itself.
   */
  async function preparedThenRolledBack(teamId: string, entry: SlackKnownRootEntry) {
    const abort = new CallerAbort("fixture: the caller abandons its transaction after a provisional result");
    // The execution context is created BEFORE the transaction it is used in.
    const execution = createSlackKnownRootExecution({ ambientDeadlineAt: null });
    const inside: { pid: number; provisional: SlackKnownRootPreparationResult | null; dueSeenInside: unknown[] } = { pid: 0, provisional: null, dueSeenInside: [] };
    const ending = await tx(async (a) => {
      inside.pid = await lifecyclePidOf(a);
      inside.provisional = await prepareSlackKnownRootRequeue(a, { teamId, entry }, execution);
      // Through the SAME transaction, after preparation has returned: the row it inserted is there.
      inside.dueSeenInside = (await a.executeSql<{ due_at_utc: string }>(DUE_OF_THE_QUEUE, [teamId])).rows.map((row) => row.due_at_utc);
      throw abort;
    }).then(
      () => "THE TRANSACTION RESOLVED",
      (error: unknown) => (error === abort ? "rejected with the caller's own error"
        : (error as { cause?: unknown } | null)?.cause === abort ? "rejected with an error caused by the caller's own"
        : `rejected with something else: ${error instanceof Error ? error.name : typeof error}`)
    );
    return { ...inside, ending };
  }
  type RolledBack = Awaited<ReturnType<typeof preparedThenRolledBack>>;

  /** What every rollback case requires of the rolled-back attempt, and of the database after it. */
  async function expectRolledBackWithNothingPersisted(rolledBack: RolledBack, teamId: string, before: Record<string, string>, label: string): Promise<void> {
    expect(rolledBack.provisional, `${label}: inside the caller's transaction, preparation returned enqueued`).toEqual({ outcome: "enqueued" });
    expect(rolledBack.dueSeenInside, `${label}: fixture: inside that transaction the inserted row was there`).toHaveLength(1);
    expect(["rejected with the caller's own error", "rejected with an error caused by the caller's own"], `${label}: the caller's throw ended the transaction (${rolledBack.ending})`)
      .toContain(rolledBack.ending);
    // From ANOTHER connection: this file's own dedicated one, which is not in the pool.
    const [{ pid: readerPid }] = await query<{ pid: number }>(`select pg_backend_pid() as pid`);
    expect([rolledBack.pid > 0, Number(readerPid) !== rolledBack.pid], `${label}: fixture: the independent read is on another connection than the one that rolled back`).toEqual([true, true]);
    expect(await lifecycleQueueAndStagingAnywhere(), `${label}: no queue row survived the rollback, and nothing is staged`).toEqual({ queue: [], staging: [] });
    expect(await lifecycleSnapshot(teamId), `${label}: no row of any snapshotted surface survived the rollback as a change`).toEqual(before);
  }

  it("persists nothing when the caller throws after preparation returned a provisional enqueued: no queue row and no other preparation write", async () => {
    const label = "caller rollback";
    const { teamId, entry } = await lifecycleAgedRoot(label, REVISIT);
    const before = await lifecycleSnapshot(teamId);

    const rolledBack = await preparedThenRolledBack(teamId, entry);

    await expectRolledBackWithNothingPersisted(rolledBack, teamId, before, label);
  });

  it("commits exactly one row at the same observation-derived due instant when the rolled-back preparation is retried on another connection", async () => {
    const label = "retry after rollback";
    const { teamId, entry, exactDue } = await lifecycleAgedRoot(label, REVISIT);
    const before = await lifecycleSnapshot(teamId);

    const rolledBack = await preparedThenRolledBack(teamId, entry);
    await expectRolledBackWithNothingPersisted(rolledBack, teamId, before, label);

    // THE RETRY: a later invocation, with its own execution context created before its transaction,
    // on a connection that is not the one that rolled back.
    const execution = createSlackKnownRootExecution({ ambientDeadlineAt: null });
    const retried = await onAnotherConnection(rolledBack.pid, async (b, pid) => ({
      pid, result: await prepareSlackKnownRootRequeue(b, { teamId, entry }, execution),
    }));

    expect([retried.pid !== rolledBack.pid, retried.result], `${label}: on another connection, the committed outcome`).toEqual([true, { outcome: "enqueued" }]);
    expect(await lifecycleQueueAgainst(teamId, exactDue), `${label}: exactly one queue row, at the exact due instant rounded up to its millisecond`)
      .toEqual(LIFECYCLE_ONE_ROW_AT_THE_EXACT_DUE);
    // The SAME historical instant the rolled-back attempt computed, as the database renders both.
    expect((await query<{ due_at_utc: string }>(DUE_OF_THE_QUEUE, [teamId])).map((row) => row.due_at_utc),
      `${label}: the committed due instant is the one the rolled-back attempt had computed`).toEqual(rolledBack.dueSeenInside);
    expect(await lifecycleQueueAndStagingAnywhere(), `${label}: the only queue row in the database is this root's, and nothing is staged`).toEqual({
      queue: [{ team_id: teamId, root_ts: OLD_ROOT }], staging: [],
    });
    expect(lifecycleTablesThatDiffer(before, await lifecycleSnapshot(teamId)), `${label}: of the snapshotted surfaces the committed retry changed the queue, and nothing else`).toEqual(["slack_sync_threads"]);
  });

  it("application receipt loss after known commit: a replay on another connection returns already_pending and leaves the single committed row byte-identical", async () => {
    const label = "application receipt loss after known commit";
    const { teamId, entry, exactDue } = await lifecycleAgedRoot(label, REVISIT);

    // THE FIRST INVOCATION COMMITS, and the application keeps NOTHING of what preparation returned:
    // the callback returns only its connection's pid. The promise resolving is the known commit.
    const firstExecution = createSlackKnownRootExecution({ ambientDeadlineAt: null });
    const committedOnPid = await tx(async (a) => {
      const pid = await lifecyclePidOf(a);
      await prepareSlackKnownRootRequeue(a, { teamId, entry }, firstExecution);
      return pid;
    });

    // What that known commit left, read from another connection and retained whole.
    expect(await lifecycleQueueAgainst(teamId, exactDue), `${label}: fixture: the known commit left exactly one queue row, at the exact due instant rounded up to its millisecond`)
      .toEqual(LIFECYCLE_ONE_ROW_AT_THE_EXACT_DUE);
    const committedRows = await lifecycleQueueRowsExactly(teamId);
    expect(committedRows, `${label}: fixture: one committed queue row`).toHaveLength(1);
    const before = await lifecycleSnapshot(teamId);

    // THE REPLAY, on another connection, with its own execution context created before its transaction.
    const replayExecution = createSlackKnownRootExecution({ ambientDeadlineAt: null });
    const replayed = await onAnotherConnection(committedOnPid, async (b, pid) => ({
      pid, result: await prepareSlackKnownRootRequeue(b, { teamId, entry }, replayExecution),
    }));

    expect([replayed.pid !== committedOnPid, replayed.result], `${label}: on another connection, the replay's committed outcome`).toEqual([true, { outcome: "already_pending" }]);
    expect(await lifecycleQueueRowsExactly(teamId), `${label}: the single committed row is byte-identical after the replay`).toEqual(committedRows);
    expect(await lifecycleQueueAndStagingAnywhere(), `${label}: still the only queue row in the database, and nothing is staged`).toEqual({
      queue: [{ team_id: teamId, root_ts: OLD_ROOT }], staging: [],
    });
    expect(await lifecycleSnapshot(teamId), `${label}: no row of any snapshotted surface was changed by the replay`).toEqual(before);
  });
});

// ── Lifecycle packet: what the concurrency suite below adds ──────────────────────────────────────
// New, file-local helpers for "KR-08 concurrent preparers and publication orderings". No earlier
// helper or case is moved or changed by them; the file's import of the test helpers gained one name,
// `transactionSessionDecoratedDb`, for the publisher-first hold.

/** How a tracked promise ended. It never rejects: a rejection is a value here. */
type LifecycleEnded<T> = { state: "resolved"; value: T } | { state: "rejected"; error: unknown };
/** A promise whose end can be awaited without throwing, and asked about without awaiting. */
function lifecycleTracked<T>(promise: Promise<T>): { ended: Promise<LifecycleEnded<T>>; hasEnded: () => boolean } {
  let over = false;
  const ended: Promise<LifecycleEnded<T>> = promise.then(
    (value) => { over = true; return { state: "resolved" as const, value }; },
    (error: unknown) => { over = true; return { state: "rejected" as const, error }; }
  );
  return { ended, hasEnded: () => over };
}
/** An ending as something a failed assertion can show: the value, or what kind of failure it was. Never the error itself. */
function lifecycleShown<T>(ending: LifecycleEnded<T>): unknown {
  if (ending.state === "resolved") return { state: "resolved", value: ending.value };
  const error = ending.error;
  return {
    state: "rejected",
    failure: classifySlackKnownRootPreparationFailure(error),
    sqlstate: typeof (error as { code?: unknown } | null)?.code === "string" ? (error as { code: string }).code : null,
  };
}
/** A value handed over once, from inside a transaction to the test. */
function lifecycleHandover<T>(): { given: Promise<T>; give: (value: T) => void } {
  let give!: (value: T) => void;
  const given = new Promise<T>((resolve) => { give = resolve; });
  return { given, give };
}
/** A hold point: the held party says it is there, and stays until it is released. Releasing twice does nothing. */
function lifecycleHold<T>(): { reached: Promise<T>; arrive: (value: T) => void; released: Promise<void>; release: () => void } {
  const arrival = lifecycleHandover<T>();
  let open!: () => void;
  const released = new Promise<void>((resolve) => { open = resolve; });
  let isReleased = false;
  return {
    reached: arrival.given, arrive: arrival.give, released,
    release: () => {
      if (isReleased) return;
      isReleased = true;
      open();
    },
  };
}
/** What was handed over, unless the party that should hand it over ended first: then a fixture error says how it ended. */
async function lifecycleArrived<T, U>(given: Promise<T>, party: { ended: Promise<LifecycleEnded<U>> }, what: string): Promise<T> {
  const first = await Promise.race([
    given.then((value) => ({ arrived: true as const, value })),
    party.ended.then((ending) => ({ arrived: false as const, ending })),
  ]);
  if (first.arrived) return first.value;
  throw new Error(`fixture: ${what} ended before reaching its hold point: ${JSON.stringify(lifecycleShown(first.ending))}`);
}

/**
 * WHO IS WAITING ON A LOCK HELD BY ONE BACKEND, as PostgreSQL itself reports it, read from this
 * file's own dedicated connection: every other backend of this database that `pg_blocking_pids`
 * says is blocked by `blockerPid`; its state, wait event and current statement; the locks it is
 * waiting for; and the transaction ids the BLOCKER holds — so that "it waits for a transaction of
 * that backend" is read off the lock table, not inferred.
 */
type LifecycleWaiter = {
  pid: number; state: string | null; wait_event_type: string | null; query: string | null;
  ungranted: { locktype: string; mode: string; transactionid: string | null }[];
  blocker_transaction_ids: string[];
};
const LIFECYCLE_WAITERS_SQL = `
  select a.pid, a.state, a.wait_event_type, a.query,
         (select coalesce(jsonb_agg(jsonb_build_object('locktype', l.locktype, 'mode', l.mode, 'transactionid', l.transactionid::text) order by l.locktype, l.mode), '[]'::jsonb)
            from pg_locks l where l.pid = a.pid and not l.granted) as ungranted,
         (select coalesce(jsonb_agg(h.transactionid::text order by h.transactionid::text), '[]'::jsonb)
            from pg_locks h where h.pid = $1::int and h.locktype = 'transactionid' and h.granted) as blocker_transaction_ids
    from pg_stat_activity a
   where a.datname = current_database() and a.pid <> pg_backend_pid()
     and $1::int = any(pg_blocking_pids(a.pid))
   order by a.pid`;
/**
 * Reads the lock table until a waiter behind `blockerPid` has been seen TWICE IN A ROW, and returns
 * the facts of the second reading.
 *
 * The first sighting is provisional. `pg_blocking_pids` reads the live lock queue, while the state,
 * wait event and statement of `pg_stat_activity` in that same reading can still describe the
 * backend's last moment BEFORE it went to sleep on the lock. A reading that first names the waiter
 * can therefore carry facts of the transition into the wait and not of the wait. So nothing is
 * returned from it: a second, fresh query is made, and only a reading that again names a waiter is
 * handed back. If the waiter is gone by then — a waiting preparation's lock timeout has fired — that
 * is not an observed wait, and the reading goes on until the waiting party has ended or the bound
 * has passed.
 *
 * The ONLY thing repeated is this readback: there is no sleep, and each round is one query. Not
 * seeing a wait is reported, never assumed.
 */
async function lifecycleObservedWaiters(blockerPid: number, waiterHasEnded: () => boolean, boundMs: number): Promise<{ waiters: LifecycleWaiter[]; polls: number; notObservedBecause: string | null }> {
  const startedAt = performance.now();
  let sightedOnThePreviousReading = false;
  for (let polls = 1; ; polls++) {
    const waiters = await query<LifecycleWaiter>(LIFECYCLE_WAITERS_SQL, [blockerPid]);
    if (waiters.length > 0) {
      // The second of two consecutive sightings is the observation. The first only says: read again.
      if (sightedOnThePreviousReading) return { waiters, polls, notObservedBecause: null };
      sightedOnThePreviousReading = true;
      continue;
    }
    sightedOnThePreviousReading = false;
    if (waiterHasEnded()) return { waiters, polls, notObservedBecause: "the party that should have waited ended before a wait was seen on two consecutive readings" };
    if (performance.now() - startedAt > boundMs) return { waiters, polls, notObservedBecause: `no wait was seen on two consecutive readings within ${boundMs} ms` };
  }
}
/** The observed waiters as the facts a case asserts: one line per waiter, nothing inferred. */
const lifecycleWaitFacts = (waiters: readonly LifecycleWaiter[]) => waiters.map((waiter) => {
  const statement = (waiter.query ?? "").replace(/\s+/g, " ");
  return {
    pid: Number(waiter.pid), state: waiter.state, wait_event_type: waiter.wait_event_type,
    isTheNamespaceGateRowLock: /from slack_channel_migration_gates\b/.test(statement) && /\bfor update\b/.test(statement),
    waitsFor: waiter.ungranted.map((lock) => `${lock.locktype}/${lock.mode}`),
    everyAwaitedTransactionIsTheBlockers: waiter.ungranted.length > 0 &&
      waiter.ungranted.every((lock) => lock.transactionid !== null && waiter.blocker_transaction_ids.includes(lock.transactionid)),
  };
});
/** ONE waiter, active, in a lock wait, at the namespace gate's row lock, waiting for a transaction the blocker holds. */
const lifecycleOneGateWaiter = (pid: unknown) => [{
  pid, state: "active", wait_event_type: "Lock", isTheNamespaceGateRowLock: true,
  waitsFor: ["transactionid/ShareLock"], everyAwaitedTransactionIsTheBlockers: true,
}];

/**
 * The identical complete thread of a published root, staged again as a hydrator leaves it — a queue
 * row, its claim, a complete snapshot, a checkpoint — and read back. Returns the one call that
 * republishes it through the real `ingestItem`, on whatever client it is given.
 */
async function lifecycleRestaged(f: Published, label: string): Promise<{ publish: (client: Parameters<typeof ingestItem>[0]) => ReturnType<typeof ingestItem> }> {
  const teamId = f.seed.teamId;
  const selection = await tx((s) => lockSlackSelection(s, { teamId, integrationId: f.integrationId, envToken: () => null }));
  if (selection.outcome !== "current") throw new Error("fixture: the selection is not current");
  const scope = { teamId, workspaceId: WORKSPACE, channelId: CHANNEL, rootTs: OLD_ROOT };
  await tx((s) => enqueueSlackThread(s, scope));
  const acquired = await tx((s) => claimSlackThread(s, scope, { leaseMs: 900_000 }));
  if (!acquired) throw new Error("fixture: the claim was refused");
  const staged = await tx(async (s) => {
    const written = await writeSlackThreadSnapshot(s, acquired, {
      messages: [ROOT_MESSAGE, REPLY_MESSAGE], complete: true, expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    });
    if (written !== "written") throw new Error("fixture: the snapshot was refused");
    return checkpointSlackThread(s, acquired, { pageCursor: null, snapshotGeneration: 1 });
  });
  if (staged.outcome !== "checkpointed") throw new Error("fixture: the checkpoint was refused");
  expect(await query(
    `select status, attempts, snapshot_generation::text as snapshot_generation, page_cursor, lease_expires_at > clock_timestamp() as lease_is_live
       from slack_sync_threads where team_id = $1`, [teamId]
  ), `${label}: fixture: a legitimately claimed, running queue row with a checkpointed complete snapshot`).toEqual([
    { status: "running", attempts: 1, snapshot_generation: "1", page_cursor: null, lease_is_live: true },
  ]);
  expect(await query(
    `select snapshot_generation::text as snapshot_generation, complete, jsonb_array_length(messages) as messages, expires_at > clock_timestamp() as live
       from slack_thread_snapshots where team_id = $1`, [teamId]
  ), `${label}: fixture: the staged snapshot is complete and live`).toEqual([{ snapshot_generation: "1", complete: true, messages: 2, live: true }]);

  const claim: SlackThreadClaim = { ...acquired, snapshotGeneration: 1 };
  const option = slackPublicationOption({
    claim, binding: slackBindingRef(selection.selection), namespaceRevision: f.namespaceRevision, channelName: "general", users: USERS,
  });
  const normalized = normalizeThread({ root: ROOT_MESSAGE, replies: [REPLY_MESSAGE] }, {
    channelId: CHANNEL, channelName: "general", users: { U1: "Person One" }, project: "slack",
  });
  const payload = {
    ...normalized,
    path: scopedSlackItemPath(WORKSPACE, CHANNEL, OLD_ROOT),
    frontmatter: { ...normalized.frontmatter, workspace_id: WORKSPACE, source_ts: parseSlackTimestamp(OLD_ROOT)!.iso },
  };
  const auth = { teamId, memberId: f.seed.memberId, apiKeyId: randomUUID() };
  return { publish: (client) => ingestItem(client, auth, payload, "team", { authorMemberId: null }, "team", option) };
}

/**
 * KR-08 in part — two preparers, and both orderings of a preparer against the publisher
 * (`docs/design/slack-known-root-requeue-spec.md` §5.1, §8.4, §11 KR-08).
 *
 * EVIDENCE, NOT RED: all three cases are expected to pass on the current source. The stale-claim
 * characterization of KR-08 is not here, and no mutant is claimed to be killed by this suite.
 *
 * THE OVERLAP IS READ FROM POSTGRESQL, NOT FROM TIME. In each case one party is held at a named
 * point INSIDE its open transaction, and the other is started. That the second is really waiting
 * behind the first is then read from the server: `pg_blocking_pids` names the first party's backend
 * as its blocker; `pg_stat_activity` shows it active in a lock wait on the namespace gate's row
 * lock; and `pg_locks` shows it waiting for a transaction id that the first party's backend holds.
 * Only after that readback is the first party released. An unresolved JavaScript promise is never
 * taken as the proof, and nothing sleeps: the readback is repeated, one query a round, under a bound.
 * A first reading that names the waiter is provisional, because its state fields can still describe
 * the moment before the wait; the facts asserted are those of a second, fresh reading that names it again.
 *
 * A WAITING PREPARATION HAS 250 ms. Preparation caps every lock wait at 250 ms. In the first two
 * cases the waiting party is a preparation, so the wait must be seen and the holder released within
 * that time. If it is not, the waiter fails with a lock timeout and the case FAILS: a lock timeout,
 * or an overlap that was not observed, is never a pass. Nothing in the test raises or evades the cap.
 *
 * THE HOLD POINTS, each in test-local control and none in production code:
 *   two preparers     A's own transaction callback, after preparation has returned `enqueued`.
 *   publisher first   a test-only wrapper of the publication's own session, on the real `ingestItem`:
 *                     it forwards every statement unchanged and withholds only the resolution of the
 *                     acknowledging delete of the queue row — so the evidence has been refreshed and
 *                     the row acknowledged, and nothing is committed. At that point, and only there,
 *                     it also issues one statement of its own on that session: a read-only
 *                     `select pg_backend_pid()`, which is how the test learns the publication's backend.
 *   preparer first    A's own transaction callback, after preparation has returned `already_pending`.
 *
 * WHAT CAN AND CANNOT BE ATTRIBUTED. Where a preparation's work is finished while the other party is
 * still blocked — the preparer-first case — the scoped snapshot is taken then, and shows the
 * preparation changed nothing. Where the two commit close together, the whole episode is compared
 * instead: only the tables a republication is known to write may differ, and what it wrote is read
 * back exactly. The scoped snapshot is the one of the lifecycle suites above, and is not the whole
 * of KR-13.
 *
 * Every held party is released in a `finally`, which then waits for both to end; a hook releases
 * them again if the body never gets there. Each case has its own wall-clock timeout.
 */
describe("KR-08 concurrent preparers and publication orderings", () => {
  /** The minimum policy, for the two preparers. */
  const A_MINUTE = { ms: 60_000, sqlInterval: "60 seconds" };
  /** A roomy policy for the publication orderings: an hour. The fixture ages the witness by two. */
  const AN_HOUR = { ms: 3_600_000, sqlInterval: "1 hour" };
  /** A waiting preparation gives up after 250 ms, so its wait is seen well inside this bound or not at all. */
  const PREPARATION_WAIT_BOUND_MS = 2_000;
  /** A waiting publication has no such cap; its wait is looked for a little longer. */
  const PUBLICATION_WAIT_BOUND_MS = 10_000;
  const CASE_TIMEOUT_MS = 30_000;
  /** The only tables a republication writes, of the snapshotted surfaces: the three it must, and two more it may. */
  const A_REPUBLICATION_MUST_CHANGE = ["slack_messages", "slack_sync_threads", "slack_thread_snapshots"];
  const A_REPUBLICATION_MAY_CHANGE = [...A_REPUBLICATION_MUST_CHANGE, "items", "projects"];

  const ledgerSemantics = (teamId: string): Promise<Row[]> => query(
    `select workspace_id, channel_id, message_ts, root_ts, is_root, item_id::text as item_id, author_external_id,
            ${lifecycleUtc("occurred_at")} as occurred_at_utc, eligible, exclusion_reason, source_hash,
            deleted_at is null as live, last_seen_generation::text as last_seen_generation
       from slack_messages where team_id = $1 order by message_ts`, [teamId]
  );
  const generations = (teamId: string): Promise<Row[]> => query(
    `select data_generation::text as data_generation, identity_generation::text as identity_generation,
            presentation_generation::text as presentation_generation
       from slack_team_state where team_id = $1`, [teamId]
  );
  const itemAndVersions = (teamId: string): Promise<Row[]> => query(
    `select i.id::text as id, (select count(*)::int from item_versions v where v.item_id = i.id) as versions
       from items i where i.team_id = $1 order by i.id`, [teamId]
  );
  const databaseClock = async (): Promise<string> =>
    (await query<{ at: string }>(`select ${lifecycleUtc("clock_timestamp()")} as at`))[0].at;
  const rootObservation = async (f: Published): Promise<unknown> =>
    (await query(`select ${lifecycleUtc("w.observed_at")} as observed_at_utc from slack_messages w where ${LIFECYCLE_ROOT_WITNESS}`, lifecycleWitnessOf(f)))
      .map((row) => row.observed_at_utc);
  const stagingRowsExactly = async (teamId: string): Promise<string[]> =>
    (await query(`select to_jsonb(t)::text as stored from slack_thread_snapshots t where t.team_id = $1 order by t.root_ts`, [teamId])).map((row) => row.stored as string);

  /** What a republication must have done to the root's observation: all database inequalities. */
  const observationRefreshed = (f: Published, agedObservedAt: string, clockBefore: string, clockAfter: string, exactDue: string): Promise<Row[]> => query(
    `select w.observed_at > $6::timestamptz as strictly_after_the_aged_observation,
            w.observed_at >= $7::timestamptz as not_before_the_clock_reading_before,
            w.observed_at <= $8::timestamptz as not_after_the_clock_reading_after,
            w.deleted_at is null as live,
            w.observed_at + interval '1 hour' > clock_timestamp() as refreshed_due_is_in_the_future,
            $9::timestamptz < clock_timestamp() as old_exact_due_is_still_past
       from slack_messages w where ${LIFECYCLE_ROOT_WITNESS}`, [...lifecycleWitnessOf(f), agedObservedAt, clockBefore, clockAfter, exactDue]
  );
  const REFRESHED = [{
    strictly_after_the_aged_observation: true, not_before_the_clock_reading_before: true, not_after_the_clock_reading_after: true,
    live: true, refreshed_due_is_in_the_future: true, old_exact_due_is_still_past: true,
  }];

  it("commits exactly one insertion when two preparers share one enumerated entry: the second waits in PostgreSQL behind the first and returns already_pending", async () => {
    const label = "two preparers";
    const { f, teamId, entry, agedObservedAt, exactDue } = await lifecycleAgedRoot(label, A_MINUTE);
    const before = await lifecycleSnapshot(teamId);

    // ── A: prepares, and is HELD in its own transaction after preparation returned. ──
    const holdA = lifecycleHold<{ pid: number; provisional: SlackKnownRootPreparationResult; dueSeenInside: string[] }>();
    onTestFinished(() => holdA.release());
    const executionA = createSlackKnownRootExecution({ ambientDeadlineAt: null });
    const preparerA = lifecycleTracked(tx(async (a) => {
      const pid = await lifecyclePidOf(a);
      const provisional = await prepareSlackKnownRootRequeue(a, { teamId, entry }, executionA);
      const dueSeenInside = (await a.executeSql<{ due_at_utc: string }>(
        `select ${lifecycleUtc("due_at")} as due_at_utc from slack_sync_threads where team_id = $1 order by root_ts`, [teamId]
      )).rows.map((row) => row.due_at_utc);
      holdA.arrive({ pid, provisional, dueSeenInside });
      await holdA.released;
      return provisional;
    }));

    let startedPreparerB: ReturnType<typeof lifecycleTracked<SlackKnownRootPreparationResult>> | null = null;
    let reachedHoldA: Awaited<typeof holdA.reached> | null = null;
    let pidOfB = 0;
    let committedWhileAHeld: unknown = null;
    let observedOverlap: Awaited<ReturnType<typeof lifecycleObservedWaiters>> | null = null;
    try {
      const held = await lifecycleArrived(holdA.reached, preparerA, "preparer A");
      reachedHoldA = held;
      // From outside, while A is held: its insert is not committed.
      committedWhileAHeld = await lifecycleQueueAndStagingAnywhere();

      // ── B: the same entry, on another connection, with its own context created before its transaction. ──
      const startedB = lifecycleHandover<number>();
      const executionB = createSlackKnownRootExecution({ ambientDeadlineAt: null });
      const second = lifecycleTracked(tx(async (b) => {
        startedB.give(await lifecyclePidOf(b));
        return prepareSlackKnownRootRequeue(b, { teamId, entry }, executionB);
      }));
      startedPreparerB = second;
      pidOfB = await lifecycleArrived(startedB.given, second, "preparer B");
      // ── THE OVERLAP, read from PostgreSQL. A is released the moment it has been read. ──
      observedOverlap = await lifecycleObservedWaiters(held.pid, second.hasEnded, PREPARATION_WAIT_BOUND_MS);
    } finally {
      holdA.release();
      await preparerA.ended;
      if (startedPreparerB) await startedPreparerB.ended;
    }
    if (reachedHoldA === null || startedPreparerB === null || observedOverlap === null) throw new Error("fixture: the case did not get as far as its overlap");
    const heldA = reachedHoldA;
    const observed = observedOverlap;
    const endedA = await preparerA.ended;
    const endedB = await startedPreparerB.ended;

    // FIXTURE: the hold was where it should be, and B was another connection.
    expect(heldA.provisional, `${label}: fixture: A was held after preparation had returned a provisional enqueued`).toEqual({ outcome: "enqueued" });
    expect(heldA.dueSeenInside, `${label}: fixture: inside A's transaction the inserted row was there`).toHaveLength(1);
    expect(committedWhileAHeld, `${label}: fixture: while A was held, nothing of it was committed`).toEqual({ queue: [], staging: [] });
    expect([pidOfB > 0, pidOfB !== heldA.pid], `${label}: fixture: B ran on another connection than A`).toEqual([true, true]);
    // THE OVERLAP: B was blocked in PostgreSQL, by A's backend, waiting for A's transaction.
    expect(observed.notObservedBecause, `${label}: barrier: B's wait behind A was observed in PostgreSQL`).toBeNull();
    expect(lifecycleWaitFacts(observed.waiters), `${label}: barrier: exactly B is blocked by A's backend, at the namespace gate's row lock, waiting for a transaction A holds`)
      .toEqual(lifecycleOneGateWaiter(pidOfB));

    // BOTH COMMITTED: one insertion, one already_pending. A lock timeout on B would show here as a rejection.
    expect([lifecycleShown(endedA), lifecycleShown(endedB)], `${label}: A commits enqueued and B commits already_pending`).toEqual([
      { state: "resolved", value: { outcome: "enqueued" } }, { state: "resolved", value: { outcome: "already_pending" } },
    ]);
    expect(await lifecycleQueueAgainst(teamId, exactDue), `${label}: exactly one queue row, at the exact due instant rounded up to its millisecond`)
      .toEqual(LIFECYCLE_ONE_ROW_AT_THE_EXACT_DUE);
    expect((await query<{ due_at_utc: string }>(`select ${lifecycleUtc("due_at")} as due_at_utc from slack_sync_threads where team_id = $1 order by root_ts`, [teamId])).map((row) => row.due_at_utc),
      `${label}: the committed due instant is the historical one A computed, unchanged by B`).toEqual(heldA.dueSeenInside);
    expect(await lifecycleQueueAndStagingAnywhere(), `${label}: the only queue row in the database is this root's, and nothing is staged`).toEqual({
      queue: [{ team_id: teamId, root_ts: OLD_ROOT }], staging: [],
    });
    expect(lifecycleTablesThatDiffer(before, await lifecycleSnapshot(teamId)), `${label}: of the snapshotted surfaces the two preparations changed the queue, and nothing else`).toEqual(["slack_sync_threads"]);
    expect(await rootObservation(f), `${label}: the root witness still stores the aged observation`).toEqual([agedObservedAt]);
  }, CASE_TIMEOUT_MS);

  it("publisher first: a preparation that waits in PostgreSQL behind an uncommitted republication commits not_due and leaves queue and staging absent", async () => {
    const label = "publisher first";
    const { f, teamId, entry, agedObservedAt, exactDue } = await lifecycleAgedRoot(label, AN_HOUR);
    const restaged = await lifecycleRestaged(f, label);
    const itemBefore = await itemAndVersions(teamId);
    const generationsBefore = await generations(teamId);
    const ledgerBefore = await ledgerSemantics(teamId);
    const queueBefore = await lifecycleQueueRowsExactly(teamId);
    const stagingBefore = await stagingRowsExactly(teamId);
    const before = await lifecycleSnapshot(teamId);

    // ── THE PUBLICATION: the real `ingestItem`, on a client whose transaction session is wrapped by
    //    the test. The wrapper forwards every statement unchanged, and withholds only the resolution
    //    of the acknowledging delete: evidence refreshed, queue row acknowledged, nothing committed.
    //    At that hold point it also runs one read-only statement of its own on the publication's
    //    session, `select pg_backend_pid()`, to learn which backend the publication is. ──
    const holdPublication = lifecycleHold<{ pid: number; acknowledgedRows: number }>();
    onTestFinished(() => holdPublication.release());
    let heldOnce = false;
    const heldClient = transactionSessionDecoratedDb(db(), (session) => ({
      ...session,
      executeSql: async <T = Record<string, unknown>>(sql: string, params?: unknown[]) => {
        const result = await session.executeSql<T>(sql, params);
        if (!heldOnce && /delete from slack_sync_threads t where/.test(sql.replace(/\s+/g, " "))) {
          heldOnce = true;
          holdPublication.arrive({ pid: await lifecyclePidOf(session), acknowledgedRows: result.rows.length });
          await holdPublication.released;
        }
        return result;
      },
    }));
    const clockBefore = await databaseClock();
    const publication = lifecycleTracked(restaged.publish(heldClient));

    let startedPreparation: ReturnType<typeof lifecycleTracked<SlackKnownRootPreparationResult>> | null = null;
    let reachedHold: Awaited<typeof holdPublication.reached> | null = null;
    let pidOfPreparation = 0;
    let committedWhileHeld: unknown = null;
    let observedOverlap: Awaited<ReturnType<typeof lifecycleObservedWaiters>> | null = null;
    try {
      const held = await lifecycleArrived(holdPublication.reached, publication, "the publication");
      reachedHold = held;
      // From outside, while the publication is held: nothing of it is committed.
      committedWhileHeld = {
        queue: await lifecycleQueueRowsExactly(teamId), staging: await stagingRowsExactly(teamId), rootObservation: await rootObservation(f),
      };

      // ── THE PREPARATION, from the entry enumerated before any of this, with its own context. ──
      const started = lifecycleHandover<number>();
      const execution = createSlackKnownRootExecution({ ambientDeadlineAt: null });
      const preparing = lifecycleTracked(tx(async (p) => {
        started.give(await lifecyclePidOf(p));
        return prepareSlackKnownRootRequeue(p, { teamId, entry }, execution);
      }));
      startedPreparation = preparing;
      pidOfPreparation = await lifecycleArrived(started.given, preparing, "the preparation");
      // ── THE OVERLAP, read from PostgreSQL. The publication is released the moment it has been read. ──
      observedOverlap = await lifecycleObservedWaiters(held.pid, preparing.hasEnded, PREPARATION_WAIT_BOUND_MS);
    } finally {
      holdPublication.release();
      await publication.ended;
      if (startedPreparation) await startedPreparation.ended;
    }
    if (reachedHold === null || startedPreparation === null || observedOverlap === null) throw new Error("fixture: the case did not get as far as its overlap");
    const heldPublication = reachedHold;
    const observed = observedOverlap;
    const clockAfter = await databaseClock();
    const endedPublication = await publication.ended;
    const endedPreparation = await startedPreparation.ended;

    // FIXTURE: the hold was where it should be.
    expect(heldPublication.acknowledgedRows, `${label}: fixture: the publication was held after its acknowledging delete had removed the one queue row`).toBe(1);
    expect(committedWhileHeld, `${label}: fixture: while the publication was held, the committed queue row, staging and aged observation were all still there`).toEqual({
      queue: queueBefore, staging: stagingBefore, rootObservation: [agedObservedAt],
    });
    expect([pidOfPreparation > 0, pidOfPreparation !== heldPublication.pid], `${label}: fixture: the preparation ran on another connection than the publication`).toEqual([true, true]);
    // THE OVERLAP: the preparation was blocked in PostgreSQL, by the publication's backend, at the authority lock.
    expect(observed.notObservedBecause, `${label}: barrier: the preparation's wait behind the publication was observed in PostgreSQL`).toBeNull();
    expect(lifecycleWaitFacts(observed.waiters), `${label}: barrier: exactly the preparation is blocked by the publication's backend, at the namespace gate's row lock, waiting for a transaction it holds`)
      .toEqual(lifecycleOneGateWaiter(pidOfPreparation));

    // THE PUBLICATION COMMITTED, unchanged; THE PREPARATION then read the refreshed witness and the
    // absent queue row. Had it read the row it would have answered already_pending; had it read the
    // aged witness, enqueued. A lock timeout would show here as a rejection.
    expect(endedPublication.state === "resolved" ? endedPublication.value : lifecycleShown(endedPublication), `${label}: the republication's status is unchanged, for the same item`)
      .toMatchObject({ status: "unchanged", id: f.itemId });
    expect(lifecycleShown(endedPreparation), `${label}: the preparation commits not_due`).toEqual({ state: "resolved", value: { outcome: "not_due" } });
    expect(await lifecycleQueueAndStagingAnywhere(), `${label}: queue and staging are absent`).toEqual({ queue: [], staging: [] });
    expect(await observationRefreshed(f, agedObservedAt, clockBefore, clockAfter, exactDue), `${label}: the root observation strictly advanced, to an instant between the two database clock readings`).toEqual(REFRESHED);
    expect(await itemAndVersions(teamId), `${label}: the same item id and the same number of versions`).toEqual(itemBefore);
    expect(await generations(teamId), `${label}: the data, identity and presentation generations are unchanged`).toEqual(generationsBefore);
    expect(await ledgerSemantics(teamId), `${label}: every semantic ledger field, and last_seen_generation, is unchanged`).toEqual(ledgerBefore);
    // The whole episode, on the scoped surfaces: only what a republication writes may differ.
    const differing = lifecycleTablesThatDiffer(before, await lifecycleSnapshot(teamId));
    expect(differing.filter((table) => !A_REPUBLICATION_MAY_CHANGE.includes(table)), `${label}: no scoped surface that a republication does not write was changed by either party`).toEqual([]);
    expect(A_REPUBLICATION_MUST_CHANGE.filter((table) => !differing.includes(table)), `${label}: the republication wrote the ledger and removed the queue row and the staging`).toEqual([]);
  }, CASE_TIMEOUT_MS);

  it("preparer first: a republication that waits in PostgreSQL behind a preparation holding already_pending proceeds unchanged, refreshes the observation and acknowledges the queue and staging", async () => {
    const label = "preparer first";
    const { f, teamId, entry, agedObservedAt, exactDue } = await lifecycleAgedRoot(label, AN_HOUR);
    const restaged = await lifecycleRestaged(f, label);
    const itemBefore = await itemAndVersions(teamId);
    const generationsBefore = await generations(teamId);
    const ledgerBefore = await ledgerSemantics(teamId);
    const queueBefore = await lifecycleQueueRowsExactly(teamId);
    const stagingBefore = await stagingRowsExactly(teamId);
    const before = await lifecycleSnapshot(teamId);

    // ── THE PREPARATION: finds the running row, returns already_pending, and is HELD in its own
    //    transaction, still holding its authority locks. ──
    const holdA = lifecycleHold<{ pid: number; provisional: SlackKnownRootPreparationResult }>();
    onTestFinished(() => holdA.release());
    const executionA = createSlackKnownRootExecution({ ambientDeadlineAt: null });
    const preparerA = lifecycleTracked(tx(async (a) => {
      const pid = await lifecyclePidOf(a);
      const provisional = await prepareSlackKnownRootRequeue(a, { teamId, entry }, executionA);
      holdA.arrive({ pid, provisional });
      await holdA.released;
      return provisional;
    }));

    let startedPublication: ReturnType<typeof lifecycleTracked<Awaited<ReturnType<typeof ingestItem>>>> | null = null;
    let reachedHoldA: Awaited<typeof holdA.reached> | null = null;
    let whileBothOpen: { differsFromBefore: string[]; queue: string[]; staging: string[]; rootObservation: unknown } | null = null;
    let observedOverlap: Awaited<ReturnType<typeof lifecycleObservedWaiters>> | null = null;
    let clockBefore = "";
    try {
      const held = await lifecycleArrived(holdA.reached, preparerA, "the preparation");
      reachedHoldA = held;

      // ── THE PUBLICATION: the real `ingestItem`, on the ordinary client, for the legitimately
      //    claimed pending work. Its backend is not known here; it is found by whom it waits behind. ──
      clockBefore = await databaseClock();
      const publishing = lifecycleTracked(restaged.publish(db()));
      startedPublication = publishing;
      // ── THE OVERLAP, read from PostgreSQL. ──
      const overlap = await lifecycleObservedWaiters(held.pid, publishing.hasEnded, PUBLICATION_WAIT_BOUND_MS);
      observedOverlap = overlap;
      // The preparation has finished its work and the publication is blocked before its first
      // transactional write: what differs now is what either has written so far. Read only when the
      // wait was really observed; otherwise the case fails on that, below.
      if (overlap.notObservedBecause === null) {
        whileBothOpen = {
          differsFromBefore: lifecycleTablesThatDiffer(before, await lifecycleSnapshot(teamId)),
          queue: await lifecycleQueueRowsExactly(teamId), staging: await stagingRowsExactly(teamId), rootObservation: await rootObservation(f),
        };
      }
    } finally {
      holdA.release();
      await preparerA.ended;
      if (startedPublication) await startedPublication.ended;
    }
    if (reachedHoldA === null || startedPublication === null || observedOverlap === null) throw new Error("fixture: the case did not get as far as its overlap");
    const heldA = reachedHoldA;
    const observed = observedOverlap;
    const clockAfter = await databaseClock();
    const endedA = await preparerA.ended;
    const endedPublication = await startedPublication.ended;

    // FIXTURE: the hold was where it should be.
    expect(heldA.provisional, `${label}: fixture: the preparation was held after it had returned already_pending`).toEqual({ outcome: "already_pending" });
    // THE OVERLAP: the publication was blocked in PostgreSQL, by the preparation's backend, at the authority lock.
    expect(observed.notObservedBecause, `${label}: barrier: the publication's wait behind the preparation was observed in PostgreSQL`).toBeNull();
    expect(lifecycleWaitFacts(observed.waiters), `${label}: barrier: exactly one backend is blocked by the preparation's backend, at the namespace gate's row lock, waiting for a transaction it holds`)
      .toEqual(lifecycleOneGateWaiter(expect.any(Number)));
    expect(observed.waiters.map((waiter) => Number(waiter.pid) !== heldA.pid), `${label}: barrier: that backend is not the preparation's own`).toEqual([true]);
    // WHILE BOTH WERE OPEN: the preparation had changed nothing. The one surface that differs is the
    // project row the publication touches BEFORE it opens its transaction, and the queue row, the
    // staging and the aged observation are exactly as staged.
    expect(whileBothOpen, `${label}: while the preparation was held and the publication waited, nothing the preparation could write had changed`).toEqual({
      differsFromBefore: ["projects"], queue: queueBefore, staging: stagingBefore, rootObservation: [agedObservedAt],
    });

    // THE PREPARATION COMMITTED already_pending; THE PUBLICATION then proceeded, unchanged.
    expect(lifecycleShown(endedA), `${label}: the preparation commits already_pending`).toEqual({ state: "resolved", value: { outcome: "already_pending" } });
    expect(endedPublication.state === "resolved" ? endedPublication.value : lifecycleShown(endedPublication), `${label}: the republication's status is unchanged, for the same item`)
      .toMatchObject({ status: "unchanged", id: f.itemId });
    expect(await lifecycleQueueAndStagingAnywhere(), `${label}: the publication acknowledged the queue row and removed the staging`).toEqual({ queue: [], staging: [] });
    expect(await observationRefreshed(f, agedObservedAt, clockBefore, clockAfter, exactDue), `${label}: the root observation strictly advanced, to an instant between the two database clock readings`).toEqual(REFRESHED);
    expect(await itemAndVersions(teamId), `${label}: the same item id and the same number of versions`).toEqual(itemBefore);
    expect(await generations(teamId), `${label}: the data, identity and presentation generations are unchanged`).toEqual(generationsBefore);
    expect(await ledgerSemantics(teamId), `${label}: every semantic ledger field, and last_seen_generation, is unchanged`).toEqual(ledgerBefore);
    const differing = lifecycleTablesThatDiffer(before, await lifecycleSnapshot(teamId));
    expect(differing.filter((table) => !A_REPUBLICATION_MAY_CHANGE.includes(table)), `${label}: no scoped surface that a republication does not write was changed by either party`).toEqual([]);
    expect(A_REPUBLICATION_MUST_CHANGE.filter((table) => !differing.includes(table)), `${label}: the republication wrote the ledger and removed the queue row and the staging`).toEqual([]);
  }, CASE_TIMEOUT_MS);
});

// ── THE ENUMERATION AND CONTINUATION EVIDENCE PACKET ─────────────────────────────────────────────
//
// New, file-local helpers and six suites. No earlier helper, constant or case is moved or changed.
// No KR-17 hook is involved in any of these selections, and the KR-17 capacity fixture is not
// repeated: nothing below is a capacity, plan or timing claim.

/**
 * EVIDENCE, NOT RED: every case of the six suites below is expected to pass on the current source
 * (`docs/design/slack-known-root-requeue-spec.md` §4.2, §4.3, §11 KR-02, KR-04, KR-10, KR-11, KR-15,
 * §12 M7, M8a, M8b). They are evidence to be audited later; none of them declares a KR row complete.
 *
 * WHAT IS REAL AND WHAT IS A FIXTURE. Every fixture starts from at least one root that the real
 * discovery, readiness, staging and `ingestItem` publication produced. Everything else is planted by
 * LABELED FIXTURE DML in this file, because an item id cannot be chosen through the application's
 * writers and the order of a page is the order of ids:
 *
 *   - a SYNTHETIC CANONICAL ROOT is an item row carrying the published item's own stored metadata
 *     with only its two root timestamps replaced, in the Slack project, at the path the real builder
 *     gives, with one live root witness bound to it in the exact scope;
 *   - a PLAIN FIXTURE ITEM is a bare item row with a chosen id, path and frontmatter.
 *
 * Chosen ids all begin `00000000-`, so they sort before any random id that does not itself
 * begin with eight zero digits (fewer than one random id in four billion does); each fixture ASSERTS, by reading
 * the team's ids back in PostgreSQL's own UUID order, that the order written out in the test is the
 * order the database has. An expected page is written from the specification's contract — at most
 * `pageSize` examined ids, one entry per examined id, a cursor after the last examined id inside the
 * range the first page froze — and never taken from what the page read returned.
 */
type EnumCursor = SlackKnownRootItemPage["nextCursor"];
type EnumExpectedEntry = { teamId: string; itemId: string; revisitAfterMs: number } & ({ locator: Record<string, unknown> } | { unlocated: string });
interface EnumExpectedPage {
  entries: EnumExpectedEntry[];
  nextCursor: NonNullable<EnumCursor> | null;
  exhausted: boolean;
  examined: number;
}

/** A CHOSEN item id. Every one sorts before any random id that does not begin with eight zeros. */
const enumId = (slot: number): string => `00000000-0000-4000-8000-${slot.toString(16).padStart(12, "0")}`;
/** A CHOSEN id above a random one (asserted where it is used). */
const ENUM_HIGH_ID = "ffffffff-ffff-4fff-bfff-fffffffffff0";

const enumLocated = (teamId: string, itemId: string, locator: Record<string, unknown>): EnumExpectedEntry =>
  ({ teamId, itemId, revisitAfterMs: REVISIT_AFTER_MS, locator });
const enumUnlocated = (teamId: string, itemId: string, unlocated: string): EnumExpectedEntry =>
  ({ teamId, itemId, revisitAfterMs: REVISIT_AFTER_MS, unlocated });
/**
 * A cursor WRITTEN FROM THE CONTRACT: version, team, the frozen upper bound, the last examined id and
 * the echoed policy. It is what a page is compared with, and it can be handed to a page read in
 * place of a cursor a read returned.
 */
const enumCursor = (teamId: string, upperItemId: string, afterItemId: string): NonNullable<EnumCursor> =>
  ({ version: 1, teamId, upperItemId, afterItemId, revisitAfterMs: REVISIT_AFTER_MS });

/** The pages a fixed, ordered population must be read as, WRITTEN FROM THE CONTRACT of §4.2 and §4.3. */
function enumExpectedPages(teamId: string, ordered: readonly EnumExpectedEntry[], pageSize: number, upperItemId: string): EnumExpectedPage[] {
  const pages: EnumExpectedPage[] = [];
  for (let start = 0; start < ordered.length; start += pageSize) {
    const entries = ordered.slice(start, start + pageSize);
    const last = start + pageSize >= ordered.length;
    pages.push({
      entries,
      nextCursor: last ? null : enumCursor(teamId, upperItemId, entries[entries.length - 1].itemId),
      exhausted: last,
      examined: entries.length,
    });
  }
  return pages;
}

/** ONE page read, on a transaction of its own, with its execution context created BEFORE that transaction. */
function enumPage(teamId: string, pageSize: number, cursor?: EnumCursor): Promise<SlackKnownRootItemPage> {
  const execution = createSlackKnownRootExecution({ ambientDeadlineAt: null });
  const request = { teamId, pageSize, revisitAfterMs: REVISIT_AFTER_MS, ...(cursor ? { cursor } : {}) };
  return tx((s) => readSlackKnownRootItemPage(s, request, execution));
}

/** A complete traversal: the first page, then every cursor it is handed, one transaction per page. */
async function enumTraverse(teamId: string, pageSize: number, mostPages: number): Promise<SlackKnownRootItemPage[]> {
  const pages: SlackKnownRootItemPage[] = [];
  for (let cursor: EnumCursor | undefined; cursor !== null; ) {
    if (pages.length >= mostPages) throw new Error(`fixture: the traversal at page size ${pageSize} did not end within ${mostPages} pages`);
    const page = await enumPage(teamId, pageSize, cursor ?? undefined);
    pages.push(page);
    cursor = page.nextCursor;
  }
  return pages;
}

/**
 * How one page read ENDED, as one closed value: the page, or the fact that it was rejected. A read
 * that throws is thereby judged by the same labeled assertion as a read that returns the wrong page.
 * Only the product's own static messages are kept; any other message is withheld.
 */
type EnumEnded = { page: SlackKnownRootItemPage } | { rejected: string };
const enumEnded = (read: Promise<SlackKnownRootItemPage>): Promise<EnumEnded> => read.then(
  (page): EnumEnded => ({ page }),
  (error: unknown): EnumEnded => {
    const cause = (error as { cause?: unknown } | null)?.cause;
    const message = [error, cause].map((thrown) => (thrown instanceof Error ? thrown.message : "")).find((text) => text.startsWith("slack known-root:"));
    return { rejected: `${error instanceof Error ? error.name : typeof error}: ${message ?? "(message withheld)"}` };
  }
);

/**
 * Every item id of the team in PostgreSQL's OWN UUID order, with no predicate of the product's. The
 * order is taken from the BASE uuid column, qualified by its table alias: a bare `order by id` beside
 * an output column `id::text as id` would name that text output, and sort as text.
 */
const enumItemIdsInUuidOrder = async (teamId: string): Promise<string[]> =>
  (await query<{ item_id: string }>(`select i.id::text as item_id from items i where i.team_id = $1 order by i.id`, [teamId])).map((row) => row.item_id);

/** The really published root as the fixture CHECKS enumeration against, and as synthetic roots are shaped from. */
interface EnumReal {
  f: Published;
  teamId: string;
  itemId: string;
  slackProjectId: string;
  /** The published item's stored frontmatter, as JSON text. */
  frontmatter: string;
  /** The exact locator of a root of the published root's own channel. */
  locatorOf: (rootTs: string) => Record<string, unknown>;
}
async function enumRealRoot(f: Published): Promise<EnumReal> {
  const teamId = f.seed.teamId;
  const [real] = await query<{ project_id: string; path: string; frontmatter: Record<string, unknown> }>(
    `select project_id::text as project_id, path, frontmatter from items where team_id = $1 and id = $2`, [teamId, f.itemId]
  );
  expect(real.path, "fixture: the published root is at its canonical scoped path").toBe(scopedSlackItemPath(WORKSPACE, CHANNEL, OLD_ROOT));
  const channel = await channelRow(teamId, WORKSPACE, CHANNEL);
  expect(channel?.binding_config_revision, "fixture: the channel row stores a configuration revision").toMatch(/^[0-9a-f]{64}$/);
  return {
    f, teamId, itemId: f.itemId.toLowerCase(), slackProjectId: real.project_id, frontmatter: JSON.stringify(real.frontmatter),
    locatorOf: (rootTs) => ({
      workspaceId: WORKSPACE, channelId: CHANNEL, rootTs, integrationId: f.integrationId,
      bindingConfigRevision: channel?.binding_config_revision, namespaceRevision: f.namespaceRevision,
    }),
  };
}

/** FIXTURE DML: one project of the team for plain fixture items. */
const enumFixtureProject = async (teamId: string, slug: string): Promise<string> =>
  (await query<{ id: string }>(`insert into projects (team_id, slug) values ($1, $2) returning id::text as id`, [teamId, slug]))[0].id;

/**
 * FIXTURE DML — SYNTHETIC CANONICAL ROOTS, with CHOSEN ids. Each is an item row with the published
 * item's own stored metadata and only the two root timestamps replaced (and a label added), in the
 * Slack project, of the published item's kind and access, at the path the REAL builder gives. Unless
 * `witnessed` is false, each also gets ONE live root witness bound to it in the published root's
 * exact workspace and channel, observed two hours ago. No queue row and no staging: a completed root.
 */
async function enumPlantCanonicalRoots(real: EnumReal, roots: readonly { id: string; ts: string }[], label: string, witnessed = true): Promise<void> {
  const raw = await rawSql();
  const ids = roots.map((root) => root.id);
  const stamps = roots.map((root) => root.ts);
  const items = await raw.query(
    `insert into items (id, team_id, project_id, path, kind, access, frontmatter, body, content_sha256, member_id, member_id_locked)
     select r.id, $1::uuid, $2::uuid, r.path, 'transcript'::item_kind, 'team'::access_tier,
            $3::jsonb || jsonb_build_object('ts', r.ts, 'thread_ts', r.ts, 'enumeration_fixture', $7::text),
            '', repeat('a', 64), null::uuid, false
       from unnest($4::uuid[], $5::text[], $6::text[]) as r(id, ts, path)`,
    [real.teamId, real.slackProjectId, real.frontmatter, ids, stamps, roots.map((root) => scopedSlackItemPath(WORKSPACE, CHANNEL, root.ts)), label]
  );
  expect(items.rowCount, `fixture (${label}): the synthetic canonical root items were inserted`).toBe(roots.length);
  if (!witnessed) return;
  const witnesses = await raw.query(
    `insert into slack_messages (team_id, item_id, workspace_id, channel_id, message_ts, root_ts, author_external_id,
                                 occurred_at, is_root, eligible, exclusion_reason, deleted_at, last_seen_generation, source_hash, observed_at)
     select $1::uuid, r.id, $2::text, $3::text, r.ts, r.ts, 'U1',
            to_timestamp(split_part(r.ts, '.', 1)::bigint) + rpad(split_part(r.ts, '.', 2), 6, '0')::int * interval '1 microsecond',
            true, true, null::text, null::timestamptz, 0, repeat('a', 64), clock_timestamp() - interval '2 hours'
       from unnest($4::uuid[], $5::text[]) as r(id, ts)`,
    [real.teamId, WORKSPACE, CHANNEL, ids, stamps]
  );
  expect(witnesses.rowCount, `fixture (${label}): one live root witness per synthetic root was inserted`).toBe(roots.length);
}

/** FIXTURE DML — PLAIN FIXTURE ITEMS: bare item rows with a CHOSEN id, path and frontmatter. */
async function enumPlantItems(teamId: string, projectId: string, rows: readonly { id: string; path: string; frontmatter: Record<string, unknown> }[]): Promise<void> {
  const inserted = await (await rawSql()).query(
    `insert into items (id, team_id, project_id, path, kind, access, frontmatter, body, content_sha256, member_id, member_id_locked)
     select r.id, $1::uuid, $2::uuid, r.path, 'deliverable'::item_kind, 'team'::access_tier, r.frontmatter::jsonb, '', repeat('a', 64), null::uuid, false
       from unnest($3::uuid[], $4::text[], $5::text[]) as r(id, path, frontmatter)`,
    [teamId, projectId, rows.map((row) => row.id), rows.map((row) => row.path), rows.map((row) => JSON.stringify(row.frontmatter))]
  );
  expect(inserted.rowCount, "fixture: the plain fixture items were inserted").toBe(rows.length);
}

/** FIXTURE DML: delete exactly these items of the team. */
async function enumDeleteItems(teamId: string, ids: readonly string[]): Promise<void> {
  const deleted = await (await rawSql()).query(`delete from items where team_id = $1 and id = any($2::uuid[])`, [teamId, ids]);
  expect(deleted.rowCount, "fixture: exactly the named items were deleted").toBe(ids.length);
}

/** The team's queue rows, by what they are for and the state they are in. */
const enumQueueOf = (teamId: string): Promise<Row[]> => query(
  `select workspace_id, channel_id, root_ts, status, attempts, ${lifecycleUtc("due_at")} as due_at_utc
     from slack_sync_threads where team_id = $1 order by root_ts`, [teamId]
);

/**
 * KR-02 — an exact traversal of a fixed population, at three page sizes
 * (`docs/design/slack-known-root-requeue-spec.md` §4.2, §4.3, §11 KR-02).
 *
 * THE POPULATION is one team's 750 items, fixed for the whole case:
 *
 *   - 601 canonical completed roots: ONE published by the real publication, and 600 SYNTHETIC
 *     CAPACITY-FIXTURE roots planted by labeled DML, each with its own live root witness;
 *   - 149 unrelated items: ONE written by ordinary ingest, and 148 LABELED CAPACITY-FIXTURE rows.
 *
 * The synthetic ids are chosen so that the two kinds INTERLEAVE in UUID order — four roots, then one
 * unrelated item, and so on — so no page of any size here is all of one kind until the tail, and an
 * unrelated item can only come back as an entry of its own or be wrongly searched past.
 *
 * Page sizes 37, 50 and 100: a remainder, an EXACT MULTIPLE (fifteen full pages, the last of which
 * must already say the range ended) and the maximum. Every page of every traversal is compared whole
 * with the page the contract requires: its exact entries in order, its examined count, whether the
 * range ended, and its exact cursor.
 *
 * NOT CLAIMED: capacity, plans or timing. The 100,000-item traversal in 1,007 pages is the KR-17
 * fixture's evidence and is not repeated or extended here. Every synthetic root is in the ONE
 * workspace and channel of the published root.
 */
describe("KR-02 exact enumeration traversal of a fixed population", () => {
  const SYNTHETIC_ROOTS = 600;
  const SYNTHETIC_UNRELATED = 148;
  /** The slot of the k-th synthetic root: every fifth slot is left for an unrelated item. */
  const rootSlot = (k: number): number => k + Math.floor((k - 1) / 4);
  const rootTs = (k: number): string => `${1718000000 + k}.000100`;
  /** WRITTEN OUT: for each page size, how many pages, and how many items the last one examines. */
  const TRAVERSALS: [pageSize: number, pages: number, examinedByTheLastPage: number][] = [[37, 21, 10], [50, 15, 50], [100, 8, 50]];

  it("returns each of 750 item ids exactly once in PostgreSQL UUID order, with exact entries, cursors and exhaustion, at page sizes 37, 50 and 100 (KR-02)", async () => {
    const label = "KR-02";
    const real = await enumRealRoot(await publishOldRoot());
    const teamId = real.teamId;
    const ordinaryId = (await seedUnrelatedItem(real.f.seed)).toLowerCase();
    const unrelatedProject = await enumFixtureProject(teamId, "kr02-unrelated");

    // SYNTHETIC CAPACITY FIXTURE: 600 canonical roots and 148 unrelated items, interleaved by id.
    const roots = Array.from({ length: SYNTHETIC_ROOTS }, (_unused, index) => ({ id: enumId(rootSlot(index + 1)), ts: rootTs(index + 1) }));
    const unrelated = Array.from({ length: SYNTHETIC_UNRELATED }, (_unused, index) => ({
      id: enumId(5 * (index + 1)), path: `kr02/unrelated-${String(index + 1).padStart(3, "0")}.md`,
      frontmatter: { source: "kr02-capacity-fixture", enumeration_fixture: "kr02-capacity" },
    }));
    expect(new Set([...roots, ...unrelated].map((row) => row.id)).size, `${label}: fixture: 748 distinct chosen ids`).toBe(748);
    expect(roots.map((root) => root.ts).includes(OLD_ROOT), `${label}: fixture: no synthetic root has the published root's timestamp`).toBe(false);
    await enumPlantCanonicalRoots(real, roots, "kr02-capacity");
    await enumPlantItems(teamId, unrelatedProject, unrelated);

    // THE EXPECTED ORDER, written from the fixture: the chosen ids ascending, then the two real ids.
    const synthetic = [
      ...roots.map((root) => enumLocated(teamId, root.id, real.locatorOf(root.ts))),
      ...unrelated.map((row) => enumUnlocated(teamId, row.id, "not_slack")),
    ].sort((a, b) => (a.itemId < b.itemId ? -1 : 1));
    const realItems = [
      enumLocated(teamId, real.itemId, real.locatorOf(OLD_ROOT)),
      enumUnlocated(teamId, ordinaryId, "not_slack"),
    ].sort((a, b) => (a.itemId < b.itemId ? -1 : 1));
    expect(realItems[0].itemId > enumId(rootSlot(SYNTHETIC_ROOTS)),
      `${label}: fixture: both real items' random ids sort after every chosen id (a random id sorts lower only if it begins with eight zero digits, which fewer than one in four billion do: run again)`).toBe(true);
    const ordered = [...synthetic, ...realItems];
    const orderedIds = ordered.map((entry) => entry.itemId);
    const upperItemId = orderedIds[orderedIds.length - 1];

    // FIXTURE READBACKS. PostgreSQL's own UUID order is the order written out above.
    expect(await enumItemIdsInUuidOrder(teamId), `${label}: fixture: the population is exactly these 750 ids, in PostgreSQL's UUID order`).toEqual(orderedIds);
    expect(ordered.slice(0, 10).map((entry) => ("locator" in entry ? "root" : "unrelated")), `${label}: fixture: roots and unrelated items interleave in id order`)
      .toEqual(["root", "root", "root", "root", "unrelated", "root", "root", "root", "root", "unrelated"]);
    expect(await query(
      `select count(*)::int as items,
              count(*) filter (where project_id = $2::uuid and kind = 'transcript' and access = 'team' and frontmatter->>'source' = 'slack'
                                 and frontmatter->>'workspace_id' = $3 and frontmatter->>'channel_id' = $4
                                 and frontmatter->>'ts' = frontmatter->>'thread_ts')::int as canonical_shaped_roots,
              count(*) filter (where frontmatter->>'source' is distinct from 'slack')::int as unrelated_items,
              count(*) filter (where frontmatter->>'enumeration_fixture' = 'kr02-capacity')::int as labeled_capacity_fixtures
         from items where team_id = $1`, [teamId, real.slackProjectId, WORKSPACE, CHANNEL]
    ), `${label}: fixture: item cardinalities`).toEqual([{ items: 750, canonical_shaped_roots: 601, unrelated_items: 149, labeled_capacity_fixtures: 748 }]);
    expect(await query(
      `select count(*)::int as roots_with_their_own_live_witness
         from items i
         join slack_messages w on w.team_id = i.team_id and w.item_id = i.id and w.is_root and w.deleted_at is null
                              and w.workspace_id = $2 and w.channel_id = $3
                              and w.message_ts = i.frontmatter->>'ts' and w.root_ts = i.frontmatter->>'ts'
        where i.team_id = $1`, [teamId, WORKSPACE, CHANNEL]
    ), `${label}: fixture: every root item has its own live root witness in the exact scope`).toEqual([{ roots_with_their_own_live_witness: 601 }]);
    expect(await lifecycleQueueAndStagingAnywhere(), `${label}: fixture: completed roots: no pending work and no staging`).toEqual({ queue: [], staging: [] });

    const before = await lifecycleSnapshot(teamId);
    for (const [pageSize, pageCount, examinedByTheLastPage] of TRAVERSALS) {
      const pages = await enumTraverse(teamId, pageSize, 40);
      const expected = enumExpectedPages(teamId, ordered, pageSize, upperItemId);
      expect([expected.length, expected[expected.length - 1].examined], `${label}: fixture: the written-out page count and last page at page size ${pageSize}`).toEqual([pageCount, examinedByTheLastPage]);

      // The ids first, page by page: the smallest statement of what was examined, and in what order.
      expect(pages.map((page) => page.entries.map((entry) => entry.itemId)), `${label}: page size ${pageSize}: exactly these item ids, on exactly these pages, in this order`)
        .toEqual(expected.map((page) => page.entries.map((entry) => entry.itemId)));
      // The bookkeeping of every page: examined count, exhaustion and the exact cursor.
      expect(pages.map((page) => ({ examined: page.examined, exhausted: page.exhausted, nextCursor: page.nextCursor })), `${label}: page size ${pageSize}: every page's examined count, exhaustion and exact cursor`)
        .toEqual(expected.map((page) => ({ examined: page.examined, exhausted: page.exhausted, nextCursor: page.nextCursor })));
      // EVERY PAGE, WHOLE: each entry with its exact locator or its closed category.
      expect(pages, `${label}: page size ${pageSize}: every page, whole`).toEqual(expected);

      // Stated on their own as well.
      const seen = pages.flatMap((page) => page.entries.map((entry) => entry.itemId));
      expect([seen.length, new Set(seen).size, orderedIds.filter((id) => !seen.includes(id))], `${label}: page size ${pageSize}: 750 entries, no id twice, no id omitted`).toEqual([750, 750, []]);
      expect(pages.filter((page) => page.examined > pageSize || page.entries.length !== page.examined).length, `${label}: page size ${pageSize}: no page examines more than the page size, and each returns one entry per examined id`).toBe(0);
      const entries = pages.flatMap((page) => page.entries);
      expect({
        located: entries.filter((entry) => "locator" in entry).length,
        not_slack: entries.filter((entry) => "unlocated" in entry && entry.unlocated === "not_slack").length,
        anything_else: entries.filter((entry) => "unlocated" in entry && entry.unlocated !== "not_slack").length,
      }, `${label}: page size ${pageSize}: 601 located roots, and 149 unrelated items returned as entries of their own`).toEqual({ located: 601, not_slack: 149, anything_else: 0 });
    }

    // Enumeration only reads.
    expect(await lifecycleSnapshot(teamId), `${label}: three traversals changed no row of any snapshotted surface`).toEqual(before);
    expect(await lifecycleQueueAndStagingAnywhere(), `${label}: no pending work and no staging was created`).toEqual({ queue: [], staging: [] });
  });
});

/**
 * KR-04 — the same bytes in another scope are another thing
 * (`docs/design/slack-known-root-requeue-spec.md` §4.1, §5.1 to §5.5, §11 KR-04).
 *
 * TWO TEAMS, each with a root published by the real publication under the SAME workspace id, the
 * SAME channel id and the SAME root timestamp, byte for byte. In the target team there are also,
 * planted by labeled fixture DML with the published item's own stored metadata:
 *
 *   - five SCOPE DECOYS carrying the same root timestamp bytes in another scope of the same team:
 *     the workspace id in lower case; the channel id in lower case; both in mixed case; another
 *     workspace with the same channel; the same workspace with another channel. Each has its OWN
 *     live root witness in its own scope;
 *   - two SPELLING DECOYS in the target's own workspace and channel — so both are LOCATED, and no
 *     missing binding stands in front of what they show — canonical in every stored fact, whose root
 *     timestamps are the two OTHER valid spellings of the SAME INSTANT. The first
 *     (`1718900000.0001`) has no ledger row bound to it. The second (`1718900000.00010`) has its OWN
 *     live, overdue root witness, bound to its own item in the exact scope, stored under the FIRST
 *     decoy's spelling and not under its own;
 *   - two PATH-NOISE items whose PATHS are lower-case, Slack-looking scoped paths, and whose
 *     frontmatter is not a Slack root's.
 *
 * WHAT WOULD BE BORROWING. The published root's channel row and namespace gate exist once, for the
 * exact provider bytes. A scope decoy located through them borrowed an authority fact by folding
 * case or by ignoring half of the scope. A path-noise item located at all had its path segments
 * turned into provider ids. And every decoy witness — like the other team's — is OVERDUE while the
 * target's own is fresh, so a preparation of the target that enqueues used a row of another scope.
 * A spelling decoy that is anything but `missing_root_witness` matched a witness by its instant, or
 * by its bytes without its item, and not by the exact bytes of its own root bound to its own item.
 *
 * PRECEDENCE, PINNED DELIBERATELY. Both spelling decoys are also ledger contradictions: the second
 * decoy's own row binds its item under another root's bytes, and that same row binds the first
 * decoy's thread to another item. Each is `missing_root_witness` only because the current source
 * checks the root witness BEFORE the contradictions. These expectations deliberately pin that
 * current witness-before-contradiction precedence. A reorder that still conforms to the
 * specification would answer `contradictory_ledger` for both, and would require this evidence to
 * be revisited: it would not by itself be a defect.
 *
 * THE PREPARATION CASE ADDS TWO THINGS, both before the target is first prepared. The real enqueue
 * dependency writes a queue row of the SAME root bytes in four other scopes of the target team —
 * workspace in lower case, channel in lower case, another workspace, another channel — so a target
 * that is `already_pending`, or that is not enqueued when its own observation is overdue, read a
 * queue row of another scope; those four rows must stay byte-identical throughout. And two
 * FABRICATED entries are prepared: the published root's own enumerated entry with only its workspace
 * id, or only its channel id, changed to lower case. Each names a scope that HAS a queue row, and
 * must be refused at the namespace gate, for a different reason each. For the lower-case workspace
 * the channel's gate row EXISTS, but its resolved workspace ids do not include those byte-distinct
 * workspace bytes. For the lower-case channel there is no gate row matching those channel bytes.
 *
 * LIMITS. The two teams' integration ids differ and are asserted to; their configuration revisions
 * and namespace revisions are whatever the product gave each team and may be equal, so those two
 * fields are checked for the target's own values only. The fixture has no second independently
 * bound provider workspace or channel: no scope decoy has a channel row of its own. The one
 * namespace gate is keyed by team and channel, so the scope decoys that share the published
 * channel's bytes do meet that gate row; each is unlocated for want of its channel row, which is
 * judged first. So `missing_namespace_pin` is not exercised here. Case-only stored ids on the
 * published item itself are M1b and M1c, above, and are not repeated.
 */
describe("KR-04 scope isolation of enumeration and preparation", () => {
  /** Another valid spelling of the published root's instant: four fractional digits instead of six. */
  const OTHER_SPELLING = "1718900000.0001";
  const SCOPE_DECOYS = [
    { slot: 1, what: "workspace in lower case", workspaceId: "t0source1", channelId: CHANNEL, path: "kr04/workspace-lower-case.md" },
    { slot: 2, what: "channel in lower case", workspaceId: WORKSPACE, channelId: "c0known1170", path: "kr04/channel-lower-case.md" },
    { slot: 3, what: "both in mixed case", workspaceId: "T0SoUrCe1", channelId: "C0kNoWn1170", path: "kr04/both-mixed-case.md" },
    { slot: 4, what: "another workspace, same channel", workspaceId: "T0OTHER01", channelId: CHANNEL, path: "slack/t0other01/c0known1170/1718900000.000100.md" },
    { slot: 5, what: "same workspace, another channel", workspaceId: WORKSPACE, channelId: "C0OTHER1170", path: "slack/t0source1/c0other1170/1718900000.000100.md" },
  ];
  const SPELLING_SLOT = 6;
  const PATH_NOISE = [
    // The scoped path of ANOTHER root of the published root's own channel, lower-cased as the builder writes it.
    { slot: 7, path: "slack/t0source1/c0known1170/1718900000.000200.md", frontmatter: { source: "github" }, category: "not_slack" },
    // A lower-case scoped path of the published root's own timestamp in a scope that does not exist.
    { slot: 8, path: "slack/t0other01/c0other1170/1718900000.000100.md", frontmatter: { source: "slack" }, category: "invalid_metadata" },
  ];
  /** The third valid spelling of that instant: five fractional digits. */
  const SECOND_SPELLING = "1718900000.00010";
  const SECOND_SPELLING_SLOT = 9;
  const overdueUnderTheRevisitPolicy = `(w.observed_at + interval '60 seconds') <= clock_timestamp()`;

  interface Scopes {
    target: EnumReal;
    other: EnumReal;
    /** The target team's page, as the contract requires it. */
    expectedTargetEntries: EnumExpectedEntry[];
  }

  /** FIXTURE AGING of one published root's exact root witness row, by two hours. Returns its exact due instant under the 60-second policy. */
  async function ageOwnWitness(real: EnumReal, label: string): Promise<string> {
    const aged = await (await rawSql()).query<{ exact_due_utc: string }>(
      `update slack_messages w set observed_at = w.observed_at - interval '2 hours'
        where ${LIFECYCLE_ROOT_WITNESS}
    returning ${lifecycleUtc("w.observed_at + interval '60 seconds'")} as exact_due_utc`, lifecycleWitnessOf(real.f)
    );
    expect(aged.rowCount, `${label}: fixture aging: exactly one ledger row, that team's own root witness, was changed`).toBe(1);
    return aged.rows[0].exact_due_utc;
  }

  async function scopes(label: string): Promise<Scopes> {
    const target = await enumRealRoot(await publishOldRoot());
    const other = await enumRealRoot(await publishOldRoot());
    expect([other.teamId === target.teamId, other.f.integrationId === target.f.integrationId], `${label}: fixture: another team, with an integration of its own`).toEqual([false, false]);
    // THE OTHER TEAM's root is overdue from here on; the target's own witness stays fresh.
    await ageOwnWitness(other, `${label}: the other team`);

    const raw = await rawSql();
    const project = await enumFixtureProject(target.teamId, "kr04-scopes");
    // SCOPE DECOYS: the published item's own stored metadata with only the two provider ids replaced.
    const decoys = await raw.query(
      `insert into items (id, team_id, project_id, path, kind, access, frontmatter, body, content_sha256, member_id, member_id_locked)
       select r.id, $1::uuid, $2::uuid, r.path, 'transcript'::item_kind, 'team'::access_tier,
              $3::jsonb || jsonb_build_object('workspace_id', r.workspace_id, 'channel_id', r.channel_id, 'enumeration_fixture', 'kr04-scope-decoy'),
              '', repeat('a', 64), null::uuid, false
         from unnest($4::uuid[], $5::text[], $6::text[], $7::text[]) as r(id, path, workspace_id, channel_id)`,
      [target.teamId, project, target.frontmatter, SCOPE_DECOYS.map((decoy) => enumId(decoy.slot)), SCOPE_DECOYS.map((decoy) => decoy.path),
        SCOPE_DECOYS.map((decoy) => decoy.workspaceId), SCOPE_DECOYS.map((decoy) => decoy.channelId)]
    );
    expect(decoys.rowCount, `${label}: fixture: the scope decoy items were inserted`).toBe(SCOPE_DECOYS.length);
    // Each decoy's OWN live root witness, of the same root timestamp bytes, in its own scope, overdue.
    const witnesses = await raw.query(
      `insert into slack_messages (team_id, item_id, workspace_id, channel_id, message_ts, root_ts, author_external_id,
                                   occurred_at, is_root, eligible, exclusion_reason, deleted_at, last_seen_generation, source_hash, observed_at)
       select $1::uuid, r.id, r.workspace_id, r.channel_id, $2::text, $2::text, 'U1',
              to_timestamp(split_part($2::text, '.', 1)::bigint) + rpad(split_part($2::text, '.', 2), 6, '0')::int * interval '1 microsecond',
              true, true, null::text, null::timestamptz, 0, repeat('a', 64), clock_timestamp() - interval '2 hours'
         from unnest($3::uuid[], $4::text[], $5::text[]) as r(id, workspace_id, channel_id)`,
      [target.teamId, OLD_ROOT, SCOPE_DECOYS.map((decoy) => enumId(decoy.slot)), SCOPE_DECOYS.map((decoy) => decoy.workspaceId), SCOPE_DECOYS.map((decoy) => decoy.channelId)]
    );
    expect(witnesses.rowCount, `${label}: fixture: one live root witness per scope decoy was inserted`).toBe(SCOPE_DECOYS.length);
    // THE FIRST SPELLING DECOY: canonical in every stored fact, in the target's own scope, with NO ledger row bound to it.
    await enumPlantCanonicalRoots(target, [{ id: enumId(SPELLING_SLOT), ts: OTHER_SPELLING }], "kr04-spelling-decoy", false);
    await enumPlantItems(target.teamId, project, PATH_NOISE.map((noise) => ({ id: enumId(noise.slot), path: noise.path, frontmatter: noise.frontmatter })));
    // THE SECOND SPELLING DECOY: canonical in every stored fact under ITS OWN spelling, with its OWN
    // live, overdue root witness — bound to its own item, in the exact scope — stored under the
    // OTHER spelling of the same instant.
    await enumPlantCanonicalRoots(target, [{ id: enumId(SECOND_SPELLING_SLOT), ts: SECOND_SPELLING }], "kr04-second-spelling-decoy", false);
    const underTheOtherSpelling = await raw.query(
      `insert into slack_messages (team_id, item_id, workspace_id, channel_id, message_ts, root_ts, author_external_id,
                                   occurred_at, is_root, eligible, exclusion_reason, deleted_at, last_seen_generation, source_hash, observed_at)
       select $1::uuid, $2::uuid, $3::text, $4::text, $5::text, $5::text, 'U1',
              to_timestamp(split_part($5::text, '.', 1)::bigint) + rpad(split_part($5::text, '.', 2), 6, '0')::int * interval '1 microsecond',
              true, true, null::text, null::timestamptz, 0, repeat('a', 64), clock_timestamp() - interval '2 hours'`,
      [target.teamId, enumId(SECOND_SPELLING_SLOT), WORKSPACE, CHANNEL, OTHER_SPELLING]
    );
    expect(underTheOtherSpelling.rowCount, `${label}: fixture: the second spelling decoy's own witness was inserted under the other spelling`).toBe(1);

    // FIXTURE READBACKS.
    expect([new Set([OLD_ROOT, OTHER_SPELLING, SECOND_SPELLING]).size, parseSlackTimestamp(OLD_ROOT)?.iso, parseSlackTimestamp(OTHER_SPELLING)?.iso, parseSlackTimestamp(SECOND_SPELLING)?.iso],
      `${label}: fixture: three byte-distinct valid spellings of one instant`)
      .toEqual([3, "2024-06-20T16:13:20.000100Z", "2024-06-20T16:13:20.000100Z", "2024-06-20T16:13:20.000100Z"]);
    expect(SCOPE_DECOYS.slice(0, 3).map((decoy) => [decoy.workspaceId.toUpperCase() === WORKSPACE.toUpperCase(), decoy.channelId.toUpperCase() === CHANNEL.toUpperCase(),
      decoy.workspaceId === WORKSPACE && decoy.channelId === CHANNEL]), `${label}: fixture: the three case decoys differ from the published scope by case, and only by case`)
      .toEqual([[true, true, false], [true, true, false], [true, true, false]]);
    // Every live root witness of these timestamp bytes, in both teams: seven scopes, one of them fresh.
    const witnessed = await query<{ team: string; workspace_id: string; channel_id: string; overdue: boolean }>(
      `select case when w.team_id = $1::uuid then 'target' else 'other' end as team, w.workspace_id, w.channel_id, ${overdueUnderTheRevisitPolicy} as overdue
         from slack_messages w
        where w.team_id = any($2::uuid[]) and w.is_root and w.deleted_at is null and w.message_ts = $3 and w.root_ts = $3`,
      [target.teamId, [target.teamId, other.teamId], OLD_ROOT]
    );
    expect(witnessed.map((row) => `${row.team} ${row.workspace_id} ${row.channel_id} ${row.overdue ? "OVERDUE" : "fresh"}`).sort(),
      `${label}: fixture: the same root timestamp bytes are witnessed in seven scopes, and only the target's own witness is fresh`).toEqual([
      `other ${WORKSPACE} ${CHANNEL} OVERDUE`,
      `target ${WORKSPACE} ${CHANNEL} fresh`,
      ...SCOPE_DECOYS.map((decoy) => `target ${decoy.workspaceId} ${decoy.channelId} OVERDUE`),
    ].sort());
    // Every live root witness in the published root's EXACT workspace and channel: the published
    // root's own, fresh, under its own bytes; and the second spelling decoy's own, overdue, under the
    // first decoy's spelling. No ledger row is bound to the first decoy, and none carries the second
    // decoy's own spelling.
    const inTheExactScope = await query<{ message_ts: string; root_ts: string; item_id: string; overdue: boolean }>(
      `select w.message_ts, w.root_ts, w.item_id::text as item_id, ${overdueUnderTheRevisitPolicy} as overdue
         from slack_messages w
        where w.team_id = $1 and w.workspace_id = $2 and w.channel_id = $3 and w.is_root and w.deleted_at is null`, [target.teamId, WORKSPACE, CHANNEL]
    );
    expect(inTheExactScope.map((row) => `${row.message_ts} ${row.root_ts} item ${row.item_id} ${row.overdue ? "OVERDUE" : "fresh"}`).sort(),
      `${label}: fixture: two live root witnesses in the exact scope, each bound to its own item under the bytes written here`).toEqual([
      `${OLD_ROOT} ${OLD_ROOT} item ${target.itemId} fresh`,
      `${OTHER_SPELLING} ${OTHER_SPELLING} item ${enumId(SECOND_SPELLING_SLOT)} OVERDUE`,
    ].sort());
    expect(await query(
      `select (select count(*)::int from slack_messages where team_id = $1 and item_id = $2::uuid) as rows_bound_to_the_first_spelling_decoy,
              (select count(*)::int from slack_messages where team_id = $1 and (message_ts = $3 or root_ts = $3)) as rows_under_the_second_decoys_own_spelling`,
      [target.teamId, enumId(SPELLING_SLOT), SECOND_SPELLING]
    ), `${label}: fixture: no ledger row is bound to the first spelling decoy, and none carries the second decoy's own spelling`)
      .toEqual([{ rows_bound_to_the_first_spelling_decoy: 0, rows_under_the_second_decoys_own_spelling: 0 }]);
    // The authority rows the published root is located through exist ONCE in the target team, for the exact bytes.
    expect(await query(`select workspace_id, channel_id from slack_sync_channels where team_id = $1`, [target.teamId]),
      `${label}: fixture: the target team has one channel row, for the exact provider bytes`).toEqual([{ workspace_id: WORKSPACE, channel_id: CHANNEL }]);
    expect(await query(`select raw_channel_id from slack_channel_migration_gates where team_id = $1`, [target.teamId]),
      `${label}: fixture: the target team has one namespace gate, for the exact channel bytes`).toEqual([{ raw_channel_id: CHANNEL }]);
    expect(target.itemId > enumId(SECOND_SPELLING_SLOT), `${label}: fixture: the published item's random id sorts after every chosen id (a random id sorts lower only if it begins with eight zero digits, which fewer than one in four billion do: run again)`).toBe(true);

    const expectedTargetEntries = [
      ...SCOPE_DECOYS.map((decoy) => enumUnlocated(target.teamId, enumId(decoy.slot), "missing_channel_binding")),
      enumLocated(target.teamId, enumId(SPELLING_SLOT), target.locatorOf(OTHER_SPELLING)),
      ...PATH_NOISE.map((noise) => enumUnlocated(target.teamId, enumId(noise.slot), noise.category)),
      enumLocated(target.teamId, enumId(SECOND_SPELLING_SLOT), target.locatorOf(SECOND_SPELLING)),
      enumLocated(target.teamId, target.itemId, target.locatorOf(OLD_ROOT)),
    ];
    expect(await enumItemIdsInUuidOrder(target.teamId), `${label}: fixture: the target team's ten items, in PostgreSQL's UUID order`).toEqual(expectedTargetEntries.map((entry) => entry.itemId));
    expect(await lifecycleQueueAndStagingAnywhere(), `${label}: fixture: no pending work and no staging in either team`).toEqual({ queue: [], staging: [] });
    return { target, other, expectedTargetEntries };
  }

  /** Every queue row in the DATABASE, of any team, by its exact scope. */
  const queueRowsAnywhere = async (): Promise<string[]> => (await query(
    `select team_id::text as team_id, workspace_id, channel_id, root_ts, status, attempts from slack_sync_threads`
  )).map((row) => `${row.team_id} ${row.workspace_id} ${row.channel_id} ${row.root_ts} ${row.status} ${row.attempts}`).sort();

  /** Every queue row of the team OUTSIDE the published root's exact workspace and channel: every column, as the database renders the whole row. */
  const queueOutsideTheExactScope = async (teamId: string): Promise<string[]> => (await query(
    `select to_jsonb(t)::text as stored from slack_sync_threads t where t.team_id = $1 and not (t.workspace_id = $2 and t.channel_id = $3)`, [teamId, WORKSPACE, CHANNEL]
  )).map((row) => row.stored as string).sort();
  /** Every queue row of the team IN the published root's exact workspace and channel, whole. */
  const queueInTheExactScopeExactly = async (teamId: string): Promise<string[]> => (await query(
    `select to_jsonb(t)::text as stored from slack_sync_threads t where t.team_id = $1 and t.workspace_id = $2 and t.channel_id = $3`, [teamId, WORKSPACE, CHANNEL]
  )).map((row) => row.stored as string).sort();
  /** The same rows against an exact due instant: scope, state, and the due rounded UP to its millisecond. */
  const queueInTheExactScopeAgainst = (teamId: string, exactDue: string): Promise<Row[]> => query(
    `select t.workspace_id, t.channel_id, t.root_ts, t.status, t.attempts,
            t.due_at >= $4::timestamptz as not_before_the_exact_due,
            t.due_at < $4::timestamptz + interval '1 millisecond' as less_than_a_millisecond_after_it,
            to_char(t.due_at at time zone 'UTC', 'US') like '%000' as on_a_whole_millisecond
       from slack_sync_threads t where t.team_id = $1 and t.workspace_id = $2 and t.channel_id = $3`, [teamId, WORKSPACE, CHANNEL, exactDue]
  );

  /** Preparation on a transaction of its own, from the team and the enumerated entry ALONE. */
  function prepared(teamId: string, entry: SlackKnownRootEntry): Promise<SlackKnownRootPreparationResult> {
    const execution = createSlackKnownRootExecution({ ambientDeadlineAt: null });
    return tx((s) => prepareSlackKnownRootRequeue(s, { teamId, entry }, execution));
  }

  it("locates each item by its own exact stored bytes: a decoy scope borrows no channel row or gate, a path is never read as provider ids, and each team sees only its own authority (KR-04)", async () => {
    const label = "KR-04 enumeration";
    const { target, other, expectedTargetEntries } = await scopes(label);
    const before = { target: await lifecycleSnapshot(target.teamId), other: await lifecycleSnapshot(other.teamId) };

    const targetPage = await enumPage(target.teamId, 100);
    const otherPage = await enumPage(other.teamId, 100);

    // The five scope decoys, one by one: each is unlocated for want of ITS OWN channel row.
    for (const [index, decoy] of SCOPE_DECOYS.entries()) {
      expect(targetPage.entries[index], `${label}: ${decoy.what}: unlocated, with no channel row or gate of the published scope borrowed`)
        .toEqual(enumUnlocated(target.teamId, enumId(decoy.slot), "missing_channel_binding"));
    }
    // The other spelling, in the published root's own scope, is located by ITS OWN bytes.
    expect(targetPage.entries[SCOPE_DECOYS.length], `${label}: the other spelling of the instant is located with its own timestamp bytes, not the published root's`)
      .toEqual(enumLocated(target.teamId, enumId(SPELLING_SLOT), target.locatorOf(OTHER_SPELLING)));
    // Lower-case, Slack-looking path segments are path noise.
    for (const [index, noise] of PATH_NOISE.entries()) {
      expect(targetPage.entries[SCOPE_DECOYS.length + 1 + index], `${label}: an item at ${noise.path} is ${noise.category}: no provider id was taken from its path`)
        .toEqual(enumUnlocated(target.teamId, enumId(noise.slot), noise.category));
    }
    // The second spelling, likewise: its own bytes, not the spelling its own witness is stored under.
    expect(targetPage.entries[SCOPE_DECOYS.length + 1 + PATH_NOISE.length], `${label}: the second spelling of the instant is located with its own timestamp bytes, not those its witness is stored under`)
      .toEqual(enumLocated(target.teamId, enumId(SECOND_SPELLING_SLOT), target.locatorOf(SECOND_SPELLING)));
    // THE WHOLE PAGE of each team.
    expect(targetPage, `${label}: the target team's page, whole`).toEqual({ entries: expectedTargetEntries, nextCursor: null, exhausted: true, examined: 10 });
    expect(otherPage, `${label}: the other team's page is its own one root, with its own integration`).toEqual({
      entries: [enumLocated(other.teamId, other.itemId, other.locatorOf(OLD_ROOT))], nextCursor: null, exhausted: true, examined: 1,
    });
    // Stated on its own: the integration each team's root is located with is that team's.
    const integrationOf = (page: SlackKnownRootItemPage): unknown[] =>
      page.entries.flatMap((entry) => ("locator" in entry ? [entry.locator.integrationId] : []));
    expect([integrationOf(targetPage), integrationOf(otherPage)], `${label}: no locator carries the other team's integration`)
      .toEqual([[target.f.integrationId, target.f.integrationId, target.f.integrationId], [other.f.integrationId]]);

    expect({ target: await lifecycleSnapshot(target.teamId), other: await lifecycleSnapshot(other.teamId) }, `${label}: enumeration changed no row of any snapshotted surface of either team`).toEqual(before);
    expect(await lifecycleQueueAndStagingAnywhere(), `${label}: no pending work and no staging in either team`).toEqual({ queue: [], staging: [] });
  });

  it("prepares each entry from its own scope alone: an overdue witness or a queue row of the same bytes in another team, scope or spelling is never used (KR-04)", async () => {
    const label = "KR-04 preparation";
    const { target, other, expectedTargetEntries } = await scopes(label);
    const targetPage = await enumPage(target.teamId, 100);
    const otherPage = await enumPage(other.teamId, 100);
    expect([targetPage.entries, otherPage.entries.length], `${label}: fixture: both pages are the ones the enumeration case requires`).toEqual([expectedTargetEntries, 1]);
    const targetEntry = targetPage.entries[targetPage.entries.length - 1];
    if (!("locator" in targetEntry)) throw new Error("fixture: the published root's entry is not a located one");
    const spellingEntry = targetPage.entries[SCOPE_DECOYS.length];
    const secondSpellingEntry = targetPage.entries[SCOPE_DECOYS.length + 1 + PATH_NOISE.length];
    const otherEntry = otherPage.entries[0];
    /** Every entry of the target team's page but the published root's own, with the result each must have. */
    const decoyResults: [what: string, entry: SlackKnownRootEntry, expected: SlackKnownRootPreparationResult][] = [
      ...SCOPE_DECOYS.map((decoy, index): [string, SlackKnownRootEntry, SlackKnownRootPreparationResult] =>
        [decoy.what, targetPage.entries[index], { outcome: "unattested", reason: "missing_channel_binding" }]),
      ["the other spelling of the instant", spellingEntry, { outcome: "unattested", reason: "missing_root_witness" }],
      ["path noise, not Slack", targetPage.entries[SCOPE_DECOYS.length + 1], { outcome: "unattested", reason: "not_slack" }],
      ["path noise, Slack without ids", targetPage.entries[SCOPE_DECOYS.length + 2], { outcome: "unattested", reason: "invalid_metadata" }],
      ["the second spelling of the instant, whose own witness is stored under the other spelling", secondSpellingEntry, { outcome: "unattested", reason: "missing_root_witness" }],
    ];
    /**
     * FABRICATED entries: the published root's own enumerated entry — its item, its integration, its
     * configuration revision, its namespace revision — with ONE provider id changed to lower case.
     * No enumeration returned either. Each names a scope in which a queue row of these root bytes is
     * planted below.
     */
    const fabricated: [what: string, entry: SlackKnownRootEntry][] = [
      ["the published root's entry with its workspace id in lower case", { ...targetEntry, locator: { ...targetEntry.locator, workspaceId: SCOPE_DECOYS[0].workspaceId } }],
      ["the published root's entry with its channel id in lower case", { ...targetEntry, locator: { ...targetEntry.locator, channelId: SCOPE_DECOYS[1].channelId } }],
    ];
    const REFUSED_AT_THE_NAMESPACE_GATE: SlackKnownRootPreparationResult = { outcome: "refused", reason: "namespace_changed_or_unready" };

    // ── 0. QUEUE ROWS OF THE SAME ROOT BYTES IN FOUR OTHER SCOPES of the target team, each written
    //       by the real enqueue dependency before the target is prepared at all. ──
    const queuedElsewhere = [SCOPE_DECOYS[0], SCOPE_DECOYS[1], SCOPE_DECOYS[3], SCOPE_DECOYS[4]];
    for (const decoy of queuedElsewhere) {
      const written = await tx((s) => enqueueSlackThread(s, { teamId: target.teamId, workspaceId: decoy.workspaceId, channelId: decoy.channelId, rootTs: OLD_ROOT }));
      expect(written.inserted, `${label}: fixture: the real enqueue dependency inserted a queue row of the same root bytes for: ${decoy.what}`).toBe(true);
    }
    const elsewhereRows = queuedElsewhere.map((decoy) => `${target.teamId} ${decoy.workspaceId} ${decoy.channelId} ${OLD_ROOT} queued 0`);
    expect(await queueRowsAnywhere(), `${label}: fixture: four queue rows in the database, of the same root bytes, each in another scope of the target team`).toEqual([...elsewhereRows].sort());
    const elsewhereExactly = await queueOutsideTheExactScope(target.teamId);
    expect([elsewhereExactly.length, await queueInTheExactScopeExactly(target.teamId)], `${label}: fixture: four whole rows outside the published root's exact scope, and none inside it`).toEqual([4, []]);
    const before = { target: await lifecycleSnapshot(target.teamId), other: await lifecycleSnapshot(other.teamId) };

    // ── 1. THE TARGET'S OWN WITNESS IS FRESH. The same bytes are overdue in the other team and in
    //       five other scopes of this team, and QUEUED in four of those. ──
    expect(await prepared(target.teamId, targetEntry), `${label}: the published root is not_due on its own fresh observation: neither an overdue witness nor a queue row of the same root bytes in another scope is its own`).toEqual({ outcome: "not_due" });
    for (const [what, entry, expected] of decoyResults) {
      expect(await prepared(target.teamId, entry), `${label}: ${what}: unattested, on its own facts`).toEqual(expected);
    }
    for (const [what, entry] of fabricated) {
      expect(await prepared(target.teamId, entry), `${label}: fabricated: ${what}: refused at the namespace gate, whatever is queued in the scope it names`).toEqual(REFUSED_AT_THE_NAMESPACE_GATE);
    }
    expect(await queueRowsAnywhere(), `${label}: nothing was enqueued in any team or scope: the four rows of other scopes are the only queue rows`).toEqual([...elsewhereRows].sort());
    expect([await queueOutsideTheExactScope(target.teamId), await queueInTheExactScopeExactly(target.teamId)], `${label}: the four rows of other scopes are byte-identical, and there is no row in the published root's exact scope`)
      .toEqual([elsewhereExactly, []]);
    expect({ target: await lifecycleSnapshot(target.teamId), other: await lifecycleSnapshot(other.teamId) }, `${label}: none of those preparations changed a row of any snapshotted surface of either team`).toEqual(before);

    // ── 2. THE OTHER TEAM's root is overdue, and is enqueued for the other team only. ──
    expect(await prepared(other.teamId, otherEntry), `${label}: the other team's overdue root is enqueued`).toEqual({ outcome: "enqueued" });
    const otherRow = `${other.teamId} ${WORKSPACE} ${CHANNEL} ${OLD_ROOT} queued 0`;
    expect(await queueRowsAnywhere(), `${label}: exactly one queue row was added, the other team's, in its exact scope`).toEqual([...elsewhereRows, otherRow].sort());
    expect(await lifecycleSnapshot(target.teamId), `${label}: the other team's preparation changed no row of the target team`).toEqual(before.target);
    expect(lifecycleTablesThatDiffer(before.other, await lifecycleSnapshot(other.teamId)), `${label}: of the other team's surfaces only its queue changed`).toEqual(["slack_sync_threads"]);
    const otherQueueExactly = await lifecycleQueueRowsExactly(other.teamId);
    // The other team's pending row, of the same bytes, is not the target's pending work.
    expect(await prepared(target.teamId, targetEntry), `${label}: the published root is still not_due: the other team's queue row is not its pending work`).toEqual({ outcome: "not_due" });

    // ── 3. FIXTURE AGING of the target's own witness. Now, and only now, it is enqueued — although
    //       four rows of the same root bytes were pending in other scopes all along. ──
    const exactDue = await ageOwnWitness(target, `${label}: the target team`);
    expect(await prepared(target.teamId, targetEntry), `${label}: the published root is enqueued once its own observation is overdue`).toEqual({ outcome: "enqueued" });
    expect(await queueInTheExactScopeAgainst(target.teamId, exactDue), `${label}: exactly one queue row of the target team in the exact provider scope, at its own exact due instant`)
      .toEqual(LIFECYCLE_ONE_ROW_AT_THE_EXACT_DUE);
    expect(await queueRowsAnywhere(), `${label}: six queue rows in the database: the four of other scopes, the other team's, and the published root's own, each in its exact scope`)
      .toEqual([...elsewhereRows, otherRow, `${target.teamId} ${WORKSPACE} ${CHANNEL} ${OLD_ROOT} queued 0`].sort());
    expect(await queueOutsideTheExactScope(target.teamId), `${label}: the four queue rows of other scopes are byte-identical after the published root was enqueued`).toEqual(elsewhereExactly);
    expect(await lifecycleQueueRowsExactly(other.teamId), `${label}: the other team's queue row is byte-identical`).toEqual(otherQueueExactly);
    const targetQueueExactly = await queueInTheExactScopeExactly(target.teamId);
    expect(targetQueueExactly.length, `${label}: fixture: one whole row in the published root's exact scope`).toBe(1);

    // ── 4. WITH THE PUBLISHED ROOT PENDING, every decoy is still judged on its own facts: neither
    //       other spelling of the same instant has a witness of its own bytes bound to its own
    //       item, and neither is "already pending"; and a fabricated entry is still refused. ──
    for (const [what, entry, expected] of decoyResults) {
      expect(await prepared(target.teamId, entry), `${label}: ${what}: unchanged by the published root's pending row`).toEqual(expected);
    }
    for (const [what, entry] of fabricated) {
      expect(await prepared(target.teamId, entry), `${label}: fabricated: ${what}: still refused, and not already_pending, with the published root and the scope it names both pending`).toEqual(REFUSED_AT_THE_NAMESPACE_GATE);
    }
    expect(await prepared(target.teamId, targetEntry), `${label}: the published root itself is now already_pending`).toEqual({ outcome: "already_pending" });
    expect([await queueInTheExactScopeExactly(target.teamId), await queueOutsideTheExactScope(target.teamId), await lifecycleQueueRowsExactly(other.teamId)],
      `${label}: the published root's row, the four rows of other scopes and the other team's row are all byte-identical, and there is no seventh`)
      .toEqual([targetQueueExactly, elsewhereExactly, otherQueueExactly]);
    expect((await queueRowsAnywhere()).length, `${label}: six queue rows in the database`).toBe(6);
    expect((await lifecycleQueueAndStagingAnywhere()).staging, `${label}: nothing is staged`).toEqual([]);
  });
});

/**
 * KR-10 in part, and the falsifier of M7 — a page advances after its last EXAMINED id, whatever the
 * items on it turned out to be (`docs/design/slack-known-root-requeue-spec.md` §4.2, §11 KR-10, §12 M7).
 *
 * The target team has seventeen items. In UUID order, at page size five:
 *
 *   page 1   five items that are NOT Slack's at all, in five different stored shapes;
 *   page 2   four items that say they are Slack's and cannot be located, then one that is not Slack's;
 *   page 3   sparse: a root, an unrelated item, a root, a malformed Slack item, an unrelated item;
 *   page 4   a synthetic root and the really published root.
 *
 * So a traversal that advanced only past entries it took for Slack's would have nothing to advance
 * past on page 1; one that advanced past the last Slack-looking entry would stop one short on pages 2
 * and 3; and one that advanced past the last LOCATED entry would have nothing on pages 1 and 2 and
 * stop two short on page 3. Every plain item sits at a lower-case, Slack-looking path, which is noise.
 *
 * HOW THE PAGES ARE READ. At page size five nothing traverses: page 1 is read and judged whole first,
 * and pages 2, 3 and 4 are each asked for with the cursor the contract requires of the page before,
 * written out in the test. A read that does not advance, or advances short, therefore fails the
 * labeled assertion of the page it is wrong on — never a page cap of this file, and never the
 * product's own validation of a cursor it produced.
 *
 * NOT CLAIMED: `missing_namespace_pin` (no channel row without a gate is built here), the deleted
 * cursor (the KR-11 suite below), contention, or the classifier and reducer parts of KR-10.
 */
describe("KR-10 sparse and all-unlocated pages advance by examined id (M7)", () => {
  const synthTs = (slot: number): string => `${1718000000 + slot}.000100`;
  const noisePath = (slot: number): string => `slack/t0source1/c0known1170/${1719100000 + slot}.000100.md`;
  const ROOT_SLOTS = [11, 13, 16];
  /** Slot, stored frontmatter, and the ONE closed category it must come back with. */
  const PLAIN: [slot: number, frontmatter: Record<string, unknown>, category: string][] = [
    // PAGE 1: not Slack's at all.
    [1, {}, "not_slack"],
    [2, { source: "github" }, "not_slack"],
    [3, { source: "Slack" }, "not_slack"],
    [4, { source: ["slack"] }, "not_slack"],
    [5, { workspace_id: WORKSPACE, channel_id: CHANNEL, ts: OLD_ROOT, thread_ts: OLD_ROOT }, "not_slack"],
    // PAGE 2: Slack's by its source, and not locatable; then one that is not Slack's.
    [6, { source: "slack" }, "invalid_metadata"],
    [7, { source: "slack", workspace_id: WORKSPACE, channel_id: CHANNEL, ts: 1718900000.0001 }, "invalid_metadata"],
    [8, { source: "slack", workspace_id: "T0UNBOUND1", channel_id: CHANNEL, ts: OLD_ROOT }, "missing_channel_binding"],
    [9, { source: "slack", workspace_id: WORKSPACE, channel_id: "C0UNBOUND99", ts: OLD_ROOT }, "missing_channel_binding"],
    [10, { source: "notes" }, "not_slack"],
    // PAGE 3: between the roots.
    [12, { source: "github" }, "not_slack"],
    [14, { source: "slack", workspace_id: WORKSPACE, channel_id: CHANNEL }, "invalid_metadata"],
    [15, {}, "not_slack"],
  ];

  it("returns a whole page of non-Slack items, a whole page with nothing located and a sparse page as exact entries, and continues after each page's last examined id to the roots that follow (KR-10, M7)", async () => {
    const label = "M7";
    const real = await enumRealRoot(await publishOldRoot());
    const teamId = real.teamId;
    const project = await enumFixtureProject(teamId, "m7-noise");
    await enumPlantCanonicalRoots(real, ROOT_SLOTS.map((slot) => ({ id: enumId(slot), ts: synthTs(slot) })), "m7-root");
    await enumPlantItems(teamId, project, PLAIN.map(([slot, frontmatter]) => ({ id: enumId(slot), path: noisePath(slot), frontmatter })));
    expect(real.itemId > enumId(16), `${label}: fixture: the published item's random id sorts after every chosen id (a random id sorts lower only if it begins with eight zero digits, which fewer than one in four billion do: run again)`).toBe(true);

    const bySlot = new Map<number, EnumExpectedEntry>([
      ...PLAIN.map(([slot, , category]): [number, EnumExpectedEntry] => [slot, enumUnlocated(teamId, enumId(slot), category)]),
      ...ROOT_SLOTS.map((slot): [number, EnumExpectedEntry] => [slot, enumLocated(teamId, enumId(slot), real.locatorOf(synthTs(slot)))]),
    ]);
    const slots = (from: number, to: number): EnumExpectedEntry[] =>
      Array.from({ length: to - from + 1 }, (_unused, index) => bySlot.get(from + index) as EnumExpectedEntry);
    const publishedRoot = enumLocated(teamId, real.itemId, real.locatorOf(OLD_ROOT));
    const ordered = [...slots(1, 16), publishedRoot];
    expect(await enumItemIdsInUuidOrder(teamId), `${label}: fixture: the team's seventeen items, in PostgreSQL's UUID order`).toEqual(ordered.map((entry) => entry.itemId));
    expect(await query(`select count(*)::int as rows from items where team_id = $1 and path like 'slack/t0source1/c0known1170/%' and project_id = $2::uuid`, [teamId, project]),
      `${label}: fixture: thirteen plain items sit at lower-case, Slack-looking paths`).toEqual([{ rows: 13 }]);
    const before = await lifecycleSnapshot(teamId);

    // ── PAGE SIZE FIVE, ONE READ AT A TIME, every page written out. Page 1 is judged, whole, before
    //    anything is read after it. Each later page is then asked for with the cursor the CONTRACT
    //    requires of the page before it — written out here, never one a page read returned — so a
    //    read that advances wrongly, or not at all, fails the labeled assertion of the page it is
    //    wrong on, and no later read depends on it. Each read's END is one closed value. ──
    const upper = real.itemId;
    const categories = (ended: EnumEnded): unknown =>
      ("page" in ended ? ended.page.entries.map((entry) => ("unlocated" in entry ? entry.unlocated : "LOCATED")) : ended);

    const first = await enumEnded(enumPage(teamId, 5));
    expect(first, `${label}: page 1: five non-Slack items are five not_slack entries, and the cursor is after the fifth`).toEqual({
      page: { entries: slots(1, 5), nextCursor: enumCursor(teamId, upper, enumId(5)), exhausted: false, examined: 5 },
    });
    expect(categories(first), `${label}: page 1: every entry is not_slack`)
      .toEqual(["not_slack", "not_slack", "not_slack", "not_slack", "not_slack"]);

    const second = await enumEnded(enumPage(teamId, 5, enumCursor(teamId, upper, enumId(5))));
    expect(second, `${label}: page 2: nothing located, each entry with its closed category, and the cursor is after the non-Slack item that ends the page`).toEqual({
      page: { entries: slots(6, 10), nextCursor: enumCursor(teamId, upper, enumId(10)), exhausted: false, examined: 5 },
    });
    expect(categories(second), `${label}: page 2: the four closed categories, in order`)
      .toEqual(["invalid_metadata", "invalid_metadata", "missing_channel_binding", "missing_channel_binding", "not_slack"]);

    const third = await enumEnded(enumPage(teamId, 5, enumCursor(teamId, upper, enumId(10))));
    expect(third, `${label}: page 3: two roots among three unlocated items, and the cursor is after the unrelated item that ends the page`).toEqual({
      page: { entries: slots(11, 15), nextCursor: enumCursor(teamId, upper, enumId(15)), exhausted: false, examined: 5 },
    });

    const fourth = await enumEnded(enumPage(teamId, 5, enumCursor(teamId, upper, enumId(15))));
    expect(fourth, `${label}: page 4: the two roots that follow, and the range has ended`).toEqual({
      page: { entries: [...slots(16, 16), publishedRoot], nextCursor: null, exhausted: true, examined: 2 },
    });
    expect([first, second, third, fourth].map((ended) => ("page" in ended ? ended.page.exhausted : "REJECTED")), `${label}: four pages at page size five, and only the fourth says the range has ended`)
      .toEqual([false, false, false, true]);

    // ── BOUNDED OUTPUT at two more sizes: never more than the page size, never fewer than there are. ──
    for (const [pageSize, pageCount] of [[3, 6], [100, 1]]) {
      const traversal = await enumTraverse(teamId, pageSize, 8);
      expect(traversal, `${label}: page size ${pageSize}: every page, whole`).toEqual(enumExpectedPages(teamId, ordered, pageSize, real.itemId));
      expect([traversal.length, traversal.filter((page) => page.entries.length > pageSize || page.entries.length !== page.examined).length],
        `${label}: page size ${pageSize}: ${pageCount} page(s), none over the page size, one entry per examined id`).toEqual([pageCount, 0]);
    }

    expect(await lifecycleSnapshot(teamId), `${label}: the four reads and the two traversals changed no row of any snapshotted surface`).toEqual(before);
    expect(await lifecycleQueueAndStagingAnywhere(), `${label}: no pending work and no staging was created`).toEqual({ queue: [], staging: [] });
  });

  it("returns one empty, exhausted page with no cursor for a team that has no item, while another team has items (KR-10)", async () => {
    const label = "empty team";
    const populated = await seedTeam();
    const empty = await seedTeam();
    await enumPlantItems(populated.teamId, await enumFixtureProject(populated.teamId, "kr10-populated"), [
      { id: enumId(1), path: "kr10/one.md", frontmatter: {} }, { id: enumId(2), path: "kr10/two.md", frontmatter: { source: "github" } },
    ]);
    expect([await enumItemIdsInUuidOrder(empty.teamId), await enumItemIdsInUuidOrder(populated.teamId)], `${label}: fixture: one team has no item, the other has two`)
      .toEqual([[], [enumId(1), enumId(2)]]);
    const before = await lifecycleSnapshot(empty.teamId);

    for (const pageSize of [1, 100]) {
      expect(await enumEnded(enumPage(empty.teamId, pageSize)), `${label}: page size ${pageSize}: no entry, no cursor, exhausted, nothing examined`)
        .toEqual({ page: { entries: [], nextCursor: null, exhausted: true, examined: 0 } });
    }
    // The other team, as a control that the read works at all here.
    expect(await enumPage(populated.teamId, 100), `${label}: control: the populated team's two items`).toEqual({
      entries: [enumUnlocated(populated.teamId, enumId(1), "not_slack"), enumUnlocated(populated.teamId, enumId(2), "not_slack")],
      nextCursor: null, exhausted: true, examined: 2,
    });
    expect([await enumItemIdsInUuidOrder(empty.teamId), await lifecycleSnapshot(empty.teamId)], `${label}: no sentinel item was created, and no snapshotted row of the empty team changed`)
      .toEqual([[], before]);
  });
});

/**
 * KR-11 in part, and the falsifiers of M8a and M8b — continuation inside a frozen KEY RANGE whose
 * population changes (`docs/design/slack-known-root-requeue-spec.md` §4.2, §4.3, §9, §11 KR-11 and
 * KR-15, §12 M8a and M8b).
 *
 * TWELVE ORIGINAL ITEMS: eleven with chosen ids `…10` to `…b0` — five plain items and six synthetic
 * canonical roots, interleaved — and the really published root, whose random id is the greatest and
 * is therefore the UPPER BOUND the first page freezes. Page size four. Between pages, labeled fixture DML:
 *
 *   after page 1   deletes `…20` (an earlier item) and `…40` (THE CURSOR ITEM), and inserts `…15`
 *                  (below the consumed cursor), `…55` (strictly between the cursor and the bound) and
 *                  one item ABOVE the frozen bound;
 *   after page 2   inserts a NEW row at exactly `…40`, the id the first cursor is after, and `…65`
 *                  (below the second cursor, above the first).
 *
 * WHY EACH FALSIFIER FAILS HERE.
 *   M8b (OFFSET in place of the keyset): after the two deletions and one insertion below the cursor,
 *   the first four rows of the range are `…10 …15 …30 …50`, so a page that skips four rows starts at
 *   `…55` and OMITS the original `…50`. Page 2 below requires `…50` first.
 *   M8a (no upper bound on a continuation): the last page would be asked for everything after `…b0`
 *   and would meet the item above the frozen bound. The last page below requires the published root
 *   alone and the range ended. Each page's END is asserted as one closed value, so a read that is
 *   rejected because it met an id outside its range fails the same labeled assertion as one that
 *   returns that id.
 *
 * LOST-CURSOR REPLAY, as a characterization and nothing more: a continuation from an OLD cursor is a
 * deterministic read of what is in its range now, and can be repeated; a traversal that has LOST its
 * cursor starts again at the lowest id under a NEW frozen bound. Neither is durable sweep progress.
 * There is no persisted sweep state in this packet, and nothing here is evidence of FIFO order,
 * fairness, starvation bounds, traversal cost, failures awaiting later sweeps, or orphan and
 * re-creation risk; the 1,007-page traversal of 100,601 items is the KR-17 fixture's evidence.
 */
describe("KR-11 continuation inside a frozen key range (M8a, M8b)", () => {
  const ROOT_SLOTS = [0x20, 0x40, 0x50, 0x70, 0x90, 0xb0];
  const PLAIN_SLOTS = [0x10, 0x30, 0x60, 0x80, 0xa0];
  const tsOf = (slot: number): string => `${1718000000 + slot}.000100`;

  it("omits no remaining original id after the cursor item and an earlier item are deleted, admits an insert between the cursor and the bound, and never returns an insert at or below the cursor or above the bound (KR-11, M8a, M8b)", async () => {
    const label = "KR-11";
    const real = await enumRealRoot(await publishOldRoot());
    const teamId = real.teamId;
    const project = await enumFixtureProject(teamId, "kr11-continuation");
    await enumPlantCanonicalRoots(real, ROOT_SLOTS.map((slot) => ({ id: enumId(slot), ts: tsOf(slot) })), "kr11-root");
    await enumPlantItems(teamId, project, PLAIN_SLOTS.map((slot) => ({ id: enumId(slot), path: `kr11/original-${slot.toString(16)}.md`, frontmatter: { source: "kr11-fixture" } })));
    const bound = real.itemId;
    expect([enumId(0xb0) < bound, bound < ENUM_HIGH_ID], `${label}: fixture: the published item's random id is above every chosen id and below the id reserved for "above the bound" (run again on a miss)`).toEqual([true, true]);

    const root = (slot: number): EnumExpectedEntry => enumLocated(teamId, enumId(slot), real.locatorOf(tsOf(slot)));
    const plain = (itemId: string): EnumExpectedEntry => enumUnlocated(teamId, itemId, "not_slack");
    const publishedRoot = enumLocated(teamId, real.itemId, real.locatorOf(OLD_ROOT));
    const cursorAfter = (itemId: string, upperItemId = bound): NonNullable<EnumCursor> => enumCursor(teamId, upperItemId, itemId);
    /** The ids, the cursor and the exhaustion of one page read's end — or, if it was rejected, that. */
    const idsAndCursor = (ended: EnumEnded): unknown => ("page" in ended
      ? { ids: ended.page.entries.map((entry) => entry.itemId), nextCursor: ended.page.nextCursor, exhausted: ended.page.exhausted }
      : ended);
    const pageOf = (page: EnumEnded): SlackKnownRootItemPage => {
      if (!("page" in page)) throw new Error("fixture: the page read did not return a page");
      return page.page;
    };
    const originals = [0x10, 0x20, 0x30, 0x40, 0x50, 0x60, 0x70, 0x80, 0x90, 0xa0, 0xb0].map(enumId);
    expect(await enumItemIdsInUuidOrder(teamId), `${label}: fixture: twelve original items, in PostgreSQL's UUID order`).toEqual([...originals, bound]);

    // ── PAGE 1 freezes the bound: the published root's id. ──
    const first = await enumEnded(enumPage(teamId, 4));
    expect(first, `${label}: page 1: the first four originals, and a cursor after the fourth inside the frozen bound`).toEqual({
      page: { entries: [plain(enumId(0x10)), root(0x20), plain(enumId(0x30)), root(0x40)], nextCursor: cursorAfter(enumId(0x40)), exhausted: false, examined: 4 },
    });
    // Every later page is asked for with the cursor the CONTRACT requires of the page before it,
    // written out here: no later read depends on a cursor that a page read returned.
    const firstCursor = cursorAfter(enumId(0x40));

    // ── FIXTURE DML after page 1: two deletions, three insertions. ──
    await enumDeleteItems(teamId, [enumId(0x20), enumId(0x40)]);
    await enumPlantItems(teamId, project, [
      { id: enumId(0x15), path: "kr11/inserted-below-the-cursor.md", frontmatter: { source: "kr11-fixture" } },
      { id: enumId(0x55), path: "kr11/inserted-between-cursor-and-bound.md", frontmatter: { source: "kr11-fixture" } },
      { id: ENUM_HIGH_ID, path: "kr11/inserted-above-the-bound.md", frontmatter: { source: "kr11-fixture" } },
    ]);
    expect(await enumItemIdsInUuidOrder(teamId), `${label}: fixture: after the first change, in PostgreSQL's UUID order`).toEqual(
      [0x10, 0x15, 0x30, 0x50, 0x55, 0x60, 0x70, 0x80, 0x90, 0xa0, 0xb0].map(enumId).concat([bound, ENUM_HIGH_ID])
    );
    expect(await query(`select count(*)::int as rows from items where team_id = $1 and id = $2::uuid`, [teamId, enumId(0x40)]), `${label}: fixture: the cursor item no longer exists`).toEqual([{ rows: 0 }]);

    // ── PAGE 2, from a cursor whose item is gone. ──
    const second = await enumEnded(enumPage(teamId, 4, firstCursor));
    // FIRST, and narrowly: the ids and the exact cursor. A page that skips rows instead of continuing
    // after the cursor id is wrong here, in both.
    expect(idsAndCursor(second), `${label}: M8b: page 2 is exactly the four ids after the deleted cursor item, beginning with the original that follows it, with a cursor exactly after its fourth id inside the frozen bound`).toEqual({
      ids: [0x50, 0x55, 0x60, 0x70].map(enumId), nextCursor: cursorAfter(enumId(0x70)), exhausted: false,
    });
    expect(second, `${label}: page 2: the next original after the deleted cursor item comes FIRST, the insert between cursor and bound is admitted, and the bound is still the frozen one`).toEqual({
      page: { entries: [root(0x50), plain(enumId(0x55)), plain(enumId(0x60)), root(0x70)], nextCursor: cursorAfter(enumId(0x70)), exhausted: false, examined: 4 },
    });
    const secondCursor = cursorAfter(enumId(0x70));

    // ── FIXTURE DML after page 2: a NEW row at exactly the first cursor's id, and one below the second cursor. ──
    await enumPlantItems(teamId, project, [
      { id: enumId(0x40), path: "kr11/inserted-at-the-first-cursor.md", frontmatter: { source: "kr11-fixture" } },
      { id: enumId(0x65), path: "kr11/inserted-below-the-second-cursor.md", frontmatter: { source: "kr11-fixture" } },
    ]);
    const everyIdNow = [0x10, 0x15, 0x30, 0x40, 0x50, 0x55, 0x60, 0x65, 0x70, 0x80, 0x90, 0xa0, 0xb0].map(enumId).concat([bound, ENUM_HIGH_ID]);
    expect(await enumItemIdsInUuidOrder(teamId), `${label}: fixture: after the second change, in PostgreSQL's UUID order`).toEqual(everyIdNow);
    const before = await lifecycleSnapshot(teamId);

    // ── PAGES 3 AND 4. ──
    const third = await enumEnded(enumPage(teamId, 4, secondCursor));
    expect(third, `${label}: page 3: the four originals after the second cursor; nothing inserted at or below it appears`).toEqual({
      page: { entries: [plain(enumId(0x80)), root(0x90), plain(enumId(0xa0)), root(0xb0)], nextCursor: cursorAfter(enumId(0xb0)), exhausted: false, examined: 4 },
    });
    const fourth = await enumEnded(enumPage(teamId, 4, cursorAfter(enumId(0xb0))));
    // FIRST, and narrowly: what the last page ENDED as. A continuation with no upper bound meets the
    // item above the frozen bound here: it either returns that id or is rejected for it, and either
    // is a different value from this one.
    expect(idsAndCursor(fourth), `${label}: M8a: page 4 returned a page of exactly the published root's id at the frozen bound, with no cursor, and the range has ended`).toEqual({
      ids: [bound], nextCursor: null, exhausted: true,
    });
    expect(fourth, `${label}: page 4: the published root alone, at the frozen bound, and the range has ended; the item above the bound is not returned`).toEqual({
      page: { entries: [publishedRoot], nextCursor: null, exhausted: true, examined: 1 },
    });

    // ── WHAT THE TRAVERSAL SAW, against what was there. ──
    const seen = [first, second, third, fourth].flatMap((page) => pageOf(page).entries.map((entry) => entry.itemId));
    const remainingOriginals = [...originals.filter((id) => id !== enumId(0x20) && id !== enumId(0x40)), bound];
    expect(remainingOriginals.filter((id) => !seen.includes(id)), `${label}: no original item that still exists inside the range was omitted`).toEqual([]);
    expect([0x15, 0x55, 0x65].map(enumId).concat([ENUM_HIGH_ID]).filter((id) => seen.includes(id)), `${label}: of the inserts, only the one strictly between the cursor and the bound was returned`).toEqual([enumId(0x55)]);
    expect(seen.filter((id) => id === enumId(0x40)).length, `${label}: the cursor id was returned once, on page 1, and its later re-creation was not`).toBe(1);
    expect(new Set(seen).size, `${label}: no id was returned twice`).toBe(seen.length);

    // ── SAFE REPLAY FROM AN OLD CURSOR: a deterministic read of the range as it is NOW. ──
    const replayOfFirst = {
      page: { entries: [root(0x50), plain(enumId(0x55)), plain(enumId(0x60)), plain(enumId(0x65))], nextCursor: cursorAfter(enumId(0x65)), exhausted: false, examined: 4 },
    };
    expect(await enumEnded(enumPage(teamId, 4, firstCursor)), `${label}: replay from the first cursor: after the cursor id (its re-created row is not returned), inside the same frozen bound, with what is in the range now`).toEqual(replayOfFirst);
    expect(await enumEnded(enumPage(teamId, 4, firstCursor)), `${label}: the same replay again is the same page: a replay consumes nothing`).toEqual(replayOfFirst);
    expect(await enumEnded(enumPage(teamId, 4, secondCursor)), `${label}: replay from the second cursor is page 3 again`).toEqual(third);

    // ── A LOST CURSOR: the traversal starts again at the lowest id, under a NEW frozen bound. ──
    expect(await enumEnded(enumPage(teamId, 4)), `${label}: a first-page request starts again from the lowest id and freezes a new bound, the greatest id there is now`).toEqual({
      page: {
        entries: [plain(enumId(0x10)), plain(enumId(0x15)), plain(enumId(0x30)), plain(enumId(0x40))],
        nextCursor: cursorAfter(enumId(0x40), ENUM_HIGH_ID), exhausted: false, examined: 4,
      },
    });
    // A LATER SWEEP, whole: every item that waited is returned by it, once.
    const later = await enumTraverse(teamId, 4, 8);
    expect(later.flatMap((page) => page.entries.map((entry) => entry.itemId)), `${label}: a later sweep returns every item there is now, in order, including each that waited`).toEqual(everyIdNow);
    expect([later.length, later[later.length - 1].exhausted, later[later.length - 1].nextCursor, later.slice(0, -1).map((page) => page.nextCursor?.upperItemId)],
      `${label}: the later sweep is four pages under its own bound, and ends`).toEqual([4, true, null, [ENUM_HIGH_ID, ENUM_HIGH_ID, ENUM_HIGH_ID]]);

    expect(await lifecycleSnapshot(teamId), `${label}: every read since the second change changed no row of any snapshotted surface`).toEqual(before);
    expect(await lifecycleQueueAndStagingAnywhere(), `${label}: no pending work and no staging was created`).toEqual({ queue: [], staging: [] });
  });
});

/**
 * KR-11 in part — queue traffic during a traversal neither moves the traversal nor is moved by it
 * (`docs/design/slack-known-root-requeue-spec.md` §4.3, §5.2, §11 KR-11).
 *
 * The published root already has pending work, with a DISTINCTIVE HISTORY: the real enqueue helper
 * wrote its row with a due instant in 2001, and one labeled fixture statement then gave it seven
 * attempts. A three-page traversal is read. Between its pages the real enqueue helper is called for
 * the same root again, with another due instant, and for two other roots of the channel; and between
 * pages 1 and 2 the REAL PREPARATION is run for the synthetic root that page 1 returned, from that
 * enumerated entry alone.
 *
 * Required: that preparation is `enqueued`, with one queue row in the root's exact scope at its own
 * observation-derived due instant; the three pages are exactly the pages of a quiet team, under the
 * one bound the first page froze, with that root's pending work changing nothing of the pages that
 * follow; each page read changes no snapshotted row; the historical row is byte-identical after
 * every step; the published root is still returned as a located entry although its work is pending;
 * and a preparation from either entry afterwards returns `already_pending` and leaves both rows
 * byte-identical.
 *
 * NOT CLAIMED: anything about claim order, FIFO, fairness or starvation; running, expired or staged
 * queue states (the KR-06 suites above); or a traversal concurrent with a writer on another
 * connection — the traffic here is committed between page transactions.
 */
describe("KR-11 queue traffic during a traversal", () => {
  const HISTORICAL_DUE = "2001-02-03T04:05:06.789Z";
  const HISTORICAL_DUE_AS_STORED = "2001-02-03 04:05:06.789000+00";
  const TRAFFIC_ROOTS = ["1718900600.000100", "1718900700.000100"];

  it("reads the same three pages under the same frozen bound while queue rows are written between pages, and leaves an existing row's historical due instant, attempts and state byte-identical (KR-11)", async () => {
    const label = "queue traffic";
    const real = await enumRealRoot(await publishOldRoot());
    const teamId = real.teamId;
    const project = await enumFixtureProject(teamId, "kr11-traffic");
    const tsOf = (slot: number): string => `${1718000000 + slot}.000100`;
    await enumPlantCanonicalRoots(real, [3, 5].map((slot) => ({ id: enumId(slot), ts: tsOf(slot) })), "kr11-traffic-root");
    await enumPlantItems(teamId, project, [1, 2, 4, 6].map((slot) => ({ id: enumId(slot), path: `kr11/traffic-${slot}.md`, frontmatter: { source: "kr11-fixture" } })));
    expect(real.itemId > enumId(6), `${label}: fixture: the published item's random id sorts after every chosen id (a random id sorts lower only if it begins with eight zero digits, which fewer than one in four billion do: run again)`).toBe(true);
    const publishedRoot = enumLocated(teamId, real.itemId, real.locatorOf(OLD_ROOT));
    const ordered = [1, 2, 3, 4, 5, 6].map((slot) => ([3, 5].includes(slot)
      ? enumLocated(teamId, enumId(slot), real.locatorOf(tsOf(slot)))
      : enumUnlocated(teamId, enumId(slot), "not_slack"))).concat([publishedRoot]);
    expect(await enumItemIdsInUuidOrder(teamId), `${label}: fixture: seven items, in PostgreSQL's UUID order`).toEqual(ordered.map((entry) => entry.itemId));
    const expected = enumExpectedPages(teamId, ordered, 3, real.itemId);

    // ── THE EXISTING ROW: written by the real enqueue helper at a historical due instant. ──
    const scope = { teamId, workspaceId: WORKSPACE, channelId: CHANNEL, rootTs: OLD_ROOT };
    const written = await tx((s) => enqueueSlackThread(s, scope, { dueAt: new Date(HISTORICAL_DUE) }));
    expect(written.inserted, `${label}: fixture: the real enqueue helper inserted the row`).toBe(true);
    // FIXTURE DML: an attempt count no fresh row has.
    const attempted = await (await rawSql()).query(
      `update slack_sync_threads set attempts = 7 where team_id = $1 and workspace_id = $2 and channel_id = $3 and root_ts = $4`, [teamId, WORKSPACE, CHANNEL, OLD_ROOT]
    );
    expect(attempted.rowCount, `${label}: fixture: exactly one queue row was given its attempt count`).toBe(1);
    const HISTORICAL_ROW = { workspace_id: WORKSPACE, channel_id: CHANNEL, root_ts: OLD_ROOT, status: "queued", attempts: 7, due_at_utc: HISTORICAL_DUE_AS_STORED };
    expect(await enumQueueOf(teamId), `${label}: fixture: one queued row, seven attempts, due in 2001`).toEqual([HISTORICAL_ROW]);
    const [historicalExactly] = await lifecycleQueueRowsExactly(teamId);
    /** The historical row, whole, wherever it now sorts among the team's queue rows. */
    const historicalNow = async (): Promise<string[]> => {
      const rows = await query(
        `select to_jsonb(t)::text as stored from slack_sync_threads t where t.team_id = $1 and t.workspace_id = $2 and t.channel_id = $3 and t.root_ts = $4`,
        [teamId, WORKSPACE, CHANNEL, OLD_ROOT]
      );
      return rows.map((row) => row.stored as string);
    };
    /** One page read, with the snapshots on either side of it. */
    const quietlyRead = async (cursor?: EnumCursor) => {
      const before = await lifecycleSnapshot(teamId);
      const page = await enumPage(teamId, 3, cursor);
      return { page, changed: lifecycleTablesThatDiffer(before, await lifecycleSnapshot(teamId)) };
    };

    // ── PAGE 1. ──
    const first = await quietlyRead();
    expect([first.page, first.changed], `${label}: page 1 is the quiet team's page 1, and reading it changed nothing`).toEqual([expected[0], []]);

    // ── QUEUE TRAFFIC, by the real enqueue helper: the same root again, and another root. ──
    const again = await tx((s) => enqueueSlackThread(s, scope, { dueAt: new Date() }));
    const another = await tx((s) => enqueueSlackThread(s, { ...scope, rootTs: TRAFFIC_ROOTS[0] }, { dueAt: new Date("1999-12-31T23:59:59.000Z") }));
    expect([again.inserted, another.inserted], `${label}: traffic: the existing row conflicted and was not re-inserted; another root's row was inserted`).toEqual([false, true]);
    expect(await historicalNow(), `${label}: after the first traffic the historical row is byte-identical`).toEqual([historicalExactly]);

    // ── A REAL PREPARATION BETWEEN PAGES 1 AND 2: the synthetic root that page 1 returned, from its
    //    enumerated entry alone. Its witness was planted two hours old, so it is overdue. ──
    const syntheticEntry = first.page.entries[2];
    const syntheticScope = [teamId, WORKSPACE, CHANNEL, tsOf(3)];
    const syntheticWitness = await query<{ exact_due_utc: string; exact_due_is_past: boolean }>(
      `select ${lifecycleUtc("w.observed_at + interval '60 seconds'")} as exact_due_utc,
              w.observed_at + interval '60 seconds' < clock_timestamp() as exact_due_is_past
         from slack_messages w where ${LIFECYCLE_ROOT_WITNESS} and w.deleted_at is null`, [...syntheticScope, enumId(3)]
    );
    expect(syntheticWitness.map((row) => row.exact_due_is_past), `${label}: fixture: the synthetic root has exactly one live root witness, and its exact due instant is past`).toEqual([true]);
    const syntheticDue = syntheticWitness[0].exact_due_utc;
    /** The synthetic root's queue rows, against its exact due instant; and the same rows, whole. */
    const syntheticQueue = (): Promise<Row[]> => query(
      `select t.workspace_id, t.channel_id, t.root_ts, t.status, t.attempts,
              t.due_at >= $5::timestamptz as not_before_the_exact_due,
              t.due_at < $5::timestamptz + interval '1 millisecond' as less_than_a_millisecond_after_it,
              to_char(t.due_at at time zone 'UTC', 'US') like '%000' as on_a_whole_millisecond
         from slack_sync_threads t where t.team_id = $1 and t.workspace_id = $2 and t.channel_id = $3 and t.root_ts = $4`, [...syntheticScope, syntheticDue]
    );
    const syntheticNow = async (): Promise<string[]> => (await query(
      `select to_jsonb(t)::text as stored from slack_sync_threads t where t.team_id = $1 and t.workspace_id = $2 and t.channel_id = $3 and t.root_ts = $4`, syntheticScope
    )).map((row) => row.stored as string);
    expect(await syntheticQueue(), `${label}: fixture: the synthetic root has no pending work before its preparation`).toEqual([]);
    // The execution context is created BEFORE the transaction it is used in.
    const betweenPages = createSlackKnownRootExecution({ ambientDeadlineAt: null });
    expect(await tx((s) => prepareSlackKnownRootRequeue(s, { teamId, entry: syntheticEntry }, betweenPages)),
      `${label}: between pages 1 and 2 the real preparation of the synthetic root page 1 returned is enqueued`).toEqual({ outcome: "enqueued" });
    expect(await syntheticQueue(), `${label}: that preparation wrote one queued, never-attempted row in the root's exact scope, at its observation-derived due instant rounded up to its millisecond`).toEqual([{
      workspace_id: WORKSPACE, channel_id: CHANNEL, root_ts: tsOf(3), status: "queued", attempts: 0,
      not_before_the_exact_due: true, less_than_a_millisecond_after_it: true, on_a_whole_millisecond: true,
    }]);
    const [syntheticExactly] = await syntheticNow();
    expect(await historicalNow(), `${label}: after that preparation the historical row is byte-identical`).toEqual([historicalExactly]);

    // ── PAGE 2, from page 1's cursor. ──
    const second = await quietlyRead(first.page.nextCursor);
    expect([second.page, second.changed], `${label}: page 2 is the quiet team's page 2, under the same frozen bound, and reading it changed nothing`).toEqual([expected[1], []]);

    // ── MORE TRAFFIC. ──
    const third = await tx((s) => enqueueSlackThread(s, { ...scope, rootTs: TRAFFIC_ROOTS[1] }));
    expect(third.inserted, `${label}: traffic: a third root's row was inserted`).toBe(true);

    // ── PAGE 3: the published root, located, although its work is pending. ──
    const last = await quietlyRead(second.page.nextCursor);
    expect([last.page, last.changed], `${label}: page 3 is the published root as a located entry, the range has ended, and reading it changed nothing`).toEqual([expected[2], []]);
    expect([first.page, second.page, last.page], `${label}: the whole traversal is the quiet team's, page for page`).toEqual(expected);

    // ── THE QUEUE: four rows, and the historical one exactly as it was. ──
    expect((await enumQueueOf(teamId)).map((row) => [row.root_ts, row.status, row.attempts]), `${label}: four queue rows: the one the preparation between pages wrote, the historical one, and the two the traffic inserted`)
      .toEqual([[tsOf(3), "queued", 0], [OLD_ROOT, "queued", 7], [TRAFFIC_ROOTS[0], "queued", 0], [TRAFFIC_ROOTS[1], "queued", 0]]);
    expect((await enumQueueOf(teamId)).filter((row) => row.root_ts === OLD_ROOT), `${label}: the historical row still has its 2001 due instant, its seven attempts and its state`).toEqual([HISTORICAL_ROW]);
    expect([await historicalNow(), await syntheticNow()], `${label}: after the traversal the historical row and the row the preparation between pages wrote are byte-identical`)
      .toEqual([[historicalExactly], [syntheticExactly]]);

    // ── PREPARATION from the enumerated entries: pending work is left exactly as it is. ──
    const execution = createSlackKnownRootExecution({ ambientDeadlineAt: null });
    const entry = last.page.entries[0];
    expect(await tx((s) => prepareSlackKnownRootRequeue(s, { teamId, entry }, execution)), `${label}: preparation from the enumerated entry returns already_pending`).toEqual({ outcome: "already_pending" });
    expect(await historicalNow(), `${label}: after the preparation the historical row is byte-identical`).toEqual([historicalExactly]);
    const syntheticAgain = createSlackKnownRootExecution({ ambientDeadlineAt: null });
    expect(await tx((s) => prepareSlackKnownRootRequeue(s, { teamId, entry: syntheticEntry }, syntheticAgain)), `${label}: a second preparation of the synthetic root returns already_pending`).toEqual({ outcome: "already_pending" });
    expect([await syntheticQueue(), await syntheticNow()], `${label}: after it, that root still has one row at its observation-derived due instant, byte-identical`).toEqual([[{
      workspace_id: WORKSPACE, channel_id: CHANNEL, root_ts: tsOf(3), status: "queued", attempts: 0,
      not_before_the_exact_due: true, less_than_a_millisecond_after_it: true, on_a_whole_millisecond: true,
    }], [syntheticExactly]]);
    expect((await lifecycleQueueAndStagingAnywhere()).staging, `${label}: nothing is staged`).toEqual([]);
  });
});

/**
 * KR-10 in part — a page read that FAILS supplies no continuation, and the cursor before it still
 * works (`docs/design/slack-known-root-requeue-spec.md` §4.3, §7.4, §11 KR-10).
 *
 * A TEST-ONLY wrapper around the caller's session forwards every statement unchanged until the
 * chosen one, which it rejects with an error of this file's own instead of sending it. It names no
 * statement of the product: a successful read through the same wrapper is counted first, and the
 * failure is then injected at EVERY position that count gives, each on a transaction and an
 * execution context of its own. That is done for a first-page request and for a continuation.
 *
 * Required at every position: the read is rejected with the injected error itself (or an error
 * caused by it), so NO page and NO cursor is returned — not an empty page, not an exhausted one;
 * nothing more is sent on that session once the statement has failed; and immediately afterwards a
 * fresh transaction with a fresh execution context returns, from the request as it was BEFORE the
 * failure, exactly the page it returns undisturbed.
 *
 * NOT CLAIMED: a failure raised by the SERVER (a timeout, a lock timeout, a cancelled statement), a
 * deadline, an aborted transaction or an unusable connection — those are KR-12's — and contention on
 * another connection. The error here never reaches PostgreSQL.
 */
describe("KR-10 a failed page read supplies no continuation", () => {
  class InjectedPageFailure extends Error {}

  /** The caller's session, unchanged in behaviour, except that the statement at `failAt` is rejected and not sent. */
  const failingAt = (session: TransactionSession, failAt: number | null, injected: Error, sent: { statements: number }): TransactionSession => {
    const executeSql: SqlExecutor = async <T = Record<string, unknown>>(text: string, params?: unknown[]) => {
      sent.statements += 1;
      if (sent.statements === failAt) throw injected;
      return session.executeSql<T>(text, params);
    };
    return {
      get db() {
        return session.db;
      },
      executeSql,
      optionalAudit<T>(operation: () => Promise<T>, fallback: T): Promise<T> {
        return session.optionalAudit(operation, fallback);
      },
    };
  };

  it("is rejected with the injected failure at every statement position, returns no page or cursor, and the request as it was before the failure returns the same page on a fresh transaction (KR-10)", async () => {
    const real = await enumRealRoot(await publishOldRoot());
    const teamId = real.teamId;
    const project = await enumFixtureProject(teamId, "kr10-failure");
    await enumPlantCanonicalRoots(real, [{ id: enumId(3), ts: "1718000003.000100" }], "kr10-failure-root");
    await enumPlantItems(teamId, project, [1, 2, 4, 5].map((slot) => ({ id: enumId(slot), path: `kr10/failure-${slot}.md`, frontmatter: { source: "kr10-fixture" } })));
    expect(real.itemId > enumId(5), "fixture: the published item's random id sorts after every chosen id (a random id sorts lower only if it begins with eight zero digits, which fewer than one in four billion do: run again)").toBe(true);
    const ordered = [1, 2, 3, 4, 5].map((slot) => (slot === 3
      ? enumLocated(teamId, enumId(slot), real.locatorOf("1718000003.000100"))
      : enumUnlocated(teamId, enumId(slot), "not_slack"))).concat([enumLocated(teamId, real.itemId, real.locatorOf(OLD_ROOT))]);
    expect(await enumItemIdsInUuidOrder(teamId), "fixture: six items, in PostgreSQL's UUID order").toEqual(ordered.map((entry) => entry.itemId));
    const expected = enumExpectedPages(teamId, ordered, 2, real.itemId);

    // The undisturbed traversal: three pages of two.
    const undisturbed = await enumTraverse(teamId, 2, 5);
    expect(undisturbed, "fixture: the undisturbed traversal is three pages of two").toEqual(expected);
    const before = await lifecycleSnapshot(teamId);

    const requests: [label: string, cursor: EnumCursor | undefined, expectedPage: EnumExpectedPage][] = [
      ["a first-page request", undefined, expected[0]],
      ["a continuation from page 1's cursor", undisturbed[0].nextCursor, expected[1]],
    ];
    for (const [label, cursor, expectedPage] of requests) {
      const request = { teamId, pageSize: 2, revisitAfterMs: REVISIT_AFTER_MS, ...(cursor ? { cursor } : {}) };
      const through = (failAt: number | null, injected: Error, sent: { statements: number }): Promise<SlackKnownRootItemPage> => {
        // The execution context is created BEFORE the transaction it is used in.
        const execution = createSlackKnownRootExecution({ ambientDeadlineAt: null });
        return tx((s) => readSlackKnownRootItemPage(failingAt(s, failAt, injected, sent), request, execution));
      };

      // CONTROL: through the wrapper with nothing injected, the page is the undisturbed one.
      const counted = { statements: 0 };
      expect(await through(null, new InjectedPageFailure("fixture: never thrown"), counted), `${label}: control: the wrapper, injecting nothing, changes nothing`).toEqual(expectedPage);
      expect(counted.statements >= 3, `${label}: fixture: a page read sends several statements on the caller's session`).toBe(true);

      for (let position = 1; position <= counted.statements; position++) {
        const injected = new InjectedPageFailure(`fixture: statement ${position} of the page read fails`);
        const sent = { statements: 0 };
        const ended = await through(position, injected, sent).then(
          (page) => ({ returned: page as SlackKnownRootItemPage | null, rejectedWithTheInjectedFailure: false }),
          (error: unknown) => ({ returned: null, rejectedWithTheInjectedFailure: error === injected || (error as { cause?: unknown } | null)?.cause === injected })
        );
        expect(ended, `${label}: failing statement ${position} of ${counted.statements}: the read is rejected with the injected failure, and returns no page and no cursor`)
          .toEqual({ returned: null, rejectedWithTheInjectedFailure: true });
        expect(sent.statements, `${label}: failing statement ${position} of ${counted.statements}: nothing more was sent on that session after it`).toBe(position);
        // The request as it was BEFORE the failure, on a fresh transaction and a fresh execution context.
        expect(await enumEnded(enumPage(teamId, 2, cursor)), `${label}: after failing statement ${position} of ${counted.statements}: the same request returns the same page`)
          .toEqual({ page: expectedPage });
      }
    }

    // After every failure: the whole traversal is still the undisturbed one, and nothing was written.
    expect(await enumTraverse(teamId, 2, 5), "after every injected failure the whole traversal is the undisturbed one").toEqual(expected);
    expect(await lifecycleSnapshot(teamId), "no injected failure, and no read, changed a row of any snapshotted surface").toEqual(before);
    expect(await lifecycleQueueAndStagingAnywhere(), "no pending work and no staging was created").toEqual({ queue: [], staging: [] });
  });
});

// ── THE AUTHORITY INVALIDATION EVIDENCE PACKET ───────────────────────────────────────────────────
//
// New, file-local helpers and four suites. No earlier helper, constant or case is moved or changed;
// three names were added to this file's import statements. No KR-17 hook is involved in any of
// these selections.

/**
 * KR-09 — an entry enumerated BEFORE an authoritative change is refused after it, and nothing is
 * written (`docs/design/slack-known-root-requeue-spec.md` §4.1, §5.1, §11 KR-09 and its two fixture
 * notes, §12 M6a and M6b).
 *
 * EVIDENCE, NOT RED: every case of the four suites below is expected to pass on the current source.
 * They are evidence to be audited later; none of them declares KR-09 complete.
 *
 * THE SHAPE OF EVERY CASE. A root is published by the real discovery, readiness, staging and
 * `ingestItem` publication. Its root witness alone is aged by fixture DML, so that a preparation
 * which is NOT refused would enqueue: a refusal is therefore never "not due" in disguise. The real
 * enumeration returns its one located entry, which is kept, with its bytes. ONE authoritative fact
 * is then changed. Preparation is given the team, that old entry and an ordinary execution context,
 * and nothing else. Required: the exact closed result; no snapshotted row changed by the
 * preparation; no queue row and no staging in any team; the entry byte-identical.
 *
 * WHAT IS REPORTED, AND WHAT IS NOT. Every value handed to an assertion here is a fixed label, a
 * closed outcome or reason name, a table name, a count or a boolean. A snapshot is a per-table row
 * count and digest COMPUTED BY THE DATABASE: no row content, token, ciphertext, fingerprint,
 * revision, path or id is read into an assertion, and a comparison of two such values is reported
 * as the names of the tables that differ. Tokens, ciphertext, fingerprints and revisions that a
 * fixture must hold are held privately and only ever compared with each other. A preparation that
 * throws is reported as the exported classifier's closed failure category.
 *
 * FIXTURE DML IS LABELED, AND IS NOT A PRODUCT PATH. Each change is one statement on one fact, so
 * that the refusal can be attributed to it; the surfaces it altered are read back and must be
 * exactly the ones it is meant to alter. None of these statements is an approved way to disable,
 * edit, rotate or repair anything.
 */
type AuthorityLocatedEntry = Extract<SlackKnownRootEntry, { locator: unknown }>;
/** How one preparation ENDED: its closed result, or the closed category of what it threw. */
type AuthorityEnded = SlackKnownRootPreparationResult | { threw: string };

interface AuthorityFixture {
  teamId: string;
  integrationId: string;
  /** The entry the real enumeration returned BEFORE any change, and the bytes it had then. */
  entry: AuthorityLocatedEntry;
  entryBytes: string;
}

const AUTHORITY_NOTHING_PENDING = { queue_rows: 0, staged_snapshots: 0 };
const AUTHORITY_ONE_QUEUE_ROW = { queue_rows: 1, staged_snapshots: 0 };
/** Queue rows and staged snapshots in the DATABASE, of any team, as counts. */
const authorityPendingCounts = async (): Promise<Row> => (await query(
  `select (select count(*)::int from slack_sync_threads) as queue_rows,
          (select count(*)::int from slack_thread_snapshots) as staged_snapshots`
))[0];

/**
 * Every row of the team in every surface a preparation must not touch — the lifecycle packet's list:
 * queue and staging, items and versions, ledger, identity, access, generations, channel and source
 * authority, namespace gate and readiness proofs, budgets and runs — as ONE row count and ONE digest
 * per table, both computed by the database. Nothing of a row leaves it.
 */
async function authorityDigests(teamId: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const table of LIFECYCLE_SNAPSHOT_TABLES) {
    const [row] = await query<{ rows: number; digest: string }>(
      `select count(*)::int as rows,
              md5(coalesce(jsonb_agg(to_jsonb(t) order by to_jsonb(t)::text), '[]'::jsonb)::text) as digest
         from "${table}" t where t.team_id = $1`, [teamId]
    );
    out[table] = `${row.rows}:${row.digest}`;
  }
  const [versions] = await query<{ rows: number; digest: string }>(
    `select count(*)::int as rows,
            md5(coalesce(jsonb_agg(to_jsonb(v) order by to_jsonb(v)::text), '[]'::jsonb)::text) as digest
       from item_versions v join items i on i.id = v.item_id where i.team_id = $1`, [teamId]
  );
  out.item_versions = `${versions.rows}:${versions.digest}`;
  return out;
}
/** The NAMES of the tables whose count or digest differs. */
const authorityTablesThatDiffer = (from: Record<string, string>, to: Record<string, string>): string[] =>
  Object.keys(from).filter((table) => from[table] !== to[table]).sort();

/**
 * FIXTURE AGING of the published root's exact root witness, by two hours, and then the real
 * enumeration: exactly one located entry, in the published root's exact scope, which is returned
 * with the bytes it has now.
 */
async function authorityRoot(label: string, f: Published): Promise<AuthorityFixture> {
  const teamId = f.seed.teamId;
  const aged = await (await rawSql()).query(
    `update slack_messages w set observed_at = w.observed_at - interval '2 hours' where ${LIFECYCLE_ROOT_WITNESS}`, lifecycleWitnessOf(f)
  );
  expect(aged.rowCount, `${label}: fixture aging: exactly one ledger row, the root witness, was changed`).toBe(1);
  expect(await authorityPendingCounts(), `${label}: fixture: the real publication left no queue row and no staging`).toEqual(AUTHORITY_NOTHING_PENDING);

  const page = await enumPage(teamId, 100);
  const entry = page.entries[0];
  expect([page.entries.length, page.examined, page.exhausted, page.nextCursor === null, entry !== undefined && "locator" in entry],
    `${label}: fixture: the real enumeration returns exactly one entry, located, and the range ends`).toEqual([1, 1, true, true, true]);
  if (entry === undefined || !("locator" in entry)) throw new Error("fixture: the enumeration returned no located entry");
  expect([
    entry.teamId === teamId.toLowerCase(), entry.itemId === f.itemId.toLowerCase(), entry.revisitAfterMs === REVISIT_AFTER_MS,
    entry.locator.workspaceId === WORKSPACE, entry.locator.channelId === CHANNEL, entry.locator.rootTs === OLD_ROOT,
    entry.locator.integrationId === f.integrationId.toLowerCase(), entry.locator.namespaceRevision === f.namespaceRevision,
    /^[0-9a-f]{64}$/.test(entry.locator.bindingConfigRevision),
  ], `${label}: fixture: the entry is the published root's, in its exact scope, with the integration, namespace revision and a configuration revision of the fixture`)
    .toEqual([true, true, true, true, true, true, true, true, true]);
  return { teamId, integrationId: f.integrationId, entry, entryBytes: JSON.stringify(entry) };
}

/** Preparation on a transaction of its own, from the team and one entry ALONE, as one closed value. */
function authorityPrepared(teamId: string, entry: SlackKnownRootEntry): Promise<AuthorityEnded> {
  // The execution context is created BEFORE the transaction it is used in.
  const execution = createSlackKnownRootExecution({ ambientDeadlineAt: null });
  return tx((s) => prepareSlackKnownRootRequeue(s, { teamId, entry }, execution)).then(
    (result): AuthorityEnded => result,
    (error: unknown): AuthorityEnded => ({ threw: classifySlackKnownRootPreparationFailure(error) })
  );
}

/**
 * What every refusal here requires: the exact closed result of preparing the OLD entry; no row of any
 * snapshotted surface changed by that preparation; no queue row and no staging in any team; and the
 * entry byte-identical. `resultLabel` names the first assertion when a later mutation run must find it.
 */
async function authorityRefusedWithNothingWritten(
  fx: AuthorityFixture, label: string, expected: SlackKnownRootPreparationResult, resultLabel?: string
): Promise<void> {
  const before = await authorityDigests(fx.teamId);
  const ended = await authorityPrepared(fx.teamId, fx.entry);
  expect(ended, resultLabel ?? `${label}: the entry enumerated before the change is refused with the exact closed reason`).toEqual(expected);
  expect(authorityTablesThatDiffer(before, await authorityDigests(fx.teamId)), `${label}: the refused preparation changed no row of any snapshotted surface`).toEqual([]);
  expect(await authorityPendingCounts(), `${label}: nothing was enqueued and nothing is staged, in any team`).toEqual(AUTHORITY_NOTHING_PENDING);
  expect(JSON.stringify(fx.entry) === fx.entryBytes, `${label}: the entry handed to preparation is byte-identical to the one enumeration returned`).toBe(true);
}

/** Whether each named environment variable is present, and its value. PRIVATE: never handed to an assertion. */
const authorityEnvironmentState = (names: readonly string[]): { present: boolean; value: string | undefined }[] =>
  names.map((name) => ({ present: Object.prototype.hasOwnProperty.call(process.env, name), value: process.env[name] }));

/**
 * Run with the named environment variables under the test's control, and put each back EXACTLY as it
 * was — present with its value, or absent — in `finally`, whatever the run did.
 */
async function authorityWithEnvironment<T>(names: readonly string[], run: () => Promise<T>): Promise<T> {
  const saved = authorityEnvironmentState(names);
  try {
    return await run();
  } finally {
    names.forEach((name, index) => {
      const { present, value } = saved[index];
      if (present) process.env[name] = value as string;
      else delete process.env[name];
    });
  }
}
/** One boolean per variable: it is, now, exactly as `saved` recorded it. */
const authorityEnvironmentIsAs = (names: readonly string[], saved: readonly { present: boolean; value: string | undefined }[]): boolean[] =>
  authorityEnvironmentState(names).map((now, index) => now.present === saved[index].present && now.value === saved[index].value);

/**
 * KR-09 — ten single-fact changes, each its own fixture and its own reported case, and one control.
 *
 * THE CONTROL: the same fixture with NO change. Its entry is enqueued. So each refusal below is the
 * doing of the one fact that case changed, and not of the fixture.
 *
 * THE REASON EACH CHANGE MUST GIVE is the one §5.1's order gives: the namespace gate first, then the
 * integration's current selection, then the binding row, then the channel row.
 *
 *   disabled, deleted, deselected, configuration revision moved   `source_not_current`
 *   binding at another revision, no longer verified, other workspace   `binding_changed`
 *   channel row deleted                                                `binding_changed`
 *   channel private, channel public state unknown                      `channel_not_public`
 *
 * NOT HERE: the token and the namespace gate, which are the three suites below; a second integration
 * taking the channel over; and an invalid app id on a verified binding.
 */
describe("KR-09 authority invalidation between enumeration and preparation", () => {
  interface AuthorityChange {
    /** A fixed label. It is the only thing of the case that is reported. */
    name: string;
    /** FIXTURE DML: one statement, which must write exactly one row. */
    sql: string;
    params: (fx: AuthorityFixture) => unknown[];
    /** The snapshotted surfaces the statement must alter, and those it may alter besides. */
    mustChange: string[];
    mayChange: string[];
    /**
     * Optionally, the ONE row the statement updates and the only columns of it that may change. Every
     * other column of that row is digested by the database before and after and must be the same, and
     * the named columns must go from exactly `from` to exactly `to`. The values named are fixed labels.
     */
    onlyColumns?: { table: string; where: string; params: (fx: AuthorityFixture) => unknown[]; from: Record<string, unknown>; to: Record<string, unknown> };
    expected: SlackKnownRootPreparationResult;
  }
  /** Of that ONE row: a database digest of every column but the named ones, and the named ones as the database holds them. */
  const rowBut = (only: NonNullable<AuthorityChange["onlyColumns"]>, fx: AuthorityFixture): Promise<{ rest: string; named: Record<string, unknown> }[]> => {
    const params = only.params(fx);
    const named = `$${params.length + 1}::text[]`;
    return query<{ rest: string; named: Record<string, unknown> }>(
      `select md5((to_jsonb(t) - ${named})::text) as rest,
              (select jsonb_object_agg(c.key, c.value) from jsonb_each(to_jsonb(t)) as c where c.key = any(${named})) as named
         from ${only.table} t ${only.where}`, [...params, Object.keys(only.to)]
    );
  };
  const NO_COLUMN_READBACK = "this case has no column-level readback";
  const integration = (fx: AuthorityFixture): unknown[] => [fx.teamId, fx.integrationId];
  const channel = (fx: AuthorityFixture): unknown[] => [fx.teamId, WORKSPACE, CHANNEL];
  const ITS_INTEGRATION = `where team_id = $1 and id = $2::uuid`;
  const ITS_BINDING = `where team_id = $1 and integration_id = $2::uuid`;
  const ITS_CHANNEL = `where team_id = $1 and workspace_id = $2 and channel_id = $3`;
  const SOURCE_NOT_CURRENT: SlackKnownRootPreparationResult = { outcome: "refused", reason: "source_not_current" };
  const BINDING_CHANGED: SlackKnownRootPreparationResult = { outcome: "refused", reason: "binding_changed" };
  const CHANNEL_NOT_PUBLIC: SlackKnownRootPreparationResult = { outcome: "refused", reason: "channel_not_public" };

  const CHANGES: AuthorityChange[] = [
    {
      name: "the integration is disabled",
      sql: `update integrations set status = 'disabled' ${ITS_INTEGRATION}`, params: integration,
      mustChange: ["integrations"], mayChange: [], expected: SOURCE_NOT_CURRENT,
    },
    {
      // The binding goes with it, the channel row loses its binder, and the budget row that discovery keyed on the integration goes too.
      name: "the integration is deleted",
      sql: `delete from integrations ${ITS_INTEGRATION}`, params: integration,
      mustChange: ["integrations", "slack_integration_bindings", "slack_method_budgets", "slack_sync_channels"], mayChange: [], expected: SOURCE_NOT_CURRENT,
    },
    {
      name: "the channel is deselected in the integration's configuration",
      sql: `update integrations set config = jsonb_set(config, '{channelIds}', '[]'::jsonb) ${ITS_INTEGRATION}`, params: integration,
      mustChange: ["integrations"], mayChange: [], expected: SOURCE_NOT_CURRENT,
    },
    {
      // What an ordinary edit of the integration does to the revision: its updated_at moves. Status, type and selection are as they were.
      name: "the integration's configuration revision has moved",
      sql: `update integrations set updated_at = updated_at + interval '1 microsecond' ${ITS_INTEGRATION}`, params: integration,
      mustChange: ["integrations"], mayChange: [], expected: SOURCE_NOT_CURRENT,
    },
    {
      // A synthetic revision of sixty-four zeros: valid in shape, and no revision of this fixture.
      name: "the binding is recorded at another configuration revision",
      sql: `update slack_integration_bindings set config_revision = repeat('0', 64) ${ITS_BINDING}`, params: integration,
      mustChange: ["slack_integration_bindings"], mayChange: [], expected: BINDING_CHANGED,
    },
    {
      // ONLY the state, and the category a blocked state must carry. The workspace, the app id, the configuration revision, the
      // token fingerprint and the selected channels all stay exactly as verified: the state is the one operative fact, so a
      // preparation that did not check it would find nothing else wrong with this binding and would enqueue.
      name: "the binding is no longer verified",
      sql: `update slack_integration_bindings set state = 'blocked', error_code = 'kr09_fixture_blocked' ${ITS_BINDING}`, params: integration,
      mustChange: ["slack_integration_bindings"], mayChange: [],
      onlyColumns: {
        table: "slack_integration_bindings", where: ITS_BINDING, params: integration,
        from: { state: "verified", error_code: null }, to: { state: "blocked", error_code: "kr09_fixture_blocked" },
      },
      expected: BINDING_CHANGED,
    },
    {
      name: "the binding's stored workspace is another workspace",
      sql: `update slack_integration_bindings set workspace_id = 'T0SOURCE2' ${ITS_BINDING}`, params: integration,
      mustChange: ["slack_integration_bindings"], mayChange: [], expected: BINDING_CHANGED,
    },
    {
      name: "the channel's stored public state is private",
      sql: `update slack_sync_channels set public_state = 'private' ${ITS_CHANNEL}`, params: channel,
      mustChange: ["slack_sync_channels"], mayChange: [], expected: CHANNEL_NOT_PUBLIC,
    },
    {
      name: "the channel's stored public state is unknown",
      sql: `update slack_sync_channels set public_state = 'unknown', public_checked_at = null ${ITS_CHANNEL}`, params: channel,
      mustChange: ["slack_sync_channels"], mayChange: [], expected: CHANNEL_NOT_PUBLIC,
    },
    {
      name: "the channel row is deleted",
      sql: `delete from slack_sync_channels ${ITS_CHANNEL}`, params: channel,
      mustChange: ["slack_sync_channels"], mayChange: [], expected: BINDING_CHANGED,
    },
  ];

  it("enqueues the same fixture's entry when nothing has changed (control)", async () => {
    const label = "KR-09 control: nothing changed";
    const fx = await authorityRoot(label, await publishOldRoot());
    const before = await authorityDigests(fx.teamId);

    expect(await authorityPrepared(fx.teamId, fx.entry), `${label}: the entry is enqueued: the fixture is preparable as it stands`).toEqual({ outcome: "enqueued" });
    expect(authorityTablesThatDiffer(before, await authorityDigests(fx.teamId)), `${label}: of the snapshotted surfaces only the queue changed`).toEqual(["slack_sync_threads"]);
    expect(await authorityPendingCounts(), `${label}: one queue row, nothing staged`).toEqual(AUTHORITY_ONE_QUEUE_ROW);
    expect(JSON.stringify(fx.entry) === fx.entryBytes, `${label}: the entry is byte-identical`).toBe(true);
  });

  it.each(CHANGES.map((change): [string, AuthorityChange] => [change.name, change]))(
    "refuses the entry enumerated before the change with its exact closed reason, and writes nothing, after: %s", async (name, change) => {
      const label = `KR-09: ${name}`;
      const fx = await authorityRoot(label, await publishOldRoot());
      const beforeTheChange = await authorityDigests(fx.teamId);
      const only = change.onlyColumns;
      const rowBefore = only ? await rowBut(only, fx) : [];

      // ── THE ONE AUTHORITATIVE CHANGE, by labeled fixture DML, between enumeration and preparation. ──
      const written = await (await rawSql()).query(change.sql, change.params(fx));
      expect(written.rowCount, `${label}: fixture: the change wrote exactly one row`).toBe(1);
      // Where the case names the only columns that may change: every other column of that row is the same.
      const rowAfter = only ? await rowBut(only, fx) : [];
      expect(only ? {
        rows: [rowBefore.length, rowAfter.length],
        every_other_column_of_the_row_unchanged: rowBefore[0]?.rest === rowAfter[0]?.rest,
        named_columns_before: rowBefore[0]?.named, named_columns_now: rowAfter[0]?.named,
      } : NO_COLUMN_READBACK, `${label}: fixture: of the row the change updated, only the named columns changed, from and to exactly the named values`).toEqual(only ? {
        rows: [1, 1], every_other_column_of_the_row_unchanged: true, named_columns_before: only.from, named_columns_now: only.to,
      } : NO_COLUMN_READBACK);
      const altered = authorityTablesThatDiffer(beforeTheChange, await authorityDigests(fx.teamId));
      expect({
        surfaces_it_must_alter_and_did_not: change.mustChange.filter((table) => !altered.includes(table)),
        surfaces_it_altered_and_must_not: altered.filter((table) => !change.mustChange.includes(table) && !change.mayChange.includes(table)),
      }, `${label}: fixture: the change altered exactly the surfaces it is meant to alter`).toEqual({
        surfaces_it_must_alter_and_did_not: [], surfaces_it_altered_and_must_not: [],
      });

      await authorityRefusedWithNothingWritten(fx, label, change.expected);
    }
  );
});

/**
 * KR-09 and the permanent fixture of M6a — a STORED-SECRET rotation that preserves the configuration
 * revision (`docs/design/slack-known-root-requeue-spec.md` §11 "Stored-secret rotation fixture", §12 M6a).
 *
 * The specification's fixture, step by step. A synthetic 32-byte `SECRETS_KEY` is installed for the
 * whole case, and whatever was there before — present with its value, or absent — is put back in
 * `finally`. Under that key the real integration writer encrypts synthetic token A with the real
 * crypto helper; the real discovery, readiness and publication build the binding, the channel and
 * the gate for it; the real enumeration returns the entry; and the real `lockSlackSelection`, on a
 * transaction of its own, gives the authoritative selection, which is kept privately.
 *
 * THE ROTATION is one statement and nothing else: `update integrations set secret_ciphertext = …`
 * to a real encryption of a distinct synthetic token B. It is explicitly synthetic fixture
 * construction, NOT an approved rotation path. Read back afterwards, as booleans: `updated_at` is
 * the same to the microsecond; every column of the row but the secret is the same; no other
 * snapshotted surface — binding, channel, gate, readiness proof, item, ledger — changed; and the
 * real selection has the SAME configuration revision, still selects the channel, still takes its
 * token from the stored secret, and has a DIFFERENT effective-token fingerprint.
 *
 * So everything §5.1 requires is still true except one: the binding's fingerprint is no longer the
 * current token's. The entry enumerated before the rotation must be refused as `binding_changed`,
 * at the assertion labeled `M6a: …`, and nothing may be written. A preparation that had lost ONLY
 * the fingerprint comparison would find nothing else wrong, and — the witness being overdue — would
 * return `enqueued` there.
 *
 * THE CONTROL closes the argument from the other side: the ORIGINAL ciphertext is written back, the
 * real selection's fingerprint is the first one again, and the SAME entry is enqueued.
 *
 * No token, ciphertext, fingerprint or revision is ever handed to an assertion.
 */
describe("KR-09 stored-secret rotation with the configuration revision preserved (M6a)", () => {
  /** A synthetic 32-byte key, base64. Not a secret: thirty-two bytes of one fixed value. */
  const SYNTHETIC_SECRETS_KEY = Buffer.alloc(32, 0x4b).toString("base64");
  /** Synthetic token B. Token A is the one the publication fixture stores. */
  const ROTATED_SYNTHETIC_TOKEN = "xoxb-synthetic-known-root-rotated";
  const ENVIRONMENT = ["SECRETS_KEY"];

  it("refuses the entry enumerated before the rotation as binding_changed and writes nothing when only the stored secret changed, and enqueues that entry once the original secret is back (KR-09, M6a)", async () => {
    const label = "stored-secret rotation";
    const environmentBefore = authorityEnvironmentState(ENVIRONMENT);

    await authorityWithEnvironment(ENVIRONMENT, async () => {
      process.env.SECRETS_KEY = SYNTHETIC_SECRETS_KEY;
      // Token A is encrypted, by the real writer and the real crypto helper, under the synthetic key.
      const fx = await authorityRoot(label, await publishOldRoot());
      const integration = [fx.teamId, fx.integrationId];
      /** The authoritative selection, through the real lock, on a completed transaction of its own. PRIVATE. */
      const selection = async () => {
        const read = await tx((s) => lockSlackSelection(s, { teamId: fx.teamId, integrationId: fx.integrationId }));
        if (read.outcome !== "current") throw new Error("fixture: the integration's selection is not current");
        return read.selection;
      };
      /** The integration row, as digests and booleans computed by the database. PRIVATE but for the booleans. */
      const row = async () => (await query<{ updated_at_utc: string; all_but_the_secret: string; secret: string | null; has_secret: boolean }>(
        `select to_char(i.updated_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as updated_at_utc,
                md5((to_jsonb(i) - 'secret_ciphertext')::text) as all_but_the_secret,
                md5(i.secret_ciphertext) as secret, i.secret_ciphertext is not null as has_secret
           from integrations i where i.team_id = $1 and i.id = $2::uuid`, integration
      ))[0];

      const selectedBefore = await selection();
      const rowBefore = await row();
      expect({
        token_source: selectedBefore.tokenSource,
        has_a_stored_secret: rowBefore.has_secret,
        the_entry_carries_the_real_configuration_revision: selectedBefore.configRevision === fx.entry.locator.bindingConfigRevision,
        channel_selected: selectedBefore.channelIds.includes(CHANNEL),
      }, `${label}: fixture: before the rotation the token is the stored secret, and the entry's revision is the real selection's`).toEqual({
        token_source: "integration_secret", has_a_stored_secret: true, the_entry_carries_the_real_configuration_revision: true, channel_selected: true,
      });
      // PRIVATE: the original ciphertext, kept only to be written back for the control.
      const [{ original }] = await query<{ original: string }>(`select secret_ciphertext as original from integrations where team_id = $1 and id = $2::uuid`, integration);
      const beforeTheRotation = await authorityDigests(fx.teamId);

      // ── THE ROTATION: this one statement, and nothing else. SYNTHETIC FIXTURE CONSTRUCTION. ──
      const rotated = await (await rawSql()).query(
        `update integrations set secret_ciphertext = $3 where team_id = $1 and id = $2::uuid`, [...integration, encryptSecret(ROTATED_SYNTHETIC_TOKEN)]
      );
      expect(rotated.rowCount, `${label}: fixture: the rotation wrote exactly one row`).toBe(1);

      // ── READBACK: only the secret moved. ──
      const rowAfter = await row();
      const selectedAfter = await selection();
      expect(authorityTablesThatDiffer(beforeTheRotation, await authorityDigests(fx.teamId)), `${label}: fixture: the rotation altered the integration row and no other snapshotted surface`).toEqual(["integrations"]);
      expect({
        updated_at_unchanged_to_the_microsecond: rowAfter.updated_at_utc === rowBefore.updated_at_utc,
        every_column_but_the_secret_unchanged: rowAfter.all_but_the_secret === rowBefore.all_but_the_secret,
        stored_secret_changed: rowAfter.secret !== rowBefore.secret,
        still_has_a_stored_secret: rowAfter.has_secret,
      }, `${label}: fixture: of the integration row only the stored secret changed`).toEqual({
        updated_at_unchanged_to_the_microsecond: true, every_column_but_the_secret_unchanged: true, stored_secret_changed: true, still_has_a_stored_secret: true,
      });
      expect({
        token_source: selectedAfter.tokenSource,
        configuration_revision_unchanged: selectedAfter.configRevision === selectedBefore.configRevision,
        channel_still_selected: selectedAfter.channelIds.includes(CHANNEL),
        effective_token_fingerprint_changed: selectedAfter.tokenFingerprint !== selectedBefore.tokenFingerprint,
      }, `${label}: fixture: the real selection has the same configuration revision and a different effective token`).toEqual({
        token_source: "integration_secret", configuration_revision_unchanged: true, channel_still_selected: true, effective_token_fingerprint_changed: true,
      });

      // ── THE OLD ENTRY IS REFUSED, AND NOTHING IS WRITTEN. ──
      await authorityRefusedWithNothingWritten(fx, label, { outcome: "refused", reason: "binding_changed" },
        "M6a: after only the stored secret was rotated, with the configuration revision preserved, the entry enumerated before the rotation is refused as binding_changed and is not enqueued");

      // ── CONTROL: the original ciphertext written back. The same entry is enqueued. ──
      const restored = await (await rawSql()).query(`update integrations set secret_ciphertext = $3 where team_id = $1 and id = $2::uuid`, [...integration, original]);
      expect(restored.rowCount, `${label}: control: the original stored secret was written back to exactly one row`).toBe(1);
      const selectedAgain = await selection();
      expect([selectedAgain.tokenFingerprint === selectedBefore.tokenFingerprint, selectedAgain.configRevision === selectedBefore.configRevision],
        `${label}: control: the real selection has the first effective token and the same configuration revision again`).toEqual([true, true]);
      expect(await authorityPrepared(fx.teamId, fx.entry), `${label}: control: with the original secret back the same entry is enqueued, so every other authority fact was valid throughout`).toEqual({ outcome: "enqueued" });
      expect(await authorityPendingCounts(), `${label}: control: one queue row, nothing staged`).toEqual(AUTHORITY_ONE_QUEUE_ROW);
      expect(JSON.stringify(fx.entry) === fx.entryBytes, `${label}: the entry is byte-identical throughout`).toBe(true);
    });

    expect(authorityEnvironmentIsAs(ENVIRONMENT, environmentBefore), `${label}: SECRETS_KEY is exactly as it was before the case: present with its value, or absent`).toEqual([true]);
  });
});

/**
 * KR-09 — an ENVIRONMENT-FALLBACK token rotation, with no stored ciphertext
 * (`docs/design/slack-known-root-requeue-spec.md` §5.1, §11 "Stored-secret rotation fixture", last paragraph).
 *
 * Both spellings of the fallback variable, `SLACK_BOT_TOKEN` and `slack_bot_token`, are under this
 * case's control and are put back EXACTLY — present with its value, or absent — in `finally`. The
 * integration is created with NO secret. Discovery, readiness, the selection and the publication
 * all resolve the token the product's own way, from the environment: no `envToken` override is
 * passed anywhere in this case, and preparation has none to pass.
 *
 * WHAT IS SHOWN, each step read through the real `resolveEnvSlackToken` and the real
 * `lockSlackSelection`, and reported as booleans:
 *
 *   precedence     with both spellings set to different tokens, the upper-case one is effective;
 *   not a rotation changing ONLY the lower-case spelling leaves the effective token as it was;
 *   rotation       changing the upper-case spelling changes the effective token, with the
 *                  configuration revision and the integration row unchanged — the old entry is
 *                  refused as `binding_changed`;
 *   fallback       with the upper-case spelling REMOVED the lower-case one becomes effective, which
 *                  is again another token — refused as `binding_changed`;
 *   no token       with both removed there is no token at all — refused as `source_not_current`;
 *   control        with the first token back in the upper-case spelling, the same entry is enqueued.
 *
 * No fingerprint is compared with a constant of this file: every comparison is between two values
 * the real resolution returned.
 */
describe("KR-09 environment-fallback token rotation", () => {
  const UPPER = "SLACK_BOT_TOKEN";
  const LOWER = "slack_bot_token";
  const ENVIRONMENT = [UPPER, LOWER];
  const FIRST_TOKEN = "xoxb-synthetic-environment-first";
  const LOWER_ALIAS_TOKEN = "xoxb-synthetic-environment-lower-alias";
  const OTHER_LOWER_ALIAS_TOKEN = "xoxb-synthetic-environment-lower-alias-changed";
  const ROTATED_TOKEN = "xoxb-synthetic-environment-rotated";

  /**
   * `publishOldRoot` for an integration with NO stored secret: the same real steps, with the token
   * resolved from the environment by the product itself at every one of them.
   */
  async function publishedFromTheEnvironmentToken(): Promise<Published> {
    const seed = await seedTeam();
    const integrationId = await seedSlackIntegration(seed, { channelIds: [CHANNEL] });
    const fake = fakeSlack({
      "auth.test": () => slackJson(authTestBody({ app_id: "A0SOURCE1" })),
      "conversations.info": () => slackJson(channelInfoBody(CHANNEL)),
      "conversations.history": () => slackJson(historyBody({ messages: [] })),
    });
    const discovered = await discoverSlackSource({ db: db(), teamId: seed.teamId, integrationId }, { fetchImpl: fake.impl });
    if (discovered.binding?.state !== "verified") throw new Error("fixture: the binding did not verify from the environment token");
    const gate = await tx((s) => prepareNewSlackChannelNamespace(s, { teamId: seed.teamId, rawChannelId: CHANNEL }));
    if (gate.outcome !== "ready") throw new Error("fixture: the namespace is not ready");
    const selection = await tx((s) => lockSlackSelection(s, { teamId: seed.teamId, integrationId }));
    if (selection.outcome !== "current") throw new Error("fixture: the selection is not current");

    const scope = { teamId: seed.teamId, workspaceId: WORKSPACE, channelId: CHANNEL, rootTs: OLD_ROOT };
    await tx((s) => enqueueSlackThread(s, scope));
    const acquired = await tx((s) => claimSlackThread(s, scope, { leaseMs: 900_000 }));
    if (!acquired) throw new Error("fixture: the claim was refused");
    const staged = await tx(async (s) => {
      const written = await writeSlackThreadSnapshot(s, acquired, {
        messages: [ROOT_MESSAGE, REPLY_MESSAGE], complete: true, expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      });
      if (written !== "written") throw new Error("fixture: the snapshot was refused");
      return checkpointSlackThread(s, acquired, { pageCursor: null, snapshotGeneration: 1 });
    });
    if (staged.outcome !== "checkpointed") throw new Error("fixture: the checkpoint was refused");
    const claim: SlackThreadClaim = { ...acquired, snapshotGeneration: 1 };
    const option = slackPublicationOption({
      claim, binding: slackBindingRef(selection.selection), namespaceRevision: gate.gate.revision, channelName: "general", users: USERS,
    });
    const normalized = normalizeThread({ root: ROOT_MESSAGE, replies: [REPLY_MESSAGE] }, {
      channelId: CHANNEL, channelName: "general", users: { U1: "Person One" }, project: "slack",
    });
    const payload = {
      ...normalized,
      path: scopedSlackItemPath(WORKSPACE, CHANNEL, OLD_ROOT),
      frontmatter: { ...normalized.frontmatter, workspace_id: WORKSPACE, source_ts: parseSlackTimestamp(OLD_ROOT)!.iso },
    };
    const auth = { teamId: seed.teamId, memberId: seed.memberId, apiKeyId: randomUUID() };
    const published = await ingestItem(db(), auth, payload, "team", { authorMemberId: null }, "team", option);
    if ((published as { status?: unknown }).status !== "created") throw new Error("fixture: the real publication did not create the item");
    const items = await query<{ id: string }>(`select id::text as id from items where team_id = $1 and path = $2`, [
      seed.teamId, scopedSlackItemPath(WORKSPACE, CHANNEL, OLD_ROOT),
    ]);
    if (items.length !== 1) throw new Error("fixture: there is not exactly one canonical item");
    return { seed, integrationId, fake, itemId: items[0].id, namespaceRevision: gate.gate.revision, answerHistory: () => undefined };
  }

  it("resolves the upper-case spelling first, refuses the entry enumerated before the effective token changed and writes nothing, and enqueues that entry once the first token is back (KR-09)", async () => {
    const label = "environment-fallback rotation";
    const environmentBefore = authorityEnvironmentState(ENVIRONMENT);

    await authorityWithEnvironment(ENVIRONMENT, async () => {
      // BOTH SPELLINGS SET, to different synthetic tokens.
      process.env[UPPER] = FIRST_TOKEN;
      process.env[LOWER] = LOWER_ALIAS_TOKEN;
      const fx = await authorityRoot(label, await publishedFromTheEnvironmentToken());
      const integration = [fx.teamId, fx.integrationId];
      /** The real selection read, on a completed transaction of its own, with the product's own token resolution. PRIVATE. */
      const selectionRead = () => tx((s) => lockSlackSelection(s, { teamId: fx.teamId, integrationId: fx.integrationId }));
      const selection = async () => {
        const read = await selectionRead();
        if (read.outcome !== "current") throw new Error("fixture: the integration's selection is not current");
        return read.selection;
      };
      const row = async () => (await query<{ updated_at_utc: string; whole_row: string; has_secret: boolean }>(
        `select to_char(i.updated_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as updated_at_utc,
                md5(to_jsonb(i)::text) as whole_row, i.secret_ciphertext is not null as has_secret
           from integrations i where i.team_id = $1 and i.id = $2::uuid`, integration
      ))[0];

      // ── PRECEDENCE: the upper-case spelling is the effective token. ──
      const first = await selection();
      const rowAtFirst = await row();
      expect({
        has_a_stored_secret: rowAtFirst.has_secret,
        token_source: first.tokenSource,
        the_resolved_token_is_the_upper_case_spelling: resolveEnvSlackToken() === process.env[UPPER],
        the_resolved_token_is_the_lower_case_spelling: resolveEnvSlackToken() === process.env[LOWER],
        the_entry_carries_the_real_configuration_revision: first.configRevision === fx.entry.locator.bindingConfigRevision,
      }, `${label}: fixture: no stored secret; with both spellings set the upper-case one is the effective token`).toEqual({
        has_a_stored_secret: false, token_source: "env", the_resolved_token_is_the_upper_case_spelling: true,
        the_resolved_token_is_the_lower_case_spelling: false, the_entry_carries_the_real_configuration_revision: true,
      });
      const atTheStart = await authorityDigests(fx.teamId);
      /** Against the first selection and the first row: what an environment change did and did not move. */
      const moved = async () => {
        const now = await selection();
        const rowNow = await row();
        return {
          token_source: now.tokenSource,
          effective_token_changed: now.tokenFingerprint !== first.tokenFingerprint,
          configuration_revision_unchanged: now.configRevision === first.configRevision,
          integration_row_unchanged: rowNow.whole_row === rowAtFirst.whole_row && rowNow.updated_at_utc === rowAtFirst.updated_at_utc,
          snapshotted_surfaces_altered: authorityTablesThatDiffer(atTheStart, await authorityDigests(fx.teamId)),
        };
      };
      const ROTATED = { token_source: "env", effective_token_changed: true, configuration_revision_unchanged: true, integration_row_unchanged: true, snapshotted_surfaces_altered: [] };

      // ── NOT A ROTATION: only the lower-case spelling changes. ──
      process.env[LOWER] = OTHER_LOWER_ALIAS_TOKEN;
      expect(await moved(), `${label}: changing only the lower-case spelling leaves the effective token as it was`).toEqual({ ...ROTATED, effective_token_changed: false });

      // ── ROTATION: the upper-case spelling changes. Nothing stored changed. ──
      process.env[UPPER] = ROTATED_TOKEN;
      expect(await moved(), `${label}: changing the upper-case spelling changes the effective token, and no stored row`).toEqual(ROTATED);
      await authorityRefusedWithNothingWritten(fx, `${label}: upper-case spelling rotated`, { outcome: "refused", reason: "binding_changed" });

      // ── FALLBACK: the upper-case spelling REMOVED. The lower-case one is now the effective token. ──
      delete process.env[UPPER];
      expect([resolveEnvSlackToken() === process.env[LOWER], Object.prototype.hasOwnProperty.call(process.env, UPPER)],
        `${label}: with the upper-case spelling removed the lower-case one is resolved`).toEqual([true, false]);
      expect(await moved(), `${label}: the lower-case spelling's token is another effective token, and no stored row changed`).toEqual(ROTATED);
      await authorityRefusedWithNothingWritten(fx, `${label}: upper-case spelling removed`, { outcome: "refused", reason: "binding_changed" });

      // ── NO TOKEN AT ALL: both spellings removed. ──
      delete process.env[LOWER];
      const none = await selectionRead();
      expect([resolveEnvSlackToken() === null, none.outcome], `${label}: with both spellings removed and no stored secret there is no token`).toEqual([true, "no_token"]);
      await authorityRefusedWithNothingWritten(fx, `${label}: no token at all`, { outcome: "refused", reason: "source_not_current" });

      // ── CONTROL: the first token back in the upper-case spelling. The same entry is enqueued. ──
      process.env[UPPER] = FIRST_TOKEN;
      expect(await moved(), `${label}: control: with the first token back the effective token is the first one again`).toEqual({ ...ROTATED, effective_token_changed: false });
      expect(await authorityPrepared(fx.teamId, fx.entry), `${label}: control: with the first token back the same entry is enqueued, so every other authority fact was valid throughout`).toEqual({ outcome: "enqueued" });
      expect(await authorityPendingCounts(), `${label}: control: one queue row, nothing staged`).toEqual(AUTHORITY_ONE_QUEUE_ROW);
      expect(JSON.stringify(fx.entry) === fx.entryBytes, `${label}: the entry is byte-identical throughout`).toBe(true);
    });

    expect(authorityEnvironmentIsAs(ENVIRONMENT, environmentBefore), `${label}: both spellings are exactly as they were before the case: present with their values, or absent`).toEqual([true, true]);
  });
});

/**
 * KR-09 and the permanent fixture of M6b — the namespace gate is invalidated, and then made ready
 * again at a GREATER revision, between enumeration and preparation
 * (`docs/design/slack-known-root-requeue-spec.md` §4.1, §5.1, §11 "Namespace rereadiness fixture", §12 M6b).
 *
 * INVALIDATION is the real `invalidateSlackNamespaceGate`. REREADINESS is a TEST-ONLY, schema-valid
 * fixture, labeled where it is written: a readiness proof row at the new revision, copied from the
 * proof the real producer wrote at the old one, and the gate row set ready at that revision with
 * that proof. The real empty-new-channel producer is NOT used for it: this channel has a canonical
 * item, which is exactly what that producer refuses. The proof's kind is the only one the schema
 * admits, and here it attests nothing: it is a structural fixture, not the producer's verdict.
 *
 * FIRST CASE — invalidated only. The old entry is refused; and so is a FRESH entry, enumerated
 * while the gate is blocked, because enumeration reports a revision and proves no readiness.
 *
 * SECOND CASE — invalidated, then ready again at a greater revision. Every authority fact is valid
 * again, and the workspace is ready again; only the revision the old entry was enumerated at is no
 * longer the gate's. The old entry must be refused as `namespace_changed_or_unready`, at the
 * assertion labeled `M6b: …`, with nothing written and its bytes unchanged. A preparation that
 * read the gate's revision afresh instead of using the entry's would find the gate ready at the
 * revision it had just read and — the witness being overdue — would return `enqueued` there.
 * THE CONTROL: a FRESH enumeration returns the same entry but for the greater revision, and that
 * entry is enqueued.
 */
describe("KR-09 namespace invalidation and rereadiness (M6b)", () => {
  const INVALIDATION_REASON = "kr09_fixture_invalidation";
  const NAMESPACE_REFUSED: SlackKnownRootPreparationResult = { outcome: "refused", reason: "namespace_changed_or_unready" };
  const gateScope = (fx: AuthorityFixture) => ({ teamId: fx.teamId, rawChannelId: CHANNEL });
  /** The gate row, as booleans and one count, against the revision the old entry carries. */
  const gateFacts = (fx: AuthorityFixture, proofId: string | null): Promise<Row[]> => query(
    `select g.state, g.revision > $3::bigint as revision_is_greater_than_the_entrys,
            g.ready_revision is not distinct from g.revision as ready_at_its_current_revision,
            g.resolved_workspace_ids = array[$4]::text[] as resolves_exactly_the_published_workspace,
            g.completed_repair_id is not distinct from $5::uuid as completed_by_the_fixture_proof,
            (select count(*)::int from slack_namespace_readiness_proofs p where p.team_id = g.team_id and p.raw_channel_id = g.raw_channel_id) as proofs
       from slack_channel_migration_gates g where g.team_id = $1 and g.raw_channel_id = $2`,
    [fx.teamId, CHANNEL, fx.entry.locator.namespaceRevision, WORKSPACE, proofId]
  );
  /** A fresh enumeration's one entry, and whether it is the old entry but for its namespace revision. */
  async function freshEntry(fx: AuthorityFixture, label: string): Promise<{ entry: AuthorityLocatedEntry; facts: Record<string, boolean> }> {
    const page = await enumPage(fx.teamId, 100);
    const entry = page.entries[0];
    if (page.entries.length !== 1 || entry === undefined || !("locator" in entry)) throw new Error(`fixture: ${label}: the fresh enumeration returned no single located entry`);
    const butForTheRevision = (candidate: AuthorityLocatedEntry): string => JSON.stringify({ ...candidate, locator: { ...candidate.locator, namespaceRevision: null } });
    return {
      entry,
      facts: {
        same_entry_but_for_the_namespace_revision: butForTheRevision(entry) === butForTheRevision(fx.entry),
        carries_a_greater_namespace_revision: entry.locator.namespaceRevision > fx.entry.locator.namespaceRevision,
      },
    };
  }

  it("refuses the entry enumerated before the namespace was invalidated, and a fresh entry enumerated while it is blocked, and writes nothing (KR-09)", async () => {
    const label = "namespace invalidated";
    const fx = await authorityRoot(label, await publishOldRoot());
    const beforeTheChange = await authorityDigests(fx.teamId);

    // ── THE REAL INVALIDATOR. ──
    const invalidated = await tx((s) => invalidateSlackNamespaceGate(s, gateScope(fx), INVALIDATION_REASON));
    expect([invalidated.state, invalidated.revision > fx.entry.locator.namespaceRevision, invalidated.readyRevision === null, invalidated.resolvedWorkspaceIds.length],
      `${label}: fixture: the real invalidator left the gate blocked, at a greater revision, with no readiness`).toEqual(["blocked", true, true, 0]);
    expect(authorityTablesThatDiffer(beforeTheChange, await authorityDigests(fx.teamId)), `${label}: fixture: the invalidation altered the gate and no other snapshotted surface`).toEqual(["slack_channel_migration_gates"]);

    await authorityRefusedWithNothingWritten(fx, label, NAMESPACE_REFUSED);

    // A FRESH entry, enumerated while the gate is blocked: located, at the greater revision, and refused too.
    const fresh = await freshEntry(fx, label);
    expect(fresh.facts, `${label}: a fresh enumeration returns the same entry but for a greater namespace revision`).toEqual({
      same_entry_but_for_the_namespace_revision: true, carries_a_greater_namespace_revision: true,
    });
    await authorityRefusedWithNothingWritten({ ...fx, entry: fresh.entry, entryBytes: JSON.stringify(fresh.entry) }, `${label}: fresh entry, gate still blocked`, NAMESPACE_REFUSED);
  });

  it("refuses the entry enumerated before the namespace was invalidated and made ready again at a greater revision, writes nothing, and enqueues a freshly enumerated entry (KR-09, M6b)", async () => {
    const label = "namespace invalidated and ready again";
    const fx = await authorityRoot(label, await publishOldRoot());
    const beforeTheChange = await authorityDigests(fx.teamId);
    expect(await gateFacts(fx, null), `${label}: fixture: before the change the gate is ready at the entry's revision, by the real producer's one proof`).toEqual([{
      state: "ready", revision_is_greater_than_the_entrys: false, ready_at_its_current_revision: true,
      resolves_exactly_the_published_workspace: true, completed_by_the_fixture_proof: false, proofs: 1,
    }]);

    // ── 1. THE REAL INVALIDATOR. ──
    const invalidated = await tx((s) => invalidateSlackNamespaceGate(s, gateScope(fx), INVALIDATION_REASON));
    expect([invalidated.state, invalidated.revision > fx.entry.locator.namespaceRevision], `${label}: fixture: the real invalidator left the gate blocked at a greater revision`).toEqual(["blocked", true]);

    // ── 2. TEST-ONLY READINESS FIXTURE at that greater revision. Schema-valid, and NOT the producer:
    //       a proof row copied from the real producer's proof of the old revision, and the gate set
    //       ready at the new revision with it. ──
    const raw = await rawSql();
    const proof = await raw.query<{ id: string }>(
      `insert into slack_namespace_readiness_proofs
              (team_id, raw_channel_id, gate_revision, workspace_id, integration_id, binding_id, config_revision, public_checked_at, legacy_rows_found)
       select p.team_id, p.raw_channel_id, $4::bigint, p.workspace_id, p.integration_id, p.binding_id, p.config_revision, p.public_checked_at, 0
         from slack_namespace_readiness_proofs p
        where p.team_id = $1 and p.raw_channel_id = $2 and p.gate_revision = $3::bigint
    returning id::text as id`,
      [fx.teamId, CHANNEL, fx.entry.locator.namespaceRevision, invalidated.revision]
    );
    expect(proof.rowCount, `${label}: fixture: one readiness proof row was written at the greater revision`).toBe(1);
    const ready = await raw.query(
      `update slack_channel_migration_gates
          set state = 'ready', ready_revision = revision, resolved_workspace_ids = array[$3]::text[],
              completed_repair_id = $4::uuid, blocked_reason = null, updated_at = clock_timestamp()
        where team_id = $1 and raw_channel_id = $2 and state = 'blocked' and revision = $5::bigint`,
      [fx.teamId, CHANNEL, WORKSPACE, proof.rows[0].id, invalidated.revision]
    );
    expect(ready.rowCount, `${label}: fixture: the gate row was set ready at the greater revision`).toBe(1);

    // ── READBACK: ready again, at a GREATER revision, for the same workspace; nothing else moved. ──
    expect(await gateFacts(fx, proof.rows[0].id), `${label}: fixture: the gate is ready again at a greater revision than the entry's, for the published workspace, by the fixture's proof`).toEqual([{
      state: "ready", revision_is_greater_than_the_entrys: true, ready_at_its_current_revision: true,
      resolves_exactly_the_published_workspace: true, completed_by_the_fixture_proof: true, proofs: 2,
    }]);
    expect(authorityTablesThatDiffer(beforeTheChange, await authorityDigests(fx.teamId)), `${label}: fixture: the gate and its readiness proofs are the only snapshotted surfaces that differ from before the change`)
      .toEqual(["slack_channel_migration_gates", "slack_namespace_readiness_proofs"]);

    // ── THE OLD ENTRY IS REFUSED, AND NOTHING IS WRITTEN. ──
    await authorityRefusedWithNothingWritten(fx, label, NAMESPACE_REFUSED,
      "M6b: after the namespace was invalidated and made ready again at a greater revision, the entry enumerated at the old revision is refused as namespace_changed_or_unready and is not enqueued");

    // ── CONTROL: a FRESH enumeration carries the greater revision, and that entry is enqueued. ──
    const fresh = await freshEntry(fx, label);
    expect(fresh.facts, `${label}: control: a fresh enumeration returns the same entry but for a greater namespace revision`).toEqual({
      same_entry_but_for_the_namespace_revision: true, carries_a_greater_namespace_revision: true,
    });
    expect(await authorityPrepared(fx.teamId, fresh.entry), `${label}: control: the freshly enumerated entry is enqueued, so every other authority fact was valid throughout`).toEqual({ outcome: "enqueued" });
    expect(await authorityPendingCounts(), `${label}: control: one queue row, nothing staged`).toEqual(AUTHORITY_ONE_QUEUE_ROW);
    expect(JSON.stringify(fx.entry) === fx.entryBytes, `${label}: the old entry is byte-identical throughout`).toBe(true);
  });
});
