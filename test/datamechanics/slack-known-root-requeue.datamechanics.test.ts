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
