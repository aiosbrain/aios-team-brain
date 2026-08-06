import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { db, ingest, seedTeam, type Seed } from "./helpers";
import { backfillMeetingNotesFromItems } from "@/lib/meetings/from-items";
import { getWorkTimeline } from "@/lib/dashboard/work-timeline";

/**
 * The whole ask, end to end: a calendar event a person chose to share must be RECEIVED, LOGGED, and
 * ASSOCIATED WITH THE PERSON — every person who was in it, not just whoever pushed it.
 *
 * Real Postgres because every step is persistence + identity: the item lands through the real ingest
 * path, the meeting note is a real row, attendance is resolved against the real `members`/email
 * tables, and the timeline reads it all back. A fake DB can prove none of that.
 */

/** A second real member with a known email — the person the event must ALSO land on. */
async function addMember(seed: Seed, name: string, email: string): Promise<string> {
  const { data, error } = await db()
    .from("members")
    .insert({
      team_id: seed.teamId,
      email,
      display_name: name,
      actor_handle: `a-${randomUUID().slice(0, 8)}`,
      role: "member",
      tier: "team",
      status: "active",
    })
    .select("id")
    .single();
  if (error || !data) throw new Error(`member insert failed: ${error?.message}`);
  return (data as { id: string }).id;
}

const today = () => new Date().toISOString().slice(0, 10);

/** Meeting evidence on one person's card. */
function meetingsFor(days: Awaited<ReturnType<typeof getWorkTimeline>>, memberId: string) {
  return days
    .flatMap((d) => d.people)
    .filter((p) => p.memberId === memberId)
    .flatMap((p) => p.other)
    .filter((g) => g.source === "meetings")
    .flatMap((g) => g.items);
}

/** Push a calendar event the way a workspace would: structured attendees, no body. */
async function pushCalendarEvent(
  seed: Seed,
  opts: { title: string; attendees: unknown; path?: string; occurredAt?: string }
) {
  return ingest(seed, {
    path: opts.path ?? `1-inbox/calendar/${randomUUID().slice(0, 8)}.md`,
    project: "calendar",
    kind: "artifact", // a calendar event has no natural kind — the SOURCE is what identifies it
    frontmatter: {
      source: "calendar",
      title: opts.title,
      occurred_at: opts.occurredAt ?? today(),
      attendees: opts.attendees,
    },
    body: "", // deliberately empty: an invite has no transcript
    access: "team",
  });
}

