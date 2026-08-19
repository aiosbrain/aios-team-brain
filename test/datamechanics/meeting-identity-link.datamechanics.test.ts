import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { randomUUID as uuid } from "node:crypto";
import { db, ingest, seedTeam, sha, type Seed } from "./helpers";
import { backfillTeamContext } from "@/lib/projects/context/backfill";
import { ingestItem } from "@/lib/ingest";
import { backfillMeetingNotesFromItems } from "@/lib/meetings/from-items";
import { getMeetingNote, listMeetingNotesForTeam } from "@/lib/meetings/notes";

/**
 * Spec (MTGATT-3, real Postgres): a calendar event and the transcript of the same meeting become ONE
 * meeting, and the person who pushed the calendar is credited on it.
 *
 * This tier because every failure here is a ROW: a hidden note, a lost submitter, a resurrected
 * duplicate, an attendee that never arrived. `plan()` being right proves none of that — it is the
 * write order, the reads, and the interaction with the merge that runs immediately afterwards that
 * this file exists to pin.
 */

const EVENT_ID = "evt12345abc";
const today = () => new Date().toISOString().slice(0, 10);

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

/** A recorded meeting: has a body, carries the event id. */
async function pushTranscript(seed: Seed, opts: { eventId?: string; body?: string; date?: string } = {}) {
  return ingest(seed, {
    kind: "transcript",
    access: "team",
    path: `1-inbox/transcripts/${randomUUID().slice(0, 8)}.md`,
    body: opts.body ?? "# Design review\n\nWe agreed the rollout.",
    frontmatter: {
      source: "granola",
      created: `${opts.date ?? today()}T09:00:00.000Z`,
      ...(opts.eventId === undefined ? { calendar_event_id: EVENT_ID } : opts.eventId ? { calendar_event_id: opts.eventId } : {}),
    },
  });
}

/**
 * A pushed calendar event: no body, carries the same event id.
 *
 * `asMemberId` pushes it as SOMEONE ELSE — which is the whole scenario: John's transcript, my
 * calendar. Without it the "submitter" under test is the same member on both sides and the credit
 * assertion passes for the wrong reason.
 */
async function pushCalendarEvent(
  seed: Seed,
  opts: { eventId?: string; attendees?: unknown; date?: string; asMemberId?: string; body?: string } = {}
) {
  const frontmatter = {
    source: "calendar",
    title: "Design review",
    occurred_at: opts.date ?? today(),
    attendees: opts.attendees ?? [],
    ...(opts.eventId === undefined ? { calendar_event_id: EVENT_ID } : opts.eventId ? { calendar_event_id: opts.eventId } : {}),
  };
  if (opts.asMemberId) {
    const path = `1-inbox/calendar/${uuid().slice(0, 8)}.md`;
    return ingestItem(
      db(),
      { teamId: seed.teamId, memberId: opts.asMemberId, apiKeyId: uuid() },
      {
        project: "calendar",
        kind: "artifact",
        actor: "tester",
        frontmatter,
        content_sha256: sha(opts.body ?? ""),
        path,
        body: opts.body ?? "",
      },
      "team"
    );
  }
  return ingest(seed, {
    kind: "artifact",
    access: "team",
    path: `1-inbox/calendar/${randomUUID().slice(0, 8)}.md`,
    body: opts.body ?? "",
    project: "calendar",
    frontmatter: {
      source: "calendar",
      title: "Design review",
      occurred_at: opts.date ?? today(),
      attendees: opts.attendees ?? [],
      ...(opts.eventId === undefined ? { calendar_event_id: EVENT_ID } : opts.eventId ? { calendar_event_id: opts.eventId } : {}),
    },
  });
}

const tick = (seed: Seed) => backfillMeetingNotesFromItems(db(), seed.teamId, { extract: async () => ({ summary: "", attendeeMemberIds: [] }) });

async function liveNotes(seed: Seed) {
  // ENFB-3: the list is oracle-gated — converge memberships for whatever the fixture just
  // ingested (prod guarantee: the scheduler's context sweep) before reading.
  await backfillTeamContext(db(), seed.teamId);
  return listMeetingNotesForTeam(db(), seed.teamId, { memberId: seed.memberId, tier: "team" });
}

