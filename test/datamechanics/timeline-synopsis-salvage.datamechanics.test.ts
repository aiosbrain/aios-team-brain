import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { db, ingest, seedTeam, type Seed } from "./helpers";
import { getCachedWorkTimeline, PAYLOAD_VERSION, MIN_SALVAGEABLE_VERSION } from "@/lib/dashboard/timeline-cache";

/**
 * Spec: a PAYLOAD_VERSION bump must not blank the daily synopsis.
 *
 * THE OUTCOME THIS REPRODUCES. Summaries are attached only on the BACKGROUND refresh path — the
 * cold-miss path deliberately returns the pure ledger fast, with no LLM. A version bump makes every
 * stored row read as a MISS, so the next viewer gets a summary-less timeline, that summary-less
 * payload is persisted stamped `computed_at = now`, and the synopsis stays gone until a background
 * pass finishes. Twice now the visible symptom has been "we've lost the summaries at the top of each
 * person's day", reported by the user, after a bump I shipped.
 *
 * The rule: a synopsis describes WHAT A PERSON DID ON A DAY. A change to the payload's SHAPE does not
 * make that sentence untrue, so it should be carried across the bump and then replaced by the
 * background pass — not dropped on the floor.
 *
 * Assertions are derived from that rule, not from the implementation:
 *   1. after a bump, the first view still carries the previous row's per-person-day summaries;
 *   2. a summary is matched to ITS OWN person and day, never smeared across people;
 *   3. an ancient row is NOT resurrected — a synopsis has a shelf life;
 *   4. a freshly computed summary always wins over a salvaged one.
 */

async function seedLinkedTeam(): Promise<Seed> {
  const seed = await seedTeam();
  const { data: proj } = await db()
    .from("projects")
    .insert({ team_id: seed.teamId, slug: `p-${randomUUID().slice(0, 6)}`, name: "P" })
    .select("id")
    .single();
  await db().from("tasks").insert({
    team_id: seed.teamId,
    project_id: (proj as { id: string }).id,
    row_key: "SALV-1",
    title: "Carried work",
    status: "in_progress",
    assignee: "Tester",
    origin: "sync",
    audience: "external",
  });
  return seed;
}

async function seedCommit(seed: Seed, title: string, whenIso: string, access: "team" | "external" = "team") {
  return ingest(seed, {
    path: `commits/x/${title}.md`,
    project: "commits",
    kind: "artifact",
    frontmatter: { source: "git", title, committed_at: whenIso, source_url: "https://example.com/c" },
    body: `# ${title} (SALV-1)`,
    access,
  });
}

/** Write a cache row from a PREVIOUS payload version that carries a synopsis for one person-day. */
async function seedPriorRow(args: {
  teamId: string;
  memberId: string;
  date: string;
  summary: string;
  version?: number;
  computedAt?: string;
  tier?: "team" | "external";
}) {
  const payload = {
    // A FOREIGN version that is still SALVAGEABLE. It used to be `PAYLOAD_VERSION - 1`, which broke the
    // moment `MIN_SALVAGEABLE_VERSION` was introduced at the current version: v10 prose is refused on
    // CONTENT grounds (it was written from mislabelled Slack titles), so every fixture here would be
    // rejected by the version gate before reaching the behaviour under test — failing the one carry test
    // and, far worse, silently DISARMING the three that assert an ABSENCE (own-person-day, age, tier),
    // which would have gone green for the wrong reason. `+1` models the real remaining case: a row
    // written by a NEWER build and read after a rollback.
    v: args.version ?? PAYLOAD_VERSION + 1,
    days: [
      {
        date: args.date,
        label: "Today",
        people: [
          {
            memberId: args.memberId,
            name: "Tester",
            handle: "tester",
            summary: args.summary,
            total: 1,
            tasks: [],
            other: [],
            unlinked: 0,
            signals: [],
          },
        ],
      },
    ],
  };
  const { error } = await db().from("work_timeline_cache").upsert(
    {
      team_id: args.teamId,
      group_key: args.tier ?? "team",
      payload: JSON.stringify(payload),
      computed_at: args.computedAt ?? new Date().toISOString(),
    },
    { onConflict: "team_id,group_key" }
  );
  if (error) throw new Error(`prior row seed failed: ${error.message}`);
}

// ONE timestamp for both the commit and the prior row's date. `dayOf` slices the ISO string, so the
// day is UTC — deriving the date from `new Date()` instead put the fixture on the wrong day for eight
// hours a day, which looks exactly like the feature not working.
const WHEN = new Date(Date.now() - 3_600_000).toISOString();
const dayOfWhen = WHEN.slice(0, 10);

type Days = Awaited<ReturnType<typeof getCachedWorkTimeline>>["days"];

