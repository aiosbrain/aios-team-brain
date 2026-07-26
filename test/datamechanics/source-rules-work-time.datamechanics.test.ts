import { describe, expect, it } from "vitest";
import { db, seedTeam, ingest, type Seed } from "./helpers";

/**
 * Spec: whether a moved work-time counts as WORK is a per-source question (audit M2).
 *
 * Both arms of the fork are real, which is why this needed a rules layer rather than a patch:
 *  • `local` emits the file's **mtime**. A `touch` / `rsync` / `chmod` / checkout moves it with no
 *    content change and no author — letting the unchanged-body heal take it re-dates the item, and a
 *    file nobody has opened in a year resurfaces as **today's work** in the Timeline.
 *  • `linear` / `plane` emit the issue's last **state transition**. A ticket reaching `completed` is
 *    genuine work whose document body is byte-identical — freezing that would make completions
 *    invisible.
 *
 * So "preserve on unchanged body" is correct for one and a bug for the other.
 *
 * Asserted on the persisted **`items.work_at` column** (R1, #395) — the value every surface actually
 * orders and windows by. Checking the frontmatter instead would pass while the column, and therefore
 * the product, still said "today".
 */

const BODY = "# Q3 plan\n\nunchanged between pushes\n";

async function storedWorkTime(seed: Seed, path: string): Promise<string | null> {
  const { data } = await db()
    .from("items")
    .select("work_at")
    .eq("team_id", seed.teamId)
    .eq("path", path)
    .maybeSingle();
  const raw = (data as { work_at?: string | Date | null } | null)?.work_at;
  if (!raw) return null;
  return (raw instanceof Date ? raw : new Date(raw)).toISOString();
}

/** Push the same body twice with a MOVED work-time — the exact unchanged-body re-sync. */
async function pushTwiceWithMovedTime(seed: Seed, source: string, path: string) {
  const first = { source, source_ts: "2025-03-01T09:00:00.000Z" };
  const second = { source, source_ts: "2026-07-26T09:00:00.000Z" };
  await ingest(seed, { path, project: "acme", kind: "deliverable", access: "team", body: BODY, frontmatter: first });
  const res = await ingest(seed, { path, project: "acme", kind: "deliverable", access: "team", body: BODY, frontmatter: second });
  // Pin the premise: the body really is unchanged, so this is the heal path and not a new version.
  expect(res.status).toBe("unchanged");
}

describe("per-source work-time rules (real Postgres)", () => {
  it("local: a touched file keeps its original work-time — mtime is storage, not work", async () => {
    const seed = await seedTeam();
    await pushTwiceWithMovedTime(seed, "local", "docs/plan.md");
    expect(await storedWorkTime(seed, "docs/plan.md")).toBe("2025-03-01T09:00:00.000Z");
  });

  it("linear: a state transition DOES move the work-time on an unchanged body", async () => {
    const seed = await seedTeam();
    await pushTwiceWithMovedTime(seed, "linear", "linear/aio-1.md");
    expect(await storedWorkTime(seed, "linear/aio-1.md")).toBe("2026-07-26T09:00:00.000Z");
  });

  it("plane behaves like linear, and an unclassified source keeps the permissive default", async () => {
    const seed = await seedTeam();
    await pushTwiceWithMovedTime(seed, "plane", "plane/eng-1.md");
    expect(await storedWorkTime(seed, "plane/eng-1.md")).toBe("2026-07-26T09:00:00.000Z");

    // A source with no rule must NOT be frozen: making real work invisible is the worse error, and
    // the completeness guard is what keeps this default from quietly becoming load-bearing.
    await pushTwiceWithMovedTime(seed, "some-future-mcp-connector", "future/thing.md");
    expect(await storedWorkTime(seed, "future/thing.md")).toBe("2026-07-26T09:00:00.000Z");
  });

  it("local: a REAL content change re-dates the item (the freeze is not a permanent stick)", async () => {
    const seed = await seedTeam();
    await pushTwiceWithMovedTime(seed, "local", "docs/live.md");
    await ingest(seed, {
      path: "docs/live.md",
      project: "acme",
      kind: "deliverable",
      access: "team",
      body: `${BODY}\nsomeone actually edited it\n`,
      frontmatter: { source: "local", source_ts: "2026-07-26T09:00:00.000Z" },
    });
    expect(await storedWorkTime(seed, "docs/live.md")).toBe("2026-07-26T09:00:00.000Z");
  });

  it("local: the freeze does not clobber the author heal that shares this path", async () => {
    const seed = await seedTeam();
    await ingest(seed, {
      path: "docs/authored.md",
      project: "acme",
      kind: "deliverable",
      access: "team",
      body: BODY,
      frontmatter: { source: "local", source_ts: "2025-03-01T09:00:00.000Z", authors: [{ name: "Ada" }] },
    });
    // A tick where the connector's author enrichment came back empty AND mtime moved.
    await ingest(seed, {
      path: "docs/authored.md",
      project: "acme",
      kind: "deliverable",
      access: "team",
      body: BODY,
      frontmatter: { source: "local", source_ts: "2026-07-26T09:00:00.000Z" },
    });
    const { data } = await db()
      .from("items")
      .select("frontmatter")
      .eq("team_id", seed.teamId)
      .eq("path", "docs/authored.md")
      .maybeSingle();
    const fm = (data as { frontmatter: Record<string, unknown> }).frontmatter;
    expect(fm.authors).toEqual([{ name: "Ada" }]); // preserved
    expect(fm.source_ts).toBe("2025-03-01T09:00:00.000Z"); // frozen
  });
});
