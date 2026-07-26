import type { TaskStatusValue } from "@/lib/pm-sync/provider";

/**
 * THE answer to "is this task being worked on" — one definition, consumed by every surface that asks.
 *
 * Why this module exists: the question was answered independently in five places, in three different
 * ways. The work timeline said `{in_progress, blocked}`; the Home "on your plate" box and the Pulse
 * in-flight metric each said `{ready, in_progress, blocked}` via their own private `Set`; and arc
 * eligibility answered it from the raw LINEAR workflow-state vocabulary, which meant Plane tickets were
 * never gated at all — Done and Backlog Plane issues shaped narrative arcs (the same noise class that
 * #363/#331 removed for Linear, still live for the other provider). Three surfaces gave three answers
 * to one product question, and adding a provider silently opted out of the rule.
 *
 * ── Two sets, not one, and that part is deliberate ──────────────────────────────────────────────────
 * The divergence worth keeping is between two genuinely different questions:
 *
 *   ACTIVE  — someone is working this NOW. `blocked` counts: the work is underway and stuck, which is
 *             exactly what a "what is the team working through" surface should show. `ready` does NOT:
 *             it is queued, not started.
 *   OPEN    — not finished. ACTIVE plus `ready`, i.e. everything on someone's plate. `backlog` is out
 *             (unprioritised intake, not a commitment) and so are `done`/cancelled.
 *
 * A caller picks the question it means. What it must NOT do is re-spell either set locally — that is
 * what drifted, and `test/guards/activity-policy-single-source.test.ts` fails the build if a surface
 * declares its own copy.
 *
 * The vocabulary is the BRAIN's normalized `tasks.status`, never a provider's own state names. Each
 * connector maps its states once, at ingest (`planeStatus`, the Linear state-group map), so the policy
 * is provider-agnostic by construction and a new provider inherits the rule instead of bypassing it.
 */

/** Being worked right now — including `blocked` (underway and stuck), excluding `ready` (queued). */
export const ACTIVE_STATUSES: ReadonlySet<TaskStatusValue> = new Set<TaskStatusValue>([
  "in_progress",
  "blocked",
]);

/** Not finished: ACTIVE + `ready`. Excludes `backlog` (intake) and `done`. */
export const OPEN_STATUSES: ReadonlySet<TaskStatusValue> = new Set<TaskStatusValue>([
  "ready",
  ...ACTIVE_STATUSES,
]);

/**
 * Is this status active work? Unknown/absent input is NOT active — fail closed. A status we can't
 * recognise is most often a provider state we haven't mapped, and treating those as active is how
 * backlog noise gets into a "currently working on" surface.
 */
export function isActiveStatus(status: string | null | undefined): boolean {
  return ACTIVE_STATUSES.has((status ?? "").trim() as TaskStatusValue);
}

/** Is this status open (unfinished)? Fail closed on anything unrecognised, as above. */
export function isOpenStatus(status: string | null | undefined): boolean {
  return OPEN_STATUSES.has((status ?? "").trim() as TaskStatusValue);
}
