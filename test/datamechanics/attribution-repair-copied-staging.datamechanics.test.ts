import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { Client } from "pg";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AttributionRepairPendingError, authorizationEpoch } from "@/lib/access/authorization-epoch";
import { addAuthorAlias } from "@/lib/admin/aliases";
import { readTimelineCache, resolveTimelineVariant, writeTimelineCache } from "@/lib/dashboard/timeline-cache";
import { getPool } from "@/lib/db/pg/pool";
import type { DbClient } from "@/lib/db/types";
import { describeManualRepair } from "@/lib/ingest/attribution-repair-report";
import { startAttributionRepairScheduler } from "@/lib/ingest/attribution-repair-scheduler";
import {
  discoverPendingAttributionRepairs,
  kickAttributionRepair,
  onAttributionRepairKick,
  repairAttributionNow,
} from "@/lib/ingest/reconcile-attribution";
import { resolveIntegrationsAdmin } from "@/lib/integrations/read";
import { isCopiedStagingRuntime } from "@/lib/staging/runtime-policy";
import { db, seedTeam, type Seed } from "./helpers";

/**
 * ATTRIBUTION REPAIR ON A COPIED-STAGING RUNTIME, against real PostgreSQL with the actual copied-
 * staging policy in force (AIO-1167, Stage-4 HOLD remediation).
 *
 * Spec. Copied staging suppresses every in-process scheduler on purpose, and that includes the
 * attribution-repair scheduler. It is an exception to AUTOMATIC continuation only. Reads stay
 * fenced until a repair's strict finalization, the upgrade/restore migration still seeds every
 * team pending, and a roster change still invalidates — so the only thing that converges a repair
 * there is the trusted manual action, run by an authorized admin until it reports completion:
 *
 *   1. the scheduler does not start, and nothing discovers pending work by itself;
 *   2. repeated manual runs converge migration-seeded pending work AND a later roster change that
 *      nothing announced — across more work than one manual budget: the cursor is kept between
 *      runs, reads are fenced after every partial run, and the strict purge and the epoch advance
 *      come before any read resumes;
 *   3. contention, a process that dies between batches, and a failed purge all leave work the next
 *      manual run recovers;
 *   4. a partial or busy result — from the Admin button or from a post-mutation hook — never says
 *      the repair continues in the background. In a normal runtime it still does say so.
 *
 * The Admin action and the hooks are the REAL ones; only the session lookup, the cache
 * revalidation and the post-response deferral — which need a live Next request — are stood in for.
 */

const admin = vi.hoisted(() => ({ teamId: "", memberId: "" }));
const deferred = vi.hoisted(() => ({ callbacks: [] as Array<() => unknown> }));

vi.mock("@/lib/auth/guard", () => ({
  requireTeamAdmin: async () => (admin.teamId ? { teamId: admin.teamId, memberId: admin.memberId } : null),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/server", async (original) => ({
  ...(await original<typeof import("next/server")>()),
  // The post-response hook, held so the test runs it when it means to — as the platform would
  // after the response has been sent.
  after: (callback: () => unknown) => { deferred.callbacks.push(callback); },
}));

const { addMemberEmail, linkMemberIdentity, reattributeIdentitiesNow } = await import("@/app/t/[team]/admin/members/actions");

/** Anything that would read as "this will finish by itself". */
const PROMISES_BACKGROUND = /continuing in the background|continues? in the background|will (continue|resume|finish)|automatically|scheduler/i;
const MANUAL_NEXT_STEP = "Progress is saved, but background continuation is disabled on this deployment: an admin must run Re-attribute content again";

/** The statement with which the snapshot-fence migration seeds an upgraded or restored database. */
const MIGRATION_SEED = /insert into team_identity_authority\(team_id,revision,repair_revision,repair_status,completed_at\)\s+select id,1,1,'pending',null from teams\s+on conflict \(team_id\) do nothing;/
  .exec(readFileSync("postgres/migrations/20260922190000_identity_snapshot_fence.sql", "utf8"))?.[0];

interface AuthorityRow {
  repair_status: string;
  revision: number;
  cursor_item_id: string | null;
  items_scanned: number;
  items_updated: number;
  attempts: number;
  last_error: string | null;
  deferred: boolean;
}

