import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { Pool, PoolClient } from "pg";
import { describe, expect, it } from "vitest";

import { visibleItemIdsForProjects } from "@/lib/access/enforce";
import { contentReaderFor, provenanceCtxForReader, resolveContentAdmission, type ContentAdmission } from "@/lib/access/admission";
import { createGroup, grantProjectToGroup } from "@/lib/access/groups";
import { rowVisibleByProvenanceCtx } from "@/lib/access/provenance";
import { ITEM_LIMIT } from "@/lib/dashboard/work-timeline";
import type { PersonDay, TaskGroup, TimelineDay } from "@/lib/dashboard/timeline-group";
import { PgClient } from "@/lib/db/pg/client";
import { getPool, runSql } from "@/lib/db/pg/pool";
import type { SqlExecutor, TransactionSession } from "@/lib/db/types";
import { removeMemberIdentity, setMemberIdentity } from "@/lib/identity/member-identities";
import { applyAttributionCorrection } from "@/lib/ingest/attribution-correction";
import { reconcileCompleteSlackThreadEvidence } from "@/lib/ingest/slack-message-ledger";
import { projectSlackMessageEvidence } from "@/lib/ingest/sources/slack-message-evidence";
import { backfillTeamContext } from "@/lib/projects/context/backfill";
import { transactionCapability } from "@/lib/projects/context/transaction";
import { db, externalMember, ingest, seedTeam, type Seed } from "./helpers";

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
 *  - The test-only options are the specification's named seams: `afterTransactionConfigured(query)`,
 *    `afterDiscovery(query)` (between candidate discovery and shared projection), `afterEvidence()`
 *    (between the evidence and validation transactions), `corruptCandidates(rows)` over SQL
 *    candidate rows `{ itemId, memberId, day, at, messageCount, rootAuthored }`,
 *    `corruptAccountRelation(rows)` over the SQL join's `(workspace, user, member)` relation, and
 *    `messagePageSize` for the internal message batches.
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

/**
 * A task associated with a Slack item. Either a FIXTURE-ONLY link (title and status given here, and
 * optionally the item that backs it), or — with `taskRowId` — a REAL `tasks` row, whose provenance
 * fields, title, status and assignee are read through the page's executor. Both kinds are admitted or
 * denied by the one existing provenance owner; nothing here decides visibility on its own.
 */
interface TaskLink { taskId: string; title: string; status: string; backingItemId?: string; taskRowId?: string }

/** A link to a real `tasks` row: everything shown comes from that row, if the owner admits it. */
const realTask = (taskRowId: string): TaskLink => ({ taskId: taskRowId, title: "", status: "", taskRowId });

interface TaskRow {
  id: string;
  project_id: string | null;
  source_item_id: string | null;
  created_by: string | null;
  title: string;
  status: string;
  assignee: string | null;
}

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
    /** Every presentation bundle the loader RETURNED, in order (two per page: evidence, validation). */
    bundles: Json[];
    initial: number;
    snapshots: { label: string; pid: number; snapshot: string; isolation: string; readOnly: string }[];
  };
}

