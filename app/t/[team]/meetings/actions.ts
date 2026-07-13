"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { serverClient } from "@/lib/db/server";
import { adminClient } from "@/lib/db/admin";
import { currentMember } from "@/lib/auth/guard";
import { getProviderKey } from "@/lib/integrations/manage";
import { createMeetingNote, canSeeMeetingNotes, MEETING_NOTES_PROJECT_SLUG } from "@/lib/meetings/notes";
import { extractFromTranscript, type RosterPerson } from "@/lib/meetings/llm-extract";
import { extractMeetingTodosForTeam } from "@/lib/meetings/extract-todos";
import { backfillMeetingNotesFromItems } from "@/lib/meetings/from-items";

const uploadSchema = z.object({
  teamSlug: z.string().min(1),
  title: z.string().trim().min(1).max(200),
  rawText: z.string().trim().min(1).max(200_000),
  occurredAt: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .nullable()
    .optional(),
});

async function resolveTeam(teamSlug: string): Promise<{ id: string; slug: string } | null> {
  const db = await serverClient();
  const { data: team } = await db.from("teams").select("id, slug").eq("slug", teamSlug).maybeSingle();
  return (team as { id: string; slug: string } | null) ?? null;
}

/**
 * Upload a meeting transcript: resolves the submitter + team roster, runs the LLM
 * summary/attendee pass (best-effort — never blocks the upload, see lib/meetings/llm-extract),
 * writes the note via the single writer, then auto-extracts todo items scoped to just this note's
 * transcript. Team-tier only, matching lib/meetings/notes.canSeeMeetingNotes.
 */
export async function uploadMeetingNoteAction(
  input: z.input<typeof uploadSchema>
): Promise<{ ok: boolean; error?: string; id?: string }> {
  const parsed = uploadSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "invalid upload" };

  const team = await resolveTeam(parsed.data.teamSlug);
  if (!team) return { ok: false, error: "team not found" };

  const me = await currentMember(team.id);
  if (!me) return { ok: false, error: "not a member of this team" };
  if (!canSeeMeetingNotes(me.tier)) return { ok: false, error: "team-tier membership required" };

  const admin = adminClient();
  const [{ data: rosterRows }, openaiKey, anthropicKey] = await Promise.all([
    admin.from("members").select("id, display_name").eq("team_id", team.id).eq("status", "active"),
    getProviderKey(admin, team.id, "openai"),
    getProviderKey(admin, team.id, "anthropic"),
  ]);
  const roster: RosterPerson[] = ((rosterRows ?? []) as { id: string; display_name: string }[]).map((m) => ({
    id: m.id,
    displayName: m.display_name,
  }));

  const extraction = await extractFromTranscript(parsed.data.rawText, roster, { openaiKey, anthropicKey });

  let noteId: string;
  try {
    noteId = await createMeetingNote(admin, team.id, {
      title: parsed.data.title,
      rawText: parsed.data.rawText,
      submittedByMemberId: me.id,
      occurredAt: parsed.data.occurredAt ?? null,
      summary: extraction.summary,
      attendeeMemberIds: extraction.attendeeMemberIds,
    });
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "could not save the meeting note" };
  }

  try {
    await extractMeetingTodosForTeam(admin, team.id, {
      sourceProject: MEETING_NOTES_PROJECT_SLUG,
      pathPrefix: `meetings/${noteId}`,
    });
  } catch {
    // Todo extraction is best-effort — the note itself already saved successfully.
  }

  revalidatePath(`/t/${team.slug}/meetings`);
  return { ok: true, id: noteId };
}

/**
 * Import meetings that arrived via the CLI/ingest (`aios push`) into the Meetings page. Scans this
 * team's meeting-source transcript `items` that don't yet have a note and creates one for each
 * (summary/attendees extracted, idempotent). Team-tier only, matching `canSeeMeetingNotes`.
 */
export async function importPushedMeetingsAction(
  teamSlug: string
): Promise<{ ok: boolean; error?: string; created?: number; scanned?: number }> {
  const team = await resolveTeam(teamSlug);
  if (!team) return { ok: false, error: "team not found" };

  const me = await currentMember(team.id);
  if (!me) return { ok: false, error: "not a member of this team" };
  if (!canSeeMeetingNotes(me.tier)) return { ok: false, error: "team-tier membership required" };

  const admin = adminClient();
  const [openaiKey, anthropicKey] = await Promise.all([
    getProviderKey(admin, team.id, "openai"),
    getProviderKey(admin, team.id, "anthropic"),
  ]);
  try {
    const s = await backfillMeetingNotesFromItems(admin, team.id, { keys: { openaiKey, anthropicKey } });
    revalidatePath(`/t/${team.slug}/meetings`);
    return { ok: true, created: s.created, scanned: s.scanned };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "import failed" };
  }
}
