import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { visibleItemIdsForProjects } from "@/lib/access/enforce";
import { resolveContentAdmission, type ContentAdmission } from "@/lib/access/admission";
import { ITEM_LIMIT } from "@/lib/dashboard/work-timeline";
import type { PersonDay, TaskGroup, TimelineDay } from "@/lib/dashboard/timeline-group";
import { PgClient } from "@/lib/db/pg/client";
import { runSql } from "@/lib/db/pg/pool";
import type { SqlExecutor, TransactionSession } from "@/lib/db/types";
import { removeMemberIdentity, setMemberIdentity } from "@/lib/identity/member-identities";
import { applyAttributionCorrection } from "@/lib/ingest/attribution-correction";
import { reconcileCompleteSlackThreadEvidence } from "@/lib/ingest/slack-message-ledger";
import { projectSlackMessageEvidence } from "@/lib/ingest/sources/slack-message-evidence";
import { backfillTeamContext } from "@/lib/projects/context/backfill";
import { transactionCapability } from "@/lib/projects/context/transaction";
import { db, ingest, seedTeam, type Seed } from "./helpers";

/**
 * AIO-1170 AC-09 — the inactive aggregate Slack page reader on REAL Postgres
 * (`lib/ingest/slack-person-day-page-read.ts`), and the complete drain over it.
 *
 * What only a real database can show: that a page is cut from completed `(item, member, UTC day)`
 * groups and not from a capped item set; that the cut survives a non-UTC session, exact-microsecond
 * ties and a group whose messages span many internal batches; that a correction, a roster change, a
 * provenance change or a membership revocation committed by the REAL writer between two pages — or
 * between a page's evidence read and its publication — is seen, and stops the traversal.
 *
 * Fixture rules:
 *  - Authorization is never faked. `loadAdmission` here resolves the real admission and calls the
 *    real `visibleItemIdsForProjects` on the page's own transaction executor.
 *  - Correction owner and lock are never supplied by a dependency: only the packet's own session
 *    reader can know them, so the real `applyAttributionCorrection` is what the tests change.
 *  - No generation is stamped by hand. A test that needs a generation to move calls the supported
 *    ledger or identity writer; a test that needs an UNSTAMPED change says so and relies on digests.
 *  - Source admission, provenance proofs, presentation and composition are injected seams. Tests of
 *    those are seam tests of the packet's obligations, not production AC-11 or presentation proof.
 *
 * Modules are loaded per test through a non-literal specifier so each case fails on its own.
 */

const REPO = join(import.meta.dirname, "..", "..");
const READER_FILE = join(REPO, "lib/ingest/slack-person-day-page-read.ts");
const CONTRACT_FILE = join(REPO, "lib/dashboard/slack-timeline-page-contract.ts");
const DRAIN_FILE = join(REPO, "lib/dashboard/slack-timeline-drain.ts");

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- the modules under test do not exist yet
type Loose = Record<string, any>;
type Json = Record<string, unknown>;

const reader = async (): Promise<Loose> => (await import(/* @vite-ignore */ READER_FILE)) as Loose;
const contract = async (): Promise<Loose> => (await import(/* @vite-ignore */ CONTRACT_FILE)) as Loose;
const drain = async (): Promise<Loose> => (await import(/* @vite-ignore */ DRAIN_FILE)) as Loose;

type FailureCode = "invalid_request" | "restart_required" | "unavailable" | "budget_exhausted";

async function failureOf(run: () => unknown): Promise<Json> {
  try {
    await run();
  } catch (error) {
    const e = error as Json;
    return { ...e, name: String(e?.name), code: String(e?.code), message: String(e?.message) };
  }
  throw new Error("expected a Slack timeline failure, but a page or result was returned");
}

async function expectFailure(run: () => unknown, code: FailureCode): Promise<Json> {
  const failure = await failureOf(run);
  expect(failure).toMatchObject({ name: "SlackTimelineError", code });
  expect(failure, "a failure carries no partial page").not.toHaveProperty("days");
  return failure;
}

const WORKSPACE = "TPAGE";
const HASH = "a".repeat(64);
const KEY = Buffer.alloc(32, 9);
const NOW_MS = Date.parse("2024-06-21T00:00:00.000Z");
const DAY_MS = 86_400_000;
const TTL_MS = 900_000;
const ms = (value: number): string => new Date(value).toISOString();

/** A Slack `ts` for an ISO second plus microseconds, and the exact instant the ledger stores for it. */
function ts(isoSecond: string, micro = 0): string {
  return `${Date.parse(`${isoSecond}Z`) / 1000}.${String(micro).padStart(6, "0")}`;
}
function instant(slackTs: string): string {
  const [seconds, micro] = slackTs.split(".");
  return `${new Date(Number(seconds) * 1000).toISOString().slice(0, 19)}.${micro}Z`;
}
const channelOf = (itemId: string): string => `CPAGE${itemId.replace(/-/g, "")}`;
const groupId = (itemId: string, memberId: string, day: string): string => JSON.stringify([itemId, memberId, day]);

// ── database fixtures ────────────────────────────────────────────────────────

async function slackItem(team: Seed, name: string): Promise<string> {
  return (await ingest(team, {
    path: `slack/${WORKSPACE}/CPAGE/${name}-${randomUUID().slice(0, 8)}.md`, body: name, access: "team",
    frontmatter: { source: "slack" },
  })).id;
}

async function githubItem(team: Seed, name: string): Promise<string> {
  return (await ingest(team, {
    path: `github/${name}-${randomUUID().slice(0, 8)}.md`, body: name, access: "team", frontmatter: { source: "github" },
  })).id;
}

/** Converge context units and memberships so the real oracle can see the fixtures. */
async function converge(team: Seed): Promise<void> {
  const result = await backfillTeamContext(db(), team.teamId);
  if (!result.ok) throw new Error(`fixture backfill failed: ${result.error}`);
}

/** Close an item's current memberships: its visibility changes, no project grant does. */
async function revokeMembership(itemId: string): Promise<void> {
  const { rowCount } = await runSql(
    `update project_context_memberships m set valid_to = now()
       from project_context_units u
      where u.id = m.context_unit_id and u.source_item_id = $1::uuid and m.valid_to is null`, [itemId]
  );
  if (rowCount < 1) throw new Error("fixture: the item had no current membership to revoke");
}

interface Person { id: string; email: string; name: string }

async function person(teamId: string, name: string, kind = "human", connector = false): Promise<Person> {
  const key = randomUUID();
  const email = `${key}@test.local`;
  const { rows } = await runSql<{ id: string }>(
    `insert into members (team_id,email,display_name,actor_handle,status,kind,is_connector)
     values ($1,$2,$3,$4,'active',$5,$6) returning id`,
    [teamId, email, name, `actor-${key}`, kind, connector]
  );
  return { id: rows[0].id, email, name };
}

/** A FIXTURE mapping row, written without the identity writer (and so without a generation bump). */
async function mapAccount(teamId: string, memberId: string, user: string, over: { provider?: string; external?: string } = {}): Promise<void> {
  await runSql(
    `insert into member_identities(team_id,member_id,provider,external_id) values($1,$2,$3,$4)`,
    [teamId, memberId, over.provider ?? "slack", over.external ?? `${WORKSPACE}:${user}`]
  );
}

interface MessageOptions { root?: string; user?: string | null; reason?: string | null; deleted?: boolean; workspace?: string; channel?: string }

/** One ledger row, exactly as the stored codec requires it. Seeding only — never a mid-test "writer". */
async function message(teamId: string, itemId: string, slackTs: string, options: MessageOptions = {}): Promise<void> {
  const reason = options.reason ?? null;
  await runSql(
    `insert into slack_messages
       (team_id,item_id,workspace_id,channel_id,message_ts,root_ts,author_external_id,
        occurred_at,is_root,eligible,exclusion_reason,deleted_at,source_hash)
     values ($1,$2::uuid,$3,$4,$5,$6,$7,
             to_timestamp(split_part($5,'.',1)::bigint) + split_part($5,'.',2)::integer * interval '1 microsecond',
             $5=$6,$8::text is null,$8,case when $9 then now() else null end,$10)`,
    [teamId, itemId, options.workspace ?? WORKSPACE, options.channel ?? channelOf(itemId), slackTs, options.root ?? slackTs,
      options.user === undefined ? "U1" : options.user, reason, options.deleted === true, HASH]
  );
}

const tx = <T>(fn: (session: TransactionSession) => Promise<T>): Promise<T> => transactionCapability(db()).transaction(fn);

/** The SUPPORTED ledger writer: a complete thread snapshot, which moves `dataGeneration` itself. */
async function publishThread(teamId: string, itemId: string, messages: { ts: string; user: string; thread_ts?: string }[]): Promise<void> {
  const users = Object.fromEntries(messages.map((m) => [m.user, { isBot: false, isAppUser: false }]));
  await tx((session) => reconcileCompleteSlackThreadEvidence(session, {
    teamId, itemId, workspaceId: WORKSPACE, channelId: channelOf(itemId), rootTs: messages[0].ts, complete: true,
    projection: projectSlackMessageEvidence(messages.map((m) => ({ ...m, text: "text" })), {
      scope: { workspaceId: WORKSPACE, channelId: channelOf(itemId) }, now: new Date(NOW_MS), users,
    }),
  }));
}

async function correct(team: Seed, itemId: string, toMember: string): Promise<void> {
  const result = await applyAttributionCorrection(
    db(), team.teamId, { kind: "reassign", match: { itemId }, toMember }, { memberId: team.memberId }, 1
  );
  expect(result, "the real correction writer applied").toMatchObject({ ok: true, updated: 1 });
}

// ── the injected server-only dependencies ────────────────────────────────────

interface TaskLink { taskId: string; title: string; status: string; backingItemId?: string }

interface World {
  team: Seed;
  nowMs: number;
  mono: number;
  roots: Map<string, string>;
  provenance: Map<string, Json>;
  denied: Set<string>;
  tasks: Map<string, TaskLink[]>;
  titles: Map<string, string>;
  nonSlack: { itemId: string; title: string; memberId: string }[];
  fail: { admission?: Error; presentation?: Error; initial?: Error };
  override: {
    admission?: (result: Json) => Json;
    initial?: (result: Json) => Json;
    compose?: (days: TimelineDay[], input: Json) => unknown;
  };
  seen: {
    aggregates: Json[][];
    admission: Json[];
    presentation: Json[];
    initial: number;
    snapshots: { label: string; pid: number; snapshot: string; isolation: string; readOnly: string }[];
  };
}

function world(team: Seed): World {
  return {
    team, nowMs: NOW_MS, mono: 0, roots: new Map(), provenance: new Map(), denied: new Set(), tasks: new Map(),
    titles: new Map(), nonSlack: [], fail: {}, override: {},
    seen: { aggregates: [], admission: [], presentation: [], initial: 0, snapshots: [] },
  };
}

function verified(w: World, itemId: string): Json {
  return {
    status: "verified", workspaceId: WORKSPACE, channelId: channelOf(itemId),
    rootTs: w.roots.get(itemId) ?? ts("2024-06-20T16:13:20", 1), workspaceUrl: null,
  };
}

async function observe(w: World, query: SqlExecutor, label: string): Promise<void> {
  const { rows } = await query<{ pid: number; snapshot: string; isolation: string; readOnly: string }>(
    `select pg_backend_pid() as pid, txid_current_snapshot()::text as snapshot,
            current_setting('transaction_isolation') as isolation,
            current_setting('transaction_read_only') as "readOnly"`
  );
  w.seen.snapshots.push({ label, ...rows[0] });
}

