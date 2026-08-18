import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { db, ingest, seedTeam, type Seed } from "./helpers";
import { backfillMeetingNotesFromItems } from "@/lib/meetings/from-items";
import { getWorkTimeline } from "@/lib/dashboard/work-timeline";

/**
 * Spec (MTGATT-2 §1, real Postgres): a calendar invitee who DECLINED must not become an attendee —
 * and every other invitee must still be credited exactly as before.
 *
 * This tier, because the failure is a WRONG ROW in `meeting_note_attendees` and a wrong card on the
 * timeline, not a wrong return value. `attendingAttendees` being right proves nothing about what the
 * backfill wrote.
 *
 * BOTH HALVES ARE PINNED HERE ON PURPOSE. The shipped contract — a shared event credits every member
 * attendee, so a meeting Bob only attended is still a record of Bob's work — is deliberate and
 * survives this change untouched. A filter that dropped `needsAction` as well would satisfy the
 * decline test alone; only the survival test catches it.
 */

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

async function pushCalendarEvent(seed: Seed, opts: { title: string; attendees: unknown }) {
  return ingest(seed, {
    path: `1-inbox/calendar/${randomUUID().slice(0, 8)}.md`,
    project: "calendar",
    kind: "artifact",
    frontmatter: { source: "calendar", title: opts.title, occurred_at: today(), attendees: opts.attendees },
    body: "",
    access: "team",
  });
}

/** The attendee member ids actually persisted for this team's single live note. */
async function attendeeIds(seed: Seed): Promise<string[]> {
  const { data: notes } = await db().from("meeting_notes").select("id").eq("team_id", seed.teamId).is("merged_into", null);
  const ids = ((notes ?? []) as { id: string }[]).map((n) => n.id);
  const { data: rows } = await db().from("meeting_note_attendees").select("member_id").in("meeting_note_id", ids);
  return ((rows ?? []) as { member_id: string }[]).map((r) => r.member_id).sort();
}

function meetingsFor(days: Awaited<ReturnType<typeof getWorkTimeline>>, memberId: string) {
  return days
    .flatMap((d) => d.people)
    .filter((p) => p.memberId === memberId)
    .flatMap((p) => p.other)
    .filter((g) => g.source === "meetings")
    .flatMap((g) => g.items);
}

describe("calendar RSVP: a declined invitee is not an attendee (real Postgres)", () => {
  it("writes NO attendee row for the person who declined, and keeps the others", async () => {
    const seed = await seedTeam();
    const goingEmail = `going-${randomUUID().slice(0, 6)}@acme.com`;
    const declinedEmail = `nope-${randomUUID().slice(0, 6)}@acme.com`;
    const going = await addMember(seed, "Going", goingEmail);
    const declined = await addMember(seed, "Declined", declinedEmail);

    const summary = await pushEventAndBackfill(seed, [
      { email: goingEmail, responseStatus: "accepted" },
      { email: declinedEmail, responseStatus: "declined" },
    ]);

    expect(summary.created).toBe(1);
    const ids = await attendeeIds(seed);
    expect(ids, "the accepted invitee is recorded").toContain(going);
    // The inverse, asserted directly: it is not enough that the right row exists. MTGATT-1's review
    // found a criterion whose missing half hid a leak — "survivors keep their content" with no
    // assertion that the removed one's is gone.
    expect(ids, "the declined invitee must have NO attendance row").not.toContain(declined);
  });

  it("the declined person gets no meeting on their timeline card either", async () => {
    const seed = await seedTeam();
    const declinedEmail = `nope-${randomUUID().slice(0, 6)}@acme.com`;
    const bobEmail = `bob-${randomUUID().slice(0, 6)}@acme.com`;
    const declined = await addMember(seed, "Declined", declinedEmail);
    const bob = await addMember(seed, "Bob", bobEmail);

    await pushEventAndBackfill(seed, [
      { email: bobEmail },
      { email: declinedEmail, responseStatus: "declined" },
    ]);

    const days = await getWorkTimeline(db(), seed.teamId, "team");
    expect(meetingsFor(days, bob), "an invitee with no RSVP is still credited").toHaveLength(1);
    expect(meetingsFor(days, declined), "declining a meeting is not doing it").toHaveLength(0);
  });

  it("keeps EVERY non-declined invitee — tentative, needsAction and no RSVP at all", async () => {
    // The shipped contract, re-asserted against this change. If the filter ever widens beyond
    // `declined`, this is what reddens.
    const seed = await seedTeam();
    const emails = ["t", "n", "m"].map((p) => `${p}-${randomUUID().slice(0, 6)}@acme.com`);
    const ids = [
      await addMember(seed, "Tentative", emails[0]),
      await addMember(seed, "NeedsAction", emails[1]),
      await addMember(seed, "Missing", emails[2]),
    ];

    await pushEventAndBackfill(seed, [
      { email: emails[0], responseStatus: "tentative" },
      { email: emails[1], responseStatus: "needsAction" },
      { email: emails[2] },
    ]);

    expect(await attendeeIds(seed)).toEqual([...ids].sort());
  });

  it("counts what it removed, so the drop is visible and not a silent parser failure", async () => {
    const seed = await seedTeam();
    const a = `a-${randomUUID().slice(0, 6)}@acme.com`;
    const b = `b-${randomUUID().slice(0, 6)}@acme.com`;
    await addMember(seed, "A", a);
    await addMember(seed, "B", b);

    const summary = await pushEventAndBackfill(seed, [
      { email: a, responseStatus: "declined" },
      { email: b, responseStatus: "declined" },
      // A non-member decline counts too: the number is "invitees the RSVP rule removed", not
      // "members it removed" — otherwise a producer sending garbage RSVPs to outsiders reads as zero.
      { email: `outsider-${randomUUID().slice(0, 6)}@other.com`, responseStatus: "declined" },
    ]);
    expect(summary.calendarDeclined).toBe(3);
  });

  it("an event where EVERYONE declined produces a note with no attendees, not a model fallback", async () => {
    const seed = await seedTeam();
    const a = `a-${randomUUID().slice(0, 6)}@acme.com`;
    await addMember(seed, "A", a);

    const summary = await pushEventAndBackfill(seed, [{ email: a, responseStatus: "declined" }]);
    expect(summary.created).toBe(1);
    // An empty calendar answer is an answer — the note exists with nobody on it.
    //
    // HONEST LIMIT: this does NOT prove the no-fallthrough rule. On the calendar path the model is
    // never consulted at all (`from-items.ts` hands rank 3 a hardcoded empty list), so a
    // fall-through would produce this same zero. The rule itself lives in `attendance.ts` and is
    // pinned where it can actually fail — `test/meetings-attendance-source.test.ts`, which asserts
    // the llm callback is not invoked.
    expect(await attendeeIds(seed)).toEqual([]);
  });
});

/** Push one event and run the backfill that turns it into a note. */
async function pushEventAndBackfill(seed: Seed, attendees: unknown[]) {
  await pushCalendarEvent(seed, { title: "Design review", attendees });
  return backfillMeetingNotesFromItems(db(), seed.teamId);
}