function world(team: Seed): World {
  return {
    team, nowMs: NOW_MS, mono: 0, roots: new Map(), provenance: new Map(), denied: new Set(), tasks: new Map(),
    titles: new Map(), nonSlack: [], fail: {}, override: {},
    seen: { aggregates: [], admission: [], presentation: [], bundles: [], initial: 0, snapshots: [] },
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

/** A day label from the bound asOf only — never from the ambient clock. */
function labelFor(date: string, asOf: unknown): string {
  const asOfDay = (asOf instanceof Date ? asOf.toISOString() : String(asOf)).slice(0, 10);
  return date === asOfDay ? "Today" : date;
}

function composeDays(aggregates: readonly Json[], presentation: Json, asOf: unknown): TimelineDay[] {
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
    date, label: labelFor(date, asOf),
    people: [...people].map(([memberId, p]): PersonDay => ({
      memberId, name: members.get(memberId)?.name ?? "Unknown", handle: members.get(memberId)?.handle ?? "", avatarUrl: null,
      total: 0, unlinked: 0, signals: [],
      tasks: [...p.tasks].map(([taskId, t]): TaskGroup => ({
        taskId, title: t.link.title as string, status: t.link.status as string, source: "linear", evidenceCount: t.rows.length,
        sources: [{ source: "slack", count: t.rows.length, items: t.rows as never[] }],
        ...(t.link.assignee ? { assignee: { name: t.link.assignee as string, avatarUrl: null } } : {}),
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
      // Seeing the Slack thread does not grant its linked task. Every association is admitted or
      // denied by the EXISTING provenance owner — `contentReaderFor` → `provenanceCtxForReader` →
      // `rowVisibleByProvenanceCtx` — over the real oracle's visible set, read on THIS executor
      // under the admission the packet handed over. A real task row supplies its own provenance
      // fields (`source_item_id`, `created_by`, `project_id`); a fixture-only link is judged as the
      // row it stands for: sourced by its backing item, or hand-entered by the seed member.
      const visible = await oracleVisible(query, input.teamId, input.admission);
      const ctx = provenanceCtxForReader(contentReaderFor(input.admission), visible);
      const links = ids.flatMap((itemId) => (w.tasks.get(itemId) ?? []).map((link) => ({ itemId, link })));
      const rowIds = [...new Set(links.flatMap(({ link }) => (link.taskRowId ? [link.taskRowId] : [])))];
      const stored = rowIds.length === 0 ? [] : (await query<TaskRow>(
        `select id, project_id, source_item_id, created_by, title, status, assignee
           from tasks where team_id = $1::uuid and id = any($2::uuid[]) order by id`, [input.teamId, rowIds]
      )).rows;
      const storedById = new Map(stored.map((row) => [row.id, row]));
      const associations = links.flatMap(({ itemId, link }) => {
        const row: TaskRow | undefined = link.taskRowId
          ? storedById.get(link.taskRowId)
          : {
            id: link.taskId, project_id: null, source_item_id: link.backingItemId ?? null,
            created_by: link.backingItemId ? null : w.team.memberId, title: link.title, status: link.status, assignee: null,
          };
        if (!row || !rowVisibleByProvenanceCtx(row, ctx)) return [];
        // Only an ADMITTED task contributes anything: its title, its status and its assignee's display name.
        return [{ itemId, taskId: row.id, title: row.title, status: row.status, ...(row.assignee ? { assignee: row.assignee } : {}) }];
      });
      const bundle = {
        locale: "en-US", policyVersion: "1",
        items: items.rows.map((r) => ({ itemId: r.id, title: w.titles.get(r.id) ?? r.path })),
        members: members.rows, associations,
      };
      w.seen.bundles.push(bundle);
      return bundle;
    },
    composeSlackPage: (input: { aggregates: Json[]; presentation: Json; asOf: unknown }) => {
      w.seen.aggregates.push(input.aggregates.map((a) => ({ ...a })));
      const days = composeDays(input.aggregates, input.presentation, input.asOf);
      return w.override.compose ? w.override.compose(days, input as unknown as Json) : days;
    },
    loadInitialNonSlack: async (query: SqlExecutor, input: { teamId: string; admission: ContentAdmission; asOf: unknown }) => {
      w.seen.initial++;
      await observe(w, query, "initial");
      if (w.fail.initial) throw w.fail.initial;
      const visible = await oracleVisible(query, input.teamId, input.admission);
      const rows = w.nonSlack.filter((g) => visible.has(g.itemId));
      const result = {
        sourceItemIds: rows.map((g) => g.itemId),
        days: rows.length === 0 ? [] : [{
          // Labelled from the SAME bound asOf as the Slack composer, as the contract requires.
          date: "2024-06-20", label: labelFor("2024-06-20", input.asOf),
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
async function traverse(w: World, pageSize: number, options: Json = {}, deps: Json = {}): Promise<Traversal> {
  const c = await contract();
  const out: Traversal = { pages: [], ids: [], tuples: [], compact: [] };
  let cursor: string | null = null;
  for (let guard = 0; guard < 2000; guard++) {
    const before = w.seen.aggregates.length;
    const p = await page(w, { pageSize, cursor }, options, deps);
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
    expect(want).toHaveLength(11);
    for (const size of [1, 2, 128]) {
      const run = await traverse(s.w, size);
      expect(run.tuples).toEqual(want);
      expect(run.pages).toHaveLength(Math.ceil(want.length / size));
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

  it("advances exactly once through groups tied on the same six-digit instant", async () => {
    const s = await scene();
    // Eight threads whose only message carries the SAME microsecond: four by A, four by B. Day and
    // instant tie for all eight, so only the item (and then member) components order them.
    const stamp = ts(D20, 123_456);
    const owner = new Map<string, string>();
    for (let n = 0; n < 8; n++) owner.set(await thread(s, `tie-${n}`, stamp, n % 2 === 0 ? "U1" : "U2"), n % 2 === 0 ? s.a.id : s.b.id);
    await converge(s.team);
    for (const size of [1, 3]) {
      const run = await traverse(s.w, size);
      expect(run.tuples).toEqual([...owner.keys()].sort().map((itemId) => ({
        day: "2024-06-20", at: instant(stamp), itemId, memberId: owner.get(itemId),
      })));
    }
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

    const run = await traverse(s.w, 128, { messagePageSize: 100 }, { budgets: { candidateFetchSize: 1 } });
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
      let firstLanded = false;
      let secondLanded = false;
      const deps = dependencies(w);
      const run = () => d.drainSlackTimeline({
        pageSize: 1,
        startPage: (input: Json) => { starts++; return r.readSlackPersonDayPage(request(w, { ...input, cursor: null }), deps); },
        nextPage: async (cursor: string) => {
          // Between page one and page two of the first attempt, a REAL correction lands: lock to B.
          if (!firstLanded) {
            firstLanded = true;
            await correct(s.team, s.x, s.b.email);
          }
          return r.readSlackPersonDayPage(request(w, { pageSize: 1, cursor }), deps);
        },
        validateFinal: async (input: Json) => {
          // The second attempt is one terminal page (B's group). A second real correction lands
          // after its evidence and before final validation: only the fresh final check can see it.
          if (overtakes === 2 && firstLanded && !secondLanded) {
            secondLanded = true;
            await correct(s.team, s.x, s.a.email);
          }
          return r.validateSlackPersonDayFinal({ ...request(w, { pageSize: 1 }), ...input }, deps);
        },
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
        await expectFailure(run, "restart_required");
        expect(starts).toBe(2);
        expect(secondLanded).toBe(true);
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
        // A committed transaction between the two: it changes no data, and it guarantees the
        // validation snapshot cannot be textually identical to the evidence snapshot.
        await runSql(`select txid_current()`);
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

  it("fails its executor closed once the snapshot transaction has ended, for a page that returned and for one that failed", async () => {
    // A dependency may keep the executor it was handed. After the transaction ends its connection is
    // back in the pool: a late statement must be refused, not run on whatever session holds that
    // connection next (source review, LOW 5).
    for (const outcome of ["returned", "failed"] as const) {
      const s = await scene();
      await thread(s, "x", ts(D20, 1), "U1");
      await converge(s.team);
      const real = dependencies(s.w);
      const kept: SqlExecutor[] = [];
      const keep = (name: string) => (query: SqlExecutor, context: Json): unknown => {
        kept.push(query);
        return (real[name] as (q: SqlExecutor, c: Json) => unknown)(query, context);
      };
      const deps = { loadAdmission: keep("loadAdmission"), loadPresentation: keep("loadPresentation"), loadInitialNonSlack: keep("loadInitialNonSlack") };
      let seamExecutor: SqlExecutor | null = null;
      const options: Json = { afterDiscovery: async (query: SqlExecutor) => { seamExecutor = query; } };
      if (outcome === "failed") options.afterEvidence = async () => { throw new Error("fails after the evidence transaction"); };

      if (outcome === "returned") expect((await page(s.w, {}, options, deps)).aggregates).toHaveLength(1);
      else await expectFailure(() => page(s.w, {}, options, deps), "unavailable");

      // While its transaction was open each executor worked (the page above depended on it). Now:
      expect(seamExecutor, "the seam was handed an executor").not.toBeNull();
      const executors = [...new Set([...kept, seamExecutor as unknown as SqlExecutor])];
      expect(executors.length).toBeGreaterThanOrEqual(outcome === "returned" ? 2 : 1);
      const marker = `aio_1170_late_${randomUUID().replace(/-/g, "")}`;
      for (const query of executors) {
        const failure = await failureOf(() => query(`select '${marker}' as marker, pg_backend_pid() as pid`));
        expect(failure).toMatchObject({ name: "SlackTimelineError", code: "unavailable" });
        expect(failure).not.toHaveProperty("rows");
        // A write would be refused the same way: before it reaches any connection at all.
        expect(await failureOf(() => query(`update items set body = 'late' where team_id = $1`, [s.team.teamId]))).toMatchObject({
          name: "SlackTimelineError", code: "unavailable",
        });
      }
      // Nothing was sent: no session ran the marker statement, and no row was touched.
      const ran = await runSql<{ n: number }>(
        `select count(*)::int as n from pg_stat_activity where datname = current_database() and pid <> pg_backend_pid() and query like $1`,
        [`%${marker}%`]
      );
      expect(ran.rows[0].n).toBe(0);
      expect((await runSql<{ n: number }>(`select count(*)::int as n from items where team_id = $1 and body = 'late'`, [s.team.teamId])).rows[0].n).toBe(0);
    }
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

  it("never reads through an ambient transaction: it is refused, or the page demonstrably opens its own", async () => {
    const s = await scene();
    await thread(s, "one", ts(D20, 1), "U1");
    await converge(s.team);
    const r = await reader();
    const outcome = await tx(async (session) => {
      const ambient = (await session.executeSql<{ pid: number }>(`select pg_backend_pid() as pid`)).rows[0].pid;
      try {
        await r.readSlackPersonDayPage(request(s.w), dependencies(s.w), {
          afterDiscovery: (query: SqlExecutor) => observe(s.w, query, "seam"),
        });
        return { ambient, failure: null as Json | null };
      } catch (error) {
        return { ambient, failure: error as Json };
      }
    });
    if (outcome.failure) {
      expect(outcome.failure).toMatchObject({ name: "SlackTimelineError", code: "unavailable" });
    } else {
      expect(s.w.seen.snapshots.length).toBeGreaterThan(0);
      for (const row of s.w.seen.snapshots) {
        expect(row.pid, `${row.label} did not run on the ambient connection`).not.toBe(outcome.ambient);
        expect(row).toMatchObject({ isolation: "repeatable read", readOnly: "on" });
      }
    }
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

  /**
   * Eight groups that an internal fetch of two splits into at least four batches (red review, 4):
   *
   *   1 x·A 06-20 .900   2 y·B 06-20 .800 | 3 y·C 06-20 .700   4 y·B 06-19 .800 | … only y … | (later x)
   *
   * X is loaded in the FIRST batch. Its one later group sits either between y's groups ("middle") or
   * after all of them ("tail"). Every batch after the first holds only y once that group is omitted,
   * so a comparison that looks only at the items of the CURRENT batch never looks at X again.
   */
  async function interleaved(position: "middle" | "tail"): Promise<Scene & { x: string; y: string; omitted: string; laterDay: string }> {
    const s = await scene();
    const team = s.team.teamId;
    const xRoot = ts(D20, 900);
    const yRoot = ts(D20, 800);
    const x = await thread(s, "x", xRoot, "U1");
    const y = await thread(s, "y", yRoot, "U2");
    await message(team, y, ts(D20, 700), { root: yRoot, user: "U3" });
    await message(team, y, ts(D19, 800), { root: yRoot, user: "U2" });
    await message(team, y, ts(D19, 700), { root: yRoot, user: "U3" });
    await message(team, y, ts(D18, 800), { root: yRoot, user: "U2" });
    await message(team, y, ts(D18, 700), { root: yRoot, user: "U3" });
    const later = position === "middle"
      ? { stamp: ts(D19, 750), user: "U2", member: s.b.id, day: "2024-06-19" }
      : { stamp: ts("2024-06-17T16:13:20", 500), user: "U3", member: s.c.id, day: "2024-06-17" };
    await message(team, x, later.stamp, { root: xRoot, user: later.user });
    await converge(s.team);
    return { ...s, x, y, omitted: groupId(x, later.member, later.day), laterDay: later.day };
  }

  it.each(["middle", "tail"] as const)(
    "retains a loaded item across internal fetch batches: a later X group omitted at the %s is found although every remaining batch holds only Y",
    async (position) => {
      const s = await interleaved(position);
      const small = { budgets: { candidateFetchSize: 2 } };

      // Control: the same forced batching with nothing omitted is one complete page of eight groups,
      // read in at least four internal batches of at most two candidates.
      const batches: string[][] = [];
      const clean = await page(s.w, {}, {
        corruptCandidates: (rows: Json[]) => { batches.push(rows.map((r) => String(r.itemId))); return rows; },
      }, small);
      expect(clean.aggregates).toHaveLength(8);
      expect(clean.slackComplete).toBe(true);
      expect(clean.aggregates.map((a: Json) => a.id)).toContain(s.omitted);
      expect(batches.filter((batch) => batch.length > 0).length).toBeGreaterThanOrEqual(4);
      for (const batch of batches) expect(batch.length).toBeLessThanOrEqual(2);
      expect(batches[0]).toEqual([s.x, s.y]);

      // Now omit X's later group from the one batch that carries it.
      const seen: string[][] = [];
      let dropped = 0;
      const failure = await expectFailure(() => page(s.w, {}, {
        corruptCandidates: (rows: Json[]) => {
          const out = rows.filter((r) => !(r.itemId === s.x && r.day === s.laterDay));
          dropped += rows.length - out.length;
          seen.push(out.map((r) => String(r.itemId)));
          return out;
        },
      }, small), "unavailable");
      expect(dropped, "exactly the later X group was omitted").toBe(1);
      // X was loaded in batch one, and after that the reader never saw X in a batch again: at least
      // two later batches held only Y. The omission can therefore only be found from RETAINED state —
      // when the scan frontier passes the missing tuple, or at the latest when SQL exhaustion is claimed.
      expect(seen[0]).toEqual([s.x, s.y]);
      const afterFirst = seen.slice(1);
      expect(afterFirst.flat()).not.toContain(s.x);
      expect(afterFirst.filter((batch) => batch.length > 0 && batch.every((id) => id === s.y)).length).toBeGreaterThanOrEqual(2);
      // Not a short "complete" page of seven, and not a restart: an unexplained missing candidate.
      expect(failure).not.toHaveProperty("aggregates");
      expect(s.w.seen.aggregates.at(-1)?.map((g) => g.id) ?? [], "the seven-group page was never composed").not.toHaveLength(7);
    }
  );

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

  // An item SQL never surfaces at all is outside this per-loaded-item comparison by design. It is
  // covered by the saturation and identity tests above, which compare complete traversals against
  // independently computed expectations; no test here pins that such a fault goes UNDETECTED.
  it("leaves an uncorrupted traversal alone when the seams are present but pass rows through (control)", async () => {
    const s = await twoDays();
    const run = await traverse(s.w, 1, {
      corruptCandidates: (rows: Json[]) => rows, corruptAccountRelation: (relation: Json[]) => relation,
    });
    expect(run.ids).toEqual([
      groupId(s.y, s.c.id, "2024-06-20"), groupId(s.x, s.a.id, "2024-06-20"),
      groupId(s.x, s.a.id, "2024-06-19"), groupId(s.x, s.b.id, "2024-06-18"),
    ]);
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
    // Filters the view key cannot bind are a malformed request, found before any read — not an
    // unavailable dependency found after admission was already loaded (source review, LOW 4).
    ["filters holding a Date", { requestedView: { mode: "timeline", filters: { since: new Date(0) }, locale: "en-US", presentationPolicyVersion: "1" } }],
    ["filters holding NaN", { requestedView: { mode: "timeline", filters: { limit: Number.NaN }, locale: "en-US", presentationPolicyVersion: "1" } }],
    ["filters holding a Set", { requestedView: { mode: "timeline", filters: { memberIds: new Set(["x"]) }, locale: "en-US", presentationPolicyVersion: "1" } }],
    ["filters holding a function", { requestedView: { mode: "timeline", filters: { pick: () => true }, locale: "en-US", presentationPolicyVersion: "1" } }],
    ["filters that are an array", { requestedView: { mode: "timeline", filters: [], locale: "en-US", presentationPolicyVersion: "1" } }],
  ])("refuses %s as an invalid request before any database work", async (_label, over) => {
    const s = await scene();
    await expectFailure(() => page(s.w, over), "invalid_request");
    expect(s.w.seen.admission).toEqual([]);
  });

  it("snapshots the request's filters before its first await: a caller mutating them mid-page changes nothing", async () => {
    const s = await scene();
    await thread(s, "x", ts(D20, 1), "U1");
    await converge(s.team);
    const view = (filters: Json): Json => ({ mode: "timeline", filters, locale: "en-US", presentationPolicyVersion: "1" });
    const expected = (await page(s.w, { requestedView: view({ memberIds: ["a"], nested: { on: true } }) })).binding.viewKey;

    // The caller keeps its object and rewrites it between the evidence and validation snapshots.
    const filters: Json = { memberIds: ["a"], nested: { on: true } };
    const seenBefore = s.w.seen.admission.length;
    const p = await page(s.w, { requestedView: view(filters) }, {
      afterEvidence: async () => {
        (filters.memberIds as string[]).push("b");
        (filters.nested as Json).on = false;
        filters.added = "later";
      },
    });
    // One view for the whole page: no restart, and the key is the ORIGINAL filters' key.
    expect(p.aggregates).toHaveLength(1);
    expect(p.binding.viewKey).toBe(expected);
    expect(p.binding.viewKey).not.toBe((await page(s.w, { requestedView: view(filters) })).binding.viewKey);
    // Both admission reads of that page saw the same copied, immutable filters — never the caller's object.
    const [evidenceRead, validationRead] = s.w.seen.admission.slice(seenBefore, seenBefore + 2) as { requestedView: { filters: Json } }[];
    for (const read of [evidenceRead, validationRead]) {
      expect(read.requestedView.filters).toEqual({ memberIds: ["a"], nested: { on: true } });
      expect(read.requestedView.filters).not.toBe(filters);
      expect(Object.isFrozen(read.requestedView.filters)).toBe(true);
      expect(Object.isFrozen(read.requestedView.filters.memberIds)).toBe(true);
    }
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
      expect(text).toContain(s.x);
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
    // Two legacy Slack rows that DISAGREE (one evidence ID, two titles) are a valid-shape conflict
    // to the shared merger. They must be refused as Slack evidence before any merge: reaching the
    // merger would classify a malformed dependency as restart_required (source review, LOW 2).
    ["conflicting legacy Slack rows the shared merger would call a merge conflict", (r: Json) => {
      const days = structuredClone(r.days) as TimelineDay[];
      const legacy = (title: string) => ({ id: "legacy", title, source: "slack", kind: "thread", at: "2024-06-20T10:00:00Z" });
      days[0].people[0].other.push({ source: "slack", count: 1, items: [legacy("One title")] });
      days[0].people[0].tasks.push({
        taskId: "T", title: "Task", status: "done", source: "linear", evidenceCount: 1,
        sources: [{ source: "slack", count: 1, items: [legacy("Another title")] }],
      });
      return { ...r, days };
    }],
    ["a Slack-sourced row hidden inside a group labelled with another source", (r: Json) => {
      const days = structuredClone(r.days) as TimelineDay[];
      days[0].people[0].other.push({
        source: "github", count: 1, items: [{ id: "legacy", title: "Old Slack row", source: "slack", kind: "thread", at: "2024-06-20T10:00:00Z" }],
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
    expect(failure).not.toHaveProperty("days");
    if (_label === "a backing ID the real oracle does not show") {
      // Not malformed: an ID outside the current real-oracle set is a revocation, found at publication.
      expect(failure.code).toBe("restart_required");
    } else {
      expect(failure.code).toBe("unavailable");
      expect(s.w.seen.aggregates, "rejected before composition").toEqual([]);
    }
  });

  /**
   * A frozen initial snapshot that depends on source items in every way a timeline day can:
   *   g — an evidence row whose own `id` is a same-team item;
   *   h — an item a row CITES through `/library/<id>` while its own id is not an item;
   *   k — a row nested under a task;
   *   d — an item a decision signal cites;
   *   m — the capped third GitHub row and the synopsis: counted and summarized, rendered nowhere.
   * All five are real items the real oracle shows. The declared list must be exactly this set: a
   * list that is well-formed and a subset of the visible set can still be INCOMPLETE, and then the
   * publication and final subset checks have nothing to notice a revocation with (red review, 3).
   */
  type Backing = Record<"g" | "h" | "k" | "d" | "m", string>;
  async function sourcedInitial(): Promise<Scene & { x: string; ids: Backing; result: () => Json }> {
    const s = await scene();
    const x = await thread(s, "x", ts(D20, 1), "U1");
    const ids: Backing = {
      g: await githubItem(s.team, "row"), h: await githubItem(s.team, "cited"), k: await githubItem(s.team, "task-row"),
      d: await githubItem(s.team, "decision"), m: await githubItem(s.team, "capped"),
    };
    await converge(s.team);
    const result = (): Json => ({
      sourceItemIds: [ids.g, ids.h, ids.k, ids.d, ids.m],
      days: [{
        date: "2024-06-20", label: labelFor("2024-06-20", new Date(s.w.nowMs)),
        people: [{
          memberId: s.team.memberId, name: "Tester", handle: "tester", avatarUrl: null, total: 4, unlinked: 3,
          summary: "Opened a pull request and recorded a decision.",
          tasks: [{
            taskId: "T9", title: "Tracked task", status: "in_progress", source: "linear", evidenceCount: 1,
            sources: [{ source: "github", count: 1, items: [{ id: ids.k, title: "Task commit", source: "github", kind: "commit", at: "2024-06-20T08:00:00Z" }] }],
          }],
          other: [{
            source: "github", count: 3, // capped: the third row (m) is counted and summarized, not rendered
            items: [
              { id: ids.g, title: "PR one", source: "github", kind: "pr", at: "2024-06-20T09:00:00Z", url: "https://github.com/acme/repo/pull/1" },
              { id: "commit:abc123", title: "Cited commit", source: "github", kind: "commit", at: "2024-06-20T08:30:00Z", url: `/library/${ids.h}` },
            ],
          }],
          signals: [{ kind: "decision", count: 1, items: [{ id: "decision-1", kind: "decision", title: "Decided X", at: "2024-06-20", url: `/library/${ids.d}` }] }],
        }],
      }],
    });
    s.w.override.initial = () => result();
    return { ...s, x, ids, result };
  }
  const RENDERED = ["PR one", "Cited commit", "Task commit", "Decided X", "Opened a pull request"];

  it("accepts an initial snapshot whose declared backing IDs are exactly its dependency set", async () => {
    const s = await sourcedInitial();
    const all = Object.values(s.ids).sort();
    const one = await page(s.w);
    for (const title of RENDERED) expect(JSON.stringify(one.days)).toContain(title);
    expect([...one.initialNonSlackSourceItemIds].sort()).toEqual(all);
    // Order carries no meaning; the set does.
    s.w.override.initial = () => ({ ...s.result(), sourceItemIds: [...all].reverse() });
    expect([...(await page(s.w)).initialNonSlackSourceItemIds].sort()).toEqual(all);
    // A genuinely unsourced row — its id is no item and it cites none — needs no backing ID.
    s.w.override.initial = () => {
      const r = s.result();
      (r.days as TimelineDay[])[0].people[0].other.push({
        source: "meetings", count: 1, items: [{ id: randomUUID(), title: "Standup", source: "meetings", kind: "meeting", at: "2024-06-20" }],
      });
      return r;
    };
    const withMeeting = await page(s.w);
    expect(JSON.stringify(withMeeting.days)).toContain("Standup");
    expect([...withMeeting.initialNonSlackSourceItemIds].sort()).toEqual(all);
  });

  it.each([
    ["everything: G is rendered and nothing is declared (the review counterexample)", (): string[] => [], "g"],
    ["an evidence row whose own id is a same-team item", (ids: Backing): string[] => [ids.h, ids.k, ids.d, ids.m], "g"],
    ["an item a row cites through its /library link", (ids: Backing): string[] => [ids.g, ids.k, ids.d, ids.m], "h"],
    ["a row nested under a task", (ids: Backing): string[] => [ids.g, ids.h, ids.d, ids.m], "k"],
    ["an item a decision signal cites", (ids: Backing): string[] => [ids.g, ids.h, ids.k, ids.m], "d"],
    ["every rendered dependency, declaring only an unrelated visible item instead", (_ids: Backing, unrelated: string): string[] => [unrelated], "g"],
    ["the synopsis's rendered evidence, declaring only the unrendered capped row", (ids: Backing): string[] => [ids.m], "g"],
  ] as const)("refuses a VALID, visible backing-ID list that omits %s, and never publishes it stale", async (_label, listOf, omitted) => {
    const s = await sourcedInitial();
    const unrelated = await githubItem(s.team, "unrelated");
    await converge(s.team);
    const declared = listOf(s.ids, unrelated);
    s.w.override.initial = () => ({ ...s.result(), sourceItemIds: declared });
    // The list is a well-formed, duplicate-free subset of what the real oracle shows right now, so a
    // shape-and-subset check alone would publish this page. It is an incomplete dependency result.
    const visibleNow = (await runSql<{ id: string }>(
      `select u.source_item_id as id from project_context_memberships m
         join project_context_units u on u.id = m.context_unit_id
        where m.team_id = $1 and m.valid_to is null and u.source_item_id = any($2::uuid[])`, [s.team.teamId, declared]
    )).rows.map((row) => row.id);
    expect([...new Set(visibleNow)].sort()).toEqual([...declared].sort());
    const complete = await expectFailure(() => page(s.w), "unavailable");
    // The stale-publication half of the counterexample: the omitted item is revoked after the
    // evidence read. Nothing declared would have caught it; the page must still not exist.
    const stale = await expectFailure(() => page(s.w, {}, { afterEvidence: () => revokeMembership(s.ids[omitted]) }), "unavailable");
    for (const failure of [complete, stale]) {
      for (const title of RENDERED) expect(JSON.stringify(failure)).not.toContain(title);
    }
  });

  it("enforces a declared dependency no rendered row shows: the synopsis and capped count depend on it", async () => {
    const s = await sourcedInitial();
    expect(JSON.stringify(s.result().days), "m is rendered nowhere").not.toContain(s.ids.m);
    // Revoked between the evidence read and publication: the first page restarts.
    await expectFailure(() => page(s.w, {}, { afterEvidence: () => revokeMembership(s.ids.m) }), "restart_required");

    // Revoked after a published first page: only the final real-oracle subset check can see it.
    const later = await sourcedInitial();
    const r = await reader();
    const one = await page(later.w);
    const input = { ...request(later.w), binding: one.binding, initialNonSlackSourceItemIds: one.initialNonSlackSourceItemIds };
    await expect(r.validateSlackPersonDayFinal(input, dependencies(later.w))).resolves.toBeUndefined();
    await revokeMembership(later.ids.m);
    await expectFailure(() => r.validateSlackPersonDayFinal(input, dependencies(later.w)), "restart_required");
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
    // The admission is the one resolved in that snapshot, complete — not a view key standing in for it.
    expect(first.admission).toEqual(await resolveContentAdmission(db(), s.team.teamId, s.team.memberId));
    expect(String(first.asOf instanceof Date ? (first.asOf as Date).toISOString() : first.asOf)).toBe(ms(NOW_MS));
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
    const run = await traverse(s.w, 1, {}, { budgets: { candidateFetchSize: 2 } });
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
    // The boundary is placed at the reader's LAST clock reading, the check before it returns: no
    // statement follows it, so "exactly the budget" does not also mean "a transaction with no time
    // left to run in". The number of readings for this unchanged fixture is learned from a first run.
    let readings = 0;
    expect((await page(s.w, {}, {}, { monotonicNow: () => { readings++; return 5_000; } })).aggregates).toHaveLength(1);
    expect(readings, "the reader consults the monotonic clock").toBeGreaterThan(1);
    for (const [elapsed, ok] of [[30_000, true], [30_001, false]] as const) {
      let n = 0;
      const run = () => page(s.w, {}, {}, { monotonicNow: () => (++n >= readings ? 5_000 + elapsed : 5_000) });
      if (ok) expect((await run()).aggregates).toHaveLength(1);
      else await expectFailure(run, "budget_exhausted");
      expect(n, "the same number of clock readings as the learning run").toBe(readings);
    }
    // Running out part-way is refused wherever it is noticed: after the evidence read…
    s.w.mono = 5_000;
    await expectFailure(() => page(s.w, {}, { afterEvidence: async () => { s.w.mono = 5_000 + 30_001; } }), "budget_exhausted");
    // …or during it. The wall clock is independent: it stands still while the monotonic budget runs out.
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

  /**
   * Exact-limit coverage for the three read/size ceilings (source review, LOW 6). The totals are not
   * guessed and not searched for: a run that is refused only at PUBLICATION (a one-byte page budget)
   * has finished every read, so its counters are the page's complete row and byte totals. The
   * fixture's own snapshot probe is answered locally, because a backend pid or snapshot text of a
   * different length would make the byte total differ between two otherwise identical runs.
   */
  function steadyDependencies(w: World): Json {
    const real = dependencies(w);
    const steady = (query: SqlExecutor): SqlExecutor => (async (text: string, params?: unknown[]) =>
      text.includes("pg_backend_pid()")
        ? { rows: [{ pid: 1, snapshot: "1:1:", isolation: "repeatable read", readOnly: "on" }], rowCount: 1 }
        : query(text, params)) as SqlExecutor;
    const wrap = (name: string) => (query: SqlExecutor, context: Json): unknown =>
      (real[name] as (q: SqlExecutor, c: Json) => unknown)(steady(query), context);
    return { loadAdmission: wrap("loadAdmission"), loadPresentation: wrap("loadPresentation"), loadInitialNonSlack: wrap("loadInitialNonSlack") };
  }

  it("allows exactly the rows and read bytes a page needs, and refuses one fewer of either", async () => {
    const s = await rejectedRun(2);
    s.w.nonSlack.push({ itemId: await githubItem(s.team, "pr"), title: "PR one", memberId: s.team.memberId });
    await converge(s.team);
    const deps = (budgets: Json): Json => ({ ...steadyDependencies(s.w), budgets });

    const atPublication = await expectFailure(() => page(s.w, {}, {}, deps({ maxPageBytes: 1 })), "budget_exhausted");
    const totals = atPublication.diagnostics as { rowsRead: number; bytesRead: number; candidatesExamined: number };
    expect(Number.isSafeInteger(totals.rowsRead) && totals.rowsRead > 0).toBe(true);
    expect(Number.isSafeInteger(totals.bytesRead) && totals.bytesRead > totals.rowsRead).toBe(true);
    expect(totals.candidatesExamined).toBe(3); // two rejected groups and the deliverable one
    // The totals are a property of the unchanged fixture, not of one run.
    const again = await expectFailure(() => page(s.w, {}, {}, deps({ maxPageBytes: 1 })), "budget_exhausted");
    expect(again.diagnostics).toEqual(totals);

    // Rows: exactly the total passes; one fewer is refused, on the read that completes the total.
    expect((await page(s.w, {}, {}, deps({ maxRows: totals.rowsRead }))).aggregates).toHaveLength(1);
    const rowsShort = await expectFailure(() => page(s.w, {}, {}, deps({ maxRows: totals.rowsRead - 1 })), "budget_exhausted");
    expect(rowsShort.diagnostics).toMatchObject({ rowsRead: totals.rowsRead });
    expect(rowsShort).not.toHaveProperty("aggregates");

    // Read bytes: the same boundary, on cumulative UTF-8 JSON bytes of rows and bundles.
    expect((await page(s.w, {}, {}, deps({ maxReadBytes: totals.bytesRead }))).aggregates).toHaveLength(1);
    const bytesShort = await expectFailure(() => page(s.w, {}, {}, deps({ maxReadBytes: totals.bytesRead - 1 })), "budget_exhausted");
    expect(bytesShort.diagnostics).toMatchObject({ bytesRead: totals.bytesRead });
    expect(bytesShort).not.toHaveProperty("aggregates");

    // Both exact limits together still admit the page; neither budget borrows from the other.
    expect((await page(s.w, {}, {}, deps({ maxRows: totals.rowsRead, maxReadBytes: totals.bytesRead }))).aggregates).toHaveLength(1);
  });

  it("allows a page of exactly its serialized size budget and refuses one byte fewer, terminal or not", async () => {
    const s = await scene();
    await thread(s, "x", ts(D20, 1), "U1");
    await thread(s, "y", ts(D19, 1), "U2");
    s.w.nonSlack.push({ itemId: await githubItem(s.team, "pr"), title: "PR one", memberId: s.team.memberId });
    await converge(s.team);
    // The measured quantity is pinned: UTF-8 bytes of the JSON of the complete page envelope.
    const size = (p: Loose): number => Buffer.byteLength(JSON.stringify(p), "utf8");

    // A terminal first page: both groups, the non-Slack snapshot, no cursor.
    const terminal = await page(s.w);
    expect(terminal).toMatchObject({ slackComplete: true, nextSlackCursor: null });
    const exactTerminal = await page(s.w, {}, {}, { budgets: { maxPageBytes: size(terminal) } });
    expect(exactTerminal).toEqual(terminal);
    const terminalShort = await expectFailure(() => page(s.w, {}, {}, { budgets: { maxPageBytes: size(terminal) - 1 } }), "budget_exhausted");
    expect(terminalShort).not.toHaveProperty("aggregates");

    // A nonterminal first page: its opaque cursor is part of the envelope and of the budget. The
    // token differs per encoding (fresh nonce) but its length does not.
    const first = await page(s.w, { pageSize: 1 });
    expect(first.slackComplete).toBe(false);
    const exactFirst = await page(s.w, { pageSize: 1 }, {}, { budgets: { maxPageBytes: size(first) } });
    expect(size(exactFirst)).toBe(size(first));
    expect({ ...exactFirst, nextSlackCursor: null }).toEqual({ ...first, nextSlackCursor: null });
    await expectFailure(() => page(s.w, { pageSize: 1 }, {}, { budgets: { maxPageBytes: size(first) - 1 } }), "budget_exhausted");

    // And a continuation, which carries no non-Slack snapshot.
    const second = await page(s.w, { pageSize: 1, cursor: first.nextSlackCursor });
    expect((await page(s.w, { pageSize: 1, cursor: first.nextSlackCursor }, {}, { budgets: { maxPageBytes: size(second) } })).aggregates).toHaveLength(1);
    await expectFailure(() => page(s.w, { pageSize: 1, cursor: first.nextSlackCursor }, {}, { budgets: { maxPageBytes: size(second) - 1 } }), "budget_exhausted");
  });

  it("reports a monotonic clock that throws as unavailable, on its first reading and on any later one", async () => {
    const s = await rejectedRun(1);
    // The first reading is taken before any transaction exists (source review, LOW 3).
    const before = s.w.seen.admission.length;
    await expectFailure(() => page(s.w, {}, {}, { monotonicNow: () => { throw new Error("clock device failed"); } }), "unavailable");
    expect(s.w.seen.admission.length, "nothing was read").toBe(before);
    // A later reading: learn how many a clean page takes, then fail each of a spread of them.
    let readings = 0;
    await page(s.w, {}, {}, { monotonicNow: () => { readings++; return 0; } });
    expect(readings).toBeGreaterThan(3);
    for (const failAt of [...new Set([2, 3, Math.ceil(readings / 2), readings - 1, readings])]) {
      let n = 0;
      const failure = await expectFailure(() => page(s.w, {}, {}, {
        monotonicNow: () => { if (++n === failAt) throw new Error("clock device failed"); return 0; },
      }), "unavailable");
      expect(String(failure.message)).not.toContain("clock device failed");
    }
    // A clock that misreports is the same failed dependency.
    for (const value of [Number.NaN, Number.POSITIVE_INFINITY, "0", null]) {
      await expectFailure(() => page(s.w, {}, {}, { monotonicNow: () => value }), "unavailable");
    }
    // Final validation reads the same clock under the same contract.
    const r = await reader();
    const one = await page(s.w);
    const input = { ...request(s.w), binding: one.binding, initialNonSlackSourceItemIds: one.initialNonSlackSourceItemIds };
    await expectFailure(() => r.validateSlackPersonDayFinal(input, dependencies(s.w, { monotonicNow: () => { throw new Error("clock device failed"); } })), "unavailable");
    // No transaction is left open by any of these.
    expect((await runSql<{ n: number }>(
      `select count(*)::int as n from pg_stat_activity
        where datname = current_database() and pid <> pg_backend_pid() and state like 'idle in transaction%'`
    )).rows[0].n).toBe(0);
  });

  it.each(["now", "monotonicNow", "loadAdmission", "loadPresentation", "composeSlackPage", "loadInitialNonSlack"])(
    "is unavailable without its %s dependency",
    async (missing) => {
      const s = await scene();
      await expectFailure(() => page(s.w, {}, {}, { [missing]: undefined }), "unavailable");
    }
  );
});

/**
 * Red review, finding 5. The elapsed-time tests above advance a clock inside callbacks that then
 * RETURN, so they prove a check after the fact. A page budget must also end work that never returns:
 *
 *  - Every opaque loader is handed `signal: AbortSignal` in its context object.
 *  - While any awaited work is pending the reader holds a deadline through the injectable
 *    `scheduleDeadline(callback, delayMs) => cancel` (default: the platform timer), with a delay no
 *    longer than the remaining elapsed budget. When it fires, the reader aborts that signal, rolls
 *    its transaction back, releases the connection and rejects `budget_exhausted` — without waiting
 *    for the abandoned work, and never with a partial page.
 *  - Both transactions run under a transaction-local `statement_timeout` no longer than the
 *    remaining budget (and never 0, which PostgreSQL reads as "no timeout"), so a statement that
 *    never returns is cancelled by the server.
 *
 * Nothing here sleeps: fake timers are fired by hand, pending work is a promise the test holds, and
 * the one real wait is PostgreSQL cancelling its own statement.
 */
describe("aggregate Slack page — pending work, cancellation and statement timeouts", () => {
  interface FakeTimer { fire: () => void; delayMs: number; cancelled: boolean; fired: boolean }

  function fakeTimers(): { timers: FakeTimer[]; scheduleDeadline: (callback: () => void, delayMs: number) => () => void; fireAll: () => void } {
    const timers: FakeTimer[] = [];
    return {
      timers,
      scheduleDeadline: (callback, delayMs) => {
        const timer: FakeTimer = { fire: callback, delayMs, cancelled: false, fired: false };
        timers.push(timer);
        return () => { timer.cancelled = true; };
      },
      // Fire every armed timer, including any re-armed by a callback, a bounded number of rounds.
      fireAll: () => {
        for (let round = 0; round < 8; round++) {
          const armed = timers.filter((t) => !t.cancelled && !t.fired);
          if (armed.length === 0) return;
          for (const t of armed) { t.fired = true; t.fire(); }
        }
      },
    };
  }

  type Settled = { state: "pending" } | { state: "fulfilled"; value: unknown } | { state: "rejected"; error: Json };

  interface Watched { state: () => Settled; done: Promise<Settled> }

  /**
   * Take ownership of a promise the moment it exists. Both handlers are attached synchronously, so
   * its rejection is always handled — it cannot surface as an unhandled rejection however early it
   * fails — and `done` itself never rejects, so it is safe to race and to await in a `finally`.
   */
  function watch(promise: Promise<unknown>): Watched {
    let outcome: Settled = { state: "pending" };
    const done = promise.then(
      (value): Settled => (outcome = { state: "fulfilled", value }),
      (error): Settled => (outcome = { state: "rejected", error: error as Json })
    );
    return { state: () => outcome, done };
  }

  const turn = (): Promise<void> => new Promise<void>((resolve) => setImmediate(resolve));

  /**
   * The state after the event loop AND the database have each had a bounded chance to move it: a
   * fixed number of loop turns and real round trips. Used to show a run is still pending. No sleep.
   */
  async function idle(run: Watched, turns = 25, roundTrips = 5): Promise<Settled> {
    for (let n = 0; n < turns && run.state().state === "pending"; n++) await turn();
    for (let n = 0; n < roundTrips && run.state().state === "pending"; n++) await runSql(`select 1`).catch(() => undefined);
    return run.state();
  }

  /**
   * Wait for a run that is EXPECTED to settle, for at most a fixed number of database round trips
   * (each is real I/O time for a rollback and a connection release, and none is a sleep). Never
   * throws and never waits unboundedly: a run that is still pending is returned as pending.
   */
  async function settlesWithin(run: Watched, roundTrips = 400): Promise<Settled> {
    for (let n = 0; n < roundTrips && run.state().state === "pending"; n++) {
      await runSql(`select 1`).catch(() => undefined);
      await turn();
    }
    return run.state();
  }

  /** Sessions other than this one still inside a transaction, after a bounded number of round trips. */
  async function openTransactionsSettleToZero(): Promise<number> {
    let open = -1;
    for (let n = 0; n < 60; n++) {
      open = (await runSql<{ n: number }>(
        `select count(*)::int as n from pg_stat_activity
          where datname = current_database() and pid <> pg_backend_pid() and state like 'idle in transaction%'`
      )).rows[0].n;
      if (open === 0) return 0;
    }
    return open;
  }

  /** Work that never settles until the test lets go of it, and a signal for "the reader got here". */
  function neverSettles(): { work: Promise<never>; entered: Promise<void>; enter: () => void; finishLate: () => void } {
    let enter = (): void => undefined;
    let finishLate = (): void => undefined;
    const entered = new Promise<void>((resolve) => { enter = resolve; });
    const work = new Promise<never>((_resolve, reject) => { finishLate = () => reject(new Error("abandoned work finished late")); });
    work.catch(() => undefined); // the test owns this promise; the reader must not need it to settle
    return { work, entered, enter, finishLate };
  }

  async function oneThread(): Promise<Scene> {
    const s = await scene();
    await thread(s, "x", ts(D20, 1), "U1");
    s.w.nonSlack.push({ itemId: await githubItem(s.team, "pr"), title: "PR one", memberId: s.team.memberId });
    await converge(s.team);
    return s;
  }

  type PendingPoint =
    | "loadAdmission" | "loadPresentation" | "loadInitialNonSlack"
    | "loadAdmission (validation transaction)" | "loadPresentation (validation transaction)"
    | "in-transaction work after discovery" | "work between the two transactions";

  it.each<PendingPoint>([
    "loadAdmission", "loadPresentation", "loadInitialNonSlack",
    "loadAdmission (validation transaction)", "loadPresentation (validation transaction)",
    "in-transaction work after discovery", "work between the two transactions",
  ])("ends a page whose %s never settles: abort, rollback, budget_exhausted, no partial page", async (point) => {
    const s = await oneThread();
    const clock = fakeTimers();
    const pending = neverSettles();
    const real = dependencies(s.w);
    let signal: AbortSignal | undefined;
    const calls: Record<string, number> = {};
    /** A loader that hangs on its `hangOn`-th call and otherwise behaves exactly like the real fixture. */
    const hanging = (name: string, hangOn: number) => (query: SqlExecutor, context: Json): unknown => {
      calls[name] = (calls[name] ?? 0) + 1;
      if (calls[name] !== hangOn) return (real[name] as (q: SqlExecutor, c: Json) => unknown)(query, context);
      signal = context.signal as AbortSignal;
      pending.enter();
      return pending.work;
    };
    const deps: Json = { scheduleDeadline: clock.scheduleDeadline, monotonicNow: () => s.w.mono };
    const options: Json = {};
    const [name, phase] = point.split(" (");
    if (name.startsWith("load")) deps[name] = hanging(name, phase ? 2 : 1);
    else if (point === "in-transaction work after discovery") options.afterDiscovery = () => { pending.enter(); return pending.work; };
    else options.afterEvidence = () => { pending.enter(); return pending.work; };

    s.w.mono = 1_000;
    // The run is observed in the SAME tick it is created: it can never become an unhandled rejection,
    // whether it fails before reaching the held work (a missing module does), during it, or after.
    const run = watch(page(s.w, {}, options, deps));
    try {
      // Either the reader reaches the work that will never finish, or the run ended first. An early
      // end is reported at once — as its own failure — instead of waiting on an entry that cannot come.
      const first = await Promise.race([pending.entered.then(() => "entered" as const), run.done]);
      if (first !== "entered") {
        if (first.state === "rejected") throw first.error;
        throw new Error("the page completed without reaching the work that never settles");
      }
      expect((await idle(run)).state, "nothing ends the page before its deadline").toBe("pending");

      // The pending work is guarded by a live deadline no longer than the remaining 30-second budget.
      const armed = clock.timers.filter((t) => !t.cancelled && !t.fired);
      expect(armed.length, "a deadline is armed while work is pending").toBeGreaterThan(0);
      for (const t of clock.timers) {
        expect(Number.isFinite(t.delayMs) && t.delayMs > 0, "a deadline is a positive finite delay").toBe(true);
        expect(t.delayMs).toBeLessThanOrEqual(30_000);
      }
      if (name.startsWith("load")) {
        expect(signal, "the loader was handed an AbortSignal").toBeInstanceOf(AbortSignal);
        expect(signal?.aborted).toBe(false);
      }

      // The monotonic clock passes the budget and the deadline fires. The work is STILL pending:
      // the test has not let go of it, so only the deadline can end the page.
      s.w.mono = 1_000 + 30_001;
      clock.fireAll();
      const after = await settlesWithin(run);
      expect(after.state, "the page ends on its deadline without waiting for the abandoned work").toBe("rejected");
      const failure = (after as { error: Json }).error;
      expect(failure).toMatchObject({ name: "SlackTimelineError", code: "budget_exhausted" });
      for (const partial of ["days", "aggregates", "binding", "nextSlackCursor", "slackComplete"]) expect(failure).not.toHaveProperty(partial);
      if (name.startsWith("load")) expect(signal?.aborted, "the abandoned loader was told to stop").toBe(true);
      expect(clock.timers.filter((t) => !t.cancelled && !t.fired), "no deadline is left armed").toEqual([]);

      // The transaction was rolled back and its connection released although the work never returned.
      expect(await openTransactionsSettleToZero()).toBe(0);
      // Abandoned work finishing late changes nothing and poisons nothing.
      pending.finishLate();
      expect((await idle(run)).state).toBe("rejected");
      expect(run.state()).toBe(after);
      s.w.mono = 0;
      expect((await page(s.w)).aggregates).toHaveLength(1);
    } finally {
      // Whatever happened above — an early failure, a failed assertion, or success — nothing this
      // test started is left running: the budget is spent, every armed deadline is fired down, the
      // held work is released, and the run is given a bounded number of round trips to settle.
      s.w.mono = 1_000 + 30_001;
      clock.fireAll();
      pending.finishLate();
      await settlesWithin(run);
      for (const t of clock.timers) t.cancelled = true;
    }
  });

  it("cancels its deadlines and aborts nothing on a page that completes normally", async () => {
    const s = await oneThread();
    const clock = fakeTimers();
    const real = dependencies(s.w);
    const signals: AbortSignal[] = [];
    const recording = (name: string) => (query: SqlExecutor, context: Json): unknown => {
      signals.push(context.signal as AbortSignal);
      return (real[name] as (q: SqlExecutor, c: Json) => unknown)(query, context);
    };
    const p = await page(s.w, {}, {}, {
      scheduleDeadline: clock.scheduleDeadline,
      loadAdmission: recording("loadAdmission"), loadPresentation: recording("loadPresentation"), loadInitialNonSlack: recording("loadInitialNonSlack"),
    });
    expect(p.aggregates).toHaveLength(1);
    expect(clock.timers.length, "the page armed a deadline").toBeGreaterThan(0);
    expect(clock.timers.filter((t) => !t.cancelled), "every deadline was cancelled").toEqual([]);
    // Admission and presentation are each read twice (evidence, validation); the initial loader once.
    expect(signals).toHaveLength(5);
    for (const signal of signals) {
      expect(signal).toBeInstanceOf(AbortSignal);
      expect(signal.aborted).toBe(false);
    }
    // A deadline that fires after the page was returned is inert.
    for (const t of clock.timers) t.fire();
    expect(signals.every((signal) => !signal.aborted)).toBe(true);
    expect(await openTransactionsSettleToZero()).toBe(0);
  });

  it.each([
    ["a non-function", 42],
    ["a scheduler that returns no cancel function", () => undefined],
  ])("refuses %s as its deadline scheduler: unavailable, with no transaction left open", async (_label, scheduleDeadline) => {
    const s = await oneThread();
    await expectFailure(() => page(s.w, {}, {}, { scheduleDeadline }), "unavailable");
    expect(await openTransactionsSettleToZero()).toBe(0);
  });

  it("runs both transactions under a local statement timeout no longer than the remaining budget, and never zero", async () => {
    const timeoutMs = async (query: SqlExecutor): Promise<number> =>
      (await query<{ ms: number }>(`select setting::int as ms from pg_settings where name = 'statement_timeout'`)).rows[0].ms;
    for (const [budgets, spentBetween] of [[{}, 0], [{ maxElapsedMs: 5_000 }, 0], [{ maxElapsedMs: 5_000 }, 2_000], [{}, 12_345]] as const) {
      const s = await oneThread();
      const limit = (budgets as { maxElapsedMs?: number }).maxElapsedMs ?? 30_000;
      const real = dependencies(s.w);
      const seen: { phase: string; ms: number }[] = [];
      let admissions = 0;
      s.w.mono = 0;
      await page(s.w, {}, {
        afterTransactionConfigured: async (query: SqlExecutor) => { seen.push({ phase: "evidence", ms: await timeoutMs(query) }); },
        afterEvidence: async () => { s.w.mono = spentBetween; },
      }, {
        budgets,
        loadAdmission: async (query: SqlExecutor, context: Json) => {
          if (++admissions === 2) seen.push({ phase: "validation", ms: await timeoutMs(query) });
          return (real.loadAdmission as (q: SqlExecutor, c: Json) => unknown)(query, context);
        },
      });
      expect(seen.map((row) => row.phase)).toEqual(["evidence", "validation"]);
      const [evidence, validation] = seen;
      expect(evidence.ms).toBeGreaterThan(0);
      expect(evidence.ms).toBeLessThanOrEqual(limit);
      // Zero would mean "no timeout" to PostgreSQL: the bound is always positive, and it SHRINKS with
      // the budget already spent — a timeout fixed at the whole budget is not the remaining runtime.
      expect(validation.ms).toBeGreaterThan(0);
      expect(validation.ms).toBeLessThanOrEqual(limit - spentBetween);
      // Transaction-local: a pooled connection is not left with the page's timeout.
      const outside = (await runSql<{ ms: number }>(`select setting::int as ms from pg_settings where name = 'statement_timeout'`)).rows[0].ms;
      const baseline = (await runSql<{ ms: number }>(`select reset_val::int as ms from pg_settings where name = 'statement_timeout'`)).rows[0].ms;
      expect(outside).toBe(baseline);
    }
  });

  /**
   * Source review, MEDIUM. A timeout applied once — at transaction start, or at a few points between
   * phases — lets a LATER statement run under the larger bound an earlier statement was given. The
   * executor must re-derive the transaction-local timeout from the budget that actually remains
   * immediately before EVERY statement. Each case below spends budget on the monotonic clock between
   * two consecutive statements of ONE callback, with no phase boundary in between, and then asks the
   * server what bound the very next statement runs under.
   */
  it("re-derives the statement timeout before every statement: a later statement never inherits an older, larger one", { timeout: 20_000 }, async () => {
    const timeoutMs = async (query: SqlExecutor): Promise<number> =>
      (await query<{ ms: number }>(`select setting::int as ms from pg_settings where name = 'statement_timeout'`)).rows[0].ms;

    // Evidence transaction, inside one seam call.
    const s = await oneThread();
    const inert = fakeTimers();
    const evidence: number[] = [];
    s.w.mono = 0;
    await page(s.w, {}, {
      afterDiscovery: async (query: SqlExecutor) => {
        evidence.push(await timeoutMs(query));
        s.w.mono = 10_000;
        evidence.push(await timeoutMs(query));
        s.w.mono = 25_000;
        evidence.push(await timeoutMs(query));
        s.w.mono = 0; // the budget is given back so the rest of the page can finish
        evidence.push(await timeoutMs(query));
      },
    }, { scheduleDeadline: inert.scheduleDeadline });
    expect(evidence[0]).toBeGreaterThan(20_000);
    expect(evidence[0]).toBeLessThanOrEqual(30_000);
    // Ten seconds later, the next statement runs under at most twenty; then at most five.
    expect(evidence[1]).toBeGreaterThan(0);
    expect(evidence[1]).toBeLessThanOrEqual(20_000);
    expect(evidence[2]).toBeGreaterThan(0);
    expect(evidence[2]).toBeLessThanOrEqual(5_000);
    // The bound follows the remaining budget in both directions; it is not a ratchet either.
    expect(evidence[3]).toBe(evidence[0]);

    // Validation transaction, inside one loader call: consecutive statements of a dependency.
    const v = await oneThread();
    const real = dependencies(v.w);
    const validation: number[] = [];
    let admissions = 0;
    v.w.mono = 0;
    await page(v.w, {}, {}, {
      scheduleDeadline: fakeTimers().scheduleDeadline,
      loadAdmission: async (query: SqlExecutor, context: Json) => {
        if (++admissions === 2) {
          validation.push(await timeoutMs(query));
          v.w.mono = 18_000;
          validation.push(await timeoutMs(query));
          v.w.mono = 0;
        }
        return (real.loadAdmission as (q: SqlExecutor, c: Json) => unknown)(query, context);
      },
    });
    expect(validation[0]).toBeGreaterThan(20_000);
    expect(validation[1]).toBeGreaterThan(0);
    expect(validation[1]).toBeLessThanOrEqual(12_000);

    // And the server ENFORCES the refreshed bound: after the budget shrinks to half a second, the
    // very next statement — three seconds of server-side work — is cancelled by the server. Under an
    // inherited thirty-second timeout it would simply finish, and this assertion would fail.
    const c = await oneThread();
    let cancelled: Json | null = null;
    let finished = false;
    c.w.mono = 0;
    const failure = await expectFailure(() => page(c.w, {}, {
      afterDiscovery: async (query: SqlExecutor) => {
        expect(await timeoutMs(query)).toBeGreaterThan(20_000);
        c.w.mono = 29_500;
        try {
          await query(`select pg_sleep(3)`);
          finished = true;
        } catch (error) {
          cancelled = error as Json;
          throw error;
        }
      },
    }, { scheduleDeadline: fakeTimers().scheduleDeadline }), "budget_exhausted");
    expect(finished, "the later statement did not run to completion under an older timeout").toBe(false);
    expect(cancelled).toMatchObject({ code: "57014" }); // query_canceled: statement timeout
    expect(String(failure.message)).not.toContain("pg_sleep");
    expect(await openTransactionsSettleToZero()).toBe(0);
  });

  it("lets PostgreSQL cancel a statement that outlives the budget, and reports budget_exhausted", { timeout: 20_000 }, async () => {
    const s = await oneThread();
    let cancelled: Json | null = null;
    // The reader's own deadline timer is replaced by one that never fires, so only the SERVER can
    // end the statement: this isolates the statement timeout from the client-side deadline.
    const inert = fakeTimers();
    const failure = await expectFailure(() => page(s.w, {}, {
      afterDiscovery: async (query: SqlExecutor) => {
        try {
          // Five seconds of server-side work against a one-second budget. Nothing in this test waits:
          // the server ends the statement, or the assertion below fails when it returns normally.
          await query(`select pg_sleep(5)`);
        } catch (error) {
          cancelled = error as Json;
          throw error;
        }
      },
    }, { budgets: { maxElapsedMs: 1_000 }, scheduleDeadline: inert.scheduleDeadline }), "budget_exhausted");
    expect(inert.timers.every((t) => !t.fired), "no client-side deadline fired").toBe(true);
    expect(cancelled, "the statement was ended by the server, not allowed to finish").not.toBeNull();
    expect(cancelled).toMatchObject({ code: "57014" }); // query_canceled: statement timeout
    expect(String(failure.message)).not.toContain("pg_sleep");
    expect(await openTransactionsSettleToZero()).toBe(0);
    expect((await page(s.w)).aggregates).toHaveLength(1);
  });

  // ── final review, finding 1: the deadline covers transaction ACQUISITION and SETUP ──────────────
  //
  // The page's deadline was raced only against injected callbacks. Obtaining the transaction itself —
  // the pool checkout, BEGIN, and the transaction's configuration — sat outside it: with the pool
  // exhausted the page stayed pending past its budget. These cases block the REAL pool and the REAL
  // session, never a loader, and require the page (and final validation) to end on its own deadline
  // while the checkout or the setup statement is still outstanding. Whatever arrives late must be
  // disposed safely: no session left in a transaction, no client left checked out, a healthy pool.

  type Phase = "the evidence transaction" | "the validation transaction" | "final validation";
  const PHASES: Phase[] = ["the evidence transaction", "the validation transaction", "final validation"];
  /**
   * A budget generous enough that the real statements run BEFORE the block (their transaction-local
   * timeout is this budget) cannot trip on a slow machine. Elapsed time is the fake monotonic clock.
   */
  const BUDGET_MS = 5_000;

  /** Check out every connection the pool may open, so the NEXT checkout has to wait. */
  async function holdWholePool(): Promise<{ pool: Pool; release: () => void }> {
    const pool = getPool();
    const held: PoolClient[] = [];
    try {
      for (let n = 0; n < pool.options.max; n++) held.push(await pool.connect());
    } catch (error) {
      // A checkout that fails part-way must not strand the clients already taken: hand every one
      // back before the failure is reported, or the rest of the file runs on a starved pool.
      for (const client of held) client.release();
      throw error;
    }
    let released = false;
    return { pool, release: () => { if (!released) { released = true; for (const client of held) client.release(); } } };
  }

  interface LateClient {
    /** Every statement sent on the client between its late acquisition and its disposal. */
    statements: string[];
    disposed: boolean;
    /** True when it was released WITH an error or flag, which makes the pool destroy the session. */
    destroyed: boolean;
  }

  /**
   * Watches the client(s) the pool hands to a WAITER while `during()` runs. pg-pool serves a queued
   * checkout synchronously inside `release()`, so every `acquire` emitted during that call belongs to
   * a waiter — here, the checkout the unit under test abandoned at its deadline. Each such client is
   * instrumented before the pool gives it to its waiter, and watched until the pool sees it released.
   */
  function lateClients(pool: Pool): { seen: LateClient[]; during: (release: () => void) => void; stop: () => void } {
    const seen: LateClient[] = [];
    const tracked = new Map<PoolClient, { entry: LateClient; restore: () => void }>();
    let serving = false;
    const onAcquire = (client: PoolClient): void => {
      if (!serving || tracked.has(client)) return;
      const entry: LateClient = { statements: [], disposed: false, destroyed: false };
      seen.push(entry);
      const original = client.query as unknown as (...args: unknown[]) => unknown;
      (client as unknown as { query: unknown }).query = function (this: unknown, ...args: unknown[]): unknown {
        const first = args[0] as { text?: unknown } | string | undefined;
        entry.statements.push(typeof first === "string" ? first : String(first?.text ?? "(statement)"));
        return original.apply(this, args);
      };
      tracked.set(client, { entry, restore: () => { delete (client as unknown as { query?: unknown }).query; } });
    };
    const onRelease = (error: unknown, client: PoolClient): void => {
      const watched = tracked.get(client);
      if (!watched) return;
      watched.entry.disposed = true;
      watched.entry.destroyed = Boolean(error);
      // From here the pool may hand the client to anyone: stop recording, restore the driver's method.
      watched.restore();
      tracked.delete(client);
    };
    pool.on("acquire", onAcquire);
    pool.on("release", onRelease);
    return {
      seen,
      during: (release) => {
        serving = true;
        try { release(); } finally { serving = false; }
      },
      stop: () => {
        pool.off("acquire", onAcquire);
        pool.off("release", onRelease);
        for (const watched of tracked.values()) watched.restore();
        tracked.clear();
      },
    };
  }

  /** Event-loop turns only — usable while the pool is exhausted and no round trip is possible. */
  async function turnsWhile(condition: () => boolean, limit = 400): Promise<void> {
    for (let n = 0; n < limit && condition(); n++) await turn();
  }

  /** No client checked out, nobody waiting, no session inside a transaction — after bounded round trips. */
  async function poolSettlesClean(pool: Pool): Promise<{ waiting: number; checkedOut: number; inTransaction: number }> {
    const inTransaction = await openTransactionsSettleToZero();
    for (let n = 0; n < 200 && (pool.waitingCount !== 0 || pool.totalCount !== pool.idleCount); n++) await runSql(`select 1`).catch(() => undefined);
    return { waiting: pool.waitingCount, checkedOut: pool.totalCount - pool.idleCount, inTransaction };
  }

  /** Start the unit under test for one phase; `blockNow` is called at the moment that phase's transaction is about to be obtained. */
  async function startPhase(s: Scene, phase: Phase, deps: Json, blockNow: () => Promise<void>): Promise<{ run: Watched; blocked: Promise<void> }> {
    const r = await reader();
    let markBlocked = (): void => undefined;
    const blocked = new Promise<void>((resolve) => { markBlocked = resolve; });
    const block = async (): Promise<void> => { await blockNow(); markBlocked(); };
    if (phase === "the validation transaction") {
      return { run: watch(page(s.w, {}, { afterEvidence: block }, deps)), blocked };
    }
    // The published page final validation checks is read BEFORE anything is blocked.
    const published = phase === "final validation" ? await page(s.w) : null;
    await block();
    const run = published === null
      ? watch(page(s.w, {}, {}, deps))
      : watch(r.validateSlackPersonDayFinal(
        { ...request(s.w), binding: published.binding, initialNonSlackSourceItemIds: published.initialNonSlackSourceItemIds },
        dependencies(s.w, deps)
      ));
    return { run, blocked };
  }

  it.each(PHASES)("ends on the page deadline while the pool checkout for %s is still blocked, and disposes the late client", { timeout: 30_000 }, async (phase) => {
    const s = await oneThread();
    const clock = fakeTimers();
    const pool = getPool();
    let hold: { release: () => void } | null = null;
    let started: { run: Watched; blocked: Promise<void> } | null = null;
    const late = lateClients(pool);
    s.w.mono = 0;
    try {
      started = await startPhase(s, phase, { scheduleDeadline: clock.scheduleDeadline, budgets: { maxElapsedMs: BUDGET_MS } }, async () => {
        hold = await holdWholePool();
      });
      const { run, blocked } = started;
      const first = await Promise.race([blocked.then(() => "blocked" as const), run.done]);
      if (first !== "blocked") {
        if (first.state === "rejected") throw first.error;
        throw new Error("the run completed before its transaction could be blocked");
      }
      // The scenario is real: the unit under test is queued on the pool, and nothing has ended it.
      await turnsWhile(() => pool.waitingCount === 0 && run.state().state === "pending");
      expect(pool.waitingCount, "the transaction's checkout is waiting on the exhausted pool").toBeGreaterThanOrEqual(1);
      expect(run.state().state).toBe("pending");
      expect(clock.timers.filter((t) => !t.cancelled && !t.fired).length, "a deadline is armed while the checkout is pending").toBeGreaterThan(0);

      // One millisecond past the budget. The pool is STILL exhausted: only the deadline can end this.
      s.w.mono = BUDGET_MS + 1;
      clock.fireAll();
      await turnsWhile(() => run.state().state === "pending");
      const after = run.state();
      expect(after.state, "the deadline ends it without waiting for a connection").toBe("rejected");
      const failure = (after as { error: Json }).error;
      expect(failure).toMatchObject({ name: "SlackTimelineError", code: "budget_exhausted" });
      for (const partial of ["days", "aggregates", "binding", "nextSlackCursor", "slackComplete"]) expect(failure).not.toHaveProperty(partial);
      expect(clock.timers.filter((t) => !t.cancelled && !t.fired), "no deadline is left armed").toEqual([]);

      // Only now is a connection available. The checkout that was abandoned receives its client LATE.
      // Ending the PROMISE on time is not enough: racing the whole transaction helper against the
      // deadline does that too, and then lets the helper wake up on this client and run BEGIN, SET
      // TRANSACTION and its configuration read for a page that no longer exists. So the late client
      // itself is watched from the instant the pool serves it: it must be disposed — handed back, or
      // destroyed — without one statement ever being sent on it.
      const waiting = pool.waitingCount;
      late.during(() => (hold as { release: () => void } | null)?.release());
      expect(late.seen, "each abandoned checkout was served a client late").toHaveLength(waiting);
      await turnsWhile(() => late.seen.some((client) => !client.disposed));
      for (let n = 0; n < 200 && late.seen.some((client) => !client.disposed); n++) await runSql(`select 1`).catch(() => undefined);
      for (const client of late.seen) {
        expect(client.statements, "no statement was sent on the late client before it was disposed").toEqual([]);
        expect(client.disposed, "the late client was disposed, not kept").toBe(true);
      }

      // And eventually: nothing waiting, nothing checked out, nothing in a transaction.
      expect(await poolSettlesClean(pool)).toEqual({ waiting: 0, checkedOut: 0, inTransaction: 0 });
      expect(run.state()).toBe(after);
      // The pool is healthy: an ordinary page reads again.
      s.w.mono = 0;
      expect((await page(s.w)).aggregates).toHaveLength(1);
    } finally {
      // Runs after a failed assertion too: spend the budget, fire down every deadline, free the pool,
      // give the run a bounded chance to settle, and take the instrumentation off the pool's clients.
      s.w.mono = BUDGET_MS + 1;
      clock.fireAll();
      (hold as { release: () => void } | null)?.release();
      if (started) await settlesWithin(started.run);
      late.stop();
      for (const t of clock.timers) t.cancelled = true;
    }
  });

  it.each(PHASES)("ends on the page deadline while the acquired session for %s is still busy before BEGIN, and never reuses that session mid-statement", { timeout: 30_000 }, async (phase) => {
    const s = await oneThread();
    const clock = fakeTimers();
    const pool = getPool();
    // The next client the pool hands out is given two seconds of server-side work FIRST, so the
    // transaction helper's own BEGIN queues behind it: acquisition succeeded, SETUP is what blocks.
    let busy: Promise<void> | null = null;
    // The statement's two possible ends are told apart: it ran to COMPLETION on the server (two
    // seconds), or it was ABORTED because the session was destroyed under it. A safe reader may do
    // the second at once; only waiting for the first is what the page's deadline forbids.
    let completed = false;
    let aborted = false;
    const stillRunning = (): boolean => !completed && !aborted;
    let busyClient: PoolClient | null = null;
    // What the POOL saw happen to that one session, each event stamped with whether its statement was
    // still running. `reusable` is a release the pool would keep for the next caller: no error passed,
    // and the session neither closing nor unqueryable (pg-pool's own condition for removing it).
    const handedBack: { whileBusy: boolean; reusable: boolean }[] = [];
    const takenAgain: { whileBusy: boolean }[] = [];
    const occupy = (client: PoolClient): void => {
      if (busy === null) {
        busyClient = client;
        busy = client.query(`select pg_sleep(2)`).then(() => { completed = true; }, () => { aborted = true; });
        return;
      }
      if (client === busyClient) takenAgain.push({ whileBusy: stillRunning() });
    };
    const disposed = (error: unknown, client: PoolClient): void => {
      if (client !== busyClient) return;
      const session = client as unknown as { _ending?: boolean; _queryable?: boolean };
      handedBack.push({ whileBusy: stillRunning(), reusable: !error && session._ending !== true && session._queryable !== false });
    };
    let started: { run: Watched; blocked: Promise<void> } | null = null;
    s.w.mono = 0;
    try {
      started = await startPhase(s, phase, { scheduleDeadline: clock.scheduleDeadline, budgets: { maxElapsedMs: BUDGET_MS } }, async () => {
        pool.on("acquire", occupy);
        pool.on("release", disposed);
      });
      const { run, blocked } = started;
      const first = await Promise.race([blocked.then(() => "blocked" as const), run.done]);
      if (first !== "blocked") {
        if (first.state === "rejected") throw first.error;
        throw new Error("the run completed before its transaction could be blocked");
      }
      await turnsWhile(() => busy === null && run.state().state === "pending");
      expect(busy, "the transaction's session was acquired and is busy").not.toBeNull();
      expect(run.state().state).toBe("pending");

      s.w.mono = BUDGET_MS + 1;
      clock.fireAll();
      await turnsWhile(() => run.state().state === "pending");
      const after = run.state();
      // Ended by the deadline, not by the session finally getting round to BEGIN two seconds later.
      // (Destroying the session aborts its statement; that is not the statement completing.)
      expect(completed, "the page did not wait for the session's statement to run to completion").toBe(false);
      expect(after.state).toBe("rejected");
      expect((after as { error: Json }).error).toMatchObject({ name: "SlackTimelineError", code: "budget_exhausted" });
      expect(clock.timers.filter((t) => !t.cancelled && !t.fired), "no deadline is left armed").toEqual([]);

      // The page is over and its session is mid-statement. Ending the promise must not put that
      // session back into circulation: a reusable release now would let the next checkout share a
      // connection that is still executing, with the helper's BEGIN queued behind it. The pool is
      // used here, before the statement could have completed, exactly as any other caller would use
      // it: a session wrongly put back is the one the pool hands out next.
      expect(completed, "the statement has not completed while the pool is used again").toBe(false);
      for (let n = 0; n < 3; n++) await runSql(`select 1`);

      // Let the server finish (or the destroyed session drop) its statement; this is the test's only
      // real wait and the server bounds it. The observers stay on the pool until the session's fate
      // is known: disposed at least once, after bounded round trips.
      await busy;
      for (let n = 0; n < 200 && handedBack.length === 0; n++) await runSql(`select 1`).catch(() => undefined);
      expect(handedBack.length, "the timed-out session was disposed").toBeGreaterThanOrEqual(1);
      // Either its statement was over, or it was disposed destructively. Never reusable while busy…
      expect(handedBack.filter((event) => event.whileBusy && event.reusable), "no reusable release while the session was busy").toEqual([]);
      // …and so never handed to another checkout while busy.
      expect(takenAgain.filter((event) => event.whileBusy), "the busy session was never acquired again").toEqual([]);

      // And eventually: nothing waiting, nothing checked out, nothing in a transaction.
      expect(await poolSettlesClean(pool)).toEqual({ waiting: 0, checkedOut: 0, inTransaction: 0 });
      expect(run.state()).toBe(after);
      s.w.mono = 0;
      expect((await page(s.w)).aggregates).toHaveLength(1);
    } finally {
      // Runs after a failed assertion too. The statement the test started is always awaited (the
      // server bounds it at two seconds), so no query of this test outlives it on a pooled session.
      pool.off("acquire", occupy);
      pool.off("release", disposed);
      s.w.mono = BUDGET_MS + 1;
      clock.fireAll();
      if (busy) await busy;
      if (started) await settlesWithin(started.run);
      for (const t of clock.timers) t.cancelled = true;
    }
  });

  // ── final review, finding 5: the cursor key is captured before the first await ─────────────────

  it("seals the next cursor with the key it was GIVEN: a caller overwriting its buffer while a dependency is suspended changes nothing", async () => {
    const s = await scene();
    await thread(s, "x", ts(D20, 1), "U1");
    await thread(s, "y", ts(D19, 1), "U2");
    await thread(s, "z", ts(D18, 1), "U3");
    await converge(s.team);
    const c = await contract();
    const original = Buffer.from(KEY);
    const real = dependencies(s.w);

    for (const when of ["during the evidence admission read", "between the two transactions", "during the validation admission read"] as const) {
      // Each run hands over its OWN buffer and overwrites it mid-page, as a caller zeroising key material would.
      const callerKey = Buffer.from(original);
      let admissions = 0;
      const overwrite = (): void => { callerKey.fill(0xee); };
      const run = async (cursor: string | null): Promise<Loose> => {
        admissions = 0;
        callerKey.set(original);
        return page(s.w, { pageSize: 1, cursor }, when === "between the two transactions" ? { afterEvidence: async () => overwrite() } : {}, {
          slackTimelineCursorKey: callerKey,
          loadAdmission: async (query: SqlExecutor, context: Json) => {
            const result = await (real.loadAdmission as (q: SqlExecutor, x: Json) => Promise<unknown>)(query, context);
            admissions++;
            // The loader is suspended on a real read just above; the caller's buffer changes under it.
            if ((when === "during the evidence admission read" && admissions === 1) ||
                (when === "during the validation admission read" && admissions === 2)) overwrite();
            return result;
          },
        });
      };

      const first = await run(null);
      expect(callerKey.equals(original), `${when}: the caller's buffer really was overwritten`).toBe(false);
      expect(first.nextSlackCursor).not.toBeNull();
      // The cursor verifies under the ORIGINAL bytes — the configuration captured before any await…
      expect(c.decodeSlackTimelineCursor(first.nextSlackCursor, original)).toEqual({
        ...first.binding, lastAggregateTuple: first.aggregates[0].tuple,
      });
      // …and not under whatever the caller's buffer became.
      await expectFailure(() => c.decodeSlackTimelineCursor(first.nextSlackCursor, Buffer.alloc(32, 0xee)), "invalid_request");

      // A continuation both OPENS its cursor and SEALS the next one with the captured key.
      const second = await run(first.nextSlackCursor);
      expect(second.aggregates).toHaveLength(1);
      expect(second.nextSlackCursor).not.toBeNull();
      expect(c.decodeSlackTimelineCursor(second.nextSlackCursor, original).lastAggregateTuple).toEqual(second.aggregates[0].tuple);
      // And the traversal completes for a caller that still holds the true key.
      const third = await page(s.w, { pageSize: 1, cursor: second.nextSlackCursor });
      expect(third).toMatchObject({ slackComplete: true, nextSlackCursor: null });
      expect(third.aggregates).toHaveLength(1);
    }
  });

  // ── final review, finding 6: transaction-control results are materialized rows too ─────────────

  /**
   * Every result the DATABASE returned on connections checked out while armed, tallied at the driver:
   * nothing here reads the reader's own counters. A result with no rows materializes nothing.
   */
  function tallyMaterializedResults(): { rows: () => number; bytes: () => number; stop: () => void } {
    const pool = getPool();
    const patched = new Set<PoolClient>();
    let rows = 0;
    let bytes = 0;
    const count = (result: unknown): void => {
      for (const one of Array.isArray(result) ? result : [result]) {
        const got = (one as { rows?: unknown } | null | undefined)?.rows;
        if (!Array.isArray(got) || got.length === 0) continue;
        rows += got.length;
        bytes += Buffer.byteLength(JSON.stringify(got), "utf8");
      }
    };
    const instrument = (client: PoolClient): void => {
      if (patched.has(client)) return;
      patched.add(client);
      const original = client.query as unknown as (...args: unknown[]) => unknown;
      (client as unknown as { query: unknown }).query = function (this: unknown, ...args: unknown[]): unknown {
        const out = original.apply(this, args);
        if (out === null || typeof out !== "object" || typeof (out as PromiseLike<unknown>).then !== "function") return out;
        return (out as Promise<unknown>).then((result) => { count(result); return result; });
      };
    };
    pool.on("acquire", instrument);
    return {
      rows: () => rows,
      bytes: () => bytes,
      stop: () => {
        pool.off("acquire", instrument);
        for (const client of patched) delete (client as unknown as { query?: unknown }).query; // back to the prototype's method
        patched.clear();
      },
    };
  }

  it("meters every row the database actually materializes for a page — the transaction's own control results included", async () => {
    const s = await oneThread();
    const real = dependencies(s.w);
    // The fixture's snapshot probe is answered locally so two runs are byte-identical (a backend pid
    // of another length would change the byte totals); everything else goes to the database.
    const steady = (query: SqlExecutor): SqlExecutor => (async (text: string, params?: unknown[]) =>
      text.includes("pg_backend_pid()")
        ? { rows: [{ pid: 1, snapshot: "1:1:", isolation: "repeatable read", readOnly: "on" }], rowCount: 1 }
        : query(text, params)) as SqlExecutor;
    const wrap = (name: string) => (query: SqlExecutor, context: Json): unknown =>
      (real[name] as (q: SqlExecutor, x: Json) => unknown)(steady(query), context);
    const loaders = { loadAdmission: wrap("loadAdmission"), loadPresentation: wrap("loadPresentation"), loadInitialNonSlack: wrap("loadInitialNonSlack") };

    /** One page refused only at PUBLICATION: every read is done, so both tallies are the page's totals. */
    const totals = async (options: Json): Promise<{ reader: { rowsRead: number; bytesRead: number }; driver: { rows: number; bytes: number } }> => {
      const tally = tallyMaterializedResults();
      try {
        s.w.mono = 0;
        const failure = await expectFailure(() => page(s.w, {}, options, { ...loaders, budgets: { maxPageBytes: 1 } }), "budget_exhausted");
        return { reader: failure.diagnostics as { rowsRead: number; bytesRead: number }, driver: { rows: tally.rows(), bytes: tally.bytes() } };
      } finally {
        tally.stop();
      }
    };
    const probes = async (query: SqlExecutor, perturbClock: boolean): Promise<void> => {
      // Two ordinary statements. With `perturbClock` the remaining budget changes before each, so the
      // transaction issues two more of its OWN control statements; the data read is identical.
      if (perturbClock) s.w.mono = 10_000;
      await query(`select 1 as probe`);
      if (perturbClock) s.w.mono = 0;
      await query(`select 1 as probe`);
    };

    const plain = await totals({ afterDiscovery: (query: SqlExecutor) => probes(query, false) });
    expect(plain.driver.rows).toBeGreaterThan(0);
    // The reader's row count IS the number of rows the database returned on its connections.
    expect(plain.reader.rowsRead, "rows the reader metered vs rows the driver saw returned").toBe(plain.driver.rows);
    // Deterministic for an unchanged fixture, at the driver as well as in the reader.
    expect(await totals({ afterDiscovery: (query: SqlExecutor) => probes(query, false) })).toEqual(plain);

    // More control statements, same data: whatever extra the database materializes, the reader meters.
    const perturbed = await totals({ afterDiscovery: (query: SqlExecutor) => probes(query, true) });
    expect(perturbed.reader.rowsRead).toBe(perturbed.driver.rows);
    expect(perturbed.reader.rowsRead - plain.reader.rowsRead, "extra rows metered vs extra rows materialized").toBe(perturbed.driver.rows - plain.driver.rows);
    expect(perturbed.reader.bytesRead - plain.reader.bytesRead, "extra bytes metered vs extra bytes materialized").toBe(perturbed.driver.bytes - plain.driver.bytes);

    // The exact boundary, set from the DRIVER's count and not from the reader's: exactly that many
    // rows is allowed, one fewer is refused. A reader that leaves its control results unmetered
    // still fits under the smaller budget, and so fails here.
    const options = { afterDiscovery: (query: SqlExecutor) => probes(query, false) };
    s.w.mono = 0;
    expect((await page(s.w, {}, options, { ...loaders, budgets: { maxRows: plain.driver.rows } })).aggregates).toHaveLength(1);
    const short = await expectFailure(() => page(s.w, {}, options, { ...loaders, budgets: { maxRows: plain.driver.rows - 1 } }), "budget_exhausted");
    expect(short).not.toHaveProperty("aggregates");
    expect(await openTransactionsSettleToZero()).toBe(0);
  });
});

// ── final review: the frozen non-Slack snapshot, malformed rows, and the real task-provenance owner ──

/** True when the value and everything reachable from it is frozen. */
function deepFrozen(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return true;
  return Object.isFrozen(value) && Object.values(value as object).every(deepFrozen);
}

describe("aggregate Slack page — final-review falsifiers: frozen snapshot, row shapes, real task provenance", () => {
  /** A team with one thread (A on the 20th, B on the 19th) and one visible GitHub item. */
  async function base(): Promise<Scene & { x: string; g: string }> {
    const s = await scene();
    const x = await thread(s, "x", ts(D20, 1), "U1");
    await message(s.team.teamId, x, ts(D19, 1), { root: ts(D20, 1), user: "U2" });
    const g = await githubItem(s.team, "pr");
    await converge(s.team);
    return { ...s, x, g };
  }

  // Finding 2. The shared merger copies containers but keeps the row, signal-item and assignee
  // OBJECTS it was given. A loader that keeps its own graph — a cache does — can therefore change a
  // page after its evidence snapshot was read, or after it was published.
  it("publishes the non-Slack snapshot as it was READ: mutating the loader's retained rows, signals and nested fields changes nothing", async () => {
    const s = await base();
    const meetingId = randomUUID();
    /** A fresh object graph each time, with handles on every nested object a loader could retain. */
    const build = () => {
      const meeting = { id: meetingId, title: "Standup", source: "meetings", kind: "meeting", at: "2024-06-20" };
      const cited = {
        id: s.g, title: "PR one", source: "github", kind: "pr", at: "2024-06-20T09:00:00Z",
        url: "https://github.com/acme/repo/pull/1", linkedTask: { key: "AIO-1", title: "Linked task", status: "open" },
      };
      const taskRow = { id: "commit:abc123", title: "Task commit", source: "github", kind: "commit", at: "2024-06-20T08:00:00Z" };
      const signalItem = { id: "decision-1", kind: "decision", title: "Decided X", at: "2024-06-20", url: `/library/${s.g}`, stillValid: true };
      const assignee = { name: "Owner Name", avatarUrl: null as string | null };
      const result = {
        sourceItemIds: [s.g],
        days: [{
          date: "2024-06-20", label: labelFor("2024-06-20", new Date(s.w.nowMs)),
          people: [{
            memberId: s.team.memberId, name: "Tester", handle: "tester", avatarUrl: null, total: 3, unlinked: 2, summary: "Did things.",
            tasks: [{
              taskId: "T9", title: "Tracked task", status: "in_progress", source: "linear", evidenceCount: 1, assignee,
              sources: [{ source: "github", count: 1, items: [taskRow] }],
            }],
            other: [{ source: "github", count: 1, items: [cited] }, { source: "meetings", count: 1, items: [meeting] }],
            signals: [{ kind: "decision", count: 1, items: [signalItem] }],
          }],
        }],
      };
      /** Every write is attempted; an object the reader froze in place simply refuses it. */
      const mutate = (): void => {
        const attempts: (() => void)[] = [
          () => { meeting.title = "MUTATED meeting"; },
          () => { meeting.at = "2024-06-19"; },
          () => { cited.title = "MUTATED row"; },
          () => { cited.url = "https://example.com/MUTATED"; },
          () => { cited.linkedTask.title = "MUTATED nested task"; },
          () => { taskRow.title = "MUTATED task row"; },
          () => { signalItem.title = "MUTATED signal"; },
          () => { signalItem.stillValid = false; },
          () => { assignee.name = "MUTATED assignee"; },
          () => { result.days[0].people[0].summary = "MUTATED synopsis"; },
          () => { result.days[0].people[0].name = "MUTATED person"; },
          () => { result.days[0].people[0].tasks[0].title = "MUTATED task"; },
          () => { result.days[0].people[0].other[0].items.push({ ...cited, id: "commit:late", title: "MUTATED added row" }); },
          () => { result.days[0].people[0].signals[0].items.push({ ...signalItem, id: "decision-late", title: "MUTATED added signal" }); },
          () => { result.sourceItemIds.push(randomUUID()); },
        ];
        for (const attempt of attempts) {
          try { attempt(); } catch { /* frozen in place: also immutable */ }
        }
      };
      return { result, mutate };
    };

    // What the snapshot publishes when nobody touches it.
    const untouched = build();
    s.w.override.initial = () => untouched.result as unknown as Json;
    const clean = await page(s.w);
    const snapshotBytes = JSON.stringify(clean.days);
    for (const shown of ["Standup", "PR one", "Linked task", "Task commit", "Decided X", "Owner Name", "Did things."]) expect(snapshotBytes).toContain(shown);

    // Mutated between the evidence snapshot and publication.
    const during = build();
    s.w.override.initial = () => during.result as unknown as Json;
    const published = await page(s.w, {}, { afterEvidence: async () => during.mutate() });
    expect(JSON.stringify(published.days), "the page is the snapshot that was read").toBe(snapshotBytes);
    expect(JSON.stringify(published)).not.toContain("MUTATED");
    expect(published.initialNonSlackSourceItemIds).toEqual(clean.initialNonSlackSourceItemIds);

    // Mutated AFTER publication, through the loader's graph: the page already returned is unaffected.
    const later = build();
    s.w.override.initial = () => later.result as unknown as Json;
    const returned = await page(s.w);
    later.mutate();
    expect(JSON.stringify(returned.days)).toBe(snapshotBytes);
    expect(JSON.stringify(returned)).not.toContain("MUTATED");

    // And nobody holding the PAGE can change it either: the first page's days are frozen all the way down.
    for (const p of [clean, published, returned]) {
      expect(deepFrozen(p.days), "page days are deeply frozen").toBe(true);
      expect(deepFrozen(p.initialNonSlackSourceItemIds), "backing IDs are frozen").toBe(true);
    }
    // A frozen first page still drains: the shared merger copies, it does not write into its input.
    expect((await contract()).mergeSlackTimelineDays(published.days, [])).toHaveLength(2);
  });

  // Finding 3. A group of a non-Slack source whose rows are not rows reached the shared merger, which
  // threw on them, and the wrapper reported that as a cross-page conflict: restart_required. A
  // malformed dependency result is unavailable, before anything is merged.
  const prRow = (id: string, over: Json = {}): Json => ({ id, title: "PR", source: "github", kind: "pr", at: "2024-06-20T09:00:00Z", ...over });
  const withoutKey = (row: Json, key: string): Json => { const copy = { ...row }; delete copy[key]; return copy; };

  it.each([
    ["two null rows (the review counterexample)", [null, null]],
    ["one null row", [null]],
    ["a string where a row belongs", ["row", prRow("g2")]],
    ["an array where a row belongs", [[], prRow("g2")]],
    ["a number where a row belongs", [7, prRow("g2")]],
    ["a row with no id", [withoutKey(prRow("g1"), "id"), prRow("g2")]],
    ["a row whose id is not a string", [prRow("g1", { id: 42 }), prRow("g2")]],
    ["rows with no instant", [withoutKey(prRow("g1"), "at"), withoutKey(prRow("g2"), "at")]],
    ["a row whose instant is not a string", [prRow("g1", { at: 20240620 }), prRow("g2")]],
  ])("refuses an initial non-Slack group holding %s as unavailable, before any merge or composition", async (_label, items) => {
    for (const placement of ["other", "task"] as const) {
      const s = await base();
      const group = { source: "github", count: 2, items };
      s.w.override.initial = () => ({
        sourceItemIds: [],
        days: [{
          date: "2024-06-20", label: labelFor("2024-06-20", new Date(s.w.nowMs)),
          people: [{
            memberId: s.team.memberId, name: "Tester", handle: "tester", avatarUrl: null, total: 2, unlinked: 2, signals: [],
            tasks: placement === "task"
              ? [{ taskId: "T9", title: "Tracked task", status: "in_progress", source: "linear", evidenceCount: 2, sources: [group] }]
              : [],
            other: placement === "other" ? [group] : [],
          }],
        }],
      });
      const failure = await expectFailure(() => page(s.w), "unavailable");
      expect(String(failure.message), placement).not.toMatch(/disagree|conflict/i);
      expect(s.w.seen.aggregates, `${placement}: refused before composition`).toEqual([]);
    }
  });

  it("still accepts well-formed non-Slack rows, capped or not (control)", async () => {
    const s = await base();
    s.w.override.initial = () => ({
      sourceItemIds: [s.g],
      days: [{
        date: "2024-06-20", label: labelFor("2024-06-20", new Date(s.w.nowMs)),
        people: [{
          memberId: s.team.memberId, name: "Tester", handle: "tester", avatarUrl: null, total: 5, unlinked: 5, tasks: [], signals: [],
          // `count` may exceed the rendered rows: that is a cap, not a malformation.
          other: [{ source: "github", count: 5, items: [prRow(s.g), prRow("commit:abc123", { kind: "commit", at: "2024-06-20" })] }],
        }],
      }],
    });
    const p = await page(s.w);
    expect(JSON.stringify(p.days)).toContain("commit:abc123");
    expect(p.aggregates).toHaveLength(2);
  });

  // Finding 4 (N2). The presentation fixture now asks the EXISTING provenance owner about real
  // `tasks` rows. These cases use rows the old fixture admitted merely because they named no backing
  // item: a sourced task whose source was purged, and a hand-entered task in a project the viewer was
  // never granted.
  let rowKey = 0;
  async function insertTask(s: Scene, projectId: string, over: Json): Promise<string> {
    const { data, error } = await db().from("tasks").insert({
      team_id: s.team.teamId, project_id: projectId, row_key: `N2-${randomUUID().slice(0, 8)}-${++rowKey}`, title: "task",
      assignee: "Nobody", status: "in_progress", audience: "team", origin: "ui", ...over,
    }).select("id").single();
    if (error || !data) throw new Error(`fixture: task insert failed: ${error?.message}`);
    return (data as { id: string }).id;
  }
  async function projectOf(itemId: string): Promise<string> {
    return (await runSql<{ project_id: string }>(`select project_id from items where id = $1`, [itemId])).rows[0].project_id;
  }
  async function newProject(s: Scene, name: string): Promise<string> {
    const { data, error } = await db().from("projects").insert({
      team_id: s.team.teamId, slug: `${name}-${randomUUID().slice(0, 8)}`, name, kind: "initiative",
    }).select("id").single();
    if (error || !data) throw new Error(`fixture: project insert failed: ${error?.message}`);
    return (data as { id: string }).id;
  }
  const DENIED = ["Purged sourced task", "Purged Assignee", "Ungranted hand-entered task", "Ungranted Assignee", "Hidden-source task", "Hidden Assignee"];

  it("denies a purged sourced task and a task whose source is not visible to EVERY reader, assignee included, and they cannot move the digest", async () => {
    const s = await base();
    const project = await projectOf(s.x);
    const hidden = await githubItem(s.team, "hidden-basis");
    await converge(s.team);
    await revokeMembership(hidden);
    const handEntered = await insertTask(s, await newProject(s, "elsewhere"), {
      title: "Hand-entered task", assignee: "Hand Assignee", source_item_id: null, created_by: s.team.memberId,
    });
    const sourced = await insertTask(s, project, {
      title: "Visible sourced task", assignee: "Sourced Assignee", origin: "sync", source_item_id: s.g, created_by: null,
    });
    // A synced task whose source was purged: no source left, and never hand-entered.
    const purged = await insertTask(s, project, {
      title: "Purged sourced task", assignee: "Purged Assignee", origin: "sync", source_item_id: null, created_by: null,
    });
    const hiddenSource = await insertTask(s, project, {
      title: "Hidden-source task", assignee: "Hidden Assignee", origin: "sync", source_item_id: hidden, created_by: null,
    });
    const allowed = [realTask(handEntered), realTask(sourced)];
    s.w.tasks.set(s.x, [...allowed, realTask(purged), realTask(hiddenSource)]);

    const one = await page(s.w, { pageSize: 1 });
    // The loader was handed the snapshot's own admission: the seed member is an Everyone reader.
    expect(s.w.seen.presentation.at(-1)?.admission).toMatchObject({ kind: "member", memberId: s.team.memberId, everyone: true });
    const bundle = JSON.stringify(s.w.seen.bundles.at(-1));
    const composed = JSON.stringify(one.days);
    for (const text of [bundle, composed]) {
      // An Everyone reader keeps every hand-entered task, in any project, and a task whose source it sees…
      for (const shown of ["Hand-entered task", "Hand Assignee", "Visible sourced task", "Sourced Assignee"]) expect(text).toContain(shown);
      // …and nobody keeps a task with no provenance left, or one whose source is not visible.
      for (const denied of DENIED) expect(text).not.toContain(denied);
      for (const id of [purged, hiddenSource]) expect(text).not.toContain(id);
    }

    // The denied rows are not part of the bound presentation: without them the digest is identical…
    s.w.tasks.set(s.x, allowed);
    expect((await page(s.w, { pageSize: 1 })).binding.presentationInputDigest).toBe(one.binding.presentationInputDigest);
    // …and changing them between pages is not a change to anything the viewer was shown.
    s.w.tasks.set(s.x, [...allowed, realTask(purged), realTask(hiddenSource)]);
    await runSql(`update tasks set title = 'Renamed while denied', assignee = 'Renamed denied assignee' where id = any($1::uuid[])`, [[purged, hiddenSource]]);
    const two = await page(s.w, { pageSize: 1, cursor: one.nextSlackCursor });
    expect(two.aggregates).toHaveLength(1);
    expect(JSON.stringify(two.days)).not.toContain("Renamed");
    // An ADMITTED task's assignee is bound: changing it does require restart.
    const again = await page(s.w, { pageSize: 1 });
    await runSql(`update tasks set assignee = 'New owner' where id = $1`, [sourced]);
    await expectFailure(() => page(s.w, { pageSize: 1, cursor: again.nextSlackCursor }), "restart_required");
    // And a real sourced task follows its source's membership, exactly like the fixture-only control above.
    const beforeRevocation = await page(s.w, { pageSize: 1 });
    await revokeMembership(s.g);
    await expectFailure(() => page(s.w, { pageSize: 1, cursor: beforeRevocation.nextSlackCursor }), "restart_required");
    expect(JSON.stringify((await traverse(s.w, 1)).pages)).not.toContain("Visible sourced task");
  });

  it("denies a hand-entered task in a project the reader was never granted, and still shows the one in a granted project", async () => {
    const s = await base();
    // A reader who is NOT an Everyone member: an external human whose only grant is one project,
    // reached through a group. The thread is placed in that project, so they see it by membership.
    const viewerId = await externalMember(s.team);
    const granted = await newProject(s, "granted");
    const ungranted = await newProject(s, "ungranted");
    const group = await createGroup(db(), s.team.teamId, `rg-${randomUUID().slice(0, 8)}`, "RG", s.team.memberId);
    await grantProjectToGroup(db(), s.team.teamId, granted, group.groupId!, s.team.memberId);
    const joined = await db().from("group_members").upsert(
      { team_id: s.team.teamId, group_id: group.groupId, member_id: viewerId }, { onConflict: "group_id,member_id" }
    );
    expect(joined.error, "fixture: the reader joins the granted group").toBeNull();
    const { data: unit } = await db().from("project_context_units").select("id").eq("source_item_id", s.x).single();
    await db().from("project_context_memberships").update({ valid_to: new Date().toISOString() }).eq("context_unit_id", unit!.id).is("valid_to", null);
    const placed = await db().from("project_context_memberships").insert({
      team_id: s.team.teamId, project_id: granted, context_unit_id: unit!.id, method: "manual",
    });
    expect(placed.error, "fixture: the thread is placed in the granted project").toBeNull();

    const inGranted = await insertTask(s, granted, {
      title: "Granted hand-entered task", assignee: "Granted Assignee", source_item_id: null, created_by: s.team.memberId,
    });
    const inUngranted = await insertTask(s, ungranted, {
      title: "Ungranted hand-entered task", assignee: "Ungranted Assignee", source_item_id: null, created_by: s.team.memberId,
    });
    const purged = await insertTask(s, granted, {
      title: "Purged sourced task", assignee: "Purged Assignee", origin: "sync", source_item_id: null, created_by: null,
    });
    s.w.tasks.set(s.x, [realTask(inGranted), realTask(inUngranted), realTask(purged)]);

    const viewer = { principal: { teamId: s.team.teamId, memberId: viewerId } };
    const one = await page(s.w, { ...viewer, pageSize: 1 });
    // Fixture preconditions, stated so a broken fixture cannot pass for a denial.
    const admission = s.w.seen.presentation.at(-1)?.admission as { kind: string; everyone: boolean; grantedProjectIds: string[] };
    expect(admission).toMatchObject({ kind: "member", memberId: viewerId, everyone: false });
    expect(admission.grantedProjectIds).toContain(granted);
    expect(admission.grantedProjectIds).not.toContain(ungranted);
    expect(one.aggregates.map((a: Json) => a.id)).toEqual([groupId(s.x, s.a.id, "2024-06-20")]);

    const bundle = JSON.stringify(s.w.seen.bundles.at(-1));
    const composed = JSON.stringify(one.days);
    for (const text of [bundle, composed]) {
      for (const shown of ["Granted hand-entered task", "Granted Assignee"]) expect(text).toContain(shown);
      for (const denied of DENIED) expect(text).not.toContain(denied);
      for (const id of [inUngranted, purged]) expect(text).not.toContain(id);
    }
    // Denied rows are outside the digest for this reader too.
    s.w.tasks.set(s.x, [realTask(inGranted)]);
    expect((await page(s.w, { ...viewer, pageSize: 1 })).binding.presentationInputDigest).toBe(one.binding.presentationInputDigest);
    s.w.tasks.set(s.x, [realTask(inGranted), realTask(inUngranted), realTask(purged)]);
    await runSql(`update tasks set title = 'Renamed while denied' where id = any($1::uuid[])`, [[inUngranted, purged]]);
    expect((await page(s.w, { ...viewer, pageSize: 1, cursor: one.nextSlackCursor })).aggregates).toHaveLength(1);
    // The owner decides per READER: the previous case shows an Everyone member keeping a hand-entered
    // task in a project nobody granted them, which this reader is denied.
  });
});
