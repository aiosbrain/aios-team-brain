import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import type { TransactionSession } from "@/lib/db/types";
import { ingestItem } from "@/lib/ingest";
import {
  createSlackKnownRootExecution,
  readSlackKnownRootItemPage,
  type SlackKnownRootEntry,
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
 * FIRST RED CHECKPOINT. The two new modules are typed stubs that do no work. The first case below is
 * a permanent CHARACTERIZATION of the gap and passes before and after this slice. The other two are
 * behavioural red: they import, set up, connect and run normally, and fail only on the assertion
 * that the enumeration found the published root and that preparation rebuilt its pending row.
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

  // BEHAVIOURAL RED against the stub reader, which returns a placeholder page with no entries.
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

  // BEHAVIOURAL RED (KR-01). Against the stub reader there is no entry to prepare; against a real
  // reader and the no-op stub preparer there is an entry and still no row. Either way the failing
  // assertion is the same one: the old root's pending row was not rebuilt.
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
});
