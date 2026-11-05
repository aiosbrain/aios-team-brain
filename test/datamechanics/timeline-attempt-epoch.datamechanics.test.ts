import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * AIO-1167 R92 #1 — a Timeline request attempt is bound to ONE authorization epoch, captured before its
 * first admission read (real Postgres, Google Drive evidence, the real cache layer).
 *
 * A restricted Drive document is visible to reader R and to member S only through an ordinary group.
 * R's read resolves its admission (the project set → the variant key); an ordinary-group revocation of R
 * then commits E+1. Whatever stage of R's attempt that lands at — after admission, between the memory and
 * persisted lookups, before salvage, before publication, with the persistent write failing — the attempt
 * is invalidated and retried whole: R never receives or publishes the restricted evidence, its retry
 * resolves the reduced view, even when S (still authorized) has LEGITIMATELY populated the old project
 * set's variant at E+1 in memory or in the persisted cache. Unchanged authority still serves hits; S still
 * sees the document; retry exhaustion and an unreadable authority fail closed. Deterministic hooks, no
 * sleeps; a retried attempt is never mistaken for success — the served payload is asserted.
 */

const fault = vi.hoisted(() => ({ epochReadFails: false, cacheWriteFails: false }));
// Faults are injected at the SQL itself (the one `runSql` seam), so every epoch read — including the
// ones `withLockedAuthorizationEpoch` makes inside its own module — fails as a real outage would.
vi.mock("@/lib/db/pg/pool", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/db/pg/pool")>();
  const runSql = (async (...args: Parameters<typeof actual.runSql>) => {
    if (fault.epochReadFails && /from team_authorization_epochs where team_id=\$1 for share/i.test(String(args[0]))) {
      throw new Error("authorization epoch read failed");
    }
    if (fault.cacheWriteFails && /insert into work_timeline_cache/i.test(String(args[0]))) {
      throw new Error("persistent timeline cache write failed");
    }
    return actual.runSql(...args);
  }) as typeof actual.runSql;
  return { ...actual, runSql };
});

import { addMemberToGroup, createGroup, grantProjectToGroup, removeMemberFromGroup } from "@/lib/access/groups";
import { contentTimelineEnforcement } from "@/lib/access/admission";
import {
  getCachedWorkTimeline, resolveTimelineVariant, settleTimelineRefreshes, TimelineAuthorizationChangedError,
  writeTimelineCache, type TimelineServeOrigin,
} from "@/lib/dashboard/timeline-cache";
import { getWorkTimeline } from "@/lib/dashboard/work-timeline";
import { getPool } from "@/lib/db/pg/pool";
import { revocationEpoch } from "@/lib/access/authorization-epoch";
import { setMemberIdentity } from "@/lib/identity/member-identities";
import { backfillTeamContext } from "@/lib/projects/context/backfill";
import { convergeIdentityAttribution, db, driveFixture, placeMemberByTier, seedTeam, type Seed } from "./helpers";

afterEach(async () => {
  fault.epochReadFails = false;
  fault.cacheWriteFails = false;
  await settleTimelineRefreshes();
});

const SECRET = "obsidianlark launch plan";
const recent = new Date(Date.now() - 2 * 86_400_000).toISOString();

async function member(seed: Seed, name: string): Promise<string> {
  const { data } = await db().from("members").insert({
    team_id: seed.teamId, email: `${randomUUID()}@test.local`, display_name: name,
    actor_handle: `${name.toLowerCase()}-${randomUUID().slice(0, 8)}`, role: "member", tier: "team", status: "active",
  }).select("id").single();
  const id = (data as { id: string }).id;
  await placeMemberByTier(seed.teamId, id, "team");
  return id;
}