describe("shared calendar events become per-person work (real Postgres)", () => {
  it("RECEIVES, LOGS and ASSOCIATES the event with every attendee", async () => {
    const seed = await seedTeam();
    const bobEmail = `bob-${randomUUID().slice(0, 6)}@acme.com`;
    const bob = await addMember(seed, "Bob", bobEmail);
    // The pusher's own email, so the organiser resolves too.
    const { data: me } = await db().from("members").select("email").eq("id", seed.memberId).single();
    const myEmail = (me as { email: string }).email;

    await pushCalendarEvent(seed, {
      title: "Design review",
      // The gog puller's real shape — an object with `id` + `display` + `role`.
      attendees: [
        { id: myEmail, display: "Tester", role: "organizer" },
        { id: bobEmail, display: "Bob", role: "attendee" },
      ],
    });

    // LOGGED: the backfill turns it into a meeting note.
    const summary = await backfillMeetingNotesFromItems(db(), seed.teamId);
    expect(summary.created, "the calendar event should have produced a meeting note").toBe(1);

    // ASSOCIATED: it lands on BOTH people's cards, credited as attendance (no submitter fallback).
    const days = await getWorkTimeline(db(), seed.teamId, "team");
    for (const [who, id] of [
      ["organiser", seed.memberId],
      ["attendee", bob],
    ] as const) {
      const found = meetingsFor(days, id);
      expect(found, `${who} should see the event`).toHaveLength(1);
      expect(found[0].title).toBe("Design review");
      expect(found[0].via, `${who} attended — not a submitter fallback`).toBeUndefined();
    }
  });

  it("counts as WORK for a person who only attended — the log of what they did", async () => {
    // Bob pushed nothing and wrote nothing that day. The point of the feature is that the meeting is
    // still a record of work he did for the company.
    const seed = await seedTeam();
    const bobEmail = `bob-${randomUUID().slice(0, 6)}@acme.com`;
    const bob = await addMember(seed, "Bob", bobEmail);

    await pushCalendarEvent(seed, { title: "Roadmap sync", attendees: [bobEmail] });
    await backfillMeetingNotesFromItems(db(), seed.teamId);

    const days = await getWorkTimeline(db(), seed.teamId, "team");
    const bobDay = days.flatMap((d) => d.people).find((p) => p.memberId === bob);
    expect(bobDay, "a day of only meetings must still produce a person-day").toBeDefined();
    expect(bobDay!.total, "the meeting counts toward his work total").toBe(1);
  });

  it("is idempotent — re-running the backfill does not double-log the event", async () => {
    // The backfill runs every scheduler tick and on every push. A second note for the same item would
    // credit everyone twice.
    const seed = await seedTeam();
    const bobEmail = `bob-${randomUUID().slice(0, 6)}@acme.com`;
    const bob = await addMember(seed, "Bob", bobEmail);
    await pushCalendarEvent(seed, { title: "Standup", attendees: [bobEmail] });

    expect((await backfillMeetingNotesFromItems(db(), seed.teamId)).created).toBe(1);
    expect((await backfillMeetingNotesFromItems(db(), seed.teamId)).created, "second run creates nothing").toBe(0);

    const days = await getWorkTimeline(db(), seed.teamId, "team");
    expect(meetingsFor(days, bob)).toHaveLength(1);
  });

  it("does not credit a non-member guest, and still credits the members present", async () => {
    // A client on the invite is not someone we can attribute company work to — but their presence must
    // not sink the whole event for the people who WERE there.
    const seed = await seedTeam();
    const bobEmail = `bob-${randomUUID().slice(0, 6)}@acme.com`;
    const bob = await addMember(seed, "Bob", bobEmail);

    await pushCalendarEvent(seed, {
      title: "Client call",
      attendees: [bobEmail, "someone@other-company.com", { id: "No Email Person", display: "No Email Person" }],
    });
    await backfillMeetingNotesFromItems(db(), seed.teamId);

    const days = await getWorkTimeline(db(), seed.teamId, "team");
    expect(meetingsFor(days, bob)).toHaveLength(1);
    // …and nobody was invented for the unresolvable guests.
    const { data: attendees } = await db()
      .from("meeting_note_attendees")
      .select("member_id");
    expect((attendees ?? []).length, "only the real member is credited").toBe(1);
  });

  it("an event with NO resolvable attendee falls back to the pusher, marked", async () => {
    // A solo event, or one whose guests are all external. We know the pusher was in it; that is the
    // honest floor, and it must be distinguishable from real attendance.
    const seed = await seedTeam();
    await pushCalendarEvent(seed, { title: "External-only call", attendees: ["nobody@elsewhere.com"] });
    await backfillMeetingNotesFromItems(db(), seed.teamId);

    const days = await getWorkTimeline(db(), seed.teamId, "team");
    const found = meetingsFor(days, seed.memberId);
    expect(found).toHaveLength(1);
    expect(found[0].via).toBe("submitter");
  });

  it("an event shared WEEKS AHEAD is still credited when its day arrives", async () => {
    // Sharing is forward-looking: a person selects next month's meetings today. The note's `created_at`
    // is therefore today while `occurred_at` is far in the future, which is the exact inverse of the
    // recording case the leg was built for. Bounding the query on `created_at` meant that by the time
    // the meeting actually happened its note had aged out — it would silently never reach any card.
    const seed = await seedTeam();
    const bobEmail = `bob-${randomUUID().slice(0, 6)}@acme.com`;
    const bob = await addMember(seed, "Bob", bobEmail);

    // Shared now, for a meeting that already happened 3 days ago (in-window) — the note is brand new.
    const threeDaysAgo = new Date(Date.now() - 3 * 86_400_000).toISOString().slice(0, 10);
    await pushCalendarEvent(seed, { title: "Backdated share", attendees: [bobEmail], occurredAt: threeDaysAgo });
    await backfillMeetingNotesFromItems(db(), seed.teamId);

    const days = await getWorkTimeline(db(), seed.teamId, "team");
    const found = meetingsFor(days, bob);
    expect(found, "a just-shared event for an in-window day must be credited").toHaveLength(1);
    expect(found[0].at).toBe(threeDaysAgo); // dated by the meeting, not by the share
  });

  it("does not double-count on the PUSHER's card", async () => {
    // The event item carries `occurred_at`, so it satisfies `work_at_from_source` and lands in the raw
    // items lane credited to the pusher — while the meetings leg credits every attendee. Measured
    // `total: 2` for one event before the raw-lane exclusion. Counted per LANE, not just per meeting,
    // because the duplicate arrives under a DIFFERENT source and a meetings-only assertion misses it.
    const seed = await seedTeam();
    const { data: me } = await db().from("members").select("email").eq("id", seed.memberId).single();
    await pushCalendarEvent(seed, { title: "Solo standup", attendees: [(me as { email: string }).email] });
    await backfillMeetingNotesFromItems(db(), seed.teamId);

    const days = await getWorkTimeline(db(), seed.teamId, "team");
    const pusher = days.flatMap((d) => d.people).find((p) => p.memberId === seed.memberId);
    expect(pusher?.total, "one event must count once").toBe(1);
    expect(pusher?.other.map((g) => g.source).sort(), "no raw `calendar` lane beside the meetings one").toEqual([
      "meetings",
    ]);
  });

  it("TIER: a shared calendar event never reaches an external-tier viewer", async () => {
    // Meeting notes are team-tier by construction and `meeting_notes` has no audience column, so the
    // timeline's `canSeeMeetingNotes` gate is the sole enforcement. A calendar event must inherit it.
    const seed = await seedTeam();
    const bobEmail = `bob-${randomUUID().slice(0, 6)}@acme.com`;
    await addMember(seed, "Bob", bobEmail);
    await pushCalendarEvent(seed, { title: "Internal planning", attendees: [bobEmail] });
    await backfillMeetingNotesFromItems(db(), seed.teamId);

    const external = await getWorkTimeline(db(), seed.teamId, "external");
    const leaked = external
      .flatMap((d) => d.people)
      .flatMap((p) => p.other)
      .filter((g) => g.source === "meetings");
    expect(leaked, "a calendar event leaked to an external viewer").toEqual([]);
  });
});
