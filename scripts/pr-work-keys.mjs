/**
 * Work-key extraction and verification for the two PR workflows — ONE copy, because there were two and
 * they were about to disagree.
 *
 * `pr-task-link.yml` (advisory, on open/edit) warns when a PR cites no brain task or cites one that
 * doesn't exist. `aios-work-sync.yml` (on merge) posts those same keys to `/api/v1/work-events`, which
 * moves the matching task to Done. Both had their own inline copy of the matcher, so a fix to what counts
 * as a "cited key" landed in the warning and not in the thing that actually closes tickets — the check
 * would clear a PR whose keys the merge step then read differently.
 *
 * Pure and testable on purpose: the response parser here shipped broken (see `knownKeysFrom`) precisely
 * because it lived in a YAML heredoc that no tier could reach.
 */

/** Same shape `lib/pm-sync/work-keys` accepts: `AIO-12`, `W2.5.8`, optionally after an `AIOS-Work:` label. */
const WORK_KEY_RE = /\b(?:AIOS-Work:\s*)?([A-Z][A-Z0-9]+-\d+|[A-Z]\d+(?:\.\d+)*)\b/g;

/**
 * The parts of a PR that CLAIM a work key, with the parts that merely DISCUSS one removed: HTML comments
 * (the template's `<!-- e.g. AIO-72 -->` placeholder), fenced blocks, and inline code.
 *
 * A PR body explaining that the model "sees `T1…Tn`" was read as citing a work key called `T1`: the
 * advisory check warned about it, and the merge step would have posted it as a key to close. Prose noise
 * is how an advisory warning earns its way onto everyone's ignore list.
 */
export function prSearchText(pr) {
  const prose = String(pr?.body ?? "")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`[^`\n]*`/g, " ");
  return [String(pr?.title ?? ""), prose, String(pr?.head?.ref ?? "")].join("\n");
}

/** Every distinct work key the PR cites, in first-seen order. */
export function extractWorkKeys(pr) {
  return [...new Set([...prSearchText(pr).matchAll(WORK_KEY_RE)].map((m) => m[1]))];
}

/**
 * The set of key strings a `GET /api/v1/tasks` response actually contains.
 *
 * THE BUG THIS EXISTS FOR: that endpoint answers `{tasks: [{project, rows: [{row_key, …}]}]}` — grouped
 * BY PROJECT, not a flat row list. The original one-liner read `body.tasks` as rows, found `row_key` on
 * none of them, and produced an empty set — so every key was reported as invented, including real ones.
 * It cried wolf on its own first run, on a PR citing a task that exists.
 *
 * Tolerates a flat array and a bare `{rows}` group too: the caller must not care which of those it got.
 */
export function knownKeysFrom(body) {
  const groups = Array.isArray(body) ? body : (body?.tasks ?? body?.data ?? []);
  const rows = (Array.isArray(groups) ? groups : []).flatMap((g) => (Array.isArray(g?.rows) ? g.rows : [g]));
  return new Set(rows.map((t) => String(t?.row_key ?? t?.rowKey ?? "")).filter(Boolean));
}

/**
 * Verdict for the advisory check: what do we actually know about these keys?
 *
 * `unverified` is a DISTINCT outcome from `invented`, and keeping them apart is the whole point. Zero
 * known keys means "we couldn't ask" — an empty response, a shape change, a tier that sees nothing — each
 * indistinguishable from a brain with no tasks. Accusing the author on no evidence is exactly what makes
 * an advisory warning worthless.
 */
export function verifyKeys(keys, known) {
  if (!keys.length) return { status: "none" };
  if (!known.size) return { status: "unverified", keys };
  const invented = keys.filter((k) => !known.has(k));
  return invented.length ? { status: "invented", invented, checked: known.size } : { status: "ok", checked: known.size };
}
