/**
 * Pure issue-key reference extraction for the timeline's task↔evidence links. A commit, PR, doc, or
 * Slack message "belongs to" a Linear/Plane task when its text cites the task's issue key (e.g.
 * `feat: … (AIO-123)`, a `chetan/AIO-123-fix` branch, "see ENG-45"). Deterministic + high-precision:
 * we only accept a token that EXACTLY matches one of the team's real issue-shaped task `row_key`s
 * (mirror-imported Linear/Plane tasks store the provider identifier there) — so incidental tokens like
 * `utf-8` / `sha-256` / `http-2` never false-link. No LLM here (that's a later, lower-confidence pass).
 * Unit-tested; no server-only/DB imports.
 */

// An issue-key-shaped token: a short letter-led prefix, a dash, then digits (AIO-123, ENG-45, S3-1).
const ISSUE_KEY_RE = /\b([A-Za-z][A-Za-z0-9]{0,9})-(\d+)\b/g;
const ISSUE_KEY_SHAPE = /^[A-Za-z][A-Za-z0-9]{0,9}-\d+$/;

/**
 * From all of a team's task `row_key`s, keep ONLY the issue-key-shaped ones (Linear/Plane identifiers),
 * uppercased for case-insensitive matching. Drops `ui-…`, `meet-<hash>-<hash>`, and slug row_keys — a
 * non-issue row_key must never become a match target. Returns a Set for O(1) membership.
 */
export function issueShapedKeys(rowKeys: Iterable<string | null | undefined>): Set<string> {
  const set = new Set<string>();
  for (const k of rowKeys) {
    const t = (k ?? "").trim();
    if (ISSUE_KEY_SHAPE.test(t)) set.add(t.toUpperCase());
  }
  return set;
}

/**
 * The issue keys referenced in `text` that are in `knownKeys` (already uppercased via issueShapedKeys).
 * Case-insensitive; returns the canonical uppercased keys, deduped, in first-seen order. Membership in
 * `knownKeys` is what makes this precise — the regex is broad, the allowlist is exact.
 */
export function extractIssueRefs(text: string | null | undefined, knownKeys: Set<string>): string[] {
  if (!text || knownKeys.size === 0) return [];
  const found = new Set<string>();
  for (const m of text.matchAll(ISSUE_KEY_RE)) {
    const key = `${m[1]}-${m[2]}`.toUpperCase();
    if (knownKeys.has(key)) found.add(key);
  }
  return [...found];
}

export interface LinkTask {
  id: string;
  row_key: string | null;
}
export interface LinkItem {
  id: string;
  text: string; // title + body/path (head) — where an issue key would appear
}

/**
 * Map each item id → the task ids its text references (via issue keys). An item may reference more than
 * one task (a commit closing two issues). Uses the team's issue-shaped `row_key`s as the exact allowlist,
 * so incidental tokens never link. Pure — used inline by the timeline builder AND the persisted writer.
 */
export function computeTaskLinks(tasks: LinkTask[], items: LinkItem[]): Map<string, string[]> {
  const known = issueShapedKeys(tasks.map((t) => t.row_key));
  // key(uppercased) → taskId. Issue keys are unique within a (team, project); across projects the same
  // identifier could recur — keep the lowest task id (a STABLE tiebreak, independent of caller fetch
  // order, so the two call sites — inline builder + persisted writer — always agree).
  const keyToTask = new Map<string, string>();
  for (const t of [...tasks].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))) {
    const k = (t.row_key ?? "").trim().toUpperCase();
    if (known.has(k) && !keyToTask.has(k)) keyToTask.set(k, t.id);
  }
  const out = new Map<string, string[]>();
  for (const it of items) {
    const taskIds = extractIssueRefs(it.text, known)
      .map((k) => keyToTask.get(k))
      .filter((v): v is string => Boolean(v));
    if (taskIds.length) out.set(it.id, [...new Set(taskIds)]);
  }
  return out;
}
