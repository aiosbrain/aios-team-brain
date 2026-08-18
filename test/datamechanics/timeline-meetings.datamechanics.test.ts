import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { db, seedTeam, viewFor, type Seed } from "./helpers";
import { createMeetingNote } from "@/lib/meetings/notes";
import { getWorkTimeline } from "@/lib/dashboard/work-timeline";

/**
 * Spec: `docs/specs/meeting-participation-as-work-v1.md` — the persistence + access half.
 *
 * The behaviour that makes this feature worth building is the FAN-OUT: one meeting, N people. On prod
 * every transcript resolves to the single member who runs `aios push`, so "1-1 with Chetan" —
 * attended by John AND Chetan — is credited to John alone and Chetan's card shows nothing for a
 * meeting he was in. That cannot be tested with a fake DB: it is a join across `meeting_notes`,
 * `meeting_note_attendees` and `members`, plus a tier gate with no RLS backstop behind it.
 */

/** A second active member on the same team — the attendee who did NOT push. */
async function addMember(seed: Seed, name: string): Promise<string> {
  const { data, error } = await db()
    .from("members")
    .insert({
      team_id: seed.teamId,
      email: `${randomUUID()}@test.local`,
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

/** Every meeting evidence item on one person's card, across the whole window. */
function meetingsFor(days: Awaited<ReturnType<typeof getWorkTimeline>>, memberId: string) {
  const out: { id: string; title: string; at: string; via?: string }[] = [];
  for (const d of days) {
    for (const p of d.people) {
      if (p.memberId !== memberId) continue;
      for (const g of p.other) {
        if (g.source !== "meetings") continue;
        for (const it of g.items) out.push({ id: it.id, title: it.title, at: it.at, via: it.via });
      }
    }
  }
  return out;
}

describe("meetings on the timeline, per attendee (real Postgres)", () => {
  it("credits EVERY attendee — not just whoever pushed it", async () => {
    // The prod bug, reproduced: a 1-1 pushed by one person, attended by two.
    const seed = await seedTeam();
    const other = await addMember(seed, "Chetan");
    await createMeetingNote(db(), seed.teamId, {
      title: "1-1 with Chetan RE: AIOS next steps",
      rawText: "we talked about the next steps",
      submittedByMemberId: seed.memberId,
      occurredAt: today(),
      attendeeMemberIds: [seed.memberId, other],
    });

    const days = await getWorkTimeline(db(), seed.teamId, "team", undefined, await viewFor(seed));

    const pusher = meetingsFor(days, seed.memberId);
    const attendee = meetingsFor(days, other);
    expect(pusher).toHaveLength(1);
    expect(attendee, "the attendee who did not push must still get credit").toHaveLength(1);
    expect(attendee[0].title).toBe("1-1 with Chetan RE: AIOS next steps");
    // Real attendance, so no fallback marker on either.
    expect(pusher[0].via).toBeUndefined();
    expect(attendee[0].via).toBeUndefined();
    // …and it is WORK: it reaches `total`, which is what "count meetings as work" means.
    const person = days.flatMap((d) => d.people).find((p) => p.memberId === other);
    expect(person?.total).toBe(1);
  });

  it("shows the meeting exactly ONCE per person — the transcript item stays excluded", async () => {
    // `createMeetingNote` also writes a `kind='transcript'` item. If that were admitted as evidence
    // too, the meeting would appear twice — once credited to the pusher, once per attendee.
    const seed = await seedTeam();
    const other = await addMember(seed, "Chetan");
    await createMeetingNote(db(), seed.teamId, {
      title: "Only once please",
      rawText: "body",
      submittedByMemberId: seed.memberId,
      occurredAt: today(),
      attendeeMemberIds: [seed.memberId, other],
    });

    const days = await getWorkTimeline(db(), seed.teamId, "team", undefined, await viewFor(seed));
    expect(meetingsFor(days, seed.memberId)).toHaveLength(1);
    // …and no OTHER lane picked the transcript up under a different source.
    const pusherDay = days.flatMap((d) => d.people).find((p) => p.memberId === seed.memberId);
    expect(pusherDay?.total).toBe(1);
  });

  it("TIER: an external viewer's ledger contains no meeting evidence at all", async () => {
    // Sole enforcement — `meeting_notes` has no access/audience column, so no visibility helper can
    // gate it. Mutation-checked by deleting the `canSeeMeetingNotes` call.
    const seed = await seedTeam();
    await createMeetingNote(db(), seed.teamId, {
      title: "Internal-only meeting",
      rawText: "body",
      submittedByMemberId: seed.memberId,
      occurredAt: today(),
      attendeeMemberIds: [seed.memberId],
    });

    const teamDays = await getWorkTimeline(db(), seed.teamId, "team", undefined, await viewFor(seed));
    expect(meetingsFor(teamDays, seed.memberId), "control: team tier DOES see it").toHaveLength(1);

    const externalDays = await getWorkTimeline(db(), seed.teamId, "external", undefined, await viewFor(seed, "external"));
    const leaked = externalDays
      .flatMap((d) => d.people)
      .flatMap((p) => p.other)
      .filter((g) => g.source === "meetings");
    expect(leaked, "meeting evidence leaked to an external-tier viewer").toEqual([]);
  });

  it("falls back to the SUBMITTER when no attendee resolved, and marks it", async () => {
    // Attendee extraction drops any name it can't match to the roster, leaving no trace — so "no
    // attendees" means "we don't know who was there", not "nobody". Crediting the submitter is the
    // honest floor, but it must be distinguishable from real attendance.
    const seed = await seedTeam();
    await createMeetingNote(db(), seed.teamId, {
      title: "Nobody matched",
      rawText: "body",
      submittedByMemberId: seed.memberId,
      occurredAt: today(),
      attendeeMemberIds: [],
    });

    const days = await getWorkTimeline(db(), seed.teamId, "team", undefined, await viewFor(seed));
    const found = meetingsFor(days, seed.memberId);
    expect(found).toHaveLength(1);
    expect(found[0].via).toBe("submitter");
  });

  it("a TOMBSTONED note contributes nothing — its merge target carries the union", async () => {
    // Criterion 6. `.is("merged_into", null)` reads like a tidy-up guard, so it is exactly the line a
    // later "simplification" removes — and then every merged meeting double-credits everyone in it,
    // silently. Written against the real column rather than through the merge helper so it pins the
    // QUERY's behaviour, which is the thing that would regress.
    const seed = await seedTeam();
    const other = await addMember(seed, "Chetan");

    const targetId = await createMeetingNote(db(), seed.teamId, {
      title: "The surviving note",
      rawText: "merged body",
      submittedByMemberId: seed.memberId,
      occurredAt: today(),
      attendeeMemberIds: [seed.memberId, other], // the UNION, as merge leaves it
    });
    const dupId = await createMeetingNote(db(), seed.teamId, {
      title: "The duplicate recording",
      rawText: "same meeting, second recording",
      submittedByMemberId: seed.memberId,
      occurredAt: today(),
      attendeeMemberIds: [seed.memberId, other],
    });
    await db().from("meeting_notes").update({ merged_into: targetId }).eq("id", dupId);

    const days = await getWorkTimeline(db(), seed.teamId, "team", undefined, await viewFor(seed));
    for (const memberId of [seed.memberId, other]) {
      const found = meetingsFor(days, memberId);
      expect(found, `${memberId} should see the merged meeting exactly once`).toHaveLength(1);
      expect(found[0].title).toBe("The surviving note");
    }
  });

  it("drops a meeting nobody can be credited for, rather than guessing", async () => {
    // Criterion 5's other half. With no resolved attendee AND no usable submitter there is no honest
    // person to put it on, so it contributes nothing — it must not fall through to some default.
    const seed = await seedTeam();
    const noteId = await createMeetingNote(db(), seed.teamId, {
      title: "Orphaned meeting",
      rawText: "body",
      submittedByMemberId: seed.memberId,
      occurredAt: today(),
      attendeeMemberIds: [],
    });
    await db().from("meeting_notes").update({ submitted_by: null }).eq("id", noteId);

    const days = await getWorkTimeline(db(), seed.teamId, "team", undefined, await viewFor(seed));
    const anyMeeting = days
      .flatMap((d) => d.people)
      .flatMap((p) => p.other)
      .filter((g) => g.source === "meetings");
    expect(anyMeeting).toEqual([]);
  });

  it("dates a meeting by occurred_at, as a bare date", async () => {
    // `occurred_at` is a `date` column — no clock time. A meeting must land on the day it happened,
    // and must not carry a bogus midnight timestamp that sorts before every same-day commit.
    const seed = await seedTeam();
    const twoDaysAgo = new Date(Date.now() - 2 * 86_400_000).toISOString().slice(0, 10);
    await createMeetingNote(db(), seed.teamId, {
      title: "Happened two days ago",
      rawText: "body",
      submittedByMemberId: seed.memberId,
      occurredAt: twoDaysAgo,
      attendeeMemberIds: [seed.memberId],
    });

    const days = await getWorkTimeline(db(), seed.teamId, "team", undefined, await viewFor(seed));
    const found = meetingsFor(days, seed.memberId);
    expect(found).toHaveLength(1);
    expect(found[0].at).toBe(twoDaysAgo); // bare YYYY-MM-DD, not an ISO timestamp
    expect(days.find((d) => d.people.some((p) => p.memberId === seed.memberId))?.date).toBe(twoDaysAgo);
  });
});
