import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { getWorkTimeline } from "@/lib/dashboard/work-timeline";
import { db, ingest, seedTeam } from "./helpers";

describe("TMP: slack thread rooted before the window with an in-window reply", () => {
  it("still surfaces the in-window participant contribution", async () => {
    const seed = await seedTeam();
    await db()
      .from("member_identities")
      .insert({ team_id: seed.teamId, member_id: seed.memberId, provider: "slack", external_id: "U_REPLIER" });
    const rootTs = new Date(Date.now() - 10 * 86_400_000).toISOString(); // thread started 10d ago
    const replyTs = new Date(Date.now() - 1 * 86_400_000).toISOString(); // reply yesterday
    await ingest(seed, {
      kind: "transcript", path: `slack/eng/${randomUUID()}.md`, access: "team", body: "old thread, fresh reply",
      frontmatter: {
        source: "slack", channel: "eng", title: "#eng: long-running incident thread",
        source_ts: rootTs,
        participants: [
          { author_id: "U_REPLIER", display_name: "Tester", message_count: 3, first_ts: rootTs, last_ts: replyTs },
        ],
      },
    });
    const days = await getWorkTimeline(db(), seed.teamId, "team");
    const titles = days.flatMap((d) => d.people.flatMap((p) => p.other.flatMap((sg) => sg.items.map((i) => i.title))));
    expect(titles).toContain("#eng: long-running incident thread");
  });
});
