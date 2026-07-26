import "server-only";
import { runSql } from "@/lib/db/pg/pool";
import { isActiveStatus } from "@/lib/tasks/activity-policy";

/**
 * Which items' facts are eligible to inform NARRATIVE ARCS (Layer 3) — a filter applied at arc
 * synthesis only, NOT at ingest/projection, so the excluded content stays in the graph and the
 * facts/events panels (it's still context, still searchable) but doesn't shape the "what the team is
 * working through" storylines.
 *
 * Rules (per product):
 *   1. A PM issue (Linear, Plane, any future provider) informs arcs ONLY while it's ACTIVE work.
 *      Backlog, Todo, Done, Canceled are context, not narrative — a done or not-yet-started ticket
 *      isn't something the team is "working through". Gated on the BRAIN-normalized
 *      `frontmatter.status` through the shared `lib/tasks/activity-policy`, so every provider inherits
 *      the rule. It used to be gated on Linear's own state vocabulary, which meant PLANE was never
 *      gated at all: its frontmatter carried no state, and the query only fetched `source='linear'`, so
 *      Done and Backlog Plane tickets shaped arcs (H6 — the noise class #363/#331 removed for Linear,
 *      still live for the other provider).
 *   2. The GitHub issues-BACKLOG aggregate (`github/<repo>/issues.md`) is excluded too — it's ONE
 *      connector-owned `kind=task` document snapshotting every repo issue, so it has no human author
 *      and produces an author-less, low-signal arc (this is what a "no person assigned" arc traces to).
 *      A backlog snapshot is context, not "what a person is working through" — same rationale as (1).
 * Non-Linear, non-issue-backlog content is unaffected (always arc-eligible). See docs/design/brain-learning-panel.md.
 */

// "In Progress" / "In Review" (and "Reviewing"). Overridable per deployment; a name matching this is
// active. Deliberately a substring regex, not an exact set, to tolerate team-configured state names.
const ACTIVE_LINEAR_STATE = (() => {
  const raw = (process.env.ARCS_LINEAR_ACTIVE_STATE_RE ?? "progress|review").trim();
  try {
    return new RegExp(raw || "progress|review", "i");
  } catch {
    return /progress|review/i;
  }
})();

export function isArcActiveLinearState(state: string): boolean {
  return ACTIVE_LINEAR_STATE.test(state);
}

/**
 * Is an item's fact eligible for arc synthesis? Only Linear items are status-gated; everything else is
 * always eligible. Prefers the CANONICAL Linear workflow-state `type` (`started` = active work —
 * team-vocabulary-agnostic, covers In Progress / In Review / Blocked / QA etc.); falls back to the
 * display-name regex for rows ingested before `state_type` was persisted. A Linear item with neither a
 * type nor a matching state name is NOT active (arcs = active work). Pure.
 */
/**
 * The PM providers whose issues are status-gated. Deliberately exported and used BOTH by the predicate
 * below and as a query PARAMETER — spelling it twice is how H6 happened: the gate and its SQL filter
 * disagreed about which sources it applied to, and Plane fell through the gap. A provider #3 is added
 * here, once, and both halves follow.
 */
export const PM_SOURCES = ["linear", "plane"] as const;
const PM_SOURCE_SET: ReadonlySet<string> = new Set(PM_SOURCES);

export function isArcEligible(
  source: string | null | undefined,
  state: string | null | undefined,
  stateType?: string | null,
  status?: string | null
): boolean {
  if (!PM_SOURCE_SET.has((source ?? "").trim().toLowerCase())) return true;
  // Preferred: the brain-normalized status every connector now emits — one vocabulary for every
  // provider, so the policy lives in ONE place (lib/tasks/activity-policy) instead of being re-derived
  // from each provider's state names here.
  const normalized = (status ?? "").trim();
  if (normalized) return isActiveStatus(normalized);
  // Fallbacks for rows ingested before `status` was on the issue doc; they heal on the next sync.
  const type = (stateType ?? "").trim().toLowerCase();
  if (type) return type === "started"; // canonical Linear workflow-state type
  return !!state && isArcActiveLinearState(state);
}

/**
 * The GitHub issues-BACKLOG aggregate: one connector-owned `kind=task` document at `github/<repo>/issues.md`
 * that lists every issue in a repo. It's a machine snapshot with no single human author, so it can only
 * produce an author-less arc — excluded from arc synthesis (kept in the graph/facts/search). GitHub issues
 * are ingested ONLY as this aggregate (not per-issue), so `source=github` + `kind=task` + the `issues.md`
 * path pins it precisely. Pure.
 */
export function isGithubIssueBacklog(
  source: string | null | undefined,
  kind: string | null | undefined,
  path: string | null | undefined
): boolean {
  return (
    (source ?? "").trim().toLowerCase() === "github" &&
    (kind ?? "").trim().toLowerCase() === "task" &&
    /(^|\/)issues\.md$/i.test((path ?? "").trim())
  );
}

/**
 * The subset of `itemIds` whose facts must be EXCLUDED from arc synthesis — inactive Linear issues
 * (not In Progress / In Review) AND the GitHub issues-backlog aggregate. Reads `items` (source/kind/
 * path/state); other content is never returned. Best-effort (empty set on error, so a hiccup can't
 * blank arcs). `itemIds` are already tier-scoped by the caller (they came out of the tier-visible pool).
 */
export async function arcIneligibleItemIds(
  teamId: string,
  itemIds: string[]
): Promise<Set<string>> {
  const ids = [...new Set(itemIds)].filter(Boolean);
  if (ids.length === 0) return new Set();
  try {
    const { rows } = await runSql<{
      id: string;
      source: string | null;
      kind: string | null;
      path: string | null;
      state: string | null;
      state_type: string | null;
      status: string | null;
    }>(
      `select id, frontmatter->>'source' as source, kind::text as kind, path,
              frontmatter->>'state' as state, frontmatter->>'state_type' as state_type,
              frontmatter->>'status' as status
         from items
        where team_id = $1 and id::text = any($2)
          and (frontmatter->>'source' = any($3)
               or (frontmatter->>'source' = 'github' and kind = 'task'))`,
      [teamId, ids, [...PM_SOURCES]]
    );
    const out = new Set<string>();
    for (const r of rows) {
      if (isGithubIssueBacklog(r.source, r.kind, r.path)) out.add(r.id);
      else if (!isArcEligible(r.source, r.state, r.state_type, r.status)) out.add(r.id);
    }
    return out;
  } catch (err) {
    // FAIL CLOSED. This used to return an empty set, i.e. "nothing is ineligible" — so one transient DB
    // error flooded the arc pool with the exact backlog/done noise this gate exists to remove, and the
    // result was then committed as a fresh 4h arc set. Throwing is the safe direction: the BACKGROUND
    // refresh path wraps synthesis in try/catch and does NOT commit on error, so the previous arcs
    // stand. (A cold miss with no prior surfaces the error instead — degraded, but never wrong data.)
    const message = err instanceof Error ? err.message : String(err);
    console.error("[arcs] arc-eligibility lookup failed — refusing to synthesize:", message);
    throw new Error(`arc-eligibility lookup failed: ${message}`);
  }
}
