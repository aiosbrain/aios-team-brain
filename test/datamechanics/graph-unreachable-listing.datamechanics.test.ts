import { describe, expect, it } from "vitest";
import type { GraphEpisode } from "@/lib/graph/graphiti-client";
import { projectItemsToGraph } from "@/lib/graph/project";
import { reconcileProjectedEpisodes, LANDED_SCAN_DEPTH } from "@/lib/graph/reconcile";
import { runGraphProjection } from "@/lib/graph/run";
import type { EpisodeLookup } from "@/lib/graph/episode-lookup";
import type { DbClient } from "@/lib/db/types";
import { db, ingest, seedTeam } from "./helpers";
import { FakeGraphiti, client } from "./fake-graphiti";

// RECONULL-1 ACs (docs/design/reconull1-unreachable-listing.md §3): a FAILED group listing is
// COUNTED (it was silent), nothing is written on a guess, an EMPTY listing over mature rows is loud
// while its bounded recovery is unchanged, and a failed pending-count read is a run error that
// keeps every other counter.

function ep(name: string): GraphEpisode {
  return { content: "x", timestamp: "2020-01-01T00:00:00Z", sourceDescription: "x", name };
}
async function teamSlugFor(teamId: string): Promise<string> {
  const { data } = await db().from("teams").select("slug").eq("id", teamId).maybeSingle();
  return (data as { slug: string }).slug;
}
async function rows(teamId: string, groupId: string) {
  const { data } = await db().from("graph_episodes").select("source_id, content_sha256, episode_uuid").eq("team_id", teamId).eq("group_id", groupId);
  return (data ?? []) as { source_id: string; content_sha256: string; episode_uuid: string | null }[];
}

/** N mature rows in the team group, one never-landed, plus one external row (a second group). */
async function fixture(n = 4) {
  const seed = await seedTeam();
  const slug = await teamSlugFor(seed.teamId);
  const teamGroup = `${slug}_team`;
  const extGroup = `${slug}_external`;
  for (let i = 0; i < n; i++) await ingest(seed, { kind: "deliverable", path: `docs/t${i}.md`, body: `team doc ${i}`, access: "team" });
  await ingest(seed, { kind: "deliverable", path: "docs/x.md", body: "external doc", access: "external" });
  const fake = new FakeGraphiti();
  await projectItemsToGraph(db(), { teamId: seed.teamId, teamSlug: slug, client: client(fake) });
  // Mature (past the grace) and uuid-less so a backfill would be observable.
  await db().from("graph_episodes").update({ projected_at: "2020-01-01T00:00:00Z", episode_uuid: null }).eq("team_id", seed.teamId);
  return { seed, slug, teamGroup, extGroup, fake };
}