/** The real oracle, on the executor it is handed: the same snapshot as everything else on that page. */
async function oracleVisible(query: SqlExecutor, teamId: string, admission: ContentAdmission): Promise<Set<string>> {
  if (admission.kind !== "member") throw new Error("fixture: the principal is not a member");
  const visible = await visibleItemIdsForProjects(new PgClient({ executor: query, bound: true }), teamId, new Set(admission.grantedProjectIds));
  if (visible.error) throw new Error("fixture: access substrate read failed");
  return visible.ids;
}

function composeDays(aggregates: readonly Json[], presentation: Json, asOf: unknown): TimelineDay[] {
  const asOfDay = (asOf instanceof Date ? asOf.toISOString() : String(asOf)).slice(0, 10);
  const members = new Map((presentation.members as { id: string; name: string; handle: string }[]).map((m) => [m.id, m]));
  const titles = new Map((presentation.items as { itemId: string; title: string }[]).map((i) => [i.itemId, i.title]));
  const links = presentation.associations as { itemId: string; taskId: string; title: string; status: string }[];
  const days = new Map<string, Map<string, { tasks: Map<string, { link: Json; rows: Json[] }>; other: Json[] }>>();
  for (const a of aggregates) {
    const date = a.day as string;
    const people = days.get(date) ?? new Map();
    days.set(date, people);
    const p = people.get(a.memberId) ?? { tasks: new Map(), other: [] as Json[] };
    people.set(a.memberId, p);
    const row = {
      id: a.id, title: titles.get(a.sourceItemId as string) ?? "Slack thread", source: "slack",
      kind: a.rootAuthored ? "thread" : "reply", at: a.at, url: `/library/${a.sourceItemId}`,
    };
    const mine = links.filter((l) => l.itemId === a.sourceItemId);
    if (mine.length === 0) p.other.push(row);
    for (const link of mine) {
      const t = p.tasks.get(link.taskId) ?? { link, rows: [] as Json[] };
      p.tasks.set(link.taskId, t);
      t.rows.push(row);
    }
  }
  return [...days].map(([date, people]) => ({
    date, label: date === asOfDay ? "Today" : date,
    people: [...people].map(([memberId, p]): PersonDay => ({
      memberId, name: members.get(memberId)?.name ?? "Unknown", handle: members.get(memberId)?.handle ?? "", avatarUrl: null,
      total: 0, unlinked: 0, signals: [],
      tasks: [...p.tasks].map(([taskId, t]): TaskGroup => ({
        taskId, title: t.link.title as string, status: t.link.status as string, source: "linear", evidenceCount: t.rows.length,
        sources: [{ source: "slack", count: t.rows.length, items: t.rows as never[] }],
      })),
      other: p.other.length ? [{ source: "slack", count: p.other.length, items: p.other as never[] }] : [],
    })),
  }));
}

function dependencies(w: World, over: Json = {}): Json {
  return {
    slackTimelineCursorKey: KEY,
    now: () => new Date(w.nowMs),
    monotonicNow: () => w.mono,
    loadAdmission: async (query: SqlExecutor, input: { teamId: string; principal: { teamId: string; memberId: string }; requestedView: Json }) => {
      w.seen.admission.push(input as unknown as Json);
      await observe(w, query, "admission");
      if (w.fail.admission) throw w.fail.admission;
      const admission = await resolveContentAdmission(new PgClient({ executor: query, bound: true }), input.teamId, input.principal.memberId);
      const visible = await oracleVisible(query, input.teamId, admission);
      const { rows } = await query<{ id: string }>(
        `select id from items where team_id = $1::uuid and frontmatter->>'source' = 'slack' and id = any($2::uuid[]) order by id`,
        [input.teamId, [...visible]]
      );
      const result = {
        teamId: input.teamId, principalKey: `member:${input.principal.memberId}`, admission,
        admissionBinding: {
          kind: admission.kind, memberId: admission.memberId, posture: admission.posture,
          everyone: admission.kind === "member" ? admission.everyone : false,
          grantedProjectIds: admission.kind === "member" ? [...admission.grantedProjectIds].sort() : [],
        },
        slackItems: rows.filter((r) => !w.denied.has(r.id)).map((r) => ({ itemId: r.id, provenance: w.provenance.get(r.id) ?? verified(w, r.id) })),
        sourceAdmissionBinding: { denied: [...w.denied].sort() },
      };
      return w.override.admission ? w.override.admission(result) : result;
    },
    loadPresentation: async (query: SqlExecutor, input: { teamId: string; admission: ContentAdmission; slackItems: { itemId: string }[] } & Json) => {
      w.seen.presentation.push(input);
      await observe(w, query, "presentation");
      if (w.fail.presentation) throw w.fail.presentation;
      const ids = input.slackItems.map((i) => i.itemId);
      const items = await query<{ id: string; path: string }>(
        `select id, path from items where team_id = $1::uuid and id = any($2::uuid[]) order by id`, [input.teamId, ids]
      );
      const members = await query<{ id: string; name: string; handle: string }>(
        `select id, display_name as name, actor_handle as handle from members where team_id = $1::uuid order by id`, [input.teamId]
      );
      // A linked task is presented only when ITS backing item is visible to this admission, read
      // through the real oracle on this executor: seeing the Slack thread does not grant the task.
      const visible = await oracleVisible(query, input.teamId, input.admission);
      const associations = ids.flatMap((itemId) => (w.tasks.get(itemId) ?? [])
        .filter((t) => !t.backingItemId || visible.has(t.backingItemId))
        .map((t) => ({ itemId, taskId: t.taskId, title: t.title, status: t.status })));
      return {
        locale: "en-US", policyVersion: "1",
        items: items.rows.map((r) => ({ itemId: r.id, title: w.titles.get(r.id) ?? r.path })),
        members: members.rows, associations,
      };
    },
    composeSlackPage: (input: { aggregates: Json[]; presentation: Json; asOf: unknown }) => {
      w.seen.aggregates.push(input.aggregates.map((a) => ({ ...a })));
      const days = composeDays(input.aggregates, input.presentation, input.asOf);
      return w.override.compose ? w.override.compose(days, input as unknown as Json) : days;
    },
    loadInitialNonSlack: async (query: SqlExecutor, input: { teamId: string; admission: ContentAdmission }) => {
      w.seen.initial++;
      await observe(w, query, "initial");
      if (w.fail.initial) throw w.fail.initial;
      const visible = await oracleVisible(query, input.teamId, input.admission);
      const rows = w.nonSlack.filter((g) => visible.has(g.itemId));
      const result = {
        sourceItemIds: rows.map((g) => g.itemId),
        days: rows.length === 0 ? [] : [{
          date: "2024-06-20", label: "2024-06-20",
          people: [...new Set(rows.map((g) => g.memberId))].map((memberId) => {
            const mine = rows.filter((g) => g.memberId === memberId);
            return {
              memberId, name: "Tester", handle: "tester", avatarUrl: null, total: mine.length, unlinked: mine.length, tasks: [], signals: [],
              other: [{ source: "github", count: mine.length, items: mine.map((g) => ({ id: g.itemId, title: g.title, source: "github", kind: "pr", at: "2024-06-20T09:00:00Z" })) }],
            };
          }),
        }],
      };
      return w.override.initial ? w.override.initial(result) : result;
    },
    ...over,
  };
}

function request(w: World, over: Json = {}): Json {
  return {
    teamId: w.team.teamId, principal: { teamId: w.team.teamId, memberId: w.team.memberId },
    requestedView: { mode: "timeline", filters: {}, locale: "en-US", presentationPolicyVersion: "1" },
    windowDays: 7, pageSize: 128, cursor: null, ...over,
  };
}

async function page(w: World, over: Json = {}, options: Json = {}, deps: Json = {}): Promise<Loose> {
  return (await reader()).readSlackPersonDayPage(request(w, over), dependencies(w, deps), options);
}

interface Traversal { pages: Loose[]; ids: string[]; tuples: Json[]; compact: Json[] }

/** Follow cursors to the end, checking every per-page invariant on the way. */
async function traverse(w: World, pageSize: number, options: Json = {}): Promise<Traversal> {
  const c = await contract();
  const out: Traversal = { pages: [], ids: [], tuples: [], compact: [] };
  let cursor: string | null = null;
  for (let guard = 0; guard < 2000; guard++) {
    const before = w.seen.aggregates.length;
    const p = await page(w, { pageSize, cursor }, options);
    expect(w.seen.aggregates.length, "the composer ran exactly once for the page").toBe(before + 1);
    expect(p.aggregates.length).toBeLessThanOrEqual(pageSize);
    expect(p.slackComplete).toBe(p.nextSlackCursor === null);
    if (!p.slackComplete) expect(p.aggregates.length, "a nonterminal page is full").toBe(pageSize);
    expect(p.window_days).toBe(7);
    expect(p.binding.pageSize).toBe(pageSize);
    out.pages.push(p);
    out.ids.push(...p.aggregates.map((a: Json) => a.id));
    out.tuples.push(...p.aggregates.map((a: Json) => a.tuple));
    out.compact.push(...w.seen.aggregates[w.seen.aggregates.length - 1]);
    if (p.slackComplete) {
      for (let i = 1; i < out.tuples.length; i++) {
        expect(c.compareSlackAggregateTuples(out.tuples[i - 1], out.tuples[i]), "strict global aggregate order").toBeLessThan(0);
      }
      expect(new Set(out.ids).size, "each aggregate exactly once").toBe(out.ids.length);
      expect(out.compact.map((a) => a.id)).toEqual(out.ids);
      return out;
    }
    expect(c.decodeSlackTimelineCursor(p.nextSlackCursor, KEY).lastAggregateTuple).toEqual(p.aggregates[p.aggregates.length - 1].tuple);
    cursor = p.nextSlackCursor;
  }
  throw new Error("traversal did not terminate");
}

interface Scene { team: Seed; w: World; a: Person; b: Person; c: Person }

/** A team with three mapped humans: U1 → a, U2 → b, U3 → c. */
async function scene(): Promise<Scene> {
  const team = await seedTeam();
  const [a, b, c] = [await person(team.teamId, "Person A"), await person(team.teamId, "Person B"), await person(team.teamId, "Person C")];
  await mapAccount(team.teamId, a.id, "U1");
  await mapAccount(team.teamId, b.id, "U2");
  await mapAccount(team.teamId, c.id, "U3");
  return { team, w: world(team), a, b, c };
}

/** One thread whose root is `user`'s, with the root remembered for the provenance proof. */
async function thread(s: Scene, name: string, root: string, user = "U1"): Promise<string> {
  const id = await slackItem(s.team, name);
  s.w.roots.set(id, root);
  await message(s.team.teamId, id, root, { user });
  return id;
}

const D20 = "2024-06-20T16:13:20";
const D19 = "2024-06-19T16:13:20";
const D18 = "2024-06-18T16:13:20";

