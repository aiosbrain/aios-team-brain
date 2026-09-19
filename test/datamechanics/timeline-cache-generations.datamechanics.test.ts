import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DbClient, TransactionSession } from "@/lib/db/types";
import type { TimelineDay } from "@/lib/dashboard/timeline-group";
import { readSlackTeamGenerations } from "@/lib/ingest/slack-message-ledger";
import { setMemberIdentity } from "@/lib/identity/member-identities";
import { deleteMember } from "@/lib/admin/members";
import { ensureAuthUser, linkMemberByEmail } from "@/lib/auth/pg-login";
import { transactionCapability } from "@/lib/projects/context/transaction";
import { closeMembershipInto } from "@/lib/projects/context/memberships";
import { memberVisibility } from "@/lib/access/enforce";
import type { PgBuilder } from "@/lib/db/types";
import { db, ingest, placeMemberByTier, seedTeam, transactionSessionDecoratedDb, visOf } from "./helpers";
import * as cache from "@/lib/dashboard/timeline-cache";

const cacheWorkers: (typeof cache)[] = [cache];
async function secondWorker(): Promise<typeof cache> {
  vi.resetModules();
  const other = await import("@/lib/dashboard/timeline-cache");
  cacheWorkers.push(other);
  return other;
}
afterEach(async () => {
  await Promise.all(cacheWorkers.map((worker) => worker.settleTimelineRefreshes()));
  cacheWorkers.length = 1;
});

const NOW = () => new Date(Date.now() - 3_600_000).toISOString();
const titles = (days: TimelineDay[]) => days.flatMap((d) => d.people)
  .flatMap((p) => p.tasks.flatMap((t) => t.sources.flatMap((g) => g.items.map((i) => i.title))));
const credited = (days: TimelineDay[]) => new Set(days.flatMap((d) => d.people.map((p) => p.memberId)));
const tx = <T>(fn: (s: TransactionSession) => Promise<T>) => transactionCapability(db()).transaction(fn);

async function fixture() {
  const seed = await seedTeam();
  const src = await ingest(seed, {
    path: `task-docs/${randomUUID()}.md`, access: "team", body: "task source AIO-1170",
    frontmatter: { source: "linear" },
  });
  if (!src.projectId) throw new Error("timeline fixture missing project id");
  await db().from("tasks").insert({
    team_id: seed.teamId, project_id: src.projectId, row_key: "AIO-1170", title: "Timeline task",
    status: "in_progress", assignee: "Tester", origin: "sync", audience: "team", source_item_id: src.id,
  });
  await db().from("member_identities").insert({
    team_id: seed.teamId, member_id: seed.memberId, provider: "slack", external_id: "U_TIMELINE",
  });
  const frontmatter = {
    source: "slack", channel: "eng", author_id: "U_TIMELINE",
    title: "#eng: first AIO-1170", participants: [{ author_id: "U_TIMELINE", display_name: "Tester",
      message_count: 1, first_ts: NOW(), last_ts: NOW() }],
  };
  const item = await ingest(seed, {
    kind: "transcript", path: `slack/eng/${randomUUID()}.md`, access: "team", body: "first AIO-1170",
    frontmatter,
  });
  const { backfillTeamContext } = await import("@/lib/projects/context/backfill");
  const backfill = await backfillTeamContext(db(), seed.teamId);
  if (!backfill.ok) throw new Error(`timeline fixture backfill: ${backfill.error}`);
  return { seed, item, frontmatter };
}

async function activeViewer(teamId: string): Promise<string> {
  const id = randomUUID();
  const { error } = await db().from("members").insert({ id, team_id: teamId,
    email: `${randomUUID()}@test.local`, display_name: "Viewer", actor_handle: `viewer-${randomUUID().slice(0, 8)}`,
    role: "member", tier: "team", status: "active" });
  if (error) throw error;
  await placeMemberByTier(teamId, id, "team");
  return id;
}

function observing(real: DbClient, onGenerationRead: (n: number) => Promise<void> | void) {
  let count = 0;
  const client = transactionSessionDecoratedDb(real, (s) => ({
    ...s,
    executeSql: async <T = Record<string, unknown>>(sql: string, params?: unknown[]) => {
      if (sql.includes("from slack_team_state where team_id = $1") && !sql.includes("for share")) {
        await onGenerationRead(++count);
      }
      return s.executeSql<T>(sql, params);
    },
  }));
  return { client, count: () => count };
}

