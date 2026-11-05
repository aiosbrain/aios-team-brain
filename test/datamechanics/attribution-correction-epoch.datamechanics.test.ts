import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { authorizationEpoch } from "@/lib/access/authorization-epoch";
import { getCachedWorkTimeline, settleTimelineRefreshes } from "@/lib/dashboard/timeline-cache";
import type { TimelineDay } from "@/lib/dashboard/timeline-group";
import { getPool } from "@/lib/db/pg/pool";
import { readArcCache, writeArcCache } from "@/lib/graph/arc-cache";
import { arcCorrectionVersion } from "@/lib/graph/arc-corrections";
import type { NarrativeArc } from "@/lib/graph/arcs";
import { applyAttributionCorrection } from "@/lib/ingest/attribution-correction";
import { backfillTeamContext } from "@/lib/projects/context/backfill";
import { convergeIdentityAttribution, db, externalMember, ingest, seedTeam, type Seed } from "./helpers";

/**
 * AIO-1167 (P2, AC-09) — a manual attribution correction is a durable cache-generation barrier
 * (real Postgres).
 *
 * Spec. `applyAttributionCorrection` rewrites primary credit — item, versions, Drive contribution
 * evidence — and must advance the team's authorization epoch in the SAME transaction, before it
 * commits. Then:
 *   · another process's warm Timeline and arc memory, and the persisted rows, stop serving the old
 *     mapped credit the moment the correction commits — no best-effort eviction (`after()`) needed;
 *   · a rebuild that read the old credit before the correction and publishes after it is rejected,
 *     and the reader gets a fresh build;
 *   · fresh output holds for every viewer variant;
 *   · if the epoch cannot be advanced, the whole correction rolls back.
 * No identity revision or full-team repair is opened: the correction writes every effect itself.
 *
 * "Another process" is a second, independently loaded module graph (`vi.resetModules()`): its own
 * Timeline/arc memory and its own connection pool. Nothing here calls the eviction the admin action
 * schedules with `after()` — that hook is skipped throughout, which is the case under test.
 */

const epochFault = vi.hoisted(() => ({ fail: false }));
vi.mock("@/lib/access/authorization-epoch", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/access/authorization-epoch")>();
  return {
    ...actual,
    advanceAuthorizationEpoch: async (teamId: string) => {
      if (epochFault.fail) throw new Error("authorization epoch advance failed (injected)");
      return actual.advanceAuthorizationEpoch(teamId);
    },
  };
});

afterEach(async () => {
  epochFault.fail = false;
  await settleTimelineRefreshes();
});

const RECENT = new Date(Date.now() - 2 * 86_400_000).toISOString();
const MARKER = "feat: correction epoch marker (CORR-1)";
const CORRECTED = "Bea Corrected";
const NO_KEYS = { anthropicApiKey: null, openaiApiKey: null } as never;

interface Fixture { seed: Seed; external: string; creditedId: string }

/**
 * A task-linked, EXTERNAL-audience commit credited (by `items.member_id`) to the seed member
 * "Tester", visible to a team viewer and an external viewer (two admission variants), with the
 * correction target "Bea Corrected" on the roster and the identity repair complete.
 */
async function creditedTeam(): Promise<Fixture> {
  const seed = await seedTeam();
  const { error: memberError } = await db().from("members").insert({
    team_id: seed.teamId, email: `${randomUUID()}@test.local`, display_name: CORRECTED,
    actor_handle: `bea-${randomUUID().slice(0, 8)}`, role: "member", tier: "team", status: "active",
  });
  expect(memberError).toBeNull();
  const anchor = await ingest(seed, {
    kind: "artifact", path: `commits/repo/${randomUUID()}.md`, access: "external",
    body: "seed", frontmatter: { source: "git", committed_at: RECENT },
  });
  const source = await ingest(seed, {
    kind: "deliverable", path: `task-docs/${randomUUID()}.md`, access: "external",
    body: "task source CORR-1", frontmatter: { source: "linear" },
  });
  const { error: taskError } = await db().from("tasks").insert({
    team_id: seed.teamId, project_id: anchor.projectId, row_key: "CORR-1", title: "Correction rollout",
    assignee: "Tester", status: "in_progress", audience: "external", origin: "sync", source_item_id: source.id,
  });
  expect(taskError).toBeNull();
  const credited = await ingest(seed, {
    kind: "artifact", path: `commits/repo/${randomUUID()}.md`, access: "external",
    body: MARKER, frontmatter: { source: "git", committed_at: RECENT },
  });
  const external = await externalMember(seed);
  const backfill = await backfillTeamContext(db(), seed.teamId);
  expect(backfill.ok, backfill.ok ? "" : backfill.error).toBe(true);
  await convergeIdentityAttribution(seed);
  return { seed, external, creditedId: credited.id };
}