describe("aggregate Slack page — grain, order and saturation on real Postgres", () => {
  it("publishes conservative page budgets", async () => {
    expect((await reader()).SLACK_PERSON_DAY_PAGE_BUDGETS).toMatchObject({
      candidateFetchSize: 512, maxCandidates: 100_000, maxRows: 2_000_000,
      maxReadBytes: 128 * 1024 * 1024, maxPageBytes: 4 * 1024 * 1024, maxElapsedMs: 30_000,
    });
  });

  it("pages one thread's member/day groups, interleaved with other threads, in global order at sizes 1, 2 and 128", async () => {
    const s = await scene();
    // X: three members on three days (nine groups). Y and Z interleave between X's instants.
    const x = await thread(s, "x", ts(D18, 1));
    const users: [string, Person][] = [["U1", s.a], ["U2", s.b], ["U3", s.c]];
    const expected: { item: string; member: string; at: string }[] = [];
    for (const [d, isoSecond] of [D20, D19, D18].entries()) {
      for (const [u, [user, member]] of users.entries()) {
        const stamp = ts(isoSecond, 100 + 10 * u + d);
        await message(s.team.teamId, x, stamp, { root: ts(D18, 1), user });
        expected.push({ item: x, member: member.id, at: instant(stamp) });
      }
    }
    const y = await thread(s, "y", ts(D20, 105), "U2");
    const z = await thread(s, "z", ts(D19, 115), "U3");
    expected.push({ item: y, member: s.b.id, at: instant(ts(D20, 105)) }, { item: z, member: s.c.id, at: instant(ts(D19, 115)) });
    await converge(s.team);

    const cmp = (p: string, q: string): number => (p < q ? -1 : p > q ? 1 : 0);
    const order = [...expected].sort((p, q) =>
      cmp(q.at.slice(0, 10), p.at.slice(0, 10)) || cmp(q.at, p.at) || cmp(p.item, q.item) || cmp(p.member, q.member));
    const want = order.map((e) => ({ day: e.at.slice(0, 10), at: e.at, itemId: e.item, memberId: e.member }));
    for (const size of [1, 2, 128]) {
      const run = await traverse(world(s.team) && s.w, size);
      expect(run.tuples).toEqual(want);
      expect(run.pages).toHaveLength(size === 128 ? 1 : Math.floor(want.length / size) + 1);
    }
    // A's root on D18 is the same person-day as A's D18 reply: one group, both messages.
    const rootDay = (await traverse(s.w, 128)).compact.find((g) => g.id === groupId(x, s.a.id, "2024-06-18"));
    expect(rootDay).toMatchObject({ messageCount: 2, rootAuthored: true, linkMessage: { messageTs: ts(D18, 1) } });
  });

  it("never re-aggregates an emitted group from a later page (the reaggregation trap)", async () => {
    const s = await scene();
    const itemA = await thread(s, "a", ts("2024-06-20T10:00:00"), "U1");
    await message(s.team.teamId, itemA, ts("2024-06-20T11:00:00"), { root: ts("2024-06-20T10:00:00"), user: "U1" });
    const itemB = await thread(s, "b", ts("2024-06-20T10:30:00"), "U2");
    await converge(s.team);
    const run = await traverse(s.w, 1);
    expect(run.compact.map((g) => [g.sourceItemId, g.at, g.messageCount])).toEqual([
      [itemA, "2024-06-20T11:00:00.000000Z", 2],
      [itemB, "2024-06-20T10:30:00.000000Z", 1],
    ]);
    // A never comes back as (count 1, 10:00) once the cursor has passed 11:00.
    expect(run.ids.filter((id) => id === groupId(itemA, s.a.id, "2024-06-20"))).toHaveLength(1);
  });

  it("surfaces every visible aggregate past ITEM_LIMIT stale items and ITEM_LIMIT newer invisible ones", async () => {
    const s = await scene();
    const count = ITEM_LIMIT + 5;
    const visible: string[] = [];
    const hidden: string[] = [];
    for (let n = 0; n < count; n++) {
      // Old root, recent reply: discovery by item recency would rank these last.
      const id = await thread(s, `old-${n}`, ts("2024-01-10T10:00:00", n), "U1");
      await message(s.team.teamId, id, ts(D19, n), { root: ts("2024-01-10T10:00:00", n), user: "U2" });
      visible.push(id);
    }
    for (let n = 0; n < count; n++) hidden.push(await thread(s, `hidden-${n}`, ts(D20, 500 + n), "U1"));
    await converge(s.team);
    for (const id of hidden) await revokeMembership(id);
    // Misleading recency: the visible items look untouched for years, the hidden ones brand new.
    await runSql(`update items set synced_at = '2020-01-01', updated_at = '2020-01-01' where id = any($1::uuid[])`, [visible]);
    await runSql(`update items set synced_at = now(), updated_at = now() where id = any($1::uuid[])`, [hidden]);

    const run = await traverse(s.w, 7);
    expect(run.ids.sort()).toEqual(visible.map((id) => groupId(id, s.b.id, "2024-06-19")).sort());
    for (const g of run.compact) expect(g).toMatchObject({ messageCount: 1, rootAuthored: false });
    for (const id of hidden) expect(JSON.stringify(run.ids)).not.toContain(id);
  });

  it("groups by UTC day under a non-UTC session, across midnight and a DST change", async () => {
    const s = await scene();
    s.w.nowMs = Date.parse("2024-03-12T00:00:00.000Z");
    const root = ts("2024-03-09T23:59:59", 999_999);
    const id = await thread(s, "dst", root, "U1");
    for (const stamp of [ts("2024-03-10T00:00:00", 0), ts("2024-03-10T09:59:59", 999_999), ts("2024-03-10T10:00:00", 0), ts("2024-03-11T06:59:59", 0), ts("2024-03-11T07:00:00", 0)]) {
      await message(s.team.teamId, id, stamp, { root, user: "U1" });
    }
    await converge(s.team);
    for (const zone of ["America/Los_Angeles", "Pacific/Kiritimati", "UTC"]) {
      const run = await traverse(s.w, 1, {
        afterTransactionConfigured: async (query: SqlExecutor) => {
          await query(`set local time zone '${zone}'`);
          expect((await query<{ zone: string }>("select current_setting('TimeZone') as zone")).rows[0].zone).toBe(zone);
        },
      });
      expect(run.compact.map((g) => [g.day, g.messageCount, g.at])).toEqual([
        ["2024-03-11", 2, "2024-03-11T07:00:00.000000Z"],
        ["2024-03-10", 3, "2024-03-10T10:00:00.000000Z"],
        ["2024-03-09", 1, "2024-03-09T23:59:59.999999Z"],
      ]);
    }
  });

  it("advances exactly once through equal six-digit instants tied on item and member", async () => {
    const s = await scene();
    const stamp = ts(D20, 123_456);
    const items: string[] = [];
    for (let n = 0; n < 4; n++) {
      const id = await thread(s, `tie-${n}`, stamp, "U1");
      await message(s.team.teamId, id, ts(D20, 123_456).replace(/6$/, "6"), { root: stamp, user: "U1" }).catch(() => undefined);
      await message(s.team.teamId, id, ts(D20, 123_455), { root: stamp, user: "U2" });
      await message(s.team.teamId, id, `${stamp.slice(0, -1)}6`, { root: stamp, user: "U3" }).catch(() => undefined);
      items.push(id);
    }
    await converge(s.team);
    const run = await traverse(s.w, 1);
    const atStamp = run.tuples.filter((t) => t.at === instant(stamp));
    expect(atStamp.map((t) => t.itemId)).toEqual([...items].sort());
    expect(run.tuples).toHaveLength(8);
    for (const t of atStamp) expect(t.memberId).toBe(s.a.id);
  });

  it("counts only in-window, eligible, surviving messages, inclusively at both window bounds", async () => {
    const s = await scene();
    const since = "2024-06-14T00:00:00";
    const root = ts("2024-06-13T23:59:59", 999_999); // one microsecond before the window
    const id = await thread(s, "bounds", root, "U1");
    await message(s.team.teamId, id, ts(since, 0), { root, user: "U1" }); // exactly `since`: in
    await message(s.team.teamId, id, ts(since, 1), { root, user: "U1" });
    await message(s.team.teamId, id, ts("2024-06-21T00:00:00", 0), { root, user: "U2" }); // exactly `asOf`: in
    await message(s.team.teamId, id, ts("2024-06-21T00:00:00", 1), { root, user: "U2" }); // future: out
    await message(s.team.teamId, id, ts(D20, 1), { root, user: "U2", deleted: true });
    await message(s.team.teamId, id, ts(D20, 2), { root, user: "U2", reason: "bot_identity" });
    await message(s.team.teamId, id, ts(D20, 3), { root, user: null, reason: "no_author" });
    await converge(s.team);
    const run = await traverse(s.w, 128);
    expect(run.compact.map((g) => [g.memberId, g.day, g.messageCount, g.at, g.rootAuthored])).toEqual([
      [s.b.id, "2024-06-21", 1, "2024-06-21T00:00:00.000000Z", false],
      // The root is out of window, so the boundary-day group counts two messages and is not root-authored.
      [s.a.id, "2024-06-14", 2, "2024-06-14T00:00:00.000001Z", false],
    ]);
  });

  it("keeps an exact count and one defined link for a group spanning many internal message batches", async () => {
    const s = await scene();
    const root = ts(D20, 1);
    const big = await thread(s, "big", root, "U1");
    await runSql(
      `insert into slack_messages
         (team_id,item_id,workspace_id,channel_id,message_ts,root_ts,author_external_id,occurred_at,is_root,eligible,source_hash)
       select $1,$2::uuid,$3,$4, '1718900000.' || lpad((n + 10)::text, 6, '0'), $5, 'U1',
              to_timestamp(1718900000) + (n + 10) * interval '1 microsecond', false, true, $6
         from generate_series(1, 2500) n`,
      [s.team.teamId, big, WORKSPACE, channelOf(big), root, HASH]
    );
    // A second thread: the root was deleted, replies survive.
    const gone = ts(D19, 1);
    const orphan = await slackItem(s.team, "orphan");
    s.w.roots.set(orphan, gone);
    await message(s.team.teamId, orphan, gone, { user: "U1", deleted: true });
    await message(s.team.teamId, orphan, ts(D19, 20), { root: gone, user: "U1" });
    await message(s.team.teamId, orphan, ts(D19, 30), { root: gone, user: "U1" });
    await converge(s.team);

    const run = await traverse(s.w, 128, { messagePageSize: 100, candidateFetchSize: 1 });
    const [bigGroup, orphanGroup] = run.compact;
    expect(bigGroup).toMatchObject({
      id: groupId(big, s.a.id, "2024-06-20"), messageCount: 2501, rootAuthored: true, rootTs: root,
      at: "2024-06-20T16:13:20.002510Z", linkMessage: { messageTs: root, occurredAt: instant(root) },
    });
    expect(orphanGroup).toMatchObject({
      id: groupId(orphan, s.a.id, "2024-06-19"), messageCount: 2, rootAuthored: false, rootTs: gone,
      linkMessage: { messageTs: ts(D19, 30), occurredAt: instant(ts(D19, 30)) },
    });
    for (const g of run.compact) {
      expect(Object.prototype.hasOwnProperty.call(g, "messages")).toBe(false);
      expect(Buffer.byteLength(JSON.stringify(g), "utf8")).toBeLessThanOrEqual(2048);
    }
    expect(Buffer.byteLength(run.pages[0].nextSlackCursor ?? "", "utf8")).toBeLessThanOrEqual(16 * 1024);
  });
});

