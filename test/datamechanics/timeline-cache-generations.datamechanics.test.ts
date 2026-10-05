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
import { discoverSlackSource } from "@/lib/ingest/slack-source-discovery";
import {
  db, ingest, placeMemberByTier, seedTeam, transactionDecoratedDb, transactionSessionDecoratedDb, visOf,
} from "./helpers";
import {
  authTestBody, disableSlackIntegration, fakeSlack, rotateSlackSecret, seedSlackIntegration, slackJson,
} from "./slack-source-helpers";
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
  // PA-4's spacing and maximum-age cases move the JS clock; no other test may inherit it.
  vi.useRealTimers();
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
    // TIERRET-1: the cache resolves the reader through the one admission resolver, which is what
    // refuses each failed read (member row, posture, oracle grants).
    for (const table of ["members", "group_members", "project_groups"] as const) {
      await expect(cache.getCachedWorkTimeline(failedOracleRead(db(), table), seed.teamId, "team", seed.memberId))
        .rejects.toThrow("content admission unavailable");
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
      seed.teamId, "team", seed.memberId)).rejects.toThrow("content admission unavailable");
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
    const key = await cache.timelineViewKey(db(), seed.teamId, "team", seed.memberId);
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

  // ⚠️ CHANGED ON PURPOSE (pre-activation correction PA-4, AC-PA-12). This test used to state the
  // GENERAL rule — any data or presentation mismatch is a cold miss. That is now true only where it
  // is tested here: a team with NO enabled, verified Slack integration, which this fixture is. With
  // a current source the same mismatch is served stale; that rule lives in the PA-4 block below.
  it("with NO current Slack source, presentation and data changes still rebuild inline; an unchanged revisit remains a hit (AC-PA-12)", async () => {
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
    // The READER's own `adm:` row — an unstamped row at any other key would never be looked up.
    const key = await cache.timelineViewKey(db(), seed.teamId, "team", seed.memberId);
    await db().from("work_timeline_cache").upsert({ team_id: seed.teamId, group_key: key,
      payload: JSON.stringify({ v: cache.PAYLOAD_VERSION, days: [] }), computed_at: new Date().toISOString() },
      { onConflict: "team_id,group_key" });
    const result = await cache.getCachedWorkTimeline(db(), seed.teamId, "team", seed.memberId);
    expect(titles(result.days)).toContain("#eng: first AIO-1170");
  });

  // PA-4 note: expectations unchanged, reason narrowed. This fixture has no current Slack source, so
  // an overtaken cold build may not be handed back as generation-lag reuse and is retried instead.
  // The with-source rule (publish under the earlier stamps, return it as stale) is in the PA-4 block.
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

/**
 * AIO-1170 pre-activation correction PA-4 — identity is the only cold miss.
 *
 * With a CURRENT Slack source (one enabled integration with a verified binding), a row whose DATA or
 * PRESENTATION generation lags is served as it is, marked stale, with its model prose removed, while
 * one spaced background refresh catches up. Identity and current item visibility stay hard
 * boundaries on every path, and a build overtaken only by data or presentation is published under
 * the generations it actually read — never relabelled with later ones, never handed back as fresh.
 *
 * WHAT THIS BLOCK CANNOT SHOW: that a lagging row LOOKS stale to a person. Only the team-work route
 * puts the freshness envelope on the wire; the timeline route, the v1 route and the panel drop it.
 */
const LONG = 30_000;
const SLACK_TOKEN = "xoxb-synthetic-not-a-real-token";
const FIRST = "#eng: first AIO-1170";
const RENAMED = "#eng: renamed AIO-1170";
const OVERTAKING = "#eng: overtaking AIO-1170";

type StampedPayload = {
  v: number; days: TimelineDay[]; itemFingerprint: string;
  generations: { dataGeneration: string; identityGeneration: string; presentationGeneration: string };
};
type SeededTeam = Awaited<ReturnType<typeof seedTeam>>;