/** R and S in group G; G is granted the restricted project holding one Drive document edited by E. */
async function world() {
  const seed = await seedTeam();
  await backfillTeamContext(db(), seed.teamId);
  const editor = await member(seed, "Editor");
  await setMemberIdentity(db(), seed.teamId, editor, { provider: "gdrive", externalId: "permission:perm-editor" });
  const reader = await member(seed, "Reader");
  const second = await member(seed, "Second");
  const doc = await driveFixture(seed, {
    project: "drive-timeline", path: `gdrive/plan-${randomUUID()}.md`, body: `${SECRET} body`,
    frontmatter: {
      source: "gdrive", source_id: `plan-${randomUUID().slice(0, 8)}`, title: SECRET, source_ts: recent,
      authors: [{ provider: "gdrive", external_id: "permission:perm-editor", role: "editor" }],
      contributions: [{ external_id: "permission:perm-editor", role: "editor", at: recent }],
    },
  });
  await backfillTeamContext(db(), seed.teamId);
  const { data: proj } = await db().from("projects")
    .insert({ team_id: seed.teamId, slug: `r-${randomUUID().slice(0, 8)}`, name: "Restricted", kind: "initiative" })
    .select("id").single();
  const projectId = (proj as { id: string }).id;
  const group = await createGroup(db(), seed.teamId, `g-${randomUUID().slice(0, 8)}`, "G", seed.memberId);
  for (const id of [reader, second]) expect((await addMemberToGroup(db(), seed.teamId, group.groupId!, id, seed.memberId)).ok).toBe(true);
  expect((await grantProjectToGroup(db(), seed.teamId, projectId, group.groupId!, seed.memberId)).ok).toBe(true);
  const { data: unit } = await db().from("project_context_units").select("id").eq("source_item_id", doc.id).single();
  await db().from("project_context_memberships").update({ valid_to: new Date().toISOString() })
    .eq("context_unit_id", (unit as { id: string }).id).is("valid_to", null);
  await db().from("project_context_memberships")
    .insert({ team_id: seed.teamId, project_id: projectId, context_unit_id: (unit as { id: string }).id, method: "manual" });
  await convergeIdentityAttribution(seed);
  const revoke = async () => {
    expect((await removeMemberFromGroup(db(), seed.teamId, group.groupId!, reader, seed.memberId)).ok).toBe(true);
  };
  return { seed, reader, second, revoke };
}
type W = Awaited<ReturnType<typeof world>>;

const shows = (days: unknown) => JSON.stringify(days).includes(SECRET);
const read = (w: W, memberId: string, hooks: Parameters<typeof getCachedWorkTimeline>[4] = {}) =>
  getCachedWorkTimeline(db(), w.seed.teamId, "team", memberId, hooks);
/** No row R's attempts wrote may carry the secret under R's CURRENT (reduced) variant. */
async function readerRowsClean(w: W): Promise<boolean> {
  const { visibilityHash } = await resolveTimelineVariant(db(), w.seed.teamId, w.reader);
  const { rows } = await getPool().query<{ payload: unknown }>(
    `select payload from work_timeline_cache where team_id=$1 and group_key like $2`, [w.seed.teamId, `%${visibilityHash}%`]);
  return rows.every((row) => !shows(row.payload));
}

