import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it, vi } from "vitest";
import { db, externalMember, ingest, placeMemberByTier, seedTeam, type Seed } from "./helpers";
import { getWorkTimeline } from "@/lib/dashboard/work-timeline";
import { contentTimelineEnforcement } from "@/lib/access/admission";
import { createMember } from "@/lib/admin/members";
import { createGroup, addMemberToGroup, grantProjectToGroup } from "@/lib/access/groups";
import { ensureAccessBootstrap } from "@/lib/access/bootstrap";
import { backfillTeamContext } from "@/lib/projects/context/backfill";

// The meeting leg's cap is captured from TIMELINE_MEETING_LIMIT when work-timeline.ts is imported.
// vi.hoisted runs ahead of the static imports above, so this file's own (per-file isolated) module
// graph builds with a small cap; afterAll restores the env so no later suite inherits it. The
// production default (2000) is untouched — only this file's module load sees 3.
const CAP = vi.hoisted(() => {
  const cap = 3;
  const prev = process.env.TIMELINE_MEETING_LIMIT;
  process.env.TIMELINE_MEETING_LIMIT = String(cap);
  return { cap, prev };
});

afterAll(() => {
  if (CAP.prev === undefined) delete process.env.TIMELINE_MEETING_LIMIT;
  else process.env.TIMELINE_MEETING_LIMIT = CAP.prev;
});

/**
 * TIERRET-1 / AIO-1045, code-review 2 LOW-2 — the timeline's meeting leg must authorize BEFORE its
 * LIMIT (accepted scope item 1; AC-05 capped-window semantics). Spec-derived, not characterization:
 * a member who can see ONE in-window meeting must get it on the timeline no matter how many NEWER
 * meetings it cannot see exist. If the leg ranks/caps over every team note and only then drops the
 * hidden ones, more-than-cap hidden newer notes fill the window and the visible meeting silently
 * vanishes — starvation, not a leak, but a wrong answer for exactly the newly opened member leg.
 *
 * RED-FIRST: written before the in-query predicate; the baseline run is recorded in the handoff.
 * Expected on the unmodified builder: the starvation assertion RED, the leak/negative controls GREEN.
 */

const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);
const HIDDEN_COUNT = CAP.cap + 1;
const VISIBLE_TITLE = "Granted kickoff retro";
const hiddenTitle = (i: number) => `Sealed board session ${i}`;

type Days = Awaited<ReturnType<typeof getWorkTimeline>>;

/** Every meeting evidence row on the timeline, across every person's card. */
function meetingEvidence(days: Days) {
  const out: { memberId: string; id: string; title: string }[] = [];
  for (const d of days)
    for (const p of d.people)
      for (const g of p.other) {
        if (g.source !== "meetings") continue;
        for (const it of g.items) out.push({ memberId: p.memberId, id: it.id, title: it.title });
      }
  return out;
}

async function mkInitiative(seed: Seed, slug: string): Promise<string> {
  const { data, error } = await db()
    .from("projects")
    .insert({ team_id: seed.teamId, slug: `${slug}-${randomUUID().slice(0, 6)}`, name: slug, kind: "initiative" })
    .select("id")
    .single();
  expect(error).toBeNull();
  return (data as { id: string }).id;
}

/** Fixture-only custom placement (spec AC-01: custom placements use fixture membership writes). */
async function moveMembership(seed: Seed, itemId: string, projectId: string): Promise<void> {
  const { data: unit } = await db().from("project_context_units").select("id").eq("source_item_id", itemId).single();
  await db()
    .from("project_context_memberships")
    .update({ valid_to: new Date().toISOString() })
    .eq("context_unit_id", (unit as { id: string }).id)
    .is("valid_to", null);
  const { error } = await db().from("project_context_memberships").insert({
    team_id: seed.teamId,
    project_id: projectId,
    context_unit_id: (unit as { id: string }).id,
    method: "manual",
  });
  expect(error).toBeNull();
}