describe("aggregate Slack page — identity and the shared credit oracle", () => {
  it("merges one person's accounts, credits a mapped replier under an unmapped root, and credits no ambiguous, foreign or nonhuman mapping", async () => {
    const s = await scene();
    const other = await seedTeam();
    const bot = await person(s.team.teamId, "Bot", "agent");
    const connector = await person(s.team.teamId, "Connector", "human", true);
    await mapAccount(s.team.teamId, s.a.id, "U1B"); // A's second account
    await mapAccount(s.team.teamId, bot.id, "UBOT");
    await mapAccount(s.team.teamId, connector.id, "UCONN");
    await mapAccount(other.teamId, other.memberId, "UFOREIGN"); // mapped, but in another team
    await mapAccount(s.team.teamId, s.b.id, "UCASE");
    await mapAccount(s.team.teamId, s.c.id, "UCASE", { external: `${WORKSPACE.toLowerCase()}:ucase` }); // case collision
    await mapAccount(s.team.teamId, s.b.id, "UPROV");
    await mapAccount(s.team.teamId, s.c.id, "UPROV", { provider: "Slack" }); // provider-variant collision

    const root = ts(D20, 1);
    const id = await thread(s, "identity", root, "UNMAPPED");
    const stamps: [string, number][] = [["U1", 10], ["U1B", 20], ["U2", 30], ["UBOT", 40], ["UCONN", 50], ["UFOREIGN", 60], ["UCASE", 70], ["UPROV", 80]];
    for (const [user, micro] of stamps) await message(s.team.teamId, id, ts(D20, micro), { root, user });
    await converge(s.team);

    const run = await traverse(s.w, 128);
    expect(run.compact.map((g) => [g.memberId, g.messageCount, g.rootAuthored, g.at])).toEqual([
      [s.b.id, 1, false, instant(ts(D20, 30))],
      // U1 and U1B are one person: one group, two messages, never two groups or two IDs.
      [s.a.id, 2, false, instant(ts(D20, 20))],
    ]);
  });

  it("requires restart after the real identity writer remaps or unlinks an account between pages", async () => {
    for (const change of ["remap", "unlink"] as const) {
      const s = await scene();
      const first = await thread(s, "one", ts(D20, 1), "U1");
      await thread(s, "two", ts(D19, 1), "U2");
      await converge(s.team);
      const one = await page(s.w, { pageSize: 1 });
      expect(one.aggregates.map((a: Json) => a.id)).toEqual([groupId(first, s.a.id, "2024-06-20")]);
      if (change === "remap") {
        await setMemberIdentity(db(), s.team.teamId, s.c.id, { provider: "slack", externalId: `${WORKSPACE}:U2` }, { force: true, explicit: true });
      } else {
        await removeMemberIdentity(db(), s.team.teamId, { provider: "slack", externalId: `${WORKSPACE}:U2` });
      }
      await expectFailure(() => page(s.w, { pageSize: 1, cursor: one.nextSlackCursor }), "restart_required");
      // A fresh traversal is bound to the new generation and shows the new truth.
      const fresh = await traverse(s.w, 1);
      expect(fresh.pages[0].binding.identityGeneration).not.toBe(one.binding.identityGeneration);
      expect(fresh.tuples.map((t) => t.memberId)).toEqual(change === "remap" ? [s.a.id, s.c.id] : [s.a.id]);
    }
  });

  it("catches a mapping row changed WITHOUT a generation bump through the complete mapping digest", async () => {
    const s = await scene();
    await thread(s, "one", ts(D20, 1), "U1");
    await thread(s, "two", ts(D19, 1), "U2");
    await converge(s.team);
    const one = await page(s.w, { pageSize: 1 });
    // Unstamped fixture mutation: a provider-variant row that makes U2 a collision. No writer ran.
    await mapAccount(s.team.teamId, s.c.id, "U2", { provider: "Slack" });
    const failure = await expectFailure(() => page(s.w, { pageSize: 1, cursor: one.nextSlackCursor }), "restart_required");
    expect(String(failure.message)).not.toContain(s.c.id);
    const fresh = await traverse(s.w, 1);
    expect(fresh.pages[0].binding.identityGeneration).toBe(one.binding.identityGeneration);
    expect(fresh.pages[0].binding.creditInputDigest).not.toBe(one.binding.creditInputDigest);
    expect(fresh.tuples.map((t) => t.memberId)).toEqual([s.a.id]);
  });
});

describe("aggregate Slack page — real corrections through the packet's own lock reader (B1 / N3)", () => {
  /** X has A on day D and B on day D-1; pageSize 1 puts the correction between the two groups. */
  async function corrected(): Promise<Scene & { x: string }> {
    const s = await scene();
    const x = await thread(s, "x", ts(D20, 1), "U1");
    await message(s.team.teamId, x, ts(D19, 1), { root: ts(D20, 1), user: "U2" });
    await converge(s.team);
    return { ...s, x };
  }

  it("locks to an owner with no messages: page two restarts, and the fresh answer emits nothing for X", async () => {
    const s = await corrected();
    const one = await page(s.w, { pageSize: 1 });
    expect(one.aggregates.map((a: Json) => a.id)).toEqual([groupId(s.x, s.a.id, "2024-06-20")]);
    const generations = [one.binding.dataGeneration, one.binding.identityGeneration, one.binding.presentationGeneration];
    await correct(s.team, s.x, s.c.email);
    await expectFailure(() => page(s.w, { pageSize: 1, cursor: one.nextSlackCursor }), "restart_required");
    const fresh = await traverse(s.w, 1);
    // The lock suppresses A and B and never transfers their messages to C.
    expect(fresh.ids).toEqual([]);
    // No Slack generation moved: only the credit-input digest could have seen this.
    expect([fresh.pages[0].binding.dataGeneration, fresh.pages[0].binding.identityGeneration, fresh.pages[0].binding.presentationGeneration]).toEqual(generations);
    expect(fresh.pages[0].binding.creditInputDigest).not.toBe(one.binding.creditInputDigest);
  });

  it("locks to an owner WITH their own message: only that owner's group survives", async () => {
    const s = await corrected();
    const one = await page(s.w, { pageSize: 1 });
    await correct(s.team, s.x, s.b.email);
    await expectFailure(() => page(s.w, { pageSize: 1, cursor: one.nextSlackCursor }), "restart_required");
    const fresh = await traverse(s.w, 1);
    expect(fresh.ids).toEqual([groupId(s.x, s.b.id, "2024-06-19")]);
    expect(fresh.compact[0]).toMatchObject({ messageCount: 1, rootAuthored: false });
  });

  it("clears the owner under a lock: nobody is credited, and the stale first page is never completed", async () => {
    const s = await corrected();
    const one = await page(s.w, { pageSize: 1 });
    await correct(s.team, s.x, "nobody");
    await expectFailure(() => page(s.w, { pageSize: 1, cursor: one.nextSlackCursor }), "restart_required");
    expect((await traverse(s.w, 1)).ids).toEqual([]);
  });

  it("does not let a dependency supply the owner or lock: only the session reader's row counts", async () => {
    const s = await corrected();
    await correct(s.team, s.x, s.c.email);
    // A lying admission adapter that claims the item is unlocked and owned by A changes nothing.
    s.w.override.admission = (result) => ({
      ...result,
      slackItems: (result.slackItems as Json[]).map((i) => ({ ...i, currentMemberId: s.a.id, locked: false, member_id: s.a.id, member_id_locked: false })),
    });
    expect((await traverse(s.w, 1)).ids).toEqual([]);
  });

  it("keeps a correction committed mid-evidence-read out of that snapshot, then restarts at validation", async () => {
    const s = await corrected();
    let digestBefore = "";
    const failure = await expectFailure(() => page(s.w, { pageSize: 1 }, {
      afterDiscovery: async (query: SqlExecutor) => {
        await correct(s.team, s.x, s.c.email); // committed on another connection
        // Same snapshot: the evidence transaction still sees the old owner and no lock.
        const { rows } = await query<{ locked: boolean }>(`select member_id_locked as locked from items where id = $1::uuid`, [s.x]);
        expect(rows[0].locked).toBe(false);
        digestBefore = "seen";
      },
    }), "restart_required");
    expect(digestBefore).toBe("seen");
    expect(JSON.stringify(failure)).not.toContain(groupId(s.x, s.a.id, "2024-06-20"));
    // The evidence was composed from the old snapshot, and was NOT published with a newer stamp.
    expect(s.w.seen.aggregates.at(-1)?.map((g) => g.id)).toEqual([groupId(s.x, s.a.id, "2024-06-20")]);
    expect((await traverse(s.w, 1)).ids).toEqual([]);
  });

  it("drains to the fully corrected output after one overtake, and throws on a second", async () => {
    const d = await drain();
    const c = await contract();
    const r = await reader();
    for (const overtakes of [1, 2]) {
      const s = await corrected();
      const w = s.w;
      let starts = 0;
      let nexts = 0;
      const deps = dependencies(w);
      const run = () => d.drainSlackTimeline({
        pageSize: 1,
        startPage: (input: Json) => { starts++; return r.readSlackPersonDayPage(request(w, { ...input, cursor: null }), deps); },
        nextPage: async (cursor: string) => {
          // Between page one and page two of each attempt, a REAL correction lands.
          if (nexts++ < overtakes) await correct(s.team, s.x, nexts === 1 ? s.b.email : s.a.email);
          return r.readSlackPersonDayPage(request(w, { pageSize: 1, cursor }), deps);
        },
        validateFinal: (input: Json) => r.validateSlackPersonDayFinal({ ...request(w, { pageSize: 1 }), ...input }, deps),
        decodeCursor: (token: string) => c.decodeSlackTimelineCursor(token, KEY),
      });
      if (overtakes === 1) {
        const result = await run();
        expect(Object.keys(result).sort()).toEqual(["days", "window_days"]);
        expect(starts).toBe(2);
        // Locked to B: only B's group, and never the stale A group from the discarded attempt.
        const ids = (result.days as TimelineDay[]).flatMap((day) => day.people.flatMap((p) => p.other.flatMap((g) => g.items.map((i) => i.id))));
        expect(ids).toEqual([groupId(s.x, s.b.id, "2024-06-19")]);
      } else {
        // Attempt one is overtaken (locked to B); attempt two starts with B's single group and is
        // terminal on its first page, so the second correction can only be seen by final validation.
        await expectFailure(run, "restart_required");
        expect(starts).toBe(2);
      }
    }
  });
});

