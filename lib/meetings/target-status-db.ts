import "server-only";
import type { DbClient } from "@/lib/db/types";
import { normalizeMeetingTaskStatus, type MeetingTaskStatus } from "./target-status";

/** Server-only read/write of `teams.meeting_task_status` (see target-status.ts for the vocabulary). */

/** Read the team's configured target status (defaulting when unset/invalid). */
export async function getMeetingTaskStatus(db: DbClient, teamId: string): Promise<MeetingTaskStatus> {
  const { data } = await db.from("teams").select("meeting_task_status").eq("id", teamId).maybeSingle();
  return normalizeMeetingTaskStatus((data as { meeting_task_status: string | null } | null)?.meeting_task_status);
}

/** Set the team's target status (validated). Single write path for the admin action. */
export async function setMeetingTaskStatus(db: DbClient, teamId: string, status: MeetingTaskStatus): Promise<void> {
  const { error } = await db
    .from("teams")
    .update({ meeting_task_status: normalizeMeetingTaskStatus(status) })
    .eq("id", teamId);
  if (error) throw new Error(`set meeting_task_status: ${error.message}`);
}
