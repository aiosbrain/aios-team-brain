import { linearMirrorProject } from "@/lib/ingest/sources/linear-normalize";

/**
 * Which task does a PR's work-key refer to? PURE decision rule, shared by the work-event ingest path and
 * the link-only backfill (docs/design/pr-task-link-propagation.md).
 *
 * THE BUG THIS FIXES: the lookup used to be scoped to the PUSHED project (`payload.project` = the repo's
 * project, e.g. `aios-team-brain`), but Linear-mirrored tasks live in `linear-<teamKey>` — so a PR citing
 * `AIO-494` could never find its task (prod: 318 of 347 AIO tasks live in `linear-aio`). A work-key
 * identifies one issue within a TEAM; which brain project mirrors it is an ingestion detail the pusher
 * can't know.
 *
 * OUTCOME semantics (the blast-radius guarantee — Fable design review):
 *  • `applied` — matched in the PUSHED project. Unchanged legacy behavior: the caller completes the task
 *    and projects it back to the PM tool.
 *  • `linked`  — matched TEAM-WIDE via the widened fallback. The caller records `task_id` ONLY: it must NOT
 *    complete the task and must NOT write back to the PM tool. Widening the lookup while keeping the old
 *    side effects would (a) `issueCreate` DUPLICATE Linear issues for mirror tasks with no `task_pm_links`
 *    row (prod: the 14 `GH-*` rows), (b) clobber Linear-native edits via the full brain-wins projection,
 *    and (c) auto-complete issues merely MENTIONED in a PR body (`extractWorkKeys` has no `Fixes:` gating).
 *  • `unresolved` — no match, or ambiguous across projects.
 */

/** An issue-key-shaped token (`AIO-494`, `GH-12`) — the ONLY shape eligible for the team-wide fallback.
 *  Junk keys the extractor emits (`V1`, `C1`, `GPT-5`) stay project-scoped, where they harmlessly miss;
 *  searching those team-wide could collide with an arbitrary slug `row_key`. Mirrors `issue-ref`'s shape. */
const ISSUE_KEY_SHAPE = /^[A-Za-z][A-Za-z0-9]{0,9}-\d+$/;

export function isIssueShapedKey(rowKey: string): boolean {
  return ISSUE_KEY_SHAPE.test((rowKey ?? "").trim());
}

/** A candidate task row for the decision (already team-scoped by the caller's query). */
export interface TaskCandidate {
  id: string;
  project_id: string;
  projectSlug: string | null; // the candidate's project slug — used for the canonical-mirror tiebreak
}

export type WorkEventOutcome =
  | { status: "applied"; taskId: string }
  | { status: "linked"; taskId: string }
  | { status: "unresolved"; taskId: null; error: string };

/**
 * Decide the outcome for ONE work-key given every team-wide task carrying that `row_key`.
 * `pushedProjectId` is the project the event was pushed with (may be null when the slug is unknown).
 */
export function resolveWorkEventTask(
  rowKey: string,
  candidates: TaskCandidate[],
  pushedProjectId: string | null
): WorkEventOutcome {
  // 1. The pushed project wins — pure widening, so every previously-resolving event is unchanged.
  const inPushed = pushedProjectId ? candidates.filter((c) => c.project_id === pushedProjectId) : [];
  if (inPushed.length === 1) return { status: "applied", taskId: inPushed[0].id };
  // (>1 in one project is impossible: `unique (team_id, project_id, row_key)`.)

  // 2. Team-wide fallback — issue-shaped keys ONLY.
  if (!isIssueShapedKey(rowKey)) {
    return { status: "unresolved", taskId: null, error: "no matching task row" };
  }
  if (candidates.length === 0) {
    return { status: "unresolved", taskId: null, error: "no matching task row" };
  }
  if (candidates.length === 1) return { status: "linked", taskId: candidates[0].id };

  // 2b. Ambiguous across projects → prefer the CANONICAL Linear mirror (`linear-<prefix>`), which is
  // deterministic by construction rather than a guess. (Prod has zero ambiguity today — a forward guard.)
  const prefix = rowKey.trim().split("-")[0] ?? "";
  const mirrorSlug = linearMirrorProject(prefix);
  const inMirror = candidates.filter((c) => (c.projectSlug ?? "").toLowerCase() === mirrorSlug.toLowerCase());
  if (inMirror.length === 1) return { status: "linked", taskId: inMirror[0].id };

  return { status: "unresolved", taskId: null, error: "ambiguous row_key across projects" };
}
