import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { db, ingest, seedTeam } from "./helpers";
import { setMemberIdentity } from "@/lib/identity/member-identities";

describe("AIO-1167 Drive Timeline pagination (real Postgres)", () => {
  it("does not let the generic item cap, other sources, or timestamp ties hide older Drive evidence", async () => {
    // The data-mechanics config lowers this production backstop to keep saturation tests cheap.
    const { getWorkTimeline, ITEM_LIMIT } = await import("@/lib/dashboard/work-timeline");
    const seed = await seedTeam();
    await setMemberIdentity(db(), seed.teamId, seed.memberId, {
      provider: "gdrive", externalId: "permission:timeline-person",
    });
    const at = new Date(Date.now() - 86_400_000).toISOString();
    const visible = new Set<string>();
    const driveCount = ITEM_LIMIT + 5;
    for (let index = 0; index < driveCount; index++) {
      const item = await ingest(seed, {
        project: "drive-timeline",
        path: `gdrive/page-${index}-${randomUUID()}.md`,
        access: "team",
        body: `Drive body ${index}`,
        frontmatter: {
          source: "gdrive",
          source_id: `timeline-doc-${index}`,
          source_url: `https://docs.google.com/document/d/timeline-doc-${index}/edit`,
          title: `Drive evidence ${index}`,
          source_ts: at,
          authors: [{ provider: "gdrive", external_id: "permission:timeline-person", role: "editor" }],
          contributions: [{ external_id: "permission:timeline-person", role: "editor", at }],
        },
      });
      visible.add(item.id);
    }
    // These rows share/newer timestamps and consume the generic leg's tiny limit. Drive evidence is
    // read from its independent required ledger, so all five Drive rows must still survive.
    for (let index = 0; index < ITEM_LIMIT + 2; index++) {
      const item = await ingest(seed, {
        project: "other-timeline",
        path: `notion/noise-${index}-${randomUUID()}.md`,
        access: "team",
        body: `Other body ${index}`,
        frontmatter: {
          source: "notion", title: `Other evidence ${index}`,
          source_ts: new Date(Date.parse(at) + 60_000).toISOString(),
        },
      });
      visible.add(item.id);
    }

    const days = await getWorkTimeline(db(), seed.teamId, "team", undefined, {
      visibleItemIds: visible,
    });
    const driveGroups = days.flatMap((day) => day.people)
      .flatMap((person) => [
        ...person.tasks.flatMap((task) => task.sources),
        ...person.other,
      ])
      .filter((source) => source.source === "gdrive");
    expect(driveGroups).toHaveLength(1);
    // The required ledger query crossed its page boundary and counted every row. The existing
    // SourceGroup payload deliberately caps rendered rows, but `count > items.length` is explicit
    // incompleteness and the UI renders "+N more" rather than silently claiming the page is complete.
    expect(driveGroups[0].count).toBe(driveCount);
    expect(driveGroups[0].items).toHaveLength(6);
    expect(new Set(driveGroups[0].items.map((item) => item.title)).size).toBe(6);
  });
});