describe("aggregate Slack page — roster and provenance (B1 / M1)", () => {
  it("requires restart when a human becomes a connector with no generation change", async () => {
    const s = await scene();
    await thread(s, "one", ts(D20, 1), "U1");
    await thread(s, "two", ts(D19, 1), "U2");
    await converge(s.team);
    const one = await page(s.w, { pageSize: 1 });
    await runSql(`update members set is_connector = true where id = $1`, [s.b.id]);
    await expectFailure(() => page(s.w, { pageSize: 1, cursor: one.nextSlackCursor }), "restart_required");
    const fresh = await traverse(s.w, 1);
    expect(fresh.tuples.map((t) => t.memberId)).toEqual([s.a.id]);
    expect(fresh.pages[0].binding.identityGeneration).toBe(one.binding.identityGeneration);
  });

  it("requires restart when a workspace proof changes to another CONSISTENT proof between pages", async () => {
    const s = await scene();
    const first = await thread(s, "one", ts(D20, 1), "U1");
    await thread(s, "two", ts(D19, 1), "U2");
    await converge(s.team);
    const one = await page(s.w, { pageSize: 1 });
    s.w.provenance.set(first, { ...verified(s.w, first), workspaceUrl: "https://acme.slack.com" });
    await expectFailure(() => page(s.w, { pageSize: 1, cursor: one.nextSlackCursor }), "restart_required");
    expect((await traverse(s.w, 1)).ids).toHaveLength(2);
  });

  it.each([
    ["a verified workspace that contradicts the ledger's authors", (w: World, id: string) => ({ ...verified(w, id), workspaceId: "TOTHER" })],
    ["a missing proof for an item with eligible authors", () => ({ status: "unverified" })],
    ["a verified channel that contradicts the ledger", (w: World, id: string) => ({ ...verified(w, id), channelId: "COTHER" })],
    ["a verified root that contradicts the ledger", (w: World, id: string) => ({ ...verified(w, id), rootTs: "1700000000.000001" })],
    ["a workspace URL that is not a Slack HTTPS URL", (w: World, id: string) => ({ ...verified(w, id), workspaceUrl: "http://acme.example.com" })],
  ])("fails the whole page as unavailable for %s — even for an unresolved author outside the window", async (_label, proof) => {
    const s = await scene();
    const good = await thread(s, "good", ts(D20, 1), "U1");
    // The contradicted item's ONLY author is unmapped and out of window: no group would ever show it.
    const bad = await thread(s, "bad", ts("2024-01-10T10:00:00", 1), "UNMAPPED");
    await converge(s.team);
    expect((await traverse(s.w, 128)).ids).toEqual([groupId(good, s.a.id, "2024-06-20")]);
    s.w.provenance.set(bad, proof(s.w, bad));
    await expectFailure(() => page(s.w), "unavailable");
    // …including between pages, where a mere digest change would only have asked for a restart.
    s.w.provenance.delete(bad);
    await thread(s, "more", ts(D19, 1), "U2");
    await converge(s.team);
    const one = await page(s.w, { pageSize: 1 });
    s.w.provenance.set(bad, proof(s.w, bad));
    await expectFailure(() => page(s.w, { pageSize: 1, cursor: one.nextSlackCursor }), "unavailable");
  });

  it("emits nothing for an empty or absent ledger, and does not demand a proof for it", async () => {
    const s = await scene();
    const empty = await slackItem(s.team, "empty");
    const deletedOnly = await slackItem(s.team, "deleted-only");
    await message(s.team.teamId, deletedOnly, ts(D20, 1), { user: "U1", deleted: true });
    await converge(s.team);
    s.w.provenance.set(empty, { status: "unverified" });
    s.w.provenance.set(deletedOnly, { status: "unverified" });
    const only = await page(s.w);
    expect(only).toMatchObject({ aggregates: [], days: [], slackComplete: true, nextSlackCursor: null });
    expect(only.binding.authorizedSlackItemFingerprint).toBe((await contract()).slackItemFingerprint([empty, deletedOnly]));
  });

  it("fails as unavailable when one item's ledger is bound to two threads", async () => {
    const s = await scene();
    const id = await thread(s, "split", ts(D20, 1), "U1");
    await message(s.team.teamId, id, ts(D20, 2), { user: "U2", channel: "COTHERCHANNEL" });
    await converge(s.team);
    await expectFailure(() => page(s.w), "unavailable");
  });

  it("classifies a provenance conflict seen together with a changed digest as unavailable, never as a restart", async () => {
    const s = await scene();
    const first = await thread(s, "one", ts(D20, 1), "U1");
    await thread(s, "two", ts(D19, 1), "U2");
    await converge(s.team);
    const one = await page(s.w, { pageSize: 1 });
    await runSql(`update members set is_connector = true where id = $1`, [s.b.id]); // digest change
    s.w.provenance.set(first, { ...verified(s.w, first), workspaceId: "TOTHER" }); // provenance conflict
    await expectFailure(() => page(s.w, { pageSize: 1, cursor: one.nextSlackCursor }), "unavailable");
  });

  it("re-validates roster and provenance AFTER the evidence transaction, before publishing", async () => {
    for (const [change, code] of [["connector", "restart_required"], ["consistent-proof", "restart_required"], ["conflicting-proof", "unavailable"]] as const) {
      const s = await scene();
      const first = await thread(s, "one", ts(D20, 1), "U1");
      await converge(s.team);
      await expectFailure(() => page(s.w, {}, {
        afterEvidence: async () => {
          if (change === "connector") await runSql(`update members set is_connector = true where id = $1`, [s.a.id]);
          else if (change === "consistent-proof") s.w.provenance.set(first, { ...verified(s.w, first), workspaceUrl: "https://acme.slack.com" });
          else s.w.provenance.set(first, { ...verified(s.w, first), workspaceId: "TOTHER" });
        },
      }), code);
    }
  });
});

describe("aggregate Slack page — one evidence snapshot, one fresh validation snapshot", () => {
  it("reads access, presentation, initial non-Slack and messages on one read-only repeatable-read snapshot", async () => {
    const s = await scene();
    await thread(s, "one", ts(D20, 1), "U1");
    s.w.nonSlack.push({ itemId: await githubItem(s.team, "pr"), title: "PR one", memberId: s.team.memberId });
    await converge(s.team);
    let seamCommitted = false;
    await page(s.w, {}, {
      afterDiscovery: async (query: SqlExecutor) => { await observe(s.w, query, "seam"); },
      afterEvidence: async () => {
        // A committed write between the two transactions: the validation snapshot must be newer.
        await runSql(`update items set body = body where team_id = $1`, [s.team.teamId]);
        seamCommitted = true;
      },
    });
    expect(seamCommitted).toBe(true);
    const seen = s.w.seen.snapshots;
    for (const row of seen) expect(row).toMatchObject({ isolation: "repeatable read", readOnly: "on" });
    const evidence = seen.find((row) => row.label === "seam")!;
    const sameAsEvidence = seen.filter((row) => row.pid === evidence.pid && row.snapshot === evidence.snapshot).map((row) => row.label);
    // The first admission, presentation and initial reads share the evidence snapshot exactly.
    expect(sameAsEvidence).toEqual(expect.arrayContaining(["admission", "presentation", "initial", "seam"]));
    // Admission and presentation are read AGAIN for validation, on a different snapshot.
    const validation = seen.filter((row) => row.snapshot !== evidence.snapshot);
    expect(validation.map((row) => row.label)).toEqual(expect.arrayContaining(["admission", "presentation"]));
    expect(new Set(validation.map((row) => row.snapshot)).size, "validation is ONE fresh snapshot").toBe(1);
    // The frozen initial snapshot is loaded once per attempt; a continuation never loads it.
    expect(s.w.seen.initial).toBe(1);
  });

  it("refuses a write on either transaction, and a seam failure is never an empty page", async () => {
    const s = await scene();
    const id = await thread(s, "one", ts(D20, 1), "U1");
    await converge(s.team);
    expect(await failureOf(() => page(s.w, {}, {
      afterDiscovery: async (query: SqlExecutor) => { await query(`update items set body = 'forbidden' where id = $1`, [id]); },
    }))).toMatchObject({ name: "SlackTimelineError", code: "unavailable" });
    expect(await failureOf(() => page(s.w, {}, {
      afterTransactionConfigured: async (query: SqlExecutor) => { await query(`select * from aio_1170_missing_aggregate_source`); },
    }))).toMatchObject({ name: "SlackTimelineError", code: "unavailable" });
    expect((await runSql<{ body: string }>(`select body from items where id = $1`, [id])).rows[0].body).not.toBe("forbidden");
  });

  it("holds real ledger, mapping and correction writes committed mid-read out of the evidence, then detects the overtake", async () => {
    for (const write of ["ledger", "mapping", "correction"] as const) {
      const s = await scene();
      const root = ts(D20, 1);
      const id = await slackItem(s.team, "race");
      s.w.roots.set(id, root);
      await publishThread(s.team.teamId, id, [{ ts: root, user: "U1" }]);
      await converge(s.team);
      const failure = await expectFailure(() => page(s.w, {}, {
        afterDiscovery: async () => {
          if (write === "ledger") await publishThread(s.team.teamId, id, [{ ts: root, user: "U1" }, { ts: ts(D20, 2), user: "U1", thread_ts: root }]);
          else if (write === "mapping") await setMemberIdentity(db(), s.team.teamId, s.c.id, { provider: "slack", externalId: `${WORKSPACE}:U1` }, { force: true, explicit: true });
          else await correct(s.team, id, s.c.email);
        },
      }), "restart_required");
      expect(failure).not.toHaveProperty("binding");
      // Internally consistent old evidence: one message by A, composed before validation refused it.
      expect(s.w.seen.aggregates.at(-1)).toMatchObject([{ id: groupId(id, s.a.id, "2024-06-20"), messageCount: 1, rootAuthored: true }]);
      const fresh = await traverse(s.w, 128);
      if (write === "ledger") expect(fresh.compact).toMatchObject([{ memberId: s.a.id, messageCount: 2 }]);
      if (write === "mapping") expect(fresh.compact).toMatchObject([{ memberId: s.c.id, messageCount: 1 }]);
      if (write === "correction") expect(fresh.compact).toEqual([]);
    }
  });

  it("refuses to run inside an ambient transaction it did not open", async () => {
    const s = await scene();
    await thread(s, "one", ts(D20, 1), "U1");
    await converge(s.team);
    const r = await reader();
    await expectFailure(() => tx(async (session) =>
      r.readSlackPersonDayPage(request(s.w), dependencies(s.w), { executor: session.executeSql })), "unavailable");
  });
});

describe("aggregate Slack page — two-way SQL/projector equality (N4)", () => {
  async function twoDays(): Promise<Scene & { x: string; y: string }> {
    const s = await scene();
    // One member, two accounts: U1 on the 20th, U1B on the 19th. Plus a second surfaced item.
    await mapAccount(s.team.teamId, s.a.id, "U1B");
    const x = await thread(s, "x", ts(D20, 1), "U1");
    await message(s.team.teamId, x, ts(D19, 1), { root: ts(D20, 1), user: "U1B" });
    await message(s.team.teamId, x, ts(D18, 1), { root: ts(D20, 1), user: "U2" });
    const y = await thread(s, "y", ts(D20, 2), "U3");
    await converge(s.team);
    return { ...s, x, y };
  }

  it.each([
    ["a group dropped from an otherwise surfaced item", (rows: Json[]) => rows.filter((r) => r.day !== "2024-06-19")],
    ["a later group dropped before SQL exhaustion", (rows: Json[]) => rows.filter((r) => r.day !== "2024-06-18")],
    ["an extra SQL-only group", (rows: Json[]) => [...rows, { ...rows[0], day: "2024-06-17", at: "2024-06-17T10:00:00.000000Z" }]],
    ["a different instant", (rows: Json[]) => rows.map((r, n) => (n === 0 ? { ...r, at: "2024-06-20T16:13:20.999999Z" } : r))],
    ["a different count", (rows: Json[]) => rows.map((r, n) => (n === 0 ? { ...r, messageCount: 99 } : r))],
    ["a different root flag", (rows: Json[]) => rows.map((r, n) => (n === 0 ? { ...r, rootAuthored: !r.rootAuthored } : r))],
    ["a different member", (rows: Json[]) => rows.map((r, n) => (n === 0 ? { ...r, memberId: "c0000000-0000-4000-8000-00000000000c" } : r))],
  ])("is unavailable for %s — at every page size, and not explained away as lock suppression", async (_label, corrupt) => {
    const s = await twoDays();
    expect((await traverse(s.w, 1)).ids).toHaveLength(4);
    for (const pageSize of [1, 128]) {
      let corrupted = 0;
      const run = async (): Promise<void> => {
        let cursor: string | null = null;
        for (let n = 0; n < 8; n++) {
          const p = await page(s.w, { pageSize, cursor }, {
            corruptCandidates: (rows: Json[]) => { const out = corrupt(rows); if (JSON.stringify(out) !== JSON.stringify(rows)) corrupted++; return out; },
          });
          if (p.slackComplete) return;
          cursor = p.nextSlackCursor;
        }
      };
      await expectFailure(run, "unavailable");
      expect(corrupted, "the seam actually changed a candidate batch").toBeGreaterThan(0);
    }
  });

  it("is unavailable when the SQL account relation omits one of a member's accounts", async () => {
    const s = await twoDays();
    let omitted = 0;
    await expectFailure(() => traverse(s.w, 1, {
      corruptAccountRelation: (relation: Json[]) => {
        const out = relation.filter((row) => JSON.stringify(row).includes("U1B") === false);
        omitted += relation.length - out.length;
        return out;
      },
    }), "unavailable");
    expect(omitted).toBeGreaterThan(0);
  });

  it("does not claim to detect an item SQL never surfaces: that stays the saturation tests' job", async () => {
    const s = await twoDays();
    // Dropping EVERY candidate of item y leaves nothing loaded to compare against. The comparison
    // is per loaded item; this case is recorded so nobody reads the equality check as global.
    const run = await traverse(s.w, 128, { corruptCandidates: (rows: Json[]) => rows.filter((r) => r.itemId !== s.y) });
    expect(run.ids).toHaveLength(3);
    expect(JSON.stringify(run.ids)).not.toContain(s.y);
  });
});