describe("RECONULL-1 — a failed group listing is counted, nothing is written on a guess", () => {
  it("AC1(a,b) the landed listing THROWS for the team group → unreachableGroups 1, group unjudged, no write, lookup NEVER called — with the flag on and with the lookup unconfigured", async () => {
    const f = await fixture();
    f.fake.failListFor.add(f.teamGroup);
    const before = await rows(f.seed.teamId, f.teamGroup);
    const calls: string[] = [];
    // A COUNTING lookup (a throwing one would be defeated by a stray `.catch`): the pin is calls === 0.
    for (const lookup of [
      (async (g: string) => { calls.push(g); return []; }) as EpisodeLookup,
      (async (g: string) => { calls.push(g); return null; }) as EpisodeLookup,
    ]) {
      const res = await reconcileProjectedEpisodes(db(), client(f.fake), f.seed.teamId, { lookup, deepRequeue: true });
      expect(calls, "the lookup must never be called on the unreachable branch").toEqual([]);
      expect(res.unreachableGroups).toBe(1);
      expect(res.saturatedGroups).toBe(0);
      expect(res.deepResolvedGroups).toBe(0);
      expect(res.confirmed, "the external group still confirms; the unreachable team group contributes 0").toBe(1);
      expect(res.reQueued).toBe(0);
      expect(res.deepRequeueHeld).toBe(0);
      expect(res.errors).toEqual([]);
      const after = await rows(f.seed.teamId, f.teamGroup);
      expect(after).toEqual(before); // no uuid backfilled, no sha touched
    }
  });

  it("AC1(c) a MALFORMED listing body throws in the client → counted as unreachable, nothing re-queued (the old tolerant read would have parked every mature row)", async () => {
    const f = await fixture();
    const { GraphitiClient } = await import("@/lib/graph/graphiti-client");
    for (const body of ["{}", "42", '{"episodes":"oops"}', '{"episodes":[{"name":"items:x"}]}']) {
      const strict = new GraphitiClient({
        baseUrl: "http://graphiti.test",
        fetchImpl: (async () => new Response(body, { status: 200 })) as unknown as typeof fetch,
      });
      const res = await reconcileProjectedEpisodes(db(), strict, f.seed.teamId, { lookup: async () => null });
      expect(res.unreachableGroups, body).toBe(2); // both groups' listings malformed
      expect(res.reQueued, body).toBe(0);
      expect((await rows(f.seed.teamId, f.teamGroup)).every((r) => r.content_sha256 !== ""), body).toBe(true);
    }
  });

  it("AC1(d) an EMPTY listing over N mature rows → emptyListingGroups 1; the bounded re-queue proceeds exactly as today: reQueued === min(N, cap)", async () => {
    const f = await fixture(4);
    f.fake.emptyListFor.add(f.teamGroup);
    const res = await reconcileProjectedEpisodes(db(), client(f.fake), f.seed.teamId, { maxRequeuePerPass: 3 });
    expect(res.emptyListingGroups).toBe(1);
    expect(res.reQueued).toBe(3); // min(4, 3)
    expect(res.requeueThrottled).toBe(1);
    // A group whose rows are ALL sentinels (already parked) does not fire it again.
    await db().from("graph_episodes").update({ content_sha256: "" }).eq("team_id", f.seed.teamId).eq("group_id", f.teamGroup);
    const again = await reconcileProjectedEpisodes(db(), client(f.fake), f.seed.teamId);
    expect(again.emptyListingGroups).toBe(0);
  });

  it("AC1(e) cleanup leg: the OLD-group listing throws → unreachableCleanupGroups 1, cleaned 0, pendingCleanups 1, flag intact", async () => {
    const f = await fixture(1);
    const [row] = await rows(f.seed.teamId, f.teamGroup);
    await db().from("graph_episodes").update({ pending_delete_group_id: "old_group", pending_delete_at: "2020-01-01T00:00:00Z" }).eq("team_id", f.seed.teamId).eq("source_id", row.source_id);
    f.fake.failListFor.add("old_group");
    const res = await reconcileProjectedEpisodes(db(), client(f.fake), f.seed.teamId);
    expect(res.unreachableCleanupGroups).toBe(1);
    expect(res.cleaned).toBe(0);
    expect(res.pendingCleanups).toBe(1);
    const { data } = await db().from("graph_episodes").select("pending_delete_group_id").eq("team_id", f.seed.teamId).eq("source_id", row.source_id).single();
    expect((data as { pending_delete_group_id: string }).pending_delete_group_id).toBe("old_group");
  });

  it("AC1(e2) the final pending-count read FAILS → a run error with every other counter retained, ok:false through the runner", async () => {
    const f = await fixture(2);
    const real = db();
    // Fail ONLY the pending-count select (the `.not("pending_delete_group_id", "is", null)` chain).
    const wrapped = {
      from(table: string) {
        const chain = real.from(table);
        if (table !== "graph_episodes") return chain;
        return new Proxy(chain as unknown as Record<string, unknown>, {
          get(target, prop, receiver) {
            if (prop !== "select") return Reflect.get(target, prop, receiver);
            return (...a: unknown[]) => {
              const sel = (target.select as (...x: unknown[]) => Record<string, unknown>)(...a);
              return new Proxy(sel, {
                get(t2, p2, r2) {
                  if (p2 !== "eq") return Reflect.get(t2, p2, r2);
                  return (c: string, v: unknown) => {
                    const eq = (t2.eq as (c: string, v: unknown) => Record<string, unknown>)(c, v);
                    return new Proxy(eq, {
                      get(t3, p3, r3) {
                        if (p3 !== "not") return Reflect.get(t3, p3, r3);
                        return () => ({ then: (res: (v: unknown) => void) => res({ data: null, error: { message: "induced count failure" } }) });
                      },
                    });
                  };
                },
              });
            };
          },
        });
      },
    } as unknown as DbClient;
    // An EXISTING pending row (its old-group listing fails too, so it stays pending) — the count beside
    // the error must be the pass's known value, never a false zero (Codex diff review M1).
    const [pendingRow] = await rows(f.seed.teamId, f.teamGroup);
    await real.from("graph_episodes").update({ pending_delete_group_id: "old_group", pending_delete_at: "2020-01-01T00:00:00Z" }).eq("team_id", f.seed.teamId).eq("source_id", pendingRow.source_id);
    f.fake.failListFor.add("old_group");
    const res = await reconcileProjectedEpisodes(wrapped, client(f.fake), f.seed.teamId);
    expect(res.errors).toEqual(["reconcile: pending-cleanup count failed: induced count failure"]);
    expect(res.pendingCleanups, "the known pending count, not a false zero").toBe(1);
    expect(res.confirmed, "the pass's work is retained").toBe(3);
    const summary = await runGraphProjection({ teamId: f.seed.teamId, client: client(f.fake), db: wrapped });
    expect(summary.ok).toBe(false);
    expect(summary.errors.some((e) => e.endsWith("reconcile: pending-cleanup count failed: induced count failure"))).toBe(true);
    expect(summary.reconciled).toBe(3);
  });

  it("AC1(e3) the LEDGER read fails → a run error, nothing judged, no listing called (it used to read as an empty ledger: groupsChecked 0, ok:true)", async () => {
    const f = await fixture(1);
    const real = db();
    const wrapped = {
      from(table: string) {
        const chain = real.from(table);
        if (table !== "graph_episodes") return chain;
        return new Proxy(chain as unknown as Record<string, unknown>, {
          get(target, prop, receiver) {
            if (prop !== "select") return Reflect.get(target, prop, receiver);
            return (...a: unknown[]) => {
              // Fail RECONCILE's ledger read only (its select starts `id, source_id, source_table, …`) — not the
              // projector's batch read (`source_id, content_sha256, …`) and not the pending count (`id`).
              if (String(a[0]).startsWith("id, source_id, source_table")) {
                const failing = { then: (res: (v: unknown) => void) => res({ data: null, error: { message: "induced ledger failure" } }) };
                return new Proxy(failing, { get: (t, p) => (p === "then" ? t.then : () => new Proxy(failing, { get: (t2, p2) => (p2 === "then" ? t2.then : () => failing) })) });
              }
              return (target.select as (...x: unknown[]) => unknown)(...a);
            };
          },
        });
      },
    } as unknown as DbClient;
    const res = await reconcileProjectedEpisodes(wrapped, client(f.fake), f.seed.teamId);
    expect(res.errors).toEqual(["reconcile: ledger read failed: induced ledger failure"]);
    expect(res.groupsChecked).toBe(0);
    expect(res.confirmed).toBe(0);
    expect(f.fake.listCalls.filter((c) => c.groupId === f.teamGroup)).toHaveLength(0);
    const summary = await runGraphProjection({ teamId: f.seed.teamId, client: client(f.fake), db: wrapped });
    expect(summary.ok).toBe(false);
    expect(summary.errors.some((e) => e.endsWith("reconcile: ledger read failed: induced ledger failure"))).toBe(true);
  });

  it("AC1(f) a listing that SUCCEEDS (small group) is today's REST verdict with every new counter zero", async () => {
    const f = await fixture(2);
    const res = await reconcileProjectedEpisodes(db(), client(f.fake), f.seed.teamId);
    expect(res.confirmed).toBe(3);
    expect(res.unreachableGroups).toBe(0);
    expect(res.unreachableCleanupGroups).toBe(0);
    expect(res.emptyListingGroups).toBe(0);
    expect(res.errors).toEqual([]);
    // And a saturated group still routes to the lookup path (unchanged).
    await f.fake.addEpisodes(f.teamGroup, Array.from({ length: LANDED_SCAN_DEPTH }, (_, i) => ep(`items:filler-${i}`)));
    const sat = await reconcileProjectedEpisodes(db(), client(f.fake), f.seed.teamId, { lookup: async () => null });
    expect(sat.saturatedGroups).toBe(1);
    expect(sat.unreachableGroups).toBe(0);
  });
});