function failedOracleRead(real: DbClient, table: "members" | "group_members" | "project_groups"): DbClient {
  const denied = new Proxy({} as PgBuilder, {
    get(_target, prop) {
      if (prop === "then") return (resolve: (value: unknown) => void) =>
        Promise.resolve({ data: null, error: { message: `${table} unavailable` } }).then(resolve);
      if (prop === "maybeSingle") return () => Promise.resolve({ data: null, error: { message: `${table} unavailable` } });
      return () => denied;
    },
  });
  return { from: (name) => name === table ? denied : real.from(name), rpc: real.rpc.bind(real),
    ...( "transaction" in real ? { transaction: real.transaction.bind(real) } : {} ) } as DbClient;
}

async function bump(teamId: string, field: "data_generation" | "presentation_generation") {
  await tx(async (s) => {
    await s.executeSql(`insert into slack_team_state(team_id, ${field}) values ($1, 1)
      on conflict(team_id) do update set ${field}=slack_team_state.${field}+1`, [teamId]);
  });
}

/** Close through the production item-locked writer. Only current includes in projects the viewer
 * can actually read matter; other project memberships must not make this a false-positive test. */
async function revokeItem(seed: Awaited<ReturnType<typeof seedTeam>>, itemId: string) {
  const vis = await memberVisibility(db(), { teamId: seed.teamId, memberId: seed.memberId });
  const { data: unit, error: unitError } = await db().from("project_context_units").select("id")
    .eq("team_id", seed.teamId).eq("source_item_id", itemId).eq("unit_kind", "item").single();
  if (unitError || !unit) throw new Error("missing active item unit");
  const { data: memberships, error } = await db().from("project_context_memberships")
    .select("project_id").eq("team_id", seed.teamId).eq("context_unit_id", unit.id)
    .eq("decision", "include").is("valid_to", null);
  if (error) throw error;
  const reachable = (memberships as { project_id: string }[])
    .filter((m) => vis.visibleProjectIds.has(m.project_id));
  if (!reachable.length) throw new Error("fixture item had no reachable membership to close");
  for (const membership of reachable) {
    const closed = await closeMembershipInto(db(), seed.teamId, unit.id as string, membership.project_id);
    if (!closed.ok || closed.closed === 0) throw new Error(`membership close failed: ${JSON.stringify(closed)}`);
  }
}