function personDay(days: Days, memberId: string) {
  for (const d of days) for (const p of d.people) if (p.memberId === memberId) return p;
  return undefined;
}

/**
 * ARMS every "no summary" assertion below. Each of those is an ABSENCE, and an absence passes just as
 * happily when the person-day isn't rendered at all — a fixture or attribution regression would
 * silently disarm the test rather than fail it. Assert the row EXISTS first, then that it carries no
 * synopsis, so the only variable left is the one under test.
 */
function summaryOfRenderedDay(days: Days, memberId: string): string | undefined {
  const p = personDay(days, memberId);
  expect(p, "the member's person-day must be rendered, or this assertion proves nothing").toBeDefined();
  return p!.summary;
}

describe("the daily synopsis survives a PAYLOAD_VERSION bump (real Postgres)", () => {
  it("carries a foreign version's summary into the first post-bump view", async () => {
    const seed = await seedLinkedTeam();
    await seedCommit(seed, "carried", WHEN);
    await seedPriorRow({
      teamId: seed.teamId,
      memberId: seed.memberId,
      date: dayOfWhen,
      summary: "Shipped the carried work.",
    });

    // Cold miss by version mismatch — exactly what every deploy that bumps the version produces.
    const { days } = await getCachedWorkTimeline(db(), seed.teamId, "team");
    expect(summaryOfRenderedDay(days, seed.memberId)).toBe("Shipped the carried work.");
  });

  it("REFUSES prose written before the content floor, even though it would bridge a bump", async () => {
    // The other half of the same contract, and the reason the default fixture version had to move. A
    // pre-`MIN_SALVAGEABLE_VERSION` payload is not merely a different shape: its sentences were written
    // from prompts in which a Slack replier carried the thread ROOT author's words, so carrying one
    // forward would re-persist that misattribution as prose in the new row. Blank beats wrong.
    const seed = await seedLinkedTeam();
    await seedCommit(seed, "carried", WHEN);
    await seedPriorRow({
      teamId: seed.teamId,
      memberId: seed.memberId,
      date: dayOfWhen,
      summary: "Shared two sizzle reels.", // the shape of the misattributed claim
      version: MIN_SALVAGEABLE_VERSION - 1,
    });

    const { days } = await getCachedWorkTimeline(db(), seed.teamId, "team");
    expect(summaryOfRenderedDay(days, seed.memberId)).toBeUndefined();
  });

  it("matches a summary to ITS OWN person-day, never another's", async () => {
    const seed = await seedLinkedTeam();
    await seedCommit(seed, "carried", WHEN);
    // A summary stored against a DIFFERENT member on the same day must not land on ours.
    await seedPriorRow({
      teamId: seed.teamId,
      memberId: randomUUID(),
      date: dayOfWhen,
      summary: "Someone else's day.",
    });

    const { days } = await getCachedWorkTimeline(db(), seed.teamId, "team");
    expect(summaryOfRenderedDay(days, seed.memberId)).toBeUndefined();
  });

  it("does NOT resurrect an ancient synopsis", async () => {
    // A shelf life, because a salvaged sentence is only defensible as a bridge to the next refresh.
    const seed = await seedLinkedTeam();
    await seedCommit(seed, "carried", WHEN);
    await seedPriorRow({
      teamId: seed.teamId,
      memberId: seed.memberId,
      date: dayOfWhen,
      summary: "Stale from last week.",
      computedAt: new Date(Date.now() - 8 * 24 * 3600_000).toISOString(),
    });

    const { days } = await getCachedWorkTimeline(db(), seed.teamId, "team");
    expect(summaryOfRenderedDay(days, seed.memberId)).toBeUndefined();
  });

  it("TIER: an external viewer never receives a summary written for the TEAM tier", async () => {
    // The sharpest risk in this change. `work_timeline_cache` is keyed by tier because the synopsis is
    // LLM TEXT generated from the tier-filtered set — a team-tier sentence describes work an external
    // viewer may not see. The salvage read is the newest path that touches those rows, and nothing
    // else pins its scoping: reading the "team" row here instead of the viewer's own survives the
    // whole suite. Tier isolation is app-code only; there is no RLS backstop.
    const seed = await seedLinkedTeam();
    await seedCommit(seed, "external-work", WHEN, "external");
    await seedPriorRow({
      teamId: seed.teamId,
      memberId: seed.memberId,
      date: dayOfWhen,
      summary: "Team-tier sentence about work an external viewer must not learn about.",
      tier: "team",
    });

    const { days } = await getCachedWorkTimeline(db(), seed.teamId, "external");
    expect(summaryOfRenderedDay(days, seed.memberId)).toBeUndefined();
  });
});
