import "server-only";
import { runSql } from "@/lib/db/pg/pool";

/**
 * Which items' facts are eligible to inform NARRATIVE ARCS (Layer 3) — a filter applied at arc
 * synthesis only, NOT at ingest/projection, so the excluded content stays in the graph and the
 * facts/events panels (it's still context, still searchable) but doesn't shape the "what the team is
 * working through" storylines.
 *
 * Rule (per product): a Linear issue informs arcs ONLY while it's ACTIVE work — In Progress / In Review.
 * Backlog, Todo, Done, Canceled are context, not narrative — a done or not-yet-started ticket isn't
 * something the team is "working through". Non-Linear content is unaffected (always arc-eligible).
 * Matched on the raw Linear state NAME (the per-issue `deliverable` frontmatter carries the Linear
 * display name, e.g. "In Progress", not a normalized enum). See docs/design/brain-learning-panel.md.
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
 * The subset of `itemIds` whose facts must be EXCLUDED from arc synthesis — Linear issues that aren't
 * active (In Progress / In Review). Reads `items.frontmatter` (source + state); non-Linear items are
 * never returned. Best-effort (empty set on error, so a hiccup can't blank arcs). `itemIds` are already
 * tier-scoped by the caller (they came out of the tier-visible fact pool).
 */
export async function arcIneligibleItemIds(
  teamId: string,
  itemIds: string[]
): Promise<Set<string>> {
  const ids = [...new Set(itemIds)].filter(Boolean);
  if (ids.length === 0) return new Set();
  try {
    const { rows } = await runSql<{ id: string; state: string | null; state_type: string | null }>(
      `select id, frontmatter->>'state' as state, frontmatter->>'state_type' as state_type
         from items
        where team_id = $1 and id::text = any($2) and frontmatter->>'source' = 'linear'`,
      [teamId, ids]
    );
    const out = new Set<string>();
    for (const r of rows) if (!isArcEligible("linear", r.state, r.state_type)) out.add(r.id);
    return out;
  } catch (err) {
    console.error("[arcs] arcIneligibleItemIds failed:", err instanceof Error ? err.message : err);
    return new Set();
  }
}
