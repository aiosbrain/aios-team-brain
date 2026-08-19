import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { db, ingest, seedTeam, placeMemberByTier, type Seed } from "./helpers";
import { backfillTeamContext } from "@/lib/projects/context/backfill";
import { createGroup, grantProjectToGroup, addMemberToGroup } from "@/lib/access/groups";
import {
  createMeetingNote,
  createMeetingNoteFromItem,
  getMeetingNote,
  listMeetingNotesForTeam,
} from "@/lib/meetings/notes";

// ENFB-3 AC1/AC2 (docs/design/enfb3-meetings-graph-feeds.md): the meetings surfaces gate on
// the ITEM oracle — a note's restriction axis is its source transcript. Restricted notes
// vanish from the non-grantee's list, 404-shape at detail (indistinguishable from unknown),
// and the transcript actions refuse before any LLM/summary/provider write. Tombstones refuse
// (D4). The upload round-trip is immediate (D2's inline reconcile).

vi.mock("@/lib/auth/guard", () => ({ currentMember: vi.fn() }));
vi.mock("@/lib/db/server", () => ({ serverClient: vi.fn() }));

async function seedMember(seed: Seed, posture: "team" | "external" = "team"): Promise<string> {
  const { data } = await db()
    .from("members")
    .insert({ team_id: seed.teamId, email: `${randomUUID()}@t.local`, display_name: "M", actor_handle: `h-${randomUUID().slice(0, 10)}`, role: "member", tier: posture, status: "active" })
    .select("id")
    .single();
  await placeMemberByTier(seed.teamId, data!.id as string, posture);
  return data!.id as string;
}

/** Curate an item's unit into a fresh restricted initiative granted to `memberInGroup`. */
async function restrictInto(seed: Seed, itemId: string, memberInGroup: string): Promise<string> {
  const { data: proj } = await db().from("projects").insert({ team_id: seed.teamId, slug: `r-${randomUUID().slice(0, 8)}`, name: "R", kind: "initiative" }).select("id").single();
  const g = await createGroup(db(), seed.teamId, `rg-${randomUUID().slice(0, 8)}`, "RG", seed.memberId);
  await grantProjectToGroup(db(), seed.teamId, proj!.id as string, g.groupId!, seed.memberId);
  await addMemberToGroup(db(), seed.teamId, g.groupId!, memberInGroup, seed.memberId);
  const { data: unit } = await db().from("project_context_units").select("id").eq("source_item_id", itemId).single();
  await db().from("project_context_memberships").update({ valid_to: new Date().toISOString() }).eq("context_unit_id", unit!.id).is("valid_to", null);
  const { error } = await db().from("project_context_memberships").insert({ team_id: seed.teamId, project_id: proj!.id as string, context_unit_id: unit!.id, method: "manual" });
  expect(error).toBeNull();
  return proj!.id as string;
}

const viewer = (memberId: string, tier: "team" | "external" = "team") => ({ memberId, tier });

