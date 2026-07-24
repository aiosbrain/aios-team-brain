import "server-only";
import { runSql } from "@/lib/db/pg/pool";

/**
 * Which items' facts are eligible to inform NARRATIVE ARCS (Layer 3) — a filter applied at arc
 * synthesis only, NOT at ingest/projection, so the excluded content stays in the graph and the
 * facts/events panels (it's still context, still searchable) but doesn't shape the "what the team is
 * working through" storylines.
 *
 * Rules (per product):
 *   1. A Linear issue informs arcs ONLY while it's ACTIVE work — In Progress / In Review. Backlog,
 *      Todo, Done, Canceled are context, not narrative — a done or not-yet-started ticket isn't
 *      something the team is "working through". Matched on the raw Linear state NAME (the per-issue
 *      `deliverable` frontmatter carries the display name, e.g. "In Progress", not a normalized enum).
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
export function isArcEligible(
  source: string | null | undefined,
  state: string | null | undefined,
  stateType?: string | null
): boolean {
  if ((source ?? "").trim().toLowerCase() !== "linear") return true;
  const type = (stateType ?? "").trim().toLowerCase();
  if (type) return type === "started"; // canonical: active work
  return !!state && isArcActiveLinearState(state); // fallback (pre-state_type rows)
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
    }>(
      `select id, frontmatter->>'source' as source, kind::text as kind, path,
              frontmatter->>'state' as state, frontmatter->>'state_type' as state_type
         from items
        where team_id = $1 and id::text = any($2)
          and (frontmatter->>'source' = 'linear'
               or (frontmatter->>'source' = 'github' and kind = 'task'))`,
      [teamId, ids]
    );
    const out = new Set<string>();
    for (const r of rows) {
      if (isGithubIssueBacklog(r.source, r.kind, r.path)) out.add(r.id);
      else if (!isArcEligible(r.source, r.state, r.state_type)) out.add(r.id);
    }
    return out;
  } catch (err) {
    console.error("[arcs] arcIneligibleItemIds failed:", err instanceof Error ? err.message : err);
    return new Set();
  }
}