async function authority(seed: Seed): Promise<AuthorityRow> {
  const { rows } = await getPool().query<AuthorityRow>(
    `select repair_status, revision::int as revision, cursor_item_id, items_scanned::int as items_scanned,
            items_updated::int as items_updated, attempts, last_error,
            coalesce(next_attempt_at > now(), false) as deferred
       from team_identity_authority where team_id=$1`, [seed.teamId]);
  return rows[0];
}

/** The durable epoch itself — readable while the fence refuses the application's own read of it. */
async function storedEpoch(seed: Seed): Promise<number> {
  const { rows } = await getPool().query<{ epoch: number }>(
    "select epoch::int as epoch from team_authorization_epochs where team_id=$1", [seed.teamId]);
  return rows[0]?.epoch ?? 1;
}

async function adminSeed(): Promise<Seed> {
  const seed = await seedTeam();
  await db().from("members").update({ role: "admin" }).eq("id", seed.memberId).eq("team_id", seed.teamId);
  admin.teamId = seed.teamId;
  admin.memberId = seed.memberId;
  return seed;
}

async function member(seed: Seed, name: string, status: "active" | "invited" = "active"): Promise<{ id: string; email: string }> {
  const email = `${name.toLowerCase()}-${randomUUID().slice(0, 8)}@roster.example`;
  const { data, error } = await db().from("members").insert({
    team_id: seed.teamId, email, display_name: name,
    actor_handle: `${name.toLowerCase()}-${randomUUID().slice(0, 8)}`,
    role: "member", tier: "team", status, is_connector: false,
  }).select("id").single();
  if (error || !data) throw new Error(`member fixture failed: ${error?.message}`);
  return { id: (data as { id: string }).id, email };
}

const authorAddress = () => `author-${randomUUID().slice(0, 8)}@provider.example`;

/** `count` stored team-tier items naming one author address and credited to nobody. */
async function storedItems(seed: Seed, count: number, authorEmail: string): Promise<void> {
  const { data, error } = await db().from("projects")
    .insert({ team_id: seed.teamId, slug: `repair-${randomUUID().slice(0, 8)}`, name: "Repair fixtures", kind: "initiative" })
    .select("id").single();
  if (error || !data) throw new Error(`project fixture failed: ${error?.message}`);
  await getPool().query(
    `insert into items (team_id, project_id, path, kind, access, frontmatter, content_sha256)
     select $1, $2, 'stored/' || lpad(g::text, 6, '0') || '.md', 'deliverable', 'team', $3::jsonb, md5(g::text)
       from generate_series(1, $4::int) g`,
    [seed.teamId, (data as { id: string }).id,
      JSON.stringify({ source: "notion", authors: [{ email: authorEmail, role: "author" }] }), count]);
}

async function credited(seed: Seed, memberId: string | null): Promise<number> {
  const { rows } = await getPool().query<{ n: number }>(
    "select count(*)::int as n from items where team_id=$1 and member_id is not distinct from $2", [seed.teamId, memberId]);
  return rows[0].n;
}

/** The id of the nth stored item in scan order — where a cursor must stand after n rows. */
async function nthItem(seed: Seed, n: number): Promise<string> {
  const { rows } = await getPool().query<{ id: string }>(
    "select id from items where team_id=$1 order by id offset $2 limit 1", [seed.teamId, n - 1]);
  return rows[0].id;
}

const fenced = (seed: Seed) => authorizationEpoch(db(), seed.teamId)
  .then(() => false, (error: unknown) => {
    if (error instanceof AttributionRepairPendingError) return true;
    throw error;
  });

/** The real client, except that one builder operation on one table answers with an error envelope. */
function failingBuilder(table: string, operation: "upsert" | "delete", message: string): DbClient {
  const real = db();
  const failed = { data: null, error: { message } };
  const answer: Record<string, unknown> = {
    then: (resolve: (value: unknown) => unknown) => resolve(failed),
  };
  for (const chained of ["eq", "select", "in"]) answer[chained] = () => answer;
  return new Proxy(real as object, {
    get(target, prop, receiver) {
      if (prop !== "from") return Reflect.get(target, prop, receiver);
      return (name: string) => {
        const query = (target as { from: (n: string) => unknown }).from(name) as object;
        if (name !== table) return query;
        return new Proxy(query, {
          get(inner, key, innerReceiver) {
            return key === operation ? () => answer : Reflect.get(inner, key, innerReceiver);
          },
        });
      };
    },
  }) as DbClient;
}