describe("ENFB-3 — the meetings surfaces gate on the item oracle", () => {
  it("a restricted transcript's note: absent from the non-grantee's list, detail null (≡ unknown), grantee gets everything; General serves every everyone-member", async () => {
    const seed = await seedTeam();
    await backfillTeamContext(db(), seed.teamId);
    const insider = await seedMember(seed);
    const outsider = await seedMember(seed);

    // Two GUI uploads → both General-visible after the inline reconcile (D2).
    const open = await createMeetingNote(db(), seed.teamId, {
      title: "Open standup", rawText: "we shipped things", submittedByMemberId: insider, occurredAt: "2026-08-18", summary: "", attendeeMemberIds: [],
    });
    const secret = await createMeetingNote(db(), seed.teamId, {
      title: "Restricted planning", rawText: "the secret plan", submittedByMemberId: insider, occurredAt: "2026-08-18", summary: "", attendeeMemberIds: [],
    });
    expect(open.visible && secret.visible, "D2: inline reconcile makes both immediately visible").toBe(true);

    // Restrict the second note's transcript into an initiative only the insider holds.
    const { data: secretRow } = await db().from("meeting_notes").select("source_item_id").eq("id", secret.noteId).single();
    await restrictInto(seed, secretRow!.source_item_id as string, insider);

    const outsiderList = await listMeetingNotesForTeam(db(), seed.teamId, viewer(outsider));
    expect(outsiderList.map((n) => n.id), "restricted note absent from the non-grantee's list").not.toContain(secret.noteId);
    expect(outsiderList.map((n) => n.id), "the General note still serves (non-vacuity)").toContain(open.noteId);

    // Detail: denied ≡ unknown (both null → the page's one notFound).
    expect(await getMeetingNote(db(), seed.teamId, secret.noteId, viewer(outsider)), "denied detail is null").toBeNull();
    expect(await getMeetingNote(db(), seed.teamId, randomUUID(), viewer(outsider)), "unknown detail is null").toBeNull();

    // Grantee: list + detail incl. the transcript body (non-vacuity of the wall).
    const insiderList = await listMeetingNotesForTeam(db(), seed.teamId, viewer(insider));
    expect(insiderList.map((n) => n.id)).toContain(secret.noteId);
    const insiderDetail = await getMeetingNote(db(), seed.teamId, secret.noteId, viewer(insider));
    expect(insiderDetail?.rawText).toBe("the secret plan");

    // The list≡detail agreement pin: every listed id serves at detail, for both viewers.
    for (const [m, list] of [[outsider, outsiderList], [insider, insiderList]] as const) {
      for (const n of list) {
        expect(await getMeetingNote(db(), seed.teamId, n.id, viewer(m)), `listed id ${n.id} must serve at detail`).not.toBeNull();
      }
    }
  });

  it("D4: a tombstone (merged_into) refuses at detail even for a grantee; external posture stays walled", async () => {
    const seed = await seedTeam();
    await backfillTeamContext(db(), seed.teamId);
    const member = await seedMember(seed);
    const item = await ingest(seed, { path: "meetings/x.md", body: "folded transcript", access: "team", project: "meeting-notes", kind: "transcript" });
    await backfillTeamContext(db(), seed.teamId);
    const target = await createMeetingNote(db(), seed.teamId, {
      title: "Survivor", rawText: "kept", submittedByMemberId: member, occurredAt: null, summary: "", attendeeMemberIds: [],
    });
    const tombstoneId = await createMeetingNoteFromItem(db(), seed.teamId, {
      sourceItemId: item.id, title: "Folded", occurredAt: null, summary: "", submittedByMemberId: member, attendeeMemberIds: [], mergedInto: target.noteId,
    });
    expect(await getMeetingNote(db(), seed.teamId, String(tombstoneId), viewer(member)), "a tombstone serves nobody").toBeNull();
    expect(await getMeetingNote(db(), seed.teamId, target.noteId, viewer(member)), "the survivor serves").not.toBeNull();

    const external = await seedMember(seed, "external");
    expect(await listMeetingNotesForTeam(db(), seed.teamId, viewer(external, "external")), "external posture → [] (the coarse wall, unchanged)").toEqual([]);
  });

  it("the transcript ACTIONS refuse a denied noteId before any write (extract + regenerate + push), and work for the grantee", async () => {
    const seed = await seedTeam();
    await backfillTeamContext(db(), seed.teamId);
    const insider = await seedMember(seed);
    const outsider = await seedMember(seed);
    const secret = await createMeetingNote(db(), seed.teamId, {
      title: "Secret", rawText: "- [ ] rotate the key", submittedByMemberId: insider, occurredAt: null, summary: "existing summary", attendeeMemberIds: [],
    });
    const { data: row } = await db().from("meeting_notes").select("source_item_id").eq("id", secret.noteId).single();
    await restrictInto(seed, row!.source_item_id as string, insider);
    const { data: team } = await db().from("teams").select("slug").eq("id", seed.teamId).single();
    const teamSlug = team!.slug as string;

    const { currentMember } = await import("@/lib/auth/guard");
    const { serverClient } = await import("@/lib/db/server");
    (serverClient as ReturnType<typeof vi.fn>).mockResolvedValue(db());
    // The outsider is an ADMIN — role must not bypass the wall.
    (currentMember as ReturnType<typeof vi.fn>).mockResolvedValue({ id: outsider, role: "admin", tier: "team" });

    const { extractMeetingActionItemsAction, regenerateMeetingSummaryAction, pushMeetingTasksAction } = await import("@/app/t/[team]/meetings/actions");
    const ex = await extractMeetingActionItemsAction(teamSlug, secret.noteId);
    expect(ex.ok).toBe(false);
    expect(ex.error, "the refusal is the absent-note shape (§5.7)").toBe("meeting note not found");
    const rg = await regenerateMeetingSummaryAction(teamSlug, secret.noteId);
    expect(rg.ok).toBe(false);
    const { data: after } = await db().from("meeting_notes").select("summary").eq("id", secret.noteId).single();
    expect(after!.summary, "the denied regenerate wrote nothing").toBe("existing summary");
    const push = await pushMeetingTasksAction(teamSlug, secret.noteId, [randomUUID()]);
    expect(push.ok).toBe(false);

    // Non-vacuity: the INSIDER's push path resolves the note (it fails later on no PM provider,
    // never on the visibility gate).
    (currentMember as ReturnType<typeof vi.fn>).mockResolvedValue({ id: insider, role: "member", tier: "team" });
    const insiderPush = await pushMeetingTasksAction(teamSlug, secret.noteId, [randomUUID()]);
    expect(insiderPush.error, "the gate passed for the grantee").not.toBe("meeting note not found");
  });
});