describe("aggregate Slack page — authenticated continuation on the real service", () => {
  async function two(): Promise<Scene & { first: string; second: string; one: Loose }> {
    const s = await scene();
    const first = await thread(s, "one", ts(D20, 1), "U1");
    const second = await thread(s, "two", ts(D19, 1), "U2");
    await converge(s.team);
    return { ...s, first, second, one: await page(s.w, { pageSize: 1 }) };
  }

  it("binds the complete snapshot, and an unchanged replay returns equivalent evidence without sliding expiry", async () => {
    const s = await two();
    const c = await contract();
    expect(s.one.binding).toMatchObject({
      schemaVersion: 1, teamId: s.team.teamId, principalKey: `member:${s.team.memberId}`, windowDays: 7, pageSize: 1,
      since: ms(NOW_MS - 7 * DAY_MS), asOf: ms(NOW_MS), issuedAt: ms(NOW_MS), expiresAt: ms(NOW_MS + TTL_MS),
      dataGeneration: "0", identityGeneration: "0", presentationGeneration: "0",
      authorizedSlackItemFingerprint: c.slackItemFingerprint([s.first, s.second]),
    });
    for (const digest of ["viewKey", "admissionBindingDigest", "sourceAdmissionBindingDigest", "creditInputDigest", "presentationInputDigest"]) {
      expect(s.one.binding[digest], digest).toMatch(/^[0-9a-f]{64}$/);
    }
    expect(s.one.asOf).toBe(ms(NOW_MS));
    expect(c.decodeSlackTimelineCursor(s.one.nextSlackCursor, KEY)).toEqual({ ...s.one.binding, lastAggregateTuple: s.one.aggregates[0].tuple });

    s.w.nowMs = NOW_MS + TTL_MS - 1; // the wall clock moved; asOf, since and expiry did not
    const a = await page(s.w, { pageSize: 1, cursor: s.one.nextSlackCursor });
    const b = await page(s.w, { pageSize: 1, cursor: s.one.nextSlackCursor });
    expect(a.nextSlackCursor).toBeNull();
    expect({ ...a, nextSlackCursor: null }).toEqual({ ...b, nextSlackCursor: null });
    expect(a.binding).toEqual(s.one.binding);
    expect(a.aggregates.map((g: Json) => g.id)).toEqual([groupId(s.second, s.b.id, "2024-06-19")]);
    // A continuation contains only its own Slack groups: no repeated first-page content.
    expect(Object.prototype.hasOwnProperty.call(a, "initialNonSlackSourceItemIds")).toBe(false);
    expect(s.w.seen.initial).toBe(1);
  });

  it("requires restart exactly at expiry, on admission and again at publication", async () => {
    const s = await two();
    s.w.nowMs = NOW_MS + TTL_MS;
    await expectFailure(() => page(s.w, { pageSize: 1, cursor: s.one.nextSlackCursor }), "restart_required");
    // Valid on admission, expired by the time the evidence was read: still a restart, never a page.
    s.w.nowMs = NOW_MS + TTL_MS - 1;
    await expectFailure(() => page(s.w, { pageSize: 1, cursor: s.one.nextSlackCursor }, {
      afterEvidence: async () => { s.w.nowMs = NOW_MS + TTL_MS; },
    }), "restart_required");
    // The same holds for a FIRST page that outlives its own fifteen minutes.
    s.w.nowMs = NOW_MS;
    await expectFailure(() => page(s.w, { pageSize: 1 }, { afterEvidence: async () => { s.w.nowMs = NOW_MS + TTL_MS; } }), "restart_required");
  });

  it("rejects a future-issued cursor and a clock that ran backwards as invalid requests", async () => {
    const s = await two();
    s.w.nowMs = NOW_MS - 1;
    await expectFailure(() => page(s.w, { pageSize: 1, cursor: s.one.nextSlackCursor }), "invalid_request");
    s.w.nowMs = NOW_MS;
    await expectFailure(() => page(s.w, { pageSize: 1, cursor: s.one.nextSlackCursor }, {
      afterEvidence: async () => { s.w.nowMs = NOW_MS - 1; },
    }), "invalid_request");
  });

  it("rejects a tampered, re-keyed or malformed cursor before any database work", async () => {
    const s = await two();
    const raw = Buffer.from(s.one.nextSlackCursor, "base64url");
    const flipped = Buffer.from(raw);
    flipped[Math.floor(raw.length / 2)] ^= 0x01;
    const before = s.w.seen.admission.length;
    for (const cursor of [flipped.toString("base64url"), "", "not a cursor", "A".repeat(16 * 1024 + 1), 7]) {
      await expectFailure(() => page(s.w, { pageSize: 1, cursor }), "invalid_request");
    }
    await expectFailure(() => page(s.w, { pageSize: 1, cursor: s.one.nextSlackCursor }, {}, { slackTimelineCursorKey: Buffer.alloc(32, 1) }), "invalid_request");
    expect(s.w.seen.admission.length, "no dependency was consulted").toBe(before);
    for (const key of [undefined, null, Buffer.alloc(16, 1), "k".repeat(32)]) {
      await expectFailure(() => page(s.w, { pageSize: 1 }, {}, { slackTimelineCursorKey: key }), "unavailable");
    }
  });

  it.each([
    ["page size", { pageSize: 2 }],
    ["window", { windowDays: 14 }],
    ["view mode", { requestedView: { mode: "expanded", filters: {}, locale: "en-US", presentationPolicyVersion: "1" } }],
    ["view filters", { requestedView: { mode: "timeline", filters: { memberIds: ["x"] }, locale: "en-US", presentationPolicyVersion: "1" } }],
    ["locale", { requestedView: { mode: "timeline", filters: {}, locale: "de-DE", presentationPolicyVersion: "1" } }],
    ["label policy version", { requestedView: { mode: "timeline", filters: {}, locale: "en-US", presentationPolicyVersion: "2" } }],
  ])("requires restart when a valid cursor is presented with a different %s", async (_label, over) => {
    const s = await two();
    await expectFailure(() => page(s.w, { pageSize: 1, cursor: s.one.nextSlackCursor, ...over }), "restart_required");
  });

  it("requires restart when a valid cursor is presented by another principal or for another team", async () => {
    const s = await two();
    const colleague = await person(s.team.teamId, "Colleague");
    const { placeMemberByTier } = await import("./helpers");
    await placeMemberByTier(s.team.teamId, colleague.id, "team");
    await expectFailure(() => page(s.w, { pageSize: 1, cursor: s.one.nextSlackCursor, principal: { teamId: s.team.teamId, memberId: colleague.id } }), "restart_required");
    const other = await scene();
    await thread(other, "elsewhere", ts(D20, 1), "U1");
    await converge(other.team);
    await expectFailure(() => page(other.w, { pageSize: 1, cursor: s.one.nextSlackCursor }), "restart_required");
    // A principal whose team is not the request's team is not a view at all.
    await expectFailure(() => page(s.w, { pageSize: 1, principal: { teamId: other.team.teamId, memberId: s.team.memberId } }), "invalid_request");
  });

  it.each([
    ["page size 0", { pageSize: 0 }], ["page size 513", { pageSize: 513 }], ["a fractional page size", { pageSize: 1.5 }],
    ["window 8", { windowDays: 8 }], ["window 0", { windowDays: 0 }], ["a non-UUID team", { teamId: "team" }],
    ["no principal", { principal: null }], ["no view", { requestedView: null }],
  ])("refuses %s as an invalid request before any database work", async (_label, over) => {
    const s = await scene();
    await expectFailure(() => page(s.w, over), "invalid_request");
    expect(s.w.seen.admission).toEqual([]);
  });

  it("accepts every allowed window on the page service; v1's seven-day rule belongs to the drain", async () => {
    const s = await scene();
    await thread(s, "old", ts("2024-05-25T10:00:00", 1), "U1");
    await converge(s.team);
    for (const windowDays of [7, 14, 21]) expect((await page(s.w, { windowDays })).aggregates).toEqual([]);
    for (const windowDays of [28, 30]) {
      const p = await page(s.w, { windowDays });
      expect(p.aggregates).toHaveLength(1);
      expect(p).toMatchObject({ window_days: windowDays, binding: { windowDays, since: ms(NOW_MS - windowDays * DAY_MS) } });
    }
  });
});

describe("aggregate Slack page — access through the real oracle, and injected source admission", () => {
  it("requires restart when an item's real membership is revoked between pages, with grants unchanged", async () => {
    const s = await scene();
    await thread(s, "one", ts(D20, 1), "U1");
    const second = await thread(s, "two", ts(D19, 1), "U2");
    await converge(s.team);
    const one = await page(s.w, { pageSize: 1 });
    await revokeMembership(second);
    await expectFailure(() => page(s.w, { pageSize: 1, cursor: one.nextSlackCursor }), "restart_required");
    const fresh = await traverse(s.w, 1);
    expect(fresh.ids).toHaveLength(1);
    expect(JSON.stringify(fresh.pages)).not.toContain(second);
    // The grants did not change: only the Slack-only item fingerprint did.
    expect(fresh.pages[0].binding.admissionBindingDigest).toBe(one.binding.admissionBindingDigest);
    expect(fresh.pages[0].binding.authorizedSlackItemFingerprint).not.toBe(one.binding.authorizedSlackItemFingerprint);
  });

  it("requires restart when the cursor's own item is no longer authorized", async () => {
    const s = await scene();
    const first = await thread(s, "one", ts(D20, 1), "U1");
    await thread(s, "two", ts(D19, 1), "U2");
    await converge(s.team);
    const one = await page(s.w, { pageSize: 1 });
    await revokeMembership(first);
    await expectFailure(() => page(s.w, { pageSize: 1, cursor: one.nextSlackCursor }), "restart_required");
  });

  it("never returns an item revoked after the evidence read and before publication", async () => {
    const s = await scene();
    const id = await thread(s, "one", ts(D20, 1), "U1");
    await converge(s.team);
    const failure = await expectFailure(() => page(s.w, {}, { afterEvidence: () => revokeMembership(id) }), "restart_required");
    expect(JSON.stringify(failure)).not.toContain(id);
    expect((await page(s.w)).aggregates).toEqual([]);
  });

  it("treats an access-read failure as unavailable, never as an empty authorized set", async () => {
    const s = await scene();
    await thread(s, "one", ts(D20, 1), "U1");
    await converge(s.team);
    s.w.fail.admission = new Error("oracle read failed");
    await expectFailure(() => page(s.w), "unavailable");
    s.w.fail.admission = undefined;
    // …and the same when it fails only on the validation read.
    await expectFailure(() => page(s.w, {}, { afterEvidence: async () => { s.w.fail.admission = new Error("oracle read failed"); } }), "unavailable");
  });

  it.each([
    ["no Slack items", (r: Json) => ({ ...r, slackItems: undefined })],
    ["a duplicate item row", (r: Json) => ({ ...r, slackItems: [...(r.slackItems as Json[]), (r.slackItems as Json[])[0]] })],
    ["an uppercase item id", (r: Json) => ({ ...r, slackItems: (r.slackItems as Json[]).map((i) => ({ ...i, itemId: String(i.itemId).toUpperCase() })) })],
    ["an item with no provenance", (r: Json) => ({ ...r, slackItems: (r.slackItems as Json[]).map((i) => ({ itemId: i.itemId })) })],
    ["an unknown provenance status", (r: Json) => ({ ...r, slackItems: (r.slackItems as Json[]).map((i) => ({ ...i, provenance: { status: "trusted" } })) })],
    ["another team", (r: Json) => ({ ...r, teamId: randomUUID() })],
    ["no principal key", (r: Json) => ({ ...r, principalKey: "" })],
    ["no admission binding", (r: Json) => ({ ...r, admissionBinding: undefined })],
    ["no source-admission binding", (r: Json) => ({ ...r, sourceAdmissionBinding: undefined })],
    ["a binding that is not JSON-safe", (r: Json) => ({ ...r, admissionBinding: { at: new Date(0) } })],
    ["nothing", () => null as unknown as Json],
  ])("rejects an admission result with %s as an incomplete trusted dependency result", async (_label, mutate) => {
    const s = await scene();
    await thread(s, "one", ts(D20, 1), "U1");
    await converge(s.team);
    s.w.override.admission = mutate;
    await expectFailure(() => page(s.w), "unavailable");
  });

  it("never silently drops an authorized ID the session reader cannot find as a same-team Slack item", async () => {
    const s = await scene();
    await thread(s, "one", ts(D20, 1), "U1");
    const github = await githubItem(s.team, "pr");
    const foreignScene = await scene();
    const foreign = await thread(foreignScene, "foreign", ts(D20, 1), "U1");
    await converge(s.team);
    await converge(foreignScene.team);
    for (const stray of [github, foreign, randomUUID()]) {
      s.w.override.admission = (r) => ({
        ...r, slackItems: [...(r.slackItems as Json[]), { itemId: stray, provenance: { status: "unverified" } }],
      });
      const failure = await failureOf(() => page(s.w));
      expect(failure.name).toBe("SlackTimelineError");
      expect(["unavailable", "restart_required"]).toContain(failure.code);
    }
  });

  it("models source-admission revocation and failure through the injected seam (not production AC-11 proof)", async () => {
    const s = await scene();
    await thread(s, "one", ts(D20, 1), "U1");
    const second = await thread(s, "two", ts(D19, 1), "U2");
    await converge(s.team);
    const one = await page(s.w, { pageSize: 1 });
    s.w.denied.add(second);
    await expectFailure(() => page(s.w, { pageSize: 1, cursor: one.nextSlackCursor }), "restart_required");
    const fresh = await traverse(s.w, 1);
    expect(fresh.ids).toHaveLength(1);
    expect(fresh.pages[0].binding.sourceAdmissionBindingDigest).not.toBe(one.binding.sourceAdmissionBindingDigest);
    // A denied item never reaches the evidence query: its conflicting proof cannot fail the page.
    s.w.provenance.set(second, { status: "verified", workspaceId: "TOTHER", channelId: "C", rootTs: "1.000001", workspaceUrl: null });
    expect((await traverse(s.w, 1)).ids).toHaveLength(1);
    s.w.denied.clear();
    await expectFailure(() => page(s.w), "unavailable");
  });
});