const people = (days: TimelineDay[]) => days.flatMap((d) => d.people);
/** OMITTED means the key is absent — not present and undefined, which the payload shape forbids. */
const hasProse = (days: TimelineDay[]) => people(days).some((p) => "summary" in p);
const live = (teamId: string) => tx((s) => readSlackTeamGenerations(s, teamId));

/** One pass of the real entrypoint with one request to spend: it settles the binding and nothing else. */
function authPass(seed: SeededTeam, integrationId: string, answer: () => Response) {
  return discoverSlackSource(
    { db: db(), teamId: seed.teamId, integrationId },
    { fetchImpl: fakeSlack({ "auth.test": answer }).impl, envToken: () => null, maxRequests: 1 }
  );
}

/**
 * The base fixture plus a CURRENT Slack source, reached the way production reaches it: a real
 * integration row and a binding the discovery entrypoint verified. Nothing here mints `verified`.
 */
async function sourced() {
  const base = await fixture();
  const integrationId = await seedSlackIntegration(base.seed, { channelIds: [], token: SLACK_TOKEN });
  const bound = await authPass(base.seed, integrationId, () => slackJson(authTestBody({ app_id: "A0SOURCE1" })));
  if (bound.binding?.state !== "verified") throw new Error("fixture: the Slack binding should be verified");
  // The generation row exists from the start, so a test that holds a publication open never makes
  // a concurrent bump wait on that publication's own uncommitted insert of it.
  await tx((s) => s.executeSql(
    `insert into slack_team_state (team_id) values ($1) on conflict (team_id) do nothing`, [base.seed.teamId]));
  return { ...base, integrationId };
}

async function retitle(teamId: string, itemId: string, title: string) {
  await tx((s) => s.executeSql(
    `update items set frontmatter=jsonb_set(frontmatter, '{title}', to_jsonb($3::text))
      where team_id=$1 and id=$2`, [teamId, itemId, title]));
}

async function rowOf(seed: SeededTeam): Promise<{ payload: StampedPayload; computed_at: string | Date }> {
  const key = await cache.timelineViewKey(db(), seed.teamId, "team", seed.memberId);
  const { data, error } = await db().from("work_timeline_cache").select("payload, computed_at")
    .eq("team_id", seed.teamId).eq("group_key", key).single();
  if (error || !data) throw new Error("fixture: the reader's cache row is missing");
  return data as { payload: StampedPayload; computed_at: string | Date };
}

async function rewritePayload(seed: SeededTeam, change: (payload: StampedPayload) => void) {
  const key = await cache.timelineViewKey(db(), seed.teamId, "team", seed.memberId);
  const { payload } = await rowOf(seed);
  change(payload);
  await db().from("work_timeline_cache").update({ payload: JSON.stringify(payload) })
    .eq("team_id", seed.teamId).eq("group_key", key);
}

/** Model prose on the stored row, as a completed background pass would have left it. */
const plantSummary = (seed: SeededTeam, text: string) =>
  rewritePayload(seed, (payload) => { payload.days[0].people[0].summary = text; });

/** ⚠️ CLOCK FIXTURE: make the persisted row `ms` old on the database's clock. */
async function ageRow(teamId: string, ms: number) {
  await tx((s) => s.executeSql(
    `update work_timeline_cache
        set computed_at = clock_timestamp() - ($2::double precision * interval '1 millisecond')
      where team_id = $1`, [teamId, ms]));
}

/** ⚠️ CLOCK FIXTURE: move this process's clock forward. Only `Date` is faked; timers stay real. */
function advanceClock(ms: number) {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(Date.now() + ms);
}

/** A separate cache process, with the admin module ITS background refresh will construct a client from. */
async function workerWithAdmin() {
  const worker = await secondWorker();
  const admin = await import("@/lib/db/admin");
  return { worker, admin };
}

