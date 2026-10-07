import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { SqlExecutor, TransactionSession } from "@/lib/db/types";
import { ingestItem } from "@/lib/ingest";
import {
  createSlackKnownRootExecution,
  readSlackKnownRootItemPage,
  type SlackKnownRootEntry,
  type SlackKnownRootExecution,
  type SlackKnownRootItemPage,
} from "@/lib/ingest/slack-known-root-page";
import { prepareSlackKnownRootRequeue, type SlackKnownRootPreparationResult } from "@/lib/ingest/slack-known-root-requeue";
import { prepareNewSlackChannelNamespace } from "@/lib/ingest/slack-namespace-gate";
import { slackPublicationOption } from "@/lib/ingest/slack-publication";
import { lockSlackSelection, slackBindingRef } from "@/lib/ingest/slack-source-binding";
import { discoverSlackSource } from "@/lib/ingest/slack-source-discovery";
import {
  checkpointSlackThread,
  claimSlackThread,
  enqueueSlackThread,
  writeSlackThreadSnapshot,
  type SlackThreadClaim,
} from "@/lib/ingest/slack-thread-state";
import type { SlackMessage } from "@/lib/ingest/sources/slack";
import { parseSlackTimestamp } from "@/lib/ingest/sources/slack-message-evidence";
import { scopedSlackItemPath } from "@/lib/ingest/sources/slack-namespace";
import { normalizeThread } from "@/lib/ingest/sources/slack-normalize";
import { transactionCapability } from "@/lib/projects/context/transaction";
import { db, ingest, seedTeam, type Seed } from "./helpers";
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

/** A canonical old root, published through the real publication into a channel whose history is complete. */
async function publishOldRoot(): Promise<Published> {
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
  let capacity: Capacity;

  // The fixture is built by the two hooks below, before each of the two cases: the global setup
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

  // SECOND HALF: 600 synthetic canonical roots in the SAME workspace and channel, the ledger of all
  // 601 roots, exact readbacks, and statistics.
  beforeEach(async () => {
    const { teamId, realItemId, realPath, slackProjectId, capacityProjectId, frontmatter } = loading;
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

    // STATISTICS COLLECTION, the last step before anything is measured. ANALYZE only: no VACUUM, no
    // planner setting, no index.
    const analyzed = "items, slack_messages, slack_sync_threads, slack_sync_channels, slack_channel_migration_gates, slack_integration_bindings, integrations, projects";
    await raw.query(`analyze ${analyzed}`);
    capacity = {
      f: loading.f, teamId, realItemId, realPath, slackProjectId, capacityProjectId,
      cardinalities: { items, messages, threadsWithACompleteCohort: shape.threads, workspace: "one", channel: "one", reallyPublishedRoots: 1, syntheticRoots: KR17.syntheticRoots },
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