async function teamHuman(seed: Seed, name: string): Promise<string> {
  const { data, error } = await db()
    .from("members")
    .insert({
      team_id: seed.teamId,
      email: `${randomUUID()}@test.local`,
      display_name: name,
      actor_handle: `h-${randomUUID().slice(0, 10)}`,
      role: "member",
      tier: "team",
      status: "active",
    })
    .select("id")
    .single();
  if (error || !data) throw new Error(`seed member failed: ${error?.message}`);
  const id = (data as { id: string }).id;
  await placeMemberByTier(seed.teamId, id, "team");
  return id;
}

async function mkNote(seed: Seed, sourceItemId: string, title: string, occurredAt: string, attendees: string[]) {
  const { data, error } = await db()
    .from("meeting_notes")
    .insert({ team_id: seed.teamId, source_item_id: sourceItemId, title, summary: title, occurred_at: occurredAt })
    .select("id")
    .single();
  expect(error).toBeNull();
  const id = (data as { id: string }).id;
  for (const member_id of attendees) {
    const { error: aErr } = await db().from("meeting_note_attendees").insert({ meeting_note_id: id, member_id });
    expect(aErr).toBeNull();
  }
  return id;
}

interface Fx {
  seed: Seed;
  granted: string; // external-posture human granted ONLY initiative X
  hiddenAttendee: string; // team human who attended ONLY the hidden meetings
  visibleTranscript: string;
  hiddenTranscripts: string[];
  visibleNote: string;
  hiddenNotes: string[];
}

async function buildFixture(): Promise<Fx> {
  const seed = await seedTeam();
  await backfillTeamContext(db(), seed.teamId);
  const visible = await ingest(seed, { kind: "transcript", path: "meetings/kickoff-retro.md", body: "kickoff retro transcript", access: "team", project: "src" });
  const hidden: string[] = [];
  for (let i = 0; i < HIDDEN_COUNT; i++) {
    const h = await ingest(seed, { kind: "transcript", path: `meetings/sealed-${i}.md`, body: `sealed board transcript ${i}`, access: "team", project: "src" });
    hidden.push(h.id);
  }
  await backfillTeamContext(db(), seed.teamId);
  const boot = await ensureAccessBootstrap(db(), seed.teamId);
  expect(boot.ok, boot.error).toBe(true);

  const X = await mkInitiative(seed, "x");
  await moveMembership(seed, visible.id, X);

  const m = await createMember(db(), seed.teamId, { email: `${randomUUID()}@test.local`, displayName: "Collaborator", actorHandle: `c-${randomUUID().slice(0, 8)}`, role: "member", tier: "external" });
  await db().from("members").update({ status: "active" }).eq("id", m.id).eq("team_id", seed.teamId);
  const g = await createGroup(db(), seed.teamId, `clients-${randomUUID().slice(0, 6)}`, "Clients X", seed.memberId);
  expect(g.ok, g.error).toBe(true);
  expect((await addMemberToGroup(db(), seed.teamId, g.groupId!, m.id, seed.memberId)).ok).toBe(true);
  expect((await grantProjectToGroup(db(), seed.teamId, X, g.groupId!, seed.memberId)).ok).toBe(true);

  const hiddenAttendee = await teamHuman(seed, "Sealed Attendee");

  // Deterministic, in-window dates: the visible meeting is OLDER than every hidden one, so an
  // ordered scan capped before authorization fills its window with hidden rows first.
  const visibleNote = await mkNote(seed, visible.id, VISIBLE_TITLE, daysAgo(3), [m.id, seed.memberId]);
  const hiddenNotes: string[] = [];
  for (let i = 0; i < HIDDEN_COUNT; i++) {
    hiddenNotes.push(await mkNote(seed, hidden[i], hiddenTitle(i), daysAgo(1), [hiddenAttendee]));
  }
  return { seed, granted: m.id, hiddenAttendee, visibleTranscript: visible.id, hiddenTranscripts: hidden, visibleNote, hiddenNotes };
}