async function anotherMember(teamId: string): Promise<string> {
  const id = randomUUID();
  const { error } = await db().from("members").insert({ id, team_id: teamId,
    email: `${randomUUID()}@test.local`, display_name: "New owner", actor_handle: `new-${randomUUID().slice(0, 8)}`,
    role: "member", tier: "team", status: "active" });
  if (error) throw error;
  await placeMemberByTier(teamId, id, "team");
  return id;
}

/**
 * Hold a build at the last moment before it PUBLISHES: the first time its compare-and-set goes to
 * read the generation row under the row lock. Whatever the test commits while it is held is, by
 * construction, an overtake the publication has to judge — however the build got that far.
 */
function holdBeforePublish(real: DbClient) {
  let release!: () => void;
  let arrived!: () => void;
  let held = false;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const reached = new Promise<void>((resolve) => { arrived = resolve; });
  const client = transactionSessionDecoratedDb(real, (s) => ({
    ...s,
    executeSql: async <T = Record<string, unknown>>(sql: string, params?: unknown[]) => {
      if (!held && sql.includes("from slack_team_state") && sql.includes("for share")) {
        held = true;
        arrived();
        await gate;
      }
      return s.executeSql<T>(sql, params);
    },
  }));
  return { client, reached, release };
}

/** Wait for a held background publication, failing by name if no refresh is running to reach it. */
async function refreshReached(reached: Promise<void>, worker: typeof cache) {
  await Promise.race([reached, worker.settleTimelineRefreshes().then(() => {
    throw new Error("fixture: no background refresh reached publication");
  })]);
}

/** Ingestion that never pauses: a presentation bump lands before EVERY generation read, locked or not. */
function backfilling(real: DbClient, teamId: string): DbClient {
  return transactionSessionDecoratedDb(real, (s) => ({
    ...s,
    executeSql: async <T = Record<string, unknown>>(sql: string, params?: unknown[]) => {
      if (sql.includes("from slack_team_state")) await bump(teamId, "presentation_generation");
      return s.executeSql<T>(sql, params);
    },
  }));
}

/** A client on which the binding table cannot be read at all, by builder or by raw SQL. */
function unreadableBindings(real: DbClient): DbClient {
  const refuse = (): never => { throw new Error("slack bindings unavailable"); };
  const builders = transactionDecoratedDb(real, (bound) => ({
    from: (table: string) => (table === "slack_integration_bindings" ? refuse() : bound.from(table)),
    rpc: bound.rpc.bind(bound),
  }));
  return transactionSessionDecoratedDb(builders, (s) => ({
    ...s,
    executeSql: async <T = Record<string, unknown>>(sql: string, params?: unknown[]) =>
      sql.includes("slack_integration_bindings") ? refuse() : s.executeSql<T>(sql, params),
  }));
}