describe("aggregate Slack page — initial non-Slack evidence (N1) and presentation (N2 / M3)", () => {
  async function withGithub(): Promise<Scene & { x: string; g: string }> {
    const s = await scene();
    const x = await thread(s, "x", ts(D20, 1), "U1");
    await message(s.team.teamId, x, ts(D19, 1), { root: ts(D20, 1), user: "U2" });
    const g = await githubItem(s.team, "pr");
    s.w.nonSlack.push({ itemId: g, title: "PR one", memberId: s.team.memberId });
    await converge(s.team);
    return { ...s, x, g };
  }

  it("merges the frozen non-Slack snapshot into the first page only, and carries its backing IDs internally", async () => {
    const s = await withGithub();
    const one = await page(s.w, { pageSize: 1 });
    expect(one.initialNonSlackSourceItemIds).toEqual([s.g]);
    expect(JSON.stringify(one.days)).toContain("PR one");
    const two = await page(s.w, { pageSize: 1, cursor: one.nextSlackCursor });
    expect(JSON.stringify(two.days)).not.toContain("PR one");
    expect(JSON.stringify(two.days)).not.toContain("github");
    expect(s.w.seen.initial).toBe(1);
    // The backing IDs are not in the cursor and not in the binding.
    expect(JSON.stringify((await contract()).decodeSlackTimelineCursor(one.nextSlackCursor, KEY))).not.toContain(s.g);
  });

  it("restarts a first page whose non-Slack backing item was revoked before publication", async () => {
    const s = await withGithub();
    const failure = await expectFailure(() => page(s.w, { pageSize: 1 }, { afterEvidence: () => revokeMembership(s.g) }), "restart_required");
    expect(JSON.stringify(failure)).not.toContain("PR one");
    const fresh = await page(s.w, { pageSize: 1 });
    expect(fresh.initialNonSlackSourceItemIds).toEqual([]);
    expect(JSON.stringify(fresh.days)).not.toContain("PR one");
  });

  it("drains with a real-oracle final subset check: revocation restarts and omits G; an unrelated addition does not restart", async () => {
    const d = await drain();
    const c = await contract();
    const r = await reader();
    for (const event of ["revoke", "unrelated-addition"] as const) {
      const s = await withGithub();
      const deps = dependencies(s.w);
      let starts = 0;
      let done = false;
      const result = await d.drainSlackTimeline({
        pageSize: 1,
        startPage: (input: Json) => { starts++; return r.readSlackPersonDayPage(request(s.w, { ...input, cursor: null }), deps); },
        nextPage: async (cursor: string) => {
          if (!done) {
            done = true;
            if (event === "revoke") await revokeMembership(s.g);
            else {
              await githubItem(s.team, "unrelated");
              await converge(s.team);
            }
          }
          return r.readSlackPersonDayPage(request(s.w, { pageSize: 1, cursor }), deps);
        },
        validateFinal: (input: Json) => r.validateSlackPersonDayFinal({ ...request(s.w, { pageSize: 1 }), ...input }, deps),
        decodeCursor: (token: string) => c.decodeSlackTimelineCursor(token, KEY),
      });
      expect(result.window_days).toBe(7);
      const text = JSON.stringify(result);
      expect(text).toContain(groupId(s.x, s.a.id, "2024-06-20").slice(2, 38));
      if (event === "revoke") {
        expect(starts).toBe(2);
        expect(text).not.toContain("PR one");
        expect(text).not.toContain(s.g);
      } else {
        // Slack-only fingerprint and Slack-only presentation: a new GitHub item is not an overtake.
        expect(starts).toBe(1);
        expect(text).toContain("PR one");
      }
    }
  });

  it("final validation itself restarts on a revoked backing ID and is unavailable when it cannot read", async () => {
    const s = await withGithub();
    const r = await reader();
    const one = await page(s.w);
    const input = { ...request(s.w), binding: one.binding, initialNonSlackSourceItemIds: one.initialNonSlackSourceItemIds };
    await expect(r.validateSlackPersonDayFinal(input, dependencies(s.w))).resolves.toBeUndefined();
    s.w.nowMs = NOW_MS + TTL_MS;
    await expectFailure(() => r.validateSlackPersonDayFinal(input, dependencies(s.w)), "restart_required");
    s.w.nowMs = NOW_MS;
    await revokeMembership(s.g);
    await expectFailure(() => r.validateSlackPersonDayFinal(input, dependencies(s.w)), "restart_required");
    s.w.fail.admission = new Error("oracle read failed");
    await expectFailure(() => r.validateSlackPersonDayFinal(input, dependencies(s.w)), "unavailable");
    s.w.fail.admission = undefined;
    for (const ids of [undefined, "ids", [42], [s.g, s.g]]) {
      await expectFailure(() => r.validateSlackPersonDayFinal({ ...input, initialNonSlackSourceItemIds: ids }, dependencies(s.w)), "unavailable");
    }
  });

  it.each([
    ["a legacy Slack group", (r: Json) => {
      const days = structuredClone(r.days) as TimelineDay[];
      days[0].people[0].other.push({ source: "slack", count: 1, items: [{ id: "legacy", title: "Old Slack row", source: "slack", kind: "thread", at: "2024-06-20T10:00:00Z" }] });
      return { ...r, days };
    }],
    ["a Slack row nested under a task", (r: Json) => {
      const days = structuredClone(r.days) as TimelineDay[];
      days[0].people[0].tasks.push({
        taskId: "T", title: "Task", status: "done", source: "linear", evidenceCount: 1,
        sources: [{ source: "slack", count: 1, items: [{ id: "legacy", title: "Old Slack row", source: "slack", kind: "thread", at: "2024-06-20T10:00:00Z" }] }],
      });
      return { ...r, days };
    }],
    ["no backing-ID list", (r: Json) => ({ days: r.days })],
    ["a backing-ID list that is not an array", (r: Json) => ({ ...r, sourceItemIds: "ids" })],
    ["a duplicated backing ID", (r: Json) => ({ ...r, sourceItemIds: [...(r.sourceItemIds as string[]), ...(r.sourceItemIds as string[])] })],
    ["a backing ID the real oracle does not show", (r: Json) => ({ ...r, sourceItemIds: [...(r.sourceItemIds as string[]), randomUUID()] })],
    ["days that are not an array", (r: Json) => ({ ...r, days: null })],
    ["a malformed day", (r: Json) => ({ ...r, days: [{ date: "2024-02-30", label: "x", people: [] }] })],
  ])("rejects an initial non-Slack result with %s", async (_label, mutate) => {
    const s = await withGithub();
    s.w.override.initial = mutate;
    const failure = await failureOf(() => page(s.w));
    expect(failure.name).toBe("SlackTimelineError");
    // An unlisted-by-the-oracle backing ID is a revocation (restart); everything else is malformed.
    expect(failure.code).toBe(_label === "a backing ID the real oracle does not show" ? "restart_required" : "unavailable");
    expect(s.w.seen.aggregates, "rejected before composition").toEqual([]);
  });

  it("hands the presentation loader the actual principal and the evidence-snapshot admission", async () => {
    const s = await withGithub();
    await page(s.w);
    const [first] = s.w.seen.presentation;
    expect(first).toMatchObject({
      teamId: s.team.teamId, principal: { teamId: s.team.teamId, memberId: s.team.memberId }, windowDays: 7,
      admission: { kind: "member", teamId: s.team.teamId, memberId: s.team.memberId },
    });
    expect(first.viewKey).toMatch(/^[0-9a-f]{64}$/);
    expect((first.slackItems as Json[]).map((i) => i.itemId)).toEqual([s.x]);
    expect(first.admission).toEqual((s.w.seen.admission.length, (await resolveContentAdmission(db(), s.team.teamId, s.team.memberId))));
    // The view key is derived server-side: a caller-supplied one is not an input at all.
    const forged = await page(s.w, { viewKey: "f".repeat(64) });
    expect(forged.binding.viewKey).toBe((await page(s.w)).binding.viewKey);
  });

  it("removes a linked task the viewer cannot see, and restarts when that task's visibility changes between pages", async () => {
    const s = await withGithub();
    const backing = await githubItem(s.team, "task-source");
    await converge(s.team);
    s.w.tasks.set(s.x, [{ taskId: "T1", title: "Visible task", status: "in_progress", backingItemId: backing }]);
    const one = await page(s.w, { pageSize: 1 });
    expect(JSON.stringify(one.days)).toContain("Visible task");
    await revokeMembership(backing);
    await expectFailure(() => page(s.w, { pageSize: 1, cursor: one.nextSlackCursor }), "restart_required");
    const fresh = await traverse(s.w, 1);
    expect(JSON.stringify(fresh.pages)).not.toContain("Visible task");
    expect(fresh.pages[0].binding.presentationInputDigest).not.toBe(one.binding.presentationInputDigest);
    // The thread itself is still visible and still credited: only the association went.
    expect(fresh.ids).toHaveLength(2);
  });

  it.each([
    ["a task status", async (s: Scene & { x: string }) => { s.w.tasks.set(s.x, [{ taskId: "T1", title: "Task", status: "done" }]); }],
    ["a task title", async (s: Scene & { x: string }) => { s.w.tasks.set(s.x, [{ taskId: "T1", title: "Renamed task", status: "in_progress" }]); }],
    ["a task association", async (s: Scene & { x: string }) => { s.w.tasks.delete(s.x); }],
    ["a member's display name", async (s: Scene & { x: string }) => { await runSql(`update members set display_name = 'Renamed' where id = $1`, [s.b.id]); }],
    ["a thread title", async (s: Scene & { x: string }) => { s.w.titles.set(s.x, "Renamed thread"); }],
  ])("requires restart when %s changes after the first page, with no generation involved", async (_label, change) => {
    const s = await withGithub();
    s.w.tasks.set(s.x, [{ taskId: "T1", title: "Task", status: "in_progress" }]);
    const one = await page(s.w, { pageSize: 1 });
    await change(s);
    await expectFailure(() => page(s.w, { pageSize: 1, cursor: one.nextSlackCursor }), "restart_required");
    expect((await page(s.w, { pageSize: 1 })).binding.presentationGeneration).toBe(one.binding.presentationGeneration);
  });

  it("renders one aggregate under two tasks without changing its identity, count or page slot", async () => {
    const s = await withGithub();
    s.w.tasks.set(s.x, [{ taskId: "T1", title: "One", status: "in_progress" }, { taskId: "T2", title: "Two", status: "done" }]);
    const run = await traverse(s.w, 1);
    expect(run.ids).toEqual([groupId(s.x, s.a.id, "2024-06-20"), groupId(s.x, s.b.id, "2024-06-19")]);
    const personA = (run.pages[0].days as TimelineDay[]).find((day) => day.date === "2024-06-20")!.people.find((p) => p.memberId === s.a.id)!;
    expect(personA.tasks.map((t) => t.taskId).sort()).toEqual(["T1", "T2"]);
    // First page is normalized through the shared merger: one unique Slack contribution.
    expect(personA.total).toBe(1);
  });

  it("labels days from the bound asOf, not from the wall clock at composition time", async () => {
    const s = await withGithub();
    s.w.nowMs = Date.parse("2024-06-20T23:59:00.000Z");
    const one = await page(s.w, { pageSize: 1 });
    expect((one.days as TimelineDay[]).find((day) => day.date === "2024-06-20")?.label).toBe("Today");
    s.w.nowMs = Date.parse("2024-06-21T00:05:00.000Z"); // past UTC midnight, inside the TTL
    const asOfSeen: unknown[] = [];
    s.w.override.compose = (days, input) => { asOfSeen.push(input.asOf); return days; };
    const two = await page(s.w, { pageSize: 1, cursor: one.nextSlackCursor });
    expect(two.asOf).toBe("2024-06-20T23:59:00.000Z");
    expect(String(asOfSeen[0] instanceof Date ? (asOfSeen[0] as Date).toISOString() : asOfSeen[0])).toBe("2024-06-20T23:59:00.000Z");
    expect((await contract()).mergeSlackTimelineDays(one.days, two.days)).toHaveLength(2);
  });

  it.each([
    ["drops an aggregate", (days: TimelineDay[]) => days.slice(1)],
    ["invents a Slack ID", (days: TimelineDay[]) => { (days[0].people[0].other[0].items[0] as { id: string }).id += "x"; return days; }],
    ["changes the instant", (days: TimelineDay[]) => { (days[0].people[0].other[0].items[0] as { at: string }).at = "2024-06-20T00:00:00.000000Z"; return days; }],
    ["moves a row to another member", (days: TimelineDay[]) => { days[0].people[0].memberId = randomUUID(); return days; }],
    ["adds a synopsis", (days: TimelineDay[]) => { days[0].people[0].summary = "invented"; return days; }],
    ["adds non-Slack evidence", (days: TimelineDay[]) => {
      days[0].people[0].other.push({ source: "github", count: 1, items: [{ id: "g", title: "PR", source: "github", kind: "pr", at: "2024-06-20T09:00:00Z" }] });
      return days;
    }],
    ["returns a promise", (days: TimelineDay[]) => Promise.resolve(days)],
    ["returns nothing", () => undefined],
    ["throws", () => { throw new Error("composer bug"); }],
  ])("rejects a composer that %s as unavailable, and publishes nothing", async (_label, mutate) => {
    const s = await scene();
    await thread(s, "x", ts(D20, 1), "U1");
    await thread(s, "y", ts(D19, 1), "U2");
    await converge(s.team);
    s.w.override.compose = (days) => mutate(structuredClone(days));
    await expectFailure(() => page(s.w), "unavailable");
  });

  it("treats a failing presentation or initial loader as unavailable, never as a conflict or an empty bundle", async () => {
    const s = await withGithub();
    s.w.fail.presentation = new Error("Conflicting timeline person: not a merge conflict");
    await expectFailure(() => page(s.w), "unavailable");
    s.w.fail.presentation = undefined;
    s.w.fail.initial = new Error("initial read failed");
    await expectFailure(() => page(s.w), "unavailable");
  });
});