describe("TIERRET-1 LOW-2 — the timeline meeting leg authorizes before its LIMIT (real Postgres)", () => {
  it("a granted member's older visible meeting survives more-than-cap newer hidden meetings; hidden titles and attendees never surface", async () => {
    const F = await buildFixture();
    const enforce = await contentTimelineEnforcement(db(), F.seed.teamId, F.granted);
    // Preconditions (fixture honesty): the oracle serves the visible transcript and none of the hidden.
    expect(enforce.reader.principal).toBe("member");
    expect(enforce.visibleItemIds.has(F.visibleTranscript)).toBe(true);
    for (const h of F.hiddenTranscripts) expect(enforce.visibleItemIds.has(h)).toBe(false);
    expect(F.hiddenNotes.length, "more hidden newer notes than the meeting cap").toBeGreaterThan(CAP.cap);

    const days = await getWorkTimeline(db(), F.seed.teamId, "external", undefined, enforce);
    const ev = meetingEvidence(days);

    // The spec outcome: the visible meeting is on the card of each of its attendees.
    const visibleRows = ev.filter((e) => e.id.startsWith(`${F.visibleNote}:`));
    expect(visibleRows.map((e) => e.title), "the older visible meeting must not be starved by hidden newer notes").toContain(VISIBLE_TITLE);
    expect(new Set(visibleRows.map((e) => e.memberId))).toEqual(new Set([F.granted, F.seed.memberId]));

    // Leak controls: no hidden title, note id or attendee evidence anywhere in the payload.
    const flat = JSON.stringify(days);
    for (let i = 0; i < HIDDEN_COUNT; i++) expect(flat).not.toContain(hiddenTitle(i));
    for (const n of F.hiddenNotes) expect(flat).not.toContain(n);
    expect(ev.filter((e) => e.memberId === F.hiddenAttendee), "hidden-meeting attendance is never credited").toEqual([]);
    expect(ev.every((e) => e.id.startsWith(`${F.visibleNote}:`))).toBe(true);
  });

  it("non-vacuity: the isolated cap really bites — a reader who sees every hidden meeting gets exactly the cap newest", async () => {
    const F = await buildFixture();
    // The seed admin is in Everyone (sees General, where the hidden transcripts auto-placed) but not
    // granted X — so for it the hidden notes are the visible ones, and the cap must still clip them.
    const enforce = await contentTimelineEnforcement(db(), F.seed.teamId, F.seed.memberId);
    for (const h of F.hiddenTranscripts) expect(enforce.visibleItemIds.has(h)).toBe(true);
    expect(enforce.visibleItemIds.has(F.visibleTranscript)).toBe(false);

    const days = await getWorkTimeline(db(), F.seed.teamId, "team", undefined, enforce);
    const notes = new Set(meetingEvidence(days).map((e) => e.id.split(":")[0]));
    expect(notes.size, `TIMELINE_MEETING_LIMIT=${CAP.cap} is the live cap for this module load`).toBe(CAP.cap);
    expect(notes.has(F.visibleNote)).toBe(false);
  });

  it("empty visible set (negative control): a grantless member gets no meeting evidence at all", async () => {
    const F = await buildFixture();
    const grantless = await externalMember(F.seed);
    const enforce = await contentTimelineEnforcement(db(), F.seed.teamId, grantless);
    expect(enforce.visibleItemIds.size, "precondition: the grantless member's item set is empty").toBe(0);

    const days = await getWorkTimeline(db(), F.seed.teamId, "external", undefined, enforce);
    expect(meetingEvidence(days)).toEqual([]);
    const flat = JSON.stringify(days);
    expect(flat).not.toContain(VISIBLE_TITLE);
    for (let i = 0; i < HIDDEN_COUNT; i++) expect(flat).not.toContain(hiddenTitle(i));
  });
});