/** Another session that has taken the team's repair turn and holds nothing else yet. */
async function holdTurn(seed: Seed): Promise<Client> {
  const owner = new Client({ connectionString: process.env.DATABASE_URL });
  owner.on("error", () => undefined);
  await owner.connect();
  await owner.query("begin");
  const turn = await owner.query<{ acquired: boolean }>(
    "select pg_try_advisory_xact_lock(hashtextextended($1,0)) as acquired", [`${seed.teamId}:attribution-repair-turn`]);
  expect(turn.rows[0].acquired).toBe(true);
  return owner;
}

/** Run every post-response callback the last action deferred, as the platform does after responding. */
async function runDeferred(): Promise<void> {
  for (const callback of deferred.callbacks.splice(0)) await callback();
}

/** The attribution lines a console spy received. */
const lines = (spy: { mock: { calls: unknown[][] } }) =>
  spy.mock.calls.map(([line]) => String(line)).filter((line) => line.startsWith("[attribution]"));

beforeEach(() => {
  admin.teamId = "";
  admin.memberId = "";
  deferred.callbacks.length = 0;
  onAttributionRepairKick(null);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  onAttributionRepairKick(null);
});

describe("AIO-1167 copied staging: the scheduler is suppressed and the manual action converges the repair (real Postgres)", () => {
  beforeEach(() => {
    // The actual policy switch, read by the actual policy: nothing here is told it is staging.
    vi.stubEnv("STAGING_DATA_MODE", "copy-ready");
    vi.stubEnv("INGEST_POLL_ENABLED", "true");
    vi.stubEnv("ATTRIBUTION_REPAIR_POLL_ENABLED", "true");
    expect(isCopiedStagingRuntime()).toBe(true);
  });

  it("UPGRADE / RESTORE: the migration-seeded pending repair converges through the Admin button alone — two manual budgets, the cursor kept, fenced until the strict finalization — and the button never promises a background", async () => {
    // More work than one click of the button can do: its budget is 100 batches of 100.
    const TOTAL = 10_150;
    const seed = await adminSeed();
    const alice = await member(seed, "Alice");
    const author = authorAddress();
    // The address has been Alice's all along; these rows were stored before the complete-read
    // protocol existed, credited to nobody — the stale attribution the upgrade pass exists for.
    expect(await addAuthorAlias(db(), seed.teamId, alice.id, author)).toMatchObject({ aliased: true });
    await storedItems(seed, TOTAL, author);
    // A ledger published before the upgrade, under the epoch of that time.
    await db().from("work_timeline_cache").insert({
      team_id: seed.teamId, group_key: "vis:team:pre-upgrade", payload: JSON.stringify({ v: 14, days: [] }), authorization_epoch: 1,
    });

    // The upgrade (and equally a restore): the authority table arrives with the migration, which
    // seeds EVERY existing team pending. This is that migration's own statement.
    expect(MIGRATION_SEED, "the snapshot-fence migration no longer seeds teams pending").toBeTruthy();
    await getPool().query("delete from team_identity_authority where team_id=$1", [seed.teamId]);
    await getPool().query(MIGRATION_SEED!);
    expect(await authority(seed)).toMatchObject({ repair_status: "pending", cursor_item_id: null, items_scanned: 0, attempts: 0 });
    expect(await fenced(seed)).toBe(true);
    const epochBefore = await storedEpoch(seed);

    // 1. Nothing will pick this up by itself. The scheduler's start refuses on this runtime: no
    //    timer is armed and it installs no loop behind the kick, so the durable work just waits.
    const timers = vi.spyOn(globalThis, "setTimeout");
    const intervals = vi.spyOn(globalThis, "setInterval");
    const nobody = vi.fn();
    onAttributionRepairKick(nobody);
    startAttributionRepairScheduler();
    expect(timers).not.toHaveBeenCalled();
    expect(intervals).not.toHaveBeenCalled();
    timers.mockRestore();
    intervals.mockRestore();
    kickAttributionRepair();
    expect(nobody).toHaveBeenCalledTimes(1); // still the listener registered above: start replaced nothing
    onAttributionRepairKick(null);
    expect((await discoverPendingAttributionRepairs(20)).map((team) => team.teamId)).toEqual([seed.teamId]);
    expect(await authority(seed)).toMatchObject({ repair_status: "pending", items_scanned: 0 });

    // 2. The control stays reachable while reads are fenced: the admin gate does not read the
    //    attribution epoch. (The real gate, asked directly; the action below runs behind a stand-in.)
    const user = await getPool().query<{ id: string }>(
      "insert into auth_users (email) values ($1) returning id", [`admin-${randomUUID().slice(0, 8)}@roster.example`]);
    await getPool().query("update members set auth_user_id=$2 where id=$1", [seed.memberId, user.rows[0].id]);
    expect(await resolveIntegrationsAdmin(db(), seed.teamSlug, user.rows[0].id))
      .toEqual({ teamId: seed.teamId, memberId: seed.memberId });
    expect(await authority(seed)).toMatchObject({ repair_status: "pending", items_scanned: 0 });

    // 3. First click: the whole budget, and the work is not finished.
    const first = await reattributeIdentitiesNow(seed.teamSlug);
    expect(first).toEqual({
      ok: true,
      message: `Re-attributed 10000 of 10000 item(s) so far; the repair is not complete. ${MANUAL_NEXT_STEP} to continue.`,
    });
    expect(first.message).not.toMatch(PROMISES_BACKGROUND);
    // Progress is durable, exactly where the budget ended; nothing counted it as a failure.
    expect(await authority(seed)).toMatchObject({
      repair_status: "running", cursor_item_id: await nthItem(seed, 10_000), items_scanned: 10_000, items_updated: 10_000,
      attempts: 0, last_error: null, deferred: false,
    });
    expect(await credited(seed, alice.id)).toBe(10_000);
    // Reads are still fenced, the pre-upgrade ledger is still on disk, and the epoch has not moved.
    expect(await fenced(seed)).toBe(true);
    expect(await storedEpoch(seed)).toBe(epochBefore);
    expect((await db().from("work_timeline_cache").select("group_key").eq("team_id", seed.teamId)).data).toHaveLength(1);

    // 4. Second click: resumes from the cursor — 150 rows, not 10,150 — and finishes the strict way.
    const second = await reattributeIdentitiesNow(seed.teamSlug);
    expect(second).toEqual({ ok: true, message: "Re-attributed 150 of 150 item(s) to current identity mappings." });
    expect(await authority(seed)).toMatchObject({
      repair_status: "complete", items_scanned: TOTAL, items_updated: TOTAL, attempts: 0, last_error: null,
    });
    expect(await credited(seed, alice.id)).toBe(TOTAL);
    // The purge and the epoch advance came with the completion; only now do reads resume.
    expect((await db().from("work_timeline_cache").select("group_key").eq("team_id", seed.teamId)).data).toEqual([]);
    expect(await storedEpoch(seed)).toBeGreaterThan(epochBefore);
    expect(await fenced(seed)).toBe(false);
    expect(await discoverPendingAttributionRepairs(20)).toEqual([]);
  }, 300_000);

  it("ROSTER CHANGE with no callback: manual budgets converge it through contention, a process dying mid-batch and a failed purge — the cursor kept, fenced after every partial run, no background ever promised", async () => {
    const seed = await adminSeed();
    const invitee = await member(seed, "Invitee", "invited");
    const signInAddress = authorAddress();
    await storedItems(seed, 23, signInAddress);
    expect(await authority(seed)).toMatchObject({ repair_status: "complete" });
    const vis = await resolveTimelineVariant(db(), seed.teamId, seed.memberId);
    const healthyEpoch = await authorizationEpoch(db(), seed.teamId);
    expect(await writeTimelineCache(db(), seed.teamId, "team", [], false, vis, healthyEpoch)).toMatchObject({ status: "published" });
    expect(await readTimelineCache(db(), seed.teamId, "team", vis)).not.toBeNull();

    // The invitee signs in for the first time with that address: the address becomes theirs and
    // the invitation an active membership. Two roster writes; no Admin action, so no hook ran.
    expect(await addAuthorAlias(db(), seed.teamId, invitee.id, signInAddress)).toMatchObject({ aliased: true });
    expect((await db().from("members").update({ status: "active" }).eq("id", invitee.id).eq("team_id", seed.teamId)).error).toBeNull();
    expect(deferred.callbacks).toEqual([]);
    const pending = await authority(seed);
    expect(pending).toMatchObject({ repair_status: "pending", cursor_item_id: null, items_scanned: 0 });
    expect(await readTimelineCache(db(), seed.teamId, "team", vis)).toBeNull();
    // The roster writes advanced the epoch (the old ledger can never be served again); what they
    // did NOT do is complete anything. Every later epoch reading is compared with this one.
    const pendingEpoch = await storedEpoch(seed);
    expect(pendingEpoch).toBeGreaterThan(healthyEpoch);

    // The manual entry point, as the Admin button composes it, with a budget of two 5-row batches.
    const manual = async (client: DbClient = db()) => {
      const outcome = await repairAttributionNow(client, seed.teamId, seed.teamSlug, { maxBatches: 2, batchSize: 5, request: true });
      return { outcome, message: describeManualRepair(outcome) };
    };
    const stillFenced = async () => {
      expect(await fenced(seed)).toBe(true);
      expect(await readTimelineCache(db(), seed.teamId, "team", vis)).toBeNull();
      expect(await writeTimelineCache(db(), seed.teamId, "team", [], false, vis)).toMatchObject({ status: "cache_failed" });
    };

    // Budget 1: ten rows.
    const first = await manual();
    expect(first.outcome).toMatchObject({ status: "continuing", busy: false, scanned: 10, updated: 10 });
    expect(first.message).toBe(`Re-attributed 10 of 10 item(s) so far; the repair is not complete. ${MANUAL_NEXT_STEP} to continue.`);
    const afterFirst = await authority(seed);
    expect(afterFirst).toMatchObject({
      repair_status: "running", revision: pending.revision, cursor_item_id: await nthItem(seed, 10), items_scanned: 10, attempts: 0,
    });
    await stillFenced();

    // CONTENTION: another run holds the team's repair. This one did nothing — and says exactly that.
    const other = await holdTurn(seed);
    try {
      const contended = await manual();
      expect(contended.outcome).toMatchObject({ status: "continuing", busy: true, scanned: 0 });
      expect(contended.message).toBe(
        "Another re-attribution run holds this team's repair right now, so this run did nothing and the repair is not complete. "
        + `${MANUAL_NEXT_STEP} once that run has finished.`,
      );
      expect(contended.message).not.toMatch(PROMISES_BACKGROUND);
      // Busy is not a failure and not progress: the durable row is untouched.
      expect(await authority(seed)).toEqual(afterFirst);
      await stillFenced();

      // INTERRUPTION: that other run dies in the middle of its batch — three more rows written and
      // its cursor moved, uncommitted, when its backend goes away.
      await other.query("select pg_advisory_xact_lock(hashtextextended($1,0))", [`${seed.teamId}:identity-authority`]);
      const written = await other.query<{ id: string }>(
        `update items set member_id=$2
          where id in (select id from items where team_id=$1 and id>$3::uuid order by id limit 3)
        returning id`, [seed.teamId, invitee.id, afterFirst.cursor_item_id]);
      expect(written.rows).toHaveLength(3);
      await other.query(
        "update team_identity_authority set cursor_item_id=$2, items_scanned=items_scanned+3 where team_id=$1",
        [seed.teamId, written.rows.map((row) => row.id).sort().at(-1)]);
      const { rows: backend } = await other.query<{ pid: number }>("select pg_backend_pid() as pid");
      await getPool().query("select pg_terminate_backend($1)", [backend[0].pid]);
    } finally {
      await other.end().catch(() => undefined);
    }

    // Budget 2, by the next manual run: it resumes from the last COMMITTED cursor — row 11, not
    // row 14 — because the dead run's batch went with it.
    let second = await manual();
    for (let waited = 0; second.outcome.busy && waited < 100; waited++) {
      // The terminated backend may take a moment to let go of the turn; a busy answer changes nothing.
      await new Promise((resolve) => setTimeout(resolve, 100));
      second = await manual();
    }
    expect(second.outcome).toMatchObject({ status: "continuing", busy: false, scanned: 10, updated: 10 });
    expect(second.message).not.toMatch(PROMISES_BACKGROUND);
    expect(await authority(seed)).toMatchObject({
      repair_status: "running", cursor_item_id: await nthItem(seed, 20), items_scanned: 20, items_updated: 20, attempts: 0,
    });
    expect(await credited(seed, invitee.id)).toBe(20);
    await stillFenced();

    // PURGE FAILURE: the scan finishes and its finalization fails. Nothing is completed.
    await expect(manual(failingBuilder("work_timeline_cache", "delete", "injected purge outage")))
      .rejects.toThrow(/injected purge outage/);
    expect(await authority(seed)).toMatchObject({
      repair_status: "retry", items_scanned: 23, attempts: 1, last_error: expect.stringContaining("injected purge outage"),
    });
    expect(await credited(seed, invitee.id)).toBe(23);
    await stillFenced();
    expect(await storedEpoch(seed)).toBe(pendingEpoch); // the failed finalization advanced nothing

    // Recovery is the same manual run again. A request made in `retry` starts the scan over rather
    // than trust a failed run's cursor, so it takes three more budgets; each partial one says so.
    // (The rows are already right, so these runs revisit them and change none.)
    const recovery: string[] = [];
    for (let run = 0; run < 6; run++) {
      const next = await manual();
      recovery.push(next.outcome.status);
      if (next.outcome.status === "complete") {
        expect(next.message).toBe("Re-attributed 0 of 3 item(s) to current identity mappings.");
        break;
      }
      expect(next.message).toContain(MANUAL_NEXT_STEP);
      expect(next.message).not.toMatch(PROMISES_BACKGROUND);
      await stillFenced();
    }
    expect(recovery).toEqual(["continuing", "continuing", "complete"]);

    // Strict completion: the superseded ledger is gone, the epoch advanced past every earlier one,
    // and only now does a read resume and a new generation publish.
    expect(await authority(seed)).toMatchObject({ repair_status: "complete", revision: pending.revision, items_scanned: 23, last_error: null });
    expect(await credited(seed, invitee.id)).toBe(23);
    expect((await db().from("work_timeline_cache").select("group_key").eq("team_id", seed.teamId)).data).toEqual([]);
    const completedEpoch = await authorizationEpoch(db(), seed.teamId);
    expect(completedEpoch).toBe(pendingEpoch + 1);
    expect(await writeTimelineCache(db(), seed.teamId, "team", [], false, vis, healthyEpoch))
      .toMatchObject({ status: "epoch_rejected", currentAuthorizationEpoch: completedEpoch });
    expect(await writeTimelineCache(db(), seed.teamId, "team", [], false, vis, completedEpoch)).toMatchObject({ status: "published" });
    expect(await readTimelineCache(db(), seed.teamId, "team", vis)).not.toBeNull();
  }, 120_000);

  it("HOOKS: a post-mutation hook that cannot finish warns that the repair is NOT complete and an admin must run it — for a spent budget and for contention", async () => {
    // More than a hook's budget (20 batches of 100).
    const seed = await adminSeed();
    const alice = await member(seed, "Alice");
    const author = authorAddress();
    await storedItems(seed, 2_050, author);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const info = vi.spyOn(console, "info").mockImplementation(() => {});

    // The Admin "add email" action: the roster write, then its post-response reconcile.
    expect(await addMemberEmail(seed.teamSlug, alice.id, author)).toMatchObject({ ok: true });
    expect(await authority(seed)).toMatchObject({ repair_status: "pending", items_scanned: 0 });
    expect(deferred.callbacks).toHaveLength(1);
    await runDeferred();
    expect(await authority(seed)).toMatchObject({ repair_status: "running", items_scanned: 2_000, attempts: 0, last_error: null });
    expect(lines(warn)).toEqual([
      `[attribution] repair for team ${seed.teamId} is NOT complete (its bounded budget ended): progress is saved, but background `
        + "continuation is disabled on this deployment — an admin must run Re-attribute content again",
    ]);
    expect(lines(info)).toEqual([]);
    expect(await fenced(seed)).toBe(true);

    // The Google-identity hook, finding another run on the team's repair.
    warn.mockClear();
    const other = await holdTurn(seed);
    try {
      expect(await linkMemberIdentity(seed.teamSlug, alice.id, "gdrive", `permission:${randomUUID().slice(0, 12)}`)).toEqual({ ok: true });
      await runDeferred();
    } finally {
      await other.query("rollback").catch(() => undefined);
      await other.end().catch(() => undefined);
    }
    expect(lines(warn)).toEqual([
      `[attribution] repair for team ${seed.teamId} is NOT complete (another run holds its repair): progress is saved, but background `
        + "continuation is disabled on this deployment — an admin must run Re-attribute content again",
    ]);
    for (const line of [...lines(warn), ...lines(info)]) expect(line).not.toMatch(PROMISES_BACKGROUND);
    expect(await authority(seed)).toMatchObject({ attempts: 0, last_error: null });

    // And the admin doing so finishes it. The identity link was a new revision, so every row is
    // revisited; the 2,000 the hook had already put right are found right.
    expect(await reattributeIdentitiesNow(seed.teamSlug))
      .toEqual({ ok: true, message: "Re-attributed 50 of 2050 item(s) to current identity mappings." });
    expect(await fenced(seed)).toBe(false);
    expect(await credited(seed, alice.id)).toBe(2_050);
  }, 180_000);

  it("the Admin button under CONTENTION says another run holds the repair, promises nothing, and writes no failure", async () => {
    const seed = await adminSeed();
    const alice = await member(seed, "Alice");
    const author = authorAddress();
    await storedItems(seed, 12, author);
    await addAuthorAlias(db(), seed.teamId, alice.id, author);
    const before = await authority(seed);
    const other = await holdTurn(seed);
    try {
      expect(await reattributeIdentitiesNow(seed.teamSlug)).toEqual({
        ok: true,
        message: "Another re-attribution run holds this team's repair right now, so this run did nothing and the repair is not complete. "
          + `${MANUAL_NEXT_STEP} once that run has finished.`,
      });
      expect(await authority(seed)).toEqual(before);
    } finally {
      await other.query("rollback").catch(() => undefined);
      await other.end().catch(() => undefined);
    }
    expect(await reattributeIdentitiesNow(seed.teamSlug))
      .toEqual({ ok: true, message: "Re-attributed 12 of 12 item(s) to current identity mappings." });
  }, 60_000);
});

