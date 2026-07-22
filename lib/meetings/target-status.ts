/**
 * Where extracted MEETING action items land in the team's PM tool. Stored as a brain task STATUS on
 * `teams.meeting_task_status`; the projection maps that status to the provider's workflow-state group
 * (`desiredStateForStatus` in lib/pm-sync/provider) — so "In Progress" here → Linear's Started
 * category / Plane's equivalent. Provider-agnostic. Null → the historical `backlog` default.
 *
 * Pure + client-safe (no server-only / DB imports) so both the admin UI and the meeting page can use
 * the options and labels. DB read/write lives in `target-status-db.ts` (server-only).
 */

/** The selectable statuses (each maps 1:1 to a PM "category"). Ordered for the admin radio. */
export const MEETING_TASK_STATUSES = ["backlog", "ready", "in_progress", "done"] as const;
export type MeetingTaskStatus = (typeof MEETING_TASK_STATUSES)[number];

export const DEFAULT_MEETING_TASK_STATUS: MeetingTaskStatus = "backlog";

/** Human labels using the PM-tool category vocabulary (what the user recognizes in Linear/Plane). */
export const MEETING_CATEGORY_LABEL: Record<MeetingTaskStatus, string> = {
  backlog: "Backlog",
  ready: "Todo",
  in_progress: "In Progress",
  done: "Done",
};

/** Coerce an unknown/legacy value to a valid status, falling back to the default. */
export function normalizeMeetingTaskStatus(value: unknown): MeetingTaskStatus {
  return (MEETING_TASK_STATUSES as readonly string[]).includes(value as string)
    ? (value as MeetingTaskStatus)
    : DEFAULT_MEETING_TASK_STATUS;
}