describe("timeline cache generation lag (PA-4, real Postgres)", () => {
  const read = (worker: typeof cache, seed: SeededTeam, client: DbClient = db()) =>
    worker.getCachedWorkTimeline(client, seed.teamId, "team", seed.memberId);

  /** A published, settled row and a SEPARATE worker that reads it as a plain hit (no refresh of its own). */
  async function warmed() {
    const base = await sourced();
    await read(cache, base.seed);
    await cache.settleTimelineRefreshes();
    return base;
  }

  it.each([
    { field: "data_generation" as const, layer: "a warm memory entry", warm: true, ac: "AC-PA-10" },
    { field: "data_generation" as const, layer: "a second worker's persisted row", warm: false, ac: "AC-PA-10" },
    { field: "presentation_generation" as const, layer: "a warm memory entry", warm: true, ac: "AC-PA-10b" },
  ])("serves $layer STALE and without prose after a $field bump, and refreshes once ($ac)", async ({ field, warm }) => {
    const { seed, item } = await warmed();
    await plantSummary(seed, "Shipped the first thing.");
    const { worker, admin } = await workerWithAdmin();
    if (warm) {
      // THE CONTROL: with matching generations this same entry is fresh and carries its prose, so
      // what changes below is caused by the lag and by nothing else.
      const hit = await read(worker, seed);
      expect(hit.freshness.stale).toBe(false);
      expect(people(hit.days).map((p) => p.summary)).toContain("Shipped the first thing.");
    }

    await retitle(seed.teamId, item.id, RENAMED);
    await bump(seed.teamId, field);
    const refreshes = vi.spyOn(admin, "adminClient");
    try {
      const lagging = await Promise.all([1, 2, 3].map(() => read(worker, seed)));
      for (const served of lagging) {
        // The PRIOR row — not a rebuild — marked stale although it is seconds old…
        expect(served.freshness.stale).toBe(true);
        expect(titles(served.days)).toContain(FIRST);
        expect(titles(served.days)).not.toContain(RENAMED);
        // …and facts only: prose written for an earlier generation cannot be vouched for.
        expect(hasProse(served.days)).toBe(false);
      }
      await worker.settleTimelineRefreshes();
      // Three concurrent lagging reads, ONE background refresh.
      expect(refreshes).toHaveBeenCalledTimes(1);
    } finally {
      refreshes.mockRestore();
    }

    // AC-PA-13b, the quiet case: nothing overtook that refresh, so its stamps are the live ones and
    // the row is an ordinary fresh hit again.
    expect((await rowOf(seed)).payload.generations).toEqual(await live(seed.teamId));
    const settled = await read(worker, seed);
    expect(settled.freshness.stale).toBe(false);
    expect(titles(settled.days)).toContain(RENAMED);
  }, LONG);

  it("never turns a read cold, or into an error, across a run of presentation bumps (AC-PA-10b)", async () => {
    const { seed } = await warmed();
    const worker = await secondWorker();
    await read(worker, seed);

    for (let burst = 0; burst < 4; burst++) {
      // A backfill: every newly scoped root bumps the presentation generation.
      await tx((s) => s.executeSql(
        `update slack_team_state set presentation_generation = presentation_generation + 75 where team_id = $1`,
        [seed.teamId]));
      const served = await read(worker, seed);
      // A cold rebuild would come back fresh; this is the standing row, again.
      expect(served.freshness.stale).toBe(true);
      expect(titles(served.days)).toContain(FIRST);
      expect(hasProse(served.days)).toBe(false);
      await worker.settleTimelineRefreshes();
    }
  }, LONG);

  it("starts no second refresh inside the refresh spacing, and exactly one after it (AC-PA-10c)", async () => {
    const { seed } = await warmed();
    const { worker, admin } = await workerWithAdmin();
    await read(worker, seed);
    const refreshes = vi.spyOn(admin, "adminClient");
    try {
      await bump(seed.teamId, "data_generation");
      expect((await read(worker, seed)).freshness.stale).toBe(true);
      await worker.settleTimelineRefreshes();
      expect(refreshes).toHaveBeenCalledTimes(1);

      // Ingestion carries on, so the row lags again straight away — and a polling dashboard reads it
      // again and again. None of those reads may buy another build, or another summary pass.
      await bump(seed.teamId, "data_generation");
      const published = (await rowOf(seed)).computed_at;
      for (let poll = 0; poll < 3; poll++) expect((await read(worker, seed)).freshness.stale).toBe(true);
      await worker.settleTimelineRefreshes();
      expect(refreshes).toHaveBeenCalledTimes(1);
      expect((await rowOf(seed)).computed_at).toEqual(published);

      // One spacing later (the cache TTL by default) the next lagging read starts exactly one.
      advanceClock(cache.TIMELINE_TTL_MS + 1_000);
      expect((await read(worker, seed)).freshness.stale).toBe(true);
      await worker.settleTimelineRefreshes();
      expect(refreshes).toHaveBeenCalledTimes(2);
      expect((await rowOf(seed)).payload.generations).toEqual(await live(seed.teamId));
    } finally {
      refreshes.mockRestore();
    }
  }, LONG);

  it.each([
    { layer: "this worker's memory entry", fresh: false },
    { layer: "a second worker's persisted row", fresh: true },
  ])("never lets a same-hash membership close through a stale serve of $layer (AC-PA-11, AC-PA-14)", async ({ fresh }) => {
    const { seed, item } = await warmed();
    const worker = await secondWorker();
    await read(worker, seed);

    // The state a leak needs: the row IS being served stale, and it names the item.
    await bump(seed.teamId, "data_generation");
    const stale = await read(worker, seed);
    expect(stale.freshness.stale).toBe(true);
    expect(JSON.stringify(stale.days)).toContain("first AIO-1170");
    await worker.settleTimelineRefreshes();
    // Lagging again, inside the spacing: no refresh is coming to replace the row on its own.
    await bump(seed.teamId, "data_generation");

    const hash = (await visOf(seed))!.visibilityHash;
    const before = await live(seed.teamId);
    await revokeItem(seed, item.id);
    // Same project-set key, same generations: ONLY the item fingerprint knows access was lost.
    expect((await visOf(seed))!.visibilityHash).toBe(hash);
    expect(await live(seed.teamId)).toEqual(before);

    const served = await read(fresh ? await secondWorker() : worker, seed);
    expect(JSON.stringify(served.days)).not.toContain("first AIO-1170");
    expect(served.freshness.stale).toBe(false);
  }, LONG);

  it.each([
    { how: "the integration is disabled",
      lose: (seed: SeededTeam, id: string) => disableSlackIntegration(seed, id) },
    { how: "its binding is no longer verified",
      lose: async (seed: SeededTeam, id: string) => {
        await rotateSlackSecret(seed, id, "xoxb-synthetic-rotated-token");
        const refused = await authPass(seed, id, () => slackJson({ ok: false, error: "invalid_auth" }));
        if (refused.binding?.state !== "blocked") throw new Error("fixture: the binding should be blocked");
      } },
    { how: "the integration is gone",
      lose: async (seed: SeededTeam, id: string) => {
        await db().from("integrations").delete().eq("team_id", seed.teamId).eq("id", id);
      } },
  ])("rebuilds cold instead of serving stale once $how (AC-PA-12)", async ({ lose }) => {
    const { seed, item, integrationId } = await warmed();
    const worker = await secondWorker();
    await read(worker, seed);

    // WITH its source, this reader is served the lagging row…
    await retitle(seed.teamId, item.id, RENAMED);
    await bump(seed.teamId, "data_generation");
    const stale = await read(worker, seed);
    expect(stale.freshness.stale).toBe(true);
    expect(titles(stale.days)).toContain(FIRST);
    await worker.settleTimelineRefreshes();

    // …and WITHOUT it, the very same lag is a cold rebuild: the check must not pass vacuously.
    await lose(seed, integrationId);
    await retitle(seed.teamId, item.id, OVERTAKING);
    await bump(seed.teamId, "data_generation");
    const cold = await read(worker, seed);
    expect(cold.freshness.stale).toBe(false);
    expect(titles(cold.days)).toContain(OVERTAKING);
    expect(titles(cold.days)).not.toContain(RENAMED);
  }, LONG);

  it("never treats an UNREADABLE source, access or generation check as passed while the row lags (conditions 1 and 3)", async () => {
    const { seed, item } = await warmed();
    const worker = await secondWorker();
    await read(worker, seed);
    await bump(seed.teamId, "data_generation");
    expect((await read(worker, seed)).freshness.stale).toBe(true);
    await worker.settleTimelineRefreshes();
    await retitle(seed.teamId, item.id, RENAMED);
    await bump(seed.teamId, "data_generation");

    // The source check could not be made. Whether that read fails or rebuilds, it is not a stale serve.
    const blind = await read(worker, seed, unreadableBindings(db())).then(
      (served) => ({ served, error: null }), (error: unknown) => ({ served: null, error }));
    if (blind.served) {
      expect(blind.served.freshness.stale).toBe(false);
      expect(titles(blind.served.days)).toContain(RENAMED);
    } else {
      expect(blind.error).toBeInstanceOf(Error);
    }

    // The two authorities every hit is validated against still fail closed on the lag branch.
    await expect(read(worker, seed, failedOracleRead(db(), "project_groups")))
      .rejects.toThrow("content admission unavailable");
    const noGenerations = observing(db(), () => { throw new Error("generation read unavailable"); });
    await expect(read(worker, seed, noGenerations.client)).rejects.toThrow("generation read unavailable");
  }, LONG);

  it.each([
    { field: "data_generation" as const },
    { field: "presentation_generation" as const },
  ])("publishes a refresh overtaken only by a $field bump under its EARLIER stamps, then converges (AC-PA-13, AC-PA-13b)", async ({ field }) => {
    const { seed, item } = await warmed();
    const { worker, admin } = await workerWithAdmin();
    await read(worker, seed);
    await retitle(seed.teamId, item.id, RENAMED);
    await bump(seed.teamId, "data_generation");
    const earlier = await live(seed.teamId);

    const held = holdBeforePublish(db());
    const spy = vi.spyOn(admin, "adminClient").mockReturnValue(held.client);
    try {
      expect((await read(worker, seed)).freshness.stale).toBe(true);
      await refreshReached(held.reached, worker); // built from the RENAMED ledger, about to publish
      await retitle(seed.teamId, item.id, OVERTAKING);
      await bump(seed.teamId, field);
      held.release();
      await worker.settleTimelineRefreshes();
    } finally {
      held.release();
      spy.mockRestore();
    }

    // The overtaken build IS published — under the generations it read, not the ones it lost to.
    const row = await rowOf(seed);
    expect(row.payload.generations).toEqual(earlier);
    expect(row.payload.generations).not.toEqual(await live(seed.teamId));
    expect(titles(row.payload.days)).toContain(RENAMED);
    expect(titles(row.payload.days)).not.toContain(OVERTAKING);
    // …so the read keeps resolving, and is told the truth about what it got.
    const next = await read(worker, seed);
    expect(next.freshness.stale).toBe(true);
    expect(titles(next.days)).toContain(RENAMED);
    expect(hasProse(next.days)).toBe(false);

    // AC-PA-13b: ingestion has paused. One spacing later the next refresh is not overtaken, its
    // stamps are the live ones, and the row stops being stale.
    advanceClock(cache.TIMELINE_TTL_MS + 1_000);
    await read(worker, seed);
    await worker.settleTimelineRefreshes();
    vi.useRealTimers();
    expect((await rowOf(seed)).payload.generations).toEqual(await live(seed.teamId));
    const settled = await read(worker, seed);
    expect(settled.freshness.stale).toBe(false);
    expect(titles(settled.days)).toContain(OVERTAKING);
  }, LONG);

  it("serves a lagging row up to the maximum stale age and rebuilds cold past it (AC-PA-13c)", async () => {
    const { seed, item } = await warmed();
    await retitle(seed.teamId, item.id, RENAMED);
    await bump(seed.teamId, "data_generation");

    // Fourteen minutes old: past the TTL, inside the fifteen-minute bound. Still the standing row.
    await ageRow(seed.teamId, 14 * 60_000);
    const first = await secondWorker();
    const within = await read(first, seed);
    expect(within.freshness.stale).toBe(true);
    expect(titles(within.days)).toContain(FIRST);
    await first.settleTimelineRefreshes();

    // Sixteen: an old build is no longer reused, however current the source says it is.
    await retitle(seed.teamId, item.id, OVERTAKING);
    await bump(seed.teamId, "data_generation");
    await ageRow(seed.teamId, 16 * 60_000);
    const beyond = await read(await secondWorker(), seed);
    expect(titles(beyond.days)).toContain(OVERTAKING);
    expect(titles(beyond.days)).not.toContain(RENAMED);
    expect(beyond.freshness.stale).toBe(false);
  }, LONG);

  it("does not let hits or a failed refresh extend a memory entry past the maximum stale age (AC-PA-13c, condition 5)", async () => {
    const { seed, item } = await warmed();
    const { worker, admin } = await workerWithAdmin();
    await read(worker, seed);
    await retitle(seed.teamId, item.id, RENAMED);
    await bump(seed.teamId, "data_generation");

    // Every refresh this worker starts FAILS, so nothing ever replaces the entry it holds.
    const broken = observing(db(), () => { throw new Error("refresh source unavailable"); });
    const spy = vi.spyOn(admin, "adminClient").mockReturnValue(broken.client);
    try {
      expect((await read(worker, seed)).freshness.stale).toBe(true);
      await worker.settleTimelineRefreshes();

      advanceClock(14 * 60_000);
      const hit = await read(worker, seed);
      expect(hit.freshness.stale).toBe(true);
      expect(titles(hit.days)).toContain(FIRST);
      await worker.settleTimelineRefreshes();

      // Two minutes after that hit, sixteen after the build: the age is the BUILD's, and it is over.
      vi.setSystemTime(Date.now() + 2 * 60_000);
      const cold = await read(worker, seed);
      expect(titles(cold.days)).toContain(RENAMED);
      expect(titles(cold.days)).not.toContain(FIRST);
      await worker.settleTimelineRefreshes();
    } finally {
      spy.mockRestore();
    }
  }, LONG);

  it.each([
    { by: "an identity remap", identity: true },
    { by: "a same-hash membership close", identity: false },
  ])("discards a refresh overtaken by $by, and the next read rebuilds cold (AC-PA-13d)", async ({ identity }) => {
    const { seed, item } = await warmed();
    const newOwner = await anotherMember(seed.teamId);
    const { worker, admin } = await workerWithAdmin();
    await read(worker, seed);
    await bump(seed.teamId, "data_generation");

    const held = holdBeforePublish(db());
    const spy = vi.spyOn(admin, "adminClient").mockReturnValue(held.client);
    try {
      expect((await read(worker, seed)).freshness.stale).toBe(true);
      await refreshReached(held.reached, worker); // built with the OLD credit and the item, unpublished
      if (identity) {
        await setMemberIdentity(db(), seed.teamId, newOwner,
          { provider: "slack", externalId: "U_TIMELINE" }, { force: true });
      } else {
        await revokeItem(seed, item.id);
      }
      held.release();
      await worker.settleTimelineRefreshes();
    } finally {
      held.release();
      spy.mockRestore();
    }

    const refused = (days: TimelineDay[]) => identity
      ? credited(days).has(seed.memberId)
      : JSON.stringify(days).includes("first AIO-1170");
    const next = await read(worker, seed);
    expect(refused(next.days)).toBe(false);
    if (identity) expect(credited(next.days)).toContain(newOwner);
    expect(next.freshness.stale).toBe(false);
    // Whatever now stands in the row, it is not the build that lost the race.
    const persisted = await worker.readTimelineCache(db(), seed.teamId, "team", await visOf(seed));
    expect(refused(persisted!.days)).toBe(false);
  }, LONG);

  it.each([
    { layer: "this worker's memory entry", fresh: false },
    { layer: "a second worker's persisted row", fresh: true },
  ])("rebuilds cold on an identity change while data lags, never serving the old credit from $layer (AC-PA-14b)", async ({ fresh }) => {
    const { seed } = await warmed();
    const newOwner = await anotherMember(seed.teamId);
    const worker = await secondWorker();
    await read(worker, seed);

    await bump(seed.teamId, "data_generation");
    const stale = await read(worker, seed);
    expect(stale.freshness.stale).toBe(true);
    expect(credited(stale.days)).toContain(seed.memberId);
    await worker.settleTimelineRefreshes();
    await bump(seed.teamId, "data_generation");

    // Data lags AND identity moved. The lag is tolerable; the remap is not.
    await setMemberIdentity(db(), seed.teamId, newOwner,
      { provider: "slack", externalId: "U_TIMELINE" }, { force: true });
    const served = await read(fresh ? await secondWorker() : worker, seed);
    expect(credited(served.days)).toContain(newOwner);
    expect(credited(served.days)).not.toContain(seed.memberId);
    expect(served.freshness.stale).toBe(false);
  }, LONG);

  it("rebuilds cold after an identity correction while presentation bumps keep landing (AC-PA-14c)", async () => {
    const { seed } = await warmed();
    const newOwner = await anotherMember(seed.teamId);
    await setMemberIdentity(db(), seed.teamId, newOwner,
      { provider: "slack", externalId: "U_TIMELINE" }, { force: true });

    // Every generation read this request makes finds the counter moved again. It used to give up
    // after two attempts; a backfill is not a reason to fail a correction.
    const served = await read(cache, seed, backfilling(db(), seed.teamId));

    expect(credited(served.days)).toContain(newOwner);
    expect(credited(served.days)).not.toContain(seed.memberId);
    // Correct about identity, honest about the rest: it was overtaken, so it is stale and prose-free.
    expect(served.freshness.stale).toBe(true);
    expect(hasProse(served.days)).toBe(false);
    const row = await rowOf(seed);
    const now = await live(seed.teamId);
    expect(row.payload.generations.identityGeneration).toBe(now.identityGeneration);
    expect(BigInt(row.payload.generations.presentationGeneration))
      .toBeLessThan(BigInt(now.presentationGeneration));
  }, LONG);

  /** A row that reads as a version MISS and whose prose is otherwise salvageable into the rebuild. */
  async function versionMissWithProse() {
    const base = await warmed();
    await rewritePayload(base.seed, (payload) => {
      payload.v = cache.PAYLOAD_VERSION + 1;
      payload.days[0].people[0].summary = "Bridged across the bump.";
    });
    return base;
  }

  // THE CONTROL for the test below: with nothing overtaking it, that cold build carries the prose.
  it("bridges prose across a version miss when nothing overtakes the cold build (condition 4 control)", async () => {
    const { seed } = await versionMissWithProse();
    const served = await read(await secondWorker(), seed);
    expect(people(served.days).map((p) => p.summary)).toContain("Bridged across the bump.");
    expect(served.freshness.stale).toBe(false);
  }, LONG);

  it("returns a cold build overtaken by a data bump as STALE, prose-free, under its before-stamps (conditions 2 and 4)", async () => {
    const { seed } = await versionMissWithProse();
    const earlier = await live(seed.teamId);
    const held = holdBeforePublish(db());
    const worker = await secondWorker();

    const pending = read(worker, seed, held.client);
    try {
      await Promise.race([held.reached, pending.then(() => {
        throw new Error("fixture: the cold read finished without reaching publication");
      })]);
      await bump(seed.teamId, "data_generation");
    } finally {
      held.release();
    }
    const served = await pending;

    // Permission to PUBLISH is not permission to call it fresh, or to keep prose it cannot vouch for.
    expect(served.freshness.stale).toBe(true);
    expect(hasProse(served.days)).toBe(false);
    expect((await rowOf(seed)).payload.generations).toEqual(earlier);
    // The next reader of that row, in another process, is told the same.
    const later = await read(await secondWorker(), seed);
    expect(later.freshness.stale).toBe(true);
    expect(hasProse(later.days)).toBe(false);
  }, LONG);
});
