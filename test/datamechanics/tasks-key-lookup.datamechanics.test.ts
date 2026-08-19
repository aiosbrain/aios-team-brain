import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import { GET as tasksGET } from "@/app/api/v1/tasks/route";
import { issueApiKey } from "@/lib/admin/keys";
import { db, seedTeam, ingest, placeMemberByTier, type Seed } from "./helpers";
import { backfillTeamContext } from "@/lib/projects/context/backfill";

/**
 * Spec for the by-key task lookup (brain-api 1.14).
 *
 * WHY IT EXISTS. `?all=1` is capped at 500 rows ordered `updated_at` ASCENDING and does not
 * paginate, so a "full table read" is a prefix of the STALEST rows. The PR work-key CI check used
 * it to answer "does this ticket exist?" and told us a real ticket did not: measured on prod,
 * 677 keyed tasks and `AIO-484` at rank 628 — never in the response. The check was corrected to
 * report "couldn't verify", which is honest but means the failure it was BUILT for (a PR citing an
 * invented `AIO-48x`) is no longer caught at all.
 *
 * The contract these assertions are derived from — written before the implementation:
 *   1. `mode=table&keys=A,B` returns exactly the rows for those keys, whatever their `updated_at`.
 *   2. `unknown_keys` names the requested keys that matched nothing — so "does it exist" is an
 *      ANSWER, not something the client infers from absence and gets wrong.
 *   3. Absence is PROOF here: the query is bounded by the keys, so no cap can hide a match.
 *      If that ever stops holding, `unknown_keys` must be `null` — never a wrong list.
 *   4. `keys` is refused outside table mode: writeback/sync-origin apply extra filters, so a real
 *      key would look absent. A silent wrong answer is the exact bug this endpoint is fixing.
 *   5. Tier isolation holds — an external key learns nothing about a team-audience task, including
 *      whether it exists.
 *   6. Old clients are byte-unaffected: no `keys` param, no `unknown_keys` field.
 */

const URL = "http://test/api/v1/tasks";

async function issueKeyFor(seed: Seed, tier: "team" | "external"): Promise<string> {
  let memberId = seed.memberId;
  if (tier === "external") {
    const { data, error } = await db()
      .from("members")
      .insert({
        team_id: seed.teamId,
        email: `ext-${randomUUID().slice(0, 8)}@test.local`,
        display_name: "External",
        actor_handle: `ext-${randomUUID().slice(0, 8)}`,
        role: "member",
        tier: "external",
        status: "active",
      })
      .select("id")
      .single();
    if (error || !data) throw new Error(`external member seed failed: ${error?.message}`);
    memberId = (data as { id: string }).id;
    await placeMemberByTier(seed.teamId, memberId, "external");
  }
  const { key } = await issueApiKey(db(), seed.teamId, memberId, `${tier} key`);
  return key;
}

function get(key: string, teamSlug: string, qs: string) {
  const req = new Request(`${URL}?${qs}`, {
    headers: { Authorization: `Bearer ${key}`, "X-AIOS-Team": teamSlug },
  }) as unknown as NextRequest;
  return tasksGET(req);
}

type FeedRow = { row_key: string; title: string; status: string };
type Feed = { mode: string; tasks: { project: string; rows: FeedRow[] }[]; unknown_keys?: string[] | null };

const rowKeys = (feed: Feed): string[] => feed.tasks.flatMap((g) => g.rows.map((r) => r.row_key)).sort();

async function seedProject(teamId: string, slug: string): Promise<string> {
  const { data } = await db().from("projects").insert({ team_id: teamId, slug, name: slug }).select("id").single();
  return (data as { id: string }).id;
}

/** One batch insert — `updatedAt` is what decides whether `?all=1` would ever reach the row.
 *  `creator` is the hand-typed provenance the real dashboard writer stamps (ENFB-2: the feed
 *  compiles the provenance predicate in-query; a created_by-less ui row is unproducible). */
async function seedTasks(
  teamId: string,
  projectId: string,
  creator: string,
  rows: { rowKey: string; updatedAt: string; audience?: "team" | "external" }[]
): Promise<void> {
  const { error } = await db()
    .from("tasks")
    .insert(
      rows.map((r) => ({
        team_id: teamId,
        project_id: projectId,
        row_key: r.rowKey,
        title: `task ${r.rowKey}`,
        status: "in_progress",
        assignee: "",
        origin: "ui",
        created_by: creator,
        audience: r.audience ?? "team",
        updated_at: r.updatedAt,
      }))
    );
  if (error) throw new Error(`task seed failed: ${error.message}`);
}

