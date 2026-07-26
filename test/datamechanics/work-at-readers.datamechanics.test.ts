import { describe, expect, it } from "vitest";
import { getWorkTimeline, ITEM_LIMIT } from "@/lib/dashboard/work-timeline";
import { retrieve } from "@/lib/query/retrieve";
import { db, ingest, seedTeam } from "./helpers";

/**
 * Spec (Pass-1 review, Wave 2): the READERS move onto the persisted work-time.
 *
 * #395 wrote `items.work_at` down; every surface still windowed and ordered by `synced_at`, which each
 * re-sync tick bumps. Two consequences this pins:
 *
 *  • H5 — the timeline's "last 7 days" fetch was `synced_at >= since ORDER BY synced_at LIMIT 2000`.
 *    After one tick the whole corpus is inside that window, so the query really returns "the 2000 most
 *    recently PUSHED rows", with ties broken by query plan. In-window work drops out silently, and
 *    differently on each rebuild.
 *  • M3 — the retrieval recency leg ("a fallback so fresh content always has a shot") ordered by
 *    `synced_at`, so a re-scan of an old corpus makes months-old documents the "latest" ones — on the
 *    path that grounds LLM answers.
 */

/** Every evidence title in the ledger — nested under a task, or in the task-less "other" bucket. */
function evidenceTitles(days: Awaited<ReturnType<typeof getWorkTimeline>>): string[] {
  return days.flatMap((d) =>
    d.people.flatMap((p) => [
      ...p.tasks.flatMap((t) => t.sources.flatMap((sg) => sg.items.map((i) => i.title))),
      ...p.other.flatMap((sg) => sg.items.map((i) => i.title)),
    ])
  );
}

/** Push an item whose work happened `daysAgo`, and which is re-synced NOW (the shape that breaks). */
async function itemWorkedDaysAgo(
  seed: Awaited<ReturnType<typeof seedTeam>>,
  path: string,
  daysAgo: number,
  over: { kind?: "deliverable" | "artifact"; body?: string; source?: string } = {}
) {
  const at = new Date(Date.now() - daysAgo * 86_400_000).toISOString();
  return ingest(seed, {
    kind: over.kind ?? "deliverable",
    path,
    body: over.body ?? `work from ${daysAgo} days ago`,
    access: "team",
    frontmatter: { title: path, source_ts: at, ...(over.source ? { source: over.source } : {}) },
  });
}

describe("the timeline windows on work_at, not sync time (real Postgres)", () => {
  it("keeps in-window work that was pushed long ago, and excludes old work re-synced today", async () => {
    const seed = await seedTeam();
    await itemWorkedDaysAgo(seed, "docs/recent.md", 2);
    await itemWorkedDaysAgo(seed, "docs/ancient.md", 120);
    // Both rows are re-synced NOW, exactly as every 30-minute tick does.
    await db().from("items").update({ synced_at: new Date().toISOString() }).eq("team_id", seed.teamId);

    const titles = evidenceTitles(await getWorkTimeline(db(), seed.teamId, "team"));

    expect(titles).toContain("docs/recent.md");
    // The point: a shared `synced_at` says these two are equally "recent". Their work times don't.
    expect(titles).not.toContain("docs/ancient.md");
  });

  it("survives the row cap BITING: a flood of re-synced old items can't evict in-window work (H5)", async () => {
    // H5's actual failure, which only appears once the cap is reached. The fetch was
    // `synced_at >= since ORDER BY synced_at DESC LIMIT n` — but after one sync tick EVERY row is inside
    // a `synced_at` window, so the query really returns "the n most recently PUSHED rows". A re-scan of
    // an old corpus therefore fills the whole page with out-of-window documents and the week's real work
    // never gets fetched at all — silently, and differently on each rebuild (no secondary sort).
    //
    // Ordering and filtering by `work_at` makes the cap bite only on genuinely in-window work.
    const seed = await seedTeam();
    await itemWorkedDaysAgo(seed, "docs/real-work.md", 1);
    for (let i = 0; i < ITEM_LIMIT + 5; i++) await itemWorkedDaysAgo(seed, `docs/old-${i}.md`, 200 + i);
    // The re-scan: every OLD doc is pushed again now, i.e. newer than the real work's push.
    await db()
      .from("items")
      .update({ synced_at: new Date().toISOString() })
      .eq("team_id", seed.teamId)
      .neq("path", "docs/real-work.md");

    const titles = evidenceTitles(await getWorkTimeline(db(), seed.teamId, "team"));
    expect(titles).toContain("docs/real-work.md");
    expect(titles.filter((t) => t.startsWith("docs/old-"))).toHaveLength(0);
  });

  it("still drops an item the source never dated (unchanged rule, now enforced in SQL)", async () => {
    const seed = await seedTeam();
    await ingest(seed, {
      kind: "deliverable",
      path: "docs/undated.md",
      body: "no work time anywhere",
      access: "team",
      frontmatter: { title: "docs/undated.md" },
    });

    const titles = evidenceTitles(await getWorkTimeline(db(), seed.teamId, "team"));
    expect(titles).not.toContain("docs/undated.md");
  });
});

describe("retrieval recency reads work_at (real Postgres)", () => {
  it("treats the most recently WORKED item as latest, not the most recently re-synced one", async () => {
    // M3, on the path that grounds LLM answers. `retrieveContext`'s recency leg exists so fresh content
    // always has a shot; ordered by `synced_at` it surfaces whatever a re-scan touched last.
    const seed = await seedTeam();
    await itemWorkedDaysAgo(seed, "docs/fresh.md", 1, { body: "quarterly planning notes, current" });
    await itemWorkedDaysAgo(seed, "docs/stale.md", 300, { body: "quarterly planning notes, ancient" });
    // The re-scan pushes the OLD doc last, making it the most recently synced row.
    await db()
      .from("items")
      .update({ synced_at: new Date(Date.now() + 60_000).toISOString() })
      .eq("team_id", seed.teamId)
      .eq("path", "docs/stale.md");

    // A question with no keyword overlap, so the recency leg is what answers it.
    const ctx = await retrieve(db(), seed.teamId, "team", "what is the latest");
    const blob = JSON.stringify(ctx);
    const freshAt = blob.indexOf("docs/fresh.md");
    const staleAt = blob.indexOf("docs/stale.md");
    expect(freshAt).toBeGreaterThanOrEqual(0);
    // Ordered by work-time, the genuinely recent doc leads.
    if (staleAt >= 0) expect(freshAt).toBeLessThan(staleAt);
  });
});
