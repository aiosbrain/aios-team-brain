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
 *
 * ONE DELIBERATE ASYMMETRY. `prSearchText` NARROWS what counts as a citation, which means a key written
 * inside backticks stops closing its task on merge. That is the safe direction: over-matching posts a key
 * the author never claimed, and `/api/v1/work-events` sets `status='done'` on a task that matches in the
 * pushed project — so prose like "supersedes `AIO-100`" would have CLOSED AIO-100. Under-matching leaves
 * the board stale, which the advisory check announces at open time ("No brain task linked"). A wrongly
 * closed ticket is silent; a missed one is warned about. The PR template asks for a bare
 * `AIOS-Work: AIO-72` line, and the title and branch are never stripped.
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
    // Fences: ``` or ~~~, indented up to 3 spaces (GitHub still renders those as a fence — a block nested
    // under a list item is the common case), and an UNCLOSED fence swallows the rest of the body. A lazy
    // `[\s\S]*?` needs a closing fence, so one stray ``` left everything after it matchable. Both gaps
    // failed toward OVER-match, the direction that closes someone else's ticket on merge.
    .replace(/(^|\n)[ ]{0,3}(```|~~~)[\s\S]*?(\n[ ]{0,3}\2|$)/g, " ")
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
export function taskRowsFrom(body) {
  const groups = Array.isArray(body) ? body : (body?.tasks ?? body?.data ?? []);
  return (Array.isArray(groups) ? groups : []).flatMap((g) => (Array.isArray(g?.rows) ? g.rows : [g]));
}

export function knownKeysFrom(body) {
  return new Set(taskRowsFrom(body).map((t) => String(t?.row_key ?? t?.rowKey ?? "")).filter(Boolean));
}

/**
 * The documented row bound of `GET /api/v1/tasks?all=1` (brain-api: "up to the endpoint's 500-row bound").
 * Table mode does not paginate — `next_cursor` is null for it by design — so a full page means the answer
 * we got is a PREFIX of the table, ordered by `updated_at` ASCENDING: the STALEST rows. The tasks people
 * actually cite in PRs are the recently-touched ones, i.e. exactly the ones missing.
 *
 * Measured when this was found: prod had 677 keyed tasks, and AIO-484 — cited by the PR that exposed all
 * this — sat at rank 628 of 677. It was never in the answer, so "no task has this key" was a confident
 * statement about data the check had never seen.
 *
 * A full page therefore only ever justifies a POSITIVE: a key we DID see is real. Absence proves nothing.
 */
export const TASKS_PAGE_BOUND = 500;

/**
 * Verdict for the advisory check: what do we actually know about these keys?
 *
 * `unverified` is a DISTINCT outcome from `invented`, and keeping them apart is the whole point. Zero
 * known keys means "we couldn't ask" — an empty response, a shape change, a tier that sees nothing — each
 * indistinguishable from a brain with no tasks. Accusing the author on no evidence is exactly what makes
 * an advisory warning worthless.
 */
export function verifyKeys(keys, known, opts) {
  // MANDATORY, and it throws rather than defaulting. `truncated = false` would be a default that ACCUSES:
  // drop the argument — a plausible merge-conflict resolution, in glue code that lives in a YAML heredoc —
  // and the false accusation comes back with every test still green. That is the exact class this module
  // exists to end, so the omission has to fail loudly instead of quietly picking the unsafe branch.
  if (typeof opts?.truncated !== "boolean") {
    throw new Error("verifyKeys requires an explicit { truncated } — defaulting it would silently accuse");
  }
  const truncated = opts.truncated;
  if (!keys.length) return { status: "none" };
  if (!known.size) return { status: "unverified", keys, reason: "empty" };
  const invented = keys.filter((k) => !known.has(k));
  if (!invented.length) return { status: "ok", checked: known.size };
  // A missing key is only evidence of a FAKE key when we can see the whole table. On a truncated read the
  // same absence is equally explained by "it's in the part we didn't get" — and on this team's data that
  // is what it always was. Verifying the keys we CAN see still works: `ok` above is unaffected.
  if (truncated) return { status: "unverified", keys: invented, reason: "truncated", checked: known.size };
  return { status: "invented", invented, checked: known.size };
}