describe("timeline cache Slack generation fence (real Postgres)", () => {
  it("removes a disabled member's Slack credit from a second worker's warm cache", async () => {
    const { seed } = await fixture();
    const viewer = await activeViewer(seed.teamId);
    const warm = await secondWorker();
    expect(credited((await warm.getCachedWorkTimeline(db(), seed.teamId, "team", viewer)).days))
      .toContain(seed.memberId);
    await warm.settleTimelineRefreshes();
    const email = (await db().from("members").select("email").eq("id", seed.memberId).single()).data.email as string;
    const before = await tx((s) => readSlackTeamGenerations(s, seed.teamId));
    await deleteMember(db(), seed.teamId, email);
    const after = await tx((s) => readSlackTeamGenerations(s, seed.teamId));
    expect(BigInt(after.identityGeneration)).toBe(BigInt(before.identityGeneration) + 1n);
    expect(credited((await warm.getCachedWorkTimeline(db(), seed.teamId, "team", viewer)).days))
      .not.toContain(seed.memberId);
  });

  it("adds an activated member's Slack credit on another worker's next cache read", async () => {
    const { seed } = await fixture();
    const viewer = await activeViewer(seed.teamId);
    const email = (await db().from("members").select("email").eq("id", seed.memberId).single()).data.email as string;
    await db().from("members").update({ status: "invited" }).eq("id", seed.memberId);
    const warm = await secondWorker();
    expect(credited((await warm.getCachedWorkTimeline(db(), seed.teamId, "team", viewer)).days))
      .not.toContain(seed.memberId);
    await warm.settleTimelineRefreshes();
    const before = await tx((s) => readSlackTeamGenerations(s, seed.teamId));
    await linkMemberByEmail(await ensureAuthUser(email), email, seed.teamId);
    const after = await tx((s) => readSlackTeamGenerations(s, seed.teamId));
    expect(BigInt(after.identityGeneration)).toBe(BigInt(before.identityGeneration) + 1n);
    expect(credited((await warm.getCachedWorkTimeline(db(), seed.teamId, "team", viewer)).days))
      .toContain(seed.memberId);
  });

  it("rejects a warm same-project-set hit after the Slack item's reachable membership closes", async () => {
    const { seed, item } = await fixture();
    expect(titles((await cache.getCachedWorkTimeline(db(), seed.teamId, "team", seed.memberId)).days))
      .toContain("#eng: first AIO-1170");
    await cache.settleTimelineRefreshes();
    const before = await tx((s) => readSlackTeamGenerations(s, seed.teamId));
    const hash = (await visOf(seed))!.visibilityHash;
    await revokeItem(seed, item.id);
    expect((await visOf(seed))!.visibilityHash).toBe(hash);
    expect(await tx((s) => readSlackTeamGenerations(s, seed.teamId))).toEqual(before);
    const result = await cache.getCachedWorkTimeline(db(), seed.teamId, "team", seed.memberId);
    expect(JSON.stringify(result.days)).not.toContain("first AIO-1170");
    expect(result.freshness.stale).toBe(false);
  });

  it("rejects a second worker's persisted same-project-set hit after membership closes", async () => {
    const { seed, item } = await fixture();
    await cache.getCachedWorkTimeline(db(), seed.teamId, "team", seed.memberId);
    await cache.settleTimelineRefreshes();
    const hash = (await visOf(seed))!.visibilityHash;
    await revokeItem(seed, item.id);
    expect((await visOf(seed))!.visibilityHash).toBe(hash);
    const other = await secondWorker();
    const result = await other.getCachedWorkTimeline(db(), seed.teamId, "team", seed.memberId);
    expect(JSON.stringify(result.days)).not.toContain("first AIO-1170");
    const persisted = await other.readTimelineCache(db(), seed.teamId, "team", await visOf(seed));
    expect(JSON.stringify(persisted!.days)).not.toContain("first AIO-1170");
  });

  it("retries a cold build overtaken by same-project membership revocation", async () => {
    const { seed, item } = await fixture();
    let release!: () => void;
    let arrived!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const reached = new Promise<void>((resolve) => { arrived = resolve; });
    const observed = observing(db(), async (n) => {
      if (n === 2) { arrived(); await gate; }
    });
    const pending = cache.getCachedWorkTimeline(observed.client, seed.teamId, "team", seed.memberId);
    await reached;
    await revokeItem(seed, item.id);
    release();
    const result = await pending;
    expect(observed.count()).toBeGreaterThanOrEqual(3);
    expect(JSON.stringify(result.days)).not.toContain("first AIO-1170");
    expect(JSON.stringify((await cache.readTimelineCache(db(), seed.teamId, "team", await visOf(seed)))!.days))
      .not.toContain("first AIO-1170");
  });

  it("does not publish an in-flight background rebuild as fresh after membership closes", async () => {
    const { seed, item } = await fixture();
    const worker = await secondWorker(); // spy and cache must use the same fresh admin module instance
    await worker.getCachedWorkTimeline(db(), seed.teamId, "team", seed.memberId);
    await worker.settleTimelineRefreshes();
    await worker.bustTeamTimeline(db(), seed.teamId);
    let release!: () => void;
    let arrived!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const reached = new Promise<void>((resolve) => { arrived = resolve; });
    const observed = observing(db(), async (n) => {
      if (n === 2) { arrived(); await gate; }
    });
    const admin = await import("@/lib/db/admin");
    const spy = vi.spyOn(admin, "adminClient").mockReturnValue(observed.client);
    try {
      const stale = await worker.getCachedWorkTimeline(db(), seed.teamId, "team", seed.memberId);
      expect(stale.freshness.stale).toBe(true);
      await reached; // old build finished; hold it before its after-generation/visibility check
      await revokeItem(seed, item.id);
      release();
      await worker.settleTimelineRefreshes();
      expect(observed.count()).toBeGreaterThanOrEqual(3);
      const next = await worker.getCachedWorkTimeline(db(), seed.teamId, "team", seed.memberId);
      expect(JSON.stringify(next.days)).not.toContain("first AIO-1170");
      expect(next.freshness.stale).toBe(false);
    } finally {
      release();
      spy.mockRestore();
    }
  });

  it("returns an authorized degraded ledger when only cache publication fails", async () => {
    const { seed } = await fixture();
    const failed = transactionSessionDecoratedDb(db(), (s) => ({
      ...s,
      executeSql: async <T = Record<string, unknown>>(sql: string, params?: unknown[]) => {
        if (sql.includes("insert into work_timeline_cache")) throw new Error("cache disk unavailable");
        return s.executeSql<T>(sql, params);
      },
    }));
    const result = await cache.getCachedWorkTimeline(failed, seed.teamId, "team", seed.memberId);
    expect(titles(result.days)).toContain("#eng: first AIO-1170");
    expect(result.freshness.degraded).toBe(true);
    expect(await cache.readTimelineCache(db(), seed.teamId, "team", await visOf(seed))).toBeNull();
  });

  it("throws on member, group or grant read errors; a grantless member remains a valid empty view", async () => {
    const { seed } = await fixture();
    await cache.getCachedWorkTimeline(db(), seed.teamId, "team", seed.memberId);
    await cache.settleTimelineRefreshes();
    for (const table of ["members", "group_members", "project_groups"] as const) {
      await expect(cache.getCachedWorkTimeline(failedOracleRead(db(), table), seed.teamId, "team", seed.memberId))
        .rejects.toThrow("member visibility");
    }
    const { data: grantless, error } = await db().from("members").insert({ id: randomUUID(),
      team_id: seed.teamId, email: `${randomUUID()}@test.local`, display_name: "Grantless",
      actor_handle: `grantless-${randomUUID().slice(0, 8)}`, role: "member", tier: "team", status: "active",
    }).select("id").single();
    if (error || !grantless) throw new Error("grantless fixture failed");
    const view = await memberVisibility(db(), { teamId: seed.teamId, memberId: grantless.id as string });
    expect(view.visibleProjectIds.size).toBe(0);
  });

  it("throws on a grant-read failure on a cold miss without persisting an empty variant", async () => {
    const { seed } = await fixture();
    await expect(cache.getCachedWorkTimeline(failedOracleRead(db(), "project_groups"),
      seed.teamId, "team", seed.memberId)).rejects.toThrow("member visibility");
    const { data } = await db().from("work_timeline_cache").select("group_key").eq("team_id", seed.teamId);
    expect(data).toEqual([]);
  });
  it("reads the indexed generation once before a memory hit and once before a second-worker persisted hit", async () => {
    const { seed } = await fixture();
    await cache.getCachedWorkTimeline(db(), seed.teamId, "team", seed.memberId);
    await cache.settleTimelineRefreshes();
    const first = observing(db(), () => {});
    expect(titles((await cache.getCachedWorkTimeline(first.client, seed.teamId, "team", seed.memberId)).days))
      .toContain("#eng: first AIO-1170");
    expect(first.count()).toBe(1);

    const other = await secondWorker(); // a separate module-local memory map
    const second = observing(db(), () => {});
    expect(titles((await other.getCachedWorkTimeline(second.client, seed.teamId, "team", seed.memberId)).days))
      .toContain("#eng: first AIO-1170");
    expect(second.count()).toBe(1);
  });

  it("never treats a generation read error as zero on memory or persisted hits", async () => {
    const { seed } = await fixture();
    await cache.getCachedWorkTimeline(db(), seed.teamId, "team", seed.memberId);
    await cache.settleTimelineRefreshes();
    const failed = observing(db(), () => { throw new Error("generation read unavailable"); });
    await expect(cache.getCachedWorkTimeline(failed.client, seed.teamId, "team", seed.memberId))
      .rejects.toThrow("generation read unavailable");
    const other = await secondWorker();
    await expect(other.getCachedWorkTimeline(failed.client, seed.teamId, "team", seed.memberId))
      .rejects.toThrow("generation read unavailable");
  });

  it("remap rebuilds inline across workers, removes old credit and refuses old synopsis", async () => {
    const { seed } = await fixture();
    const old = await cache.getCachedWorkTimeline(db(), seed.teamId, "team", seed.memberId);
    expect(credited(old.days)).toContain(seed.memberId);
    await cache.settleTimelineRefreshes();
    const vis = await visOf(seed);
    const key = `vis:team:${vis!.visibilityHash}`;
    const row = await db().from("work_timeline_cache").select("payload").eq("team_id", seed.teamId)
      .eq("group_key", key).single();
    const payload = row.data.payload as { days: TimelineDay[] };
    payload.days[0].people[0].summary = "Old owner synopsis";
    await db().from("work_timeline_cache").update({ payload: JSON.stringify(payload) })
      .eq("team_id", seed.teamId).eq("group_key", key);

    const memberId = randomUUID();
    await db().from("members").insert({ id: memberId, team_id: seed.teamId,
      email: `${randomUUID()}@test.local`, display_name: "New owner", actor_handle: `new-${randomUUID().slice(0, 8)}`,
      role: "member", tier: "team", status: "active" });
    await placeMemberByTier(seed.teamId, memberId, "team");
    const oldGeneration = await tx((s) => readSlackTeamGenerations(s, seed.teamId));
    // This worker already has the old person in memory; another loads the old persisted payload.
    const warm = await secondWorker();
    expect(credited((await warm.getCachedWorkTimeline(db(), seed.teamId, "team", seed.memberId)).days))
      .toContain(seed.memberId);
    await setMemberIdentity(db(), seed.teamId, memberId,
      { provider: "slack", externalId: "U_TIMELINE" }, { force: true });
    expect((await tx((s) => readSlackTeamGenerations(s, seed.teamId))).identityGeneration)
      .toBe(String(BigInt(oldGeneration.identityGeneration) + 1n));
    const warmRebuilt = await warm.getCachedWorkTimeline(db(), seed.teamId, "team", seed.memberId);
    expect(credited(warmRebuilt.days)).toContain(memberId);
    expect(credited(warmRebuilt.days)).not.toContain(seed.memberId);
    expect(warmRebuilt.days.flatMap((d) => d.people).map((p) => p.summary))
      .not.toContain("Old owner synopsis");
    const other = await secondWorker();
    const rebuilt = await other.getCachedWorkTimeline(db(), seed.teamId, "team", seed.memberId);
    expect(rebuilt.freshness.stale).toBe(false);
    expect(credited(rebuilt.days)).toContain(memberId);
    expect(credited(rebuilt.days)).not.toContain(seed.memberId);
    expect(rebuilt.days.flatMap((d) => d.people).map((p) => p.summary)).not.toContain("Old owner synopsis");
  });

  it("presentation and data changes rebuild inline; an unchanged revisit remains a hit", async () => {
    const { seed, item } = await fixture();
    const initial = await cache.getCachedWorkTimeline(db(), seed.teamId, "team", seed.memberId);
    expect(titles(initial.days)).toContain("#eng: first AIO-1170");
    await cache.settleTimelineRefreshes();
    const before = await tx((s) => readSlackTeamGenerations(s, seed.teamId));
    const unchanged = observing(db(), () => {});
    expect(titles((await cache.getCachedWorkTimeline(unchanged.client, seed.teamId, "team", seed.memberId)).days))
      .toContain("#eng: first AIO-1170");
    expect(unchanged.count()).toBe(1);
    expect(await tx((s) => readSlackTeamGenerations(s, seed.teamId))).toEqual(before);
    const other = await secondWorker();
    // Give the second worker its OWN old-label memory entry before the publisher changes the label.
    expect(titles((await other.getCachedWorkTimeline(db(), seed.teamId, "team", seed.memberId)).days))
      .toContain("#eng: first AIO-1170");

    await tx(async (s) => {
      await s.executeSql(`update items set frontmatter=jsonb_set(frontmatter, '{title}',
        to_jsonb($3::text)) where team_id=$1 and id=$2`, [seed.teamId, item.id, "#eng: renamed AIO-1170"]);
      await s.executeSql(`update slack_team_state set presentation_generation=presentation_generation+1
        where team_id=$1`, [seed.teamId]);
    });
    const renamed = await cache.getCachedWorkTimeline(db(), seed.teamId, "team", seed.memberId);
    expect(titles(renamed.days)).toContain("#eng: renamed AIO-1170");
    expect(titles(renamed.days)).not.toContain("#eng: first AIO-1170");
    expect(renamed.freshness.stale).toBe(false);
    const remoteMemory = await other.getCachedWorkTimeline(db(), seed.teamId, "team", seed.memberId);
    expect(titles(remoteMemory.days)).toContain("#eng: renamed AIO-1170");
    expect(titles(remoteMemory.days)).not.toContain("#eng: first AIO-1170");
    await cache.settleTimelineRefreshes();

    const second = await ingest(seed, { kind: "transcript", path: `slack/eng/${randomUUID()}.md`,
      access: "team", body: "another AIO-1170", frontmatter: {
        source: "slack", channel: "eng", author_id: "U_TIMELINE", title: "#eng: second AIO-1170",
        participants: [{ author_id: "U_TIMELINE", message_count: 1, first_ts: NOW(), last_ts: NOW() }],
      } });
    expect(second.id).toBeTruthy();
    const { backfillTeamContext } = await import("@/lib/projects/context/backfill");
    const backfill = await backfillTeamContext(db(), seed.teamId);
    if (!backfill.ok) throw new Error(backfill.error);
    await bump(seed.teamId, "data_generation");
    const updated = await cache.getCachedWorkTimeline(db(), seed.teamId, "team", seed.memberId);
    expect(titles(updated.days)).toContain("#eng: second AIO-1170");
    expect(updated.freshness.stale).toBe(false);
  });

  it("rejects an unstamped persisted row and rebuilds a real ledger", async () => {
    const { seed } = await fixture();
    const key = `vis:team:${(await visOf(seed))!.visibilityHash}`;
    await db().from("work_timeline_cache").upsert({ team_id: seed.teamId, group_key: key,
      payload: JSON.stringify({ v: cache.PAYLOAD_VERSION, days: [] }), computed_at: new Date().toISOString() },
      { onConflict: "team_id,group_key" });
    const result = await cache.getCachedWorkTimeline(db(), seed.teamId, "team", seed.memberId);
    expect(titles(result.days)).toContain("#eng: first AIO-1170");
  });

  it("retries an in-flight build overtaken by a presentation revision before publication", async () => {
    const { seed, item } = await fixture();
    let release!: () => void;
    let arrived!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const reached = new Promise<void>((resolve) => { arrived = resolve; });
    const observed = observing(db(), async (n) => {
      if (n === 2) { arrived(); await gate; }
    });
    const pending = cache.getCachedWorkTimeline(observed.client, seed.teamId, "team", seed.memberId);
    await reached; // the old pure ledger has been built, just before its after-generation read
    await tx(async (s) => {
      await s.executeSql(`update items set frontmatter=jsonb_set(frontmatter, '{title}',
        to_jsonb($3::text)) where team_id=$1 and id=$2`, [seed.teamId, item.id, "#eng: overtaking AIO-1170"]);
      await s.executeSql(`insert into slack_team_state(team_id,presentation_generation) values($1,1)
        on conflict(team_id) do update set presentation_generation=slack_team_state.presentation_generation+1`, [seed.teamId]);
    });
    release();
    const rebuilt = await pending;
    expect(observed.count()).toBeGreaterThanOrEqual(3);
    expect(titles(rebuilt.days)).toContain("#eng: overtaking AIO-1170");
    expect(titles(rebuilt.days)).not.toContain("#eng: first AIO-1170");
    const persisted = await cache.readTimelineCache(db(), seed.teamId, "team", await visOf(seed));
    expect(titles(persisted!.days)).toContain("#eng: overtaking AIO-1170");
  });

  it("retries an in-flight build overtaken by the production identity writer", async () => {
    const { seed } = await fixture();
    const memberId = randomUUID();
    await db().from("members").insert({ id: memberId, team_id: seed.teamId,
      email: `${randomUUID()}@test.local`, display_name: "New owner", actor_handle: `new-${randomUUID().slice(0, 8)}`,
      role: "member", tier: "team", status: "active" });
    await placeMemberByTier(seed.teamId, memberId, "team");
    let release!: () => void;
    let arrived!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const reached = new Promise<void>((resolve) => { arrived = resolve; });
    const observed = observing(db(), async (n) => {
      if (n === 2) { arrived(); await gate; }
    });
    const pending = cache.getCachedWorkTimeline(observed.client, seed.teamId, "team", seed.memberId);
    await reached;
    await setMemberIdentity(db(), seed.teamId, memberId,
      { provider: "slack", externalId: "U_TIMELINE" }, { force: true });
    release();
    const rebuilt = await pending;
    expect(observed.count()).toBeGreaterThanOrEqual(3);
    expect(credited(rebuilt.days)).toContain(memberId);
    expect(credited(rebuilt.days)).not.toContain(seed.memberId);
    const persisted = await cache.readTimelineCache(db(), seed.teamId, "team", await visOf(seed));
    expect(credited(persisted!.days)).toContain(memberId);
    expect(credited(persisted!.days)).not.toContain(seed.memberId);
  });
});