describe("aggregate Slack page — deterministic budgets (D1)", () => {
  /** `rejected` locked threads (their only author is suppressed) sorting BEFORE one deliverable group. */
  async function rejectedRun(rejected: number): Promise<Scene & { deliverable: string }> {
    const s = await scene();
    const locked: string[] = [];
    for (let n = 0; n < rejected; n++) locked.push(await thread(s, `locked-${n}`, ts(D20, 100 + n), "U1"));
    const deliverable = await thread(s, "deliverable", ts(D19, 1), "U2");
    await converge(s.team);
    // Each lock is a real correction to C, who wrote nothing: A's group is a rejected candidate.
    for (const id of locked) await correct(s.team, id, s.c.email);
    return { ...s, deliverable };
  }

  it("fails with budget_exhausted when N rejected candidates precede a deliverable that needs N+1", async () => {
    const s = await rejectedRun(3);
    const failure = await expectFailure(() => page(s.w, { pageSize: 1 }, {}, { budgets: { maxCandidates: 3 } }), "budget_exhausted");
    // Never an empty or "complete" page, and the diagnostics are counters, not content.
    expect(failure).not.toHaveProperty("slackComplete");
    expect(String(failure.message)).not.toContain(s.deliverable);
    // The same request from the same (absent) cursor fails the same way: the run is not skipped.
    await expectFailure(() => page(s.w, { pageSize: 1 }, {}, { budgets: { maxCandidates: 3 } }), "budget_exhausted");
  });

  it("succeeds when N-1 rejected candidates and the deliverable prove exhaustion within N", async () => {
    const s = await rejectedRun(2);
    const p = await page(s.w, { pageSize: 1 }, {}, { budgets: { maxCandidates: 3 } });
    expect(p.aggregates.map((a: Json) => a.id)).toEqual([groupId(s.deliverable, s.b.id, "2024-06-19")]);
    expect(p).toMatchObject({ slackComplete: true, nextSlackCursor: null });
    // Rejected groups cost budget, not page slots: the page is not short because of them.
    await expectFailure(() => page(s.w, { pageSize: 1 }, {}, { budgets: { maxCandidates: 2 } }), "budget_exhausted");
  });

  it("scans past a rejected run longer than the page and the internal fetch to fill the page", async () => {
    const s = await rejectedRun(5);
    const extra = await thread(s, "extra", ts(D18, 1), "U2");
    await converge(s.team);
    const run = await traverse(s.w, 1, { candidateFetchSize: 2 });
    expect(run.ids).toEqual([groupId(s.deliverable, s.b.id, "2024-06-19"), groupId(extra, s.b.id, "2024-06-18")]);
    // The cursor is the last EMITTED tuple, not the last scanned or lookahead one.
    const c = await contract();
    expect(c.decodeSlackTimelineCursor(run.pages[0].nextSlackCursor, KEY).lastAggregateTuple).toEqual(run.tuples[0]);
  });

  it.each([
    ["result rows", { maxRows: 3 }],
    ["read bytes", { maxReadBytes: 64 }],
    ["the serialized page", { maxPageBytes: 64 }],
  ])("fails the whole page when %s exceed their budget, and never truncates", async (_label, budgets) => {
    const s = await rejectedRun(1);
    const failure = await expectFailure(() => page(s.w, {}, {}, { budgets }), "budget_exhausted");
    expect(failure).not.toHaveProperty("aggregates");
    // The default budgets admit the same page.
    expect((await page(s.w)).aggregates).toHaveLength(1);
  });

  it("meters the real oracle's materialized result before using it", async () => {
    const s = await scene();
    for (let n = 0; n < 6; n++) await thread(s, `t-${n}`, ts(D20, n + 1), "U1");
    await converge(s.team);
    const composedBefore = s.w.seen.aggregates.length;
    await expectFailure(() => page(s.w, {}, {}, { budgets: { maxRows: 5 } }), "budget_exhausted");
    expect(s.w.seen.aggregates.length, "nothing was composed from an over-limit read").toBe(composedBefore);
  });

  it("counts large initial non-Slack days in the page byte budget", async () => {
    const s = await scene();
    await thread(s, "x", ts(D20, 1), "U1");
    const g = await githubItem(s.team, "pr");
    s.w.nonSlack.push({ itemId: g, title: "T".repeat(8192), memberId: s.team.memberId });
    await converge(s.team);
    await expectFailure(() => page(s.w, {}, {}, { budgets: { maxPageBytes: 4096 } }), "budget_exhausted");
    s.w.nonSlack[0].title = "PR";
    expect((await page(s.w, {}, {}, { budgets: { maxPageBytes: 4096 } })).aggregates).toHaveLength(1);
  });

  it("enforces elapsed time on the injected monotonic clock: the exact limit passes, one more fails", async () => {
    const s = await rejectedRun(1);
    for (const [elapsed, ok] of [[30_000, true], [30_001, false]] as const) {
      s.w.mono = 5_000;
      const run = () => page(s.w, {}, { afterEvidence: async () => { s.w.mono = 5_000 + elapsed; } });
      if (ok) expect((await run()).aggregates).toHaveLength(1);
      else await expectFailure(run, "budget_exhausted");
    }
    // The wall clock is independent: it can stand still while the monotonic budget runs out.
    s.w.mono = 0;
    await expectFailure(() => page(s.w, {}, { afterDiscovery: async () => { s.w.mono = 31_000; } }), "budget_exhausted");
  });

  it.each([
    ["a zero candidate budget", { maxCandidates: 0 }],
    ["a negative row budget", { maxRows: -1 }],
    ["a fractional byte budget", { maxReadBytes: 1.5 }],
    ["an infinite time budget", { maxElapsedMs: Number.POSITIVE_INFINITY }],
    ["an internal fetch above 512", { candidateFetchSize: 513 }],
  ])("refuses %s as unavailable configuration before any database work", async (_label, budgets) => {
    const s = await scene();
    await expectFailure(() => page(s.w, {}, {}, { budgets }), "unavailable");
    expect(s.w.seen.admission).toEqual([]);
  });

  it.each(["now", "monotonicNow", "loadAdmission", "loadPresentation", "composeSlackPage", "loadInitialNonSlack"])(
    "is unavailable without its %s dependency",
    async (missing) => {
      const s = await scene();
      await expectFailure(() => page(s.w, {}, {}, { [missing]: undefined }), "unavailable");
    }
  );
});