/** Who the payload credits with the marker commit. */
function creditedTo(days: TimelineDay[]): string[] {
  return [...new Set(days.flatMap((day) => day.people)
    .filter((person) => JSON.stringify(person).includes(MARKER))
    .map((person) => person.name))].sort();
}

function correct(f: Fixture, toMember: string) {
  return applyAttributionCorrection(db(), f.seed.teamId, {
    kind: "reassign", match: { itemId: f.creditedId }, toMember,
  }, { memberId: f.seed.memberId }, 1);
}

/** A second process: its own module graph — Timeline and arc memory, admin client and pool. */
async function secondProcess() {
  vi.resetModules();
  return {
    timeline: await import("@/lib/dashboard/timeline-cache"),
    arcs: await import("@/lib/graph/arcs"),
    admin: await import("@/lib/db/admin"),
  };
}

describe("AIO-1167 manual attribution correction advances the authorization epoch (real Postgres)", () => {
  it.each([
    { label: "A → B", toMember: CORRECTED, expected: [CORRECTED] },
    { label: "A → nobody", toMember: "nobody", expected: [] as string[] },
  ])("$label: warm Timeline memory in two processes, persisted rows and a second process's arc memory stop serving the old credit at commit", async ({ toMember, expected }) => {
    const f = await creditedTeam();
    const other = await secondProcess();
    try {
      const otherDb = other.admin.adminClient();
      const viewers = [
        { memberId: f.seed.memberId, tier: "team" as const },
        { memberId: f.external, tier: "external" as const },
      ];
      // Warm: this process builds and persists each variant; the other reads it into ITS memory; a
      // second read in each is a memory hit at the current epoch.
      const before: Record<string, string[]> = {};
      for (const viewer of viewers) {
        await getCachedWorkTimeline(db(), f.seed.teamId, viewer.tier, viewer.memberId);
        await other.timeline.getCachedWorkTimeline(otherDb, f.seed.teamId, viewer.tier, viewer.memberId);
        before[viewer.memberId] = creditedTo((await getCachedWorkTimeline(db(), f.seed.teamId, viewer.tier, viewer.memberId)).days);
        expect(creditedTo((await other.timeline.getCachedWorkTimeline(otherDb, f.seed.teamId, viewer.tier, viewer.memberId)).days))
          .toEqual(before[viewer.memberId]);
      }
      // Non-vacuous: the team viewer's warm copies really carry the old mapped credit.
      expect(before[f.seed.memberId]).toEqual(["Tester"]);

      // The other process's arc memory and the persisted arc row, at the current epoch.
      const epoch = await authorizationEpoch(db(), f.seed.teamId);
      const oldArc: NarrativeArc = {
        id: "credit", title: "OLD-CREDIT-ARC", summary: "Tester shipped the correction rollout", confidence: "high",
        participants: ["Tester"], supporting_sources: [], derived_at: new Date().toISOString(),
        evidence: [{ fact: "rollout", itemId: f.creditedId }],
      };
      const scopeKey = `g:corr-${randomUUID().slice(0, 8)}`;
      const correctionVersion = await arcCorrectionVersion(f.seed.teamId);
      await writeArcCache(db(), f.seed.teamId, scopeKey, [oldArc], "old", { authorizationEpoch: epoch });
      other.arcs.memCacheSet(scopeKey, {
        arcs: [oldArc], at: Date.now(), factsHash: "old", degraded: false, authorizationEpoch: epoch, correctionVersion,
      });
      expect(await readArcCache(db(), f.seed.teamId, scopeKey)).not.toBeNull();
      // Non-vacuous: the other process serves its warm arc memory before the correction.
      const warmArcs = await other.arcs.getArcs(otherDb, f.seed.teamId, f.seed.teamSlug, [scopeKey.slice(2)], NO_KEYS, { scopeKey });
      expect(JSON.stringify(warmArcs.arcs)).toContain("OLD-CREDIT-ARC");

      // The correction — and NOTHING else: no after(), no eviction, no repair.
      const revisionBefore = (await getPool().query<{ revision: string }>(
        "select revision::text as revision from team_identity_authority where team_id=$1", [f.seed.teamId])).rows[0]?.revision;
      await expect(correct(f, toMember)).resolves.toMatchObject({ ok: true, updated: 1 });
      expect(await authorizationEpoch(db(), f.seed.teamId)).toBeGreaterThan(epoch);
      // No revision and no repair were opened to invalidate caches.
      const authority = (await getPool().query<{ revision: string; repair_status: string }>(
        "select revision::text as revision, repair_status from team_identity_authority where team_id=$1", [f.seed.teamId])).rows[0];
      expect(authority?.revision).toBe(revisionBefore);
      expect(authority?.repair_status ?? "complete").toBe("complete");

      for (const viewer of viewers) {
        const here = creditedTo((await getCachedWorkTimeline(db(), f.seed.teamId, viewer.tier, viewer.memberId)).days);
        const there = creditedTo((await other.timeline.getCachedWorkTimeline(otherDb, f.seed.teamId, viewer.tier, viewer.memberId)).days);
        for (const served of [here, there]) {
          expect(served, `viewer ${viewer.tier}`).not.toContain("Tester");
          // A variant that saw the commit before sees it under its corrected credit now.
          if (before[viewer.memberId].length > 0) expect(served, `viewer ${viewer.tier}`).toEqual(expected);
        }
      }
      expect(await readArcCache(db(), f.seed.teamId, scopeKey)).toBeNull();
      const served = await other.arcs.getArcs(otherDb, f.seed.teamId, f.seed.teamSlug, [scopeKey.slice(2)], NO_KEYS, { scopeKey });
      expect(JSON.stringify(served.arcs)).not.toContain("OLD-CREDIT-ARC");
    } finally {
      // Its background work settles here. The pool is left open like every suite's: after the
      // registry reset, later lazy imports in this worker resolve to this graph's modules.
      await other.timeline.settleTimelineRefreshes();
      await other.arcs.settleArcRefreshes();
    }
  }, 60_000);

  it("a rebuild that read the old credit and publishes after the correction is rejected; the reader gets a fresh build", async () => {
    const f = await creditedTeam();
    let corrected = false;
    const result = await getCachedWorkTimeline(db(), f.seed.teamId, "team", f.seed.memberId, {
      // Attempt 0 has built its ledger from the OLD credit and is about to publish it.
      beforeColdPublish: async (attempt) => {
        if (attempt !== 0) return;
        await expect(correct(f, CORRECTED)).resolves.toMatchObject({ ok: true, updated: 1 });
        corrected = true;
      },
    });
    expect(corrected).toBe(true);
    expect(creditedTo(result.days)).toEqual([CORRECTED]);
    // What was published is the fresh build, at the current epoch — the stale one never landed.
    const current = await authorizationEpoch(db(), f.seed.teamId);
    const { rows } = await getPool().query<{ authorization_epoch: string; payload: unknown }>(
      "select authorization_epoch::text as authorization_epoch, payload from work_timeline_cache where team_id=$1", [f.seed.teamId]);
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(Number(row.authorization_epoch)).toBe(current);
      expect(creditedTo((row.payload as { days?: TimelineDay[] }).days ?? [])).not.toContain("Tester");
    }
    // And a later read serves the corrected credit too.
    expect(creditedTo((await getCachedWorkTimeline(db(), f.seed.teamId, "team", f.seed.memberId)).days)).toEqual([CORRECTED]);
  }, 60_000);

  it("if the epoch cannot be advanced, the whole correction rolls back — item, versions, lock and audit", async () => {
    const f = await creditedTeam();
    const pool = getPool();
    const snapshot = async () => ({
      item: (await pool.query("select member_id, member_id_locked, updated_at::text as updated_at from items where id=$1", [f.creditedId])).rows,
      versions: (await pool.query("select id, member_id from item_versions where item_id=$1 order by id", [f.creditedId])).rows,
      evidence: (await pool.query("select evidence_key, member_id, diagnostic from gdrive_contribution_evidence where item_id=$1 order by 1", [f.creditedId])).rows,
      audit: (await pool.query<{ n: number }>(
        "select count(*)::int as n from audit_log where team_id=$1 and action in ('attribution.corrected','item.reassigned')", [f.seed.teamId])).rows[0].n,
      epoch: await authorizationEpoch(db(), f.seed.teamId),
    });
    const warm = creditedTo((await getCachedWorkTimeline(db(), f.seed.teamId, "team", f.seed.memberId)).days);
    expect(warm).toEqual(["Tester"]);
    const before = await snapshot();

    epochFault.fail = true;
    await expect(correct(f, CORRECTED)).rejects.toThrow(/authorization epoch advance failed/);
    epochFault.fail = false;

    expect(await snapshot()).toEqual(before);
    expect(before.item[0]).toMatchObject({ member_id_locked: false });
    // Nothing changed, so the warm credit is still the true credit.
    expect(creditedTo((await getCachedWorkTimeline(db(), f.seed.teamId, "team", f.seed.memberId)).days)).toEqual(["Tester"]);
  }, 60_000);
});