describe("tasks by-key lookup (real handler, real Postgres)", () => {
  it("answers for keys the 500-row table read can NEVER reach", async () => {
    // THE REGRESSION, reproduced: 505 stale tasks fill the page, and the key we ask about is the
    // NEWEST — so `?all=1` orders it last and the cap drops it. This is prod's AIO-484 at rank 628.
    const seed = await seedTeam();
    const proj = await seedProject(seed.teamId, "acme");
    const key = await issueKeyFor(seed, "team");
    await seedTasks(seed.teamId, proj, seed.memberId,
      Array.from({ length: 505 }, (_, i) => ({
        rowKey: `OLD-${i}`,
        updatedAt: new Date(Date.UTC(2020, 0, 1) + i * 60_000).toISOString(),
      }))
    );
    await seedTasks(seed.teamId, proj, seed.memberId, [{ rowKey: "AIO-484", updatedAt: "2026-07-27T10:00:00Z" }]);

    // Proof the fixture is real: the full-table read genuinely cannot see it.
    const table = (await (await get(key, seed.teamSlug, "all=1")).json()) as Feed;
    expect(rowKeys(table)).not.toContain("AIO-484");

    // The lookup finds it regardless of how stale-ordered the table is.
    const feed = (await (await get(key, seed.teamSlug, "mode=table&keys=AIO-484")).json()) as Feed;
    expect(rowKeys(feed)).toEqual(["AIO-484"]);
    expect(feed.unknown_keys).toEqual([]);
  });

  it("names the keys that do not exist, so absence is an ANSWER and not an inference", async () => {
    const seed = await seedTeam();
    const proj = await seedProject(seed.teamId, "acme");
    const key = await issueKeyFor(seed, "team");
    await seedTasks(seed.teamId, proj, seed.memberId, [{ rowKey: "AIO-484", updatedAt: "2026-07-27T10:00:00Z" }]);

    const feed = (await (await get(key, seed.teamSlug, "mode=table&keys=AIO-484,AIO-999,AIO-1000")).json()) as Feed;
    expect(rowKeys(feed)).toEqual(["AIO-484"]);
    expect(feed.unknown_keys?.slice().sort()).toEqual(["AIO-1000", "AIO-999"]);
  });

  it("REFUSES `keys` outside table mode rather than answering from a filtered feed", async () => {
    // writeback hides `origin='sync'` rows and sync-origin hides `origin='ui'` ones, so a real key
    // would come back "unknown" — a confident wrong answer, which is the whole failure being fixed.
    const seed = await seedTeam();
    await seedProject(seed.teamId, "acme");
    const key = await issueKeyFor(seed, "team");

    for (const qs of ["keys=AIO-484", "mode=writeback&keys=AIO-484", "mode=sync-origin&project=acme&keys=AIO-484"]) {
      const res = await get(key, seed.teamSlug, qs);
      expect(res.status, `${qs} must be refused, not silently answered`).toBe(400);
    }
  });

  it("refuses more keys than it can answer without truncating", async () => {
    const seed = await seedTeam();
    await seedProject(seed.teamId, "acme");
    const key = await issueKeyFor(seed, "team");
    const many = Array.from({ length: 201 }, (_, i) => `AIO-${i}`).join(",");
    expect((await get(key, seed.teamSlug, `mode=table&keys=${many}`)).status).toBe(400);
  });

  it("TIER: an external key does not learn that a team task exists", async () => {
    // No RLS — `visibleTasks` is the only enforcement. The row must not appear, AND the key must be
    // reported as unknown: "it exists but you can't see it" is itself a disclosure.
    const seed = await seedTeam();
    const proj = await seedProject(seed.teamId, "acme");
    const teamKey = await issueKeyFor(seed, "team");
    const extKey = await issueKeyFor(seed, "external");
    // ENFB-2 re-specification: a hand-typed row is TEAM-ONLY (the PRET-5 H2 audience wall on
    // the null-source branch — enfb-decision-create pins the same rule), so the external
    // entitlement arm rides a SOURCED row whose item lives in external-shared, the shape a
    // real client-shared push produces.
    await seedTasks(seed.teamId, proj, seed.memberId, [
      { rowKey: "TEAM-1", updatedAt: "2026-07-27T10:00:00Z", audience: "team" },
    ]);
    const extItem = await ingest(seed, { path: "ext-shared.md", body: "e", access: "external", project: "acme" });
    await backfillTeamContext(db(), seed.teamId);
    await db().from("tasks").insert({
      team_id: seed.teamId, project_id: proj, row_key: "EXT-1", title: "task EXT-1",
      status: "in_progress", assignee: "", origin: "sync", audience: "external",
      source_item_id: extItem.id, updated_at: "2026-07-27T10:00:00Z",
    });

    const ext = (await (await get(extKey, seed.teamSlug, "mode=table&keys=TEAM-1,EXT-1")).json()) as Feed;
    expect(rowKeys(ext)).toEqual(["EXT-1"]);
    expect(ext.unknown_keys).toEqual(["TEAM-1"]);

    // …and the same question from a team key proves the row was really there to leak.
    const team = (await (await get(teamKey, seed.teamSlug, "mode=table&keys=TEAM-1,EXT-1")).json()) as Feed;
    expect(rowKeys(team)).toEqual(["EXT-1", "TEAM-1"]);
    expect(team.unknown_keys).toEqual([]);
  });

  it("leaves old clients byte-unaffected — no `keys`, no `unknown_keys`", async () => {
    const seed = await seedTeam();
    const proj = await seedProject(seed.teamId, "acme");
    const key = await issueKeyFor(seed, "team");
    await seedTasks(seed.teamId, proj, seed.memberId, [{ rowKey: "AIO-484", updatedAt: "2026-07-27T10:00:00Z" }]);

    for (const qs of ["all=1", "since=1970-01-01T00:00:00Z"]) {
      const body = (await (await get(key, seed.teamSlug, qs)).json()) as Record<string, unknown>;
      expect(Object.keys(body).sort(), `${qs} response shape must not change`).toEqual([
        "mode",
        "next_cursor",
        "tasks",
      ]);
    }
  });
});