describe("R92 #1: a Timeline attempt is bound to the epoch captured before its admission", () => {
  it("sanity: R and S both see the restricted Drive evidence before any revocation", async () => {
    const w = await world();
    expect(shows((await read(w, w.reader)).days)).toBe(true);
    expect(shows((await read(w, w.second)).days)).toBe(true);
  }, 60_000);

  it("cold: a revocation after admission resolve retries whole and serves the reduced view", async () => {
    const w = await world();
    const attempts: number[] = [];
    const served = await read(w, w.reader, {
      afterAdmission: async (attempt) => { attempts.push(attempt); if (attempt === 0) await w.revoke(); },
    });
    expect(attempts).toEqual([0, 1]);
    expect(shows(served.days), "R never receives the revoked evidence").toBe(false);
    expect(await readerRowsClean(w)).toBe(true);
    expect(shows((await read(w, w.second)).days), "S is still authorized").toBe(true);
  }, 60_000);

  it("memory: S legitimately populated the old project set's variant at E+1 — R's stale attempt never serves it", async () => {
    const w = await world();
    const origins: TimelineServeOrigin[] = [];
    const served = await read(w, w.reader, {
      afterAdmission: async (attempt) => {
        if (attempt !== 0) return;
        await w.revoke();
        expect(shows((await read(w, w.second)).days), "S populates memory + persisted at E+1").toBe(true);
      },
      onServed: (origin) => origins.push(origin),
    });
    expect(shows(served.days)).toBe(false);
    expect(origins).toEqual(["cold"]); // the reduced view's own cold build — never S's memory variant
  }, 60_000);

  it("persisted: a revocation between the memory and persisted lookups, with S's E+1 row persisted, retries", async () => {
    const w = await world();
    const served = await read(w, w.reader, {
      beforePersistedRead: async (attempt) => {
        if (attempt !== 0) return;
        await w.revoke();
        // Another process (S, still authorized) persists the OLD project set's variant at E+1.
        const variant = await resolveTimelineVariant(db(), w.seed.teamId, w.second);
        const days = await getWorkTimeline(db(), w.seed.teamId, "team", undefined,
          await contentTimelineEnforcement(db(), w.seed.teamId, w.second));
        expect(shows(days)).toBe(true);
        const published = await writeTimelineCache(db(), w.seed.teamId, variant.admission.posture, days, false, variant,
          await revocationEpoch(db(), w.seed.teamId));
        expect(published.status).toBe("published");
      },
    });
    expect(shows(served.days)).toBe(false);
  }, 60_000);

  it.each(["beforeSalvage", "beforeColdPublish"] as const)("a revocation at %s invalidates the cold attempt; nothing restricted is published", async (stage) => {
    const w = await world();
    const served = await read(w, w.reader, {
      [stage]: async (attempt: number) => { if (attempt === 0) await w.revoke(); },
    });
    expect(shows(served.days)).toBe(false);
    const { rows } = await getPool().query<{ payload: unknown }>(
      `select payload from work_timeline_cache where team_id=$1`, [w.seed.teamId]);
    expect(rows.some((row) => shows(row.payload)), "the stale cold build never landed").toBe(false);
  }, 60_000);

  it("a revocation before publication WITH the persistent write failing: the memory fallback is refused too", async () => {
    const w = await world();
    fault.cacheWriteFails = true;
    const served = await read(w, w.reader, {
      beforeColdPublish: async (attempt) => { if (attempt === 0) await w.revoke(); },
    });
    expect(shows(served.days)).toBe(false);
    fault.cacheWriteFails = false;
    // Nothing restricted reached process memory either: R's next read is still reduced.
    expect(shows((await read(w, w.reader)).days)).toBe(false);
  }, 60_000);

  it("unchanged authority: memory hits serve; retry exhaustion and an unreadable authority fail closed", async () => {
    const w = await world();
    const origins: TimelineServeOrigin[] = [];
    expect(shows((await read(w, w.second, { onServed: (o) => origins.push(o) })).days)).toBe(true);
    expect(shows((await read(w, w.second, { onServed: (o) => origins.push(o) })).days)).toBe(true);
    expect(origins).toEqual(["cold", "memory"]);

    // Every attempt invalidated: the read fails closed instead of serving the stale admission.
    let revocations = 0;
    await expect(read(w, w.reader, {
      afterAdmission: async () => { revocations++; await getPool().query(
        `update team_authorization_epochs set epoch = epoch + 1, updated_at = now() where team_id=$1`, [w.seed.teamId]); },
    })).rejects.toBeInstanceOf(TimelineAuthorizationChangedError);
    expect(revocations).toBe(2);

    fault.epochReadFails = true;
    await expect(read(w, w.reader)).rejects.toThrow(/authorization epoch read failed/);
  }, 60_000);
});