describe("AIO-1167 a normal runtime still reports automatic continuation (real Postgres)", () => {
  beforeEach(() => {
    vi.stubEnv("STAGING_DATA_MODE", "");
    vi.stubEnv("STAGING_OPS_ENVIRONMENT_ID", "");
    vi.stubEnv("RAILWAY_ENVIRONMENT_ID", "");
    vi.stubEnv("INGEST_POLL_ENABLED", "");
    vi.stubEnv("ATTRIBUTION_REPAIR_POLL_ENABLED", "");
    expect(isCopiedStagingRuntime()).toBe(false);
  });

  it("the Admin button under contention, and a hook whose budget ended, both say the repair is continuing in the background", async () => {
    const seed = await adminSeed();
    const alice = await member(seed, "Alice");
    const author = authorAddress();
    await storedItems(seed, 2_050, author);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const info = vi.spyOn(console, "info").mockImplementation(() => {});

    expect(await addMemberEmail(seed.teamSlug, alice.id, author)).toMatchObject({ ok: true });
    await runDeferred();
    expect(await authority(seed)).toMatchObject({ repair_status: "running", items_scanned: 2_000, attempts: 0 });
    expect(lines(info)).toEqual([
      `[attribution] repair for team ${seed.teamId} is continuing in the background (its bounded budget ended)`,
    ]);
    expect(lines(warn)).toEqual([]);

    const other = await holdTurn(seed);
    try {
      expect(await reattributeIdentitiesNow(seed.teamSlug)).toEqual({
        ok: true, message: "Re-attribution is already running for this team and is continuing in the background.",
      });
    } finally {
      await other.query("rollback").catch(() => undefined);
      await other.end().catch(() => undefined);
    }
    expect(await authority(seed)).toMatchObject({ repair_status: "running", items_scanned: 2_000, attempts: 0, last_error: null });
  }, 180_000);
});
