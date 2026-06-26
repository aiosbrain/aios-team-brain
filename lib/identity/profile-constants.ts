/**
 * Client-safe constants + types for the identity context layer. Kept OUT of profile.ts
 * (which is `server-only`) so the editor client component can import the allowlists without
 * pulling server code. profile.ts re-exports these so server callers have one import site.
 */

export type Weekday = "mon" | "tue" | "wed" | "thu" | "fri" | "sat" | "sun";
export const WEEKDAYS: readonly Weekday[] = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];

/** Per-weekday [start, end] in 24h "HH:MM"; omitted days mean "not working". */
export type WorkingHours = Partial<Record<Weekday, [string, string]>>;

/** Contact-preference channels, in priority order. Allowlisted to keep the set queryable. */
export const CHANNEL_KINDS = ["slack", "email", "linear", "plane", "github", "phone", "in_person"] as const;
export type ChannelKind = (typeof CHANNEL_KINDS)[number];

export const TIME_OFF_KINDS = ["pto", "holiday", "sick", "other"] as const;
export type TimeOffKind = (typeof TIME_OFF_KINDS)[number];

export const GOAL_KINDS = ["okr", "goal"] as const;
export type GoalKind = (typeof GOAL_KINDS)[number];

export const GOAL_STATUSES = ["on_track", "at_risk", "off_track", "done"] as const;
export type GoalStatus = (typeof GOAL_STATUSES)[number];

export const GOAL_SOURCES = ["manual", "jira", "plane", "linear"] as const;
export type GoalSource = (typeof GOAL_SOURCES)[number];