/** The surviving note's transcript text — the list view carries no body, the detail read does. */
async function bodyOf(seed: Seed, noteId: string): Promise<string> {
  const detail = await getMeetingNote(db(), seed.teamId, noteId, { memberId: seed.memberId, tier: "team" });
  return detail?.rawText ?? "";
}

async function submitterIds(noteId: string): Promise<string[]> {
  const { data } = await db().from("meeting_note_submitters").select("member_id").eq("meeting_note_id", noteId);
  return ((data ?? []) as { member_id: string }[]).map((r) => r.member_id).sort();
}

describe("identity link: one meeting, two pushes (real Postgres)", () => {
  it("folds the calendar event into the TRANSCRIPT and credits the calendar pusher", async () => {
    const seed = await seedTeam(); // ENFB-3: gated reads need a context-bootstrapped team
    await backfillTeamContext(db(), seed.teamId);
    const chetanEmail = `chetan-${randomUUID().slice(0, 6)}@acme.com`;
    const chetan = await addMember(seed, "Chetan", chetanEmail);

    await pushTranscript(seed);
    await pushCalendarEvent(seed, { attendees: [{ email: chetanEmail, responseStatus: "accepted" }] });
    const summary = await tick(seed);

    expect(summary.created, "both items become notes first").toBe(2);
    expect(summary.link.linked).toBe(1);

    const notes = await liveNotes(seed);
    expect(notes, "one meeting, not two").toHaveLength(1);
    // The survivor is identified by CONTENT, not by a uuid — the assertion has to survive being run
    // in either order (see the reverse-order test below).
    expect(await bodyOf(seed, notes[0].id), "the transcript's body survived").toContain("We agreed the rollout.");
    expect(notes[0].attendees.map((a) => a.id), "the calendar pusher is now an attendee").toContain(chetan);
  });

  it("produces the same outcome when the calendar event arrives FIRST", async () => {
    const seed = await seedTeam(); // ENFB-3: gated reads need a context-bootstrapped team
    await backfillTeamContext(db(), seed.teamId);
    const chetanEmail = `chetan-${randomUUID().slice(0, 6)}@acme.com`;
    const chetan = await addMember(seed, "Chetan", chetanEmail);

    await pushCalendarEvent(seed, { attendees: [{ email: chetanEmail }] });
    await pushTranscript(seed);
    const summary = await tick(seed);

    expect(summary.link.linked).toBe(1);
    const notes = await liveNotes(seed);
    expect(notes).toHaveLength(1);
    // Order-independence, asserted rather than argued: the note with the BODY survives either way.
    // The reverse would be MTGATT-1's deferred hazard — a transcript folding into an empty note.
    expect(await bodyOf(seed, notes[0].id)).toContain("We agreed the rollout.");
    expect(notes[0].attendees.map((a) => a.id)).toContain(chetan);
  });

  it("hides the folded note without destroying it, and never resurrects it", async () => {
    const seed = await seedTeam(); // ENFB-3: gated reads need a context-bootstrapped team
    await backfillTeamContext(db(), seed.teamId);
    const cal = await pushCalendarEvent(seed);
    await pushTranscript(seed);
    await tick(seed);

    const { data: folded } = await db()
      .from("meeting_notes")
      .select("id, merged_into")
      .eq("source_item_id", cal.id)
      .maybeSingle();
    expect((folded as { merged_into: string | null }).merged_into, "hidden behind the survivor").toBeTruthy();

    // The ITEM is untouched — a link is reversible, unlike the overlap merge's item retirement.
    const { data: item } = await db().from("items").select("id").eq("id", cal.id).maybeSingle();
    expect(item, "the calendar item still exists").toBeTruthy();

    // The backfill notes every un-noted meeting item each tick; a folded note must not come back as a
    // second meeting on the next one.
    await tick(seed);
    expect(await liveNotes(seed)).toHaveLength(1);
  });

  it("a WHITESPACE-only calendar body does not outrank the transcript", async () => {
    // Pins the caller's `body.trim()`, which the pure rule cannot: `plan()` receives `hasBody` already
    // computed, so without this a producer emitting "\n" for an invite would make the empty note the
    // survivor and hide the real transcript. Found by a surviving mutation, not by review.
    const seed = await seedTeam(); // ENFB-3: gated reads need a context-bootstrapped team
    await backfillTeamContext(db(), seed.teamId);
    await pushCalendarEvent(seed, { body: "  \n\t \n" });
    await pushTranscript(seed);
    await tick(seed);

    const notes = await liveNotes(seed);
    expect(notes).toHaveLength(1);
    expect(await bodyOf(seed, notes[0].id), "the transcript survived, not the blank invite").toContain(
      "We agreed the rollout."
    );
  });

  it("is idempotent — a second tick changes nothing", async () => {
    const seed = await seedTeam(); // ENFB-3: gated reads need a context-bootstrapped team
    await backfillTeamContext(db(), seed.teamId);
    const chetanEmail = `chetan-${randomUUID().slice(0, 6)}@acme.com`;
    await addMember(seed, "Chetan", chetanEmail);
    await pushTranscript(seed);
    await pushCalendarEvent(seed, { attendees: [{ email: chetanEmail }] });

    await tick(seed);
    const first = await liveNotes(seed);
    const firstSubs = await submitterIds(first[0].id);

    const second = await tick(seed);
    const after = await liveNotes(seed);
    expect(second.link.linked, "nothing left to link").toBe(0);
    expect(after).toHaveLength(1);
    expect(after[0].id).toBe(first[0].id);
    expect(after[0].attendees.length).toBe(first[0].attendees.length);
    expect(await submitterIds(after[0].id)).toEqual(firstSubs);
  });

  it("does NOT link two meetings that share no identifier, even with the same title and date", async () => {
    // The misassociation the operator asked about at team size, asserted as an absence. If this ever
    // reddens, the join has started deciding on a resemblance.
    const seed = await seedTeam(); // ENFB-3: gated reads need a context-bootstrapped team
    await backfillTeamContext(db(), seed.teamId);
    await pushTranscript(seed, { eventId: "" });
    await pushCalendarEvent(seed, { eventId: "" });
    const summary = await tick(seed);

    expect(summary.link.linked).toBe(0);
    expect(await liveNotes(seed), "both meetings stay live").toHaveLength(2);
  });

  it("REFUSES a component where BOTH notes have bodies, and neither loses its text (AC10)", async () => {
    // Two recordings of one meeting are the overlap merge's job — it combines their text; this path
    // would hide one. Bodies are deliberately NON-overlapping so the overlap merge does not
    // legitimately fold them either, leaving this path's refusal as the only thing under test.
    const seed = await seedTeam(); // ENFB-3: gated reads need a context-bootstrapped team
    await backfillTeamContext(db(), seed.teamId);
    await pushTranscript(seed, { body: "# Design review\n\nAlpha notes about the rollout schedule." });
    await pushTranscript(seed, { body: "# Design review\n\nCompletely different words, zero overlap here." });
    const summary = await tick(seed);

    expect(summary.link.linked).toBe(0);
    expect(summary.link.refusals["two-bodies"]).toBe(1);
    const notes = await liveNotes(seed);
    expect(notes, "both recordings stay live").toHaveLength(2);
    const bodies = (await Promise.all(notes.map((n) => bodyOf(seed, n.id)))).join("\n");
    expect(bodies, "the first keeps its text").toContain("Alpha notes");
    expect(bodies, "and so does the second").toContain("Completely different words");
  });

  it("REFUSES a component whose dates are weeks apart — the undetectable-series case", async () => {
    const seed = await seedTeam(); // ENFB-3: gated reads need a context-bootstrapped team
    await backfillTeamContext(db(), seed.teamId);
    const old = new Date(Date.now() - 14 * 86_400_000).toISOString().slice(0, 10);
    await pushTranscript(seed, { date: old });
    await pushCalendarEvent(seed);
    const summary = await tick(seed);

    expect(summary.link.linked).toBe(0);
    expect(summary.link.refusals["dates-too-far-apart"]).toBe(1);
    expect(await liveNotes(seed)).toHaveLength(2);
  });

  it("credits the calendar PUSHER as a submitter of the surviving meeting", async () => {
    // The operator's scenario end to end: John records, I push my calendar, and the one meeting that
    // remains says both of us put it there.
    const seed = await seedTeam(); // ENFB-3: gated reads need a context-bootstrapped team
    await backfillTeamContext(db(), seed.teamId);
    const chetan = await addMember(seed, "Chetan", `chetan-${randomUUID().slice(0, 6)}@acme.com`);
    await pushTranscript(seed);
    await pushCalendarEvent(seed, { asMemberId: chetan });
    await tick(seed);

    const notes = await liveNotes(seed);
    expect(notes).toHaveLength(1);
    expect(await submitterIds(notes[0].id)).toContain(chetan);
  });

  it("keeps the accumulated submitter when the linked note is later folded AWAY by the overlap merge", async () => {
    // The hazard this slice makes reachable, and the direction matters: stranding only happens when
    // the note carrying the ACCUMULATED credit is the one folded AWAY — i.e. the later-created of an
    // overlapping pair, since the merge keeps the earliest as primary. The first version of this test
    // built the opposite direction and passed with the fix reverted; a mutation caught it.
    const seed = await seedTeam(); // ENFB-3: gated reads need a context-bootstrapped team
    await backfillTeamContext(db(), seed.teamId);
    const chetanEmail = `chetan-${randomUUID().slice(0, 6)}@acme.com`;
    const chetan = await addMember(seed, "Chetan", chetanEmail);
    const shared = "# Design review\n\nWe agreed the rollout and the launch plan in detail today.";

    // Tick 1 — the EARLIER note, which will become the merge's primary. No event id.
    await pushTranscript(seed, { eventId: "", body: shared });
    await tick(seed);

    // Tick 2 — a second recording of the same meeting, plus Chetan's calendar event for it. The link
    // folds the calendar event into THIS note (it has the body), crediting Chetan on it...
    await pushTranscript(seed, { body: `${shared} Plus a closing note.` });
    await pushCalendarEvent(seed, { asMemberId: chetan, attendees: [{ email: chetanEmail }] });
    const second = await tick(seed);
    expect(second.link.linked, "the calendar event linked to the newer transcript").toBe(1);

    // ...and the overlap merge, in that same tick, folds that newer note into the earlier one. Whether
    // Chetan's credit survives is exactly what `newSubmitterIds` decides.
    const notes = await liveNotes(seed);
    expect(notes, "the two recordings became one meeting").toHaveLength(1);
    expect(await submitterIds(notes[0].id), "the calendar pusher survived the second fold").toContain(chetan);

    // AND THE KEY SURVIVED. The merge writes a NEW item that replaces both, and it wrote `{title}`
    // alone — so the merged meeting lost its event id and a THIRD push of the same event could never
    // find it: a second visible meeting forever, uncredited, with no refusal counted. Asserting
    // submitter survival alone left that green by construction, which is how the second reviewer
    // found it. Note the keyed note here is the one folded AWAY, so the identity has to be carried
    // from the duplicate, not just the survivor.
    const { data: survivor } = await db()
      .from("meeting_notes")
      .select("source_item_id")
      .eq("id", notes[0].id)
      .maybeSingle();
    const { data: item } = await db()
      .from("items")
      .select("frontmatter")
      .eq("id", (survivor as { source_item_id: string }).source_item_id)
      .maybeSingle();
    const fm = ((item as { frontmatter: Record<string, unknown> }).frontmatter ?? {}) as Record<string, unknown>;
    expect(fm.calendar_event_id, "the merged item still carries the event id").toBe(EVENT_ID);

    // The proof it is reachable, not just present: a third push of the same event links to it.
    const third = await addMember(seed, "Third", `third-${randomUUID().slice(0, 6)}@acme.com`);
    await pushCalendarEvent(seed, { asMemberId: third });
    const third_tick = await tick(seed);
    expect(third_tick.link.linked, "a later push of the same event still finds the meeting").toBe(1);
    expect(await submitterIds(notes[0].id)).toContain(third);
  });
});
